# org-hooks

One versioned source of truth for git hooks across all repos. Backbone:
[Lefthook](https://lefthook.dev) with `remotes:` — each repo carries a
~6-line pinned stub (`examples/lefthook.stub.yml`); everything else lives
here.

## Why this design

- **Polyglot, no Node tax** — Lefthook is a single Go binary; Python-only
  repos don't pull a Node toolchain just to get hooks.
- **One config, many repos** — repos reference a pinned `ref:`; bumping
  the tag here rolls out everywhere on next `lefthook install`.
- **Worktree-safe** — Lefthook uses the common git dir correctly
  (relevant to the ai-roller ×3 and wicketmap ×4 worktrees).
- **Tiered** — fast staged-only checks on commit; heavier checks on push;
  full test/coverage/e2e in CI or dispatched to the GPU queue.

## Tiers

| File | Hook(s) | Contents |
|---|---|---|
| `lefthook-common.yml` | pre-commit, pre-merge-commit | secret scan (gitleaks), hygiene (large files / conflict markers / EOF), linear-history guard |
| `lefthook-push.yml` | pre-push | language-agnostic push gates |
| `profiles/ts.yml` | adds to pre-commit | Biome (staged) · tsc · knip · dpdm · duplicate-type scan · no-reexports · size-cap |
| `profiles/python.yml` | adds to pre-commit/pre-push | ruff format+lint (staged) · mypy · vulture · deptry · size-cap |
| `profiles/specs.yml` | pre-commit/post-commit | AI-Roller `air check` / artifact-drift (ai-roller only) |
| `profiles/sci.yml` | pre-commit | simple-ci GPU dispatch for unit + e2e (flat `commands:` style); syncs lcov from CI host; runs coverage ratchet inline after sync |
| `profiles/sci-tiered.yml` | pre-commit, pre-merge-commit | **self-contained** tiered fail-fast gate — ALL checks inlined (12 static + 2 GPU); pull ONLY this file with ZERO consumer pre-commit overrides |

## Shared Biome config (`config/biome.base.json`)

A repo onboarding `profiles/ts.yml` adds a `biome.json` that **extends** the
shared base:

```json
{
  "$schema": "https://biomejs.dev/schemas/2.5.0/schema.json",
  "extends": ["../org-hooks/config/biome.base.json"],
  "files": { "includes": ["**", "!examples", "!**/build_dev"] }
}
```

> **DO NOT INLINE.** Never copy the base's formatter/linter rules into a repo's
> own `biome.json`. Always `extends` the shared base so a rule change here rolls
> out to every repo. Inlining forks the org standard and silently drifts. The
> only repo-local keys allowed are `extends`, `$schema`, and narrow `files`/
> per-repo overrides — not a reimplementation of the base rules.
>
> Biome parses an `extends` target as **strict JSON**: no comments, no `//`
> keys, and the `$schema` must match the installed Biome major/minor. Always
> track the **latest** Biome — bump this base's `$schema` when Biome updates;
> never pin consumers to an old Biome to accommodate a stale base.

## Tiered fail-fast gate (`profiles/sci-tiered.yml`)

A repo that wants a two-tier, fail-fast pre-commit dispatches static checks
first and only runs the expensive GPU test jobs if every static check passed.
This profile is **self-contained**: a consumer pulls ONLY `profiles/sci-tiered.yml`
(not `lefthook-common.yml` / `profiles/ts.yml` / `profiles/sci.yml`) and declares
NO `pre-commit:` block of its own — its `lefthook.yml` is just `remotes:` + `rc:`.

Why zero overrides: lefthook 2.1.6 cross-config merge is unsafe for this shape —
a consumer `pre-commit:` block drops the remote's top-level `piped: true` (killing
fail-fast), and nested-job overrides don't deep-merge. With nothing to merge, the
tier tree and `piped: true` are used verbatim. Tunables are env vars (sourced from
the consumer's `rc:`), never config overrides:

| Env var | Default | Purpose |
|---|---|---|
| `ORG_HOOKS` | — (required) | absolute path to this checkout |
| `DPDM_CIRCULAR` | `circular:1` | ts-circular exit policy; set `circular:0` for warn-only in repos with known cycles |
| `SCI_WT` | derived | CI queue name; **not needed** — derived from the git common dir so all worktrees of a repo resolve to the repo dir name |
| `SCI_BIN` | `/home/john/src/simple-ci/sci` | simple-ci binary; falls back to `npm run test:coverage`/`test:e2e` if absent |
| `COVERAGE_E2E_BASELINE_LCOV` | `coverage/e2e-fullrun/lcov.info` | local path the persisted full-run e2e lcov is scp'd to and fed to the union merge as `--e2e-baseline` (full-e2e carry-forward, below) |

**Full-run e2e carry-forward.** The per-commit gate runs only the **TIA-selected**
e2e spec subset, so a source file whose real e2e coverage comes from an
*unselected* spec (e.g. a `mediaService` that maps to no spec) is absent from the
per-commit e2e lcov and would **false-drop** the union ratchet. To prevent that,
`ci/e2e-map.sh` persists the full e2e lcov on the CI host (green-run only, under
an `flock`) at `~/ci-flake/<repo>-e2e-fullrun.lcov`. The `coverage-union` job
scp's it to `COVERAGE_E2E_BASELINE_LCOV` and unions it into the per-commit merge
via `coverage-union-merge.mjs --e2e-baseline`. If the file is absent the scp/merge
silently omit it and behave exactly as before.

Soundness: the baseline is keyed by the line numbers from the **last green
`ci/e2e-map`**, so for a file changed since then its e2e attribution is
*approximate*. This is **conservative** — it biases toward NOT false-dropping and
never toward hiding a real regression: unit coverage is always re-measured fresh
this commit, and the periodic full e2e suite + baseline reseed catch genuine e2e
coverage regressions. The baseline refreshes on every green `ci/e2e-map` run.

The CI queue name is derived as
`basename "$(cd "$(dirname "$(git rev-parse --git-common-dir)")" && pwd)"` — the
parent of the shared `.git`. From any worktree (e.g. `repo-wt1`) this resolves to
the main repo dir (`repo`), so a worktree never pushes to a stray queue.

Heavy tests/coverage/e2e are dispatched to the remote GPU queue via `profiles/sci.yml`.
The coverage ratchet is inlined at the end of each sci command — after the lcov is
retrieved from the CI host — so it always checks coverage from the current commit.

## Coverage ratchet

The ratchet lives inside `profiles/sci.yml`, not in a separate lefthook command. This
is intentional: lefthook v2 has no command-level ordering that survives `parallel: true`,
so a separate command would race the test job and check stale lcov.
By inlining the ratchet after the `scp` sync, ordering is enforced by the shell.

Two independent ratchets, one per sci command:

| sci command | Baseline file | lcov source |
|---|---|---|
| `unit-tests` | `coverage-baseline.json` | `coverage/lcov.info` |
| `e2e-tests` | `coverage-e2e-baseline.json` | `coverage/e2e/lcov.info` |

Each ratchet auto-seeds on first run — if the baseline file does not exist, the
first invocation writes it from current lcov and exits 0. Subsequent commits
then have something to ratchet against.

**Baseline format (v2)** — one percentage per file, with sorted keys for clean
diffs:
```json
{
  "version": 2,
  "files": {
    "src/foo.ts": 87.50,
    "src/bar.ts": 60.42
  }
}
```

Rules (per staged source file, checked against `scripts/coverage-ratchet.mjs`):
- **File not in baseline** (brand-new or never tracked): must reach the floor
  (default 75% lines hit).
- **File in baseline**: current % must be ≥ baseline % within the tolerance
  (default 0.5 pp — absorbs noise from coverage-instrument runs).

On pass the baseline is rewritten — current % overwrites if it's higher; lower
runs are ignored (no down-ratchet). The file is re-staged with the commit.
On fail the commit is aborted with a per-file reason.

Duplicate keys after path normalisation (e.g. stale `localhost-NNNN/src/...`
entries alongside `src/...`) collapse to the max on read.

**Staged-file filter** (applied by sci.yml via `git diff --cached`):

| ratchet | glob |
|---|---|
| unit | `^src/.*\.(ts\|tsx\|js\|jsx\|mjs\|cjs)$` |
| e2e | `^src/.*\.(ts\|tsx)$` |

Both exclude `src/test/`, `*.test.*`, `*.spec.*`.
Per-repo additional excludes: create `coverage-ratchet-exclude` / `coverage-e2e-ratchet-exclude` in the repo root — one path per line, `#` comments supported.

Example `coverage-e2e-ratchet-exclude`:
```
# GPS hardware interface — snap logic requires real GPS; can't reach 75% in E2E
src/components/MapView/hooks/useGpsSnap.ts
```

**Env var overrides**: `COVERAGE_LCOV`, `COVERAGE_BASELINE`, `COVERAGE_E2E_LCOV`,
`COVERAGE_E2E_BASELINE`, `COVERAGE_FLOOR` (0–1, default 0.75),
`COVERAGE_TOLERANCE` (0–1, default 0.005 = 0.5 pp).

**Tests**: pure helpers live in `scripts/coverage-ratchet-lib.mjs`; run the
suite with `node --test scripts/coverage-ratchet.test.mjs` (uses node:test,
no external deps).

**Reseeding the baseline** — two modes for a full rebuild:

- `--reseed` (preferred, monotonic): merges the current lcov over the existing
  baseline taking the per-file **max**, and keeps baseline entries absent from
  the lcov. High-water-mark preserving — a full reseed can never lower or forget
  a file below its accumulated mark. This is the right choice for a routine
  full-suite reseed.
- `--seed` (hard reset): overwrites the baseline from the current lcov only,
  discarding the old baseline. Use only when code was legitimately removed and
  the old marks should be forgotten.

```sh
# Monotonic rebuild (keeps high-water marks):
node <ORG_HOOKS>/scripts/coverage-ratchet.mjs --reseed \
  --lcov coverage/lcov.info --baseline coverage-baseline.json

# Hard reset (drops everything not in the new lcov):
node <ORG_HOOKS>/scripts/coverage-ratchet.mjs --seed \
  --lcov coverage/lcov.info --baseline coverage-baseline.json
```

## Host tools (installed once per machine)

| Tool | Purpose | Install |
|---|---|---|
| lefthook | hook runner | `npm i -g lefthook` |
| gitleaks | secret scanning | release binary → `~/.local/bin` |
| ruff | Python format+lint | (already present) `~/.local/bin` |
| mypy | Python type check | `uv tool install mypy` |
| typos | spell check (optional) | `cargo install typos-cli` |

Per-repo JS tools (Biome/knip/dpdm/typescript) are pinned as repo
devDependencies and invoked via `npx --no-install` — never global.

## Onboarding a repo

See `examples/lefthook.stub.yml` for the step-by-step checklist. Repos
are onboarded **one at a time** and verified before moving on.

## Tagging

Consumers pin a `ref:`. Cut a tag after any change:
`git tag vX.Y.Z && git push --tags` (bump consumers deliberately).

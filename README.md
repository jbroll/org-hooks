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
| `profiles/python.yml` | adds to pre-commit | ruff format+lint+autofix (staged, re-staged) · mypy · vulture · deptry · import-linter (only if a contract exists) · size-cap · test-size-cap — all at commit, parallel, glob-gated (mirrors `ts.yml`; no pre-push) |
| `profiles/kotlin.yml` | adds to pre-commit | ktlint format+lint+autofix (staged, re-staged) · detekt AST static analysis · size-cap · test-size-cap — all at commit, parallel, glob-gated (mirrors `ts.yml`/`python.yml`). Lint/static only — Gradle compile/test needs the SDK and belongs in the repo's own lefthook (dispatch to a build host). Java = a future `profiles/java.yml` (spotless/checkstyle), same shape. |
| `profiles/specs.yml` | pre-commit/post-commit | AI-Roller `air check` / artifact-drift (ai-roller only) |
| `profiles/sci.yml` | pre-commit | simple-ci GPU dispatch for unit + e2e (flat `commands:` style) — composes `scripts/sci-run.sh` (dispatch + lcov sync) and `scripts/ratchet-staged.sh` (inline coverage ratchet) |
| `profiles/sci-tiered.yml` | pre-commit, pre-merge-commit | **self-contained** tiered fail-fast gate — the TS, Python and Kotlin packs inlined and glob-gated (25 static + 1 GPU); pull ONLY this file with ZERO consumer pre-commit overrides |

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
It carries the TypeScript, Python and Kotlin packs inlined and glob-gated, so a
polyglot repo gets each language's checks on the commits that touch it, and a
single-language repo pays nothing for the other two.
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

**Python projects in a subdirectory.** mypy, pytest and deptry resolve config,
dependencies and import roots from the directory they start in, which in a
polyglot repo is not the repo root. `scripts/py-run.sh` maps each staged file to
its nearest ancestor `pyproject.toml` and runs the command there, once per
distinct project — so `host-bridge/` in a mostly-TypeScript repo is gated the same
as a flat Python repo. A staged `.py` under no `pyproject.toml` fails the commit
rather than being skipped. (`profiles/python.yml`, the standalone pack, still
assumes the project is at the repo root.)

mypy and pytest run as `uv run` from the project's own environment, so a repo
pins them in its dev group; third-party imports then type-check and the suite
sees its dependencies. vulture, deptry and import-linter need no project deps and
run via `uv tool run`. Every tool reads its settings from the repo's
`pyproject.toml`, so strictness stays repo-local.

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
The dispatch core (SCI/WT resolution, `ci/before-test-push`, trap-kill on interrupt,
wait, lcov retrieval) is the shared `scripts/sci-run.sh` — also usable directly for
repo-local gates, e.g. a pre-push `"${ORG_HOOKS}/scripts/sci-run.sh" --label full-gate test`.
The coverage ratchet runs at the end of each sci command — after `sci-run.sh` has
retrieved the lcov from the CI host — so it always checks coverage from the current
commit; the staged-file filtering lives in the shared `scripts/ratchet-staged.sh`.

## The `ci/` contract required by `profiles/sci-tiered.yml`

The `tier2-gpu` stage pushes `<repo>/ci/test` and `<repo>/ci/e2e` to simple-ci and
gates the commit on both. The profile supplies none of that: the repo does, as four
files under `ci/`. Copy them from `examples/ci/`.

| File | Mode | Runs | Purpose |
|---|---|---|---|
| `ci/before-test-push` | executable | locally, before dispatch | writes `ci/.changed-files`, the staged-source manifest both jobs read |
| `ci/test` | executable | on the CI host | unit job; delegates to `$ORG_HOOKS/ci/test.sh` |
| `ci/e2e` | executable | on the CI host | E2E job; delegates to `$ORG_HOOKS/ci/e2e.sh` |
| `ci/setup.sh` | **sourced** | on the CI host | per-repo env callback, sourced by both orchestrators |

The three shims must be `chmod +x`. `ci-rsync.sh` rejects the push outright if
`ci/test` or `ci/e2e` is not executable in the job worktree. `ci/before-test-push` is
weaker: tier 2 runs it as `[ -x ci/before-test-push ] && ci/before-test-push`, so a
missing or non-executable one is skipped without a word, and a failing one does not
abort the job — either way both jobs run against whatever manifest is already on
disk.

`ci/setup.sh` is sourced with `.`, never executed: it must be POSIX `sh`, must not
`exit` on a success path, and must not end on a statement that returns non-zero (the
orchestrators run under `set -e`, so a non-zero final statement aborts the job with
no message).

### Variables the shims export

`$ORG_HOOKS/ci/test.sh` and `$ORG_HOOKS/ci/e2e.sh` abort on a missing required
variable via `${VAR:?}`.

| Variable | Required by | Meaning |
|---|---|---|
| `WORKTREE` | `ci/test.sh`, `ci/e2e.sh` | absolute path to the job's repo root |
| `CI_SETUP` | `ci/test.sh`, `ci/e2e.sh` | absolute path to the file they source |
| `ORG_HOOKS` | `ci/e2e.sh` | org-hooks checkout **on the CI host** — `ci/e2e.sh` runs `scripts/e2e-select-cli.mjs`, `scripts/flake-gate.mjs` and `ci/assert-all-ran.sh` from it. `ci/test.sh` does not read it, but every shim needs it to locate the orchestrator. The job worktree has no `.git` and no lefthook `rc:`, so it cannot inherit `ORG_HOOKS` the way a local commit does; export it in the shim. |

Optional knobs, all read on the CI host:

| Variable | Default | Read by | Effect |
|---|---|---|---|
| `CI_E2E_SMOKE_CMD` | `npm run test:e2e:smoke` | `ci/e2e.sh` | command `eval`'d when spec selection returns `RUN_ALL`. **A repo without a `test:e2e:smoke` npm script MUST set this**, or every `RUN_ALL` commit fails. |
| `CI_E2E_SPEC_CMD` | `npx playwright test` | `ci/e2e.sh` | command `eval`'d with the selected spec paths appended when selection returns a list. Both run from the repo root, so **a repo whose `playwright.config.ts` lives in a workspace MUST set this** to a command that enters that workspace — otherwise playwright finds no config and runs with no `baseURL` and no `webServer`. |
| `CI_SELECTOR` | unset | `ci/e2e.sh` | when non-empty, runs `npx playwright test "$CI_SELECTOR" --project=chromium` and skips both spec selection and the flake gate. For targeted manual pushes. |
| `CI_CHANGED_GLOB` | `^(src\|scripts\|ci\|packages)/.*\.(ts\|tsx\|js\|jsx\|mjs\|cjs)$` | `ci/before-test-push.sh` | which staged paths enter the manifest. It must cover every directory the union ratchet gates (`^(src\|packages)/`), or a gated file's tests never run and it ratchets at a false zero. |

### Variables the lefthook `rc:` sets

These are read by the `coverage-union` job, which runs **locally** under lefthook —
they come from the repo's `rc:` file, not from a `ci/` shim.

| Variable | Default | Purpose |
|---|---|---|
| `COVERAGE_LCOV` | `coverage/lcov.info` | unit lcov; used as **both** the remote source and the local destination of the `scp`, so it names the same repo-relative path on both sides |
| `COVERAGE_E2E_LCOV` | `coverage/e2e/lcov.info` | E2E lcov, same on both sides |
| `COVERAGE_E2E_BASELINE_LCOV` | `coverage/e2e-fullrun/lcov.info` | local landing path for the persisted full-run e2e lcov (see full-run carry-forward above) |
| `COVERAGE_UNION_LCOV` | `coverage/union/lcov.info` | merged per-line union, written locally |
| `COVERAGE_UNION_BASELINE` | `coverage-union-baseline.json` | committed baseline the union ratchet gates against |

Ratchet thresholds (`COVERAGE_FLOOR`, `COVERAGE_TOLERANCE`, …) are in
[Coverage ratchet](#coverage-ratchet) below.

### lcov

`ci/test` emits `coverage/lcov.info`; `ci/e2e` emits `coverage/e2e/lcov.info`. The
unit lcov is produced by the repo's own tooling, not by org-hooks.

`ci/test.sh` runs `npx vitest related --run --isolate --coverage`, so the repo needs
`vitest`, a v8 coverage provider, and an `lcov` reporter:

```ts
coverage: { provider: "v8", reporter: ["text", "lcov"], include: ["src/**"] }
```

With vitest's default `reportsDirectory` that lands at `coverage/lcov.info`.

The E2E lcov must land at `coverage/e2e/lcov.info`. `scripts/e2e-coverage.mjs`
produces it from raw Playwright V8 dumps:

```sh
node "$ORG_HOOKS/scripts/e2e-coverage.mjs" report \
  --worktree . --origin localhost:5199 --rewrite 'src/=packages/web/src/'
```

The repo supplies a Playwright fixture that writes `{spec, data}` JSON per test
into `coverage/e2e-raw/`, and a `globalTeardown` that spawns the CLI. Everything
below the Playwright API — monocart, the entry filter, the source-path rewrites —
is the CLI's.

`--rewrite from=to` replaces `from` at a path-segment boundary. A monorepo whose
Vite dev server serves one package's source at a bare `/src/` needs it: without
the rewrite those files normalise to `src/…` and merge with nothing. A rule is
skipped for a path already sitting under the rule's own target package, so it
never double-applies to a path that already names a package. The same rules key
the impact map, so the two outputs cannot disagree about what a source path is.

`--require-prefix <prefix>` (repeatable) fails the run if any normalised `SF:`
path in the generated lcov does not start with one of the given prefixes,
naming the offending paths. It catches `--rewrite` silently failing to fire —
without it, an unrewritten path can still pass the "lcov exists, names at least
one file" checks while merging with nothing at the union stage. Omitting the
flag skips the check entirely.

With `E2E_BUILD_IMPACT_MAP` set, the CLI also writes
`coverage/e2e-impact/coverage.jsonl` for `build-e2e-map.mjs`.

Either may be absent. The `scp` of a missing file is swallowed, and
`coverage-union-merge.mjs` treats a missing input as empty coverage — so the union
degrades to the other source alone. If **neither** exists the merge is skipped
entirely and the ratchet reads whatever `coverage/union/lcov.info` is already on
disk from a previous commit.

### `coverage-union-baseline.json`

`scripts/ratchet-staged.sh` exits 0 when the baseline file is absent, so the union
ratchet is inert until one is committed. Seeding it is a deliberate act.

**Do not commit `{}` as a placeholder.** `parseBaseline` in
`scripts/coverage-ratchet-lib.mjs` throws unless `version === 2`, so `{}` fails the
moment tier 2 first produces a union lcov, with an uncaught
`unsupported baseline version undefined — re-seed with --seed`. An empty-but-valid
`{"version": 2, "files": {}}` is no better: every staged source file is then "not in
baseline" and must reach the 75% floor on its own.

The only correct starting content is a real measurement. Commit nothing, let one
tier-2 run write `coverage/union/lcov.info`, then seed from it:

```sh
node "$ORG_HOOKS/scripts/coverage-ratchet.mjs" --seed \
  --lcov coverage/union/lcov.info --baseline coverage-union-baseline.json
```

`--seed` writes the file and `git add`s it. A union lcov from a per-commit run holds
only the files that commit's TIA-selected suites loaded; `--reseed` merges later runs
in monotonically, taking the per-file max and keeping entries absent from the new
lcov, so the baseline fills out over time and never loses a mark.

The ratchet gates staged files matching `^(src|packages)/.*\.(ts|tsx|js|jsx|mjs|cjs)$`
minus `src/test/`, `__tests__/`, `*.test.*`, `*.spec.*`. Further per-repo exemptions
go one path per line in `coverage-union-ratchet-exclude` (`#` comments supported).

### `ci/.changed-files`

`ci/before-test-push` writes it locally; `ci/test.sh` and `scripts/e2e-select-cli.mjs`
read it on the CI host. Two things must both be true:

**It must be gitignored.** `hygiene.sh fully-staged` (tier 0) rejects any untracked
non-ignored file, so an unignored manifest fails every commit. Ignore
`coverage/` too — the tier-2 job `scp`s lcovs into it locally, and the next commit's
`fully-staged` would trip on them.

**It must be force-included in the rsync.** `sci push` runs

```
rsync -a --delete ${CI_RSYNC_ARGS:-} --filter=':- .gitignore' --exclude=.git . DEST
```

so a gitignored file is excluded from the overlay and never reaches the host. The
`--include` must come before the `.gitignore` filter, which is what `CI_RSYNC_ARGS`
does:

```sh
CI_RSYNC_ARGS="--include=ci/.changed-files"
```

Put it in the repo's `ci/simple-ci.conf`. It is a property of the repo, not of the
machine, so it belongs beside the code where every clone and every worktree gets it,
and it applies to a manual `sci push` as well as to the hook — both run `sci` from the
repo root. Setting it in the lefthook `rc:` instead reaches the hook and nothing else.

`sci` loads the **first** config it finds — `$CI_CONF`, `./ci/simple-ci.conf`,
`~/.config/simple-ci.conf`, `<sci-dir>/simple-ci.conf` — and does not merge them, so a
repo-local conf shadows the host settings (`CI_HOSTS`, `CI_HOST`, `CI_REMOTE_SCRIPT`,
`CI_SERVER_URL`) that `~/.config/simple-ci.conf` would have supplied. Source that file
rather than restating them, and real host names stay out of the repo:

```sh
. "$HOME/.config/simple-ci.conf"
CI_RSYNC_ARGS="--include=ci/.changed-files"
```

If the repo also uses `ci/changed-functions`, add `--include=ci/.changed-functions`.

**Signature of getting this wrong: a green unit job that ran no tests.**
`ci/test.sh` tests `[ ! -s "$CHANGED" ]`, so a missing manifest is indistinguishable
from an empty one — it prints `ci/test: no staged source/test files — nothing to
run.` and exits 0. The commit goes green having tested nothing. `examples/ci/setup.sh`
carries a precondition check that turns this into a loud failure; keep it.

### The flake gate

`scripts/flake-gate.mjs` runs from inside `$ORG_HOOKS/ci/e2e.sh`, after Playwright
and before the exit-code decision — **not** from `profiles/sci-tiered.yml`. Reading
only the profile suggests there is no flake gate.

It appends this run's per-test outcomes to `~/ci-flake/<repo>-flake.jsonl`
(`CI_FLAKE_FILE`, else derived from `CI_REPO`, which simple-ci's runner exports),
then blocks the commit if any test that flaked or failed **this** run is non-pass in
≥40% of its last 10 recorded runs, once it has at least 6 records. `test.skip`/
`fixme` count as skipped and are ignored. It is skipped entirely on the
`CI_SELECTOR` path.

It reads `PLAYWRIGHT_JSON`, which `ci/e2e.sh` sets to
`$WORKTREE/test-results/results.json`. **The repo's Playwright config must have a
`json` reporter writing exactly there**, repo-root-relative — a config living in a
subdirectory has to point its `outputFile` back up:

```ts
reporter: [["list"], ["json", { outputFile: "../../test-results/results.json" }]]
```

Without it the file never exists, the gate's top-level catch logs
`[flake-gate] internal error, failing open (not blocking)` and exits 0. It never
blocks and never records history — the second "looks wired, does nothing" case after
the manifest above.

Alongside it, `ci/assert-all-ran.sh` hard-fails the job if Playwright reported any
test as "did not run".

### Host prerequisite

The build host needs a clone at `~/ci-workspace/<repo>`, whose directory name is the
repo name in the push target, and `origin/HEAD` must resolve. The client needs a
`simple-ci.conf` naming a reachable host. Both are simple-ci's, not org-hooks': see
[simple-ci's quickstart](../simple-ci/docs/quickstart.md).

### Tier-1 allowlists

Tier 1 is grandfather-friendly: each check takes a repo-root allowlist, one entry per
line, `#` comments ignored. Every entry should carry a reason.

| File | Exempts | Checked by |
|---|---|---|
| `.no-reexports-allow` | path substrings — an intentional barrel file | `check-no-reexports.mjs` |
| `.size-cap-allow` | path substrings — a file over the 500-line production cap | `hygiene.sh size-cap` |
| `.dup-types-allow` | type **names** — a name deliberately declared in more than one file | `check-duplicate-types.mjs` |

`.no-jsdoc-tags-allow` exempts path substrings from the banned-TSDoc-tag check;
`sci-tiered.yml` does not run that check.

### Adoption checklist

1. Clone the repo on the build host at `~/ci-workspace/<repo>`, and confirm
   `sci host` resolves from your machine.
2. Copy `examples/lefthook.stub.yml` to `lefthook.yml`, list **only**
   `profiles/sci-tiered.yml` under `configs:`, and declare no `pre-commit:` block.
3. Create the `rc:` file: export `ORG_HOOKS`, then `. "$ORG_HOOKS/rc.sh"`.
4. Copy `examples/ci/*` to `ci/`, `chmod +x ci/before-test-push ci/test ci/e2e`, and
   fill in the repo specifics in `ci/setup.sh`.
5. Set `CI_E2E_SMOKE_CMD` in `ci/e2e` unless the repo has a `test:e2e:smoke` script,
   and `CI_E2E_SPEC_CMD` unless `playwright.config.ts` sits at the repo root.
6. `ci/simple-ci.conf` (copied in step 4) sources `~/.config/simple-ci.conf` and sets
   `CI_RSYNC_ARGS="--include=ci/.changed-files"`. The repo conf replaces that file
   rather than extending it, hence the source line.
7. Gitignore `ci/.changed-files` and `coverage/`.
8. Add the npm scripts the profile runs: `type-check` and `knip`.
9. Configure the lcov reporters: vitest v8 + `lcov` → `coverage/lcov.info`; the E2E
   run → `coverage/e2e/lcov.info`.
10. Run `npm ci` in the org-hooks checkout — on your machine and on the CI host.
    `scripts/e2e-coverage.mjs` needs `monocart-coverage-reports`; it exits 1 naming
    this step if the dependency is missing. Keep the host's checkout current too —
    see [Updating the host's checkout](#updating-the-hosts-checkout).
11. Add the Playwright `json` reporter at `test-results/results.json`.
12. `lefthook install`, then make a throwaway commit. Read the unit job's log and
    confirm it names the files it tested — a "nothing to run" pass means step 6 or 7
    is wrong.
13. Once tier 2 is green, seed `coverage-union-baseline.json` with
    `coverage-ratchet.mjs --seed` and commit it.

### Updating the host's checkout

One org-hooks checkout serves every job on a build host, and jobs run
concurrently. `npm ci` deletes `node_modules` wholesale, so an update that runs
while a job is importing from it fails that job with `ERR_MODULE_NOT_FOUND` —
which reads as a code bug, not a stale host.

Two pieces keep that from happening. A job takes `$ORG_HOOKS/.cilock` **shared**
in its `ci/setup.sh`; because that file is sourced, the descriptor stays open for
the job's life:

```sh
exec 8<"$ORG_HOOKS/.cilock"
flock -s -w 600 8 || exit 1
```

The update takes the same lock **exclusive**, so it waits for running jobs and a
job starting mid-update waits for the install. That lock is what makes the update
safe, so it can run on a plain schedule — in simple-ci's `~/.config/simple-ci/schedule.tcl`:

```tcl
cron {every 15m at 0m} {
    catch {exec sh $::env(HOME)/.config/simple-ci/org-hooks-sync.sh &}
}
```

Not `CI_IDLE_HOOK`: that fires on a busy→idle transition observed by a 10-second
maintenance tick, so a job shorter than one tick never registers as busy and the
hook never runs.

The script belongs outside the checkout — `git pull` would rewrite it while `sh`
is still reading it:

```sh
flock -x -w 60 "$ORG_HOOKS/.cilock" sh -c '
    cd "$ORG_HOOKS" && git pull --ff-only -q
    [ package-lock.json -nt node_modules ] && npm ci --silent
'
```

`ci/setup.sh` should also fail loudly when `node_modules` is absent or older than
`package-lock.json`, so a host that never got its update names the reason instead
of failing somewhere downstream. Gitignore `.cilock`.

## Coverage ratchet

The ratchet is invoked from `profiles/sci.yml` (via `scripts/ratchet-staged.sh`),
not as a separate lefthook command. This
is intentional: lefthook v2 has no command-level ordering that survives `parallel: true`,
so a separate command would race the test job and check stale lcov.
By inlining the ratchet after the `scp` sync, ordering is enforced by the shell.

Two independent ratchets, one per sci command:

| sci command | Baseline file | lcov source |
|---|---|---|
| `unit-tests` | `coverage-baseline.json` | `coverage/lcov.info` |
| `e2e-tests` | `coverage-e2e-baseline.json` | `coverage/e2e/lcov.info` |

A repo with no committed baseline file is not gated: the hook-side wrapper
(`ratchet-staged.sh`) exits 0 when the baseline or lcov is missing. Seeding a
baseline is a deliberate act — run `coverage-ratchet.mjs --seed` (below); from
then on every commit ratchets against it.

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

**Staged-file filter** (applied by `scripts/ratchet-staged.sh` via `git diff --cached`):

| ratchet | glob |
|---|---|
| unit | `^src/.*\.(ts\|tsx\|js\|jsx\|mjs\|cjs)$` |
| e2e | `^src/.*\.(ts\|tsx)$` |

Both exclude `src/test/`, `__tests__/`, `*.test.*`, `*.spec.*`.
Per-repo additional excludes: create `coverage-ratchet-exclude` / `coverage-e2e-ratchet-exclude` in the repo root — one path per line, `#` comments supported.

Example `coverage-e2e-ratchet-exclude`:
```
# GPS hardware interface — snap logic requires real GPS; can't reach 75% in E2E
src/components/MapView/hooks/useGpsSnap.ts
```

**Env var overrides**: `COVERAGE_LCOV`, `COVERAGE_BASELINE`, `COVERAGE_E2E_LCOV`,
`COVERAGE_E2E_BASELINE`, `COVERAGE_FLOOR` (0–1, default 0.75),
`COVERAGE_TOLERANCE` (0–1, default 0.005 = 0.5 pp),
`COVERAGE_REGRESSION_WAIVER` (0–1, default 0.90 — a baselined file at or above this
may regress freely), `COVERAGE_LINE_TOLERANCE` (absolute covered-line slack, default
5 — a drop passes within *either* the pp tolerance or this many lines).

**Tests**: pure helpers live in `scripts/coverage-ratchet-lib.mjs`; run the
suite with `node --test scripts/coverage-ratchet.test.mjs` (uses node:test,
no external deps). The dispatch core and staged-filter wrapper have their own
subprocess suites: `node --test scripts/sci-run.test.mjs scripts/ratchet-staged.test.mjs`.

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
| uv | Python runner — `uv tool run` for vulture/deptry/import-linter, `uv run` for the project's own mypy/pytest | `~/.local/bin` |
| ktlint | Kotlin format+lint | release binary → `/usr/local/bin/ktlint` (self-executable, needs JDK 17+) |
| detekt | Kotlin static analysis | `detekt-cli-<ver>-all.jar` → wrap as `detekt` on PATH (`java -jar …`) |
| typos | spell check (optional) | `cargo install typos-cli` |

Per-repo JS tools (Biome/knip/dpdm/typescript) are pinned as repo
devDependencies and invoked via `npx --no-install` — never global.

## Onboarding a repo

See `examples/lefthook.stub.yml` for the step-by-step checklist. Repos
are onboarded **one at a time** and verified before moving on.

A repo adopting `profiles/sci-tiered.yml` also supplies the four `ci/` files —
templates in `examples/ci/`, contract and checklist in
[The `ci/` contract required by `profiles/sci-tiered.yml`](#the-ci-contract-required-by-profilessci-tieredyml).

## Tagging

Consumers pin a `ref:`. Cut a tag after any change:
`git tag vX.Y.Z && git push --tags` (bump consumers deliberately).

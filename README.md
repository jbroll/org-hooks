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
| `lefthook-common.yml` | pre-commit, commit-msg, pre-merge-commit | secret scan (gitleaks), hygiene (large files / conflict markers / EOF), commit-msg lint (gitlint), linear-history guard |
| `lefthook-push.yml` | pre-push | language-agnostic push gates |
| `profiles/ts.yml` | adds to pre-commit/pre-push | Biome (staged) · tsc · knip · dpdm · duplicate-type scan · no-reexports · size-cap |
| `profiles/python.yml` | adds to pre-commit/pre-push | ruff format+lint (staged) · mypy · vulture · deptry · size-cap |
| `profiles/specs.yml` | pre-commit/post-commit | AI-Roller `air check` / artifact-drift (ai-roller only) |
| `profiles/sci.yml` | pre-commit | simple-ci GPU dispatch for unit + e2e; syncs lcov back after dispatch |
| `profiles/coverage.yml` | pre-commit (after unit-tests) | coverage ratchet — per-file lcov baseline; fails on regression |

Heavy tests/coverage/e2e are dispatched to the remote GPU queue via `profiles/sci.yml`.
The `profiles/coverage.yml` ratchet runs after tests and enforces that no commit reduces
per-file line coverage below its previous high-water mark. Claude Code agent (`stop`) hooks
stay in `.claude/settings.json` — intentionally decoupled from git hooks.

## Coverage ratchet

`profiles/coverage.yml` adds a `coverage-ratchet` pre-commit command that reads
`coverage/lcov.info` and compares it against a committed `coverage-baseline.json`.

Rules (per staged source file):
- **New file**: must reach the configured floor (default 75% lines hit).
- **Existing file at ≥ floor**: must stay at or above the floor.
- **Existing file below floor**: uncovered-line count must not increase.

On pass the baseline is rewritten with the current run's numbers and re-staged.
On fail the commit is aborted with a per-file summary.

To enable on a repo:
1. Add `lcov` to your test runner's coverage reporters (`npm run test:coverage` must
   produce `coverage/lcov.info`).
2. Add `profiles/coverage.yml` to `remotes.configs` in `lefthook.yml`.
3. Run `npm run test:coverage` once; the baseline is written automatically on the
   first passing run and committed with that change.

When used with `profiles/sci.yml`, the lcov is synced from the CI host after a
dispatched job so the ratchet always operates on fresh data.

## Host tools (installed once per machine)

| Tool | Purpose | Install |
|---|---|---|
| lefthook | hook runner | `npm i -g lefthook` |
| gitleaks | secret scanning | release binary → `~/.local/bin` |
| ruff | Python format+lint | (already present) `~/.local/bin` |
| mypy | Python type check | `uv tool install mypy` |
| gitlint | commit-msg lint | `uv tool install gitlint` |
| typos | spell check (optional) | `cargo install typos-cli` |

Per-repo JS tools (Biome/knip/dpdm/typescript) are pinned as repo
devDependencies and invoked via `npx --no-install` — never global.

## Onboarding a repo

See `examples/lefthook.stub.yml` for the step-by-step checklist. Repos
are onboarded **one at a time** and verified before moving on.

## Tagging

Consumers pin a `ref:`. Cut a tag after any change:
`git tag vX.Y.Z && git push --tags` (bump consumers deliberately).

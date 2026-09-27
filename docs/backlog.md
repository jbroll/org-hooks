# Backlog

Outstanding work only. What the hooks do today is described in `README.md`; what was done
and when is in the git log.

## Coverage

- **Whole-baseline gating needs a per-file "exercised" signal.** `coverage-ratchet.mjs
  --check-all` (`COVERAGE_CHECK_ALL=1`) treats presence in the lcov as evidence the run
  measured a file, and presence is not measurement. A suite that selects tests by impact
  still *loads* files it never exercises, so they land in the lcov at or near zero while
  the baseline holds the high-water mark an earlier run — one that did exercise them —
  ratcheted up. On KinoQ's impact-selected tier-2 union, 71 of 197 baselined files read as
  regressions on that basis; `packages/sim-bridge/src/secret.ts` arrives as `LF:20 LH:0`
  against a 100% mark. The flag is therefore usable only by a repo whose gate runs the full
  suite every time.

  The fix is to carry an exercised flag per file out of the union merge, which is the only
  stage that sees each input suite separately and already distinguishes real coverage from
  incidental instrumentation in `scrubIncidentalUnit`. Gating on whether the measured line
  total matches the baseline's is worse: the baseline stores a percentage, not a total, so
  the comparison has nothing to anchor to, and any edit to a file changes its total without
  saying anything about whether the run exercised it. Gating against a persisted full-run
  union rather than the per-commit one is worse too: it moves the check onto data that can
  be several commits stale, so it reports regressions against code that no longer exists
  and misses the ones a commit just introduced.

- **The coverage ratchet's documentation is behind its code.** `README.md` documents the
  baseline format as bare numbers, lists the per-file rules, and gives an env-var list
  ending at `COVERAGE_LINE_TOLERANCE`. Missing: the `COVERAGE_BRANCHES`,
  `COVERAGE_CHECK_ALL` and `COVERAGE_BRANCH_TOLERANCE` environment variables; the
  `--branches`, `--check-all` and `--branch-tolerance` flags; the `{ lines, branches }`
  per-file baseline form that a bare number still remains valid alongside; and that the
  absolute slack differs per metric — 5 lines against 2 branches. The
  `COVERAGE_REGRESSION_WAIVER_DROP` paragraph spells out a boundary case (a file falling
  from 100% to exactly 95%) that a float epsilon now tolerates, so the described edge is no
  longer where the boundary actually falls. In `scripts/coverage-ratchet-lib.mjs`,
  `checkOne`'s JSDoc has `branchTolerance` and `branches` inserted mid-sentence through
  `regressionWaiver`'s description, and its `@param` options type does not list either
  field.

- **A branch gate switches itself off silently when branch records vanish.** `branchPct`
  reports 100% for a file with zero branches, which is right for a file that genuinely has
  none. A file carrying a recorded branch figure that arrives with no branch records at all
  reads the same way and passes — which is what happens if a scrub drops them, an input
  loses instrumentation, or the branch union regresses. The line side treats the analogous
  case, a file absent from the lcov, as a regression to zero. The guard in `ratchetUp` (only
  recording a branch mark when `branchesFound > 0`) stops this from corrupting the
  baseline, so the damage is silence, not bad data. A fix has to tell a file that
  legitimately lost every branch to a refactor from one whose records merely disappeared —
  failing both would make a routine refactor unpassable. A loud warning naming the affected
  files is preferable to a failure.

## Consumers

- **Rowboat's `ci/test` header claims a pre-push wiring that does not exist.**
  `ci/test:2-5` says "Wired into `git push` via the pre-push hook in
  lefthook.yml", but rowboat's `lefthook.yml` has no `pre-push:` block and
  neither does the `profiles/ts.yml` it pulls. Fix the comment or wire the
  hook; while here, confirm no other consumer carries the same stale claim.

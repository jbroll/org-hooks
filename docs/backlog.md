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

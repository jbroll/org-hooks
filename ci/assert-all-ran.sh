#!/usr/bin/env bash
# Hard-fail if Playwright reported any test as "did not run".
# "did not run" = scheduled but never executed (serial cascade after a failure,
# a failed setup dependency, or an interrupted run) — an UNKNOWN, not a pass.
# Playwright prints "N did not run" ONLY for these (test.skip/fixme report as
# "skipped", which the flake gate ignores). Without this guard an incomplete run
# can slip through pass/fail accounting and seed coverage from a partial suite.
# Usage: assert-all-ran.sh <playwright-output-log>
set -euo pipefail
log="${1:?usage: assert-all-ran.sh <playwright-output-log>}"
[ -f "$log" ] || exit 0
if grep -qE '[1-9][0-9]* did not run' "$log"; then
  n=$(grep -oE '[1-9][0-9]* did not run' "$log" | tail -1)
  echo "ci: HARD FAIL — Playwright reported '$n'." >&2
  echo "    Tests were scheduled but never executed. An incomplete suite is not a pass." >&2
  exit 1
fi

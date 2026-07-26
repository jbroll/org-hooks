#!/usr/bin/env bash
# Per-commit E2E orchestrator. Emits coverage/e2e/lcov.info for the union gate.
# Selector path (CI_SELECTOR) = targeted manual run; otherwise coverage-based
# spec selection with RUN_ALL -> smoke fallback, then the flake gate.
set -euo pipefail
: "${WORKTREE:?WORKTREE must be exported by the consumer shim}"
: "${ORG_HOOKS:?ORG_HOOKS must be set}"
# shellcheck source=/dev/null
. "${CI_SETUP:?CI_SETUP must point at the consumer setup callback}"
cd "$WORKTREE"

# Kill the entire process group on exit so Playwright's webServer (Vite) doesn't
# survive as an orphan holding port 4310/5199 when fail-fast kills the job.
trap 'kill -- -$$ 2>/dev/null || true' EXIT INT TERM

export CI=true
npm install

if [ -n "${CI_SELECTOR:-}" ]; then
  echo "ci/e2e: explicit selector '$CI_SELECTOR' (targeted; chromium; TIA + flake gate skipped)"
  npx playwright test "$CI_SELECTOR" --project=chromium 2>&1 | tee "$WORKTREE/playwright-output.log"
  rc=${PIPESTATUS[0]}
  bash "$ORG_HOOKS/ci/assert-all-ran.sh" "$WORKTREE/playwright-output.log"
  exit "$rc"
fi

SEL="$(node "$ORG_HOOKS/scripts/e2e-select-cli.mjs" "$WORKTREE/ci/.changed-files" 2>>"$WORKTREE/e2e-select.stderr.log" || echo RUN_ALL)"

set +e
if [ "$SEL" = "RUN_ALL" ] || [ -z "$SEL" ]; then
  echo "ci/e2e: RUN_ALL -> running @smoke core (full suite runs via e2e-map)"
  # shellcheck disable=SC2086,SC2294
  eval ${CI_E2E_SMOKE_CMD:-npm run test:e2e:smoke} 2>&1 | tee "$WORKTREE/playwright-output.log"
  PW_EXIT=${PIPESTATUS[0]}
else
  echo "ci/e2e: running selected specs:"
  # shellcheck disable=SC2001
  echo "$SEL" | sed 's/^/  /'
  # shellcheck disable=SC2086
  npx playwright test $SEL 2>&1 | tee "$WORKTREE/playwright-output.log"
  PW_EXIT=${PIPESTATUS[0]}
fi

PLAYWRIGHT_JSON="$WORKTREE/test-results/results.json" node "$ORG_HOOKS/scripts/flake-gate.mjs"
GATE_EXIT=$?
set -e

bash "$ORG_HOOKS/ci/assert-all-ran.sh" "$WORKTREE/playwright-output.log"

if [ "$PW_EXIT" -ne 0 ]; then
  echo "ci/e2e: Playwright failed (exit $PW_EXIT)."
  exit "$PW_EXIT"
fi
exit "$GATE_EXIT"

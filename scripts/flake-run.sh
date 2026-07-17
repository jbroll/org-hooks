#!/usr/bin/env bash
# flake-run.sh <e2e|unit> — run a suite with retries and feed the org-hooks flake gate.
# CI (CI=true): firehose ~/ci-flake/<repo>-<suite>.jsonl, retries 2.
# Local:        firehose ${FLAKE_HOME:-~/.cache/org-hooks/flake}/<repo>-<suite>.jsonl.
# Fail-open: the gate never wedges the run; a real suite failure exits non-zero regardless.
set -uo pipefail
KIND="${1:?usage: flake-run.sh <e2e|unit>}"
HERE="$(cd "$(dirname "$0")" && pwd)"
GATE="$HERE/flake-gate.mjs"
REPORTER="$HERE/vitest-flake-reporter.mjs"
REPO="${CI_REPO:-$(basename "$(git rev-parse --show-toplevel 2>/dev/null || echo repo)")}"

if [ -n "${CI:-}" ]; then
  BASE="$HOME/ci-flake"; RETRIES=2
else
  BASE="${FLAKE_HOME:-$HOME/.cache/org-hooks/flake}"; RETRIES="${FLAKE_LOCAL_RETRIES:-2}"
fi
mkdir -p "$BASE"

case "$KIND" in
  e2e)
    FIRE="$BASE/${REPO}-e2e.jsonl"
    set +e
    npm run test:e2e -- --retries="$RETRIES"
    SUITE=$?
    CI_FLAKE_FILE="$FIRE" CI_REPO="$REPO" PLAYWRIGHT_JSON="test-results/results.json" node "$GATE"
    GATE_EXIT=$?
    set -e
    ;;
  unit)
    FIRE="$BASE/${REPO}-unit.jsonl"
    REC="$(mktemp)"; REC_BE="$(mktemp)"
    set +e
    VITEST_RETRY="$RETRIES" VITEST_FLAKE_REPORTER="$REPORTER" VITEST_FLAKE_OUT="$REC" \
      VITEST_PROJECT="unit-frontend" npm run test:run
    FE=$?
    ( cd backend && VITEST_RETRY="$RETRIES" VITEST_FLAKE_REPORTER="$REPORTER" VITEST_FLAKE_OUT="$REC_BE" \
      VITEST_PROJECT="unit-backend" npm test )
    BE=$?
    cat "$REC_BE" >> "$REC" 2>/dev/null || true
    SUITE=0; { [ $FE -eq 0 ] && [ $BE -eq 0 ]; } || SUITE=1
    CI_FLAKE_FILE="$FIRE" CI_REPO="$REPO" FLAKE_FORMAT=normalized FLAKE_RECORDS="$REC" node "$GATE"
    GATE_EXIT=$?
    rm -f "$REC" "$REC_BE"
    set -e
    ;;
  *) echo "flake-run.sh: unknown suite '$KIND'" >&2; exit 2 ;;
esac

[ "${SUITE:-0}" -eq 0 ] || exit "$SUITE"
exit "${GATE_EXIT:-0}"

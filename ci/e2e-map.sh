#!/usr/bin/env bash
# Full E2E suite + spec->src impact-map rebuild. Map refreshed ONLY from a green
# run (a red/partial run poisons selection). Lower parallelism than per-commit.
set -euo pipefail
: "${WORKTREE:?WORKTREE must be exported by the consumer shim}"; export WORKTREE
: "${ORG_HOOKS:?ORG_HOOKS must be set}"
# shellcheck source=/dev/null
. "${CI_SETUP:?CI_SETUP must point at the consumer setup callback}"
cd "$WORKTREE"

export CI=true
export E2E_BUILD_IMPACT_MAP=1
export PLAYWRIGHT_WORKERS="${PLAYWRIGHT_WORKERS:-2}"
npm install

rm -rf "$WORKTREE/${CI_IMPACT_DIR:-coverage/e2e-impact}"

set +e
# shellcheck disable=SC2086,SC2294
eval ${CI_E2E_FULL_CMD:-npm run test:e2e} 2>&1 | tee "$WORKTREE/playwright-output.log"
PW_EXIT=${PIPESTATUS[0]}
set -e

bash "$ORG_HOOKS/ci/assert-all-ran.sh" "$WORKTREE/playwright-output.log"

if [ "$PW_EXIT" -ne 0 ]; then
  echo "ci/e2e-map: full E2E suite FAILED (exit $PW_EXIT) — coverage map NOT updated."
  exit "$PW_EXIT"
fi
echo "ci/e2e-map: full E2E suite passed — refreshing coverage map."

CI_FLAKE_MAP_PATH="${CI_FLAKE_MAP:-$HOME/ci-flake/${CI_REPO}-e2e-impact.json}"
mkdir -p "$(dirname "$CI_FLAKE_MAP_PATH")"
set +e
flock "${CI_FLAKE_MAP_PATH}.lock" -c "node \"$ORG_HOOKS/scripts/build-e2e-map.mjs\""
BUILD_EXIT=$?
set -e

echo "ci/e2e-map: full E2E lcov at $WORKTREE/coverage/e2e/lcov.info"
exit "$BUILD_EXIT"

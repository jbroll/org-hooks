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

# Persist the full-run e2e lcov (green-only, like the impact map above) so the
# per-commit union gate can carry forward complete e2e attribution even when TIA
# selected a spec subset (coverage-union-merge.mjs --e2e-baseline). Best-effort:
# a copy failure must not fail the (passing) e2e-map run.
CI_FLAKE_E2E_LCOV="${CI_FLAKE_E2E_FULLRUN:-$HOME/ci-flake/${CI_REPO}-e2e-fullrun.lcov}"
mkdir -p "$(dirname "$CI_FLAKE_E2E_LCOV")"
if flock "${CI_FLAKE_E2E_LCOV}.lock" -c "cp \"$WORKTREE/coverage/e2e/lcov.info\" \"$CI_FLAKE_E2E_LCOV\""; then
  echo "ci/e2e-map: persisted full-run e2e lcov -> $CI_FLAKE_E2E_LCOV"
  # Persist the commit this baseline was measured on. The per-commit union gate
  # remaps the baseline's line numbers through `git diff <sha>` so a later
  # line-shifting edit (e.g. a barrel→leaf import split) stays coverage-neutral
  # (coverage-union-merge.mjs --e2e-baseline-sha). Best-effort.
  BASE_SHA="$(git -C "$WORKTREE" rev-parse HEAD 2>/dev/null || true)"
  if [ -n "$BASE_SHA" ]; then
    flock "${CI_FLAKE_E2E_LCOV}.lock" -c "printf '%s\n' '$BASE_SHA' > \"${CI_FLAKE_E2E_LCOV%.lcov}.sha\"" \
      && echo "ci/e2e-map: persisted baseline sha $BASE_SHA"
  fi
else
  echo "ci/e2e-map: WARNING — could not persist full-run e2e lcov (continuing)"
fi

echo "ci/e2e-map: full E2E lcov at $WORKTREE/coverage/e2e/lcov.info"
exit "$BUILD_EXIT"

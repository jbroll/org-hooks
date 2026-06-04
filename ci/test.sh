#!/usr/bin/env bash
# Per-commit unit job: vitest related over ci/.changed-files. Emits unit lcov
# for the union gate (ratchet runs in the sci-tiered orchestrator, not here).
set -euo pipefail
: "${WORKTREE:?WORKTREE must be exported by the consumer shim}"
# shellcheck source=/dev/null
. "${CI_SETUP:?CI_SETUP must point at the consumer setup callback}"
cd "$WORKTREE"
npm install
CHANGED="$WORKTREE/ci/.changed-files"
if [ ! -s "$CHANGED" ]; then
    echo "ci/test: no staged source/test files — nothing to run."
    exit 0
fi
mapfile -t CHANGED_FILES < "$CHANGED"
echo "ci/test: vitest related for ${#CHANGED_FILES[@]} changed file(s):"
printf '  %s\n' "${CHANGED_FILES[@]}"
# --isolate: the targeted `related` subset can co-schedule a jazz-mocking test
# with a real-jazz one in one worker; default isolate:false leaks the mock.
npx vitest related --run --isolate --coverage "${CHANGED_FILES[@]}"

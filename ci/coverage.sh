#!/usr/bin/env bash
# Full unit coverage (deliberate baseline reseed). Emits full unit lcov.
set -euo pipefail
: "${WORKTREE:?WORKTREE must be exported by the consumer shim}"
# shellcheck source=/dev/null
. "${CI_SETUP:?CI_SETUP must point at the consumer setup callback}"
cd "$WORKTREE"
npm install
# shellcheck disable=SC2294
eval "${CI_COVERAGE_CMD:-npm run test:coverage}"

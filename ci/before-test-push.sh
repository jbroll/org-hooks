#!/usr/bin/env bash
# Write staged source/test files to ci/.changed-files so the CI worktree (no
# branch history) can scope `vitest related`. Runs locally where git history is
# intact. File-type filter via CI_CHANGED_GLOB.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
git diff --cached --name-only --diff-filter=ACMR \
    | grep -E "${CI_CHANGED_GLOB:-^(src|scripts|ci)/.*\.(ts|tsx|js|jsx|mjs|cjs)$}" \
    > ci/.changed-files || true

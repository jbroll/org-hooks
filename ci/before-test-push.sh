#!/usr/bin/env bash
# Write staged source/test files to ci/.changed-files so the CI worktree (no
# branch history) can scope `vitest related`. Runs locally where git history is
# intact. File-type filter via CI_CHANGED_GLOB.
#
# The default glob includes packages/ (monorepo workspaces) so workspace tests
# are selected by `vitest related`. This MUST stay aligned with the union
# ratchet's staged-file detector (profiles/sci-tiered.yml, ^(src|packages)/):
# any source dir the ratchet gates for coverage must also be selected here, or
# its tests never run and it ratchets at a false zero-coverage regression.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
git diff --cached --name-only --diff-filter=ACMR \
    | grep -E "${CI_CHANGED_GLOB:-^(src|scripts|ci|packages)/.*\.(ts|tsx|js|jsx|mjs|cjs)$}" \
    > ci/.changed-files || true

# Optional finer e2e TIA: if the repo provides ci/changed-functions, let it emit a
# per-function changed manifest (same opt-in convention as ci/before-test-push).
# Best-effort: a failure removes the partial file so selection degrades to file-level.
if [ -x ci/changed-functions ]; then
    ci/changed-functions > ci/.changed-functions || rm -f ci/.changed-functions
fi

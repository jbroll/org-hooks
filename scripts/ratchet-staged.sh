#!/usr/bin/env bash
# Staged-file coverage-ratchet wrapper — the ONE copy of the "which staged
# files does the ratchet gate" filtering that the sci profiles previously
# inlined (with drifting regexes). Selects staged source files, subtracts the
# per-repo exclude file, and runs coverage-ratchet.mjs over the survivors.
#
#   ratchet-staged.sh --lcov path --baseline path
#                     [--exclude-file path] [--glob ERE] [--exclude ERE]
#
# No committed baseline or no lcov on disk → exit 0: seeding a baseline is a
# deliberate act (coverage-ratchet.mjs --seed), never a hook side-effect.
set -euo pipefail

usage() {
  echo "usage: ratchet-staged.sh --lcov path --baseline path [--exclude-file path] [--glob ERE] [--exclude ERE]" >&2
  exit 2
}

lcov="" baseline="" exclude_file=""
glob='^src/.*\.(ts|tsx|js|jsx|mjs|cjs)$'
exclude='(^src/test/|/__tests__/|\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$)'
while [ $# -gt 0 ]; do
  case "$1" in
    --lcov) lcov="${2:?}"; shift 2 ;;
    --baseline) baseline="${2:?}"; shift 2 ;;
    --exclude-file) exclude_file="${2:?}"; shift 2 ;;
    --glob) glob="${2:?}"; shift 2 ;;
    --exclude) exclude="${2:?}"; shift 2 ;;
    *) usage ;;
  esac
done
[ -n "$lcov" ] && [ -n "$baseline" ] || usage
[ -f "$baseline" ] && [ -f "$lcov" ] || exit 0

staged=$(git diff --cached --name-only --diff-filter=ACMR \
  | grep -E "$glob" | grep -Ev "$exclude" || true)
if [ -n "$exclude_file" ] && [ -f "$exclude_file" ]; then
  excl=$(mktemp)
  grep -v '^#' "$exclude_file" | grep -v '^[[:space:]]*$' > "$excl" || true
  staged=$(printf '%s\n' "$staged" | grep -vFf "$excl" || true)
  rm -f "$excl"
fi
[ -n "$staged" ] || exit 0

# shellcheck disable=SC2086 — the staged list is deliberately word-split
node "$(dirname "$0")/coverage-ratchet.mjs" --lcov "$lcov" --baseline "$baseline" $staged

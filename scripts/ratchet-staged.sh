#!/usr/bin/env bash
# Staged-file coverage-ratchet wrapper — the ONE copy of the "which staged
# files does the ratchet gate" filtering that the sci profiles previously
# inlined (with drifting regexes). Selects staged source files, subtracts the
# per-repo exclude file, and runs coverage-ratchet.mjs over the survivors.
#
#   ratchet-staged.sh --lcov path --baseline path
#                     [--exclude-file path] [--glob ERE] [--exclude ERE]
#                     [--branches] [--check-all]
#
# --branches and --check-all are also switched on by COVERAGE_BRANCHES=1 and
# COVERAGE_CHECK_ALL=1, so a repo opts in from its lefthook-rc.sh without the
# shared profile naming the flags.
#
# No committed baseline or no lcov on disk → exit 0: seeding a baseline is a
# deliberate act (coverage-ratchet.mjs --seed), never a hook side-effect.
set -euo pipefail

usage() {
  echo "usage: ratchet-staged.sh --lcov path --baseline path [--exclude-file path] [--glob ERE] [--exclude ERE] [--branches] [--check-all]" >&2
  exit 2
}

lcov="" baseline="" exclude_file=""
branches="" check_all=""
[ "${COVERAGE_BRANCHES:-}" = "1" ] && branches="--branches"
[ "${COVERAGE_CHECK_ALL:-}" = "1" ] && check_all="--check-all"
glob='^src/.*\.(ts|tsx|js|jsx|mjs|cjs)$'
exclude='(^src/test/|/__tests__/|\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$)'
while [ $# -gt 0 ]; do
  case "$1" in
    --lcov) lcov="${2:?}"; shift 2 ;;
    --baseline) baseline="${2:?}"; shift 2 ;;
    --exclude-file) exclude_file="${2:?}"; shift 2 ;;
    --glob) glob="${2:?}"; shift 2 ;;
    --exclude) exclude="${2:?}"; shift 2 ;;
    --branches) branches="--branches"; shift ;;
    --check-all) check_all="--check-all"; shift ;;
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
# A check-all run has a whole baseline to gate, so an empty staged list is not
# a reason to skip it.
[ -n "$staged" ] || [ -n "$check_all" ] || exit 0

# The staged list and the optional flags are deliberately word-split.
# shellcheck disable=SC2086
node "$(dirname "$0")/coverage-ratchet.mjs" --lcov "$lcov" --baseline "$baseline" \
  $branches $check_all $staged

#!/usr/bin/env bash
# Shared simple-ci dispatch core — the ONE copy of push/trap/wait used by the
# sci profiles and repo-local push gates. Dispatches <WT>/<job-suffix> to the
# CI host, streams the job log via `sci wait`, kills the remote job if the
# hook is interrupted, and exits with the job's exit code.
#
#   sci-run.sh [--label name] [--before script] [--lcov path] [--fallback cmd] <job-suffix>
#
#   --label name      display name for the "queued" line (default: the suffix)
#   --before script   run script before dispatch IF it exists+is executable
#                     (the ci/before-test-push convention); its failure aborts
#   --lcov path       after the job finishes, scp <host>:<job-worktree>/<path>
#                     to <path> locally (best-effort; never changes the exit code)
#   --fallback cmd    if the sci binary is absent, run cmd locally and exit with
#                     its code. Without it, a missing binary fails loudly (127).
#
# Env: SCI_BIN — sci binary (default /home/john/src/simple-ci/sci)
#      SCI_WT  — CI queue name; derived from the git COMMON dir when unset, so
#                every worktree of a repo resolves to the repo's own dir name.
set -euo pipefail

usage() {
  echo "usage: sci-run.sh [--label name] [--before script] [--lcov path] [--fallback cmd] <job-suffix>" >&2
  exit 2
}

label="" before="" lcov="" fallback=""
while [ $# -gt 0 ]; do
  case "$1" in
    --label) label="${2:?}"; shift 2 ;;
    --before) before="${2:?}"; shift 2 ;;
    --lcov) lcov="${2:?}"; shift 2 ;;
    --fallback) fallback="${2:?}"; shift 2 ;;
    --*) usage ;;
    *) break ;;
  esac
done
[ $# -eq 1 ] || usage
suffix="$1"
label="${label:-$suffix}"

SCI="${SCI_BIN:-/home/john/src/simple-ci/sci}"
if ! test -x "$SCI"; then
  if [ -n "$fallback" ]; then
    echo "  sci not found at $SCI — running fallback: $fallback" >&2
    exec sh -c "$fallback"
  fi
  echo "sci-run: sci binary not found at $SCI (set SCI_BIN)" >&2
  echo "sci-run: no --fallback given — refusing to skip the gate" >&2
  exit 127
fi

WT="${SCI_WT:-$(basename "$(cd "$(dirname "$(git rev-parse --git-common-dir)")" && pwd)")}"

if [ -n "$before" ] && [ -x "$before" ]; then
  "$before"
fi

job=$("$SCI" push "${WT}/${suffix}") || exit 1
echo "  ${label} queued (${job})"
# If the hook is interrupted, kill the remote job rather than leaving it to run.
trap '"$SCI" kill "$job" >/dev/null 2>&1 || true' INT TERM
rc=0
"$SCI" wait "$job" || rc=$?
trap - INT TERM

if [ -n "$lcov" ]; then
  # Retrieve the fresh lcov from the CI host so a ratchet run here checks
  # current data. Best-effort: coverage retrieval never masks the job result.
  if ci_host=$("$SCI" host 2>/dev/null) && [ -n "$ci_host" ]; then
    worktree=$("$SCI" path "$job" 2>/dev/null) || worktree=""
    if [ -n "$worktree" ]; then
      mkdir -p "$(dirname "$lcov")"
      scp -q "$ci_host:$worktree/$lcov" "$lcov" 2>/dev/null || true
    fi
  fi
fi

exit "$rc"

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
#   --lcov path       after a passing job, scp <read-host>:<job-worktree>/<path>
#                     to <path> locally, replacing it. A failed fetch exits 1
#                     rather than leaving a stale file for a ratchet to grade.
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

if [ -n "$lcov" ] && [ "$rc" -eq 0 ]; then
  # Reads go over a shell-capable login, not the push identity: that key is
  # forced to the CI receive script and can serve neither scp nor sftp.
  read_host=$("$SCI" readhost) || read_host=""
  worktree=$("$SCI" path "$job") || worktree=""
  if [ -z "$read_host" ] || [ -z "$worktree" ]; then
    echo "sci-run: ${label} passed, but the CI host for its lcov could not be resolved" >&2
    echo "sci-run: host='${read_host}' worktree='${worktree}' — refusing to grade stale $lcov" >&2
    exit 1
  fi
  rm -f "$lcov"
  mkdir -p "$(dirname "$lcov")"
  if ! scp -q "$read_host:$worktree/$lcov" "$lcov"; then
    echo "sci-run: ${label} passed, but its lcov did not come back from ${read_host}:${worktree}/${lcov}" >&2
    echo "sci-run: refusing to grade stale coverage" >&2
    exit 1
  fi
fi

exit "$rc"

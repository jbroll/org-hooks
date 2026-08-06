#!/usr/bin/env bash
# Run a command once per Python project owning the given staged files.
#
#   py-run.sh '<shell command>' <file>...
#
# mypy, pytest and deptry all resolve config, dependencies and import roots from
# the directory they start in. lefthook hands us repo-relative paths and runs at
# the repo root, which in a polyglot repo is not where pyproject.toml lives — so
# each file is mapped to its nearest ancestor pyproject.toml and the command runs
# there, once per distinct project. A .py under no pyproject.toml is an error,
# not a skip: it would otherwise sit permanently outside the gate.
set -euo pipefail

cmd="${1:?usage: py-run.sh '<command>' <file>...}"
shift

repo_root=$(git rev-parse --show-toplevel)

roots=""
for f in "$@"; do
  dir=$(cd "$(dirname "$f")" && pwd)
  root=""
  while :; do
    if [ -f "$dir/pyproject.toml" ]; then root="$dir"; break; fi
    [ "$dir" = "$repo_root" ] && break
    [ "$dir" = "/" ] && break
    dir=$(dirname "$dir")
  done
  if [ -z "$root" ]; then
    echo "  no pyproject.toml above $f — Python sources must belong to a project" >&2
    exit 1
  fi
  case " $roots " in *" $root "*) ;; *) roots="$roots $root";; esac
done

rc=0
for root in $roots; do
  ( cd "$root" && eval "$cmd" ) || rc=1
done
exit $rc

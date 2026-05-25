#!/usr/bin/env bash
# Language-agnostic repo-hygiene checks. Subcommand dispatched by name;
# remaining args are staged file paths (passed by lefthook {staged_files}).
set -euo pipefail

cmd="${1:-}"
shift || true

fail=0

case "$cmd" in
  large-files)
    # Block accidentally-staged blobs (default 1 MiB; override LF_MAX).
    max="${LF_MAX:-1048576}"
    for f in "$@"; do
      [ -f "$f" ] || continue
      sz=$(wc -c <"$f" | tr -d ' ')
      if [ "$sz" -gt "$max" ]; then
        echo "  large file: $f ($sz bytes > $max)"
        fail=1
      fi
    done
    ;;
  conflict-markers)
    for f in "$@"; do
      [ -f "$f" ] || continue
      if grep -nE '^(<{7}|={7}|>{7})( |$)' "$f" >/dev/null 2>&1; then
        echo "  merge-conflict marker in: $f"
        fail=1
      fi
    done
    ;;
  eof-ws)
    for f in "$@"; do
      [ -f "$f" ] || continue
      # Trailing whitespace
      if grep -nE ' +$' "$f" >/dev/null 2>&1; then
        echo "  trailing whitespace: $f"
        fail=1
      fi
      # Missing final newline (non-empty file)
      if [ -s "$f" ] && [ "$(tail -c1 "$f" | wc -l)" -eq 0 ]; then
        echo "  no final newline: $f"
        fail=1
      fi
    done
    ;;
  size-cap)
    # Per-file line cap on PRODUCTION source only (tests grow with
    # coverage and are exempt). Default 500; override SIZE_CAP. An
    # allowlisted file (one path-substring per line in .size-cap-allow,
    # '#' comments) is exempt — fail-on-new / grandfather pattern.
    cap="${SIZE_CAP:-500}"
    prod='^(src|bin|lib)/.*\.(ts|tsx|js|jsx|mjs|cjs|py)$'
    allow_file=".size-cap-allow"
    is_allowed() {
      [ -f "$allow_file" ] || return 1
      while IFS= read -r pat; do
        pat="${pat%%#*}"; pat="$(echo "$pat" | xargs 2>/dev/null || true)"
        [ -n "$pat" ] || continue
        case "$1" in *"$pat"*) return 0;; esac
      done < "$allow_file"
      return 1
    }
    for f in "$@"; do
      [ -f "$f" ] || continue
      echo "$f" | grep -qE "$prod" || continue
      case "$f" in test/*|tests/*|*/test/*|*/tests/*|*.test.*|*.spec.*) continue;; esac
      is_allowed "$f" && continue
      n=$(wc -l <"$f" | tr -d ' ')
      if [ "$n" -gt "$cap" ]; then
        echo "  $f: $n lines (cap $cap) — split it, or add to $allow_file with a reason"
        fail=1
      fi
    done
    ;;
  test-size-cap)
    # Per-file line cap on TEST source only. Default 800; override TEST_SIZE_CAP.
    # Uses .test-size-cap-allow for grandfathered exceptions.
    cap="${TEST_SIZE_CAP:-800}"
    allow_file=".test-size-cap-allow"
    is_allowed() {
      [ -f "$allow_file" ] || return 1
      while IFS= read -r pat; do
        pat="${pat%%#*}"; pat="$(echo "$pat" | xargs 2>/dev/null || true)"
        [ -n "$pat" ] || continue
        case "$1" in *"$pat"*) return 0;; esac
      done < "$allow_file"
      return 1
    }
    for f in "$@"; do
      [ -f "$f" ] || continue
      case "$f" in *.test.ts|*.test.tsx|*.test.js|*.test.jsx|*.spec.ts|*.spec.tsx) ;; *) continue;; esac
      is_allowed "$f" && continue
      n=$(wc -l <"$f" | tr -d ' ')
      if [ "$n" -gt "$cap" ]; then
        echo "  $f: $n lines (cap $cap) — split it, or add to $allow_file with a reason"
        fail=1
      fi
    done
    ;;
  no-merge-commit)
    # Blocks `git merge` that would create a merge commit on a protected
    # branch. Fast feedback only — GitHub Rulesets are authoritative.
    branch=$(git symbolic-ref --short HEAD 2>/dev/null || echo "")
    protected="${PROTECTED_BRANCHES:-main master}"
    for p in $protected; do
      if [ "$branch" = "$p" ]; then
        echo "  merge commits are not allowed on '$branch' — rebase instead:"
        echo "      git switch $branch && git rebase <branch>"
        exit 1
      fi
    done
    ;;
  *)
    echo "hygiene.sh: unknown subcommand '$cmd'" >&2
    exit 2
    ;;
esac

exit "$fail"

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
      # A PNG has neither trailing whitespace nor a final newline to speak of.
      grep -Iq . "$f" 2>/dev/null || continue
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
    # A src/, bin/, or lib/ segment ANYWHERE marks production source, so this
    # holds for a flat repo, a packages/<pkg>/src/ monorepo, a Python project in
    # its own subdirectory, and Gradle's <module>/src/main/kotlin/ alike. Only
    # staged paths reach here, so a vendored or built src/ can't be picked up.
    cap="${SIZE_CAP:-500}"
    prod='(^|/)(src|bin|lib)/.*\.(ts|tsx|js|jsx|mjs|cjs|py|kt|kts)$'
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
    cap="${TEST_SIZE_CAP:-800}"
    for f in "$@"; do
      [ -f "$f" ] || continue
      case "$f" in
        *.test.ts|*.test.tsx|*.test.js|*.test.jsx|*.spec.ts|*.spec.tsx) ;;
        test_*.py|*/test_*.py|*_test.py|conftest.py|*/conftest.py) ;;  # pytest layout
        *Test.kt|*Tests.kt|*Spec.kt) ;;                                 # JVM layout
        *) continue;;
      esac
      n=$(wc -l <"$f" | tr -d ' ')
      if [ "$n" -gt "$cap" ]; then
        echo "  $f: $n lines (cap $cap) — split into smaller files"
        fail=1
      fi
    done
    ;;
  comment-hygiene)
    # Ban TSDoc tags TypeScript already encodes (@param/@returns/@type/@typedef
    # only restate the signature) or that silently rot (@example). There is no
    # good home for @example: the tests and call sites ARE the examples, and
    # they're type-checked so they can't drift — a JSDoc sample only rots.
    # Applies to TESTS too (a test is itself an example; it never needs an
    # @example tag, and @param/etc. are just as redundant there).
    # NO grandfathering: the gate only sees STAGED files, so untouched legacy
    # keeps its tags, but touching a file forces cleaning it ("change it → fix
    # it" drives the drain). Genuine must-keeps (real JSDoc-typed .js, generated
    # files) go one-path-substring-per-line in .no-jsdoc-tags-allow, with a reason.
    pat='^[[:space:]]*(/?\*+|//)[[:space:]]*@(example|param|returns?|typedef|type)\b'
    allow_file=".no-jsdoc-tags-allow"
    is_allowed() {
      [ -f "$allow_file" ] || return 1
      while IFS= read -r p; do
        p="${p%%#*}"; p="$(echo "$p" | xargs 2>/dev/null || true)"
        [ -n "$p" ] || continue
        case "$1" in *"$p"*) return 0;; esac
      done < "$allow_file"
      return 1
    }
    for f in "$@"; do
      [ -f "$f" ] || continue
      is_allowed "$f" && continue
      hits=$(grep -nE "$pat" "$f" || true)
      if [ -n "$hits" ]; then
        echo "  $f: forbidden TSDoc tag(s). TS already states @param/@returns/@type/@typedef; tests + call sites are the examples, so delete @example (narrative → docs/). Genuine cases: $allow_file."
        printf '%s\n' "$hits" | sed 's/^/    /'
        fail=1
      fi
    done
    ;;
  fully-staged)
    # Gate soundness: the GPU test job rsyncs the WORKING TREE, but the commit
    # captures only STAGED files. If they differ, the gate tests something other
    # than what lands ("green" describes your desk, not the SHA). Require the
    # working tree to hold nothing beyond what's staged. Gitignored runtime deps
    # (node_modules, .env.local, coverage/, …) are exempt via --exclude-standard.
    # MUST run after any auto-fix/restage step (e.g. ts-format-lint stage_fixed)
    # so a concurrent restage can't race this read — keep it out of that group.
    if ! git diff --quiet; then
      echo "  unstaged changes to tracked files — stage them ('git add -A') or stash before committing"
      echo "    (the gate tests the working tree; it must equal what you commit):"
      git --no-pager diff --name-only | sed 's/^/      /'
      fail=1
    fi
    untracked=$(git ls-files --others --exclude-standard)
    if [ -n "$untracked" ]; then
      echo "  untracked (non-ignored) files present — add or remove them:"
      printf '%s\n' "$untracked" | sed 's/^/      /'
      fail=1
    fi
    ;;
  no-merge-commit)
    # Protected branches update by FAST-FORWARD MERGE ONLY — no merge commits,
    # no PRs. A fast-forward merge creates no commit, so it never trips this
    # pre-merge-commit hook; the hook fires only when a merge WOULD create a
    # merge commit on a protected branch, which is exactly what we reject.
    branch=$(git symbolic-ref --short HEAD 2>/dev/null || echo "")
    protected="${PROTECTED_BRANCHES:-main master}"
    for p in $protected; do
      if [ "$branch" = "$p" ]; then
        echo "  '$branch' is fast-forward-only. Rebase your feature branch onto"
        echo "  '$branch', then fast-forward — do not create a merge commit:"
        echo "      git switch <feature> && git rebase $branch"
        echo "      git switch $branch && git merge --ff-only <feature>"
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

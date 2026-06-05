# org-hooks shared rc defaults — org-wide lefthook env, set in ONE place.
#
# Source this from a consumer's lefthook rc: file, AFTER it exports ORG_HOOKS:
#
#   export ORG_HOOKS=/path/to/org-hooks
#   . "$ORG_HOOKS/rc.sh"
#
# Every value uses := (assign-if-unset), so the org default applies unless a
# repo overrides it by exporting its own value BEFORE the source line. That is
# why "repos can, but don't need to" set these — the default lives here.
#
# Why here and not the remote profile: lefthook 2.1.x does NOT merge a top-level
# `output:` (or other top-level settings) from a remote config — only hook
# blocks merge. The rc file, by contrast, is sourced before lefthook runs, so an
# env var set here reaches lefthook itself. (Verified: the real git-hook path
# honors LEFTHOOK_OUTPUT even though `lefthook run` does not.)

# LEFTHOOK_OUTPUT — lefthook's printed sections (its `output` config option).
# Keep the summary tree, the failing command's output, and per-tier progress;
# drop passing commands' verbose stdout so a real failure (e.g. a size-cap
# "823 lines (cap 800)") isn't buried under the tiers that passed.
: "${LEFTHOOK_OUTPUT:=summary,failure,execution_info}"
export LEFTHOOK_OUTPUT

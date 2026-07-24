#!/bin/sh
# ci/setup.sh — copy to <repo>/ci/setup.sh. Does NOT need to be executable.
#
# The per-repo environment callback. It is SOURCED (`. "$CI_SETUP"`) by the
# org-hooks orchestrators — ci/test.sh, ci/e2e.sh, ci/coverage.sh, ci/e2e-map.sh
# — on the CI host, before `npm install` and before any test runs. Everything it
# exports is visible to the whole job.
#
# Rules, because it is sourced and not executed:
#   • POSIX sh. No bashisms (no arrays, no [[ ]], no `local`).
#   • Do NOT `exit` on a success path — it would end the job.
#   • The orchestrators run under `set -e`, so if the LAST statement in this
#     file returns non-zero the job aborts with no message. End on something
#     that returns 0 (the `:` at the bottom of this file does that).
#   • `exit 1` IS the way to fail a precondition. Print why, to stderr.
#
# Reads: WORKTREE — the job's repo root, exported by the calling shim.
#        Every other variable is whatever this repo's shims export.

# ── Secrets and service endpoints ────────────────────────────────────────────
# Load anything the app needs that is not in the repo. `set -a` exports every
# variable the file assigns.
# SECRETS="$HOME/.config/<repo>/secrets.env"
# [ -f "$SECRETS" ] && set -a && . "$SECRETS" && set +a

# ── Preconditions that would otherwise fail silently ─────────────────────────
# The changed-files manifest must have survived the rsync. ci/before-test-push
# always writes it, so a MISSING file means the transfer dropped it: it is
# gitignored, and `sci push` filters the transfer through .gitignore, so it only
# arrives when CI_RSYNC_ARGS force-includes it. Without this check the unit job
# prints "no staged source/test files — nothing to run" and exits 0 having run
# no tests. An EMPTY manifest is legitimate (a commit touching no source).
if [ ! -f "$WORKTREE/ci/.changed-files" ]; then
    echo "[ci/setup] ERROR: $WORKTREE/ci/.changed-files is missing." >&2
    echo "[ci/setup]   Set CI_RSYNC_ARGS=\"--include=ci/.changed-files\" on the" >&2
    echo "[ci/setup]   pushing side (ci/simple-ci.conf)." >&2
    exit 1
fi

# ── Per-job ports ────────────────────────────────────────────────────────────
# simple-ci exports CI_SLOT_INDEX (0..CI_WORKERS-1) per job. Derive every port
# the repo binds from it, or two concurrent jobs collide. ci/e2e.sh exports
# CI=true, so Playwright's reuseExistingServer is off and it binds the ports
# itself.
# SLOT="${CI_SLOT_INDEX:-0}"
# export APP_PORT=$((5170 + SLOT))

# ── Services the test run needs ──────────────────────────────────────────────
# Start, seed or verify anything Playwright does not bring up itself.

:

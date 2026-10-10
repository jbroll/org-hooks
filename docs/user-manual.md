# org-hooks user manual

## `land`

```
land [BRANCH]
```

Fast-forwards `main` in a repo's main checkout onto `BRANCH`, resets `BRANCH`'s worktree to the
new `main`, pushes `main` to `origin`, and runs the repo's post-land hook. `BRANCH` defaults to the
branch checked out in the current directory's worktree. It runs from any worktree of the repo or
from the main checkout.

The main checkout is the parent of the repo's common git dir (`git rev-parse --git-common-dir`),
so every worktree of a repo lands into the same place.

### Order of operations

1. Refuse `main` and a detached HEAD with no `BRANCH` given.
2. Take an exclusive `flock` on `<common git dir>/land.lock`, waiting up to `LOCK_TIMEOUT`
   seconds (default 30). Each repo has its own lock, so lands in different repos never wait on
   each other. The lock is taken before any state is read: an edit made while waiting is caught
   by the checks below instead of being thrown away by the reset in step 7.
3. Check, in order, and stop with an error on the first failure:
   - the main checkout is on `main`
   - the main checkout has no uncommitted changes to tracked files
   - `BRANCH` is checked out in a worktree, and that directory exists
   - that worktree has no uncommitted changes to tracked files
   - `BRANCH` has commits ahead of `main`
   - `BRANCH` is rebased onto the current `main` (its merge base is `main`'s head); the error
     prints the `git rebase main` command to run
4. Run `scripts/pre-land` from the worktree, if it is executable. A non-zero exit stops the land
   with `main` untouched.
5. `git merge --ff-only BRANCH` in the main checkout.
6. Check that `main`'s new head is `BRANCH`'s head.
7. `git reset --hard main` in the worktree.
8. `git push origin main`. simple-ci bases every job on `origin/HEAD`, so a stale `origin/main`
   makes CI test against an old base.
9. Run `scripts/post-land` from the main checkout, if it is executable.
10. Warn if the main checkout is dirty, since the next land would refuse.

The land is complete after step 7. A failure in step 8 or 9 is reported with the command to
re-run and makes `land` exit 1, but nothing is rolled back.

`land` unsets `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_COMMON_DIR`,
`GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES` and `GIT_PREFIX` first. A commit hook
exports them, and a `land` started from one would otherwise act on the hooked repo.

`land` runs no tests. Verify the branch before landing.

### Hooks

Both hooks are optional executables in the repo, run with these variables set:

| Variable | Value |
|---|---|
| `LAND_BRANCH` | the branch being landed |
| `LAND_MAIN_REPO` | absolute path of the main checkout |
| `LAND_WORKTREE` | absolute path of the branch's worktree |

| Hook | Copy that runs | Working directory | When | On failure |
|---|---|---|---|---|
| `scripts/pre-land` | the branch's, in the worktree | the worktree | after the checks, before the merge, under the lock | nothing lands; exit 1 |
| `scripts/post-land` | the landed one, in the main checkout | the main checkout | after the push | land and push stand; exit 1 |

Use `pre-land` for checks that depend on the machine rather than the code, such as a toolchain
version that would make `post-land` rewrite a lockfile. Use `post-land` to refresh the main
checkout, such as `npm install && npm run build` for local consumers that link its build output
through `file:` dependencies.

### Exit status

| Status | Meaning |
|---|---|
| 0 | landed, pushed, and `post-land` (if any) passed |
| 1 | refused before landing, or landed but the push or `post-land` failed; the output says which |

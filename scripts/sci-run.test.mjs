// Tests for sci-run.sh — the shared simple-ci dispatch core — end-to-end via
// subprocess against a fake `sci` binary. Run with:
//   node --test scripts/sci-run.test.mjs

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "sci-run.sh");

/** Build a sandbox with a fake sci binary that logs its argv lines. */
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "sci-run-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const log = join(dir, "calls.log");
  const sci = join(bin, "sci");
  writeFileSync(
    sci,
    `#!/usr/bin/env bash
echo "$*" >> "${log}"
case "$1" in
  push) echo "job-abc123";;
  wait) echo "wait streamed log"; exit "\${FAKE_WAIT_RC:-0}";;
  kill) ;;
  host) echo "\${FAKE_HOST:-}";;
  path) echo "\${FAKE_JOB_PATH:-}";;
esac
`,
  );
  chmodSync(sci, 0o755);
  // scp stub for --lcov retrieval: "scp -q host:src dst" -> cp src dst
  const scp = join(bin, "scp");
  writeFileSync(scp, `#!/usr/bin/env bash\ncp "\${2#*:}" "$3"\n`);
  chmodSync(scp, 0o755);
  return { dir, bin, sci, log };
}

function run(args, { env = {}, cwd } = {}) {
  return spawnSync("bash", [SCRIPT, ...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

test("missing sci binary without --fallback fails loudly with 127", () => {
  const r = run(["ci/test"], { env: { SCI_BIN: "/nonexistent/sci", SCI_WT: "repo" } });
  assert.equal(r.status, 127);
  assert.match(r.stderr, /sci binary not found/);
  assert.match(r.stderr, /SCI_BIN/);
});

test("missing sci binary with --fallback runs it and propagates its exit code", () => {
  const s = sandbox();
  const marker = join(s.dir, "marker");
  const r = run(["--fallback", `touch ${marker}; exit 5`, "ci/test"], {
    env: { SCI_BIN: "/nonexistent/sci", SCI_WT: "repo" },
  });
  assert.equal(r.status, 5);
  assert.equal(readFileSync(marker, "utf8"), "");
  rmSync(s.dir, { recursive: true, force: true });
});

test("happy path: pushes WT/suffix, waits the job, exits 0", () => {
  const s = sandbox();
  const r = run(["ci/test"], { env: { SCI_BIN: s.sci, SCI_WT: "myrepo" } });
  assert.equal(r.status, 0, r.stderr);
  const calls = readFileSync(s.log, "utf8").trim().split("\n");
  assert.deepEqual(calls, ["push myrepo/ci/test", "wait job-abc123"]);
  assert.match(r.stdout, /ci\/test queued \(job-abc123\)/);
  assert.match(r.stdout, /wait streamed log/);
  rmSync(s.dir, { recursive: true, force: true });
});

test("--label overrides the queued display name", () => {
  const s = sandbox();
  const r = run(["--label", "unit", "ci/test"], { env: { SCI_BIN: s.sci, SCI_WT: "myrepo" } });
  assert.match(r.stdout, /unit queued/);
  rmSync(s.dir, { recursive: true, force: true });
});

test("a failing job propagates its exit code", () => {
  const s = sandbox();
  const r = run(["ci/test"], { env: { SCI_BIN: s.sci, SCI_WT: "myrepo", FAKE_WAIT_RC: "3" } });
  assert.equal(r.status, 3);
  rmSync(s.dir, { recursive: true, force: true });
});

test("--before runs an executable hook before dispatch; its failure aborts", () => {
  const s = sandbox();
  const hook = join(s.dir, "before-test-push");
  writeFileSync(hook, `#!/usr/bin/env bash\necho "before" >> "${s.log}"\n`);
  chmodSync(hook, 0o755);
  const r = run(["--before", hook, "ci/test"], { env: { SCI_BIN: s.sci, SCI_WT: "myrepo" } });
  assert.equal(r.status, 0, r.stderr);
  const calls = readFileSync(s.log, "utf8").trim().split("\n");
  assert.equal(calls[0], "before"); // hook ran first
  assert.equal(calls[1], "push myrepo/ci/test");

  writeFileSync(hook, "#!/usr/bin/env bash\nexit 9\n");
  const r2 = run(["--before", hook, "ci/test"], { env: { SCI_BIN: s.sci, SCI_WT: "myrepo" } });
  assert.equal(r2.status, 9);
  rmSync(s.dir, { recursive: true, force: true });
});

test("--before with a missing hook proceeds (convention hook is optional)", () => {
  const s = sandbox();
  const r = run(["--before", join(s.dir, "nope"), "ci/test"], {
    env: { SCI_BIN: s.sci, SCI_WT: "myrepo" },
  });
  assert.equal(r.status, 0, r.stderr);
  rmSync(s.dir, { recursive: true, force: true });
});

test("--lcov retrieves the job's lcov from the CI host after wait", () => {
  const s = sandbox();
  // The "remote" job worktree with an lcov the scp stub can copy locally.
  const remote = join(s.dir, "remote-wt");
  mkdirSync(join(remote, "coverage"), { recursive: true });
  writeFileSync(join(remote, "coverage/lcov.info"), "SF:src/a.ts\nDA:1,1\nend_of_record\n");
  const cwd = join(s.dir, "local");
  mkdirSync(cwd);
  const r = run(["--lcov", "coverage/lcov.info", "ci/test"], {
    cwd,
    env: {
      SCI_BIN: s.sci,
      SCI_WT: "myrepo",
      FAKE_HOST: "ci-host",
      FAKE_JOB_PATH: remote,
      PATH: `${s.bin}:${process.env.PATH}`,
    },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(readFileSync(join(cwd, "coverage/lcov.info"), "utf8"), /SF:src\/a\.ts/);
  rmSync(s.dir, { recursive: true, force: true });
});

test("--lcov with no reachable host is a no-op that keeps the job's exit code", () => {
  const s = sandbox();
  const cwd = join(s.dir, "local");
  mkdirSync(cwd);
  const r = run(["--lcov", "coverage/lcov.info", "ci/test"], {
    cwd,
    env: { SCI_BIN: s.sci, SCI_WT: "myrepo", FAKE_WAIT_RC: "4" },
  });
  assert.equal(r.status, 4);
  rmSync(s.dir, { recursive: true, force: true });
});

test("WT derives from the git COMMON dir: worktrees resolve to the main repo name", () => {
  const s = sandbox();
  const repo = join(s.dir, "myrepo");
  mkdirSync(repo);
  const git = (args, cwd) =>
    spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    });
  git(["init", "-q"], repo);
  writeFileSync(join(repo, "f"), "x");
  git(["add", "f"], repo);
  git(["commit", "-qm", "init"], repo);

  const main = run(["ci/test"], { cwd: repo, env: { SCI_BIN: s.sci, SCI_WT: "" } });
  assert.equal(main.status, 0, main.stderr);
  assert.match(readFileSync(s.log, "utf8"), /push myrepo\/ci\/test/);

  const wt = join(s.dir, "myrepo-wt1");
  git(["worktree", "add", "-q", wt], repo);
  rmSync(s.log, { force: true });
  const fromWt = run(["ci/test"], { cwd: wt, env: { SCI_BIN: s.sci, SCI_WT: "" } });
  assert.equal(fromWt.status, 0, fromWt.stderr);
  assert.match(readFileSync(s.log, "utf8"), /push myrepo\/ci\/test/);
  rmSync(s.dir, { recursive: true, force: true });
});

test("usage errors exit 2", () => {
  assert.equal(run([]).status, 2);
  assert.equal(run(["--bogus", "ci/test"]).status, 2);
  assert.equal(run(["a", "b"]).status, 2);
});

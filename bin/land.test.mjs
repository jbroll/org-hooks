// Tests for bin/land against throwaway repos with a bare origin. Run with:
//   node --test bin/land.test.mjs

import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const LAND = join(dirname(fileURLToPath(import.meta.url)), "land");

// A commit hook exports GIT_DIR and friends; children must not act on the hooked repo.
const baseEnv = () => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))),
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
});

function git(cwd, ...args) {
  const r = spawnSync("git", ["-C", cwd, ...args], { env: baseEnv(), encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/** main checkout + bare origin + worktree wt/1, removed after the test. */
function fixture(t) {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "land-")));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const origin = join(tmp, "origin.git");
  const main = join(tmp, "main");
  const wt = join(tmp, "wt1");
  mkdirSync(main);
  git(tmp, "init", "-q", "--bare", "-b", "main", origin);
  git(main, "init", "-q", "-b", "main");
  writeFileSync(join(main, "README"), "base\n");
  git(main, "add", ".");
  git(main, "commit", "-q", "-m", "base");
  git(main, "remote", "add", "origin", origin);
  git(main, "push", "-q", "origin", "main");
  git(main, "worktree", "add", "-q", "-b", "wt/1", wt);
  const commit = (file, text, dir = wt) => {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
    git(dir, "add", file);
    git(dir, "commit", "-q", "-m", `edit ${file}`);
  };
  const land = (args = ["wt/1"], { cwd = wt, env = {} } = {}) =>
    spawnSync("sh", [LAND, ...args], { cwd, env: { ...baseEnv(), ...env }, encoding: "utf8" });
  return { tmp, origin, main, wt, commit, land };
}

const out = (r) => r.stdout + r.stderr;

function hook(path, body) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

test("lands, resets the worktree, pushes main and exits 0", (t) => {
  const f = fixture(t);
  f.commit("a.txt", "a\n");
  const r = f.land();
  assert.equal(r.status, 0, out(r));
  assert.match(r.stdout, /landed wt\/1/);
  assert.equal(git(f.main, "rev-parse", "main"), git(f.wt, "rev-parse", "HEAD"));
  assert.equal(git(f.origin, "rev-parse", "main"), git(f.main, "rev-parse", "main"));
});

test("defaults to the current worktree's branch", (t) => {
  const f = fixture(t);
  f.commit("a.txt", "a\n");
  const r = f.land([]);
  assert.equal(r.status, 0, out(r));
  assert.equal(git(f.main, "rev-parse", "main"), git(f.wt, "rev-parse", "HEAD"));
});

test("lands from the main checkout when the branch is named", (t) => {
  const f = fixture(t);
  f.commit("a.txt", "a\n");
  const r = f.land(["wt/1"], { cwd: f.main });
  assert.equal(r.status, 0, out(r));
  assert.equal(git(f.main, "rev-parse", "main"), git(f.wt, "rev-parse", "HEAD"));
});

test("refuses main, whether named or defaulted from the main checkout", (t) => {
  const f = fixture(t);
  for (const r of [f.land(["main"]), f.land([], { cwd: f.main })]) {
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /cannot land main onto itself/);
  }
});

test("refuses a detached HEAD with no branch named", (t) => {
  const f = fixture(t);
  git(f.wt, "checkout", "-q", "--detach");
  const r = f.land([]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /HEAD is detached/);
});

test("refuses a branch not checked out in any worktree", (t) => {
  const f = fixture(t);
  const r = f.land(["wt/nope"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /is not checked out in any worktree/);
});

test("refuses a branch with nothing ahead of main, including right after a land", (t) => {
  const f = fixture(t);
  assert.match(f.land().stderr, /no commits ahead of main/);
  f.commit("a.txt", "a\n");
  assert.equal(f.land().status, 0);
  const r = f.land();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no commits ahead of main/);
});

test("refuses a dirty worktree", (t) => {
  const f = fixture(t);
  f.commit("a.txt", "a\n");
  writeFileSync(join(f.wt, "a.txt"), "dirty\n");
  const r = f.land();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /worktree .* has uncommitted changes/);
});

test("refuses a branch not rebased onto main", (t) => {
  const f = fixture(t);
  f.commit("a.txt", "a\n");
  f.commit("m.txt", "m\n", f.main);
  const r = f.land();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /not rebased onto current main \(1 commits behind\)/);
});

test("refuses a dirty main checkout", (t) => {
  const f = fixture(t);
  f.commit("a.txt", "a\n");
  writeFileSync(join(f.main, "README"), "dirty\n");
  const r = f.land();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /main repo has uncommitted changes/);
});

test("refuses when the main checkout is not on main", (t) => {
  const f = fixture(t);
  f.commit("a.txt", "a\n");
  git(f.main, "checkout", "-q", "-b", "other");
  const r = f.land();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /on branch 'other', expected 'main'/);
});

test("exits non-zero when the push fails, keeping the local land", (t) => {
  const f = fixture(t);
  git(f.main, "remote", "set-url", "origin", join(f.tmp, "missing.git"));
  f.commit("a.txt", "a\n");
  const r = f.land();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /git push origin main/);
  assert.equal(git(f.main, "rev-parse", "main"), git(f.wt, "rev-parse", "HEAD"));
});

test("a failing pre-land from the branch aborts with main untouched", (t) => {
  const f = fixture(t);
  const before = git(f.main, "rev-parse", "main");
  const seen = join(f.tmp, "pre-land.env");
  hook(
    join(f.wt, "scripts/pre-land"),
    `echo "$PWD|$LAND_BRANCH|$LAND_MAIN_REPO|$LAND_WORKTREE" > '${seen}'; exit 3`,
  );
  git(f.wt, "add", "scripts/pre-land");
  git(f.wt, "commit", "-q", "-m", "pre-land");
  const r = f.land();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /pre-land failed .* nothing landed/);
  assert.equal(git(f.main, "rev-parse", "main"), before);
  assert.equal(git(f.origin, "rev-parse", "main"), before);
  assert.equal(readFileSync(seen, "utf8").trim(), `${f.wt}|wt/1|${f.main}|${f.wt}`);
});

test("a passing pre-land lets the land proceed", (t) => {
  const f = fixture(t);
  hook(join(f.wt, "scripts/pre-land"), "exit 0");
  git(f.wt, "add", "scripts/pre-land");
  git(f.wt, "commit", "-q", "-m", "pre-land");
  const r = f.land();
  assert.equal(r.status, 0, out(r));
});

test("post-land runs in the main checkout with the landed version and the env", (t) => {
  const f = fixture(t);
  const seen = join(f.tmp, "post-land.env");
  hook(
    join(f.wt, "scripts/post-land"),
    `echo "$PWD|$LAND_BRANCH|$LAND_MAIN_REPO|$LAND_WORKTREE" > '${seen}'`,
  );
  git(f.wt, "add", "scripts/post-land");
  git(f.wt, "commit", "-q", "-m", "post-land");
  const r = f.land();
  assert.equal(r.status, 0, out(r));
  assert.match(r.stdout, /ran scripts\/post-land/);
  assert.equal(readFileSync(seen, "utf8").trim(), `${f.main}|wt/1|${f.main}|${f.wt}`);
});

test("a failing post-land exits non-zero after a completed land and push", (t) => {
  const f = fixture(t);
  hook(join(f.wt, "scripts/post-land"), "echo BUILD_BOOM; exit 1");
  git(f.wt, "add", "scripts/post-land");
  git(f.wt, "commit", "-q", "-m", "post-land");
  const r = f.land();
  assert.notEqual(r.status, 0);
  assert.match(out(r), /BUILD_BOOM/);
  assert.match(r.stderr, /\( cd '.*' && scripts\/post-land \)/);
  assert.equal(git(f.main, "rev-parse", "main"), git(f.wt, "rev-parse", "HEAD"));
  assert.equal(git(f.origin, "rev-parse", "main"), git(f.main, "rev-parse", "main"));
});

test("warns when post-land leaves main dirty", (t) => {
  const f = fixture(t);
  hook(join(f.wt, "scripts/post-land"), "echo drift >> README");
  git(f.wt, "add", "scripts/post-land");
  git(f.wt, "commit", "-q", "-m", "post-land");
  const r = f.land();
  assert.equal(r.status, 0, out(r));
  assert.match(r.stderr, /is dirty after landing/);
});

test("does not warn about untracked files in main, which never block a land", (t) => {
  const f = fixture(t);
  f.commit("a.txt", "a\n");
  writeFileSync(join(f.main, "scratch.txt"), "local\n");
  const r = f.land();
  assert.equal(r.status, 0, out(r));
  assert.doesNotMatch(r.stderr, /is dirty after landing/);
});

test("times out when another land holds the lock", async (t) => {
  const f = fixture(t);
  f.commit("a.txt", "a\n");
  const lock = join(f.main, ".git", "land.lock");
  const holder = spawn("sh", ["-c", `exec 8>"${lock}" && flock 8 && echo held && sleep 10`]);
  t.after(() => holder.kill());
  await new Promise((r) => holder.stdout.once("data", r));
  const r = f.land(["wt/1"], { env: { LOCK_TIMEOUT: "1" } });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /could not acquire land lock within 1s/);
});

test("takes the lock before validating, so edits made while waiting are refused and kept", async (t) => {
  const f = fixture(t);
  f.commit("a.txt", "a\n");
  const lock = join(f.main, ".git", "land.lock");
  const holder = spawn("sh", ["-c", `exec 8>"${lock}" && flock 8 && echo held && sleep 2`]);
  t.after(() => holder.kill());
  await new Promise((r) => holder.stdout.once("data", r));
  const child = spawn("sh", [LAND, "wt/1"], {
    cwd: f.wt,
    env: { ...baseEnv(), LOCK_TIMEOUT: "20" },
  });
  let text = "";
  child.stdout.on("data", (d) => (text += d));
  child.stderr.on("data", (d) => (text += d));
  await new Promise((r) => setTimeout(r, 500));
  writeFileSync(join(f.wt, "a.txt"), "edited while waiting\n");
  const code = await new Promise((r) => child.on("close", r));
  assert.notEqual(code, 0);
  assert.match(text, /worktree .* has uncommitted changes/);
  assert.equal(readFileSync(join(f.wt, "a.txt"), "utf8"), "edited while waiting\n");
  assert.notEqual(git(f.main, "rev-parse", "main"), git(f.wt, "rev-parse", "HEAD"));
});

test("ignores GIT_* variables inherited from a commit hook", (t) => {
  const f = fixture(t);
  const decoy = join(f.tmp, "decoy");
  mkdirSync(decoy);
  git(decoy, "init", "-q", "-b", "main");
  writeFileSync(join(decoy, "f"), "decoy\n");
  git(decoy, "add", "f");
  git(decoy, "commit", "-q", "-m", "decoy");
  const snapshot = () => ({
    head: git(decoy, "rev-parse", "HEAD"),
    refs: git(decoy, "for-each-ref"),
    status: git(decoy, "status", "--porcelain"),
    index: readFileSync(join(decoy, ".git", "index")).toString("base64"),
  });
  const before = snapshot();
  f.commit("a.txt", "a\n");
  const r = f.land(["wt/1"], {
    env: {
      GIT_DIR: join(decoy, ".git"),
      GIT_INDEX_FILE: join(decoy, ".git", "index"),
      GIT_WORK_TREE: decoy,
      GIT_COMMON_DIR: join(decoy, ".git"),
      GIT_OBJECT_DIRECTORY: join(decoy, ".git", "objects"),
    },
  });
  assert.equal(r.status, 0, out(r));
  assert.equal(git(f.main, "rev-parse", "main"), git(f.wt, "rev-parse", "HEAD"));
  assert.deepEqual(snapshot(), before);
  assert.ok(!existsSync(join(decoy, ".git", "land.lock")));
});

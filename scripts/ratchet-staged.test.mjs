// Tests for ratchet-staged.sh — the shared staged-file coverage-ratchet
// wrapper — end-to-end via subprocess in a scratch git repo, driving the real
// coverage-ratchet.mjs. Run with:
//   node --test scripts/ratchet-staged.test.mjs

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "ratchet-staged.sh");

// 50% over 1000 lines — a drop from a 100% baseline exceeds both the pct
// tolerance and the 5-line absolute tolerance.
const LCOV_HALF = "SF:src/a.ts\nLF:1000\nLH:500\nend_of_record\n";
const BASELINE_HIGH = `${JSON.stringify({ version: 2, files: { "src/a.ts": 100 } })}\n`;
const BASELINE_LOW = `${JSON.stringify({ version: 2, files: { "src/a.ts": 40 } })}\n`;

/** Scratch git repo with src/a.ts staged and a coverage lcov on disk. */
function repo({ lcov = LCOV_HALF, baseline } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ratchet-staged-"));
  const git = (...args) =>
    spawnSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    });
  git("init", "-q");
  mkdirSync(join(dir, "src"));
  mkdirSync(join(dir, "coverage"));
  writeFileSync(join(dir, "src/a.ts"), "export const a = 1;\n");
  writeFileSync(join(dir, "coverage/lcov.info"), lcov);
  if (baseline !== undefined) writeFileSync(join(dir, "coverage-baseline.json"), baseline);
  git("add", "src/a.ts");
  return dir;
}

function run(dir, extra = []) {
  return spawnSync(
    "bash",
    [SCRIPT, "--lcov", "coverage/lcov.info", "--baseline", "coverage-baseline.json", ...extra],
    { cwd: dir, encoding: "utf8", env: process.env },
  );
}

test("a staged file regressing below baseline fails", () => {
  const dir = repo({ baseline: BASELINE_HIGH });
  const r = run(dir);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  rmSync(dir, { recursive: true, force: true });
});

test("a staged file at/above baseline passes", () => {
  const dir = repo({ baseline: BASELINE_LOW });
  const r = run(dir);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  rmSync(dir, { recursive: true, force: true });
});

test("no committed baseline file is a no-op (no auto-seed from a hook)", () => {
  const dir = repo(); // would fail if gated
  const r = run(dir);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  rmSync(dir, { recursive: true, force: true });
});

test("no lcov on disk is a no-op", () => {
  const dir = repo({ baseline: BASELINE_HIGH });
  rmSync(join(dir, "coverage/lcov.info"));
  const r = run(dir);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  rmSync(dir, { recursive: true, force: true });
});

test("an exclude-file entry removes the failing file from the gate", () => {
  const dir = repo({ baseline: BASELINE_HIGH });
  writeFileSync(join(dir, "ratchet-exclude"), "# comment\n\nsrc/a.ts\n");
  const r = run(dir, ["--exclude-file", "ratchet-exclude"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  rmSync(dir, { recursive: true, force: true });
});

test("--glob narrows which staged files are gated", () => {
  const dir = repo({ baseline: BASELINE_HIGH });
  const r = run(dir, ["--glob", "^backend/.*\\.ts$"]); // src/a.ts falls outside
  assert.equal(r.status, 0, r.stdout + r.stderr);
  rmSync(dir, { recursive: true, force: true });
});

test("--exclude filters staged files by regex", () => {
  const dir = repo({ baseline: BASELINE_HIGH });
  const r = run(dir, ["--exclude", "a\\.ts$"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  rmSync(dir, { recursive: true, force: true });
});

test("test/spec files are excluded by the default filter", () => {
  const dir = repo({ baseline: BASELINE_HIGH });
  const git = (...args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  spawnSync("git", ["reset"], { cwd: dir });
  writeFileSync(join(dir, "src/a.test.ts"), "test\n");
  git("add", "src/a.test.ts");
  const r = run(dir);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  rmSync(dir, { recursive: true, force: true });
});

test("usage errors exit 2", () => {
  const r = spawnSync("bash", [SCRIPT], { encoding: "utf8" });
  assert.equal(r.status, 2);
});

// Tests for coverage-union-lib.mjs (pure helpers) and coverage-union-merge.mjs
// CLI end-to-end. Run with:  node --test scripts/coverage-union-merge.test.mjs

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

import { parseLcovDA, unionFiles, formatLcov } from "./coverage-union-lib.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const UNIT = [
  "SF:src/App.tsx",
  "DA:1,1", "DA:2,1", "DA:3,1", "DA:4,0", "DA:5,0",
  "LF:5", "LH:3",
  "end_of_record",
  "SF:scripts/build-x.ts",
  "DA:1,0",
  "LF:1", "LH:0",
  "end_of_record",
  "",
].join("\n");

// Same file, browser host-prefixed path, complementary line coverage.
const E2E = [
  "SF:localhost-5441/src/App.tsx",
  "DA:1,0", "DA:2,0", "DA:3,0", "DA:4,7", "DA:5,7",
  "LF:5", "LH:2",
  "end_of_record",
  "",
].join("\n");

test("parseLcovDA keys by normalised path and keeps per-line max within a file", () => {
  const u = parseLcovDA(UNIT, "src");
  assert.ok(u.has("src/App.tsx"));
  assert.ok(u.has("scripts/build-x.ts"));
  assert.equal(u.get("src/App.tsx").get(1), 1);
  const e = parseLcovDA(E2E, "src");
  assert.ok(e.has("src/App.tsx"), "host prefix stripped to src/App.tsx");
  assert.equal(e.get("src/App.tsx").get(4), 7);
});

test("unionFiles ORs per-line hits across sources (1-3 unit + 4-5 e2e = full)", () => {
  const merged = unionFiles(parseLcovDA(UNIT, "src"), parseLcovDA(E2E, "src"));
  const app = merged.get("src/App.tsx");
  assert.equal(app.get(1), 1);
  assert.equal(app.get(4), 7); // 0 (unit) OR 7 (e2e)
  assert.equal([...app.values()].filter((h) => h > 0).length, 5); // all covered
});

test("unionFiles keeps files present in only one source", () => {
  const merged = unionFiles(parseLcovDA(UNIT, "src"), parseLcovDA(E2E, "src"));
  assert.ok(merged.has("scripts/build-x.ts"));
});

test("formatLcov recomputes LF/LH from unioned DA and emits canonical SF", () => {
  const merged = unionFiles(parseLcovDA(UNIT, "src"), parseLcovDA(E2E, "src"));
  const out = formatLcov(merged);
  assert.match(out, /SF:src\/App\.tsx\n/);
  assert.doesNotMatch(out, /localhost-5441/);
  // src/App.tsx: 5 found, 5 hit after union
  const block = out.split("end_of_record").find((b) => b.includes("src/App.tsx"));
  assert.match(block, /LF:5/);
  assert.match(block, /LH:5/);
});

test("CLI merges two lcov files into a union lcov on disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "union-"));
  try {
    const unit = join(dir, "unit.info");
    const e2e = join(dir, "e2e.info");
    const out = join(dir, "union.info");
    writeFileSync(unit, UNIT);
    writeFileSync(e2e, E2E);
    execFileSync("node", [
      join(__dirname, "coverage-union-merge.mjs"),
      "--unit", unit, "--e2e", e2e, "--out", out, "--src-root", "src",
    ]);
    const text = readFileSync(out, "utf8");
    assert.match(text, /SF:src\/App\.tsx/);
    assert.doesNotMatch(text, /localhost-5441/);
    const appBlock = text.split("end_of_record").find((b) => b.includes("src/App.tsx"));
    assert.match(appBlock, /LH:5/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI tolerates a missing e2e lcov (treats as empty)", () => {
  const dir = mkdtempSync(join(tmpdir(), "union-"));
  try {
    const unit = join(dir, "unit.info");
    const out = join(dir, "union.info");
    writeFileSync(unit, UNIT);
    execFileSync("node", [
      join(__dirname, "coverage-union-merge.mjs"),
      "--unit", unit, "--e2e", join(dir, "nope.info"), "--out", out, "--src-root", "src",
    ]);
    const text = readFileSync(out, "utf8");
    assert.match(text, /SF:src\/App\.tsx/); // unit-only union still produced
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

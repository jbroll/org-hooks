// Tests for coverage-union-lib.mjs (pure helpers) and coverage-union-merge.mjs
// CLI end-to-end. Run with:  node --test scripts/coverage-union-merge.test.mjs

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

import {
  parseLcovDA,
  unionFiles,
  mergeBaseline,
  formatLcov,
  parseDiffHunks,
  remapLine,
  remapBaseline,
  scrubIncidentalUnit,
} from "./coverage-union-lib.mjs";

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

// --- carry-forward: full-run e2e attribution ---------------------------------
// X is covered {1,2} by unit, {} by the per-commit e2e (TIA selected no spec for
// it), and {3,4} by the persisted full-run e2e baseline. The merged union must
// cover {1,2,3,4} — proving the baseline rescues files the TIA subset missed.
const UNIT_X = [
  "SF:src/X.ts",
  "DA:1,1", "DA:2,1", "DA:3,0", "DA:4,0",
  "LF:4", "LH:2",
  "end_of_record",
  "",
].join("\n");

const E2E_EMPTY_X = [
  "SF:src/X.ts",
  "DA:1,0", "DA:2,0", "DA:3,0", "DA:4,0",
  "LF:4", "LH:0",
  "end_of_record",
  "",
].join("\n");

const E2E_BASELINE_X = [
  "SF:localhost-5441/src/X.ts",
  "DA:1,0", "DA:2,0", "DA:3,9", "DA:4,9",
  "LF:4", "LH:2",
  "end_of_record",
  "",
].join("\n");

test("unionFiles is associative — baseline carry-forward fills TIA-missed lines", () => {
  const merged = unionFiles(
    unionFiles(parseLcovDA(UNIT_X, "src"), parseLcovDA(E2E_EMPTY_X, "src")),
    parseLcovDA(E2E_BASELINE_X, "src"),
  );
  const x = merged.get("src/X.ts");
  assert.equal([...x.values()].filter((h) => h > 0).length, 4); // {1,2}∪{}∪{3,4}
  assert.equal(x.get(3), 9);
  assert.equal(x.get(4), 9);
});

test("CLI --e2e-baseline carries full-run e2e attribution into the union", () => {
  const dir = mkdtempSync(join(tmpdir(), "union-"));
  try {
    const unit = join(dir, "unit.info");
    const e2e = join(dir, "e2e.info");
    const base = join(dir, "e2e-baseline.info");
    const out = join(dir, "union.info");
    writeFileSync(unit, UNIT_X);
    writeFileSync(e2e, E2E_EMPTY_X);
    writeFileSync(base, E2E_BASELINE_X);
    execFileSync("node", [
      join(__dirname, "coverage-union-merge.mjs"),
      "--unit", unit, "--e2e", e2e, "--e2e-baseline", base,
      "--out", out, "--src-root", "src",
    ]);
    const text = readFileSync(out, "utf8");
    const block = text.split("end_of_record").find((b) => b.includes("src/X.ts"));
    assert.match(block, /LH:4/); // all 4 lines covered after carry-forward
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- mergeBaseline: changed-file safety (no denominator inflation) -----------
// Regression for a CHANGED file: fresh has lines 1-3 (line 1 covered). The
// baseline, at OLD line numbers, covers line 2 but ALSO carries a stale
// uncovered line 99 that no longer exists. mergeBaseline must flip line 2 to
// covered WITHOUT importing line 99 — else the changed file's LF inflates and it
// false-drops (the mediaService 97%→88% bug).
const FRESH_CHANGED = [
  "SF:src/Y.ts",
  "DA:1,1", "DA:2,0", "DA:3,0",
  "LF:3", "LH:1",
  "end_of_record",
  "",
].join("\n");

const BASELINE_STALE = [
  "SF:localhost-5441/src/Y.ts",
  "DA:1,0", "DA:2,5", "DA:99,0",
  "LF:3", "LH:1",
  "end_of_record",
  "",
].join("\n");

test("mergeBaseline flips existing uncovered lines but never imports stale baseline-only lines", () => {
  const merged = mergeBaseline(parseLcovDA(FRESH_CHANGED, "src"), parseLcovDA(BASELINE_STALE, "src"));
  const y = merged.get("src/Y.ts");
  assert.equal(y.size, 3); // line 99 NOT imported → denominator stays 3
  assert.equal(y.get(2), 5); // existing uncovered line flipped to covered
  assert.equal(y.has(99), false);
});

const BASELINE_ABSENT = [
  "SF:localhost-5441/src/Z.ts",
  "DA:1,3", "DA:2,3",
  "LF:2", "LH:2",
  "end_of_record",
  "",
].join("\n");

test("mergeBaseline carries the whole baseline for files ABSENT from fresh (TIA missed)", () => {
  const merged = mergeBaseline(parseLcovDA(FRESH_CHANGED, "src"), parseLcovDA(BASELINE_ABSENT, "src"));
  assert.ok(merged.has("src/Z.ts"));
  assert.equal(merged.get("src/Z.ts").get(1), 3);
  assert.equal(merged.get("src/Y.ts").size, 3); // unrelated fresh file untouched
});

test("CLI without --e2e-baseline is byte-identical to today (no regression)", () => {
  const dir = mkdtempSync(join(tmpdir(), "union-"));
  try {
    const unit = join(dir, "unit.info");
    const e2e = join(dir, "e2e.info");
    const outA = join(dir, "a.info");
    const outB = join(dir, "b.info");
    writeFileSync(unit, UNIT);
    writeFileSync(e2e, E2E);
    const args = ["--unit", unit, "--e2e", e2e, "--src-root", "src"];
    execFileSync("node", [join(__dirname, "coverage-union-merge.mjs"), ...args, "--out", outA]);
    // Same invocation but pointing --e2e-baseline at a missing file → no-op.
    execFileSync("node", [
      join(__dirname, "coverage-union-merge.mjs"), ...args,
      "--e2e-baseline", join(dir, "absent.info"), "--out", outB,
    ]);
    assert.equal(readFileSync(outA, "utf8"), readFileSync(outB, "utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── incidental-unit scrub (cross-instrumenter denominator noise) ──────────────
// A boot-path file (App.tsx) has NO unit test. The per-commit `vitest --changed`
// run still transitively LOADS it, so v8 instruments it at line numbers that the
// monocart e2e baseline never uses — all uncovered. Those lines can never be
// covered (different instrumenter) and inflate the denominator. Worse, WHICH v8
// lines appear depends on the --changed selection, so the file false-drops
// non-deterministically on edits. Scrub: when unit covers ZERO lines of a file
// that e2e DOES cover, drop unit's incidental entries before the union.
const UNIT_INCIDENTAL = [
  "SF:src/Boot.tsx", // transitively loaded, never exercised by unit (v8 lines 100..102)
  "DA:100,0", "DA:101,0", "DA:102,0",
  "LF:3", "LH:0",
  "end_of_record",
  "SF:src/Real.ts", // genuinely unit-tested — must NOT be scrubbed
  "DA:1,1", "DA:2,0",
  "LF:2", "LH:1",
  "end_of_record",
  "",
].join("\n");

const E2E_BOOT = [
  "SF:localhost-5441/src/Boot.tsx", // monocart lines 1..4, 1-3 covered
  "DA:1,7", "DA:2,7", "DA:3,7", "DA:4,0",
  "LF:4", "LH:3",
  "end_of_record",
  "",
].join("\n");

test("scrubIncidentalUnit drops zero-coverage unit files that e2e covers, keeps the rest", () => {
  const unit = parseLcovDA(UNIT_INCIDENTAL, "src");
  const e2e = parseLcovDA(E2E_BOOT, "src");
  const scrubbed = scrubIncidentalUnit(unit, e2e);
  assert.equal(scrubbed.has("src/Boot.tsx"), false); // incidental v8 noise removed
  assert.ok(scrubbed.has("src/Real.ts")); // real unit coverage preserved
});

test("scrubIncidentalUnit keeps a zero-coverage unit file e2e does NOT cover (genuinely untested)", () => {
  const unit = parseLcovDA(
    ["SF:src/Orphan.ts", "DA:1,0", "DA:2,0", "LF:2", "LH:0", "end_of_record", ""].join("\n"),
    "src",
  );
  const scrubbed = scrubIncidentalUnit(unit, new Map());
  assert.ok(scrubbed.has("src/Orphan.ts")); // no e2e coverage → keep, report as 0%
});

test("CLI scrubs incidental unit noise so an e2e-dominated boot file does not false-drop", () => {
  const dir = mkdtempSync(join(tmpdir(), "union-scrub-"));
  try {
    const unit = join(dir, "unit.info");
    const e2e = join(dir, "e2e.info");
    const out = join(dir, "union.info");
    writeFileSync(unit, UNIT_INCIDENTAL);
    writeFileSync(e2e, E2E_BOOT);
    execFileSync("node", [
      join(__dirname, "coverage-union-merge.mjs"),
      "--unit", unit, "--e2e", e2e, "--out", out, "--src-root", "src",
    ]);
    const text = readFileSync(out, "utf8");
    const block = text.split("end_of_record").find((b) => b.includes("src/Boot.tsx"));
    // Denominator is e2e's 4 lines (3 covered) — NOT 7 (with v8 noise → 3/7=43%).
    assert.match(block, /LF:4/);
    assert.match(block, /LH:3/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── diff-aware baseline remap (line-shift remediation) ────────────────────────

test("remapLine: pure insertion shifts only lines strictly after the insert point", () => {
  // `@@ -10,0 +11,2 @@` — 2 lines inserted after old line 10.
  const hunks = [{ oldStart: 10, oldCount: 0, newStart: 11, newCount: 2 }];
  assert.equal(remapLine(10, hunks), 10); // at/before insert point — unaffected
  assert.equal(remapLine(11, hunks), 13); // after — shifted +2
  assert.equal(remapLine(1, hunks), 1);
});

test("remapLine: deletion drops in-range lines and shifts the tail up", () => {
  // `@@ -10,2 +9,0 @@` — old lines 10,11 removed.
  const hunks = [{ oldStart: 10, oldCount: 2, newStart: 9, newCount: 0 }];
  assert.equal(remapLine(9, hunks), 9);
  assert.equal(remapLine(10, hunks), null); // deleted
  assert.equal(remapLine(11, hunks), null); // deleted
  assert.equal(remapLine(12, hunks), 10); // shifted -2
});

test("remapLine: modified line drops (coverage must not carry to changed code)", () => {
  const hunks = [{ oldStart: 25, oldCount: 1, newStart: 25, newCount: 1 }];
  assert.equal(remapLine(25, hunks), null);
  assert.equal(remapLine(26, hunks), 26); // net line count unchanged
});

test("remapLine: multiple hunks accumulate correctly", () => {
  const hunks = [
    { oldStart: 10, oldCount: 0, newStart: 11, newCount: 2 }, // +2
    { oldStart: 25, oldCount: 1, newStart: 27, newCount: 1 }, // modify
  ];
  assert.equal(remapLine(30, hunks), 32); // +2 from first, +0 from second
  assert.equal(remapLine(25, hunks), null); // modified
});

test("parseDiffHunks parses per-file hunks and normalises paths", () => {
  const diff = [
    "diff --git a/src/F.tsx b/src/F.tsx",
    "index abc..def 100644",
    "--- a/src/F.tsx",
    "+++ b/src/F.tsx",
    "@@ -10,0 +11,2 @@",
    "+import { X } from './x';",
    "+import { Y } from './y';",
    "",
  ].join("\n");
  const h = parseDiffHunks(diff, "src");
  assert.ok(h.has("src/F.tsx"));
  assert.deepEqual(h.get("src/F.tsx"), [
    { oldStart: 10, oldCount: 0, newStart: 11, newCount: 2 },
  ]);
});

test("remapBaseline: a 2-line import-split keeps an e2e-dominated file from false-dropping", () => {
  // File F: baseline (full e2e) covers old lines 12..16; unit covers almost
  // nothing (the e2e-dominated case, e.g. AudioFieldInput at 4% unit).
  const baseline = parseLcovDA(
    ["SF:src/F.tsx", "DA:12,1", "DA:13,1", "DA:14,1", "DA:15,1", "DA:16,1", "LF:5", "LH:5", "end_of_record", ""].join("\n"),
    "src",
  );
  // Fresh union: 2 import lines added at the top → old 12..16 are now 14..18,
  // and unit only covers line 14 (1 line). Without remap, mergeBaseline would
  // flip old-numbered 12,13 (now blank/other) and miss 15..18 → false drop.
  const fresh = parseLcovDA(
    ["SF:src/F.tsx", "DA:14,1", "DA:15,0", "DA:16,0", "DA:17,0", "DA:18,0", "LF:5", "LH:1", "end_of_record", ""].join("\n"),
    "src",
  );
  const diff = ["--- a/src/F.tsx", "+++ b/src/F.tsx", "@@ -11,0 +12,2 @@", "+import a", "+import b", ""].join("\n");
  const hunks = parseDiffHunks(diff, "src");
  const remapped = remapBaseline(baseline, hunks);
  // old 12..16 -> new 14..18
  assert.equal(remapped.get("src/F.tsx").get(14), 1);
  assert.equal(remapped.get("src/F.tsx").get(18), 1);
  // merge: every fresh line now flips to covered via the aligned baseline
  const merged = mergeBaseline(fresh, remapped);
  const f = merged.get("src/F.tsx");
  let lh = 0;
  for (const h of f.values()) if (h > 0) lh++;
  assert.equal(lh, 5); // 5/5 covered — no drop (was 5/5 in baseline)
});

test("remapBaseline: unchanged files (no hunks) are kept verbatim", () => {
  const baseline = parseLcovDA(["SF:src/G.tsx", "DA:3,1", "DA:4,0", "LF:2", "LH:1", "end_of_record", ""].join("\n"), "src");
  const remapped = remapBaseline(baseline, new Map());
  assert.equal(remapped.get("src/G.tsx").get(3), 1);
  assert.equal(remapped.get("src/G.tsx").get(4), 0);
});

test("CLI --e2e-baseline-sha remaps the baseline through a real git diff (no false drop)", () => {
  const dir = mkdtempSync(join(tmpdir(), "union-git-"));
  const run = (...a) => execFileSync(a[0], a.slice(1), { cwd: dir, encoding: "utf8" });
  try {
    run("git", "init", "-q");
    run("git", "config", "user.email", "t@t");
    run("git", "config", "user.name", "t");
    mkdirpFile(dir, "src/F.tsx", ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o", "p"].join("\n") + "\n");
    run("git", "add", "-A");
    run("git", "commit", "-qm", "old");
    const sha = run("git", "rev-parse", "HEAD^{tree}").trim(); // tree-ish anchor, as e2e-map now persists
    // Insert 2 import lines at the top → executable lines shift +2.
    mkdirpFile(dir, "src/F.tsx", "import x\nimport y\n" + ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o", "p"].join("\n") + "\n");
    // baseline (old): lines 12..16 covered by e2e. unit (new): only line 14.
    const unit = join(dir, "unit.info");
    const base = join(dir, "base.info");
    const out = join(dir, "union.info");
    writeFileSync(unit, ["SF:src/F.tsx", "DA:14,1", "DA:15,0", "DA:16,0", "DA:17,0", "DA:18,0", "LF:5", "LH:1", "end_of_record", ""].join("\n"));
    writeFileSync(base, ["SF:src/F.tsx", "DA:12,1", "DA:13,1", "DA:14,1", "DA:15,1", "DA:16,1", "LF:5", "LH:5", "end_of_record", ""].join("\n"));
    execFileSync("node", [
      join(__dirname, "coverage-union-merge.mjs"),
      "--unit", unit, "--e2e", join(dir, "none.info"),
      "--e2e-baseline", base, "--e2e-baseline-sha", sha,
      "--out", out, "--src-root", "src",
    ], { cwd: dir });
    const block = readFileSync(out, "utf8").split("end_of_record").find((b) => b.includes("src/F.tsx"));
    assert.match(block, /LH:5/); // remapped baseline (12-16 -> 14-18) aligns with fresh → 5/5, no drop
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function mkdirpFile(dir, rel, content) {
  const p = join(dir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

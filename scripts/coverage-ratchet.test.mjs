// Tests for coverage-ratchet-lib.mjs (pure helpers) and the CLI script
// end-to-end via subprocess. Run with:  node --test scripts/coverage-ratchet.test.mjs

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

import {
  checkOne,
  fmtPct,
  formatBaseline,
  normalisePath,
  parseBaseline,
  parseLcov,
  pct,
  ratchetUp,
  reseedBaseline,
} from "./coverage-ratchet-lib.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RATCHET_BIN = join(__dirname, "coverage-ratchet.mjs");

// ───────────────────────────── normalisePath ────────────────────────────────

test("normalisePath: relative path with localhost prefix stripped", () => {
  assert.equal(normalisePath("localhost-5438/src/foo.ts", "src"), "src/foo.ts");
});

test("normalisePath: relative src path passes through", () => {
  assert.equal(normalisePath("src/foo.ts", "src"), "src/foo.ts");
});

test("normalisePath: absolute path under CWD becomes relative", () => {
  const cwd = "/home/user/proj";
  assert.equal(normalisePath("/home/user/proj/src/foo.ts", "src", cwd), "src/foo.ts");
});

test("normalisePath: absolute path outside CWD found via src marker", () => {
  const cwd = "/home/user/proj";
  assert.equal(normalisePath("/other/proj/src/foo.ts", "src", cwd), "src/foo.ts");
});

// Workspace packages have their own `<pkg>/src` root. They must keep their
// `packages/<pkg>/src/...` identity instead of collapsing into the top-level
// src/ namespace (which would lose identity and collide with src/ files).
test("normalisePath: relative packages path is preserved", () => {
  assert.equal(
    normalisePath("packages/quick-contact/src/hooks/useQCContact.ts", "src"),
    "packages/quick-contact/src/hooks/useQCContact.ts",
  );
});

test("normalisePath: absolute packages path outside CWD keeps the packages prefix", () => {
  const cwd = "/home/user/proj";
  assert.equal(
    normalisePath("/other/proj/packages/qc/src/foo.ts", "src", cwd),
    "packages/qc/src/foo.ts",
  );
});

test("normalisePath: absolute packages path under CWD is relative and preserved", () => {
  const cwd = "/home/user/proj";
  assert.equal(
    normalisePath("/home/user/proj/packages/qc/src/foo.ts", "src", cwd),
    "packages/qc/src/foo.ts",
  );
});

// ───────────────────────────── parseLcov ────────────────────────────────────

test("parseLcov: extracts LF/LH per file", () => {
  const text = [
    "SF:src/a.ts",
    "LF:10",
    "LH:8",
    "end_of_record",
    "SF:src/b.ts",
    "LF:20",
    "LH:5",
    "end_of_record",
  ].join("\n");
  const out = parseLcov(text, "src");
  assert.deepEqual(out, {
    "src/a.ts": { linesFound: 10, linesHit: 8 },
    "src/b.ts": { linesFound: 20, linesHit: 5 },
  });
});

test("parseLcov: normalises browser-coverage prefix", () => {
  const text = ["SF:localhost-5438/src/a.ts", "LF:10", "LH:7", "end_of_record"].join("\n");
  const out = parseLcov(text, "src");
  assert.deepEqual(out, { "src/a.ts": { linesFound: 10, linesHit: 7 } });
});

// ───────────────────────────── pct / fmtPct ─────────────────────────────────

test("pct: empty file is treated as 100%", () => {
  assert.equal(pct({ linesFound: 0, linesHit: 0 }), 1);
});

test("pct: standard ratio", () => {
  assert.equal(pct({ linesFound: 4, linesHit: 3 }), 0.75);
});

test("fmtPct: 2-decimal percent", () => {
  assert.equal(fmtPct(0.7273), "72.73%");
});

// ───────────────────────────── parseBaseline ────────────────────────────────

test("parseBaseline: v2 → canonical ratios", () => {
  const out = parseBaseline({ version: 2, files: { "src/a.ts": 80.5 } }, "src");
  assert.equal(out["src/a.ts"], 0.805);
});

test("parseBaseline: duplicate keys after normalisation collapse to max", () => {
  const out = parseBaseline(
    { version: 2, files: { "src/a.ts": 60, "localhost-5438/src/a.ts": 80 } },
    "src",
  );
  assert.equal(Object.keys(out).length, 1);
  assert.equal(out["src/a.ts"], 0.8);
});

test("parseBaseline: rejects v1 with re-seed hint", () => {
  assert.throws(
    () => parseBaseline({ version: 1, files: {} }, "src"),
    /unsupported baseline version 1.*re-seed/,
  );
});

// ───────────────────────────── formatBaseline ───────────────────────────────

test("formatBaseline: sorts keys, 2-decimal percent, trailing newline", () => {
  const out = formatBaseline({ "src/b.ts": 0.5, "src/a.ts": 0.7273 });
  assert.equal(
    out,
    `{\n  "version": 2,\n  "files": {\n    "src/a.ts": 72.73,\n    "src/b.ts": 50\n  }\n}\n`,
  );
});

test("formatBaseline → parseBaseline round-trip", () => {
  const input = { "src/a.ts": 0.8123, "src/b.ts": 0.45 };
  const round = parseBaseline(JSON.parse(formatBaseline(input)), "src");
  assert.equal(round["src/a.ts"], 0.8123);
  assert.equal(round["src/b.ts"], 0.45);
});

// ───────────────────────────── checkOne ─────────────────────────────────────

const OPTS = { floor: 0.75, tolerance: 0.005 };

test("checkOne: no baseline + cur ≥ floor → pass", () => {
  assert.equal(checkOne("src/a.ts", undefined, { linesFound: 10, linesHit: 8 }, OPTS), null);
});

test("checkOne: no baseline + cur < floor → fail", () => {
  const r = checkOne("src/a.ts", undefined, { linesFound: 10, linesHit: 7 }, OPTS);
  assert.match(r.reason, /must be ≥ 75\.00%/);
});

test("checkOne: no baseline + no lcov → fail", () => {
  const r = checkOne("src/a.ts", undefined, undefined, OPTS);
  assert.match(r.reason, /no entry in lcov/);
});

test("checkOne: baseline + cur ≥ baseline → pass", () => {
  assert.equal(checkOne("src/a.ts", 0.6, { linesFound: 10, linesHit: 6 }, OPTS), null);
});

test("checkOne: baseline + cur within tolerance → pass", () => {
  // baseline 60.00%, current 59.60%; tolerance 0.5pp → 59.50% is the floor → pass
  assert.equal(
    checkOne("src/a.ts", 0.6, { linesFound: 1000, linesHit: 596 }, OPTS),
    null,
  );
});

test("checkOne: baseline + cur outside tolerance → fail", () => {
  // baseline 60%, current 59% drops by 1pp > 0.5pp tolerance → fail
  const r = checkOne("src/a.ts", 0.6, { linesFound: 100, linesHit: 59 }, OPTS);
  assert.match(r.reason, /coverage dropped/);
});

test("checkOne: baseline + missing lcov → fail", () => {
  const r = checkOne("src/a.ts", 0.6, undefined, OPTS);
  assert.match(r.reason, /regressed to 0/);
});

const WAIVER_OPTS = { floor: 0.75, tolerance: 0.005, regressionWaiver: 0.9 };

test("checkOne: regression allowed when cur stays at/above the waiver", () => {
  // baseline 100%, current 95% — a real regression, but ≥ 90% waiver → pass
  assert.equal(checkOne("src/a.ts", 1.0, { linesFound: 100, linesHit: 95 }, WAIVER_OPTS), null);
});

test("checkOne: regression below the waiver still fails", () => {
  // baseline 95%, current 88% — below the 90% waiver → ratchet bites
  const r = checkOne("src/a.ts", 0.95, { linesFound: 100, linesHit: 88 }, WAIVER_OPTS);
  assert.match(r.reason, /coverage dropped/);
});

test("checkOne: waiver does not rescue a file absent from lcov", () => {
  const r = checkOne("src/a.ts", 1.0, undefined, WAIVER_OPTS);
  assert.match(r.reason, /regressed to 0/);
});

test("checkOne: default opts (no waiver) preserve strict no-regression", () => {
  // regressionWaiver defaults to 1 (off) → a 100%→95% drop still fails
  const r = checkOne("src/a.ts", 1.0, { linesFound: 100, linesHit: 95 }, OPTS);
  assert.match(r.reason, /coverage dropped/);
});

// ───────────────────────────── ratchetUp ────────────────────────────────────

test("ratchetUp: improves baseline, leaves untouched files alone", () => {
  const prev = { "src/a.ts": 0.6, "src/c.ts": 0.9 };
  const lcov = {
    "src/a.ts": { linesFound: 10, linesHit: 8 }, // 0.80, improvement
    "src/b.ts": { linesFound: 10, linesHit: 7 }, // 0.70, new entry
  };
  const next = ratchetUp(prev, lcov);
  assert.equal(next["src/a.ts"], 0.8);
  assert.equal(next["src/b.ts"], 0.7);
  assert.equal(next["src/c.ts"], 0.9, "untouched file kept");
});

test("ratchetUp: lower coverage does not down-grade baseline", () => {
  const next = ratchetUp({ "src/a.ts": 0.8 }, { "src/a.ts": { linesFound: 10, linesHit: 7 } });
  assert.equal(next["src/a.ts"], 0.8, "stayed at 0.80 even though lcov was 0.70");
});

// ───────────────────────────── reseedBaseline ───────────────────────────────

test("reseedBaseline: keeps high-water marks, adds new, retains absent", () => {
  const prev = { "src/old.ts": 0.99, "src/keep.ts": 0.8 };
  const lcov = {
    "src/old.ts": { linesFound: 10, linesHit: 4 }, // 0.40 — lower than 0.99
    "src/new.ts": { linesFound: 10, linesHit: 7 }, // 0.70 — added
  };
  const next = reseedBaseline(prev, lcov);
  assert.equal(next["src/old.ts"], 0.99, "high-water mark preserved");
  assert.equal(next["src/new.ts"], 0.7, "new file added");
  assert.equal(next["src/keep.ts"], 0.8, "absent file retained");
});

test("reseedBaseline: a genuine improvement raises the mark", () => {
  const next = reseedBaseline(
    { "src/a.ts": 0.6 },
    { "src/a.ts": { linesFound: 10, linesHit: 9 } },
  );
  assert.equal(next["src/a.ts"], 0.9);
});

// ───────────────────────────── CLI end-to-end ───────────────────────────────

function mkSandbox() {
  const dir = mkdtempSync(join(tmpdir(), "ratchet-test-"));
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "config", "user.email", "t@e.x"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "T"]);
  return dir;
}

function writeLcov(dir, entries) {
  const lines = [];
  for (const [file, { lf, lh }] of Object.entries(entries)) {
    lines.push(`SF:${file}`, `LF:${lf}`, `LH:${lh}`, "end_of_record");
  }
  const lcovPath = join(dir, "lcov.info");
  writeFileSync(lcovPath, lines.join("\n") + "\n");
  return lcovPath;
}

function runRatchet(dir, args) {
  try {
    const out = execFileSync("node", [RATCHET_BIN, ...args], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout: out, stderr: "" };
  } catch (e) {
    return {
      code: e.status ?? 1,
      stdout: e.stdout?.toString() ?? "",
      stderr: e.stderr?.toString() ?? "",
    };
  }
}

test("CLI: auto-seeds when baseline missing", () => {
  const dir = mkSandbox();
  try {
    const lcov = writeLcov(dir, { "src/a.ts": { lf: 10, lh: 8 } });
    const baseline = join(dir, "b.json");
    const r = runRatchet(dir, [
      "--lcov", lcov, "--baseline", baseline, "src/a.ts",
    ]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /auto-seed/);
    const parsed = JSON.parse(readFileSync(baseline, "utf8"));
    assert.equal(parsed.version, 2);
    assert.equal(parsed.files["src/a.ts"], 80);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: passes when staged file holds baseline; ratchets up on improvement", () => {
  const dir = mkSandbox();
  try {
    const baseline = join(dir, "b.json");
    writeFileSync(baseline, formatBaseline({ "src/a.ts": 0.6 }));
    const lcov = writeLcov(dir, { "src/a.ts": { lf: 10, lh: 9 } }); // 90%
    const r = runRatchet(dir, [
      "--lcov", lcov, "--baseline", baseline, "src/a.ts",
    ]);
    assert.equal(r.code, 0, r.stderr);
    const after = JSON.parse(readFileSync(baseline, "utf8"));
    assert.equal(after.files["src/a.ts"], 90);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: fails when staged file regresses below tolerance", () => {
  const dir = mkSandbox();
  try {
    const baseline = join(dir, "b.json");
    writeFileSync(baseline, formatBaseline({ "src/a.ts": 0.9 }));
    const lcov = writeLcov(dir, { "src/a.ts": { lf: 100, lh: 70 } }); // 70%
    const r = runRatchet(dir, [
      "--lcov", lcov, "--baseline", baseline, "src/a.ts",
    ]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /coverage dropped/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: default 0.90 waiver lets a well-covered file regress", () => {
  const dir = mkSandbox();
  try {
    const baseline = join(dir, "b.json");
    writeFileSync(baseline, formatBaseline({ "src/a.ts": 1.0 }));
    const lcov = writeLcov(dir, { "src/a.ts": { lf: 100, lh: 95 } }); // 95% ≥ 0.90
    const r = runRatchet(dir, ["--lcov", lcov, "--baseline", baseline, "src/a.ts"]);
    assert.equal(r.code, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: --seed overwrites baseline unconditionally", () => {
  const dir = mkSandbox();
  try {
    const baseline = join(dir, "b.json");
    writeFileSync(baseline, formatBaseline({ "src/old.ts": 0.99 }));
    const lcov = writeLcov(dir, { "src/new.ts": { lf: 10, lh: 4 } });
    const r = runRatchet(dir, ["--seed", "--lcov", lcov, "--baseline", baseline]);
    assert.equal(r.code, 0, r.stderr);
    const after = JSON.parse(readFileSync(baseline, "utf8"));
    assert.equal(after.files["src/new.ts"], 40);
    assert.equal(after.files["src/old.ts"], undefined, "old entry dropped on seed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: --reseed preserves high-water marks", () => {
  const dir = mkSandbox();
  try {
    const baseline = join(dir, "b.json");
    writeFileSync(baseline, formatBaseline({ "src/old.ts": 0.99, "src/keep.ts": 0.8 }));
    const lcov = writeLcov(dir, {
      "src/old.ts": { lf: 10, lh: 4 }, // 40% — LOWER than the 99% high-water mark
      "src/new.ts": { lf: 10, lh: 7 }, // 70% — added
      // src/keep.ts absent from this lcov — must be retained
    });
    const r = runRatchet(dir, ["--reseed", "--lcov", lcov, "--baseline", baseline]);
    assert.equal(r.code, 0, r.stderr);
    const after = JSON.parse(readFileSync(baseline, "utf8"));
    assert.equal(after.files["src/old.ts"], 99, "high-water mark not lowered");
    assert.equal(after.files["src/new.ts"], 70, "new file added at its pct");
    assert.equal(after.files["src/keep.ts"], 80, "absent file retained");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

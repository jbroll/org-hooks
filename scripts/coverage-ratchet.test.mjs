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
  branchPct,
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
    "src/a.ts": { linesFound: 10, linesHit: 8, branchesFound: 0, branchesHit: 0 },
    "src/b.ts": { linesFound: 20, linesHit: 5, branchesFound: 0, branchesHit: 0 },
  });
});

test("parseLcov: normalises browser-coverage prefix", () => {
  const text = ["SF:localhost-5438/src/a.ts", "LF:10", "LH:7", "end_of_record"].join("\n");
  const out = parseLcov(text, "src");
  assert.deepEqual(out, {
    "src/a.ts": { linesFound: 10, linesHit: 7, branchesFound: 0, branchesHit: 0 },
  });
});

test("parseLcov: extracts BRF/BRH per file", () => {
  const text = ["SF:src/a.ts", "LF:10", "LH:8", "BRF:6", "BRH:3", "end_of_record"].join("\n");
  const out = parseLcov(text, "src");
  assert.deepEqual(out, {
    "src/a.ts": { linesFound: 10, linesHit: 8, branchesFound: 6, branchesHit: 3 },
  });
});

test("parseLcov: a file with no BRF record reports zero branches", () => {
  const text = ["SF:src/a.ts", "LF:10", "LH:8", "end_of_record"].join("\n");
  assert.equal(parseLcov(text, "src")["src/a.ts"].branchesFound, 0);
});

test("parseLcov: branch counts do not leak between records", () => {
  const text = [
    "SF:src/a.ts",
    "LF:10",
    "LH:8",
    "BRF:6",
    "BRH:3",
    "end_of_record",
    "SF:src/b.ts",
    "LF:4",
    "LH:4",
    "end_of_record",
  ].join("\n");
  const out = parseLcov(text, "src");
  assert.equal(out["src/b.ts"].branchesFound, 0);
  assert.equal(out["src/b.ts"].branchesHit, 0);
});

// ───────────────────────────── pct / fmtPct ─────────────────────────────────

test("pct: empty file is treated as 100%", () => {
  assert.equal(pct({ linesFound: 0, linesHit: 0 }), 1);
});

test("pct: standard ratio", () => {
  assert.equal(pct({ linesFound: 4, linesHit: 3 }), 0.75);
});

test("branchPct: a file with no branches is 100%, not 0%", () => {
  assert.equal(branchPct({ linesFound: 4, linesHit: 4, branchesFound: 0, branchesHit: 0 }), 1);
});

test("branchPct: standard ratio", () => {
  assert.equal(branchPct({ linesFound: 4, linesHit: 4, branchesFound: 8, branchesHit: 6 }), 0.75);
});

test("fmtPct: 2-decimal percent", () => {
  assert.equal(fmtPct(0.7273), "72.73%");
});

// ───────────────────────────── parseBaseline ────────────────────────────────

test("parseBaseline: a bare number is lines-only", () => {
  const out = parseBaseline({ version: 2, files: { "src/a.ts": 80.5 } }, "src");
  assert.deepEqual(out["src/a.ts"], { lines: 0.805, branches: undefined });
});

test("parseBaseline: the object form carries both metrics", () => {
  const out = parseBaseline(
    { version: 2, files: { "src/a.ts": { lines: 92.5, branches: 81.2 } } },
    "src",
  );
  assert.equal(out["src/a.ts"].lines, 0.925);
  assert.equal(out["src/a.ts"].branches, 0.812);
});

test("parseBaseline: duplicate keys after normalisation collapse to max per metric", () => {
  const out = parseBaseline(
    {
      version: 2,
      files: {
        "src/a.ts": { lines: 60, branches: 90 },
        "localhost-5438/src/a.ts": { lines: 80, branches: 40 },
      },
    },
    "src",
  );
  assert.equal(Object.keys(out).length, 1);
  assert.equal(out["src/a.ts"].lines, 0.8);
  assert.equal(out["src/a.ts"].branches, 0.9);
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

test("formatBaseline: a file with no branch data stays a bare number", () => {
  const out = JSON.parse(formatBaseline({ "src/a.ts": { lines: 0.7273 } }));
  assert.equal(out.files["src/a.ts"], 72.73);
});

test("formatBaseline: a file with branch data becomes the object form", () => {
  const out = JSON.parse(
    formatBaseline({ "src/a.ts": { lines: 0.925, branches: 0.812 } }),
  );
  assert.deepEqual(out.files["src/a.ts"], { lines: 92.5, branches: 81.2 });
});

test("formatBaseline → parseBaseline round-trip", () => {
  const input = { "src/a.ts": { lines: 0.8123, branches: 0.45 }, "src/b.ts": { lines: 0.45 } };
  const round = parseBaseline(JSON.parse(formatBaseline(input)), "src");
  assert.equal(round["src/a.ts"].lines, 0.8123);
  assert.equal(round["src/a.ts"].branches, 0.45);
  assert.equal(round["src/b.ts"].lines, 0.45);
  assert.equal(round["src/b.ts"].branches, undefined);
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

test("checkOne: .d.ts is never gated (no runtime lines, never in lcov)", () => {
  assert.equal(checkOne("src/types/foo.d.ts", undefined, undefined, OPTS), null);
  assert.equal(checkOne("src/foo.d.ts", undefined, { linesFound: 0, linesHit: 0 }, OPTS), null);
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

test("checkOne: baseline + cur outside BOTH tolerances → fail", () => {
  // baseline 60% (600/1000), current 590/1000: 1pp > 0.5pp AND 10-line drop > 5 → fail
  const r = checkOne("src/a.ts", 0.6, { linesFound: 1000, linesHit: 590 }, OPTS);
  assert.match(r.reason, /coverage dropped/);
});

test("checkOne: small absolute-line drop passes even when pct drop exceeds tolerance", () => {
  // e2e-dominated noise: baseline 46.72% (~64/137), current 62/137 = 45.26%.
  // pct drop 1.46pp > 0.5pp, BUT only a 2-line drop ≤ 5 → pass (e2e noise floor).
  assert.equal(
    checkOne("src/POISheet.tsx", 0.4672, { linesFound: 137, linesHit: 62 }, OPTS),
    null,
  );
  // FilterSpecEditor: baseline 30% (~12.3/41), current 12/41 = 29.27% → <1-line drop → pass.
  assert.equal(
    checkOne("src/FilterSpecEditor.tsx", 0.3, { linesFound: 41, linesHit: 12 }, OPTS),
    null,
  );
});

test("checkOne: a large absolute-line drop still fails even on a low-coverage file", () => {
  // baseline 50% (250/500), current 200/500 = 40%: 10pp AND 50-line drop > 5 → fail
  const r = checkOne("src/big.tsx", 0.5, { linesFound: 500, linesHit: 200 }, OPTS);
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
  // regressionWaiver defaults to 1 (off) → a 100%→90% drop (100 lines > 5) still fails
  const r = checkOne("src/a.ts", 1.0, { linesFound: 1000, linesHit: 900 }, OPTS);
  assert.match(r.reason, /coverage dropped/);
});

test("checkOne: a drop past waiverDrop is reported even above the waiver", () => {
  // 100% → 91%: above the 0.9 waiver, but a 9pp drop exceeds waiverDrop (0.05).
  const cur = { linesFound: 100, linesHit: 91 };
  const result = checkOne("src/a.ts", 1, cur, WAIVER_OPTS);
  assert.ok(result, "a 9pp drop past waiverDrop must be reported even above the waiver");
  assert.match(result.reason, /coverage dropped/);
});

test("checkOne: the waiver forgives a drop within waiverDrop that tolerance alone would reject", () => {
  // 100% → 96.25%: above the waiver and within waiverDrop → pass. The 15-line
  // drop exceeds lineTolerance, so only the waiver — not the ordinary
  // tolerance/lineTolerance check — forgives it.
  const cur = { linesFound: 400, linesHit: 385 };
  assert.equal(checkOne("src/a.ts", 1, cur, WAIVER_OPTS), null);
});

// ───────────────────────────── checkOne: branches ───────────────────────────

const BRANCH_OPTS = { floor: 0.75, tolerance: 0.005, branches: true };

test("checkOne: branches off by default ignores a branch regression", () => {
  const cur = { linesFound: 1000, linesHit: 1000, branchesFound: 1000, branchesHit: 400 };
  assert.equal(checkOne("src/a.ts", { lines: 1, branches: 0.9 }, cur, OPTS), null);
});

test("checkOne: branches on fails a branch drop while lines hold", () => {
  const cur = { linesFound: 1000, linesHit: 1000, branchesFound: 1000, branchesHit: 400 };
  const r = checkOne("src/a.ts", { lines: 1, branches: 0.9 }, cur, BRANCH_OPTS);
  assert.match(r.reason, /branch coverage dropped/);
});

test("checkOne: branches on passes when the branch figure holds", () => {
  const cur = { linesFound: 1000, linesHit: 1000, branchesFound: 1000, branchesHit: 950 };
  assert.equal(checkOne("src/a.ts", { lines: 1, branches: 0.9 }, cur, BRANCH_OPTS), null);
});

test("checkOne: a line baseline with no branch entry bootstraps rather than failing", () => {
  const cur = { linesFound: 1000, linesHit: 1000, branchesFound: 1000, branchesHit: 100 };
  assert.equal(checkOne("src/a.ts", { lines: 1 }, cur, BRANCH_OPTS), null);
  assert.equal(checkOne("src/a.ts", 1, cur, BRANCH_OPTS), null);
});

test("checkOne: a file with no branches is not a file at 0% branch coverage", () => {
  const cur = { linesFound: 10, linesHit: 10, branchesFound: 0, branchesHit: 0 };
  assert.equal(checkOne("src/a.ts", { lines: 1, branches: 1 }, cur, BRANCH_OPTS), null);
});

test("checkOne: the branch tolerance absorbs noise the way the line one does", () => {
  const cur = { linesFound: 1000, linesHit: 1000, branchesFound: 1000, branchesHit: 596 };
  assert.equal(checkOne("src/a.ts", { lines: 1, branches: 0.6 }, cur, BRANCH_OPTS), null);
});

test("checkOne: the waiver applies to branches too", () => {
  const cur = { linesFound: 100, linesHit: 100, branchesFound: 100, branchesHit: 95 };
  assert.equal(
    checkOne("src/a.ts", { lines: 1, branches: 1 }, cur, { ...BRANCH_OPTS, regressionWaiver: 0.9 }),
    null,
  );
});

test("checkOne: a branch drop past waiverDrop fails even above the waiver", () => {
  const cur = { linesFound: 100, linesHit: 100, branchesFound: 100, branchesHit: 91 };
  const r = checkOne("src/a.ts", { lines: 1, branches: 1 }, cur, {
    ...BRANCH_OPTS,
    regressionWaiver: 0.9,
  });
  assert.match(r.reason, /branch coverage dropped/);
});

test("checkOne: a line regression is reported before the branch one", () => {
  const cur = { linesFound: 1000, linesHit: 500, branchesFound: 1000, branchesHit: 400 };
  const r = checkOne("src/a.ts", { lines: 1, branches: 0.9 }, cur, BRANCH_OPTS);
  assert.match(r.reason, /^coverage dropped/);
});

// ───────────────────────────── ratchetUp ────────────────────────────────────

test("ratchetUp: improves baseline, leaves untouched files alone", () => {
  const prev = { "src/a.ts": 0.6, "src/c.ts": 0.9 };
  const lcov = {
    "src/a.ts": { linesFound: 10, linesHit: 8 }, // 0.80, improvement
    "src/b.ts": { linesFound: 10, linesHit: 7 }, // 0.70, new entry
  };
  const next = ratchetUp(prev, lcov);
  assert.equal(next["src/a.ts"].lines, 0.8);
  assert.equal(next["src/b.ts"].lines, 0.7);
  assert.equal(next["src/c.ts"].lines, 0.9, "untouched file kept");
});

test("ratchetUp: lower coverage does not down-grade baseline", () => {
  const next = ratchetUp({ "src/a.ts": 0.8 }, { "src/a.ts": { linesFound: 10, linesHit: 7 } });
  assert.equal(next["src/a.ts"].lines, 0.8, "stayed at 0.80 even though lcov was 0.70");
});

test("ratchetUp: records no branch figure unless asked", () => {
  const lcov = { "src/a.ts": { linesFound: 10, linesHit: 8, branchesFound: 4, branchesHit: 2 } };
  assert.equal(ratchetUp({}, lcov)["src/a.ts"].branches, undefined);
  assert.equal(ratchetUp({}, lcov, { branches: true })["src/a.ts"].branches, 0.5);
});

test("ratchetUp: a file the lcov measured no branches on gets no branch mark", () => {
  const lcov = { "src/a.ts": { linesFound: 10, linesHit: 8, branchesFound: 0, branchesHit: 0 } };
  assert.equal(ratchetUp({}, lcov, { branches: true })["src/a.ts"].branches, undefined);
});

test("ratchetUp: branch marks are monotonic too", () => {
  const next = ratchetUp(
    { "src/a.ts": { lines: 0.8, branches: 0.9 } },
    { "src/a.ts": { linesFound: 10, linesHit: 10, branchesFound: 10, branchesHit: 4 } },
    { branches: true },
  );
  assert.equal(next["src/a.ts"].lines, 1);
  assert.equal(next["src/a.ts"].branches, 0.9);
});

// ───────────────────────────── reseedBaseline ───────────────────────────────

test("reseedBaseline: keeps high-water marks, adds new, retains absent", () => {
  const prev = { "src/old.ts": 0.99, "src/keep.ts": 0.8 };
  const lcov = {
    "src/old.ts": { linesFound: 10, linesHit: 4 }, // 0.40 — lower than 0.99
    "src/new.ts": { linesFound: 10, linesHit: 7 }, // 0.70 — added
  };
  const next = reseedBaseline(prev, lcov);
  assert.equal(next["src/old.ts"].lines, 0.99, "high-water mark preserved");
  assert.equal(next["src/new.ts"].lines, 0.7, "new file added");
  assert.equal(next["src/keep.ts"].lines, 0.8, "absent file retained");
});

test("reseedBaseline: a genuine improvement raises the mark", () => {
  const next = reseedBaseline(
    { "src/a.ts": 0.6 },
    { "src/a.ts": { linesFound: 10, linesHit: 9 } },
  );
  assert.equal(next["src/a.ts"].lines, 0.9);
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
  for (const [file, { lf, lh, brf, brh }] of Object.entries(entries)) {
    lines.push(`SF:${file}`, `LF:${lf}`, `LH:${lh}`);
    if (brf !== undefined) lines.push(`BRF:${brf}`, `BRH:${brh}`);
    lines.push("end_of_record");
  }
  const lcovPath = join(dir, "lcov.info");
  writeFileSync(lcovPath, lines.join("\n") + "\n");
  return lcovPath;
}

function runRatchet(dir, args, env = {}) {
  try {
    const out = execFileSync("node", [RATCHET_BIN, ...args], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
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

// ───────────────────────── CLI: branches / check-all ────────────────────────

test("CLI: --branches gates the branch figure of a staged file", () => {
  const dir = mkSandbox();
  try {
    const baseline = join(dir, "b.json");
    writeFileSync(baseline, formatBaseline({ "src/a.ts": { lines: 1, branches: 0.9 } }));
    const lcov = writeLcov(dir, { "src/a.ts": { lf: 100, lh: 100, brf: 100, brh: 40 } });
    const pass = runRatchet(dir, ["--lcov", lcov, "--baseline", baseline, "src/a.ts"]);
    assert.equal(pass.code, 0, "branches are off by default");
    const r = runRatchet(dir, ["--branches", "--lcov", lcov, "--baseline", baseline, "src/a.ts"]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /branch coverage dropped/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: COVERAGE_BRANCHES=1 turns the branch gate on", () => {
  const dir = mkSandbox();
  try {
    const baseline = join(dir, "b.json");
    writeFileSync(baseline, formatBaseline({ "src/a.ts": { lines: 1, branches: 0.9 } }));
    const lcov = writeLcov(dir, { "src/a.ts": { lf: 100, lh: 100, brf: 100, brh: 40 } });
    const r = runRatchet(dir, ["--lcov", lcov, "--baseline", baseline, "src/a.ts"], {
      COVERAGE_BRANCHES: "1",
    });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /branch coverage dropped/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: --branches records a branch figure for a staged file that had none", () => {
  const dir = mkSandbox();
  try {
    const baseline = join(dir, "b.json");
    writeFileSync(baseline, formatBaseline({ "src/a.ts": 60 / 100 }));
    const lcov = writeLcov(dir, { "src/a.ts": { lf: 10, lh: 9, brf: 4, brh: 1 } });
    const r = runRatchet(dir, ["--branches", "--lcov", lcov, "--baseline", baseline, "src/a.ts"]);
    assert.equal(r.code, 0, r.stderr);
    const after = JSON.parse(readFileSync(baseline, "utf8"));
    assert.deepEqual(after.files["src/a.ts"], { lines: 90, branches: 25 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: --check-all fails a regressed baselined file that is not staged", () => {
  const dir = mkSandbox();
  try {
    const baseline = join(dir, "b.json");
    writeFileSync(baseline, formatBaseline({ "src/a.ts": 0.6, "src/other.ts": 0.9 }));
    const lcov = writeLcov(dir, {
      "src/a.ts": { lf: 10, lh: 9 },
      "src/other.ts": { lf: 100, lh: 40 },
    });
    const args = ["--lcov", lcov, "--baseline", baseline, "src/a.ts"];
    assert.equal(runRatchet(dir, args).code, 0, "unstaged regressions are invisible by default");
    const r = runRatchet(dir, ["--check-all", ...args]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /src\/other\.ts: coverage dropped: 90\.00% → 40\.00%/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: COVERAGE_CHECK_ALL=1 turns the whole-baseline check on", () => {
  const dir = mkSandbox();
  try {
    const baseline = join(dir, "b.json");
    writeFileSync(baseline, formatBaseline({ "src/a.ts": 0.6, "src/other.ts": 0.9 }));
    const lcov = writeLcov(dir, {
      "src/a.ts": { lf: 10, lh: 9 },
      "src/other.ts": { lf: 100, lh: 40 },
    });
    const r = runRatchet(dir, ["--lcov", lcov, "--baseline", baseline, "src/a.ts"], {
      COVERAGE_CHECK_ALL: "1",
    });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /src\/other\.ts/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: --check-all persists raises for staged files only", () => {
  const dir = mkSandbox();
  try {
    const baseline = join(dir, "b.json");
    writeFileSync(baseline, formatBaseline({ "src/a.ts": 0.6, "src/other.ts": 0.5 }));
    const lcov = writeLcov(dir, {
      "src/a.ts": { lf: 10, lh: 9 },
      "src/other.ts": { lf: 10, lh: 10 },
    });
    const r = runRatchet(dir, ["--check-all", "--lcov", lcov, "--baseline", baseline, "src/a.ts"]);
    assert.equal(r.code, 0, r.stderr);
    const after = JSON.parse(readFileSync(baseline, "utf8"));
    assert.equal(after.files["src/a.ts"], 90, "staged file ratchets up");
    assert.equal(after.files["src/other.ts"], 50, "unstaged file keeps its recorded mark");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: --check-all skips a baselined file absent from the lcov", () => {
  const dir = mkSandbox();
  try {
    const baseline = join(dir, "b.json");
    writeFileSync(baseline, formatBaseline({ "src/a.ts": 0.6, "src/gone.ts": 0.9 }));
    const lcov = writeLcov(dir, { "src/a.ts": { lf: 10, lh: 9 } });
    const r = runRatchet(dir, ["--check-all", "--lcov", lcov, "--baseline", baseline, "src/a.ts"]);
    assert.equal(r.code, 0, r.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: --check-all still fails a STAGED file absent from the lcov", () => {
  const dir = mkSandbox();
  try {
    const baseline = join(dir, "b.json");
    writeFileSync(baseline, formatBaseline({ "src/a.ts": 0.6, "src/gone.ts": 0.9 }));
    const lcov = writeLcov(dir, { "src/a.ts": { lf: 10, lh: 9 } });
    const r = runRatchet(dir, [
      "--check-all", "--lcov", lcov, "--baseline", baseline, "src/a.ts", "src/gone.ts",
    ]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /src\/gone\.ts: previously measured but absent/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: --check-all runs with no staged files at all", () => {
  const dir = mkSandbox();
  try {
    const baseline = join(dir, "b.json");
    writeFileSync(baseline, formatBaseline({ "src/other.ts": 0.9 }));
    const lcov = writeLcov(dir, { "src/other.ts": { lf: 100, lh: 40 } });
    const r = runRatchet(dir, ["--check-all", "--lcov", lcov, "--baseline", baseline]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /src\/other\.ts/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: --branches records nothing for a file the lcov measured no branches on", () => {
  const dir = mkSandbox();
  try {
    const baseline = join(dir, "b.json");
    writeFileSync(baseline, formatBaseline({ "src/a.ts": 0.6 }));
    const lcov = writeLcov(dir, { "src/a.ts": { lf: 10, lh: 9 } });
    const r = runRatchet(dir, ["--branches", "--lcov", lcov, "--baseline", baseline, "src/a.ts"]);
    assert.equal(r.code, 0, r.stderr);
    const after = JSON.parse(readFileSync(baseline, "utf8"));
    assert.equal(after.files["src/a.ts"], 90, "stays a bare lines-only number");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

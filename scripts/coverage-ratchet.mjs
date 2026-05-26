#!/usr/bin/env node
// Coverage ratchet gate. Reads an lcov.info and compares per-file line
// coverage against a committed baseline JSON. Fails if any staged file
// regresses; rewrites the baseline with current numbers on pass and
// re-stages it so the improvement travels with the commit.
//
// Baseline format (v2): { version: 2, files: { "<path>": <percent> } }
// where <percent> is line coverage 0-100 with 2 decimals.
//
// Per-file rules:
//   1. File not in baseline: must reach >= FLOOR (covers both brand-new files
//      and ones never previously measured).
//   2. File in baseline: current % must be >= baseline % within TOLERANCE pp.
//
// Bootstrap: when the baseline file does not exist on disk, the first run
// auto-seeds from the current lcov (exit 0). Subsequent commits then have
// something to ratchet against.
//
// Path normalisation: duplicate keys after stripping browser-coverage
// "localhost-NNNN/" prefixes collapse to the max — handles stale entries.
//
// Usage:
//   node coverage-ratchet.mjs [options] [staged_file ...]
//
//   --lcov PATH       lcov.info to read (default: $COVERAGE_LCOV or coverage/lcov.info)
//   --baseline PATH   baseline JSON (default: $COVERAGE_BASELINE or coverage-baseline.json)
//   --floor N         0–1 floor for files without a baseline entry
//                     (default: $COVERAGE_FLOOR or 0.75)
//   --tolerance N     0–1 slack vs baseline % to absorb coverage-instrument noise
//                     (default: $COVERAGE_TOLERANCE or 0.005 = 0.5 pp)
//   --src-root DIR    strip path prefix up to this dir name when normalising lcov
//                     SF: paths (default: src)
//   --seed            write current lcov to baseline unconditionally; no gate check.
//                     Use to reset after a refactor. Requires lcov to exist;
//                     ignores staged_file list.
//
// Exit codes:  0 = pass  1 = coverage regression  2 = setup error (missing lcov)

import { execSync } from "node:child_process";
import fs from "node:fs";
import {
  checkOne,
  fmtPct,
  formatBaseline,
  parseBaseline,
  parseLcov,
  pct,
  ratchetUp,
} from "./coverage-ratchet-lib.mjs";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

let lcovPath = process.env.COVERAGE_LCOV ?? "coverage/lcov.info";
let baselinePath = process.env.COVERAGE_BASELINE ?? "coverage-baseline.json";
let floor = Number(process.env.COVERAGE_FLOOR ?? "0.75");
let tolerance = Number(process.env.COVERAGE_TOLERANCE ?? "0.005");
let srcRoot = "src";
let seedMode = false;
/** @type {string[]} */
const stagedFiles = [];

for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === "--lcov") lcovPath = process.argv[++i];
  else if (arg === "--baseline") baselinePath = process.argv[++i];
  else if (arg === "--floor") floor = Number(process.argv[++i]);
  else if (arg === "--tolerance") tolerance = Number(process.argv[++i]);
  else if (arg === "--src-root") srcRoot = process.argv[++i];
  else if (arg === "--seed") seedMode = true;
  else if (!arg.startsWith("--")) stagedFiles.push(arg);
}

if (!seedMode && stagedFiles.length === 0) process.exit(0);

// ---------------------------------------------------------------------------
// Baseline I/O
// ---------------------------------------------------------------------------

const baselineExists = fs.existsSync(baselinePath);
/** @type {Record<string, number>} */
const baseline = baselineExists
  ? parseBaseline(JSON.parse(fs.readFileSync(baselinePath, "utf8")), srcRoot)
  : {};

function writeBaseline(/** @type {Record<string, number>} */ files) {
  fs.writeFileSync(baselinePath, formatBaseline(files));
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      execSync(`git add ${baselinePath}`, { stdio: "ignore" });
      return;
    } catch {
      if (attempt === 3) throw new Error(`Failed to stage ${baselinePath} after 3 attempts`);
      execSync("sleep 1");
    }
  }
}

// ---------------------------------------------------------------------------
// lcov
// ---------------------------------------------------------------------------

if (!fs.existsSync(lcovPath)) {
  if (seedMode) {
    console.error(`coverage ratchet --seed: ${lcovPath} not found — run tests with coverage first`);
    process.exit(2);
  }
  if (baselineExists && Object.keys(baseline).length > 0) {
    console.error(`coverage ratchet: ${lcovPath} not found — run \`npm run test:coverage\` first`);
    process.exit(2);
  }
  // No baseline and no lcov: first-run no-op.
  process.exit(0);
}

const lcov = parseLcov(fs.readFileSync(lcovPath, "utf8"), srcRoot);

// ---------------------------------------------------------------------------
// Seed mode (explicit or auto)
// ---------------------------------------------------------------------------

if (seedMode || !baselineExists) {
  const next = ratchetUp({}, lcov);
  writeBaseline(next);
  const label = seedMode ? "--seed" : "auto-seed (no baseline)";
  console.log(`coverage ratchet ${label}: wrote ${Object.keys(next).length} files to ${baselinePath}`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/** @type {{ file: string; reason: string }[]} */
const failures = [];
for (const file of stagedFiles) {
  const fail = checkOne(file, baseline[file], lcov[file], { floor, tolerance });
  if (fail) failures.push(fail);
}

if (failures.length > 0) {
  console.error("coverage ratchet failed:");
  for (const f of failures) console.error(`  ${f.file}: ${f.reason}`);
  console.error("\nAdd test coverage for the affected lines before committing.");
  process.exit(1);
}

writeBaseline(ratchetUp(baseline, lcov));

const summary = stagedFiles
  .map((f) => {
    const cur = lcov[f];
    return cur ? `${f} ${fmtPct(pct(cur))}` : `${f} (not in lcov)`;
  })
  .join(", ");
console.log(`coverage ratchet ok: ${summary}`);

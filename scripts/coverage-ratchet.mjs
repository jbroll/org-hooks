#!/usr/bin/env node
// Coverage ratchet gate. Reads an lcov.info and compares per-file line
// coverage against a committed baseline JSON. Fails if any staged file
// regresses; rewrites the baseline with current numbers on pass and
// re-stages it so the improvement travels with the commit.
//
// Per-file rules:
//   1. New file (not in baseline and not yet in HEAD): must reach >= FLOOR.
//   2. Existing file at >= FLOOR in baseline: must stay at >= FLOOR.
//   3. Existing file below FLOOR in baseline: uncovered-line count must
//      not increase (new covered lines are fine; new uncovered lines are not).
//
// Usage:
//   node coverage-ratchet.mjs [options] [staged_file ...]
//
//   --lcov PATH       lcov.info to read (default: $COVERAGE_LCOV or coverage/lcov.info)
//   --baseline PATH   baseline JSON to compare against (default: $COVERAGE_BASELINE
//                     or coverage-baseline.json)
//   --floor N         0–1 floor for new/above-floor files (default: $COVERAGE_FLOOR or 0.75)
//   --src-root DIR    strip path prefix up to this dir name when normalising lcov
//                     SF: paths (default: src)
//   --seed            write current lcov to baseline unconditionally; no gate check.
//                     Use after a large refactor to accept the current state as the
//                     new floor. Requires lcov to exist; ignores staged_file list.
//
// Exit codes:  0 = pass  1 = coverage regression  2 = setup error (missing lcov)
//
// Design notes:
//   - No-op (exit 0) when no staged files are passed.
//   - No-op (exit 0) when baseline does not exist or is empty — the baseline
//     is written fresh from the current lcov on first run.
//   - Exit 2 (setup error, not a coverage failure) when the baseline exists
//     and has entries but the lcov file is missing.
//   - Paths in lcov SF: records are normalised to be relative to CWD.
//     Absolute paths are stripped up to the first occurrence of /<src-root>/.

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

let lcovPath = process.env.COVERAGE_LCOV ?? "coverage/lcov.info";
let baselinePath = process.env.COVERAGE_BASELINE ?? "coverage-baseline.json";
let floor = Number(process.env.COVERAGE_FLOOR ?? "0.75");
let srcRoot = "src";
let seedMode = false;
/** @type {string[]} */
const stagedFiles = [];

for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === "--lcov") lcovPath = process.argv[++i];
  else if (arg === "--baseline") baselinePath = process.argv[++i];
  else if (arg === "--floor") floor = Number(process.argv[++i]);
  else if (arg === "--src-root") srcRoot = process.argv[++i];
  else if (arg === "--seed") seedMode = true;
  else if (!arg.startsWith("--")) stagedFiles.push(arg);
}

if (!seedMode && stagedFiles.length === 0) process.exit(0);

// ---------------------------------------------------------------------------
// Baseline
// ---------------------------------------------------------------------------

/**
 * @typedef {{ linesFound: number; linesHit: number }} FileMetric
 * @typedef {{ version: 1; files: Record<string, FileMetric> }} Baseline
 */

/** @returns {Baseline} */
function readBaseline() {
  if (!fs.existsSync(baselinePath)) return { version: 1, files: {} };
  const raw = fs.readFileSync(baselinePath, "utf8");
  const parsed = /** @type {Baseline} */ (JSON.parse(raw));
  if (parsed.version !== 1)
    throw new Error(`${baselinePath}: unsupported version ${parsed.version}`);
  return parsed;
}

const baseline = readBaseline();
const baselineIsEmpty = Object.keys(baseline.files).length === 0;

// ---------------------------------------------------------------------------
// lcov
// ---------------------------------------------------------------------------

if (!fs.existsSync(lcovPath)) {
  if (seedMode) {
    console.error(`coverage ratchet --seed: ${lcovPath} not found — run tests with coverage first`);
    process.exit(2);
  }
  if (!baselineIsEmpty) {
    console.error(
      `coverage ratchet: ${lcovPath} not found — run \`npm run test:coverage\` first`,
    );
    process.exit(2);
  }
  // No baseline and no lcov: first-run no-op; nothing to compare.
  process.exit(0);
}

/**
 * Normalise a path from an lcov SF: record to be relative to CWD.
 * Handles both relative and absolute paths, including paths produced by a
 * remote CI worktree (different absolute prefix, same src-root structure).
 * @param {string} p
 * @returns {string}
 */
function normalisePath(p) {
  if (!path.isAbsolute(p)) return p;
  // Strip CWD prefix if present.
  const cwd = process.cwd() + path.sep;
  if (p.startsWith(cwd)) return p.slice(cwd.length);
  // Strip up to the first occurrence of /<srcRoot>/ so CI worktree absolute
  // paths (e.g. /home/user/ci-worktrees/repo-abc123/src/...) resolve correctly.
  const marker = `${path.sep}${srcRoot}${path.sep}`;
  const idx = p.indexOf(marker);
  if (idx !== -1) return p.slice(idx + 1);
  return p;
}

/** @returns {Record<string, FileMetric>} */
function parseLcov(text) {
  /** @type {Record<string, FileMetric>} */
  const out = {};
  let sf = /** @type {string|null} */ (null);
  let lf = 0;
  let lh = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("SF:")) {
      sf = normalisePath(line.slice(3).trim());
      lf = 0;
      lh = 0;
    } else if (line.startsWith("LF:")) {
      lf = Number(line.slice(3));
    } else if (line.startsWith("LH:")) {
      lh = Number(line.slice(3));
    } else if (line === "end_of_record" && sf) {
      out[sf] = { linesFound: lf, linesHit: lh };
      sf = null;
    }
  }
  return out;
}

const lcov = parseLcov(fs.readFileSync(lcovPath, "utf8"));

// ---------------------------------------------------------------------------
// Per-file check
// ---------------------------------------------------------------------------

/** @param {FileMetric} m @returns {number} */
function pct(m) {
  return m.linesFound === 0 ? 1 : m.linesHit / m.linesFound;
}
/** @param {FileMetric} m @returns {number} */
function uncovered(m) {
  return m.linesFound - m.linesHit;
}
/** @param {number} p @returns {string} */
function fmtPct(p) {
  return `${(p * 100).toFixed(2)}%`;
}

/** @param {string} filePath @returns {boolean} */
function existedInHead(filePath) {
  try {
    execSync(`git cat-file -e HEAD:${filePath}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} file
 * @param {FileMetric|undefined} prev
 * @param {FileMetric|undefined} cur
 * @returns {{ file: string; reason: string }|null}
 */
function checkOne(file, prev, cur) {
  const inHead = existedInHead(file);

  if (!inHead) {
    // New file — must reach the floor.
    if (!cur)
      return {
        file,
        reason: "new file not exercised by tests (no entry in lcov)",
      };
    if (pct(cur) < floor)
      return {
        file,
        reason: `new file at ${fmtPct(pct(cur))} (${cur.linesHit}/${cur.linesFound}); must be ≥ ${fmtPct(floor)}`,
      };
    return null;
  }

  if (!cur) {
    // File no longer appears in lcov.
    if (prev)
      return {
        file,
        reason: "previously measured but absent from current lcov — regressed to 0",
      };
    return null; // Never measured; tolerate.
  }

  if (!prev) return null; // First time seeing it; accept and ratchet from here.

  if (pct(prev) >= floor) {
    // Was at or above the floor — must stay there.
    if (pct(cur) < floor)
      return {
        file,
        reason: `regressed below floor: was ${fmtPct(pct(prev))}, now ${fmtPct(pct(cur))}`,
      };
    return null;
  }

  // Was below the floor — uncovered-line count must not increase.
  if (uncovered(cur) > uncovered(prev))
    return {
      file,
      reason: `more uncovered lines: ${uncovered(prev)} → ${uncovered(cur)} (${fmtPct(pct(prev))} → ${fmtPct(pct(cur))})`,
    };
  return null;
}

// ---------------------------------------------------------------------------
// Seed mode — accept current lcov as baseline unconditionally
// ---------------------------------------------------------------------------

if (seedMode) {
  const next = { version: 1, files: /** @type {Record<string, FileMetric>} */ ({}) };
  for (const [file, metric] of Object.entries(lcov)) next.files[file] = metric;
  fs.writeFileSync(baselinePath, `${JSON.stringify(next, null, 2)}\n`);
  execSync(`git add ${baselinePath}`, { stdio: "ignore" });
  const count = Object.keys(next.files).length;
  console.log(`coverage ratchet --seed: wrote ${count} files to ${baselinePath}`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/** @type {{ file: string; reason: string }[]} */
const failures = [];
for (const file of stagedFiles) {
  const fail = checkOne(file, baseline.files[file], lcov[file]);
  if (fail) failures.push(fail);
}

if (failures.length > 0) {
  console.error("coverage ratchet failed:");
  for (const f of failures) console.error(`  ${f.file}: ${f.reason}`);
  console.error(
    "\nAdd test coverage for the affected lines before committing.",
  );
  process.exit(1);
}

// Pass: absorb all current lcov numbers into the baseline (not just staged
// files — improvements anywhere ratchet up, not just the files you touched).
const next = { version: 1, files: { ...baseline.files } };
for (const [file, metric] of Object.entries(lcov)) next.files[file] = metric;
fs.writeFileSync(baselinePath, `${JSON.stringify(next, null, 2)}\n`);
execSync(`git add ${baselinePath}`, { stdio: "ignore" });

const summary = stagedFiles
  .map((f) => {
    const cur = lcov[f];
    return cur ? `${f} ${fmtPct(pct(cur))}` : `${f} (not in lcov)`;
  })
  .join(", ");
console.log(`coverage ratchet ok: ${summary}`);

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
//   2. File in baseline: current % must be >= baseline % within TOLERANCE pp,
//      UNLESS it is still >= REGRESSION-WAIVER — a well-covered file may regress
//      freely (one new error-path line shouldn't fail the build).
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
//   --regression-waiver N  0–1; a baselined file at/above this ratio may regress
//                     freely (default: $COVERAGE_REGRESSION_WAIVER or 0.90)
//   --src-root DIR    strip path prefix up to this dir name when normalising lcov
//                     SF: paths (default: src)
//   --seed            HARD RESET: write current lcov to baseline unconditionally,
//                     discarding the existing baseline; no gate check. Use only
//                     when code was legitimately removed and old marks should be
//                     forgotten. Requires lcov to exist; ignores staged_file list.
//   --reseed          MONOTONIC full rebuild: merge current lcov over the EXISTING
//                     baseline taking the per-file max (high-water-mark preserving),
//                     and KEEP baseline entries absent from the lcov. Never lowers
//                     or forgets a file. No gate check; ignores staged_file list.
//                     This is the right choice for a routine full reseed.
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
  reseedBaseline,
} from "./coverage-ratchet-lib.mjs";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

let lcovPath = process.env.COVERAGE_LCOV ?? "coverage/lcov.info";
let baselinePath = process.env.COVERAGE_BASELINE ?? "coverage-baseline.json";
let floor = Number(process.env.COVERAGE_FLOOR ?? "0.75");
let tolerance = Number(process.env.COVERAGE_TOLERANCE ?? "0.005");
let regressionWaiver = Number(process.env.COVERAGE_REGRESSION_WAIVER ?? "0.90");
let srcRoot = "src";
let seedMode = false;
let reseedMode = false;
/** @type {string[]} */
const stagedFiles = [];

for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === "--lcov") lcovPath = process.argv[++i];
  else if (arg === "--baseline") baselinePath = process.argv[++i];
  else if (arg === "--floor") floor = Number(process.argv[++i]);
  else if (arg === "--tolerance") tolerance = Number(process.argv[++i]);
  else if (arg === "--regression-waiver") regressionWaiver = Number(process.argv[++i]);
  else if (arg === "--src-root") srcRoot = process.argv[++i];
  else if (arg === "--seed") seedMode = true;
  else if (arg === "--reseed") reseedMode = true;
  else if (!arg.startsWith("--")) stagedFiles.push(arg);
}

const writeMode = seedMode || reseedMode;
if (!writeMode && stagedFiles.length === 0) process.exit(0);

// ---------------------------------------------------------------------------
// Baseline I/O
// ---------------------------------------------------------------------------

const baselineExists = fs.existsSync(baselinePath);
// Skip parsing in --seed mode — we're about to overwrite, and the existing file
// may be in a legacy format we no longer read. --reseed must parse it: it
// preserves the existing high-water marks.
/** @type {Record<string, number>} */
const baseline =
  baselineExists && !seedMode
    ? parseBaseline(JSON.parse(fs.readFileSync(baselinePath, "utf8")), srcRoot)
    : {};

function writeBaseline(/** @type {Record<string, number>} */ files) {
  fs.writeFileSync(baselinePath, formatBaseline(files));
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      execSync(`git add ${baselinePath}`, { stdio: "ignore" });
      return;
    } catch {
      if (attempt === 3) {
        // The index is busy (concurrent hook commands / parallel sci ratchets).
        // Don't fail an otherwise-passing commit over a staging race — leave the
        // baseline modified; it can be re-staged manually if the bump matters.
        console.error(
          `coverage ratchet: could not stage ${baselinePath} (git index busy); leaving it modified`,
        );
        return;
      }
      execSync("sleep 1");
    }
  }
}

// ---------------------------------------------------------------------------
// lcov
// ---------------------------------------------------------------------------

if (!fs.existsSync(lcovPath)) {
  if (writeMode) {
    const flag = seedMode ? "--seed" : "--reseed";
    console.error(`coverage ratchet ${flag}: ${lcovPath} not found — run tests with coverage first`);
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
// Write modes
//   --reseed  : monotonic full rebuild — merge lcov over existing baseline,
//               max per file, retain absent entries (never forgets a mark).
//   --seed    : hard reset — overwrite from lcov only, discard old baseline.
//   auto-seed : no baseline yet — first run seeds from lcov.
// ---------------------------------------------------------------------------

if (reseedMode) {
  const next = reseedBaseline(baseline, lcov);
  writeBaseline(next);
  console.log(
    `coverage ratchet --reseed: wrote ${Object.keys(next).length} files to ${baselinePath} (high-water marks preserved)`,
  );
  process.exit(0);
}

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
  const fail = checkOne(file, baseline[file], lcov[file], { floor, tolerance, regressionWaiver });
  if (fail) failures.push(fail);
}

if (failures.length > 0) {
  // Classify each failure so the user knows what action to take.
  const dropped = failures.filter((f) => /dropped:/.test(f.reason));
  const missing = failures.filter((f) => /no entry in lcov/.test(f.reason));
  const floored = failures.filter((f) => /must be ≥/.test(f.reason));
  const other = failures.filter(
    (f) => !dropped.includes(f) && !missing.includes(f) && !floored.includes(f),
  );

  console.error("coverage ratchet FAILED");
  console.error("=".repeat(60));
  for (const f of failures) console.error(`  ${f.file}: ${f.reason}`);
  console.error("");

  // Resolve the exclude file path for this baseline so the message tells the
  // user exactly which file to edit (unit vs. E2E differs).
  const baselineDir = baselinePath.includes("e2e") ? "e2e" : "unit";
  const excludeFile =
    baselineDir === "e2e" ? "coverage-e2e-ratchet-exclude" : "coverage-ratchet-exclude";

  if (dropped.length > 0) {
    console.error("ACTION — coverage dropped on these files:");
    for (const f of dropped) console.error(`  ${f.file}`);
    console.error(
      "  → Add test coverage for the newly-uncovered lines, then re-stage and commit.",
    );
    console.error(
      `  → If the new lines are inherently unreachable from this test layer (${baselineDir}),`,
    );
    console.error(
      `    add the file to ${excludeFile} with a one-line reason explaining why.`,
    );
    console.error(
      "  → Do NOT lower the baseline number unless you understand the regression is intended.",
    );
    console.error("");
  }

  if (missing.length > 0) {
    console.error("ACTION — these files have no entry in lcov (no test imports them):");
    for (const f of missing) console.error(`  ${f.file}`);
    console.error("  → Add at least one test that imports the file, OR");
    console.error(`  → Add the file to ${excludeFile} if it is genuinely untestable here`);
    console.error("    (CLI shells, type-only files, hardware-specific code, etc.).");
    console.error("");
  }

  if (floored.length > 0) {
    console.error("ACTION — these new files are below the coverage floor:");
    for (const f of floored) console.error(`  ${f.file}: ${f.reason}`);
    console.error("  → Add tests to bring coverage above the floor before committing.");
    console.error("");
  }

  if (other.length > 0) {
    console.error("ACTION — unclassified failures (investigate manually):");
    for (const f of other) console.error(`  ${f.file}: ${f.reason}`);
    console.error("");
  }

  console.error("=".repeat(60));
  process.exit(1);
}

// Persist raises for STAGED files only. Using the full lcov here would let a
// degraded full-suite run (e.g. `vitest --changed` falling back to all tests)
// silently ratchet up — and auto-commit — baselines for files this commit never
// touched. Seed mode (above) intentionally writes the whole lcov; this
// incremental path must not.
const nextBaseline = { ...baseline };
for (const f of stagedFiles) {
  const m = lcov[f];
  if (m) nextBaseline[f] = Math.max(nextBaseline[f] ?? 0, pct(m));
}
writeBaseline(nextBaseline);

const summary = stagedFiles
  .map((f) => {
    const cur = lcov[f];
    return cur ? `${f} ${fmtPct(pct(cur))}` : `${f} (not in lcov)`;
  })
  .join(", ");
console.log(`coverage ratchet ok: ${summary}`);

// Pure helpers for coverage-ratchet.mjs. No fs / no exec — easy to test.

import path from "node:path";

/** @typedef {{ linesFound: number; linesHit: number; branchesFound: number; branchesHit: number }} FileMetric */
/** @typedef {{ lines: number; branches?: number }} BaselineEntry */
/** @typedef {{ version: 2; files: Record<string, number | { lines: number; branches?: number }> }} Baseline */

/**
 * A baseline entry is a bare number (lines only) or an object carrying both
 * metrics. Repos other than the branch-gated ones hold the number form, so
 * both are read and the number form is written back unchanged.
 * @param {number|BaselineEntry} v
 * @returns {BaselineEntry}
 */
function entry(v) {
  return typeof v === "number" ? { lines: v } : v;
}

/**
 * Normalise an lcov SF: path relative to CWD.
 * Handles absolute paths (server-side coverage), relative paths already
 * relative to CWD, and browser-coverage paths with a hostname:port/ prefix
 * (e.g. "localhost-5438/src/..." → "src/...").
 * @param {string} p
 * @param {string} srcRoot
 * @param {string} [cwd]
 */
export function normalisePath(p, srcRoot, cwd = process.cwd()) {
  // Workspace packages carry their own `<pkg>/src` root. Anchor on `packages/`
  // BEFORE the srcRoot marker so a package file keeps its
  // `packages/<pkg>/src/...` identity instead of collapsing into the top-level
  // src/ namespace (which loses identity and can collide with src/ files).
  if (path.isAbsolute(p)) {
    const cwdSep = cwd + path.sep;
    if (p.startsWith(cwdSep)) return p.slice(cwdSep.length);
    const pkgMarker = `${path.sep}packages${path.sep}`;
    const pkgIdx = p.indexOf(pkgMarker);
    if (pkgIdx !== -1) return p.slice(pkgIdx + 1);
    const marker = `${path.sep}${srcRoot}${path.sep}`;
    const idx = p.indexOf(marker);
    if (idx !== -1) return p.slice(idx + 1);
    return p;
  }
  if (p.startsWith("packages/")) return p;
  const pkgIdx = p.indexOf("/packages/");
  if (pkgIdx !== -1) return p.slice(pkgIdx + 1);
  const marker = `/${srcRoot}/`;
  const idx = p.indexOf(marker);
  if (idx !== -1) return p.slice(idx + 1);
  return p;
}

/**
 * @param {string} text
 * @param {string} srcRoot
 * @returns {Record<string, FileMetric>}
 */
export function parseLcov(text, srcRoot) {
  /** @type {Record<string, FileMetric>} */
  const out = {};
  let sf = /** @type {string|null} */ (null);
  let lf = 0;
  let lh = 0;
  let brf = 0;
  let brh = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("SF:")) {
      sf = normalisePath(line.slice(3).trim(), srcRoot);
      lf = 0;
      lh = 0;
      brf = 0;
      brh = 0;
    } else if (line.startsWith("LF:")) {
      lf = Number(line.slice(3));
    } else if (line.startsWith("LH:")) {
      lh = Number(line.slice(3));
    } else if (line.startsWith("BRF:")) {
      brf = Number(line.slice(4));
    } else if (line.startsWith("BRH:")) {
      brh = Number(line.slice(4));
    } else if (line === "end_of_record" && sf) {
      out[sf] = { linesFound: lf, linesHit: lh, branchesFound: brf, branchesHit: brh };
      sf = null;
    }
  }
  return out;
}

/** @param {FileMetric} m */
export function pct(m) {
  return m.linesFound === 0 ? 1 : m.linesHit / m.linesFound;
}

/** @param {FileMetric} m */
export function branchPct(m) {
  return m.branchesFound === 0 ? 1 : m.branchesHit / m.branchesFound;
}

/** @param {number} p */
export function fmtPct(p) {
  return `${(p * 100).toFixed(2)}%`;
}

/**
 * Parse a v2 baseline JSON object to canonical { path: { lines, branches? } },
 * ratios 0-1. Normalises paths; collapses duplicates via max, per metric.
 * @param {unknown} parsed
 * @param {string} srcRoot
 * @returns {Record<string, BaselineEntry>}
 */
export function parseBaseline(parsed, srcRoot) {
  const obj = /** @type {{version?: number; files?: Record<string, number|BaselineEntry>}} */ (
    parsed
  );
  if (obj.version !== 2)
    throw new Error(`unsupported baseline version ${obj.version} — re-seed with --seed`);
  /** @type {Record<string, BaselineEntry>} */
  const files = {};
  for (const [k, v] of Object.entries(obj.files ?? {})) {
    const key = normalisePath(String(k), srcRoot);
    const e = entry(v);
    const lines = Number(e.lines) / 100;
    const branches = e.branches === undefined ? undefined : Number(e.branches) / 100;
    const prev = files[key];
    files[key] = {
      lines: prev === undefined ? lines : Math.max(prev.lines, lines),
      branches: maxDefined(prev?.branches, branches),
    };
  }
  return files;
}

/**
 * @param {number|undefined} a
 * @param {number|undefined} b
 */
function maxDefined(a, b) {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.max(a, b);
}

/**
 * Format canonical entries back to a v2 baseline JSON string. Keys sorted for
 * stable diffs; percentages 0-100 with 2-decimal precision. A file with no
 * branch figure stays a bare number.
 * @param {Record<string, number|BaselineEntry>} files
 */
export function formatBaseline(files) {
  /** @type {Record<string, number|{lines: number; branches: number}>} */
  const sorted = {};
  for (const k of Object.keys(files).sort()) {
    const e = entry(files[k]);
    const lines = Number((e.lines * 100).toFixed(2));
    sorted[k] =
      e.branches === undefined
        ? lines
        : { lines, branches: Number((e.branches * 100).toFixed(2)) };
  }
  return `${JSON.stringify({ version: 2, files: sorted }, null, 2)}\n`;
}

/**
 * One metric's regression rules: waiver first, then the pct tolerance OR a
 * small absolute count drop.
 * @param {number} prevPct
 * @param {number} curPct
 * @param {number} found
 * @param {number} hit
 * @param {{ tolerance: number; regressionWaiver: number; waiverDrop: number; lineTolerance: number }} opts
 * @param {string} label
 * @param {string} unit
 * @returns {string|null}
 */
function metricRegression(prevPct, curPct, found, hit, opts, label, unit) {
  const { tolerance, regressionWaiver, waiverDrop, lineTolerance } = opts;
  // A baselined file at/above the waiver absorbs small drops without churn, but
  // the waiver is not a floor to slide to: past waiverDrop it is a regression.
  if (curPct >= regressionWaiver && prevPct - curPct <= waiverDrop) return null;
  // Pass within EITHER the pct tolerance OR a small absolute covered-count drop.
  // The baseline stores only a %, so derive the implied prior hit count from the
  // CURRENT total (stable for an incidental touch); a sub-lineTolerance drop
  // is e2e-instrument noise, not a regression.
  const drop = prevPct * found - hit;
  if (curPct < prevPct - tolerance && drop > lineTolerance)
    return `${label} dropped: ${fmtPct(prevPct)} → ${fmtPct(curPct)} (tolerance ${(tolerance * 100).toFixed(2)} pp / ${lineTolerance} ${unit}; waiver ≥ ${fmtPct(regressionWaiver)})`;
  return null;
}

/**
 * Per-file gate check.
 * @param {string} file
 * @param {number|BaselineEntry|undefined} prev  Baseline entry, or undefined if not in baseline.
 * @param {FileMetric|undefined} cur  Current lcov entry.
 * @param {{ floor: number; tolerance: number; regressionWaiver?: number; waiverDrop?: number; lineTolerance?: number }} opts
 *   floor             — minimum for a file with no baseline entry (new files).
 *   tolerance         — slack vs baseline % to absorb instrumentation noise.
 *   regressionWaiver  — a baselined file at/above this ratio may regress without
 *                       hitting the tolerance/lineTolerance checks, as long as the
 *                       drop from baseline stays within waiverDrop (a well-covered
 *                       file shouldn't fail the build over one new error-path
 *                       line; that just pushes toward excludes). Defaults to 1
 *   branches          — also gate branch coverage against the entry's branches
 *                       figure. Off by default. An entry with no branches figure
 *                       records one and passes, per the ratchet's bootstrap rule.
 *                       (off) here; the CLI passes 0.90.
 *   waiverDrop        — bounds the waiver: past this many percentage points below
 *                       baseline, even a file still above regressionWaiver is a
 *                       regression. Default 0.05.
 *   lineTolerance     — absolute covered-line slack. A drop within EITHER the pct
 *                       tolerance OR this many covered lines passes. On a low-
 *                       coverage e2e-dominated file (few lines = many pp), a 1-2
 *                       line e2e-instrument flake otherwise false-drops a file the
 *                       commit never meaningfully changed. Default 5.
 * @returns {{ file: string; reason: string }|null}
 */
export function checkOne(
  file,
  prev,
  cur,
  {
    floor,
    tolerance,
    regressionWaiver = 1,
    waiverDrop = 0.05,
    lineTolerance = 5,
    branches = false,
  },
) {
  // .d.ts files are pure type declarations — erased at compile, zero runtime
  // lines, so they can never appear in lcov. Never gate them (no per-repo
  // exclude needed). Applies to the whole extension, not individual files.
  if (file.endsWith(".d.ts")) return null;
  const prevEntry = prev === undefined ? undefined : entry(prev);
  if (prevEntry === undefined) {
    if (!cur)
      return { file, reason: "file not exercised by tests (no entry in lcov)" };
    if (pct(cur) < floor)
      return {
        file,
        reason: `at ${fmtPct(pct(cur))} (${cur.linesHit}/${cur.linesFound}); must be ≥ ${fmtPct(floor)}`,
      };
    return null;
  }
  if (!cur)
    return { file, reason: "previously measured but absent from current lcov — regressed to 0" };
  const opts = { tolerance, regressionWaiver, waiverDrop, lineTolerance };
  const lineReason = metricRegression(
    prevEntry.lines, pct(cur), cur.linesFound, cur.linesHit, opts, "coverage", "lines",
  );
  if (lineReason) return { file, reason: lineReason };
  if (!branches || prevEntry.branches === undefined) return null;
  const branchReason = metricRegression(
    prevEntry.branches, branchPct(cur), cur.branchesFound, cur.branchesHit, opts,
    "branch coverage", "branches",
  );
  return branchReason ? { file, reason: branchReason } : null;
}

/**
 * Compute the next baseline after a passing run — improvements anywhere in
 * lcov ratchet the stored % up; existing entries not in this lcov stay put.
 * @param {Record<string, number|BaselineEntry>} prev  Baseline entries.
 * @param {Record<string, FileMetric>} lcov
 * @param {{ branches?: boolean }} [opts]
 * @returns {Record<string, BaselineEntry>}
 */
export function ratchetUp(prev, lcov, { branches = false } = {}) {
  /** @type {Record<string, BaselineEntry>} */
  const next = {};
  for (const [file, v] of Object.entries(prev)) next[file] = { ...entry(v) };
  for (const [file, metric] of Object.entries(lcov)) {
    const e = next[file] ?? { lines: 0 };
    e.lines = Math.max(e.lines, pct(metric));
    // No branches measured means nothing to ratchet. Recording the 100% that
    // branchPct reports would pin a mark the file never earned, and an lcov that
    // carries no branch records at all would pin it on every file at once.
    if (branches && metric.branchesFound > 0)
      e.branches = Math.max(e.branches ?? 0, branchPct(metric));
    next[file] = e;
  }
  return next;
}

/**
 * Compute a full-rebuild baseline that PRESERVES every accumulated high-water
 * mark. Unlike a hard `--seed` (which discards the old baseline), this merges
 * the new lcov over the existing baseline taking the max per file, and keeps
 * baseline entries absent from the new lcov untouched — so a full reseed can
 * never "forget" or lower a file below its accumulated mark. (Mechanically the
 * same monotonic max-merge as {@link ratchetUp}; named separately to mark the
 * deliberate full-reseed intent at the call site.)
 * @param {Record<string, number|BaselineEntry>} prev  Existing baseline entries.
 * @param {Record<string, FileMetric>} lcov
 * @param {{ branches?: boolean }} [opts]
 * @returns {Record<string, BaselineEntry>}
 */
export function reseedBaseline(prev, lcov, opts) {
  return ratchetUp(prev, lcov, opts);
}

// Pure helpers for coverage-ratchet.mjs. No fs / no exec — easy to test.

import path from "node:path";

/** @typedef {{ linesFound: number; linesHit: number }} FileMetric */
/** @typedef {{ version: 2; files: Record<string, number> }} Baseline */

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
  if (path.isAbsolute(p)) {
    const cwdSep = cwd + path.sep;
    if (p.startsWith(cwdSep)) return p.slice(cwdSep.length);
    const marker = `${path.sep}${srcRoot}${path.sep}`;
    const idx = p.indexOf(marker);
    if (idx !== -1) return p.slice(idx + 1);
    return p;
  }
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
  for (const line of text.split("\n")) {
    if (line.startsWith("SF:")) {
      sf = normalisePath(line.slice(3).trim(), srcRoot);
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

/** @param {FileMetric} m */
export function pct(m) {
  return m.linesFound === 0 ? 1 : m.linesHit / m.linesFound;
}

/** @param {number} p */
export function fmtPct(p) {
  return `${(p * 100).toFixed(2)}%`;
}

/**
 * Parse a v2 baseline JSON object to canonical { path: ratio0-1 }.
 * Normalises paths; collapses duplicates via max.
 * @param {unknown} parsed
 * @param {string} srcRoot
 * @returns {Record<string, number>}
 */
export function parseBaseline(parsed, srcRoot) {
  const obj = /** @type {{version?: number; files?: Record<string, number>}} */ (parsed);
  if (obj.version !== 2)
    throw new Error(`unsupported baseline version ${obj.version} — re-seed with --seed`);
  /** @type {Record<string, number>} */
  const files = {};
  for (const [k, v] of Object.entries(obj.files ?? {})) {
    const key = normalisePath(String(k), srcRoot);
    const ratio = Number(v) / 100;
    if (files[key] === undefined || ratio > files[key]) files[key] = ratio;
  }
  return files;
}

/**
 * Format a canonical { path: ratio } back to a v2 baseline JSON string.
 * Keys sorted for stable diffs; percentages 0-100 with 2-decimal precision.
 * @param {Record<string, number>} files
 */
export function formatBaseline(files) {
  /** @type {Record<string, number>} */
  const sorted = {};
  for (const k of Object.keys(files).sort()) {
    sorted[k] = Number((files[k] * 100).toFixed(2));
  }
  return `${JSON.stringify({ version: 2, files: sorted }, null, 2)}\n`;
}

/**
 * Per-file gate check.
 * @param {string} file
 * @param {number|undefined} prevPct  Baseline ratio 0-1, or undefined if not in baseline.
 * @param {FileMetric|undefined} cur  Current lcov entry.
 * @param {{ floor: number; tolerance: number; regressionWaiver?: number }} opts
 *   floor             — minimum for a file with no baseline entry (new files).
 *   tolerance         — slack vs baseline % to absorb instrumentation noise.
 *   regressionWaiver  — a baselined file at/above this ratio may regress freely
 *                       (a well-covered file shouldn't fail the build over one
 *                       new error-path line; that just pushes toward excludes).
 *                       Default 1 (off — no waiver) preserves strict behavior.
 * @returns {{ file: string; reason: string }|null}
 */
export function checkOne(file, prevPct, cur, { floor, tolerance, regressionWaiver = 1 }) {
  if (prevPct === undefined) {
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
  // A baselined file that stays at/above the waiver is allowed to regress.
  if (pct(cur) >= regressionWaiver) return null;
  if (pct(cur) < prevPct - tolerance)
    return {
      file,
      reason: `coverage dropped: ${fmtPct(prevPct)} → ${fmtPct(pct(cur))} (tolerance ${(tolerance * 100).toFixed(2)} pp; waiver ≥ ${fmtPct(regressionWaiver)})`,
    };
  return null;
}

/**
 * Compute the next baseline after a passing run — improvements anywhere in
 * lcov ratchet the stored % up; existing entries not in this lcov stay put.
 * @param {Record<string, number>} prev  Baseline ratios.
 * @param {Record<string, FileMetric>} lcov
 * @returns {Record<string, number>}
 */
export function ratchetUp(prev, lcov) {
  /** @type {Record<string, number>} */
  const next = { ...prev };
  for (const [file, metric] of Object.entries(lcov)) {
    const curPct = pct(metric);
    const prevPct = next[file] ?? 0;
    next[file] = Math.max(prevPct, curPct);
  }
  return next;
}

// Pure helpers for coverage-union-merge.mjs. No fs / no exec — easy to test.
// Produces a per-line UNION lcov: a line is covered if it is hit in EITHER input.
// The ratchet (coverage-ratchet.mjs) consumes the recomputed LF/LH unchanged.

import { normalisePath } from "./coverage-ratchet-lib.mjs";

/** @typedef {Map<string, Map<number, number>>} FileLines  canonicalSF -> (lineNo -> hits) */

/**
 * Parse an lcov into canonicalSF -> Map(lineNo -> maxHits). SF paths are
 * normalised so unit ("src/App.tsx") and monocart e2e
 * ("localhost-5441/src/App.tsx") records merge under the same key. Repeated
 * records for one file (and repeated DA lines) collapse via max.
 * @param {string} text
 * @param {string} srcRoot
 * @returns {FileLines}
 */
export function parseLcovDA(text, srcRoot) {
  /** @type {FileLines} */
  const files = new Map();
  /** @type {Map<number, number>|null} */
  let lines = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("SF:")) {
      const sf = normalisePath(line.slice(3).trim(), srcRoot);
      lines = files.get(sf);
      if (!lines) {
        lines = new Map();
        files.set(sf, lines);
      }
    } else if (line.startsWith("DA:") && lines) {
      const comma = line.indexOf(",");
      const lineNo = Number(line.slice(3, comma));
      const hits = Number(line.slice(comma + 1));
      if (Number.isFinite(lineNo)) {
        lines.set(lineNo, Math.max(lines.get(lineNo) ?? 0, hits || 0));
      }
    } else if (line === "end_of_record") {
      lines = null;
    }
  }
  return files;
}

/**
 * Per-line OR of two parsed lcovs. Files in either input appear in the result.
 * @param {FileLines} a
 * @param {FileLines} b
 * @returns {FileLines}
 */
export function unionFiles(a, b) {
  /** @type {FileLines} */
  const out = new Map();
  for (const [sf, lines] of a) out.set(sf, new Map(lines));
  for (const [sf, lines] of b) {
    let cur = out.get(sf);
    if (!cur) {
      cur = new Map();
      out.set(sf, cur);
    }
    for (const [n, h] of lines) cur.set(n, Math.max(cur.get(n) ?? 0, h));
  }
  return out;
}

/**
 * Carry forward a full-run e2e baseline onto the fresh per-commit union WITHOUT
 * inflating the denominator.
 *
 * - File ABSENT from `fresh` (the TIA subset simply didn't run it this commit):
 *   carry the whole baseline. The file is unchanged, so its line numbers still
 *   align and it is the only coverage estimate we have.
 * - File PRESENT in `fresh` (it WAS run, and may have been edited so its lines
 *   shifted): only let the baseline flip EXISTING uncovered lines to covered.
 *   Never add baseline-only lines — a changed file's stale, old-numbered
 *   `DA:n,0` entries would otherwise inflate LF and FALSE-DROP it, even though
 *   its fresh unit∪e2e coverage is intact.
 *
 * @param {FileLines} fresh  unit ∪ per-commit e2e
 * @param {FileLines} baseline  persisted full-run e2e
 * @returns {FileLines}
 */
export function mergeBaseline(fresh, baseline) {
  /** @type {FileLines} */
  const out = new Map();
  for (const [sf, lines] of fresh) out.set(sf, new Map(lines));
  for (const [sf, blines] of baseline) {
    const cur = out.get(sf);
    if (!cur) {
      out.set(sf, new Map(blines));
      continue;
    }
    for (const [n, h] of cur) {
      if (h === 0) {
        const bh = blines.get(n) ?? 0;
        if (bh > 0) cur.set(n, bh);
      }
    }
  }
  return out;
}

/**
 * Serialise to a minimal valid lcov (SF/DA/LF/LH/end_of_record). LF/LH are
 * recomputed from the unioned DA set, so they encode the per-line union.
 * @param {FileLines} files
 * @returns {string}
 */
export function formatLcov(files) {
  const out = [];
  for (const sf of [...files.keys()].sort()) {
    const lines = files.get(sf);
    out.push(`SF:${sf}`);
    let lh = 0;
    for (const n of [...lines.keys()].sort((x, y) => x - y)) {
      const h = lines.get(n);
      if (h > 0) lh++;
      out.push(`DA:${n},${h}`);
    }
    out.push(`LF:${lines.size}`);
    out.push(`LH:${lh}`);
    out.push("end_of_record");
  }
  return out.length ? out.join("\n") + "\n" : "";
}

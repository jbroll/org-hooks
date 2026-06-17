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
 * Drop incidental unit instrumentation that only inflates the denominator.
 *
 * A boot-path file with no unit test (e.g. App.tsx — only Main.tsx imports it)
 * still gets LOADED by `vitest --changed` whenever a changed test transitively
 * pulls it in. v8 then instruments it at line numbers the monocart e2e baseline
 * never uses — all uncovered — so they can never be covered and inflate LF.
 * Because WHICH lines appear depends on the (varying) --changed selection, the
 * file false-drops non-deterministically. When unit covers ZERO lines of a file
 * that e2e DOES cover, that unit attribution is pure noise: drop it so the file's
 * coverage comes from e2e (+baseline) alone. Files with real unit coverage
 * (LH>0) and files e2e does not cover (genuinely 0%) are kept untouched.
 * @param {FileLines} unit
 * @param {FileLines} e2eCombined  per-commit e2e ∪ full-run e2e baseline
 * @returns {FileLines}
 */
export function scrubIncidentalUnit(unit, e2eCombined) {
  /** @type {FileLines} */
  const out = new Map();
  for (const [sf, lines] of unit) {
    const unitCovers = [...lines.values()].some((h) => h > 0);
    if (!unitCovers) {
      const e = e2eCombined.get(sf);
      if (e && [...e.values()].some((h) => h > 0)) continue; // incidental → drop
    }
    out.set(sf, new Map(lines));
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

/** @typedef {{oldStart:number,oldCount:number,newStart:number,newCount:number}} Hunk */

/**
 * Parse `git diff --no-color -U0 <baselineSha>` into canonicalSF -> Hunk[].
 * The baseline lcov is keyed to the OLD line numbers from the last green
 * ci/e2e-map; a line-shifting edit since then (e.g. a barrel→leaf import split
 * adding N import lines) moves every line below, so the baseline misaligns and
 * mergeBaseline carries coverage onto the WRONG lines, false-dropping an
 * e2e-dominated file. These hunks drive remapBaseline (old line -> new line).
 * @param {string} diffText
 * @param {string} srcRoot
 * @returns {Map<string, Hunk[]>}
 */
export function parseDiffHunks(diffText, srcRoot) {
  /** @type {Map<string, Hunk[]>} */
  const out = new Map();
  /** @type {Hunk[]|null} */
  let cur = null;
  for (const raw of diffText.split("\n")) {
    if (raw.startsWith("+++ ")) {
      const p = raw.slice(4).trim().replace(/^b\//, "");
      if (p === "/dev/null") {
        cur = null;
        continue;
      }
      const sf = normalisePath(p, srcRoot);
      cur = [];
      out.set(sf, cur);
    } else if (raw.startsWith("@@") && cur) {
      const m = raw.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (m) {
        cur.push({
          oldStart: Number(m[1]),
          oldCount: m[2] === undefined ? 1 : Number(m[2]),
          newStart: Number(m[3]),
          newCount: m[4] === undefined ? 1 : Number(m[4]),
        });
      }
    }
  }
  return out;
}

/**
 * Map an OLD line number to its NEW position through diff hunks, or null if the
 * line was deleted/modified (its coverage must NOT carry — that code changed, so
 * it should be measured fresh, not inherited). Each hunk independently shifts
 * lines that fall AFTER its old range; a pure insertion (`-X,0`) shifts only
 * lines strictly after X.
 * @param {number} oldLine
 * @param {Hunk[]} hunks
 * @returns {number|null}
 */
export function remapLine(oldLine, hunks) {
  let n = oldLine;
  for (const h of hunks) {
    if (h.oldCount === 0) {
      if (oldLine > h.oldStart) n += h.newCount;
    } else {
      if (oldLine >= h.oldStart && oldLine < h.oldStart + h.oldCount) return null;
      if (oldLine >= h.oldStart + h.oldCount) n += h.newCount - h.oldCount;
    }
  }
  return n;
}

/**
 * Remap a stale e2e baseline onto current line numbers. Files ABSENT from
 * `hunksByFile` are unchanged since the baseline → kept verbatim. Files PRESENT
 * are remapped per line; deleted/modified lines drop out so they cannot carry
 * stale coverage. This is what makes a line-shifting edit coverage-neutral.
 * @param {FileLines} baseline
 * @param {Map<string, Hunk[]>} hunksByFile
 * @returns {FileLines}
 */
export function remapBaseline(baseline, hunksByFile) {
  /** @type {FileLines} */
  const out = new Map();
  for (const [sf, blines] of baseline) {
    const hunks = hunksByFile.get(sf);
    if (!hunks) {
      out.set(sf, new Map(blines));
      continue;
    }
    /** @type {Map<number, number>} */
    const remapped = new Map();
    for (const [n, h] of blines) {
      const nn = remapLine(n, hunks);
      if (nn !== null) remapped.set(nn, Math.max(remapped.get(nn) ?? 0, h));
    }
    out.set(sf, remapped);
  }
  return out;
}

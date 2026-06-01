// Pure helpers for the e2e coverage-attribution map. No I/O.
// A spec's covered set = the /src/ files its V8 coverage shows as executed.

/**
 * Extract executed /src/ file paths from a page.coverage.stopJSCoverage() array.
 *
 * frontendPort is OPTIONAL. When a truthy port is given, entries served from a
 * different port are dropped. When omitted (or falsy) the port is ignored and
 * every executed /src/ URL is kept -- callers that cannot reliably know the
 * bound port should omit it, since the app is the only /src/ source served.
 *
 * @param {Array<{url: string, functions?: Array<{ranges?: Array<{count: number}>}>}>} entries
 * @param {number|string} [frontendPort]
 * @returns {string[]}
 */
export function coveredSrcFiles(entries, frontendPort) {
  if (!Array.isArray(entries)) return [];
  const out = new Set();
  for (const e of entries) {
    const url = e?.url ?? "";
    const i = url.indexOf("/src/");
    if (i === -1) continue;
    if (frontendPort && !url.includes(`:${frontendPort}`)) continue;
    const executed = (e.functions ?? []).some((f) => (f.ranges ?? []).some((r) => r.count > 0));
    if (!executed) continue;
    out.add(url.slice(i + 1).split("?")[0]); // strip leading "/" and query → "src/..."
  }
  return [...out].sort();
}

/** Set map[specId] = sorted-unique files. */
export function mergeIntoMap(map, specId, files) {
  map[specId] = [...new Set(files)].sort();
  return map;
}

/**
 * Drop src files whose spec-frequency (fraction of specs covering them) is at or
 * above `threshold`. A file covered by EVERY spec can never narrow selection
 * (intersecting it always returns all specs), so it is pure noise — the IDF
 * "stopword" of test-impact analysis. Removing it lets the files that DO vary
 * across specs drive selection. Statistical, not a hand-maintained blacklist:
 * re-derived from the map each build.
 *
 * Only meaningful on a full build (all specs present); skipped when there are
 * too few specs to be statistically meaningful (a file in "all" of 1–2 specs is
 * not ubiquitous). Spec keys are preserved (kept-file lists may become empty;
 * the selector simply never intersects an empty list).
 *
 * @param {Record<string, string[]>} map  spec → files
 * @param {number} [threshold=1.0]  prune files with DF >= this (1.0 = all specs)
 * @param {number} [minSpecs=8]     skip pruning below this many specs
 * @returns {{ map: Record<string, string[]>, pruned: string[], specCount: number }}
 */
export function pruneUbiquitous(map, threshold = 1.0, minSpecs = 8) {
  const specs = Object.keys(map);
  const n = specs.length;
  if (n < minSpecs) return { map, pruned: [], specCount: n };

  const df = {};
  for (const files of Object.values(map)) {
    for (const f of files) df[f] = (df[f] ?? 0) + 1;
  }
  const drop = new Set(
    Object.entries(df)
      .filter(([, c]) => c / n >= threshold)
      .map(([f]) => f),
  );

  const out = {};
  for (const [spec, files] of Object.entries(map)) {
    out[spec] = files.filter((f) => !drop.has(f));
  }
  return { map: out, pruned: [...drop].sort(), specCount: n };
}

/**
 * Count files by their `src/<a>/<b>` area prefix, descending. Used to summarize
 * the pruned (universal) set into a "lazy-load candidates" report — feature-ish
 * areas with many universal files are eager-import candidates to move off the
 * boot path.
 *
 * @param {string[]} files
 * @returns {Array<[string, number]>}  [area, count] sorted by count desc
 */
export function summarizeAreas(files) {
  const counts = {};
  for (const f of files) {
    const area = f.split("/").slice(0, 3).join("/");
    counts[area] = (counts[area] ?? 0) + 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1]);
}

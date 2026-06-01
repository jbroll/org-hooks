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

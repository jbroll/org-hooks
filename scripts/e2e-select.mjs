// Decide which e2e specs to run for a set of changed paths, given the coverage
// attribution map. Always selects @smoke (the floor) plus every spec that
// covers a MAPPED changed file. An unmapped changed file leans on the @smoke
// floor (the nightly map rebuild refreshes its coverage) and must NOT discard
// the specs selected for mapped files — see selectSpecs.
//
// When the map is function-level ({ spec: { file: [fns] } }) and a per-file
// changed-functions manifest is supplied, selection NARROWS: a changed file
// selects only the specs covering one of its changed functions. This narrowing
// fires ONLY when every changed fn name is recognized in the file's fn-vocabulary;
// any unrecognized name (a new fn, or a V8↔TS naming mismatch) coarse-falls-back
// to all specs covering the file, so a mismatch never under-selects.
export const DEFAULT_E2E_EXCLUDE = [/^backend\//, /^scripts\//, /\.d\.ts$/, /^src\/test\//, /^docs\//, /\.md$/];

const isSpec = (p) => /(^|\/)tests\/.*\.spec\.(ts|tsx)$/.test(p) || /\.spec\.(ts|tsx)$/.test(p);

/** True if a map entry (array=file-level, object=fn-level) covers `file`. */
function entryHasFile(entry, file) {
  return Array.isArray(entry) ? entry.includes(file) : Object.prototype.hasOwnProperty.call(entry ?? {}, file);
}
/** Functions a map entry attributes to `file` ([] for legacy array entries). */
function entryFns(entry, file) {
  return Array.isArray(entry) ? [] : (entry?.[file] ?? []);
}

export function selectSpecs({ changed, map, smoke = [], exclude = DEFAULT_E2E_EXCLUDE, changedFns = null }) {
  if (!map || typeof map !== "object") return { runAll: true, specs: [], reason: "no-map" };
  const specs = new Set(smoke);
  const unmapped = [];
  let narrowed = 0;
  for (const p of changed ?? []) {
    if (isSpec(p)) { specs.add(p); continue; }
    if (exclude.some((re) => re.test(p))) continue;
    const fileSpecs = Object.entries(map).filter(([, e]) => entryHasFile(e, p));
    // An unmapped file's impact is unknown — the @smoke floor is its proxy. Do NOT
    // early-return runAll: that discarded specs already selected for mapped files.
    if (fileSpecs.length === 0) { unmapped.push(p); continue; }

    const fns = changedFns?.[p];
    const fnLevel = changedFns && Array.isArray(fns) && fileSpecs.every(([, e]) => !Array.isArray(e));
    if (!fnLevel) {
      for (const [s] of fileSpecs) specs.add(s); // coarse: "*", legacy entry, or no fn data
      continue;
    }
    // Narrow ONLY when every changed fn is recognized in the file's fn-vocabulary.
    // An unrecognized name is a new fn OR a V8↔TS naming mismatch — either way,
    // coarse-fall-back so a mismatch can't masquerade as "covered by no spec" and
    // silently under-select (which would reintroduce false coverage drops).
    const known = new Set(fileSpecs.flatMap(([, e]) => entryFns(e, p)));
    if (!fns.every((fn) => known.has(fn))) {
      for (const [s] of fileSpecs) specs.add(s);
      continue;
    }
    for (const [s, e] of fileSpecs) {
      if (fns.some((fn) => entryFns(e, p).includes(fn))) specs.add(s);
    }
    narrowed++;
  }
  const parts = [];
  if (narrowed) parts.push(`narrowed:${narrowed}`);
  if (unmapped.length) parts.push(`smoke-floor(unmapped:${unmapped.length})`);
  const reason = parts.length ? parts.join("+") : "mapped";
  return { runAll: false, specs: [...specs].sort(), reason };
}

// Decide which e2e specs to run for a set of changed paths, given the coverage
// attribution map. Always selects @smoke (the floor) plus every spec that
// covers a MAPPED changed file. An unmapped changed file leans on the @smoke
// floor (the nightly map rebuild refreshes its coverage) and must NOT discard
// the specs selected for mapped files — see selectSpecs.
export const DEFAULT_E2E_EXCLUDE = [/^backend\//, /^scripts\//, /\.d\.ts$/, /^src\/test\//, /^docs\//, /\.md$/];

const isSpec = (p) => /(^|\/)tests\/.*\.spec\.(ts|tsx)$/.test(p) || /\.spec\.(ts|tsx)$/.test(p);

export function selectSpecs({ changed, map, smoke = [], exclude = DEFAULT_E2E_EXCLUDE }) {
  if (!map || typeof map !== "object") return { runAll: true, specs: [], reason: "no-map" };
  const specs = new Set(smoke);
  const unmapped = [];
  for (const p of changed ?? []) {
    if (isSpec(p)) { specs.add(p); continue; }
    if (exclude.some((re) => re.test(p))) continue;
    const covering = Object.entries(map).filter(([, files]) => files.includes(p)).map(([spec]) => spec);
    // An unmapped file's impact is unknown — the @smoke floor is its proxy.
    // Crucially, do NOT early-return runAll here: that discarded the specs
    // already selected for mapped files, so a route shell (e.g. MapView)
    // covered only by non-smoke specs lost them and the union ratchet reported
    // a false coverage regression. Accumulate; let @smoke cover the tail.
    if (covering.length === 0) { unmapped.push(p); continue; }
    for (const s of covering) specs.add(s);
  }
  const reason = unmapped.length ? `mapped+smoke-floor(unmapped:${unmapped.length})` : "mapped";
  return { runAll: false, specs: [...specs].sort(), reason };
}

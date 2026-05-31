// Decide which e2e specs to run for a set of changed paths, given the coverage
// attribution map. FAIL-SAFE: anything uncertain → runAll (never silently fewer).
export const DEFAULT_E2E_EXCLUDE = [/^backend\//, /^scripts\//, /\.d\.ts$/, /^src\/test\//, /^docs\//, /\.md$/];

const isSpec = (p) => /(^|\/)tests\/.*\.spec\.(ts|tsx)$/.test(p) || /\.spec\.(ts|tsx)$/.test(p);

export function selectSpecs({ changed, map, smoke = [], exclude = DEFAULT_E2E_EXCLUDE }) {
  if (!map || typeof map !== "object") return { runAll: true, specs: [], reason: "no-map" };
  const specs = new Set(smoke);
  for (const p of changed ?? []) {
    if (isSpec(p)) { specs.add(p); continue; }
    if (exclude.some((re) => re.test(p))) continue;
    const covering = Object.entries(map).filter(([, files]) => files.includes(p)).map(([spec]) => spec);
    if (covering.length === 0) return { runAll: true, specs: [], reason: `unmapped:${p}` };
    for (const s of covering) specs.add(s);
  }
  return { runAll: false, specs: [...specs].sort(), reason: "mapped" };
}

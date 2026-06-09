// Aggregate per-worker JSONL coverage-attribution files into a single
// spec → src-files map, written atomically to $CI_FLAKE_MAP.
//
// Per-worker JSONL is produced by the tests/fixtures.ts `_coverage` hook when
// E2E_BUILD_IMPACT_MAP is set (one line per test: { spec, files }). This script
// folds them into { "<spec>": ["src/a.ts", ...] }, unioning files for a spec
// that appears in multiple worker files (or multiple lines).
//
// Atomicity: write to <path>.tmp.<pid>, then rename over the target (rename is
// atomic on the same filesystem) so readers never observe a partial file.
// Cross-process serialization is provided by the caller (ci/e2e-map) wrapping
// the invocation in `flock <path>.lock -c`.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { mergeIntoMap, pruneUbiquitous, summarizeAreas } from "./e2e-impact-lib.mjs";

/** Consumer worktree root — the job cd's here and exports WORKTREE. */
const WORKTREE = process.env.WORKTREE ?? process.cwd();
/**
 * Worktree-relative dir where the fixture appends per-worker JSONL.
 * MUST stay a SIBLING of monocart's e2e coverage outputDir (coverage/e2e), not a
 * child: monocart's global-teardown generate() runs with clean:true and empties
 * coverage/e2e before this builder reads it, so an impact subdir under it would
 * be deleted mid-run → empty map. See build-e2e-map.test.mjs "IMPACT_DIR placement".
 */
/** SIBLING of monocart's coverage/e2e outputDir (wiped on generate), NOT a child. */
export const IMPACT_DIR = path.resolve(WORKTREE, "coverage", "e2e-impact");

/**
 * Read every *.jsonl file in `dir` and fold its `{ spec, files }` lines into a
 * single { spec: sorted-unique-files } map. Malformed lines are skipped. A spec
 * seen across multiple files/lines gets the union of its files. Missing dir → {}.
 * @param {string} dir
 * @returns {Record<string, string[]>}
 */
export function aggregate(dir) {
  /** @type {Record<string, string[]>} */
  const map = {};
  if (!existsSync(dir)) return map;

  let names;
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".jsonl")).sort();
  } catch {
    return map;
  }

  // Accumulate raw file lists per spec first, then merge once (sorted-unique).
  /** @type {Record<string, string[]>} */
  const acc = {};
  for (const name of names) {
    const full = path.join(dir, name);
    let text;
    try {
      if (!statSync(full).isFile()) continue;
      text = readFileSync(full, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed);
        if (!obj || typeof obj.spec !== "string" || !Array.isArray(obj.files)) continue;
        const files = obj.files.filter((f) => typeof f === "string");
        (acc[obj.spec] ??= []).push(...files);
      } catch {
        // malformed line — skip
      }
    }
  }

  for (const spec of Object.keys(acc)) {
    mergeIntoMap(map, spec, acc[spec]);
  }
  return map;
}

/** Resolve the output map path from $CI_FLAKE_MAP or CI_REPO-derived default. */
export function mapPath() {
  if (process.env.CI_FLAKE_MAP) return process.env.CI_FLAKE_MAP;
  if (process.env.CI_REPO) return path.join(homedir(), "ci-flake", `${process.env.CI_REPO}-e2e-impact.json`);
  throw new Error("build-e2e-map: set CI_FLAKE_MAP or CI_REPO");
}

/**
 * Write `map` to `outPath` atomically (tmp file + rename). Creates parent dir.
 * @param {Record<string, string[]>} map
 * @param {string} outPath
 */
export function writeMapAtomic(map, outPath) {
  mkdirSync(path.dirname(outPath), { recursive: true });
  const tmp = `${outPath}.tmp.${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(map, null, 2)}\n`);
  renameSync(tmp, outPath);
}

function main() {
  const raw = aggregate(IMPACT_DIR);

  // The selection artifact is the FULL spec→files truth — we deliberately do NOT
  // prune ubiquitous (DF=1.0) files out of it. A file covered by every spec is
  // the strongest possible signal that changing it can break anything, so the
  // selector must map it to all its covering specs, not to zero. Pruning created
  // a cliff (a file in 75/76 specs selects 75; in 76/76 selects 0), silently
  // under-selecting boot-path files (mapService, jazz/*, etc.) — which then leaned
  // on the @smoke floor and tripped false union-coverage drops. Pruning now feeds
  // ONLY the informational universal report below; it never mutates the map.
  const outPath = mapPath();
  writeMapAtomic(raw, outPath);
  const specCount = Object.keys(raw).length;
  const distinct = new Set(Object.values(raw).flat()).size;
  console.log(`build-e2e-map: ${specCount} specs, ${distinct} src files → ${outPath}`);

  // Derive the ubiquitous (zero-discrimination) set purely for the "lazy-load
  // candidates" report next to the map, grouped by area: areas with many
  // universal files are eager-import candidates to move off the boot path.
  // MAP_PRUNE_DF tunes the cutoff (set > 1 to disable); default 1.0 = files in
  // literally every spec. This no longer affects selection.
  const threshold = Number(process.env.MAP_PRUNE_DF ?? 1.0);
  const { pruned } = pruneUbiquitous(raw, threshold);
  const areas = summarizeAreas(pruned);
  const reportPath = outPath.replace(/\.json$/, "") + "-universal.json";
  writeMapAtomic({ count: pruned.length, byArea: Object.fromEntries(areas), files: pruned }, reportPath);
  console.log(`build-e2e-map: ${pruned.length} ubiquitous file(s) (DF >= ${threshold}) flagged for lazy-load audit → ${reportPath}`);
  for (const [area, c] of areas.slice(0, 8)) console.log(`  ${String(c).padStart(4)}  ${area}`);
}

// Run main() only when executed directly (not when imported by tests).
// Match by basename, not full-path equality: $ORG_HOOKS is a symlink (/home →
// /data) on the CI host, and Node realpaths import.meta.url but not argv[1], so
// a `=== fileURLToPath(import.meta.url)` compare is FALSE under the symlink and
// silently skips main(). endsWith on the script name is symlink-robust.
if (process.argv[1] && path.resolve(process.argv[1]).endsWith("build-e2e-map.mjs")) {
  main();
}

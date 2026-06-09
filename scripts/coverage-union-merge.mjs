#!/usr/bin/env node
// Merge a unit lcov and an e2e lcov into a per-line UNION lcov.
//   node coverage-union-merge.mjs --unit <lcov> --e2e <lcov> --out <lcov> \
//     [--e2e-baseline <lcov>] [--src-root src]
// A missing input file is treated as empty coverage (does not throw) so the
// gate degrades to "the other source only" rather than crashing the commit.
//
// --e2e-baseline carries forward the FULL-run e2e lcov (persisted by ci/e2e-map
// on the CI host). The per-commit e2e run only executes the TIA-selected spec
// subset, so a file whose real e2e coverage comes from an unselected spec (e.g.
// mediaService maps to 0 specs) is absent from the per-commit e2e lcov and would
// false-drop. Unioning the full-run baseline restores that attribution.
//
// Tradeoff: the baseline encodes coverage by OLD line numbers (from the last
// green ci/e2e-map). For a file changed since then, its e2e attribution is
// approximate — but it is CONSERVATIVE (biases toward NOT false-dropping, never
// toward hiding a real drop, because unit coverage is always re-measured fresh
// and the periodic full e2e suite + reseed catch genuine e2e regressions). The
// baseline is refreshed on every green ci/e2e-map run.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { parseLcovDA, unionFiles, formatLcov } from "./coverage-union-lib.mjs";

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

function readOrEmpty(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

const unitPath = arg("--unit", "coverage/lcov.info");
const e2ePath = arg("--e2e", "coverage/e2e/lcov.info");
const e2eBaselinePath = arg("--e2e-baseline", "");
const outPath = arg("--out", "coverage/union/lcov.info");
const srcRoot = arg("--src-root", "src");

const unit = parseLcovDA(readOrEmpty(unitPath), srcRoot);
const e2e = parseLcovDA(readOrEmpty(e2ePath), srcRoot);
// Empty when --e2e-baseline is omitted or its file is missing → no-op union,
// keeping behaviour byte-identical to the unit∪e2e-only case.
const e2eBaseline = parseLcovDA(readOrEmpty(e2eBaselinePath), srcRoot);
const merged = unionFiles(unionFiles(unit, e2e), e2eBaseline);

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, formatLcov(merged));
process.stderr.write(
  `union: ${unit.size} unit + ${e2e.size} e2e + ${e2eBaseline.size} e2e-baseline -> ${merged.size} files -> ${outPath}\n`,
);

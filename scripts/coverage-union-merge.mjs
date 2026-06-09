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
// The baseline encodes coverage by OLD line numbers (from the last green
// ci/e2e-map). For a file CHANGED since then, those numbers are stale — so the
// baseline is applied via mergeBaseline (coverage-union-lib), which carries the
// whole baseline only for files ABSENT from the fresh per-commit union and, for
// files PRESENT (run + possibly edited), only flips EXISTING uncovered lines to
// covered. This keeps carry-forward CONSERVATIVE: it can only raise coverage,
// never import stale uncovered lines that would inflate LF and false-drop a
// changed file. The baseline is refreshed on every green ci/e2e-map run.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { parseLcovDA, unionFiles, mergeBaseline, formatLcov } from "./coverage-union-lib.mjs";

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
// Carry the baseline forward onto the fresh union. mergeBaseline (NOT a third
// plain union) prevents a changed file's shifted lines from importing the
// baseline's stale old-numbered uncovered DA entries, which inflated LF and
// false-dropped the file (e.g. mediaService 97%→88% after an edit).
const merged = mergeBaseline(unionFiles(unit, e2e), e2eBaseline);

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, formatLcov(merged));
process.stderr.write(
  `union: ${unit.size} unit + ${e2e.size} e2e + ${e2eBaseline.size} e2e-baseline -> ${merged.size} files -> ${outPath}\n`,
);

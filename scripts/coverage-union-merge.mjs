#!/usr/bin/env node
// Merge a unit lcov and an e2e lcov into a per-line UNION lcov.
//   node coverage-union-merge.mjs --unit <lcov> --e2e <lcov> --out <lcov> [--src-root src]
// A missing input file is treated as empty coverage (does not throw) so the
// gate degrades to "the other source only" rather than crashing the commit.

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
const outPath = arg("--out", "coverage/union/lcov.info");
const srcRoot = arg("--src-root", "src");

const unit = parseLcovDA(readOrEmpty(unitPath), srcRoot);
const e2e = parseLcovDA(readOrEmpty(e2ePath), srcRoot);
const merged = unionFiles(unit, e2e);

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, formatLcov(merged));
process.stderr.write(
  `union: ${unit.size} unit + ${e2e.size} e2e -> ${merged.size} files -> ${outPath}\n`,
);

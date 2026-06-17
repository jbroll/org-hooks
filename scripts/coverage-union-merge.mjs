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

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  parseLcovDA,
  unionFiles,
  mergeBaseline,
  formatLcov,
  parseDiffHunks,
  remapBaseline,
  scrubIncidentalUnit,
} from "./coverage-union-lib.mjs";

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
// Commit the e2e baseline was captured on (persisted by ci/e2e-map). When given,
// the baseline's OLD line numbers are remapped onto the current source through
// `git diff <sha>` BEFORE carry-forward, so a line-shifting edit since then
// (e.g. a barrel→leaf import split) doesn't misalign the baseline and
// false-drop an e2e-dominated file. Omitted/unresolvable → byte-identical to the
// previous (raw line-number) behaviour.
const e2eBaselineSha = arg("--e2e-baseline-sha", "");
const outPath = arg("--out", "coverage/union/lcov.info");
const srcRoot = arg("--src-root", "src");

const unit = parseLcovDA(readOrEmpty(unitPath), srcRoot);
const e2e = parseLcovDA(readOrEmpty(e2ePath), srcRoot);
// Empty when --e2e-baseline is omitted or its file is missing → no-op union,
// keeping behaviour byte-identical to the unit∪e2e-only case.
let e2eBaseline = parseLcovDA(readOrEmpty(e2eBaselinePath), srcRoot);
if (e2eBaselineSha && e2eBaseline.size) {
  try {
    // -U0 vs the working tree (what the unit/e2e lcovs were measured on).
    const diff = execFileSync("git", ["diff", "--no-color", "-U0", e2eBaselineSha, "--"], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
    e2eBaseline = remapBaseline(e2eBaseline, parseDiffHunks(diff, srcRoot));
  } catch (e) {
    // git not reachable / SHA not in history (shallow clone, dropped ref) →
    // degrade to the raw baseline rather than crash the gate.
    process.stderr.write(
      `coverage-union-merge: baseline line-remap skipped (${String(e.message).split("\n")[0]})\n`,
    );
  }
}
// Scrub incidental unit instrumentation: a boot-path file with no unit test
// (App.tsx) gets transitively loaded by `vitest --changed`, so v8 attributes it
// uncovered lines the monocart e2e baseline can never cover — non-deterministic
// denominator noise. Drop unit's zero-coverage entries for e2e-covered files so
// their coverage comes from e2e (+baseline) alone.
const scrubbedUnit = scrubIncidentalUnit(unit, unionFiles(e2e, e2eBaseline));
// Carry the baseline forward onto the fresh union. mergeBaseline (NOT a third
// plain union) prevents a changed file's shifted lines from importing the
// baseline's stale old-numbered uncovered DA entries, which inflated LF and
// false-dropped the file (e.g. mediaService 97%→88% after an edit).
const merged = mergeBaseline(unionFiles(scrubbedUnit, e2e), e2eBaseline);

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, formatLcov(merged));
const scrubbed = unit.size - scrubbedUnit.size;
process.stderr.write(
  `union: ${unit.size} unit${scrubbed ? ` (-${scrubbed} incidental)` : ""} + ${e2e.size} e2e + ${e2eBaseline.size} e2e-baseline -> ${merged.size} files -> ${outPath}\n`,
);

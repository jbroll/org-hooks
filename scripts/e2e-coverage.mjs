#!/usr/bin/env node
// Turn raw Playwright V8 dumps into coverage/e2e/lcov.info, and (when
// E2E_BUILD_IMPACT_MAP is set) the spec->src map build-e2e-map.mjs reads.
//
// Consuming repos write {spec, data} dumps from a Playwright fixture and call
// this; monocart and every filter/rewrite rule live here so the two outputs
// cannot disagree about what a source path is.
//
// Usage:
//   node e2e-coverage.mjs report --worktree <dir> --origin host:port \
//     [--raw coverage/e2e-raw] [--out coverage/e2e] [--impact coverage/e2e-impact] \
//     [--rewrite from=to ...]

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { foldImpact, makeCoverageOptions, makeMapPath, parseRewrites } from "./e2e-coverage-lib.mjs";

function argValues(argv, flag) {
  const out = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === flag) out.push(argv[i + 1]);
  return out.filter(Boolean);
}
const argValue = (argv, flag, fallback) => argValues(argv, flag)[0] ?? fallback;

function fail(message) {
  process.stderr.write(`e2e-coverage: ${message}\n`);
  process.exit(1);
}

async function loadMonocart() {
  try {
    return (await import("monocart-coverage-reports")).CoverageReport;
  } catch (err) {
    fail(
      `monocart-coverage-reports is not installed.\n` +
        `  Run 'npm ci' in ${path.dirname(import.meta.dirname)}.\n` +
        `  (${err.message})`,
    );
  }
}

function readDumps(rawDir) {
  if (!existsSync(rawDir)) {
    fail(
      `no raw coverage at ${rawDir}.\n` +
        `  The Playwright fixture did not run. Check that every spec imports\n` +
        `  'test' from the repo's fixtures module, not from '@playwright/test'.`,
    );
  }
  const names = readdirSync(rawDir).filter((n) => n.endsWith(".json")).sort();
  if (names.length === 0) fail(`${rawDir} is empty — the Playwright fixture wrote nothing.`);
  return names.map((n) => JSON.parse(readFileSync(path.join(rawDir, n), "utf8")));
}

async function report(argv) {
  const worktree = path.resolve(argValue(argv, "--worktree", process.cwd()));
  const rawDir = path.resolve(worktree, argValue(argv, "--raw", "coverage/e2e-raw"));
  const outDir = path.resolve(worktree, argValue(argv, "--out", "coverage/e2e"));
  const impactDir = path.resolve(worktree, argValue(argv, "--impact", "coverage/e2e-impact"));
  const origins = argValues(argv, "--origin");
  const rewrites = parseRewrites(argValues(argv, "--rewrite"));

  if (origins.length === 0) fail("at least one --origin is required (e.g. --origin localhost:5199)");

  const CoverageReport = await loadMonocart();
  const dumps = readDumps(rawDir);

  rmSync(outDir, { recursive: true, force: true });
  const mcr = new CoverageReport(makeCoverageOptions({ outputDir: outDir, origins, rewrites }));
  for (const { data } of dumps) if (data?.length) await mcr.add(data);
  await mcr.generate();

  const lcov = path.join(outDir, "lcov.info");
  if (!existsSync(lcov)) fail(`monocart produced no ${lcov} from ${dumps.length} dumps.`);
  const files = readFileSync(lcov, "utf8").split("\n").filter((l) => l.startsWith("SF:")).length;
  if (files === 0) fail(`${lcov} names no files — check --origin and --rewrite against the dump urls.`);
  process.stdout.write(`e2e-coverage: ${dumps.length} dumps -> ${files} files -> ${lcov}\n`);

  if (process.env.E2E_BUILD_IMPACT_MAP) {
    const records = foldImpact(dumps, makeMapPath(rewrites, worktree));
    rmSync(impactDir, { recursive: true, force: true });
    mkdirSync(impactDir, { recursive: true });
    const jsonl = records.map((r) => JSON.stringify(r)).join("\n");
    writeFileSync(path.join(impactDir, "coverage.jsonl"), jsonl ? `${jsonl}\n` : "");
    process.stdout.write(`e2e-coverage: ${records.length} spec records -> ${impactDir}/coverage.jsonl\n`);
  }
}

const [command, ...rest] = process.argv.slice(2);
if (command !== "report") fail(`unknown command '${command ?? ""}' — expected 'report'`);
await report(rest);

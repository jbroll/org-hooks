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
//     [--rewrite from=to ...] [--require-prefix prefix ...]

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { normalisePath } from "./coverage-ratchet-lib.mjs";
import { foldImpact, makeCoverageOptions, makeMapPath, parseRewrites } from "./e2e-coverage-lib.mjs";

function argValues(argv, flag) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== flag) continue;
    const val = argv[i + 1];
    if (val === undefined) fail(`${flag} requires a value but none was given`);
    if (val.startsWith("--")) fail(`${flag} requires a value, got the flag '${val}' instead`);
    out.push(val);
  }
  return out;
}
const argValue = (argv, flag, fallback) => argValues(argv, flag)[0] ?? fallback;

function fail(message) {
  process.stderr.write(`e2e-coverage: ${message}\n`);
  process.exit(1);
}

// A resolved --out/--impact escaping the worktree (e.g. `--out ..`) would
// hand rmSync a path outside it, deleting whatever is there.
function assertInsideWorktree(dir, worktree, flag) {
  const rel = path.relative(worktree, dir);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    fail(`--${flag} resolves to ${dir}, which is not inside worktree ${worktree}`);
  }
}

async function loadMonocart() {
  try {
    return (await import("monocart-coverage-reports")).CoverageReport;
  } catch (err) {
    if (err.code === "ERR_MODULE_NOT_FOUND") {
      fail(
        `monocart-coverage-reports is not installed.\n` +
          `  Run 'npm ci' in ${path.dirname(import.meta.dirname)}.\n` +
          `  (${err.message})`,
      );
    } else {
      fail(`monocart-coverage-reports failed to load: ${err.message}`);
    }
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
  return names.map((n) => {
    const file = path.join(rawDir, n);
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch (err) {
      fail(`${file} is not valid JSON (${err.message})`);
    }
  });
}

async function report(argv) {
  const worktree = path.resolve(argValue(argv, "--worktree", process.cwd()));
  const rawDir = path.resolve(worktree, argValue(argv, "--raw", "coverage/e2e-raw"));
  const outDir = path.resolve(worktree, argValue(argv, "--out", "coverage/e2e"));
  const impactDir = path.resolve(worktree, argValue(argv, "--impact", "coverage/e2e-impact"));
  assertInsideWorktree(outDir, worktree, "out");
  assertInsideWorktree(impactDir, worktree, "impact");
  const origins = argValues(argv, "--origin");
  let rewrites;
  try {
    rewrites = parseRewrites(argValues(argv, "--rewrite"));
  } catch (err) {
    fail(err.message);
  }

  if (origins.length === 0) fail("at least one --origin is required (e.g. --origin localhost:5199)");

  const CoverageReport = await loadMonocart();
  const dumps = readDumps(rawDir);

  rmSync(outDir, { recursive: true, force: true });
  const mcr = new CoverageReport(makeCoverageOptions({ outputDir: outDir, origins, rewrites }));
  for (const { data } of dumps) if (data?.length) await mcr.add(data);
  await mcr.generate();

  const lcov = path.join(outDir, "lcov.info");
  if (!existsSync(lcov)) fail(`monocart produced no ${lcov} from ${dumps.length} dumps.`);
  const sfLines = readFileSync(lcov, "utf8").split("\n").filter((l) => l.startsWith("SF:"));
  if (sfLines.length === 0) fail(`${lcov} names no files — check --origin and --rewrite against the dump urls.`);
  process.stdout.write(`e2e-coverage: ${dumps.length} dumps -> ${sfLines.length} files -> ${lcov}\n`);

  const requirePrefixes = argValues(argv, "--require-prefix");
  if (requirePrefixes.length > 0) {
    const offending = sfLines
      .map((l) => normalisePath(l.slice(3), "src", worktree))
      .filter((p) => !requirePrefixes.some((prefix) => p.startsWith(prefix)));
    if (offending.length > 0) {
      const shown = offending.slice(0, 5).join(", ");
      const more = offending.length > 5 ? ` (+${offending.length - 5} more)` : "";
      fail(
        `${offending.length} source path(s) in ${lcov} do not start with any of --require-prefix ` +
          `${requirePrefixes.join(", ")}: ${shown}${more} — --rewrite is likely not matching these paths.`,
      );
    }
  }

  if (process.env.E2E_BUILD_IMPACT_MAP) {
    const records = foldImpact(dumps, makeMapPath(rewrites, worktree, origins));
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

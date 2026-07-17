#!/usr/bin/env node
// E2E flake gate CLI. Runs at the end of ci/e2e ON THE GPU. Appends this
// run's per-test outcomes to a host-shared firehose (shared across all worktrees
// because every job runs on the same GPU box), then fails (exit 1) if any test
// that flaked/failed this run is historically unstable. FAIL-OPEN: any internal
// error logs a warning and exits 0 — this runs on every commit and must never
// wedge CI through its own bugs. A genuine Playwright failure is surfaced
// separately by ci/e2e via Playwright's own exit code.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path, { dirname } from "node:path";
import { computeTrips, parseResults } from "./flake-gate-lib.mjs";

const WINDOW = 10;

/** Read a normalized-records JSONL into [{ testId, project, status }]. Skips corrupt lines. */
function readNormalized(recordsPath) {
  if (!recordsPath || !existsSync(recordsPath)) return [];
  const out = [];
  for (const line of readFileSync(recordsPath, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (rec.testId && rec.status) {
        out.push({ testId: rec.testId, project: rec.project ?? "", status: rec.status });
      }
    } catch {
      // skip a partially-written / malformed line
    }
  }
  return out;
}

export function main() {
  const reportPath = process.env.PLAYWRIGHT_JSON ?? "test-results/results.json";
  const firehose =
    process.env.CI_FLAKE_FILE ??
    (process.env.CI_REPO ? `${process.env.HOME}/ci-flake/${process.env.CI_REPO}-flake.jsonl` : null);
  if (!firehose) {
    console.warn("[flake-gate] no CI_FLAKE_FILE/CI_REPO — skipping (fail-open).");
    return 0;
  }

  const format = process.env.FLAKE_FORMAT ?? "playwright";
  const thisRun =
    format === "normalized"
      ? readNormalized(process.env.FLAKE_RECORDS)
      : parseResults(JSON.parse(readFileSync(reportPath, "utf-8")));
  if (thisRun.length === 0) {
    console.log("[flake-gate] no test results to record.");
    return 0;
  }

  // Append this run's outcomes. Each line is a single small atomic O_APPEND
  // write (<4KB), so concurrent jobs interleave safely at line granularity
  // without a lock; lines are self-describing by testId.
  mkdirSync(dirname(firehose), { recursive: true });
  const ts = new Date().toISOString();
  for (const r of thisRun) {
    appendFileSync(
      firehose,
      `${JSON.stringify({ ts, testId: r.testId, project: r.project, status: r.status })}\n`,
    );
  }

  // Read history (now includes this run) and group by testId.
  const historyByTestId = {};
  for (const line of readFileSync(firehose, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // skip any partially-written/corrupt line
    }
    (historyByTestId[rec.testId] ??= []).push(rec);
  }

  const trips = computeTrips(thisRun, historyByTestId);
  if (trips.length === 0) {
    console.log("[flake-gate] OK — no historically-unstable test flaked this run.");
    return 0;
  }

  console.error("[flake-gate] BLOCKED — fix the test or the code:");
  for (const t of trips) {
    console.error(
      `  ${t.testId} — ${(t.rate * 100).toFixed(0)}% non-pass over last ${t.runs} run(s) (threshold 40%, min ${WINDOW}).`,
    );
  }
  return 1;
}

// Run main() only when executed directly (not when imported by tests).
// Match by basename, not full-path equality: $ORG_HOOKS is a symlink (/home →
// /data) on the CI host, and Node realpaths import.meta.url but not argv[1], so
// a `=== fileURLToPath(import.meta.url)` compare is FALSE under the symlink and
// silently skips main(). endsWith on the script name is symlink-robust.
if (process.argv[1] && path.resolve(process.argv[1]).endsWith("flake-gate.mjs")) {
  let code = 0;
  try {
    code = main();
  } catch (err) {
    console.warn(`[flake-gate] internal error, failing open (not blocking): ${err.message}`);
    code = 0;
  }
  process.exit(code);
}

// Pure logic for the e2e flake gate. No I/O — see flake-gate.mjs for the CLI.
// A flaky outcome (passed only on retry) lets a commit through silently; once a
// test is historically unstable, a fresh flake on it is promoted to a hard
// failure. See docs/superpowers/specs/2026-05-30-ci-flake-gate-and-staged-test-selection-design.md

const WINDOW = 10;
const MIN_DENOMINATOR = 6;
const THRESHOLD = 0.4;

const PLAYWRIGHT_STATUS = {
  expected: "passed",
  flaky: "flaky",
  unexpected: "failed",
  // "skipped" intentionally omitted — a skipped test did not run.
};

/** Flatten a Playwright JSON report into [{ testId, project, status }]. */
export function parseResults(report) {
  const out = [];
  const walk = (suite) => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        const status = PLAYWRIGHT_STATUS[test.status];
        if (!status) continue; // skipped / unknown
        out.push({
          testId: `${spec.file} › ${spec.title} › ${test.projectName}`,
          project: test.projectName,
          status,
        });
      }
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of report.suites ?? []) walk(suite);
  return out;
}

const isNonPass = (r) => r.status === "flaky" || r.status === "failed";

/** Non-pass rate over the last WINDOW records. */
export function rateOfWindow(records) {
  const window = records.slice(-WINDOW);
  if (window.length === 0) return 0;
  return window.filter(isNonPass).length / window.length;
}

/** True when a test's recent window is unstable enough to block. */
export function shouldTrip(records, opts = {}) {
  const window = records.slice(-WINDOW);
  const minDenominator = opts.minDenominator ?? MIN_DENOMINATOR;
  const threshold = opts.threshold ?? THRESHOLD;
  if (window.length < minDenominator) return false;
  return rateOfWindow(window) >= threshold;
}

/**
 * Given this run's records and a {testId: history[]} map (history already
 * includes this run's record), return the tests that should block the commit.
 * Only tests that flaked or failed THIS run are consulted.
 */
export function computeTrips(thisRunRecords, historyByTestId, opts = {}) {
  const trips = [];
  for (const rec of thisRunRecords) {
    if (rec.status === "passed") continue;
    const history = historyByTestId[rec.testId] ?? [];
    if (shouldTrip(history, opts)) {
      const window = history.slice(-WINDOW);
      trips.push({ testId: rec.testId, rate: rateOfWindow(window), runs: window.length });
    }
  }
  return trips;
}

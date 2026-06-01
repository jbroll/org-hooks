// Tests for flake-gate-lib.mjs (pure logic).
// Run with:  node --test scripts/flake-gate-lib.test.mjs

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeTrips, parseResults, rateOfWindow, shouldTrip } from "./flake-gate-lib.mjs";

const playwrightReport = {
  suites: [
    {
      title: "a.spec.ts",
      file: "a.spec.ts",
      specs: [
        {
          title: "passes cleanly",
          file: "a.spec.ts",
          tests: [{ projectName: "chromium", status: "expected", results: [{ status: "passed" }] }],
        },
        {
          title: "recovers on retry",
          file: "a.spec.ts",
          tests: [{ projectName: "chromium", status: "flaky", results: [{ status: "failed" }, { status: "passed" }] }],
        },
      ],
      suites: [
        {
          title: "nested",
          file: "a.spec.ts",
          specs: [
            {
              title: "is broken",
              file: "a.spec.ts",
              tests: [{ projectName: "chromium", status: "unexpected", results: [{ status: "failed" }] }],
            },
            {
              title: "is skipped",
              file: "a.spec.ts",
              tests: [{ projectName: "chromium", status: "skipped", results: [] }],
            },
          ],
        },
      ],
    },
  ],
};

describe("parseResults", () => {
  it("maps Playwright statuses, walks nested suites, drops skipped", () => {
    const recs = parseResults(playwrightReport);
    assert.deepEqual(recs, [
      { testId: "a.spec.ts › passes cleanly › chromium", project: "chromium", status: "passed" },
      { testId: "a.spec.ts › recovers on retry › chromium", project: "chromium", status: "flaky" },
      { testId: "a.spec.ts › is broken › chromium", project: "chromium", status: "failed" },
    ]);
  });
});

describe("rateOfWindow", () => {
  it("counts flaky + failed as non-pass over the last 10", () => {
    const recs = Array(8).fill({ status: "passed" }).concat([{ status: "flaky" }, { status: "failed" }]);
    const rate = rateOfWindow(recs);
    assert.ok(Math.abs(rate - 0.2) < 1e-9, `expected ~0.2, got ${rate}`);
  });
  it("uses only the last 10 records", () => {
    const recs = Array(20).fill({ status: "failed" }).concat(Array(10).fill({ status: "passed" }));
    assert.strictEqual(rateOfWindow(recs), 0); // last 10 are all passes
  });
});

describe("shouldTrip", () => {
  it("does not trip below the minimum denominator (6)", () => {
    const recs = Array(5).fill({ status: "failed" }); // 100% but only 5 runs
    assert.strictEqual(shouldTrip(recs), false);
  });
  it("trips at 3/6 (50% >= 40%)", () => {
    const recs = Array(3).fill({ status: "passed" }).concat(Array(3).fill({ status: "flaky" }));
    assert.strictEqual(shouldTrip(recs), true);
  });
  it("does not trip at 2/6 (33% < 40%)", () => {
    const recs = Array(4).fill({ status: "passed" }).concat(Array(2).fill({ status: "flaky" }));
    assert.strictEqual(shouldTrip(recs), false);
  });
  it("trips at exactly 4/10 (40%)", () => {
    const recs = Array(6).fill({ status: "passed" }).concat(Array(4).fill({ status: "failed" }));
    assert.strictEqual(shouldTrip(recs), true);
  });
  it("does not trip at 3/10 (30%)", () => {
    const recs = Array(7).fill({ status: "passed" }).concat(Array(3).fill({ status: "flaky" }));
    assert.strictEqual(shouldTrip(recs), false);
  });
});

describe("computeTrips", () => {
  it("only consults tests that flaked/failed this run, ignores clean passes", () => {
    const thisRun = [
      { testId: "clean", project: "chromium", status: "passed" },
      { testId: "hot", project: "chromium", status: "flaky" },
    ];
    const history = {
      // "clean" is historically terrible but passed this run -> never consulted
      clean: Array(10).fill({ status: "failed" }),
      // "hot" is historically unstable and flaked this run -> trips
      hot: Array(6).fill({ status: "passed" }).concat(Array(4).fill({ status: "flaky" })),
    };
    const trips = computeTrips(thisRun, history);
    assert.deepEqual(trips.map((t) => t.testId), ["hot"]);
  });

  it("does not trip a test that flaked this run but is historically clean", () => {
    const thisRun = [{ testId: "rare", project: "chromium", status: "flaky" }];
    const history = { rare: Array(9).fill({ status: "passed" }).concat([{ status: "flaky" }]) };
    assert.deepEqual(computeTrips(thisRun, history), []);
  });
});

// Tests for e2e-impact-lib.mjs (pure helpers).
// Run with:  node --test scripts/e2e-impact-lib.test.mjs

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { coveredSrcFiles, mergeIntoMap } from "./e2e-impact-lib.mjs";

// Shape mirrors Playwright page.coverage.stopJSCoverage() entries.
const v8 = [
  { url: "http://localhost:5440/src/components/MapView/MapView.tsx", functions: [{ ranges: [{ count: 1 }] }] },
  { url: "http://localhost:5440/src/services/turfMapService.ts", functions: [{ ranges: [{ count: 0 }] }] }, // not executed
  { url: "http://localhost:5440/node_modules/react/index.js", functions: [{ ranges: [{ count: 1 }] }] },     // not /src/
];

describe("coveredSrcFiles", () => {
  it("returns executed /src/ files, normalized, excludes node_modules and unexecuted", () => {
    assert.deepEqual(coveredSrcFiles(v8, 5440), ["src/components/MapView/MapView.tsx"]);
  });
  it("returns [] for empty/garbage input", () => {
    assert.deepEqual(coveredSrcFiles([], 5440), []);
    assert.deepEqual(coveredSrcFiles(null, 5440), []);
  });
});

describe("mergeIntoMap", () => {
  it("sets a spec's covered files, sorted unique", () => {
    const m = {};
    mergeIntoMap(m, "tests/a.spec.ts", ["src/b.ts", "src/a.ts", "src/a.ts"]);
    assert.deepEqual(m, { "tests/a.spec.ts": ["src/a.ts", "src/b.ts"] });
  });
});

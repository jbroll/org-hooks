// Tests for e2e-impact-lib.mjs (pure helpers).
// Run with:  node --test scripts/e2e-impact-lib.test.mjs

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { coveredSrcFiles, mergeIntoMap, pruneUbiquitous } from "./e2e-impact-lib.mjs";

/** Build a map of `n` specs: every spec covers `core`, plus its own `extra[i]`. */
function mkMap(n, core, extra = {}) {
  const m = {};
  for (let i = 0; i < n; i++) m[`tests/s${i}.spec.ts`] = [...core, ...(extra[i] ?? [])];
  return m;
}

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

describe("pruneUbiquitous", () => {
  it("drops files covered by every spec (DF=1.0), keeps discriminating ones", () => {
    // 10 specs all cover src/core.ts; only s0 covers src/feat.ts.
    const map = mkMap(10, ["src/core.ts"], { 0: ["src/feat.ts"] });
    const { map: out, pruned, specCount } = pruneUbiquitous(map);
    assert.equal(specCount, 10);
    assert.deepEqual(pruned, ["src/core.ts"]);
    assert.deepEqual(out["tests/s0.spec.ts"], ["src/feat.ts"]); // discriminating file kept
    assert.deepEqual(out["tests/s1.spec.ts"], []); // core pruned → empty, key preserved
  });

  it("does not prune below threshold (DF just under 1.0 is kept)", () => {
    // src/core.ts covered by 9 of 10 specs (DF=0.9) → kept at threshold 1.0.
    const map = mkMap(10, [], {});
    for (let i = 0; i < 9; i++) map[`tests/s${i}.spec.ts`] = ["src/core.ts"];
    const { pruned } = pruneUbiquitous(map);
    assert.deepEqual(pruned, []);
  });

  it("honors a custom threshold (0.9 prunes the 9/10 file)", () => {
    const map = mkMap(10, [], {});
    for (let i = 0; i < 9; i++) map[`tests/s${i}.spec.ts`] = ["src/core.ts"];
    map["tests/s9.spec.ts"] = ["src/feat.ts"];
    const { pruned } = pruneUbiquitous(map, 0.9);
    assert.deepEqual(pruned, ["src/core.ts"]);
  });

  it("skips pruning when there are fewer than minSpecs (not statistically meaningful)", () => {
    // 3 specs all cover src/core.ts — DF=1.0 but below the default minSpecs.
    const map = mkMap(3, ["src/core.ts"]);
    const { map: out, pruned } = pruneUbiquitous(map);
    assert.deepEqual(pruned, []);
    assert.deepEqual(out, map); // unchanged
  });

  it("empty map → no-op", () => {
    assert.deepEqual(pruneUbiquitous({}), { map: {}, pruned: [], specCount: 0 });
  });
});

// Tests for e2e-impact-lib.mjs (pure helpers).
// Run with:  node --test scripts/e2e-impact-lib.test.mjs

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { coveredSrcFiles, coveredSrcFns, mergeIntoMap, pruneUbiquitous, specFiles, summarizeAreas } from "./e2e-impact-lib.mjs";

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

describe("coveredSrcFns", () => {
  it("groups executed function names by /src/ file, dropping unexecuted and anonymous", () => {
    const entries = [
      { url: "http://localhost:5440/src/services/mapService.ts", functions: [
        { functionName: "createMap", ranges: [{ count: 3 }] },
        { functionName: "deleteMap", ranges: [{ count: 0 }] }, // unexecuted
        { functionName: "", ranges: [{ count: 2 }] },          // anonymous
      ]},
      { url: "http://localhost:5440/node_modules/react/index.js", functions: [
        { functionName: "useState", ranges: [{ count: 1 }] },  // not /src/
      ]},
    ];
    assert.deepEqual(coveredSrcFns(entries, 5440), { "src/services/mapService.ts": ["createMap"] });
  });
  it("includes a file with an empty fn list when only anonymous code executed (file-level parity)", () => {
    // A spec that loads a file but runs only its module-scope (anonymous "")
    // function must still attribute the file — else coarse selection under-picks.
    const entries = [
      { url: "http://localhost:5440/src/boot.ts", functions: [{ functionName: "", ranges: [{ count: 1 }] }] },
      { url: "http://localhost:5440/src/idle.ts", functions: [{ functionName: "foo", ranges: [{ count: 0 }] }] },
    ];
    assert.deepEqual(coveredSrcFns(entries, 5440), { "src/boot.ts": [] });
  });

  it("unions and sorts functions for a file appearing twice; honors port filter; {} on garbage", () => {
    const entries = [
      { url: "http://localhost:5440/src/a.ts", functions: [{ functionName: "b", ranges: [{ count: 1 }] }] },
      { url: "http://localhost:5440/src/a.ts", functions: [{ functionName: "a", ranges: [{ count: 1 }] }] },
      { url: "http://localhost:9999/src/z.ts", functions: [{ functionName: "z", ranges: [{ count: 1 }] }] }, // wrong port
    ];
    assert.deepEqual(coveredSrcFns(entries, 5440), { "src/a.ts": ["a", "b"] });
    assert.deepEqual(coveredSrcFns(null, 5440), {});
  });
});

describe("coveredSrcFns mapPath", () => {
  const fsEntries = [
    {
      url: "http://localhost:5199/@fs/home/john/src/KinoQ/packages/camera-protocol/src/httpBridge.ts",
      functions: [{ functionName: "signRequest", ranges: [{ count: 1 }] }],
    },
    { url: "http://localhost:5199/src/App.tsx", functions: [{ functionName: "App", ranges: [{ count: 1 }] }] },
  ];

  it("without mapPath, keeps today's first-/src/ behaviour", () => {
    assert.deepEqual(coveredSrcFns(fsEntries), {
      "src/KinoQ/packages/camera-protocol/src/httpBridge.ts": ["signRequest"],
      "src/App.tsx": ["App"],
    });
  });

  it("with mapPath, uses the mapper's path", () => {
    const mapPath = (url) => {
      const i = url.indexOf("/packages/");
      if (i !== -1) return url.slice(i + 1);
      const j = url.indexOf("/src/");
      return j === -1 ? null : `packages/web/${url.slice(j + 1)}`;
    };
    assert.deepEqual(coveredSrcFns(fsEntries, undefined, mapPath), {
      "packages/camera-protocol/src/httpBridge.ts": ["signRequest"],
      "packages/web/src/App.tsx": ["App"],
    });
  });

  it("drops entries the mapper rejects", () => {
    assert.deepEqual(coveredSrcFns(fsEntries, undefined, () => null), {});
  });

  it("mapPath still sees entries whose url lacks /src/", () => {
    const entries = [{ url: "http://x/@fs/a/packages/p/lib/z.ts", functions: [{ functionName: "z", ranges: [{ count: 1 }] }] }];
    assert.deepEqual(coveredSrcFns(entries, undefined, (u) => u.slice(u.indexOf("/packages/") + 1)), {
      "packages/p/lib/z.ts": ["z"],
    });
  });
});

describe("specFiles", () => {
  it("returns the array for a legacy file-level entry, keys for an object entry", () => {
    assert.deepEqual(specFiles(["src/a.ts", "src/b.ts"]), ["src/a.ts", "src/b.ts"]);
    assert.deepEqual(specFiles({ "src/a.ts": ["fn"], "src/b.ts": [] }), ["src/a.ts", "src/b.ts"]);
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

describe("summarizeAreas", () => {
  it("counts files by src/<a>/<b> area, descending", () => {
    const areas = summarizeAreas([
      "src/plugins/core/A.ts",
      "src/plugins/core/B.ts",
      "src/views/UserHome/X.tsx",
    ]);
    assert.deepEqual(areas, [
      ["src/plugins/core", 2],
      ["src/views/UserHome", 1],
    ]);
  });
});

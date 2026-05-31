// Tests for e2e-select.mjs (pure selector logic).
// Run with:  node --test scripts/e2e-select.test.mjs
//
// Mirrors the plan's vitest cases, translated to node:test + node:assert
// to match this repo's existing test runner (see coverage-ratchet.test.mjs).

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_E2E_EXCLUDE, selectSpecs } from "./e2e-select.mjs";

const map = {
  "tests/map.spec.ts": ["src/components/MapView/MapView.tsx", "src/jazz/sync.ts"],
  "tests/filter.spec.ts": ["src/components/FilterPanel.tsx", "src/jazz/sync.ts"],
};
const smoke = ["tests/smoke.spec.ts"];

describe("selectSpecs", () => {
  it("selects specs whose map entry covers a changed file", () => {
    const r = selectSpecs({ changed: ["src/components/FilterPanel.tsx"], map, smoke });
    assert.equal(r.runAll, false);
    assert.deepEqual(r.specs.sort(), ["tests/filter.spec.ts", "tests/smoke.spec.ts"]);
  });

  it("high-fanout file is implicitly all specs covering it", () => {
    const r = selectSpecs({ changed: ["src/jazz/sync.ts"], map, smoke });
    assert.deepEqual(r.specs.sort(), [
      "tests/filter.spec.ts",
      "tests/map.spec.ts",
      "tests/smoke.spec.ts",
    ]);
  });

  it("excluded paths contribute nothing", () => {
    const r = selectSpecs({
      changed: ["backend/server.ts", "scripts/x.ts", "src/x.d.ts"],
      map,
      smoke,
    });
    assert.equal(r.runAll, false);
    assert.deepEqual(r.specs, ["tests/smoke.spec.ts"]); // only smoke
  });

  it("unknown unmapped frontend file -> runAll (fail-safe)", () => {
    const r = selectSpecs({ changed: ["src/components/NewThing.tsx"], map, smoke });
    assert.equal(r.runAll, true);
  });

  it("changed spec file is run directly", () => {
    const r = selectSpecs({ changed: ["tests/map.spec.ts"], map, smoke });
    assert.ok(r.specs.includes("tests/map.spec.ts"));
  });

  it("missing map -> runAll (bootstrap)", () => {
    assert.equal(selectSpecs({ changed: ["src/a.tsx"], map: null, smoke }).runAll, true);
  });

  it("exports a non-empty default exclude list", () => {
    assert.ok(Array.isArray(DEFAULT_E2E_EXCLUDE));
    assert.ok(DEFAULT_E2E_EXCLUDE.length > 0);
  });
});

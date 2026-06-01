// Unit tests for the PURE helpers in e2e-select-cli.mjs. The Playwright-listing
// path (listSmokeSpecs) is intentionally NOT tested here — it shells out.
// Run with:  node --test scripts/e2e-select-cli.test.mjs

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  loadMap,
  mapPathFromEnv,
  manifestPath,
  normalizeSpecPath,
  parseManifest,
  parseSmokeListJson,
} from "./e2e-select-cli.mjs";

describe("parseManifest", () => {
  it("splits lines, trims, drops blanks", () => {
    assert.deepEqual(parseManifest("src/a.ts\n  src/b.ts  \n\n\ntests/c.spec.ts\n"), [
      "src/a.ts",
      "src/b.ts",
      "tests/c.spec.ts",
    ]);
  });
  it("returns [] for empty or non-string input", () => {
    assert.deepEqual(parseManifest(""), []);
    assert.deepEqual(parseManifest("   \n  \n"), []);
    assert.deepEqual(parseManifest(null), []);
  });
});

describe("loadMap", () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "e2e-sel-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("returns the parsed object for valid JSON object", () => {
    const p = path.join(dir, "map.json");
    writeFileSync(p, JSON.stringify({ "tests/a.spec.ts": ["src/a.ts"] }));
    assert.deepEqual(loadMap(p), { "tests/a.spec.ts": ["src/a.ts"] });
  });
  it("returns null when the file is missing", () => {
    assert.strictEqual(loadMap(path.join(dir, "nope.json")), null);
  });
  it("returns null for invalid JSON", () => {
    const p = path.join(dir, "bad.json");
    writeFileSync(p, "{ not json");
    assert.strictEqual(loadMap(p), null);
  });
  it("returns null when JSON is an array (not a map object)", () => {
    const p = path.join(dir, "arr.json");
    writeFileSync(p, "[1,2,3]");
    assert.strictEqual(loadMap(p), null);
  });
});

describe("path resolvers", () => {
  it("manifestPath defaults to ci/.changed-files", () => {
    assert.strictEqual(manifestPath(["node", "cli"]), path.join("ci", ".changed-files"));
    assert.strictEqual(manifestPath(["node", "cli", "custom"]), "custom");
  });
  it("mapPathFromEnv honors CI_FLAKE_MAP", () => {
    assert.strictEqual(mapPathFromEnv({ CI_FLAKE_MAP: "/x/y.json" }), "/x/y.json");
  });
  it("mapPathFromEnv derives from CI_REPO when CI_FLAKE_MAP is absent", () => {
    const result = mapPathFromEnv({ CI_REPO: "myrepo" });
    assert.strictEqual(result, path.join(homedir(), "ci-flake", "myrepo-e2e-impact.json"));
  });
  it("mapPathFromEnv throws when neither CI_FLAKE_MAP nor CI_REPO is set", () => {
    assert.throws(() => mapPathFromEnv({}), /CI_FLAKE_MAP or CI_REPO/);
  });
});

describe("parseSmokeListJson", () => {
  it("extracts unique spec files from nested suites", () => {
    const json = JSON.stringify({
      suites: [
        {
          file: "tests/a.spec.ts",
          specs: [{ file: "tests/a.spec.ts" }],
          suites: [{ file: "tests/b.spec.ts", specs: [{ file: "tests/b.spec.ts" }] }],
        },
        { specs: [{ file: "tests/a.spec.ts" }] },
      ],
    });
    assert.deepEqual(parseSmokeListJson(json), ["tests/a.spec.ts", "tests/b.spec.ts"]);
  });
  it("falls back to the suite file when a spec lacks its own file", () => {
    const json = JSON.stringify({ suites: [{ file: "tests/c.spec.ts", specs: [{}] }] });
    assert.deepEqual(parseSmokeListJson(json), ["tests/c.spec.ts"]);
  });
  it("returns [] for invalid JSON or empty shapes", () => {
    assert.deepEqual(parseSmokeListJson("not json"), []);
    assert.deepEqual(parseSmokeListJson("{}"), []);
    assert.deepEqual(parseSmokeListJson(JSON.stringify({ suites: [] })), []);
  });
});

describe("normalizeSpecPath", () => {
  it("passes through a repo-relative posix path", () => {
    assert.strictEqual(normalizeSpecPath("tests/a.spec.ts"), "tests/a.spec.ts");
  });
});

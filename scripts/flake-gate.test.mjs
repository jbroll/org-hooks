// CLI tests for flake-gate.mjs.
// Run with:  node --test scripts/flake-gate.test.mjs
//
// flake-gate.mjs guards its top-level process.exit() with an import.meta.url
// check, so importing it is side-effect-free and we can call main() directly.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { main } from "./flake-gate.mjs";

/** A minimal Playwright JSON report containing a single passing test. */
function minimalReport() {
  return {
    suites: [
      {
        specs: [
          {
            file: "tests/a.spec.ts",
            title: "does a thing",
            tests: [{ status: "expected", projectName: "chromium" }],
          },
        ],
      },
    ],
  };
}

describe("flake-gate main()", () => {
  const orig = {
    CI_FLAKE_FILE: process.env.CI_FLAKE_FILE,
    CI_REPO: process.env.CI_REPO,
    PLAYWRIGHT_JSON: process.env.PLAYWRIGHT_JSON,
    HOME: process.env.HOME,
  };
  const tmps = [];

  function newTmp(prefix) {
    const d = mkdtempSync(path.join(tmpdir(), prefix));
    tmps.push(d);
    return d;
  }

  afterEach(() => {
    for (const [k, v] of Object.entries(orig)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("appends this run's outcomes to CI_FLAKE_FILE and returns 0", () => {
    const tmp = newTmp("flake-");
    const firehose = path.join(tmp, "flake.jsonl");
    const reportPath = path.join(tmp, "results.json");
    writeFileSync(reportPath, JSON.stringify(minimalReport()));

    process.env.CI_FLAKE_FILE = firehose;
    process.env.PLAYWRIGHT_JSON = reportPath;
    delete process.env.CI_REPO;

    const code = main();
    assert.strictEqual(code, 0);

    const lines = readFileSync(firehose, "utf-8").trim().split("\n");
    assert.strictEqual(lines.length, 1);
    const rec = JSON.parse(lines[0]);
    assert.strictEqual(rec.testId, "tests/a.spec.ts › does a thing › chromium");
    assert.strictEqual(rec.project, "chromium");
    assert.strictEqual(rec.status, "passed");
  });

  it("with neither CI_FLAKE_FILE nor CI_REPO, returns 0 and writes nothing (fail-open)", () => {
    const tmp = newTmp("flake-");
    const reportPath = path.join(tmp, "results.json");
    writeFileSync(reportPath, JSON.stringify(minimalReport()));

    delete process.env.CI_FLAKE_FILE;
    delete process.env.CI_REPO;
    process.env.PLAYWRIGHT_JSON = reportPath;

    const code = main();
    assert.strictEqual(code, 0);
    // Fail-open: no firehose path is derived, so nothing is written.
    assert.ok(!existsSync(path.join(tmp, "flake.jsonl")));
  });

  it("with CI_FLAKE_FILE unset but CI_REPO=foo, firehose lands at ~/ci-flake/foo-flake.jsonl", () => {
    const tmpHome = newTmp("home-");
    const tmp = newTmp("flake-");
    const reportPath = path.join(tmp, "results.json");
    writeFileSync(reportPath, JSON.stringify(minimalReport()));

    delete process.env.CI_FLAKE_FILE;
    process.env.CI_REPO = "foo";
    process.env.HOME = tmpHome;
    process.env.PLAYWRIGHT_JSON = reportPath;

    const code = main();
    assert.strictEqual(code, 0);

    const expected = path.join(tmpHome, "ci-flake", "foo-flake.jsonl");
    assert.ok(existsSync(expected), `expected firehose at ${expected}`);
  });
});

describe("flake-gate normalized format", () => {
  const orig = { ...process.env };
  const tmps = [];
  afterEach(() => {
    for (const k of ["CI_FLAKE_FILE", "CI_REPO", "FLAKE_FORMAT", "FLAKE_RECORDS"]) {
      if (orig[k] === undefined) delete process.env[k];
      else process.env[k] = orig[k];
    }
    for (const p of tmps.splice(0)) rmSync(p, { recursive: true, force: true });
  });

  it("appends normalized records to the firehose and exits 0 on a clean run", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "flake-norm-"));
    tmps.push(dir);
    const records = path.join(dir, "records.jsonl");
    const firehose = path.join(dir, "unit-flake.jsonl");
    writeFileSync(
      records,
      JSON.stringify({ testId: "src/a.test.ts › does x › unit-frontend", project: "unit-frontend", status: "passed" }) + "\n",
    );
    process.env.FLAKE_FORMAT = "normalized";
    process.env.FLAKE_RECORDS = records;
    process.env.CI_FLAKE_FILE = firehose;
    delete process.env.CI_REPO;

    const code = main();

    assert.equal(code, 0);
    const lines = readFileSync(firehose, "utf-8").trim().split("\n");
    assert.equal(lines.length, 1);
    assert.match(lines[0], /"testId":"src\/a\.test\.ts › does x › unit-frontend"/);
    assert.match(lines[0], /"status":"passed"/);
  });

  it("skips corrupt record lines (fail-open)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "flake-norm-"));
    tmps.push(dir);
    const records = path.join(dir, "records.jsonl");
    const firehose = path.join(dir, "unit-flake.jsonl");
    writeFileSync(records, "{not json}\n" + JSON.stringify({ testId: "t", project: "p", status: "passed" }) + "\n");
    process.env.FLAKE_FORMAT = "normalized";
    process.env.FLAKE_RECORDS = records;
    process.env.CI_FLAKE_FILE = firehose;
    const code = main();
    assert.equal(code, 0);
    assert.equal(readFileSync(firehose, "utf-8").trim().split("\n").length, 1);
  });
});

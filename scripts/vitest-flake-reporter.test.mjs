// Run with: node --test scripts/vitest-flake-reporter.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import FlakeReporter, { classify } from "./vitest-flake-reporter.mjs";

/** Fake a Vitest 4 TestModule with the accessors the reporter uses. */
function makeModule(relId, tests) {
  const cases = tests.map((t) => ({
    fullName: t.fullName,
    module: { relativeModuleId: relId },
    result: () => ({ state: t.state }),
    diagnostic: () => (t.retryCount === undefined ? undefined : { retryCount: t.retryCount }),
  }));
  return {
    children: {
      *allTests() {
        yield* cases;
      },
    },
  };
}

describe("classify()", () => {
  it("maps state + retryCount to a normalized status", () => {
    assert.equal(classify("failed", 0), "failed");
    assert.equal(classify("passed", 0), "passed");
    assert.equal(classify("passed", 2), "flaky");
    assert.equal(classify("skipped", 0), null);
    assert.equal(classify("passed", undefined), "passed");
  });
});

describe("vitest-flake-reporter onTestRunEnd", () => {
  const orig = { ...process.env };
  const tmps = [];
  afterEach(() => {
    for (const k of ["VITEST_FLAKE_OUT", "VITEST_PROJECT"]) {
      if (orig[k] === undefined) delete process.env[k];
      else process.env[k] = orig[k];
    }
    for (const p of tmps.splice(0)) rmSync(p, { recursive: true, force: true });
  });

  it("classifies passed / failed / flaky and stamps file + project into testId", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "vflake-"));
    tmps.push(dir);
    const out = path.join(dir, "records.jsonl");
    process.env.VITEST_FLAKE_OUT = out;
    process.env.VITEST_PROJECT = "unit-frontend";

    const mod = makeModule("src/a.test.ts", [
      { fullName: "G > clean", state: "passed", retryCount: 0 },
      { fullName: "G > recovered", state: "passed", retryCount: 1 },
      { fullName: "G > broken", state: "failed", retryCount: 2 },
      { fullName: "G > skipped", state: "skipped" },
    ]);
    new FlakeReporter().onTestRunEnd([mod]);

    const recs = readFileSync(out, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    const byId = Object.fromEntries(recs.map((r) => [r.testId, r.status]));
    assert.equal(byId["src/a.test.ts › G > clean › unit-frontend"], "passed");
    assert.equal(byId["src/a.test.ts › G > recovered › unit-frontend"], "flaky");
    assert.equal(byId["src/a.test.ts › G > broken › unit-frontend"], "failed");
    assert.equal(recs.length, 3); // skipped omitted
    for (const r of recs) assert.equal(r.project, "unit-frontend");
  });

  it("is a no-op when VITEST_FLAKE_OUT is unset", () => {
    delete process.env.VITEST_FLAKE_OUT;
    new FlakeReporter().onTestRunEnd([makeModule("src/a.test.ts", [{ fullName: "x", state: "passed" }])]);
  });
});

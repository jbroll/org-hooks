// Run with: node --test scripts/vitest-flake-reporter.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import FlakeReporter from "./vitest-flake-reporter.mjs";

/** Build a linked file→suite→test task tree the way @vitest/runner expects. */
function makeFile(relPath, tests) {
  const file = { type: "suite", name: relPath, filepath: `/abs/${relPath}`, tasks: [] };
  file.file = file;
  for (const t of tests) {
    const suite = { type: "suite", name: t.group, file, tasks: [] };
    suite.suite = file;
    const test = {
      type: "test",
      name: t.title,
      suite,
      file,
      result: { state: t.state, retryCount: t.retryCount ?? 0 },
    };
    suite.tasks.push(test);
    file.tasks.push(suite);
  }
  return file;
}

describe("vitest-flake-reporter", () => {
  const orig = { ...process.env };
  const tmps = [];
  afterEach(() => {
    for (const k of ["VITEST_FLAKE_OUT", "VITEST_PROJECT"]) {
      if (orig[k] === undefined) delete process.env[k];
      else process.env[k] = orig[k];
    }
    for (const p of tmps.splice(0)) rmSync(p, { recursive: true, force: true });
  });

  it("classifies passed / failed / flaky and stamps the project into testId", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "vflake-"));
    tmps.push(dir);
    const out = path.join(dir, "records.jsonl");
    process.env.VITEST_FLAKE_OUT = out;
    process.env.VITEST_PROJECT = "unit-frontend";

    const file = makeFile("src/a.test.ts", [
      { group: "G", title: "clean", state: "pass", retryCount: 0 },
      { group: "G", title: "recovered", state: "pass", retryCount: 1 },
      { group: "G", title: "broken", state: "fail", retryCount: 2 },
    ]);
    new FlakeReporter().onFinished([file]);

    const recs = readFileSync(out, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    const byTitle = Object.fromEntries(recs.map((r) => [r.testId, r.status]));
    assert.equal(byTitle["src/a.test.ts › G › clean › unit-frontend"], "passed");
    assert.equal(byTitle["src/a.test.ts › G › recovered › unit-frontend"], "flaky");
    assert.equal(byTitle["src/a.test.ts › G › broken › unit-frontend"], "failed");
    for (const r of recs) assert.equal(r.project, "unit-frontend");
  });

  it("is a no-op when VITEST_FLAKE_OUT is unset", () => {
    delete process.env.VITEST_FLAKE_OUT;
    // Must not throw.
    new FlakeReporter().onFinished([makeFile("src/a.test.ts", [{ group: "G", title: "x", state: "pass" }])]);
  });
});

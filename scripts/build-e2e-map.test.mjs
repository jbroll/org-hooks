// Tests for build-e2e-map.mjs (aggregate logic + IMPACT_DIR placement regression).
// Run with:  node --test scripts/build-e2e-map.test.mjs

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

// IMPACT_DIR is computed at import time from process.env.WORKTREE.
// Set WORKTREE to a tmpdir before importing so the regression test is meaningful.
const fakeWorktree = mkdtempSync(path.join(tmpdir(), "worktree-"));
process.env.WORKTREE = fakeWorktree;

// Dynamic import after setting env so IMPACT_DIR picks up our WORKTREE.
const { aggregate, IMPACT_DIR } = await import("./build-e2e-map.mjs");

let dir;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "e2e-impact-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeJsonl(name, lines) {
  writeFileSync(path.join(dir, name), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
}

describe("aggregate", () => {
  it("folds JSONL lines from multiple worker files into one sorted-unique map", () => {
    writeJsonl("0.jsonl", [
      { spec: "tests/a.spec.ts", files: ["src/b.ts", "src/a.ts"] },
      { spec: "tests/c.spec.ts", files: ["src/c.ts"] },
    ]);
    writeJsonl("1.jsonl", [
      // same spec from another worker → union of files
      { spec: "tests/a.spec.ts", files: ["src/a.ts", "src/d.ts"] },
    ]);

    assert.deepEqual(aggregate(dir), {
      "tests/a.spec.ts": ["src/a.ts", "src/b.ts", "src/d.ts"],
      "tests/c.spec.ts": ["src/c.ts"],
    });
  });

  it("merges multiple lines for the same spec within one file", () => {
    writeJsonl("0.jsonl", [
      { spec: "tests/a.spec.ts", files: ["src/a.ts"] },
      { spec: "tests/a.spec.ts", files: ["src/b.ts", "src/a.ts"] },
    ]);

    assert.deepEqual(aggregate(dir), { "tests/a.spec.ts": ["src/a.ts", "src/b.ts"] });
  });

  it("skips malformed lines and blank lines, keeps valid ones", () => {
    writeFileSync(
      path.join(dir, "0.jsonl"),
      [
        JSON.stringify({ spec: "tests/a.spec.ts", files: ["src/a.ts"] }),
        "{ not valid json",
        "",
        JSON.stringify({ spec: "tests/b.spec.ts", files: ["src/b.ts"] }),
        JSON.stringify({ nope: true }), // no spec
        JSON.stringify({ spec: "tests/c.spec.ts" }), // no files array
      ].join("\n"),
    );

    assert.deepEqual(aggregate(dir), {
      "tests/a.spec.ts": ["src/a.ts"],
      "tests/b.spec.ts": ["src/b.ts"],
    });
  });

  it("ignores non-.jsonl files in the directory", () => {
    writeJsonl("0.jsonl", [{ spec: "tests/a.spec.ts", files: ["src/a.ts"] }]);
    writeFileSync(path.join(dir, "README.txt"), "not jsonl\n");

    assert.deepEqual(aggregate(dir), { "tests/a.spec.ts": ["src/a.ts"] });
  });

  it("returns {} for a missing or empty directory", () => {
    assert.deepEqual(aggregate(path.join(dir, "does-not-exist")), {});
    assert.deepEqual(aggregate(dir), {});
  });
});

describe("IMPACT_DIR placement", () => {
  // Regression: the per-test JSONL must NOT live inside monocart's e2e coverage
  // outputDir (./coverage/e2e). monocart's generate() runs with clean:true and
  // empties that dir before writing reports, so an impact subdir under it gets
  // deleted by global-teardown BEFORE this builder reads it → empty {} map.
  // Keep IMPACT_DIR a sibling of coverage/e2e, not a child.
  it("is outside monocart's coverage/e2e outputDir", () => {
    const monocartOutputDir = path.join(fakeWorktree, "coverage", "e2e");
    const rel = path.relative(monocartOutputDir, IMPACT_DIR);
    assert.ok(rel.startsWith(".."), `expected IMPACT_DIR to be outside coverage/e2e, got rel="${rel}"`);
  });
});

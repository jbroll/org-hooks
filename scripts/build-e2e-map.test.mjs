// Tests for build-e2e-map.mjs (aggregate logic + IMPACT_DIR placement regression).
// Run with:  node --test scripts/build-e2e-map.test.mjs

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

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

describe("main() writes the full (un-pruned) selection map", () => {
  // Regression: ubiquitous (DF=1.0) files must stay in the written map so the
  // selector maps a changed boot-path file to all its covering specs. Pruning
  // them collapsed selection to zero (→ @smoke floor → false union-coverage
  // drops). Pruning now only feeds the informational -universal.json report.
  const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "build-e2e-map.mjs");

  it("keeps ubiquitous files in the map but still flags them in the universal report", () => {
    const wt = mkdtempSync(path.join(tmpdir(), "wt-full-"));
    const impactDir = path.join(wt, "coverage", "e2e-impact");
    mkdirSync(impactDir, { recursive: true });
    // 8 specs (>= minSpecs) all cover src/core.ts (ubiquitous); s0 also covers src/feat.ts.
    const lines = [];
    for (let i = 0; i < 8; i++) {
      const files = i === 0 ? ["src/core.ts", "src/feat.ts"] : ["src/core.ts"];
      lines.push(JSON.stringify({ spec: `tests/s${i}.spec.ts`, files }));
    }
    writeFileSync(path.join(impactDir, "0.jsonl"), `${lines.join("\n")}\n`);

    const mapOut = path.join(wt, "map.json");
    execFileSync(process.execPath, [scriptPath], {
      env: { ...process.env, WORKTREE: wt, CI_FLAKE_MAP: mapOut },
      stdio: "ignore",
    });

    const map = JSON.parse(readFileSync(mapOut, "utf8"));
    // Ubiquitous file survives in EVERY spec — not pruned to zero.
    assert.deepEqual(map["tests/s1.spec.ts"], ["src/core.ts"]);
    assert.deepEqual(map["tests/s0.spec.ts"], ["src/core.ts", "src/feat.ts"]);

    // ...but it IS reported for the lazy-load audit.
    const report = JSON.parse(readFileSync(`${mapOut.replace(/\.json$/, "")}-universal.json`, "utf8"));
    assert.deepEqual(report.files, ["src/core.ts"]);
    assert.equal(report.count, 1);

    rmSync(wt, { recursive: true, force: true });
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

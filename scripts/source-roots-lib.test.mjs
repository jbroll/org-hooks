import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DEFAULT_ROOTS, resolveRoots } from "./source-roots-lib.mjs";

// The scanners resolve roots relative to CWD (lefthook runs them at the
// repo root), so each case builds a throwaway repo and chdirs into it.
function inRepo(dirs, fn) {
  const repo = mkdtempSync(join(tmpdir(), "source-roots-"));
  const cwd = process.cwd();
  try {
    for (const d of dirs) mkdirSync(join(repo, d), { recursive: true });
    process.chdir(repo);
    fn();
  } finally {
    process.chdir(cwd);
    rmSync(repo, { recursive: true, force: true });
  }
}

test("flat repo: src resolves, packages glob contributes nothing", () => {
  inRepo(["src"], () => {
    assert.deepEqual(resolveRoots([]), ["src"]);
  });
});

test("monorepo: packages/*/src expands to one root per workspace", () => {
  inRepo(["packages/web/src", "packages/api/src"], () => {
    assert.deepEqual(resolveRoots(["packages/*/src"]).sort(), [
      "packages/api/src",
      "packages/web/src",
    ]);
  });
});

// The regression this lib exists to prevent: before it, a repo with no
// top-level src/ walked nothing and the gate passed silently.
test("workspace-only repo: default roots still find the sources", () => {
  inRepo(["packages/web/src", "packages/e2e/src"], () => {
    const roots = resolveRoots([]);
    assert.deepEqual(roots.sort(), ["packages/e2e/src", "packages/web/src"]);
    assert.notEqual(roots.length, 0);
  });
});

test("non-existent roots are dropped, not passed through", () => {
  inRepo(["src"], () => {
    assert.deepEqual(resolveRoots(["src", "backend/src"]), ["src"]);
  });
});

test("a workspace without the expected subdir is skipped", () => {
  inRepo(["packages/web/src", "packages/docs"], () => {
    assert.deepEqual(resolveRoots(["packages/*/src"]), ["packages/web/src"]);
  });
});

test("node_modules and dotted dirs never become roots", () => {
  inRepo(["packages/web/src", "packages/node_modules/src", "packages/.cache/src"], () => {
    assert.deepEqual(resolveRoots(["packages/*/src"]), ["packages/web/src"]);
  });
});

test("explicit args override the defaults entirely", () => {
  inRepo(["src", "packages/web/src"], () => {
    assert.deepEqual(resolveRoots(["src"]), ["src"]);
  });
});

test("duplicate patterns yield one root each", () => {
  inRepo(["src"], () => {
    assert.deepEqual(resolveRoots(["src", "src"]), ["src"]);
  });
});

test("DEFAULT_ROOTS covers the flat, workspace and backend conventions", () => {
  assert.deepEqual(DEFAULT_ROOTS, ["src", "packages/*/src", "backend/src"]);
});

test("TS_SCAN_ROOTS replaces the defaults when no argv is given", () => {
  const prev = process.env.TS_SCAN_ROOTS;
  inRepo(["src", "apps/web/src"], () => {
    process.env.TS_SCAN_ROOTS = "apps/*/src";
    try {
      assert.deepEqual(resolveRoots([]), ["apps/web/src"]);
    } finally {
      if (prev === undefined) delete process.env.TS_SCAN_ROOTS;
      else process.env.TS_SCAN_ROOTS = prev;
    }
  });
});

test("explicit argv still beats TS_SCAN_ROOTS", () => {
  const prev = process.env.TS_SCAN_ROOTS;
  inRepo(["src", "apps/web/src"], () => {
    process.env.TS_SCAN_ROOTS = "apps/*/src";
    try {
      assert.deepEqual(resolveRoots(["src"]), ["src"]);
    } finally {
      if (prev === undefined) delete process.env.TS_SCAN_ROOTS;
      else process.env.TS_SCAN_ROOTS = prev;
    }
  });
});

test("backend/src resolves from the defaults when nothing else exists", () => {
  inRepo(["backend/src"], () => {
    assert.deepEqual(resolveRoots([]), ["backend/src"]);
  });
});

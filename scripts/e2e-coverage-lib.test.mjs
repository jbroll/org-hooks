// Tests for e2e-coverage-lib.mjs (pure helpers).
// Run with:  node --test scripts/e2e-coverage-lib.test.mjs

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyRewrites,
  foldImpact,
  makeCoverageOptions,
  makeMapPath,
  parseRewrites,
  rewriteSourcePath,
} from "./e2e-coverage-lib.mjs";

describe("parseRewrites", () => {
  it("splits on the first '=' so the target may contain one", () => {
    assert.deepEqual(parseRewrites(["src/=packages/web/src/"]), [{ from: "src/", to: "packages/web/src/" }]);
  });
  it("returns [] for no specs", () => {
    assert.deepEqual(parseRewrites([]), []);
  });
  it("throws on a spec with no '='", () => {
    assert.throws(() => parseRewrites(["src/"]), /--rewrite/);
  });
  it("throws on a spec with an empty 'from'", () => {
    assert.throws(() => parseRewrites(["=foo"]), /--rewrite/);
  });
});

describe("applyRewrites", () => {
  const rw = parseRewrites(["src/=packages/web/src/"]);
  it("rewrites at the start of the string", () => {
    assert.equal(applyRewrites("src/App.tsx", rw), "packages/web/src/App.tsx");
  });
  it("rewrites after a '/'", () => {
    assert.equal(applyRewrites("localhost-5199/src/App.tsx", rw), "localhost-5199/packages/web/src/App.tsx");
  });
  it("does not match mid-segment", () => {
    assert.equal(applyRewrites("mysrc/App.tsx", rw), "mysrc/App.tsx");
  });
  it("leaves a non-matching path alone", () => {
    assert.equal(applyRewrites("packages/camera-protocol/lib/x.ts", rw), "packages/camera-protocol/lib/x.ts");
  });
  it("applies only the first matching rule", () => {
    const two = parseRewrites(["src/=a/", "src/=b/"]);
    assert.equal(applyRewrites("src/x.ts", two), "a/x.ts");
  });
  it("fires on a path that already names a package — which is why callers use rewriteSourcePath", () => {
    assert.equal(applyRewrites("packages/camera-protocol/src/x.ts", rw), "packages/camera-protocol/packages/web/src/x.ts");
  });
});

describe("rewriteSourcePath", () => {
  const rw = parseRewrites(["src/=packages/web/src/"]);
  it("maps a bare src/ path into its package", () => {
    assert.equal(rewriteSourcePath("src/App.tsx", rw), "packages/web/src/App.tsx");
  });
  it("leaves a path that already names a package untouched", () => {
    assert.equal(rewriteSourcePath("packages/camera-protocol/src/x.ts", rw), "packages/camera-protocol/src/x.ts");
  });
  it("leaves an origin-prefixed package path untouched", () => {
    assert.equal(rewriteSourcePath("localhost-5199/packages/camera-protocol/src/x.ts", rw), "localhost-5199/packages/camera-protocol/src/x.ts");
  });
  it("still maps an origin-prefixed bare src/ path", () => {
    assert.equal(rewriteSourcePath("localhost-5199/src/App.tsx", rw), "localhost-5199/packages/web/src/App.tsx");
  });
});

describe("makeMapPath", () => {
  const mapPath = makeMapPath(parseRewrites(["src/=packages/web/src/"]), "/home/john/src/KinoQ");

  it("anchors a /@fs/ url on /packages/ and skips the rewrite", () => {
    assert.equal(
      mapPath("http://localhost:5199/@fs/home/john/src/KinoQ/packages/camera-protocol/src/httpBridge.ts"),
      "packages/camera-protocol/src/httpBridge.ts",
    );
  });
  it("rewrites a bare /src/ url into its package", () => {
    assert.equal(mapPath("http://localhost:5199/src/App.tsx"), "packages/web/src/App.tsx");
  });
  it("strips a query string", () => {
    assert.equal(mapPath("http://localhost:5199/src/App.tsx?t=123"), "packages/web/src/App.tsx");
  });
  it("returns null for a url with no source path", () => {
    assert.equal(mapPath("http://localhost:5199/node_modules/.vite/deps/react.js"), null);
  });
});

describe("makeCoverageOptions", () => {
  const opts = makeCoverageOptions({
    outputDir: "coverage/e2e",
    origins: ["localhost:5199"],
    rewrites: parseRewrites(["src/=packages/web/src/"]),
  });

  it("never cleans the cache", () => {
    assert.equal(opts.cleanCache, false);
  });
  it("emits lcovonly", () => {
    assert.ok(opts.reports.includes("lcovonly"));
  });
  it("keeps an entry from a listed origin under /src/", () => {
    assert.equal(opts.entryFilter({ url: "http://localhost:5199/src/App.tsx" }), true);
  });
  it("drops an entry from another origin", () => {
    assert.equal(opts.entryFilter({ url: "http://localhost:4310/src/x.ts" }), false);
  });
  it("drops a prebundled dep", () => {
    assert.equal(opts.entryFilter({ url: "http://localhost:5199/node_modules/.vite/deps/react.js" }), false);
  });
  it("drops a /@fs/ dep whose absolute path only looks like source because the checkout sits under ~/src/", () => {
    assert.equal(
      opts.entryFilter({ url: "http://localhost:5199/@fs/home/john/src/KinoQ/node_modules/vite/dist/client/env.mjs" }),
      false,
    );
  });
  it("keeps a /@fs/ workspace package source", () => {
    assert.equal(
      opts.entryFilter({ url: "http://localhost:5199/@fs/home/john/src/KinoQ/packages/camera-protocol/src/auth.ts" }),
      true,
    );
  });
  it("resolves a bare sourcemap filename against the script url, then rewrites", () => {
    assert.equal(opts.sourcePath("App.tsx", { distFile: "localhost-5199/src/App.tsx" }), "localhost-5199/packages/web/src/App.tsx");
  });
  it("rewrites an already-pathed source", () => {
    assert.equal(opts.sourcePath("src/App.tsx", {}), "packages/web/src/App.tsx");
  });
  it("keeps only /src/ sources", () => {
    assert.equal(opts.sourceFilter("packages/web/src/App.tsx"), true);
    assert.equal(opts.sourceFilter("node_modules/react/index.js"), false);
    assert.equal(opts.sourceFilter("localhost-5199/@fs/home/john/src/KinoQ/node_modules/vite/dist/client/env.mjs"), false);
  });
});

describe("foldImpact", () => {
  const mapPath = makeMapPath(parseRewrites(["src/=packages/web/src/"]), "/repo");
  const dumps = [
    {
      spec: "packages/e2e/export.spec.ts",
      data: [{ url: "http://localhost:5199/src/App.tsx", functions: [{ functionName: "App", ranges: [{ count: 1 }] }] }],
    },
    {
      spec: "packages/e2e/export.spec.ts",
      data: [{ url: "http://localhost:5199/src/app/edl.ts", functions: [{ functionName: "buildEdl", ranges: [{ count: 1 }] }] }],
    },
  ];

  it("keys files the way ci/.changed-files does", () => {
    const folded = foldImpact(dumps, mapPath);
    assert.deepEqual(folded[0].files, { "packages/web/src/App.tsx": ["App"] });
  });
  it("emits one record per dump, tagged with its spec", () => {
    const folded = foldImpact(dumps, mapPath);
    assert.equal(folded.length, 2);
    assert.equal(folded[1].spec, "packages/e2e/export.spec.ts");
  });
  it("drops a dump that covers nothing", () => {
    assert.deepEqual(foldImpact([{ spec: "a.spec.ts", data: [] }], mapPath), []);
  });
});

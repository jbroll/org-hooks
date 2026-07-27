// Pure helpers for the e2e coverage CLI. No monocart import and no I/O, so the
// option object and the path rewriting can be unit-tested on their own.

import path from "node:path";
import { normalisePath } from "./coverage-ratchet-lib.mjs";
import { coveredSrcFns } from "./e2e-impact-lib.mjs";

/** ["from=to", ...] -> [{from, to}]. Splits on the FIRST '=' so `to` may contain one. */
export function parseRewrites(specs) {
  return (specs ?? []).map((s) => {
    const i = s.indexOf("=");
    if (i <= 0) throw new Error(`--rewrite needs 'from=to', got: ${s}`);
    return { from: s.slice(0, i), to: s.slice(i + 1) };
  });
}

/**
 * Replace the first rule that matches at a path-segment boundary (string start
 * or after a '/'), so `src/=packages/web/src/` cannot fire inside `mysrc/`.
 * The primitive — callers want rewriteSourcePath.
 */
export function applyRewrites(p, rewrites) {
  for (const { from, to } of rewrites) {
    if (p.startsWith(from)) return to + p.slice(from.length);
    const i = p.indexOf(`/${from}`);
    if (i !== -1) return `${p.slice(0, i + 1)}${to}${p.slice(i + 1 + from.length)}`;
  }
  return p;
}

/**
 * A rule mapping a bare `src/` into a package matches at any segment boundary,
 * so unguarded it would turn packages/a/src/x.ts into packages/a/packages/b/src/x.ts.
 * A path that already names a package needs no rule.
 */
export function rewriteSourcePath(p, rewrites) {
  if (p.includes("packages/")) return p;
  return applyRewrites(p, rewrites);
}

/**
 * URL -> impact-map key, matching the repo-relative paths in ci/.changed-files.
 * normalisePath anchors on /packages/ first, so a workspace file keeps its
 * package identity; only a bare /src/ reaches the rewrites.
 */
export function makeMapPath(rewrites, cwd) {
  return (url) => {
    const clean = url.split("?")[0];
    const fs = clean.indexOf("/@fs/");
    const candidate = fs !== -1 ? clean.slice(fs + 4) : clean;
    if (!candidate.includes("/packages/") && !candidate.includes("/src/")) return null;
    const normalised = normalisePath(candidate, "src", cwd);
    if (normalised.startsWith("/") || normalised.includes("://")) return null;
    return rewriteSourcePath(normalised, rewrites);
  };
}

/** Monocart CoverageReport options. Returned as a plain object — no monocart here. */
export function makeCoverageOptions({ outputDir, origins, rewrites }) {
  return {
    name: "E2E Coverage",
    outputDir,
    reports: ["v8", "lcovonly"],
    // A checkout under a path containing /src/ (e.g. ~/src/repo) makes an
    // absolute /@fs/ dep url look like source, so node_modules is excluded here.
    entryFilter: (entry) =>
      origins.some((o) => entry.url.includes(o)) &&
      entry.url.includes("/src/") &&
      !entry.url.includes("/node_modules/"),
    // Vite dev source maps carry bare filenames in `sources`; resolve them
    // against the compiled script's URL before any prefix rule can match.
    sourcePath: (sp, info) => {
      let resolved = sp;
      if (!sp.includes("/") && info?.distFile) {
        resolved = path.posix.join(path.posix.dirname(info.distFile), sp);
      }
      return rewriteSourcePath(resolved, rewrites);
    },
    sourceFilter: (sourcePath) =>
      sourcePath.includes("/src/") && !sourcePath.includes("node_modules/"),
    // The CLI builds one report per run; a clean would discard nothing but
    // could race a partially-written cache.
    cleanCache: false,
  };
}

/** [{spec, data}] -> [{spec, files}], dropping dumps that covered nothing. */
export function foldImpact(dumps, mapPath) {
  const out = [];
  for (const { spec, data } of dumps) {
    const files = coveredSrcFns(data, undefined, mapPath);
    if (Object.keys(files).length > 0) out.push({ spec, files });
  }
  return out;
}

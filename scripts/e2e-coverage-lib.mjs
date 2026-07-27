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
 * Replace the first rule matching at a path-segment boundary, so
 * `src/=packages/web/src/` cannot fire inside `mysrc/`. Callers want rewriteSourcePath.
 */
export function applyRewrites(p, rewrites) {
  for (const { from, to } of rewrites) {
    if (p.startsWith(from)) return to + p.slice(from.length);
    const i = p.indexOf(`/${from}`);
    if (i !== -1) return `${p.slice(0, i + 1)}${to}${p.slice(i + 1 + from.length)}`;
  }
  return p;
}

/** True when `p` already sits under `seg` as a path segment (start or after '/'). */
function underSegment(p, seg) {
  return p === seg || p.startsWith(`${seg}/`) || p.includes(`/${seg}/`);
}

/**
 * Skip a rule whose target's leading segment (e.g. `packages` from
 * `packages/web/src/`) the path already sits under — covers both a path already
 * inside the target package and one under a sibling package of the same name.
 */
export function rewriteSourcePath(p, rewrites) {
  const applicable = rewrites.filter((r) => !underSegment(p, r.to.split("/")[0]));
  return applyRewrites(p, applicable);
}

/**
 * True for a vendor path as URL, monocart source path, or normalised repo-relative path.
 * Relies on Vite's `preserveSymlinks: false`, which resolves a workspace package's
 * `node_modules/@scope/pkg` symlink to its `packages/` realpath before this sees it.
 */
export function isVendorPath(p) {
  return p.startsWith("node_modules/") || p.includes("/node_modules/");
}

/**
 * URL -> impact-map key, matching the repo-relative paths in ci/.changed-files.
 * `origins`, when given, mirrors makeCoverageOptions' entryFilter so the lcov
 * and the impact map can't disagree about what counts as a source origin.
 */
export function makeMapPath(rewrites, cwd, origins) {
  return (url) => {
    if (origins && !origins.some((o) => url.includes(o))) return null;
    const clean = url.split("?")[0];
    const fs = clean.indexOf("/@fs/");
    const candidate = fs !== -1 ? clean.slice(fs + 4) : clean;
    if (!candidate.includes("/packages/") && !candidate.includes("/src/")) return null;
    const normalised = normalisePath(candidate, "src", cwd);
    if (normalised.startsWith("/") || normalised.includes("://") || isVendorPath(normalised)) return null;
    return rewriteSourcePath(normalised, rewrites);
  };
}

/** Monocart CoverageReport options. Returned as a plain object — no monocart here. */
export function makeCoverageOptions({ outputDir, origins, rewrites }) {
  return {
    name: "E2E Coverage",
    outputDir,
    reports: ["lcovonly"],
    // A checkout under a path containing /src/ (e.g. ~/src/repo) makes an
    // absolute /@fs/ dep url look like source, so node_modules is excluded here.
    entryFilter: (entry) =>
      origins.some((o) => entry.url.includes(o)) &&
      entry.url.includes("/src/") &&
      !isVendorPath(entry.url),
    // Vite dev source maps carry bare filenames in `sources`; resolve them
    // against the compiled script's URL before any prefix rule can match.
    sourcePath: (sp, info) => {
      let resolved = sp;
      if (!sp.includes("/") && info?.distFile) {
        resolved = path.posix.join(path.posix.dirname(info.distFile), sp);
      }
      return rewriteSourcePath(resolved, rewrites);
    },
    sourceFilter: (sourcePath) => sourcePath.includes("/src/") && !isVendorPath(sourcePath),
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

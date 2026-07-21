// Shared source-root resolution for the standalone TS scanners
// (check-no-reexports, check-duplicate-types, check-jazz-value-import-ban).
//
// Why this exists: those three scanners each took a single hardcoded `src`
// root, so in a monorepo they walked nothing and exited 0 — a silently
// passing gate, which is worse than a missing one. Every other part of
// org-hooks already understood workspaces (hygiene.sh's size-cap prod
// regex, coverage-ratchet's path anchoring, sci-tiered's
// {src,packages,...} globs, ci/before-test-push.sh), so the scanners were
// the stragglers, not the convention.
//
// A root may contain a single `*` path segment — `packages/*/src` expands
// to one root per workspace. Non-existent roots are dropped silently:
// passing `backend/src` to a repo without a backend is normal.
//
// Zero deps (node builtins only).

import { existsSync, readdirSync, statSync } from "node:fs";

export const DEFAULT_ROOTS = ["src", "packages/*/src"];

// Expand one `*` segment against the filesystem. `packages/*/src` ->
// ["packages/web/src", "packages/e2e/src", ...] for those that exist.
function expandGlob(pattern) {
  const segments = pattern.split("/");
  const star = segments.indexOf("*");
  if (star === -1) return [pattern];

  const parent = segments.slice(0, star).join("/") || ".";
  if (!existsSync(parent)) return [];

  const rest = segments.slice(star + 1);
  return readdirSync(parent)
    .filter((name) => !name.startsWith(".") && name !== "node_modules")
    .map((name) => [...segments.slice(0, star), name, ...rest].join("/"))
    .filter((p) => existsSync(p) && statSync(p).isDirectory());
}

// argv: the raw process.argv.slice(2) of a scanner. Empty means "use the
// conventional roots"; explicit args override entirely so a profile can
// scope a scan narrowly.
export function resolveRoots(argv) {
  const patterns = argv.length > 0 ? argv : DEFAULT_ROOTS;
  const seen = new Set();
  for (const pattern of patterns) {
    for (const root of expandGlob(pattern)) {
      if (existsSync(root)) seen.add(root);
    }
  }
  return [...seen];
}

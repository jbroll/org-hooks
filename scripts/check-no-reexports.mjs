#!/usr/bin/env node
// Re-export guard (generalised from rkr-blog's check-no-reexports.ts).
//
// Re-exports add zero value when you control all callers, and several
// costs: they hide where a symbol is actually defined (breaks
// go-to-definition / grep), create import-path drift (half the codebase
// imports from A, half from re-exporter B), and are a duplicate-typedef
// vector if the re-exporter renames.
//
// Flags:
//   export { x } from './y'        (incl. `export type { … } from`)
//   export * from './y'            (barrel)
//   export { x }                   (bare — re-export after a prior import)
// Allowed: inline-declaration exports (`export function/const/class/
//   interface/type/enum/default`).
//
// Usage:  node check-no-reexports.mjs [srcDir=src]
// Allowlist: `.no-reexports-allow` in repo root, one path-substring per
// line ('#' comments) — e.g. an intentional public barrel `src/index.ts`.
// Zero deps (node builtins only).

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, extname } from "node:path";

const root = process.argv[2] || "src";

const allow = [];
if (existsSync(".no-reexports-allow")) {
  for (const line of readFileSync(".no-reexports-allow", "utf8").split("\n")) {
    const t = line.replace(/#.*/, "").trim();
    if (t) allow.push(t);
  }
}
const allowed = (f) => allow.some((a) => f.includes(a));

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if ([".ts", ".tsx", ".js", ".jsx", ".mjs"].includes(extname(p)))
      out.push(p);
  }
  return out;
}

// `export ... from '...'`  or  `export * from`  or bare `export { ... }`
// (not followed by `from`, and not an inline declaration).
// `export {}` (empty braces) is excluded — it's a TypeScript module marker.
const FROM = /^\s*export\s+(type\s+)?(\{[^}]*\}|\*)\s+from\s+['"]/;
const BARE = /^\s*export\s+\{\s*\w[^}]*\}\s*;?\s*$/;

let failed = 0;
for (const file of walk(root)) {
  if (allowed(file)) continue;
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (FROM.test(line) || BARE.test(line)) {
      console.error(`  re-export  ${file}:${i + 1}  ${line.trim()}`);
      failed++;
    }
  });
}

if (failed) {
  console.error(
    `\n${failed} re-export(s). Use inline exports at the definition ` +
      `site, or allowlist an intentional barrel in .no-reexports-allow.`
  );
  process.exit(1);
}

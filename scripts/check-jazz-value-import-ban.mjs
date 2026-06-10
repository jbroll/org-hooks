#!/usr/bin/env node
// Jazz narrow-waist guard. Bans VALUE imports from "jazz-tools" and
// "jazz-tools/react" outside the two blessed dirs (src/jazz/** runtime + hooks
// adapter, src/schema/** schema defs), so app code expresses intent through the
// adapter/schema and the eventual Jazz v2 migration touches a handful of modules
// (the adapter + the providers), not the whole tree.
//
// Allowed everywhere (NOT flagged):
//   - `import type { … } from "jazz-tools"` / `"jazz-tools/react"` (types are
//     migration-cheap)
//   - `jazz-tools/testing` and other subpaths (e.g. better-auth) — different path
// Exempt files: src/jazz/**, src/schema/**, src/test/**, *.{test,spec}.*, *.d.ts,
//   and `.jazz-waist-allow` entries (the React providers that mount JazzProvider).
//
// Usage:  node check-jazz-value-import-ban.mjs [srcDir=src]
// Allowlist: `.jazz-waist-allow` (one path-substring per line, '#' comments).
//   Meant to stay EMPTY for app code — the documented escape valve only.
// Zero deps (node builtins only); mirrors check-no-reexports.mjs.

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, extname } from "node:path";

const root = process.argv[2] || "src";

const allow = [];
if (existsSync(".jazz-waist-allow")) {
  for (const line of readFileSync(".jazz-waist-allow", "utf8").split("\n")) {
    const t = line.replace(/#.*/, "").trim();
    if (t) allow.push(t);
  }
}
const allowed = (f) => allow.some((a) => f.includes(a));

function isExempt(file) {
  return (
    file.includes("src/jazz/") ||
    file.includes("src/schema/") ||
    file.includes("/test/") ||
    /\.(test|spec)\.(ts|tsx|js|jsx)$/.test(file) ||
    file.endsWith(".d.ts") ||
    allowed(file)
  );
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if ([".ts", ".tsx", ".js", ".jsx", ".mjs"].includes(extname(p))) out.push(p);
  }
  return out;
}

// An import statement whose source is EXACTLY "jazz-tools" or "jazz-tools/react"
// (other subpaths like "jazz-tools/testing" / "jazz-tools/better-auth/*" have
// extra text before the closing quote and won't match). The clause is `[^;]*?`
// so it spans a multi-line brace block but cannot cross a `;` into a previous
// import; `^` (m flag) anchors each statement's start.
const IMPORT = /^\s*import\s+([^;]*?)\s+from\s+["']jazz-tools(?:\/react)?["']/gm;

// True if the import clause pulls in at least one VALUE binding (vs. type-only).
function hasValueBinding(clause) {
  const c = clause.trim();
  if (/^type\b/.test(c)) return false; // whole-clause `import type { … }`
  const braced = c.match(/\{([\s\S]*)\}/);
  // Anything outside the braces (default or `* as ns`) is a value import.
  const outside = c.replace(/\{[\s\S]*\}/, "").replace(/,/g, "").trim();
  if (outside) return true;
  if (braced) {
    for (const raw of braced[1].split(",")) {
      const name = raw.trim();
      if (name && !/^type\s/.test(name)) return true; // a value member
    }
  }
  return false;
}

let failed = 0;
for (const file of walk(root)) {
  if (isExempt(file)) continue;
  const src = readFileSync(file, "utf8");
  let m;
  while ((m = IMPORT.exec(src)) !== null) {
    if (hasValueBinding(m[1])) {
      const line = src.slice(0, m.index).split("\n").length;
      console.error(`  jazz value-import  ${file}:${line}  ${m[1].replace(/\s+/g, " ").trim()}`);
      failed++;
    }
  }
}

if (failed) {
  console.error(
    `\n${failed} value import(s) from 'jazz-tools' or 'jazz-tools/react' outside ` +
      `src/jazz/** and src/schema/**.\nUse the @/jazz/* adapter or @/schema — ` +
      `\`import type\` and the jazz-tools/testing subpath are allowed.`,
  );
  process.exit(1);
}

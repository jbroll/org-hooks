#!/usr/bin/env node
// Cross-file duplicate type/interface/enum name detector.
//
// Why this exists: TypeScript scopes type names per-module and silently
// merges same-name interfaces; tsc, Biome and ESLint do NOT flag the
// same `interface Foo`/`type Foo`/`enum Foo` declared in two files. No
// off-the-shelf tool covers this in 2026, so this is a deliberate small
// custom scanner (zero deps — node builtins only).
//
// Usage:  node check-duplicate-types.mjs [srcDir=src]
// Allowlist: a `.dup-types-allow` file (one name per line, '#' comments)
// in the repo root suppresses known pre-existing dupes — new ones fail.
// Pattern mirrors rkr-blog's warn-on-existing / fail-on-new gate.

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, extname } from "node:path";

const root = process.argv[2] || "src";

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if ([".ts", ".tsx"].includes(extname(p)) && !p.endsWith(".d.ts"))
      out.push(p);
  }
  return out;
}

// Matches top-level / exported declarations. Intentionally conservative:
// favors false-negatives over flagging legitimate local shadows.
const DECL =
  /^\s*(?:export\s+)?(?:declare\s+)?(?:interface|type|enum)\s+([A-Z][A-Za-z0-9_]*)/;

const allow = new Set();
if (existsSync(".dup-types-allow")) {
  for (const line of readFileSync(".dup-types-allow", "utf8").split("\n")) {
    const t = line.replace(/#.*/, "").trim();
    if (t) allow.add(t);
  }
}

const seen = new Map(); // name -> [files]
for (const file of walk(root)) {
  const names = new Set();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = DECL.exec(line);
    if (m) names.add(m[1]);
  }
  for (const n of names) {
    if (!seen.has(n)) seen.set(n, []);
    seen.get(n).push(file);
  }
}

let failed = 0;
for (const [name, files] of seen) {
  if (files.length > 1 && !allow.has(name)) {
    console.error(`  duplicate type name "${name}":`);
    for (const f of files) console.error(`      ${f}`);
    failed++;
  }
}

if (failed) {
  console.error(
    `\n${failed} cross-file duplicate type name(s). ` +
      `Rename, or add to .dup-types-allow with a reason.`
  );
  process.exit(1);
}

// Thin CLI wrapper around org-hooks' pure selectSpecs(), so ci/e2e (bash) can
// decide which Playwright specs to run for a commit's changed source.
//
// Contract (fail-safe by design — under-selecting tests ships bugs):
//   stdout: either the single token `RUN_ALL`, or one spec path per line.
//   stderr: a human-readable summary (reason + count).
//   ANY error → print `RUN_ALL` (run the full suite).
//
// Inputs:
//   argv[2]            path to the changed-files manifest (default ci/.changed-files)
//   $CI_FLAKE_MAP      path to the GPU attribution map JSON
//                      (CI_FLAKE_MAP wins; else ~/ci-flake/${CI_REPO}-e2e-impact.json; else throw)
//   $CI_REPO           repo name for deriving the default map path
//
// The `smoke` always-run core is computed at runtime by listing @smoke specs via
// Playwright; if that listing fails we fall back to [] (the selector still
// unions in whatever is impacted, and fail-safe run-all covers the rest).

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { selectSpecs, DEFAULT_E2E_EXCLUDE } from "./e2e-select.mjs";

const RUN_ALL = "RUN_ALL";

/**
 * Parse a changed-files manifest into a list of repo-relative paths.
 * One path per line; blank lines and surrounding whitespace are ignored.
 * @param {string} text
 * @returns {string[]}
 */
export function parseManifest(text) {
  if (typeof text !== "string") return [];
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/**
 * Load the attribution map JSON from `mapPath`. Returns the parsed object, or
 * null if the file is missing / unreadable / not valid JSON / not an object.
 * null deliberately makes selectSpecs() return runAll (bootstrap).
 * @param {string} mapPath
 * @returns {Record<string, string[]> | null}
 */
export function loadMap(mapPath) {
  let text;
  try {
    text = readFileSync(mapPath, "utf8");
  } catch {
    return null;
  }
  try {
    const obj = JSON.parse(text);
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
    return obj;
  } catch {
    return null;
  }
}

/** Resolve the manifest path from argv (default ci/.changed-files relative to cwd). */
export function manifestPath(argv) {
  return argv[2] ?? path.join("ci", ".changed-files");
}

/** Resolve the attribution-map path from $CI_FLAKE_MAP or CI_REPO-derived default. */
export function mapPathFromEnv(env = process.env) {
  if (env.CI_FLAKE_MAP) return env.CI_FLAKE_MAP;
  if (env.CI_REPO) return path.join(homedir(), "ci-flake", `${env.CI_REPO}-e2e-impact.json`);
  throw new Error("e2e-select-cli: set CI_FLAKE_MAP or CI_REPO");
}

/**
 * List the spec files tagged @smoke via Playwright (repo-relative paths matching
 * the map's key style, e.g. "tests/foo.spec.ts"). Best-effort: any failure → [].
 * @returns {string[]}
 */
export function listSmokeSpecs() {
  try {
    const out = execFileSync(
      "npx",
      ["playwright", "test", "--grep", "@smoke", "--list", "--reporter=json"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return parseSmokeListJson(out);
  } catch {
    return [];
  }
}

/**
 * Extract unique repo-relative spec file paths from `playwright --list
 * --reporter=json` output. Tolerant of shape variations; returns [] on any
 * parse failure. Exported for unit testing without invoking Playwright.
 * @param {string} jsonText
 * @returns {string[]}
 */
export function parseSmokeListJson(jsonText) {
  let data;
  try {
    data = JSON.parse(jsonText);
  } catch {
    return [];
  }
  const files = new Set();
  const visitSpec = (spec, suiteFile) => {
    const file = spec?.file ?? suiteFile;
    if (typeof file === "string" && file) files.add(normalizeSpecPath(file));
  };
  const visitSuite = (suite) => {
    if (!suite || typeof suite !== "object") return;
    const suiteFile = typeof suite.file === "string" ? suite.file : undefined;
    for (const spec of suite.specs ?? []) visitSpec(spec, suiteFile);
    for (const child of suite.suites ?? []) visitSuite(child);
  };
  for (const suite of data?.suites ?? []) visitSuite(suite);
  return [...files].sort();
}

/** Normalize a Playwright file path to a repo-relative posix path. */
export function normalizeSpecPath(file) {
  // Playwright --list usually emits repo-relative paths already; guard absolutes.
  const rel = path.isAbsolute(file) ? path.relative(process.cwd(), file) : file;
  return rel.split(path.sep).join("/");
}

async function main() {
  const mPath = manifestPath(process.argv);
  let manifestText = "";
  try {
    manifestText = readFileSync(mPath, "utf8");
  } catch {
    // Missing/empty manifest → no changed files known → fail-safe run-all.
    process.stderr.write(`e2e-select: no manifest at ${mPath} → RUN_ALL\n`);
    process.stdout.write(`${RUN_ALL}\n`);
    return;
  }

  const changed = parseManifest(manifestText);
  if (changed.length === 0) {
    process.stderr.write("e2e-select: empty manifest → RUN_ALL\n");
    process.stdout.write(`${RUN_ALL}\n`);
    return;
  }

  let map = null;
  try {
    map = loadMap(mapPathFromEnv());
  } catch {
    // No CI_FLAKE_MAP/CI_REPO → treat as missing map → runAll (bootstrap).
  }
  const smoke = listSmokeSpecs();

  const result = selectSpecs({ changed, map, smoke, exclude: DEFAULT_E2E_EXCLUDE });

  if (result.runAll) {
    process.stderr.write(`e2e-select: runAll (reason=${result.reason})\n`);
    process.stdout.write(`${RUN_ALL}\n`);
    return;
  }

  process.stderr.write(
    `e2e-select: ${result.specs.length} spec(s) (reason=${result.reason}, smoke=${smoke.length})\n`,
  );
  process.stdout.write(`${result.specs.join("\n")}\n`);
}

// Run main() only when executed directly (not when imported by tests).
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]).endsWith("e2e-select-cli.mjs");
if (invokedDirectly) {
  main().catch((err) => {
    // Fail-safe: any unexpected error → run the full suite.
    process.stderr.write(`e2e-select: error → RUN_ALL: ${err?.message ?? err}\n`);
    process.stdout.write(`${RUN_ALL}\n`);
  });
}

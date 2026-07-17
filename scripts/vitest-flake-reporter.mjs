// Vitest 4 reporter that emits normalized flake records for org-hooks' flake gate.
// Writes one {testId, project, status} JSON line per test to VITEST_FLAKE_OUT.
// status: "flaky" when the test passed only after a retry (diagnostic.retryCount > 0),
// "failed" when its final state is failed, else "passed". Skipped/pending are omitted.
//
// Targets the Vitest 4 reporter API: onTestRunEnd(testModules) with the
// TestModule / TestCase object model (module.relativeModuleId, case.fullName,
// case.result().state, case.diagnostic().retryCount). Self-contained — vitest is
// not an org-hooks dependency, so the reporter takes objects vitest hands it and
// imports nothing from vitest.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Map a vitest test state + retry count to a normalized flake status (or null to skip). */
export function classify(state, retryCount) {
  if (state === "failed") return "failed";
  if (state === "passed") return (retryCount ?? 0) > 0 ? "flaky" : "passed";
  return null; // skipped / pending
}

export default class FlakeReporter {
  onTestRunEnd(testModules = []) {
    const out = process.env.VITEST_FLAKE_OUT;
    if (!out) return;
    const project = process.env.VITEST_PROJECT ?? "unit";
    const lines = [];
    for (const mod of testModules) {
      for (const test of mod.children.allTests()) {
        const status = classify(test.result().state, test.diagnostic()?.retryCount);
        if (!status) continue;
        const file = test.module.relativeModuleId;
        lines.push(JSON.stringify({ testId: `${file} › ${test.fullName} › ${project}`, project, status }));
      }
    }
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, lines.length ? lines.join("\n") + "\n" : "");
  }
}

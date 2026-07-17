// Vitest reporter that emits normalized flake records for org-hooks' flake gate.
// Writes one {testId, project, status} JSON line per test to VITEST_FLAKE_OUT.
// status: "flaky" when the test passed only after a retry (result.retryCount > 0),
// "failed" when its final state is fail, else "passed". Skipped/todo are omitted.
//
// Self-contained: the `files` task tree is handed to onFinished() by vitest at
// runtime, so we walk it directly rather than importing @vitest/runner (which is
// not a dependency of org-hooks and would break this reporter's own unit test).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Depth-first collect every `type: "test"` task under a file/suite tree. */
function collectTests(task, out) {
  if (task.type === "test") {
    out.push(task);
    return;
  }
  for (const child of task.tasks ?? []) collectTests(child, out);
}

/** Full test name: file name › describe… › test title (walks the .suite chain). */
function fullName(task) {
  const names = [];
  let t = task;
  while (t) {
    if (t.name) names.unshift(t.name);
    t = t.suite;
  }
  return names.join(" › ");
}

function normalize(test) {
  const r = test.result;
  if (r?.state === "fail") return "failed";
  if (r?.state === "pass") return (r.retryCount ?? 0) > 0 ? "flaky" : "passed";
  return null; // skipped / todo / not-run
}

export default class FlakeReporter {
  onFinished(files = []) {
    const out = process.env.VITEST_FLAKE_OUT;
    if (!out) return;
    const project = process.env.VITEST_PROJECT ?? "unit";
    const tests = [];
    for (const file of files) collectTests(file, tests);
    const lines = [];
    for (const test of tests) {
      const status = normalize(test);
      if (!status) continue;
      lines.push(JSON.stringify({ testId: `${fullName(test)} › ${project}`, project, status }));
    }
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, lines.length ? lines.join("\n") + "\n" : "");
  }
}

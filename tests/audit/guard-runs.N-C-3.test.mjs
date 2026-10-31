// tests/audit/guard-runs.N-C-3.test.mjs
import { test } from "node:test"; import assert from "node:assert/strict"; import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
test("N-C-3: a workflow-only change runs the CI guard (site.ci-deps)", () => {
  const g = fs.readFileSync(path.join(ROOT, ".github/workflows/workflow-guard.yml"), "utf8");
  assert.match(g, /\.github\/workflows\/\*\*/);
  assert.match(g, /site\.ci-deps\.test\.mjs/, "workflow-guard.yml doesn't run the issue/trigger/permission guard");
});

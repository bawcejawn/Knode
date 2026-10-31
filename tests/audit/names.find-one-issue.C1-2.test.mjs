// tests/audit/names.find-one-issue.C1-2.test.mjs   (node --test)   Repo Lens #C-1, finding C1-2 (PN-1 residual)
// `gh api --paginate --jq '.[]'` writes one compact JSON object per line. With exactly ONE open claim issue the find
// step's Python must still list it. Written, not run here.
import { test } from "node:test"; import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { spawnSync } from "node:child_process"; import { fileURLToPath } from "node:url";
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const wf = fs.readFileSync(path.join(ROOT, ".github/workflows/names.yml"), "utf8");
const find = wf.slice(wf.indexOf("- name: Find open claims"));
const py = find.match(/<<'PY'\n([\s\S]*?)\n\s*PY\n/)[1].replace(/^ {10}/gm, "");
// Windows has python or py; Linux/macOS have python3.
const PY = ["python3", "python", "py"].find((c) => spawnSync(c, ["-c", "import sys; assert sys.version_info >= (3, 8)"]).status === 0);
const issue = (n) => JSON.stringify({ number: n, labels: [{ name: "knode-name" }],
  body: `Knode Games name: Armana | 1AbcdefghijkmnopqrstuvwxyzABC | 2026-10-30\nSignature: ${"A".repeat(87)}` });
for (const count of [1, 2, 3]) test(`C1-2: ${count} open claim issue(s), one per line -> ${count} listed`, () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "c1-2-"));
  fs.writeFileSync(path.join(d, "all.json"), Array.from({ length: count }, (_, i) => issue(10 + i)).join("\n") + "\n");
  assert.ok(PY, "no Python 3 found (python3, python or py)");
  const p = spawnSync(PY, ["-", path.join(d, "all.json"), path.join(d, "o.json")], { input: py, encoding: "utf8" });
  assert.equal(p.status, 0, p.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(d, "o.json"), "utf8")).length, count, p.stdout);
});

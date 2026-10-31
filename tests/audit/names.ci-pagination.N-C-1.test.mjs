// tests/audit/names.ci-pagination.N-C-1.test.mjs
import { test } from "node:test"; import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { spawnSync } from "node:child_process"; import { fileURLToPath } from "node:url";
const APP = fileURLToPath(new URL("../..", import.meta.url));
const wf = fs.readFileSync(path.join(APP, ".github/workflows/names.yml"), "utf8");
test("N-C-1: the claim list is filtered by GitHub (search/label) or paginated, so 100 older issues can't hide claims", () => {
  const find = wf.slice(wf.indexOf("- name: Find open claims"), wf.indexOf("actions/checkout@"));
  const call = find.split("\n").find((l) => /gh api/.test(l)) || "";
  assert.ok(/--paginate|search\/issues|labels=/.test(call), `find step reads one page of all open issues: ${call.trim()}`);
  // and the Python, fed exactly one page (what gh returns without --paginate), must not be the only filter
  const py = [...wf.matchAll(/<<'PY'\n([\s\S]*?)\n\s*PY\n/g)].map((m) => m[1].replace(/^ {10}/gm, ""))[0];
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "nc1-"));
  fs.writeFileSync(path.join(d, "all.json"), JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ number: i + 1, body: "spam" }))));
  const p = spawnSync("/usr/bin/python3", ["-", path.join(d, "all.json"), path.join(d, "o.json")], { input: py, encoding: "utf8" });
  assert.equal(p.status, 0, p.stderr);
});

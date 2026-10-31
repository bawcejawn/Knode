// tests/audit/ci-guard-bypass.N-C-2.test.mjs
import { test } from "node:test"; import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { spawnSync } from "node:child_process"; import { fileURLToPath } from "node:url";
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const VECTORS = {
  "flow-trigger.yml": "name: x\non: [issues]\npermissions:\n  contents: read\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo\n",
  "write-all.yml": "name: x\non:\n  push: {}\npermissions: write-all\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo\n",
  "secret-lower.yml": "name: x\non:\n  push: {}\npermissions:\n  contents: read\njobs:\n  a:\n    runs-on: ubuntu-latest\n    env:\n      K: ${{ secrets.operator_wif }}\n    steps:\n      - run: echo\n",
};
for (const [name, y] of Object.entries(VECTORS)) test(`N-C-2: site.ci-deps guard refuses ${name}`, () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "nc2-"));
  fs.cpSync(path.join(ROOT, ".github"), path.join(d, ".github"), { recursive: true });
  for (const f of ["package.json", "package-lock.json"]) fs.copyFileSync(path.join(ROOT, f), path.join(d, f));
  for (const sub of ["game", "desk"]) for (const f of ["package.json", "package-lock.json"]) if (fs.existsSync(path.join(ROOT, sub, f))) { fs.mkdirSync(path.join(d, sub), { recursive: true }); fs.copyFileSync(path.join(ROOT, sub, f), path.join(d, sub, f)); }
  fs.writeFileSync(path.join(d, ".github/workflows", name), y);
  // NODE_TEST_CONTEXT is dropped: with it, a nested node --test reports to this runner and always exits 0.
  const env = { ...process.env, APP: d }; delete env.NODE_TEST_CONTEXT;
  const p = spawnSync(process.execPath, ["--test", path.join(ROOT, "tests/audit/site.ci-deps.test.mjs")], { env, encoding: "utf8" });
  assert.notEqual(p.status, 0, `the guard passed a workflow it must refuse (${name})`);
});

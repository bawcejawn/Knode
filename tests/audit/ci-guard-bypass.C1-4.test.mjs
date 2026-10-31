// tests/audit/ci-guard-bypass.C1-4.test.mjs   (node --test)   Repo Lens #C-1, finding C1-4 (PN-8 residual)
// Same harness as ci-guard-bypass.N-C-2: each vector is added to a scratch copy of .github and the guard must fail.
// Written, not run here.
import { test } from "node:test"; import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { spawnSync } from "node:child_process"; import { fileURLToPath } from "node:url";
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const job = (env) => `name: x\non:\n  push: {}\npermissions:\n  contents: read\njobs:\n  a:\n    runs-on: ubuntu-latest\n${env}    steps:\n      - run: echo\n`;
const VECTORS = {
  "tojson-secrets.yml": job("    env:\n      ALL: ${{ toJson(secrets) }}\n"),
  "inherit-quoted.yml": "name: x\non:\n  push: {}\npermissions:\n  contents: read\njobs:\n  a:\n    uses: ./.github/workflows/other.yml\n    secrets: \"inherit\"\n",
  "write-all-folded.yml": "name: x\non:\n  push: {}\npermissions: >-\n  write-all\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo\n",
};
for (const [name, y] of Object.entries(VECTORS)) test(`C1-4: site.ci-deps guard refuses ${name}`, () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "c1-4-"));
  fs.cpSync(path.join(ROOT, ".github"), path.join(d, ".github"), { recursive: true });
  for (const f of ["package.json", "package-lock.json"]) fs.copyFileSync(path.join(ROOT, f), path.join(d, f));
  for (const sub of ["game", "desk"]) for (const f of ["package.json", "package-lock.json"]) if (fs.existsSync(path.join(ROOT, sub, f))) { fs.mkdirSync(path.join(d, sub), { recursive: true }); fs.copyFileSync(path.join(ROOT, sub, f), path.join(d, sub, f)); }
  fs.writeFileSync(path.join(d, ".github/workflows", name), y);
  const env = { ...process.env, APP: d }; delete env.NODE_TEST_CONTEXT;
  const p = spawnSync(process.execPath, ["--test", path.join(ROOT, "tests/audit/site.ci-deps.test.mjs")], { env, encoding: "utf8" });
  assert.notEqual(p.status, 0, `the guard passed a workflow it must refuse (${name})`);
});

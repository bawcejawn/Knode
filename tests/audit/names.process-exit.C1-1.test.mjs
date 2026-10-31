// tests/audit/names.process-exit.C1-1.test.mjs   (node --import tsx --test)   Repo Lens #C-1, finding C1-1 (PN-3 residual)
// A node that accepts connections and never answers must not keep the check job's process alive after its work is done.
// Written, not run here. Both fake nodes run in a separate process, so only the bot's own sockets can keep it alive.
import { test } from "node:test"; import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { spawn, spawnSync } from "node:child_process"; import { fileURLToPath } from "node:url";
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
test("C1-1: `names run` exits on its own when both nodes hang (refresh run)", { timeout: 120000 }, async () => {
  const fake = spawn(process.execPath, ["-e", `const n=require("node:net");for(const p of [0,0]){const s=n.createServer(()=>{}).listen(p,"127.0.0.1",()=>console.log(s.address().port));}`], { stdio: ["ignore", "pipe", "inherit"] });
  try {
    const ports = await new Promise((ok) => { let b = ""; fake.stdout.on("data", (d) => { b += d; const l = b.trim().split(/\s+/); if (l.length >= 2) ok(l.slice(0, 2)); }); });
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "c1-1-"));
    fs.writeFileSync(path.join(d, "issues.json"), "[]");
    fs.mkdirSync(path.join(d, "producers"));
    const env = { ...process.env, NAMES_OUT: path.join(d, "out"), NAMES_RESULT: path.join(d, "result/results.json"), NAMES_REFRESH: "true",
      ISSUES_FILE: path.join(d, "issues.json"), PRODUCERS_DIR: path.join(d, "producers"),
      RPC: `http://127.0.0.1:${ports[0]}`, RPC_CHECK: `http://127.0.0.1:${ports[1]}` };
    delete env.NODE_TEST_CONTEXT;
    const t0 = Date.now();
    const p = spawnSync(process.execPath, ["--import", "tsx", path.join(ROOT, "bot/names.ts"), "run"], { cwd: ROOT, env, encoding: "utf8", timeout: 90000 });
    assert.notEqual(p.signal, "SIGTERM", `the process was still running after ${Math.round((Date.now() - t0) / 1000)} s (a hung request keeps it alive; the job would hit its 10-minute limit)`);
    assert.ok(fs.existsSync(env.NAMES_RESULT), "results.json written");
  } finally { fake.kill(); }
});

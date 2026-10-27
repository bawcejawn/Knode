// Self-heal auto-repair (bot/heal.mjs): when a node's block store is in a crash loop, the nodes help each other: the
// broken node's block data is copied from a healthy node by node/repair-node-data.ps1, within strict safety rules.
// Each test runs the real heal.mjs as a child process against fake nodes (local RPC), a fake docker, a fake
// PowerShell (records its arguments) and a fake GitHub (records the alert emails).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const HEAL = path.join(ROOT, "bot", "heal.mjs");
const NET = 1_000_000;
const ts = (msAgo) => new Date(Date.now() - msAgo).toISOString().slice(0, 19).replace("T", " ");

async function world({ heights = {}, crash = [], state = {}, task = true, lock = null, env = {}, psExit = 0, backups = [] } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "heal-"));
  const healDir = path.join(tmp, "state");
  fs.mkdirSync(healDir);
  const calls = path.join(tmp, "calls.log");
  fs.writeFileSync(calls, "");
  const nodes = [];
  for (const k of ["desk", "game", "personal"]) {
    const dir = path.join(tmp, k, "koinos"), base = path.join(tmp, k, "basedir");
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(base, "block_store", "logs"), { recursive: true });
    fs.mkdirSync(path.join(base, "block_store", "db"), { recursive: true });
    fs.mkdirSync(path.join(base, "chain", "blockchain"), { recursive: true });
    fs.writeFileSync(path.join(base, "block_store", "db", "000001.sst"), "x".repeat(1000));
    fs.writeFileSync(path.join(base, "chain", "blockchain", "000001.sst"), "y".repeat(1000));
    fs.writeFileSync(path.join(dir, ".env"), `BASEDIR=${base}\n`);
    const starts = crash.includes(k) ? [1, 3, 6, 9, 12].map((m) => `${ts(m * 60_000)}.000000 (block_store.Koinos) [main.go:1] <info>: Koinos Block Store v1.1.0\n`).join("") : `${ts(5 * 3600_000)}.0 Koinos Block Store v1.1.0\n`;
    fs.writeFileSync(path.join(base, "block_store", "logs", "block_store.log"), starts);
    for (const b of backups.filter((x) => x.node === k)) fs.mkdirSync(path.join(base, b.sub, b.name), { recursive: true });
    nodes.push({ name: `${k} node`, dir, k, base });
  }
  const emails = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      if (req.url.startsWith("/repos/")) { emails.push(JSON.parse(body).inputs); res.writeHead(204); return res.end(); }
      const who = req.url.slice(1);
      const h = who === "net" ? NET : heights[who] ?? NET;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { head_topology: { height: String(h) } } }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const fakeDocker = path.join(tmp, "docker.sh");
  fs.writeFileSync(fakeDocker, `#!/bin/sh\necho "docker $* @ $PWD" >> "${calls}"\nexit 0\n`, { mode: 0o755 });
  const fakePs = path.join(tmp, "powershell.sh");
  fs.writeFileSync(fakePs, `#!/bin/sh\necho "powershell $*" >> "${calls}"\necho "OK  copied"\n${psExit === 0 ? 'echo "DONE. repaired"' : 'echo "PROBLEM: copy failed"'}\nexit ${psExit}\n`, { mode: 0o755 });
  const fullState = { nodes: {} };
  for (const n of nodes) fullState.nodes[n.name] = { heals: [], height: heights[n.k] ?? NET, okRuns: 1, ...(state[n.k] || {}) };
  fs.writeFileSync(path.join(healDir, "heal-state.json"), JSON.stringify(fullState));
  if (task) fs.writeFileSync(path.join(healDir, "heal-task.json"), JSON.stringify({ version: 2, limitMinutes: 120 }));
  if (lock) fs.writeFileSync(path.join(healDir, "repair.lock"), JSON.stringify(lock));
  const run = (args = []) => new Promise((resolve) => {
    execFile(process.execPath, [HEAL, ...args], {
      cwd: tmp,
      env: {
        PATH: process.env.PATH, HOME: tmp, RPC: `${url}/net`, HEAL_GITHUB_API: url, GITHUB_ALERT_TOKEN: "test", HEAL_DIR: healDir,
        HEAL_DOCKER: fakeDocker, HEAL_POWERSHELL: fakePs, HEAL_DISK_MARGIN_BYTES: "0",
        HEAL_NODES: JSON.stringify(nodes.map((n) => ({ name: n.name, dir: n.dir, rpc: `${url}/${n.k}` }))), ...env,
      },
    }, (err, stdout, stderr) => resolve({ out: stdout + stderr }));
  });
  const done = () => new Promise((r) => server.close(r));
  return {
    tmp, healDir, nodes, emails, run, done,
    calls: () => fs.readFileSync(calls, "utf8"),
    state: () => JSON.parse(fs.readFileSync(path.join(healDir, "heal-state.json"), "utf8")),
  };
}

test("a crash-looping node is repaired from the first healthy source (desk), with an email before and after; the lock is released", async () => {
  const w = await world({ crash: ["game"] });
  try {
    const { out } = await w.run();
    assert.match(w.calls(), /powershell .*-File .*repair-node-data\.ps1 -Broken game -From desk/);
    assert.match(out, /repair finished/);
    assert.equal(w.emails.length, 2, "one email before, one after");
    assert.match(w.emails[0].detail, /Repairing the game node from the desk node/);
    assert.match(w.emails[1].detail, /Repair finished/);
    assert.ok(!fs.existsSync(path.join(w.healDir, "repair.lock")), "lock released");
    assert.ok(fs.readdirSync(w.healDir).some((f) => /^repair-game-\d{12}\.log$/.test(f)), "the script's output is kept in a log");
    const st = w.state();
    assert.ok(st.nodes["game node"].repairedAt && st.nodes["desk node"].sourceAt);
    assert.equal(st.nodes["game node"].autoRepairs.length, 1);
  } finally { await w.done(); }
});

test("the desk can't be the source when it was used recently: the personal node is used instead (never the broken one)", async () => {
  const w = await world({ crash: ["game"], state: { desk: { sourceAt: Date.now() - 3600_000 } } });
  try {
    await w.run();
    assert.match(w.calls(), /-Broken game -From personal/);
  } finally { await w.done(); }
});

test("no node healthy for two checks in a row: no repair, an email asks for a repair by hand", async () => {
  const w = await world({ crash: ["game"], state: { desk: { okRuns: 0 }, personal: { okRuns: 0 } }, heights: { desk: NET - 50, personal: NET - 50 } });
  try {
    await w.run();
    assert.doesNotMatch(w.calls(), /powershell/);
    assert.equal(w.emails.length, 1);
    assert.match(w.emails[0].detail, /no other node has been healthy for two checks in a row.*repair-node-data\.ps1 -Broken game -From desk/);
  } finally { await w.done(); }
});

test("a running repair (lock) blocks a second repair and any restart of the two nodes it involves", async () => {
  // The desk node is frozen (far behind, not moving), which would normally mean a restart.
  const w = await world({ crash: ["personal"], heights: { desk: NET - 500 }, state: { desk: { height: NET - 500 } },
    lock: { pid: 1, startedAt: Date.now() - 10 * 60_000, broken: "game", from: "desk" } });
  try {
    const { out } = await w.run();
    assert.doesNotMatch(w.calls(), /powershell/, "no second repair");
    assert.doesNotMatch(w.calls(), /docker compose (down|up).*desk/, "the desk (in the repair) is not restarted");
    assert.match(out, /desk node: a repair \(game from desk\) is running/);
    assert.match(w.emails.map((e) => e.detail).join("\n"), /another repair \(game from desk\) is running/);
  } finally { await w.done(); }
});

test("a lock older than 90 minutes is stale and doesn't block a repair", async () => {
  const w = await world({ crash: ["game"], lock: { pid: 1, startedAt: Date.now() - 2 * 3600_000, broken: "personal", from: "desk" } });
  try {
    await w.run();
    assert.match(w.calls(), /-Broken game -From desk/);
  } finally { await w.done(); }
});

test("at most one automatic repair per node per 24 hours, then emails only", async () => {
  const w = await world({ crash: ["game"], state: { game: { autoRepairs: [Date.now() - 5 * 3600_000] } } });
  try {
    await w.run();
    assert.doesNotMatch(w.calls(), /powershell/);
    assert.match(w.emails[0].detail, /already repaired automatically in the last 24 hours/);
  } finally { await w.done(); }
});

test("off switch: HEAL_AUTO_REPAIR=off only emails", async () => {
  const w = await world({ crash: ["game"], env: { HEAL_AUTO_REPAIR: "off" } });
  try {
    await w.run();
    assert.doesNotMatch(w.calls(), /powershell/);
    assert.match(w.emails[0].detail, /switched off/);
  } finally { await w.done(); }
});

test("dry run: says what it would repair, runs nothing, emails nothing, takes no lock", async () => {
  const w = await world({ crash: ["game"] });
  try {
    const { out } = await w.run(["--dry-run"]);
    assert.match(out, /\(dry run\) would repair: Repairing the game node from the desk node/);
    assert.doesNotMatch(w.calls(), /powershell/);
    assert.equal(w.emails.length, 0);
    assert.ok(!fs.existsSync(path.join(w.healDir, "repair.lock")));
  } finally { await w.done(); }
});

test("no repair until install-heal.ps1 has given the task room for one (old 15-minute limit)", async () => {
  const w = await world({ crash: ["game"], task: false });
  try {
    await w.run();
    assert.doesNotMatch(w.calls(), /powershell/);
    assert.match(w.emails[0].detail, /install-heal\.ps1/);
  } finally { await w.done(); }
});

test("too little free disk: no repair, an email says why", async () => {
  const w = await world({ crash: ["game"], env: { HEAL_FAKE_FREE_BYTES: "100" } });
  try {
    await w.run();
    assert.doesNotMatch(w.calls(), /powershell/);
    assert.match(w.emails[0].detail, /not enough free disk space/);
  } finally { await w.done(); }
});

test("a failed repair is reported by email with the script's last lines, and the lock is released", async () => {
  const w = await world({ crash: ["game"], psExit: 1 });
  try {
    await w.run();
    assert.match(w.emails[1].detail, /Repair FAILED: .*PROBLEM: copy failed/);
    assert.ok(!fs.existsSync(path.join(w.healDir, "repair.lock")));
  } finally { await w.done(); }
});

test("repair backups older than 7 days are deleted; newer ones and other folders stay", async () => {
  const old = new Date(Date.now() - 9 * 24 * 3600_000), recent = new Date(Date.now() - 24 * 3600_000);
  const name = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}-1200`;
  const w = await world({ backups: [
    { node: "desk", sub: "block_store", name: `db-broken-${name(old)}` },
    { node: "desk", sub: "chain", name: `blockchain-broken-${name(old)}` },
    { node: "desk", sub: "block_store", name: `db-broken-${name(recent)}` },
    { node: "desk", sub: "block_store", name: "db-broken-keepme" },
  ] });
  try {
    await w.run();
    const desk = w.nodes.find((n) => n.k === "desk").base;
    assert.ok(!fs.existsSync(path.join(desk, "block_store", `db-broken-${name(old)}`)));
    assert.ok(!fs.existsSync(path.join(desk, "chain", `blockchain-broken-${name(old)}`)));
    assert.ok(fs.existsSync(path.join(desk, "block_store", `db-broken-${name(recent)}`)));
    assert.ok(fs.existsSync(path.join(desk, "block_store", "db-broken-keepme")));
    assert.ok(fs.existsSync(path.join(desk, "block_store", "db")), "the live database is never touched");
  } finally { await w.done(); }
});

test("the repair script runs unattended and returns an exit code (0 repaired, 1 not)", () => {
  const ps = fs.readFileSync(path.join(ROOT, "node", "repair-node-data.ps1"), "utf8");
  assert.match(ps, /if \(\$copied\) \{ exit 0 \} else \{ exit 1 \}\s*$/);
  assert.doesNotMatch(ps, /Read-Host|-Confirm:\$true|Pause\b/i, "no prompts");
  assert.match(ps, /\[ValidateSet\("game", "desk", "personal"\)\]\[string\]\$Broken/);
  const inst = fs.readFileSync(path.join(ROOT, "node", "install-heal.ps1"), "utf8");
  assert.match(inst, /ExecutionTimeLimit \(New-TimeSpan -Hours 2\)/);
  assert.match(inst, /heal-task\.json/);
});

// Moving a node's data into a Docker volume (node/move-node-to-volume.ps1), and the self-heal / repair tools working
// with such nodes (bot/heal.mjs, node/repair-node-data.ps1).
//   - static checks on the PowerShell scripts (the override covers exactly the services that mount ${BASEDIR}; nothing
//     ever deletes a basedir folder or a volume);
//   - the real heal.mjs against fake nodes whose data is in a volume (a fake docker answers the helper containers);
//   - when PowerShell 7 (pwsh) is installed (set PWSH=/path/to/pwsh), the move script end to end against a fake docker.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFile, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MOVE = path.join(ROOT, "node", "move-node-to-volume.ps1");
const REPAIR = path.join(ROOT, "node", "repair-node-data.ps1");
const HEAL = path.join(ROOT, "bot", "heal.mjs");
const COMPOSE = fs.readFileSync(path.join(ROOT, "tests", "fixtures", "koinos-docker-compose.yml"), "utf8");
const move = fs.readFileSync(MOVE, "utf8");
const repair = fs.readFileSync(REPAIR, "utf8");

/** Services in the owner's docker-compose.yml (koinos/koinos) that mount ${BASEDIR} at /koinos. */
function basedirServices(yml) {
  const out = [];
  let inServices = false, svc = null;
  for (const line of yml.split(/\r?\n/)) {
    if (/^\S/.test(line)) { inServices = line.startsWith("services:"); svc = null; continue; }
    if (!inServices) continue;
    const m = line.match(/^ {3}([a-z_]+):\s*$/);
    if (m) { svc = m[1]; continue; }
    if (svc && line.includes('"${BASEDIR}:/koinos"') && !out.includes(svc)) out.push(svc);
  }
  return out;
}

test("the override covers exactly the compose services that mount ${BASEDIR} (and nothing else)", () => {
  const want = basedirServices(COMPOSE).sort();
  assert.ok(want.includes("block_store") && want.includes("block_producer") && want.includes("chain"), "fixture parsed");
  assert.ok(!want.includes("amqp") && !want.includes("rest"));
  const list = (move.match(/\$services = @\(([^)]*)\)/) || [])[1];
  assert.ok(list, "the move script lists its services");
  const have = [...list.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(have, want);
});

test("the override names the volume as external and keeps docker-compose.yml untouched", () => {
  assert.match(move, /"\s*external: true"/);
  assert.match(move, /"\s*name: \$Vol"/);
  assert.match(move, /knode-basedir:\/koinos/);
  assert.match(move, /# knode-volume: \$Vol/);
  assert.doesNotMatch(move, /Set-Content[^\n]*docker-compose\.yml/);
  assert.match(move, /docker-compose\.override\.yml/);
});

test("nothing deletes a basedir folder or a Docker volume", () => {
  for (const [name, src] of [["move", move], ["repair", repair]]) {
    assert.doesNotMatch(src, /docker[^\n]*volume rm/i, `${name}: no 'docker volume rm'`);
    assert.doesNotMatch(src, /Remove-Item[^\n]*\$Base\b/, `${name}: no Remove-Item on the basedir`);
    assert.doesNotMatch(src, /Remove-Item[^\n]*basedir"?\s*(-|$)/i, `${name}: no Remove-Item on a basedir path`);
    assert.doesNotMatch(src, /rm -rf \/(from|k|to)\/?["'\s;]/, `${name}: no rm -rf of a whole mount`);
  }
  // The move script removes only its own lock file.
  for (const m of move.matchAll(/Remove-Item ([^\n]*)/g)) assert.match(m[1], /^\$LockFile/);
  // The copy source is mounted read-only.
  assert.match(move, /\$\{BaseFwd\}:\/from:ro/);
  assert.match(repair, /\$\{FromMount\}:\/from:ro/);
});

test("the move takes the self-heal's repair lock in heal.mjs's format and pins the helper image", () => {
  assert.match(move, /pid = \$PID; startedAt = \[DateTimeOffset\]::UtcNow\.ToUnixTimeMilliseconds\(\); broken = \$Node; from = \$Node/);
  assert.match(move, /repair\.lock/);
  for (const src of [move, repair, fs.readFileSync(HEAL, "utf8")]) assert.match(src, /alpine:3\.20/);
});

// ───────────── heal.mjs with nodes in Docker volumes ─────────────
const ts = (msAgo) => new Date(Date.now() - msAgo).toISOString().slice(0, 19).replace("T", " ");
const stampAgo = (ms) => { const d = new Date(Date.now() - ms); const p = (x) => String(x).padStart(2, "0"); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`; };

async function volumeWorld({ crash = [], backups = [], env = {} } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "healvol-"));
  const healDir = path.join(tmp, "state"); fs.mkdirSync(healDir);
  const calls = path.join(tmp, "calls.log"); fs.writeFileSync(calls, "");
  const nodes = [];
  for (const k of ["desk", "game", "personal"]) {
    const dir = path.join(tmp, k, "koinos"); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, ".env"), `BASEDIR=${path.join(tmp, k, "basedir")}\n`);
    fs.writeFileSync(path.join(dir, "docker-compose.override.yml"), `# knode-volume: ${k}-basedir\nservices: {}\n`);
    const log = crash.includes(k) ? [1, 3, 6, 9, 12].map((m) => `${ts(m * 60_000)}.000000 (block_store.Koinos) [main.go:1] <info>: Koinos Block Store v1.1.0`).join("\n") : `${ts(5 * 3600_000)}.0 Koinos Block Store v1.1.0`;
    fs.writeFileSync(path.join(tmp, `${k}-log.txt`), log + "\n");
    fs.writeFileSync(path.join(tmp, `${k}-ls.txt`), backups.filter((b) => b.node === k).map((b) => b.name).join("\n") + "\n");
    nodes.push({ name: `${k} node`, dir, k });
  }
  // A fake docker: answers the helper containers from files, records every call.
  const fakeDocker = path.join(tmp, "docker.sh");
  fs.writeFileSync(fakeDocker, `#!/bin/sh
echo "docker $*" >> "${calls}"
vol=""
for a in "$@"; do case "$a" in *-basedir:/k*) vol="\${a%%-basedir:*}";; esac; done
case "$*" in
  *"tail -c"*) cat "${tmp}/$vol-log.txt";;
  *"ls -1 /k/block_store"*) cat "${tmp}/$vol-ls.txt";;
  *"find /k/block_store/db"*) echo 2000;;
esac
exit 0
`, { mode: 0o755 });
  const fakePs = path.join(tmp, "powershell.sh");
  fs.writeFileSync(fakePs, `#!/bin/sh\necho "powershell $*" >> "${calls}"\necho "DONE. repaired"\nexit 0\n`, { mode: 0o755 });
  const NET = 1_000_000;
  const server = http.createServer((req, res) => {
    let body = ""; req.on("data", (d) => (body += d));
    req.on("end", () => {
      if (req.url.startsWith("/repos/")) { res.writeHead(204); return res.end(); }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { head_topology: { height: String(NET) } } }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const state = { nodes: {} };
  for (const n of nodes) state.nodes[n.name] = { heals: [], height: NET, okRuns: 1 };
  fs.writeFileSync(path.join(healDir, "heal-state.json"), JSON.stringify(state));
  fs.writeFileSync(path.join(healDir, "heal-task.json"), JSON.stringify({ version: 2, limitMinutes: 120 }));
  const run = (args = []) => new Promise((resolve) => execFile(process.execPath, [HEAL, ...args], {
    cwd: tmp,
    env: { PATH: process.env.PATH, HOME: tmp, RPC: `${url}/net`, HEAL_GITHUB_API: url, GITHUB_ALERT_TOKEN: "t", HEAL_DIR: healDir,
      HEAL_DOCKER: fakeDocker, HEAL_POWERSHELL: fakePs, HEAL_DISK_MARGIN_BYTES: "0",
      HEAL_NODES: JSON.stringify(nodes.map((n) => ({ name: n.name, dir: n.dir, rpc: `${url}/${n.k}` }))), ...env },
  }, (err, stdout, stderr) => resolve(stdout + stderr)));
  return { run, calls: () => fs.readFileSync(calls, "utf8"), done: () => new Promise((r) => server.close(r)) };
}

test("heal reads a volume node's block-store log inside the volume and repairs a crash loop from a healthy node", async () => {
  const w = await volumeWorld({ crash: ["game"] });
  try {
    const out = await w.run();
    assert.match(out, /game node: its block store started 5 times/);
    assert.match(w.calls(), /docker run --rm -v game-basedir:\/k:ro alpine:3\.20 sh -c tail -c 400000 \/k\/block_store\/logs\/block_store\.log/);
    assert.match(w.calls(), /find \/k\/block_store\/db \/k\/chain\/blockchain/);   // measured inside the source's volume
    assert.match(w.calls(), /powershell .*-Broken game -From desk/);
    assert.match(out, /desk node: OK/);
  } finally { await w.done(); }
});

test("heal deletes only week-old repair backups inside a volume, by exact name", async () => {
  const old = stampAgo(8 * 24 * 3600_000), fresh = stampAgo(2 * 24 * 3600_000);
  const w = await volumeWorld({ backups: [
    { node: "desk", name: `db-broken-${old}` }, { node: "desk", name: `blockchain-broken-${fresh}` },
    { node: "desk", name: "db" }, { node: "desk", name: "blockchain" }, { node: "desk", name: `db-broken-${old}-x` },
  ] });
  try {
    await w.run();
    const rm = w.calls().split("\n").filter((l) => l.includes("rm -rf"));
    assert.equal(rm.length, 1, rm.join("\n"));
    assert.match(rm[0], new RegExp(`-v desk-basedir:/k alpine:3\\.20 sh -c rm -rf /k/block_store/db-broken-${old}$`));
  } finally { await w.done(); }
});

test("heal --dry-run touches nothing inside a volume", async () => {
  const w = await volumeWorld({ crash: ["desk"], backups: [{ node: "game", name: `db-broken-${stampAgo(9 * 24 * 3600_000)}` }] });
  try {
    const out = await w.run(["--dry-run"]);
    assert.match(out, /\(dry run\) would delete the old repair backup \/k\/block_store\/db-broken-/);
    assert.match(out, /\(dry run\) would repair/);
    assert.doesNotMatch(w.calls(), /rm -rf|powershell/);
  } finally { await w.done(); }
});

// ───────────── the move script end to end (needs PowerShell 7: PWSH=/path/to/pwsh) ─────────────
const PWSH = process.env.PWSH || (() => { try { return execFileSync("sh", ["-c", "command -v pwsh"], { encoding: "utf8" }).trim(); } catch { return ""; } })();

// Fake docker: volumes are folders under vols/; "run" maps the -v mounts onto real folders and runs the sh script there.
function writeFakeDocker(bin, vols, calls, base, failCopy = false) {
  fs.writeFileSync(path.join(bin, "docker"), `#!/bin/bash
echo "docker $*" >> "${calls}"
case "$1" in
  info|pull) exit 0;;
  volume) if [ "$2" = inspect ]; then [ -d "${vols}/$3" ]; exit $?; fi; if [ "$2" = create ]; then mkdir -p "${vols}/$3"; exit 0; fi;;
  compose)
    if [ "$2" = config ]; then if [ -f docker-compose.override.yml ]; then n=$(sed -n 's/^    name: //p' docker-compose.override.yml); echo "volumes:"; echo "  knode-basedir:"; echo "    name: $n"; echo "    external: true"; else echo "volumes: ${base}"; fi; fi
    exit 0;;
  run)
    shift; script=""; declare -A map
    while [ $# -gt 0 ]; do case "$1" in --rm) shift;; -v) spec="$2"; shift 2; dst=$(echo "$spec" | sed -E 's/:ro$//; s/.*:(\\/[a-z]+)$/\\1/'); src="\${spec%:$dst*}"; [ "\${src#/}" = "$src" ] && src="${vols}/$src"; map[$dst]="$src";; alpine*) shift; shift; shift; script="$1"; shift;; *) shift;; esac; done
    for k in "\${!map[@]}"; do script=$(echo "$script" | sed "s#\${k}\\([/ ;]\\|$\\)#\${map[$k]}\\1#g"); done
    ${failCopy ? 'case "$script" in *"cp -a"*) echo "cp failed" >&2; exit 1;; esac' : ""}
    out=$(bash -c "$script"); rc=$?
    for k in "\${!map[@]}"; do out=$(echo "$out" | sed "s#\${map[$k]}#\${k}#g"); done
    [ -n "$out" ] && echo "$out"; exit $rc;;
esac
exit 0
`, { mode: 0o755 });
}

async function moveWorld({ failCopy = false } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "move-"));
  const root = path.join(tmp, "kpred-desk-node"), koinos = path.join(root, "koinos"), base = path.join(root, "basedir");
  for (const d of ["block_store/db", "chain/blockchain", "block_producer", "p2p"]) fs.mkdirSync(path.join(base, d), { recursive: true });
  fs.writeFileSync(path.join(base, "block_store/db/000001.sst"), "x".repeat(5000));
  fs.writeFileSync(path.join(base, "chain/blockchain/000002.sst"), "y".repeat(7000));
  fs.writeFileSync(path.join(base, "block_producer/private.key"), "test-key-not-real");
  fs.mkdirSync(koinos, { recursive: true });
  fs.writeFileSync(path.join(koinos, "docker-compose.yml"), COMPOSE);
  const server = http.createServer((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"jsonrpc":"2.0","id":1,"result":{"head_topology":{"height":"4242"}}}'); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  fs.writeFileSync(path.join(koinos, ".env"), `BASEDIR=${base}\nCOMPOSE_PROJECT_NAME=kpred-desk-node\nJSONRPC_PORT=${server.address().port}\n`);
  const bin = path.join(tmp, "bin"); fs.mkdirSync(bin);
  const vols = path.join(tmp, "vols"); fs.mkdirSync(vols);
  const calls = path.join(tmp, "calls.log"); fs.writeFileSync(calls, "");
  writeFakeDocker(bin, vols, calls, base, failCopy);
  const run = (args) => new Promise((resolve) => execFile(PWSH, ["-NoProfile", "-NonInteractive", "-File", MOVE, ...args], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, KNODE_TEST_ROOTS: JSON.stringify({ desk: root }), KNODE_TEST_FREE_BYTES: String(10 * 2 ** 40), HEAL_DIR: tmp },
    timeout: 120_000,
  }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, out: stdout + stderr })));
  return { tmp, koinos, base, vols, run, calls: () => fs.readFileSync(calls, "utf8"), done: () => new Promise((r) => server.close(r)) };
}

test("move script: -WhatIf changes nothing", { skip: !PWSH && "pwsh not installed" }, async () => {
  const w = await moveWorld();
  try {
    const r = await w.run(["-Node", "desk", "-WhatIf"]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /dry run\) would: copy/);
    assert.equal(fs.existsSync(path.join(w.koinos, "docker-compose.override.yml")), false);
    assert.doesNotMatch(w.calls(), /compose down|volume create|docker run/);
  } finally { await w.done(); }
});

test("move script: copies everything into the volume, checks it, writes the override and starts the node", { skip: !PWSH && "pwsh not installed" }, async () => {
  const w = await moveWorld();
  try {
    const r = await w.run(["-Node", "desk"]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /copy checked: 3 files/);
    assert.match(r.out, /DONE\. The desk node now runs on the Docker volume kpred-desk-node-basedir/);
    const vol = path.join(w.vols, "kpred-desk-node-basedir");
    assert.equal(fs.readFileSync(path.join(vol, "block_producer/private.key"), "utf8"), "test-key-not-real");
    const ov = fs.readFileSync(path.join(w.koinos, "docker-compose.override.yml"), "utf8");
    assert.match(ov, /^# knode-volume: kpred-desk-node-basedir/);
    for (const s of basedirServices(COMPOSE)) assert.match(ov, new RegExp(`\\n  ${s}:\\n    volumes:\\n      - knode-basedir:/koinos`));
    assert.ok(fs.existsSync(path.join(w.base, "block_store/db/000001.sst")), "the old folder is untouched");
    const c = w.calls();
    assert.ok(c.indexOf("compose down") < c.indexOf("cp -a") && c.indexOf("cp -a") < c.indexOf("compose up -d"), c);
    assert.equal(fs.existsSync(path.join(w.tmp, "repair.lock")), false, "lock released");
    // A second run sees the override and does nothing.
    const again = await w.run(["-Node", "desk"]);
    assert.match(again.out, /already runs on the volume/);
  } finally { await w.done(); }
});

test("move script: a failed copy leaves no override and starts the node again on its old folder", { skip: !PWSH && "pwsh not installed" }, async () => {
  const w = await moveWorld({ failCopy: true });
  try {
    const r = await w.run(["-Node", "desk"]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /PROBLEM/);
    assert.equal(fs.existsSync(path.join(w.koinos, "docker-compose.override.yml")), false);
    assert.match(w.calls(), /compose up -d/);
    assert.ok(fs.existsSync(path.join(w.base, "block_producer/private.key")));
    // The half-filled volume is refused without -Resume, emptied and refilled with it (the copy fails again here).
    fs.writeFileSync(path.join(w.vols, "kpred-desk-node-basedir", "partial"), "x");
    const again = await w.run(["-Node", "desk"]);
    assert.match(again.out, /already holds data.*-Resume/s);
  } finally { await w.done(); }
});

// ───────────── the repair script with volumes (needs PowerShell 7) ─────────────
async function repairWorld({ deskVolume }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "repairvol-"));
  const bin = path.join(tmp, "bin"), vols = path.join(tmp, "vols"), calls = path.join(tmp, "calls.log");
  fs.mkdirSync(bin); fs.mkdirSync(vols); fs.writeFileSync(calls, "");
  const fill = (d, tag) => {
    for (const x of ["block_store/db", "chain/blockchain", "block_producer"]) fs.mkdirSync(path.join(d, x), { recursive: true });
    fs.writeFileSync(path.join(d, "block_store/db/1.sst"), tag.repeat(300));
    fs.writeFileSync(path.join(d, "chain/blockchain/2.sst"), tag.repeat(500));
    fs.writeFileSync(path.join(d, "block_producer/private.key"), `key-${tag}`);
  };
  const roots = {};
  for (const [k, vol] of [["desk", deskVolume ? "kpred-desk-node-basedir" : null], ["game", "kpred-node-basedir"]]) {
    const root = path.join(tmp, k); roots[k] = root;
    fs.mkdirSync(path.join(root, "koinos"), { recursive: true });
    if (vol) { fs.writeFileSync(path.join(root, "koinos", "docker-compose.override.yml"), `# knode-volume: ${vol}\n`); fill(path.join(vols, vol), k === "desk" ? "d" : "g"); }
    else fill(path.join(root, "basedir"), "d");
  }
  writeFakeDocker(bin, vols, calls, "/nonexistent");
  const run = (args) => new Promise((resolve) => execFile(PWSH, ["-NoProfile", "-NonInteractive", "-File", REPAIR, ...args], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, KNODE_TEST_ROOTS: JSON.stringify(roots), KNODE_TEST_FREE_BYTES: String(10 * 2 ** 40) },
    timeout: 120_000,
  }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, out: stdout + stderr })));
  return { tmp, vols, roots, run, calls: () => fs.readFileSync(calls, "utf8") };
}

for (const deskVolume of [true, false]) {
  test(`repair script: game (volume) repaired from desk (${deskVolume ? "volume" : "folder"}); keys untouched, old data kept`, { skip: !PWSH && "pwsh not installed" }, async () => {
    const w = await repairWorld({ deskVolume });
    const r = await w.run(["-Broken", "game", "-From", "desk"]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /DONE\. The game node now has the desk node's healthy data/);
    const g = path.join(w.vols, "kpred-node-basedir");
    assert.equal(fs.readFileSync(path.join(g, "block_store/db/1.sst"), "utf8"), "d".repeat(300));
    assert.equal(fs.readFileSync(path.join(g, "block_producer/private.key"), "utf8"), "key-g", "the game node keeps its own key");
    const kept = fs.readdirSync(path.join(g, "block_store")).filter((x) => x.startsWith("db-broken-"));
    assert.equal(kept.length, 1);
    assert.equal(fs.readFileSync(path.join(g, "block_store", kept[0], "1.sst"), "utf8"), "g".repeat(300));
    const c = w.calls();
    assert.ok(c.indexOf("compose down") < c.indexOf("cp -a") && c.indexOf("cp -a") < c.indexOf("compose up -d"), c);
  });
}

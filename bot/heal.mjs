/**
 * NODE SELF-HEALING — runs on your PC every 20 minutes (Windows Task Scheduler; set up with node\install-heal.ps1).
 *
 * For each of your three nodes it compares the node's block height with the Koinos network:
 *   - a node more than 200 blocks (~10 minutes) behind that has NOT moved since the last check (20 minutes ago),
 *     or that doesn't answer at two checks in a row, is frozen → it does a full restart (docker compose down, then up -d);
 *   - a node that is behind but moving is catching up → it's left alone;
 *   - after a restart it waits at least 50 minutes before restarting the same node again;
 *   - if 3 restarts in 6 hours haven't fixed a node, it stops restarting it and emails you to check by hand;
 *   - if a node's block store keeps crashing (3+ starts in 20 minutes: the desk on 2026-10-23, the game on 2026-10-27),
 *     a restart doesn't cure it: the data needs repairing. The nodes then help each other (AUTO-REPAIR): the broken
 *     node's block data is copied from a healthy one with node\repair-node-data.ps1 (both pause ~5-20 minutes):
 *       - the source must be OK (at most 5 blocks behind) at this check and the one before, not restarted in the last
 *         50 minutes, and not repaired or used as a source in the last 6 hours; order: desk, game, personal;
 *       - one repair at a time (lock file node\repair.lock; a lock older than 90 minutes is stale), and while a repair
 *         runs no check restarts the two nodes involved;
 *       - at most one automatic repair per node per 24 hours; after that, or with no healthy source, or too little
 *         free disk, it emails you as before;
 *       - you get an email before it starts and when it ends (with the last lines of node\repair-<node>-<time>.log);
 *       - off switch: HEAL_AUTO_REPAIR=off in .env. It also stays off until node\install-heal.ps1 has been run again
 *         (the scheduled task needs room for a repair: up to 2 hours instead of 15 minutes).
 *     Old "...-broken-<date>" backups that a repair leaves are deleted after 7 days.
 * Every restart (and every problem it can't fix) emails you through GitHub: it starts the "Heal alert" workflow,
 * which fails on purpose, and GitHub emails you about the failed run. That needs GITHUB_ALERT_TOKEN in .env.
 *
 * Run by hand:   node bot\heal.mjs --dry-run      (shows what it would do; restarts, repairs and emails nothing)
 *                node bot\heal.mjs --test-alert   (sends one test email, to check the token works)
 * Log: node\heal.log    State between runs: node\heal-state.json
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = process.env.HEAL_DIR || path.join(ROOT, "node");
const LOG = path.join(DIR, "heal.log");
const STATE = path.join(DIR, "heal-state.json");
const DRY = process.argv.includes("--dry-run");
const TEST_ALERT = process.argv.includes("--test-alert");

const NETWORK_RPC = process.env.RPC || "https://api.koinos.io";
const GITHUB_API = process.env.HEAL_GITHUB_API || "https://api.github.com";
const REPO = process.env.HEAL_REPO || "bawcejawn/Knode";
const BEHIND = 200;                    // blocks (~10 minutes at ~3 s per block)
const COOLDOWN_MS = 50 * 60_000;       // wait after a restart before restarting the same node again
const MAX_HEALS = 3, WINDOW_MS = 6 * 3600_000;
const NAG_MS = 3 * 3600_000;           // repeat an "I can't fix this" email at most every 3 hours
// Auto-repair (block-store crash loop → copy a healthy node's block data over the broken node's).
const LOCK = path.join(DIR, "repair.lock");
const TASK_INFO = path.join(DIR, "heal-task.json");   // written by node\install-heal.ps1 (the task's time limit)
const REPAIR_SCRIPT = process.env.HEAL_REPAIR_SCRIPT || path.join(ROOT, "node", "repair-node-data.ps1");
const POWERSHELL = process.env.HEAL_POWERSHELL || "powershell.exe";
const SOURCE_ORDER = ["desk", "game", "personal"];
const SOURCE_MAX_BEHIND = 5;            // a source must be this close to the network, two checks in a row
const LOCK_STALE_MS = 90 * 60_000;
const REPAIR_GAP_MS = 6 * 3600_000;     // a node repaired, or used as a source, recently is not used as a source
const AUTO_PER_NODE_MS = 24 * 3600_000; // at most one automatic repair per node per 24 hours
const REPAIR_TIMEOUT_MS = 85 * 60_000;
const BACKUP_KEEP_MS = 7 * 24 * 3600_000;
const DISK_MARGIN = process.env.HEAL_DISK_MARGIN_BYTES != null ? Number(process.env.HEAL_DISK_MARGIN_BYTES) : 10 * 2 ** 30;

const NODES = process.env.HEAL_NODES ? JSON.parse(process.env.HEAL_NODES) : [
  { name: "desk node", dir: "C:\\kpred-desk-node\\koinos", rpc: "http://127.0.0.1:8100" },
  { name: "game node", dir: "C:\\kpred-node\\koinos", rpc: "http://127.0.0.1:8080" },
  { name: "personal node", dir: "C:\\koinos-personal\\koinos", rpc: "http://127.0.0.1:8090" },
];

// ───────────── small helpers ─────────────
function loadEnv() {
  const f = path.join(ROOT, ".env");
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
function log(msg) {
  const line = `${stamp()}  ${msg}`;
  console.log(line);
  if (DRY) return;
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.appendFileSync(LOG, line + "\n");
    const lines = fs.readFileSync(LOG, "utf8").split("\n");
    if (lines.length > 3000) fs.writeFileSync(LOG, lines.slice(-2000).join("\n"));
  } catch {}
}
const readState = () => { try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { return { nodes: {} }; } };
const writeState = (s) => { if (!DRY) fs.writeFileSync(STATE, JSON.stringify(s, null, 2)); };

async function height(rpc, timeoutMs = 10_000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(rpc, { method: "POST", signal: ctl.signal, headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "chain.get_head_info", params: {} }) });
    const j = await r.json();
    const h = Number(j?.result?.head_topology?.height);
    if (!Number.isFinite(h) || h <= 0) throw new Error(j?.error?.message || "no height in the answer");
    return h;
  } finally { clearTimeout(t); }
}

function docker(args, cwd) {
  return execFileSync(process.env.HEAL_DOCKER || "docker", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 180_000, windowsHide: true });
}

/** The node's data folder (BASEDIR in its koinos\.env), or null. */
function baseDir(dir) {
  try {
    const env = fs.readFileSync(path.join(dir, ".env"), "utf8");
    const base = (env.match(/^\s*BASEDIR\s*=\s*(.+?)\s*$/m) || [])[1];
    return base ? base.replace(/[\\/]/g, path.sep) : null;
  } catch { return null; }
}

// How many times the node's block store started in the last `ms` (read from its own log file), not counting starts
// before `notBefore` (a repair's end). Docker restarts a crashed block store by itself within seconds, so a crash
// loop shows up here even when the height looks fine.
function blockStoreStarts(dir, ms, notBefore = 0) {
  try {
    const base = baseDir(dir);
    if (!base) return 0;
    const f = path.join(base, "block_store", "logs", "block_store.log");
    const size = fs.statSync(f).size, len = Math.min(size, 400_000);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(f, "r"); fs.readSync(fd, buf, 0, len, size - len); fs.closeSync(fd);
    const since = Math.max(Date.now() - ms, notBefore);
    return buf.toString("utf8").split("\n").filter((l) => l.includes("Koinos Block Store v"))
      .map((l) => Date.parse(l.slice(0, 19).replace(" ", "T") + "Z")).filter((t) => t >= since).length;
  } catch { return 0; }
}

// ───────────── auto-repair helpers ─────────────
const keyOf = (n) => String(n.name).split(" ")[0];          // "game node" → "game"
function readLock() {
  try {
    const l = JSON.parse(fs.readFileSync(LOCK, "utf8"));
    if (Date.now() - Number(l.startedAt) > LOCK_STALE_MS) return null;   // stale: a repair can't take this long
    return l;
  } catch { return null; }
}
function dirBytes(d) {
  let total = 0;
  for (const e of fs.readdirSync(d, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) { try { total += fs.statSync(path.join(e.parentPath ?? e.path, e.name)).size; } catch {} }
  }
  return total;
}
function freeBytes(p) {
  if (process.env.HEAL_FAKE_FREE_BYTES != null) return Number(process.env.HEAL_FAKE_FREE_BYTES);
  const s = fs.statfsSync(path.parse(path.resolve(p)).root);
  return Number(s.bavail) * Number(s.bsize);
}
function taskAllowsRepair() {
  try { return Number(JSON.parse(fs.readFileSync(TASK_INFO, "utf8")).limitMinutes) >= 100; } catch { return false; }
}
/** Deletes "db-broken-YYYYMMDD-HHMM" / "blockchain-broken-…" folders (left by a repair) older than 7 days. */
function pruneBackups(n) {
  const base = baseDir(n.dir);
  if (!base) return;
  for (const [sub, name] of [["block_store", "db"], ["chain", "blockchain"]]) {
    const parent = path.join(base, sub);
    let entries = [];
    try { entries = fs.readdirSync(parent, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const m = e.isDirectory() && e.name.match(new RegExp(`^${name}-broken-(\\d{4})(\\d{2})(\\d{2})-(\\d{2})(\\d{2})$`));
      if (!m) continue;
      const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime();   // the script names it in the PC's local time
      if (!(Date.now() - t > BACKUP_KEEP_MS)) continue;
      if (DRY) { log(`(dry run) would delete the old repair backup ${path.join(parent, e.name)}`); continue; }
      try { fs.rmSync(path.join(parent, e.name), { recursive: true, force: true }); log(`${n.name}: deleted the repair backup ${e.name} (older than 7 days)`); }
      catch (err) { log(`${n.name}: couldn't delete the old backup ${e.name}: ${err.message}`); }
    }
  }
}

async function alert(node, detail) {
  const token = process.env.GITHUB_ALERT_TOKEN;
  if (DRY) { log(`(dry run) would email: [${node}] ${detail}`); return; }
  if (!token) { log("No GITHUB_ALERT_TOKEN in .env, so no email was sent."); return; }
  try {
    const r = await fetch(`${GITHUB_API}/repos/${REPO}/actions/workflows/heal-alert.yml/dispatches`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "content-type": "application/json" },
      body: JSON.stringify({ ref: "main", inputs: { node: String(node).slice(0, 100), detail: String(detail).slice(0, 900) } }),
    });
    if (r.status === 204) log(`Email requested through GitHub: [${node}] ${detail}`);
    else log(`GitHub refused the alert (HTTP ${r.status}): ${(await r.text()).slice(0, 200)}. Check GITHUB_ALERT_TOKEN.`);
  } catch (e) { log(`Couldn't reach GitHub to send the alert: ${e.message}`); }
}

// ───────────── main ─────────────
async function main() {
  loadEnv();
  if (TEST_ALERT) { DRY ? log("(dry run) --test-alert does nothing") : await alert("test", "This is a test of the Knode self-healing email. Nothing is wrong."); return; }

  const st = readState();
  st.nodes ??= {};
  const now = Date.now();

  let net;
  try { net = await height(NETWORK_RPC, 20_000); }
  catch (e) { log(`Can't reach the Koinos network (${e.message}). Is the internet down? Skipping this check.`); return; }

  try { docker(["info", "--format", "{{.ServerVersion}}"]); }
  catch {
    log("Docker isn't running, so the nodes can't be checked or restarted.");
    if (!st.dockerAlert || now - st.dockerAlert > NAG_MS) { await alert("Docker", "Docker Desktop isn't running on the PC, so all nodes are stopped. Open Docker Desktop."); st.dockerAlert = now; }
    writeState(st);
    return;
  }
  st.dockerAlert = 0;

  const lock = readLock();
  const crashed = [];   // nodes in a block-store crash loop this run: repaired after every node has been checked
  for (const n of NODES) {
    if (!fs.existsSync(n.dir)) continue;
    const s = (st.nodes[n.name] ??= { heals: [] });
    s.heals = (s.heals || []).filter((t) => now - t < WINDOW_MS);
    pruneBackups(n);
    if (lock && (lock.broken === keyOf(n) || lock.from === keyOf(n))) {
      log(`${n.name}: a repair (${lock.broken} from ${lock.from}) is running since ${new Date(Number(lock.startedAt)).toISOString().slice(11, 16)} UTC; not touching it.`);
      s.okRuns = 0;
      continue;
    }
    const starts = blockStoreStarts(n.dir, 20 * 60_000, Number(s.repairedAt) || 0);
    if (starts >= 3) {
      log(`${n.name}: its block store started ${starts} times in the last 20 minutes (crash loop). Not restarting: that doesn't fix it.`);
      crashed.push({ n, s, starts });
      s.okRuns = 0;
      continue;
    }
    s.loopAlert = 0;
    let local = null, why = "";
    try { local = await height(n.rpc); } catch (e) { why = `doesn't answer on ${n.rpc} (${e.message})`; }
    const behind = local === null ? null : net - local;
    const moved = local !== null && s.height != null && local > s.height;
    // A node that doesn't answer must fail two checks in a row (it may just be starting up, e.g. after a reboot).
    const silentTwice = local === null && s.silent === true;
    s.silent = local === null;
    if (local === null && !silentTwice) { log(`${n.name}: ${why}; checking again next run.`); s.at = now; s.okRuns = 0; continue; }
    const frozen = silentTwice || (behind > BEHIND && s.height != null && !moved);
    if (local !== null && behind > BEHIND && !frozen) why = moved ? `catching up (${behind} blocks behind, moving)` : `${behind} blocks behind; checking again next run`;
    if (local !== null && frozen) why = `${behind} blocks behind and hasn't moved since the last check (still at #${local})`;

    s.okRuns = local !== null && behind <= SOURCE_MAX_BEHIND ? (Number(s.okRuns) || 0) + 1 : 0;
    if (!frozen) {
      log(`${n.name}: ${behind <= BEHIND ? `OK, #${local} (${Math.max(0, behind)} behind the network)` : why}`);
      s.height = local; s.at = now; s.gaveUp = 0;
      continue;
    }
    if (s.heals.length && now - Math.max(...s.heals) < COOLDOWN_MS) {
      log(`${n.name}: ${why}. Restarted ${Math.round((now - Math.max(...s.heals)) / 60000)} min ago; giving it more time.`);
      continue;
    }
    if (s.heals.length >= MAX_HEALS) {
      log(`${n.name}: ${why}. ${s.heals.length} restarts in 6 hours didn't fix it; NOT restarting again.`);
      if (!s.gaveUp || now - s.gaveUp > NAG_MS) {
        await alert(n.name, `${why}. Self-healing restarted it ${s.heals.length} times in 6 hours without success and has stopped trying. Please check it by hand (docker compose logs --tail 40 chain, in ${n.dir}).`);
        s.gaveUp = now;
      }
      continue;
    }
    log(`${n.name}: ${why}. Restarting it (docker compose down, then up -d) ...`);
    let result = "";
    if (DRY) result = "(dry run: not restarted)";
    else {
      try { docker(["compose", "down"], n.dir); docker(["compose", "up", "-d"], n.dir); result = "restarted"; }
      catch (e) { result = `restart FAILED: ${String(e.stderr || e.message).trim().slice(0, 300)}`; }
      s.heals.push(now);
    }
    log(`${n.name}: ${result}`);
    await alert(n.name, `${why}. Self-healing ${result} at ${stamp()}. Check in about 30 minutes that it caught up: npm run ${n.name.startsWith("desk") ? "desk -- node-status" : n.name.startsWith("personal") ? "bot -- node-status personal" : "bot -- node-status"}`);
    s.height = null;   // after a restart, measure afresh
    s.at = now;
  }
  for (const c of crashed) await handleCrashLoop(c, st, now, lock);
  writeState(st);
}

const manualHint = (k) => `powershell -ExecutionPolicy Bypass -File node\\repair-node-data.ps1 -Broken ${k} -From ${k === "desk" ? "game" : "desk"}`;

/** A node in a block-store crash loop: repair it from a healthy node when every safety rule allows, else email. */
async function handleCrashLoop({ n, s, starts }, st, now, lock) {
  const k = keyOf(n);
  const nag = async (reason) => {
    log(`${n.name}: not repairing it automatically: ${reason}`);
    if (!s.loopAlert || now - s.loopAlert > NAG_MS) {
      await alert(n.name, `The block store keeps crashing (${starts} starts in 20 minutes), so the node freezes again and again. A restart doesn't fix this; its data needs repairing. Not repaired automatically: ${reason}. Repair it by hand from a healthy node: ${manualHint(k)}`);
      s.loopAlert = now;
    }
  };
  if (/^(off|0|false|no)$/i.test(String(process.env.HEAL_AUTO_REPAIR || ""))) return nag("auto-repair is switched off (HEAL_AUTO_REPAIR=off)");
  if (!SOURCE_ORDER.includes(k)) return nag(`"${n.name}" isn't one of the desk, game and personal nodes`);
  if (!DRY && !taskAllowsRepair()) return nag("the scheduled task still has its old 15-minute limit; run node\\install-heal.ps1 once to allow repairs");
  if (lock) return nag(`another repair (${lock.broken} from ${lock.from}) is running`);
  s.autoRepairs = (s.autoRepairs || []).filter((t) => now - t < AUTO_PER_NODE_MS);
  if (s.autoRepairs.length) return nag(`it was already repaired automatically in the last 24 hours`);
  const byKey = new Map(NODES.filter((m) => fs.existsSync(m.dir)).map((m) => [keyOf(m), m]));
  let src = null;
  for (const sk of SOURCE_ORDER) {
    const m = byKey.get(sk);
    if (!m || sk === k) continue;
    const ms = st.nodes[m.name] || {};
    const fresh = (t) => t && now - Number(t) < REPAIR_GAP_MS;
    if ((Number(ms.okRuns) || 0) < 2) continue;                                        // OK now and at the check before
    if ((ms.heals || []).some((t) => now - t < COOLDOWN_MS)) continue;                 // restarted recently
    if (fresh(ms.repairedAt) || fresh(ms.sourceAt)) continue;                           // repaired or used as a source recently
    src = m; break;
  }
  if (!src) return nag("no other node has been healthy for two checks in a row");
  // Free disk: the copy needs the source's two databases plus room to spare (the script checks again).
  try {
    const base = baseDir(src.dir);
    if (!base) return nag(`the ${src.name}'s data folder is unknown (no BASEDIR in ${path.join(src.dir, ".env")})`);
    const need = dirBytes(path.join(base, "block_store", "db")) + dirBytes(path.join(base, "chain", "blockchain")) + DISK_MARGIN;
    const free = freeBytes(base);
    if (free < need) return nag(`not enough free disk space (need ${(need / 2 ** 30).toFixed(0)} GB, have ${(free / 2 ** 30).toFixed(0)} GB)`);
  } catch (e) { return nag(`couldn't check the free disk space (${e.message})`); }

  const sk = keyOf(src);
  const what = `Repairing the ${n.name} from the ${src.name}: both pause for about 5-20 minutes`;
  if (DRY) { log(`(dry run) would repair: ${what} (${REPAIR_SCRIPT} -Broken ${k} -From ${sk})${taskAllowsRepair() ? "" : ". Note: the scheduled task can't run a repair until node\\install-heal.ps1 is run again"}`); return; }
  // Take the lock (only if nobody else did in the meantime).
  try { fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, startedAt: Date.now(), broken: k, from: sk }), { flag: "wx" }); }
  catch {
    const l = readLock();
    if (l) return nag(`another repair (${l.broken} from ${l.from}) is running`);
    fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, startedAt: Date.now(), broken: k, from: sk }));   // replaces a stale lock
  }
  s.autoRepairs.push(now);
  writeState(st);   // the 24-hour limit holds even if this run is cut short
  log(`${what} ...`);
  await alert(n.name, `${what}. The block store kept crashing (${starts} starts in 20 minutes); its data is being copied from the ${src.name}. You'll get another email when it's done.`);
  const stampName = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
  const logFile = path.join(DIR, `repair-${k}-${stampName}.log`);
  let out = "", ok = false;
  try {
    const r = spawnSync(POWERSHELL, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", REPAIR_SCRIPT, "-Broken", k, "-From", sk],
      { encoding: "utf8", timeout: REPAIR_TIMEOUT_MS, windowsHide: true, maxBuffer: 16 * 2 ** 20 });
    out = `${r.stdout || ""}${r.stderr || ""}${r.error ? `\n${r.error.message}` : ""}`;
    ok = r.status === 0 && /DONE\./.test(out);
  } catch (e) { out = String(e.message || e); }
  finally {
    try { fs.writeFileSync(logFile, out); } catch {}
    try { fs.unlinkSync(LOCK); } catch {}
  }
  const tail = out.trim().split(/\r?\n/).slice(-6).join(" | ").slice(0, 600);
  const done = Date.now();
  s.repairedAt = done; s.loopAlert = 0; s.height = null; s.okRuns = 0;
  const ss = (st.nodes[src.name] ??= { heals: [] });
  ss.sourceAt = done; ss.height = null; ss.okRuns = 0;
  log(`${n.name}: repair ${ok ? "finished" : "FAILED"} (log: ${logFile})`);
  await alert(n.name, ok
    ? `Repair finished: the ${n.name} now has the ${src.name}'s block data and both are running again. Check in about 15 minutes: node bot\\heal.mjs --dry-run. Log: ${logFile}. Last lines: ${tail}`
    : `Repair FAILED: ${tail}. Both nodes were started again. Log: ${logFile}. Ask Claude, or try by hand: ${manualHint(k)}`);
}

main().catch((e) => { log(`Self-healing check crashed: ${e.message}`); process.exitCode = 1; });

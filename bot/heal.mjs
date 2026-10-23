/**
 * NODE SELF-HEALING — runs on your PC every 20 minutes (Windows Task Scheduler; set up with node\install-heal.ps1).
 *
 * For each of your three nodes it compares the node's block height with the Koinos network:
 *   - a node more than 200 blocks (~10 minutes) behind that has NOT moved since the last check (20 minutes ago),
 *     or that doesn't answer at two checks in a row, is frozen → it does a full restart (docker compose down, then up -d);
 *   - a node that is behind but moving is catching up → it's left alone;
 *   - after a restart it waits at least 50 minutes before restarting the same node again;
 *   - if 3 restarts in 6 hours haven't fixed a node, it stops restarting it and emails you to check by hand.
 * Every restart (and every problem it can't fix) emails you through GitHub: it starts the "Heal alert" workflow,
 * which fails on purpose, and GitHub emails you about the failed run. That needs GITHUB_ALERT_TOKEN in .env.
 *
 * Run by hand:   node bot\heal.mjs --dry-run      (shows what it would do; restarts nothing, emails nothing)
 *                node bot\heal.mjs --test-alert   (sends one test email, to check the token works)
 * Log: node\heal.log    State between runs: node\heal-state.json
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(ROOT, "node");
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
  return execFileSync("docker", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 180_000, windowsHide: true });
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

  for (const n of NODES) {
    if (!fs.existsSync(n.dir)) continue;
    const s = (st.nodes[n.name] ??= { heals: [] });
    s.heals = (s.heals || []).filter((t) => now - t < WINDOW_MS);
    let local = null, why = "";
    try { local = await height(n.rpc); } catch (e) { why = `doesn't answer on ${n.rpc} (${e.message})`; }
    const behind = local === null ? null : net - local;
    const moved = local !== null && s.height != null && local > s.height;
    // A node that doesn't answer must fail two checks in a row (it may just be starting up, e.g. after a reboot).
    const silentTwice = local === null && s.silent === true;
    s.silent = local === null;
    if (local === null && !silentTwice) { log(`${n.name}: ${why}; checking again next run.`); s.at = now; continue; }
    const frozen = silentTwice || (behind > BEHIND && s.height != null && !moved);
    if (local !== null && behind > BEHIND && !frozen) why = moved ? `catching up (${behind} blocks behind, moving)` : `${behind} blocks behind; checking again next run`;
    if (local !== null && frozen) why = `${behind} blocks behind and hasn't moved since the last check (still at #${local})`;

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
  writeState(st);
}

main().catch((e) => { log(`Self-healing check crashed: ${e.message}`); process.exitCode = 1; });

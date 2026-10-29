/**
 * DAILY QUESTION RELEASE — backup starter, runs on your PC every 5 minutes (Windows Task Scheduler; set up with
 * node\install-release-kick.ps1). It does nothing except around release time, Monday to Saturday:
 *
 *   11:50-11:58 UTC   starts the bot on GitHub ("Kpred bot", Run workflow) unless one is already running. The bot
 *                     waits for 12:00 UTC on its own and posts the day's questions on the dot. GitHub also starts this
 *                     run itself at 11:48, but GitHub often starts scheduled runs late (38 minutes on 2026-10-28).
 *   12:06-14:00 UTC   checks that today's question file is on GitHub. If not, and no bot run is going, it starts one
 *                     (at most every 12 minutes). If they are still not out at 12:20, it emails you, once a day.
 *
 * It needs GITHUB_ALERT_TOKEN in .env (the same token as the self-heal emails: Actions read and write on the repo).
 * The token can only start the repository's own workflows on main; it can't read secrets or change any file.
 *
 * Run by hand:   node bot\release-kick.mjs --dry-run   (shows what it would do now; starts nothing, emails nothing)
 *                node bot\release-kick.mjs --at 2026-10-29T11:52:00Z --dry-run   (as if it were that time)
 * Log: node\release-kick.log    State between runs: node\release-kick-state.json
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(ROOT, "node");
const LOG = path.join(DIR, "release-kick.log");
const STATE = path.join(DIR, "release-kick-state.json");
const DRY = process.argv.includes("--dry-run");
const AT = (() => { const i = process.argv.indexOf("--at"); return i > 0 ? Date.parse(process.argv[i + 1]) : NaN; })();

const API = process.env.HEAL_GITHUB_API || "https://api.github.com";
const REPO = process.env.HEAL_REPO || "bawcejawn/Knode";
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const RELEASE = 12 * HOUR;                       // 12:00 UTC
const EARLY_FROM = RELEASE - 10 * MIN, EARLY_TO = RELEASE - 2 * MIN;
const CHECK_FROM = RELEASE + 6 * MIN, CHECK_TO = RELEASE + 2 * HOUR;
const ALERT_AFTER = RELEASE + 20 * MIN;
const REKICK_MS = 12 * MIN;

function loadEnv() {
  const f = path.join(ROOT, ".env");
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const stamp = (t = Date.now()) => new Date(t).toISOString().replace("T", " ").slice(0, 19) + " UTC";
function log(msg) {
  const line = `${stamp()}  ${DRY ? "(dry run) " : ""}${msg}`;
  console.log(line);
  if (DRY) return;
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.appendFileSync(LOG, line + "\n");
    const lines = fs.readFileSync(LOG, "utf8").split("\n");
    if (lines.length > 3000) fs.writeFileSync(LOG, lines.slice(-2000).join("\n"));
  } catch {}
}
const readState = () => { try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { return {}; } };
const writeState = (s) => { if (!DRY) fs.writeFileSync(STATE, JSON.stringify(s, null, 2)); };

function genesis() {
  try { return Number(JSON.parse(fs.readFileSync(path.join(ROOT, "game-data", "deployment.json"), "utf8")).genesisTime) || 1792368000000; }
  catch { return 1792368000000; } // 2026-10-19 00:00 UTC (a Monday)
}

async function gh(method, url, body, auth = true) {
  const r = await fetch(`${API}${url}`, {
    method,
    headers: { ...(auth ? { authorization: `Bearer ${process.env.GITHUB_ALERT_TOKEN}` } : {}), accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r;
}

/** Is a "Kpred bot" run queued or running right now? (Started after `since`, so a stale run doesn't count.) */
async function botRunGoing(since) {
  const r = await gh("GET", `/repos/${REPO}/actions/workflows/bot.yml/runs?per_page=10`);
  if (!r.ok) throw new Error(`GitHub said ${r.status} listing bot runs`);
  const runs = (await r.json()).workflow_runs || [];
  return runs.find((x) => x.status !== "completed" && Date.parse(x.created_at) >= since - 3 * HOUR) || null;
}

/** Today's question file on main: null (not there), or { n: number of questions, skipped }. */
async function todaysFile(label) {
  // Read without the token: the repository is public, and the token only has Actions permission.
  const r = await gh("GET", `/repos/${REPO}/contents/game-data/questions/${label}.json?ref=main`, null, false);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub said ${r.status} reading ${label}.json`);
  const j = await r.json();
  const d = JSON.parse(Buffer.from(j.content || "", "base64").toString("utf8") || "{}");
  return { n: (d.questions || []).length, skipped: d.skipped || "" };
}

async function startBot(why) {
  if (DRY) { log(`would start the bot on GitHub: ${why}`); return true; }
  const r = await gh("POST", `/repos/${REPO}/actions/workflows/bot.yml/dispatches`, { ref: "main" });
  if (r.status === 204) { log(`started the bot on GitHub: ${why}`); return true; }
  log(`GitHub refused to start the bot (HTTP ${r.status}): ${(await r.text()).slice(0, 200)}. Check GITHUB_ALERT_TOKEN.`);
  return false;
}

async function alert(detail) {
  if (DRY) { log(`would email: ${detail}`); return; }
  const r = await gh("POST", `/repos/${REPO}/actions/workflows/heal-alert.yml/dispatches`, { ref: "main", inputs: { node: "daily questions", detail: detail.slice(0, 900) } });
  log(r.status === 204 ? `emailed you: ${detail}` : `couldn't email (HTTP ${r.status})`);
}

async function main() {
  loadEnv();
  const now = Number.isFinite(AT) ? AT : Date.now();
  const g = genesis();
  if (now < g) return;
  const d = Math.floor((now - g) / DAY), dd = d % 7, w = Math.floor(d / 7);
  if (dd >= 6) return;                               // Sunday: results day, no questions
  const dayStart = g + d * DAY, t = now - dayStart;  // t = time of day (UTC) in ms
  const inEarly = t >= EARLY_FROM && t < EARLY_TO, inCheck = t >= CHECK_FROM && t < CHECK_TO;
  if (!inEarly && !inCheck) return;                  // the rest of the day: nothing to do (and nothing logged)
  if (!process.env.GITHUB_ALERT_TOKEN) { log("No GITHUB_ALERT_TOKEN in .env, so the bot can't be started from here."); return; }

  const label = `W${String(w).padStart(3, "0")}-D${dd + 1}`;
  const day = new Date(dayStart).toISOString().slice(0, 10);
  const st = readState();
  if (st.day !== day) { st.day = day; st.early = 0; st.lastKick = 0; st.alerted = false; st.done = false; }
  if (st.done) return;

  try {
    if (inEarly) {
      if (st.early) return;
      const going = await botRunGoing(now);
      if (going) log(`${label}: a bot run is already ${going.status} (started ${going.created_at}); it will post at 12:00 UTC`);
      else if (await startBot(`${label} release (the bot waits for 12:00 UTC)`)) st.lastKick = now;
      else return; // couldn't start it: try again in 5 minutes
      st.early = now;
      return;
    }
    // After 12:06: are today's questions out?
    const f = await todaysFile(label);
    if (f && f.n > 0) { log(`${label}: ${f.n} questions are out`); st.done = true; return; }
    if (f && f.skipped) {
      log(`${label}: the bot skipped today (${f.skipped})`);
      if (!st.alerted) { await alert(`${label}: the bot skipped today's questions ("${f.skipped}"). Please check the Kpred bot runs on GitHub.`); st.alerted = true; }
      st.done = true;
      return;
    }
    const going = await botRunGoing(now);
    if (going) log(`${label}: not out yet; a bot run is ${going.status} (started ${going.created_at})`);
    else if (now - (st.lastKick || 0) >= REKICK_MS) { if (await startBot(`${label} questions are not out yet`)) st.lastKick = now; }
    else log(`${label}: not out yet; started the bot ${Math.round((now - st.lastKick) / MIN)} min ago, waiting for it`);
    if (t >= ALERT_AFTER && !st.alerted) {
      await alert(`${label}: today's questions are not out yet at ${stamp(now)} (they're due at 12:00 UTC). ${going ? `A bot run is ${going.status}.` : "No bot run is going; one was started."} Check the Kpred bot runs on GitHub.`);
      st.alerted = true;
    }
  } finally { writeState(st); }
}

main().catch((e) => { log(`release check failed: ${e.message}`); process.exitCode = 1; });

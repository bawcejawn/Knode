// Shared helpers for the Last Node Standing publish tests: the REAL publish shell from lastnode.yml run against a
// throwaway bare repository, the recorder-shaped day files and boards it checks, and the race-card folder.
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync, spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PY, withBash } from "./lib/platform.mjs";
export const APP = process.env.APP || fileURLToPath(new URL("../..", import.meta.url));
await import(pathToFileURL(path.resolve(APP, "race-math.js")).href); await import(pathToFileURL(path.resolve(APP, "lastnode-math.js")).href);
const L = globalThis.KLastNode;
export const A = (c) => "1" + c.repeat(33);
export const P1 = A("P"), P2 = A("Q"), P3 = A("R"), P4 = A("S");
export const yml = fs.readFileSync(path.resolve(APP, ".github/workflows/lastnode.yml"), "utf8");
export const AT = (w, h) => String(L.weekStart(w) + h * 3600000);

// The publish step's real shell against a throwaway bare repository (bash, git): skipped on Windows.
export const linux = withBash;   // the publish job's real shell: Linux (GitHub Actions); skipped on Windows
export function publishScript() {
  const lines = yml.split("\n");
  const i = lines.findIndex((l) => /name:\s*Push games-data\/lastnode/.test(l));
  const r = lines.findIndex((l, j) => j > i && /^\s+run:\s*\|\s*$/.test(l));
  const indent = lines[r + 1].match(/^\s*/)[0].length;
  const out = [];
  for (let j = r + 1; j < lines.length; j++) { const l = lines[j]; if (l.trim() && l.match(/^\s*/)[0].length < indent) break; out.push(l.slice(indent)); }
  const s = out.join("\n");
  assert.match(s, /^remote=.*$/m);
  return s.replace(/^remote=.*$/m, 'remote="$FAKE_REMOTE"').replace(/sleep \$\(\(try \* 5\)\)/g, "sleep 0");
}
// Fix-check N-1: the publish job re-reads what a run adds from two RPC nodes. The tests run a fake Koinos node
// (tests/audit/lib/fake-koinos-rpc.py, its own encoders) answering from a fixture: by default the HONEST chain for the
// days a run names (the blocks and picks dayFile() gives with PICKS), whatever the run's files say.
const servers = [];
process.on("exit", () => { for (const p of servers) try { p.kill(); } catch { /* gone */ } });
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
export function fakeNode(fixtureFile) {
  const portFile = fixtureFile + ".port";
  const p = spawn(PY, ["-I", path.resolve(APP, "tests/audit/lib/fake-koinos-rpc.py"), fixtureFile, portFile], { stdio: "ignore" });
  servers.push(p); p.unref();
  for (let k = 0; k < 500 && !fs.existsSync(portFile); k++) sleepMs(10);
  const port = fs.readFileSync(portFile, "utf8").trim();
  return { a: `http://127.0.0.1:${port}/a`, b: `http://127.0.0.1:${port}/b` };
}
export const PICKS_CONTRACT = A("K");
export const FILLER = A("z");                   // a producer outside the field
/** The honest chain for some days: every window of their whole event (dayFile's blocks, the rest by FILLER) and PICKS. */
export function chainFor(days, { picks = PICKS, boost = {} } = {}) {
  const windows = [], pk = {};
  for (const day of days) {
    const d = dayFile(day, picks, { hours: NODES.length - 1, boost });
    for (const h of d.hours) windows.push({ from: h.from, to: h.to, t0: d.start + h.i * 3600000, counts: h.blocks });
    pk[`13:${L.eventOf(day).round}`] = picks.map(([w, s0, b]) => [w, b ? [s0, b] : [s0], d.start - 3600000]);
  }
  return { windows, picks: pk };
}
/** The race card a day's field comes from (12:00 UTC the day before): the 11 test nodes. */
export function fieldCard(day) {
  const start = Date.parse(`${day}T14:00:00Z`);
  return { at: start - 26 * 3600000, field: NODES.map((a, i) => ({ a, vhp: 2000 - i * 10, k: 600 })), paddock: [] };
}
function cardsOf(dir) {
  const out = [];
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) { const w = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); for (const r of w.races || []) for (const c of r.cards || []) if (c) out.push(c); }
  return out;
}
export function publisher() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lns-pub-"));
  const remote = path.join(root, "remote.git");
  const fixture = path.join(root, "chain.json");
  fs.writeFileSync(fixture, JSON.stringify({ windows: [] }));
  const node = fakeNode(fixture);
  const env = { ...process.env, HOME: root, GIT_CONFIG_NOSYSTEM: "1", FAKE_REMOTE: remote, GH_TOKEN: "x", KG_TEST_NOW: AT(4, 13),
    LASTNODE_RPC: node.a, LASTNODE_RPC_CHECK: node.b, LASTNODE_PICKS: PICKS_CONTRACT };
  execFileSync("git", ["init", "-q", "--bare", remote], { env });
  let n = 0, chainSet = false;
  return {
    remote, env, node,
    /** The chain the fake node answers with from now on (default: the honest chain for each run's days). */
    chain(fx) { fs.writeFileSync(fixture, JSON.stringify(fx)); chainSet = true; },
    publish(files, extraEnv = {}) {
      const t = path.join(root, `run${++n}`), IN = path.join(t, "incoming");
      fs.mkdirSync(path.join(IN, "lastnode", "vault"), { recursive: true });
      for (const [k, v] of Object.entries(files)) fs.writeFileSync(path.join(IN, "lastnode", k), typeof v === "string" ? v : JSON.stringify(v));
      const days = Object.keys(files).filter((k) => /^D\d{4}-\d{2}-\d{2}\.json$/.test(k)).map((k) => k.slice(1, -5));
      if (!chainSet) fs.writeFileSync(fixture, JSON.stringify(chainFor(days)));
      // The race cards: the test's own, plus each day's field card where the test gave none at that time.
      const given = extraEnv.FAKE_RACE ? cardsOf(extraEnv.FAKE_RACE) : [];
      const withField = days.filter((x) => { const v = files[`D${x}.json`]; return v && typeof v === "object" && v.field; });
      const cards = [...given, ...withField.map(fieldCard).filter((c) => !given.some((g) => g.at === c.at))];
      const r = spawnSync("bash", ["-c", publishScript()], { cwd: t, env: { ...env, IN, RUNNER_TEMP: t, ...extraEnv, FAKE_RACE: raceFiles(cards) }, encoding: "utf8" });
      return { status: r.status, out: r.stdout + r.stderr };
    },
    /** Put files on games-data directly, as earlier runs would have published them. */
    seed(files) {
      const w = path.join(root, `seed${++n}`);
      execFileSync("git", ["init", "-q", w], { env });
      const g = (...a) => execFileSync("git", a, { cwd: w, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      try { g("fetch", "-q", remote, "games-data"); g("checkout", "-q", "FETCH_HEAD"); } catch { /* first */ }
      for (const [k, v] of Object.entries(files)) { const f = path.join(w, "lastnode", k); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v)); }
      g("add", "-A"); g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "seed"); g("push", "-q", remote, "HEAD:refs/heads/games-data");
    },
    show: (name) => { try { return execFileSync("git", ["--git-dir", remote, "show", `games-data:lastnode/${name}`], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); } catch { return null; } },
  };
}
export const idx = { v: 1, updated: "x", days: [], contract: null, game: 13 };

// Last week's history (week 3 starts Monday 2026-11-09), made by the real rules: one event, an 11-node field, one cut
// an hour. P1 and P2 ride the winner (10 + 5 = 15), P4's node goes at cut 5 (4), P3's at cut 3 (2).
export const NODES = Array.from({ length: 11 }, (_, i) => A("ABCDEFGHJKL"[i]));
export const CUT_ORDER = NODES.slice(1), WINNER = NODES[0];
export function dayFile(day, pickRows, { hours = 10, extra = {}, raceCard = undefined, boost = {} } = {}) {
  const start = Date.parse(`${day}T14:00:00Z`);
  const field = { at: start - 26 * 3600000, c: 0, fairness: null, nodes: NODES.map((a, i) => ({ a, vhp: 2000 - i * 10, kh: 100, h: 1 })), vt: 21450 };
  // raceCard: the card every window names (fix-check LNF-3/N-4), and the multipliers it lowers. Default: the field's own
  // card (race-data has no later one), which lowers nobody; null: no card named.
  const rc = raceCard === undefined ? fieldCard(day) : raceCard;
  const base = 1000000 + Math.round((start - Date.parse("2026-11-01T14:00:00Z")) / 86400000) * 30000;   // each day its own heights
  const hs = Array.from({ length: hours }, (_, i) => ({ i, from: base + i * 1200, to: base + 1199 + i * 1200, checked: 2,
    // Every field node's blocks in every window, as the recorder keeps them (also after its cut): 100 an hour, the
    // node cut in that hour 0 then; boost: { node: blocks an hour } for a node that signs more.
    blocks: Object.fromEntries(NODES.map((a) => [a, a === CUT_ORDER[i] ? 0 : boost[a] ?? 100])),
    card: rc ? rc.at : null, ...(rc && Object.keys(L.raceCut(field, rc)).length ? { hh: L.raceCut(field, rc) } : {}) }));
  const res = L.cutsFrom(field, hs);
  const picks = { 0: pickRows.map(([w, s0, b]) => (b ? [w, s0, start - 3600000, b] : [w, s0, start - 3600000])) };
  const players = pickRows.map(([w, s0, b]) => ({ a: w, r: L.playerResult(field, res, { start: s0, backup: b || null }) })).filter((x) => x.r.entered)
    .map(({ a, r }) => ({ a, start: r.start, jumpTo: r.jumpTo, out: r.out, survived: r.survived, rode: r.rode, jumped: r.jumped, points: r.points, ranked: true }))
    .sort((x, y) => y.points - x.points || (x.a < y.a ? -1 : 1));
  return { v: 1, day, start, week: L.weekOf(start), field, hours: hs, picks, cuts: res.cuts, standing: res.standing, winner: res.winner, done: res.done, players, ...extra };
}
export const boardOf = (days, final = true, week = 3) => {
  const rows = days.flatMap((d) => d.players.map((p) => ({ player: p.a, points: p.points, rode: p.rode, jumped: p.jumped, ranked: p.ranked })));
  const rk = new Set(rows.filter((x) => x.ranked).map((x) => x.player));
  const view = L.places(L.board(rows)).map((x) => ({ a: x.player, place: x.place, pts: x.pts, rides: x.rides, jumps: x.jumps, events: x.events, ranked: rk.has(x.player) }));
  return { v: 1, updated: "x", today: { rows: [] }, week: { rows: [] }, lastWeek: { week, start: L.weekStart(week), final, rows: view }, allTime: { rows: [] } };
};
export const PICKS = [[P1, WINNER], [P2, WINNER], [P4, CUT_ORDER[4]], [P3, CUT_ORDER[2]]];
export const dayW3 = dayFile("2026-11-10", PICKS);
export const brd = boardOf([dayW3]);
export const vgood = { game: 13, week: 3, final: true, rows: [{ player: P1, points: 15 }, { player: P2, points: 15 }, { player: P3, points: 2 }], first: [], second: [] };
/** A void day file, as the recorder writes for an event it never got a field for. */
export const voidDay = (day, why = "no race card for the field") => { const start = Date.parse(`${day}T14:00:00Z`);
  return { v: 1, day, start, week: L.weekOf(start), field: null, void: why, hours: [], picks: {}, cuts: [], standing: [], winner: null, done: false, players: [] }; };
/** The rest of week 3 after the recorded Tuesday: void (fix-check N-3: a final week has every event finished or void). */
export const REST_W3 = ["2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15"];
export const history = (b = brd, day = dayW3) => ({ "board.json": b, "D2026-11-10.json": day, ...Object.fromEntries(REST_W3.map((x) => [`D${x}.json`, voidDay(x)])),
  "index.json": { ...idx, days: ["2026-11-10", ...REST_W3] } });

// Fix-check LNF-3: each window's lowered multipliers are checked against the real race card in the publish job.
export function raceFiles(cards) {
  // As the race recorder writes them: each card in its race (by the card's time) at its leg's place, in its week's file.
  const M = globalThis.KRaceMath, d = fs.mkdtempSync(path.join(os.tmpdir(), "lns-race-")), weeks = new Map();
  for (const c of cards) {
    const ra = M.raceAt(Number(c.at)), w = M.weekOf(ra.start);
    if (!weeks.has(w)) weeks.set(w, new Map());
    const races = weeks.get(w);
    if (!races.has(ra.id)) races.set(ra.id, { id: ra.id, cards: Array(6).fill(null) });
    races.get(ra.id).cards[M.legOf(ra.start, Number(c.at), 6)] = c;
  }
  for (const [w, races] of weeks) fs.writeFileSync(path.join(d, `W${String(w).padStart(3, "0")}.json`), JSON.stringify({ v: 1, week: w, races: [...races.values()] }));
  return d;
}
export const S10 = Date.parse("2026-11-10T14:00:00Z");
export const grown = { at: S10 - 2 * 3600000, field: NODES.map((a, i) => ({ a, vhp: i === 5 ? 4000 : 2000 - i * 10, k: 600 })), paddock: [] };


/** Week 3 with one node far above its multiplier: the winner signs 160 an hour against 100 expected (watch-and-hold
 *  flags it: z about 6 in the event it won). gamed.chain is the chain that really says so. */
export const dayG = dayFile("2026-11-10", PICKS, { boost: { [WINNER]: 160 } });
export const gamed = { history: () => history(boardOf([dayG]), dayG), chain: () => chainFor(["2026-11-10", ...REST_W3], { boost: { [WINNER]: 160 } }) };

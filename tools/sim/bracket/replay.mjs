// Producer Bracket replay: runs the real recorder (bot/games/bracket.ts) hour by hour over weeks of REAL mainnet blocks
// (data/blocks-compact.csv.gz, moved forward by whole weeks so they land on KnodeGames weeks), with race cards made
// from each hour's trailing 3 days of blocks (a stand-in for the VHP cards), and fake brackets (chalk, underdog,
// random, perfect). Checks every week: seeded, locked, every hour of every round recorded with contiguous heights that
// cover every block of the day, results equal to the shared math run directly on the blocks, final after the
// correction window, the perfect bracket on top with the maximum points, and the publish job's shape check passes.
//   node --import tsx tools/sim/bracket/replay.mjs [weeks=3] [end|start]
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
const REPO = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
const { run } = await import(REPO + "/bot/games/bracket.ts");
const M = globalThis.KRaceMath, B = globalThis.KBracketMath;
const WEEKS = Number(process.argv[2] || 3);
const FROM = process.argv[3] === "start" ? "start" : "end";   // which part of the history: the first weeks or the latest
const H = 3600000, DAY = 24 * H;
const fail = (m) => { console.error("FAIL: " + m); process.exitCode = 1; };

// ── real blocks ──
const lines = zlib.gunzipSync(fs.readFileSync(REPO + "/data/blocks-compact.csv.gz")).toString().split("\n");
const names = lines[0].split(",").slice(1); const [, h0, t0] = lines[1].split(",").map(Number);
const N = lines.length - 3, ts = new Float64Array(N), sg = new Int32Array(N);
let t = t0, n = 0;
for (let i = 2; i < lines.length; i++) { if (!lines[i]) continue; const [s, dt] = lines[i].split(","); t += Number(dt); ts[n] = t; sg[n] = Number(s); n++; }
// shift by whole weeks so the history's first full Monday lands on the Monday of KnodeGames week 1 minus 1 week
const firstMon = Math.ceil((ts[0] - (M.GENESIS % M.WEEK)) / M.WEEK) * M.WEEK + (M.GENESIS % M.WEEK);
const lastMon = Math.floor((ts[n - 1] - (M.GENESIS % M.WEEK)) / M.WEEK) * M.WEEK + (M.GENESIS % M.WEEK);
// a week of history before week 1 for the first cards; "end" replays the latest weeks (bigger fields)
const SHIFT = FROM === "start" ? B.weekStart(1) - (firstMon + M.WEEK) : B.weekStart(WEEKS + 1) - lastMon;
for (let i = 0; i < n; i++) ts[i] += SHIFT;
const heightOf = (i) => h0 + i, idxOf = (h) => h - h0;
console.log(`${n.toLocaleString()} real blocks; replaying weeks 1–${WEEKS} (history shifted ${SHIFT / DAY} days)`);

const node = {
  async head() { throw new Error("given"); },
  async blockTime(h) { const i = idxOf(h); if (i < 0 || i >= n) throw new Error(`no block ${h}`); return ts[i]; },
  async blocks(from, to) { const T = [], who = []; for (let h = from; h <= to; h++) { T.push(ts[idxOf(h)]); who.push(names[sg[idxOf(h)]]); } const signers = [...new Set(who)]; return { ts: T, sig: who.map((a) => signers.indexOf(a)), signers }; },
};
const lb = (x) => { let lo = 0, hi = n; while (lo < hi) { const m = (lo + hi) >> 1; if (ts[m] < x) lo = m + 1; else hi = m; } return lo; };
const headAt = (time) => { const i = lb(time) - 1; return { height: heightOf(i) + 20, time: time + 60000, lib: heightOf(i), libTime: ts[i] }; };

// ── race cards from trailing 3 days of blocks (stand-in for VHP) ──
const raceDir = fs.mkdtempSync(path.join(os.tmpdir(), "replay-race-"));
function cardFor(at) {
  const a = lb(at - 3 * DAY), b = lb(at), cnt = new Map();
  for (let i = a; i < b; i++) cnt.set(names[sg[i]], (cnt.get(names[sg[i]]) || 0) + 1);
  const rows = [...cnt].map(([addr, c]) => ({ a: addr, vhp: c })), tot = rows.reduce((s, r) => s + r.vhp, 0);
  const field = [], paddock = [];
  for (const r of rows.sort((x, y) => y.vhp - x.vhp)) { const k = 7200 * r.vhp / tot; (k >= M.MIN_K ? field : paddock).push({ ...r, k, h: 1 }); }
  return { at, c: 0, blocksPerRace: 7200, fairness: null, field, paddock };
}
for (let w = 0; w <= WEEKS + 1; w++) {
  const races = [];
  for (let s = M.weekStart(w); s < M.weekStart(w + 1); s += M.RACE) races.push({ id: M.raceId(M.raceIndex(s)), start: s, end: s + M.RACE, cards: Array.from({ length: 6 }, (_, l) => cardFor(s + l * H)), result: null });
  fs.writeFileSync(path.join(raceDir, `W${String(w).padStart(3, "0")}.json`), JSON.stringify({ v: 1, week: w, start: M.weekStart(w), end: M.weekStart(w + 1), races }));
}

// ── the truth, straight from the blocks with the shared math ──
function truthOf(w) {
  const s = B.seeding(cardFor(B.seedTime(w))); if (!s.size) return { s, res: null };
  const days = Array.from({ length: B.roundsOf(s.size) }, (_, r) => {
    const d = B.roundDay(w, r), a = lb(d), b = lb(d + DAY);
    const blk = { ts: Array.from(ts.subarray(a, b)), sig: Array.from(sg.subarray(a, b)), signers: names };
    return B.dayIndex(blk, d, Array.from({ length: 24 }, (_, h) => cardFor(d + h * H)));
  });
  return { s, res: B.results(s.seeds, s.size, days) };
}
const truths = new Map();
for (let w = 1; w <= WEEKS; w++) truths.set(w, truthOf(w));

// fake brackets: chalk (0), underdog (all 1s, cleaned up), random, and the perfect one
const P = (i) => ("1BrackxtRp" + String(i).padStart(4, "1").replace(/0/g, "9")).padEnd(34, "x");
const picksOf = async (_node, round) => {
  const w = B.weekOfPicksRound(round), tr = truths.get(w);
  if (!tr || !tr.s.size) return [];
  const size = tr.s.size, nS = tr.s.seeds.length, mk = (fn) => B.encode(B.play(size, nS, fn).rounds, size, nS);
  let x = 12345 + w;
  const rnd = () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; };
  return [
    { player: P(1), number: mk(() => false), time: 1 },
    { player: P(2), number: mk(() => true), time: 2 },
    { player: P(3), number: mk(() => rnd() < 0.5), time: 3 },
    { player: P(4), number: B.encode(tr.res.rounds, size, nS), time: 4 },
  ];
};

// ── run hour by hour ──
const out = process.env.REPLAY_OUT || fs.mkdtempSync(path.join(os.tmpdir(), "replay-bracket-"));
const UNTIL = process.env.REPLAY_UNTIL ? Date.parse(process.env.REPLAY_UNTIL) : null;   // stop early (page fixtures)
fs.mkdirSync(out, { recursive: true });
const log = console.log; console.log = () => {};
let problems = 0;
for (let time = B.seedTime(1) - 2 * H; time <= (UNTIL ?? B.weekStart(WEEKS + 1) + 2 * H); time += H) {
  const r = await run({ p: "main", check: "check", prev: out, out, raceDir, picksContract: null, nodeOf: () => node, picksOf, head: headAt(time + 50 * 60000) });
  problems += r.problems.filter((p) => !p.includes("no race card yet")).length;
}
console.log = log;
if (problems) fail(`${problems} problems reported`);
if (UNTIL) { log(`Stopped at ${new Date(UNTIL).toISOString()}; files in ${out}`); process.exit(process.exitCode || 0); }

for (let w = 1; w <= WEEKS; w++) {
  const wf = JSON.parse(fs.readFileSync(path.join(out, `W${String(w).padStart(3, "0")}.json`), "utf8")), tr = truths.get(w);
  if (!tr.s.size) { if (wf.status !== "none") fail(`week ${w}: expected no bracket`); else log(`week ${w}: no bracket (field ${tr.s.seeds.length + tr.s.out.length})`); continue; }
  if (wf.status !== "final") fail(`week ${w}: status ${wf.status}`);
  if (JSON.stringify(wf.seeding.seeds) !== JSON.stringify(tr.s.seeds)) fail(`week ${w}: seeding differs`);
  for (let r = 0; r < wf.days.length; r++) {
    const d = B.roundDay(w, r), hrs = wf.days[r];
    if (!hrs.every(Boolean)) { fail(`week ${w} round ${r + 1}: hours missing`); continue; }
    for (let h = 1; h < 24; h++) if (hrs[h].from !== hrs[h - 1].to + 1) fail(`week ${w} round ${r + 1}: gap at hour ${h}`);
    if (hrs[0].from !== heightOf(lb(d)) || hrs[23].to !== heightOf(lb(d + DAY) - 1)) fail(`week ${w} round ${r + 1}: heights don't cover the day`);
    const total = hrs.reduce((s, x) => s + x.n, 0); if (total !== lb(d + DAY) - lb(d)) fail(`week ${w} round ${r + 1}: ${total} blocks recorded, ${lb(d + DAY) - lb(d)} on chain`);
  }
  if (JSON.stringify(wf.results.rounds) !== JSON.stringify(tr.res.rounds)) fail(`week ${w}: results differ from the shared math`);
  const pts = Object.fromEntries(wf.points.map((p) => [p[0], p[1]]));
  if (pts[P(4)] !== B.maxPoints(tr.s.size) - B.byesOf(tr.s.size, tr.s.seeds.length).length) fail(`week ${w}: perfect bracket scored ${pts[P(4)]}`);
  const champ = tr.s.seeds[tr.res.rounds.at(-1)[0] - 1];
  log(`week ${w}: ${tr.s.size}-bracket (${tr.s.seeds.length} producers), champion seed ${tr.res.rounds.at(-1)[0]} (${champ.slice(0, 8)}…), points chalk ${pts[P(1)]}, underdog ${pts[P(2)]}, random ${pts[P(3)]}, perfect ${pts[P(4)]}`);
}
const yml = fs.readFileSync(REPO + "/.github/workflows/games.yml", "utf8");
const py = [...yml.matchAll(/<<'PY'\n([\s\S]*?)\n\s*PY\n/g)].map((m) => m[1].split("\n").map((l) => l.replace(/^ {10}/, "")).join("\n")).find((p) => p.includes("bracket files ok"));
try { execFileSync("python3", ["-c", py, out], { stdio: "pipe" }); log("publish shape check: ok"); } catch (e) { fail("publish shape check: " + e.stderr); }
const board = JSON.parse(fs.readFileSync(path.join(out, "board.json"), "utf8"));
log(`all-time board top: ${board.allTime.rows.slice(0, 4).map((r) => `${r.a.slice(0, 11)} ${r.pts}`).join(", ")}`);
log(process.exitCode ? "REPLAY FAILED" : `All replay checks passed (${WEEKS} weeks, files in ${out}).`);

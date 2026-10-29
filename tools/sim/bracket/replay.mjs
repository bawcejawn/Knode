// Producer Bracket replay on REAL mainnet data (option A, exact VHP): runs the real recorder (bot/games/bracket.ts)
// hour by hour over the 8-day mainnet sample (data/bracket-vhp-sample.json.gz: every block's signer, every VHP event,
// every producer's balance read at the end on two nodes; made by tools/sim/bracket/sample-vhp.ts). The sample's times are
// moved so it holds one whole bracket week: seeding Saturday 12:00, lock Sunday 23:55, rounds Monday–Thursday, final.
// The seeding is exact VHP averaged over the day before Saturday 12:00, as the recorder does it. Fake brackets: chalk, underdog, random, perfect.
// Checks: seeded, locked, every hour of every round recorded with contiguous heights covering every block of the day,
// results equal to the shared math run directly on the sample, the perfect bracket on top with the most points, and the
// publish job's shape check passes. Prints the week's matchups with each producer's index.
//   node --import tsx tools/sim/bracket/replay.mjs [sample.json.gz]
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
const REPO = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
const { run } = await import(REPO + "/bot/games/bracket.ts");
const M = globalThis.KRaceMath, B = globalThis.KBracketMath;
const FILE = process.argv[2] || REPO + "/data/bracket-vhp-sample.json.gz";
const H = 3600000, DAY = 24 * H, WK = 3;
const fail = (m) => { console.error("FAIL: " + m); process.exitCode = 1; };

const S = JSON.parse(zlib.gunzipSync(fs.readFileSync(FILE)));
const n = S.blocks.sig.length;
const ts = new Array(n); { let t = S.t0; for (let i = 0; i < n; i++) { t += S.blocks.dts[i]; ts[i] = t; } }
// move the sample so it starts on the Friday 06:00 before week WK's seeding
const SHIFT = B.seedTime(WK) - 30 * H - ts[0];
for (let i = 0; i < n; i++) ts[i] += SHIFT;
const hs = Array.from({ length: n }, (_, i) => S.from + i), names = S.blocks.signers;
const events = [...S.events, ...S.tail].filter((e) => e.src === B.VHP_CONTRACT);
const deltas = B.vhpDeltas(events);
const anchorH = S.balances.primary.before;   // balances were read with the head at this block
const anchors = Object.fromEntries(Object.entries(S.balances.primary.values).map(([a, v]) => [a, { h: anchorH, v: Number(v) }]));
console.log(`Real sample ${S.made}: ${n.toLocaleString()} blocks, ${deltas.length.toLocaleString()} VHP changes, ${Object.keys(anchors).length} producers; replayed as week ${WK + 1} (seeding ${new Date(B.seedTime(WK)).toISOString()})`);
if (ts[n - 1] < B.roundDay(WK, 4) + 13 * H) fail("the sample is too short for a whole week");

const lb = (t) => { let lo = 0, hi = n; while (lo < hi) { const m = (lo + hi) >> 1; if (ts[m] < t) lo = m + 1; else hi = m; } return lo; };
const tailDeltas = new Map(); for (const d of deltas) if (d.h > S.top) { if (!tailDeltas.has(d.h)) tailDeltas.set(d.h, []); tailDeltas.get(d.h).push(d); }
const node = {
  async head() { throw new Error("given"); },
  async blockTime(h) { const i = h - S.from; if (i < 0) return ts[0] - (S.from - h) * 3000; if (i >= n) return ts[n - 1] + (h - S.top) * 3000; return ts[i]; },
  async blockId(h) { return "id" + h; },
  async chain(from, to) {
    const out = { hs: [], ts: [], sig: [], signers: names, ids: [], deltas: [] };
    if (from < S.from) throw new Error(`the sample starts at ${S.from}, asked from ${from}`);
    for (let h = from; h <= to; h++) {
      const i = h - S.from;
      out.hs.push(h); out.ts.push(i < n ? ts[i] : ts[n - 1] + (h - S.top) * 3000); out.sig.push(i < n ? S.blocks.sig[i] : 0); out.ids.push("id" + h);
    }
    out.deltas = deltas.filter((d) => d.h >= from && d.h <= to);
    return out;
  },
  async balance(a) { const an = anchors[a]; return { v: an ? an.v : 0, h: anchorH, id: "id" + anchorH }; },
};
const book = B.vhpBook(anchors, deltas);
const headAt = (t) => { const i = Math.min(n - 1, lb(t + 1) - 1); return { height: hs[i] + 20, time: t + 60000, lib: hs[i], libTime: ts[i] }; };

// ── race cards from exact VHP (a card is a VHP reading; the bracket only uses the one at the seeding) ──
const raceDir = fs.mkdtempSync(path.join(os.tmpdir(), "replay-race-"));
function cardAt(t) {
  const i = lb(t); if (i < B.ACTIVE_BLOCKS || i >= n) return null;
  const act = new Set(); for (let k = i - B.ACTIVE_BLOCKS; k < i; k++) act.add(names[S.blocks.sig[k]]);
  const rows = [...act].map((a) => ({ a, vhp: (book.before(a, hs[i]) ?? 0) / 1e8 })).filter((r) => r.vhp > 0);
  const tot = rows.reduce((s, r) => s + r.vhp, 0), field = [], paddock = [];
  for (const r of rows.sort((x, y) => y.vhp - x.vhp)) { const k = 7200 * r.vhp / tot; (k >= M.MIN_K ? field : paddock).push({ a: r.a, vhp: Math.round(r.vhp * 100) / 100, k, h: 1 }); }
  return { at: t, c: 0, blocksPerRace: 7200, fairness: null, field, paddock };
}
for (let w = WK - 1; w <= WK + 1; w++) {
  const races = [];
  for (let s = M.weekStart(w); s < M.weekStart(w + 1); s += M.RACE) races.push({ id: M.raceId(M.raceIndex(s)), start: s, end: s + M.RACE, cards: Array.from({ length: 6 }, (_, l) => cardAt(s + l * H)), result: null });
  fs.writeFileSync(path.join(raceDir, `W${String(w).padStart(3, "0")}.json`), JSON.stringify({ v: 1, week: w, start: M.weekStart(w), end: M.weekStart(w + 1), races }));
}

// ── the truth, straight from the sample with the shared math ──
const chain = { hs, ts, sig: S.blocks.sig, signers: names };
const seedI = lb(B.seedTime(WK)), sd = B.seeding(B.averageCard(chain, seedI - B.SEED_BLOCKS, seedI, book));
const days = Array.from({ length: B.roundsOf(sd.size) }, (_, r) => B.dayIndex(chain, B.roundDay(WK, r), sd.seeds, book));
const truth = B.results(sd.seeds, sd.size, days);
const nS = sd.seeds.length, mk = (fn) => B.encode(B.play(sd.size, nS, fn).rounds, sd.size, nS);
let x = 12345; const rnd = () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; };
const P = (i) => ("1BrackxtRp" + String(i).padStart(4, "1")).padEnd(34, "x");
const picks = [{ player: P(1), number: mk(() => false), time: 1 }, { player: P(2), number: mk(() => true), time: 2 }, { player: P(3), number: mk(() => rnd() < 0.5), time: 3 }, { player: P(4), number: B.encode(truth.rounds, sd.size, nS), time: 4 }];
const picksOf = async (_n, round) => (B.weekOfPicksRound(round) === WK ? picks : []);

// ── run the recorder hour by hour ──
const out = process.env.REPLAY_OUT || fs.mkdtempSync(path.join(os.tmpdir(), "replay-bracket-"));
fs.mkdirSync(out, { recursive: true });
const log = console.log; console.log = () => {};
let problems = [];
for (let t = B.seedTime(WK) - H; t <= B.roundDay(WK, B.roundsOf(sd.size)) + 13 * H; t += H) {
  const r = await run({ p: "main", check: "check", prev: out, out, raceDir, picksContract: null, nodeOf: () => node, picksOf, stakedOf: async (_n, ps) => ps, head: headAt(t) });
  problems.push(...r.problems);
}
console.log = log;
if (problems.length) fail(`${problems.length} problems reported: ${problems.slice(0, 3).join(" | ")}`);

const wf = JSON.parse(fs.readFileSync(path.join(out, `W${String(WK).padStart(3, "0")}.json`), "utf8"));
if (wf.status !== "final") fail(`status ${wf.status}`);
if (JSON.stringify(wf.seeding.seeds) !== JSON.stringify(sd.seeds)) fail("seeding differs");
for (let r = 0; r < wf.days.length; r++) {
  const d = B.roundDay(WK, r), hrs = wf.days[r];
  if (!hrs.every(Boolean)) { fail(`round ${r + 1}: hours missing`); continue; }
  for (let h = 1; h < 24; h++) if (hrs[h].from !== hrs[h - 1].to + 1) fail(`round ${r + 1}: gap at hour ${h}`);
  if (hrs[0].from !== hs[lb(d)] || hrs[23].to !== hs[lb(d + DAY) - 1]) fail(`round ${r + 1}: heights don't cover the day`);
  const tot = hrs.reduce((s, x) => s + x.n, 0); if (tot !== lb(d + DAY) - lb(d)) fail(`round ${r + 1}: ${tot} blocks recorded, ${lb(d + DAY) - lb(d)} on chain`);
}
if (JSON.stringify(wf.results.rounds) !== JSON.stringify(truth.rounds)) fail("results differ from the shared math");
const pts = Object.fromEntries(wf.points.map((p) => [p[0], p[1]]));
if (pts[P(4)] !== B.maxPoints(sd.size) - B.byesOf(sd.size, nS).length) fail(`perfect bracket scored ${pts[P(4)]}`);

// ── what the week looked like ──
const short = (a) => a.slice(0, 6) + "…";
console.log(`\n${sd.size}-producer bracket, ${nS} producers (${sd.out.length} sat out). Index = blocks signed ÷ expected from exact VHP.`);
for (let r = 0; r < truth.rounds.length; r++) {
  const idx = days[r], prev = r ? truth.rounds[r - 1] : null;
  const pairs = r === 0 ? B.firstRound(sd.size, nS) : Array.from({ length: prev.length / 2 }, (_, m) => [Math.min(prev[2 * m], prev[2 * m + 1]), Math.max(prev[2 * m], prev[2 * m + 1])]);
  const line = pairs.map(([a, b], m) => {
    if (!b) return `${a} bye`;
    const ia = idx.get(sd.seeds[a - 1]), ib = idx.get(sd.seeds[b - 1]), w = truth.rounds[r][m];
    return `${w === a ? "*" : ""}${a} ${short(sd.seeds[a - 1])} ${(ia.index * 100).toFixed(0)}% v ${w === b ? "*" : ""}${b} ${short(sd.seeds[b - 1])} ${(ib.index * 100).toFixed(0)}%`;
  });
  console.log(`  ${B.ROUND_NAMES[sd.size][r]} (${new Date(B.roundDay(WK, r)).toUTCString().slice(0, 3)}): ${line.join(" · ")}`);
}
console.log(`  Champion: seed ${truth.rounds.at(-1)[0]} ${sd.seeds[truth.rounds.at(-1)[0] - 1]}`);
console.log(`  Points: chalk ${pts[P(1)]}, underdog ${pts[P(2)]}, random ${pts[P(3)]}, perfect ${pts[P(4)]} (most possible ${B.maxPoints(sd.size) - B.byesOf(sd.size, nS).length})`);
const higher = truth.rounds.flatMap((ws, r) => ws).length;
const yml = fs.readFileSync(REPO + "/.github/workflows/games.yml", "utf8");
const py = [...yml.matchAll(/<<'PY'\n([\s\S]*?)\n\s*PY\n/g)].map((m) => m[1].split("\n").map((l) => l.replace(/^ {10}/, "")).join("\n")).find((p) => p.includes("bracket files ok"));
try { execFileSync("python3", ["-c", py, out], { stdio: "pipe" }); console.log("Publish shape check: ok"); } catch (e) { fail("publish shape check: " + e.stderr); }
console.log(process.exitCode ? "REPLAY FAILED" : `All replay checks passed (${higher} matchups; files in ${out}).`);

// Producer Bracket on ~100 days of REAL mainnet history with exact VHP (tools/sim/bracket/history-vhp.ts output).
//   node tools/sim/bracket/history-analyze.mjs <folder with history-*.json.gz and anchors.json>
// For every whole KnodeGames week in the history: seed the bracket from exact VHP at Saturday 12:00 (the race field rule:
// at least 10 expected blocks a 6-hour race), play every matchup on exact VHP, and score four kinds of bracket:
// chalk (better seed), underdog, random, and "form" (whoever had the higher index over the 7 days before the seeding).
// Reports: fairness by seed gap (better seed's win rate; fair = 50%), how close matchups are, field size per week, and
// the brackets' points.
import fs from "node:fs"; import path from "node:path"; import zlib from "node:zlib";
const REPO = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
await import(REPO + "/site/race-math.js"); await import(REPO + "/site/bracket-math.js");
const M = globalThis.KRaceMath, B = globalThis.KBracketMath;
const DIR = process.argv[2];
const H = 3600000, DAY = 24 * H;
const pct = (x) => (100 * x).toFixed(1) + "%";

// ── load ──
const files = fs.readdirSync(DIR).filter((f) => /^history-\d+\.json\.gz$/.test(f)).map((f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(DIR, f))))).sort((a, b) => a.from - b.from);
for (const e of fs.readdirSync(DIR).filter((f) => /^error-/.test(f))) console.log("ERROR FILE", e, fs.readFileSync(path.join(DIR, e), "utf8").slice(0, 400));
for (let i = 1; i < files.length; i++) if (files[i].from !== files[i - 1].to + 1) throw new Error(`gap between chunks at ${files[i - 1].to}`);
const A = JSON.parse(fs.readFileSync(path.join(DIR, "anchors.json"), "utf8"));
const from = files[0].from, top = files.at(-1).to, n = top - from + 1;
const hs = new Float64Array(n), ts = new Float64Array(n), sig = new Int32Array(n);
const names = [], nIx = new Map(), deltas = [];
let k = 0;
for (const f of files) {
  let t = f.t0;
  for (let i = 0; i < f.sig.length; i++, k++) {
    t += f.dts[i]; hs[k] = f.from + i; ts[k] = t;
    const a = f.signers[f.sig[i]]; let j = nIx.get(a); if (j === undefined) { j = names.length; names.push(a); nIx.set(a, j); } sig[k] = j;
  }
  for (const [dh, ai, d] of f.ev) deltas.push({ h: f.from + dh, a: f.addrs[ai], d });
}
for (const [h, a, d] of A.tail) deltas.push({ h, a, d });
const anchors = Object.fromEntries(Object.entries(A.primary).map(([a, x]) => [a, { h: x.h, v: Number(x.v) }]));
const disagree = A.checkNode ? Object.keys(A.primary).filter((a) => A.checkNode[a] && A.checkNode[a].h === A.primary[a].h && A.checkNode[a].v !== A.primary[a].v) : [];
console.log(`History ${new Date(ts[0]).toISOString().slice(0, 10)} → ${new Date(ts[n - 1]).toISOString().slice(0, 10)}: ${n.toLocaleString()} blocks, ${deltas.length.toLocaleString()} VHP changes, ${names.length} signers, ${Object.keys(anchors).length} anchored (nodes disagree at the same block: ${disagree.length})`);
const noAnchor = names.filter((a) => !anchors[a]);
if (noAnchor.length) {
  const cnt = new Map(); for (let i = 0; i < n; i++) if (!anchors[names[sig[i]]]) cnt.set(names[sig[i]], (cnt.get(names[sig[i]]) || 0) + 1);
  console.log(`Signers without a balance reading (left out of every total; blocks signed): ${[...cnt].map(([a, c]) => `${a.slice(0, 8)}… ${c}`).join(", ")}`);
}
const book = B.vhpBook(anchors, deltas);
const neg = Object.keys(anchors).filter((a) => (book.before(a, from) ?? 0) < -1);
console.log(`Rebuilt balances below zero at the start (missed events): ${neg.length}`);
// a book that never answers null: signers without a reading count as 0 VHP
const safe = { before: (a, h) => book.before(a, h) ?? 0 };
const chain = { hs, ts, sig, signers: names };
const lb = (t) => { let lo = 0, hi = n; while (lo < hi) { const m = (lo + hi) >> 1; if (ts[m] < t) lo = m + 1; else hi = m; } return lo; };

// ── seeding from exact VHP (the race field rule) ──
function cardAt(t) {
  const i = lb(t); if (i < B.ACTIVE_BLOCKS || i >= n) return null;
  const act = new Set(); for (let j = i - B.ACTIVE_BLOCKS; j < i; j++) act.add(names[sig[j]]);
  const rows = [...act].map((a) => ({ a, vhp: safe.before(a, hs[i]) / 1e8 })).filter((r) => r.vhp > 0);
  const tot = rows.reduce((s, r) => s + r.vhp, 0), field = [], paddock = [];
  for (const r of rows) (7200 * r.vhp / tot >= M.MIN_K ? field : paddock).push(r);
  return { field, paddock };
}
/** Index over [t0, t1) for the given producers (whole hours). */
function indexOver(t0, t1, who) {
  const hours = []; for (let t = t0; t < t1; t += H) hours.push(t);
  const hr = B.exactHours(chain, hours, who, safe);
  const out = new Map(who.map((a) => [a, { blocks: 0, expected: 0 }]));
  for (const x of hr) for (const a of who) { out.get(a).blocks += x.by[a]; out.get(a).expected += x.exp[a]; }
  return out;
}

// ── every whole week ──
const PTS = { chalk: [], underdog: [], random: [], form: [], perfect: [] };
const gap = new Map(), margins = [], sizes = [];
let x = 777; const rnd = () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; };
for (let w = -40; w < 400; w++) {
  const seedT = B.seedTime(w), endT = B.roundDay(w, 5);
  if (seedT - 7 * DAY < ts[0] + B.ACTIVE_BLOCKS * 3000 + H) continue;
  if (B.roundDay(w, 4) + DAY > ts[n - 1]) break;
  const sd = B.seeding(cardAt(seedT));
  sizes.push([new Date(B.weekStart(w)).toISOString().slice(0, 10), sd.size, sd.seeds.length + sd.out.length]);
  if (!sd.size) continue;
  const R = B.roundsOf(sd.size);
  if (B.roundDay(w, R - 1) + DAY > ts[n - 1]) break;
  const days = Array.from({ length: R }, (_, r) => B.dayIndex(chain, B.roundDay(w, r), sd.seeds, safe));
  const res = B.results(sd.seeds, sd.size, days);
  // fairness: every real matchup, by seed gap
  B.play(sd.size, sd.seeds.length, (r, m, a, b) => {
    const won = res.rounds[r][m] === b, g = b - a, e = gap.get(g) || [0, 0];
    e[0] += won ? 0 : 1; e[1]++; gap.set(g, e);
    const ia = days[r].get(sd.seeds[a - 1]).index, ib = days[r].get(sd.seeds[b - 1]).index;
    margins.push(Math.abs(ia - ib));
    return won;
  });
  const form = indexOver(seedT - 7 * DAY, seedT, sd.seeds);
  const fi = (s) => { const f = form.get(sd.seeds[s - 1]); return f.expected > 0 ? f.blocks / f.expected : 0; };
  const nS = sd.seeds.length, sc = (fn) => B.score({ rounds: B.play(sd.size, nS, fn).rounds }, res, sd.size, nS).points;
  PTS.chalk.push(sc(() => false)); PTS.underdog.push(sc(() => true)); PTS.random.push(sc(() => rnd() < 0.5));
  PTS.form.push(sc((r, m, a, b) => fi(b) > fi(a))); PTS.perfect.push(B.score({ rounds: res.rounds }, res, sd.size, nS).points);
  console.log(`  week of ${new Date(B.weekStart(w)).toISOString().slice(0, 10)}: ${sd.size}-bracket (${nS}), champion seed ${res.rounds.at(-1)[0]}; points chalk ${PTS.chalk.at(-1)}, underdog ${PTS.underdog.at(-1)}, random ${PTS.random.at(-1)}, form ${PTS.form.at(-1)} of ${PTS.perfect.at(-1)}`);
}
console.log(`\nField (race-field producers at the Saturday seeding) and bracket size by week: ${sizes.map(([d, s, f]) => `${d.slice(5)} ${f}→${s || "none"}`).join(", ")}`);
const all = [...gap.values()].reduce((t, e) => [t[0] + e[0], t[1] + e[1]], [0, 0]);
console.log(`\nFairness: the better seed won ${pct(all[0] / all[1])} of ${all[1]} real matchups (fair = 50%)`);
for (const g of [...gap.keys()].sort((a, b) => b - a)) { const e = gap.get(g); if (e[1] >= 3) console.log(`  seed gap ${String(g).padStart(2)}: better seed won ${e[0]} of ${e[1]} (${pct(e[0] / e[1])})`); }
margins.sort((a, b) => a - b);
console.log(`Index gap between the two producers in a matchup: median ${(margins[margins.length >> 1] * 100).toFixed(1)} points, under 5 points in ${pct(margins.filter((m) => m < 0.05).length / margins.length)}`);
const avg = (l) => (l.reduce((s, v) => s + v, 0) / l.length).toFixed(1);
console.log(`\nBrackets over ${PTS.chalk.length} real weeks, average points: chalk ${avg(PTS.chalk)}, underdog ${avg(PTS.underdog)}, random ${avg(PTS.random)}, form ${avg(PTS.form)}, perfect ${avg(PTS.perfect)}`);
const beats = PTS.form.filter((v, i) => v > PTS.random[i]).length;
console.log(`Form bracket beat the random one in ${beats} of ${PTS.form.length} weeks (ties ${PTS.form.filter((v, i) => v === PTS.random[i]).length})`);

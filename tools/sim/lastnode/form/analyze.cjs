// Last Node Standing: who wins on real blocks, and why. Data: two recent-blocks snapshots + the week-1 race cards.
const fs = require("fs"), path = require("path");
const REPO = require("path").resolve(__dirname, "../../../..");
require(REPO + "/race-math.js"); require(REPO + "/lastnode-math.js");
const L0 = globalThis.KLastNode, M = globalThis.KRaceMath;
// ── blocks: merge the two snapshots by height ──
const byH = new Map();
for (const f of ["recent1.json", "recent2.json"]) {
  const b = JSON.parse(fs.readFileSync(path.join(__dirname, f)));
  let t = b.t0;
  for (let i = 0; i < b.sig.length; i++) { t += i ? b.dts[i] : 0; byH.set(b.from + i, [t, b.signers[b.sig[i]]]); }
}
const hs = [...byH.keys()].sort((a, b) => a - b);
const ts = hs.map((h) => byH.get(h)[0]), who = hs.map((h) => byH.get(h)[1]);
console.log(`blocks ${hs.length}, heights ${hs[0]}..${hs.at(-1)} (gaps ${hs.at(-1) - hs[0] + 1 - hs.length}), ${new Date(ts[0]).toISOString()} → ${new Date(ts.at(-1)).toISOString()}`);
const lb = (x) => { let lo = 0, hi = ts.length; while (lo < hi) { const m = (lo + hi) >> 1; if (ts[m] < x) lo = m + 1; else hi = m; } return lo; };
const count = (t0, t1, set) => { const c = {}; for (let i = lb(t0); i < ts.length && ts[i] < t1; i++) if (!set || set.has(who[i])) c[who[i]] = (c[who[i]] || 0) + 1; return c; };
// ── the field: the latest race card ──
const W = JSON.parse(fs.readFileSync(path.join(__dirname, "W001.json")));
const cards = W.races.flatMap((r) => (r.cards || []).filter(Boolean));
const card = cards.sort((a, b) => a.at - b.at).at(-1);
const field = L0.makeField(card);
const short = (a) => a.slice(0, 8);
const all = [...card.field, ...(card.paddock || [])], totV = all.reduce((s, x) => s + x.vhp, 0);
const t0 = ts[0], t1 = ts.at(-1), tot = ts.length, act = count(t0, t1 + 1);
console.log(`\nfield ${field.nodes.length}, c ${field.c}, model fairness ${JSON.stringify(field.fairness)}\n`);
console.log("node      VHP share  expected/h  actual/h  reliability  handicap");
const rel = {};
for (const n of field.nodes) {
  const v = all.find((x) => x.a === n.a).vhp, exp = (tot * v) / totV, a = act[n.a] || 0;
  rel[n.a] = a / exp;
  console.log(`${short(n.a)}  ${(100 * v / totV).toFixed(2).padStart(6)}%  ${(exp / ((t1 - t0) / 3600e3)).toFixed(1).padStart(9)}  ${(a / ((t1 - t0) / 3600e3)).toFixed(1).padStart(8)}  ${(100 * a / exp).toFixed(1).padStart(9)}%  ×${n.h}`);
}
// ── replay: every possible start on the real blocks, both timings ──
function replay(R, step) {
  const set = new Set(field.nodes.map((n) => n.a)), wins = {}, seconds = {};
  let n = 0;
  for (let s = Math.ceil(t0 / step) * step; s + (field.nodes.length - 1) * R.CUT <= t1; s += step) {
    const hours = [];
    for (let k = 0; k < field.nodes.length - 1; k++) hours.push({ blocks: count(s + k * R.CUT, s + (k + 1) * R.CUT, set) });
    const res = R.cutsFrom(field, hours);
    wins[res.winner] = (wins[res.winner] || 0) + 1;
    const ru = res.cuts.at(-1).a; seconds[ru] = (seconds[ru] || 0) + 1; n++;
  }
  return { n, wins, seconds };
}
const F = L0.forGame(L0.FAST_GAME);
for (const [name, R, step] of [["real game (hourly cuts), a start every hour", L0, 3600e3], ["fast test (20-min cuts), a start every 20 min", F, 1200e3]]) {
  const r = replay(R, step);
  console.log(`\n${name}: ${r.n} events (overlapping)`);
  for (const nd of field.nodes) console.log(`  ${short(nd.a)}  wins ${String(r.wins[nd.a] || 0).padStart(3)} (${(100 * (r.wins[nd.a] || 0) / r.n).toFixed(0).padStart(2)}%)   2nd ${String(r.seconds[nd.a] || 0).padStart(3)}`);
}
// ── Monte Carlo: Poisson blocks at the VHP rate (the model) vs at each node's real rate ──
const rng = L0.rng(20261029);
function mc(R, mult, T = 20000) {
  const ks = field.nodes.map((n) => n.kh * (R.CUT / 3600e3) * mult(n.a)), wins = new Array(ks.length).fill(0);
  for (let t = 0; t < T; t++) {
    const hours = [];
    for (let k = 0; k < ks.length - 1; k++) { const b = {}; field.nodes.forEach((n, i) => { b[n.a] = rng.poisson(ks[i]); }); hours.push({ blocks: b }); }
    const res = R.cutsFrom(field, hours); wins[field.nodes.findIndex((n) => n.a === res.winner)]++;
  }
  return wins.map((w) => w / T);
}
for (const [name, R] of [["real game", L0], ["fast test", F]]) {
  const fair = mc(R, () => 1), real = mc(R, (a) => rel[a]);
  console.log(`\nMonte Carlo, ${name}: chance to be last standing`);
  console.log("node      at VHP rate   at real rate");
  field.nodes.forEach((n, i) => console.log(`  ${short(n.a)}  ${(100 * fair[i]).toFixed(1).padStart(7)}%   ${(100 * real[i]).toFixed(1).padStart(8)}%`));
}
fs.writeFileSync(path.join(__dirname, "rel.json"), JSON.stringify(rel));

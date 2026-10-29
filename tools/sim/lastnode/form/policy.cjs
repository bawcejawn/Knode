// Policies on real blocks: A = today (VHP card only), B = + 48 h form (reliability), C = B + VHP rebase (only down) at the final check.
const fs = require("fs"), path = require("path");
const REPO = require("path").resolve(__dirname, "../../../..");
require(REPO + "/race-math.js"); require(REPO + "/lastnode-math.js");
const L0 = globalThis.KLastNode;
const byH = new Map();
for (const f of ["recent1.json", "recent2.json"]) { const b = JSON.parse(fs.readFileSync(path.join(__dirname, f))); let t = b.t0; for (let i = 0; i < b.sig.length; i++) { t += i ? b.dts[i] : 0; byH.set(b.from + i, [t, b.signers[b.sig[i]]]); } }
const hs = [...byH.keys()].sort((a, b) => a - b), ts = hs.map((h) => byH.get(h)[0]), who = hs.map((h) => byH.get(h)[1]);
const lb = (x) => { let lo = 0, hi = ts.length; while (lo < hi) { const m = (lo + hi) >> 1; if (ts[m] < x) lo = m + 1; else hi = m; } return lo; };
const count = (t0, t1) => { const c = {}; for (let i = lb(t0); i < ts.length && ts[i] < t1; i++) c[who[i]] = (c[who[i]] || 0) + 1; return c; };
const W = JSON.parse(fs.readFileSync(path.join(__dirname, "W001.json")));
const cards = W.races.flatMap((r) => (r.cards || []).filter(Boolean)).sort((a, b) => a.at - b.at);
const cardAt = (t) => { let c = null; for (const x of cards) if (x.at <= t) c = x; return c; };
const shareOf = (c) => { const all = [...c.field, ...(c.paddock || [])], tot = all.reduce((s, x) => s + x.vhp, 0); return new Map(all.map((x) => [x.a, x.vhp / tot])); };
const H = 3600e3, FORM = 48 * H, RMIN = 0.8, RMAX = 1.2;
function form(tEnd) {          // reliability per node over [tEnd-48h, tEnd), hour by hour against that hour's card
  const A = {}, E = {};
  for (let t = tEnd - FORM; t < tEnd; t += H) {
    const c = cardAt(t) || cards[0], sh = shareOf(c), n = count(t, t + H), N = Object.values(n).reduce((s, x) => s + x, 0);
    for (const [a, s] of sh) { A[a] = (A[a] || 0) + (n[a] || 0); E[a] = (E[a] || 0) + N * s; }
  }
  const r = {}; for (const a in E) r[a] = E[a] > 0 ? Math.min(RMAX, Math.max(RMIN, A[a] / E[a])) : 1; return r;
}
function fieldFor(R, ev, policy) {
  const card = cardAt(ev.cardTime); if (!card) return null;
  if (policy === "A") return L0.makeField(card, 4000);
  const r = form(ev.cardTime);
  let c2 = card;
  if (policy === "C") { const fin = cardAt(ev.lock - 10 * 60e3); const g = new Map(fin.field.concat(fin.paddock || []).map((x) => [x.a, x.vhp]));
    c2 = { ...card, field: card.field.map((x) => ({ ...x, k: x.k * Math.max(1, (g.get(x.a) || x.vhp) / x.vhp) })) }; }
  return L0.makeField({ ...c2, field: c2.field.map((x) => ({ ...x, k: x.k * (r[x.a] ?? 1) })) }, 4000);
}
const t0 = ts[0], t1 = ts.at(-1);
for (const [name, R] of [["fast test (20-min cuts)", L0.forGame(L0.FAST_GAME)], ["real timing (hourly cuts)", L0]]) {
  const step = R === L0 ? H : 20 * 60e3;
  console.log(`\n${name}`);
  const tally = {};
  for (const P of ["A", "B", "C"]) {
    const wins = {}; let n = 0;
    for (let s = Math.ceil(t0 / step) * step; s < t1; s += step) {
      // an event "starting" at s with this game's timing relative to its start
      const real = R.eventOf(s), ev = { start: s, cardTime: s - (real.start - real.cardTime), lock: s - (real.start - real.lock) };
      if (ev.cardTime - FORM < t0 || ev.cardTime < cards[0].at) continue;
      const f = fieldFor(R, ev, P); if (!f) continue;
      if (s + (f.nodes.length - 1) * R.CUT > t1) break;
      const hours = []; for (let k = 0; k < f.nodes.length - 1; k++) hours.push({ blocks: count(s + k * R.CUT, s + (k + 1) * R.CUT) });
      const res = R.cutsFrom(f, hours); wins[res.winner] = (wins[res.winner] || 0) + 1; n++;
    }
    tally[P] = { n, wins };
  }
  const nodes = L0.makeField(cards.at(-1)).nodes.map((x) => x.a);
  console.log("node       A today     B +form     C +form+rebase   (events: " + ["A", "B", "C"].map((p) => tally[p].n).join("/") + ")");
  for (const a of nodes) console.log(a.slice(0, 8), ["A", "B", "C"].map((p) => `${String(tally[p].wins[a] || 0).padStart(4)} (${(100 * (tally[p].wins[a] || 0) / tally[p].n).toFixed(0).padStart(2)}%)`).join("  "));
  const chi = (p) => { const n = tally[p].n, e = n / nodes.length; return nodes.reduce((s, a) => s + ((tally[p].wins[a] || 0) - e) ** 2 / e, 0).toFixed(1); };
  console.log("spread (chi², fair ≈ 9):", ["A", "B", "C"].map((p) => `${p} ${chi(p)}`).join("  "));
}

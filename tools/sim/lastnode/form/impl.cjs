// The built rule (lastnode-math formOf + makeField with form) replayed on real blocks, next to today's rule.
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
const H = 3600e3;
const shareAt = (t) => { let c = null; for (const x of cards) { if (x.at <= t) c = x; else break; } if (!c || t - c.at > 3 * H) return null; const all = [...c.field, ...(c.paddock || [])], tot = all.reduce((s, x) => s + x.vhp, 0); return Object.fromEntries(all.map((x) => [x.a, x.vhp / tot])); };
const cardAt = (t) => { let c = null; for (const x of cards) if (x.at <= t) c = x; return c; };
const R = L0.forGame(L0.FAST_GAME), step = 20 * 60e3, t0 = ts[0], t1 = ts.at(-1);
const tally = { A: {}, B: {} }; let n = 0; const forms = [];
for (let s = Math.ceil(t0 / step) * step; s < t1; s += step) {
  const real = R.eventOf(s), cardTime = s - (real.start - real.cardTime);
  const card = cardAt(cardTime); if (!card) continue;
  const hours = []; for (let k = 0; k < 48; k++) { const a = cardTime - 48 * H + k * H; hours.push(a < t0 ? { blocks: {}, shares: null } : { blocks: count(a, a + H), shares: shareAt(a) }); }
  const form = L0.formOf(hours); if (!form) continue;
  const fA = L0.makeField(card, 4000), fB = L0.makeField(card, 4000, form);
  if (s + (fA.nodes.length - 1) * R.CUT > t1) break;
  const win = []; for (let k = 0; k < fA.nodes.length - 1; k++) win.push({ blocks: count(s + k * R.CUT, s + (k + 1) * R.CUT) });
  for (const [P, f] of [["A", fA], ["B", fB]]) { const r = R.cutsFrom(f, win); tally[P][r.winner] = (tally[P][r.winner] || 0) + 1; }
  n++; forms.push(form);
}
const nodes = L0.makeField(cards.at(-1)).nodes.map((x) => x.a);
console.log(`fast-test starts every 20 min with a full 24 h+ of form: ${n} events (overlapping)\nnode      form(last)   today      with form`);
for (const a of nodes) console.log(a.slice(0, 8), String(forms.at(-1)[a]).padStart(8), ["A", "B"].map((p) => `${String(tally[p][a] || 0).padStart(5)} (${(100 * (tally[p][a] || 0) / n).toFixed(0).padStart(2)}%)`).join("  "));

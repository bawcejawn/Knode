// Is each node's reliability (blocks ÷ its VHP share, hour by hour from the race cards) the same from day to day?
const fs = require("fs"), path = require("path");
const REPO = require("path").resolve(__dirname, "../../../..");
require(REPO + "/race-math.js"); require(REPO + "/lastnode-math.js");
const L0 = globalThis.KLastNode;
const byH = new Map();
for (const f of ["recent1.json", "recent2.json"]) { const b = JSON.parse(fs.readFileSync(path.join(__dirname, f))); let t = b.t0; for (let i = 0; i < b.sig.length; i++) { t += i ? b.dts[i] : 0; byH.set(b.from + i, [t, b.signers[b.sig[i]]]); } }
const hs = [...byH.keys()].sort((a, b) => a - b), ts = hs.map((h) => byH.get(h)[0]), who = hs.map((h) => byH.get(h)[1]);
const W = JSON.parse(fs.readFileSync(path.join(__dirname, "W001.json")));
const cards = W.races.flatMap((r) => (r.cards || []).filter(Boolean)).sort((a, b) => a.at - b.at);
console.log("cards", cards.length, new Date(cards[0].at).toISOString(), "→", new Date(cards.at(-1).at).toISOString());
const cardAt = (t) => { let c = null; for (const x of cards) if (x.at <= t) c = x; return c || cards[0]; };
const shareOf = (c) => { const all = [...c.field, ...(c.paddock || [])], tot = all.reduce((s, x) => s + x.vhp, 0); return new Map(all.map((x) => [x.a, x.vhp / tot])); };
// per hour: actual and expected per node
const H = 3600e3, field = L0.makeField(cards.at(-1)).nodes.map((n) => n.a);
const hourStats = []; // {t, act:{a:n}, exp:{a:x}}
for (let t = Math.ceil(ts[0] / H) * H; t + H <= ts.at(-1); t += H) {
  const act = {}; let N = 0;
  for (let i = 0; i < ts.length; i++) { if (ts[i] < t) continue; if (ts[i] >= t + H) break; act[who[i]] = (act[who[i]] || 0) + 1; N++; }
  const sh = shareOf(cardAt(t)), exp = {}; for (const a of field) exp[a] = N * (sh.get(a) || 0);
  hourStats.push({ t, act, exp });
}
fs.writeFileSync(path.join(__dirname, "hours.json"), JSON.stringify(hourStats));
const days = {};
for (const h of hourStats) { const d = new Date(h.t).toISOString().slice(0, 10); (days[d] = days[d] || []).push(h); }
console.log("\nreliability per UTC day (blocks ÷ VHP share, hour by hour)");
console.log("node     " + Object.keys(days).map((d) => d.slice(5) + `(${days[d].length}h)`).join("  "));
for (const a of field) {
  const row = Object.values(days).map((hs) => { const A = hs.reduce((s, h) => s + (h.act[a] || 0), 0), E = hs.reduce((s, h) => s + h.exp[a], 0); return (100 * A / E).toFixed(1).padStart(9) + "%"; });
  console.log(a.slice(0, 8) + " " + row.join(" "));
}
// hour-to-hour spread vs Poisson
console.log("\nhourly counts: variance ÷ mean (Poisson = 1; higher = clumpier)");
for (const a of field) { const xs = hourStats.map((h) => (h.act[a] || 0) / h.exp[a] * h.exp[a]), m = xs.reduce((s, x) => s + x, 0) / xs.length, v = xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1); console.log(a.slice(0, 8), (v / m).toFixed(2), "zero-block hours:", xs.filter((x) => x === 0).length); }

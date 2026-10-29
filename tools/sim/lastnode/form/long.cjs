// 123 days of real mainnet blocks (June–October): the proposed rule, where each node's expected blocks come from what it
// actually signed in the 48 hours before the field is set. Independent events: real timing (daily) and fast test (every 4 h).
const fs = require("fs"), zlib = require("zlib");
const REPO = require("path").resolve(__dirname, "../../../..");
require(REPO + "/race-math.js"); require(REPO + "/lastnode-math.js");
const L0 = globalThis.KLastNode;
const lines = zlib.gunzipSync(fs.readFileSync(REPO + "/data/blocks-compact.csv.gz")).toString().split("\n");
let signers, t = 0; const ts = [], sg = [];
for (const l of lines) { if (!l) continue; if (l.startsWith("#signers")) { signers = l.split(",").slice(1); continue; } if (l.startsWith("#start")) { t = +l.split(",")[2]; continue; } const [s, dt] = l.split(","); t += +dt; ts.push(t); sg.push(+s); }
const lb = (x) => { let lo = 0, hi = ts.length; while (lo < hi) { const m = (lo + hi) >> 1; if (ts[m] < x) lo = m + 1; else hi = m; } return lo; };
const count = (a, b) => { const c = {}; for (let i = lb(a), j = lb(b); i < j; i++) { const k = signers[sg[i]]; c[k] = (c[k] || 0) + 1; } return c; };
const H = 3600e3;
const mode = process.argv[2] || "form";   // form = 48 h of real blocks; week = a 7-day average (closer to a VHP share that ignores form)
for (const [name, R] of [["real timing (daily, hourly cuts)", L0], ["fast test (every 4 h, 20-min cuts)", L0.forGame(L0.FAST_GAME)]]) {
  const exp = {}, wins = {}, byRel = {}; let n = 0;
  const first = L0.eventOf(ts[0] + 9 * L0.DAY);
  for (let ev = first; ev.start + 11 * R.CUT < ts.at(-1); ev = R.nextEvent(ev)) {
    const tc = ev.cardTime, win = mode === "week" ? 7 * 24 * H : 48 * H, prior = count(tc - win, tc), hrs = win / H;
    // the "card": the 48 h production rate as expected blocks an hour (k is per 10-minute race leg in real cards: ×6)
    const card = { at: tc, field: Object.entries(prior).map(([a, c]) => ({ a, vhp: c, k: (c / hrs) * 6 })) };
    const f = L0.makeField(card, 3000); if (!f) continue;
    const hours = []; for (let k = 0; k < f.nodes.length - 1; k++) hours.push({ blocks: count(ev.start + k * R.CUT, ev.start + (k + 1) * R.CUT) });
    const res = R.cutsFrom(f, hours); if (!res.done) continue;
    n++; wins[res.winner] = (wins[res.winner] || 0) + 1;
    for (const x of f.nodes) exp[x.a] = (exp[x.a] || 0) + 1 / f.nodes.length;
    // did the node that signed most above its 48 h rate in the event win?
  }
  let chi = 0, df = 0; const rows = [];
  for (const a in exp) { if (exp[a] < 5) continue; chi += ((wins[a] || 0) - exp[a]) ** 2 / exp[a]; df++; rows.push([a, wins[a] || 0, exp[a]]); }
  rows.sort((x, y) => y[1] / y[2] - x[1] / x[2]);
  console.log(`\n${name} [${mode}]: ${n} events, chi² ${chi.toFixed(1)} on ${df - 1} degrees of freedom (fair ≈ ${df - 1})`);
  for (const [a, w, e] of rows) console.log(`  ${a.slice(0, 8)}  wins ${String(w).padStart(3)}  fair share ${e.toFixed(1).padStart(5)}  ratio ${(w / e).toFixed(2)}`);
}

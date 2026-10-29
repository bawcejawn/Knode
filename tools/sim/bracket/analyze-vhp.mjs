// Producer Bracket, option A: what the mainnet VHP sample (tools/sim/bracket/sample-vhp.ts) shows.
//   node tools/sim/bracket/analyze-vhp.mjs <vhp-sample.json.gz> [race-data dir]
// 1. Which events exist (census), and which VHP events touch producers.
// 2. Rebuild each producer's VHP before every block from the final balances and the VHP events.
// 3. Check the rebuild against every Producer Race card reading in the window (they read VHP at head at a known time).
// 4. Check the handicap: blocks signed vs blocks expected from exact VHP (active producers' total), per producer.
import fs from "node:fs"; import zlib from "node:zlib"; import path from "node:path";
const [file, raceDir] = process.argv.slice(2);
const S = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)));
const VHP = S.contracts.VHP, E8 = 1e8;
const pct = (x, d = 1) => (100 * x).toFixed(d) + "%";
const n = S.blocks.sig.length, from = S.from;
const ts = new Float64Array(n); { let t = S.t0; for (let i = 0; i < n; i++) { t += S.blocks.dts[i]; ts[i] = t; } }
const signerOf = (i) => S.blocks.signers[S.blocks.sig[i]];
console.log(`Sample ${S.made}: blocks ${from}–${S.top} (${n.toLocaleString()}), ${S.events.length.toLocaleString()} watched events, ${S.tail.length} after the top`);
console.log(`Spot check on the second node: ${S.spot.ranges} ranges, ${S.spot.mismatches.length} mismatches`);
console.log("\n1. Census (source name: count), top 25");
for (const [k, v] of Object.entries(S.census).slice(0, 25)) console.log(`  ${k}: ${v.toLocaleString()}`);

// ── VHP deltas per address ──
const vhpEv = [...S.events, ...S.tail].filter((e) => e.src === VHP);
const kinds = {}; for (const e of vhpEv) kinds[e.name + (e.tx < 0 ? " (block)" : "")] = (kinds[e.name + (e.tx < 0 ? " (block)" : "")] || 0) + 1;
console.log("\nVHP events by kind:", kinds);
const undecoded = vhpEv.filter((e) => e.value === undefined);
if (undecoded.length) console.log(`  ${undecoded.length} VHP events could not be decoded, e.g.`, undecoded[0]);
const delta = (e, a) => { const v = Number(e.value || 0); return (e.to === a ? v : 0) - (e.from === a ? v : 0); };
// block-reward check: does the signer of a block receive VHP in that block's own events?
let rewardHits = 0, rewardBlocks = 0;
const byH = new Map(); for (const e of vhpEv) { if (!byH.has(e.h)) byH.set(e.h, []); byH.get(e.h).push(e); }
for (let i = 0; i < n; i += 97) { rewardBlocks++; const es = byH.get(from + i) || []; if (es.some((e) => e.to === signerOf(i) && e.tx < 0)) rewardHits++; }
console.log(`  Signer receives VHP in its own block's events: ${rewardHits} of ${rewardBlocks} sampled blocks`);

// ── 2. rebuild ──
const bal = S.balances.primary, chk = S.balances.check;
const producers = Object.keys(bal.values);
if (chk) { const diff = producers.filter((a) => chk.values[a] !== bal.values[a]); console.log(`\n2. Final balances: ${producers.length} producers; nodes ${diff.length ? "DIFFER for " + diff.length : "agree"} (heads ${bal.before}–${bal.after} / ${chk.before}–${chk.after})`); }
const movedDuringRead = producers.filter((a) => vhpEv.some((e) => e.h > bal.before && e.h <= bal.after && (e.from === a || e.to === a)));
console.log(`  Producers with a VHP event while the balances were being read: ${movedDuringRead.length} (their rebuild may be off by that event)`);
// balance BEFORE block h = final (after block bal.before) − Σ deltas of events in blocks h … bal.before
const evAfter = new Map(); // address → [ {h, d} ] sorted
for (const e of vhpEv) for (const a of [e.from, e.to]) if (a && bal.values[a] !== undefined && e.h <= bal.before) { if (!evAfter.has(a)) evAfter.set(a, []); evAfter.get(a).push({ h: e.h, d: delta(e, a) }); }
for (const l of evAfter.values()) l.sort((x, y) => x.h - y.h);
/** VHP (in VHP, not satoshi) of a before block h. */
function vhpBefore(a, h) {
  let v = Number(bal.values[a] || 0);
  for (const x of evAfter.get(a) || []) if (x.h >= h) v -= x.d;
  return v / E8;
}
// per-producer timeline as arrays for speed: value before each block index
const series = new Map();
for (const a of producers) {
  const arr = new Float64Array(n), l = evAfter.get(a) || [];
  let v = Number(bal.values[a] || 0); let j = l.length - 1;
  for (const x of l) if (x.h > S.top) v -= x.d;   // events after the sample top (tail) up to the read
  while (j >= 0 && l[j].h > S.top) j--;            // …which are already taken off
  for (let i = n - 1; i >= 0; i--) { const h = from + i; while (j >= 0 && l[j].h >= h && l[j].h <= S.top) { v -= l[j].d; j--; } arr[i] = v / E8; }
  series.set(a, arr);
}
const neg = producers.filter((a) => series.get(a).some((x) => x < -1e-8));
console.log(`  Rebuilt balances going negative (a sign of a missed event): ${neg.length}${neg.length ? " " + neg.join(", ") : ""}`);

// ── 3. against the race cards ──
if (raceDir) {
  let cards = 0, exact = 0, close = 0, worst = [];
  for (const f of fs.readdirSync(raceDir).filter((x) => /^W\d{3}\.json$/.test(x))) {
    const wf = JSON.parse(fs.readFileSync(path.join(raceDir, f), "utf8"));
    for (const r of wf.races || []) for (const c of r.cards || []) {
      if (!c || !(c.at >= ts[0] && c.at <= ts[n - 1])) continue;
      let lo = 0, hi = n; while (lo < hi) { const m = (lo + hi) >> 1; if (ts[m] <= c.at) lo = m + 1; else hi = m; }
      const i = Math.max(0, lo - 1);   // the last block made at or before the card's reading
      for (const row of [...c.field, ...c.paddock]) {
        if (!series.has(row.a)) continue;
        cards++;
        // the reading was at the head when the card was taken: it may sit a few blocks either side of i
        let best = Infinity; for (let k = Math.max(0, i - 40); k <= Math.min(n - 1, i + 40); k++) best = Math.min(best, Math.abs(series.get(row.a)[k] - row.vhp));
        if (best < 0.006) exact++; else if (best / row.vhp < 1e-4) close++; else worst.push([best, row.a, r.id, row.vhp, series.get(row.a)[i]]);
      }
    }
  }
  worst.sort((x, y) => y[0] - x[0]);
  console.log(`\n3. Race card readings in the window: ${cards}; match to 0.01 VHP within ±40 blocks: ${exact}; within 0.01%: ${close}; off: ${worst.length}`);
  for (const w of worst.slice(0, 8)) console.log(`   off by ${w[0].toFixed(2)} VHP: ${w[1]} race ${w[2]} card ${w[3]} rebuilt ${w[4].toFixed(2)}`);
}

// ── 4. the handicap from exact VHP ──
// expected share of block i for producer a = VHP_a(before i) / Σ VHP of producers that signed in the 7,200 blocks before i
const WIN = 7200, last = new Map(); let expd = new Map(), got = new Map(), counted = 0;
const daily = new Map(); // day → Map(a → [got, exp])
for (let i = 0; i < n; i++) {
  const s = signerOf(i);
  if (i >= WIN) {
    const act = [...last].filter(([, j]) => j >= i - WIN).map(([a]) => a).filter((a) => series.has(a));
    const tot = act.reduce((t, a) => t + Math.max(0, series.get(a)[i]), 0);
    if (tot > 0) {
      counted++;
      const d = Math.floor(ts[i] / 864e5); if (!daily.has(d)) daily.set(d, new Map()); const dm = daily.get(d);
      for (const a of act) { const e = Math.max(0, series.get(a)[i]) / tot; expd.set(a, (expd.get(a) || 0) + e); const x = dm.get(a) || [0, 0]; x[1] += e; dm.set(a, x); }
      got.set(s, (got.get(s) || 0) + 1); const x = dm.get(s) || [0, 0]; x[0]++; dm.set(s, x);
    }
  }
  last.set(s, i);
}
console.log(`\n4. Blocks signed ÷ blocks expected from exact VHP, over ${counted.toLocaleString()} blocks (active = signed in the last 7,200 blocks)`);
const rows = [...expd].sort((x, y) => y[1] - x[1]);
for (const [a, e] of rows) console.log(`  ${a.slice(0, 10)}… expected ${e.toFixed(0).padStart(7)} signed ${String(got.get(a) || 0).padStart(7)}  ratio ${((got.get(a) || 0) / e).toFixed(3)}   VHP now ${(Number(bal.values[a]) / E8).toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
const ratios = []; for (const dm of daily.values()) for (const [, [g, e]] of dm) if (e > 40) ratios.push(g / e);
ratios.sort((x, y) => x - y);
console.log(`  Daily ratio spread (producer-days with ≥40 expected): median ${ratios[ratios.length >> 1].toFixed(3)}, 5% ${ratios[Math.floor(ratios.length * .05)].toFixed(3)}, 95% ${ratios[Math.floor(ratios.length * .95)].toFixed(3)}, n=${ratios.length}`);
fs.writeFileSync(process.env.SERIES_OUT || "/dev/null", JSON.stringify({ producers, from, n }));

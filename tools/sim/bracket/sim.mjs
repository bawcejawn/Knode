// Producer Bracket simulation (2026-10-27): head-to-head fairness (plain vs race handicap), real-history backtest, player strategies over a month. Run: node tools/sim/bracket/sim.mjs
import fs from "node:fs"; import zlib from "node:zlib"; import { execSync } from "node:child_process";
const REPO = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
await import(REPO + "/race-math.js");
const M = globalThis.KRaceMath;
const git = (s) => execSync(`git -C ${REPO} show ${s}`, { maxBuffer: 1 << 28 }).toString();
const pct = (x) => (100 * x).toFixed(1) + "%";
const ORDER16 = [1, 16, 8, 9, 5, 12, 4, 13, 6, 11, 3, 14, 7, 10, 2, 15];
const ORDER8 = [1, 8, 4, 5, 3, 6, 2, 7];

// ── today's card ──
const W = JSON.parse(git("race-data:W001.json"));
let card = null; for (const r of W.races) for (const c of r.cards) if (c) card = c;
const field = card.field; // sorted by VHP
const totalVhp = [...field, ...card.paddock].reduce((s, r) => s + r.vhp, 0);
console.log(`Card ${new Date(card.at).toISOString()}  field ${field.length}  c=${card.c}  blocks/race ${card.blocksPerRace}`);

// ── A. reliability: recent blocks vs VHP share ──
const RB = JSON.parse(git("blocks-data:recent-blocks.json"));
const nb = RB.sig.length, cnt = new Map();
for (const s of RB.sig) cnt.set(RB.signers[s], (cnt.get(RB.signers[s]) || 0) + 1);
const rel = new Map();
console.log(`\nA. Reliability over the last ${nb} blocks (~${(nb / 28800).toFixed(1)} days): signed ÷ expected from VHP share`);
field.forEach((r, i) => { const exp = nb * r.vhp / totalVhp, got = cnt.get(r.a) || 0; rel.set(r.a, got / exp); console.log(`  seed ${String(i + 1).padStart(2)} ${r.a.slice(0, 8)}… k/day ${(4 * r.k).toFixed(0).padStart(5)}  rel ${(got / exp).toFixed(3)}`); });

// ── exact 1-v-1 chance (Poisson), tie → underdog (b) ──
function pmf(k) { const lo = Math.max(0, Math.floor(k - 10 * Math.sqrt(k) - 10)), hi = Math.ceil(k + 10 * Math.sqrt(k) + 10); const p = []; let lp = -k + lo * Math.log(k) - lgamma(lo + 1); for (let x = lo; x <= hi; x++) { p.push([x, Math.exp(lp)]); lp += Math.log(k) - Math.log(x + 1); } return p; }
function lgamma(n) { let s = 0; for (let i = 2; i < n; i++) s += Math.log(i); return s; } // n integer
const pmfCache = new Map(); const P = (k) => { const key = k.toFixed(3); if (!pmfCache.has(key)) pmfCache.set(key, pmf(k)); return pmfCache.get(key); };
/** chance the favourite a beats underdog b: steps a*ha > b*hb strictly (tie goes to b). ka,kb = expected blocks that day. */
function favWins(ka, ha, kb, hb) {
  const A = P(ka), B = P(kb); let win = 0;
  // cumulative over B sorted by value
  const Bv = B.map(([x, p]) => [x * hb, p]); const cum = []; let s = 0; for (const [v, p] of Bv) { s += p; cum.push([v, s]); }
  for (const [x, p] of A) { const sa = x * ha; // P(b steps < sa)
    let lo = 0, hi = cum.length; while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m][0] < sa - 1e-9) lo = m + 1; else hi = m; }
    win += p * (lo > 0 ? cum[lo - 1][1] : 0); }
  return win;
}
const kd = field.map((r) => 4 * r.k), kTopD = kd[0];
const hPlain = (i) => kTopD / kd[i];
const hRace = (i) => field[i].h; // the card's race handicap (c = card.c, k per race)
const hRaceDay = (i, c) => M.handicapOf(kd[i], kTopD, c);

console.log(`\nB. Round-of-16 matchups on today's card, chance the HIGHER seed wins (fair = 50%), all producers fully reliable`);
console.log(`  match     blocks/day   plain c=0   race card h (c=${card.c})`);
const pairs16 = []; for (let i = 0; i < 16; i += 2) pairs16.push([ORDER16[i] - 1, ORDER16[i + 1] - 1]);
for (const [a, b] of pairs16) console.log(`  ${String(a + 1).padStart(2)} v ${String(b + 1).padEnd(3)} ${kd[a].toFixed(0).padStart(5)} v ${kd[b].toFixed(0).padEnd(5)}  ${pct(favWins(kd[a], hPlain(a), kd[b], hPlain(b))).padStart(8)}   ${pct(favWins(kd[a], hRace(a), kd[b], hRace(b))).padStart(8)}`);
// worst over every possible pairing in the 16
let worst0 = [0.5, 0, 0], worstR = [0.5, 0, 0];
for (let a = 0; a < 16; a++) for (let b = a + 1; b < 16; b++) { const p0 = favWins(kd[a], hPlain(a), kd[b], hPlain(b)), pr = favWins(kd[a], hRace(a), kd[b], hRace(b)); if (Math.abs(p0 - .5) > Math.abs(worst0[0] - .5)) worst0 = [p0, a, b]; if (Math.abs(pr - .5) > Math.abs(worstR[0] - .5)) worstR = [pr, a, b]; }
console.log(`  Worst pair anywhere in the 16: plain ${pct(worst0[0])} (${worst0[1] + 1} v ${worst0[2] + 1}); race card ${pct(worstR[0])} (${worstR[1] + 1} v ${worstR[2] + 1})`);
// best 1v1 c
console.log(`  1-v-1 trim c (daily k) — mean |higher-seed chance − 50%| over all 120 pairs:`);
for (const c of [-0.5, -0.25, 0, 0.25, 0.5, 1.1]) { let s = 0, n = 0; for (let a = 0; a < 16; a++) for (let b = a + 1; b < 16; b++) { s += Math.abs(favWins(kd[a], hRaceDay(a, c), kd[b], hRaceDay(b, c)) - .5); n++; } console.log(`    c=${String(c).padEnd(5)} ${pct(s / n)}`); }

// ── C. real history backtest (123 days of mainnet blocks) ──
const lines = zlib.gunzipSync(fs.readFileSync(REPO + "/data/blocks-compact.csv.gz")).toString().split("\n");
const signers = lines[0].split(",").slice(1); const [, h0, t0] = lines[1].split(",").map(Number);
let t = t0; const days = new Map();
for (let i = 2; i < lines.length; i++) { if (!lines[i]) continue; const [s, dt] = lines[i].split(","); t += Number(dt); const d = Math.floor(t / 86400000); let m = days.get(d); if (!m) days.set(d, (m = new Float64Array(signers.length))); m[Number(s)]++; }
const dkeys = [...days.keys()].sort((a, b) => a - b).slice(1, -1); // drop partial first/last day
console.log(`\nC. Real mainnet history: ${dkeys.length} full UTC days (${new Date(dkeys[0] * 864e5).toISOString().slice(0, 10)} → ${new Date(dkeys.at(-1) * 864e5).toISOString().slice(0, 10)})`);
// proxy card: trailing 7-day share (VHP history isn't stored); seeds = top 16 by that share
let tot = { p: [0, 0], r: [0, 0] }, bySeedGap = new Map(), outages = [0, 0];
const realDays = [];
for (let di = 7; di < dkeys.length; di++) {
  const trail = new Float64Array(signers.length); for (let j = di - 7; j < di; j++) days.get(dkeys[j]).forEach((v, s) => (trail[s] += v));
  const today = days.get(dkeys[di]), tsum = trail.reduce((a, b) => a + b, 0), dsum = today.reduce((a, b) => a + b, 0);
  const order = [...trail.keys()].filter((s) => trail[s] / tsum * dsum / 4 >= M.MIN_K).sort((a, b) => trail[b] - trail[a]);
  const k = order.map((s) => trail[s] / tsum * dsum); // expected blocks today
  for (let i = 0; i < order.length; i++) { outages[1]++; if (today[order[i]] < 0.5 * k[i]) outages[0]++; }
  realDays.push({ order, k, got: order.map((s) => today[s]) });
  if (order.length < 16) continue;
  const cr = M.calibrate(k.slice(0, 16).map((x) => x / 4), 1500).c;
  for (const [a, b] of pairs16) {
    const p0 = today[order[a]] * (k[0] / k[a]) > today[order[b]] * (k[0] / k[b]);
    const hr = (i) => M.handicapOf(k[i] / 4, k[0] / 4, cr);
    const pr = today[order[a]] * hr(a) > today[order[b]] * hr(b);
    tot.p[0] += p0; tot.p[1]++; tot.r[0] += pr; tot.r[1]++;
    const g = b - a; const e = bySeedGap.get(g) || [0, 0, 0]; e[0] += p0; e[1] += pr; e[2]++; bySeedGap.set(g, e);
  }
}
console.log(`  Higher seed won a round-of-16 day: plain ${pct(tot.p[0] / tot.p[1])}, race handicap ${pct(tot.r[0] / tot.r[1])}  (${tot.p[1]} matchups)`);
for (const g of [...bySeedGap.keys()].sort((a, b) => b - a)) { const e = bySeedGap.get(g); console.log(`    seed gap ${String(g).padStart(2)} (e.g. ${pairs16.find(([a, b]) => b - a === g).map((x) => x + 1).join(" v ")}): plain ${pct(e[0] / e[2])}, race ${pct(e[1] / e[2])}  n=${e[2]}`); }
console.log(`  Producer-days below half their expected blocks (an outage): ${pct(outages[0] / outages[1])} of ${outages[1]}`);
const fieldSizes = realDays.map((d) => d.order.length); console.log(`  Field size (≥10 blocks per race) over history: min ${Math.min(...fieldSizes)}, max ${Math.max(...fieldSizes)}, days <16: ${fieldSizes.filter((x) => x < 16).length}, days <12: ${fieldSizes.filter((x) => x < 12).length}`);

// ── D. players over a month (model with reliability, drift and outages) ──
const R = M.rng(20261027);
const relBase = field.slice(0, 16).map((r) => 1 + 0.8 * (rel.get(r.a) - 1)); // shrink 20% toward 1
const OUT = outages[0] / outages[1];
function bracketWinners(kExp, perDay) { // perDay(day, i) → blocks; returns winners per round (seed indexes)
  let alive = ORDER16.map((s) => s - 1), rounds = [];
  for (let d = 0; d < 4; d++) { const next = []; for (let i = 0; i < alive.length; i += 2) { const a = Math.min(alive[i], alive[i + 1]), b = Math.max(alive[i], alive[i + 1]); const sa = perDay(d, a) * kTopD / kExp[a], sb = perDay(d, b) * kTopD / kExp[b]; next.push(sa > sb ? a : b); } rounds.push(next); alive = next; }
  return rounds; // keep bracket order: next[i] is winner of slot pair i
}
function fill(pickFn) { let alive = ORDER16.map((s) => s - 1), rounds = []; for (let d = 0; d < 4; d++) { const next = []; for (let i = 0; i < alive.length; i += 2) next.push(pickFn(alive[i], alive[i + 1], d)); rounds.push(next); alive = next; } return rounds; }
const PTS = [1, 2, 4, 8], CHAMP = 2;
function score(pick, real) { let s = 0; for (let d = 0; d < 4; d++) { const won = new Set(real[d]); for (const x of pick[d]) if (won.has(x)) s += PTS[d]; } if (pick[3][0] === real[3][0]) s += CHAMP; return s; }
const STRATS = ["random", "chalk (higher seed)", "underdog", "thoughtful (last week's reliability)"];
const res = STRATS.map(() => ({ top30: 0, n: 0, monthWins: 0, pts: 0 }));
const MONTHS = 400, PER = 10;
for (let m = 0; m < MONTHS; m++) {
  let relNow = relBase.map((x) => x * (1 + 0.03 * R.normal()));
  const monthPts = Array.from({ length: STRATS.length * PER }, () => 0);
  for (let w = 0; w < 4; w++) {
    // last week observed (what a thoughtful player can see): 7 days of blocks
    const seen = relNow.map((r, i) => { let g = 0; for (let d = 0; d < 7; d++) g += R.next() < OUT ? 0.2 * kd[i] * r : R.poisson(kd[i] * r); return g / (7 * kd[i]); });
    relNow = relNow.map((x) => Math.max(0.3, x * (1 + 0.03 * R.normal())));
    const real = bracketWinners(kd, (d, i) => R.poisson(kd[i] * relNow[i] * (R.next() < OUT ? 0.2 : 1)));
    // weekly scores per player
    const wk = [];
    for (let s = 0; s < STRATS.length; s++) for (let p = 0; p < PER; p++) {
      const pick = fill((x, y) => { const a = Math.min(x, y), b = Math.max(x, y);
        if (s === 0) return R.next() < 0.5 ? a : b; if (s === 1) return a; if (s === 2) return b;
        const noisy = (i) => seen[i] + 0.02 * R.normal(); return noisy(a) >= noisy(b) ? a : b; });
      const sc = score(pick, real); wk.push(sc); monthPts[s * PER + p] += sc; res[s].pts += sc;
    }
    const sorted = [...wk].sort((a, b) => b - a), cut = sorted[Math.ceil(0.3 * wk.length) - 1];
    wk.forEach((sc, j) => { const s = Math.floor(j / PER); res[s].n++; if (sc >= cut) res[s].top30++; });
  }
  const best = Math.max(...monthPts); const winners = monthPts.map((x, j) => (x === best ? j : -1)).filter((j) => j >= 0);
  for (const j of winners) res[Math.floor(j / PER)].monthWins += 1 / winners.length;
}
console.log(`\nD. ${MONTHS} simulated months × 4 brackets, ${PER} players per strategy (model: today's card, measured reliability shrunk 20%, ±3% weekly drift, outage rate ${pct(OUT)} per producer-day)`);
console.log(`  strategy                               avg pts/week   top 30% of week   wins the month`);
STRATS.forEach((n, s) => console.log(`  ${n.padEnd(38)} ${(res[s].pts / res[s].n).toFixed(1).padStart(8)}   ${pct(res[s].top30 / res[s].n).padStart(12)}   ${pct(res[s].monthWins / MONTHS).padStart(12)}`));
console.log(`  (max per week: 8×1 + 4×2 + 2×4 + 1×8 + 2 = 34)`);

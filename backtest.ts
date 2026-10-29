/**
 * BACKTEST — do our question templates stay unpredictable?   (READ-ONLY, no keys needed)
 * ---------------------------------------------------------------------------------------
 * Replays real chain history. At many past "release" moments it builds each question template
 * exactly as the live generator would (lines and buckets from the realized-rate model below),
 * then checks what actually happened in the observation window.
 *
 * A template PASSES when, over many replays:
 *   - every option won close to 1/k of the time (within ±5 points), and
 *   - the void rule fired on fewer than 5% of questions.
 * Only passing templates are allowed into the daily generator.
 *
 * Run:   npx tsx backtest.ts                (uses 35 days of history; downloads what's missing once)
 *        npx tsx backtest.ts --rate-days 1  (try a different forecast setting)
 *
 * Model (v2, after the first real-data run): each producer's rate comes from the last 2 days, and
 * bucket widths are learned from the last 7 days of the forecast's actual errors. A 4-week average
 * proved far too slow — the producer set shifted within days.
 *
 * Outputs go to ./backtest-output/ (blocks.csv cache, report.json, instances.csv).
 */

import { Provider } from "koilib";
import * as fs from "node:fs";
import * as path from "node:path";

// ───────────────────────── Settings (override with --flags) ─────────────────────────

const DEFAULTS = {
  rpc: "https://koinos.armana.io",
  days: 120, // history to test on (the saved block cache is never trimmed below what it holds)
  rateDays: 2, // eligibility checks (size class, new, drifting, offline) use this many recent days
  coreRateDays: 0.25, // FORECAST rate for core producers: last 6 hours (v5 — 2 days lagged behind outages)
  smallRateDays: 1, // forecast rate for smaller producers (too few blocks in 6 hours to be reliable)
  calibDays: 7, // how far back to learn the forecast's real error (sets bucket widths)
  aggDays: 3, // look-back for network-wide question buckets
  voidAlpha: 0.001,
  minVoidBlocks: 600, // ...and only if the stretch is longer than this (600 blocks ≈ 30 minutes) // void only if a subject's offline stretch has < 0.1% chance of being luck
  reliabilityDays: 14, // look-back for each producer's own void history
  maxVoidHistory: 0.03, // skip a producer whose own past windows would have been voided more than 3% of the time
  cleanDays: 2, // a producer is a subject only after this many days with no offline stretch
  pairCleanDays: 14, // head-to-head subjects need this many clean days (two subjects = twice the void risk)
  maxDrift: 0.25, // skip a producer as subject if its last-12h rate differs from its 2-day rate by more than 25%
  step: 1200, // blocks between replayed release moments (1200 ≈ 1 hour)
  lockBlocks: 14400, // answers stay open this long after release (14,400 ≈ 12 h); the window starts after lock
  batch: 100,
  concurrency: 2,
  minDaily: 1400, // CORE producers sign at least this many blocks/day
  minSmallDaily: 20, // SMALLER producers sign at least this many blocks/day (below that: grouped questions only)
  maxSmallWindow: 86400, // longest window a smaller producer may get (longer windows catch more outages)
  minExpected: 60, // a smaller producer's window is lengthened until at least this many blocks are expected
  tolerance: 0.05, // ±5 points around 1/k
  maxVoid: 0.05, // void rate must stay under 5%
  minInstances: 30, // fewer replays than this = "not enough data"
  out: "backtest-output",
};

const BLOCKS_PER_DAY = 28_800;

function parseArgs(): typeof DEFAULTS {
  const cfg: any = { ...DEFAULTS };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const k2 = key === "trailDays" ? "rateDays" : key; // old flag name still works
    if (!(k2 in DEFAULTS)) throw new Error(`Unknown flag --${argv[i].slice(2)}`);
    cfg[k2] = typeof (DEFAULTS as any)[k2] === "number" ? Number(argv[i + 1]) : argv[i + 1];
    i++;
  }
  return cfg;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fmt = (x: number, d = 0) => (isFinite(x) ? x.toLocaleString("en-US", { maximumFractionDigits: d }) : "n/a");
const pct = (x: number, d = 1) => (isFinite(x) ? (x * 100).toFixed(d) + "%" : "n/a");

async function withRetry<T>(label: string, fn: () => Promise<T>, tries = 6): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= tries) throw new Error(`${label}: ${(err as Error).message}`);
      const wait = 1000 * 2 ** attempt;
      // The public node often refuses a request when busy; a single quiet retry is normal.
      if (attempt >= 2) console.log(`  ${label}: server busy, retry ${attempt} in ${wait / 1000}s ...`);
      await sleep(wait);
    }
  }
}

// ───────────────────────── Lean block cache ─────────────────────────
// The backtest only needs height, time, signer, transaction count and compute per block.

type Blk = { h: number; ts: number; signer: string; ntx: number; compute: number };

function loadCache(cfg: typeof DEFAULTS): Blk[] {
  const csvPath = path.join(cfg.out, "blocks.csv");
  if (fs.existsSync(csvPath)) {
    const lines = fs.readFileSync(csvPath, "utf8").split("\n").filter(Boolean);
    console.log(`Loaded ${fmt(lines.length)} blocks from ${csvPath}.`);
    return lines.map((l) => {
      const [h, ts, signer, ntx, compute] = l.split(",");
      return { h: +h, ts: +ts, signer, ntx: +ntx, compute: +compute };
    });
  }
  return [];
}

function saveCache(cfg: typeof DEFAULTS, blocks: Blk[]) {
  fs.mkdirSync(cfg.out, { recursive: true });
  const csv = blocks.map((b) => `${b.h},${b.ts},${b.signer},${b.ntx},${b.compute}`).join("\n");
  fs.writeFileSync(path.join(cfg.out, "blocks.csv"), csv);
}

function toBlk(item: any): Blk {
  const header = item.block?.header ?? {};
  return {
    h: Number(item.block_height ?? header.height),
    ts: Number(header.timestamp),
    signer: header.signer ?? "unknown",
    ntx: item.block?.transactions?.length ?? 0,
    compute: Number(item.receipt?.compute_bandwidth_used ?? 0),
  };
}

async function fetchRange(provider: Provider, headId: string, from: number, to: number, cfg: typeof DEFAULTS) {
  const starts: number[] = [];
  for (let h = from; h <= to; h += cfg.batch) starts.push(h);
  const results = new Map<number, Blk[]>();
  const total = to - from + 1;
  let done = 0;
  const t0 = Date.now();
  const worker = async () => {
    while (starts.length) {
      const s = starts.shift()!;
      const count = Math.min(cfg.batch, to - s + 1);
      const got: Blk[] = [];
      while (got.length < count) {
        const res: any = await withRetry(`blocks at ${s + got.length}`, () =>
          provider.call("block_store.get_blocks_by_height", {
            head_block_id: headId,
            ancestor_start_height: String(s + got.length),
            num_blocks: count - got.length,
            return_block: true,
            return_receipt: true,
          })
        );
        const items = res?.block_items ?? [];
        if (items.length === 0) throw new Error(`node returned no blocks at ${s + got.length}`);
        got.push(...items.map(toBlk));
      }
      results.set(s, got);
      done += count;
      const rate = done / ((Date.now() - t0) / 1000);
      process.stdout.write(`\r  downloaded ${fmt(done)} / ${fmt(total)} blocks  (~${fmt((total - done) / rate / 60, 1)} min left)   `);
    }
  };
  await Promise.all(Array.from({ length: cfg.concurrency }, worker));
  process.stdout.write("\n");
  return [...results.keys()].sort((a, b) => a - b).flatMap((k) => results.get(k)!);
}

// ───────────────────────── Statistics helpers ─────────────────────────

/** Inverse of the standard normal CDF (Acklam's approximation; plenty accurate here). */
function normInv(p: number): number {
  const a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924];
  const b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857];
  const c = [-0.00778489400243029, -0.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497, 2.93816398269878];
  const d = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742];
  const lo = 0.02425;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - lo) return -normInv(1 - p);
  const q = p - 0.5, r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** Bucket edges for a count with given mean and variance: k equal-chance options, half-integer edges. */
function modelEdges(mean: number, variance: number, k: number): number[] {
  const sd = Math.sqrt(Math.max(variance, 1e-9));
  const edges: number[] = [];
  for (let j = 1; j < k; j++) edges.push(Math.floor(mean + normInv(j / k) * sd) + 0.5);
  return edges;
}

/** Bucket edges from a trailing sample: thresholds whose empirical CDF is nearest j/k. */
function sampleEdges(sample: number[], k: number): number[] | null {
  const s = [...sample].sort((x, y) => x - y);
  const uniq = [...new Set(s)];
  const cdf = (v: number) => {
    let lo = 0, hi = s.length; // count of values <= v
    while (lo < hi) { const m = (lo + hi) >> 1; if (s[m] <= v) lo = m + 1; else hi = m; }
    return lo / s.length;
  };
  const edges: number[] = [];
  for (let j = 1; j < k; j++) {
    let best = uniq[0], bestErr = Infinity;
    for (const v of uniq) {
      const err = Math.abs(cdf(v) - j / k);
      if (err < bestErr) { bestErr = err; best = v; }
    }
    edges.push(best);
  }
  for (let j = 1; j < edges.length; j++) if (edges[j] <= edges[j - 1]) return null; // can't make k distinct options
  return edges;
}

/** Option index = how many edges the value is above (for sample edges: value > edge). */
const optionOf = (value: number, edges: number[]) => edges.filter((e) => value > e).length;

// ───────────────────────── Main ─────────────────────────

async function main() {
  const cfg = parseArgs();
  const provider = new Provider([cfg.rpc]);
  console.log("\n=== BACKTEST: are question templates unpredictable? (read-only) ===\n");

  // 1) Make sure we have [lib - days, lib] of blocks
  let blocks = loadCache(cfg);
  const head: any = await withRetry("reading head", () => provider.getHeadInfo());
  const lib = Number(head.last_irreversible_block);
  const from = Math.max(1, lib - Math.round(cfg.days * BLOCKS_PER_DAY) + 1);
  blocks = blocks.filter((b) => b.h <= lib).sort((a, b) => a.h - b.h);
  const first = blocks.length ? blocks[0].h : lib + 1;
  const last = blocks.length ? blocks[blocks.length - 1].h : from - 1;
  // Download in 50,000-block chunks and save after each, so an interrupted run keeps its progress.
  const CHUNK = 50_000;
  if (first > from) {
    console.log(`Downloading ${fmt(first - from)} older blocks (one time; saved as it goes) ...`);
    for (let hi = first - 1; hi >= from; hi -= CHUNK) {
      const lo = Math.max(from, hi - CHUNK + 1);
      blocks = (await fetchRange(provider, head.head_topology.id, lo, hi, cfg)).concat(blocks);
      saveCache(cfg, blocks);
    }
  }
  if (last < lib) {
    console.log(`Downloading ${fmt(lib - Math.max(last, from - 1))} newer blocks ...`);
    for (let lo = Math.max(last + 1, from); lo <= lib; lo += CHUNK) {
      blocks = blocks.concat(await fetchRange(provider, head.head_topology.id, lo, Math.min(lib, lo + CHUNK - 1), cfg));
      saveCache(cfg, blocks);
    }
  }
  // Analyse only the last --days, but keep the whole saved history (a shorter run never shrinks it).
  blocks = blocks.filter((b) => b.h >= from && b.h <= lib);
  const N = blocks.length;
  console.log(`History: ${fmt(N)} irreversible blocks (~${fmt(N / BLOCKS_PER_DAY, 1)} days).`);

  // 2) Arrays for speed
  const ids = new Map<string, number>();
  const names: string[] = [];
  const SG = new Int32Array(N), TS = new Float64Array(N), NTX = new Int32Array(N), CMP = new Float64Array(N);
  blocks.forEach((b, i) => {
    if (!ids.has(b.signer)) { ids.set(b.signer, names.length); names.push(b.signer); }
    SG[i] = ids.get(b.signer)!; TS[i] = b.ts; NTX[i] = b.ntx; CMP[i] = b.compute;
  });
  const K = names.length;
  // Prefix counts for every producer with real history (100+ blocks), big or small.
  const total = new Float64Array(K);
  for (let i = 0; i < N; i++) total[SG[i]]++;
  const tracked = [...total.keys()].filter((p) => total[p] >= 100);
  const P = new Map<number, Int32Array>();
  for (const p of tracked) {
    const a = new Int32Array(N + 1);
    for (let i = 0; i < N; i++) a[i + 1] = a[i] + (SG[i] === p ? 1 : 0);
    P.set(p, a);
  }
  const cnt = (p: number, a: number, b: number) => P.get(p)![b] - P.get(p)![a];
  // Block positions of each producer, plus the largest gap per chunk of 256, so "longest absence in
  // [a, b)" is fast enough to check for every calibration window.
  const POS = new Map<number, Int32Array>(), CHK = new Map<number, Int32Array>();
  for (const p of tracked) {
    const pos = new Int32Array(total[p]);
    let n = 0;
    for (let i = 0; i < N; i++) if (SG[i] === p) pos[n++] = i;
    const chunks = new Int32Array(Math.ceil(pos.length / 256));
    for (let i = 0; i + 1 < pos.length; i++) chunks[i >> 8] = Math.max(chunks[i >> 8], pos[i + 1] - pos[i] - 1);
    POS.set(p, pos);
    CHK.set(p, chunks);
  }
  const lowerBound = (a: Int32Array, x: number) => { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < x) lo = m + 1; else hi = m; } return lo; };
  /** Longest run of blocks in [a, b) that producer p did not sign. */
  const absentIn = (p: number, a: number, b: number) => {
    const pos = POS.get(p)!, ch = CHK.get(p)!;
    const lo = lowerBound(pos, a), hi = lowerBound(pos, b);
    if (lo >= hi) return b - a;
    let g = Math.max(pos[lo] - a, b - 1 - pos[hi - 1]);
    let i = lo; // gaps between consecutive signed blocks, indices lo .. hi-2
    while (i < hi - 1) {
      if ((i & 255) === 0 && i + 256 <= hi - 1) { g = Math.max(g, ch[i >> 8]); i += 256; }
      else { g = Math.max(g, pos[i + 1] - pos[i] - 1); i++; }
    }
    return g;
  };

  const R = Math.round(cfg.rateDays * BLOCKS_PER_DAY); // window for each producer's current rate
  const L0 = cfg.lockBlocks;
  const C = Math.round(cfg.calibDays * BLOCKS_PER_DAY); // look-back for learning the forecast's real error
  const A = Math.round(cfg.aggDays * BLOCKS_PER_DAY); // look-back for network-wide (aggregate) buckets
  const H12 = BLOCKS_PER_DAY / 2;
  const rateAt = (p: number, q: number) => cnt(p, q - R, q) / R;
  // Forecast rate: core producers use a short recent window (the 120-day data showed a 2-day rate lags
  // whenever another producer drops out or returns, which made "over" win 55%); smaller producers use a
  // longer one because 6 hours holds too few of their blocks.
  const RC = Math.round(cfg.coreRateDays * BLOCKS_PER_DAY), RS = Math.round(cfg.smallRateDays * BLOCKS_PER_DAY);
  const fc = (p: number, q: number, cls: string) => {
    const Rw = cls === "core" ? RC : RS;
    const v = cnt(p, Math.max(0, q - Rw), q) / Math.min(Rw, q);
    return v > 0 ? v : rateAt(p, q);
  };
  // An absence counts as "offline" only if it is longer than luck allows AND longer than --min-void-blocks.
  // Short restarts (a few minutes) are normal on the real chain; they stay inside the learned spread
  // instead of cancelling questions.
  const absenceLimit = (rate: number, W: number) => Math.max(cfg.minVoidBlocks, Math.log(cfg.voidAlpha / W) / Math.log(1 - rate));
  /** Longest stretch (in blocks) each producer in `ps` went without signing, inside [a, b). */
  const longestAbsence = (ps: number[], a: number, b: number) => {
    const last = new Map(ps.map((p) => [p, a - 1])), gap = new Map(ps.map((p) => [p, 0]));
    for (let i = a; i < b; i++) { const s = SG[i]; if (last.has(s)) { gap.set(s, Math.max(gap.get(s)!, i - last.get(s)! - 1)); last.set(s, i); } }
    for (const p of ps) gap.set(p, Math.max(gap.get(p)!, b - 1 - last.get(p)!));
    return gap;
  };

  // Producer classes. CORE producers sign ≥ minDaily blocks/day and use fixed windows. SMALLER producers
  // (≥ minSmallDaily/day) get a longer window, chosen so at least minExpected blocks are expected —
  // enough for a fair question. Every class must also be: settled (2+ days of history), steady (no
  // ramp-up or wind-down beyond noise) and reliable (not offline in the last 2 days).
  const SMALL_WS = [20000, 43200, 86400]; // ≈ 17 h, 1.5 days, 3 days
  const smallWindow = (rate: number) => SMALL_WS.find((W) => W <= cfg.maxSmallWindow && W * rate >= cfg.minExpected) ?? null;
  type Status = "core" | "small" | "too small" | "new" | "drifting" | "offline" | "unreliable";
  // Reliability: how often THIS producer's own recent question windows would have been voided. A node that
  // keeps dropping out (even briefly) is skipped until its record is clean again. Checked on a 1-hour grid.
  const RD = Math.round(cfg.reliabilityDays * BLOCKS_PER_DAY);
  const voidMemo = new Map<string, boolean>();
  const voidedAt = (p: number, q0: number, W: number) => {
    const k = `${p}:${q0}:${W}`;
    if (!voidMemo.has(k)) voidMemo.set(k, absentIn(p, q0 + L0, q0 + L0 + W) > absenceLimit(rateAt(p, q0), W));
    return voidMemo.get(k)!;
  };
  const voidHistory = (p: number, q: number, W: number) => {
    let n = 0, v = 0;
    const first = Math.max(R, q - RD);
    for (let q0 = q - L0 - W - ((q - L0 - W) % cfg.step); q0 >= first; q0 -= cfg.step) {
      if (cnt(p, q0 - R, q0) === 0) continue; // wasn't producing yet
      n++;
      if (voidedAt(p, q0, W)) v++;
    }
    return n >= 24 ? v / n : 0;
  };
  type Classes = { core: number[]; small: number[]; pairs: number[]; status: Map<number, Status> };
  const classMemo = new Map<number, Classes>();
  const classesAt = (q: number): Classes => {
    if (classMemo.has(q)) return classMemo.get(q)!;
    const status = new Map<number, Status>();
    const active = tracked.filter((p) => cnt(p, q - R, q) > 0);
    const candidates: number[] = [];
    for (const p of active) {
      const r = rateAt(p, q);
      if (r * BLOCKS_PER_DAY < cfg.minSmallDaily || !smallWindow(r) && r * BLOCKS_PER_DAY < cfg.minDaily) { status.set(p, "too small"); continue; }
      if (cnt(p, q - R, q - R / 2) === 0 || cnt(p, q - R / 2, q) === 0) { status.set(p, "new"); continue; }
      const tol = Math.max(cfg.maxDrift, 3 / Math.sqrt(r * H12)); // allow for pure noise on small producers
      if (Math.abs(cnt(p, q - H12, q) / H12 / r - 1) > tol) { status.set(p, "drifting"); continue; }
      candidates.push(p);
    }
    // Reliability: no offline stretch in the last --clean-days. A flaky node becomes a subject again after a
    // clean week, which keeps voids rare and rewards operators for running steadily.
    const CD = Math.min(q, Math.max(R, Math.round(cfg.cleanDays * BLOCKS_PER_DAY)));
    const core: number[] = [], small: number[] = [];
    for (const p of candidates) {
      const r = rateAt(p, q);
      if (absentIn(p, q - CD, q) > absenceLimit(r, CD)) { status.set(p, "offline"); continue; }
      const Wp = r * BLOCKS_PER_DAY >= cfg.minDaily ? 20000 : smallWindow(r)!;
      if (voidHistory(p, q, Wp) > cfg.maxVoidHistory) { status.set(p, "unreliable"); continue; }
      if (r * BLOCKS_PER_DAY >= cfg.minDaily) { status.set(p, "core"); core.push(p); } else { status.set(p, "small"); small.push(p); }
    }
    core.sort((a, b) => rateAt(b, q) - rateAt(a, q));
    small.sort((a, b) => rateAt(b, q) - rateAt(a, q));
    // Head-to-heads need two subjects (twice the void risk), so they use only core producers with a
    // clean record over the last --pair-clean-days.
    const PC = Math.min(q, Math.round(cfg.pairCleanDays * BLOCKS_PER_DAY));
    const pairs = core.filter((p) => absentIn(p, q - PC, q) <= absenceLimit(rateAt(p, q), PC));
    const out = { core, small, pairs, status };
    classMemo.set(q, out);
    return out;
  };

  // The group question covers every producer that is NOT core-sized: eligible smaller producers plus the
  // ones too small for their own question. Membership is by size and steadiness, so a big producer that
  // is briefly filtered (new, drifting, offline) never lands in the group and swings its total.
  const tailAt = (q: number) => {
    const st = classesAt(q).status;
    return tracked.filter((p) => (st.get(p) === "small" || st.get(p) === "too small") && rateAt(p, q) > 0);
  };

  // Aggregate statistics over blocks [a, b)
  const stats = {
    maxGap: (a: number, b: number) => { let g = 0; for (let i = a + 1; i < b; i++) g = Math.max(g, (TS[i] - TS[i - 1]) / 1000); return g; },
    avgInterval: (a: number, b: number) => (TS[b - 1] - TS[a]) / 1000 / (b - a - 1),
    emptyShare: (a: number, b: number) => { let e = 0; for (let i = a; i < b; i++) if (NTX[i] === 0) e++; return e / (b - a); },
    transactions: (a: number, b: number) => { let t = 0; for (let i = a; i < b; i++) t += NTX[i]; return t; },
  };

  // 3) Templates. Retired after the real-data backtest: distinct producers, longest streak, compute used,
  // top producer's share (they couldn't be split into equal-chance options).
  type Tpl = { id: string; name: string; tier: string; k: number; W: number; kind: "over" | "buckets" | "h2h" | "combo" | "tail" | "agg"; cls?: "core" | "small"; stat?: keyof typeof stats };
  const templates: Tpl[] = [
    { id: "E3", name: "Smaller producer over/under", tier: "Easy", k: 2, W: 0, kind: "over", cls: "small" },
    { id: "M1", name: "Core producer quartiles", tier: "Medium", k: 4, W: 10000, kind: "buckets", cls: "core" },
    { id: "M4", name: "Largest gap between blocks", tier: "Medium", k: 3, W: 5000, kind: "agg", stat: "maxGap" },
    { id: "M5", name: "Average block interval", tier: "Medium", k: 4, W: 5000, kind: "agg", stat: "avgInterval" },
    { id: "M6", name: "Share of empty blocks", tier: "Medium", k: 4, W: 5000, kind: "agg", stat: "emptyShare" },
    { id: "M7", name: "Transactions in the window", tier: "Medium", k: 4, W: 5000, kind: "agg", stat: "transactions" },
    { id: "M9", name: "Smaller producer quartiles", tier: "Medium", k: 4, W: 0, kind: "buckets", cls: "small" },
    { id: "M10", name: "All non-core producers combined", tier: "Medium", k: 4, W: 20000, kind: "tail" },
    { id: "H1", name: "Core producer sextiles", tier: "Hard", k: 6, W: 5000, kind: "buckets", cls: "core" },
    // Retired after the 120-day run (v5): E1 and E2 on 20,000 blocks (replaced by the 10,000-block E1s/E2s,
    // which void less often) and H2/H2s (two head-to-heads: too few clean pairs, voids 10–15%).
    { id: "H3", name: "Core producer eighths", tier: "Hard", k: 8, W: 10000, kind: "buckets", cls: "core" },
    { id: "E1s", name: "Core producer over/under", tier: "Easy", k: 2, W: 10000, kind: "over", cls: "core" },
    { id: "E2s", name: "Head-to-head with spread", tier: "Easy", k: 2, W: 10000, kind: "h2h" },
  ];
  const maxW = Math.max(...templates.map((t) => t.W), ...SMALL_WS);
  const coreWs = [...new Set(templates.filter((t) => t.cls === "core").map((t) => t.W))];
  const pairWs = [...new Set(templates.filter((t) => t.kind === "h2h" || t.kind === "combo").map((t) => t.W))];
  const tailWs = [...new Set(templates.filter((t) => t.kind === "tail").map((t) => t.W))];

  // 4) The forecast's real error, learned from the past (see README). Errors are standardized ("z") and
  // stored per grid point; at a release we use only windows that had ENDED — no peeking ahead.
  const S = cfg.step;
  const grid: number[] = [];
  const L = cfg.lockBlocks; // forecasts are made at release, but the observation window starts after lock
  for (let q = R; q + L + maxW <= N; q += S) grid.push(q);
  type ZRow = Array<{ p: number; z: number }>;
  const zSingle = new Map<string, ZRow[]>(); // key "core:W" or "small:W"
  const zPair = new Map<number, number[][]>(pairWs.map((W) => [W, []]));
  const zTail = new Map<number, number[][]>(tailWs.map((W) => [W, []]));
  const pushZ = (key: string, gi: number, p: number, z: number) => {
    if (!zSingle.has(key)) zSingle.set(key, []);
    const rows = zSingle.get(key)!;
    while (rows.length <= gi) rows.push([]);
    rows[gi].push({ p, z });
  };
  const zOf = (count: number, W: number, r: number) => (count - W * r) / Math.sqrt(W * r * (1 - r));
  grid.forEach((q, gi) => {
    const cl = classesAt(q);
    // Learn only from windows that would NOT have been voided. Live questions with an offline subject are
    // cancelled, so including those (very low) results would set every line too low and make "over" win
    // too often — exactly what the 120-day run showed (core producers went over 53–59% of the time).
    const ok = (p: number, W: number) => absentIn(p, q + L, q + L + W) <= absenceLimit(rateAt(p, q), W);
    for (const W of coreWs) for (const p of cl.core) if (ok(p, W)) pushZ(`core:${W}`, gi, p, zOf(cnt(p, q + L, q + L + W), W, fc(p, q, "core")));
    for (const p of cl.small) { const W = smallWindow(rateAt(p, q))!; if (ok(p, W)) pushZ(`small:${W}`, gi, p, zOf(cnt(p, q + L, q + L + W), W, fc(p, q, "small"))); }
    for (const W of pairWs) {
      const zs: number[] = [];
      for (let i = 0; i + 1 < cl.pairs.length; i++) {
        const a = cl.pairs[i], b = cl.pairs[i + 1], ra = fc(a, q, "core"), rb = fc(b, q, "core");
        if (!ok(a, W) || !ok(b, W)) continue;
        zs.push((cnt(a, q + L, q + L + W) - cnt(b, q + L, q + L + W) - W * (ra - rb)) / Math.sqrt(W * (ra + rb - (ra - rb) ** 2)));
      }
      zPair.get(W)!.push(zs);
    }
    for (const W of tailWs) {
      const tail = tailAt(q);
      const rt = tail.reduce((s, p) => s + fc(p, q, "small"), 0);
      zTail.get(W)!.push([zOf(tail.reduce((s, p) => s + cnt(p, q + L, q + L + W), 0), W, rt)]);
    }
  });
  const inCalib = (q: number, W: number, r: number) => q >= r - C && q + L + W <= r;
  const calibMemo = new Map<string, Array<{ p: number; z: number }>>();
  const calibRows = (key: string, W: number, r: number) => {
    const mk = `${key}@${r}`;
    if (calibMemo.has(mk)) return calibMemo.get(mk)!;
    const out: Array<{ p: number; z: number }> = [];
    const rows = zSingle.get(key) ?? [];
    grid.forEach((q, gi) => { if (inCalib(q, W, r) && rows[gi]) out.push(...rows[gi]); });
    calibMemo.clear(); // only the current release's entries are ever reused
    calibMemo.set(mk, out);
    return out;
  };
  const calibPlain = (store: Map<number, number[][]>, W: number, r: number) => {
    const out: number[] = [];
    grid.forEach((q, gi) => { if (inCalib(q, W, r)) out.push(...store.get(W)![gi]); });
    return out.sort((x, y) => x - y);
  };
  const quant = (s: number[], p: number) => {
    const pos = (s.length - 1) * p, lo = Math.floor(pos), hi = Math.ceil(pos);
    return s[lo] + (s[hi] - s[lo]) * (pos - lo);
  };
  // Each producer also gets its own correction: if its recent errors lean one way (e.g. it keeps
  // beating its line while growing), the buckets shift by that lean, shrunk toward zero when it has
  // little history.
  const leanOf = (rows: Array<{ p: number; z: number }>, p: number, poolMid: number) => {
    const own = rows.filter((x) => x.p === p).map((x) => x.z).sort((a, b) => a - b);
    if (own.length < 5) return 0;
    return (quant(own, 0.5) - poolMid) * (own.length / (own.length + 30));
  };

  const firstRelease = Math.max(R + C, A);
  const releases = grid.filter((q) => q >= firstRelease);
  if (releases.length === 0) {
    console.log(`\n✖ Not enough history: this model needs about ${fmt((firstRelease + maxW) / BLOCKS_PER_DAY, 1)} days.`);
    console.log(`  Run with more history, e.g.:  npm run backtest -- --days 120`);
    return;
  }

  type Inst = { tpl: string; release: number; subject: string; cls: string; option: number; void: boolean };
  const inst: Inst[] = [];
  const skipped = new Map<string, number>();
  const short = (s: string) => s.slice(0, 8);
  const coverage = new Map<number, Map<Status, number>>();

  for (const r of releases) {
    const cl = classesAt(r);
    for (const [p, st] of cl.status) {
      const m = coverage.get(p) ?? new Map<Status, number>();
      m.set(st, (m.get(st) ?? 0) + 1);
      coverage.set(p, m);
    }
    // Longest absence of each subject inside each window it's asked about
    const absentMemo = new Map<number, Map<number, number>>();
    const absent = (p: number, W: number) => {
      if (!absentMemo.has(W)) absentMemo.set(W, longestAbsence([...cl.core, ...cl.small], r + L, r + L + W));
      return absentMemo.get(W)!.get(p)!;
    };
    const offline = (p: number, W: number) => absent(p, W) > absenceLimit(rateAt(p, r), W);

    for (const t of templates) {
      if (t.kind === "over" || t.kind === "buckets") {
        const subj = t.cls === "core" ? cl.core : cl.small;
        for (const p of subj) {
          const rr = rateAt(p, r), W = t.cls === "core" ? t.W : smallWindow(rr)!;
          const rows = calibRows(`${t.cls}:${W}`, W, r);
          if (rows.length < 50) { skipped.set(t.id, (skipped.get(t.id) ?? 0) + 1); continue; }
          const pool = rows.map((x) => x.z).sort((a, b) => a - b);
          const lean = leanOf(rows, p, quant(pool, 0.5));
          const fr = fc(p, r, t.cls!), m = W * fr, sd = Math.sqrt(m * (1 - fr));
          const edges = Array.from({ length: t.k - 1 }, (_, j) => Math.floor(m + sd * (quant(pool, (j + 1) / t.k) + lean)) + 0.5);
          inst.push({ tpl: t.id, release: r, subject: short(names[p]), cls: t.cls!, option: optionOf(cnt(p, r + L, r + L + W), edges), void: offline(p, W) });
        }
      } else if (t.kind === "h2h" || t.kind === "combo") {
        const z = calibPlain(zPair, t.W, r);
        if (z.length < 50) { skipped.set(t.id, (skipped.get(t.id) ?? 0) + 1); continue; }
        const zMid = quant(z, 0.5);
        const h2h = (a: number, b: number) => {
          const ra = fc(a, r, "core"), rb = fc(b, r, "core");
          const line = Math.floor(t.W * (ra - rb) + Math.sqrt(t.W * (ra + rb - (ra - rb) ** 2)) * zMid) + 0.5;
          return { win: cnt(a, r + L, r + L + t.W) - cnt(b, r + L, r + L + t.W) > line ? 1 : 0, void: offline(a, t.W) || offline(b, t.W) };
        };
        const sp = cl.pairs;
        if (t.kind === "h2h")
          for (let i = 0; i + 1 < sp.length; i++) {
            const o = h2h(sp[i], sp[i + 1]);
            inst.push({ tpl: t.id, release: r, subject: `${short(names[sp[i]])}-${short(names[sp[i + 1]])}`, cls: "core", option: o.win, void: o.void });
          }
        else
          for (let i = 0; i + 3 < sp.length; i += 2) {
            const o1 = h2h(sp[i], sp[i + 1]), o2 = h2h(sp[i + 2], sp[i + 3]);
            inst.push({ tpl: t.id, release: r, subject: `pairs ${i + 1}-${i + 4}`, cls: "core", option: o1.win * 2 + o2.win, void: o1.void || o2.void });
          }
      } else if (t.kind === "tail") {
        const z = calibPlain(zTail, t.W, r);
        if (z.length < 50) { skipped.set(t.id, (skipped.get(t.id) ?? 0) + 1); continue; }
        const tail = tailAt(r);
        const rt = tail.reduce((s, p) => s + fc(p, r, "small"), 0), m = t.W * rt, sd = Math.sqrt(m * (1 - rt));
        const edges = Array.from({ length: t.k - 1 }, (_, j) => Math.floor(m + sd * quant(z, (j + 1) / t.k)) + 0.5);
        inst.push({ tpl: t.id, release: r, subject: `${tail.length} producers`, cls: "group", option: optionOf(tail.reduce((s, p) => s + cnt(p, r + L, r + L + t.W), 0), edges), void: false });
      } else {
        const f = stats[t.stat!];
        const sample: number[] = [];
        const hop = Math.max(1, Math.floor(t.W / 5));
        for (let a = r - A; a + t.W <= r; a += hop) sample.push(f(a, a + t.W));
        const edges = sampleEdges(sample, t.k);
        if (!edges) { skipped.set(t.id, (skipped.get(t.id) ?? 0) + 1); continue; }
        inst.push({ tpl: t.id, release: r, subject: "network", cls: "network", option: optionOf(f(r + L, r + L + t.W), edges), void: false });
      }
    }
  }

  // 6) Results
  console.log(`Replayed ${fmt(releases.length)} release moments (every ${fmt(cfg.step)} blocks).`);
  console.log(`Model v5: forecast rate from the last ${cfg.coreRateDays * 24} h (core) / ${cfg.smallRateDays * 24} h (smaller); bucket spread learned`);
  console.log(`from the last ${cfg.calibDays} days of forecast errors; network questions use the last ${cfg.aggDays} days. Subjects must have no outage`);
  console.log(`in ${cfg.cleanDays} days and ≤ ${cfg.maxVoidHistory * 100}% voided windows over ${cfg.reliabilityDays} days.`);
  console.log(`Answers lock ${fmt(cfg.lockBlocks)} blocks (~${fmt(cfg.lockBlocks / 1200, 1)} h) after release; the observation window starts after lock.`);
  console.log(`Void = subject offline longer than luck allows (chance < ${cfg.voidAlpha * 100}%) and longer than ${fmt(cfg.minVoidBlocks)} blocks.\n`);
  const rows: any[] = [];
  const summary: any[] = [];
  for (const t of templates) {
    const all = inst.filter((x) => x.tpl === t.id);
    const live = all.filter((x) => !x.void);
    const freq = Array.from({ length: t.k }, (_, o) => live.filter((x) => x.option === o).length / Math.max(live.length, 1));
    const maxDev = Math.max(...freq.map((f) => Math.abs(f - 1 / t.k)));
    const voidRate = all.length ? (all.length - live.length) / all.length : 0;
    const Wtyp = t.W || 43200;
    const independent = Math.max(1, Math.round(live.length * Math.min(1, cfg.step / Wtyp)));
    // Single-producer templates must also be fair PER producer: no subject may lean past ±10 pts on its own.
    let worstSubj = 0;
    if (t.kind === "over") {
      const by = new Map<string, number[]>();
      for (const x of live) { const v = by.get(x.subject) ?? [0, 0]; v[x.option]++; by.set(x.subject, v); }
      for (const [, v] of by) {
        const n = v[0] + v[1], nInd = n * Math.min(1, cfg.step / Wtyp);
        if (nInd < 10) continue;
        // Count a lean only when it's bigger than 10 pts AND bigger than chance would explain (2 standard errors).
        const dev = Math.abs(v[1] / n - 0.5), se = 0.5 / Math.sqrt(nInd);
        if (dev > 2 * se) worstSubj = Math.max(worstSubj, dev);
      }
    }
    // A miss only counts as a real FAIL if it's bigger than chance alone would produce (2 standard errors).
    const se = Math.sqrt((1 / t.k) * (1 - 1 / t.k) / independent);
    const verdict =
      skipped.get(t.id) && !all.length ? "CAN'T BALANCE" :
      independent < cfg.minInstances ? "NEED MORE DATA" :
      voidRate > cfg.maxVoid || worstSubj > 0.1 ? "FAIL" :
      maxDev <= cfg.tolerance ? "PASS" :
      maxDev <= 2 * se ? "LIKELY OK*" : "FAIL";
    rows.push({
      id: t.id, template: t.name, tier: t.tier, options: t.k, window: t.W ? fmt(t.W) : "per producer",
      questions: live.length, independent, voids: pct(voidRate),
      "option win rates": freq.map((f) => (f * 100).toFixed(0)).join(" / ") + "%",
      target: (100 / t.k).toFixed(0) + "%", "worst miss": (maxDev * 100).toFixed(1) + " pts",
      "worst producer": t.kind === "over" ? (worstSubj * 100).toFixed(1) + " pts" : "", verdict,
    });
    summary.push({ ...t, questions: live.length, independent, voidRate, freq, maxDev, worstSubj, skipped: skipped.get(t.id) ?? 0, verdict });
  }
  console.table(rows);
  console.log("Reading the table:");
  console.log("  option win rates  how often each option turned out correct (should all be near the target)");
  console.log("  worst miss        the furthest any option landed from its target; PASS needs ≤ " + (cfg.tolerance * 100) + " pts");
  console.log("  worst producer    over/under only: the most lopsided producer beyond chance; PASS needs ≤ 10 pts");
  console.log("  independent       rough count of non-overlapping questions; needs ≥ " + cfg.minInstances + " to judge");
  console.log("  voids             share of questions the void rule cancelled; PASS needs ≤ " + pct(cfg.maxVoid, 0));
  console.log("  LIKELY OK*        missed by more than 5 pts, but by less than chance alone produces with this much data —");
  console.log("                    run with more --days to confirm (each template needs ~300–400 independent questions)");
  for (const [id, n] of skipped) console.log(`  ${id}: ${n} producer-questions skipped — not enough recent history to set fair options.`);

  // Per-producer fairness on over/under
  const bySubj = new Map<string, { cls: string; n: number; over: number; voids: number }>();
  for (const x of inst.filter((x) => x.tpl === "E1" || x.tpl === "E3")) {
    const s = bySubj.get(x.subject) ?? { cls: x.cls, n: 0, over: 0, voids: 0 };
    s.n++; if (x.void) s.voids++; else if (x.option === 1) s.over++;
    bySubj.set(x.subject, s);
  }
  console.log("\nOver/under by producer (each should be near 50% over):");
  console.table([...bySubj.entries()].map(([s, v]) => ({ producer: s + "…", class: v.cls, questions: v.n, "went over": pct(v.over / Math.max(v.n - v.voids, 1)), voided: v.voids })));

  // Coverage: how often each producer could be a question subject, and why not
  console.log("Coverage — share of release moments each producer was eligible, and why it wasn't:");
  const covRows = [...coverage.entries()]
    .sort((a, b) => total[b[0]] - total[a[0]])
    .map(([p, m]) => {
      const n = [...m.values()].reduce((a, b) => a + b, 0);
      const share = (s: Status) => (m.get(s) ? pct(m.get(s)! / n, 0) : "");
      return { producer: short(names[p]) + "…", "share of blocks": pct(total[p] / N, 2), "as core": share("core"), "as smaller": share("small"),
        "too small": share("too small"), "new (<2 days)": share("new"), drifting: share("drifting"), offline: share("offline"), unreliable: share("unreliable") };
    });
  console.table(covRows);
  const everEligible = [...coverage.values()].filter((m) => (m.get("core") ?? 0) + (m.get("small") ?? 0) > 0).length;
  console.log(`${everEligible} of ${coverage.size} producers seen were eligible at least some of the time.`);

  fs.mkdirSync(cfg.out, { recursive: true });
  fs.writeFileSync(path.join(cfg.out, "report.json"), JSON.stringify({ generated: new Date().toISOString(), settings: cfg, blocks: N, releases: releases.length, templates: summary, coverage: covRows }, null, 2));
  fs.writeFileSync(path.join(cfg.out, "instances.csv"),
    ["template,release_height,subject,class,winning_option,voided", ...inst.map((x) => `${x.tpl},${blocks[x.release].h},${x.subject},${x.cls},${x.option},${x.void}`)].join("\n"));
  console.log(`\nFiles written to ./${cfg.out}/ (report.json, instances.csv, blocks.csv)\n`);
}

main().catch((err) => {
  console.error("\n✖ Backtest failed:", err.message ?? err);
  console.error("  If the download stopped, just run the same command again — finished blocks are kept.");
  process.exit(1);
});

/**
 * LIVE QUESTION GENERATOR  (read-only on chain; writes question files locally)
 * -----------------------------------------------------------------------------
 * Builds each day's questions exactly the way the backtester tested them, picks subjects by the
 * rotation rules, writes plain-English wording with exact integer option bounds, and computes the
 * parameter hash that will be recorded on-chain at release. Later it resolves each question from
 * irreversible blocks.
 *
 *   npm run generate -- release                 build today's questions (UTC date)
 *   npm run generate -- release --date 2026-11-02
 *   npm run generate -- resolve                 resolve every question whose window has closed
 *   npm run generate -- show --date 2026-11-02  print a day's questions again
 *
 * The operator bot (bot/bot.ts) calls it with the ON-CHAIN week and day instead of a calendar date:
 *   release --label W003-D2 --week 3 --day 2 --max-lock <week end height> --max-end <last allowed window end>
 * so every question fits inside its on-chain week (answers close before the week ends, and the window ends
 * early enough that the week can close on time).
 *
 * Files (in ./generator-data/):
 *   game.json            settings you can edit (week-one start date, schedule, enabled templates)
 *   state.json           rotation memory: when each producer was last featured, voids this week
 *   questions/DATE.json  that day's questions, options, hashes and (later) results
 *   blocks.csv           the last ~10 days of blocks (seeded from the backtester's cache)
 */
import { Provider } from "koilib";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { BLOCKS_PER_DAY, fmt, pct, quant, sampleThresholds, optionFor, syncBlocks, readCsv, type Blk } from "./common.ts";

const DIR = process.env.GEN_DIR ?? "generator-data"; // the bot uses game-data/ (committed, public)
const MODEL_VERSION = "v5";

// ───────────────────────── Settings ─────────────────────────

type Game = {
  rpc: string;
  weekOneStart: string; // YYYY-MM-DD (UTC); day 0 of week 1
  lockBlocks: number; // answers close this many blocks after release; the window starts right after
  questionsPerDay: number[]; // 7 entries
  tierByDay: string[]; // 7 entries: Easy | Medium | Hard
  menus: Record<string, string[]>; // template ids per tier, in preference order (shuffled daily)
  enabled: string[]; // template ids allowed live (update from the backtest verdicts)
  model: { rateDays: number; calibDays: number; aggDays: number; minDaily: number; minSmallDaily: number; minExpected: number; maxDrift: number; voidAlpha: number; tolerance: number; step: number; pairCleanDays?: number;
    coreRateDays?: number; smallRateDays?: number; minVoidBlocks?: number; cleanDays?: number; reliabilityDays?: number; maxVoidHistory?: number };
};

function nextMonday(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7 || 7));
  return d.toISOString().slice(0, 10);
}

function loadGame(): Game {
  const file = path.join(DIR, "game.json");
  if (!fs.existsSync(file)) {
    const g: Game = {
      rpc: "https://api.koinos.io",
      weekOneStart: nextMonday(),
      lockBlocks: 14400,
      questionsPerDay: [3, 3, 3, 3, 3, 3, 2],
      tierByDay: ["Easy", "Easy", "Medium", "Medium", "Medium", "Hard", "Hard"],
      menus: { Easy: ["E1s", "E3", "E2s"], Medium: ["M1", "M9", "M10", "M4", "M5", "M6", "M7"], Hard: ["H1", "H3"] },
      // From the 120-day backtest (model v5). E3/M9 are fair but void ~6% (smaller nodes have more outages).
      enabled: ["E1s", "E2s", "E3", "M1", "M4", "M5", "M6", "M7", "M9", "M10", "H1", "H3"],
      model: { rateDays: 2, calibDays: 7, aggDays: 3, minDaily: 1400, minSmallDaily: 20, minExpected: 60, maxDrift: 0.25, voidAlpha: 0.001, tolerance: 0.05, step: 1200,
        pairCleanDays: 14, coreRateDays: 0.25, smallRateDays: 1, minVoidBlocks: 600, cleanDays: 2, reliabilityDays: 14, maxVoidHistory: 0.03 },
    };
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(g, null, 2));
    console.log(`Created ${file} with defaults (week one starts ${g.weekOneStart}). Edit it any time.`);
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

type State = { featured: Record<string, number>; voidedByWeek: Record<string, string[]> };
const stateFile = path.join(DIR, "state.json");
const loadState = (): State => (fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : { featured: {}, voidedByWeek: {} });
const saveState = (s: State) => fs.writeFileSync(stateFile, JSON.stringify(s, null, 2));

function parseArgs() {
  const [cmd = "release", ...rest] = process.argv.slice(2);
  const o: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i].startsWith("--")) continue;
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) o[rest[i].slice(2)] = "true"; // a switch like --offline
    else { o[rest[i].slice(2)] = next; i++; }
  }
  const n = (k: string) => (o[k] === undefined ? undefined : Number(o[k]));
  return { cmd, date: o.label ?? o.date ?? new Date().toISOString().slice(0, 10), force: o.force === "true" || "force" in o, offline: "offline" in o,
    week: n("week"), day: n("day"), maxLock: n("max-lock"), maxEnd: n("max-end") };
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
/** Deterministic pseudo-random numbers from a seed, so anyone can reproduce the day's choices. */
function seeded(seed: string) {
  let n = 0;
  return () => parseInt(sha256(`${seed}:${n++}`).slice(0, 12), 16) / 2 ** 48;
}
const short = (a: string) => a.slice(0, 8) + "…";

// ───────────────────────── The model (same as backtest v5) ─────────────────────────

function buildModel(blocks: Blk[], g: Game) {
  const m = g.model;
  const N = blocks.length;
  const h0 = blocks[0].h;
  for (let i = 1; i < N; i++) if (blocks[i].h !== h0 + i) throw new Error(`Block history has a gap at height ${h0 + i}. Delete ${DIR}/blocks.csv and run again.`);
  const ids = new Map<string, number>(), names: string[] = [];
  const SG = new Int32Array(N), TS = new Float64Array(N), NTX = new Int32Array(N);
  blocks.forEach((b, i) => {
    if (!ids.has(b.signer)) { ids.set(b.signer, names.length); names.push(b.signer); }
    SG[i] = ids.get(b.signer)!; TS[i] = b.ts; NTX[i] = b.ntx;
  });
  const K = names.length;
  const total = new Float64Array(K);
  for (let i = 0; i < N; i++) total[SG[i]]++;
  const tracked = [...total.keys()].filter((p) => total[p] >= 20);
  const P = new Map<number, Int32Array>();
  for (const p of tracked) { const a = new Int32Array(N + 1); for (let i = 0; i < N; i++) a[i + 1] = a[i] + (SG[i] === p ? 1 : 0); P.set(p, a); }
  const cnt = (p: number, a: number, b: number) => P.get(p)![Math.min(b, N)] - P.get(p)![Math.max(a, 0)];

  const R = Math.round(m.rateDays * BLOCKS_PER_DAY), C = Math.round(m.calibDays * BLOCKS_PER_DAY), A = Math.round(m.aggDays * BLOCKS_PER_DAY);
  const L = g.lockBlocks, H12 = BLOCKS_PER_DAY / 2;
  const rateAt = (p: number, q: number) => cnt(p, q - R, q) / R;
  const absenceLimit = (rate: number, W: number) => Math.max(m.minVoidBlocks ?? 0, Math.log(m.voidAlpha / W) / Math.log(1 - rate));
  // Forecast rate: core producers use the last 6 hours, smaller producers the last day (see README).
  const RC = Math.round((m.coreRateDays ?? 0.25) * BLOCKS_PER_DAY), RS = Math.round((m.smallRateDays ?? 1) * BLOCKS_PER_DAY);
  const fc = (p: number, q: number, cls: string) => {
    const Rw = cls === "core" ? RC : RS;
    const v = cnt(p, q - Rw, q) / Math.min(Rw, q);
    return v > 0 ? v : rateAt(p, q);
  };
  // Fast "longest absence of one producer in [a, b)": block positions + largest gap per chunk of 256.
  const POS = new Map<number, Int32Array>(), CHK = new Map<number, Int32Array>();
  for (const p of tracked) {
    const pos = new Int32Array(total[p]);
    let n = 0;
    for (let i = 0; i < N; i++) if (SG[i] === p) pos[n++] = i;
    const ch = new Int32Array(Math.ceil(pos.length / 256));
    for (let i = 0; i + 1 < pos.length; i++) ch[i >> 8] = Math.max(ch[i >> 8], pos[i + 1] - pos[i] - 1);
    POS.set(p, pos); CHK.set(p, ch);
  }
  const lowerBound = (a: Int32Array, x: number) => { let lo = 0, hi = a.length; while (lo < hi) { const k = (lo + hi) >> 1; if (a[k] < x) lo = k + 1; else hi = k; } return lo; };
  const absentIn = (p: number, a: number, b: number) => {
    a = Math.max(0, a); b = Math.min(N, b);
    const pos = POS.get(p)!, ch = CHK.get(p)!;
    const lo = lowerBound(pos, a), hi = lowerBound(pos, b);
    if (lo >= hi) return b - a;
    let gmax = Math.max(pos[lo] - a, b - 1 - pos[hi - 1]);
    let i = lo;
    while (i < hi - 1) {
      if ((i & 255) === 0 && i + 256 <= hi - 1) { gmax = Math.max(gmax, ch[i >> 8]); i += 256; }
      else { gmax = Math.max(gmax, pos[i + 1] - pos[i] - 1); i++; }
    }
    return gmax;
  };
  // Reliability: share of this producer's own recent question windows that would have been voided.
  const RD = Math.round((m.reliabilityDays ?? 14) * BLOCKS_PER_DAY);
  const voidMemo = new Map<string, boolean>();
  const voidHistory = (p: number, q: number, W: number) => {
    let n = 0, v = 0;
    for (let q0 = q - L - W - ((q - L - W) % m.step); q0 >= Math.max(R, q - RD); q0 -= m.step) {
      if (cnt(p, q0 - R, q0) === 0) continue;
      n++;
      const k = `${p}:${q0}:${W}`;
      if (!voidMemo.has(k)) voidMemo.set(k, absentIn(p, q0 + L, q0 + L + W) > absenceLimit(rateAt(p, q0), W));
      if (voidMemo.get(k)) v++;
    }
    return n >= 24 ? v / n : 0;
  };
  const longestAbsence = (ps: number[], a: number, b: number) => {
    const last = new Map(ps.map((p) => [p, a - 1])), gap = new Map(ps.map((p) => [p, 0]));
    for (let i = a; i < b; i++) { const s = SG[i]; if (last.has(s)) { gap.set(s, Math.max(gap.get(s)!, i - last.get(s)! - 1)); last.set(s, i); } }
    for (const p of ps) gap.set(p, Math.max(gap.get(p)!, b - 1 - last.get(p)!));
    return gap;
  };
  const SMALL_WS = [20000, 43200, 86400];
  const smallWindow = (rate: number) => SMALL_WS.find((W) => W * rate >= m.minExpected) ?? null;
  type Classes = { core: number[]; small: number[]; pairs: number[]; status: Map<number, string> };
  const memo = new Map<number, Classes>();
  const classesAt = (q: number): Classes => {
    if (memo.has(q)) return memo.get(q)!;
    const status = new Map<number, string>(), cand: number[] = [];
    for (const p of tracked.filter((p) => cnt(p, q - R, q) > 0)) {
      const r = rateAt(p, q);
      if (r * BLOCKS_PER_DAY < m.minSmallDaily || (!smallWindow(r) && r * BLOCKS_PER_DAY < m.minDaily)) { status.set(p, "too small"); continue; }
      if (cnt(p, q - R, q - R / 2) === 0 || cnt(p, q - R / 2, q) === 0) { status.set(p, "new (<2 days)"); continue; }
      if (Math.abs(cnt(p, q - H12, q) / H12 / r - 1) > Math.max(m.maxDrift, 3 / Math.sqrt(r * H12))) { status.set(p, "drifting"); continue; }
      cand.push(p);
    }
    const CD = Math.min(q, Math.max(R, Math.round((m.cleanDays ?? 2) * BLOCKS_PER_DAY)));
    const core: number[] = [], small: number[] = [];
    for (const p of cand) {
      const r = rateAt(p, q);
      if (absentIn(p, q - CD, q) > absenceLimit(r, CD)) { status.set(p, "offline recently"); continue; }
      const Wp = r * BLOCKS_PER_DAY >= m.minDaily ? 20000 : smallWindow(r)!;
      if (voidHistory(p, q, Wp) > (m.maxVoidHistory ?? 0.03)) { status.set(p, "unreliable (recent outages)"); continue; }
      if (r * BLOCKS_PER_DAY >= m.minDaily) { status.set(p, "core"); core.push(p); } else { status.set(p, "smaller"); small.push(p); }
    }
    core.sort((a, b) => rateAt(b, q) - rateAt(a, q));
    small.sort((a, b) => rateAt(b, q) - rateAt(a, q));
    const PC = Math.min(q, Math.round((m.pairCleanDays ?? 14) * BLOCKS_PER_DAY));
    const pairs = core.filter((p) => absentIn(p, q - PC, q) <= absenceLimit(rateAt(p, q), PC));
    const out = { core, small, pairs, status };
    memo.set(q, out);
    return out;
  };

  // Calibration: standardized forecast errors from grid points whose (lock-offset) window had ended by now.
  const r = N; // release = right after the newest irreversible block
  const grid: number[] = [];
  for (let q = r - C; q <= r; q += m.step) if (q - R >= 0) grid.push(q);
  const zOf = (count: number, W: number, rate: number) => (count - W * rate) / Math.sqrt(W * rate * (1 - rate));
  // Learn only from windows that would NOT have been voided (live questions with an offline subject are
  // cancelled, so counting those low results would set every line too low).
  const okWin = (p: number, q: number, W: number) => absentIn(p, q + L, q + L + W) <= absenceLimit(rateAt(p, q), W);
  // Group question: every producer that is not core-sized, by size and steadiness (never a big producer
  // that is only briefly filtered).
  const tailAt = (q: number) => {
    const st = classesAt(q).status;
    return tracked.filter((p) => (st.get(p) === "smaller" || st.get(p) === "too small") && rateAt(p, q) > 0);
  };
  const calibCache = new Map<string, Array<{ p: number; z: number }>>();
  const singleCalib = (cls: "core" | "small", W: number) => {
    const key = `${cls}:${W}`;
    if (calibCache.has(key)) return calibCache.get(key)!;
    const out: Array<{ p: number; z: number }> = [];
    for (const q of grid) {
      if (q + L + W > r) continue;
      const cl = classesAt(q);
      for (const p of cls === "core" ? cl.core : cl.small) {
        if (cls === "small" && smallWindow(rateAt(p, q)) !== W) continue;
        if (!okWin(p, q, W)) continue;
        out.push({ p, z: zOf(cnt(p, q + L, q + L + W), W, fc(p, q, cls)) });
      }
    }
    calibCache.set(key, out);
    return out;
  };
  const pairCalib = (W: number) => {
    const out: number[] = [];
    for (const q of grid) {
      if (q + L + W > r) continue;
      const sp = classesAt(q).pairs;
      for (let i = 0; i + 1 < sp.length; i++) {
        const a = sp[i], b = sp[i + 1], ra = fc(a, q, "core"), rb = fc(b, q, "core");
        if (!okWin(a, q, W) || !okWin(b, q, W)) continue;
        out.push((cnt(a, q + L, q + L + W) - cnt(b, q + L, q + L + W) - W * (ra - rb)) / Math.sqrt(W * (ra + rb - (ra - rb) ** 2)));
      }
    }
    return out.sort((x, y) => x - y);
  };
  const tailCalib = (W: number) => {
    const out: number[] = [];
    for (const q of grid) {
      if (q + L + W > r) continue;
      const tail = tailAt(q);
      out.push(zOf(tail.reduce((s, p) => s + cnt(p, q + L, q + L + W), 0), W, tail.reduce((s, p) => s + fc(p, q, "small"), 0)));
    }
    return out.sort((x, y) => x - y);
  };

  // Network statistics in integer units, so every option bound is exact
  const stats: Record<string, { unit: string; f: (a: number, b: number) => number }> = {
    maxGap: { unit: "ms", f: (a, b) => { let g = 0; for (let i = a + 1; i < b; i++) g = Math.max(g, TS[i] - TS[i - 1]); return g; } },
    avgInterval: { unit: "ms", f: (a, b) => Math.round((TS[b - 1] - TS[a]) / (b - a - 1)) },
    emptyShare: { unit: "permille", f: (a, b) => { let e = 0; for (let i = a; i < b; i++) if (NTX[i] === 0) e++; return Math.round((1000 * e) / (b - a)); } },
    transactions: { unit: "count", f: (a, b) => { let t = 0; for (let i = a; i < b; i++) t += NTX[i]; return t; } },
  };
  const aggSample = (stat: string, W: number) => {
    const out: number[] = [], hop = Math.max(1, Math.floor(W / 5));
    for (let a = r - A; a + W <= r; a += hop) out.push(stats[stat].f(a, a + W));
    return out;
  };

  return { N, h0, names, ids, tracked, cnt, rateAt, fc, classesAt, smallWindow, absenceLimit, singleCalib, pairCalib, tailCalib, tailAt, stats, aggSample, r, L, longestAbsence, SG, TS, NTX };
}

// ───────────────────────── Templates → questions ─────────────────────────

type Option = { index: number; label: string; min: number | null; max: number | null };
type Question = {
  id: string; date: string; week: number; day: number; tier: string; template: string; title: string; text: string;
  subjects: string[]; group?: string[]; unit: string;
  releaseHeight: number; lockHeight: number; windowStart: number; windowEnd: number;
  thresholds: number[]; options: Option[]; predicted: number[];
  model: { version: string; rates: Record<string, number>; forecast?: Record<string, number>; window: number }; // rates: 2-day (void rule); forecast: what set the options
  paramsHash?: string; result?: any;
};

const TEMPLATES: Record<string, { name: string; kind: string; k: number; W: number; cls?: "core" | "small"; stat?: string }> = {
  E1: { name: "Core producer over/under", kind: "single", k: 2, W: 20000, cls: "core" },
  E2: { name: "Head-to-head with spread", kind: "h2h", k: 2, W: 20000 },
  E3: { name: "Smaller producer over/under", kind: "single", k: 2, W: 0, cls: "small" },
  M1: { name: "Core producer quartiles", kind: "single", k: 4, W: 10000, cls: "core" },
  M9: { name: "Smaller producer quartiles", kind: "single", k: 4, W: 0, cls: "small" },
  M10: { name: "All non-core producers combined", kind: "tail", k: 4, W: 20000 },
  M4: { name: "Largest gap between blocks", kind: "agg", k: 3, W: 5000, stat: "maxGap" },
  M5: { name: "Average block interval", kind: "agg", k: 4, W: 5000, stat: "avgInterval" },
  M6: { name: "Share of empty blocks", kind: "agg", k: 4, W: 5000, stat: "emptyShare" },
  M7: { name: "Transactions in the window", kind: "agg", k: 4, W: 5000, stat: "transactions" },
  H1: { name: "Core producer sextiles", kind: "single", k: 6, W: 5000, cls: "core" },
  H2: { name: "Two head-to-heads combined", kind: "combo", k: 4, W: 10000 },
  E1s: { name: "Core producer over/under", kind: "single", k: 2, W: 10000, cls: "core" },
  E2s: { name: "Head-to-head with spread", kind: "h2h", k: 2, W: 10000 },
  H3: { name: "Core producer eighths", kind: "single", k: 8, W: 10000, cls: "core" },
  H2s: { name: "Two head-to-heads combined", kind: "combo", k: 4, W: 5000 },
};

/** Human labels for integer thresholds: "X or fewer", "X–Y", "Z or more". */
function rangeOptions(t: number[], show: (v: number) => string, few = "or fewer", more = "or more"): Option[] {
  const opts: Option[] = [];
  for (let j = 0; j <= t.length; j++) {
    const lo = j === 0 ? null : t[j - 1] + 1, hi = j === t.length ? null : t[j];
    const label = lo === null ? `${show(hi!)} ${few}` : hi === null ? `${show(lo)} ${more}` : lo === hi ? show(lo) : `${show(lo)} to ${show(hi)}`;
    opts.push({ index: j, label, min: lo, max: hi });
  }
  return opts;
}
const unitShow: Record<string, (v: number) => string> = {
  count: (v) => fmt(v),
  ms: (v) => (v / 1000).toFixed(3) + " s",
  permille: (v) => (v / 10).toFixed(1) + "%",
};

function predictedFromZ(z: number[], mean: number, sd: number, lean: number, t: number[]) {
  const k = t.length + 1, c = new Array(k).fill(0);
  for (const x of z) c[optionFor(Math.round(mean + sd * (x + lean)), t)]++;
  return c.map((v) => v / Math.max(z.length, 1));
}

function main() {
  return run().catch((err) => { console.error("\n✖ Generator failed:", err.message ?? err); process.exit(1); });
}

async function run() {
  const args = parseArgs();
  const g = loadGame();
  fs.mkdirSync(path.join(DIR, "questions"), { recursive: true });
  if (args.cmd === "show") return show(args.date);

  const provider = new Provider([g.rpc]);
  // History: 2-day rates + 7 days of calibration + 14 days of reliability record, plus a margin.
  const need = g.model.rateDays + g.model.calibDays + (g.model.reliabilityDays ?? 14) + 2;
  const { blocks, lib } = args.offline
    ? { blocks: readCsv(path.join(DIR, "blocks.csv")), lib: NaN }
    : await syncBlocks(provider, path.join(DIR, "blocks.csv"), need, "backtest-output/blocks.csv");
  if (blocks.length < (need - 0.5) * BLOCKS_PER_DAY) throw new Error(`Need about ${need} days of blocks; have ${fmt(blocks.length / BLOCKS_PER_DAY, 1)}.`);
  const libHeight = isNaN(lib) ? blocks[blocks.length - 1].h : lib;

  if (args.cmd === "resolve") return resolve(blocks, g);
  if (args.cmd !== "release") throw new Error(`Unknown command "${args.cmd}". Use release, resolve or show.`);

  const file = path.join(DIR, "questions", `${args.date}.json`);
  if (fs.existsSync(file) && !args.force) throw new Error(`${file} already exists. Questions are released once per day (use --force only for testing).`);

  // Calendar mode (manual runs): week/day from the date. Bot mode: the on-chain week and day are given.
  const onChain = args.week !== undefined && args.day !== undefined;
  const dayNumber = onChain ? args.week! * 7 + args.day! : Math.floor((Date.parse(args.date) - Date.parse(g.weekOneStart)) / 86_400_000);
  const week = onChain ? args.week! : Math.floor(dayNumber / 7) + 1, day = onChain ? args.day! : ((dayNumber % 7) + 7) % 7;
  const tier = g.tierByDay[day], count = g.questionsPerDay[day];
  console.log(`\n=== Releasing questions for ${args.date} — week ${week}, day ${day + 1} (${tier}), ${count} questions ===`);
  if (dayNumber < 0) console.log(`(Practice run: the game starts ${g.weekOneStart}.)`);

  const M = buildModel(blocks, g);
  const st = loadState();
  const voided = new Set(st.voidedByWeek[String(week)] ?? []);
  const rand = seeded(`${args.date}:${blocks[blocks.length - 1].h}`);
  const cl = M.classesAt(M.r);
  const lockHeight = libHeight + M.L;
  if (args.maxLock !== undefined && lockHeight > args.maxLock) throw new Error(`Too late in the week to release: answers would close at ${lockHeight}, after the week ends at ${args.maxLock}.`);
  const maxEnd = args.maxEnd ?? Infinity; // the window must end early enough for the week to close on time
  const usedToday = new Set<string>();

  // Rotation: never-featured first, then longest since featured; ties broken by the day's seed.
  const order = (ps: number[]) => ps
    .map((p) => ({ p, a: M.names[p], last: st.featured[M.names[p]] ?? -1e9, tie: rand() }))
    .filter((x) => !usedToday.has(x.a) && !voided.has(x.a))
    .sort((x, y) => x.last - y.last || x.tie - y.tie)
    .map((x) => x.p);

  const questions: Question[] = [];
  const menu = g.menus[tier].filter((id) => g.enabled.includes(id)).map((id) => ({ id, s: rand() })).sort((a, b) => a.s - b.s).map((x) => x.id);
  const tol = g.model.tolerance;
  let attempts = 0;
  for (let mi = 0; questions.length < count && attempts < 40; mi = (mi + 1) % menu.length, attempts++) {
    const id = menu[mi], T = TEMPLATES[id];
    const base = { date: args.date, week, day: day + 1, tier, template: id, releaseHeight: libHeight, lockHeight };
    const n = questions.length + 1;
    let q: Question | null = null;
    if (T.W > 0 && lockHeight + T.W > maxEnd) continue;

    if (T.kind === "single") {
      const pool = T.cls === "core" ? cl.core : cl.small;
      for (const p of order(pool)) {
        const rate = M.rateAt(p, M.r), W = T.cls === "core" ? T.W : M.smallWindow(rate)!;
        if (lockHeight + W > maxEnd) continue;
        const frate = M.fc(p, M.r, T.cls!);
        const rows = M.singleCalib(T.cls!, W);
        if (rows.length < 50) continue;
        const z = rows.map((x) => x.z).sort((a, b) => a - b), mid = quant(z, 0.5);
        const own = rows.filter((x) => x.p === p).map((x) => x.z).sort((a, b) => a - b);
        const lean = own.length >= 5 ? (quant(own, 0.5) - mid) * (own.length / (own.length + 30)) : 0;
        const mean = W * frate, sd = Math.sqrt(mean * (1 - frate));
        const t = Array.from({ length: T.k - 1 }, (_, j) => Math.floor(mean + sd * (quant(z, (j + 1) / T.k) + lean)));
        if (t[0] < 0 || t.some((v, j) => j > 0 && v <= t[j - 1])) continue;
        const pred = predictedFromZ(z, mean, sd, lean, t);
        if (pred.some((x) => Math.abs(x - 1 / T.k) > tol)) continue;
        const who = M.names[p], hours = (W * 3) / 3600;
        const text = T.k === 2
          ? `Will producer ${short(who)} sign more than ${fmt(t[0])} blocks between block ${fmt(lockHeight + 1)} and block ${fmt(lockHeight + W)} (about ${fmt(hours, 0)} hours)?`
          : `How many blocks will producer ${short(who)} sign between block ${fmt(lockHeight + 1)} and block ${fmt(lockHeight + W)} (about ${fmt(hours, 0)} hours)?`;
        const options = T.k === 2
          ? [{ index: 0, label: `No — ${fmt(t[0])} or fewer`, min: null, max: t[0] }, { index: 1, label: `Yes — ${fmt(t[0] + 1)} or more`, min: t[0] + 1, max: null }]
          : rangeOptions(t, unitShow.count);
        q = { id: `${args.date}-${n}`, ...base, title: T.name, text, subjects: [who], unit: "count", windowStart: lockHeight + 1, windowEnd: lockHeight + W,
          thresholds: t, options, predicted: pred, model: { version: MODEL_VERSION, rates: { [who]: rate }, forecast: { [who]: frate }, window: W } };
        usedToday.add(who);
        break;
      }
    } else if (T.kind === "h2h" || T.kind === "combo") {
      const z = M.pairCalib(T.W);
      if (z.length < 50) continue;
      const zMid = quant(z, 0.5), sp = cl.pairs.filter((p) => !usedToday.has(M.names[p]) && !voided.has(M.names[p]));
      const line = (a: number, b: number) => {
        const ra = M.fc(a, M.r, "core"), rb = M.fc(b, M.r, "core");
        return Math.floor(T.W * (ra - rb) + Math.sqrt(T.W * (ra + rb - (ra - rb) ** 2)) * zMid);
      };
      const firstPick = order(sp)[0];
      if (firstPick === undefined) continue;
      const i0 = sp.indexOf(firstPick);
      const pairAt = (i: number): [number, number] | null => (i + 1 < sp.length ? [sp[i], sp[i + 1]] : i > 0 ? [sp[i - 1], sp[i]] : null);
      const p1 = pairAt(i0);
      if (!p1) continue;
      const [a, b] = p1, A = M.names[a], B = M.names[b], t1 = line(a, b);
      const span = `between block ${fmt(lockHeight + 1)} and block ${fmt(lockHeight + T.W)}`;
      if (T.kind === "h2h") {
        q = { id: `${args.date}-${n}`, ...base, title: T.name,
          text: `Producer ${short(A)}'s blocks minus producer ${short(B)}'s blocks, ${span}: will the difference be more than ${fmt(t1)}?`,
          subjects: [A, B], unit: "count", windowStart: lockHeight + 1, windowEnd: lockHeight + T.W, thresholds: [t1],
          options: [{ index: 0, label: `No — ${fmt(t1)} or less`, min: null, max: t1 }, { index: 1, label: `Yes — ${fmt(t1 + 1)} or more`, min: t1 + 1, max: null }],
          predicted: [0.5, 0.5], model: { version: MODEL_VERSION, rates: { [A]: M.rateAt(a, M.r), [B]: M.rateAt(b, M.r) }, window: T.W } };
        usedToday.add(A); usedToday.add(B);
      } else {
        const rest = sp.filter((p) => p !== a && p !== b);
        if (rest.length < 2) continue;
        const [c, d] = [rest[0], rest[1]], Cn = M.names[c], Dn = M.names[d], t2 = line(c, d);
        const L1 = `${short(A)} − ${short(B)}`, L2 = `${short(Cn)} − ${short(Dn)}`;
        q = { id: `${args.date}-${n}`, ...base, title: T.name,
          text: `Two head-to-heads ${span}. Line 1: ${L1} more than ${fmt(t1)}? Line 2: ${L2} more than ${fmt(t2)}? Pick the combination.`,
          subjects: [A, B, Cn, Dn], unit: "count", windowStart: lockHeight + 1, windowEnd: lockHeight + T.W, thresholds: [t1, t2],
          options: [
            { index: 0, label: `Neither: ${L1} ≤ ${fmt(t1)} and ${L2} ≤ ${fmt(t2)}`, min: null, max: null },
            { index: 1, label: `Line 2 only: ${L1} ≤ ${fmt(t1)} and ${L2} ≥ ${fmt(t2 + 1)}`, min: null, max: null },
            { index: 2, label: `Line 1 only: ${L1} ≥ ${fmt(t1 + 1)} and ${L2} ≤ ${fmt(t2)}`, min: null, max: null },
            { index: 3, label: `Both: ${L1} ≥ ${fmt(t1 + 1)} and ${L2} ≥ ${fmt(t2 + 1)}`, min: null, max: null },
          ],
          predicted: [0.25, 0.25, 0.25, 0.25],
          model: { version: MODEL_VERSION, rates: Object.fromEntries([a, b, c, d].map((p) => [M.names[p], M.rateAt(p, M.r)])), window: T.W } };
        [A, B, Cn, Dn].forEach((x) => usedToday.add(x));
      }
    } else if (T.kind === "tail") {
      if (questions.some((x) => x.template === id)) continue;
      const z = M.tailCalib(T.W);
      if (z.length < 50) continue;
      const tail = M.tailAt(M.r);
      const rt = tail.reduce((s, p) => s + M.fc(p, M.r, "small"), 0), mean = T.W * rt, sd = Math.sqrt(mean * (1 - rt));
      const t = Array.from({ length: T.k - 1 }, (_, j) => Math.floor(mean + sd * quant(z, (j + 1) / T.k)));
      if (t.some((v, j) => j > 0 && v <= t[j - 1])) continue;
      q = { id: `${args.date}-${n}`, ...base, title: T.name,
        text: `How many blocks will these ${tail.length} non-core producers sign together between block ${fmt(lockHeight + 1)} and block ${fmt(lockHeight + T.W)}? (Full list in the question details.)`,
        subjects: [], group: tail.map((p) => M.names[p]), unit: "count", windowStart: lockHeight + 1, windowEnd: lockHeight + T.W,
        thresholds: t, options: rangeOptions(t, unitShow.count), predicted: predictedFromZ(z, mean, sd, 0, t),
        model: { version: MODEL_VERSION, rates: Object.fromEntries(tail.map((p) => [M.names[p], M.rateAt(p, M.r)])), window: T.W } };
    } else {
      if (questions.some((x) => x.template === id)) continue;
      const S = M.stats[T.stat!], sample = M.aggSample(T.stat!, T.W), t = sampleThresholds(sample, T.k);
      if (!t) continue;
      const pred = Array.from({ length: T.k }, (_, j) => sample.filter((v) => optionFor(v, t) === j).length / sample.length);
      if (pred.some((x) => Math.abs(x - 1 / T.k) > tol * 2)) continue;
      const what: Record<string, string> = {
        maxGap: "What will be the longest gap between two consecutive blocks",
        avgInterval: "What will be the average time between blocks",
        emptyShare: "What share of blocks will contain no transactions",
        transactions: "How many transactions will be included in blocks",
      };
      q = { id: `${args.date}-${n}`, ...base, title: T.name,
        text: `${what[T.stat!]} between block ${fmt(lockHeight + 1)} and block ${fmt(lockHeight + T.W)}?`,
        subjects: [], unit: S.unit, windowStart: lockHeight + 1, windowEnd: lockHeight + T.W,
        thresholds: t, options: rangeOptions(t, unitShow[S.unit], S.unit === "count" ? "or fewer" : "or less", "or more"), predicted: pred,
        model: { version: MODEL_VERSION, rates: {}, window: T.W } };
    }
    if (q) {
      const { paramsHash, result, text, title, options, ...canonical } = q;
      q.paramsHash = sha256(JSON.stringify(canonical));
      questions.push(q);
    }
  }
  if (questions.length < count) console.log(`⚠ Only ${questions.length} of ${count} questions could be made fairly today.`);

  for (const q of questions) for (const a of [...q.subjects]) st.featured[a] = dayNumber;
  fs.writeFileSync(file, JSON.stringify({ date: args.date, week, day: day + 1, tier, released: new Date().toISOString(), questions }, null, 2));
  saveState(st);
  printDay(questions);

  // Eligibility snapshot so the transparency page can explain who could be featured and why not
  console.log("Producer eligibility right now:");
  console.table([...cl.status.entries()].sort((a, b) => M.rateAt(b[0], M.r) - M.rateAt(a[0], M.r)).map(([p, s]) => ({
    producer: short(M.names[p]), "blocks/day": fmt(M.rateAt(p, M.r) * BLOCKS_PER_DAY), status: s,
    "last featured": st.featured[M.names[p]] === undefined ? "never" : `day ${st.featured[M.names[p]]}`,
  })));
  console.log(`Saved ${file}\n`);
}

function printDay(questions: Question[]) {
  for (const q of questions) {
    console.log(`\n[${q.id}] ${q.tier} · ${q.title}`);
    console.log(`  ${q.text}`);
    q.options.forEach((o) => console.log(`    ${String.fromCharCode(65 + o.index)}) ${o.label}${q.predicted ? `   (fair chance ≈ ${pct(q.predicted[o.index], 0)})` : ""}`));
    console.log(`  Answers close at block ${fmt(q.lockHeight)} · window ${fmt(q.windowStart)}–${fmt(q.windowEnd)} · params hash ${q.paramsHash!.slice(0, 16)}…`);
    if (q.result) console.log(`  RESULT: ${q.result.void ? `VOID (${q.result.reason})` : `${String.fromCharCode(65 + q.result.option)} — value ${q.result.value}`}`);
  }
}

function show(date: string) {
  const file = path.join(DIR, "questions", `${date}.json`);
  if (!fs.existsSync(file)) throw new Error(`No questions saved for ${date}.`);
  printDay(JSON.parse(fs.readFileSync(file, "utf8")).questions);
}

function resolve(blocks: Blk[], g: Game) {
  const st = loadState();
  const h0 = blocks[0].h, hLast = blocks[blocks.length - 1].h;
  const idx = (h: number) => h - h0;
  const files = fs.readdirSync(path.join(DIR, "questions")).filter((f) => f.endsWith(".json")).sort();
  let resolved = 0, pending = 0;
  const ids = new Map<string, number>();
  blocks.forEach((b) => { if (!ids.has(b.signer)) ids.set(b.signer, ids.size); });
  for (const f of files) {
    const file = path.join(DIR, "questions", f);
    const day = JSON.parse(fs.readFileSync(file, "utf8"));
    let changed = false;
    for (const q of day.questions as Question[]) {
      if (q.result) continue;
      if (q.windowEnd > hLast) { pending++; continue; }
      if (idx(q.windowStart) < 0) { q.result = { void: true, reason: "window older than stored history" }; changed = true; continue; }
      const a = idx(q.windowStart), b = idx(q.windowEnd) + 1;
      const win = blocks.slice(a, b);
      const dataHash = createHash("sha256").update(win.map((x) => `${x.h},${x.signer},${x.ts},${x.ntx}`).join("\n")).digest("hex");
      const countOf = (who: string) => win.filter((x) => x.signer === who).length;
      // Void: any subject offline longer than luck allows (chance < voidAlpha), using its rate at release
      const offline = q.subjects.filter((who) => {
        const rate = q.model.rates[who];
        let last = a - 1, gap = 0;
        for (let i = a; i < b; i++) if (blocks[i].signer === who) { gap = Math.max(gap, i - last - 1); last = i; }
        gap = Math.max(gap, b - 1 - last);
        return gap > Math.max(g.model.minVoidBlocks ?? 0, Math.log(g.model.voidAlpha / (b - a)) / Math.log(1 - rate));
      });
      let value: number, option: number, valueText = "";
      if (TEMPLATES[q.template]?.kind === "h2h") { value = countOf(q.subjects[0]) - countOf(q.subjects[1]); option = optionFor(value, q.thresholds); }
      else if (TEMPLATES[q.template]?.kind === "combo") {
        const d1 = countOf(q.subjects[0]) - countOf(q.subjects[1]), d2 = countOf(q.subjects[2]) - countOf(q.subjects[3]);
        value = d1; valueText = `line 1 = ${d1}, line 2 = ${d2}`; option = (d1 > q.thresholds[0] ? 2 : 0) + (d2 > q.thresholds[1] ? 1 : 0);
      } else if (q.group) { value = q.group.reduce((s, who) => s + countOf(who), 0); option = optionFor(value, q.thresholds); }
      else if (q.subjects.length === 1) { value = countOf(q.subjects[0]); option = optionFor(value, q.thresholds); }
      else {
        const TSa = win.map((x) => x.ts);
        value = q.template === "M4" ? Math.max(...TSa.slice(1).map((t, i) => t - TSa[i]))
          : q.template === "M5" ? Math.round((TSa[TSa.length - 1] - TSa[0]) / (TSa.length - 1))
          : q.template === "M6" ? Math.round((1000 * win.filter((x) => x.ntx === 0).length) / win.length)
          : win.reduce((s, x) => s + x.ntx, 0);
        option = optionFor(value, q.thresholds);
      }
      if (!valueText) valueText = q.unit === "ms" ? (value / 1000).toFixed(3) + " s" : q.unit === "permille" ? (value / 10).toFixed(1) + "%" : fmt(value);
      q.result = offline.length
        ? { void: true, reason: `${offline.map(short).join(", ")} went offline during the window`, value: valueText, dataHash, resolvedAt: new Date().toISOString() }
        : { void: false, option, value: valueText, dataHash, resolvedAt: new Date().toISOString() };
      if (offline.length) {
        const wk = String(q.week);
        st.voidedByWeek[wk] = [...new Set([...(st.voidedByWeek[wk] ?? []), ...offline])];
      }
      changed = true; resolved++;
      console.log(`\n[${q.id}] ${q.title}`);
      console.log(`  ${q.result.void ? `VOID — ${q.result.reason}` : `Correct option: ${String.fromCharCode(65 + option)}) ${q.options[option].label}  (actual: ${valueText})`}`);
      console.log(`  data hash ${dataHash.slice(0, 16)}… — anyone can recompute it from blocks ${fmt(q.windowStart)}–${fmt(q.windowEnd)}`);
    }
    if (changed) fs.writeFileSync(file, JSON.stringify(day, null, 2));
  }
  saveState(st);
  console.log(`\nResolved ${resolved} question(s); ${pending} still waiting for their window to close.\n`);
}

main();

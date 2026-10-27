/**
 * Producer Race recorder (run every hour by .github/workflows/race.yml; read-only on the chain, holds no key).
 *
 * Each run:
 *  1. Handicap cards. A race has 3 legs of 2 hours (UTC 00-02-04, 06-08-10, ...), and each leg gets a card from every
 *     producer's VHP: the starting card and 2 updates per race. A leg's card is taken by the last run before the leg
 *     starts (within the hour before), or else by the first run during it. A leg no run reached keeps the card before it.
 *  2. Results. A race is final once its last block is irreversible and every one of its blocks matches on two
 *     independent nodes (RPC and RPC_CHECK, like the game's results). Until then it stays "checking".
 *  3. Writes race-data/index.json and race-data/W<week>.json (the Knode game's weeks), which the publish job puts on
 *     the race-data branch for the website.
 * The scoring is site/race-math.js, the same file the website runs.
 *
 *   RPC, RPC_CHECK ("off" to skip the second node), RACE_PREV (the race-data files from the last run), RACE_OUT.
 *   npm run race            (or: npx tsx bot/race.ts)
 */
import { Provider } from "koilib";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { readVhp, MAINNET_VHP, withRetry, sleep } from "../common.ts";
await import("../site/race-math.js");
const M: any = (globalThis as any).KRaceMath;

const E = process.env;
const RPC = E.RPC || "https://api.koinos.io";
const RPC_CHECK = E.RPC_CHECK && E.RPC_CHECK !== "off" && E.RPC_CHECK !== RPC ? E.RPC_CHECK : "";
let PREV = E.RACE_PREV || "";
let OUT = E.RACE_OUT || "race-data";
const CARD_AHEAD = 60 * 60000;            // a card for the next leg is taken by the last hourly run before it starts
const LOOKBACK = 3 * M.DAY;               // races older than this that never got final are left as they are
const isAddr = (a: unknown) => typeof a === "string" && /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a);

type Card = { at: number; blocksPerRace: number; c: number; fairness: number[] | null; field: { a: string; vhp: number; k: number; h: number }[]; paddock: { a: string; vhp: number; k: number }[] };
type Race = { id: string; start: number; end: number; cards: (Card | null)[]; result: any | null };
type WeekFile = { v: 1; week: number; start: number; end: number; races: Race[] };

// ── the files from the previous run ──
function readPrev(name: string): any {
  if (!PREV) return null;
  const f = path.join(PREV, name);
  try { if (fs.lstatSync(f).isSymbolicLink()) return null; return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; }
}
function emptyWeek(w: number): WeekFile {
  const start = M.weekStart(w), races: Race[] = [];
  for (let t = start; t < start + M.WEEK; t += M.RACE) { const i = M.raceIndex(t); races.push({ id: M.raceId(i), start: M.raceStart(i), end: M.raceStart(i) + M.RACE, cards: [null, null, null], result: null }); }
  return { v: 1, week: w, start, end: start + M.WEEK, races };
}
function loadWeek(w: number): WeekFile {
  const fresh = emptyWeek(w), old = readPrev(`W${String(w).padStart(3, "0")}.json`);
  if (!old || old.v !== 1 || old.week !== w || !Array.isArray(old.races)) return fresh;
  for (const r of fresh.races) {
    const o = old.races.find((x: any) => x && x.id === r.id);
    if (!o) continue;
    if (Array.isArray(o.cards) && o.cards.length === 3) r.cards = o.cards.map((c: any) => (c && Array.isArray(c.field) ? c : null));
    if (o.result && typeof o.result === "object") r.result = o.result;
  }
  return fresh;
}

// ── chain reads ──
type Blocks = { hs: number[]; ts: number[]; sig: number[]; signers: string[] };
async function readBlocks(p: any, headId: string, from: number, to: number): Promise<Blocks> {
  const n = to - from + 1, signer: string[] = new Array(n), ts: number[] = new Array(n);
  const queue: [number, number][] = [];
  for (let s = from; s <= to; s += 200) queue.push([s, Math.min(to, s + 199)]);
  const worker = async () => {
    while (queue.length) {
      const [s, e] = queue.shift()!;
      let k = s;
      while (k <= e) {
        const res: any = await withRetry(`blocks at ${k}`, () => p.call("block_store.get_blocks_by_height", { head_block_id: headId, ancestor_start_height: String(k), num_blocks: e - k + 1, return_block: true, return_receipt: false }));
        const items = res?.block_items ?? [];
        if (!items.length) throw new Error(`no blocks returned at ${k}`);
        for (const it of items) {
          const h = Number(it.block_height);
          if (h !== k || h > e) throw new Error(`blocks out of order at ${k}`);
          signer[h - from] = it.block.header.signer; ts[h - from] = Number(it.block.header.timestamp); k++;
        }
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  const idx = new Map<string, number>(), signers: string[] = [], sig: number[] = [];
  for (const a of signer) { let i = idx.get(a); if (i === undefined) { i = signers.length; signers.push(a); idx.set(a, i); } sig.push(i); }
  return { hs: Array.from({ length: n }, (_, i) => from + i), ts, sig, signers };
}
async function blockTime(p: any, headId: string, h: number): Promise<number> {
  const res: any = await withRetry(`block ${h}`, () => p.call("block_store.get_blocks_by_height", { head_block_id: headId, ancestor_start_height: String(h), num_blocks: 1, return_block: true, return_receipt: false }));
  const it = res?.block_items?.[0];
  if (!it || Number(it.block_height) !== h) throw new Error(`block ${h} not returned`);
  return Number(it.block.header.timestamp);
}
/** The first height whose block time is at or after t (binary search between lo and hi). */
async function heightAt(p: any, headId: string, t: number, lo: number, hi: number): Promise<number> {
  while (lo < hi) { const m = Math.floor((lo + hi) / 2); if ((await blockTime(p, headId, m)) < t) lo = m + 1; else hi = m; }
  return lo;
}

type Opts = { p: any; check: any | null; prev?: string; out?: string; vhpOf?: (who: string[]) => Promise<Record<string, string>> };
/** One run. Exported for the tests, which pass fake nodes. */
export async function run({ p, check, prev, out, vhpOf }: Opts) {
  if (prev !== undefined) PREV = prev;
  if (out !== undefined) OUT = out;
  const vhpRead = vhpOf || (async (who: string[]) => (await readVhp(p, MAINNET_VHP, who)).values);
  const head: any = await withRetry("head", () => p.getHeadInfo());
  const headH = Number(head.head_topology.height), headId = head.head_topology.id, now = Number(head.head_block_time);
  const libH = Number(head.last_irreversible_block), libT = await blockTime(p, headId, libH);
  console.log(`head ${headH} (${new Date(now).toISOString()}), irreversible ${libH} (${new Date(libT).toISOString()})`);

  const wNow = M.weekOf(now), weeks = new Map<number, WeekFile>();
  for (const w of new Set([M.weekOf(now - LOOKBACK), wNow, M.weekOf(now + CARD_AHEAD)])) weeks.set(w, loadWeek(w));
  const raceById = (id: string) => { for (const wf of weeks.values()) { const r = wf.races.find((x) => x.id === id); if (r) return r; } return null; };
  const problems: string[] = [];

  // ── 1. cards ──
  const legStart = (t: number) => Math.floor(t / M.LEG) * M.LEG;
  const want: { race: Race; leg: number }[] = [];
  const curLeg = legStart(now), nextLeg = curLeg + M.LEG;
  for (const s of [curLeg, nextLeg]) {
    if (s === nextLeg && s - now > CARD_AHEAD) continue;
    const ra = M.raceAt(s), race = raceById(ra.id), leg = M.legOf(ra.start, s);
    if (race && !race.cards[leg]) want.push({ race, leg });
  }
  if (want.length) {
    const recent = await readBlocks(p, headId, Math.max(1, headH - 7199), headH);       // about the last 6 hours
    const span = recent.ts[recent.ts.length - 1] - recent.ts[0];
    const blocksPerRace = span > 0 ? (recent.ts.length - 1) * M.RACE / span : 7200;
    const producers = recent.signers.filter(isAddr);
    const values = await vhpRead(producers);
    const vhp: [string, number][] = producers.map((a) => [a, Number(values[a] || "0") / 1e8]);
    const card: Card = M.makeCard(vhp, blocksPerRace, now);
    for (const { race, leg } of want) { race.cards[leg] = card; console.log(`card for ${race.id} leg ${leg + 1}: ${card.field.length} horses, c = ${card.c}`); }
  }

  // ── 2. results ──
  // Races before the recorder's first card were never run; only a race after it with no card at all is "missed".
  let firstCard = Infinity;
  for (const wf of weeks.values()) for (const r of wf.races) if (r.cards.some(Boolean)) firstCard = Math.min(firstCard, r.start);
  for (const wf of weeks.values()) for (const race of wf.races) {
    if (race.result?.final || race.end > libT || race.end < now - LOOKBACK) continue;
    if (!race.cards.some(Boolean)) { if (race.start > firstCard) race.result = { final: true, missed: true, note: "no handicap card was recorded for this race" }; continue; }
    try {
      // A height safely before the race start (blocks average 3 s apart; step further back until it is before).
      const est = Math.ceil((libT - race.start) / 3000) + 600;
      let lo = Math.max(1, libH - est);
      while (lo > 1 && (await blockTime(p, headId, lo)) >= race.start) lo = Math.max(1, lo - est);
      const a = await heightAt(p, headId, race.start, lo, libH), b = (await heightAt(p, headId, race.end, a, libH)) - 1;
      const B = await readBlocks(p, headId, a, b);
      let checked = 1;
      if (check) {
        const ch: any = await withRetry("check head", () => check.getHeadInfo());
        const C = await readBlocks(check, ch.head_topology.id, a, b);
        const same = C.ts.length === B.ts.length && C.ts.every((t, i) => t === B.ts[i] && C.signers[C.sig[i]] === B.signers[B.sig[i]]);
        if (!same) { problems.push(`${race.id}: the two nodes disagree about the race's blocks; not final this run`); continue; }
        checked = 2;
      }
      const st = M.standings(B, race, race.cards);
      race.result = {
        final: true, checked, heights: [a, b], blocks: B.ts.length, line: M.finishLine(race.cards),
        winner: M.winners(st)[0] || null, standings: st.map((x: any) => ({ a: x.a, steps: x.steps, blocks: x.blocks })),
      };
      console.log(`${race.id}: final, winner ${race.result.winner} (${st[0]?.steps} steps), blocks ${a}-${b}, checked on ${checked} node(s)`);
    } catch (e) { problems.push(`${race.id}: ${(e as Error).message} (tried again next run)`); }
    await sleep(200);
  }

  // ── 3. write ──
  fs.mkdirSync(OUT, { recursive: true });
  const idx = readPrev("index.json"), known = new Set<number>(Array.isArray(idx?.weeks) ? idx.weeks.filter((w: any) => Number.isInteger(w) && w >= 0 && w < 10000) : []);
  for (const [w, wf] of weeks) {
    if (!wf.races.some((r) => r.cards.some(Boolean) || r.result)) continue;
    known.add(w);
    fs.writeFileSync(path.join(OUT, `W${String(w).padStart(3, "0")}.json`), JSON.stringify(wf) + "\n");
  }
  fs.writeFileSync(path.join(OUT, "index.json"), JSON.stringify({ v: 1, updated: new Date(now).toISOString(), weeks: [...known].sort((x, y) => x - y) }) + "\n");
  for (const pr of problems) console.log(`::warning::${pr}`);
  return { problems };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run({ p: new Provider([RPC]), check: RPC_CHECK ? new Provider([RPC_CHECK]) : null }).catch((e) => { console.error(e); process.exit(1); });
}

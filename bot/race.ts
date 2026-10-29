/**
 * Producer Race recorder (run every hour by .github/workflows/race.yml; read-only on the chain, holds no key).
 *
 * Each run:
 *  1. Handicap cards. A race has 6 legs of 1 hour, and each leg gets a card from every producer's VHP: the starting
 *     card and an update every hour (races recorded before 2026-10-27 have 3 legs of 2 hours and keep them). A leg's
 *     card is taken by the last run before the leg starts (within the hour before), or else by the first run during it.
 *     A leg no run reached keeps the card before it.
 *  2. Results. A race is final once its last block is irreversible and every one of its blocks matches on two
 *     independent nodes (RPC and RPC_CHECK, like the game's results). Until then it stays "checking".
 *     Once the race picks contract is live (race-data/deployment.json on main), each final race also records every
 *     pick (read on both nodes; picks are locked by the chain when a race starts), who picked the winner, and whether
 *     each wallet could be ranked (holds 1 VHP or has a Knode stake) when the race was finalized.
 *  3. Leaderboards (board.json): Today (UTC day), This week (the Knode game's week) and All time, ranked by points:
 *     a pick on the winner is a win (3 points), a pick on the 2nd or 3rd horse a show (1 point). Ties: more wins, then
 *     more picks placed, then more Knode questions answered, then a higher Knode score.
 *  4. Writes race-data/index.json, race-data/W<week>.json and race-data/board.json, which the publish job puts on the
 *     race-data branch for the website.
 * The scoring is race-math.js, the same file the website runs.
 *
 *   RPC, RPC_CHECK ("off" to skip the second node), RACE_PREV (the race-data files from the last run), RACE_OUT.
 *   npm run race            (or: npx tsx bot/race.ts)
 */
import { Provider } from "koilib";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { randomInt } from "node:crypto";
import { Contract } from "koilib";
import { readVhp, MAINNET_VHP, withRetry, sleep } from "../common.ts";
await import("../race-math.js");
const M: any = (globalThis as any).KRaceMath;

const E = process.env;
const RPC = E.RPC || "https://koinos.armana.io";
const RPC_CHECK = E.RPC_CHECK && E.RPC_CHECK !== "off" && E.RPC_CHECK !== RPC ? E.RPC_CHECK : "";
let PREV = E.RACE_PREV || "";
let OUT = E.RACE_OUT || "race-data";
const CARD_AHEAD = 60 * 60000;
// Audit BX-54: how far an irreversible block may trail its head, how far the two nodes' irreversible blocks may differ,
// and how far their head times may differ, before no card is made (Koinos makes a block about every 3 s; irreversible
// trails the head by about 60 blocks).
export const LIB_LAG_MAX = 200, LIB_GAP_MAX = 30, HEAD_GAP_MS = 60000;            // a card for the next leg is taken by the last hourly run before it starts
const LOOKBACK = 3 * M.DAY;               // races older than this that never got final are left as they are
const isAddr = (a: unknown) => typeof a === "string" && /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a);

// ── Handicap VHP that is hard to game (audit BX-3 b; owner 2026-10-28; project doc claude/handicap-anti-gaming.md) ──
// Only looking SMALL on a card pays (a bigger multiplier), so the card errs the other way:
//  1. effective VHP (what block production uses: added VHP counts only after 20 blocks), read on both nodes;
//  2. samples at random moments about every 5 minutes (bot/race.ts --sample, .github/workflows/race-samples.yml);
//     a producer's card VHP is the HIGHEST of its samples over the last 6 hours and the read at card time;
//  3. a producer that signed clearly more blocks in the last ~6 hours than its card share allows (beyond 3 standard
//     deviations of luck) is raised to the share its real production supports.
// These only decide which VHP feeds the card. Each game keeps its own multiplier rule.
export const SAMPLE_WINDOW = 6 * 3600000;          // samples count for 6 hours
export const SAMPLE_KEEP = 8 * 3600000;            // and are kept 8 hours
export const SAMPLE_MAX = 120;            // 8 hours at one sample every ~5 minutes
export type Sample = { at: number; height: number; vhp: Record<string, string> };
export type SampleFile = { v: 1; updated: string; samples: Sample[] };
const SAMPLES = "vhp-samples.json";
/** The previous run's samples: only well-formed ones, never from the future (audit BX-38: a sample dated after `now`
 *  plus a minute is dropped, so one bad head time can't block the samples that come after it), newest last. */
export const FUTURE_MS = 60000;
export function loadSamples(now = Date.now()): Sample[] {
  const f = readPrev(SAMPLES);
  if (!f || f.v !== 1 || !Array.isArray(f.samples)) return [];
  return f.samples.filter((x: any) => x && Number.isFinite(x.at) && x.at <= now + FUTURE_MS && Number.isInteger(x.height) && x.vhp && typeof x.vhp === "object"
    && Object.entries(x.vhp).every(([a, v]) => isAddr(a) && typeof v === "string" && /^\d{1,20}$/.test(v as string))).sort((a: Sample, b: Sample) => a.at - b.at);
}
/** Audit BX-37 / BX-55: two nodes' reads of every producer's VHP, combined producer by producer (never all or
 *  nothing). Reads within 0.5% of each other count at the higher one. A producer whose reads differ by more counts at
 *  the LOWER read and is FLAGGED on the card: one node can then neither lift a producer to the top (turning ×3 into
 *  ×1 for the players who picked it) nor quietly make it small, because Block X holds any target whose signer is
 *  flagged (bot/games/blockx.ts) until a card without the flag exists. (Round 2 used the higher read, capped at the
 *  top both agree on; round 3 showed one node could still lift any producer to that top.)
 *  Returns the combined values and the producers that differed. */
export function combineReads(a: Record<string, string>, b: Record<string, string> | null, who: string[]): { values: Record<string, string>; differ: string[] } {
  if (!b) return { values: Object.fromEntries(who.map((x) => [x, String(a[x] || "0")])), differ: [] };
  const differ: string[] = [];
  const values: Record<string, string> = {};
  for (const x of who) {
    const u = BigInt(a[x] || "0"), v = BigInt(b[x] || "0"), hi = u > v ? u : v, lo = u < v ? u : v;
    if (hi - lo > hi / 200n) { differ.push(x); values[x] = String(lo); }
    else values[x] = String(hi);
  }
  return { values, differ };
}
/** Rule 2: each producer's VHP (1e-8 units) = the highest of `now` (read at card time) and its samples taken in
 *  (t - SAMPLE_WINDOW, t]. Samples after t never count (a card only uses what was known when it was taken). */
export function windowHigh(now: Record<string, string>, samples: Sample[], t: number, supply: bigint | null = null): Record<string, bigint> {
  const out: Record<string, bigint> = {};
  for (const [a, v] of Object.entries(now)) out[a] = BigInt(v || "0");
  // Audit BX-57: a "total supply" below what one producer holds right now is impossible (one node lying): no cap then.
  for (const v of Object.values(out)) if (supply !== null && v > supply) { supply = null; break; }
  for (const smp of samples) {
    if (!(smp.at <= t && smp.at > t - SAMPLE_WINDOW)) continue;
    for (const a of Object.keys(out)) {
      let v = smp.vhp[a] !== undefined ? BigInt(smp.vhp[a]) : -1n;
      if (supply !== null && supply > 0n && v > supply) v = supply;    // audit BX-44: no sample above all the VHP there is
      if (v > out[a]) out[a] = v;
    }
  }
  return out;
}
/** Samples in the window before t (a card made from fewer than MIN_SAMPLES is flagged; audit BX-38). */
export const MIN_SAMPLES = 12;
export const samplesIn = (samples: Sample[], t: number) => samples.filter((x) => x.at <= t && x.at > t - SAMPLE_WINDOW).length;
/** Rule 3: raise a producer whose real block count is far above its card share. counts: blocks each signed out of
 *  `total`. Only raises (never lowers) VHP. Returns the new values and who was raised. */
export function productionFloor(vhp: Record<string, bigint>, counts: Map<string, number>, total: number): { vhp: Record<string, bigint>; raised: string[] } {
  const out = { ...vhp };
  const T0 = Object.values(vhp).reduce((x, y) => x + y, 0n);
  if (T0 <= 0n || total <= 0) return { vhp: out, raised: [] };
  // The least share each producer's production supports (3 standard deviations below what it signed).
  const low = new Map<string, number>();
  for (const a of Object.keys(vhp)) { const n = counts.get(a) || 0; if (n >= 10) { const l = (n - 3 * Math.sqrt(n)) / total; if (l > 0 && l < 1) low.set(a, l); } }
  // Audit BX-43: solve the raises together. With S the raised set, each a in S gets share low[a] of the new total
  // T = (sum of the others) / (1 - sum of low over S). Grow S until nobody outside it is below its floor.
  const S = new Set<string>();
  for (let it = 0; it < 64; it++) {
    const lowSum = [...S].reduce((x, a) => x + low.get(a)!, 0);
    if (lowSum >= 1) break;
    const rest = Object.entries(vhp).filter(([a]) => !S.has(a)).reduce((x, [, v]) => x + Number(v), 0);
    const T = rest / (1 - lowSum);
    const add = [...low.entries()].filter(([a, l]) => !S.has(a) && Number(vhp[a]) < l * T - 1e-9).map(([a]) => a);
    if (!add.length) {
      for (const a of S) { const need = BigInt(Math.ceil(low.get(a)! * T)); if (need > out[a]) out[a] = need; }
      break;
    }
    for (const a of add) S.add(a);
  }
  const raised = [...S].filter((a) => out[a] > vhp[a]);
  return { vhp: out, raised };
}

type Card = { at: number; blocksPerRace: number; c: number; fairness: number[] | null; field: { a: string; vhp: number; k: number; h: number }[]; paddock: { a: string; vhp: number; k: number }[]; samples?: number; flagged?: string[] };
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
  for (let t = start; t < start + M.WEEK; t += M.RACE) { const i = M.raceIndex(t); races.push({ id: M.raceId(i), start: M.raceStart(i), end: M.raceStart(i) + M.RACE, cards: new Array(M.LEGS).fill(null), result: null }); }
  return { v: 1, week: w, start, end: start + M.WEEK, races };
}
function loadWeek(w: number): WeekFile {
  const fresh = emptyWeek(w), old = readPrev(`W${String(w).padStart(3, "0")}.json`);
  if (!old || old.v !== 1 || old.week !== w || !Array.isArray(old.races)) return fresh;
  for (const r of fresh.races) {
    const o = old.races.find((x: any) => x && x.id === r.id);
    if (!o) continue;
    // A race keeps the format it started with: 3 two-hour cards (before 2026-10-27) once any was taken, else hourly.
    if (Array.isArray(o.cards) && (o.cards.length === 3 || o.cards.length === 6) && o.cards.some((c: any) => c && Array.isArray(c.field)))
      r.cards = o.cards.map((c: any) => (c && Array.isArray(c.field) ? c : null));
    if (o.result && typeof o.result === "object") r.result = withShows(o.result);
  }
  return fresh;
}
/** Picks recorded before Show existed have 5 fields; add the 6th (show 1/0) from the race's own stored standings. */
function withShows(result: any): any {
  if (!Array.isArray(result?.picks) || !Array.isArray(result.standings)) return result;
  const sh = new Set<string>(M.shows(result.standings));
  return { ...result, picks: result.picks.map((x: any) => (Array.isArray(x) && x.length === 5 ? [...x, x[3] ? 0 : sh.has(x[1]) ? 1 : 0] : x)) };
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

/** One pick as recorded: [player, horse, time of the pick (ms)]. */
type Pick = [string, string, number];
/** What the game knows about a wallet: stake, and the week's Knode answers and points. */
type PlayerInfo = { stake: bigint; answers: number; points: number };
type Opts = {
  p: any; check: any | null; prev?: string; out?: string; vhpOf?: (who: string[]) => Promise<Record<string, string>>;
  /** The second node's VHP read (tests). Default: the check node; with vhpOf given and this not, the same as vhpOf. */
  vhpCheckOf?: (who: string[]) => Promise<Record<string, string>>;
  raceContract?: string | null;                                       // the picks contract (default: race-data/deployment.json)
  picksOf?: (node: any, race: number) => Promise<Pick[]>;             // for the tests
  playerOf?: (node: any, who: string, week: number) => Promise<PlayerInfo>;
};

// ── the picks contract and the game (read only) ──
const RACE_ABI = () => JSON.parse(fs.readFileSync(new URL("../race/abi/race.koilib.json", import.meta.url), "utf8"));
const GAME_ABI = () => JSON.parse(fs.readFileSync(new URL("../game/abi/kpred.koilib.json", import.meta.url), "utf8"));
const GAME = (() => { try { return JSON.parse(fs.readFileSync(new URL("../game-data/deployment.json", import.meta.url), "utf8")).contract as string; } catch { return ""; } })();
function defaultRaceContract(): string | null {
  try { const d = JSON.parse(fs.readFileSync(new URL("../race-data/deployment.json", import.meta.url), "utf8")); return isAddr(d.contract) ? d.contract : null; } catch { return null; }
}
/** Every pick for a race, page by page (100 at a time). */
async function readPicks(node: any, contract: string, raceNo: number): Promise<Pick[]> {
  const c = new Contract({ id: contract, abi: RACE_ABI(), provider: node });
  const out: Pick[] = [];
  let after: string | undefined;
  for (let page = 0; page < 1000; page++) {
    const r: any = await withRetry(`picks for race ${raceNo}`, () => (c.functions as any).list_picks({ race: String(raceNo), ...(after ? { start_after: after } : {}), limit: 100 }));
    const rows = r?.result?.rows ?? [];
    for (const x of rows) if (isAddr(x.player) && isAddr(x.pick?.horse)) out.push([x.player, x.pick.horse, Number(x.pick.at || 0)]);
    if (!rows.length) break;                                    // audit BX-18: page until an empty page
    after = rows[rows.length - 1].player;
  }
  return out;
}
async function readPlayer(node: any, who: string, week: number): Promise<PlayerInfo> {
  if (!GAME) return { stake: 0n, answers: 0, points: 0 };
  const c = new Contract({ id: GAME, abi: GAME_ABI(), provider: node });
  const r: any = await withRetry(`Knode player ${who}`, () => (c.functions as any).get_player({ player: who, week: String(week) }));
  const p = r?.result?.player ?? {}, e = r?.result?.entry ?? {};
  return { stake: BigInt(p.stake || "0") + BigInt(p.pending || "0"), answers: Array.isArray(e.answers) ? e.answers.length : 0, points: Number(e.points || 0) };
}
/** One run. Exported for the tests, which pass fake nodes. */
export async function run({ p, check, prev, out, vhpOf, vhpCheckOf, raceContract, picksOf, playerOf }: Opts) {
  if (prev !== undefined) PREV = prev;
  if (out !== undefined) OUT = out;
  // Cards: effective VHP (audit BX-3 b). Who may be ranked (holds 1 VHP): the plain balance, as before.
  const vhpRead = vhpOf || (async (who: string[]) => (await readVhp(p, MAINNET_VHP, who, { effective: true })).values);
  const vhpCheck = !check ? null : vhpCheckOf || vhpOf || (async (who: string[]) => (await readVhp(check, MAINNET_VHP, who, { effective: true })).values);
  const rawRead = vhpOf || (async (who: string[]) => (await readVhp(p, MAINNET_VHP, who)).values);
  const picksContract = raceContract === undefined ? defaultRaceContract() : raceContract;
  const picksRead = picksOf || (picksContract ? (node: any, r: number) => readPicks(node, picksContract, r) : null);
  const playerRead = playerOf || readPlayer;
  // Who may be ranked: at least 1 VHP, or a Knode stake (the Mana sponsor's "real player" rule). Read once per run.
  const eligibleCache = new Map<string, boolean>();
  async function eligible(who: string[]) {
    const todo = who.filter((a) => !eligibleCache.has(a));
    if (todo.length) {
      const vhp = await rawRead(todo);
      for (const a of todo) {
        let ok = BigInt(vhp[a] || "0") >= 100000000n;
        if (!ok) { try { ok = (await playerRead(p, a, M.weekOf(Date.now()))).stake > 0n; } catch { ok = false; } }
        eligibleCache.set(a, ok);
      }
    }
    return (a: string) => eligibleCache.get(a) === true;
  }
  const head: any = await withRetry("head", () => p.getHeadInfo());
  const headH = Number(head.head_topology.height), headId = head.head_topology.id, now = Number(head.head_block_time);
  const libH = Number(head.last_irreversible_block), libT = await blockTime(p, headId, libH);
  console.log(`head ${headH} (${new Date(now).toISOString()}), irreversible ${libH} (${new Date(libT).toISOString()})`);

  const wNow = M.weekOf(now), weeks = new Map<number, WeekFile>();
  for (const w of new Set([M.weekOf(now - LOOKBACK), wNow, M.weekOf(now + CARD_AHEAD)])) weeks.set(w, loadWeek(w));
  const raceById = (id: string) => { for (const wf of weeks.values()) { const r = wf.races.find((x) => x.id === id); if (r) return r; } return null; };
  const problems: string[] = [];
  const samples = loadSamples(now);

  // ── 1. cards ──
  const legStart = (t: number) => Math.floor(t / M.LEG) * M.LEG;
  const want: { race: Race; leg: number }[] = [];
  const curLeg = legStart(now), nextLeg = curLeg + M.LEG;
  for (const s of [curLeg, nextLeg]) {
    if (s === nextLeg && s - now > CARD_AHEAD) continue;
    const ra = M.raceAt(s), race = raceById(ra.id);
    if (!race) continue;
    const leg = M.legOf(ra.start, s, race.cards.length);
    if (!race.cards[leg] && !want.some((x) => x.race === race && x.leg === leg)) want.push({ race, leg });
  }
  let winEnd = libH, cardTime = now, chId: string | null = null, nodesOk = true;
  if (want.length) {
    // Audit BX-36: the block window behind the card (who produces, how often, blocks per race) and the card's time are
    // read on BOTH nodes, ending at the lower irreversible block, and must match exactly; otherwise no card this run.
    nodesOk = headH - libH <= LIB_LAG_MAX;
    if (!nodesOk) problems.push(`the node's irreversible block is ${headH - libH} blocks behind its head (more than ${LIB_LAG_MAX}); no handicap card this run`);
    if (check) {
      const ch: any = await withRetry("check head", () => check.getHeadInfo());
      const chLib = Number(ch.last_irreversible_block), chHead = Number(ch.head_topology.height), chTime = Number(ch.head_block_time);
      // Audit BX-54: neither node may steer the window or the card's time on its own. Both irreversible blocks must be
      // recent (at most LIB_LAG_MAX behind their heads) and within LIB_GAP_MAX of each other, and the two head times
      // within HEAD_GAP_MS; the card is then dated by the later head (never back-dated, and at most HEAD_GAP_MS ahead).
      if (chHead - chLib > LIB_LAG_MAX || Math.abs(libH - chLib) > LIB_GAP_MAX) { nodesOk = false; problems.push(`the two nodes' irreversible blocks (${libH}, ${chLib}) are too far apart or behind (check node head ${chHead}); no handicap card this run`); }
      if (Math.abs(chTime - now) > HEAD_GAP_MS) { nodesOk = false; problems.push(`the two nodes' head times differ by ${Math.round(Math.abs(chTime - now) / 1000)} s; no handicap card this run`); }
      winEnd = Math.min(libH, chLib);
      cardTime = Math.max(now, chTime);    // never back-dated by one node
      chId = ch.head_topology.id;
    }
    if (!nodesOk) want.length = 0;
  }
  if (want.length) {
    const recent = await readBlocks(p, headId, Math.max(1, winEnd - 7199), winEnd);       // about the last 6 hours
    let sameWindow = true;
    if (check && chId) {
      const other = await readBlocks(check, chId, Math.max(1, winEnd - 7199), winEnd);
      sameWindow = other.ts.length === recent.ts.length && other.ts.every((t, i) => t === recent.ts[i] && other.signers[other.sig[i]] === recent.signers[recent.sig[i]]);
    }
    if (!sameWindow) problems.push("the two nodes disagree about the last 6 hours of blocks; the handicap card waits for the next run");
    else {
      const span = recent.ts[recent.ts.length - 1] - recent.ts[0];
      const blocksPerRace = span > 0 ? (recent.ts.length - 1) * M.RACE / span : 7200;
      const producers = recent.signers.filter(isAddr);
      const mine = await vhpRead([...producers, "network"]);
      const theirs = vhpCheck ? await vhpCheck([...producers, "network"]) : null;
      // Audit BX-37: producer by producer, never the whole card for one address.
      const { values, differ } = combineReads(mine, theirs, producers);
      for (const a of differ) problems.push(`the two nodes disagree on ${a}'s VHP; it counts at the lower read and is flagged on the card (Block X holds a target it signs)`);
      const sup = (x: Record<string, string> | null) => { const v = x && x.network; return v && /^\d+$/.test(v) ? BigInt(v) : null; };
      // Audit BX-57: the HIGHER of the two nodes' totals (one node reporting "1" can't switch the samples off).
      const supply = [sup(mine), sup(theirs)].filter((x): x is bigint => x !== null).reduce<bigint | null>((m, x) => (m === null || x > m ? x : m), null);
      // Blocks each producer signed in the window (recent.sig: each block's index into recent.signers).
      const counts = new Map<string, number>(); for (const i of recent.sig) { const a = recent.signers[i]; if (isAddr(a)) counts.set(a, (counts.get(a) || 0) + 1); }
      const high = windowHigh(values, samples, cardTime, supply);
      const { vhp: fair, raised } = productionFloor(high, counts, recent.sig.length);
      for (const a of raised) console.log(`card: ${a} signed more blocks than its VHP allows; raised to ${Number(fair[a]) / 1e8} VHP for the card`);
      const used = samplesIn(samples, cardTime);
      const vhp: [string, number][] = producers.map((a) => [a, Number(fair[a] || 0n) / 1e8]);
      const card: Card = { ...M.makeCard(vhp, blocksPerRace, cardTime), samples: used, ...(differ.length ? { flagged: [...differ].sort() } : {}) };
      // Audit BX-38: a card made from too few samples is published but flagged; Block X doesn't score with it.
      if (used < MIN_SAMPLES) problems.push(`handicap card from only ${used} VHP sample(s) in the last 6 hours (want ${MIN_SAMPLES}); flagged: Block X waits for a card with enough samples`);
      console.log(`card VHP: effective, highest of ${used} sample(s) in the last 6 hours and the read now`);
      for (const { race, leg } of want) { race.cards[leg] = card; console.log(`card for ${race.id} leg ${leg + 1}: ${card.field.length} horses, c = ${card.c}${check ? ", blocks and VHP checked on 2 nodes" : ""}`); }
    }
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
      const winner = M.winners(st)[0] || null, showSet = new Set<string>(M.shows(st));
      // The picks (locked by the chain since the race started), read on both nodes like the blocks.
      let picks: any[] | undefined;
      if (picksRead) {
        const raceNo = M.raceIndex(race.start);
        const mine = await picksRead(p, raceNo);
        if (check) {
          const theirs = await picksRead(check, raceNo);
          const key = (x: Pick[]) => JSON.stringify([...x].sort((u, v) => (u[0] < v[0] ? -1 : 1)));
          if (key(mine) !== key(theirs)) { problems.push(`${race.id}: the two nodes disagree about the race's picks; not final this run`); continue; }
        }
        const can = await eligible(mine.map((x) => x[0]));
        // [player, horse, time, won (1/0), may be ranked (1/0), show: 2nd or 3rd (1/0)]
        picks = mine.map(([who, horse, at]) => [who, horse, at, horse === winner ? 1 : 0, can(who) ? 1 : 0, horse !== winner && showSet.has(horse) ? 1 : 0]);
      }
      race.result = {
        final: true, checked, heights: [a, b], blocks: B.ts.length, line: M.finishLine(race.cards),
        winner, standings: st.map((x: any) => ({ a: x.a, steps: x.steps, blocks: x.blocks })),
        ...(picks ? { picks } : {}),
      };
      console.log(`${race.id}: final, winner ${race.result.winner} (${st[0]?.steps} steps), blocks ${a}-${b}, checked on ${checked} node(s)`);
    } catch (e) { problems.push(`${race.id}: ${(e as Error).message} (tried again next run)`); }
    await sleep(200);
  }

  // ── 3. leaderboards ──
  const board = await leaderboards(weeks, now, (who, week) => playerRead(p, who, week), problems);

  // ── 4. write ──
  fs.mkdirSync(OUT, { recursive: true });
  const idx = readPrev("index.json"), known = new Set<number>(Array.isArray(idx?.weeks) ? idx.weeks.filter((w: any) => Number.isInteger(w) && w >= 0 && w < 10000) : []);
  for (const [w, wf] of weeks) {
    if (!wf.races.some((r) => r.cards.some(Boolean) || r.result)) continue;
    known.add(w);
    fs.writeFileSync(path.join(OUT, `W${String(w).padStart(3, "0")}.json`), JSON.stringify(wf) + "\n");
  }
  fs.writeFileSync(path.join(OUT, "index.json"), JSON.stringify({ v: 1, updated: new Date(now).toISOString(), weeks: [...known].sort((x, y) => x - y) }) + "\n");
  if (board) fs.writeFileSync(path.join(OUT, "board.json"), JSON.stringify(board) + "\n");
  for (const pr of problems) console.log(`::warning::${pr}`);
  return { problems };
}

// ── leaderboards ──
/** correct = wins (picks on the winner), shows = picks on the 2nd or 3rd horse, pts = 3 per win + 1 per show. */
type Row = { a: string; pts: number; correct: number; shows: number; picks: number; answers: number; points: number; ranked: boolean };
/** Sort: points, then more wins, then more picks placed, then more Knode answers, then a higher Knode score. Exported. */
export function rank(rows: Row[]): Row[] {
  return [...rows].sort((x, y) => y.pts - x.pts || y.correct - x.correct || y.picks - x.picks || y.answers - x.answers || y.points - x.points || (x.a < y.a ? -1 : 1));
}
/** The picks of final races in [from, to): per wallet, wins, shows and picks placed, and whether it may be ranked. */
function tally(weeks: Map<number, WeekFile>, from: number, to: number) {
  const t = new Map<string, { correct: number; shows: number; picks: number; ranked: boolean }>();
  for (const wf of weeks.values()) for (const r of wf.races) {
    if (r.start < from || r.start >= to || !r.result?.final || !Array.isArray(r.result.picks)) continue;
    for (const [who, , , right, can, show] of r.result.picks) {
      const x = t.get(who) || { correct: 0, shows: 0, picks: 0, ranked: false };
      x.picks++; x.correct += right ? 1 : 0; x.shows += !right && show ? 1 : 0; x.ranked = x.ranked || !!can;
      t.set(who, x);
    }
  }
  return t;
}
async function leaderboards(weeks: Map<number, WeekFile>, now: number, player: (who: string, week: number) => Promise<PlayerInfo>, problems: string[]) {
  // All time needs every week: load the ones this run didn't (read only).
  const all = new Map(weeks);
  const idx = readPrev("index.json");
  for (const w of Array.isArray(idx?.weeks) ? idx.weeks : []) if (Number.isInteger(w) && !all.has(w)) all.set(w, loadWeek(w));
  const anyPicks = [...all.values()].some((wf) => wf.races.some((r) => Array.isArray(r.result?.picks)));
  if (!anyPicks) return null;
  const wNow = M.weekOf(now), day0 = Math.floor(now / M.DAY) * M.DAY;
  // Knode answers and points: this week's for Today and This week; summed over the weeks with picks for All time.
  const knode = new Map<string, PlayerInfo>();   // key: who|week
  const info = async (who: string, week: number) => {
    const k = `${who}|${week}`;
    if (!knode.has(k)) { try { knode.set(k, await player(who, week)); } catch (e) { problems.push(`Knode record of ${who}: ${(e as Error).message}`); knode.set(k, { stake: 0n, answers: 0, points: 0 }); } }
    return knode.get(k)!;
  };
  const build = async (from: number, to: number, weeksFor: (who: string) => number[]) => {
    const rows: Row[] = [];
    for (const [a, x] of tally(all, from, to)) {
      let answers = 0, points = 0;
      for (const w of weeksFor(a)) { const i = await info(a, w); answers += i.answers; points += i.points; }
      rows.push({ a, pts: x.correct * M.POINTS.win + x.shows * M.POINTS.show, correct: x.correct, shows: x.shows, picks: x.picks, answers, points, ranked: x.ranked });
    }
    return rank(rows);
  };
  const weeksOf = (who: string) => [...all.values()].filter((wf) => wf.races.some((r) => Array.isArray(r.result?.picks) && r.result.picks.some((p: any) => p[0] === who))).map((wf) => wf.week);
  return {
    v: 1, updated: new Date(now).toISOString(),
    today: { day: M.dayOf(now), rows: await build(day0, day0 + M.DAY, () => [wNow]) },
    week: { week: wNow, start: M.weekStart(wNow), rows: await build(M.weekStart(wNow), M.weekStart(wNow + 1), () => [wNow]) },
    lastWeek: wNow > 0 ? { week: wNow - 1, start: M.weekStart(wNow - 1), rows: await build(M.weekStart(wNow - 1), M.weekStart(wNow), () => [wNow - 1]) } : null,
    allTime: { rows: await build(0, Infinity, weeksOf) },
  };
}

/** The producers (field and paddock) on the newest card in the published week files of the last day (audit BX-53). */
function latestCardProducers(now: number): string[] {
  let best: Card | null = null;
  for (const w of new Set([M.weekOf(now - M.DAY), M.weekOf(now)])) {
    const wf = readPrev(`W${String(w).padStart(3, "0")}.json`);
    for (const r of (wf && Array.isArray(wf.races) ? wf.races : [])) for (const c of (Array.isArray(r?.cards) ? r.cards : [])) {
      if (c && Number.isFinite(c.at) && c.at <= now + FUTURE_MS && (!best || c.at > best.at)) best = c;
    }
  }
  if (!best) return [];
  return [...(best.field || []), ...(best.paddock || [])].map((r: any) => r && r.a).filter(isAddr).slice(0, 500);
}

/** --sample: one VHP sample at a random moment (rule 2). Waits a random 0 to `spreadMs` first (a secret chosen here,
 *  never published ahead), reads the producers of about the last hour of blocks (audit BX-45: only those, so the list
 *  never grows forever), their effective VHP on both nodes (audit BX-37: producer by producer, as combineReads), and
 *  writes vhp-samples.json with the last 8 hours of samples. Audit BX-38: the sample's time is the primary node's head
 *  time, refused when it is more than a minute ahead of the check node's head or of this computer's clock.
 *  Exported for the tests. */
export async function sample({ p, check, prev, out, vhpOf, vhpCheckOf, spreadMs = 4 * 60000, wait = sleep, clock = Date.now }: { p: any; check: any | null; prev?: string; out?: string;
  vhpOf?: (who: string[]) => Promise<Record<string, string>>; vhpCheckOf?: (who: string[]) => Promise<Record<string, string>>; spreadMs?: number; wait?: (ms: number) => Promise<unknown>; clock?: () => number }) {
  if (prev !== undefined) PREV = prev;
  if (out !== undefined) OUT = out;
  const delay = spreadMs > 0 ? randomInt(0, spreadMs) : 0;
  await wait(delay);
  const head: any = await withRetry("head", () => p.getHeadInfo());
  const headH = Number(head.head_topology.height), now = Number(head.head_block_time);
  const problems: string[] = [];
  // Audit BX-56: a head time in the future is judged against this computer's clock only, so a check node a few minutes
  // behind no longer stops every sample (its VHP reads are still compared producer by producer).
  const ahead = now - clock();
  if (ahead > FUTURE_MS) problems.push(`the node's head time is ${Math.round(ahead / 1000)} s in the future; no sample this time`);
  const old = loadSamples(Math.min(now, clock()));
  const recent = await readBlocks(p, head.head_topology.id, Math.max(1, headH - 1199), headH);
  // Audit BX-53: every producer on the latest published card is sampled too (not only those that signed in the last
  // hour), so a quiet small producer can't take VHP in and out unseen; the list still can't grow without limit.
  const who = [...new Set([...recent.signers.filter(isAddr), ...latestCardProducers(Math.min(now, clock()))])];
  const read = vhpOf || (async (w: string[]) => (await readVhp(p, MAINNET_VHP, w, { effective: true })).values);
  const readCheck = !check ? null : vhpCheckOf || vhpOf || (async (w: string[]) => (await readVhp(check, MAINNET_VHP, w, { effective: true })).values);
  let keep = old.filter((x) => x.at > Math.min(now, clock()) - SAMPLE_KEEP);
  if (!problems.length) {
    const mine = await read(who);
    const theirs = readCheck ? await readCheck(who) : null;
    const { values, differ } = combineReads(mine, theirs, who);
    for (const a of differ) problems.push(`the two nodes disagree on ${a}'s effective VHP; it is sampled at the higher read (capped at the top both agree on)`);
    if (!keep.length || now > keep[keep.length - 1].at) keep = keep.concat([{ at: now, height: headH, vhp: values }]).slice(-SAMPLE_MAX);
  }
  fs.mkdirSync(OUT, { recursive: true });
  const file: SampleFile = { v: 1, updated: new Date(Math.min(now, clock())).toISOString(), samples: keep };
  fs.writeFileSync(path.join(OUT, SAMPLES), JSON.stringify(file) + "\n");
  console.log(`sample at block ${headH} (${new Date(now).toISOString()}), ${who.length} producers; ${keep.length} kept`);
  for (const pr of problems) console.log(`::warning::${pr}`);
  return { problems, delay };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const nodes = { p: new Provider([RPC]), check: RPC_CHECK ? new Provider([RPC_CHECK]) : null };
  (process.argv.includes("--sample") ? sample(nodes) : run(nodes)).catch((e) => { console.error(`error: ${String((e && e.message) || e).replace(/[\r\n]+/g, " ").replace(/::/g, ": ").slice(0, 500)}`); process.exit(1); });
}

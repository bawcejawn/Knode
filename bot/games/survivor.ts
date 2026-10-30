/**
 * Survivor recorder (run every hour by .github/workflows/games.yml; read-only on the chain, holds no key).
 *
 * Each run:
 *  1. Days. A UTC day is recorded once the first block of the next day is irreversible and every block of the day
 *     (signer and time) matches on two independent nodes (RPC and RPC_CHECK). It keeps each producer's block count.
 *     Up to 3 days a run, so a long outage (or the first run, which needs the 8 days behind today) catches up over a
 *     few runs.
 *  2. Fields. From the recorded days: today's and tomorrow's field and handicap (survivor-math.js: each
 *     producer's blocks over days d−8 … d−2), so the page can show them before the 23:55 UTC lock.
 *  3. Seasons (once FIRST_DAY is set and the Picks contract is live, picks-data/deployment.json): for each recorded
 *     season day, the picks for that day from the Picks contract (game 3), read on both nodes (they must agree; the
 *     chain locked them at 23:55 UTC the night before), and which players still in hold 1 VHP or a Knode stake at
 *     this check (on both nodes: both must say so). Only the picks of players still in are kept (from day 2 on), so a
 *     season file stays small (audit SV-2). Game 3's settings on the chain are checked first (audit SV-9). A season
 *     stays on the list until it is final, and the days it still needs are recorded even after a long outage (SV-4). The season is played by survivor-math.js, the same file the page runs. A season is final 12
 *     hours after its last day (the correction window); its prizes appear then.
 *  4. Writes games-data/survivor/index.json, days.json, fields.json and S<season>.json; the publish job puts them on
 *     the games-data branch for the website.
 *
 *   RPC, RPC_CHECK ("off" to skip the second node), SURVIVOR_PREV (last run's files), SURVIVOR_OUT.
 *   npm run survivor       (or: npx tsx bot/games/survivor.ts)
 */
import { Provider, Contract } from "koilib";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { readVhp, MAINNET_VHP, withRetry } from "../../common.ts";
await import("../../survivor-math.js");
/** The mainnet game. A testnet run passes its own clock (o.math, from KSurvivor.withConfig); every helper below reads S. */
const MAINNET_S: any = (globalThis as any).KSurvivor;
let S: any = MAINNET_S;

const E = process.env;
const RPC = E.RPC || "https://koinos.armana.io";
const RPC_CHECK = E.RPC_CHECK && E.RPC_CHECK !== "off" && E.RPC_CHECK.trim().toLowerCase().replace(/\/+$/, "") !== RPC.trim().toLowerCase().replace(/\/+$/, "") ? E.RPC_CHECK : "";
// Repo Lense SV-A16: a second node set to the same address as the first is no second node; say so every run.
const nodeKey = (u: string) => u.trim().toLowerCase().replace(/\/+$/, "");
const SAME_CHECK = !!E.RPC_CHECK && E.RPC_CHECK !== "off" && nodeKey(E.RPC_CHECK) === nodeKey(RPC);
const MAX_DAYS_PER_RUN = 3;
const KEEP_DAYS = 60;                         // days.json keeps the last 60 recorded days
const CATCHUP_DAYS = 50;                      // after an outage, a season's older days are recorded back to 50 days
const BACK_DAYS = S.FORM_DAYS + S.FORM_GAP - 1;  // today's field needs days d−8 … d−2; tomorrow's needs d−7 … d−1
const ONE_VHP = 100000000n;
const SIZE_WARN = 1.9 * 1024 * 1024;
// The Vault (v6) reads one results file per vault week: <OUT>/vault/W<week>.json. Vault week 0 began Monday 19 Oct 2026
// 00:00 UTC (UTC day 20745); a vault week is 7 UTC days, so a Survivor season (two weeks from a Monday) is two vault weeks.
export const VAULT_GENESIS_DAY = 20745;
export const VAULT_MAX_WINNERS = 10;          // wallets per prize place (the vault contract's limit)
export const vaultWeekOf = (day: number) => Math.floor((day - VAULT_GENESIS_DAY) / 7);          // the publish job refuses a file over 2 MB (Repo Lense SV-A5)
const isAddr = (a: unknown) => typeof a === "string" && /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a);

type Counts = [string, number][];
type DayRec = { day: number; heights: [number, number]; blocks: number; checked: number; counts: Counts };
type Field = { a: string; k: number; h: number }[];
// noVhp: the players still in who did NOT hold 1 VHP or a stake at that day's check (usually few; audit SV-2).
type SeasonDay = { n: number; day: number; field: Field; counts: Counts; picks: [string, string][]; noVhp: string[] };
/** Who was staked in Survivor in one vault week of the season (Vault v6; owner, 28 Oct). `final` once the week is over
 *  (read after its end, so withdrawals can't lower it any more); until then a reading from `day`. */
type Stake = { week: number; final: boolean; day: number; staked: string[] };
type SeasonFile = { v: 1; season: number; startDay: number; days: SeasonDay[]; result: any; stakes: Stake[] };
/** On disk (Repo Lense SV-A5): each wallet and producer is written once, in `who` and `prods`, and the days refer to them
 *  by position. picks: [[wallet index, producer index]]; noVhp: [wallet index]. */
type SeasonFileV2 = { v: 2; season: number; startDay: number; who: string[]; prods: string[]; days: any[]; stakes: any[]; result: any };
export type Blocks = { ts: number[]; signers: string[] };
export type RawPick = { player: string; producer: string; time: number };
type Opts = {
  p: any; check: any | null; prev?: string; out?: string;
  firstDay?: number | null;                                               // default: KSurvivor.FIRST_DAY
  picksContract?: string | null;                                          // default: picks-data/deployment.json
  blocksOf?: (node: any, from: number, to: number) => Promise<Blocks>;    // for the tests
  timeOf?: (node: any, h: number) => Promise<number>;
  picksOf?: (node: any, day: number) => Promise<RawPick[]>;
  rankedOf?: (node: any, who: string[]) => Promise<Set<string>>;
  // Who is staked in Survivor (game 3) in vault week w: a Set, or null while the vault isn't v6 (then nobody is).
  stakedOf?: (node: any, who: string[], week: number) => Promise<Set<string> | null>;
  // The vault's clock and game 3 (Repo Lense S2-7, S2-21): null while the vault isn't v6.
  vaultOf?: (node: any) => Promise<{ genesis: number; weekLen: number; game3: any | null } | null>;
  budgetMs?: number;                                                      // this run's time for season work
  gameOf?: (node: any) => Promise<any>;                                   // game 3's settings on the Picks contract
  head?: { height: number; time: number; lib: number; libTime: number };
  // Testnet only (bot/survivor-test.ts): the game with a test clock, and the testnet's own token and contracts.
  math?: any;                                                             // KSurvivor.withConfig({...}); default mainnet
  holdToken?: string;                                                     // the token of the "hold 1" rule (default VHP)
  gameContract?: string | null;                                           // a Knode stake also counts (default game-data)
};

// ── files ──
function readJson(dir: string | undefined, name: string): any {
  if (!dir) return null;
  const f = path.join(dir, name);
  try { if (fs.lstatSync(f).isSymbolicLink()) return null; return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; }
}
const sName = (s: number) => `S${String(s).padStart(3, "0")}.json`;
const countsOk = (c: any) => Array.isArray(c) && c.length <= 500 && c.every((x: any) => Array.isArray(x) && x.length === 2 && isAddr(x[0]) && Number.isInteger(x[1]) && x[1] >= 0);
function loadDays(dir: string | undefined): Map<number, DayRec> {
  const m = new Map<number, DayRec>();
  const j = readJson(dir, "days.json");
  if (!j || j.v !== 1 || !Array.isArray(j.days)) return m;
  for (const d of j.days) {
    if (!d || !Number.isInteger(d.day) || !Array.isArray(d.heights) || d.heights.length !== 2 || !d.heights.every(Number.isInteger) || !countsOk(d.counts)) continue;
    if (d.counts.reduce((s: number, x: [string, number]) => s + x[1], 0) !== d.blocks || d.heights[1] - d.heights[0] + 1 !== d.blocks) continue;
    m.set(d.day, { day: d.day, heights: [d.heights[0], d.heights[1]], blocks: d.blocks, checked: d.checked === 2 ? 2 : 1, counts: d.counts });
  }
  return m;
}
function loadSeason(dir: string | undefined, season: number, startDay: number): SeasonFile {
  const fresh: SeasonFile = { v: 1, season, startDay, days: [], result: null, stakes: [] };
  let old = readJson(dir, sName(season));
  if (old && old.v === 2) old = decodeSeason(old);
  if (!old || old.v !== 1 || old.season !== season || old.startDay !== startDay || !Array.isArray(old.days)) return fresh;
  // Keep the recorded days in order from day 1, without gaps.
  for (const d of old.days) {
    if (!d || d.n !== fresh.days.length + 1 || d.day !== startDay + d.n - 1 || !Array.isArray(d.field) || !countsOk(d.counts) || !Array.isArray(d.picks) || !Array.isArray(d.noVhp)) break;
    if (!d.picks.every((x: any) => Array.isArray(x) && x.length === 2 && isAddr(x[0]) && isAddr(x[1])) || !d.noVhp.every(isAddr)) break;
    fresh.days.push({ n: d.n, day: d.day, field: d.field, counts: d.counts, picks: d.picks, noVhp: d.noVhp });
  }
  // Stake readings: only this season's two weeks, valid addresses, one per week.
  const w1 = vaultWeekOf(startDay);
  for (const x of Array.isArray(old.stakes) ? old.stakes : []) {
    if (!x || (x.week !== w1 && x.week !== w1 + 1) || typeof x.final !== "boolean" || !Number.isInteger(x.day) || !Array.isArray(x.staked) || !x.staked.every(isAddr)) continue;
    if (fresh.stakes.some((y) => y.week === x.week)) continue;
    fresh.stakes.push({ week: x.week, final: x.final, day: x.day, staked: [...new Set<string>(x.staked)].sort() });
  }
  // The result is never taken from the file: every run plays the season again from its days (Repo Lense SV-A4).
  return fresh;
}
/** v2 on disk → the days the math plays. Anything out of range ends the days there (the rest is recorded again). */
function decodeSeason(j: any): any {
  if (!Array.isArray(j.who) || !Array.isArray(j.prods) || !j.who.every(isAddr) || !j.prods.every(isAddr) || !Array.isArray(j.days)) return null;
  const W = (i: any) => (Number.isInteger(i) && i >= 0 && i < j.who.length ? j.who[i] : null);
  const P = (i: any) => (Number.isInteger(i) && i >= 0 && i < j.prods.length ? j.prods[i] : null);
  const days: any[] = [];
  for (const d of j.days) {
    if (!d || !Array.isArray(d.picks) || !Array.isArray(d.noVhp)) break;
    const picks = d.picks.map((x: any) => (Array.isArray(x) && x.length === 2 ? [W(x[0]), P(x[1])] : [null, null]));
    const noVhp = d.noVhp.map(W);
    if (picks.some((x: any) => !x[0] || !x[1]) || noVhp.some((x: any) => !x)) break;
    days.push({ n: d.n, day: d.day, field: d.field, counts: d.counts, picks, noVhp });
  }
  const stakes = (Array.isArray(j.stakes) ? j.stakes : []).map((x: any) => (x && Array.isArray(x.staked) ? { ...x, staked: x.staked.map(W) } : null))
    .filter((x: any) => x && x.staked.every((a: any) => a));
  return { v: 1, season: j.season, startDay: j.startDay, days, result: null, stakes };
}
export function encodeSeason(sf: SeasonFile): SeasonFileV2 {
  const who: string[] = [], prods: string[] = [], wi = new Map<string, number>(), pi = new Map<string, number>();
  const at = (list: string[], m: Map<string, number>, a: string) => { let i = m.get(a); if (i === undefined) { i = list.length; list.push(a); m.set(a, i); } return i; };
  const days = sf.days.map((d) => ({ n: d.n, day: d.day, field: d.field, counts: d.counts,
    picks: d.picks.map(([p, q]) => [at(who, wi, p), at(prods, pi, q)]), noVhp: d.noVhp.map((a) => at(who, wi, a)) }));
  // Every player of the season is in `who` (day 1's picks); a staked wallet that never played is listed after them.
  const stakes = sf.stakes.map((x) => ({ week: x.week, final: x.final, day: x.day, staked: x.staked.map((a) => at(who, wi, a)) }));
  return { v: 2, season: sf.season, startDay: sf.startDay, who, prods, days, stakes, result: sf.result };
}
function defaultPicksContract(): string | null {
  try { const d = JSON.parse(fs.readFileSync(new URL("../../picks-data/deployment.json", import.meta.url), "utf8")); return isAddr(d.contract) ? d.contract : null; } catch { return null; }
}

// ── chain reads ──
async function headOf(node: any) {
  const h: any = await withRetry("head", () => node.getHeadInfo());
  return { id: h.head_topology.id as string, height: Number(h.head_topology.height), time: Number(h.head_block_time), lib: Number(h.last_irreversible_block) };
}
function blockReader(node: any, headId: string) {
  const time = async (h: number) => {
    const res: any = await withRetry(`block ${h}`, () => node.call("block_store.get_blocks_by_height", { head_block_id: headId, ancestor_start_height: String(h), num_blocks: 1, return_block: true, return_receipt: false }));
    const it = res?.block_items?.[0];
    if (!it || Number(it.block_height) !== h) throw new Error(`block ${h} not returned`);
    return Number(it.block.header.timestamp);
  };
  const range = async (from: number, to: number): Promise<Blocks> => {
    const n = to - from + 1, signers: string[] = new Array(n), ts: number[] = new Array(n);
    const queue: [number, number][] = [];
    for (let s = from; s <= to; s += 200) queue.push([s, Math.min(to, s + 199)]);
    const worker = async () => {
      while (queue.length) {
        const [s, e] = queue.shift()!;
        let k = s;
        while (k <= e) {
          const res: any = await withRetry(`blocks at ${k}`, () => node.call("block_store.get_blocks_by_height", { head_block_id: headId, ancestor_start_height: String(k), num_blocks: e - k + 1, return_block: true, return_receipt: false }));
          const items = res?.block_items ?? [];
          if (!items.length) throw new Error(`no blocks returned at ${k}`);
          for (const it of items) {
            const h = Number(it.block_height);
            if (h !== k || h > e) throw new Error(`blocks out of order at ${k}`);
            signers[h - from] = String(it.block.header.signer); ts[h - from] = Number(it.block.header.timestamp); k++;
          }
        }
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    return { ts, signers };
  };
  return { time, range };
}
const PICKS_ABI = () => JSON.parse(fs.readFileSync(new URL("../../picks/abi/picks.koilib.json", import.meta.url), "utf8"));
async function readPicks(node: any, contract: string, day: number): Promise<RawPick[]> {
  const c = new Contract({ id: contract, abi: PICKS_ABI(), provider: node });
  const out: RawPick[] = [];
  let after: string | undefined;
  for (let page = 0; page < 1000; page++) {
    const r: any = await withRetry(`picks for day ${day}`, () => (c.functions as any).list_picks({ game: S.GAME_ID, round: String(day), ...(after ? { start_after: after } : {}), limit: 100 }));
    const rows = r?.result?.rows ?? [];
    for (const x of rows) {
      const ps = x.pick?.producers;
      if (isAddr(x.player) && Array.isArray(ps) && ps.length === 1 && isAddr(ps[0])) out.push({ player: x.player, producer: ps[0], time: Number(x.pick.time || 0) });
    }
    if (rows.length < 100) return out;
    after = rows[rows.length - 1].player;
  }
  throw new Error(`more than 100,000 picks for day ${day}: not read in full (audit SV-9)`);
}
/** Game 3's settings must be exactly what survivor-math.js assumes (audit SV-9). Returns a problem, or "". */
export function gameProblem(g: any): string {
  if (!g) return "game 3 isn't registered on the Picks contract";
  // Repo Lense SV-A14: enabled and max_picks_per_day too (a closed game would make every player miss a pick).
  const want: Record<string, string> = { id: String(S.GAME_ID), kind: "1", list_size: "1", lock_mode: "2", round_size: String(S.DAY), round_offset: "0", lead: String(S.LEAD_MS), ahead: String(S.AHEAD_MS), max_picks_per_day: String(S.PICKS_PER_DAY), max_changes: String(S.MAX_CHANGES), enabled: "true" };
  const dflt = (k: string) => (k === "enabled" ? "false" : "0");
  for (const [k, v] of Object.entries(want)) if (String(g[k] ?? dflt(k)) !== v) return `game 3's ${k} on the chain is ${g[k] ?? dflt(k)}, the Survivor math expects ${v}`;
  return "";
}
async function readGame(node: any, contract: string): Promise<any> {
  const c = new Contract({ id: contract, abi: PICKS_ABI(), provider: node });
  const r: any = await withRetry("game 3", () => (c.functions as any).get_game({ game: S.GAME_ID }));
  return r?.result ? { game: r.result.game ?? null, pending: r.result.pending ?? null } : null;
}
// Anything but a valid address counts as missing, which the run reports (fix-check: a bad file used to be silent).
const GAME = (() => { try { const c = JSON.parse(fs.readFileSync(new URL("../../game-data/deployment.json", import.meta.url), "utf8")).contract; return isAddr(c) ? (c as string) : ""; } catch { return ""; } })();
/** Runs fn over items, at most `limit` at a time (Repo Lense S2-3: one read after another took too long). The first
 *  failure is thrown once all running reads are done. */
// A hard stop for a run's chain reads (fix-check of S3-2): past it, reads stop with an error, so a day too big for one
// run is dropped cleanly and the files are still written well inside the step's time limit.
let HARD_STOP = Infinity;
export const setHardStop = (t: number) => { HARD_STOP = t; };
export async function pool<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0, err: unknown = null;
  const worker = async () => { while (next < items.length && !err) { const i = next++; try { if (Date.now() > HARD_STOP) throw new Error("out of time for this run"); out[i] = await fn(items[i]); } catch (e) { err ??= e; } } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (err) throw err;
  return out;
}
const READS_AT_ONCE = 8;

// ── the vault (v6): stakes in Survivor ──
const V6_ABI = () => JSON.parse(fs.readFileSync(new URL("./vault-v6.koilib.json", import.meta.url), "utf8"));
type VaultDeps = { state?: (node: any) => Promise<any>; gamePlayer?: (node: any, a: string, game: number, week: number) => Promise<any>; games?: (node: any) => Promise<any[]> };
function vaultReads(game: string | null, deps: VaultDeps = {}) {
  const c = (node: any) => new Contract({ id: game!, abi: V6_ABI(), provider: node });
  return {
    state: deps.state ?? (async (node: any) => (await withRetry("vault state", () => (c(node).functions as any).get_state({})))?.result ?? {}),
    gamePlayer: deps.gamePlayer ?? (async (node: any, a: string, g: number, w: number) => (await withRetry(`vault player ${a}`, () => (c(node).functions as any).get_game_player({ player: a, game: g, week: String(w) })))?.result ?? {}),
    games: deps.games ?? (async (node: any) => (await withRetry("vault games", () => (c(node).functions as any).list_games({})))?.result?.games ?? []),
  };
}
/** The vault's minimum stake for week w (config.min_stake, or min_stake_next from its week), or null before v6. */
function minStakeFor(st: any, w: number): bigint | null {
  const c = st?.config ?? {};
  if (!(Number(c.v6_rule_week_plus_one || 0) > 0)) return null;
  return BigInt(c.min_stake_next || "0") > 0n && w >= Number(c.min_stake_next_week || 0) ? BigInt(c.min_stake_next) : BigInt(c.min_stake || "0");
}
/** The vault's week clock and its game 3 (v6), or null before v6. */
async function readVault(node: any, game: string | null): Promise<{ genesis: number; weekLen: number; game3: any | null } | null> {
  if (!game) return null;
  const v = vaultReads(game);
  const st = await v.state(node);
  if (minStakeFor(st, 0) === null) return null;
  const g3 = (await v.games(node)).find((g: any) => Number(g.id) === MAINNET_S.GAME_ID) ?? null;
  return { genesis: Number(st.config?.genesis_time || 0), weekLen: Number(st.config?.week_length || 0), game3: g3 };
}
/** The vault settings that decide where Survivor's results go (not the running totals). */
export function vaultSettings(v: { genesis: number; weekLen: number; game3: any | null } | null): string {
  if (!v) return "null";
  const g = v.game3;
  return JSON.stringify([v.genesis, v.weekLen, g && ["id", "staked", "free_prize", "active", "from_week", "last_week_plus_one", "season_weeks"].map((k) => String(g[k] ?? ""))]);
}
/** Does the vault count weeks and Survivor's seasons the way the recorder writes its files? "" when it does (or the
 *  vault isn't v6 yet, or game 3 isn't in it yet); otherwise why not (Repo Lense S2-7, S2-21). */
export function vaultMismatch(v: { genesis: number; weekLen: number; game3: any | null } | null, firstDay: number | null, math: any = MAINNET_S): string {
  if (!v) return "";
  const WEEK = 7 * 86400000;
  if (v.genesis !== VAULT_GENESIS_DAY * 86400000 || v.weekLen !== WEEK) return `the vault's weeks (start ${new Date(v.genesis).toISOString()}, ${v.weekLen} ms) aren't the ones the recorder counts (Monday 19 Oct 2026, 7 days)`;
  const g = v.game3;
  if (!g) return "";
  if (Number(g.season_weeks) !== 2) return `game 3 in the vault has ${g.season_weeks}-week seasons; Survivor's are 2 weeks`;
  if (firstDay !== null && (((vaultWeekOf(firstDay) - Number(g.from_week)) % 2) + 2) % 2 !== 0) return `game 3's seasons in the vault start in week ${g.from_week}, out of step with Survivor's (Season 1 starts in week ${vaultWeekOf(firstDay)}): every season's winners would land on a week the vault doesn't pay`;
  if (!g.staked || !g.free_prize) return "game 3 in the vault isn't set up as staked and free-prize (game-add 3 \"Survivor\" --staked --free)";
  void math;
  return "";
}

/** Who is staked in Survivor (game 3) in vault week w: their highest stake in game 3 that week (peak_stake: a
 *  withdrawal never lowers it, so a wallet staked at the week's start stays staked that week) is at least the vault's
 *  minimum, exactly the vault's own test for a free-prize winner. A stake in another game doesn't count here. null while
 *  the vault isn't v6 (nobody can stake in Survivor yet). A failed read throws: the reading is tried again next run. */
export async function readStaked(node: any, who: string[], week: number, game: string | null = GAME, deps: VaultDeps = {}): Promise<Set<string> | null> {
  if (!game) return null;
  const v = vaultReads(game, deps);
  const min = minStakeFor(await v.state(node), week);
  if (min === null) return null;
  const peaks = await pool(who, READS_AT_ONCE, async (a) => {
    const p = await v.gamePlayer(node, a, MAINNET_S.GAME_ID, week);
    return p.entry ? BigInt(p.entry.peak_stake || "0") : BigInt(p.active_stake || "0");
  });
  return new Set(who.filter((a, i) => peaks[i] > 0n && peaks[i] >= min));
}
/** Who may win a prize: at least 1 VHP, or a Knode stake (the owner's 1 VHP rule; a staked player's VHP sits in the vault).
 *  The testnet passes its own token (and no game contract). */
export async function readRanked(node: any, who: string[], token = MAINNET_VHP, game: string | null = GAME,
  deps: { vhp?: (node: any, token: string, who: string[]) => Promise<Record<string, string>>; player?: (node: any, game: string, a: string) => Promise<any> } = {}): Promise<Set<string>> {
  if (!who.length) return new Set();
  // Balances in chunks of 25 wallets, 8 chunks at a time (fix-check: one at a time was too slow for a big day 1).
  const vhpOf = deps.vhp ?? (async (n: any, t: string, w: string[]) => {
    const chunks: string[][] = [];
    for (let i = 0; i < w.length; i += 25) chunks.push(w.slice(i, i + 25));
    return Object.assign({}, ...(await pool(chunks, READS_AT_ONCE, async (c) => (await readVhp(n, t, c)).values)));
  });
  // Read with the v6 ABI: its get_player also gives stake_other, the VHP the wallet has in the vault's other games
  // (stake and pending deposits, kept current on every deposit, withdrawal and move). On the v5 contract it is 0.
  const playerOf = deps.player ?? (async (n: any, g: string, a: string) => {
    const c = new Contract({ id: g, abi: V6_ABI(), provider: n });
    const r: any = await withRetry(`Knode player ${a}`, () => (c.functions as any).get_player({ player: a, week: "0" }));
    return r?.result?.player ?? {};
  });
  const vhp = await vhpOf(node, token, who);
  const rest = who.filter((a) => BigInt(vhp[a] || "0") < ONE_VHP);
  const out = new Set(who.filter((a) => BigInt(vhp[a] || "0") >= ONE_VHP));
  if (!game) return out;
  // A failed read throws, so the day is tried again next run instead of costing a staker the season (Repo Lense SV-A7).
  const ps = await pool(rest, READS_AT_ONCE, async (a) => (await playerOf(node, game, a)) ?? {});
  // At least 1 VHP in the vault, the same as the wallet rule: a dust stake doesn't count (SV-A3). Everything the wallet
  // has there counts, including a deposit or a move made this week (Repo Lense S2-2: those count for stakes only from
  // next week, but the VHP is in the vault now).
  rest.forEach((a, i) => { const p = ps[i]; if (BigInt(p.stake || "0") + BigInt(p.pending || "0") + BigInt(p.stake_other || "0") >= ONE_VHP) out.add(a); });
  return out;
}

/** The first height in [lo, hi] whose block time is at or after t (hi + 1 if none). */
async function heightAt(time: (h: number) => Promise<number>, t: number, lo: number, hi: number): Promise<number> {
  let a = lo, b = hi + 1;
  while (a < b) { const m = Math.floor((a + b) / 2); if ((await time(m)) < t) a = m + 1; else b = m; }
  return a;
}
const tally = (signers: string[]): Counts => {
  const m = new Map<string, number>();
  for (const a of signers) m.set(a, (m.get(a) || 0) + 1);
  return [...m.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1));
};

/** The vault files of one season, as far as they are final: { week: file }.
 *  - rows (staked players, Vault v6, owner 28 Oct): each week, once the week's stake reading is final and its days are
 *    all recorded (or the season is over): KSurvivor.weekRows, the season standings at the week's end, 255 down to 1.
 *  - first / second (free players): only in the season's last week, once the season is final (its result needs both
 *    weeks' stake readings). A place with more than 10 tied wallets is left empty (the vault refuses more), so its
 *    prize returns to the pool; `problems` says so. */
export function vaultFiles(sf: { startDay: number; days: any[]; result: any; stakes: Stake[] }, math: any, problems: string[] = [], published: Set<number> = new Set()): Record<number, any> {
  const out: Record<number, any> = {};
  const w1 = vaultWeekOf(sf.startDay);
  for (const k of [0, 1]) {
    const w = w1 + k, st = sf.stakes.find((x) => x.week === w);
    // Already published: written once, never again (Repo Lense S3-6).
    if (published.has(w) || !st || !st.final) continue;
    // A reading taken more than a week after its week ended may show today's stakes, not that week's (S2-9): its file
    // is held for the owner to check, not published (Repo Lense S3-11).
    if (st.day >= sf.startDay + math.WEEK_DAYS * (k + 2)) { problems.push(`Survivor: vault week ${w}'s file is held: its stakes were read late (after an outage). Check them, then publish it by hand (docs/SURVIVOR-RUNBOOK.md)`); continue; }
    if (k === 1 && !(sf.result && sf.result.final)) continue;
    const rows = math.weekRows(sf.days, k, new Set(st.staked));
    if (rows === null) continue;
    let first: string[] = [], second: string[] = [];
    if (k === 1) {
      const at = (place: number) => sf.result.prizes.filter((x: any) => x.place === place).map((x: any) => x.player as string).sort();
      first = at(1); second = at(2);
      if (first.length > VAULT_MAX_WINNERS) { problems.push(`Survivor: ${first.length} wallets tied for 1st in the season from ${math.dayLabel(sf.startDay)}; the vault takes at most ${VAULT_MAX_WINNERS}, so no prize is posted for the season (it returns to the pool)`); first = []; second = []; }
      if (second.length > VAULT_MAX_WINNERS) { problems.push(`Survivor: ${second.length} wallets tied for 2nd in the season from ${math.dayLabel(sf.startDay)}; the vault takes at most ${VAULT_MAX_WINNERS}, so 2nd's prize returns to the pool`); second = []; }
    }
    out[w] = { game: math.GAME_ID, week: w, final: true, rows, first, second };
  }
  return out;
}

// ── writing the files: a side folder, then a swap ──
// The side folder sits next to OUT's parent (never inside it, so a leftover one is never published) and on the same
// disk, so the swap is two renames. When OUT's parent is a top folder (e.g. /tmp/x), the system temp folder is used and
// the files are copied in instead. The old folder is parked under a fixed name, so a run that died between the two
// renames is put right by the next one (fix-check of SV-A26: the testnet kit's OUT is also its PREV).
function sideOf(final: string): { side: string; sameDisk: boolean } {
  // Next to OUT's parent; when that is a drive or file-system root, next to OUT itself (a local run only: on GitHub OUT
  // is always deeper), never on another disk, so the swap stays two renames (Repo Lense S3-18).
  const side = path.dirname(path.dirname(final));
  return { side: side === path.parse(side).root ? path.dirname(final) : side, sameDisk: true };
}
const oldOf = (final: string) => path.join(sideOf(final).side, `.survivor-old-${crypto.createHash("sha256").update(final).digest("hex").slice(0, 12)}`);
function renameRetry(a: string, b: string) {
  for (let i = 0; ; i++) {
    try { fs.renameSync(a, b); return; }
    catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (i >= 4 || !["EPERM", "EBUSY", "EACCES"].includes(code ?? "")) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250 * (i + 1));   // e.g. a virus scan holding a new file
    }
  }
}
/** A run that died between the two renames left OUT missing and the old folder parked: put it back. */
export function recoverOut(final: string) {
  const old = oldOf(final);
  if (!fs.existsSync(old)) return;
  // OUT missing, or created empty since (the testnet kit used to make it first: Repo Lense S3-17).
  if (fs.existsSync(final) && fs.readdirSync(final).length === 0) fs.rmdirSync(final);
  if (!fs.existsSync(final)) renameRetry(old, final);
}
/** Side folders left by a run that crashed more than an hour ago (Repo Lense S3-18). */
function cleanSide(final: string) {
  const { side } = sideOf(final);
  try {
    for (const f of fs.readdirSync(side)) if (f.startsWith(".survivor-stage-")) {
      const p = path.join(side, f);
      if (Date.now() - fs.statSync(p).mtimeMs > 3600000) fs.rmSync(p, { recursive: true, force: true });
    }
  } catch { /* nothing to clean */ }
}
function stageFor(final: string): string {
  cleanSide(final);
  return fs.mkdtempSync(path.join(sideOf(final).side, ".survivor-stage-"));
}
function swapIn(stage: string, final: string) {
  const old = oldOf(final);
  try {
    // Files of the last run that this run didn't write again (a season skipped this run) are kept.
    if (fs.existsSync(final)) fs.cpSync(final, stage, { recursive: true, force: false, errorOnExist: false });
    fs.rmSync(old, { recursive: true, force: true });
    if (fs.existsSync(final)) renameRetry(final, old);
    try { renameRetry(stage, final); }
    catch (e) { if (fs.existsSync(old) && !fs.existsSync(final)) renameRetry(old, final); throw e; }
    fs.rmSync(old, { recursive: true, force: true });
  } catch (e) {
    try { fs.rmSync(stage, { recursive: true, force: true }); } catch { /* the error that matters is e */ }
    throw e;
  }
}

/** One run. Exported for the tests, which pass fake nodes. */
export async function run(o: Opts) {
  let checkDown = "";
  S = o.math ?? MAINNET_S;
  const OUT = o.out ?? E.SURVIVOR_OUT ?? "games-data/survivor";
  const PREV = o.prev ?? E.SURVIVOR_PREV ?? "";
  recoverOut(path.resolve(OUT));
  const firstDay: number | null = o.firstDay === undefined ? S.FIRST_DAY : o.firstDay;
  const contract = o.picksContract === undefined ? defaultPicksContract() : o.picksContract;
  const problems: string[] = [];
  if (firstDay !== null && !S.isSeasonStart(firstDay)) throw new Error(S.MAINNET ? "FIRST_DAY must be a Monday (a UTC day number)" : "firstDay must be a round number");

  // ── the chain ──
  let head = o.head, readerP: any = null, readerC: any = null;
  if (!head) {
    const h = await headOf(o.p);
    readerP = blockReader(o.p, h.id);
    head = { height: h.height, time: h.time, lib: h.lib, libTime: await readerP.time(h.lib) };
    // A check node that is down doesn't stop the run (Repo Lense S3-9): days and handicaps go on from one node, and
    // seasons wait (they need two nodes on mainnet).
    if (o.check) {
      try { const c = await headOf(o.check); readerC = blockReader(o.check, c.id); }
      catch (e) { checkDown = `the second node (RPC_CHECK) didn't answer: ${(e as Error).message}`; }
    }
  }
  if (checkDown) { problems.push(`Survivor: ${checkDown}; this run reads one node`); o = { ...o, check: null }; }
  const timeP = o.timeOf ? (h: number) => o.timeOf!(o.p, h) : (h: number) => readerP.time(h);
  const rangeP = o.blocksOf ? (a: number, b: number) => o.blocksOf!(o.p, a, b) : (a: number, b: number) => readerP.range(a, b);
  const rangeC = !o.check ? null : o.blocksOf ? (a: number, b: number) => o.blocksOf!(o.check, a, b) : (a: number, b: number) => readerC.range(a, b);
  const picksRead = o.picksOf ?? (contract ? (node: any, d: number) => readPicks(node, contract, d) : null);
  const holdToken = o.holdToken ?? MAINNET_VHP, holdGame = o.gameContract === undefined ? GAME : o.gameContract;
  const rankedRead = o.rankedOf ?? ((node: any, who: string[]) => readRanked(node, who, holdToken, holdGame));
  // Stakes in Survivor (Vault v6): mainnet only; the test clock's rounds aren't vault weeks.
  const stakesOn = !!o.stakedOf || S.MAINNET;
  const stakedRead = o.stakedOf ?? ((node: any, who: string[], w: number) => readStaked(node, who, w, holdGame));
  const gameRead = o.gameOf ?? (contract ? (node: any) => readGame(node, contract) : null);
  console.log(`head ${head.height} (${new Date(head.time).toISOString()}), irreversible ${head.lib} (${new Date(head.libTime).toISOString()})`);

  // ── the seasons this run looks at (loaded first: they decide which older days are still needed) ──
  const days = loadDays(PREV);
  // The vault files already on games-data (the record step copies them into PREV/vault): never written again (S3-6).
  const publishedWeeks = new Set<number>();
  try { for (const f of fs.readdirSync(path.join(PREV || ".", "vault"))) { const m = /^W(0|[1-9]\d{0,4})\.json$/.exec(f); if (PREV && m) publishedWeeks.add(Number(m[1])); } } catch { /* none yet */ }
  const today = S.dayIndex(head.time);
  const lastDone = S.dayIndex(head.libTime) - 1;               // the last day whose next day has an irreversible block
  const idx = readJson(PREV, "index.json");
  const known = new Set<number>(Array.isArray(idx?.seasons) ? idx.seasons.filter((s: any) => Number.isInteger(s) && s >= 1 && s < 10000) : []);
  const seasons: SeasonFile[] = [], active: SeasonFile[] = [];
  let seasonsOn = firstDay !== null && !!picksRead;
  // Game 3's settings on the chain must match the math (audit SV-9).
  // Read on both nodes, which must agree (Repo Lense SV-A12). An announced change is reported (Repo Lense SV-A14).
  if (seasonsOn && gameRead) {
    try {
      const split = (r: any) => (r && typeof r === "object" && "game" in r ? r : { game: r, pending: null });
      const mine = split(await gameRead(o.p));
      let pr = gameProblem(mine.game);
      // Both nodes must agree on the settings and on any announced change (Repo Lense S2-24).
      if (!pr && o.check && JSON.stringify(split(await gameRead(o.check))) !== JSON.stringify(mine)) pr = "the two nodes disagree about game 3's settings";
      if (pr) { problems.push(`Survivor: ${pr}; seasons not recorded this run`); seasonsOn = false; }
      const pg = mine.pending && mine.pending.game;
      if (pg) { const why = gameProblem(pg); problems.push(`Survivor: a change to game 3 is announced (it can be applied from ${new Date(Number(mine.pending.eta || 0)).toISOString()})${why ? `: once applied, ${why}` : "; it matches the Survivor math"}`); }
    }
    catch (e) { problems.push(`Survivor: game 3's settings: ${(e as Error).message} (tried again next run)`); seasonsOn = false; }
  }
  // A stake can only be read with the Knode contract's address (Repo Lense SV-A7).
  if (seasonsOn && !o.rankedOf && holdGame === "") { problems.push("Survivor: game-data/deployment.json names no Knode contract, so stakes can't be checked; seasons not recorded this run"); seasonsOn = false; }
  if (SAME_CHECK) problems.push("RPC_CHECK is the same node as RPC, so nothing is checked on a second node; set RPC_CHECK to another node");
  else if (!o.check) problems.push("only one node is read this run (no RPC_CHECK): days are saved as checked on 1 node and checked again once a second node is set");
  // On mainnet a season only moves with two nodes: its picks, VHP checks and stake readings are never final on one
  // node's word (Repo Lense S2-10, S2-11). The testnet kit has one public node.
  if (seasonsOn && S.MAINNET && !o.check) { problems.push("Survivor: seasons wait for a second node (RPC_CHECK)"); seasonsOn = false; }
  // Season work stops in time for the files to be written (Repo Lense S2-3); the rest continues next run.
  // 8 minutes by default, well inside the 15-minute step: a day that starts within the budget is finished and kept
  // even if its checks run past it (Repo Lense S3-2). SURVIVOR_BUDGET_MS (a repository variable) changes it.
  const t0 = Date.now(), budget = o.budgetMs ?? Number(E.SURVIVOR_BUDGET_MS || 8 * 60000);
  let outOfTime = false;
  // Reads stop for good 4 minutes after the budget (8 + 4 = 12 of the step's 15 minutes), so the files are written.
  setHardStop(t0 + budget + 4 * 60000);
  const timeLeft = () => { if (!outOfTime && Date.now() - t0 > budget) { outOfTime = true; problems.push(`Survivor: out of time for season work this run (${Math.round(budget / 60000)} min); it carries on next run`); } return !outOfTime; };
  // The vault must count weeks and seasons as the files do, or no vault file is written (Repo Lense S2-7, S2-21).
  let vaultOk = true, vault: { genesis: number; weekLen: number; game3: any | null } | null = null;
  if (S.MAINNET && firstDay !== null) {
    try {
      const vaultRead = o.vaultOf ?? ((node: any) => readVault(node, holdGame));
      vault = await vaultRead(o.p);
      // Both nodes must give the same vault settings (fix-check).
      // Only the settings are compared: game 3's running totals (stake, held prize) move with every deposit (Repo Lense S3-5).
      if (o.check && vaultSettings(await vaultRead(o.check)) !== vaultSettings(vault)) throw new Error("the two nodes disagree about the vault's settings");
      const last = Number(vault?.game3?.last_week_plus_one || 0);
      if (vault?.game3 && (vault.game3.active === false || last > 0)) problems.push(`Survivor: game 3 is stopped in the vault${last > 0 ? ` (its last earning week is ${last - 1})` : ""}: weeks after that pay nothing (Repo Lense S3-30)`);
      const why = vaultMismatch(vault, firstDay);
      if (why) { problems.push(`Survivor: ${why}; no vault results files are written until it is fixed (docs/SURVIVOR-RUNBOOK.md)`); vaultOk = false; }
    } catch (e) { problems.push(`Survivor: the vault's settings: ${(e as Error).message}; no vault files this run`); vaultOk = false; }
  }
  if (firstDay !== null) {
    // Every known season stays on the list until it is final (audit SV-4), plus the last and the current one.
    const cur = S.seasonOf(Math.max(firstDay, today), firstDay).season;
    const list = new Set<number>(known);
    for (const s of [cur - 1, cur]) if (s >= 1 && S.seasonStartDay(s, firstDay) <= lastDone) list.add(s);
    for (const s of [...list].sort((x, y) => x - y)) {
      active.push(loadSeason(PREV, s, S.seasonStartDay(s, firstDay)));     // every season is played again (Repo Lense SV-A4)
    }
  }

  // ── 1. days ──
  /** Record day d. Its start comes from the day before's record when there is one, and is always checked against the
   *  block before it (audit SV-6); if that start doesn't fit, it is searched again from scratch (fix-check FC-1).
   *  Returns true when the day was recorded. */
  // A day has about 28,800 blocks; a range far bigger than that comes from a bad saved boundary (Repo Lense SV-A8).
  const MAX_DAY_BLOCKS = Math.ceil(S.DAY / 1000) + 100;
  /** Node C's blocks a−1 … b+1: the same blocks as node P inside, and the day's edges on its own reading too (Repo Lense SV-A12). */
  async function sameOnCheck(d: number, a: number, b: number, counts: Counts | null, B: Blocks | null): Promise<boolean> {
    const lo = Math.max(1, a - 1), C = await rangeC!(lo, b + 1), off = a - lo;
    if (C.ts.length !== b + 1 - lo + 1) return false;
    if (a > 1 && C.ts[0] >= S.dayStart(d)) return false;
    if (C.ts[C.ts.length - 1] < S.dayStart(d + 1)) return false;
    const inner = { ts: C.ts.slice(off, off + b - a + 1), signers: C.signers.slice(off, off + b - a + 1) };
    if (inner.ts[0] < S.dayStart(d) || inner.ts[inner.ts.length - 1] >= S.dayStart(d + 1)) return false;
    if (B) return inner.ts.every((t, i) => t === B.ts[i] && inner.signers[i] === B.signers[i]);
    return JSON.stringify(tally(inner.signers)) === JSON.stringify(counts);
  }
  async function recordDay(d: number): Promise<boolean> {
    const prevRec = days.get(d - 1);
    for (const usePrev of prevRec ? [true, false] : [false]) {
      let a: number;
      if (usePrev) {
        a = prevRec!.heights[1] + 1;
        // Check the saved start before downloading anything: a bad one is searched again, never followed (Repo Lense SV-A8).
        if (a < 2 || a > head!.lib || (await timeP(a)) < S.dayStart(d) || (await timeP(a - 1)) >= S.dayStart(d)) {
          problems.push(`${S.dayLabel(d)}: the day before's recorded end doesn't fit; searched again`); continue;
        }
      } else {
        const est = Math.ceil((head!.libTime - S.dayStart(d)) / 3000) + 600;
        let lo = Math.max(1, head!.lib - est);
        while (lo > 1 && (await timeP(lo)) >= S.dayStart(d)) lo = Math.max(1, lo - est);
        a = await heightAt(timeP, S.dayStart(d), lo, head!.lib);
      }
      const b = (await heightAt(timeP, S.dayStart(d + 1), a, head!.lib)) - 1;
      if (b >= head!.lib) { problems.push(`${S.dayLabel(d)}: its blocks aren't all irreversible yet`); return false; }
      if (b < a) { problems.push(`${S.dayLabel(d)}: no blocks found for the day; not recorded this run`); return false; }
      if (b - a + 1 > MAX_DAY_BLOCKS) {
        if (usePrev) { problems.push(`${S.dayLabel(d)}: the day before's recorded end gives ${b - a + 1} blocks; searched again`); continue; }
        problems.push(`${S.dayLabel(d)}: ${b - a + 1} blocks found, more than a day can have; not recorded this run`); return false;
      }
      const B = await rangeP(a, b);
      // The day's first block is the first at or after 00:00 UTC: the block before it is from the day before.
      if (B.ts[0] < S.dayStart(d) || B.ts[B.ts.length - 1] >= S.dayStart(d + 1) || (a > 1 && (await timeP(a - 1)) >= S.dayStart(d))) {
        if (usePrev) { problems.push(`${S.dayLabel(d)}: the day before's recorded end doesn't fit; searched again`); continue; }
        problems.push(`${S.dayLabel(d)}: the blocks found don't fit the day; not recorded this run`); return false;
      }
      let checked = 1;
      if (rangeC) {
        if (!(await sameOnCheck(d, a, b, null, B))) { problems.push(`${S.dayLabel(d)}: the two nodes disagree about the day's blocks; not recorded this run`); return false; }
        checked = 2;
      }
      if (!B.signers.every(isAddr)) { problems.push(`${S.dayLabel(d)}: a block has no valid signer; not recorded this run`); return false; }
      days.set(d, { day: d, heights: [a, b], blocks: b - a + 1, checked, counts: tally(B.signers) });
      console.log(`${S.dayLabel(d)}: blocks ${a}-${b} (${b - a + 1}), checked on ${checked} node(s)`);
      return true;
    }
    return false;
  }
  // First the 8 days behind today (what today's and tomorrow's handicaps need), so new days always keep coming.
  // Then, with what is left of this run's budget, older days an unfinished season still needs after an outage, but
  // never more than CATCHUP_DAYS back: a season stuck longer than that is reported for the owner to handle, not
  // chased for ever (fix-check FC-2).
  const want: number[] = [];
  for (let d = today - BACK_DAYS; d <= lastDone; d++) want.push(d);
  const floor = today - CATCHUP_DAYS;
  if (seasonsOn) for (const sf of active) {
    if (sf.days.length >= S.SEASON_DAYS || S.playSeason(sf.days).over) continue;
    const next = sf.startDay + sf.days.length;
    if (next > lastDone) continue;
    const need = next - (S.FORM_DAYS + S.FORM_GAP - 1);
    if (need < floor) { problems.push(`Survivor: season ${sf.season} is stuck at day ${sf.days.length + 1} (${S.dayLabel(next)}), more than ${CATCHUP_DAYS} days ago; it needs the owner (docs/SURVIVOR-RUNBOOK.md)`); continue; }
    for (let d = need; d <= next; d++) if (!want.includes(d)) want.push(d);
  }
  let n = 0;
  for (const d of want) {
    if (days.has(d)) continue;
    if (n >= MAX_DAYS_PER_RUN) break;
    n++;
    try { await recordDay(d); } catch (e) { problems.push(`${S.dayLabel(d)}: ${(e as Error).message} (tried again next run)`); }
  }
  // Days saved while only one node was read are checked on the second node once there is one (Repo Lense SV-A16), up to 3
  // a run of their own, oldest first, so a disputed day can't take every slot for ever (Repo Lense S3-10). A day the second
  // node disagrees with is reported, not changed.
  let rechecks = 0;
  if (rangeC) for (const rec of [...days.values()].filter((x) => x.checked === 1).sort((x, y) => x.day - y.day)) {
    if (rechecks >= MAX_DAYS_PER_RUN) break;
    rechecks++;
    try {
      if (await sameOnCheck(rec.day, rec.heights[0], rec.heights[1], rec.counts, null)) { rec.checked = 2; console.log(`${S.dayLabel(rec.day)}: checked again on the second node`); }
      else problems.push(`${S.dayLabel(rec.day)}: saved from one node, and the second node disagrees; it needs the owner (docs/SURVIVOR-RUNBOOK.md)`);
    } catch (e) { problems.push(`${S.dayLabel(rec.day)}: checking again: ${(e as Error).message} (tried again next run)`); }
  }

  // ── 2. fields for today and tomorrow ──
  const fields: any[] = [];
  for (const d of [today, today + 1]) {
    const field = S.fieldFor(d, days);
    if (!field) continue;
    const se = S.seasonOf(d, firstDay);
    fields.push({ day: d, season: se ? se.season : null, n: se ? se.n : null, out: S.outSize(field.length, se ? se.n : 1), field });
  }

  // ── 3. seasons ──
  /** Who holds 1 VHP or a stake: both nodes must say so (audit SV-7). */
  const heldOf = async (who: string[]) => {
    const mine = await rankedRead(o.p, who);
    if (!o.check) return mine;
    const theirs = await rankedRead(o.check, who);
    if (Date.now() > HARD_STOP) throw new Error("out of time for this run");
    return new Set([...mine].filter((a) => theirs.has(a)));
  };
  for (const sf of active) {
    const s = sf.season, start = sf.startDay;
    let played = S.playSeason(sf.days);
    // Record the next days of the season that are done.
    while (seasonsOn && !played.over && sf.days.length < S.SEASON_DAYS && timeLeft()) {
      const nDay = sf.days.length + 1, d = start + nDay - 1, rec = days.get(d);
      if (!rec) break;
      // A day the second node hasn't confirmed (or disputes) doesn't decide lives (Repo Lense S2-10).
      if (o.check && rec.checked !== 2) { problems.push(`season ${s} day ${nDay}: its blocks are confirmed on one node only; the season waits until the second node agrees`); break; }
      // So must the 7 days its handicap comes from (fix-check of S2-10).
      const unconfirmed = o.check ? S.formDays(d).filter((x: number) => days.get(x)?.checked !== 2) : [];
      if (unconfirmed.length) { problems.push(`season ${s} day ${nDay}: ${unconfirmed.length} of the days behind its handicap are confirmed on one node only; the season waits until the second node agrees`); break; }
      const field = S.fieldFor(d, days);
      if (!field) { problems.push(`season ${s} day ${nDay}: the 7 days behind its handicap aren't all recorded yet`); break; }
      let raw: RawPick[];
      try {
        raw = await picksRead!(o.p, d);
        if (o.check) {
          const other = await picksRead!(o.check, d);
          const key = (x: RawPick[]) => JSON.stringify([...x].sort((u, v) => (u.player < v.player ? -1 : 1)));
          if (key(raw) !== key(other)) { problems.push(`season ${s} day ${nDay}: the two nodes disagree about the picks; not recorded this run`); break; }
        }
      } catch (e) { problems.push(`season ${s} day ${nDay}: picks: ${(e as Error).message} (tried again next run)`); break; }
      // Who is still in before this day: day 1's pickers, or the season so far. Only their picks are kept (audit SV-2).
      const alive = nDay === 1 ? null : new Set<string>(played.players.filter((x: any) => x.outN === null).map((x: any) => x.a));
      // Only picks made before the lock count (the chain refuses later ones; checked again here).
      const picks: [string, string][] = raw.filter((x) => x.time < S.lockTime(d) && (!alive || alive.has(x.player)))
        .map((x) => [x.player, x.producer] as [string, string]).sort((u, v) => (u[0] < v[0] ? -1 : 1));
      // A player who already missed a check can't win this season, so is not read again or listed again (Repo Lense SV-A5).
      const already = new Set<string>(played.players.filter((x: any) => !x.eligible).map((x: any) => x.a));
      const inNow = (alive ? [...alive] : [...new Set(picks.map((x) => x[0]))]).filter((a) => !already.has(a));
      let noVhp: string[];
      try { const h = await heldOf(inNow); noVhp = inNow.filter((a) => !h.has(a)).sort(); }
      catch (e) { problems.push(`season ${s} day ${nDay}: VHP check: ${(e as Error).message} (tried again next run)`); break; }
      sf.days.push({ n: nDay, day: d, field, counts: rec.counts, picks, noVhp });
      played = S.playSeason(sf.days);
      console.log(`season ${s} day ${nDay} (${S.dayLabel(d)}): ${picks.length} picks, ${played.players.filter((x: any) => x.outN === null).length} still in`);
    }
    // Who is staked in Survivor, for each of the season's two vault weeks: read once a day while the week runs (for the
    // boards), and once more after it ends (final: withdrawals can't change it any more). Both nodes must agree.
    const w1 = vaultWeekOf(start), everyone = played.players.map((x: any) => x.a);
    // Never before day 1 is recorded: until then the season's players aren't known, and a reading of nobody would be
    // saved as final (Repo Lense S2-1).
    if (stakesOn && seasonsOn && sf.days.length && timeLeft()) for (const k of [0, 1]) {
      const w = w1 + k, ended = head.time >= S.dayStart(start + S.WEEK_DAYS * (k + 1));
      if (head.time < S.dayStart(start + S.WEEK_DAYS * k)) continue;
      const cur = sf.stakes.find((x) => x.week === w);
      if (cur && (cur.final || (!ended && cur.day === today))) continue;
      try {
        const key = (x: Set<string> | null) => JSON.stringify(x === null ? null : [...x].sort());
        const mine = everyone.length ? await stakedRead(o.p, everyone, w) : new Set<string>();
        if (o.check && everyone.length && key(await stakedRead(o.check, everyone, w)) !== key(mine)) { problems.push(`season ${s}: the two nodes disagree about who is staked in Survivor in vault week ${w}; tried again next run`); continue; }
        sf.stakes = [...sf.stakes.filter((x) => x.week !== w), { week: w, final: ended, day: today, staked: mine ? [...mine].sort() : [] }].sort((x, y) => x.week - y.week);
        // A week whose wallets didn't change their stake that week has no frozen record; read more than a week late, the
        // vault then gives today's stake (Repo Lense S2-9). Say so, so the owner can check it.
        if (ended && today >= start + S.WEEK_DAYS * (k + 2)) problems.push(`season ${s}: vault week ${w}'s stakes were read late (after an outage); wallets that didn't change their stake that week are read at today's stake. Check them before the vault pays.`);
      } catch (e) { problems.push(`season ${s}: stakes in vault week ${w}: ${(e as Error).message} (tried again next run)`); }
    }
    const stakedAny = new Set<string>(sf.stakes.flatMap((x) => x.staked));
    const stakesFinal = !stakesOn || [w1, w1 + 1].every((w) => sf.stakes.some((x) => x.week === w && x.final));
    const players = played.players.map((x: any) => ({ ...x, staked: stakedAny.has(x.a) }));
    const endDay = start + played.endN;                       // the day after the last played day
    // Final: over, past the correction window, and both weeks' stakes known (the free prize is for players free in both).
    const final = played.over && head.time >= S.dayStart(endDay) + S.CORRECTION_MS && stakesFinal;
    sf.result = { over: played.over, endN: played.endN, final, players, prizes: final ? S.prizes(players) : [] };
    seasons.push(sf);
  }
  seasons.sort((x, y) => x.season - y.season);

  // ── 4. write ──
  // Everything is written to a side folder first and moved in at the end, so a run that crashes half-way never leaves
  // new days next to old season files (Repo Lense SV-A26).
  // The side folder sits next to OUT's parent folder (never inside it, so a leftover one is never published), on the
  // same disk, so the swap at the end is two renames (Repo Lense SV-A26: copying file by file wasn't atomic).
  const FINAL = path.resolve(OUT);
  fs.mkdirSync(path.dirname(FINAL), { recursive: true });
  const STAGE = stageFor(FINAL);
  const keep = [...days.values()].sort((x, y) => x.day - y.day).slice(-KEEP_DAYS);
  fs.writeFileSync(path.join(STAGE, "days.json"), JSON.stringify({ v: 1, updated: new Date(head.time).toISOString(), days: keep }) + "\n");
  fs.writeFileSync(path.join(STAGE, "fields.json"), JSON.stringify({ v: 1, updated: new Date(head.time).toISOString(), fields }) + "\n");
  for (const sf of seasons) {
    // A season is kept from the day its day 1 is over, even with no day recorded yet, so it can't drop off the list
    // unnoticed (fix-check FC-2).
    if (!sf.days.length && (!seasonsOn || sf.startDay > lastDone)) continue;
    known.add(sf.season);
    const text = JSON.stringify(encodeSeason(sf)) + "\n";
    if (Buffer.byteLength(text) > SIZE_WARN) problems.push(`Survivor: ${sName(sf.season)} is ${(Buffer.byteLength(text) / 1048576).toFixed(2)} MB, near or over the 2 MB publish limit; only that file is left out (docs/SURVIVOR-RUNBOOK.md)`);
    fs.writeFileSync(path.join(STAGE, sName(sf.season)), text);
    // The vault's results files (mainnet only: the test clock's rounds aren't vault weeks).
    if (S.MAINNET && vaultOk) for (const [w, f] of Object.entries(vaultFiles(sf, S, problems, publishedWeeks))) {
      if (Number(w) < 0) continue;                         // before the vault's week 0 (Repo Lense S2-19)
      // A season's last week before game 3's first vault week: its winners can't be paid (fix-check).
      if (vault?.game3 && Number(w) === vaultWeekOf(sf.startDay) + 1 && Number(w) < Number(vault.game3.from_week || 0)) problems.push(`Survivor: season ${sf.season} ends in vault week ${w}, before game 3 starts in the vault (week ${vault.game3.from_week}); its free prize can't be paid`);
      fs.mkdirSync(path.join(STAGE, "vault"), { recursive: true });
      fs.writeFileSync(path.join(STAGE, "vault", `W${w}.json`), JSON.stringify(f) + "\n");
    }
  }
  // The published vault files go back out exactly as they are (never rebuilt: Repo Lense S3-6).
  for (const w of publishedWeeks) {
    fs.mkdirSync(path.join(STAGE, "vault"), { recursive: true });
    fs.copyFileSync(path.join(PREV, "vault", `W${w}.json`), path.join(STAGE, "vault", `W${w}.json`));
  }
  fs.writeFileSync(path.join(STAGE, "index.json"), JSON.stringify({ v: 1, updated: new Date(head.time).toISOString(), firstDay, contract: contract || null, seasons: [...known].sort((a, b) => a - b) }) + "\n");
  swapIn(STAGE, FINAL);
  setHardStop(Infinity);
  for (const pr of problems) console.log(`::warning::${pr}`);
  return { problems, days, fields, seasons };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run({ p: new Provider([RPC]), check: RPC_CHECK ? new Provider([RPC_CHECK]) : null }).catch((e) => { console.error(e); process.exit(1); });
}

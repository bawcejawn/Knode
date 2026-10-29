/**
 * Survivor recorder (run every hour by .github/workflows/games.yml; read-only on the chain, holds no key).
 *
 * Each run:
 *  1. Days. A UTC day is recorded once the first block of the next day is irreversible and every block of the day
 *     (signer and time) matches on two independent nodes (RPC and RPC_CHECK). It keeps each producer's block count.
 *     Up to 3 days a run, so a long outage (or the first run, which needs the 8 days behind today) catches up over a
 *     few runs.
 *  2. Fields. From the recorded days: today's and tomorrow's field and handicap (site/survivor-math.js: each
 *     producer's blocks over days d−8 … d−2), so the page can show them before the 23:55 UTC lock.
 *  3. Seasons (once FIRST_DAY is set and the Picks contract is live, picks-data/deployment.json): for each recorded
 *     season day, the picks for that day from the Picks contract (game 3), read on both nodes (they must agree; the
 *     chain locked them at 23:55 UTC the night before), and which players still in hold 1 VHP or a Knode stake at
 *     this check (on both nodes: both must say so). Only the picks of players still in are kept (from day 2 on), so a
 *     season file stays small (audit SV-2). Game 3's settings on the chain are checked first (audit SV-9). A season
 *     stays on the list until it is final, and the days it still needs are recorded even after a long outage (SV-4). The season is played by site/survivor-math.js, the same file the page runs. A season is final 12
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
import { pathToFileURL } from "node:url";
import { readVhp, MAINNET_VHP, withRetry } from "../../common.ts";
await import("../../site/survivor-math.js");
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
type SeasonFile = { v: 1; season: number; startDay: number; days: SeasonDay[]; result: any };
/** On disk (Repo Lense SV-A5): each wallet and producer is written once, in `who` and `prods`, and the days refer to them
 *  by position. picks: [[wallet index, producer index]]; noVhp: [wallet index]. */
type SeasonFileV2 = { v: 2; season: number; startDay: number; who: string[]; prods: string[]; days: any[]; result: any };
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
  const fresh: SeasonFile = { v: 1, season, startDay, days: [], result: null };
  let old = readJson(dir, sName(season));
  if (old && old.v === 2) old = decodeSeason(old);
  if (!old || old.v !== 1 || old.season !== season || old.startDay !== startDay || !Array.isArray(old.days)) return fresh;
  // Keep the recorded days in order from day 1, without gaps.
  for (const d of old.days) {
    if (!d || d.n !== fresh.days.length + 1 || d.day !== startDay + d.n - 1 || !Array.isArray(d.field) || !countsOk(d.counts) || !Array.isArray(d.picks) || !Array.isArray(d.noVhp)) break;
    if (!d.picks.every((x: any) => Array.isArray(x) && x.length === 2 && isAddr(x[0]) && isAddr(x[1])) || !d.noVhp.every(isAddr)) break;
    fresh.days.push({ n: d.n, day: d.day, field: d.field, counts: d.counts, picks: d.picks, noVhp: d.noVhp });
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
  return { v: 1, season: j.season, startDay: j.startDay, days, result: null };
}
export function encodeSeason(sf: SeasonFile): SeasonFileV2 {
  const who: string[] = [], prods: string[] = [], wi = new Map<string, number>(), pi = new Map<string, number>();
  const at = (list: string[], m: Map<string, number>, a: string) => { let i = m.get(a); if (i === undefined) { i = list.length; list.push(a); m.set(a, i); } return i; };
  const days = sf.days.map((d) => ({ n: d.n, day: d.day, field: d.field, counts: d.counts,
    picks: d.picks.map(([p, q]) => [at(who, wi, p), at(prods, pi, q)]), noVhp: d.noVhp.map((a) => at(who, wi, a)) }));
  return { v: 2, season: sf.season, startDay: sf.startDay, who, prods, days, result: sf.result };
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
/** Game 3's settings must be exactly what site/survivor-math.js assumes (audit SV-9). Returns a problem, or "". */
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
const GAME_ABI = () => JSON.parse(fs.readFileSync(new URL("../../game/abi/kpred.koilib.json", import.meta.url), "utf8"));
/** Who may win a prize: at least 1 VHP, or a Knode stake (the owner's 1 VHP rule; a staked player's VHP sits in the vault).
 *  The testnet passes its own token (and no game contract). */
export async function readRanked(node: any, who: string[], token = MAINNET_VHP, game: string | null = GAME,
  deps: { vhp?: (node: any, token: string, who: string[]) => Promise<Record<string, string>>; player?: (node: any, game: string, a: string) => Promise<any> } = {}): Promise<Set<string>> {
  const out = new Set<string>();
  if (!who.length) return out;
  const vhpOf = deps.vhp ?? (async (n: any, t: string, w: string[]) => (await readVhp(n, t, w)).values);
  const playerOf = deps.player ?? (async (n: any, g: string, a: string) => {
    const c = new Contract({ id: g, abi: GAME_ABI(), provider: n });
    const r: any = await withRetry(`Knode player ${a}`, () => (c.functions as any).get_player({ player: a, week: "0" }));
    return r?.result?.player ?? {};
  });
  const vhp = await vhpOf(node, token, who);
  for (const a of who) {
    if (BigInt(vhp[a] || "0") >= ONE_VHP) { out.add(a); continue; }
    if (!game) continue;
    // A failed read throws, so the day is tried again next run instead of costing a staker the season (Repo Lense SV-A7).
    const p = (await playerOf(node, game, a)) ?? {};
    // At least 1 VHP staked, the same as the wallet rule: a dust stake doesn't count (Repo Lense SV-A3).
    if (BigInt(p.stake || "0") + BigInt(p.pending || "0") >= ONE_VHP) out.add(a);
  }
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

/** The vault files of one season, as far as they are final: { week: file }. The season's first week carries no
 *  winners; its last week carries the whole season's 1st and 2nd (Vault v6 hand-off, 28 Oct). A place with more than
 *  10 tied wallets is left empty (the vault refuses more), so its prize returns to the pool; `problems` says so. */
export function vaultFiles(sf: { startDay: number; result: any }, now: number, math: any, problems: string[] = []): Record<number, any> {
  const out: Record<number, any> = {};
  const w1 = vaultWeekOf(sf.startDay), w2 = w1 + 1;
  const file = (week: number, first: string[], second: string[]) => ({ game: math.GAME_ID, week, final: true, rows: [], first, second });
  if (now >= math.dayStart(sf.startDay + 7)) out[w1] = file(w1, [], []);
  if (sf.result && sf.result.final) {
    const at = (place: number) => sf.result.prizes.filter((x: any) => x.place === place).map((x: any) => x.player as string).sort();
    let first = at(1), second = at(2);
    if (first.length > VAULT_MAX_WINNERS) { problems.push(`Survivor: ${first.length} wallets tied for 1st in the season from ${math.dayLabel(sf.startDay)}; the vault takes at most ${VAULT_MAX_WINNERS}, so no prize is posted for the season (it returns to the pool)`); first = []; second = []; }
    if (second.length > VAULT_MAX_WINNERS) { problems.push(`Survivor: ${second.length} wallets tied for 2nd in the season from ${math.dayLabel(sf.startDay)}; the vault takes at most ${VAULT_MAX_WINNERS}, so 2nd's prize returns to the pool`); second = []; }
    out[w2] = file(w2, first, second);
  }
  return out;
}

/** One run. Exported for the tests, which pass fake nodes. */
export async function run(o: Opts) {
  S = o.math ?? MAINNET_S;
  const OUT = o.out ?? E.SURVIVOR_OUT ?? "games-data/survivor";
  const PREV = o.prev ?? E.SURVIVOR_PREV ?? "";
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
    if (o.check) { const c = await headOf(o.check); readerC = blockReader(o.check, c.id); }
  }
  const timeP = o.timeOf ? (h: number) => o.timeOf!(o.p, h) : (h: number) => readerP.time(h);
  const rangeP = o.blocksOf ? (a: number, b: number) => o.blocksOf!(o.p, a, b) : (a: number, b: number) => readerP.range(a, b);
  const rangeC = !o.check ? null : o.blocksOf ? (a: number, b: number) => o.blocksOf!(o.check, a, b) : (a: number, b: number) => readerC.range(a, b);
  const picksRead = o.picksOf ?? (contract ? (node: any, d: number) => readPicks(node, contract, d) : null);
  const holdToken = o.holdToken ?? MAINNET_VHP, holdGame = o.gameContract === undefined ? GAME : o.gameContract;
  const rankedRead = o.rankedOf ?? ((node: any, who: string[]) => readRanked(node, who, holdToken, holdGame));
  const gameRead = o.gameOf ?? (contract ? (node: any) => readGame(node, contract) : null);
  console.log(`head ${head.height} (${new Date(head.time).toISOString()}), irreversible ${head.lib} (${new Date(head.libTime).toISOString()})`);

  // ── the seasons this run looks at (loaded first: they decide which older days are still needed) ──
  const days = loadDays(PREV);
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
      if (!pr && o.check && JSON.stringify(split(await gameRead(o.check)).game) !== JSON.stringify(mine.game)) pr = "the two nodes disagree about game 3's settings";
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
  // Days saved while only one node was read are checked on the second node once there is one (Repo Lense SV-A16), newest
  // first, with what is left of this run's budget. A day the second node disagrees with is reported, not changed.
  if (rangeC) for (const rec of [...days.values()].filter((x) => x.checked === 1).sort((x, y) => y.day - x.day)) {
    if (n >= MAX_DAYS_PER_RUN) break;
    n++;
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
    return new Set([...mine].filter((a) => theirs.has(a)));
  };
  for (const sf of active) {
    const s = sf.season, start = sf.startDay;
    let played = S.playSeason(sf.days);
    // Record the next days of the season that are done.
    while (seasonsOn && !played.over && sf.days.length < S.SEASON_DAYS) {
      const nDay = sf.days.length + 1, d = start + nDay - 1, rec = days.get(d);
      if (!rec) break;
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
    const endDay = start + played.endN;                       // the day after the last played day
    const final = played.over && head.time >= S.dayStart(endDay) + S.CORRECTION_MS;
    sf.result = { over: played.over, endN: played.endN, final, players: played.players, prizes: final ? S.prizes(played.players) : [] };
    seasons.push(sf);
  }
  seasons.sort((x, y) => x.season - y.season);

  // ── 4. write ──
  // Everything is written to a side folder first and moved in at the end, so a run that crashes half-way never leaves
  // new days next to old season files (Repo Lense SV-A26).
  // (The side folder is outside OUT's parent, so a leftover one is never published.)
  const FINAL = OUT, STAGE = fs.mkdtempSync(path.join(os.tmpdir(), "survivor-out-"));
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
    if (S.MAINNET) for (const [w, f] of Object.entries(vaultFiles(sf, head.time, S, problems))) {
      fs.mkdirSync(path.join(STAGE, "vault"), { recursive: true });
      fs.writeFileSync(path.join(STAGE, "vault", `W${w}.json`), JSON.stringify(f) + "\n");
    }
  }
  fs.writeFileSync(path.join(STAGE, "index.json"), JSON.stringify({ v: 1, updated: new Date(head.time).toISOString(), firstDay, contract: contract || null, seasons: [...known].sort((a, b) => a - b) }) + "\n");
  fs.mkdirSync(FINAL, { recursive: true });
  const names = fs.readdirSync(STAGE).sort((x, y) => (x === "index.json" ? 1 : y === "index.json" ? -1 : x < y ? -1 : 1));   // index last
  if (names.includes("vault")) {
    fs.mkdirSync(path.join(FINAL, "vault"), { recursive: true });
    for (const f of fs.readdirSync(path.join(STAGE, "vault")).sort()) fs.copyFileSync(path.join(STAGE, "vault", f), path.join(FINAL, "vault", f));
  }
  for (const f of names) if (f !== "vault") fs.copyFileSync(path.join(STAGE, f), path.join(FINAL, f));
  fs.rmSync(STAGE, { recursive: true, force: true });
  for (const pr of problems) console.log(`::warning::${pr}`);
  return { problems, days, fields, seasons };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run({ p: new Provider([RPC]), check: RPC_CHECK ? new Provider([RPC_CHECK]) : null }).catch((e) => { console.error(e); process.exit(1); });
}

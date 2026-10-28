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
import { pathToFileURL } from "node:url";
import { readVhp, MAINNET_VHP, withRetry } from "../../common.ts";
await import("../../site/survivor-math.js");
/** The mainnet game. A testnet run passes its own clock (o.math, from KSurvivor.withConfig); every helper below reads S. */
const MAINNET_S: any = (globalThis as any).KSurvivor;
let S: any = MAINNET_S;

const E = process.env;
const RPC = E.RPC || "https://koinos.armana.io";
const RPC_CHECK = E.RPC_CHECK && E.RPC_CHECK !== "off" && E.RPC_CHECK !== RPC ? E.RPC_CHECK : "";
const MAX_DAYS_PER_RUN = 3;
const KEEP_DAYS = 60;                         // days.json keeps the last 60 recorded days
const CATCHUP_DAYS = 50;                      // after an outage, a season's older days are recorded back to 50 days
const BACK_DAYS = S.FORM_DAYS + S.FORM_GAP - 1;  // today's field needs days d−8 … d−2; tomorrow's needs d−7 … d−1
const ONE_VHP = 100000000n;
const isAddr = (a: unknown) => typeof a === "string" && /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a);

type Counts = [string, number][];
type DayRec = { day: number; heights: [number, number]; blocks: number; checked: number; counts: Counts };
type Field = { a: string; k: number; h: number }[];
// noVhp: the players still in who did NOT hold 1 VHP or a stake at that day's check (usually few; audit SV-2).
type SeasonDay = { n: number; day: number; field: Field; counts: Counts; picks: [string, string][]; noVhp: string[] };
type SeasonFile = { v: 1; season: number; startDay: number; days: SeasonDay[]; result: any };
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
  const old = readJson(dir, sName(season));
  if (!old || old.v !== 1 || old.season !== season || old.startDay !== startDay || !Array.isArray(old.days)) return fresh;
  // Keep the recorded days in order from day 1, without gaps.
  for (const d of old.days) {
    if (!d || d.n !== fresh.days.length + 1 || d.day !== startDay + d.n - 1 || !Array.isArray(d.field) || !countsOk(d.counts) || !Array.isArray(d.picks) || !Array.isArray(d.noVhp)) break;
    if (!d.picks.every((x: any) => Array.isArray(x) && x.length === 2 && isAddr(x[0]) && isAddr(x[1])) || !d.noVhp.every(isAddr)) break;
    fresh.days.push({ n: d.n, day: d.day, field: d.field, counts: d.counts, picks: d.picks, noVhp: d.noVhp });
  }
  if (old.result && old.result.final === true && fresh.days.length === old.days.length) fresh.result = old.result;
  return fresh;
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
  const want: Record<string, string> = { id: String(S.GAME_ID), kind: "1", list_size: "1", lock_mode: "2", round_size: String(S.DAY), round_offset: "0", lead: String(S.LEAD_MS), ahead: String(S.AHEAD_MS), max_changes: String(S.MAX_CHANGES) };
  for (const [k, v] of Object.entries(want)) if (String(g[k] ?? "0") !== v) return `game 3's ${k} on the chain is ${g[k] ?? "0"}, the Survivor math expects ${v}`;
  return "";
}
async function readGame(node: any, contract: string): Promise<any> {
  const c = new Contract({ id: contract, abi: PICKS_ABI(), provider: node });
  const r: any = await withRetry("game 3", () => (c.functions as any).get_game({ game: S.GAME_ID }));
  return r?.result?.game ?? null;
}
const GAME = (() => { try { return JSON.parse(fs.readFileSync(new URL("../../game-data/deployment.json", import.meta.url), "utf8")).contract as string; } catch { return ""; } })();
const GAME_ABI = () => JSON.parse(fs.readFileSync(new URL("../../game/abi/kpred.koilib.json", import.meta.url), "utf8"));
/** Who may win a prize: at least 1 VHP, or a Knode stake (the owner's 1 VHP rule; a staked player's VHP sits in the vault).
 *  The testnet passes its own token (and no game contract). */
async function readRanked(node: any, who: string[], token = MAINNET_VHP, game: string | null = GAME): Promise<Set<string>> {
  const out = new Set<string>();
  if (!who.length) return out;
  const vhp = (await readVhp(node, token, who)).values;
  for (const a of who) {
    if (BigInt(vhp[a] || "0") >= ONE_VHP) { out.add(a); continue; }
    if (!game) continue;
    try {
      const c = new Contract({ id: game, abi: GAME_ABI(), provider: node });
      const r: any = await withRetry(`Knode player ${a}`, () => (c.functions as any).get_player({ player: a, week: "0" }));
      const p = r?.result?.player ?? {};
      if (BigInt(p.stake || "0") + BigInt(p.pending || "0") > 0n) out.add(a);
    } catch { /* not counted */ }
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
  if (seasonsOn && gameRead) {
    try { const pr = gameProblem(await gameRead(o.p)); if (pr) { problems.push(`Survivor: ${pr}; seasons not recorded this run`); seasonsOn = false; } }
    catch (e) { problems.push(`Survivor: game 3's settings: ${(e as Error).message} (tried again next run)`); seasonsOn = false; }
  }
  if (firstDay !== null) {
    // Every known season stays on the list until it is final (audit SV-4), plus the last and the current one.
    const cur = S.seasonOf(Math.max(firstDay, today), firstDay).season;
    const list = new Set<number>(known);
    for (const s of [cur - 1, cur]) if (s >= 1 && S.seasonStartDay(s, firstDay) <= lastDone) list.add(s);
    for (const s of [...list].sort((x, y) => x - y)) {
      const sf = loadSeason(PREV, s, S.seasonStartDay(s, firstDay));
      if (sf.result && sf.result.final) seasons.push(sf); else active.push(sf);
    }
  }

  // ── 1. days ──
  /** Record day d. Its start comes from the day before's record when there is one, and is always checked against the
   *  block before it (audit SV-6); if that start doesn't fit, it is searched again from scratch (fix-check FC-1).
   *  Returns true when the day was recorded. */
  async function recordDay(d: number): Promise<boolean> {
    const prevRec = days.get(d - 1);
    for (const usePrev of prevRec ? [true, false] : [false]) {
      let a: number;
      if (usePrev) a = prevRec!.heights[1] + 1;
      else {
        const est = Math.ceil((head!.libTime - S.dayStart(d)) / 3000) + 600;
        let lo = Math.max(1, head!.lib - est);
        while (lo > 1 && (await timeP(lo)) >= S.dayStart(d)) lo = Math.max(1, lo - est);
        a = await heightAt(timeP, S.dayStart(d), lo, head!.lib);
      }
      const b = (await heightAt(timeP, S.dayStart(d + 1), a, head!.lib)) - 1;
      if (b < a || b >= head!.lib) { problems.push(`${S.dayLabel(d)}: its blocks aren't all irreversible yet`); return false; }
      const B = await rangeP(a, b);
      // The day's first block is the first at or after 00:00 UTC: the block before it is from the day before.
      if (B.ts[0] < S.dayStart(d) || B.ts[B.ts.length - 1] >= S.dayStart(d + 1) || (a > 1 && (await timeP(a - 1)) >= S.dayStart(d))) {
        if (usePrev) { problems.push(`${S.dayLabel(d)}: the day before's recorded end doesn't fit; searched again`); continue; }
        problems.push(`${S.dayLabel(d)}: the blocks found don't fit the day; not recorded this run`); return false;
      }
      let checked = 1;
      if (rangeC) {
        const C = await rangeC(a, b);
        const same = C.ts.length === B.ts.length && C.ts.every((t, i) => t === B.ts[i] && C.signers[i] === B.signers[i]);
        if (!same) { problems.push(`${S.dayLabel(d)}: the two nodes disagree about the day's blocks; not recorded this run`); return false; }
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
      const inNow = alive ? [...alive] : [...new Set(picks.map((x) => x[0]))];
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
  fs.mkdirSync(OUT, { recursive: true });
  const keep = [...days.values()].sort((x, y) => x.day - y.day).slice(-KEEP_DAYS);
  fs.writeFileSync(path.join(OUT, "days.json"), JSON.stringify({ v: 1, updated: new Date(head.time).toISOString(), days: keep }) + "\n");
  fs.writeFileSync(path.join(OUT, "fields.json"), JSON.stringify({ v: 1, updated: new Date(head.time).toISOString(), fields }) + "\n");
  for (const sf of seasons) {
    // A season is kept from the day its day 1 is over, even with no day recorded yet, so it can't drop off the list
    // unnoticed (fix-check FC-2).
    if (!sf.days.length && (!seasonsOn || sf.startDay > lastDone)) continue;
    known.add(sf.season);
    fs.writeFileSync(path.join(OUT, sName(sf.season)), JSON.stringify(sf) + "\n");
  }
  fs.writeFileSync(path.join(OUT, "index.json"), JSON.stringify({ v: 1, updated: new Date(head.time).toISOString(), firstDay, contract: contract || null, seasons: [...known].sort((a, b) => a - b) }) + "\n");
  for (const pr of problems) console.log(`::warning::${pr}`);
  return { problems, days, fields, seasons };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run({ p: new Provider([RPC]), check: RPC_CHECK ? new Provider([RPC_CHECK]) : null }).catch((e) => { console.error(e); process.exit(1); });
}

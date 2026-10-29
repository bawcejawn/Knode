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
 *  3. Leaderboards (board.json): Today (UTC day), This week, Last week and All time, ranked by points: a pick on the
 *     winner is a win (3 points), a pick on the 2nd or 3rd horse a show (1 point). Ties: more wins, then more picks
 *     placed; wallets still tied share the place (owner, 2026-10-28: the question game no longer breaks Race ties).
 *     Each row says whether the wallet is staked in the Race in the KnodeGames Vault that week (the Staked board) or
 *     plays free (the Free play board).
 *  4. Writes race-data/index.json, race-data/W<week>.json and race-data/board.json, which the publish job puts on the
 *     race-data branch for the website.
 *  5. The KnodeGames Vault's results file for last week, race-data/vault/W<week>.json (see vaultResults below): the
 *     free prize's 1st and 2nd places, final once every race of the week is final. A final file is never rewritten.
 * The scoring is race-math.js, the same file the website runs.
 *
 *   RPC, RPC_CHECK ("off" to skip the second node), RACE_PREV (the race-data files from the last run), RACE_OUT.
 *   npm run race            (or: npx tsx bot/race.ts)
 */
import { Provider } from "koilib";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { Contract } from "koilib";
import { readVhp, MAINNET_VHP, withRetry, sleep } from "../common.ts";
await import("../race-math.js");
const M: any = (globalThis as any).KRaceMath;

const E = process.env;
const RPC = E.RPC || "https://koinos.armana.io";
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
type Opts = {
  p: any; check: any | null; prev?: string; out?: string; vhpOf?: (who: string[]) => Promise<Record<string, string>>;
  raceContract?: string | null;                                       // the picks contract (default: race-data/deployment.json)
  picksOf?: (node: any, race: number) => Promise<Pick[]>;             // for the tests
  stakedOf?: (node: any, who: string, week: number) => Promise<boolean>;   // staked in the Race in the vault (tests)
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
    if (rows.length < 100) break;
    after = rows[rows.length - 1].player;
  }
  return out;
}
/** Staked in the Race (game 7) in the KnodeGames Vault for week w (owner, 2026-10-28), by the vault's own test, the one
 *  its bot applies to free-prize winners: the week's peak stake in the game (entry.peak_stake, or active_stake when the
 *  player has no entry that week) at least that week's minimum stake. A wallet staked at the start of a week stays
 *  staked that week even if it withdraws. Before the vault (v6) is live nobody is staked; a failed read throws. */
const vaultState = new WeakMap<object, Promise<any>>();
export const NO_V6_ABI = "game/abi/kpred.koilib.json has no get_game_player (still v5): Race stakes can't be read";
async function readStaked(node: any, who: string, week: number): Promise<boolean> {
  const abi = GAME_ABI();
  if (!GAME) throw new Error("game-data/deployment.json gives no contract: Race stakes can't be read");
  // This repository's contract ABI is still v5: it can't tell whether the vault is live, so it can't say who is free.
  // Throwing keeps the vault file from being final (the boards show everyone on Free play, with one warning a run).
  if (!abi.methods?.get_game_player) throw new Error(NO_V6_ABI);
  const c = new Contract({ id: GAME, abi, provider: node });
  if (!vaultState.has(node)) vaultState.set(node, withRetry("vault state", () => (c.functions as any).get_state({})));
  const cfg = (await vaultState.get(node))?.result?.config;
  if (!cfg) { vaultState.delete(node); throw new Error("the vault's get_state came back empty"); }
  if (!(Number(cfg.v6_rule_week_plus_one || 0) > 0)) return false;   // the contract on chain isn't v6 yet
  const r: any = await withRetry(`Race stake of ${who}`, () => (c.functions as any).get_game_player({ player: who, game: VAULT_GAME, week: String(week) }));
  return stakedFrom(cfg, r?.result ?? {}, week);
}
/** The vault's test, from its config (get_state) and a get_game_player result for the Race and that week. Exported. */
export function stakedFrom(cfg: any, r: any, week: number): boolean {
  if (!(Number(cfg?.v6_rule_week_plus_one || 0) > 0)) return false;
  const next = BigInt(cfg.min_stake_next || "0");
  const min = next > 0n && week >= Number(cfg.min_stake_next_week || 0) ? next : BigInt(cfg.min_stake || "0");
  const peak = r?.entry ? BigInt(r.entry.peak_stake || "0") : BigInt(r?.active_stake || "0");
  return min > 0n && peak >= min;
}
/** One run. Exported for the tests, which pass fake nodes. */
export async function run({ p, check, prev, out, vhpOf, raceContract, picksOf, stakedOf }: Opts) {
  if (prev !== undefined) PREV = prev;
  if (out !== undefined) OUT = out;
  const vhpRead = vhpOf || (async (who: string[]) => (await readVhp(p, MAINNET_VHP, who)).values);
  const picksContract = raceContract === undefined ? defaultRaceContract() : raceContract;
  const picksRead = picksOf || (picksContract ? (node: any, r: number) => readPicks(node, picksContract, r) : null);
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
    const ra = M.raceAt(s), race = raceById(ra.id);
    if (!race) continue;
    const leg = M.legOf(ra.start, s, race.cards.length);
    if (!race.cards[leg] && !want.some((x) => x.race === race && x.leg === leg)) want.push({ race, leg });
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
        // [player, horse, time, won (1/0), 0, show: 2nd or 3rd (1/0)]. The 5th field was "may be ranked" (1 VHP or a
        // question-game stake) until 2026-10-28; the Staked / Free play split now comes from the vault, so it is no longer
        // read (a race's result depends only on its blocks and picks) and is always 0.
        picks = mine.map(([who, horse, at]) => [who, horse, at, horse === winner ? 1 : 0, 0, horse !== winner && showSet.has(horse) ? 1 : 0]);
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
  const stakedRead = stakedOf || readStaked;
  const { board, vault } = await leaderboards(weeks, now, problems,
    (who, week) => stakedRead(p, who, week), check ? (who, week) => stakedRead(check, who, week) : null);

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
  if (vault) {
    fs.mkdirSync(path.join(OUT, "vault"), { recursive: true });
    fs.writeFileSync(path.join(OUT, "vault", `W${vault.week}.json`), JSON.stringify(vault) + "\n");
  }
  for (const pr of problems) console.log(`::warning::${pr}`);
  return { problems };
}

// ── leaderboards ──
/** correct = wins (picks on the winner), shows = picks on the 2nd or 3rd horse, pts = 3 per win + 1 per show. */
/** ranked: on the Staked board, i.e. staked in the Race in the vault that week (owner, 2026-10-28; before then it meant
 *  "holds 1 VHP or a question-game stake"). boardPlace: the place on its own board (Staked or Free play), tied wallets
 *  sharing it (1, 1, 3, …), which the site shows (board.js). */
type Row = { a: string; pts: number; correct: number; shows: number; picks: number; ranked: boolean; boardPlace?: number };
/** Sort: points, then more wins, then more picks placed; the address only orders wallets that share a place. Exported. */
export function rank(rows: Row[]): Row[] {
  return [...rows].sort((x, y) => y.pts - x.pts || y.correct - x.correct || y.picks - x.picks || (x.a < y.a ? -1 : 1));
}
/** The picks of final races in [from, to): per wallet, wins, shows and picks placed. */
function tally(weeks: Map<number, WeekFile>, from: number, to: number) {
  const t = new Map<string, { correct: number; shows: number; picks: number }>();
  for (const wf of weeks.values()) for (const r of wf.races) {
    if (r.start < from || r.start >= to || !r.result?.final || !Array.isArray(r.result.picks)) continue;
    for (const [who, , , right, , show] of r.result.picks) {
      const x = t.get(who) || { correct: 0, shows: 0, picks: 0 };
      x.picks++; x.correct += right ? 1 : 0; x.shows += !right && show ? 1 : 0;
      t.set(who, x);
    }
  }
  return t;
}
type StakedOf = (who: string, week: number) => Promise<boolean>;
async function leaderboards(weeks: Map<number, WeekFile>, now: number, problems: string[],
  stakedOf: StakedOf = async () => false, stakedCheck: StakedOf | null = null) {
  // All time needs every week: load the ones this run didn't (read only).
  const all = new Map(weeks);
  const idx = readPrev("index.json");
  for (const w of Array.isArray(idx?.weeks) ? idx.weeks : []) if (Number.isInteger(w) && !all.has(w)) all.set(w, loadWeek(w));
  const wNow = M.weekOf(now), day0 = Math.floor(now / M.DAY) * M.DAY;
  const failed = new Set<string>();              // "stake:who|week": stake reads that failed (not staked on the boards)
  const anyPicks = [...all.values()].some((wf) => wf.races.some((r) => Array.isArray(r.result?.picks)));
  // Staked in the Race that week (the vault's test): read once per wallet and week; a failed read counts as not staked
  // on the boards and keeps the vault file from being final.
  const stakes = new Map<string, boolean>();
  const staked = async (who: string, week: number) => {
    const k = `${who}|${week}`;
    if (!stakes.has(k)) {
      try { stakes.set(k, await stakedOf(who, week)); }
      catch (e) {
        const m = (e as Error).message, line = m === NO_V6_ABI ? m : `Race stake of ${who}: ${m}`;
        if (!problems.includes(line)) problems.push(line);
        failed.add(`stake:${k}`); stakes.set(k, false);
      }
    }
    return stakes.get(k)!;
  };
  if (!anyPicks) return { board: null, vault: await vaultResults(all, wNow - 1, now, [], failed, problems, stakedCheck) };
  // stakeWeek: the week whose stake decides the board (Today and This week: this week; Last week: that week; All time:
  // this week, the wallet's standing now).
  const build = async (from: number, to: number, stakeWeek: number) => {
    const rows: Row[] = [];
    for (const [a, x] of tally(all, from, to))
      rows.push({ a, pts: x.correct * M.POINTS.win + x.shows * M.POINTS.show, correct: x.correct, shows: x.shows, picks: x.picks, ranked: await staked(a, stakeWeek) });
    return withPlaces(rank(rows));
  };
  const lastRows = wNow > 0 ? await build(M.weekStart(wNow - 1), M.weekStart(wNow), wNow - 1) : [];
  const board = {
    v: 1, updated: new Date(now).toISOString(),
    today: { day: M.dayOf(now), rows: await build(day0, day0 + M.DAY, wNow) },
    week: { week: wNow, start: M.weekStart(wNow), rows: await build(M.weekStart(wNow), M.weekStart(wNow + 1), wNow) },
    lastWeek: wNow > 0 ? { week: wNow - 1, start: M.weekStart(wNow - 1), rows: lastRows } : null,
    allTime: { rows: await build(0, Infinity, wNow) },
  };
  return { board, vault: await vaultResults(all, wNow - 1, now, lastRows, failed, problems, stakedCheck) };
}

// ── the KnodeGames Vault's results file (Vault v6 hand-offs, 2026-10-28) ──
/** The Producer Race's game number in the KnodeGames Vault, the vault's limit of wallets per prize place, and its
 *  points range for staked players' rows. */
export const VAULT_GAME = 7;
export const MAX_PRIZE_WINNERS = 10;
export const MAX_ROW_POINTS = 255;
type VaultRow = { player: string; points: number };
type VaultFile = { game: number; week: number; final: boolean; rows: VaultRow[]; first: string[]; second: string[]; skipped: string[] };

/** Two rows tie when every ranking measure is equal (rank() sorts by exactly these, so ties sit next to each other). */
const tied = (x: Row, y: Row) => x.pts === y.pts && x.correct === y.correct && x.picks === y.picks;
/** Each row's place on its own board (Staked or Free play), ties sharing it: 1, 1, 3, … Rows stay in rank() order. Exported. */
export function withPlaces(rows: Row[]): Row[] {
  const last: Record<string, { r: Row; place: number; n: number }> = {};
  return rows.map((r) => {
    const k = r.ranked ? "staked" : "free", prev = last[k], n = (prev ? prev.n : 0) + 1;
    const place = prev && tied(prev.r, r) ? prev.place : n;
    last[k] = { r, place, n };
    return { ...r, boardPlace: place };
  });
}
function groupsOf(rows: Row[]): Row[][] {
  const groups: Row[][] = [];
  for (const r of rows) { const g = groups[groups.length - 1]; if (g && tied(g[0], r)) g.push(r); else groups.push([r]); }
  return groups;
}

/** The free prize's places from a week's rows in rank() order. Every free player (not staked in the Race that week)
 *  with at least 1 point qualifies (owner, 2026-10-28). Wallets tied on every measure (points, wins, picks) share a
 *  place: a tie for 1st takes both prizes, so 2nd stays empty. The vault takes at most 10 wallets a place: when more are
 *  tied, the 10 that made their first pick of the week earliest (the time the chain recorded it; then the address)
 *  take the place and the rest get nothing (owner, 2026-10-28). `firstPick`: each wallet's earliest pick time that
 *  week. Exported. */
export function prizePlaces(rows: Row[], firstPick: Map<string, number> = new Map()): { first: string[]; second: string[]; notes: string[] } {
  const groups = groupsOf(rows.filter((r) => !r.ranked && r.pts >= 1));
  const notes: string[] = [];
  const at = (a: string) => firstPick.get(a) ?? Infinity;
  const early = (g: Row[]) => [...g].sort((x, y) => at(x.a) - at(y.a) || (x.a < y.a ? -1 : 1)).map((r) => r.a).slice(0, MAX_PRIZE_WINNERS);
  const [g1, g2] = groups;
  if (!g1) return { first: [], second: [], notes };
  if (g1.length > MAX_PRIZE_WINNERS) notes.push(`${g1.length} wallets are tied for 1st: the ${MAX_PRIZE_WINNERS} with the earliest first pick share it, ${g1.length - MAX_PRIZE_WINNERS} get nothing`);
  if (g1.length > 1 || !g2) return { first: early(g1), second: [], notes };
  if (g2.length > MAX_PRIZE_WINNERS) notes.push(`${g2.length} wallets are tied for 2nd: the ${MAX_PRIZE_WINNERS} with the earliest first pick share it, ${g2.length - MAX_PRIZE_WINNERS} get nothing`);
  return { first: [g1[0].a], second: early(g2), notes };
}

/** The staked players' rows for the vault: every wallet staked in the Race that week with at least 1 point, in the
 *  board's order, as points 255, 254, ... per tied group (only the order and the ties matter to the vault). Beyond 255
 *  groups the rest all get 1 point and the run warns. Exported. */
export function stakedRows(rows: Row[]): { rows: VaultRow[]; notes: string[] } {
  const groups = groupsOf(rows.filter((r) => r.ranked && r.pts >= 1)), out: VaultRow[] = [], notes: string[] = [];
  groups.forEach((g, i) => { for (const r of g) out.push({ player: r.a, points: Math.max(1, MAX_ROW_POINTS - i) }); });
  if (groups.length > MAX_ROW_POINTS) notes.push(`${groups.length} different scores among staked players: the lowest ${groups.length - MAX_ROW_POINTS + 1} share 1 point`);
  return { rows: out, notes };
}

/** A race that still isn't final this long after its week ends is skipped (owner, 2026-10-28): its picks don't count
 *  (the leaderboard only ever counts final races) and the week's results become final without it. Normally every
 *  race is final within an hour or two of its end. */
export const VAULT_SKIP_AFTER = 12 * M.HOUR;

/** The vault's file for week w. Final once:
 *  - every race of the week is final (or was never run because the recorder hadn't started, or is skipped after
 *    VAULT_SKIP_AFTER), and the week file shows the recorder did run that week;
 *  - every Race stake was read, and the stakes read the same on the second node.
 *  `skipped` lists the races left out. A file already published as final is kept exactly as it is, so the vault never
 *  sees its results change (the publish job also refuses to change one). */
async function vaultResults(all: Map<number, WeekFile>, w: number, now: number, rows: Row[], failed: Set<string>, problems: string[], stakedCheck: StakedOf | null = null): Promise<VaultFile | null> {
  if (w < 0) return null;
  const old = readPrev(`vault/W${w}.json`);
  if (old && old.final === true && old.game === VAULT_GAME && old.week === w) return old;
  const wf = all.get(w);
  // No week file, or one with nothing recorded (e.g. the last run's files couldn't be read): write nothing.
  if (!wf || !wf.races.some((r) => r.cards.some(Boolean) || r.result)) return null;
  let firstCard = Infinity;
  for (const x of all.values()) for (const r of x.races) if (r.cards.some(Boolean)) firstCard = Math.min(firstCard, r.start);
  const open = wf.races.filter((r) => !r.result?.final && !(r.start < firstCard && !r.cards.some(Boolean)));
  const late = now >= wf.end + VAULT_SKIP_AFTER;
  const unread = rows.filter((r) => failed.has(`stake:${r.a}|${w}`));
  const file: VaultFile = { game: VAULT_GAME, week: w, final: false, rows: [], first: [], second: [], skipped: [] };
  const wait = (why: string) => { problems.push(`vault week ${w}: not final yet, ${why}`); return file; };
  if (open.length && !late) return wait(`${open.length} race(s) still being checked (${open.map((r) => r.id).join(", ")}); skipped if still open at ${new Date(wf.end + VAULT_SKIP_AFTER).toISOString()}`);
  if (unread.length) return wait(`${unread.length} Race stake(s) could not be read (tried again next run)`);
  if (stakedCheck) {
    for (const r of rows) {
      let theirs: boolean;
      try { theirs = await stakedCheck(r.a, w); } catch (e) { return wait(`the second node couldn't read ${r.a}'s Race stake (${(e as Error).message})`); }
      if (theirs !== r.ranked) return wait(`the two nodes disagree about whether ${r.a} was staked in the Race`);
    }
  }
  if (open.length) problems.push(`vault week ${w}: ${open.length} race(s) never became final and are skipped: ${open.map((r) => r.id).join(", ")}`);
  const firstPick = new Map<string, number>();
  for (const r of wf.races) if (r.result?.final && Array.isArray(r.result.picks)) for (const x of r.result.picks) {
    const t = Number(x[2]); if (!firstPick.has(x[0]) || t < firstPick.get(x[0])!) firstPick.set(x[0], t);
  }
  const places = prizePlaces(rows, firstPick), staked = stakedRows(rows);
  for (const n of [...places.notes, ...staked.notes]) problems.push(`vault week ${w}: ${n}`);
  return { ...file, final: true, rows: staked.rows, first: places.first, second: places.second, skipped: open.map((r) => r.id) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run({ p: new Provider([RPC]), check: RPC_CHECK ? new Provider([RPC_CHECK]) : null }).catch((e) => { console.error(e); process.exit(1); });
}

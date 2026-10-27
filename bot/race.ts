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
 *  3. Leaderboards (board.json): Today (UTC day), This week (the Knode game's week) and All time, ranked by correct
 *     winner picks; ties: more picks placed, then more Knode questions answered, then a higher Knode score.
 *  4. Writes race-data/index.json, race-data/W<week>.json and race-data/board.json, which the publish job puts on the
 *     race-data branch for the website.
 * The scoring is site/race-math.js, the same file the website runs.
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

/** One pick as recorded: [player, horse, time of the pick (ms)]. */
type Pick = [string, string, number];
/** What the game knows about a wallet: stake, and the week's Knode answers and points. */
type PlayerInfo = { stake: bigint; answers: number; points: number };
type Opts = {
  p: any; check: any | null; prev?: string; out?: string; vhpOf?: (who: string[]) => Promise<Record<string, string>>;
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
    if (rows.length < 100) break;
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
export async function run({ p, check, prev, out, vhpOf, raceContract, picksOf, playerOf }: Opts) {
  if (prev !== undefined) PREV = prev;
  if (out !== undefined) OUT = out;
  const vhpRead = vhpOf || (async (who: string[]) => (await readVhp(p, MAINNET_VHP, who)).values);
  const picksContract = raceContract === undefined ? defaultRaceContract() : raceContract;
  const picksRead = picksOf || (picksContract ? (node: any, r: number) => readPicks(node, picksContract, r) : null);
  const playerRead = playerOf || readPlayer;
  // Who may be ranked: at least 1 VHP, or a Knode stake (the Mana sponsor's "real player" rule). Read once per run.
  const eligibleCache = new Map<string, boolean>();
  async function eligible(who: string[]) {
    const todo = who.filter((a) => !eligibleCache.has(a));
    if (todo.length) {
      const vhp = await vhpRead(todo);
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
      const winner = M.winners(st)[0] || null;
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
        // [player, horse, time, right (1/0), may be ranked (1/0)]
        picks = mine.map(([who, horse, at]) => [who, horse, at, horse === winner ? 1 : 0, can(who) ? 1 : 0]);
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
type Row = { a: string; correct: number; picks: number; answers: number; points: number; ranked: boolean };
/** Sort: correct winner picks, then more picks placed, then more Knode answers, then a higher Knode score. Exported. */
export function rank(rows: Row[]): Row[] {
  return [...rows].sort((x, y) => y.correct - x.correct || y.picks - x.picks || y.answers - x.answers || y.points - x.points || (x.a < y.a ? -1 : 1));
}
/** The picks of final races in [from, to): per wallet, right picks and picks placed, and whether it may be ranked. */
function tally(weeks: Map<number, WeekFile>, from: number, to: number) {
  const t = new Map<string, { correct: number; picks: number; ranked: boolean }>();
  for (const wf of weeks.values()) for (const r of wf.races) {
    if (r.start < from || r.start >= to || !r.result?.final || !Array.isArray(r.result.picks)) continue;
    for (const [who, , , right, can] of r.result.picks) {
      const x = t.get(who) || { correct: 0, picks: 0, ranked: false };
      x.picks++; x.correct += right ? 1 : 0; x.ranked = x.ranked || !!can;
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
      rows.push({ a, correct: x.correct, picks: x.picks, answers, points, ranked: x.ranked });
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run({ p: new Provider([RPC]), check: RPC_CHECK ? new Provider([RPC_CHECK]) : null }).catch((e) => { console.error(e); process.exit(1); });
}

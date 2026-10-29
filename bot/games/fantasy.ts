/**
 * Fantasy Producers recorder (read-only on the chain, holds no key). The rules and the scoring are site/fantasy-math.js,
 * the same file the website runs.
 *   mainnet  .github/workflows/games.yml (when Fantasy is registered): real clock, Picks games 4 (team) and 5 (rival)
 *   testnet  bot/fantasy-test.ts: picks on the testnet Picks contract, a fast clock (1 test day = 1 hour), and the
 *            teams scored on MAINNET blocks (read only), because the testnet has a single block producer.
 *
 * Each run:
 *  1. Days. Every day whose last block is irreversible gets each producer's index (blocks signed ÷ expected, from the
 *     race cards' VHP shares). Its blocks must match on two nodes (RPC and RPC_CHECK) to be final. Today so far is
 *     published too, marked provisional (irreversible blocks only, one node), so the page can show a live score.
 *  2. Price sheet. From its time (real clock: Sunday 12:00 UTC), the sheet for the coming week: the race field on the
 *     card in force then, each producer's form over the 7 days before, its price. Its sha256 is published with it and
 *     it is never made again.
 *  3. Teams and rivals (once the Picks contract is set). A day's team picks are read once the day's start is
 *     irreversible (they locked 5 minutes before), on both Picks nodes, which must agree. The week's rival challenges
 *     are read the same way when the week starts.
 *  4. Scores. Each player's day-by-day team (one change a day, budget, pool), day scores and week points. A week is
 *     "checking" until half a day after it ends (real clock: Monday 12:00 UTC) and all its days are final; then final,
 *     with the vault points (1..255) the operator bot posts to the vault. Rival matches of a final week are added to
 *     the records once.
 *  5. Writes index.json, days.json, W<week>.json, rivals.json and board.json to FANTASY_OUT, for the publish job.
 *
 *   RPC, RPC_CHECK ("off" to skip the second node), FANTASY_PREV (the last run's files), FANTASY_OUT,
 *   RACE_DATA (the race-data files, for the cards).
 *   npm run fantasy
 */
import { Provider, Contract } from "koilib";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { withRetry, sleep } from "../../common.ts";
import { readBlocks, blockTime, heightAt } from "../race.ts";
await import("../../site/race-math.js");
await import("../../site/fantasy-math.js");
const M: any = (globalThis as any).KRaceMath;
const FREAL: any = (globalThis as any).KFantasyMath;

const E = process.env;
const KEEP_DAYS = 21;                       // days kept in days.json (a sheet's form needs 7; last week and this one 14)
const BLOCK_BUDGET = 120000;                // blocks read for whole days per run (a long outage catches up over runs)
const isAddr = (a: unknown): a is string => typeof a === "string" && /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a);
const pad = (w: number) => String(w).padStart(3, "0");

type Ix = Record<string, [number, number, number | null]>;
export type DayRec = { day: number; final: boolean; checked: number; heights: [number, number]; blocks: number; producers: Ix };
type Sheet = { week: number; at: number; budget: number; median: number | null; pool: { a: string; form: number | null; price: number }[]; late?: boolean };
/** A pick as the Picks contract holds it: [player, addresses (team: captain first; rival: the rival), time (ms)]. */
export type RawPick = [string, string[], number];
type PlayerRow = { a: string; points: number; vault: number; full: boolean; place: number; days: { day: number; team: string[] | null; score: number; note?: string }[] };
type WeekFile = {
  v: 1; week: number; start: number; end: number; final: boolean;
  sheet: Sheet | null; sha256: string | null;
  picks: Record<string, RawPick[]>;                   // team picks by day number
  rivals: [string, string][] | null;                  // [challenger, target], read when the week started
  players: PlayerRow[];
  matches: { a: string; b: string; mutual: boolean; result: string }[];
};
export type Opts = {
  p: any; check: any | null;                                         // the chain whose blocks score the teams
  picksP?: any; picksCheck?: any | null;                             // the chain of the Picks contract (default: p, check)
  prev?: string; out?: string; raceData?: string;
  math?: any;                                                        // KFantasyMath or KFantasyMath.withClock(...)
  games?: { team: number; rival: number };
  picksContract?: string | null;                                     // default: picks-data/deployment.json
  picksOf?: (node: any, game: number, round: number) => Promise<RawPick[]>;   // for the tests
  live?: boolean;                                                    // publish today so far (default true)
};

function readJson(dir: string, name: string): any {
  if (!dir) return null;
  const f = path.join(dir, name);
  try { if (fs.lstatSync(f).isSymbolicLink()) return null; return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; }
}
function defaultPicksContract(): string | null {
  try { const d = JSON.parse(fs.readFileSync(new URL("../../picks-data/deployment.json", import.meta.url), "utf8")); return isAddr(d.contract) ? d.contract : null; } catch { return null; }
}
const PICKS_ABI = () => JSON.parse(fs.readFileSync(new URL("../../picks/abi/picks.koilib.json", import.meta.url), "utf8"));
/** Every pick for a round of a Picks game, page by page (list_picks: rows in address order, 100 at a time). */
export async function readPicks(node: any, contract: string, game: number, round: number): Promise<RawPick[]> {
  const c = new Contract({ id: contract, abi: PICKS_ABI(), provider: node });
  const out: RawPick[] = [];
  let after: string | undefined;
  for (let page = 0; page < 1000; page++) {
    const r: any = await withRetry(`picks game ${game} round ${round}`, () => (c.functions as any).list_picks({ game, round: String(round), ...(after ? { start_after: after } : {}), limit: 100 }));
    const rows = r?.result?.rows ?? [];
    for (const x of rows) { const list = x.pick?.producers; if (isAddr(x.player) && Array.isArray(list) && list.length && list.every(isAddr)) out.push([x.player, list, Number(x.pick.time || 0)]); }
    if (rows.length < 100) break;
    after = rows[rows.length - 1].player;
  }
  return out;
}
const sortPicks = (x: RawPick[]) => [...x].sort((u, v) => (u[0] < v[0] ? -1 : u[0] > v[0] ? 1 : 0));
const samePicks = (a: RawPick[], b: RawPick[]) => JSON.stringify(sortPicks(a)) === JSON.stringify(sortPicks(b));

/** The race cards by race id, from the race-data week files that cover [from, to). Race weeks are real weeks. */
function loadCards(dir: string, from: number, to: number): Record<string, any[]> {
  const out: Record<string, any[]> = {};
  for (let w = M.weekOf(from); w <= M.weekOf(to); w++) {
    const wf = readJson(dir, `W${pad(w)}.json`);
    if (!wf || !Array.isArray(wf.races)) continue;
    for (const r of wf.races) if (r && typeof r.id === "string" && Array.isArray(r.cards)) out[r.id] = r.cards;
  }
  return out;
}
/** The heights of the blocks in [t0, t1) up to `top` (empty: b < a). */
async function heightsOf(p: any, headId: string, top: number, topT: number, t0: number, t1: number) {
  const est = Math.ceil((topT - t0) / 3000) + 600;
  let lo = Math.max(1, top - est);
  while (lo > 1 && (await blockTime(p, headId, lo)) >= t0) lo = Math.max(1, lo - est);
  const a = await heightAt(p, headId, t0, lo, top);
  const b = t1 > topT ? top : (await heightAt(p, headId, t1, a, top)) - 1;
  return [a, b] as [number, number];
}

export async function run(o: Opts) {
  const F = o.math || FREAL;
  const G = o.games || F.GAMES;
  const prev = o.prev ?? E.FANTASY_PREV ?? "", out = o.out ?? E.FANTASY_OUT ?? "games-data/fantasy", raceData = o.raceData ?? E.RACE_DATA ?? "race-data";
  const p = o.p, check = o.check, pp = o.picksP ?? p, pcheck = o.picksCheck === undefined ? (o.picksP ? null : check) : o.picksCheck;
  const contract = o.picksContract === undefined ? defaultPicksContract() : o.picksContract;
  const picksRead = o.picksOf || (contract ? (node: any, g: number, r: number) => readPicks(node, contract, g, r) : null);
  const problems: string[] = [];
  const head: any = await withRetry("head", () => p.getHeadInfo());
  const headId = head.head_topology.id, now = Number(head.head_block_time);
  const libH = Number(head.last_irreversible_block), libT = await blockTime(p, headId, libH);
  const chk = check ? await withRetry("check head", () => check.getHeadInfo()) : null;
  // The Picks chain's own irreversible time (the testnet's, when the picks live there).
  let pLibT = libT;
  if (pp !== p) {
    const ph: any = await withRetry("picks head", () => pp.getHeadInfo());
    pLibT = await blockTime(pp, ph.head_topology.id, Number(ph.last_irreversible_block));
  }
  console.log(`scoring chain irreversible ${libH} (${new Date(libT).toISOString()}); picks chain irreversible ${new Date(pLibT).toISOString()}`);
  const cards = loadCards(raceData, now - (KEEP_DAYS + 2) * F.DAY_MS - M.DAY, now + M.DAY);

  // ── 1. days ──
  const prevDays: DayRec[] = (readJson(prev, "days.json")?.days || []).filter((d: any) => d && Number.isInteger(d.day) && d.final === true && d.producers && typeof d.producers === "object");
  const days = new Map<number, DayRec>(prevDays.map((d) => [d.day, d]));
  const today = F.dayNo(now);
  let budget = BLOCK_BUDGET;
  // Newest first, so a long backlog never holds up the days a sheet or this week needs most.
  for (let d = today - 1; d >= today - KEEP_DAYS && budget > 0; d--) {
    if (days.get(d)?.final || F.dayStart(d + 1) > libT) continue;
    try {
      const t0 = F.dayStart(d), t1 = F.dayStart(d + 1);
      const [a, b] = await heightsOf(p, headId, libH, libT, t0, t1);
      if (b < a) continue;                                  // no blocks that day (before the chain's records)
      budget -= b - a + 1;
      const B = await readBlocks(p, headId, a, b);
      let checked = 1;
      if (check) {
        const C = await readBlocks(check, chk.head_topology.id, a, b);
        const same = C.ts.length === B.ts.length && C.ts.every((t: number, i: number) => t === B.ts[i] && C.signers[C.sig[i]] === B.signers[B.sig[i]]);
        if (!same) { problems.push(`day ${new Date(t0).toISOString()}: the two nodes disagree about its blocks; not final this run`); continue; }
        checked = 2;
      }
      const ix = F.dayIndex(B, cards, d);
      if (Object.values(ix.producers).every((x: any) => x[1] === 0)) { problems.push(`day ${new Date(t0).toISOString()}: no race card covers it yet; not final this run`); continue; }
      days.set(d, { day: d, final: true, checked, heights: [a, b], blocks: ix.blocks, producers: ix.producers });
      console.log(`day ${new Date(t0).toISOString()}: ${ix.blocks} blocks ${a}-${b}, checked on ${checked} node(s)`);
    } catch (e) { problems.push(`day ${d}: ${(e as Error).message} (tried again next run)`); }
    await sleep(50);
  }
  if (budget <= 0) problems.push("catching up on past days: more next run");
  // Today so far: irreversible blocks only, one node, provisional (never used for points).
  let live: any = null;
  if (o.live !== false && libT > F.dayStart(today)) {
    try {
      const [a, b] = await heightsOf(p, headId, libH, libT, F.dayStart(today), libT + 1);
      if (b >= a) { const B = await readBlocks(p, headId, a, b); const ix = F.dayIndex(B, cards, today); live = { day: today, final: false, upTo: libT, heights: [a, b], blocks: ix.blocks, producers: ix.producers }; }
    } catch (e) { problems.push(`today so far: ${(e as Error).message}`); }
  }
  const dayList = [...days.values()].filter((d) => d.day >= today - KEEP_DAYS).sort((x, y) => x.day - y.day);

  // ── 2. weeks and sheets ──
  const wNow = F.weekOf(now), weeks = new Map<number, WeekFile>();
  const load = (w: number): WeekFile => {
    const x = readJson(prev, `W${pad(w)}.json`);
    if (x && x.v === 1 && x.week === w && x.start === F.weekStart(w)) return x;
    return { v: 1, week: w, start: F.weekStart(w), end: F.weekStart(w + 1), final: false, sheet: null, sha256: null, picks: {}, rivals: null, players: [], matches: [] };
  };
  for (const w of [wNow - 1, wNow, wNow + 1]) if (w >= 0) weeks.set(w, load(w));
  for (const [w, wf] of weeks) {
    if (wf.sheet || now < F.sheetTime(w) || w < wNow) continue;   // never a sheet for a week already over
    const formWin = F.formDays(w).map((d: number) => days.get(d));
    if (formWin.some((d: DayRec | undefined) => !d?.final) && now < wf.start) { problems.push(`week ${w}: the price sheet waits for its form days to be final`); continue; }
    const card = F.cardAt(cards, Math.floor(F.sheetTime(w) / M.HOUR) * M.HOUR);
    if (!card) { problems.push(`week ${w}: no race card at the sheet time; no sheet yet`); continue; }
    const sheet: Sheet = F.makeSheet(w, card, formWin.filter(Boolean));
    if (!sheet.pool.length) { problems.push(`week ${w}: the card at the sheet time has no field; no sheet yet`); continue; }
    if (now >= wf.start) sheet.late = true;                 // made after the week began: the page says so
    wf.sheet = sheet;
    wf.sha256 = crypto.createHash("sha256").update(F.sheetText(sheet)).digest("hex");
    console.log(`week ${w}: price sheet ${wf.sha256.slice(0, 12)}… (${sheet.pool.length} producers${sheet.late ? ", late" : ""})`);
  }

  // ── 3. picks ──
  if (picksRead) for (const wf of weeks.values()) {
    if (wf.final) continue;
    for (const d of F.weekDays(wf.week)) {
      if (wf.picks[d] || F.dayStart(d) > pLibT) continue;
      try {
        const mine = await picksRead(pp, G.team, d);
        if (pcheck && !samePicks(await picksRead(pcheck, G.team, d), mine)) { problems.push(`week ${wf.week} day ${d}: the two nodes disagree about the picks`); continue; }
        wf.picks[d] = sortPicks(mine.filter((x) => x[1].length >= 1));
      } catch (e) { problems.push(`week ${wf.week} day ${d} picks: ${(e as Error).message}`); }
    }
    if (!wf.rivals && wf.start <= pLibT) {
      try {
        const r = F.rivalRound(wf.week), mine = await picksRead(pp, G.rival, r);
        if (pcheck && !samePicks(await picksRead(pcheck, G.rival, r), mine)) problems.push(`week ${wf.week}: the two nodes disagree about the rival challenges`);
        else wf.rivals = sortPicks(mine).filter((x) => x[1].length === 1).map((x) => [x[0], x[1][0]] as [string, string]);
      } catch (e) { problems.push(`week ${wf.week} rivals: ${(e as Error).message}`); }
    }
  }

  // ── 4. scores ──
  const rivalsPrev = readJson(prev, "rivals.json");
  let records = rivalsPrev?.records && typeof rivalsPrev.records === "object" && !Array.isArray(rivalsPrev.records) ? rivalsPrev.records : {};
  const counted = new Set<number>(Array.isArray(rivalsPrev?.weeks) ? rivalsPrev.weeks.filter((w: any) => Number.isInteger(w)) : []);
  const correction = F.DAY_MS / 2;                         // real clock: Monday 12:00 UTC
  for (const w of [...weeks.keys()].sort((x, y) => x - y)) {
    const wf = weeks.get(w)!;
    if (wf.final || !wf.sheet || now < wf.start) continue;
    const wd = F.weekDays(w), recs = wd.map((d: number) => days.get(d) || { day: d, producers: {} });
    // Each player's pick for each day (the contract keeps one per round: the latest); the team carried in = the
    // player's last team of last week.
    const byPlayer = new Map<string, Record<number, string[]>>();
    for (const [d, rows] of Object.entries(wf.picks)) for (const [who, list] of rows) { const m = byPlayer.get(who) || {}; m[Number(d)] = list; byPlayer.set(who, m); }
    const last = weeks.get(w - 1) || (w > 0 ? load(w - 1) : null);
    const carried = new Map<string, string[]>((last?.players || []).filter((x) => x.days?.[6]?.team).map((x) => [x.a, x.days[6].team as string[]]));
    for (const a of carried.keys()) if (!byPlayer.has(a)) byPlayer.set(a, {});
    const rows = [...byPlayer].map(([a, picks]) => { const s = F.scoreWeek(wf.sheet, recs, picks, carried.get(a) || null); return { a, points: s.points, vault: F.vaultPoints(s.points), full: s.full, days: s.days }; });
    wf.players = F.rank(rows.filter((r) => r.days.some((d: any) => d.team)));
    const allFinal = recs.every((d: any) => d.final);
    if (allFinal && now >= wf.end + correction && (wf.rivals || !picksRead)) {
      wf.final = true;
      const pts = Object.fromEntries(wf.players.map((x) => [x.a, { points: x.points, full: x.full }]));
      wf.matches = F.matches(wf.rivals || [], pts);
      if (!counted.has(w)) { records = F.addRecords(records, wf.matches); counted.add(w); }
      console.log(`week ${w}: final, ${wf.players.length} players, ${wf.matches.length} rival matches`);
    }
  }

  // ── 5. write ──
  fs.mkdirSync(out, { recursive: true });
  const idx = readJson(prev, "index.json"), known = new Set<number>(Array.isArray(idx?.weeks) ? idx.weeks.filter((w: any) => Number.isInteger(w) && w >= 0 && w < 100000) : []);
  for (const [w, wf] of weeks) {
    if (!wf.sheet && !wf.players.length) continue;
    known.add(w);
    fs.writeFileSync(path.join(out, `W${pad(w)}.json`), JSON.stringify(wf) + "\n");
  }
  fs.writeFileSync(path.join(out, "days.json"), JSON.stringify({ v: 1, days: dayList, live }) + "\n");
  fs.writeFileSync(path.join(out, "rivals.json"), JSON.stringify({ v: 1, weeks: [...counted].sort((x, y) => x - y), records }) + "\n");
  const boardOf = (w: number) => { const wf = weeks.get(w); return wf ? { week: w, final: wf.final, rows: wf.players.map((x) => ({ a: x.a, points: x.points, place: x.place, full: x.full })) } : null; };
  const rivalRows = Object.entries(records).map(([a, x]: [string, any]) => ({ a, ...F.recordLine(x), made: x.made, received: x.received }))
    .filter((r) => isAddr(r.a) && r.n >= 4).sort((x, y) => y.pct - x.pct || y.n - x.n || (x.a < y.a ? -1 : 1));
  const cur = weeks.get(wNow), challenged = new Map<string, number>();
  for (const [, b] of cur?.rivals || []) challenged.set(b, (challenged.get(b) || 0) + 1);
  const most = [...challenged].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)).slice(0, 5).map(([a, n]) => ({ a, n }));
  fs.writeFileSync(path.join(out, "board.json"), JSON.stringify({ v: 1, updated: new Date(now).toISOString(), week: boardOf(wNow), lastWeek: boardOf(wNow - 1), rivals: rivalRows, mostChallenged: most }) + "\n");
  fs.writeFileSync(path.join(out, "index.json"), JSON.stringify({ v: 1, updated: new Date(now).toISOString(), weeks: [...known].sort((x, y) => x - y),
    contract: contract || null, games: G, clock: { day: F.DAY_MS, genesis: F.clock.genesis, sheetBefore: F.clock.sheetBefore } }) + "\n");
  for (const pr of problems) console.log(`::warning::${pr.replace(/[\r\n]+/g, " ").replace(/::/g, ": ")}`);
  return { problems, weeks, days: dayList, live };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const RPC = E.RPC || "https://koinos.armana.io";
  const RPC_CHECK = E.RPC_CHECK && E.RPC_CHECK !== "off" && E.RPC_CHECK !== RPC ? E.RPC_CHECK : "";
  run({ p: new Provider([RPC]), check: RPC_CHECK ? new Provider([RPC_CHECK]) : null }).catch((e) => { console.error(e); process.exit(1); });
}

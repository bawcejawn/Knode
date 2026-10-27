/**
 * Fantasy Producers recorder (to run hourly from a workflow, like bot/race.ts: read-only on the chain, holds no key).
 * The rules and the scoring are site/fantasy-math.js, the same file the website runs.
 *
 * Each run:
 *  1. Days. Every UTC day whose last block is irreversible gets each producer's index (blocks signed ÷ expected, from
 *     the race cards' VHP shares). The day's blocks must match on two nodes (RPC and RPC_CHECK) to be final.
 *  2. Price sheet. From Sunday 12:00 UTC, the sheet for next week: the race field on the card in force then, each
 *     producer's form over the 7 days before, its price. Its sha256 is published with it and it never changes.
 *  3. Teams and rivals (once the Picks contract is live: games-data/fantasy/deployment.json on main). Each day's picks
 *     are read once the day has started and its first block is irreversible (the chain locked them ~5 minutes before),
 *     on both nodes, which must agree. The week's rival challenges are read the same way when the week starts.
 *  4. Scores. Each player's day-by-day team (one change a day, budget, pool), day scores and week points. A week is
 *     "checking" until Monday 12:00 UTC after it ends and all its days are final; then final, with the vault points
 *     (1..255) the operator bot posts to the vault. Rival matches of a final week are added to the records once.
 *  5. Writes index.json, days.json, W<week>.json, rivals.json and board.json to FANTASY_OUT, for the publish job.
 *
 *   RPC, RPC_CHECK ("off" to skip the second node), FANTASY_PREV (the last run's files), FANTASY_OUT,
 *   RACE_DATA (the race-data files, for the cards).
 *   npm run fantasy            (or: npx tsx bot/games/fantasy.ts)
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
const F: any = (globalThis as any).KFantasyMath;

const E = process.env;
const RPC = E.RPC || "https://api.koinos.io";
const RPC_CHECK = E.RPC_CHECK && E.RPC_CHECK !== "off" && E.RPC_CHECK !== RPC ? E.RPC_CHECK : "";
const KEEP_DAYS = 21;                       // days kept in days.json (form needs 7, the current and last week 14)
const CORRECTION = 12 * M.HOUR;             // a week stays "checking" until Monday 12:00 UTC after it ends
const GAME_TEAM = 3, GAME_RIVAL = 4;        // game ids in the Picks contract
const isAddr = (a: unknown): a is string => typeof a === "string" && /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a);
const pad = (w: number) => String(w).padStart(3, "0");

type DayRec = { day: number; final: boolean; checked: number; heights: [number, number]; blocks: number; producers: Record<string, [number, number, number | null]> };
type Sheet = { week: number; at: number; budget: number; pool: { a: string; form: number | null; price: number }[]; late?: boolean };
type TeamPick = [string, string[], number];          // [player, producers (captain first), time of the pick]
type WeekFile = {
  v: 1; week: number; start: number; end: number; final: boolean;
  sheet: Sheet | null; sha256: string | null;
  picks: Record<string, TeamPick[]>;                  // by UTC day number
  rivals: [string, string][] | null;                  // [challenger, target], read when the week started
  players: { a: string; points: number; vault: number; full: boolean; place: number; days: { day: number; team: string[] | null; score: number; note?: string }[] }[];
  matches: { a: string; b: string; mutual: boolean; result: string }[];
};
type Opts = {
  p: any; check: any | null; prev?: string; out?: string; raceData?: string;
  picksContract?: string | null;                                       // default: games-data/fantasy/deployment.json
  picksOf?: (node: any, game: number, round: number) => Promise<TeamPick[]>;   // for the tests
};

function readJson(dir: string, name: string): any {
  if (!dir) return null;
  const f = path.join(dir, name);
  try { if (fs.lstatSync(f).isSymbolicLink()) return null; return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; }
}
function defaultPicksContract(): string | null {
  try { const d = JSON.parse(fs.readFileSync(new URL("../../games-data/fantasy/deployment.json", import.meta.url), "utf8")); return isAddr(d.contract) ? d.contract : null; } catch { return null; }
}
/** Every pick for a round of a Picks game, page by page. The Picks contract (Build 3) is not live yet: this follows its
 *  planned list_picks(game, round, start_after, limit ≤ 100) and must be checked against its ABI when it lands. */
async function readPicks(node: any, contract: string, game: number, round: number): Promise<TeamPick[]> {
  const abi = JSON.parse(fs.readFileSync(new URL("../../picks/abi/picks.koilib.json", import.meta.url), "utf8"));
  const c = new Contract({ id: contract, abi, provider: node });
  const out: TeamPick[] = [];
  let after: string | undefined;
  for (let page = 0; page < 1000; page++) {
    const r: any = await withRetry(`picks game ${game} round ${round}`, () => (c.functions as any).list_picks({ game, round: String(round), ...(after ? { start_after: after } : {}), limit: 100 }));
    const rows = r?.result?.rows ?? [];
    for (const x of rows) { const list = x.pick?.producers; if (isAddr(x.player) && Array.isArray(list) && list.every(isAddr)) out.push([x.player, list, Number(x.pick.at || 0)]); }
    if (rows.length < 100) break;
    after = rows[rows.length - 1].player;
  }
  return out;
}
const sortPicks = (x: TeamPick[]) => [...x].sort((u, v) => (u[0] < v[0] ? -1 : u[0] > v[0] ? 1 : 0));

/** The race cards by race id, from the race-data week files that cover [from, to). */
function loadCards(dir: string, from: number, to: number): Record<string, any[]> {
  const out: Record<string, any[]> = {};
  for (let w = M.weekOf(from); w <= M.weekOf(to); w++) {
    const wf = readJson(dir, `W${pad(w)}.json`);
    if (!wf || !Array.isArray(wf.races)) continue;
    for (const r of wf.races) if (r && typeof r.id === "string" && Array.isArray(r.cards)) out[r.id] = r.cards;
  }
  return out;
}

export async function run({ p, check, prev = E.FANTASY_PREV || "", out = E.FANTASY_OUT || "games-data/fantasy", raceData = E.RACE_DATA || "race-data", picksContract, picksOf }: Opts) {
  const contract = picksContract === undefined ? defaultPicksContract() : picksContract;
  const picksRead = picksOf || (contract ? (node: any, g: number, r: number) => readPicks(node, contract, g, r) : null);
  const problems: string[] = [];
  const head: any = await withRetry("head", () => p.getHeadInfo());
  const headId = head.head_topology.id, now = Number(head.head_block_time);
  const libH = Number(head.last_irreversible_block), libT = await blockTime(p, headId, libH);
  const chk = check ? await withRetry("check head", () => check.getHeadInfo()) : null;
  console.log(`irreversible ${libH} (${new Date(libT).toISOString()})`);
  const cards = loadCards(raceData, now - (KEEP_DAYS + 2) * M.DAY, now + M.WEEK);

  // ── 1. days ──
  const prevDays: DayRec[] = (readJson(prev, "days.json")?.days || []).filter((d: any) => d && Number.isInteger(d.day) && d.producers);
  const days = new Map<number, DayRec>(prevDays.map((d) => [d.day, d]));
  const today = F.dayNo(now);
  for (let d = today - KEEP_DAYS; d < today; d++) {
    if (days.get(d)?.final || F.dayStart(d + 1) > libT) continue;
    try {
      const t0 = F.dayStart(d), t1 = F.dayStart(d + 1);
      const est = Math.ceil((libT - t0) / 3000) + 600;
      let lo = Math.max(1, libH - est);
      while (lo > 1 && (await blockTime(p, headId, lo)) >= t0) lo = Math.max(1, lo - est);
      const a = await heightAt(p, headId, t0, lo, libH), b = (await heightAt(p, headId, t1, a, libH)) - 1;
      if (b < a) continue;                                  // no blocks that day (before the chain's records)
      const B = await readBlocks(p, headId, a, b);
      let checked = 1;
      if (check) {
        const C = await readBlocks(check, chk.head_topology.id, a, b);
        const same = C.ts.length === B.ts.length && C.ts.every((t: number, i: number) => t === B.ts[i] && C.signers[C.sig[i]] === B.signers[B.sig[i]]);
        if (!same) { problems.push(`day ${M.dayOf(t0)}: the two nodes disagree about its blocks; not final this run`); continue; }
        checked = 2;
      }
      const ix = F.dayIndex(B, cards, d);
      const missing = Object.values(ix.producers).every((x: any) => x[1] === 0);
      if (missing) { problems.push(`day ${M.dayOf(t0)}: no race card covers it; not final this run`); continue; }
      days.set(d, { day: d, final: true, checked, heights: [a, b], blocks: ix.blocks, producers: ix.producers });
      console.log(`day ${M.dayOf(t0)}: ${ix.blocks} blocks ${a}-${b}, checked on ${checked} node(s)`);
    } catch (e) { problems.push(`day ${d}: ${(e as Error).message} (tried again next run)`); }
    await sleep(100);
  }
  const dayList = [...days.values()].filter((d) => d.day >= today - KEEP_DAYS).sort((x, y) => x.day - y.day);

  // ── 2. weeks and sheets ──
  const wNow = M.weekOf(now), weeks = new Map<number, WeekFile>();
  const load = (w: number): WeekFile => {
    const o = readJson(prev, `W${pad(w)}.json`);
    if (o && o.v === 1 && o.week === w) return o;
    return { v: 1, week: w, start: M.weekStart(w), end: M.weekStart(w + 1), final: false, sheet: null, sha256: null, picks: {}, rivals: null, players: [], matches: [] };
  };
  for (const w of [wNow - 1, wNow, wNow + 1]) if (w >= 0) weeks.set(w, load(w));
  for (const [w, wf] of weeks) {
    if (wf.sheet || now < F.sheetTime(w) || w < wNow) continue;   // never a sheet for a week already over
    const formWin = F.formDays(w).map((d: number) => days.get(d));
    if (formWin.some((d: DayRec | undefined) => !d?.final)) {
      if (now < wf.start) { problems.push(`week ${w}: the price sheet waits for its form days to be final`); continue; }
    }
    const card = F.cardAt(cards, Math.floor(F.sheetTime(w) / M.HOUR) * M.HOUR);
    if (!card) { problems.push(`week ${w}: no race card at the sheet time; no sheet yet`); continue; }
    const sheet: Sheet = F.makeSheet(w, card, formWin.filter(Boolean));
    if (now >= wf.start) sheet.late = true;                 // made after the week began: disclosed on the page
    wf.sheet = sheet;
    wf.sha256 = crypto.createHash("sha256").update(F.sheetText(sheet)).digest("hex");
    console.log(`week ${w}: price sheet ${wf.sha256.slice(0, 12)}… (${sheet.pool.length} producers${sheet.late ? ", late" : ""})`);
  }

  // ── 3. picks ──
  if (picksRead) for (const wf of weeks.values()) {
    if (wf.final) continue;
    for (const d of F.weekDays(wf.week)) {
      if (wf.picks[d] || F.dayStart(d) > libT) continue;
      try {
        const mine = sortPicks(await picksRead(p, GAME_TEAM, d));
        if (check && JSON.stringify(sortPicks(await picksRead(check, GAME_TEAM, d))) !== JSON.stringify(mine)) { problems.push(`week ${wf.week} day ${d}: the two nodes disagree about the picks`); continue; }
        wf.picks[d] = mine;
      } catch (e) { problems.push(`week ${wf.week} day ${d} picks: ${(e as Error).message}`); }
    }
    if (!wf.rivals && wf.start <= libT) {
      try {
        const mine = sortPicks(await picksRead(p, GAME_RIVAL, wf.week));
        if (check && JSON.stringify(sortPicks(await picksRead(check, GAME_RIVAL, wf.week))) !== JSON.stringify(mine)) problems.push(`week ${wf.week}: the two nodes disagree about the rival challenges`);
        else wf.rivals = mine.filter((x) => x[1].length === 1).map((x) => [x[0], x[1][0]] as [string, string]);
      } catch (e) { problems.push(`week ${wf.week} rivals: ${(e as Error).message}`); }
    }
  }

  // ── 4. scores ──
  const rivalsPrev = readJson(prev, "rivals.json");
  let records = rivalsPrev?.records && typeof rivalsPrev.records === "object" ? rivalsPrev.records : {};
  const counted = new Set<number>(Array.isArray(rivalsPrev?.weeks) ? rivalsPrev.weeks : []);
  for (const w of [...weeks.keys()].sort((x, y) => x - y)) {
    const wf = weeks.get(w)!;
    if (wf.final || !wf.sheet || now < wf.start) continue;
    const wd = F.weekDays(w), recs = wd.map((d: number) => days.get(d) || { day: d, producers: {} });
    // Each player's last pick for each day; the team carried in = the player's last team of last week.
    const byPlayer = new Map<string, Record<number, string[]>>();
    for (const [d, rows] of Object.entries(wf.picks)) for (const [who, list] of rows) { const m = byPlayer.get(who) || {}; m[Number(d)] = list; byPlayer.set(who, m); }
    const last = weeks.get(w - 1);
    const carried = new Map<string, string[]>((last?.players || []).filter((x) => x.days?.[6]?.team).map((x) => [x.a, x.days[6].team as string[]]));
    for (const a of carried.keys()) if (!byPlayer.has(a)) byPlayer.set(a, {});
    const rows = [...byPlayer].map(([a, picks]) => { const s = F.scoreWeek(wf.sheet, recs, picks, carried.get(a) || null); return { a, points: s.points, vault: F.vaultPoints(s.points), full: s.full, days: s.days }; });
    wf.players = F.rank(rows.filter((r) => r.days.some((d: any) => d.team)));
    const allFinal = recs.every((d: any) => d.final);
    if (allFinal && now >= wf.end + CORRECTION && (wf.rivals || !picksRead)) {
      wf.final = true;
      const pts = Object.fromEntries(wf.players.map((x) => [x.a, { points: x.points, full: x.full }]));
      wf.matches = F.matches(wf.rivals || [], pts);
      if (!counted.has(w)) { records = F.addRecords(records, wf.matches); counted.add(w); }
      console.log(`week ${w}: final, ${wf.players.length} players, ${wf.matches.length} rival matches`);
    }
  }

  // ── 5. write ──
  fs.mkdirSync(out, { recursive: true });
  const idx = readJson(prev, "index.json"), known = new Set<number>(Array.isArray(idx?.weeks) ? idx.weeks.filter((w: any) => Number.isInteger(w) && w >= 0 && w < 10000) : []);
  for (const [w, wf] of weeks) {
    if (!wf.sheet && !wf.players.length) continue;
    known.add(w);
    fs.writeFileSync(path.join(out, `W${pad(w)}.json`), JSON.stringify(wf) + "\n");
  }
  fs.writeFileSync(path.join(out, "days.json"), JSON.stringify({ v: 1, days: dayList }) + "\n");
  fs.writeFileSync(path.join(out, "rivals.json"), JSON.stringify({ v: 1, weeks: [...counted].sort((x, y) => x - y), records }) + "\n");
  const boardOf = (w: number) => { const wf = weeks.get(w); return wf ? { week: w, final: wf.final, rows: wf.players.map((x) => ({ a: x.a, points: x.points, place: x.place, full: x.full })) } : null; };
  const rivalRows = Object.entries(records).map(([a, x]: [string, any]) => ({ a, ...F.recordLine(x), made: x.made, received: x.received })).filter((r) => r.n >= 4).sort((x, y) => y.pct - x.pct || y.n - x.n || (x.a < y.a ? -1 : 1));
  fs.writeFileSync(path.join(out, "board.json"), JSON.stringify({ v: 1, updated: new Date(now).toISOString(), week: boardOf(wNow), lastWeek: boardOf(wNow - 1), rivals: rivalRows }) + "\n");
  fs.writeFileSync(path.join(out, "index.json"), JSON.stringify({ v: 1, updated: new Date(now).toISOString(), weeks: [...known].sort((x, y) => x - y) }) + "\n");
  for (const pr of problems) console.log(`::warning::${pr}`);
  return { problems };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run({ p: new Provider([RPC]), check: RPC_CHECK ? new Provider([RPC_CHECK]) : null }).catch((e) => { console.error(e); process.exit(1); });
}

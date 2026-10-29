/**
 * Block Golf recorder (run every hour by GitHub Actions; read-only, holds no key, writes nothing on chain).
 *   mainnet  .github/workflows/golf.yml           every live game in site/games.json → games-data/golf
 *   testnet  .github/workflows/games-testnet.yml  the testnet Block X games in testnet/golf.json → testnet-data/golf
 *
 * Block Golf has no picks of its own: each live game is a hole, and a player's place on that game's weekly leaderboard
 * sets their strokes (site/golf-math.js, the same file the page runs). Each run:
 *  1. The course. Every game marked live in site/games.json that has a reader below is a hole, from the first full
 *     week after it went live (index.json "course" remembers the week each joined). On the very first run the games
 *     already live join at once.
 *  2. Each hole's standings for this week and last week, from that game's own published results (never recomputed):
 *       questions  the question game contract, read on two nodes that must agree: each answer to a resolved question
 *                  scores 1 if right (as the site does); final when the week is closed and every question resolved
 *       race       race-data/board.json (this week / last week); final when every race of the week is final, or the
 *                  race recorder's 3-day window for it has passed
 *       blockx     games-data/blockx/board.json; final when its last week says final
 *       bracket    games-data/bracket/board.json; final when that week's view says final
 *       survivor   games-data/survivor season files: the standings at the week's last season day; a week with no
 *                  season is no hole
 *     The field of a hole is the wallets that game ranks (1 VHP or a Knode stake). For the question game this recorder
 *     checks that itself, like the Block X recorder does.
 *  3. Each hole's standings are kept in the week file as they were last read, so a game's board rolling on to a new
 *     week never loses them.
 *  4. A week is final 12 hours after it ends once every hole is final; a hole still not final 60 hours after the week
 *     ends is skipped for everyone (never guessed), so the week's points reach the vault within its 3-day window.
 *     A final week is never recomputed.
 *  5. Writes index.json, W<week>.json and board.json (Today and This week: this week so far; Last week; All time:
 *     final weeks only). The publish job checks their shape and pushes them to the data branch.
 *
 *   npm run golf                     mainnet (RPC, RPC_CHECK, GOLF_PREV, GOLF_OUT, RACE_DATA, GAMES_DATA)
 *   npm run golf -- --testnet        testnet (TESTNET_DATA: the testnet-data files; GOLF_PREV, GOLF_OUT)
 */
import { Provider, Contract } from "koilib";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { readVhp, MAINNET_VHP, withRetry } from "../../common.ts";
await import("../../site/race-math.js");
await import("../../site/golf-math.js");
const M: any = (globalThis as any).KRaceMath;
const G: any = (globalThis as any).KGolf;

const E = process.env;
const HOUR = 3600000, DAY = 24 * HOUR;
const FINAL_WAIT_MS = 12 * HOUR;              // a week is final 12 hours after it ends (the correction window)
const DEADLINE_MS = 60 * HOUR;                // a hole not final 60 hours after its week ends is skipped
const RACE_GIVE_UP_MS = 3 * DAY + 2 * HOUR;   // the race recorder stops trying to finalize a race after 3 days
const ONE_VHP = 100000000n;
const MAX_ROWS = 100000;
const isAddr = (a: unknown): a is string => typeof a === "string" && G.isAddr(a);

export type Row = { a: string; score: number; scored: boolean; ranked: boolean };
/** stale: the game's files have moved past this week, so only standings kept from an earlier run can be used. */
export type Read = { state: "final" | "live" | "none"; rows: Row[]; why?: string; stale?: boolean };
export type Source = { id: string; name: string; reader: string; dir?: string };
type HoleRec = { id: string; name: string; status: "final" | "live" | "skipped"; why: string; field: number; rows: [string, number, 0 | 1, 0 | 1][] };
type CardRec = { a: string; ranked: boolean; place: number; pts: number; strokes: number; par: number; toPar: number; lost: number; under: number; best: number; mulligan: string; holes: [string, number, number | null, number | null][] };
type WeekFile = { v: 1; week: number; start: number; end: number; final: boolean; holes: HoleRec[]; cards: CardRec[] };
export type QWeek = { closed: boolean; questions: number; resolved: number; rows: { a: string; pts: number; answered: number }[] };

export type Opts = {
  now?: number;
  p?: any; check?: any | null;
  prev?: string; out?: string;
  raceDir?: string; gamesDir?: string;                 // race-data and games-data files (mainnet)
  sources?: Source[];                                  // the games that can be holes (default: site/games.json)
  joinAll?: boolean;                                   // testnet: every source plays from the first week
  minField?: number;
  knodeGame?: string | null; vhpContract?: string;
  questionsOf?: (node: any, week: number) => Promise<QWeek>;   // for the tests
  rankedOf?: (who: string[]) => Promise<Set<string>>;
};

// ── files ──
function readJson(dir: string | undefined, name: string): any {
  if (!dir) return null;
  const f = path.join(dir, name);
  try { if (fs.lstatSync(f).isSymbolicLink() || fs.statSync(f).size > 20 * 1024 * 1024) return null; return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; }
}
const wName = (w: number) => `W${String(w).padStart(3, "0")}.json`;
const MAINNET_KNODE_GAME = (() => { try { return JSON.parse(fs.readFileSync(new URL("../../game-data/deployment.json", import.meta.url), "utf8")).contract as string; } catch { return ""; } })();
const GAME_ABI = () => JSON.parse(fs.readFileSync(new URL("../../game/abi/kpred.koilib.json", import.meta.url), "utf8"));

/** The live games of site/games.json that have a reader, as hole sources. */
export function sourcesFromGames(file: URL | string = new URL("../../site/games.json", import.meta.url)): Source[] {
  let list: any[] = [];
  try { list = JSON.parse(fs.readFileSync(file, "utf8")).games; } catch { return []; }
  return (Array.isArray(list) ? list : []).filter((g) => g && g.status === "live" && typeof g.id === "string" && g.id !== "golf" && READERS[g.id])
    .map((g) => ({ id: g.id, name: typeof g.name === "string" ? g.name.slice(0, 40) : g.id, reader: g.id }));
}

// ── readers: one per game, each turning that game's own published results into hole rows ──
/** A shared-shape board.json's view of week w: its "week" or "lastWeek". */
function boardView(b: any, w: number): { view: any; last: boolean } | null {
  if (!b || b.v !== 1) return null;
  if (b.week && b.week.week === w && Array.isArray(b.week.rows)) return { view: b.week, last: false };
  if (b.lastWeek && b.lastWeek.week === w && Array.isArray(b.lastWeek.rows)) return { view: b.lastWeek, last: true };
  return null;
}
/** The board has moved past week w (its oldest week shown is later), so it will never show week w again. */
function movedOn(b: any, w: number): boolean {
  if (!b || b.v !== 1) return false;
  const shown = [b.week, b.lastWeek].filter((x: any) => x && Number.isInteger(x.week)).map((x: any) => x.week);
  return shown.length > 0 && Math.min(...shown) > w;
}
const ptsRows = (rows: any[], key = "pts"): Row[] => rows.slice(0, MAX_ROWS).filter((r) => r && isAddr(r.a) && typeof r[key] === "number" && isFinite(r[key]) && r[key] >= 0)
  .map((r) => ({ a: r.a, score: r[key], scored: r[key] > 0, ranked: r.ranked === true }));

type Ctx = { now: number; raceDir?: string; gamesDir?: string; o: Opts; questions: (w: number) => Promise<Read> };
const READERS: Record<string, (src: Source, w: number, c: Ctx) => Promise<Read>> = {
  async questions(_s, w, c) { return c.questions(w); },

  async race(_s, w, c) {
    const b = readJson(c.raceDir, "board.json");
    const v = boardView(b, w);
    const end = M.weekStart(w + 1);
    let final = false;
    if (c.now >= end) {
      const wf = readJson(c.raceDir, wName(w));
      const races = wf && Array.isArray(wf.races) ? wf.races.filter((r: any) => r && r.start >= M.weekStart(w) && r.start < end) : [];
      final = (races.length > 0 && races.every((r: any) => r.result && r.result.final === true)) || c.now >= end + RACE_GIVE_UP_MS;
    }
    if (!v) return movedOn(b, w) ? { state: "final", rows: [], why: "standings kept from an earlier run", stale: true } : { state: "live", rows: [], why: "waiting for the race results" };
    return { state: final ? "final" : "live", rows: ptsRows(v.view.rows) };
  },

  async blockx(s, w, c) {
    const b = readJson(path.join(c.gamesDir || "", s.dir || "blockx"), "board.json");
    const v = boardView(b, w);
    if (!v) return movedOn(b, w) ? { state: "final", rows: [], why: "standings kept from an earlier run", stale: true } : { state: "live", rows: [], why: "waiting for the Block X results" };
    return { state: v.last && v.view.final === true ? "final" : "live", rows: ptsRows(v.view.rows) };
  },

  async bracket(s, w, c) {
    const b = readJson(path.join(c.gamesDir || "", s.dir || "bracket"), "board.json");
    if (!b || b.v !== 1) return { state: "live", rows: [], why: "waiting for the bracket results" };
    const v = [b.week, b.lastWeek, b.next].find((x: any) => x && x.week === w && Array.isArray(x.rows));
    if (!v) return movedOn(b, w) ? { state: "final", rows: [], why: "standings kept from an earlier run", stale: true } : { state: "live", rows: [], why: "waiting for the bracket results" };
    if (v.status === "none" || v.status === "void") return { state: "none", rows: [], why: "no bracket this week" };
    return { state: v.final === true ? "final" : "live", rows: ptsRows(v.rows).map((r) => ({ ...r, ranked: true })) };
  },

  async survivor(s, w, c) {
    const dir = path.join(c.gamesDir || "", s.dir || "survivor");
    const idx = readJson(dir, "index.json");
    if (!idx || idx.v !== 1 || !Array.isArray(idx.seasons)) return { state: "live", rows: [], why: "waiting for the Survivor results" };
    const d0 = Math.floor(M.weekStart(w) / DAY), d1 = d0 + 6;
    for (const n of idx.seasons.filter((x: any) => Number.isInteger(x) && x >= 1 && x < 10000)) {
      const sf = readJson(dir, `S${String(n).padStart(3, "0")}.json`);
      if (!sf || sf.v !== 1 || !Number.isInteger(sf.startDay)) continue;
      const last = sf.startDay + 13;
      if (sf.startDay > d1 || last < d0) continue;
      // The season day that ends this week (or the season's own last day).
      const target = Math.min(d1, last) - sf.startDay + 1;
      const r = sf.result;
      if (!r || !Array.isArray(r.players)) return { state: "live", rows: [], why: "waiting for the Survivor results" };
      const endN = Number.isInteger(r.endN) ? r.endN : 0;
      // A season that ended early ends its standings there.
      const done = r.over === true && endN <= target;
      // Already past this week's last day: the standings this recorder kept from that day stand (see run()).
      if (endN > target) return { state: "final", rows: [], why: `standings kept from before day ${endN}`, stale: true };
      const rows: Row[] = r.players.slice(0, MAX_ROWS).filter((p: any) => p && isAddr(p.a) && Number.isInteger(p.place) && p.place >= 1)
        .map((p: any) => ({ a: p.a, score: -p.place, scored: p.place === 1 && p.lives > 0, ranked: p.eligible === true }));
      return { state: endN === target || done ? "final" : "live", rows };
    }
    return { state: "none", rows: [], why: "no Survivor season this week" };
  },
};
export const READABLE = Object.keys(READERS);

// ── the question game: answers, outcomes and the week, on two nodes ──
async function readQuestions(node: any, knodeGame: string, w: number): Promise<QWeek> {
  const c = new Contract({ id: knodeGame, abi: GAME_ABI(), provider: node });
  const f: any = c.functions;
  const wk: any = (await withRetry(`week ${w}`, () => f.get_week({ week: String(w) })))?.result?.week ?? {};
  const players: any[] = [];
  let start = "";
  for (let i = 0; i < 400; i++) {
    const page: any[] = (await withRetry(`players of week ${w}`, () => f.list_players({ start, limit: 50, week: String(w) })))?.result?.rows ?? [];
    players.push(...page);
    if (page.length < 50) break;
    start = page[page.length - 1].address;
  }
  const ids = new Set<number>();
  for (const p of players) for (const a of p?.entry?.answers ?? []) ids.add(Number(a.question_id));
  const outcome = new Map<number, number>();
  for (const id of ids) outcome.set(id, Number((await withRetry(`question ${id}`, () => f.get_question({ id })))?.result?.question?.outcome ?? 0));
  const rows: QWeek["rows"] = [];
  for (const p of players) {
    if (!isAddr(p?.address) || !p.entry || p.entry.voided) continue;
    let pts = 0, answered = 0;
    for (const a of p.entry.answers ?? []) {
      answered++;
      const o = outcome.get(Number(a.question_id)) ?? 0;
      if (o !== 0 && o !== 1000 && o === Number(a.option) + 1) pts++;
    }
    if (answered) rows.push({ a: p.address, pts, answered });
  }
  rows.sort((x, y) => (x.a < y.a ? -1 : 1));
  return { closed: !!wk.closed, questions: Number(wk.questions ?? 0), resolved: Number(wk.resolved ?? 0), rows };
}
/** Golf's field rule for the question game: at least 1 VHP, or a Knode stake (as the other games' Staked boards). */
async function readRanked(node: any, vhpContract: string, knodeGame: string | null, who: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (!who.length) return out;
  const vhp = (await readVhp(node, vhpContract, who)).values;
  for (const a of who) {
    if (BigInt(vhp[a] || "0") >= ONE_VHP) { out.add(a); continue; }
    if (!knodeGame) continue;
    try {
      const c = new Contract({ id: knodeGame, abi: GAME_ABI(), provider: node });
      const r: any = await withRetry(`Knode player ${a}`, () => (c.functions as any).get_player({ player: a, week: "0" }));
      const p = r?.result?.player ?? {};
      if (BigInt(p.stake || "0") + BigInt(p.pending || "0") + BigInt(p.stake_other || "0") > 0n) out.add(a);
    } catch { /* not ranked */ }
  }
  return out;
}

// ── the run ──
export async function run(o: Opts) {
  const now = o.now ?? Date.now();
  const PREV = o.prev, OUT = o.out || "games-data/golf";
  const minField = o.minField ?? G.MIN_FIELD;
  const sources = (o.sources ?? sourcesFromGames()).filter((s) => READERS[s.reader]);
  const KNODE = o.knodeGame === undefined ? MAINNET_KNODE_GAME || null : o.knodeGame;
  const VHP = o.vhpContract || MAINNET_VHP;
  const nowW = M.weekOf(now);
  const problems: string[] = [];

  // 1. the course: the week each game joined (remembered), new games from next week
  const prevIdx = readJson(PREV, "index.json");
  const course: Record<string, number> = {};
  const hadIndex = !!(prevIdx && prevIdx.v === 1 && prevIdx.course && typeof prevIdx.course === "object");
  for (const s of sources) {
    const old = hadIndex ? prevIdx.course[s.id] : undefined;
    course[s.id] = Number.isInteger(old) && old >= 0 ? old : o.joinAll || !hadIndex ? nowW : nowW + 1;
  }
  const known = new Set<number>(hadIndex && Array.isArray(prevIdx.weeks) ? prevIdx.weeks.filter((w: any) => Number.isInteger(w) && w >= 0 && w < 10000) : []);
  const byId = new Map(sources.map((s) => [s.id, s]));

  // The question game, once per week per run, on two nodes that must agree.
  const qCache = new Map<number, Read>();
  const questions = async (w: number): Promise<Read> => {
    if (qCache.has(w)) return qCache.get(w)!;
    let r: Read;
    try {
      const read = o.questionsOf ?? ((n: any, wk: number) => readQuestions(n, KNODE!, wk));
      if (!o.questionsOf && (!KNODE || !o.p)) throw new Error("no question game contract or node");
      const a = await read(o.p, w);
      const b = o.check ? await read(o.check, w) : a;
      if (JSON.stringify(a) !== JSON.stringify(b)) r = { state: "live", rows: [], why: "the two nodes don't agree yet" };
      else {
        const who = a.rows.map((x) => x.a);
        const ranked = o.rankedOf ? await o.rankedOf(who) : await readRanked(o.p, VHP, KNODE, who);
        const final = now >= M.weekStart(w + 1) && a.closed && a.questions > 0 && a.resolved >= a.questions;
        r = { state: final ? "final" : "live", rows: a.rows.map((x) => ({ a: x.a, score: x.pts, scored: x.pts > 0, ranked: ranked.has(x.a) })) };
      }
    } catch (e) { problems.push(`question game, week ${w}: ${(e as Error).message}`); r = { state: "live", rows: [], why: "couldn't read the question game this run" }; }
    qCache.set(w, r);
    return r;
  };
  const ctx: Ctx = { now, raceDir: o.raceDir, gamesDir: o.gamesDir, o, questions };

  // 2–4. last week (until final) and this week
  const weeks = new Map<number, WeekFile>();
  for (const w of [nowW - 1, nowW]) {
    if (w < 0) continue;
    const old: WeekFile | null = (() => { const j = readJson(PREV, wName(w)); return j && j.v === 1 && j.week === w && Array.isArray(j.holes) ? j : null; })();
    if (old && old.final === true) { weeks.set(w, old); continue; }
    const start = M.weekStart(w), end = M.weekStart(w + 1);
    const ids: string[] = G.courseFor(w, course, [...byId.keys()]);
    const holes: HoleRec[] = [];
    for (const id of ids) {
      const s = byId.get(id)!;
      const was = old?.holes.find((h) => h && h.id === id) ?? null;
      let rd: Read;
      try { rd = await READERS[s.reader](s, w, ctx); }
      catch (e) { problems.push(`${id}, week ${w}: ${(e as Error).message}`); rd = { state: "live", rows: [], why: "couldn't read its results this run" }; }
      let rows = rd.rows, why = rd.why || "";
      // Keep the standings last read when the game's files have moved on (or can't be read this run).
      const kept = was && Array.isArray(was.rows) && was.rows.length ? was.rows.map(([a, score, scored, ranked]) => ({ a, score, scored: !!scored, ranked: !!ranked })) : null;
      if (!rows.length && kept) rows = kept;
      let status: HoleRec["status"] = rd.state === "final" && now >= end ? "final" : rd.state === "none" ? "skipped" : "live";
      if (rd.stale && !kept) { status = "skipped"; why = "its standings for this week were never read"; }
      if (status === "live" && now >= end + DEADLINE_MS) { status = "skipped"; why = "its results weren't final in time"; }
      const scored = status === "skipped" ? null : G.scoreHole(rows, minField);
      if (scored && scored.skipped && status === "final") { status = "skipped"; why = scored.why; }
      holes.push({
        id, name: s.name, status, why: status === "final" ? "" : why || (scored && scored.skipped ? scored.why : ""),
        field: scored ? scored.field : 0,
        rows: rows.slice(0, MAX_ROWS).map((r) => [r.a, r.score, r.scored ? 1 : 0, r.ranked ? 1 : 0]),
      });
    }
    const scoredHoles = holes.map((h) => {
      if (h.status === "skipped") return { id: h.id, skipped: true, results: {} };
      const s = G.scoreHole(h.rows.map(([a, score, sc, rk]) => ({ a, score, scored: !!sc, ranked: !!rk })), minField);
      return { id: h.id, skipped: s.skipped, results: s.results };
    });
    const rankedAny = new Set<string>();
    for (const h of holes) if (h.status !== "skipped") for (const r of h.rows) if (r[3]) rankedAny.add(r[0]);
    const cards: CardRec[] = G.cards(scoredHoles).map((c: any) => ({
      a: c.a, ranked: rankedAny.has(c.a), place: c.place, pts: c.pts, strokes: c.strokes, par: c.par, toPar: c.toPar,
      lost: c.lost, under: c.under, best: c.best, mulligan: c.mulligan,
      holes: c.holes.map((x: any) => [x.id, x.strokes, x.place, x.of]),
    }));
    const final = now >= end + FINAL_WAIT_MS && holes.every((h) => h.status !== "live");
    weeks.set(w, { v: 1, week: w, start, end, final, holes, cards });
  }

  // 5. write
  fs.mkdirSync(OUT, { recursive: true });
  for (const [w, wf] of weeks) {
    if (!wf.holes.length && !known.has(w)) continue;
    known.add(w);
    fs.writeFileSync(path.join(OUT, wName(w)), JSON.stringify(wf) + "\n");
  }
  const weekList = [...known].sort((a, b) => a - b);
  fs.writeFileSync(path.join(OUT, "index.json"), JSON.stringify({ v: 1, updated: new Date(now).toISOString(), weeks: weekList, course, minField }) + "\n");

  const view = (wf: WeekFile | undefined) => (wf ? wf.cards : []).map((c) => ({ a: c.a, place: c.place, pts: c.pts, toPar: c.toPar, strokes: c.strokes, holes: c.holes.filter((x) => x[2] !== null).length, lost: c.lost, ranked: c.ranked }));
  // All time: final weeks only, points summed; places by points, then more weeks played.
  const tot = new Map<string, { pts: number; toPar: number; strokes: number; holes: number; lost: number; ranked: boolean }>();
  for (const w of weekList) {
    const wf = weeks.get(w) ?? readJson(PREV, wName(w));
    if (!wf || wf.v !== 1 || wf.final !== true || !Array.isArray(wf.cards)) continue;
    for (const c of wf.cards) {
      if (!isAddr(c.a)) continue;
      const t = tot.get(c.a) ?? { pts: 0, toPar: 0, strokes: 0, holes: 0, lost: 0, ranked: false };
      t.pts += c.pts; t.toPar += c.toPar; t.strokes += c.strokes; t.lost += c.lost; t.holes += c.holes.filter((x: any) => x[2] !== null).length; t.ranked = t.ranked || !!c.ranked;
      tot.set(c.a, t);
    }
  }
  const allRows = [...tot].map(([a, t]) => ({ a, ...t })).sort((x, y) => y.pts - x.pts || y.holes - x.holes || (x.a < y.a ? -1 : 1));
  allRows.forEach((r: any, i) => { r.place = i > 0 && allRows[i - 1].pts === r.pts && allRows[i - 1].holes === r.holes ? (allRows[i - 1] as any).place : i + 1; });
  const cur = weeks.get(nowW), last = weeks.get(nowW - 1);
  const board = {
    v: 1, updated: new Date(now).toISOString(),
    today: { day: M.dayOf(now), rows: view(cur) },
    week: { week: nowW, start: M.weekStart(nowW), rows: view(cur) },
    lastWeek: last ? { week: last.week, start: last.start, final: last.final, rows: view(last) } : null,
    allTime: { rows: allRows.map((r: any) => ({ a: r.a, place: r.place, pts: r.pts, toPar: r.toPar, strokes: r.strokes, holes: r.holes, lost: r.lost, ranked: r.ranked })) },
  };
  fs.writeFileSync(path.join(OUT, "board.json"), JSON.stringify(board) + "\n");

  for (const [w, wf] of weeks) console.log(`week ${w}: ${wf.final ? "final" : "in play"}; holes ${wf.holes.map((h) => `${h.id}=${h.status}${h.why ? ` (${h.why})` : ""}`).join(", ") || "none"}; ${wf.cards.length} scorecards`);
  if (problems.length) { console.log("Problems:"); for (const p of problems) console.log("  " + p); }
  return { weeks, board, course, problems };
}

/** Testnet: holes are the testnet Block X games in testnet/golf.json (the testnet has no question game or race). */
export function testnetSources(file: URL | string = new URL("../../testnet/golf.json", import.meta.url)): { sources: Source[]; minField: number } {
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  if (j.v !== 1 || j.network !== "koinos-foundation-testnet" || !Array.isArray(j.holes)) throw new Error("testnet/golf.json: not a testnet course");
  const sources = j.holes.filter((h: any) => h && /^[a-z0-9-]{1,24}$/.test(h.id) && READERS[h.reader] && /^[a-z0-9-]{1,24}$/.test(h.dir))
    .map((h: any) => ({ id: h.id, name: String(h.name || h.id).slice(0, 40), reader: h.reader, dir: h.dir }));
  return { sources, minField: Number.isInteger(j.minField) && j.minField >= 1 ? j.minField : G.MIN_FIELD };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const testnet = process.argv.includes("--testnet");
  const opts: Opts = { prev: E.GOLF_PREV, out: E.GOLF_OUT };
  if (testnet) {
    const t = testnetSources();
    Object.assign(opts, { sources: t.sources, minField: t.minField, gamesDir: E.TESTNET_DATA, joinAll: true, knodeGame: null });
  } else {
    const RPC = E.RPC || "https://koinos.armana.io";
    const RPC_CHECK = E.RPC_CHECK && E.RPC_CHECK !== "off" && E.RPC_CHECK !== RPC ? E.RPC_CHECK : "";
    Object.assign(opts, { p: new Provider([RPC]), check: RPC_CHECK ? new Provider([RPC_CHECK]) : null, raceDir: E.RACE_DATA, gamesDir: E.GAMES_DATA });
  }
  run(opts).catch((e) => { console.error(e); process.exit(1); });
}

/**
 * Block Golf recorder (run every hour by .github/workflows/golf.yml; read-only, holds no key, writes nothing on chain).
 *
 * Block Golf has no picks of its own: each live game is a hole, and a player's place on that game's weekly leaderboard
 * sets their strokes (site/golf-math.js, the same file the page runs). Each run:
 *  1. The course. Every game marked live in site/games.json that has a reader below joins the course from the first
 *     full week after it went live (index.json "course" remembers the week each joined, and never forgets it). On the
 *     very first run the games already live join at once. A week's holes are fixed the first time the week is
 *     recorded (its W file), so a game that leaves games.json mid-week stays a hole of that week.
 *  2. Each hole's standings for this week and last week, from that game's own published results (never recomputed):
 *       questions  the question game contract, read on two nodes that must agree: each answer to a resolved question
 *                  scores 1 if right (as the site does); final when the week is closed and every question resolved.
 *                  Who is ranked (1 VHP or a Knode stake) is read on both nodes too, and must agree.
 *       race       race-data/board.json (this week / last week); final when every race of the week is final. At the
 *                  60-hour deadline the race board's standings (which count final races only) are used as final.
 *       blockx     games-data/blockx/board.json; final when its last week says final
 *     Survivor, Bracket and the other games add their reader here when they launch (with a test).
 *     The field of a hole is the ranked wallets that scored on it (practice weeks: every wallet that scored); see
 *     golf-math.js.
 *  3. Each hole's standings are kept in the week file as they were last read, so a game's board rolling on to a new
 *     week never loses them. A hole that was final once the week ended stays final: a later bad read never undoes it.
 *  4. A week is final 12 hours after it ends once every hole is final and the run read everything without a problem;
 *     a hole still not final 60 hours after the week ends is skipped for everyone (never guessed), so the week's
 *     points reach the vault within its 3-day window. A final week is never recomputed.
 *  5. Writes index.json, W<week>.json and board.json (Today and This week: this week so far; Last week; All time:
 *     final weeks only). The publish job checks their shape and pushes them to the data branch.
 * Safety: a previous run's files that exist but can't be read stop the run (never treated as a fresh start).
 *
 *   npm run golf     (RPC, RPC_CHECK, GOLF_PREV, GOLF_OUT, RACE_DATA, GAMES_DATA, GOLF_STAKED_FROM_WEEK)
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
const HOUR = 3600000;
const FINAL_WAIT_MS = 12 * HOUR;              // a week is final 12 hours after it ends (the correction window)
const DEADLINE_MS = 60 * HOUR;                // a hole not final 60 hours after its week ends is skipped
const ONE_VHP = 100000000n;
const MAX_ROWS = 100000;
const MAX_PAGES = 2000;                       // question game: up to 100,000 players a week, else the read fails
const isAddr = (a: unknown): a is string => typeof a === "string" && G.isAddr(a);

export type Row = { a: string; score: number; scored: boolean; ranked: boolean };
/** stale: the game's files have moved past this week, so only standings kept from an earlier run can be used.
 *  atDeadline: what to do if the hole is still not final at the deadline ("skip", or "use" these standings). */
export type Read = { state: "final" | "live" | "none"; rows: Row[]; why?: string; stale?: boolean; atDeadline?: "skip" | "use" };
export type Source = { id: string; name: string; reader: string; live: boolean };
type HoleRec = { id: string; name: string; status: "final" | "live" | "skipped"; why: string; field: number; rows: [string, number, 0 | 1, 0 | 1][] };
type CardRec = { a: string; ranked: boolean; place: number; pts: number; strokes: number; par: number; toPar: number; lost: number; under: number; best: number; mulligan: string; holes: [string, number, number | null, number | null][] };
type WeekFile = { v: 1; week: number; start: number; end: number; final: boolean; practice: boolean; holes: HoleRec[]; cards: CardRec[] };
export type QWeek = { closed: boolean; questions: number; resolved: number; rows: { a: string; pts: number; answered: number }[] };

export type Opts = {
  now?: number;
  p?: any; check?: any | null;
  prev?: string; out?: string;
  raceDir?: string; gamesDir?: string;                 // race-data and games-data files
  sources?: Source[];                                  // the games that can be holes (default: site/games.json)
  minField?: number;                                   // overrides the rules' minimum (tests)
  stakedFromWeek?: number | null;                      // the first staked week (null: every week is practice)
  knodeGame?: string | null; vhpContract?: string;
  questionsOf?: (node: any, week: number) => Promise<QWeek>;           // for the tests
  rankedOf?: (node: any, who: string[]) => Promise<Set<string>>;      // for the tests
};

// ── files ──
const MAX_FILE = 20 * 1024 * 1024;
function readJson(dir: string | undefined, name: string): any {
  if (!dir) return null;
  const f = path.join(dir, name);
  try { if (fs.lstatSync(f).isSymbolicLink() || fs.statSync(f).size > MAX_FILE) return null; return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; }
}
const exists = (dir: string | undefined, name: string) => { if (!dir) return false; try { fs.lstatSync(path.join(dir, name)); return true; } catch { return false; } };
const wName = (w: number) => `W${String(w).padStart(3, "0")}.json`;
const MAINNET_KNODE_GAME = (() => { try { return JSON.parse(fs.readFileSync(new URL("../../game-data/deployment.json", import.meta.url), "utf8")).contract as string; } catch { return ""; } })();
const GAME_ABI = () => JSON.parse(fs.readFileSync(new URL("../../game/abi/kpred.koilib.json", import.meta.url), "utf8"));

/** Every game in site/games.json that has a reader, and whether it is live. */
export function sourcesFromGames(file: URL | string = new URL("../../site/games.json", import.meta.url)): Source[] {
  let list: any[] = [];
  try { list = JSON.parse(fs.readFileSync(file, "utf8")).games; } catch { return []; }
  return (Array.isArray(list) ? list : []).filter((g) => g && typeof g.id === "string" && g.id !== "golf" && READERS[g.id])
    .map((g) => ({ id: g.id, name: typeof g.name === "string" ? g.name.slice(0, 40) : g.id, reader: g.id, live: g.status === "live" }));
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
const KEPT: Read = { state: "final", rows: [], why: "standings kept from an earlier run", stale: true };

type Ctx = { now: number; raceDir?: string; gamesDir?: string; o: Opts; questions: (w: number) => Promise<Read> };
const READERS: Record<string, (src: Source, w: number, c: Ctx) => Promise<Read>> = {
  async questions(_s, w, c) { return c.questions(w); },

  async race(_s, w, c) {
    const b = readJson(c.raceDir, "board.json");
    const v = boardView(b, w);
    if (!v) return movedOn(b, w) ? { ...KEPT } : { state: "live", rows: [], why: "waiting for the race results" };
    const end = M.weekStart(w + 1);
    let final = false;
    if (c.now >= end) {
      const wf = readJson(c.raceDir, wName(w));
      const races = wf && Array.isArray(wf.races) ? wf.races.filter((r: any) => r && r.start >= M.weekStart(w) && r.start < end) : [];
      final = races.length > 0 && races.every((r: any) => r.result && r.result.final === true);
    }
    // The race board counts final races only, so at the deadline its standings stand (a race that never became
    // final is left out, as on the race's own board).
    return { state: final ? "final" : "live", rows: ptsRows(v.view.rows), atDeadline: "use" };
  },

  async blockx(_s, w, c) {
    const b = readJson(path.join(c.gamesDir || "", "blockx"), "board.json");
    const v = boardView(b, w);
    if (!v) return movedOn(b, w) ? { ...KEPT } : { state: "live", rows: [], why: "waiting for the Block X results" };
    return { state: v.last && v.view.final === true ? "final" : "live", rows: ptsRows(v.view.rows) };
  },
};
export const READABLE = Object.keys(READERS);

// ── the question game: answers, outcomes and the week ──
async function readQuestions(node: any, knodeGame: string, w: number): Promise<QWeek> {
  const c = new Contract({ id: knodeGame, abi: GAME_ABI(), provider: node });
  const f: any = c.functions;
  const wk: any = (await withRetry(`week ${w}`, () => f.get_week({ week: String(w) })))?.result?.week ?? {};
  const players: any[] = [];
  let start = "", done = false;
  for (let i = 0; i < MAX_PAGES; i++) {
    const page: any[] = (await withRetry(`players of week ${w}`, () => f.list_players({ start, limit: 50, week: String(w) })))?.result?.rows ?? [];
    players.push(...page);
    if (page.length < 50) { done = true; break; }
    start = page[page.length - 1].address;
  }
  if (!done) throw new Error(`more than ${MAX_PAGES * 50} players in week ${w}: not read`);
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
/** Golf's field rule for the question game: at least 1 VHP, or a Knode stake (as the other games' Staked boards).
 *  A failed read throws (the hole waits for the next run); it never quietly counts a wallet as unranked. */
async function readRanked(node: any, vhpContract: string, knodeGame: string | null, who: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (!who.length) return out;
  const vhp = (await readVhp(node, vhpContract, who)).values;
  const c = knodeGame ? new Contract({ id: knodeGame, abi: GAME_ABI(), provider: node }) : null;
  for (const a of who) {
    if (BigInt(vhp[a] || "0") >= ONE_VHP) { out.add(a); continue; }
    if (!c) continue;
    const r: any = await withRetry(`Knode player ${a}`, () => (c.functions as any).get_player({ player: a, week: "0" }));
    if (!r || typeof r !== "object") throw new Error(`no answer reading the Knode player ${a}`);
    const p = r.result?.player ?? {};
    if (BigInt(p.stake || "0") + BigInt(p.pending || "0") + BigInt(p.stake_other || "0") > 0n) out.add(a);
  }
  return out;
}

// ── the run ──
export async function run(o: Opts) {
  const now = o.now ?? Date.now();
  const PREV = o.prev, OUT = o.out || "games-data/golf";
  const STAKED_FROM = Number.isInteger(o.stakedFromWeek) && (o.stakedFromWeek as number) >= 0 ? (o.stakedFromWeek as number) : null;
  const ruleOf = (w: number) => { const r = G.rule(w, STAKED_FROM); return { ...r, minField: o.minField ?? r.minField }; };
  const sources = (o.sources ?? sourcesFromGames()).filter((s) => READERS[s.reader]);
  const KNODE = o.knodeGame === undefined ? MAINNET_KNODE_GAME || null : o.knodeGame;
  const VHP = o.vhpContract || MAINNET_VHP;
  const nowW = M.weekOf(now);
  const problems: string[] = [];
  const troubled = new Set<number>();            // weeks with a read problem this run: never made final in this run

  // 0. the last run's files: if any exist, its index must be readable (a broken read is never a fresh start)
  const prevIdx = readJson(PREV, "index.json");
  const hadIndex = !!(prevIdx && prevIdx.v === 1 && prevIdx.course && typeof prevIdx.course === "object" && Array.isArray(prevIdx.weeks));
  if (!hadIndex && (exists(PREV, "index.json") || exists(PREV, "board.json"))) throw new Error("the last run's files are there but its index.json can't be read: stopping rather than starting over");

  // 1. the course: the week each game joined (remembered for good), new games from next week
  const course: Record<string, number> = {};
  if (hadIndex) for (const [id, w] of Object.entries(prevIdx.course)) if (/^[a-z0-9-]{1,24}$/.test(id) && Number.isInteger(w) && (w as number) >= 0) course[id] = w as number;
  for (const s of sources) if (s.live && course[s.id] === undefined) course[s.id] = hadIndex ? nowW + 1 : nowW;
  const known = new Set<number>(hadIndex ? prevIdx.weeks.filter((w: any) => Number.isInteger(w) && w >= 0 && w < 10000) : []);
  const byId = new Map(sources.map((s) => [s.id, s]));
  const liveIds = sources.filter((s) => s.live).map((s) => s.id);

  // The question game, once per week per run, on two nodes that must agree (answers and who is ranked).
  const qCache = new Map<number, Read>();
  const questions = async (w: number): Promise<Read> => {
    if (qCache.has(w)) return qCache.get(w)!;
    let r: Read;
    try {
      const read = o.questionsOf ?? ((n: any, wk: number) => readQuestions(n, KNODE!, wk));
      const rankedRead = o.rankedOf ?? ((n: any, who: string[]) => readRanked(n, VHP, KNODE, who));
      if (!o.questionsOf && (!KNODE || !o.p)) throw new Error("no question game contract or node");
      const a = await read(o.p, w);
      const b = o.check ? await read(o.check, w) : a;
      if (JSON.stringify(a) !== JSON.stringify(b)) { r = { state: "live", rows: [], why: "the two nodes don't agree yet" }; troubled.add(w); }
      else {
        const who = a.rows.map((x) => x.a);
        const ra = await rankedRead(o.p, who), rb = o.check ? await rankedRead(o.check, who) : ra;
        if ([...ra].sort().join() !== [...rb].sort().join()) { r = { state: "live", rows: [], why: "the two nodes don't agree on who is ranked yet" }; troubled.add(w); }
        else {
          const final = now >= M.weekStart(w + 1) && a.closed && a.questions > 0 && a.resolved >= a.questions;
          r = { state: final ? "final" : "live", rows: a.rows.map((x) => ({ a: x.a, score: x.pts, scored: x.pts > 0, ranked: ra.has(x.a) })) };
        }
      }
    } catch (e) { problems.push(`question game, week ${w}: ${(e as Error).message}`); troubled.add(w); r = { state: "live", rows: [], why: "couldn't read the question game this run" }; }
    qCache.set(w, r);
    return r;
  };
  const ctx: Ctx = { now, raceDir: o.raceDir, gamesDir: o.gamesDir, o, questions };

  // 2–4. last week (until final) and this week
  const weeks = new Map<number, WeekFile>();
  for (const w of [nowW - 1, nowW]) {
    if (w < 0) continue;
    const old: WeekFile | null = (() => { const j = readJson(PREV, wName(w)); return j && j.v === 1 && j.week === w && Array.isArray(j.holes) && Array.isArray(j.cards) ? j : null; })();
    if (!old && known.has(w)) throw new Error(`week ${w} was recorded before but its file can't be read: stopping`);
    if (old && old.final === true) { weeks.set(w, old); continue; }
    const start = M.weekStart(w), end = M.weekStart(w + 1);
    const R = ruleOf(w);
    // The week's holes are fixed once it has been recorded; until then, the live games that joined by this week.
    const ids: string[] = old && old.holes.length ? old.holes.map((h) => h.id) : G.courseFor(w, course, liveIds);
    const holes: HoleRec[] = [];
    for (const id of ids) {
      const s = byId.get(id);
      const was = old?.holes.find((h) => h && h.id === id) ?? null;
      const kept = was && Array.isArray(was.rows) && was.rows.length ? was.rows.map(([a, score, scored, ranked]) => ({ a, score, scored: !!scored, ranked: !!ranked })) : null;
      // Once the week has ended, a hole that was final (or had no game that week) stays as it was.
      if (was && now >= end && (was.status === "final" || (was.status === "skipped" && was.why.startsWith("no ")))) { holes.push(was); continue; }
      let rd: Read;
      if (!s) rd = { state: "live", rows: [], why: "its game has no reader on this recorder" };
      else {
        try { rd = await READERS[s.reader](s, w, ctx); }
        catch (e) { problems.push(`${id}, week ${w}: ${(e as Error).message}`); troubled.add(w); rd = { state: "live", rows: [], why: "couldn't read its results this run" }; }
      }
      let rows = rd.rows, why = rd.why || "";
      // Keep the standings last read when the game's files have moved on (or can't be read this run).
      if (!rows.length && kept) rows = kept;
      let status: HoleRec["status"] = rd.state === "final" && now >= end ? "final" : rd.state === "none" ? "skipped" : "live";
      if (rd.stale && !kept) { status = "skipped"; why = "its standings for this week were never read"; }
      if (status === "live" && now >= end + DEADLINE_MS) {
        if (rd.atDeadline === "use" && rows.length) { status = "final"; why = ""; }
        else { status = "skipped"; why = "its results weren't final in time"; }
      }
      const scored = status === "skipped" ? null : G.scoreHole(rows, R.minField, R.everyone);
      if (scored && scored.skipped && status === "final") { status = "skipped"; why = scored.why; }
      holes.push({
        id, name: s ? s.name : (was ? was.name : id), status, why: status === "final" ? "" : why || (scored && scored.skipped ? scored.why : ""),
        field: scored ? scored.field : 0,
        rows: rows.slice(0, MAX_ROWS).map((r) => [r.a, r.score, r.scored ? 1 : 0, r.ranked ? 1 : 0]),
      });
    }
    const scoredHoles = holes.map((h) => {
      if (h.status === "skipped") return { id: h.id, skipped: true, results: {} };
      const s = G.scoreHole(h.rows.map(([a, score, sc, rk]) => ({ a, score, scored: !!sc, ranked: !!rk })), R.minField, R.everyone);
      return { id: h.id, skipped: s.skipped, results: s.results };
    });
    const rankedAny = new Set<string>();
    for (const h of holes) if (h.status !== "skipped") for (const r of h.rows) if (r[3]) rankedAny.add(r[0]);
    const cards: CardRec[] = G.cards(scoredHoles).map((c: any) => ({
      a: c.a, ranked: rankedAny.has(c.a), place: c.place, pts: c.pts, strokes: c.strokes, par: c.par, toPar: c.toPar,
      lost: c.lost, under: c.under, best: c.best, mulligan: c.mulligan,
      holes: c.holes.map((x: any) => [x.id, x.strokes, x.place, x.of]),
    }));
    const final = now >= end + FINAL_WAIT_MS && !troubled.has(w) && holes.every((h) => h.status !== "live");
    weeks.set(w, { v: 1, week: w, start, end, final, practice: R.practice, holes, cards });
  }

  // 5. write
  fs.mkdirSync(OUT, { recursive: true });
  for (const [w, wf] of weeks) {
    if (!wf.holes.length && !known.has(w)) continue;
    known.add(w);
    fs.writeFileSync(path.join(OUT, wName(w)), JSON.stringify(wf) + "\n");
  }
  const weekList = [...known].sort((a, b) => a - b);
  fs.writeFileSync(path.join(OUT, "index.json"), JSON.stringify({ v: 1, updated: new Date(now).toISOString(), weeks: weekList, course, stakedFromWeek: STAKED_FROM }) + "\n");

  const view = (wf: WeekFile | undefined) => (wf ? wf.cards : []).map((c) => ({ a: c.a, place: c.place, pts: c.pts, topar: c.toPar, strokes: c.strokes, holes: c.holes.filter((x) => x[2] !== null).length, lost: c.lost, ranked: c.ranked }));
  // All time: final weeks only, points summed; places by points, then more holes played.
  const tot = new Map<string, { pts: number; toPar: number; strokes: number; holes: number; lost: number; ranked: boolean }>();
  for (const w of weekList) {
    const wf = weeks.get(w) ?? readJson(PREV, wName(w));
    if (!wf) throw new Error(`week ${w} is in the index but its file can't be read: stopping`);
    if (wf.v !== 1 || wf.final !== true || !Array.isArray(wf.cards)) continue;
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
    allTime: { rows: allRows.map((r: any) => ({ a: r.a, place: r.place, pts: r.pts, topar: r.toPar, strokes: r.strokes, holes: r.holes, lost: r.lost, ranked: r.ranked })) },
  };
  fs.writeFileSync(path.join(OUT, "board.json"), JSON.stringify(board) + "\n");

  for (const [w, wf] of weeks) console.log(`week ${w}: ${wf.final ? "final" : "in play"}${wf.practice ? " (practice)" : ""}; holes ${wf.holes.map((h) => `${h.id}=${h.status}${h.why ? ` (${h.why})` : ""}`).join(", ") || "none"}; ${wf.cards.length} scorecards`);
  if (problems.length) { console.log("Problems:"); for (const p of problems) console.log("  " + p); }
  return { weeks, board, course, problems };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const sf = E.GOLF_STAKED_FROM_WEEK && /^\d{1,4}$/.test(E.GOLF_STAKED_FROM_WEEK) ? Number(E.GOLF_STAKED_FROM_WEEK) : null;
  const RPC = E.RPC || "https://koinos.armana.io";
  const RPC_CHECK = E.RPC_CHECK && E.RPC_CHECK !== "off" && E.RPC_CHECK !== RPC ? E.RPC_CHECK : "";
  run({
    prev: E.GOLF_PREV, out: E.GOLF_OUT, stakedFromWeek: sf, raceDir: E.RACE_DATA, gamesDir: E.GAMES_DATA,
    p: new Provider([RPC]), check: RPC_CHECK ? new Provider([RPC_CHECK]) : null,
  }).catch((e) => { console.error(e); process.exit(1); });
}

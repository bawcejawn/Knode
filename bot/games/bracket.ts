/**
 * Producer Bracket recorder (run every hour by .github/workflows/games.yml; read-only on the chain, holds no key).
 * The rules live in site/bracket-math.js, the same file the page runs.
 *
 * Each run, for last week (until final), this week and next week:
 *  1. Seeding. From Saturday 12:00 UTC before a week, once that block is irreversible: every producer's exact VHP
 *     averaged over the 28,800 blocks before it (bracket-math.averageCard), on both nodes; they must agree.
 *     bracket-math.seeding turns it into the bracket (8, 16 with byes, or 32 producers; under 8: no bracket that week).
 *     Recorded once and never changed, with a sha256 of what it says. Not seeded 24 hours later: the week is void.
 *  2. Picks. Once the block at the lock (Sunday 23:55 UTC) is irreversible: every pick for the week's round from the
 *     Picks contract (game 9), on both nodes; they must agree. The chain refused picks after the lock.
 *  3. Hours. Every UTC hour of each round's day, once irreversible: its first and last height, how many blocks it had,
 *     how many each seed signed (by), its credited blocks (cr), its baseline (w: effective VHP at the day's start) and
 *     Σ 1 ÷ active VHP over the hour's blocks (q) — the KnodeGames VHP standard (site/vhp-standard.js). The VHP is rebuilt
 *     from the chain itself: each producer's balance is read once at the head (pinned to one block), and every VHP event
 *     in the blocks between (the per-block burn, transfers, mints from burning KOIN; not reverted transactions) is
 *     walked back. Done on both nodes; the hours must come out identical. At most 6 hours a run (audit A-2).
 *  4. Results and points: each round's day index (bracket-math.indexFromHours), the winners, every pick's points.
 *     The week is final 12 hours after the last round's day (the correction window); then nothing changes.
 *  5. Stakes. Once the week has started (its stakes are fixed: deposits count from the next week, and a wallet staked at
 *     the start stays staked all week), every player's stake in game 9 for that week is read from the Vault
 *     (get_game_player) on both nodes: at least 1 VHP = a staked player (owner's player rule, 2026-10-28).
 *  6. The Vault file (vault/W<week>.json, the Vault chat's hand-off of 2026-10-28): when the week is final and within
 *     3 days of its end: { game: 9, week, final: true, rows: staked players with ≥ 1 point, scores mapped onto 1–255
 *     keeping the bracket's order and ties, first / second: the Free play board's winners (owner 2026-10-28: the Bracket
 *     is a staked game AND pays the free prize, 2 VHP / 1 VHP, shared by ties; see freeWinners) }. Without the stakes
 *     the week waits; 3 days after its end it closes without a file (the Vault rolls the week over).
 *  7. Leaderboards (board.json): Next week (its seeding), This week, Last week and All time (final weeks only), each
 *     row marked ranked = staked, for the shared board's Staked and Free play tabs.
 *  8. Writes games-data/bracket/index.json, W<week>.json, board.json and vault/W<week>.json for the publish job.
 *
 * Every time decision uses the irreversible block's time, read on both nodes (audit F-4). The run refuses to write when
 * the last run's files are incomplete (audit F-3): a failed read must never wipe the history.
 *
 * Two nodes are required to seed and to record hours (audit A-3): with RPC_CHECK off, those steps wait.
 *
 *   RPC, RPC_CHECK, BRACKET_PREV (last run's files), BRACKET_OUT.
 *   npm run bracket         (or: npx tsx bot/games/bracket.ts)
 */
import { Provider, Contract } from "koilib";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { withRetry } from "../../common.ts";
import { chainNode, heightAt, bookFor } from "../vhp-chain.ts";
await import("../../race-math.js");
await import("../../bracket-math.js");
const M: any = (globalThis as any).KRaceMath;
const B: any = (globalThis as any).KBracketMath;

const E = process.env;
const RPC = E.RPC || "https://api.koinos.io";
const RPC_CHECK = E.RPC_CHECK && E.RPC_CHECK !== "off" && E.RPC_CHECK !== RPC ? E.RPC_CHECK : "";
const HOUR = 3600000, DAY = 24 * HOUR;
const SEED_GRACE = 24 * HOUR;              // not seeded this long after Saturday 12:00 → the week is void
const CORRECTION = 12 * HOUR;              // final 12 hours after the last round's day
const MAX_HOURS_PER_RUN = 6;               // a long outage catches up over a few runs (audit A-2)
const VAULT_DAYS = 3 * DAY;                 // the Vault takes a week's file until 3 days after the week ends
const MAX_BOARD_ROWS = 1000;               // per leaderboard view (the page shows 50; your own score is in W<week>.json)
const isAddr = (a: unknown): a is string => typeof a === "string" && /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a);

export type RawPick = { player: string; number: number; time: number };
type Hour = { from: number; to: number; n: number; by: Record<string, number>; cr: Record<string, number>; w: Record<string, number>; q: number; checked: number };
type Seeding = { at: number; cardAt: number; size: number; seeds: string[]; vhp: number[]; totalVhp: number; out: string[]; hash: string };
/** A recorded pick: [player, number, pick time (ms), valid bracket 1/0]. */
type Pick = [string, number, number, number];
/** Points: [player, points, correct champion 1/0, correct winners]. */
type Points = [string, number, number, number];
export type WeekFile = {
  v: 4; week: number; start: number; end: number;
  status: "waiting" | "none" | "void" | "open" | "locked" | "final";
  seeding: Seeding | null; picks: { checked: number; rows: Pick[] } | null;
  days: (Hour | null)[][];                 // [round][hour 0–23]
  results: { rounds: number[][]; done: boolean } | null;
  points: Points[]; void?: string;
  staked: { checked: number; list: string[]; held?: string[] } | null;   // players with ≥ 1 VHP staked in game 9 that week
                                                         // (sorted); held (read when the week closes): players the Vault
                                                         // won't pay a free prize (≥ 1 VHP in game 9 at any time that week)
  vault?: "missed";                                      // closed 3 days after its end without the stakes
};
import type { Chain, Node } from "../vhp-chain.ts";
export type { Chain, Node };
type Head = { height: number; time: number; lib: number; libTime: number };
type Opts = {
  p: any; check: any | null; prev?: string; out?: string; raceDir?: string;
  picksContract?: string | null;
  picksOf?: (node: any, round: number) => Promise<RawPick[]>;   // for the tests
  gameOf?: (node: any) => Promise<any>;                          // the Picks game's settings (for the tests)
  stakedOf?: (node: any, players: string[], week: number) => Promise<string[] | Stakes>;   // the Vault's stakes (tests;
                                                         // a plain list = staked, and held = the same)
  nodeOf?: (node: any) => Node;                                  // for the tests and the replay
  head?: Head;
};

// ── files ──
function readJson(dir: string | undefined, name: string): any {
  if (!dir) return null;
  const f = path.join(dir, name);
  try { if (fs.lstatSync(f).isSymbolicLink()) return null; return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; }
}
const wName = (w: number) => `W${String(w).padStart(3, "0")}.json`;
const FILE_V = 4;   // v4 (2026-10-28): the KnodeGames VHP standard — hours carry by, cr, w (baselines), q; older files are not read
const emptyDays = (size: number) => Array.from({ length: size ? B.roundsOf(size) : 0 }, () => new Array<Hour | null>(24).fill(null));
function freshWeek(w: number): WeekFile {
  return { v: FILE_V as 4, week: w, start: B.weekStart(w), end: B.weekStart(w + 1), status: "waiting", seeding: null, picks: null, days: [], results: null, points: [], staked: null };
}
const hourOk = (h: any) => h && Number.isInteger(h.from) && Number.isInteger(h.to) && h.to >= h.from - 1 && Number.isInteger(h.n) && h.n >= 0
  && h.by && typeof h.by === "object" && h.cr && typeof h.cr === "object" && h.w && typeof h.w === "object"
  && [...Object.values(h.cr), ...Object.values(h.w)].every((x: any) => Number.isFinite(x) && x >= 0)
  && Number.isFinite(h.q) && h.q >= 0 && h.checked === 2;
function loadWeek(dir: string | undefined, w: number): WeekFile {
  const f = freshWeek(w), old = readJson(dir, wName(w));
  if (!old || old.v !== FILE_V || old.week !== w) return f;
  const s = old.seeding;
  if (s && Number.isInteger(s.size) && [0, 8, 16, 32].includes(s.size) && Array.isArray(s.seeds) && s.seeds.every(isAddr) && s.seeds.length <= s.size
      && typeof s.hash === "string" && s.hash === seedHash(w, s)) f.seeding = s;
  if (old.status === "void") { f.status = "void"; f.void = typeof old.void === "string" ? old.void.slice(0, 200) : "void"; }
  else if (old.status === "none" && f.seeding && f.seeding.size === 0) { f.status = "none"; f.void = typeof old.void === "string" ? old.void.slice(0, 200) : "no bracket this week"; }
  if (f.seeding && old.picks && Array.isArray(old.picks.rows)) f.picks = { checked: old.picks.checked === 2 ? 2 : 1, rows: old.picks.rows.filter((x: any) => Array.isArray(x) && isAddr(x[0]) && Number.isSafeInteger(x[1]) && x[1] >= 0).map((x: any) => [x[0], x[1], Number(x[2]) || 0, x[3] ? 1 : 0] as Pick) };
  if (f.picks && old.staked && Array.isArray(old.staked.list) && old.staked.list.every(isAddr) && old.staked.checked === 2) {
    f.staked = { checked: 2, list: [...old.staked.list].sort() };
    if (Array.isArray(old.staked.held) && old.staked.held.every(isAddr)) f.staked.held = [...old.staked.held].sort();
  }
  if (old.vault === "missed") f.vault = "missed";
  f.days = emptyDays(f.seeding ? f.seeding.size : 0);
  if (Array.isArray(old.days)) old.days.forEach((d: any, r: number) => { if (r < f.days.length && Array.isArray(d)) d.forEach((h: any, i: number) => { if (i < 24 && hourOk(h)) f.days[r][i] = h; }); });
  // A final week stays final; its results and points are worked out again from what it recorded (same answer).
  // (fix-check F-10: so a scoring rule change re-scores past final weeks. Any rule change after launch must apply only
  //  from a stated week on, e.g. `if (w >= RULE_FROM_WEEK)`. The forfeit rule is in from the start: no week exists yet.)
  if (old.status === "final" && f.status === "waiting" && f.seeding && f.picks) { const sc = scoreWeek(f); if (sc.results && sc.results.done) { f.status = "final"; f.results = sc.results; f.points = sc.points; } }
  return f;
}
function seedHash(w: number, s: Omit<Seeding, "hash">) {
  return crypto.createHash("sha256").update(JSON.stringify({ week: w, at: s.at, cardAt: s.cardAt, size: s.size, seeds: s.seeds, vhp: s.vhp, totalVhp: s.totalVhp, out: s.out })).digest("hex");
}
function defaultPicksContract(): string | null {
  try { const d = JSON.parse(fs.readFileSync(new URL("../../picks-data/deployment.json", import.meta.url), "utf8")); return isAddr(d.contract) ? d.contract : null; } catch { return null; }
}

/** Hour records for the given hour starts (all irreversible), on one node, from exact VHP. */
export async function readHours(n: Node, head: Head, starts: number[], seeds: string[], base: Record<number, Record<string, number>> = {}) {
  const first = Math.min(...starts), last = Math.max(...starts);
  const fromH = Math.max(1, (await heightAt(n, head, first)) - B.ACTIVE_BLOCKS), toH = (await heightAt(n, head, last + HOUR)) - 1;
  const { c, book, effCheck } = await bookFor(n, fromH, toH, seeds); console.log(`effective VHP cross-check (hours): ${JSON.stringify(effCheck)}`);
  return B.exactHours(c, starts, seeds, book, base) as Omit<Hour, "checked">[];
}
/** The seeding card at time `at` (irreversible), on one node: exact VHP averaged over the SEED_BLOCKS blocks before. */
export async function readSeedCard(n: Node, head: Head, at: number) {
  const seedH = await heightAt(n, head, at), fromH = Math.max(1, seedH - B.SEED_BLOCKS);
  const { c, book, effCheck } = await bookFor(n, fromH, seedH - 1, []); console.log(`effective VHP cross-check (seeding): ${JSON.stringify(effCheck)}`);
  return { ...B.averageCard(c, 0, c.hs.length, book), at, height: seedH };
}
const PICKS_ABI = () => JSON.parse(fs.readFileSync(new URL("../../picks/abi/picks.koilib.json", import.meta.url), "utf8"));
async function readPicks(node: any, contract: string, round: number): Promise<RawPick[]> {
  const c = new Contract({ id: contract, abi: PICKS_ABI(), provider: node });
  const out: RawPick[] = [];
  let after: string | undefined;
  for (let page = 0; page < 1000; page++) {
    const r: any = await withRetry(`picks for round ${round}`, () => (c.functions as any).list_picks({ game: B.GAME_ID, round: String(round), ...(after ? { start_after: after } : {}), limit: 100 }));
    const rows = r?.result?.rows ?? [];
    for (const x of rows) {
      const num = Number(x.pick?.number ?? "0");
      if (isAddr(x.player) && Number.isSafeInteger(num) && num >= 0) out.push({ player: x.player, number: num, time: Number(x.pick?.time || 0) });
    }
    if (rows.length < 100) break;
    after = rows[rows.length - 1].player;
  }
  return out;
}

async function readGame(node: any, contract: string): Promise<any> {
  const c = new Contract({ id: contract, abi: PICKS_ABI(), provider: node });
  const r: any = await withRetry("the bracket's Picks game", () => (c.functions as any).get_game({ game: B.GAME_ID }));
  return r?.result?.game ?? null;
}
/** The Picks game must have exactly the shape bracket-math expects (audit F-5), or no picks are recorded. */
export function gameProblem(g: any): string | null {
  if (!g) return "the Picks contract has no bracket game";
  const want: [string, number][] = [["kind", 3], ["lock_mode", 2], ["round_size", B.WEEK], ["round_offset", B.ROUND_OFFSET], ["number_min", 0], ["number_max", B.NUMBER_MAX]];
  for (const [k, v] of want) if (Number(g[k] ?? 0) !== v) return `the Picks bracket game has ${k} ${g[k] ?? 0}, expected ${v}`;
  // tighten_game may lock earlier (a longer lead) or open later (a shorter ahead) at once; looser is never accepted (R-4)
  if (!(Number(g.lead ?? 0) >= B.LOCK_BEFORE)) return `the Picks bracket game has lead ${g.lead ?? 0}, expected at least ${B.LOCK_BEFORE}`;
  if (!(Number(g.ahead ?? 0) > 0 && Number(g.ahead) <= B.SEED_BEFORE)) return `the Picks bracket game has ahead ${g.ahead ?? 0}, expected at most ${B.SEED_BEFORE}`;
  return null;
}

// ── the Vault's stakes (game 9) ──
const VAULT_ABI = () => { try { return JSON.parse(fs.readFileSync(new URL("../../game/abi/kpred.koilib.json", import.meta.url), "utf8")); } catch { return null; } };
function defaultVault(): string | null {
  try { const d = JSON.parse(fs.readFileSync(new URL("../../game-data/deployment.json", import.meta.url), "utf8")); return isAddr(d.contract) ? d.contract : null; } catch { return null; }
}
type Stakes = { staked: string[]; held: string[] };
/** For week w, from the Vault's get_game_player (Vault v6): staked = at least 1 VHP staked in game 9 for that week
 *  (rows); held = also every player the Vault would refuse a free prize: its own check, peak stake that week (or,
 *  without an entry, the stake now) of at least 1 VHP. */
async function readStaked(node: any, players: string[], w: number): Promise<Stakes> {
  const abi = VAULT_ABI(), vault = defaultVault();
  if (!abi || !abi.methods || !abi.methods.get_game_player || !vault) throw new Error("the Vault's per-game stakes can't be read yet (needs Vault v6)");
  const c = new Contract({ id: vault, abi, provider: node });
  // the Vault's own minimum stake for week w (fix-check F-8: set_min_stake can change it for later weeks)
  const st: any = await withRetry("the Vault's settings", () => (c.functions as any).get_state({}));
  const cf = st && st.result && st.result.config;
  if (!cf || cf.min_stake === undefined) throw new Error("no answer reading the Vault's minimum stake");
  const MIN = BigInt(cf.min_stake_next ?? "0") > 0n && w >= Number(cf.min_stake_next_week ?? "0") ? BigInt(cf.min_stake_next) : BigInt(cf.min_stake);
  if (MIN <= 0n) throw new Error("the Vault's minimum stake reads as 0");
  const staked: string[] = [], held: string[] = [];
  for (const a of players) {
    const r: any = await withRetry(`stake of ${a}`, () => (c.functions as any).get_game_player({ player: a, game: B.GAME_ID, week: String(w) }));
    if (!r || typeof r !== "object" || !("result" in r)) throw new Error(`no answer reading the stake of ${a}`);
    const x = r.result || {};
    const isStaked = BigInt(x.entry?.stake ?? "0") >= MIN || BigInt(x.week_stake ?? "0") >= MIN;
    const peak = BigInt((x.entry ? x.entry.peak_stake : x.active_stake) ?? "0");
    if (isStaked) staked.push(a);
    if (isStaked || peak >= MIN) held.push(a);
  }
  return { staked, held };
}
const asStakes = (x: string[] | Stakes): Stakes => (Array.isArray(x) ? { staked: [...x], held: [...x] } : { staked: [...x.staked], held: [...x.held] });

/** The free prize's winners (owner 2026-10-28; Vault payout rules): free players (not `held`) with at least 1 point,
 *  ranked like the boards (points, then a right champion, then right winners). first = everyone tied at the top. If
 *  exactly one is first, second = everyone tied next; if several share first, they share all 3 VHP and second is
 *  empty. A place with more than 10 tied (the Vault's limit) is left empty, and so is everything below it. */
export function freeWinners(points: Points[], held: Set<string>) {
  const rows = points.filter(([p, pts]) => !held.has(p) && pts >= 1);
  const key = (r: Points) => r[1] * 10000 + r[2] * 1000 + r[3];
  const keys = [...new Set(rows.map(key))].sort((a, b) => b - a);
  const at = (k: number | undefined) => (k === undefined ? [] : rows.filter((r) => key(r) === k).map((r) => r[0]).sort());
  const first = at(keys[0]);
  if (first.length > 10) return { first: [] as string[], second: [] as string[] };
  if (first.length !== 1) return { first, second: [] as string[] };
  const second = at(keys[1]);
  return { first, second: second.length > 10 ? [] : second };
}
/** The Vault file's points: every staked player with ≥ 1 point, the bracket's ranking (points, then a right champion,
 *  then right winners) mapped onto whole numbers 1–255 keeping the order and the ties. Over 255 different scores: the best 254 exact, the rest share 1. */
export function vaultRows(points: Points[], staked: Set<string>) {
  const rows = points.filter(([p, pts]) => staked.has(p) && pts >= 1);
  const key = (r: Points) => r[1] * 10000 + r[2] * 1000 + r[3];
  const distinct = [...new Set(rows.map(key))].sort((a, b) => b - a);
  // up to 255 different scores: one value each. More (fix-check F-9): the best 254 keep their exact order and ties,
  // the rest share 1. The Vault pays the top 30%, so this only matters if the paid part alone holds 254+ scores.
  const n = distinct.length, map = new Map(distinct.map((k, i) => [k, n <= 255 ? n - i : Math.max(1, 255 - i)]));
  return rows.map((r) => ({ player: r[0], points: map.get(key(r))! }))
    .sort((x, y) => y.points - x.points || (x.player < y.player ? -1 : 1));
}

/** Score a week from what is recorded (live during the week, final after). */
export function scoreWeek(wf: WeekFile) {
  if (!wf.seeding || !wf.seeding.size || !wf.picks) return { results: null, points: [] as Points[] };
  const { size, seeds } = wf.seeding;
  const days = wf.days.map((d) => (d.every(Boolean) ? B.indexFromHours(d) : null));
  const res = B.results(seeds, size, days, wf.seeding.vhp);   // with the forfeit rule (S-5)
  // During a round's day: the winners so far are not known, so only finished rounds score.
  const points: Points[] = wf.picks.rows.map(([player, number]) => {
    const s = B.score(B.decode(number, size, seeds.length), res, size, seeds.length);
    return [player, s.points, s.champion ? 1 : 0, s.correct];
  });
  return { results: { rounds: res.rounds, done: res.done }, points };
}

/** One run. Exported for the tests, which pass fake nodes. */
export async function run(o: Opts) {
  const OUT = o.out ?? E.BRACKET_OUT ?? "games-data/bracket";
  const PREV = o.prev ?? E.BRACKET_PREV ?? "";
  const problems: string[] = [];
  const contract = o.picksContract === undefined ? defaultPicksContract() : o.picksContract;
  const nodeP: Node = o.nodeOf ? o.nodeOf(o.p) : chainNode(o.p);
  const nodeC: Node | null = o.check ? (o.nodeOf ? o.nodeOf(o.check) : chainNode(o.check)) : null;
  const head: Head = o.head ?? (await nodeP.head());
  if (!o.head && nodeC) await nodeC.head();
  // The clock for every decision: the irreversible block's time, the same on both nodes (audit F-4).
  if (nodeC) {
    const t2 = await nodeC.blockTime(head.lib);
    const sameId = (await nodeP.blockId(head.lib)) === (await nodeC.blockId(head.lib));
    if (t2 !== head.libTime || !sameId) { const pr = `the two nodes disagree about block ${head.lib}'s time; nothing written this run`; console.log(`::warning::${pr}`); return { problems: [pr], weeks: new Map(), board: null }; }
  }
  const now = head.libTime;
  const picksRead = o.picksOf ?? (contract ? (node: any, r: number) => readPicks(node, contract, r) : null);
  const stakedRead = o.stakedOf ?? readStaked;
  console.log(`head ${head.height} (${new Date(head.time).toISOString()}), irreversible ${head.lib} (${new Date(head.libTime).toISOString()})`);

  const idx = readJson(PREV, "index.json");
  const known = new Set<number>(Array.isArray(idx?.weeks) ? idx.weeks.filter((w: any) => Number.isInteger(w) && w >= 0 && w < 10000) : []);
  const nowW = B.weekOf(now);
  // A week the last run published must still be there: a missing file means the read failed (audit F-3).
  for (const w of known) if (w >= nowW - 1 && !readJson(PREV, wName(w))) throw new Error(`last run's ${wName(w)} is missing; refusing to write (it would wipe that week)`);
  if (PREV && fs.existsSync(path.join(PREV, "board.json")) && !idx) throw new Error("last run's index.json is missing or unreadable; refusing to write");
  const weeks = new Map<number, WeekFile>();
  // Last week only if it was already being recorded (a first run doesn't void weeks from before it existed).
  for (const w of [nowW - 1, nowW, nowW + 1]) if (w >= 1 && (w >= nowW || known.has(w))) weeks.set(w, loadWeek(PREV, w));
  let hoursLeft = MAX_HOURS_PER_RUN;

  for (const [w, wf] of weeks) {
    if (wf.status === "final" || wf.status === "none" || wf.status === "void") continue;
    // ── 1. seeding ──
    if (!wf.seeding) {
      const at = B.seedTime(w);
      if (now < at) continue;
      let card: any = null;
      try {
        if (!nodeC) throw new Error("a second node is needed to seed (RPC_CHECK)");
        const c1 = await readSeedCard(nodeP, head, at), c2 = await readSeedCard(nodeC, head, at);
        if (JSON.stringify(c1) !== JSON.stringify(c2)) throw new Error("the two nodes disagree about the seeding");
        card = c1;
      } catch (e) {
        if (now >= at + SEED_GRACE) { wf.status = "void"; wf.void = "the seeding could not be read on two nodes within 24 hours; no bracket this week"; }
        else problems.push(`week ${w}: seeding: ${(e as Error).message} (tried again next run)`);
        continue;
      }
      const s = B.seeding(card);
      const vhpOf = new Map<string, number>(card.field.map((r: any) => [r.a, Number(r.vhp)]));
      const totalVhp = Math.round([...card.field, ...card.paddock].reduce((t: number, r: any) => t + r.vhp, 0) * 100) / 100;
      const base = { at, cardAt: card.height, size: s.size, seeds: [...s.seeds], vhp: s.seeds.map((a: string) => vhpOf.get(a) ?? 0), totalVhp, out: [...s.out] };
      wf.seeding = { ...base, hash: seedHash(w, base) };
      wf.days = emptyDays(s.size);
      if (!s.size) { wf.status = "none"; wf.void = `only ${s.seeds.length + s.out.length} producers in the field (8 needed); no bracket this week`; continue; }
      console.log(`week ${w}: seeded ${s.size}-producer bracket (${s.seeds.length} producers)`);
    }
    const { size, seeds } = wf.seeding;
    wf.status = "open";
    // ── 2. picks ──
    if (!wf.picks) {
      if (head.libTime < B.lockTime(w)) continue;
      if (!picksRead) wf.picks = { checked: nodeC ? 2 : 1, rows: [] };
      else {
        try {
          if (!o.picksOf || o.gameOf) {
            const g1 = o.gameOf ? await o.gameOf(o.p) : await readGame(o.p, contract!);
            const gp = gameProblem(g1);
            if (gp) { problems.push(`week ${w}: ${gp}; picks not recorded`); continue; }
            if (o.check) {
              const g2 = o.gameOf ? await o.gameOf(o.check) : await readGame(o.check, contract!);
              if (JSON.stringify(g1) !== JSON.stringify(g2)) { problems.push(`week ${w}: the two nodes disagree about the Picks game; picks not recorded this run`); continue; }
            }
          }
          const round = B.picksRound(w), raw = await picksRead(o.p, round);
          if (o.check) {
            const other = await picksRead(o.check, round);
            const key = (x: RawPick[]) => JSON.stringify([...x].sort((u, v) => (u.player < v.player ? -1 : 1)));
            if (key(raw) !== key(other)) { problems.push(`week ${w}: the two nodes disagree about the picks; not recorded this run`); continue; }
          }
          const seen = new Set<string>();
          const rows: Pick[] = [];
          let late = 0;
          for (const x of raw) {
            if (seen.has(x.player)) continue;
            if (!(x.time < B.lockTime(w))) { late++; continue; }   // the chain should refuse these; never count one (audit F-5)
            seen.add(x.player); rows.push([x.player, x.number, x.time, B.decode(x.number, size, seeds.length) ? 1 : 0]);
          }
          if (late) problems.push(`week ${w}: ${late} pick(s) timed at or after the lock were left out`);
          rows.sort((a, b) => (a[0] < b[0] ? -1 : 1));
          wf.picks = { checked: o.check ? 2 : 1, rows };
          console.log(`week ${w}: ${rows.length} brackets locked (${rows.filter((r) => r[3]).length} valid)`);
        } catch (e) { problems.push(`week ${w}: picks: ${(e as Error).message} (tried again next run)`); continue; }
      }
    }
    wf.status = "locked";
    // ── 3. hours: every irreversible hour of the round days not recorded yet, in one batch per run ──
    const todo: [number, number, number][] = [];   // [round, hour, start]
    for (let r = 0; r < wf.days.length; r++) for (let h = 0; h < 24; h++) {
      const start = B.roundDay(w, r) + h * HOUR;
      if (!wf.days[r][h] && start + HOUR <= head.libTime && todo.length < hoursLeft) todo.push([r, h, start]);
    }
    if (todo.length && !nodeC) problems.push(`week ${w}: hours wait for a second node (RPC_CHECK)`);
    else if (todo.length) {
      hoursLeft -= todo.length;
      try {
        const starts = todo.map((x) => x[2]);
        // baselines for days whose first hour is already recorded (hours are recorded in order)
        const base: Record<number, Record<string, number>> = {};
        for (const [r] of todo) if (wf.days[r][0]) base[B.roundDay(w, r)] = wf.days[r][0]!.w;
        const a = await readHours(nodeP, head, starts, seeds, base);
        const b = await readHours(nodeC!, head, starts, seeds, base);
        const bad = a.findIndex((x, i) => JSON.stringify(x) !== JSON.stringify(b[i]));
        if (bad >= 0) throw new Error(`the two nodes disagree about round ${todo[bad][0] + 1} hour ${todo[bad][1]}; not recorded this run`);
        const checked = 2;
        todo.forEach(([r, h], i) => { wf.days[r][h] = { ...a[i], checked }; });
        console.log(`week ${w}: ${todo.length} hour(s) recorded`);
      } catch (e) { problems.push(`week ${w}: hours: ${(e as Error).message} (tried again next run)`); }
    }
    if (wf.status === "void") continue;
    // ── 4. results and points ──
    const sc = scoreWeek(wf);
    wf.results = sc.results; wf.points = sc.points;
    const lastDayEnd = B.roundDay(w, wf.days.length - 1) + DAY;
    // ── 5. stakes (fixed from the week's start) ──
    const readBoth = async (players: string[]): Promise<Stakes> => {
      if (!nodeC) throw new Error("a second node is needed to read the stakes (RPC_CHECK)");
      const s1 = asStakes(await stakedRead(o.p, players, w)), s2 = asStakes(await stakedRead(o.check, players, w));
      for (const s of [s1, s2]) { s.staked.sort(); s.held.sort(); }
      if (JSON.stringify(s1) !== JSON.stringify(s2)) throw new Error("the two nodes disagree about the stakes");
      return s1;
    };
    if (!wf.staked && wf.picks && now >= B.weekStart(w)) {
      try {
        const players = wf.picks.rows.map((r) => r[0]);
        wf.staked = { checked: 2, list: (await readBoth(players)).staked };
      } catch (e) { problems.push(`week ${w}: stakes: ${(e as Error).message} (tried again next run)`); }
    }
    if (sc.results && sc.results.done && now >= lastDayEnd + CORRECTION) {
      // read once more as the week closes: who the Vault would refuse a free prize can change during the week
      if (wf.staked && !wf.staked.held) {
        try { const s = await readBoth(wf.picks!.rows.map((r) => r[0])); wf.staked = { checked: 2, list: s.staked, held: s.held }; }
        catch (e) { problems.push(`week ${w}: stakes at the close: ${(e as Error).message} (tried again next run)`); }
      }
      if (wf.staked && wf.staked.held) { wf.status = "final"; console.log(`week ${w}: final`); }
      else if (now >= B.weekStart(w + 1) + VAULT_DAYS) { wf.status = "final"; wf.vault = "missed"; problems.push(`week ${w}: closed without the Vault's stakes; no vault file (the Vault rolls the week over)`); }
      else problems.push(`week ${w}: results are in; waiting for the Vault's stakes before the week is final`);
    }
  }

  // ── 5. leaderboards ──
  const allW = new Map(weeks);
  for (const w of known) if (!allW.has(w)) allW.set(w, loadWeek(PREV, w));
  // each board keeps its own places: Staked (ranked) and Free play (the shared board shows the top 6 of those)
  const view = (rows: { player: string; points: number; champion: boolean; correct: number; ranked: boolean }[]) => {
    const part = (r: boolean) => B.rank(rows.filter((x) => x.ranked === r)).slice(0, MAX_BOARD_ROWS).map((x: any) => ({ a: x.player, place: x.place, pts: x.points, champion: x.champion, correct: x.correct, ranked: r }));
    return [...part(true), ...part(false)];
  };
  // Staked board: staked that week, or held a stake in the Bracket during it (a withdrawal doesn't move a player to Free
  // play, where it could never win the prize: fix-check F-5)
  const stakedSet = (wf: WeekFile | undefined) => new Set([...(wf?.staked?.list ?? []), ...(wf?.staked?.held ?? [])]);
  const weekRows = (wf: WeekFile | undefined) => { const st = stakedSet(wf); return wf ? wf.points.map(([player, points, champ, correct]) => ({ player, points, champion: !!champ, correct, ranked: st.has(player) })) : []; };
  const wv = (w: number) => { const wf = allW.get(w); return { week: w, start: B.weekStart(w), status: wf ? wf.status : "waiting", final: wf?.status === "final", rows: view(weekRows(wf)) }; };
  const tot = new Map<string, { player: string; points: number; champion: boolean; correct: number; champs: number; ranked: boolean }>();
  for (const wf of allW.values()) if (wf.status === "final") { const st = stakedSet(wf); for (const [player, points, champ, correct] of wf.points) {
    const t = tot.get(player) || { player, points: 0, champion: false, correct: 0, champs: 0, ranked: false };
    t.points += points; t.correct += correct; t.champs += champ; t.champion = t.champs > 0; t.ranked = t.ranked || st.has(player); tot.set(player, t);
  } }
  const allRows = view([...tot.values()]);
  const board = { v: 1, updated: new Date(now).toISOString(), next: wv(nowW + 1), week: wv(nowW), lastWeek: nowW >= 2 ? wv(nowW - 1) : null, allTime: { rows: allRows } };

  // ── 6. write ──
  fs.mkdirSync(OUT, { recursive: true });
  for (const [w, wf] of weeks) {
    if (wf.status === "waiting" && !wf.seeding) continue;
    known.add(w);
    fs.writeFileSync(path.join(OUT, wName(w)), JSON.stringify(wf) + "\n");
  }
  // the Vault files: final weeks with their stakes, until 3 days after the week ends
  for (const [w, wf] of weeks) {
    if (wf.status !== "final" || !wf.staked || wf.vault === "missed" || now > B.weekStart(w + 1) + VAULT_DAYS) continue;
    fs.mkdirSync(path.join(OUT, "vault"), { recursive: true });
    const prize = freeWinners(wf.points, new Set([...(wf.staked.held ?? []), ...wf.staked.list]));
    const file = { game: B.GAME_ID, week: w, final: true, rows: vaultRows(wf.points, new Set(wf.staked.list)), first: prize.first, second: prize.second };
    fs.writeFileSync(path.join(OUT, "vault", `W${w}.json`), JSON.stringify(file) + "\n");
  }
  fs.writeFileSync(path.join(OUT, "index.json"), JSON.stringify({ v: 1, updated: new Date(now).toISOString(), weeks: [...known].sort((a, b) => a - b), contract: contract || null, game: B.GAME_ID }) + "\n");
  fs.writeFileSync(path.join(OUT, "board.json"), JSON.stringify(board) + "\n");
  for (const pr of problems) console.log(`::warning::${pr}`);
  return { problems, weeks, board };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run({ p: new Provider([RPC]), check: RPC_CHECK ? new Provider([RPC_CHECK]) : null }).catch((e) => { console.error(e); process.exit(1); });
}

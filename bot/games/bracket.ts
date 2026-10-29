/**
 * Producer Bracket recorder (run every hour by .github/workflows/games.yml; read-only on the chain, holds no key).
 * The rules live in site/bracket-math.js, the same file the page runs.
 *
 * Each run, for last week (until final), this week and next week:
 *  1. Seeding. From Saturday 12:00 UTC before a week: the race card in force at that time (race-data) gives the field;
 *     bracket-math.seeding turns it into the bracket (8, 16 with byes, or 32 producers; under 8: no bracket that week).
 *     Recorded once and never changed, with a sha256 of what it says. No card 6 hours after the seeding time: the
 *     week is void.
 *  2. Picks. Once the block at the lock (Sunday 23:55 UTC) is irreversible: every pick for the week's round from the
 *     Picks contract (game 9), on both nodes; they must agree. The chain refused picks after the lock.
 *  3. Hours. Every UTC hour of each round's day, once irreversible: its first and last height, how many blocks it had,
 *     how many each seed signed, and how many each seed was expected to sign, from its exact VHP just before every
 *     block (owner decision 2026-10-28, option A). The VHP is rebuilt from the chain itself: each producer's balance is
 *     read once at the head (pinned to one block), and every VHP event in the blocks between (the per-block burn,
 *     transfers, mints from burning KOIN) is walked back. Done on both nodes; the hours must come out identical.
 *  4. Results and points: each round's day index (bracket-math.indexFromHours), the winners, every pick's points.
 *     The week is final 12 hours after the last round's day (the correction window); then nothing changes.
 *  5. Leaderboards (board.json): Next week (its seeding), This week, Last week and All time (final weeks only). Every
 *     wallet is listed; who shares the staked bucket is the vault's rule (a stake in the Bracket game).
 *  6. Writes games-data/bracket/index.json, W<week>.json and board.json for the publish job.
 *
 * Every time decision uses the irreversible block's time, read on both nodes (audit F-4). The run refuses to write when
 * the last run's files are incomplete (audit F-3): a failed read must never wipe the history.
 *
 *   RPC, RPC_CHECK ("off" to skip the second node), BRACKET_PREV (last run's files), BRACKET_OUT, RACE_DATA.
 *   npm run bracket         (or: npx tsx bot/games/bracket.ts)
 */
import { Provider, Contract } from "koilib";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { Serializer, utils } from "koilib";
import { withRetry } from "../../common.ts";
import { tokenAbi } from "../token-abi.ts";
await import("../../site/race-math.js");
await import("../../site/bracket-math.js");
const M: any = (globalThis as any).KRaceMath;
const B: any = (globalThis as any).KBracketMath;

const E = process.env;
const RPC = E.RPC || "https://api.koinos.io";
const RPC_CHECK = E.RPC_CHECK && E.RPC_CHECK !== "off" && E.RPC_CHECK !== RPC ? E.RPC_CHECK : "";
const HOUR = 3600000, DAY = 24 * HOUR;
const SEED_GRACE = 6 * HOUR;               // no seeding card this long after Saturday 12:00 → the week is void
const CORRECTION = 12 * HOUR;              // final 12 hours after the last round's day
const MAX_HOURS_PER_RUN = 30;              // a long outage catches up over a few runs
const MAX_BOARD_ROWS = 1000;               // per leaderboard view (the page shows 50; your own score is in W<week>.json)
const isAddr = (a: unknown): a is string => typeof a === "string" && /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a);

export type RawPick = { player: string; number: number; time: number };
type Hour = { from: number; to: number; n: number; by: Record<string, number>; exp: Record<string, number>; checked: number };
type Seeding = { at: number; cardAt: number; size: number; seeds: string[]; vhp: number[]; totalVhp: number; out: string[]; hash: string };
/** A recorded pick: [player, number, pick time (ms), valid bracket 1/0]. */
type Pick = [string, number, number, number];
/** Points: [player, points, correct champion 1/0, correct winners]. */
type Points = [string, number, number, number];
export type WeekFile = {
  v: 2; week: number; start: number; end: number;
  status: "waiting" | "none" | "void" | "open" | "locked" | "final";
  seeding: Seeding | null; picks: { checked: number; rows: Pick[] } | null;
  days: (Hour | null)[][];                 // [round][hour 0–23]
  results: { rounds: number[][]; done: boolean } | null;
  points: Points[]; void?: string;
};
type Head = { height: number; time: number; lib: number; libTime: number };
/** Blocks from..to: heights, times, signers, block ids, and the VHP changes their receipts hold. */
export type Chain = { hs: number[]; ts: number[]; sig: number[]; signers: string[]; ids: string[]; deltas: { h: number; a: string; d: number }[] };
export type Node = {
  head(): Promise<{ height: number; time: number; lib: number; libTime: number; id: string }>;
  blockTime(h: number): Promise<number>;
  blockId(h: number): Promise<string>;
  chain(from: number, to: number): Promise<Chain>;
  /** A VHP balance (satoshi) pinned to one block: the head did not move while it was read. */
  balance(a: string): Promise<{ v: number; h: number; id: string }>;
};
type Opts = {
  p: any; check: any | null; prev?: string; out?: string; raceDir?: string;
  picksContract?: string | null;
  picksOf?: (node: any, round: number) => Promise<RawPick[]>;   // for the tests
  gameOf?: (node: any) => Promise<any>;                          // the Picks game's settings (for the tests)
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
const FILE_V = 2;   // v2 (2026-10-28): hours carry exact expected blocks; v1 files (card shares) are not read
const emptyDays = (size: number) => Array.from({ length: size ? B.roundsOf(size) : 0 }, () => new Array<Hour | null>(24).fill(null));
function freshWeek(w: number): WeekFile {
  return { v: FILE_V as 2, week: w, start: B.weekStart(w), end: B.weekStart(w + 1), status: "waiting", seeding: null, picks: null, days: [], results: null, points: [] };
}
const hourOk = (h: any) => h && Number.isInteger(h.from) && Number.isInteger(h.to) && h.to >= h.from - 1 && Number.isInteger(h.n) && h.n >= 0
  && h.by && typeof h.by === "object" && h.exp && typeof h.exp === "object" && Object.values(h.exp).every((x: any) => Number.isFinite(x) && x >= 0) && (h.checked === 1 || h.checked === 2);
function loadWeek(dir: string | undefined, w: number): WeekFile {
  const f = freshWeek(w), old = readJson(dir, wName(w));
  if (!old || old.v !== FILE_V || old.week !== w) return f;
  const s = old.seeding;
  if (s && Number.isInteger(s.size) && [0, 8, 16, 32].includes(s.size) && Array.isArray(s.seeds) && s.seeds.every(isAddr) && s.seeds.length <= s.size
      && typeof s.hash === "string" && s.hash === seedHash(w, s)) f.seeding = s;
  if (old.status === "void") { f.status = "void"; f.void = typeof old.void === "string" ? old.void.slice(0, 200) : "void"; }
  else if (old.status === "none" && f.seeding && f.seeding.size === 0) { f.status = "none"; f.void = typeof old.void === "string" ? old.void.slice(0, 200) : "no bracket this week"; }
  if (f.seeding && old.picks && Array.isArray(old.picks.rows)) f.picks = { checked: old.picks.checked === 2 ? 2 : 1, rows: old.picks.rows.filter((x: any) => Array.isArray(x) && isAddr(x[0]) && Number.isSafeInteger(x[1]) && x[1] >= 0).map((x: any) => [x[0], x[1], Number(x[2]) || 0, x[3] ? 1 : 0] as Pick) };
  f.days = emptyDays(f.seeding ? f.seeding.size : 0);
  if (Array.isArray(old.days)) old.days.forEach((d: any, r: number) => { if (r < f.days.length && Array.isArray(d)) d.forEach((h: any, i: number) => { if (i < 24 && hourOk(h)) f.days[r][i] = h; }); });
  // A final week stays final; its results and points are worked out again from what it recorded (same answer).
  if (old.status === "final" && f.status === "waiting" && f.seeding && f.picks) { const sc = scoreWeek(f); if (sc.results && sc.results.done) { f.status = "final"; f.results = sc.results; f.points = sc.points; } }
  return f;
}
function seedHash(w: number, s: Omit<Seeding, "hash">) {
  return crypto.createHash("sha256").update(JSON.stringify({ week: w, at: s.at, cardAt: s.cardAt, size: s.size, seeds: s.seeds, vhp: s.vhp, totalVhp: s.totalVhp, out: s.out })).digest("hex");
}
function defaultPicksContract(): string | null {
  try { const d = JSON.parse(fs.readFileSync(new URL("../../picks-data/deployment.json", import.meta.url), "utf8")); return isAddr(d.contract) ? d.contract : null; } catch { return null; }
}

// ── the card in force at a time (race-data, hourly legs) ──
function cardAt(raceDir: string | undefined, t: number): any | null {
  const ra = M.raceAt(t);
  const wf = readJson(raceDir, wName(M.weekOf(ra.start)));
  const race = wf && Array.isArray(wf.races) ? wf.races.find((r: any) => r && r.id === ra.id) : null;
  if (!race || !Array.isArray(race.cards)) return null;
  const n = M.legsOf(race.cards);
  const c = M.cardForLeg(race.cards, M.legOf(ra.start, t, n));
  return c && Array.isArray(c.field) && c.field.length ? c : null;
}

// ── chain reads ──
const ser = new Serializer((utils.tokenAbi as any).koilib_types);
async function vhpEvents(it: any) {
  const rc = it.receipt || {}, out: any[] = [], h = Number(it.block_height);
  const all = [...(rc.events || []), ...(rc.transaction_receipts || []).flatMap((t: any) => t.events || [])];
  for (const x of all) {
    if (x.source !== B.VHP_CONTRACT) continue;
    const n = String(x.name || ""), kind = /transfer_event$/.test(n) ? "transfer_event" : /mint_event$/.test(n) ? "mint_event" : /burn_event$/.test(n) ? "burn_event" : "";
    if (!kind) continue;   // approve and other events don't move balances
    const d: any = await ser.deserialize(x.data, `token.${kind}`);   // a VHP event that can't be read stops the run
    out.push({ h, src: x.source, name: n, from: d.from, to: d.to, value: String(d.value ?? "0") });
  }
  return out;
}
function chainNode(p: any): Node {
  let headId = "";
  const vhp = new Contract({ id: B.VHP_CONTRACT, abi: tokenAbi as any, provider: p });
  const blockAt = async (h: number) => {
    const res: any = await withRetry(`block ${h}`, () => p.call("block_store.get_blocks_by_height", { head_block_id: headId, ancestor_start_height: String(h), num_blocks: 1, return_block: true, return_receipt: false }));
    const it = res?.block_items?.[0];
    if (!it || Number(it.block_height) !== h) throw new Error(`block ${h} not returned`);
    return it;
  };
  const headNow = async () => { const h: any = await withRetry("head", () => p.getHeadInfo()); return { id: String(h.head_topology.id), height: Number(h.head_topology.height), raw: h }; };
  return {
    async head() {
      const h = await headNow(); headId = h.id;
      const lib = Number(h.raw.last_irreversible_block);
      return { id: headId, height: h.height, time: Number(h.raw.head_block_time), lib, libTime: Number((await blockAt(lib)).block.header.timestamp) };
    },
    async blockTime(h) { return Number((await blockAt(h)).block.header.timestamp); },
    async blockId(h) { return String((await blockAt(h)).block_id); },
    async chain(from, to) {
      const hNow = await headNow(); headId = hNow.id;   // blocks up to the head as it is now
      const out: Chain = { hs: [], ts: [], sig: [], signers: [], ids: [], deltas: [] };
      const idx = new Map<string, number>(), events: any[] = [];
      let k = from;
      while (k <= to) {
        const res: any = await withRetry(`blocks at ${k}`, () => p.call("block_store.get_blocks_by_height", { head_block_id: headId, ancestor_start_height: String(k), num_blocks: Math.min(50, to - k + 1), return_block: true, return_receipt: true }));
        const items = res?.block_items ?? [];
        if (!items.length) throw new Error(`no blocks returned at ${k}`);
        for (const it of items) {
          if (Number(it.block_height) !== k || k > to) throw new Error(`blocks out of order at ${k}`);
          const a = String(it.block.header.signer); let i = idx.get(a); if (i === undefined) { i = out.signers.length; out.signers.push(a); idx.set(a, i); }
          out.hs.push(k); out.ts.push(Number(it.block.header.timestamp)); out.sig.push(i); out.ids.push(String(it.block_id));
          events.push(...(await vhpEvents(it)));
          k++;
        }
      }
      out.deltas = B.vhpDeltas(events);
      return out;
    },
    async balance(a) {
      for (let t = 0; t < 6; t++) {
        const h1 = await headNow();
        const r: any = await withRetry(`VHP of ${a}`, () => (vhp.functions as any).balance_of({ owner: a }));
        if (!r || typeof r !== "object" || !("result" in r)) throw new Error(`no answer reading the VHP of ${a}`);
        const h2 = await headNow();
        if (h1.id === h2.id) return { v: Number(r.result?.value ?? "0"), h: h1.height, id: h1.id };
      }
      throw new Error(`the head kept moving while reading the VHP of ${a}`);
    },
  };
}
/** The first height (≤ lib + 1) whose block time is at or after t. */
async function heightAt(n: Node, head: Head, t: number): Promise<number> {
  if (t > head.libTime) return head.lib + 1;
  const est = Math.round(head.lib - (head.libTime - t) / 3000);
  let lo = Math.max(1, est - 2000), hi = Math.min(head.lib, est + 2000);
  for (let i = 0; i < 20 && lo > 1 && (await n.blockTime(lo)) >= t; i++) lo = Math.max(1, lo - 4000 * 2 ** i);
  for (let i = 0; i < 20 && hi < head.lib && (await n.blockTime(hi)) < t; i++) hi = Math.min(head.lib, hi + 4000 * 2 ** i);
  if ((await n.blockTime(hi)) < t) return hi + 1;
  while (lo < hi) { const m = Math.floor((lo + hi) / 2); if ((await n.blockTime(m)) < t) lo = m + 1; else hi = m; }
  return lo;
}
/** Hour records for the given hour starts (all irreversible), on one node, from exact VHP. */
export async function readHours(n: Node, head: Head, starts: number[], seeds: string[]) {
  const first = Math.min(...starts), last = Math.max(...starts);
  const fromH = Math.max(1, (await heightAt(n, head, first)) - B.ACTIVE_BLOCKS), toH = (await heightAt(n, head, last + HOUR)) - 1;
  const c = await n.chain(fromH, toH);
  // Anchors: every producer that signed in the range, and every seed, read once at the head (pinned to a block).
  const who = [...new Set([...c.signers, ...seeds])];
  const anchors: Record<string, { h: number; v: number }> = {}, at = new Map<number, string>();
  for (const a of who) { const b = await n.balance(a); anchors[a] = { h: b.h, v: b.v }; at.set(b.h, b.id); }
  const top = Math.max(...[...at.keys()]);
  const tail = top > toH ? await n.chain(toH + 1, top) : { hs: [], ids: [], deltas: [] } as any;
  // The blocks walked back are the very ones the balances were read on (no fork in between).
  const idOf = new Map<number, string>(); c.hs.forEach((h, i) => idOf.set(h, c.ids[i])); tail.hs.forEach((h: number, i: number) => idOf.set(h, tail.ids[i]));
  for (const [h, id] of at) if (h > toH && idOf.get(h) !== id) throw new Error(`block ${h} changed while reading (a fork); tried again next run`);
  if (top < toH) throw new Error(`a balance was read below block ${toH}; tried again next run`);
  const book = B.vhpBook(anchors, [...c.deltas, ...tail.deltas]);
  for (const a of who) { const v = book.before(a, fromH); if (v === null || v < -0.5) throw new Error(`the VHP rebuild for ${a} went below zero (a missed event)`); }
  return B.exactHours(c, starts, seeds, book) as Omit<Hour, "checked">[];
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

/** Score a week from what is recorded (live during the week, final after). */
export function scoreWeek(wf: WeekFile) {
  if (!wf.seeding || !wf.seeding.size || !wf.picks) return { results: null, points: [] as Points[] };
  const { size, seeds } = wf.seeding;
  const days = wf.days.map((d) => (d.every(Boolean) ? B.indexFromHours(d) : null));
  const res = B.results(seeds, size, days);
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
  const RACE = o.raceDir ?? E.RACE_DATA ?? "";
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
      const card = cardAt(RACE, at);
      if (!card) {
        if (now >= at + SEED_GRACE) { wf.status = "void"; wf.void = "no race card was recorded at the seeding time; no bracket this week"; }
        else problems.push(`week ${w}: no race card yet for the seeding time; tried again next run`);
        continue;
      }
      const s = B.seeding(card);
      const vhpOf = new Map<string, number>(card.field.map((r: any) => [r.a, Number(r.vhp)]));
      const totalVhp = [...card.field, ...(card.paddock || [])].reduce((t: number, r: any) => t + (Number.isFinite(r?.vhp) && r.vhp > 0 ? r.vhp : 0), 0);
      const base = { at, cardAt: Number(card.at) || 0, size: s.size, seeds: [...s.seeds], vhp: s.seeds.map((a: string) => vhpOf.get(a) ?? 0), totalVhp, out: [...s.out] };
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
    if (todo.length) {
      hoursLeft -= todo.length;
      try {
        const starts = todo.map((x) => x[2]);
        const a = await readHours(nodeP, head, starts, seeds);
        let checked = 1;
        if (nodeC) {
          const b = await readHours(nodeC, head, starts, seeds);
          const bad = a.findIndex((x, i) => JSON.stringify(x) !== JSON.stringify(b[i]));
          if (bad >= 0) throw new Error(`the two nodes disagree about round ${todo[bad][0] + 1} hour ${todo[bad][1]}; not recorded this run`);
          checked = 2;
        }
        todo.forEach(([r, h], i) => { wf.days[r][h] = { ...a[i], checked }; });
        console.log(`week ${w}: ${todo.length} hour(s) recorded`);
      } catch (e) { problems.push(`week ${w}: hours: ${(e as Error).message} (tried again next run)`); }
    }
    if (wf.status === "void") continue;
    // ── 4. results and points ──
    const sc = scoreWeek(wf);
    wf.results = sc.results; wf.points = sc.points;
    const lastDayEnd = B.roundDay(w, wf.days.length - 1) + DAY;
    if (sc.results && sc.results.done && now >= lastDayEnd + CORRECTION) { wf.status = "final"; console.log(`week ${w}: final`); }
  }

  // ── 5. leaderboards ──
  const allW = new Map(weeks);
  for (const w of known) if (!allW.has(w)) allW.set(w, loadWeek(PREV, w));
  const view = (rows: { player: string; points: number; champion: boolean; correct: number }[]) =>
    B.rank(rows).slice(0, MAX_BOARD_ROWS).map((x: any) => ({ a: x.player, place: x.place, pts: x.points, champion: x.champion, correct: x.correct, ranked: true }));
  const weekRows = (wf: WeekFile | undefined) => (wf ? wf.points.map(([player, points, champ, correct]) => ({ player, points, champion: !!champ, correct })) : []);
  const wv = (w: number) => { const wf = allW.get(w); return { week: w, start: B.weekStart(w), status: wf ? wf.status : "waiting", final: wf?.status === "final", rows: view(weekRows(wf)) }; };
  const tot = new Map<string, { player: string; points: number; champion: boolean; correct: number; champs: number }>();
  for (const wf of allW.values()) if (wf.status === "final") for (const [player, points, champ, correct] of wf.points) {
    const t = tot.get(player) || { player, points: 0, champion: false, correct: 0, champs: 0 };
    t.points += points; t.correct += correct; t.champs += champ; t.champion = t.champs > 0; tot.set(player, t);
  }
  const allRows = B.rank([...tot.values()]).slice(0, MAX_BOARD_ROWS).map((x: any) => ({ a: x.player, place: x.place, pts: x.points, champion: x.champion, correct: x.correct, ranked: true }));
  const board = { v: 1, updated: new Date(now).toISOString(), next: wv(nowW + 1), week: wv(nowW), lastWeek: nowW >= 2 ? wv(nowW - 1) : null, allTime: { rows: allRows } };

  // ── 6. write ──
  fs.mkdirSync(OUT, { recursive: true });
  for (const [w, wf] of weeks) {
    if (wf.status === "waiting" && !wf.seeding) continue;
    known.add(w);
    fs.writeFileSync(path.join(OUT, wName(w)), JSON.stringify(wf) + "\n");
  }
  fs.writeFileSync(path.join(OUT, "index.json"), JSON.stringify({ v: 1, updated: new Date(now).toISOString(), weeks: [...known].sort((a, b) => a - b), contract: contract || null, game: B.GAME_ID }) + "\n");
  fs.writeFileSync(path.join(OUT, "board.json"), JSON.stringify(board) + "\n");
  for (const pr of problems) console.log(`::warning::${pr}`);
  return { problems, weeks, board };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run({ p: new Provider([RPC]), check: RPC_CHECK ? new Provider([RPC_CHECK]) : null }).catch((e) => { console.error(e); process.exit(1); });
}

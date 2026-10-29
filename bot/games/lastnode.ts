/**
 * Last Node Standing recorder (run every 5 minutes during event hours by .github/workflows/lastnode.yml; read-only on
 * the chain, holds no key). The rules are in lastnode-math.js, the same file the page runs.
 *
 * Each run, for every event from 3 days ago to tomorrow:
 *  1. The field. From the Producer Race card of the 12:00 UTC leg the day before (race-data; if that leg has none,
 *     the 13:00 leg's if it was taken before picks open at 13:15, never a later one), calibrated once and
 *     kept: nodes at 20+ blocks an hour, their handicaps and the day's c. Published as soon as the card exists, so the
 *     field is known when picks open (24 hours ahead). An event that has started with no card is void.
 *  2. The hours. Hour i (start + i h to start + (i + 1) h, block timestamps) is recorded once the first block at or
 *     after its end is irreversible, and every block in it matches on two independent nodes (RPC and RPC_CHECK).
 *     Only each field node's block count is kept. After each hour the cut is worked out; the event stops at the last
 *     cut.
 *  3. The picks. With hour i, the picks for the round at offset i + 1 (locked at 10 minutes past hour i, so already
 *     irreversible) are read on both nodes, which must agree; with hour 0 also the start round. These are the start
 *     picks and the jumps (and backups). Other rounds are never read.
 *  4. Every player's event (start, jump, cuts survived, points) and whether the wallet may be ranked (1 VHP or a
 *     Knode stake, as the race board; staked prizes are decided by the vault).
 *  5. Leaderboards (board.json): Today (today's event), This week, Last week (final 12 hours after the week ends when
 *     every event in it is finished or void) and All time.
 *  6. Writes games-data/lastnode/index.json, D<yyyy-mm-dd>.json and board.json; the publish job puts them on the
 *     games-data branch.
 *
 *   RPC, RPC_CHECK ("off" to skip the second node), LASTNODE_PREV, LASTNODE_OUT, RACE_DATA.
 *   npm run lastnode      (or: npx tsx bot/games/lastnode.ts)
 */
import { Provider, Contract } from "koilib";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { readVhp, MAINNET_VHP, withRetry } from "../../common.ts";
await import("../../race-math.js");
await import("../../lastnode-math.js");
const M: any = (globalThis as any).KRaceMath;
const L0: any = (globalThis as any).KLastNode;
/** The rules for the game this run records: the real game (13) unless run() is given other settings (testnet). */
let L: any = L0;

const E = process.env;
const RPC = E.RPC || "https://koinos.armana.io";
const RPC_CHECK = E.RPC_CHECK && E.RPC_CHECK !== "off" && E.RPC_CHECK !== RPC ? E.RPC_CHECK : "";
const LOOKBACK_MS = 3 * 86400000;           // an event not finished 3 days after its start is closed as void
const MAX_HOURS_PER_RUN = 30;               // a long outage catches up over a few runs
const CORRECTION_MS = 12 * 3600000;         // a week is final 12 hours after it ends
const ONE_VHP = 100000000n;
const isAddr = (a: unknown) => typeof a === "string" && /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a);
/** An event id of this game: "YYYY-MM-DD" (daily game) or "YYYY-MM-DDTHH" (the testnet fast game). */
const isDay = (d: unknown) => typeof d === "string" && !!L.eventOf(d);

/** A recorded pick: [player, producer, pick time (ms)]. */
type Pick = [string, string, number];
type Hour = { i: number; from: number; to: number; blocks: Record<string, number>; checked: number };
type PlayerRow = { a: string; start: string; jumpTo: string | null; out: number; survived: number; rode: boolean; jumped: boolean; points: number; ranked: boolean };
export type DayFile = {
  v: 1; day: string; start: number; week: number;
  field: any | null; void?: string;
  hours: Hour[]; picks: Record<string, Pick[]>;
  cuts: { at: number; a: string; steps: number; blocks: number }[]; standing: string[]; winner: string | null; done: boolean;
  players: PlayerRow[];
};
/** One hour's blocks as read from a node: the first and last height, and each signer's count. */
export type Window = { from: number; to: number; counts: Record<string, number> };
type Opts = {
  p: any; check: any | null; prev?: string; out?: string; raceDir?: string;
  game?: any;                                                             // other settings (testnet); default the real game
  pp?: any; pcheck?: any | null;                                          // where the picks are read (default p and check)
  practice?: boolean;                                                     // testnet: start from the event running at the first run
  picksContract?: string | null;
  now?: { time: number; libTime: number };                                // for the tests
  windowOf?: (node: any, t0: number, t1: number) => Promise<Window>;
  picksOf?: (node: any, round: number) => Promise<Pick[]>;
  rankedOf?: (who: string[]) => Promise<Set<string>>;
  /** Vault v6: the wallets with at least 1 VHP staked in this game for a vault week (null = can't tell yet). */
  stakedOf?: (week: number, who: string[]) => Promise<Set<string> | null>;
  trials?: number;
};

// ── files ──
function readJson(dir: string | undefined, name: string): any {
  if (!dir) return null;
  const f = path.join(dir, name);
  try { if (fs.lstatSync(f).isSymbolicLink()) return null; return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; }
}
const dName = (day: string) => `D${day}.json`;
const wName = (w: number) => `W${String(w).padStart(3, "0")}.json`;
function freshDay(day: string): DayFile {
  const ev = L.eventOf(day);
  return { v: 1, day: ev.day, start: ev.start, week: L.weekOf(ev.start), field: null, hours: [], picks: {}, cuts: [], standing: [], winner: null, done: false, players: [] };
}
/** Last run's file for a day, taken only if it has the expected shape (anything else starts the day fresh). */
function loadDay(dir: string | undefined, day: string): DayFile {
  const f = freshDay(day), o = readJson(dir, dName(day));
  if (!o || o.v !== 1 || o.day !== f.day || o.start !== f.start) return f;
  if (o.field && Array.isArray(o.field.nodes) && o.field.nodes.length >= 2 && o.field.nodes.length <= L.MAX_FIELD && o.field.nodes.every((n: any) => isAddr(n?.a) && Number.isFinite(n.h) && n.h > 0 && Number.isFinite(n.vhp)))
    f.field = { at: Number(o.field.at) || 0, c: Number(o.field.c) || 0, fairness: o.field.fairness ?? null, nodes: o.field.nodes.map((n: any) => ({ a: n.a, vhp: n.vhp, kh: n.kh, h: n.h })) };
  if (typeof o.void === "string") f.void = o.void.slice(0, 200);
  if (Array.isArray(o.hours)) for (const [k, h] of o.hours.entries()) {
    if (!h || h.i !== k || !Number.isInteger(h.from) || !Number.isInteger(h.to) || typeof h.blocks !== "object" || h.blocks === null) break;
    f.hours.push({ i: k, from: h.from, to: h.to, blocks: Object.fromEntries(Object.entries(h.blocks).filter(([a, n]) => isAddr(a) && Number.isInteger(n) && (n as number) >= 0)) as any, checked: h.checked === 2 ? 2 : 1 });
  }
  if (o.picks && typeof o.picks === "object") for (const [k, rows] of Object.entries(o.picks))
    if (/^\d{1,2}$/.test(k) && Array.isArray(rows)) f.picks[k] = (rows as any[]).filter((x) => Array.isArray(x) && isAddr(x[0]) && isAddr(x[1]) && Number.isFinite(x[2])).map((x) => [x[0], x[1], Number(x[2])]);
  if (Array.isArray(o.players)) f.players = o.players.filter((x: any) => x && isAddr(x.a) && x.ranked === true).map((x: any) => ({ a: x.a, ranked: true } as any));
  return f;
}
function defaultPicksContract(): string | null {
  try { const d = JSON.parse(fs.readFileSync(new URL("../../picks-data/deployment.json", import.meta.url), "utf8")); return isAddr(d.contract) ? d.contract : null; } catch { return null; }
}

// ── the race card the field comes from ──
function cardAt(raceDir: string | undefined, t: number, opens: number): any | null {
  const ra = M.raceAt(t);
  const wf = readJson(raceDir, wName(M.weekOf(ra.start)));
  const race = wf && Array.isArray(wf.races) ? wf.races.find((r: any) => r && r.id === ra.id) : null;
  if (!race || !Array.isArray(race.cards)) return null;
  // That leg's card, else the next hour's, only if it was taken before picks opened (13:15 the day before); never a
  // later one, so the field can't change after people have picked.
  const n = M.legsOf(race.cards), leg = M.legOf(ra.start, t, n);
  for (const l of [leg, leg + 1]) {
    const c = race.cards[l];
    if (c && Array.isArray(c.field) && c.field.length && Number(c.at) < opens) return c;
  }
  return null;
}

// ── chain reads ──
async function headOf(node: any) {
  const h: any = await withRetry("head", () => node.getHeadInfo());
  return { id: h.head_topology.id as string, height: Number(h.head_topology.height), time: Number(h.head_block_time), lib: Number(h.last_irreversible_block) };
}
async function blocksAt(node: any, headId: string, from: number, n: number) {
  const res: any = await withRetry(`blocks at ${from}`, () => node.call("block_store.get_blocks_by_height", { head_block_id: headId, ancestor_start_height: String(from), num_blocks: n, return_block: true, return_receipt: false }));
  const items = res?.block_items ?? [];
  if (!items.length) throw new Error(`no blocks returned at ${from}`);
  return items.map((it: any, k: number) => {
    if (Number(it.block_height) !== from + k) throw new Error(`blocks out of order at ${from}`);
    return { h: from + k, signer: String(it.block.header.signer), time: Number(it.block.header.timestamp) };
  });
}
/** A node's window reader: the blocks with time in [t0, t1), all at or below its irreversible block. */
function windowReader(node: any) {
  let headP: Promise<any> | null = null;
  const head = () => (headP ??= headOf(node));
  const timeOf = async (h: number) => (await blocksAt(node, (await head()).id, h, 1))[0].time;
  const firstAtOrAfter = async (t: number, lo: number, hi: number) => {
    while (lo < hi) { const m = Math.floor((lo + hi) / 2); if ((await timeOf(m)) < t) lo = m + 1; else hi = m; }
    return lo;
  };
  return async (t0: number, t1: number): Promise<Window> => {
    const hd = await head();
    const libT = await timeOf(hd.lib);
    if (libT < t1) throw new Error("not irreversible yet");
    let lo = Math.max(1, hd.lib - Math.ceil((libT - t0) / 3000) - 1200);
    while (lo > 1 && (await timeOf(lo)) >= t0) lo = Math.max(1, lo - 1200);
    const a = await firstAtOrAfter(t0, lo, hd.lib), b = (await firstAtOrAfter(t1, a, hd.lib)) - 1;
    const counts: Record<string, number> = {};
    for (let s = a; s <= b; s += 200) {
      for (const x of await blocksAt(node, hd.id, s, Math.min(200, b - s + 1))) {
        if (x.time < t0 || x.time >= t1) throw new Error(`block ${x.h} outside the hour`);
        counts[x.signer] = (counts[x.signer] || 0) + 1;
      }
    }
    return { from: a, to: b, counts };
  };
}
const PICKS_ABI = () => JSON.parse(fs.readFileSync(new URL("../../picks/abi/picks.koilib.json", import.meta.url), "utf8"));
async function readPicks(node: any, contract: string, round: number): Promise<Pick[]> {
  const c = new Contract({ id: contract, abi: PICKS_ABI(), provider: node });
  const out: Pick[] = [];
  let after: string | undefined;
  for (let page = 0; page < 1000; page++) {
    const r: any = await withRetry(`picks for round ${round}`, () => (c.functions as any).list_picks({ game: L.GAME_ID, round: String(round), ...(after ? { start_after: after } : {}), limit: 100 }));
    const rows = r?.result?.rows ?? [];
    for (const x of rows) {
      const ps = x.pick?.producers;
      if (isAddr(x.player) && Array.isArray(ps) && ps.length === 1 && isAddr(ps[0])) out.push([x.player, ps[0], Number(x.pick.time || 0)]);
    }
    if (rows.length < 100) break;
    after = rows[rows.length - 1].player;
  }
  return out;
}
const GAME = (() => { try { return JSON.parse(fs.readFileSync(new URL("../../game-data/deployment.json", import.meta.url), "utf8")).contract as string; } catch { return ""; } })();
const GAME_ABI = () => JSON.parse(fs.readFileSync(new URL("../../game/abi/kpred.koilib.json", import.meta.url), "utf8"));
/** Who may be ranked: at least 1 VHP, or a Knode stake (as the race and Block X boards). */
/** Vault v6 (owner's player rule, 2026-10-28): a staked player in this game is a wallet whose stake in THIS game counts
 *  for that week (week_stake, at least the vault's minimum stake for that week: 1 VHP unless the owner changes it).
 *  Returns null while the game contract has no per-game stakes (before v6), so no vault file is written on a guess.
 *  Audit LN-12: the minimum is the vault's own for that week (get_state), not a number in this file. */
/** The vault's minimum stake for a week, from get_state's config (as the vault bot's minStakeFor). Exported for the tests. */
export function minStakeOf(cf: any, week: number): bigint {
  const next = BigInt(cf?.min_stake_next || "0");
  return next > 0n && week >= Number(cf?.min_stake_next_week || 0) ? next : BigInt(cf?.min_stake || "0");
}
export async function readStakedV6(node: any, week: number, who: string[], game = GAME, abiOf = GAME_ABI): Promise<Set<string> | null> {
  if (!game) return null;
  const abi = abiOf();
  if (!abi?.methods?.get_game_player || !abi?.methods?.get_state) return null;
  const c = new Contract({ id: game, abi, provider: node });
  const st: any = await withRetry("the vault's settings", () => (c.functions as any).get_state({}));
  const min = minStakeOf(st?.result?.config ?? {}, week);
  if (min <= 0n) throw new Error("the vault's minimum stake could not be read (0)");
  const out = new Set<string>();
  for (const a of who) {
    const r: any = await withRetry(`stake of ${a} in game ${L.GAME_ID}`, () => (c.functions as any).get_game_player({ player: a, game: L.GAME_ID, week: String(week) }));
    if (BigInt(r?.result?.week_stake || "0") >= min) out.add(a);
  }
  return out;
}
/** Audit LN-2: who is staked, read on BOTH mainnet nodes; any difference holds the vault file (tried again next run).
 *  An empty answer reads as "no stake", so one faulty node could otherwise drop staked wallets from a file that is
 *  never replaced. Exported for the tests. */
export async function stakedOnBoth(read: (node: any) => Promise<Set<string> | null>, p: any, check: any): Promise<Set<string> | null> {
  const a = await read(p);
  if (!check) throw new Error("no second node to check the stakes on (RPC_CHECK)");
  const b = await read(check);
  if (a === null || b === null) { if (a !== b) throw new Error("the stakes could be read on one node only"); return null; }
  const only = [...a].filter((x) => !b.has(x)).concat([...b].filter((x) => !a.has(x)));
  if (only.length) throw new Error(`the two nodes disagree on who is staked (${only.length} wallet${only.length === 1 ? "" : "s"}, e.g. ${only[0]})`);
  return a;
}
/** The vault file's scores: the week's board order (points, then rides, then fewer jumps) as whole numbers 1–255, ties
 *  kept. The real points when they already give that order and fit; else each tie group's rank counted from the bottom.
 *  ranked: board rows, best first, each { a, pts, rides, jumps }. Exported for the tests. */
export function vaultScores(ranked: { a: string; pts: number; rides: number; jumps: number }[]): { player: string; points: number }[] {
  const rows = ranked.filter((r) => r.pts >= 1);
  const key = (r: any) => `${r.pts}|${r.rides}|${r.jumps}`;
  const groups: string[] = [];
  for (const r of rows) if (groups[groups.length - 1] !== key(r)) groups.push(key(r));
  const pointsKeepOrder = rows.every((r, i) => i === 0 || (rows[i - 1].pts === r.pts) === (key(rows[i - 1]) === key(r))) && rows.every((r) => r.pts <= 255);
  if (pointsKeepOrder) return rows.map((r) => ({ player: r.a, points: r.pts }));
  // Audit LN-13: more than 255 different places: the top 254 places keep every tie-break (where the payouts are), and
  // only the tail below them shares the lowest score, 1.
  const rank = new Map(groups.map((g, i) => [g, Math.max(1, Math.min(255, groups.length) - i)]));
  return rows.map((r) => ({ player: r.a, points: rank.get(key(r))! }));
}
async function readRanked(node: any, who: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (!who.length) return out;
  const vhp = (await readVhp(node, MAINNET_VHP, who)).values;
  for (const a of who) {
    if (BigInt(vhp[a] || "0") >= ONE_VHP) { out.add(a); continue; }
    if (!GAME) continue;
    try {
      const c = new Contract({ id: GAME, abi: GAME_ABI(), provider: node });
      const r: any = await withRetry(`Knode player ${a}`, () => (c.functions as any).get_player({ player: a, week: "0" }));
      const p = r?.result?.player ?? {};
      if (BigInt(p.stake || "0") + BigInt(p.pending || "0") > 0n) out.add(a);
    } catch { /* not ranked */ }
  }
  return out;
}
const sameCounts = (x: Window, y: Window) => x.from === y.from && x.to === y.to && JSON.stringify(Object.entries(x.counts).sort()) === JSON.stringify(Object.entries(y.counts).sort());
const samePicks = (x: Pick[], y: Pick[]) => { const k = (r: Pick[]) => JSON.stringify([...r].sort((u, v) => (u[0] < v[0] ? -1 : u[0] > v[0] ? 1 : 0))); return k(x) === k(y); };

/** One run. Exported for the tests, which pass fake nodes. */
export async function run(o: Opts) {
  L = o.game ? L0.forGame(o.game) : L0;
  const OUT = o.out ?? E.LASTNODE_OUT ?? "games-data/lastnode";
  const PREV = o.prev ?? E.LASTNODE_PREV ?? "";
  const RACE = o.raceDir ?? E.RACE_DATA ?? "";
  const problems: string[] = [];
  const contract = o.picksContract === undefined ? defaultPicksContract() : o.picksContract;

  // Now and the irreversible time: both nodes, the earlier of the two.
  let now: { time: number; libTime: number };
  if (o.now) now = o.now;
  else {
    const h = await headOf(o.p);
    const libT = (await blocksAt(o.p, h.id, h.lib, 1))[0].time;
    let libTime = libT;
    if (o.check) { const c = await headOf(o.check); libTime = Math.min(libTime, (await blocksAt(o.check, c.id, c.lib, 1))[0].time); }
    now = { time: h.time, libTime };
  }
  const winP = o.windowOf ? (a: number, b: number) => o.windowOf!(o.p, a, b) : windowReader(o.p);
  const winC = o.check ? (o.windowOf ? (a: number, b: number) => o.windowOf!(o.check, a, b) : windowReader(o.check)) : null;
  const picksRead = o.picksOf ?? (contract ? (node: any, r: number) => readPicks(node, contract, r) : null);
  const pMain = o.pp ?? o.p, pCheck = o.pp ? (o.pcheck ?? null) : o.check;
  const rankedRead = o.rankedOf ?? ((who: string[]) => readRanked(o.p, who));
  console.log(`now ${new Date(now.time).toISOString()}, irreversible to ${new Date(now.libTime).toISOString()}`);

  const idx = readJson(PREV, "index.json");
  const known = new Set<string>(Array.isArray(idx?.days) ? idx.days.filter(isDay) : []);
  // Testnet practice starts with the event running at the first run (index "since"); nothing earlier is read.
  const since = o.practice ? (Number.isFinite(idx?.since) ? Number(idx.since) : L.eventOf(now.time).start) : -Infinity;
  if (o.practice) for (const d of [...known]) if (L.eventOf(d).start < since) known.delete(d);
  // The game's first recorded day: days before it are never filled in as void (the game wasn't running yet).
  const firstStart = known.size ? L.eventOf([...known].sort()[0]).start : o.practice ? since : Infinity;
  const days = new Map<string, DayFile>();
  const touched = new Set<string>();
  const today = L.eventOf(now.time);
  // Events from 3 days ago to the next one (its field is published when its picks open).
  for (let t = Math.max(today.start - 3 * L.DAY, since); t <= today.start + L.PERIOD; t += L.PERIOD) days.set(L.eventOf(t).day, loadDay(PREV, L.eventOf(t).day));
  for (const d of known) if (!days.has(d)) days.set(d, loadDay(PREV, d));
  // Every day of last week and this week (up to today), so a day the recorder never saw is closed as void.
  for (let t = L.weekStart(Math.max(0, L.weekOf(now.time) - 1)); t <= today.start; t += L.PERIOD) { const d = L.eventOf(t).day; if (!days.has(d) && t >= firstStart) days.set(d, loadDay(PREV, d)); }

  let hoursRead = 0;
  for (const df of days.values()) {
    if (df.start > today.start + L.PERIOD || df.void) continue;
    if (df.start < today.start - 3 * L.DAY) {                     // older events are settled; one never finished is void
      if (!L.cutsFrom(df.field || { nodes: [] }, df.hours).done && now.time - df.start > LOOKBACK_MS && df.start >= firstStart) { df.void = df.field ? "not recorded within 3 days" : "never recorded"; touched.add(df.day); }
      continue;
    }
    const ev = L.eventOf(df.day);
    try {
      // ── 1. the field ──
      if (!df.field) {
        const card = cardAt(RACE, ev.cardTime, ev.opens);
        if (card) {
          const f = L.makeField(card, o.trials);
          if (f) { df.field = f; touched.add(df.day); console.log(`${df.day}: field of ${f.nodes.length}, c = ${f.c}`); }
          else if (now.time >= ev.lock) { df.void = "fewer than 2 nodes at 20 blocks an hour"; touched.add(df.day); }
        } else if (now.time >= ev.lock) { df.void = "no race card for the field"; touched.add(df.day); }
        if (!df.field) continue;
      }
      // ── 2–3. hours and picks ──
      let res = L.cutsFrom(df.field, df.hours);
      while (!res.done && hoursRead < MAX_HOURS_PER_RUN) {
        const i = df.hours.length, t0 = df.start + i * L.CUT, t1 = t0 + L.CUT;
        if (now.libTime < t1) break;
        const w = await winP(t0, t1);
        let checked = 1;
        if (winC) {
          const w2 = await winC(t0, t1);
          if (!sameCounts(w, w2)) { problems.push(`${df.day} hour ${i}: the two nodes disagree about the blocks; tried again next run`); break; }
          checked = 2;
        }
        const offsets = i === 0 ? [0, 1] : [i + 1];
        const got: Record<string, Pick[]> = {};
        if (picksRead) {
          let ok = true;
          for (const off of offsets) {
            const mine = await picksRead(pMain, ev.round + off);
            if (pCheck) { const theirs = await picksRead(pCheck, ev.round + off); if (!samePicks(mine, theirs)) { ok = false; break; } }
            got[off] = mine;
          }
          if (!ok) { problems.push(`${df.day} hour ${i}: the two nodes disagree about the picks; tried again next run`); break; }
        }
        const inField = new Set(df.field.nodes.map((n: any) => n.a));
        const blocks: Record<string, number> = {};
        for (const [a, n] of Object.entries(w.counts)) if (inField.has(a)) blocks[a] = n;
        df.hours.push({ i, from: w.from, to: w.to, blocks, checked });
        for (const [k, v] of Object.entries(got)) df.picks[k] = v;
        hoursRead++; touched.add(df.day);
        res = L.cutsFrom(df.field, df.hours);
        const cut = res.cuts[res.cuts.length - 1];
        console.log(`${df.day} hour ${i}: blocks ${w.from}-${w.to}, cut ${cut?.a}, ${res.standing.length} standing, checked on ${checked} node(s)`);
      }
    } catch (e) { problems.push(`${df.day}: ${(e as Error).message} (tried again next run)`); }
    if (df.field && !df.void && !L.cutsFrom(df.field, df.hours).done && now.time - df.start > LOOKBACK_MS) { df.void = "not recorded within 3 days"; touched.add(df.day); }
  }

  // ── 4. results and players ──
  for (const df of days.values()) {
    if (!df.field || df.void) { df.cuts = []; df.standing = []; df.winner = null; df.players = []; continue; }
    const res = L.cutsFrom(df.field, df.hours);
    df.cuts = res.cuts; df.standing = res.standing; df.winner = res.winner; df.done = res.done;
    // Each player's picks by offset (the contract keeps one pick per wallet per round).
    const by = new Map<string, Record<number, string>>();
    for (const [k, rows] of Object.entries(df.picks)) for (const [who, a] of rows) { let m = by.get(who); if (!m) by.set(who, (m = {})); m[Number(k)] = a; }
    const entrants = [...by.entries()].filter(([, m]) => m[0]);
    // Ranked flags are read again whenever the event moved this run, else kept from the last run.
    const ranked = touched.has(df.day) && entrants.length ? await rankedRead(entrants.map(([a]) => a)) : new Set<string>((df.players || []).filter((p) => p.ranked).map((p) => p.a));
    df.players = entrants.map(([a, m]) => ({ a, r: L.playerResult(df.field, res, m) })).filter((x) => x.r.entered).map(({ a, r }) => ({
      a, start: r.start, jumpTo: r.jumpTo, out: r.out, survived: r.survived, rode: r.rode, jumped: r.jumped, points: r.points, ranked: ranked.has(a),
    })).sort((x, y) => y.points - x.points || (x.a < y.a ? -1 : 1));
  }

  // ── 5. leaderboards ──
  const rowsOf = (pred: (df: DayFile) => boolean) => {
    const rows: any[] = [];
    for (const df of days.values()) if (pred(df) && !df.void) for (const p of df.players) rows.push({ player: p.a, points: p.points, rode: p.rode, jumped: p.jumped, ranked: p.ranked });
    return rows;
  };
  const view = (rows: any[]) => {
    const rk = new Set(rows.filter((x) => x.ranked).map((x) => x.player));
    return L.places(L.board(rows)).map((x: any) => ({ a: x.player, place: x.place, pts: x.pts, rides: x.rides, jumps: x.jumps, events: x.events, ranked: rk.has(x.player) }));
  };
  const nowW = L.weekOf(now.time), lw = nowW - 1;
  const inWeek = (w: number) => (df: DayFile) => df.week === w && df.start < now.time;
  let lastWeek: any = null;
  if (lw >= 0) {
    const evs = [...days.values()].filter(inWeek(lw));
    const complete = evs.length > 0 && evs.every((df) => df.done || df.void) && coversWeek(evs, lw, firstStart);
    lastWeek = { week: lw, start: L.weekStart(lw), final: now.time >= L.weekStart(nowW) + CORRECTION_MS && complete, rows: view(rowsOf(inWeek(lw))) };
  }
  const board = {
    v: 1, updated: new Date(now.time).toISOString(),
    today: { day: today.day, rows: view(rowsOf((df) => df.day === today.day)) },
    week: { week: nowW, start: L.weekStart(nowW), rows: view(rowsOf(inWeek(nowW))) },
    lastWeek,
    allTime: { rows: view(rowsOf((df) => df.start < now.time)) },
  };

  // ── the vault file (hand-off from the Vault v6 chat, 2026-10-28) ──
  // Once last week is final (12 h after it ends, inside the Vault's 3-day window): one file for the hourly bot to post.
  // rows: wallets staked in this game for that week with at least 1 point, scores keeping the board's order and ties.
  // first / second: empty (a staked game: no free prize). Not on the testnet (practice has no vault).
  let vault: any = null;
  if (!o.practice && lastWeek && lastWeek.final && now.time < L.weekStart(nowW) + 3 * L.DAY) {
    const players = lastWeek.rows.filter((r: any) => r.pts >= 1).map((r: any) => r.a);
    const staked = await (o.stakedOf ? o.stakedOf(lw, players) : stakedOnBoth((n) => readStakedV6(n, lw, players), o.p, o.check)).catch((e: Error) => { problems.push(`vault file for week ${lw}: ${e.message} (tried again next run)`); return null; });
    if (staked) vault = { game: L.GAME_ID, week: lw, final: true, rows: vaultScores(lastWeek.rows.filter((r: any) => staked.has(r.a))), first: [], second: [] };
    else if (!o.stakedOf) console.log(`week ${lw} is final; no vault file yet (the game contract has no per-game stakes before v6)`);
  }

  // ── 6. write ──
  fs.mkdirSync(OUT, { recursive: true });
  for (const df of days.values()) {
    if (!df.field && !df.void) continue;
    known.add(df.day);
    fs.writeFileSync(path.join(OUT, dName(df.day)), JSON.stringify(df) + "\n");
  }
  fs.writeFileSync(path.join(OUT, "index.json"), JSON.stringify({ v: 1, updated: new Date(now.time).toISOString(), days: [...known].sort(), contract: contract || null, game: L.GAME_ID, ...(o.practice ? { since } : {}) }) + "\n");
  fs.writeFileSync(path.join(OUT, "board.json"), JSON.stringify(board) + "\n");
  if (vault) { fs.mkdirSync(path.join(OUT, "vault"), { recursive: true }); fs.writeFileSync(path.join(OUT, "vault", `W${vault.week}.json`), JSON.stringify(vault) + "\n"); }
  for (const pr of problems) console.log(`::warning::${pr}`);
  return { problems, days, board, vault };
}

/** Every event of a week from the game's first recorded day on is present (recorded, finished or void); a week the
 *  game started in mid-week needs only its days from the first one. */
function coversWeek(evs: DayFile[], w: number, firstStart: number): boolean {
  const want = new Set<string>();
  const first = Math.min(firstStart, ...evs.map((e) => e.start));
  for (let t = L.weekStart(w); t < L.weekStart(w + 1); t += L.PERIOD) { const ev = L.eventOf(t); if (ev.start >= first && ev.start < L.weekStart(w + 1)) want.add(ev.day); }
  return [...want].every((d) => evs.some((e) => e.day === d));
}

// ── the testnet (testnet/lastnode.json) ──
export const MAINNET_CHAIN_ID = "EiBZK_GGVP0H_fXVAM3j6EAuz3-B-l3ejxRSewi7qIBfSA==";
/** The testnet settings, checked: the testnet chain (never mainnet), and games the Picks contract (time lock) accepts. */
export function readNetConfig(file: URL | string = new URL("../../testnet/lastnode.json", import.meta.url)) {
  const c = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!c || c.v !== 1 || c.network !== "koinos-foundation-testnet" || !Array.isArray(c.games) || !c.games.length) throw new Error("testnet/lastnode.json is not a testnet Last Node Standing config");
  if (c.chainId === MAINNET_CHAIN_ID) throw new Error("testnet/lastnode.json names the MAINNET chain id: refusing");
  for (const g of c.games) L0.forGame(g);   // throws on settings the contract would refuse
  return c;
}
/** The testnet Picks contract: the one Who Signs Block X's testnet settings name (one contract for both games). */
export function testnetPicks(file: URL | string = new URL("../../testnet/blockx.json", import.meta.url)): string | null {
  try { const b = JSON.parse(fs.readFileSync(file, "utf8")); return b && b.network === "koinos-foundation-testnet" && isAddr(b.picks) ? b.picks : null; } catch { return null; }
}
/** The race cards for the field, copied from the public race-data branch into dir (only plain week files). */
async function fetchRaceCards(base: string, dir: string, t: number) {
  fs.mkdirSync(dir, { recursive: true });
  const w = M.weekOf(t);
  for (const k of [w - 1, w, w + 1]) {
    if (k < 0) continue;
    try {
      const r = await fetch(`${base}${wName(k)}`, { cache: "no-store" } as any);
      if (!r.ok) continue;
      const j: any = await r.json();
      if (j && j.v === 1 && j.week === k && Array.isArray(j.races)) fs.writeFileSync(path.join(dir, wName(k)), JSON.stringify(j));
    } catch { /* that week isn't published */ }
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.includes("--testnet")) return run({ p: new Provider([RPC]), check: RPC_CHECK ? new Provider([RPC_CHECK]) : null });
  // Testnet practice: picks on the testnet Picks contract (test KOIN); the race on the real MAINNET producers, read only
  // (the testnet has a single producer). Never writes outside testnet-data/.
  const cfg = readNetConfig();
  const i = argv.indexOf("--game"), id = i >= 0 ? Number(argv[i + 1]) : cfg.games[0].id;
  const game = cfg.games.find((g: any) => g.id === id);
  if (!game) throw new Error(`game ${id} is not in testnet/lastnode.json`);
  const picks = testnetPicks();
  if (!picks) throw new Error("testnet/blockx.json has no testnet Picks contract yet (npm run picks -- upload --testnet --send)");
  const tp = new Provider([E.TESTNET_RPC || cfg.rpc]);
  const tChain = await withRetry("testnet chain id", () => tp.getChainId());
  if (tChain === MAINNET_CHAIN_ID || (cfg.chainId && tChain !== cfg.chainId)) throw new Error(`the node at ${cfg.rpc} is on chain ${tChain}, not the testnet in testnet/lastnode.json`);
  // The mainnet nodes for the blocks (MAINNET_RPC / MAINNET_RPC_CHECK, never .env.testnet's RPC).
  const mr = E.MAINNET_RPC || cfg.mainnet.rpc, mc = E.MAINNET_RPC_CHECK || cfg.mainnet.check;
  const p = new Provider([mr]), check = mc && mc !== "off" && mc !== mr ? new Provider([mc]) : null;
  for (const [node, url] of [[p, mr], [check, mc]] as const) if (node && (await withRetry("mainnet chain id", () => node.getChainId())) !== MAINNET_CHAIN_ID) throw new Error(`${url} is not a Koinos mainnet node (the race is read from mainnet)`);
  // Audit LN-26: the testnet's own names (TESTNET_…), so a mainnet LASTNODE_OUT / LASTNODE_PREV / RACE_DATA left in the
  // shell can't redirect it, and every folder must be inside testnet-data/.
  const inTestData = (d: string) => { const r = path.relative(path.resolve("testnet-data"), path.resolve(d)); if (!r || r.startsWith("..") || path.isAbsolute(r)) throw new Error(`${d} is not inside testnet-data/`); return d; };
  const raceDir = inTestData(E.TESTNET_RACE_DATA || "testnet-data/race-cards");
  await fetchRaceCards(cfg.mainnet.raceData, raceDir, Date.now());
  const koin = new Contract({ id: cfg.koin, abi: (await import("koilib")).utils.tokenAbi, provider: tp });
  // Ranked on the testnet: holds at least 1 test KOIN (test wallets have no VHP).
  const rankedOf = async (who: string[]) => {
    const out = new Set<string>();
    for (const a of who) { try { const b: any = await (koin.functions as any).balanceOf({ owner: a }); if (BigInt(b?.result?.value || "0") >= ONE_VHP) out.add(a); } catch { /* not ranked */ } }
    return out;
  };
  const dir = `testnet-data/lastnode-${id}`;
  return run({ p, check, pp: tp, pcheck: null, game, practice: true, picksContract: picks, rankedOf, raceDir, out: inTestData(E.TESTNET_LASTNODE_OUT || dir), prev: inTestData(E.TESTNET_LASTNODE_PREV || dir) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

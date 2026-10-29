/**
 * Combo Card recorder (run every hour by .github/workflows/combo.yml; read-only on the chain, holds no key).
 *
 * Each run:
 *  1. Cards. A wallet has 3 card slots a UTC day (Picks game 8, round = day × 3 + slot). Every slot of this week and
 *     last week that isn't fixed yet is read from the Picks contract on two independent nodes (RPC and RPC_CHECK),
 *     which must agree (audit CC-B1: an outage or a mid-week start never leaves a slot unread). The contract lets a
 *     card be made or changed only on its own day, so once the last irreversible block on BOTH nodes is past the end
 *     of that day (CC-B11), the slot is FIXED: stored, and never read again.
 *  2. Prices. Each leg is priced (site/combo-math.js, the same file the page runs) with the Producer Race card in force
 *     when the card was last sent: the latest race card taken at or before that time (race-data). A card is priced
 *     only once race-data holds a card taken AFTER it was sent, so the card in force is known for sure (CC-B2, CC-B3:
 *     a late or missing race file makes it wait, never void it). For scoring, each leg is worth the lower of that and
 *     its worth on the card in force when the leg locks (CC-B5). A card sent before any race card existed is void.
 *  3. Results. Race legs from the race recorder's final standings (race-data), Block X legs from the Block X recorder's
 *     final targets (games-data/blockx). A card is final when its slot is fixed and every leg and worth is known.
 *     DEADLINE (CC-B4): two days after the card's week ends, anything still unknown is void (a leg without a result
 *     is dropped; a card still unpriced is void), so the week's Vault file is always ready inside the Vault's 3 days.
 *  4. Players. A player counts for the week only with at least 1 VHP staked in the Combo Card that week (the owner's
 *     player rule; the Vault checks it again). Until the Vault (v6) can be read, a player's stake is "unknown" (null).
 *  5. Weeks. A card counts in the KnodeGames week of its slot day. A player's week = the sum of their best 10 cards.
 *     The week is final 12 hours after it ends, once every card of it is final (Sunday's cards settle by about Monday
 *     24:00 UTC). Then the Vault file vault/W<week>.json is written: players with at least 1 point, mapped onto 1..255.
 *  6. Writes games-data/combo/index.json, W<week>.json (cards), board.json (Today, This week, Last week, All time) and
 *     vault/W<week>.json; the workflow puts them on the games-data branch.
 *
 *   RPC, RPC_CHECK ("off" to skip the second node), COMBO_PREV (last run's files), COMBO_OUT, RACE_DATA (race files),
 *   BLOCKX_DATA (Block X files).      npm run combo        (or: npx tsx bot/games/combo.ts)
 */
import { Provider, Contract } from "koilib";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { withRetry } from "../../common.ts";
await import("../../site/race-math.js");
await import("../../site/blockx-math.js");
await import("../../site/combo-math.js");
const M: any = (globalThis as any).KRaceMath;
const X: any = (globalThis as any).KBlockX;
const C: any = (globalThis as any).KCombo;

const E = process.env;
const RPC = E.RPC || "https://koinos.armana.io";
const RPC_CHECK = E.RPC_CHECK && E.RPC_CHECK !== "off" && E.RPC_CHECK !== RPC ? E.RPC_CHECK : "";
const DEADLINE_MS = 2 * M.DAY;               // after the card's week ends: unknown results and prices are void then
const CORRECTION_MS = 12 * 3600000;          // a week is final 12 hours after it ends (once every card is final)
const ONE_VHP = 100000000n;
const isAddr = (a: unknown) => typeof a === "string" && /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a);

export type RawLeg = { code: number; round: number; producer: string };
export type RawCard = { player: string; legs: RawLeg[]; time: number; height: number; changes: number };
/** A recorded leg: [code, round, producer, worth (hundredths, or 0 if it can't be priced), result]. */
type Leg = [number, number, string, number, string];
type Card = {
  player: string; round: number; time: number; changes: number; priceAt: number | null;
  legs: Leg[]; state: "pending" | "final"; outcome: string | null; pts: number; settled: number;
};
type Slot = { round: number; fixed: boolean; cards: Card[] };
type WeekFile = { v: 1; week: number; start: number; end: number; slots: Slot[] };
type Head = { height: number; time: number; lib: number; libTime: number };
type Opts = {
  p: any; check: any | null; prev?: string; out?: string; raceDir?: string; blockxDir?: string;
  picksContract?: string | null;                                              // default: picks-data/deployment.json
  cardsOf?: (node: any, round: number) => Promise<RawCard[]>;                 // for the tests
  stakedOf?: (week: number, who: string[]) => Promise<Map<string, boolean> | null>;
  head?: Head;
};

// ── files ──
const memo = new Map<string, any>();         // each input file is read once per run (audit CC-B8); cleared by run()
function readJson(dir: string | undefined, name: string): any {
  if (!dir) return null;
  const f = path.join(dir, name);
  if (memo.has(f)) return memo.get(f);
  let v: any = null;
  try { if (!fs.lstatSync(f).isSymbolicLink()) v = JSON.parse(fs.readFileSync(f, "utf8")); } catch { v = null; }
  memo.set(f, v);
  return v;
}
const wName = (w: number) => `W${String(w).padStart(3, "0")}.json`;
const legOk = (l: any) => Array.isArray(l) && l.length === 5 && C.CODES.includes(l[0]) && Number.isSafeInteger(l[1]) && isAddr(l[2]) && Number.isSafeInteger(l[3]) && typeof l[4] === "string";
function cardOk(c: any): boolean {
  return !!c && isAddr(c.player) && Number.isSafeInteger(c.round) && Number.isSafeInteger(c.time) && Array.isArray(c.legs) && c.legs.length >= C.MIN_LEGS &&
    c.legs.length <= C.HARD_MAX_LEGS && c.legs.every(legOk) && (c.state === "pending" || c.state === "final") && Number.isSafeInteger(c.pts);
}
function loadWeek(dir: string | undefined, w: number): WeekFile {
  const fresh: WeekFile = { v: 1, week: w, start: M.weekStart(w), end: M.weekStart(w + 1), slots: [] };
  const old = readJson(dir, wName(w));
  if (!old || old.v !== 1 || old.week !== w || !Array.isArray(old.slots)) return fresh;
  // Only fixed slots carry over (open ones are read again), and only with well-formed cards of that slot; one entry
  // per slot and one card per player in it; a final card's outcome and points are recounted from its legs (CC-B7).
  const seen = new Set<number>();
  for (const sl of old.slots) {
    if (!(sl && sl.fixed === true && Number.isSafeInteger(sl.round) && !seen.has(sl.round) && Array.isArray(sl.cards) &&
      sl.cards.every((c: any) => cardOk(c) && c.round === sl.round) && M.weekOf(C.dayOfRound(sl.round) * M.DAY) === w)) continue;
    const players = new Set(sl.cards.map((c: any) => c.player));
    if (players.size !== sl.cards.length) continue;
    seen.add(sl.round);
    for (const c of sl.cards) if (c.state === "final") { const r = c.priceAt === null ? { outcome: "void", pts: 0 } : recount(c.legs); c.outcome = r.outcome; c.pts = r.pts; }
    fresh.slots.push({ round: sl.round, fixed: true, cards: sl.cards });
  }
  fresh.slots.sort((a, b) => a.round - b.round);
  return fresh;
}
/** A final card's outcome and points from its legs alone (worths and results). */
function recount(legs: Leg[]): { outcome: string; pts: number } {
  const kept = legs.filter((l) => l[4] !== "void");
  if (kept.length < C.MIN_LEGS) return { outcome: "void", pts: 0 };
  if (kept.some((l) => l[4] !== "hit" || !(l[3] > 0))) return { outcome: "miss", pts: 0 };
  return { outcome: "hit", pts: C.pointsFor(kept.map((l) => l[3])) };
}
function defaultPicksContract(): string | null {
  try { const d = JSON.parse(fs.readFileSync(new URL("../../picks-data/deployment.json", import.meta.url), "utf8")); return isAddr(d.contract) ? d.contract : null; } catch { return null; }
}

// ── chain reads ──
async function headOf(node: any): Promise<Head> {
  const h: any = await withRetry("head", () => node.getHeadInfo());
  const lib = Number(h.last_irreversible_block);
  const res: any = await withRetry(`block ${lib}`, () => node.call("block_store.get_blocks_by_height", { head_block_id: h.head_topology.id, ancestor_start_height: String(lib), num_blocks: 1, return_block: true, return_receipt: false }));
  const it = res?.block_items?.[0];
  if (!it || Number(it.block_height) !== lib) throw new Error(`block ${lib} not returned`);
  return { height: Number(h.head_topology.height), time: Number(h.head_block_time), lib, libTime: Number(it.block.header.timestamp) };
}
const PICKS_ABI = () => JSON.parse(fs.readFileSync(new URL("../../picks/abi/picks.koilib.json", import.meta.url), "utf8"));
async function readCards(node: any, contract: string, round: number): Promise<RawCard[]> {
  const c = new Contract({ id: contract, abi: PICKS_ABI(), provider: node });
  const out: RawCard[] = [];
  let after: string | undefined;
  for (let page = 0; page < 1000; page++) {
    const r: any = await withRetry(`cards for slot ${round}`, () => (c.functions as any).list_picks({ game: C.GAME_ID, round: String(round), ...(after ? { start_after: after } : {}), limit: 100 }));
    const rows = r?.result?.rows ?? [];
    for (const x of rows) {
      const legs = (x.pick?.legs ?? []).map((l: any) => ({ code: Number(l.code), round: Number(l.round), producer: String(l.producer) }));
      if (isAddr(x.player)) out.push({ player: x.player, legs, time: Number(x.pick?.time || 0), height: Number(x.pick?.height || 0), changes: Number(x.pick?.changes || 0) });
    }
    if (rows.length < 100) break;
    after = rows[rows.length - 1].player;
  }
  return out;
}
/** Who is staked in the Combo Card for a week, from the Vault (v6) once its ABI has get_game_player; null before. */
const GAME = (() => { try { return JSON.parse(fs.readFileSync(new URL("../../game-data/deployment.json", import.meta.url), "utf8")).contract as string; } catch { return ""; } })();
async function readStaked(node: any, week: number, who: string[]): Promise<Map<string, boolean> | null> {
  let abi: any;
  try { abi = JSON.parse(fs.readFileSync(new URL("../../game/abi/kpred.koilib.json", import.meta.url), "utf8")); } catch { return null; }
  if (!GAME || !abi?.methods?.get_game_player) return null;
  const c = new Contract({ id: GAME, abi, provider: node });
  const out = new Map<string, boolean>();
  for (const a of who) {
    const r: any = await withRetry(`Combo stake of ${a}`, () => (c.functions as any).get_game_player({ player: a, game: C.GAME_ID, week: String(week) }));
    out.set(a, BigInt(r?.result?.week_stake || "0") >= ONE_VHP);
  }
  return out;
}

// ── results from the other recorders ──
function raceRecord(raceDir: string | undefined, round: number): any | null {
  const start = M.raceStart(round), wf = readJson(raceDir, wName(M.weekOf(start)));
  return wf && Array.isArray(wf.races) ? wf.races.find((r: any) => r && r.id === M.raceId(round)) ?? null : null;
}
function racesAround(raceDir: string | undefined, t: number): any[] {
  const w = M.weekOf(t), out: any[] = [];
  for (const k of [w - 1, w]) { const wf = readJson(raceDir, wName(k)); if (wf && Array.isArray(wf.races)) out.push(...wf.races); }
  return out;
}
/** The race-data files hold a card taken after time t: the card in force at t is then known for sure. */
function racesPast(raceDir: string | undefined, t: number): boolean {
  for (const k of [M.weekOf(t), M.weekOf(t) + 1]) {
    const wf = readJson(raceDir, wName(k));
    if (wf && Array.isArray(wf.races)) for (const r of wf.races) for (const c of (r && Array.isArray(r.cards) ? r.cards : [])) if (c && Number.isFinite(c.at) && c.at > t) return true;
  }
  return false;
}
/** A race-data file exists for the week of time t (else: an outage, never a reason to void). */
const raceWeekKnown = (raceDir: string | undefined, t: number) => { const wf = readJson(raceDir, wName(M.weekOf(t))); return !!(wf && Array.isArray(wf.races)); };
const bxWeekKnown = (bxDir: string | undefined, t: number) => { const wf = readJson(bxDir, wName(M.weekOf(t))); return !!(wf && Array.isArray(wf.targets)); };
function cardAtTime(raceDir: string | undefined, t: number): any | null {
  return C.priceCard([...racesAround(raceDir, t), ...racesAround(raceDir, t + 7 * M.DAY)], t);
}
function blockTargets(blockxDir: string | undefined, weeks: number[]): Map<number, any> {
  const m = new Map<number, any>();
  for (const w of weeks) { const wf = readJson(blockxDir, wName(w)); if (wf && Array.isArray(wf.targets)) for (const t of wf.targets) if (t && Number.isInteger(t.round)) m.set(t.round, t); }
  return m;
}

/** One run. Exported for the tests, which pass fake nodes and files. */
export async function run(o: Opts) {
  const OUT = o.out ?? E.COMBO_OUT ?? "games-data/combo";
  const PREV = o.prev ?? E.COMBO_PREV ?? "";
  const RACE = o.raceDir ?? E.RACE_DATA ?? "";
  const BX = o.blockxDir ?? E.BLOCKX_DATA ?? "";
  const problems: string[] = [], errors: string[] = [];
  const contract = o.picksContract === undefined ? defaultPicksContract() : o.picksContract;
  memo.clear();
  const head = o.head ?? (await headOf(o.p));
  // Slots are fixed only when BOTH nodes are irreversibly past the day (audit CC-B11).
  let libTime = head.libTime;
  if (!o.head && o.check) { try { libTime = Math.min(libTime, (await headOf(o.check)).libTime); } catch (e) { problems.push(`second node: ${(e as Error).message}; no slot fixed this run`); libTime = 0; } }
  const cardsRead = o.cardsOf ?? (contract ? (node: any, r: number) => readCards(node, contract, r) : null);
  const stakedRead = o.stakedOf ?? ((w: number, who: string[]) => readStaked(o.p, w, who));
  console.log(`head ${head.height} (${new Date(head.time).toISOString()}), irreversible ${head.lib} (${new Date(head.libTime).toISOString()})`);

  const weeks = new Map<number, WeekFile>();
  // A slot from a previous file counts as fixed only if its day really is irreversibly over on both nodes (FC-3).
  const weekFor = (w: number) => {
    let f = weeks.get(w);
    if (!f) { f = loadWeek(PREV, w); for (const sl of f.slots) if (libTime < (C.dayOfRound(sl.round) + 1) * M.DAY) sl.fixed = false; weeks.set(w, f); }
    return f;
  };
  const idx = readJson(PREV, "index.json");
  const known = new Set<number>(Array.isArray(idx?.weeks) ? idx.weeks.filter((w: any) => Number.isInteger(w) && w >= 0 && w < 10000) : []);
  const nowW = M.weekOf(head.time), today = C.utcDay(head.time);
  for (const w of [nowW - 1, nowW]) if (w >= 0) weekFor(w);
  const bxWeeks = [nowW - 2, nowW - 1, nowW].filter((w) => w >= 0);
  const targets = blockTargets(BX, bxWeeks);

  // ── 1. cards: read every slot of last week and this week that isn't fixed yet (audit CC-B1) ──
  if (cardsRead) {
    for (let day = C.utcDay(M.weekStart(Math.max(0, nowW - 1))); day <= today; day++) {
      const wf = weekFor(M.weekOf(day * M.DAY));
      for (let s = 0; s < C.CARDS_PER_DAY; s++) {
        const round = C.slotRound(day, s);
        if (wf.slots.some((x) => x.round === round && x.fixed)) continue;
        try {
          const fixed = libTime >= (day + 1) * M.DAY;
          const raw = await cardsRead(o.p, round);
          if (o.check) {
            const other = await cardsRead(o.check, round);
            const key = (x: RawCard[]) => JSON.stringify([...x].sort((u, v) => (u.player < v.player ? -1 : 1)));
            if (key(raw) !== key(other)) { problems.push(`slot ${round}: the two nodes disagree about the cards; read again next run`); continue; }
          }
          const cards: Card[] = [];
          for (const x of raw) {
            if (!Array.isArray(x.legs) || x.legs.length < C.MIN_LEGS || x.legs.length > C.HARD_MAX_LEGS || !x.legs.every((l) => C.CODES.includes(l.code) && isAddr(l.producer))) {
              problems.push(`slot ${round}: a card of ${x.player} has a leg this recorder doesn't know; left out`); continue;
            }
            // Priced in step 2, once race-data is known to be complete for the time it was sent.
            const legs: Leg[] = x.legs.map((l) => [l.code, l.round, l.producer, 0, "pending"]);
            cards.push({ player: x.player, round, time: x.time, changes: x.changes, priceAt: null, legs, state: "pending", outcome: null, pts: 0, settled: 0 });
          }
          wf.slots = wf.slots.filter((x) => x.round !== round).concat([{ round, fixed, cards }]).sort((a, b) => a.round - b.round);
          if (cards.length) console.log(`slot ${round} (${M.dayOf(day * M.DAY)} #${s + 1}): ${cards.length} card(s)${fixed ? ", fixed" : ""}`);
        } catch (e) { problems.push(`slot ${round}: ${(e as Error).message} (read again next run)`); }
      }
    }
  }

  // ── 2–3. prices and results: every card not final yet ──
  for (const w of new Set([...weeks.keys()])) for (const sl of weekFor(w).slots) for (const c of sl.cards) {
    if (c.state === "final") continue;
    const deadline = M.weekStart(M.weekOf(C.dayOfRound(c.round) * M.DAY) + 1) + DEADLINE_MS;
    const late = head.time >= deadline;
    const legs = c.legs.map((l) => ({ code: l[0], round: l[1], producer: l[2] }));
    // The price: the race card in force when the card was sent, once race-data is complete past that moment.
    let send: any = null;
    // An outage (no race-data file for the week the card was sent) never voids: wait, and warn (audit FC-1).
    if (!raceWeekKnown(RACE, c.time)) { (late ? errors : problems).push(`slot ${c.round}: no race-data for ${M.dayOf(c.time)}; ${c.player}'s card waits`); continue; }
    if (racesPast(RACE, c.time)) {
      send = cardAtTime(RACE, c.time);
      if (!send) {                                     // sent before any race card existed: nothing to price it with
        c.priceAt = null; c.outcome = "void"; c.pts = 0;
        if (sl.fixed) { c.state = "final"; c.settled = c.time; }
        continue;
      }
      c.priceAt = send.at;
    } else if (late) {
      // race-data is there but never caught up past the send time: void, recorded so a recount agrees (FC-1).
      c.priceAt = null; c.outcome = "void"; c.pts = 0;
      c.legs.forEach((l) => { l[4] = "void"; });
      if (sl.fixed) { c.state = "final"; c.settled = deadline; }
      problems.push(`slot ${c.round}: ${c.player}'s card could not be priced by the deadline; void`);
      continue;
    } else { continue; }                               // race-data not complete yet: wait
    // Each leg: its result (void if still unknown at the deadline) and its worth (the lower of send and lock).
    let ready = true, decided = 0, outage = false;
    c.legs.forEach((l, i) => {
      const leg = legs[i], isRace = C.FAMILY[l[0]] === "race", t = isRace ? null : targets.get(l[1]) ?? null;
      let r = isRace ? C.legResult(leg, raceRecord(RACE, l[1]), null) : C.legResult(leg, null, t);
      if (r === "pending" && late) {
        // Void at the deadline only if the source file for that leg is there (an outage waits instead: FC-1).
        const known = isRace ? raceWeekKnown(RACE, M.raceStart(l[1])) : bxWeekKnown(BX, head.time + (X.target(l[1]) - head.height) * X.BLOCK_MS);
        if (known) r = "void"; else { errors.push(`slot ${c.round}: no ${isRace ? "race" : "Block X"} file for a leg of ${c.player}'s card; waits`); outage = true; }
      }
      l[4] = r;
      const sendWorth = C.priceLeg(send, leg);
      if (!sendWorth) { l[3] = 0; return; }                         // a horse not in the field when sent: a miss
      const targetTime = t && Number.isFinite(t.time) ? t.time : head.time + (X.target(l[1]) - head.height) * X.BLOCK_MS;
      const lockAt = C.legLockTime(leg, targetTime);
      if (r === "void") { l[3] = sendWorth.f100; return; }
      if (racesPast(RACE, lockAt)) l[3] = C.finalWorth(send, cardAtTime(RACE, lockAt), leg);
      else if (late) l[3] = sendWorth.f100;
      else { l[3] = sendWorth.f100; ready = false; }
      if (r === "pending") ready = false;
      decided = Math.max(decided, isRace ? M.raceStart(l[1]) + M.RACE : targetTime);
    });
    const r = recount(c.legs);
    const pending = c.legs.some((l) => l[4] === "pending");
    c.outcome = pending ? (c.legs.some((l) => l[4] === "miss" || (l[4] !== "void" && !(l[3] > 0) && l[4] !== "pending")) ? "miss" : null) : r.outcome;
    // Final once the slot is fixed (no more changes), every leg is known and every worth is settled.
    if (sl.fixed && !pending && ready && !outage) { c.state = "final"; c.outcome = r.outcome; c.pts = r.pts; c.settled = decided || c.time; }
    else c.pts = 0;
  }

  // ── 4–5. players, boards and the Vault ──
  const all = new Map(weeks);
  for (const w of known) if (!all.has(w)) all.set(w, loadWeek(PREV, w));
  // by "slot": cards of slots in [from, to) (a week counts the cards made in it); by "settled": cards decided then (Today).
  const cardRows = (from: number, to: number, by: "slot" | "settled" = "slot") => {
    const rows: any[] = [];
    for (const wf of all.values()) for (const sl of wf.slots) {
      const t = C.dayOfRound(sl.round) * M.DAY;
      if (by === "slot" && (t < from || t >= to)) continue;
      for (const c of sl.cards) if (c.state === "final" && c.outcome !== "void" && (by === "slot" || (c.settled >= from && c.settled < to))) rows.push({ player: c.player, round: c.round, pts: c.pts, hit: c.outcome === "hit", lastLegTime: c.settled });
    }
    return rows;
  };
  // Stakes per (week, player): each wallet is read once per week per run, whichever board asks first (audit CC-B6).
  const stakeCache = new Map<number, Map<string, boolean> | null>();
  async function stakes(w: number, who: string[]) {
    let m = stakeCache.get(w);
    if (m === null) return null;
    const missing = who.filter((a) => !m || !m.has(a));
    if (!m || missing.length) {
      try {
        const got = await stakedRead(w, missing);
        if (got === null) { stakeCache.set(w, null); return null; }
        m = m ?? new Map(); for (const [a, v] of got) m.set(a, v); stakeCache.set(w, m);
      } catch (e) { problems.push(`stakes for week ${w}: ${(e as Error).message}`); stakeCache.set(w, null); return null; }
    }
    return m!;
  }
  const view = async (rows: any[], w: number | null) => {
    const ranked = C.places(C.board(rows));
    const st = w === null ? null : await stakes(w, ranked.map((x: any) => x.player));
    return ranked.map((x: any) => {
      const staked = st ? st.get(x.player) ?? false : null;
      return { a: x.player, place: x.place, pts: x.pts, hits: x.hits, cards: x.cards, best: x.best, days: x.days, lastHit: x.lastHit, staked, ranked: staked !== false };
    });
  };
  const day0 = today * M.DAY, lw = nowW - 1;
  const weekDone = (w: number) => { const wf = all.get(w); if (!wf) return false; const days = 7 * C.CARDS_PER_DAY; return wf.slots.filter((s) => s.fixed).length === days && wf.slots.every((s) => s.cards.every((c) => c.state === "final")); };
  let lastWeek: any = null;
  if (lw >= 0) {
    const final = head.time >= M.weekStart(nowW) + CORRECTION_MS && weekDone(lw);
    lastWeek = { week: lw, start: M.weekStart(lw), final, rows: await view(cardRows(M.weekStart(lw), M.weekStart(nowW)), lw) };
  }
  const board = {
    v: 1, updated: new Date(head.time).toISOString(),
    today: { day: M.dayOf(head.time), rows: await view(cardRows(day0, day0 + M.DAY, "settled"), nowW) },
    week: { week: nowW, start: M.weekStart(nowW), rows: await view(cardRows(M.weekStart(nowW), M.weekStart(nowW + 1)), nowW) },
    lastWeek,
    allTime: { rows: await view(cardRows(0, Infinity), null) },
  };

  // ── 6. write ──
  fs.mkdirSync(path.join(OUT, "vault"), { recursive: true });
  for (const [w, wf] of weeks) {
    if (!wf.slots.some((s) => s.cards.length || s.fixed)) continue;
    known.add(w);
    fs.writeFileSync(path.join(OUT, wName(w)), JSON.stringify(wf) + "\n");
  }
  // The Vault file for each final week the prev run hadn't written yet (and last week's, rewritten while final).
  const vaultWritten: number[] = [];
  if (lastWeek && lastWeek.final) {
    const rows = lastWeek.rows.map((r: any) => ({ player: r.a, pts: r.pts, staked: r.staked }));
    fs.writeFileSync(path.join(OUT, "vault", `W${lw}.json`), JSON.stringify(C.vaultFile(lw, true, rows)) + "\n");
    vaultWritten.push(lw);
    console.log(`week ${lw} final: vault/W${lw}.json with ${C.vaultFile(lw, true, rows).rows.length} player(s)`);
  }
  fs.writeFileSync(path.join(OUT, "index.json"), JSON.stringify({ v: 1, updated: new Date(head.time).toISOString(), weeks: [...known].sort((a, b) => a - b), contract: contract || null }) + "\n");
  fs.writeFileSync(path.join(OUT, "board.json"), JSON.stringify(board) + "\n");
  // FC-4: last week's slots still not fixed a day after the week ended means its Vault file is at risk.
  if (lw >= 0 && head.time >= M.weekStart(nowW) + M.DAY) {
    const open = (all.get(lw)?.slots.filter((s) => s.fixed).length ?? 0);
    if (open < 7 * C.CARDS_PER_DAY) errors.push(`week ${lw}: only ${open} of ${7 * C.CARDS_PER_DAY} card slots are fixed a day after the week ended; check the nodes (the Vault needs the file within 3 days)`);
  }
  for (const pr of problems) console.log(`::warning::${pr}`);
  for (const er of errors) console.log(`::error::${er}`);
  return { problems, errors, weeks, board, vaultWritten };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run({ p: new Provider([RPC]), check: RPC_CHECK ? new Provider([RPC_CHECK]) : null }).catch((e) => { console.error(e); process.exit(1); });
}

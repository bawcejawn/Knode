/**
 * Combo Card recorder (run every hour by .github/workflows/combo.yml; read-only on the chain, holds no key).
 *
 * Each run:
 *  1. Settings. Game 8 on the Picks contract (both nodes) must be a card game whose leg types have exactly the locks
 *     this recorder and the page use (combo-math.js). Otherwise nothing is recorded (Repo Lens RL-25, as Block X BX-33).
 *  2. Cards. A wallet has 3 card slots a UTC day (round = day × 3 + slot). EVERY slot of last week and this week is read
 *     from the Picks contract on two independent nodes (RPC and RPC_CHECK) each run, and they must agree. Nothing from
 *     an earlier run's files is trusted for those two weeks (Repo Lens RL-7): a slot whose read fails this run keeps
 *     the earlier copy only for display, and its week can't turn final. A slot is FIXED once the last irreversible
 *     block on BOTH nodes is past the end of its day (the contract allows changes only on that day).
 *  3. Prices (combo-math.js, the same file the page runs). Each leg is priced with the usable race card in force when
 *     the card was last sent: taken at most 3 hours before, from at least 12 VHP samples, nothing flagged (Repo Lens
 *     RL-8, Block X's rule). A card is priced only once race-data holds a card taken AFTER it was sent (CC-B2). No usable
 *     card then: the card is void. For scoring, a leg that hits (or may still) is checked against the card in force at
 *     its lock and, for Block X, the first card after the block, with any VHP moved into the producer between its lock
 *     card and the block added (read from the chain's receipts on both nodes, the higher wins: Block X's BX-53; Repo
 *     Lens RL-2). The lowest of those is the worth if it is more than 10% below the worth when sent (owner: 10%).
 *  4. Results. Race legs from the race recorder's final standings (race-data), Block X legs from the Block X recorder's
 *     final targets (games-data/blockx): the signer the two nodes agreed on decides the leg even when Block X voided the
 *     target for its own scoring (Repo Lens RL-3).
 *     DEADLINE (CC-B4): two days after the card's week ends by BOTH nodes' clocks (the slower one), checked against
 *     this machine's clock (Repo Lens RL-5), a leg still without a result is void, but only when its source has
 *     published something after it (a later race with a result, a later Block X target). Otherwise its recorder has
 *     stopped: the card waits and an error is raised, never a silent void (Repo Lens RL-9).
 *  5. Players. Only wallets with at least the vault's minimum (1 VHP) staked in the Combo Card that week count (the
 *     owner's player rule). Stakes are read from the Vault (v6) through its own ABI after its get_state check, on both
 *     nodes; the lower read wins (Repo Lens RL-4). Unknown stakes: no Vault file this run.
 *  6. Weeks. A card counts in the KnodeGames week of its slot day; a player's week = the sum of their best 10 cards.
 *     The week is final 12 hours after it ends, once every slot of it is fixed and every card final. Then the Vault
 *     file vault/W<week>.json is written ONCE (never again once published), within the Vault's 3 days.
 *  7. Writes games-data/combo/index.json, D<day>.json (one file per UTC day: Repo Lens RL-6, so no file nears the
 *     publish job's 2 MB limit), board.json and vault/W<week>.json; the workflow checks and publishes them.
 *
 *   RPC, RPC_CHECK, COMBO_PREV (last run's files), COMBO_OUT, RACE_DATA (race files), BLOCKX_DATA (Block X files).
 *   npm run combo. The run exits 1 after writing its files when it raised an error (Repo Lens RL-5).
 */
import { Provider, Contract } from "koilib";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { withRetry, MAINNET_VHP } from "../../common.ts";
import { vaultReader, scoringVhpMoves, NonCanonicalTransfer, MOVE_MARGIN } from "./blockx.ts";
await import("../../race-math.js");
await import("../../blockx-math.js");
await import("../../combo-math.js");
const M: any = (globalThis as any).KRaceMath;
const X: any = (globalThis as any).KBlockX;
const C: any = (globalThis as any).KCombo;

const E = process.env;
const DEADLINE_MS = 2 * M.DAY;               // after the card's week ends: unknown results are void then (see 4.)
const CORRECTION_MS = 12 * 3600000;          // a week is final 12 hours after it ends (once every card is final)
const VAULT_WINDOW_MS = 3 * M.DAY;           // the Vault takes a week's file within 3 days of its end
const CLOCK_SLACK_MS = 10 * 60000;           // the nodes' time may run this far ahead of this machine's clock
const isAddr = (a: unknown) => typeof a === "string" && /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a);
const MAINNET_KNODE_GAME = (() => { try { return JSON.parse(fs.readFileSync(new URL("../../game-data/deployment.json", import.meta.url), "utf8")).contract as string; } catch { return ""; } })();

export type RawLeg = { code: number; round: number; producer: string };
export type RawCard = { player: string; legs: RawLeg[]; time: number; height: number; changes: number };
/** A recorded leg: [code, round, producer, worth (hundredths, or 0 if it can't be priced), result]. */
type Leg = [number, number, string, number, string];
type Card = {
  player: string; round: number; time: number; changes: number; priceAt: number | null;
  legs: Leg[]; state: "pending" | "final"; outcome: string | null; pts: number; settled: number;
};
type Slot = { round: number; fixed: boolean; cards: Card[] };
type WeekView = { week: number; start: number; end: number; slots: Slot[] };
type DayFile = { v: 2; day: number; start: number; slots: Slot[] };
type Head = { height: number; time: number; lib: number; libTime: number };
type Opts = {
  p: any; check: any | null; prev?: string; out?: string; raceDir?: string; blockxDir?: string;
  picksContract?: string | null;                                              // default: picks-data/deployment.json
  knodeGame?: string | null;                                                  // the Vault (v6); default: game-data/deployment.json
  cardsOf?: (node: any, round: number) => Promise<RawCard[]>;                 // tests
  /** Tests: who is staked in the Combo Card for a week (null: unknown). Replaces the two-node Vault read. */
  stakedOf?: (week: number, who: string[]) => Promise<Map<string, boolean> | null>;
  /** Tests: VHP moved into `who` in blocks from..to on `node` (Block X's scoringVhpMoves). */
  vhpMovesOf?: (node: any, who: string, from: number, to: number) => Promise<bigint>;
  head?: Head;                                                                 // tests: the agreed head (two nodes when `check` is set)
  now?: number;                                                                // tests: this machine's clock
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
export const dName = (day: number) => `D${String(day).padStart(5, "0")}.json`;
const legOk = (l: any) => Array.isArray(l) && l.length === 5 && C.CODES.includes(l[0]) && Number.isSafeInteger(l[1]) && isAddr(l[2]) && Number.isSafeInteger(l[3]) && typeof l[4] === "string";
function cardOk(c: any): boolean {
  return !!c && isAddr(c.player) && Number.isSafeInteger(c.round) && Number.isSafeInteger(c.time) && Array.isArray(c.legs) && c.legs.length >= C.MIN_LEGS &&
    c.legs.length <= C.HARD_MAX_LEGS && c.legs.every(legOk) && (c.state === "pending" || c.state === "final") && Number.isSafeInteger(c.pts);
}
/** An earlier run's day file: its well-formed slots of that day (one entry per slot, one card per player), each final
 *  card recounted from its legs. Used only for days before last week (the all-time board) and, for display only, for a
 *  slot whose chain read failed this run (never fixed then: Repo Lens RL-7). */
function loadDay(dir: string | undefined, day: number): Slot[] {
  const old = readJson(dir, dName(day));
  if (!old || old.v !== 2 || old.day !== day || !Array.isArray(old.slots)) return [];
  const out: Slot[] = [], seen = new Set<number>();
  for (const sl of old.slots) {
    if (!(sl && Number.isSafeInteger(sl.round) && C.dayOfRound(sl.round) === day && !seen.has(sl.round) && Array.isArray(sl.cards) &&
      sl.cards.every((c: any) => cardOk(c) && c.round === sl.round))) continue;
    if (new Set(sl.cards.map((c: any) => c.player)).size !== sl.cards.length) continue;
    seen.add(sl.round);
    for (const c of sl.cards) if (c.state === "final") { const r = c.priceAt === null ? { outcome: "void", pts: 0 } : recount(c.legs); c.outcome = r.outcome; c.pts = r.pts; }
    out.push({ round: sl.round, fixed: sl.fixed === true, cards: sl.cards });
  }
  return out.sort((a, b) => a.round - b.round);
}
/** A final card's outcome and points from its legs alone (worths and results). */
export function recount(legs: Leg[]): { outcome: string; pts: number } {
  const kept = legs.filter((l) => l[4] !== "void");
  if (kept.length < C.MIN_LEGS) return { outcome: "void", pts: 0 };
  if (kept.some((l) => l[4] !== "hit" || !(l[3] > 0))) return { outcome: "miss", pts: 0 };
  return { outcome: "hit", pts: C.pointsFor(kept.map((l) => l[3])) };
}
function defaultPicksContract(): string | null {
  try { const d = JSON.parse(fs.readFileSync(new URL("../../picks-data/deployment.json", import.meta.url), "utf8")); return isAddr(d.contract) ? d.contract : null; } catch { return null; }
}

// ── chain reads ──
async function headOf(node: any): Promise<Head & { id: string }> {
  const h: any = await withRetry("head", () => node.getHeadInfo());
  const lib = Number(h.last_irreversible_block);
  const res: any = await withRetry(`block ${lib}`, () => node.call("block_store.get_blocks_by_height", { head_block_id: h.head_topology.id, ancestor_start_height: String(lib), num_blocks: 1, return_block: true, return_receipt: false }));
  const it = res?.block_items?.[0];
  if (!it || Number(it.block_height) !== lib) throw new Error(`block ${lib} not returned`);
  return { id: String(h.head_topology.id), height: Number(h.head_topology.height), time: Number(h.head_block_time), lib, libTime: Number(it.block.header.timestamp) };
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
    if (!rows.length) break;                     // until an empty page (as Block X's BX-18)
    after = rows[rows.length - 1].player;
  }
  return out;
}
/** The leg types game 8 must have on chain: exactly the locks combo-math.js prices and the page shows (RL-25). */
export function expectedLegTypes() {
  const race = (code: number) => ({ code, lock_mode: 2, round_size: String(M.RACE), round_offset: "0", lead: String(C.RACE_LEAD_MS), ahead: String(C.RACE_AHEAD_MS) });
  return [race(C.WIN), race(C.SHOW), race(C.HALF), { code: C.BLOCK, lock_mode: 1, round_size: String(X.ROUND), round_offset: "0", lead: String(C.BLOCK_LEAD), ahead: String(C.BLOCK_AHEAD) }];
}
/** Why game 8's settings on chain don't match this recorder (null when they do). */
export function settingsProblem(g: any): string | null {
  if (!g) return "game 8 is not on the Picks contract";
  if (Number(g.kind) !== 4 || Number(g.round_size) !== C.CARDS_PER_DAY || Number(g.round_offset ?? 0) !== 0) return `game 8 is kind ${g.kind}, ${g.round_size} slots a day; this recorder scores a card game with ${C.CARDS_PER_DAY}`;
  const have = new Map<number, any>((Array.isArray(g.leg_types) ? g.leg_types : []).map((t: any) => [Number(t.code), t]));
  for (const want of expectedLegTypes()) {
    const t = have.get(want.code);
    if (!t) continue;                                                    // not announced yet: cards can't use it
    for (const k of ["lock_mode", "round_size", "round_offset", "lead", "ahead"] as const) {
      if (String(t[k] ?? "0") !== String((want as any)[k])) return `leg type ${want.code} on chain has ${k} ${t[k] ?? 0}; this recorder and the page use ${(want as any)[k]}. Nothing recorded: update combo-math.js first`;
    }
  }
  return null;
}

// ── results and cards from the other recorders ──
function raceWeek(raceDir: string | undefined, w: number): any[] { const wf = readJson(raceDir, wName(w)); return wf && Array.isArray(wf.races) ? wf.races : []; }
function raceRecord(raceDir: string | undefined, round: number): any | null {
  return raceWeek(raceDir, M.weekOf(M.raceStart(round))).find((r: any) => r && r.id === M.raceId(round)) ?? null;
}
/** Races of the weeks around t (the week before, of and after), for the cards in force near t. */
const racesNear = (raceDir: string | undefined, t: number) => [-1, 0, 1].flatMap((k) => raceWeek(raceDir, M.weekOf(t) + k));
/** The race-data files hold a card taken after time t (any card): the cards up to t are then complete. */
function racesPast(raceDir: string | undefined, t: number): boolean {
  for (const k of [0, 1]) for (const r of raceWeek(raceDir, M.weekOf(t) + k)) for (const c of (r && Array.isArray(r.cards) ? r.cards : [])) if (c && Number.isFinite(c.at) && c.at > t) return true;
  return false;
}
/** race-data is complete up to time t: it holds a card taken after t, or a final result of a race that started after
 *  t (the race recorder writes cards and results together, hourly). */
function raceDataPast(raceDir: string | undefined, t: number): boolean {
  if (racesPast(raceDir, t)) return true;
  for (const k of [0, 1]) for (const r of raceWeek(raceDir, M.weekOf(t) + k)) if (r && Number(r.start) > t && r.result && r.result.final === true) return true;
  return false;
}
/** A race-data file exists for the week of time t (else: an outage, never a reason to void). */
const raceWeekKnown = (raceDir: string | undefined, t: number) => !!readJson(raceDir, wName(M.weekOf(t)))?.races;
/** Race-data has a final result for a race starting after race `round` (so a missing result is not an outage: RL-9). */
function raceSourcePast(raceDir: string | undefined, round: number): boolean {
  for (const k of [0, 1]) for (const r of raceWeek(raceDir, M.weekOf(M.raceStart(round)) + k)) {
    const i = r && typeof r.id === "string" ? M.parseRaceId(r.id) : null;
    if (i !== null && i > round && r.result && r.result.final === true) return true;
  }
  return false;
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
  const KNODE = o.knodeGame === undefined ? MAINNET_KNODE_GAME || null : o.knodeGame;
  const problems: string[] = [], errors: string[] = [];
  const contract = o.picksContract === undefined ? defaultPicksContract() : o.picksContract;
  memo.clear();

  // ── the head, on both nodes (Repo Lens RL-5) ──
  // `agreed`: the time comes from both nodes (the slower one), within this machine's clock. Only then can the deadline
  // void anything. Slots are fixed only when BOTH nodes are irreversibly past the day (CC-B11).
  let head: Head, agreed: boolean;
  const headIds = new Map<any, string>();
  if (o.head) { head = { ...o.head }; agreed = !!o.check; }
  else {
    const a = await headOf(o.p);
    headIds.set(o.p, a.id);
    head = { height: a.height, time: a.time, lib: a.lib, libTime: a.libTime };
    agreed = false;
    if (o.check) {
      try {
        const b = await headOf(o.check);
        headIds.set(o.check, b.id);
        head = { height: Math.min(a.height, b.height), time: Math.min(a.time, b.time), lib: Math.min(a.lib, b.lib), libTime: Math.min(a.libTime, b.libTime) };
        agreed = true;
      } catch (e) { problems.push(`second node: ${(e as Error).message}; no slot fixed and nothing voided this run`); head.libTime = 0; }
    } else problems.push("one node only: no slot fixed and nothing voided this run");
    if (!o.check) head.libTime = 0;
    const now = o.now ?? Date.now();
    if (head.time > now + CLOCK_SLACK_MS) {
      errors.push(`the nodes' time (${new Date(head.time).toISOString()}) is ahead of this machine's clock (${new Date(now).toISOString()}); nothing fixed or voided this run`);
      agreed = false; head.libTime = 0;
    }
  }
  const cardsRead = o.cardsOf ?? (contract ? (node: any, r: number) => readCards(node, contract, r) : null);
  console.log(`head ${head.height} (${new Date(head.time).toISOString()}), irreversible ${head.lib} (${new Date(head.libTime).toISOString()})${agreed ? ", two nodes" : ""}`);

  // ── 1. game 8's settings (both nodes) ──
  if (!o.cardsOf && contract) {
    for (const node of [o.p, o.check].filter(Boolean)) {
      const r: any = await withRetry("game 8 settings", () => (new Contract({ id: contract, abi: PICKS_ABI(), provider: node }).functions as any).get_game({ game: C.GAME_ID }));
      const why = settingsProblem(r?.result?.game);
      if (why) throw new Error(`${why}. Nothing recorded this run.`);
    }
  }

  const nowW = M.weekOf(head.time), today = C.utcDay(head.time);
  const firstDay = C.utcDay(M.weekStart(Math.max(0, nowW - 1)));
  const fixedDay = (day: number) => head.libTime >= (day + 1) * M.DAY;
  const idx = readJson(PREV, "index.json");
  const knownDays = new Set<number>(Array.isArray(idx?.days) ? idx.days.filter((d: any) => Number.isInteger(d) && d >= 0 && d < 100000) : []);
  // days → slots (last week and this week from the chain; older days from the earlier run's files)
  const days = new Map<number, Slot[]>();
  for (let day = firstDay; day <= today; day++) days.set(day, []);
  const targets = blockTargets(BX, [nowW - 2, nowW - 1, nowW, nowW + 1].filter((w) => w >= 0));

  // ── 2. cards: EVERY slot of last week and this week, from the chain (RL-7) ──
  for (let day = firstDay; day <= today; day++) {
    for (let s = 0; s < C.CARDS_PER_DAY; s++) {
      const round = C.slotRound(day, s);
      const keepOld = (why: string) => {
        problems.push(`slot ${round}: ${why} (read again next run)`);
        const old = loadDay(PREV, day).find((x) => x.round === round);
        if (old) days.get(day)!.push({ ...old, fixed: false, cards: old.cards.map((c) => ({ ...c, state: "pending" as const })) });
      };
      if (!cardsRead) continue;
      try {
        const raw = await cardsRead(o.p, round);
        if (o.check) {
          const other = await cardsRead(o.check, round);
          const key = (x: RawCard[]) => JSON.stringify([...x].sort((u, v) => (u.player < v.player ? -1 : 1)));
          if (key(raw) !== key(other)) { keepOld("the two nodes disagree about the cards"); continue; }
        }
        const cards: Card[] = [], seen = new Set<string>();
        for (const x of raw) {
          if (seen.has(x.player)) continue;
          if (!Array.isArray(x.legs) || x.legs.length < C.MIN_LEGS || x.legs.length > C.HARD_MAX_LEGS || !x.legs.every((l) => C.CODES.includes(l.code) && Number.isSafeInteger(l.round) && isAddr(l.producer))) {
            problems.push(`slot ${round}: a card of ${x.player} has a leg this recorder doesn't know; left out`); continue;
          }
          seen.add(x.player);
          const legs: Leg[] = x.legs.map((l) => [l.code, l.round, l.producer, 0, "pending"]);
          cards.push({ player: x.player, round, time: x.time, changes: x.changes, priceAt: null, legs, state: "pending", outcome: null, pts: 0, settled: 0 });
        }
        days.get(day)!.push({ round, fixed: fixedDay(day), cards });
        if (cards.length) console.log(`slot ${round} (${M.dayOf(day * M.DAY)} #${s + 1}): ${cards.length} card(s)${fixedDay(day) ? ", fixed" : ""}`);
      } catch (e) { keepOld((e as Error).message); }
    }
  }

  // ── 3–4. prices and results ──
  const movedCache = new Map<string, Promise<bigint>>();
  const vhpMoves = o.vhpMovesOf ?? (o.head ? null : (node: any, who: string, from: number, to: number) => scoringVhpMoves(node, headIds.get(node) ?? "", MAINNET_VHP, who, from, to));
  /** VHP moved into `who` in blocks from..to: read on both nodes, the higher counts (Block X BX-53). */
  const movedInto = (who: string, from: number, to: number) => {
    const k = `${who}|${from}|${to}`;
    let p = movedCache.get(k);
    if (!p) {
      p = (async () => {
        if (!vhpMoves) return 0n;
        const a = await vhpMoves(o.p, who, from, to), b = o.check ? await vhpMoves(o.check, who, from, to) : a;
        return a > b ? a : b;
      })();
      movedCache.set(k, p);
    }
    return p;
  };
  for (const [day, slots] of days) for (const sl of slots) for (const c of sl.cards) {
    const deadline = M.weekStart(M.weekOf(day * M.DAY) + 1) + DEADLINE_MS;
    const late = agreed && head.time >= deadline;
    const legs = c.legs.map((l) => ({ code: l[0], round: l[1], producer: l[2] }));
    // The price: the usable race card in force when the card was sent, once race-data is complete past that moment.
    if (!raceWeekKnown(RACE, c.time) || !raceDataPast(RACE, c.time)) {
      // An outage (no race-data, or none after the send time) never voids: wait, and alert at the deadline (FC-1, RL-9).
      (late ? errors : problems).push(`slot ${c.round}: race-data doesn't reach ${new Date(c.time).toISOString()} yet; ${c.player}'s card waits`);
      continue;
    }
    const send = C.priceCard(racesNear(RACE, c.time), c.time);
    if (!send) {
      // No usable race card in the 3 hours before it was sent (RL-8): it can't be priced. Void.
      c.priceAt = null; c.outcome = "void"; c.pts = 0; c.legs.forEach((l) => { l[4] = "void"; });
      if (sl.fixed) { c.state = "final"; c.settled = c.time; }
      continue;
    }
    c.priceAt = send.at;
    let ready = true, decided = 0;
    for (let i = 0; i < c.legs.length; i++) {
      const l = c.legs[i], leg = legs[i], isRace = C.FAMILY[l[0]] === "race", t = isRace ? null : targets.get(l[1]) ?? null;
      let r = isRace ? C.legResult(leg, raceRecord(RACE, l[1]), null) : C.legResult(leg, null, t);
      if (r === "pending" && late) {
        // Void at the deadline only if the leg's source has published past it; else its recorder stopped (RL-9).
        const past = isRace ? raceSourcePast(RACE, l[1]) : [...targets.values()].some((x) => x.round > l[1] && x.final === true);
        if (past) r = "void";
        else errors.push(`slot ${c.round}: the ${isRace ? "race" : "Block X"} recorder hasn't published past a leg of ${c.player}'s card (round ${l[1]}); it waits`);
      }
      l[4] = r;
      const sendWorth = C.priceLeg(send, leg);
      if (!sendWorth) { l[3] = 0; continue; }                        // a horse not in the field when sent: a miss
      l[3] = sendWorth.f100;
      if (r === "pending") { ready = false; continue; }
      decided = Math.max(decided, isRace ? M.raceStart(l[1]) + M.RACE : (t?.time ?? 0));
      if (r !== "hit") continue;                                     // a miss or a void: its worth doesn't count
      if (isRace) {
        // Its race has a final result, so race-data is complete past its lock (25 minutes before the start).
        const lockAt = C.legLockTime(leg, 0);
        l[3] = C.finalWorth(send, C.priceCard(racesNear(RACE, lockAt), lockAt), leg);
        continue;
      }
      // A Block X leg that hit: its lock card and the first card after the block, with VHP moved in added (RL-2).
      const lockAt = C.legLockTime(leg, t.time), lock = C.priceCard(racesNear(RACE, lockAt), lockAt), after = C.cardAfter(racesNear(RACE, t.time), t.time);
      if (!after && !raceDataPast(RACE, t.time + C.CARD_MAX_AGE_MS)) { ready = false; if (late) errors.push(`slot ${c.round}: race-data doesn't reach 3 hours after block ${t.height} yet; ${c.player}'s card waits`); continue; }
      if (!lock || !after) { l[4] = "void"; problems.push(`slot ${c.round}: no usable race card ${!lock ? "at the lock of" : "within 3 hours after"} block ${t.height}; ${c.player}'s Block X leg is void`); continue; }
      const cardH = Number.isInteger(lock.height) && lock.height > 0 && lock.height <= t.height ? lock.height : t.height - Math.ceil(Math.max(0, t.time - Number(lock.at)) / X.BLOCK_MS);
      let moved = 0n;
      try { moved = await movedInto(l[2], Math.max(1, cardH - MOVE_MARGIN), t.height); }
      catch (e) {
        if (e instanceof NonCanonicalTransfer) { l[4] = "void"; problems.push(`slot ${c.round}: ${e.message.slice(0, 120)}; ${c.player}'s Block X leg is void`); continue; }
        ready = false; problems.push(`slot ${c.round}: VHP moved into ${l[2]} could not be read: ${(e as Error).message} (tried again next run)`); continue;
      }
      const add = Number(moved) / 1e8;
      l[3] = C.finalWorth(send, C.withMoved(lock, l[2], add), leg, C.withMoved(after, l[2], add));
    }
    const pending = c.legs.some((l) => l[4] === "pending");
    const r = recount(c.legs);
    c.outcome = pending ? (c.legs.some((l) => l[4] === "miss" || (l[4] === "hit" && !(l[3] > 0))) ? "miss" : null) : r.outcome;
    // Final once the slot is fixed (no more changes), every leg is known and every worth is settled.
    if (sl.fixed && !pending && ready) { c.state = "final"; c.outcome = r.outcome; c.pts = r.pts; c.settled = decided || c.time; }
    else c.pts = 0;
  }

  // ── 5–6. players, boards and the Vault ──
  const all = new Map<number, Slot[]>(days);
  for (const d of knownDays) if (!all.has(d) && d < firstDay) all.set(d, loadDay(PREV, d).map((s) => ({ ...s, fixed: true })));
  const cardRows = (from: number, to: number, by: "slot" | "settled" = "slot") => {
    const rows: any[] = [];
    for (const [d, slots] of all) {
      const t = d * M.DAY;
      if (by === "slot" && (t < from || t >= to)) continue;
      for (const sl of slots) for (const c of sl.cards) if (c.state === "final" && c.outcome !== "void" && (by === "slot" || (c.settled >= from && c.settled < to))) rows.push({ player: c.player, round: c.round, pts: c.pts, hit: c.outcome === "hit", lastLegTime: c.settled });
    }
    return rows;
  };
  // Stakes per (week, player), read once per run (CC-B6): the Vault v6 on both nodes, the lower stake wins (RL-4).
  const vault = vaultReader(KNODE, C.GAME_ID);
  const stakeCache = new Map<number, Map<string, boolean> | null>();
  async function readStakes(w: number, who: string[]): Promise<Map<string, boolean> | null> {
    if (o.stakedOf) return o.stakedOf(w, who);
    if (!o.check) return null;                                         // one node: unknown
    const a = await vault(o.p, who, w), b = await vault(o.check, who, w);
    if (a.live !== b.live) { problems.push(`stakes for week ${w}: the two nodes disagree about whether the Vault v6 is live`); return null; }
    const min = a.min > b.min ? a.min : b.min;
    return new Map(who.map((x) => {
      const sa = a.players.get(x)?.week ?? 0n, sb = b.players.get(x)?.week ?? 0n, low = sa < sb ? sa : sb;
      return [x, a.live && low > 0n && low >= min] as [string, boolean];
    }));
  }
  async function stakes(w: number, who: string[]): Promise<Map<string, boolean> | null> {
    if (stakeCache.get(w) === null) return null;
    const m = stakeCache.get(w);
    const missing = who.filter((a) => !m || !m.has(a));
    if (m && !missing.length) return m;
    try {
      const got = missing.length ? await readStakes(w, missing) : new Map<string, boolean>();
      if (got === null) { stakeCache.set(w, null); return null; }
      const merged = new Map(m ?? []); for (const [x, v] of got) merged.set(x, v);
      stakeCache.set(w, merged);
      return merged;
    } catch (e) { problems.push(`stakes for week ${w}: ${(e as Error).message}`); stakeCache.set(w, null); return null; }
  }
  const view = async (rows: any[], w: number | null) => {
    const ranked = C.places(C.board(rows));
    const st = w === null || !ranked.length ? null : await stakes(w, ranked.map((x: any) => x.player));
    return ranked.map((x: any) => {
      const staked = st ? st.get(x.player) ?? null : null;
      return { a: x.player, place: x.place, pts: x.pts, hits: x.hits, cards: x.cards, best: x.best, days: x.days, lastHit: x.lastHit, staked, ranked: staked === true };
    });
  };
  const day0 = today * M.DAY, lw = nowW - 1;
  const weekDone = (w: number) => {
    const d0 = C.utcDay(M.weekStart(w));
    for (let d = d0; d < d0 + 7; d++) {
      const slots = all.get(d) ?? [];
      if (slots.filter((s) => s.fixed).length !== C.CARDS_PER_DAY || slots.some((s) => s.cards.some((c) => c.state !== "final"))) return false;
    }
    return true;
  };
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

  // ── 7. write ──
  fs.mkdirSync(path.join(OUT, "vault"), { recursive: true });
  for (const [d, slots] of days) {
    if (!slots.some((s) => s.cards.length || s.fixed)) continue;
    knownDays.add(d);
    const f: DayFile = { v: 2, day: d, start: d * M.DAY, slots: [...slots].sort((a, b) => a.round - b.round) };
    fs.writeFileSync(path.join(OUT, dName(d)), JSON.stringify(f) + "\n");
  }
  // The Vault file for the week just ended: once, when final, within the Vault's 3 days, with every stake known.
  const vaultWritten: number[] = [];
  const vaultEnd = M.weekStart(nowW) + VAULT_WINDOW_MS;
  const published = !!PREV && fs.existsSync(path.join(PREV, "vault", `W${lw}.json`));
  if (lastWeek && lastWeek.final && !published && head.time <= vaultEnd) {
    if (lastWeek.rows.some((r: any) => r.staked === null)) errors.push(`vault week ${lw}: stakes in the Combo Card couldn't be read on both nodes; no Vault file this run (tried again next run)`);
    else {
      const rows = lastWeek.rows.map((r: any) => ({ player: r.a, pts: r.pts, staked: r.staked }));
      const vf = C.vaultFile(lw, true, rows.filter((r: any) => r.staked === true));
      fs.writeFileSync(path.join(OUT, "vault", `W${lw}.json`), JSON.stringify(vf) + "\n");
      vaultWritten.push(lw);
      console.log(`week ${lw} final: vault/W${lw}.json with ${vf.rows.length} player(s)`);
    }
  }
  if (lastWeek && lastWeek.final && !published && head.time > vaultEnd && head.time <= vaultEnd + 2 * 3600000) errors.push(`vault week ${lw}: no results file was published within the Vault's 3 days; none is written now`);
  fs.writeFileSync(path.join(OUT, "index.json"), JSON.stringify({ v: 2, updated: new Date(head.time).toISOString(), days: [...knownDays].sort((a, b) => a - b), contract: contract || null }) + "\n");
  fs.writeFileSync(path.join(OUT, "board.json"), JSON.stringify(board) + "\n");
  // FC-4: last week's slots still not fixed a day after the week ended means its Vault file is at risk.
  if (lw >= 0 && head.time >= M.weekStart(nowW) + M.DAY) {
    const d0 = C.utcDay(M.weekStart(lw));
    let n = 0; for (let d = d0; d < d0 + 7; d++) n += (all.get(d) ?? []).filter((s) => s.fixed).length;
    if (n < 7 * C.CARDS_PER_DAY) errors.push(`week ${lw}: only ${n} of ${7 * C.CARDS_PER_DAY} card slots are fixed a day after the week ended; check the nodes (the Vault needs the file within 3 days)`);
  }
  const line = (s: string) => s.replace(/[\r\n]+/g, " ").replace(/::/g, ": ");
  for (const pr of problems) console.log(`::warning::${line(pr)}`);
  for (const er of errors) console.log(`::error::${line(er)}`);
  // (`weeks`: the cards of last week and this week by week, for the tests.)
  const weeks = new Map<number, WeekView>();
  for (const [d, slots] of days) { const w = M.weekOf(d * M.DAY); let v = weeks.get(w); if (!v) { v = { week: w, start: M.weekStart(w), end: M.weekStart(w + 1), slots: [] }; weeks.set(w, v); } v.slots.push(...slots); }
  return { problems, errors, weeks, board, vaultWritten };
}

async function main() {
  const RPC = E.RPC || "https://koinos.armana.io";
  const RPC_CHECK = E.RPC_CHECK && E.RPC_CHECK !== "off" && E.RPC_CHECK !== RPC ? E.RPC_CHECK : "";
  if (!RPC_CHECK) console.log("::warning::running on ONE node (RPC_CHECK is off): no slot is fixed and nothing is voided");
  const r = await run({ p: new Provider([RPC]), check: RPC_CHECK ? new Provider([RPC_CHECK]) : null });
  if (r.errors.length) process.exitCode = 1;            // files are written; the job still publishes them (RL-5)
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(`error: ${String((e && (e as Error).message) || e).replace(/[\r\n]+/g, " ").replace(/::/g, ": ").slice(0, 500)}`); process.exit(1); });
}

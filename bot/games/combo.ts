/**
 * Combo Card recorder (run every hour by .github/workflows/combo.yml; read-only on the chain, holds no key).
 *
 * Each run:
 *  1. Settings. Game 8 on the Picks contract (both nodes) must be a card game whose leg types have exactly the locks
 *     this recorder and the page use (combo-math.js). Otherwise nothing is recorded (Repo Lens RL-25, as Block X BX-33).
 *  2. Cards. A wallet has 3 card slots a UTC day (round = day × 3 + slot). EVERY slot of last week and this week is read
 *     from the Picks contract on two independent nodes (RPC and RPC_CHECK) each run, and they must agree. A slot is
 *     FIXED once the last irreversible block on BOTH nodes is past the end of its day (the contract allows changes only
 *     on that day). A published fixed slot stays fixed, and its published final cards are kept (never re-priced),
 *     while the chain holds exactly those cards; when its read fails it is kept as published (fix-check FC-5, FC-9,
 *     FC-11). Every kept final card is re-checked each run against the race-data and Block X files (FC2-1).
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
 *     nodes, which must agree on staked or not (fix-check FC-3, FC2-12). Unknown stakes: no Vault file this run.
 *  6. Weeks. A card counts in the KnodeGames week of its slot day; a player's week = the sum of their best 10 cards.
 *     The week is final 12 hours after it ends, once every slot of it is fixed and every card final. Then the Vault
 *     file vault/W<week>.json is written ONCE (never again once published), within the Vault's 3 days.
 *  7. Writes games-data/combo/index.json, D<day>.json with D<day>-<k>.json (each UTC day in parts of at most 1,000
 *     cards; part 0 says how many parts there are: Repo Lens RL-6, FC2-5, FC3-5), board.json and vault/W<week>.json;
 *     the workflow checks and publishes them. A published final card is kept, and re-checked against its sources
 *     every run (FC2-1, FC3-1): one that can't be an honest run's is left out of the boards and stops its week's
 *     Vault file.
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
export const dName = (day: number, part = 0) => `D${String(day).padStart(5, "0")}${part ? `-${part}` : ""}.json`;
/** Fix-check 2 FC2-5: a day's cards are split into parts of at most 1,000 cards (D<day>.json, then D<day>-1.json, ...),
 *  so no file nears the publish job's 2 MB limit however busy the day. */
export const PART_CARDS = 1000;
const legOk = (l: any) => Array.isArray(l) && l.length === 5 && C.CODES.includes(l[0]) && Number.isSafeInteger(l[1]) && isAddr(l[2]) && Number.isSafeInteger(l[3]) && typeof l[4] === "string";
function cardOk(c: any): boolean {
  return !!c && isAddr(c.player) && Number.isSafeInteger(c.round) && Number.isSafeInteger(c.time) && Array.isArray(c.legs) && c.legs.length >= C.MIN_LEGS &&
    c.legs.length <= C.HARD_MAX_LEGS && c.legs.every(legOk) && (c.state === "pending" || c.state === "final") && Number.isSafeInteger(c.pts);
}
/** An earlier run's (the published) day: its well-formed slots (one entry per slot, one card per player), each final
 *  card recounted from its legs. Used for days before last week (the all-time board); for last week and this week, a
 *  published fixed slot and its final cards are kept while the chain holds exactly those cards (each final card is
 *  re-checked against its sources every run: fix-check 2 FC2-1, fix-check 3 FC3-1), and a slot whose chain read
 *  failed keeps its published copy. */
function loadDay(dir: string | undefined, day: number): Slot[] {
  // Exactly the parts part 0 names (fix-check 3 FC3-5), merged by slot (part 0 lists every slot; later parts only the
  // slots their cards belong to). A missing part: the day can't be read.
  const p0 = readJson(dir, dName(day, 0));
  if (!p0) return [];
  const n = Number.isInteger(p0.parts) && p0.parts >= 1 && p0.parts <= 1000 ? p0.parts : 0;
  const parts: any[] = [p0];
  for (let k = 1; k < n; k++) { const f = readJson(dir, dName(day, k)); if (!f || f.part !== k) return []; parts.push(f); }
  if (!n) return [];
  const merged = new Map<number, { fixed: boolean; cards: any[] }>();
  for (const old of parts) {
    if (!old || old.v !== 2 || old.day !== day || !Array.isArray(old.slots)) return [];
    for (const sl of old.slots) {
      if (!(sl && Number.isSafeInteger(sl.round) && C.dayOfRound(sl.round) === day && Array.isArray(sl.cards))) continue;
      const m = merged.get(sl.round);
      if (m) { m.cards.push(...sl.cards); m.fixed = m.fixed && sl.fixed === true; } else merged.set(sl.round, { fixed: sl.fixed === true, cards: [...sl.cards] });
    }
  }
  const out: Slot[] = [];
  for (const [round, sl] of merged) {
    if (!sl.cards.every((c: any) => cardOk(c) && c.round === round)) continue;
    if (new Set(sl.cards.map((c: any) => c.player)).size !== sl.cards.length) continue;
    for (const c of sl.cards) if (c.state === "final") { const r = c.priceAt === null ? { outcome: "void", pts: 0 } : recount(c.legs); c.outcome = r.outcome; c.pts = r.pts; }
    out.push({ round, fixed: sl.fixed, cards: sl.cards });
  }
  return out.sort((a, b) => a.round - b.round);
}
/** A final card's outcome and points from its legs alone (worths and results). */
export function recount(legs: Leg[]): { outcome: string; pts: number } {
  // A miss decides (fix-check FC-2: an unresolved leg can't hide it); else any unresolved leg voids the card.
  if (legs.some((l) => l[4] === "miss" || (l[4] === "hit" && !(l[3] > 0)))) return { outcome: "miss", pts: 0 };
  if (legs.some((l) => l[4] === "unresolved")) return { outcome: "void", pts: 0 };
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
    if (!rows.length) return out;                // until an empty page (as Block X's BX-18)
    after = rows[rows.length - 1].player;
  }
  throw new Error(`slot ${round}: more than 100,000 cards; not read (fix-check FC-18)`);
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
/** A race week's races, with every card's rows checked as addresses (fix-check FC-26, as the page does: RL-32). */
const cleanCard = (c: any) => (c && Array.isArray(c.field) ? { ...c, field: c.field.filter((r: any) => r && isAddr(r.a)), paddock: (Array.isArray(c.paddock) ? c.paddock : []).filter((r: any) => r && isAddr(r.a)) } : null);
const cleaned = new Map<any, any[]>();
function raceWeek(raceDir: string | undefined, w: number): any[] {
  const wf = readJson(raceDir, wName(w));
  if (!wf || !Array.isArray(wf.races)) return [];
  let got = cleaned.get(wf);
  if (!got) { got = wf.races.map((r: any) => (r && Array.isArray(r.cards) ? { ...r, cards: r.cards.map(cleanCard) } : r)); cleaned.set(wf, got); }
  return got;
}
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
  const problemsAll = problems, errorsAll = errors;
  const contract = o.picksContract === undefined ? defaultPicksContract() : o.picksContract;
  memo.clear(); cleaned.clear();

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
    // Fix-check 2 FC2-4: a node whose head is far behind this machine's clock would rewind the whole recorder (an old
    // week on the board, a lost Vault file). Refuse to record: nothing is written, the run fails.
    const behind = [a.time, ...(agreed ? [head.time] : [])].map((t) => now - t).reduce((x, y) => Math.max(x, y), 0);
    if (behind > 30 * 60000) throw new Error(`a node's head is ${Math.round(behind / 60000)} minutes behind this machine's clock; nothing recorded this run`);
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
  // The published files (PREV) are used in two ways only (fix-check FC-5, FC-9, FC-11): a slot they show as FIXED
  // stays fixed while the chain still holds exactly its cards (who, legs, time, changes), and a published FINAL card
  // on such a slot is kept as published (never re-priced, never turned back to pending). When the read of a published
  // fixed slot fails, the published slot is kept as it is. A degraded run therefore never un-fixes or un-finals what
  // is published, and the publish job never has to hold an honest run for it.
  const chainKey = (c: { player: string; legs: any[]; time: number; changes: number }) =>
    JSON.stringify([c.player, c.legs.map((l: any) => (Array.isArray(l) ? [l[0], l[1], l[2]] : [l.code, l.round, l.producer])), c.time, c.changes]);
  const kept = new Set<Card>();                                       // published final cards kept as published
  for (let day = firstDay; day <= today; day++) {
    const pub = loadDay(PREV, day);
    for (let s = 0; s < C.CARDS_PER_DAY; s++) {
      const round = C.slotRound(day, s), old = pub.find((x) => x.round === round) ?? null;
      const keepOld = (why: string) => {
        problems.push(`slot ${round}: ${why} (read again next run)`);
        if (!old) return;
        if (old.fixed) { days.get(day)!.push(old); for (const c of old.cards) if (c.state === "final") kept.add(c); }
        else days.get(day)!.push({ ...old, fixed: false, cards: old.cards.map((c) => ({ ...c, state: "pending" as const, pts: 0 })) });
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
        // (Fix-check 3 FC3-7: matched through a Map, not a scan per card.)
        const oldBy = new Map((old?.cards ?? []).map((c) => [chainKey(c), c] as [string, Card]));
        const same = !!old && old.cards.length === cards.length && oldBy.size === cards.length && cards.every((x) => oldBy.has(chainKey(x)));
        const fixed = fixedDay(day) || (!!old && old.fixed && same);
        if (old && old.fixed && !same) errors.push(`slot ${round}: the chain's cards differ from the published fixed slot; this day's file will be held by the publish job (check it)`);
        const out = fixed && old && old.fixed && same ? cards.map((x) => { const p = oldBy.get(chainKey(x))!; if (p.state === "final") { kept.add(p); return p; } return x; }) : cards;
        days.get(day)!.push({ round, fixed, cards: out });
        if (cards.length) console.log(`slot ${round} (${M.dayOf(day * M.DAY)} #${s + 1}): ${cards.length} card(s)${fixed ? ", fixed" : ""}`);
      } catch (e) { keepOld((e as Error).message); }
    }
  }

  // ── 3–4. prices and results ──
  // A newest race card without VHP samples means the race recorder that writes race-data isn't the one Combo needs
  // (fix-check FC-12): every card would be void. Say so loudly.
  { let newest: any = null; for (const r of racesNear(RACE, head.time)) for (const c of (r && Array.isArray(r.cards) ? r.cards : [])) if (c && Number.isFinite(c.at) && (!newest || c.at > newest.at)) newest = c;
    if (newest && !Number.isInteger(newest.samples)) errors.push("race-data's newest card has no VHP samples: no Combo card can be priced until the race recorder from the picks branch publishes race-data"); }
  const vhpMoves = o.vhpMovesOf ?? (o.head ? null : (node: any, who: string, from: number, to: number) => scoringVhpMoves(node, headIds.get(node) ?? "", MAINNET_VHP, who, from, to));
  /** VHP moved into `who` in blocks from..to, each node on its own (Block X BX-100, fix-check FC-4): { moved } (the
   *  higher of the two reads, BX-53), { nonCanonical } when BOTH nodes report a non-standard transfer, or { hold } when
   *  only one does or a read fails. Cached for the run. */
  type Moves = { moved?: bigint; nonCanonical?: string; hold?: string };
  const movedCache = new Map<string, Promise<Moves>>();
  const movedInto = (who: string, from: number, to: number): Promise<Moves> => {
    const k = `${who}|${from}|${to}`;
    let p = movedCache.get(k);
    if (!p) {
      p = (async () => {
        if (!vhpMoves) return { moved: 0n };
        const one = async (node: any): Promise<bigint | NonCanonicalTransfer | Error> => { try { return await vhpMoves(node, who, from, to); } catch (e) { return e as Error; } };
        const a = await one(o.p), b = o.check ? await one(o.check) : a;
        const nc = (x: any) => x instanceof NonCanonicalTransfer;
        if (nc(a) && nc(b)) return { nonCanonical: (a as Error).message.slice(0, 120) };
        if (nc(a) !== nc(b)) return { hold: `only one node reports a non-standard VHP transfer to ${who}` };
        for (const x of [a, b]) if (x instanceof Error) return { hold: `VHP moved into ${who} could not be read: ${x.message.slice(0, 120)}` };
        return { moved: (a as bigint) > (b as bigint) ? (a as bigint) : (b as bigint) };
      })();
      movedCache.set(k, p);
    }
    return p;
  };
  const EDGE_MS = 3 * M.DAY;                                          // Block X's own 3-day window
  /** Prices and scores one card in place. mode "live": a normal run. "verify": a dry re-check of a kept card, nothing
   *  logged, VHP moved counted as 0 (no chain reads), so its Block X worths are an upper bound. "moved": the same, with
   *  this run's moved-VHP reads (the lower bound). A re-check judges the deadline and the hold edge by the chain's time
   *  alone: the card was already made final by a run that saw both nodes (fix-check 3 FC3-10). */
  type Mode = "live" | "verify" | "moved";
  async function score(c: Card, fixed: boolean, day: number, mode: Mode = "live"): Promise<void> {
    const verify = mode !== "live";
    const problems: string[] = verify ? [] : problemsAll, errors: string[] = verify ? [] : errorsAll;
    const deadline = M.weekStart(M.weekOf(day * M.DAY) + 1) + DEADLINE_MS;
    const late = (agreed || verify) && head.time >= deadline;
    const legs = c.legs.map((l) => ({ code: l[0], round: l[1], producer: l[2] }));
    // The price: the usable race card in force when the card was sent, once race-data is complete past that moment.
    if (!raceWeekKnown(RACE, c.time) || !raceDataPast(RACE, c.time)) {
      // An outage (no race-data, or none after the send time) never voids: wait, and alert at the deadline (FC-1, RL-9).
      (late ? errors : problems).push(`slot ${c.round}: race-data doesn't reach ${new Date(c.time).toISOString()} yet; ${c.player}'s card waits`);
      c.state = "pending"; c.pts = 0;
      return;
    }
    const send = C.priceCard(racesNear(RACE, c.time), c.time);
    if (!send) {
      // No usable race card in the 3 hours before it was sent (RL-8): it can't be priced. Void.
      c.priceAt = null; c.outcome = "void"; c.pts = 0; c.legs.forEach((l) => { l[4] = "void"; });
      if (fixed) { c.state = "final"; c.settled = c.time; }
      return;
    }
    c.priceAt = send.at;
    let ready = true, decided = 0;
    // A leg whose worth can't be checked is "unresolved": the card is void unless another leg missed (fix-check FC-1,
    // FC-2: never drop one leg because its check failed, which could turn a losing card into a hit).
    const unresolved = (l: Leg, why: string, alert = false) => { l[4] = "unresolved"; (alert ? errors : problems).push(`slot ${c.round}: ${c.player}'s card: ${why}; the card is void unless another leg missed`); };
    for (let i = 0; i < c.legs.length; i++) {
      const l = c.legs[i], leg = legs[i], isRace = C.FAMILY[l[0]] === "race", t = isRace ? null : targets.get(l[1]) ?? null;
      let r = isRace ? C.legResult(leg, raceRecord(RACE, l[1]), null) : C.legResult(leg, null, t);
      l[4] = r;
      if (r === "unresolved") { unresolved(l, isRace ? `race ${M.raceId(l[1])} was never decided (no card, or not checked on two nodes)` : `Block X never decided who signed block ${X.target(l[1])}`); continue; }
      if (r === "pending" && late) {
        // At the deadline: unresolved if the leg's source has published past it (it gave up on it), else its recorder
        // stopped and the card waits (RL-9). Both are errors: someone should look.
        const past = isRace ? raceSourcePast(RACE, l[1]) : [...targets.values()].some((x) => x.round > l[1] && x.final === true);
        if (past) { unresolved(l, `its ${isRace ? "race" : "block"} (round ${l[1]}) was never decided by the deadline`, true); continue; }
        errors.push(`slot ${c.round}: the ${isRace ? "race" : "Block X"} recorder hasn't published past a leg of ${c.player}'s card (round ${l[1]}); it waits`);
      }
      // Its price when sent: the latest usable card that doesn't flag this producer (FC-8, Block X's per-signer rule).
      const sendCard = C.priceCard(racesNear(RACE, c.time), c.time, l[2]);
      const sendWorth = sendCard ? C.priceLeg(sendCard, leg) : null;
      if (!sendCard) { l[3] = 0; if (r !== "miss") unresolved(l, `no unflagged race card priced ${l[2]} when it was sent`); continue; }
      if (!sendWorth) { l[3] = 0; continue; }                        // a horse not in the field when sent: a miss
      l[3] = sendWorth.f100;
      if (r === "pending") { ready = false; continue; }
      decided = Math.max(decided, isRace ? M.raceStart(l[1]) + M.RACE : (t?.time ?? 0));
      if (r !== "hit") continue;                                     // a miss or a void: its worth doesn't count
      if (isRace) {
        // Its race has a final result, so race-data is complete past its lock (25 minutes before the start). No
        // usable card at the lock: unresolved, as for Block X (FC-1), never the worth when sent.
        const lockAt = C.legLockTime(leg, 0), lock = C.priceCard(racesNear(RACE, lockAt), lockAt, l[2]);
        if (!lock) { unresolved(l, `no usable race card at the lock of race ${M.raceId(l[1])} for ${l[2]}`); continue; }
        l[3] = C.finalWorth(sendCard, lock, leg);
        continue;
      }
      // A Block X leg that hit: its lock card and the first card after the block, with VHP moved in added (RL-2).
      const lockAt = C.legLockTime(leg, t.time), lock = C.priceCard(racesNear(RACE, lockAt), lockAt, l[2]), after = C.cardAfter(racesNear(RACE, t.time), t.time, l[2]);
      if (!after && !raceDataPast(RACE, t.time + C.CARD_MAX_AGE_MS)) { ready = false; if (late) errors.push(`slot ${c.round}: race-data doesn't reach 3 hours after block ${t.height} yet; ${c.player}'s card waits`); continue; }
      if (!lock || !after) { unresolved(l, `no usable race card ${!lock ? "at the lock of" : "within 3 hours after"} block ${t.height} for ${l[2]}`); continue; }
      const cardH = Number.isInteger(lock.height) && lock.height > 0 && lock.height <= t.height ? lock.height : t.height - Math.ceil(Math.max(0, t.time - Number(lock.at)) / X.BLOCK_MS);
      const mv: Moves = mode === "verify" ? { moved: 0n } : await movedInto(l[2], Math.max(1, cardH - MOVE_MARGIN), t.height);
      if (mv.nonCanonical) { unresolved(l, `${mv.nonCanonical} (both nodes)`); continue; }
      if (mv.hold) {
        // One node's word never decides (BX-100); a read that keeps failing ends unresolved at Block X's 3-day edge,
        // and is an error while it holds a week's Vault file (FC-7).
        // Fix-check 2 FC2-3: the hold also ends 6 hours before the card's week's Vault window closes.
        const edge = Math.min(t.time + EDGE_MS, M.weekStart(M.weekOf(day * M.DAY) + 1) + VAULT_WINDOW_MS - 6 * 3600000);
        if (head.time > edge && (agreed || verify)) { unresolved(l, `${mv.hold}, still at the edge of the hold`, true); continue; }
        ready = false; problems.push(`slot ${c.round}: ${mv.hold} (held; tried again next run)`); continue;
      }
      const add = Number(mv.moved) / 1e8;
      l[3] = C.finalWorth(sendCard, C.withMoved(lock, l[2], add), leg, C.withMoved(after, l[2], add));
    }
    const pending = c.legs.some((l) => l[4] === "pending");
    const missed = c.legs.some((l) => l[4] === "miss" || (l[4] === "hit" && !(l[3] > 0)));
    const r = recount(c.legs);
    c.outcome = pending ? (missed ? "miss" : null) : r.outcome;
    // Final once the slot is fixed (no more changes), every leg is known and every worth is settled; or, with a leg
    // that missed, as soon as the slot is fixed (a miss always decides: fix-check 2 FC2-3).
    if (fixed && ((!pending && ready) || missed)) { c.state = "final"; c.outcome = missed ? "miss" : r.outcome; c.pts = missed ? 0 : r.pts; c.settled = decided || c.time; }
    else { c.state = "pending"; c.pts = 0; }
  }
  // Fix-check 2 FC2-1 / fix-check 3 FC3-1, FC3-2, FC3-4: a kept (published final) card is re-checked every run against
  // the race-data and Block X files, accepting exactly what an honest run can leave behind:
  //   a miss: a leg it shows as a miss must miss by its sources (a miss decides as soon as the slot is fixed, so its
  //     other legs may still have been pending, and may since have been decided either way);
  //   a hit or a void: every leg's result must be its sources'; except a Block X leg left "unresolved" by the chain
  //     (both nodes reported a non-standard transfer, or a read held to its edge), which the files alone show as a hit;
  //   a hit: its settled time, and every worth: a race leg's exactly; a Block X leg's at the worth with VHP moved
  //     counted as 0 or, if lower, exactly the worth with this run's moved-VHP reads (both ways: FC3-2).
  // "Forged" (it can't be an honest run's): an error, out of the boards, no Vault file for its week. "Unchecked" (its
  // sources don't show a result yet, e.g. a race-data outage, or the moved-VHP read failed): an error and no Vault file
  // for its week this run; it stays on the boards and is checked again next run.
  const isMiss = (l: Leg) => l[4] === "miss" || (l[4] === "hit" && !(l[3] > 0));
  async function recheck(c: Card, day: number): Promise<{ forged?: string; unchecked?: string } | null> {
    const again = async (mode: Mode) => {
      const f: Card = JSON.parse(JSON.stringify(c));
      f.priceAt = null; f.state = "pending"; f.outcome = null; f.pts = 0; f.settled = 0;
      f.legs.forEach((l) => { l[3] = 0; l[4] = "pending"; });
      await score(f, true, day, mode);
      return f;
    };
    const f0 = await again("verify");
    if (f0.priceAt === null && f0.outcome !== "void") return { unchecked: "race-data doesn't reach the time it was sent" };
    if (c.priceAt === null || f0.priceAt === null) return c.priceAt === f0.priceAt && f0.outcome === "void" ? null : { forged: "its price card isn't the one race-data gives" };
    if (f0.priceAt !== c.priceAt) return { forged: "its price card isn't the one race-data gives" };
    if (c.outcome === "miss") {
      const ks = c.legs.map((_, k) => k).filter((k) => isMiss(c.legs[k]));
      if (ks.some((k) => isMiss(f0.legs[k]))) return null;
      if (ks.some((k) => f0.legs[k][4] === "pending")) return { unchecked: "the leg it shows as a miss isn't decided in its sources yet" };
      return { forged: "no leg it shows as a miss misses by its sources" };
    }
    let open = false;
    for (let k = 0; k < c.legs.length; k++) {
      const l = c.legs[k], f = f0.legs[k];
      if (l[4] === f[4]) continue;
      if (l[4] === "unresolved" && C.FAMILY[l[0]] === "block" && f[4] === "hit") continue;
      if (f[4] === "pending") { open = true; continue; }
      return { forged: `leg ${k + 1} is ${l[4]} but its source shows ${f[4]}` };
    }
    if (open) return { unchecked: "a leg isn't decided in its sources yet" };
    if (c.outcome !== "hit") return null;
    if (c.settled !== f0.settled) return { forged: "its settled time isn't the time its last leg was decided" };
    let fm: Card | null = null;
    for (let k = 0; k < c.legs.length; k++) {
      const l = c.legs[k], f = f0.legs[k];
      if (l[3] === f[3]) continue;
      if (C.FAMILY[l[0]] === "race" || l[3] > f[3]) return { forged: `leg ${k + 1}'s worth isn't its sources'` };
      fm ??= await again("moved");
      const m = fm.legs[k];
      if (m[4] === "hit" && m[3] === l[3]) continue;
      if (m[4] !== "hit") return { unchecked: `the VHP moved into ${l[2]} can't be read this run` };
      return { forged: `leg ${k + 1}'s worth isn't its sources' (with the VHP moved in)` };
    }
    return null;
  }
  const forged = new Set<Card>(), badWeeks = new Set<number>(), uncheckedWeeks = new Set<number>();
  for (const [day, slots] of days) for (const sl of slots) for (const c of sl.cards) {
    if (!kept.has(c)) { await score(c, sl.fixed, day); continue; }
    const v = await recheck(c, day), w = M.weekOf(day * M.DAY);
    if (v?.forged) { forged.add(c); badWeeks.add(w); errorsAll.push(`slot ${c.round}: the published final card of ${c.player} doesn't match the race-data and Block X files (${v.forged}); it is left out of the boards and week ${w} gets no Vault file (check it)`); }
    else if (v?.unchecked) { uncheckedWeeks.add(w); errorsAll.push(`slot ${c.round}: the published final card of ${c.player} can't be checked this run (${v.unchecked}); week ${w} gets no Vault file this run (tried again next run)`); }
  }
  // FC-7: last week's cards still pending a day after it ended put its Vault file at risk.
  if (nowW >= 1 && head.time >= M.weekStart(nowW) + M.DAY) {
    let n = 0; for (const [d, slots] of days) if (M.weekOf(d * M.DAY) === nowW - 1) for (const sl of slots) for (const c of sl.cards) if (c.state !== "final") n++;
    if (n) errors.push(`week ${nowW - 1}: ${n} card(s) still pending a day after the week ended; its Vault file waits for them (see the warnings)`);
  }

  // ── 5–6. players, boards and the Vault ──
  const all = new Map<number, Slot[]>(days);
  for (const d of knownDays) if (!all.has(d) && d < firstDay) all.set(d, loadDay(PREV, d).map((s) => ({ ...s, fixed: true })));
  const cardRows = (from: number, to: number, by: "slot" | "settled" = "slot") => {
    const rows: any[] = [];
    for (const [d, slots] of all) {
      const t = d * M.DAY;
      if (by === "slot" && (t < from || t >= to)) continue;
      for (const sl of slots) for (const c of sl.cards) if (c.state === "final" && c.outcome !== "void" && !forged.has(c) && (by === "slot" || (c.settled >= from && c.settled < to))) rows.push({ player: c.player, round: c.round, pts: c.pts, hit: c.outcome === "hit", lastLegTime: c.settled });
    }
    return rows;
  };
  // Stakes per (week, player), read once per run (CC-B6): the Vault v6 on both nodes, the lower stake wins (RL-4).
  const vault = vaultReader(KNODE, C.GAME_ID);
  const stakeCache = new Map<number, Map<string, boolean> | null>();
  // Fix-check FC-3: any disagreement between the nodes (live, the minimum, any wallet's stake) is UNKNOWN, as Block X
  // does: no Vault file that run, and an error. One node can never drop a staked player.
  let vaultLive = true;
  async function readStakes(w: number, who: string[]): Promise<Map<string, boolean> | null> {
    if (o.stakedOf) return o.stakedOf(w, who);
    if (!o.check) return null;                                         // one node: unknown
    const a = await vault(o.p, who, w), b = await vault(o.check, who, w);
    if (a.live !== b.live || (a.live && a.min !== b.min)) { problems.push(`stakes for week ${w}: the two nodes disagree about the Vault v6 (live or its minimum)`); return null; }
    if (!a.live) { vaultLive = false; return new Map(who.map((x) => [x, false] as [string, boolean])); }   // before v6 nobody is staked
    // Fix-check 2 FC2-12: the nodes must agree on staked or not (as Block X compares its staked sets), not on amounts.
    const on = (v: any, x: string) => { const s = v.players.get(x)?.week; return s === undefined ? null : s > 0n && s >= v.min; };
    const bad = who.filter((x) => on(a, x) === null || on(a, x) !== on(b, x));
    if (bad.length) { problems.push(`stakes for week ${w}: the two nodes disagree about ${bad.length} wallet(s), e.g. ${bad[0]}`); return null; }
    return new Map(who.map((x) => [x, on(a, x) === true] as [string, boolean]));
  }
  /** FC2-11: whether the Vault v6 is live, on both nodes, even when no row needed a stake read. */
  async function vaultLiveOnBoth(w: number): Promise<boolean> {
    if (o.stakedOf) return true;
    if (!o.check) return false;
    try { const a = await vault(o.p, [], w), b = await vault(o.check, [], w); return a.live && b.live; } catch { return false; }
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
  // Fix-check FC-10: board.json stays small. The all-time list keeps its top 1,000; Today and This week their top
  // 2,000; Last week every player with at least 1 point (the Vault needs them) plus the top of the rest, to 2,000.
  const view = async (rows: any[], w: number | null, cap = 2000, keepAll = (_x: any) => false) => {
    const ranked = C.places(C.board(rows));
    const shown = ranked.filter((x: any, i: number) => i < cap || keepAll(x));
    const st = w === null || !shown.length ? null : await stakes(w, shown.map((x: any) => x.player));
    return shown.map((x: any) => {
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
  let lastWeek: any = null, tooMany = false;
  const LAST_WEEK_ROWS = 6000;
  if (lw >= 0) {
    const final = head.time >= M.weekStart(nowW) + CORRECTION_MS && weekDone(lw);
    // (FC2-5, fix-check 3 FC3-6: everyone with 1+ point, up to 6,000 rows, so board.json stays well under 2 MB. More
    // players with a point than that: an error, and no Vault file, since the Vault file is judged against these rows.)
    const lwRows = await view(cardRows(M.weekStart(lw), M.weekStart(nowW)), lw, 2000, (x) => x.pts >= C.MIN_WEEK_PTS);
    if (lwRows.filter((x: any) => x.pts >= C.MIN_WEEK_PTS).length > LAST_WEEK_ROWS) tooMany = true;
    lastWeek = { week: lw, start: M.weekStart(lw), final, rows: lwRows.slice(0, LAST_WEEK_ROWS) };
  }
  const board = {
    v: 1, updated: new Date(head.time).toISOString(),
    today: { day: M.dayOf(head.time), rows: await view(cardRows(day0, day0 + M.DAY, "settled"), nowW) },
    week: { week: nowW, start: M.weekStart(nowW), rows: await view(cardRows(M.weekStart(nowW), M.weekStart(nowW + 1)), nowW) },
    lastWeek,
    allTime: { rows: await view(cardRows(0, Infinity), null, 1000) },
  };

  // ── 7. write ──
  fs.mkdirSync(path.join(OUT, "vault"), { recursive: true });
  for (const [d, slots] of days) {
    if (!slots.some((s) => s.cards.length || s.fixed)) continue;
    knownDays.add(d);
    // Parts of at most PART_CARDS cards (FC2-5); part 0 lists every slot, so empty fixed slots are known.
    const sorted = [...slots].sort((a, b) => a.round - b.round).map((sl) => ({ ...sl, cards: [...sl.cards].sort((u, v) => (u.player < v.player ? -1 : u.player > v.player ? 1 : 0)) }));
    const parts: Slot[][] = [[]];
    let n = 0;
    for (const sl of sorted) {
      if (!sl.cards.length) { parts[0].push({ round: sl.round, fixed: sl.fixed, cards: [] }); continue; }
      for (let i = 0; i < sl.cards.length; ) {
        if (n === PART_CARDS) { parts.push([]); n = 0; }
        const take = sl.cards.slice(i, i + PART_CARDS - n);
        const cur = parts[parts.length - 1], last = cur[cur.length - 1];
        if (last && last.round === sl.round) last.cards.push(...take); else cur.push({ round: sl.round, fixed: sl.fixed, cards: take });
        i += take.length; n += take.length;
      }
    }
    if (!sorted.every((sl) => parts[0].some((x) => x.round === sl.round))) for (const sl of sorted) if (!parts[0].some((x) => x.round === sl.round)) parts[0].push({ round: sl.round, fixed: sl.fixed, cards: [] });
    parts[0].sort((a, b) => a.round - b.round);
    parts.forEach((ps, k) => {
      const f: any = k ? { v: 2, day: d, start: d * M.DAY, part: k, slots: ps } : { v: 2, day: d, start: d * M.DAY, parts: parts.length, slots: ps };
      fs.writeFileSync(path.join(OUT, dName(d, k)), JSON.stringify(f) + "\n");
    });
  }
  // The Vault file for the week just ended: once, when final, within the Vault's 3 days, with every stake known.
  const vaultWritten: number[] = [];
  const vaultEnd = M.weekStart(nowW) + VAULT_WINDOW_MS;
  const published = !!PREV && fs.existsSync(path.join(PREV, "vault", `W${lw}.json`));
  if (lastWeek && lastWeek.final && !published && head.time <= vaultEnd) {
    if (tooMany) errors.push(`vault week ${lw}: more than ${LAST_WEEK_ROWS} players have a point, more than board.json can hold; no Vault file (tell Claude)`);
    else if (badWeeks.has(lw)) errors.push(`vault week ${lw}: a published final card doesn't match its sources (see above); no Vault file`);
    else if (uncheckedWeeks.has(lw)) errors.push(`vault week ${lw}: a published final card can't be checked this run (see above); no Vault file this run`);
    else if (lastWeek.rows.some((r: any) => r.staked === null)) errors.push(`vault week ${lw}: stakes in the Combo Card couldn't be read on both nodes, or they disagree; no Vault file this run (tried again next run)`);
    else if (!vaultLive || !(await vaultLiveOnBoth(lw))) problems.push(`vault week ${lw}: the Vault v6 isn't live (or the nodes don't agree it is); no Vault file (fix-check FC-21, FC2-11)`);
    else {
      const rows = lastWeek.rows.map((r: any) => ({ player: r.a, pts: r.pts, place: r.place, staked: r.staked }));
      const vf = C.vaultFile(lw, true, rows);
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

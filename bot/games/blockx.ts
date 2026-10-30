/**
 * Who Signs Block X recorder (run every hour by GitHub Actions; read-only on the chain, holds no key).
 *   mainnet  .github/workflows/games.yml          game 2, cards from the Producer Race recorder, data → games-data/blockx
 *   testnet  .github/workflows/games-testnet.yml  every game in testnet/blockx.json, its own cards, data → testnet-data
 *
 * Each run, for one game:
 *  1. Targets. Every height r × round (+ offset) is a target; mainnet: every 2,400 blocks. A target is recorded once its
 *     block is irreversible and the block (signer and time) and the lock block match on two independent nodes (RPC and
 *     RPC_CHECK; the testnet has one public node (the Koinos Foundation's), so it is checked once and says so).
 *     Until then it waits.
 *  2. The card. A correct pick scores min(3, top VHP ÷ picked VHP) with the VHP from the handicap card in force at the
 *     lock (the time of block X − lead, the first block that refuses a pick):
 *       CARDS=race (mainnet): the Producer Race recorder's hourly card (race-data).
 *       CARDS=self (testnet): this recorder takes the same kind of card itself each run, from the VHP of the producers
 *       that signed the last ~6 hours of blocks (cards.json), because the testnet has no Producer Race.
 *     Only a card taken at or before the lock counts (audit BX-3). A target whose card can't be found yet waits; after
 *     3 days it is recorded as void (no points).
 *  3. The picks: every pick for the round from the Picks contract, on both nodes; they must agree. The chain locked them
 *     `lead` blocks before the target. Each pick is stored with its time, points and whether the wallet is Staked
 *     (holds 1 VHP or has a Knode stake when the target is recorded) or Free play (everyone else).
 *  4. Leaderboards (board.json): Today, This week, Last week and All time, by blockx-math.js, the same file the
 *     page runs, for the two boards of board.js (Staked / Free play). A week is final 12 hours after it ends (the
 *     correction window) when every target in it is recorded. Prizes (2 / 1 VHP to the week's top 2: every Block X player is a free player,
 *     picks on 3+ days, ≥ 1 point) are listed only for weeks from PRIZES_FROM_WEEK: none until the Knode Games vault is
 *     live (owner, 2026-10-28). The vault pays them; this file only records.
 *  5. Writes index.json, W<week>.json, board.json (and cards.json with CARDS=self); the publish job puts them on the
 *     data branch for the website.
 *
 *   npm run blockx                          mainnet (RPC, RPC_CHECK, BLOCKX_PREV, BLOCKX_OUT, RACE_DATA)
 *   npm run blockx -- --testnet --game 2    one game of testnet/blockx.json (TESTNET_RPC overrides its rpc)
 */
import { Provider, Contract, utils as kutils } from "koilib";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { readVhp, MAINNET_VHP, withRetry } from "../../common.ts";
await import("../../race-math.js");
await import("../../blockx-math.js");
const M: any = (globalThis as any).KRaceMath;
const X: any = (globalThis as any).KBlockX;

const E = process.env;
const LOOKBACK_BLOCKS = 3 * 28800;          // targets older than ~3 days: void if they still can't be recorded
const MAX_TARGETS_PER_RUN = 48;             // so a long outage catches up over a few runs
const CORRECTION_MS = 12 * 3600000;         // a week's results are final 12 hours after it ends
const CARD_BLOCKS = 7200;                   // a self-made card looks at the last ~6 hours of blocks
const CARD_KEEP_MS = 8 * 86400000;          // and cards.json keeps 8 days of them
const ONE_VHP = 100000000n;
const isAddr = (a: unknown) => typeof a === "string" && /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a);

/** A recorded pick: [player, producer, pick time (ms), points (hundredths), Staked (1) or Free play (0)]. */
type Pick = [string, string, number, number, number];
type Target = {
  round: number; height: number; final: true; checked: number;
  signer: string | null; time: number; lockTime: number;
  card: { at: number; top: number; signerVhp: number | null; afterAt?: number } | null;   // afterAt: the first card after X (BX-35)
  void?: string; picks: Pick[];
};
type WeekFile = { v: 1; week: number; start: number; end: number; game?: number; targets: Target[] };
type Card = { at: number; field: { a: string; vhp: number }[]; paddock: { a: string; vhp: number }[]; [k: string]: any };
export type RawPick = { player: string; producer: string; time: number };
export type Opts = {
  p: any; check: any | null; prev?: string; out?: string; raceDir?: string;
  picksContract?: string | null;                                           // default: picks-data/deployment.json
  game?: Partial<{ id: number; round: number; offset: number; lead: number; ahead: number; picksPerDay: number; maxChanges: number }>;
  cards?: "race" | "self";                                                 // default: race
  vhpContract?: string;                                                    // default: mainnet VHP
  knodeGame?: string | null;                                               // the Knode vault (v6): who is staked in THIS game
  prizesFromWeek?: number | null;                                          // default: none (no prizes listed)
  picksOf?: (node: any, round: number) => Promise<RawPick[]>;             // for the tests
  blockOf?: (node: any, height: number) => Promise<{ signer: string; time: number }>;
  /** Tests: who was staked in this game in `week` (stake at least the vault's minimum at some point that week). */
  rankedOf?: (who: string[], node: any, week?: number) => Promise<Set<string>>;
  /** Tests: each player's stake in this game for `week` as the vault counts it (lowest that week), and the minimum.
   *  null: the vault (v6) isn't live, so nobody is staked. */
  stakeOf?: (who: string[], node: any, week: number) => Promise<{ min: bigint; week: Map<string, bigint> } | null>;
  signersOf?: (node: any, from: number, to: number) => Promise<{ signers: string[]; first: number; last: number; n: number }>;
  vhpOf?: (who: string[]) => Promise<Record<string, string>>;
  /** Tests: VHP moved into `who` in blocks from..to (audit BX-53). */
  vhpMovesOf?: (node: any, who: string, from: number, to: number) => Promise<bigint>;
  head?: { height: number; time: number; lib: number };
};

// ── files ──
function readJson(dir: string | undefined, name: string): any {
  if (!dir) return null;
  const f = path.join(dir, name);
  try { if (fs.lstatSync(f).isSymbolicLink()) return null; return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; }
}
const wName = (w: number) => `W${String(w).padStart(3, "0")}.json`;
const pName = (w: number) => `P${String(w).padStart(3, "0")}.json`;   // a final week's prizes, written once
function loadWeek(dir: string | undefined, w: number, G: any): WeekFile {
  const fresh: WeekFile = { v: 1, week: w, start: M.weekStart(w), end: M.weekStart(w + 1), game: G.GAME_ID, targets: [] };
  const old = readJson(dir, wName(w));
  if (!old || old.v !== 1 || old.week !== w || !Array.isArray(old.targets) || (old.game !== undefined && old.game !== G.GAME_ID)) return fresh;
  fresh.targets = old.targets.filter((t: any) => t && Number.isInteger(t.round) && t.height === G.target(t.round) && t.final === true);
  return fresh;
}
function defaultPicksContract(): string | null {
  try { const d = JSON.parse(fs.readFileSync(new URL("../../picks-data/deployment.json", import.meta.url), "utf8")); return isAddr(d.contract) ? d.contract : null; } catch { return null; }
}

// ── chain reads ──
async function headOf(node: any) {
  const h: any = await withRetry("head", () => node.getHeadInfo());
  return { id: h.head_topology.id as string, height: Number(h.head_topology.height), time: Number(h.head_block_time), lib: Number(h.last_irreversible_block) };
}
function blockReader(node: any, headId: string) {
  return async (h: number) => {
    const res: any = await withRetry(`block ${h}`, () => node.call("block_store.get_blocks_by_height", { head_block_id: headId, ancestor_start_height: String(h), num_blocks: 1, return_block: true, return_receipt: false }));
    const it = res?.block_items?.[0];
    if (!it || Number(it.block_height) !== h) throw new Error(`block ${h} not returned`);
    return { signer: String(it.block.header.signer), time: Number(it.block.header.timestamp) };
  };
}
/** The producers that signed blocks from..to, with the first and last block times (200 blocks per call). */
async function readSigners(node: any, headId: string, from: number, to: number) {
  const signers = new Set<string>();
  let first = 0, last = 0, n = 0;
  for (let s = from; s <= to; s += 200) {
    const res: any = await withRetry(`blocks at ${s}`, () => node.call("block_store.get_blocks_by_height", { head_block_id: headId, ancestor_start_height: String(s), num_blocks: Math.min(200, to - s + 1), return_block: true, return_receipt: false }));
    for (const it of res?.block_items ?? []) {
      const t = Number(it.block.header.timestamp);
      if (!first) first = t;
      last = t; n++;
      if (isAddr(it.block.header.signer)) signers.add(it.block.header.signer);
    }
  }
  return { signers: [...signers], first, last, n };
}
const PICKS_ABI = () => JSON.parse(fs.readFileSync(new URL("../../picks/abi/picks.koilib.json", import.meta.url), "utf8"));
async function readPicks(node: any, contract: string, game: number, round: number): Promise<RawPick[]> {
  const c = new Contract({ id: contract, abi: PICKS_ABI(), provider: node });
  const out: RawPick[] = [];
  let after: string | undefined;
  for (let page = 0; page < 1000; page++) {
    const r: any = await withRetry(`picks for round ${round}`, () => (c.functions as any).list_picks({ game, round: String(round), ...(after ? { start_after: after } : {}), limit: 100 }));
    const rows = r?.result?.rows ?? [];
    for (const x of rows) {
      const ps = x.pick?.producers;
      if (isAddr(x.player) && Array.isArray(ps) && ps.length === 1 && isAddr(ps[0])) out.push({ player: x.player, producer: ps[0], time: Number(x.pick.time || 0) });
    }
    // Audit BX-18: keep going until an empty page (not "a page shorter than 100", which assumes the contract's page size).
    if (!rows.length) break;
    after = rows[rows.length - 1].player;
  }
  return out;
}
const MAINNET_KNODE_GAME = (() => { try { return JSON.parse(fs.readFileSync(new URL("../../game-data/deployment.json", import.meta.url), "utf8")).contract as string; } catch { return ""; } })();
const GAME_ABI = () => JSON.parse(fs.readFileSync(new URL("../../game/abi/kpred.koilib.json", import.meta.url), "utf8"));
/** The Knode vault (v6) as this game sees it (owner, 2026-10-28: every game takes stakes; handoff
 *  claude/handoff-stake-in-every-game.md). A wallet is a STAKED player in Block X for a week only with at least the
 *  vault's minimum (1 VHP today) staked in Block X (game 2) that week; holding VHP or staking in another game doesn't
 *  count. Everyone else is a free player here. Read with get_game_player(player, game, week): `week_stake` is the
 *  stake the vault counts (the lowest that week; 0 if all was withdrawn), and the entry's `peak_stake` (else the
 *  active stake) is the most it had (a free player never reached the minimum). Before v6 is live
 *  (get_state → config.v6_rule_week_plus_one = 0) nobody is staked. Audit BX-15: a failed read is an error. */
// Audit BX-61: game/abi/kpred-v6.koilib.json is the vault v6 ABI, copied from the vault repo (branch vault-v6-next,
// f1ecf59, game/abi/kpred.koilib.json, made there by game/scripts/make-abi.cjs from game/assembly/proto/kpred.proto).
export const VAULT_ABI_FILE = new URL("../../game/abi/kpred-v6.koilib.json", import.meta.url);
export const VAULT_ABI = () => JSON.parse(fs.readFileSync(VAULT_ABI_FILE, "utf8"));
/** Audit BX-61: just enough of the vault's get_state (the same entry point in v5 and v6) to see whether v6 is live and
 *  what the minimum stake is. Fields the vault has but this doesn't name are skipped by the decoder. So the "is v6
 *  live?" check never needs the v6 ABI file: before v6, nothing else is read and nobody is staked. */
const U64 = (id: number) => ({ type: "uint64", id, options: { jstype: "JS_STRING" } });
export const STATE_ABI = {
  methods: { get_state: { entry_point: 1023583049, argument: "kpred.get_state_arguments", return: "kpred.get_state_result", read_only: true } },
  koilib_types: { nested: { kpred: { nested: {
    get_state_arguments: { fields: {} },
    get_state_result: { fields: { config: { type: "config_object", id: 1 } } },
    config_object: { fields: { owner: { type: "bytes", id: 1, options: { "(koinos.btype)": "ADDRESS" } }, min_stake: U64(9), min_stake_next: U64(13), min_stake_next_week: U64(14), v6_rule_week_plus_one: U64(21) } },
  } } } },
};
export type VaultView = { live: boolean; min: bigint; players: Map<string, { week: bigint; peak: bigint }> };
export function minStakeFor(cfg: any, week: number): bigint {
  const next = BigInt(cfg?.min_stake_next || "0"), from = Number(cfg?.min_stake_next_week || 0);
  return next > 0n && week >= from ? next : BigInt(cfg?.min_stake || "0");
}
/** Runs fn over items, at most `limit` at a time (audit BX-63). */
export async function pool<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]); } };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}
export const VAULT_READS_AT_ONCE = 8;
/** The vault as Block X sees it, read once per run (audit BX-63): the state once per node, and each wallet's
 *  get_game_player once per node and week (cached for the run; up to 8 reads at a time). Audit BX-61: the v6 check
 *  comes first, with STATE_ABI; the v6 ABI file is loaded only once v6 is live. `abi` is for the tests. */
export function vaultReader(vault: string | null, game: number, abi: () => any = VAULT_ABI) {
  const state = new Map<any, Promise<any>>();
  const stakeCache = new Map<any, Map<string, Promise<any>>>();   // node → "week|wallet" → its get_game_player answer
  const cfgOf = (node: any) => {
    let s = state.get(node);
    if (!s) {
      s = (async () => {
        const c = new Contract({ id: vault!, abi: STATE_ABI as any, provider: node });
        const st: any = await withRetry("vault state", () => (c.functions as any).get_state({}));
        // Audit BX-82: koilib always returns `result`; an answer without the game's owner is no answer.
        if (!st?.result?.config?.owner) throw new Error("no answer reading the vault's state (no owner in it)");
        return st.result?.config ?? {};
      })();
      s.catch(() => state.delete(node));
      state.set(node, s);
    }
    return s;
  };
  return async (node: any, who: string[], week: number): Promise<VaultView> => {
    if (!vault) return { live: false, min: 0n, players: new Map() };
    const cfg = await cfgOf(node);
    if (!(Number(cfg.v6_rule_week_plus_one || 0) > 0)) return { live: false, min: 0n, players: new Map() };
    const c = new Contract({ id: vault, abi: abi(), provider: node });
    let mine = stakeCache.get(node);
    if (!mine) { mine = new Map(); stakeCache.set(node, mine); }
    const results = new Map<string, any>();
    const got = await pool([...new Set(who)], VAULT_READS_AT_ONCE, async (a) => {
      const k = `${week}|${a}`;
      let p = mine!.get(k);
      if (!p) {
        p = (async () => {
          const r: any = await withRetry(`vault: ${a} in game ${game}`, () => (c.functions as any).get_game_player({ player: a, game, week: String(week) }));
          if (!r || !("result" in r)) throw new Error(`no answer reading ${a}'s stake in game ${game}`);
          return r.result ?? {};
        })();
        p.catch(() => mine!.delete(k));     // a failed read is tried again (never cached as "not staked")
        mine!.set(k, p);
      }
      return [a, await p] as [string, any];
    });
    for (const [a, r] of got) results.set(a, r);
    return vaultView(cfg, results, week);
  };
}
/** One read of the vault (no cache between calls). Exported for the tests. */
export function readVault(node: any, vault: string | null, game: number, who: string[], week: number, abi: () => any = VAULT_ABI): Promise<VaultView> {
  return vaultReader(vault, game, abi)(node, who, week);
}
/** From the vault's answers (get_state's config, and get_game_player for THIS game per player): the minimum for the
 *  week, each player's counted stake (`week_stake`, the lowest that week) and the most it had. Exported for the tests. */
export function vaultView(cfg: any, results: Map<string, any>, week: number): VaultView {
  const out: VaultView = { live: Number(cfg?.v6_rule_week_plus_one || 0) > 0, min: minStakeFor(cfg, week), players: new Map() };
  if (!out.live) return out;
  if (out.min <= 0n) out.min = 100000000n;
  for (const [a, r] of results) {
    const e = r?.entry, act = BigInt(r?.active_stake || "0");
    const peak = e ? [BigInt(e.peak_stake || "0"), BigInt(e.stake || "0")].reduce((x, y) => (y > x ? y : x)) : act;
    out.players.set(a, { week: BigInt(r?.week_stake || "0"), peak });
  }
  return out;
}
export { stakedSet };
const stakedSet = (v: VaultView) => new Set([...v.players.entries()].filter(([, x]) => v.live && x.peak >= v.min).map(([a]) => a));

/** The Vault's points for staked players (1-255, keeping the board's order and ties; only order matters to the
 *  vault). Rows come in board order with their place; distinct places get 255, 254, … and a place below 1 is 1. */
export function vaultPoints(ranked: { player: string; place: number }[]): { player: string; points: number }[] {
  const places = [...new Set(ranked.map((x) => x.place))].sort((a, b) => a - b);
  const pts = new Map(places.map((pl, i) => [pl, Math.max(1, 255 - i)]));
  return ranked.map((x) => ({ player: x.player, points: pts.get(x.place)! }));
}

// ── VHP moved in around block X (audit BX-53) ──
/** Blocks before the lock card that still count: added VHP counts for production 20 blocks after it arrives. */
export const MOVE_MARGIN = 25;
/** A card with `vhp` (1e-8 units) added to `who` (field or paddock); the same card when nothing moved. */
export function withMoved(card: Card | null, who: string, vhp: bigint): Card | null {
  if (!card || vhp <= 0n) return card;
  const add = Number(vhp) / 1e8;
  const bump = (rows: any[]) => (rows || []).map((r: any) => (r && r.a === who ? { ...r, vhp: r.vhp + add } : r));
  return { ...card, field: bump(card.field), paddock: bump(card.paddock) };
}
/** VHP moved INTO `who` by the VHP contract in blocks from..to: the sum of its transfer and mint events naming `who` as
 *  the receiver (events are read from the block receipts, 200 blocks per call). Moves out are ignored: the card already
 *  counts the highest VHP. Exported for the tests. */
export async function scoringVhpMoves(node: any, headId: string, vhp: string, who: string, from: number, to: number): Promise<bigint> {
  // Audit BX-77 / BX-84: every block of the range, contiguous, checked; 200 blocks a call, 4 calls at a time.
  const starts: number[] = [];
  for (let s = Math.max(1, from); s <= to; s += 200) starts.push(s);
  const parts = await pool(starts, 4, async (s) => {
    const n = Math.min(200, to - s + 1);
    const res: any = await withRetry(`receipts at ${s}`, () => node.call("block_store.get_blocks_by_height", { head_block_id: headId, ancestor_start_height: String(s), num_blocks: n, return_block: false, return_receipt: true }));
    const items = res?.block_items ?? [];
    if (items.length !== n || items.some((it: any, k: number) => Number(it?.block_height) !== s + k)) throw new Error(`receipts ${s}-${s + n - 1}: the node returned ${items.length} of ${n} blocks, or out of order`);
    let sum = 0n;
    for (const it of items) sum += vhpInflows(it?.receipt, vhp, who);
    return sum;
  });
  return parts.reduce((x, y) => x + y, 0n);
}
/** From one block receipt: VHP received by `who`. Audit BX-72: read exactly as the VHP contract does. The event's
 *  data is the call's own arguments, which the contract decodes with as-proto: the LAST copy of a field wins and
 *  unknown fields are skipped. The receiver is the event's impacted[0] (the contract's decoded `to`), so bytes that
 *  read differently can't credit or hide a move. transfer: value = field 3; mint: value = field 2. */
export function vhpInflows(receipt: any, vhp: string, who: string): bigint {
  const events = [...(receipt?.events ?? []), ...((receipt?.transaction_receipts ?? []) as any[]).flatMap((t) => t?.events ?? [])];
  let sum = 0n;
  for (const e of events) {
    if (!e || e.source !== vhp || typeof e.name !== "string") continue;
    const mint = /mint/i.test(e.name), transfer = /transfer/i.test(e.name);
    if (!mint && !transfer) continue;
    if (!Array.isArray(e.impacted) || e.impacted[0] !== who) continue;
    const value = lastVarint(e.data, mint ? 2 : 3);
    if (value !== null) sum += value;
  }
  return sum;
}
/** The last varint of field `want` in protobuf bytes (base64), skipping every other field as as-proto does (wire types
 *  0, 1, 2 and 5); null when the bytes don't parse. Exported for the tests. */
export function lastVarint(data: unknown, want: number): bigint | null {
  let b: Uint8Array;
  try { b = typeof data === "string" ? new Uint8Array(Buffer.from(data, "base64")) : new Uint8Array(0); } catch { return null; }
  let i = 0, last: bigint | null = null;
  const vint = (): bigint | null => { let r = 0n, sh = 0n; for (let k = 0; k < 10; k++) { if (i >= b.length) return null; const x = b[i++]; r |= BigInt(x & 0x7f) << sh; if (!(x & 0x80)) return r & 0xffffffffffffffffn; sh += 7n; } return null; };
  while (i < b.length) {
    const tag = vint(); if (tag === null) return null;
    const f = Number(tag >> 3n), w = Number(tag & 7n);
    if (w === 0) { const v = vint(); if (v === null) return null; if (f === want) last = v; }
    else if (w === 1) { i += 8; }
    else if (w === 2) { const n = vint(); if (n === null || i + Number(n) > b.length) return null; i += Number(n); }
    else if (w === 5) { i += 4; }
    else return null;
    if (i > b.length) return null;
  }
  return last;
}

// ── cards ──
/** The handicap card for a lock at time t (audit BX-3): the latest card TAKEN at or before t (its `at`), no older than
 *  3 hours, so a card made after the lock (with VHP that moved after it) is never used. Race cards come from the race
 *  at t and the one before; self-made cards (testnet) from cards.json. None: the target waits (then void). */
const CARD_MAX_AGE_MS = 3 * 3600000;
/** Audit BX-38: a race card made from fewer than 12 VHP samples is flagged; Block X never scores with it. */
export const MIN_CARD_SAMPLES = 12;
const usable = (c: Card | null | undefined, race: boolean): c is Card =>
  !!c && Number.isFinite(c.at) && Array.isArray(c.field) && c.field.length > 0 && (!race || (Number.isInteger(c.samples) && c.samples >= MIN_CARD_SAMPLES));
function latestCardAt(cards: (Card | null | undefined)[], t: number, race = false): Card | null {
  let best: Card | null = null;
  for (const c of cards) {
    if (!usable(c, race)) continue;
    if (c.at <= t && t - c.at <= CARD_MAX_AGE_MS && (!best || c.at > best.at)) best = c;
  }
  return best;
}
/** Audit BX-35: the first card taken AFTER block X (within 3 hours). A target is scored with the lower multiplier
 *  of this card and the lock's card, so VHP moved in right after the lock card doesn't pay. */
function firstCardAfter(cards: (Card | null | undefined)[], t: number, race = false, signer = ""): Card | null {
  let best: Card | null = null;
  for (const c of cards) {
    if (!usable(c, race)) continue;
    if (signer && flags(c, signer)) continue;   // audit BX-55: a card on which the nodes disagreed about the signer waits for the next

    if (c.at > t && c.at - t <= CARD_MAX_AGE_MS && (!best || c.at < best.at)) best = c;
  }
  return best;
}
function raceCards(raceDir: string | undefined, times: number[]): (Card | null)[] {
  const all: (Card | null)[] = [];
  const seen = new Set<string>();
  for (const at of times) {
    const ra = M.raceAt(at);
    if (seen.has(ra.id)) continue;
    seen.add(ra.id);
    const wf = readJson(raceDir, wName(M.weekOf(ra.start)));
    const race = wf && Array.isArray(wf.races) ? wf.races.find((r: any) => r && r.id === ra.id) : null;
    if (race && Array.isArray(race.cards)) all.push(...race.cards);
  }
  return all;
}
function raceCardAfter(raceDir: string | undefined, t: number, signer = ""): Card | null {
  return firstCardAfter(raceCards(raceDir, [t, t + M.RACE]), t, true, signer);
}
/** Audit BX-55: the race recorder lists on a card the producers whose VHP the two nodes read differently. */
export const flags = (c: Card | null | undefined, who: string) => !!c && ((Array.isArray(c.flagged) && c.flagged.includes(who)) || c.topInDoubt === true);   // round 4, BX-73: the top in doubt holds every target
function raceCardAt(raceDir: string | undefined, t: number): Card | null {
  const all: (Card | null)[] = [];
  for (const at of [t, t - M.RACE]) {
    const ra = M.raceAt(at);
    const wf = readJson(raceDir, wName(M.weekOf(ra.start)));
    const race = wf && Array.isArray(wf.races) ? wf.races.find((r: any) => r && r.id === ra.id) : null;
    if (race && Array.isArray(race.cards)) all.push(...race.cards);
  }
  return latestCardAt(all, t, true);
}
const selfCardAt = (cards: Card[], t: number): Card | null => latestCardAt(cards, t);
const selfCardAfter = (cards: Card[], t: number, signer = ""): Card | null => firstCardAfter(cards, t, false, signer);

/** One run for one game. Exported for the tests, which pass fake nodes. */
export async function run(o: Opts) {
  const G = X.forGame(o.game ?? X.MAINNET_GAME);
  const OUT = o.out ?? E.BLOCKX_OUT ?? "games-data/blockx";
  const PREV = o.prev ?? E.BLOCKX_PREV ?? "";
  const RACE = o.raceDir ?? E.RACE_DATA ?? "";
  const CARDS = o.cards ?? "race";
  const VHP = o.vhpContract ?? MAINNET_VHP;
  const KNODE = o.knodeGame === undefined ? MAINNET_KNODE_GAME || null : o.knodeGame;
  const PRIZES_FROM = o.prizesFromWeek ?? null;
  const problems: string[] = [];
  const contract = o.picksContract === undefined ? defaultPicksContract() : o.picksContract;

  const live = o.head ? null : await headOf(o.p);
  const head = o.head ?? live!;
  const headId = live ? live.id : "";
  const blockP = o.blockOf ? (h: number) => o.blockOf!(o.p, h) : blockReader(o.p, headId);
  let blockC: ((h: number) => Promise<{ signer: string; time: number }>) | null = null;
  let checkHeadId = "";
  if (o.check) {
    if (o.blockOf) blockC = (h: number) => o.blockOf!(o.check, h);
    else {
      const ch = await headOf(o.check); blockC = blockReader(o.check, ch.id); checkHeadId = ch.id;
      // Audit BX-17: a block is irreversible only when both nodes say so.
      if (ch.lib < head.lib) head.lib = ch.lib;
    }
  }
  // Audit BX-33 / BX-46: the game's lock settings on chain (both nodes) must be the ones this recorder scores with.
  // A failed read, or no such game, records nothing this run (it never falls back to the recorder's own settings).
  if (!o.picksOf && contract) {
    for (const node of [o.p, o.check].filter(Boolean)) {
      const r: any = await withRetry(`game ${G.GAME_ID} settings`, () => (new Contract({ id: contract, abi: PICKS_ABI(), provider: node }).functions as any).get_game({ game: G.GAME_ID }));
      const gc = r?.result?.game;
      if (!gc) throw new Error(`game ${G.GAME_ID} is not on the Picks contract (or the node didn't answer). Nothing recorded this run.`);
      if (Number(gc.round_size) !== G.ROUND || Number(gc.round_offset ?? 0) !== G.OFFSET || Number(gc.lead) !== G.LEAD) {
        throw new Error(`game ${G.GAME_ID} on chain has round ${gc.round_size}, offset ${gc.round_offset ?? 0}, lead ${gc.lead}; this recorder scores ${G.ROUND}/${G.OFFSET}/${G.LEAD}. Nothing recorded: update the game settings in the recorder first.`);
      }
    }
  }
  const picksRead = o.picksOf ?? (contract ? (node: any, r: number) => readPicks(node, contract, G.GAME_ID, r) : null);
  // Audit BX-63: one vault reader for the whole run (each wallet read once per node and week, in parallel).
  const vaultOnce = vaultReader(KNODE, G.GAME_ID);
  const vaultRead = o.stakeOf ? null : (who: string[], node: any, week: number) => vaultOnce(node, who, week);
  const rankedRead = o.rankedOf ?? (async (who: string[], node: any, week = 0) => stakedSet(await vaultRead!(who, node, week)));
  const weekStakes = async (who: string[], node: any, week: number): Promise<{ min: bigint; week: Map<string, bigint> } | null> => {
    if (o.stakeOf) return o.stakeOf(who, node, week);
    if (o.rankedOf) { const s = await o.rankedOf(who, node, week); return { min: 1n, week: new Map(who.map((a) => [a, s.has(a) ? 1n : 0n])) }; }
    const v = await vaultRead!(who, node, week);
    return v.live ? { min: v.min, week: new Map([...v.players.entries()].map(([a, x]) => [a, x.week])) } : null;
  };
  console.log(`game ${G.GAME_ID}: every ${G.ROUND} blocks, lock ${G.LEAD} before; head ${head.height} (${new Date(head.time).toISOString()}), irreversible ${head.lib}`);

  // ── self-made cards (CARDS=self): one per hour, from the VHP of the producers of the last ~6 hours ──
  let cards: Card[] = [];
  let startHeight = 0;                       // CARDS=self: the head when this recorder first ran (targets start there)
  if (CARDS === "self") {
    const prev = readJson(PREV, "cards.json");
    startHeight = prev && prev.v === 1 && Number.isInteger(prev.startHeight) && prev.startHeight > 0 ? prev.startHeight : head.height;
    cards = (prev && prev.v === 1 && Array.isArray(prev.cards) ? prev.cards : []).filter((c: any) => c && Number.isFinite(c.at) && Array.isArray(c.field) && head.time - c.at <= CARD_KEEP_MS);
    const hour = Math.floor(head.time / 3600000);
    if (!cards.some((c) => Math.floor(c.at / 3600000) === hour)) {
      try {
        const from = Math.max(1, head.height - CARD_BLOCKS + 1);
        const sg = o.signersOf ? await o.signersOf(o.p, from, head.height) : await readSigners(o.p, headId, from, head.height);
        const values = o.vhpOf ? await o.vhpOf(sg.signers) : (await readVhp(o.p, VHP, sg.signers, { effective: true })).values;   // effective VHP (BX-3 b; testnet: one producer)
        const span = sg.last - sg.first, perRace = span > 0 ? (sg.n - 1) * M.RACE / span : 7200;
        const card = M.makeCard(sg.signers.map((a) => [a, Number(values[a] || "0") / 1e8]), perRace, head.time);
        if (card.field.length + card.paddock.length) { cards.push(card); console.log(`card taken: ${card.field.length + card.paddock.length} producers`); }
      } catch (e) { problems.push(`card: ${(e as Error).message} (tried again next run)`); }
    }
    cards.sort((a, b) => a.at - b.at);
  }
  const cardAt = (t: number) => (CARDS === "self" ? selfCardAt(cards, t) : raceCardAt(RACE, t));
  const cardAfter = (t: number, signer = "") => (CARDS === "self" ? selfCardAfter(cards, t, signer) : raceCardAfter(RACE, t, signer));

  // The weeks touched: the last 3 days and now.
  const weeks = new Map<number, WeekFile>();
  const weekFor = (w: number) => { let f = weeks.get(w); if (!f) { f = loadWeek(PREV, w, G); weeks.set(w, f); } return f; };
  const idx = readJson(PREV, "index.json");
  const known = new Set<number>(Array.isArray(idx?.weeks) ? idx.weeks.filter((w: any) => Number.isInteger(w) && w >= 0 && w < 10000) : []);
  const done = new Set<number>();
  const nowW = M.weekOf(head.time);
  for (const w of [nowW - 1, nowW]) if (w >= 0) for (const t of weekFor(w).targets) done.add(t.round);

  /** A void row (no points) for a target that couldn't be recorded before it left the 3-day window (audit BX-16). */
  const voidAt = (r: number, h: number, time: number, lockTime: number, why: string) => {
    const t = time || (head.time - (head.height - h) * X.BLOCK_MS);
    const wf = weekFor(M.weekOf(t));
    if (wf.targets.some((x) => x.round === r)) return;
    wf.targets = wf.targets.concat([{ round: r, height: h, final: true, checked: 0, signer: null, time: Math.round(t), lockTime: Math.round(lockTime || t - G.LEAD * X.BLOCK_MS), card: null, void: why.replace(/[\r\n]+/g, " "), picks: [] }]).sort((x, y) => x.round - y.round);
    done.add(r);
  };

  // ── 1–3. targets ──
  let firstRound = Math.max(1, Math.ceil((head.lib - LOOKBACK_BLOCKS - G.OFFSET) / G.ROUND));
  // CARDS=self: only targets whose lock comes at most ~an hour (1,200 blocks) before the first run; earlier ones could
  // never have a card, so they are not part of this recorder's game at all (no "void" rows for days before it ran).
  if (CARDS === "self") firstRound = Math.max(firstRound, Math.ceil((startHeight - 1200 + G.LEAD - G.OFFSET) / G.ROUND));
  const lastRound = Math.floor((head.lib - G.OFFSET) / G.ROUND);
  let n = 0;
  // Newest first, so targets that keep waiting (no card) never crowd out the new ones within a run's budget.
  for (let r = lastRound; r >= firstRound && n < MAX_TARGETS_PER_RUN; r--) {
    if (done.has(r)) continue;
    const h = G.target(r);
    if (h <= G.LEAD) continue;
    n++;
    const old = h < head.lib - LOOKBACK_BLOCKS + G.ROUND;
    try {
      const b = await blockP(h), lock = await blockP(h - G.LEAD);
      let checked = 1;
      if (blockC) {
        const b2 = await blockC(h), l2 = await blockC(h - G.LEAD);
        if (b2.signer !== b.signer || b2.time !== b.time || l2.time !== lock.time) { problems.push(`block ${h}: the two nodes disagree; not recorded this run`); if (old) voidAt(r, h, b.time, lock.time, "the two nodes disagreed about this block until it left the 3-day window"); continue; }
        checked = 2;
      }
      let raw: RawPick[] = [];
      if (picksRead) {
        raw = await picksRead(o.p, r);
        if (o.check) {
          const other = await picksRead(o.check, r);
          const key = (x: RawPick[]) => JSON.stringify([...x].sort((u, v) => (u.player < v.player ? -1 : 1)));
          if (key(raw) !== key(other)) { problems.push(`block ${h}: the two nodes disagree about the picks; not recorded this run`); if (old) voidAt(r, h, b.time, lock.time, "the two nodes disagreed about its picks until it left the 3-day window"); continue; }
        }
      }
      const card = cardAt(lock.time);
      // CARDS=self: cards are only ever taken going forward, so a lock more than an hour before the first card will
      // never get one (the recorder wasn't running yet): void now rather than waiting 3 days.
      // Audit BX-48: cards are only made going forward, so 3 hours after the lock none can still appear for it.
      const never = (CARDS === "self" && cards.length > 0 && lock.time < cards[0].at) || head.time > lock.time + CARD_MAX_AGE_MS;
      if (!card && !old && !never) { problems.push(`block ${h}: no handicap card yet for ${new Date(lock.time).toISOString()}; tried again next run`); continue; }
      // Audit BX-35: and the first card after block X; until it exists the target waits (3 hours at most).
      const after = card ? cardAfter(b.time, b.signer) : null;
      const afterNever = head.time > b.time + CARD_MAX_AGE_MS;
      if (card && !after && !old && !afterNever) { problems.push(`block ${h}: waiting for the first handicap card after the block (scored with the lower of the two); tried again next run`); continue; }
      // Audit BX-4: Staked or Free play is read on both nodes too; a disagreement holds the target like a block's.
      const players = [...new Set(raw.map((x) => x.player))];
      const wk = M.weekOf(b.time);
      const ranked = await rankedRead(players, o.p, wk);
      if (o.check) {
        const other = await rankedRead(players, o.check, wk);
        if (ranked.size !== other.size || [...ranked].some((a) => !other.has(a))) { problems.push(`block ${h}: the two nodes disagree about which players are Staked; not recorded this run`); if (old) voidAt(r, h, b.time, lock.time, "the two nodes disagreed about Staked status until it left the 3-day window"); continue; }
      }
      // Audit BX-55: a lock card on which the two nodes disagreed about the signer's VHP is never scored: the target
      // waits (the lock card can't change, so it is voided at the usual 3-hour limit).
      const lockFlagged = !!card && flags(card, b.signer);
      if (lockFlagged && !old && !afterNever) { problems.push(`block ${h}: the two nodes disagreed about ${b.signer}'s VHP on its lock card; held (voided after 3 hours)`); continue; }
      // Audit BX-53: VHP moved INTO the signer between its lock card and block X (a "flash" stake that neither card
      // sees) counts for the signer on both cards, read on both nodes (the higher of the two), so it can't look small.
      let moved = 0n;
      // (Tests that serve fake blocks with blockOf and no vhpMovesOf have no receipts to read: nothing moved.)
      if (card && after && !lockFlagged && isAddr(b.signer) && (o.vhpMovesOf || !o.blockOf)) {
        // Audit BX-77: from the block the lock card's window ended at, when the card records it.
        const cardH = Number.isInteger(card.height) && card.height > 0 && card.height <= h ? card.height : h - Math.ceil(Math.max(0, b.time - Number(card.at)) / 3000);
        const from = Math.max(1, cardH - MOVE_MARGIN), to = h;
        const read = o.vhpMovesOf ?? ((node: any, who: string, f: number, t: number) => scoringVhpMoves(node, node === o.p ? headId : checkHeadId, VHP, who, f, t));
        const mp = await read(o.p, b.signer, from, to), mc = o.check ? await read(o.check, b.signer, from, to) : mp;
        moved = mp > mc ? mp : mc;
        if (moved > 0n) console.log(`block ${h}: ${Number(moved) / 1e8} VHP moved into ${b.signer} between its card and the block; counted on both cards`);
      }
      const lockC = withMoved(card, b.signer, moved), afterC = withMoved(after, b.signer, moved);
      const { m, top } = lockC ? X.vhpOf(lockC) : { m: new Map(), top: 0 };
      const scoring = card && after && !lockFlagged ? lockC : null;
      const pointsOf = (producer: string) => (scoring ? Math.min(X.pointsOf(lockC, producer, b.signer), X.pointsOf(afterC, producer, b.signer)) : 0);
      const picks: Pick[] = raw.map((x) => [x.player, x.producer, x.time, pointsOf(x.producer), ranked.has(x.player) ? 1 : 0]);
      const t: Target = {
        round: r, height: h, final: true, checked, signer: isAddr(b.signer) ? b.signer : null, time: b.time, lockTime: lock.time,
        card: scoring ? { at: Number(card.at) || 0, top, signerVhp: m.get(b.signer) ?? null, afterAt: Number(after!.at) || 0 } : null, picks,
      };
      if (!card) t.void = "no handicap card was recorded for this target's lock; no points";
      else if (lockFlagged) t.void = "the two nodes disagreed about the signer's VHP on the lock's handicap card; no points";
      else if (!after) t.void = "no handicap card was taken within 3 hours after the block; no points";
      const wf = weekFor(M.weekOf(b.time));
      wf.targets = wf.targets.filter((x) => x.round !== r).concat([t]).sort((x, y) => x.round - y.round);
      done.add(r);
      console.log(`block ${h}: signed by ${b.signer}, ${picks.length} picks, ${picks.filter((x) => x[3] > 0).length} right, checked on ${checked} node(s)`);
    } catch (e) {
      problems.push(`block ${h}: ${(e as Error).message} (tried again next run)`);
      // Audit BX-16: a target that keeps failing is voided, with its reason, when it reaches the edge of the window, so
      // the week can still become final.
      if (old) voidAt(r, h, 0, 0, `could not be recorded within 3 days: ${String((e as Error).message).slice(0, 120)}`);
    }
  }

  // ── 4. leaderboards ──
  const all = new Map(weeks);
  for (const w of known) if (!all.has(w)) all.set(w, loadWeek(PREV, w, G));
  const rowsOf = (from: number, to: number) => {
    const rows: any[] = [];
    for (const wf of all.values()) for (const t of wf.targets) {
      if (t.time < from || t.time >= to || t.void) continue;
      // Audit BX-33: only pick days inside the period count toward the 3-day prize rule.
      for (const [player, producer, pickTime, pts, ranked] of t.picks) rows.push({ player, height: t.height, time: t.time, pickTime: pickTime >= from && pickTime < to ? pickTime : NaN, correct: pts > 0 && producer === t.signer, pts, ranked: !!ranked });
    }
    return rows;
  };
  // Audit BX-15: a wallet's board for a period is the one its FIRST recorded pick of that period had, so nobody can push
  // a Free play leader onto the Staked board later by sending them 1 VHP.
  const rankedSet = (rows: any[]) => {
    const first = new Map<string, any>();
    for (const x of rows) { const f = first.get(x.player); if (!f || x.height < f.height) first.set(x.player, x); }
    return new Set([...first.values()].filter((x) => x.ranked).map((x) => x.player));
  };
  // Audit BX-14: each row also carries its place on its own board (Staked or Free play), ties included, so the page
  // never ranks a player against the other board.
  const view = (rows: any[]) => {
    const rk = rankedSet(rows), own = new Map<string, number>();
    for (const side of [true, false]) for (const x of X.places(X.board(rows.filter((r: any) => rk.has(r.player) === side)))) own.set(x.player, x.place);
    return X.places(X.board(rows)).map((x: any) => ({ a: x.player, place: x.place, boardPlace: own.get(x.player) || x.place, pts: x.pts, correct: x.correct, picks: x.picks, days: x.days, lastCorrect: x.lastCorrect, ranked: rk.has(x.player) }));
  };
  const lastRowsOf = (w: number) => rowsOf(M.weekStart(w), M.weekStart(w + 1));
  const day0 = Math.floor(head.time / M.DAY) * M.DAY;
  const lw = nowW - 1;
  let lastWeek: any = null;
  let freeze: any = null;
  if (lw >= 0) {
    const rows = rowsOf(M.weekStart(lw), M.weekStart(nowW));
    // Final: 12 hours after the week ended, with every target of the week recorded.
    const wf = all.get(lw);
    const complete = !!wf && wf.targets.length > 0 && targetsCover(wf, M.weekStart(lw), M.weekStart(nowW), all);
    const final = head.time >= M.weekStart(nowW) + CORRECTION_MS && complete;
    // Prizes: the Free play board's top 2 (picks on 3 days, ties share), only from PRIZES_FROM_WEEK (none until the
    // vault). Player rule (owner, 2026-10-28, every game): staked = at least the vault's minimum staked IN Block X
    // that week (the Staked board, which shares the game's weekly bucket); everyone else is a free player and plays
    // for the 2 + 1 VHP prize. A wallet that was staked here at any point that week can't win the free prize.
    const rk = rankedSet(rows);
    const prizeWeek = PRIZES_FROM !== null && lw >= PRIZES_FROM;
    lastWeek = { week: lw, start: M.weekStart(lw), final, rows: view(rows), prizes: final && prizeWeek ? X.prizes(rows.filter((x) => !rk.has(x.player))) : [] };
    // Audit BX-5: a final week's prizes are written once (P<week>.json) and never recomputed: later runs, and the page,
    // use that file, so a target recorded late can't change a prize list that was already final.
    const frozen = readJson(PREV, pName(lw));
    if (frozen && frozen.v === 1 && frozen.week === lw && frozen.game === G.GAME_ID && Array.isArray(frozen.prizes)) {
      lastWeek.final = true; lastWeek.prizes = frozen.prizes; lastWeek.frozenAt = frozen.at;
    } else if (final) {
      freeze = { v: 1, week: lw, game: G.GAME_ID, at: new Date(head.time).toISOString(), prizes: lastWeek.prizes };
    }
  }
  const board = {
    v: 1, updated: new Date(head.time).toISOString(),
    today: { day: M.dayOf(head.time), rows: view(rowsOf(day0, day0 + M.DAY)) },
    week: { week: nowW, start: M.weekStart(nowW), rows: view(rowsOf(M.weekStart(nowW), M.weekStart(nowW + 1))) },
    lastWeek,
    allTime: { rows: view(rowsOf(0, Infinity)) },
  };

  // ── 5. write ──
  fs.mkdirSync(OUT, { recursive: true });
  for (const [w, wf] of weeks) {
    if (!wf.targets.length) continue;
    known.add(w);
    fs.writeFileSync(path.join(OUT, wName(w)), JSON.stringify(wf) + "\n");
  }
  fs.writeFileSync(path.join(OUT, "index.json"), JSON.stringify({ v: 1, updated: new Date(head.time).toISOString(), weeks: [...known].sort((a, b) => a - b), contract: contract || null, game: G.GAME_ID, prizesFromWeek: PRIZES_FROM }) + "\n");
  fs.writeFileSync(path.join(OUT, "board.json"), JSON.stringify(board) + "\n");
  if (freeze) fs.writeFileSync(path.join(OUT, pName(freeze.week)), JSON.stringify(freeze) + "\n");
  // The Vault (v6) results file for the week just ended, once final (from the frozen prize list, so it never changes):
  // <OUT>/vault/W<week>.json, read by the hourly bot from games-data:blockx/vault (deployment.json vaultGames["2"]).
  // rows: the Staked board's players the vault counts as staked for the whole week (its lowest stake that week at
  // least the minimum; read on both nodes), with at least 1 point, as 1-255 in board order. A disagreement or a failed
  // read writes no file this run (tried again next run).
  if (lastWeek && lastWeek.final && !(PREV && fs.existsSync(path.join(PREV, "vault", `W${lastWeek.week}.json`)))) {
    try {
      const board = lastWeek.rows.filter((x: any) => x.ranked && x.pts > 0);
      const who = board.map((x: any) => x.a);
      let counted = new Set<string>();
      if (who.length) {
        const a = await weekStakes(who, o.p, lastWeek.week), b = o.check ? await weekStakes(who, o.check, lastWeek.week) : a;
        const pick = (v: { min: bigint; week: Map<string, bigint> } | null) => new Set(v ? who.filter((x: string) => (v.week.get(x) ?? 0n) >= v.min && (v.week.get(x) ?? 0n) > 0n) : []);
        const ca = pick(a), cb = pick(b);
        if (ca.size !== cb.size || [...ca].some((x) => !cb.has(x))) throw new Error("the two nodes disagree about who was staked in Block X that week");
        counted = ca;
      }
      const ranked = X.places(X.board(lastRowsOf(lastWeek.week).filter((x: any) => counted.has(x.player)))).map((x: any) => ({ player: x.player, place: x.place }));
      const vf = vaultFile(G.GAME_ID, lastWeek.week, lastWeek.prizes, vaultPoints(ranked));
      for (const pr of vf.problems) problems.push(pr);
      fs.mkdirSync(path.join(OUT, "vault"), { recursive: true });
      fs.writeFileSync(path.join(OUT, "vault", `W${lastWeek.week}.json`), JSON.stringify(vf.file) + "\n");
    } catch (e) { problems.push(`vault week ${lastWeek.week}: ${(e as Error).message} (tried again next run)`); }
  }
  if (CARDS === "self") fs.writeFileSync(path.join(OUT, "cards.json"), JSON.stringify({ v: 1, updated: new Date(head.time).toISOString(), startHeight, cards }) + "\n");
  for (const pr of problems) console.log(`::warning::${pr.replace(/[\r\n]+/g, " ").replace(/::/g, ": ")}`);
  return { problems, weeks, board, cards };
}

/** Every target whose block time falls in [from, to) is recorded (audit BX-5): the week's rounds run without a gap,
 *  the round right after the last one is recorded and falls at or after the week's end (so no target at the end of
 *  the week is missing), and the round right before the first one is recorded before the week's start (or, for the
 *  game's first week, the first target is within 3 hours of the start). */
export function targetsCover(wf: WeekFile, from: number, to: number, all: Map<number, WeekFile>): boolean {
  const rs = wf.targets.map((t) => t.round).sort((a, b) => a - b);
  for (let i = 1; i < rs.length; i++) if (rs[i] !== rs[i - 1] + 1) return false;
  const find = (r: number) => { for (const w of all.values()) { const t = w.targets.find((x) => x.round === r); if (t) return t; } return null; };
  const after = find(rs[rs.length - 1] + 1);
  if (!after || after.time < to) return false;
  const before = find(rs[0] - 1);
  if (before) return before.time < from;
  const first = wf.targets.find((t) => t.round === rs[0])!;
  const earlier = [...all.keys()].some((w) => w < wf.week && (all.get(w)?.targets.length ?? 0) > 0);
  return !earlier && first.time - from < 3 * 3600000;
}

// ── the testnet config (testnet/blockx.json), read and checked ──
/** The Vault's file (bot/vault.ts on vault-v6): `rows`, the staked players' points (1-255, board order), and the free
 *  board's 1st and 2nd. From the prize list (X.prizes: ties share, 2+ tied for 1st
 *  cover 2nd too, so 2nd is then empty). The Vault takes at most 10 wallets per place and refuses a whole place with
 *  more; such a place is left empty here (its prize goes back to the pool) and reported. Exported for the tests. */
export const VAULT_MAX_PER_PLACE = 10;
export function vaultFile(game: number, week: number, prizes: { player: string; place: number }[], rows: { player: string; points: number }[] = []) {
  const problems: string[] = [];
  const at = (n: number) => [...new Set(prizes.filter((x) => x.place === n).map((x) => x.player))].sort();
  let first = at(1), second = first.length >= 2 ? [] : prizes.filter((x) => x.place !== 1).map((x) => x.player).filter((a, i, l) => l.indexOf(a) === i).sort();
  if (first.length > VAULT_MAX_PER_PLACE) { problems.push(`vault week ${week}: ${first.length} wallets tied for 1st (the Vault takes at most ${VAULT_MAX_PER_PLACE}); 1st left empty`); first = []; }
  if (second.length > VAULT_MAX_PER_PLACE) { problems.push(`vault week ${week}: ${second.length} wallets tied for 2nd (the Vault takes at most ${VAULT_MAX_PER_PLACE}); 2nd left empty`); second = []; }
  // A wallet is either staked (rows) or free (first/second), never both.
  const staked = new Set(rows.map((x) => x.player));
  first = first.filter((a) => !staked.has(a)); second = second.filter((a) => !staked.has(a));
  return { file: { game, week, final: true, rows, first, second }, problems };
}

export type NetConfig = { v: 1; network: "koinos-foundation-testnet"; chainId: string | null; rpc: string; koin: string; picks: string | null; vhp: string | null; prizesFromWeek: number | null;
  data: string; games: { id: number; name: string; round: number; offset: number; lead: number; ahead: number; picksPerDay: number; maxChanges: number }[] };
export const MAINNET_CHAIN_ID = "EiBZK_GGVP0H_fXVAM3j6EAuz3-B-l3ejxRSewi7qIBfSA==";
export function readNetConfig(file: URL | string = new URL("../../testnet/blockx.json", import.meta.url)): NetConfig {
  const c = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!c || c.v !== 1 || c.network !== "koinos-foundation-testnet" || !Array.isArray(c.games) || !c.games.length) throw new Error("testnet/blockx.json is not a testnet Block X config");
  if (c.chainId === MAINNET_CHAIN_ID) throw new Error("testnet/blockx.json names the MAINNET chain id: refusing");
  for (const g of c.games) X.forGame(g);   // throws on settings the contract would refuse
  return c;
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.includes("--testnet")) {
    const RPC = E.RPC || "https://koinos.armana.io";   // audit BX-60: the same default node as the race recorder
    const RPC_CHECK = E.RPC_CHECK && E.RPC_CHECK !== "off" && E.RPC_CHECK !== RPC ? E.RPC_CHECK : "";
    // Audit BX-59: never quietly down to one node on mainnet; ALLOW_ONE_NODE=yes says so out loud.
    if (!RPC_CHECK && E.ALLOW_ONE_NODE !== "yes") throw new Error("no second node (RPC_CHECK is off, missing or the same as RPC): Block X needs two on mainnet. Set RPC_CHECK, or ALLOW_ONE_NODE=yes to run on one node.");
    if (!RPC_CHECK) console.log("::warning::running on ONE node (ALLOW_ONE_NODE=yes): blocks, picks and stakes are not cross-checked");
    const r = await run({ p: new Provider([RPC]), check: RPC_CHECK ? new Provider([RPC_CHECK]) : null, prizesFromWeek: E.PRIZES_FROM_WEEK ? Number(E.PRIZES_FROM_WEEK) : null });
    return r;
  }
  // Testnet: one game of the config. Never touches mainnet files: data goes to BLOCKX_OUT (default testnet-data/blockx-<id>).
  const cfg = readNetConfig();
  const i = argv.indexOf("--game"), id = i >= 0 ? Number(argv[i + 1]) : cfg.games[0].id;
  const game = cfg.games.find((g) => g.id === id);
  if (!game) throw new Error(`game ${id} is not in testnet/blockx.json`);
  if (!isAddr(cfg.picks)) throw new Error("testnet/blockx.json has no Picks contract yet (npm run picks -- upload --testnet --send)");
  if (!isAddr(cfg.vhp)) throw new Error("testnet/blockx.json has no testnet VHP contract (vhp); the upload finds it, or set it by hand. The mainnet VHP is never used on the testnet.");
  const rpc = E.TESTNET_RPC || cfg.rpc;
  const p = new Provider([rpc]);
  // The node must be the testnet the config names, never mainnet.
  const chain = await withRetry("chain id", () => p.getChainId());
  if (chain === MAINNET_CHAIN_ID || (cfg.chainId && chain !== cfg.chainId)) throw new Error(`the node at ${rpc} is on chain ${chain}, not the testnet in testnet/blockx.json (${cfg.chainId})`);
  return run({
    p, check: null, game, cards: "self", picksContract: cfg.picks, vhpContract: cfg.vhp!, knodeGame: null,
    prizesFromWeek: cfg.prizesFromWeek, out: E.BLOCKX_OUT || `testnet-data/blockx-${id}`, prev: E.BLOCKX_PREV || `testnet-data/blockx-${id}`,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Audit BX-34: one line, no workflow commands (a node's error text could hold "::").
main().catch((e) => { console.error(`error: ${String((e && (e as Error).message) || e).replace(/[\r\n]+/g, " ").replace(/::/g, ": ").slice(0, 500)}`); process.exit(1); });
}

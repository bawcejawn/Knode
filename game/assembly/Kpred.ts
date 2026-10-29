/**
 * KPRED — the Koinos block-producer prediction game.
 *
 * Players stake VHP (or KOIN, burned into VHP). The pooled VHP produces blocks through the game's node. Every week
 * the operator posts multiple-choice questions about the chain; players answer for free (the contract pays the
 * Mana); the operator resolves them from block data (hashes published so anyone can re-check). After the week:
 *   close_week     measures the pool's gain and splits it: 5% producer fee (KOIN), 95% winners' pot (a pot with no
 *                  winners rolls into the next week's pot without being charged the fee again)
 *   settle         counts each player's points (anyone can call it, for anyone, free)
 *   finalize_week  finds the winners: the top 30% of staked players by points (headcount), everyone tied included,
 *                  and gives each place a rank weight 1/√rank (players tied share their places' weights evenly)
 *   claim          pays each winner, in VHP, from two baskets:
 *                    A = 40% of the pot, by rank weight × stake counted up to 10 VHP (v5; before: 65% of what the
 *                        house earned, by rank weight only)
 *                    B = the other 60%, by rank weight × full stake
 *                  At most 30 questions a week, so at most 30 points (v5).
 * All of this runs on-chain. The only off-chain inputs are the operator's question parameters and resolutions.
 *
 * Who can do what:
 *   players     deposit (whole numbers), withdraw any amount at any time (withdrawing all leaves that week; part lowers
 *               the week's stake), answer, settle, claim
 *   operator    post and resolve questions — cannot move any funds
 *   owner       correct a resolution before its week closes, set operator, pause NEW deposits, register the node key,
 *               claim the producer fee, change the minimum stake (from next week), schedule an upgrade (uploadable only
 *               after the timelock, and only for 7 days after it)
 *   seed owner  add seed VHP/KOIN; withdraw it only after an announced timelock; hand the seed over (two steps, v5)
 *   nobody      can take players' stakes or rewards, or the seed — not the owner, not the deploy key
 */
import { SAFE_MODE } from "./Mode";
import { System, Storage, Protobuf, Arrays, Crypto, authority, value, protocol, Base58, u128 } from "@koinos/sdk-as";
import { kpred } from "./proto/kpred";
import { Tokens } from "./Tokens";

const VOID: u32 = 1000;
const MAX_QUESTIONS_PER_WEEK: u32 = 30;   // v5: at most 30 questions, so at most 30 points, a week
const FEE_BPS: u64 = 500;       // 5% producer fee (KOIN), charged once on everything the pool earns
const WIN_PCT: u64 = 30;        // winners = the top 30% of eligible (staked) players by headcount, ties included
const BASKET_A_BPS: u64 = 6500; // before v5: basket A = 65% of what the house (seed + unclaimed pots) earned, by rank only
// v5: basket A = 40% of the whole pot, shared by rank x stake counted up to 10 VHP; basket B = the other 60%, by rank x
// full stake. Splitting a stake of up to 10 VHP across wallets gains about nothing in basket A; a larger stake split into
// wallets of up to 10 VHP each does count more there (the cap is per wallet), at the cost of playing every wallet.
const V5_BASKET_A_BPS: u64 = 4000;
const V5_CAP_A: u64 = 10 * 100_000_000;
// v5: each week up to 2 VHP of the pot (after the fee, before the baskets) goes to the 2 best free players (answered at
// least 2 counted questions, staked less than the minimum): 1 VHP each, ties share. Nobody qualifies: it goes to basket B.
const FREE_PRIZE: u64 = 2 * 100_000_000;
const W_SCALE: u64 = 1_000_000_000_000_000_000; // rank weight of place r = sqrt(W_SCALE / r) = 1e9 / √r
const RESOLVE_MARGIN: u64 = 60; // resolve only after the window's blocks are irreversible (~3 minutes)
// Weeks and answer deadlines follow the block timestamps (ms, UTC), so they land on exact calendar times. The blocks a
// question watches are still counted by height; these bounds on the average block time keep the two consistent:
const MIN_BLOCK_MS: u64 = 2800; // even if blocks ran this fast, a question's window still starts after its answers close
const MAX_BLOCK_MS: u64 = 3500; // even if blocks ran this slow, the window still ends before its week is due to close
const WHOLE: u64 = 100_000_000;   // deposits are whole VHP / KOIN only (1, 2, 3 … never 1.5); withdrawals may be any amount
const MAX_SPONSOR_LIMIT: u64 = 1_000_000_000; // 10 KOIN of Mana: the most one free transaction may ever cost the pool
// Sponsored arguments are re-encoded and must match byte for byte; this is the longest any of them can be.
const MAX_SPONSORED_ARGS: i32 = 64;
// accept_owner must come at least this many blocks (~24 h at 3 s) after propose_owner. The hourly bot then sees the
// pending transfer many times and emails the owner, who has a day to answer (propose again to their own address).
const OWNER_ACCEPT_DELAY: u64 = 28_800;
// Announced upgrades and seed withdrawals can be carried out only during 7 days after their timelock ends. After that
// they must be announced again (with a fresh 48-hour notice), so an old announcement cannot be used by surprise.
const ANNOUNCEMENT_EXPIRY: u64 = 7 * 86_400_000;
// Changes to a posted result end this many close_delays after the week's end (or after its latest first result, if
// later), so corrections can never hold a finished week open: it closes by one more close_delay after that.
const CORRECTION_DELAYS: u64 = 2;
// Answers stay open at least 1/168 of a week: exactly 1 hour with mainnet's 7-day weeks.
const MIN_ANSWER_DIVISOR: u64 = 168;
// Finalization gives out at most this many places (rank weights) per transaction; larger weeks take several.
let finalizePage: u32 = 500;
/** Test hook: a smaller page, to exercise paged finalization with a few players. */
export function testSetFinalizePage(n: u32): void { if (BUILD_FOR_TESTING) finalizePage = n; }
// v6 rule week (+1) that init sets. Mainnet's contract was initialised long ago (the upgrade sets it on its first
// write instead); tests of the older rules keep them by default, and the v6 tests switch v6 on from week 0.
let initV6Rule: u64 = BUILD_FOR_TESTING ? 1_000_000 : 1;
/** Test hook: the v6 rule week (+1) that init will set. */
export function testSetInitV6Rule(n: u64): void { if (BUILD_FOR_TESTING) initV6Rule = n; }
// The withdrawals-only build (assembly/Mode.ts). Tests switch it on with the hook; the release builds fold it away.
let testSafeMode: bool = false;
/** Test hook: behave as the withdrawals-only build. */
export function testSetSafeMode(b: bool): void { if (BUILD_FOR_TESTING) testSafeMode = b; }
function safeMode(): bool { return BUILD_FOR_TESTING ? testSafeMode : SAFE_MODE; }

// Entry points the contract is willing to pay Mana for (first 4 bytes of sha256 of the name).
const EP_ANSWER: u32 = 0x0db52f40;
const EP_SETTLE: u32 = 0x6868e83d;
const EP_CLAIM: u32 = 0xdd1b3c31;

// Storage spaces
const S_CONFIG: u32 = 0;
const S_TOTALS: u32 = 1;
const S_PLAYERS: u32 = 2;
const S_ENTRIES: u32 = 3;
const S_QUESTIONS: u32 = 4;
const S_WEEKS: u32 = 5;
const S_BUCKETS: u32 = 6;
const S_UPGRADE: u32 = 7;
const S_SEED_WD: u32 = 8;
// v6: the KnodeGames vault (docs/V6-PLAN.md)
const S_GAMES: u32 = 9;
const S_GPROPOSALS: u32 = 10;
const S_GPLAYERS: u32 = 11;
const S_GENTRIES: u32 = 12;
const S_GWEEKS: u32 = 13;
const S_GBUCKETS: u32 = 14;
const Q_GAME: u32 = 1;                         // the question game
const MAX_GAMES: u32 = 12;                     // games besides the question game, so every close stays bounded
const MAX_GAME_POINTS: u32 = 255;              // other games' weekly points: 1 to 255
const MAX_ROWS: i32 = 50;                      // results per post_results call
const MAX_PRIZE_WINNERS: u32 = 10;             // wallets per free-prize place
const PRIZE_V6: u64 = 3 * 100_000_000;         // free prize per game per week: 2 VHP for 1st + 1 VHP for 2nd
const RESULTS_DAYS: u64 = 3;                   // other games' results are due 3/7 of a week (3 days) after the week
const MAX_NAME: i32 = 32;
const MAX_SEASON_WEEKS: u32 = 4;               // a free prize can be paid once a season of up to 4 weeks (Survivor: 2)

// ───────────── keys ─────────────
// v6 (audit V6-2): the game's code from before the vault (mainnet v3 and v5). schedule_upgrade refuses them.
const PRE_VAULT_CODE: string[] = [
  "917708a7c567d9642a7a2f121c34fbc70200909787208705fc3aa5a2b1e6433a",
  "c17066ae988d204fd43d43f662ad87fcdc38170419943c20b5164a5bd34dd784",
];
const HEX_DIGITS = "0123456789abcdef";
function hexOf(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += HEX_DIGITS.charAt(b[i] >> 4) + HEX_DIGITS.charAt(b[i] & 15);
  return s;
}

function u64Key(v: u64): Uint8Array {
  const k = new Uint8Array(8);
  for (let i = 0; i < 8; i++) k[i] = <u8>((v >> (<u64>(56 - 8 * i))) & 0xff);
  return k;
}
function u32Key(v: u32): Uint8Array {
  const k = new Uint8Array(4);
  for (let i = 0; i < 4; i++) k[i] = <u8>((v >> (<u32>(24 - 8 * i))) & 0xff);
  return k;
}
function cat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const k = new Uint8Array(a.length + b.length);
  k.set(a, 0);
  k.set(b, a.length);
  return k;
}
function bps(amount: u64, b: u64): u64 {
  return (u128.fromU64(amount) * u128.fromU64(b) / u128.fromU64(10000)).toU64();
}
/** Integer square root (floor). */
function isqrt(n: u64): u64 {
  if (n < 2) return n;
  let x = n, y = n / 2 + 1;
  while (y < x) { x = y; y = (x + n / x) / 2; }
  return x;
}
/** The balanced rank curve: place r gets 1/√r (scaled by 1e9). 1st 10.4%, 2nd 7.4%, 3rd 6.0% … of 30 winners. */
export function rankWeight(r: u64): u64 { return isqrt(W_SCALE / r); }
/** v6: 1st place's part of a free prize: two thirds (2 of every 3 VHP), rounded down. */
function prizeFirst(p: u64): u64 { return (u128.fromU64(p) * u128.fromU64(2) / u128.fromU64(3)).toU64(); }
function isAddress(a: Uint8Array | null): bool {
  return a != null && a.length == 25;
}

/** The current transaction's operations. On the chain this reads the "operations" field (each entry an `Any`
 *  holding one operation — the exact path the probe contract used on mainnet). The test VM does not fill that
 *  field faithfully, so tests read the whole transaction instead. */
function txOps(): protocol.operation[] {
  if (BUILD_FOR_TESTING) return System.getTransaction().operations;
  const list = Protobuf.decode<value.list_type>(System.getTransactionField("operations")!.message_value!.value!, value.list_type.decode);
  const out = new Array<protocol.operation>();
  for (let i = 0; i < list.values.length; i++) {
    out.push(Protobuf.decode<protocol.operation>(list.values[i].message_value!.value!, protocol.operation.decode));
  }
  return out;
}

/** How many signatures the transaction carries. A sponsored transaction needs exactly one (the player's or the
 *  sender's); extra ones only make it cost the pool more Mana (audit M-3). */
function txSignatureCount(): i32 {
  if (BUILD_FOR_TESTING) return System.getTransaction().signatures.length;
  const f = System.getTransactionField("signatures");
  if (f == null || f.message_value == null) return i32.MAX_VALUE;   // unreadable: refuse to sponsor
  return Protobuf.decode<value.list_type>(f.message_value!.value!, value.list_type.decode).values.length;
}

export class Kpred {
  contractId: Uint8Array = System.getContractId();

  config: Storage.Obj<kpred.config_object> = new Storage.Obj(System.getContractId(), S_CONFIG, kpred.config_object.decode, kpred.config_object.encode, () => new kpred.config_object());
  totals: Storage.Obj<kpred.totals_object> = new Storage.Obj(System.getContractId(), S_TOTALS, kpred.totals_object.decode, kpred.totals_object.encode, () => new kpred.totals_object());
  players: Storage.Map<Uint8Array, kpred.player_object> = new Storage.Map(System.getContractId(), S_PLAYERS, kpred.player_object.decode, kpred.player_object.encode, () => new kpred.player_object());
  entries: Storage.Map<Uint8Array, kpred.entry_object> = new Storage.Map(System.getContractId(), S_ENTRIES, kpred.entry_object.decode, kpred.entry_object.encode, null);
  questions: Storage.Map<Uint8Array, kpred.question_object> = new Storage.Map(System.getContractId(), S_QUESTIONS, kpred.question_object.decode, kpred.question_object.encode, null);
  weeks: Storage.Map<Uint8Array, kpred.week_object> = new Storage.Map(System.getContractId(), S_WEEKS, kpred.week_object.decode, kpred.week_object.encode, () => new kpred.week_object());
  buckets: Storage.Map<Uint8Array, kpred.bucket_object> = new Storage.Map(System.getContractId(), S_BUCKETS, kpred.bucket_object.decode, kpred.bucket_object.encode, () => new kpred.bucket_object());
  upgrade: Storage.Obj<kpred.timelock_object> = new Storage.Obj(System.getContractId(), S_UPGRADE, kpred.timelock_object.decode, kpred.timelock_object.encode, () => new kpred.timelock_object());
  seedWd: Storage.Obj<kpred.timelock_object> = new Storage.Obj(System.getContractId(), S_SEED_WD, kpred.timelock_object.decode, kpred.timelock_object.encode, () => new kpred.timelock_object());
  games: Storage.Map<Uint8Array, kpred.game_object> = new Storage.Map(System.getContractId(), S_GAMES, kpred.game_object.decode, kpred.game_object.encode, null);
  gproposals: Storage.Map<Uint8Array, kpred.game_proposal_object> = new Storage.Map(System.getContractId(), S_GPROPOSALS, kpred.game_proposal_object.decode, kpred.game_proposal_object.encode, null);
  gplayers: Storage.Map<Uint8Array, kpred.gplayer_object> = new Storage.Map(System.getContractId(), S_GPLAYERS, kpred.gplayer_object.decode, kpred.gplayer_object.encode, () => new kpred.gplayer_object());
  gentries: Storage.Map<Uint8Array, kpred.gentry_object> = new Storage.Map(System.getContractId(), S_GENTRIES, kpred.gentry_object.decode, kpred.gentry_object.encode, null);
  gweeks: Storage.Map<Uint8Array, kpred.gweek_object> = new Storage.Map(System.getContractId(), S_GWEEKS, kpred.gweek_object.decode, kpred.gweek_object.encode, () => new kpred.gweek_object());
  gbuckets: Storage.Map<Uint8Array, kpred.bucket_object> = new Storage.Map(System.getContractId(), S_GBUCKETS, kpred.bucket_object.decode, kpred.bucket_object.encode, () => new kpred.bucket_object());

  // ═══════════════════════ helpers ═══════════════════════

  height(): u64 {
    return System.getBlockField("header.height")!.uint64_value;
  }

  /** The current block's timestamp in milliseconds (UTC). */
  now(): u64 {
    return System.getBlockField("header.timestamp")!.uint64_value;
  }

  cfg(): kpred.config_object {
    const c = this.config.get()!;
    System.require(isAddress(c.owner), "not initialised");
    // First action after the v4 upgrade: the new winners' rule starts with the NEXT week, never one being played.
    if (c.scorer_rule_week_plus_one == 0 || c.reward_rule_week_plus_one == 0) {
      if (c.scorer_rule_week_plus_one == 0) c.scorer_rule_week_plus_one = this.weekOf(c, this.now()) + 2;
      // First action after the v5 upgrade: the v5 reward split starts with the NEXT week, so every stake it counts
      // was settled by v5 code.
      if (c.reward_rule_week_plus_one == 0) c.reward_rule_week_plus_one = this.weekOf(c, this.now()) + 2;
      this.config.put(c);
    }
    // First action after the v6 upgrade: the vault split starts with the NEXT week; the question game becomes game 1
    // and starts measuring its stake over time now.
    if (c.v6_rule_week_plus_one == 0) {
      c.v6_rule_week_plus_one = this.weekOf(c, this.now()) + 2;
      this.config.put(c);
      this.initQuestionGame(this.weekOf(c, this.now()));
    }
    return c;
  }

  /** Whether week `w` is closed by the v6 vault split. */
  v6Rule(c: kpred.config_object, w: u64): bool {
    return c.v6_rule_week_plus_one > 0 && w + 1 >= c.v6_rule_week_plus_one;
  }

  /** Game 1, the question game: its stake is everyone's stake not in another game. All of it is counted for the week
   *  running now (a v5-rule week, which the vault split never uses); deposits waiting for next week are in it too, which
   *  is right from next week on. */
  initQuestionGame(week: u64): void {
    if (this.games.get(u32Key(Q_GAME)) != null) return;
    const t = this.totals.get()!;
    const g = new kpred.game_object();
    g.id = Q_GAME;
    g.name = "Questions";
    g.staked = true;
    g.free_prize = true;
    g.active = true;
    g.stake = t.total_stake - t.stake_other;
    g.week_stake = g.stake;
    g.week = week;
    this.games.put(u32Key(Q_GAME), g);
  }

  /** Whether week `w` is paid by the v5 reward split. */
  rewardRule(c: kpred.config_object, w: u64): bool {
    return c.reward_rule_week_plus_one > 0 && w + 1 >= c.reward_rule_week_plus_one;
  }

  /** The minimum stake for week `w`: a change applies from the week after it was made. */
  minStakeFor(c: kpred.config_object, w: u64): u64 {
    return c.min_stake_next > 0 && w >= c.min_stake_next_week ? c.min_stake_next : c.min_stake;
  }

  /** Winners are the top 30% of eligible players with at least 1 point (weeks from v4 on); before: of all eligible. */
  scorerRule(c: kpred.config_object, w: u64): bool {
    return c.scorer_rule_week_plus_one > 0 && w + 1 >= c.scorer_rule_week_plus_one;
  }

  /** Smallest rc_limit the contract pays for: an amount too small to finish would revert at the pool's cost. */
  minSponsorRc(c: kpred.config_object): u64 {
    return c.min_sponsor_rc > 0 ? c.min_sponsor_rc : c.max_sponsor_rc / 2;
  }

  /** Week number of a time (times before the start count as week 0). */
  weekOf(c: kpred.config_object, t: u64): u64 {
    return t <= c.genesis_time ? 0 : (t - c.genesis_time) / c.week_length;
  }

  /** Time the week ends (ms). */
  weekEnd(c: kpred.config_object, w: u64): u64 {
    return c.genesis_time + (w + 1) * c.week_length;
  }

  entryKey(player: Uint8Array, w: u64): Uint8Array { return cat(player, u64Key(w)); }
  bucketKey(w: u64, points: u32): Uint8Array { return cat(u64Key(w), u32Key(points)); }

  /** Stake that counts for week `w`: active stake plus any pending deposit that has become active by then. */
  activeStake(p: kpred.player_object, w: u64): u64 {
    return p.pending > 0 && w >= p.pending_week ? p.stake + p.pending : p.stake;
  }

  /** Move a pending deposit into the active stake once its week has arrived. */
  normalize(p: kpred.player_object, w: u64): void {
    if (p.pending > 0 && w >= p.pending_week) {
      p.stake += p.pending;
      p.pending = 0;
    }
  }

  isOwner(c: kpred.config_object): bool {
    return System.checkAccountAuthority(c.owner!);
  }

  /** Make sure at least `amount` VHP is on hand, burning spare KOIN first if production has used some up. */
  ensureVhp(amount: u64): void {
    if (Tokens.vhpBalance(this.contractId) < amount) this.compoundInternal();
    System.require(Tokens.vhpBalance(this.contractId) >= amount, "not enough VHP on hand yet: run compound or try again after the next block reward");
  }

  /** What the contract owes, in KOIN-equivalent units (VHP and KOIN are 1:1). */
  liabilities(t: kpred.totals_object): u64 {
    // v6 (audit V6-4): summed in u128, so a broken counter can never wrap the total back into a passing number.
    const s = u128.fromU64(t.total_stake) + u128.fromU64(t.seed_vhp) + u128.fromU64(t.seed_koin) + u128.fromU64(t.owner_share)
      + u128.fromU64(t.creator_fee) + u128.fromU64(t.pots_outstanding) + u128.fromU64(t.fee_vhp) + u128.fromU64(t.games_rolled);
    System.require(s.hi == 0, "accounting error: what the vault owes is out of range");
    return s.lo;
  }

  /** v6 (audit V6-4): a counter of what the vault owes never goes below zero. A payout larger than what it is owed from
   *  is refused instead of wrapping the counter around. */
  less(have: u64, take: u64, what: string): u64 {
    System.require(take <= have, "accounting error: " + what + " would go below zero");
    return have - take;
  }

  /** Bring the "who produced it" accumulators up to the current block time. Call it before changing anything that
   *  produces: players' stake, the seed's VHP, unclaimed pots. */
  accrue(t: kpred.totals_object): void {
    const now = this.now();
    if (t.acc_time == 0) { t.acc_time = now; return; }   // first call after the upgrade: start measuring now
    if (now <= t.acc_time) return;
    const dt = u128.fromU64(now - t.acc_time);
    // Everything held that is not stake: the seed, unpaid pots, rollovers and (v6) the fee waiting in VHP.
    const house = t.seed_vhp + t.pots_outstanding + t.rolled_over + t.games_rolled + t.fee_vhp;
    const ap = new u128(t.acc_player_lo, t.acc_player_hi) + u128.fromU64(t.total_stake) * dt;
    const ah = new u128(t.acc_house_lo, t.acc_house_hi) + u128.fromU64(house) * dt;
    const as_ = new u128(t.acc_seed_lo, t.acc_seed_hi) + u128.fromU64(t.seed_vhp) * dt;   // v6: the seed's part
    t.acc_player_lo = ap.lo; t.acc_player_hi = ap.hi;
    t.acc_house_lo = ah.lo; t.acc_house_hi = ah.hi;
    t.acc_seed_lo = as_.lo; t.acc_seed_hi = as_.hi;
    t.acc_time = now;
  }

  /** Holdings must always cover everything owed. Checked after every reward/fee payout, so a bug can never pay out
   *  more than the pool has actually earned. (Principal returns — withdrawals, seed — are not blocked by it.) */
  assertSolvent(): void {
    const t = this.totals.get()!;
    const holdings = Tokens.vhpBalance(this.contractId) + Tokens.koinBalance(this.contractId);
    // v5 (audit G1-13): pots with no winners, waiting for the next close, are owed too.
    // v6 (audit V6-4): compared in u128, so no sum can wrap.
    System.require(u128.fromU64(holdings) >= u128.fromU64(this.liabilities(t)) + u128.fromU64(t.rolled_over),
      "solvency check failed: payout would exceed earned rewards");
  }

  // ───────────── automatic week progression ─────────────
  // A blockchain never runs code by itself: something has to send a transaction. So every game action
  // (deposit, withdraw, answer, settle, claim, compound, posting or resolving a question) first performs the
  // overdue steps — finalizing the oldest settled week and closing the next finished week (at most one of each) —
  // so the game moves forward on its own whenever anyone plays. The operator bot and the public close_week / finalize_week calls do the same thing.

  /** Earliest time week `w` may close: close_delay after the week ends AND close_delay after its latest resolution or
   *  correction, so every result can still be corrected for a while after it is posted. */
  closeAt(c: kpred.config_object, w: u64, wk: kpred.week_object): u64 {
    const a = this.weekEnd(c, w) + c.close_delay;
    const b = wk.last_resolved_time + c.close_delay;
    return a > b ? a : b;
  }

  /** Changes to week `w`'s posted results are accepted only while now + close_delay/4 is at most this. */
  correctionEnd(c: kpred.config_object, w: u64, wk: kpred.week_object): u64 {
    const a = this.weekEnd(c, w), b = wk.last_result_time;
    return (a > b ? a : b) + CORRECTION_DELAYS * c.close_delay;
  }

  closeDue(c: kpred.config_object, t: kpred.totals_object, h: u64): bool {
    const wk = this.weeks.get(u64Key(t.weeks_closed))!;
    if (h < this.closeAt(c, t.weeks_closed, wk)) return false;
    return wk.resolved == wk.questions;
  }

  finalizeDue(t: kpred.totals_object, h: u64): bool {
    if (t.weeks_finalized >= t.weeks_closed) return false;
    return h > this.weeks.get(u64Key(t.weeks_finalized))!.settle_end;
  }

  /** Refuses everything but getting money out when this is the withdrawals-only build (assembly/Mode.ts). */
  live(): void {
    System.require(!safeMode(), "the vault is in withdrawals-only mode: you can withdraw your stake and claim finished weeks");
  }

  advance(c: kpred.config_object): void {
    if (safeMode()) return;                          // withdrawals-only build: nothing moves forward
    const h = this.now();
    let t = this.totals.get()!;
    if (this.finalizeDue(t, h)) {
      this.finalizeStep(c, t.weeks_finalized);
      t = this.totals.get()!;
    }
    if (this.closeDue(c, t, h)) this.closeInternal(c, t.weeks_closed, h);
  }

  /** Settle the player's previous week automatically if its settlement window is open (players who keep
   *  playing are settled without doing anything; the bot and anyone else can settle the rest). */
  autoSettle(c: kpred.config_object, player: Uint8Array, p: kpred.player_object): void {
    if (p.last_week_plus_one == 0) return;
    const w = p.last_week_plus_one - 1;
    if (this.settleCheck(player, w).length == 0) this.settleInternal(c, player, w);
  }

  compoundInternal(): u64 {
    const t = this.totals.get()!;
    const koinBal = Tokens.koinBalance(this.contractId);
    const keep = t.seed_koin + t.creator_fee;           // the Mana reserve and unpaid creator fees stay as KOIN
    if (koinBal <= keep) return 0;
    let amount = koinBal - keep;
    const mana = Tokens.mana(this.contractId);
    if (amount > mana) amount = mana;                   // burning needs Mana ≥ amount
    if (amount == 0) return 0;
    Tokens.burnOwnKoin(amount);
    return amount;
  }

  // ═══════════════════════ checks shared by the entry points and `authorize` ═══════════════════════
  // They return "" when the action is valid, otherwise the reason. `authorize` runs them before agreeing to pay
  // for a transaction, so an invalid sponsored transaction is refused for free instead of wasting the pool's Mana.

  answerCheck(c: kpred.config_object, player: Uint8Array, id: u32, option: u32): string {
    const q = this.questions.get(u32Key(id));
    if (!q) return "no such question";
    if (q.outcome != 0) return "question already resolved";
    if (this.now() >= q.lock_time) return "answers for this question are closed";
    if (option >= q.k) return "no such option";
    const p = this.players.get(player)!;
    // Free play: anyone may answer and earn points. Rewards are points × stake, so a player with no stake (or less
    // than min_stake) is never eligible for a share: they appear on the leaderboard but are paid nothing.
    if (p.void_week_plus_one == q.week + 1) return "you withdrew this week, so this week's answers don't count";
    const e = this.entries.get(this.entryKey(player, q.week));
    if (e) {
      for (let i = 0; i < e.answers.length; i++) if (e.answers[i].question_id == id) return "already answered";
    }
    return "";
  }

  settleCheck(player: Uint8Array, w: u64): string {
    const wk = this.weeks.get(u64Key(w))!;
    if (!wk.closed) return "week not closed yet";
    const h = this.now();
    if (h < wk.settle_start || h > wk.settle_end) return "outside the settlement window";
    const e = this.entries.get(this.entryKey(player, w));
    if (!e) return "no answers that week";
    if (e.settled) return "already settled";
    return "";
  }

  /** v5: what a free player's claim pays for a finalized week (0 = not one of the 2 best free players). The best score
   *  takes 1 VHP (all of the prize if two or more share it, split evenly); the second score shares the other 1 VHP. */
  freePrizeOf(wk: kpred.week_object, e: kpred.entry_object): u64 {
    if (!wk.reward_rule || wk.pot_free == 0 || !e.free_player || e.eligible || e.voided || e.counted < 2 || e.points == 0) return 0;
    if (wk.prize_v6) {
      // v6: 2 VHP for 1st and 1 VHP for 2nd (of whatever was funded); players tied for 1st share both places.
      if (e.points == wk.free_best) {
        if (wk.free_best_n >= 2) return wk.pot_free / <u64>wk.free_best_n;
        return wk.free_second_n > 0 ? prizeFirst(wk.pot_free) : wk.pot_free;   // alone: finalize already returned 2nd's part
      }
      if (e.points == wk.free_second && wk.free_best_n == 1 && wk.free_second_n > 0) return (wk.pot_free - prizeFirst(wk.pot_free)) / <u64>wk.free_second_n;
      return 0;
    }
    if (e.points == wk.free_best) {
      if (wk.free_best_n >= 2) return wk.pot_free / <u64>wk.free_best_n;
      return wk.free_second_n > 0 ? wk.pot_free / 2 : wk.pot_free;
    }
    if (e.points == wk.free_second && wk.free_best_n == 1 && wk.free_second_n > 0) return (wk.pot_free - wk.pot_free / 2) / <u64>wk.free_second_n;
    return 0;
  }

  claimCheck(player: Uint8Array, w: u64): string {
    const wk = this.weeks.get(u64Key(w))!;
    if (!wk.finalized) return "week not finalized yet";
    const e = this.entries.get(this.entryKey(player, w));
    // v5: the free players' prize is paid even in a week with no staked winner (only the rest of that pot rolls over).
    if (e && e.settled && !e.eligible && this.freePrizeOf(wk, e) > 0) return e.claimed ? "already claimed" : "";
    if (wk.rolled_over) return "no winners that week";
    if (!e || !e.settled || !e.eligible) return "not eligible that week";
    if (e.points < wk.cutoff) return "below the winners' cutoff";
    if (e.claimed) return "already claimed";
    return "";
  }

  // ═══════════════════════ read-only ═══════════════════════

  get_state(args: kpred.get_state_arguments): kpred.get_state_result {
    const r = new kpred.get_state_result();
    const c = this.config.get()!;
    r.config = c;
    r.totals = this.totals.get()!;
    r.height = this.height();
    r.time = this.now();
    if (isAddress(c.owner)) {
      r.week = this.weekOf(c, r.time);
      r.week_end = this.weekEnd(c, r.week);
    }
    r.vhp_balance = Tokens.vhpBalance(this.contractId);
    r.koin_balance = Tokens.koinBalance(this.contractId);
    r.mana = Tokens.mana(this.contractId);
    r.upgrade = this.upgrade.get()!;
    r.seed_withdrawal = this.seedWd.get()!;
    return r;
  }

  get_player(args: kpred.get_player_arguments): kpred.get_player_result {
    const r = new kpred.get_player_result();
    const p = this.players.get(args.player!)!;
    r.player = p;
    r.active_stake = this.activeStake(p, args.week);
    r.entry = this.entries.get(this.entryKey(args.player!, args.week));
    return r;
  }

  get_question(args: kpred.get_question_arguments): kpred.get_question_result {
    const r = new kpred.get_question_result();
    r.question = this.questions.get(u32Key(args.id));
    return r;
  }

  get_week(args: kpred.get_week_arguments): kpred.get_week_result {
    const r = new kpred.get_week_result();
    const wk = this.weeks.get(u64Key(args.week))!;
    r.week = wk;
    for (let p: u32 = 0; p <= wk.max_points; p++) r.buckets.push(this.buckets.get(this.bucketKey(args.week, p))!);
    return r;
  }

  list_players(args: kpred.list_players_arguments): kpred.list_players_result {
    const r = new kpred.list_players_result();
    const limit: i32 = args.limit == 0 || args.limit > 50 ? 50 : <i32>args.limit;
    const start = args.start != null ? args.start! : new Uint8Array(0);
    const objs = this.players.getMany(start, limit);
    for (let i = 0; i < objs.length; i++) {
      const row = new kpred.player_row();
      row.address = objs[i].key!;
      row.player = objs[i].value;
      row.active_stake = this.activeStake(objs[i].value, args.week);
      row.entry = this.entries.get(this.entryKey(objs[i].key!, args.week));
      r.rows.push(row);
    }
    return r;
  }

  // ═══════════════════════ setup ═══════════════════════

  init(args: kpred.init_arguments): kpred.init_result {
    const c = this.config.get()!;
    System.require(!isAddress(c.owner), "already initialised");
    System.require(BUILD_FOR_TESTING || this.signedByContractKey(), "init must be signed by the contract's own key");
    System.require(isAddress(args.owner) && isAddress(args.operator) && isAddress(args.seed_owner), "owner, operator and seed owner are required");
    System.require(args.week_length > 0 && args.settle_length > 0, "week_length and settle_length must be positive");
    System.require(args.timelock_length > 0, "timelock must be positive");
    System.require(args.max_sponsor_rc <= MAX_SPONSOR_LIMIT, "at most 10 KOIN of Mana per free transaction");
    System.require(args.min_stake > 0, "min_stake must be positive");
    c.owner = args.owner;
    c.operator = args.operator;
    c.seed_owner = args.seed_owner;
    c.genesis_time = args.genesis_time;
    c.week_length = args.week_length;
    c.close_delay = args.close_delay;
    c.settle_length = args.settle_length;
    c.timelock_length = args.timelock_length;
    c.min_stake = args.min_stake;
    c.max_sponsor_rc = args.max_sponsor_rc;
    c.scorer_rule_week_plus_one = 1;
    c.reward_rule_week_plus_one = 1;
    c.v6_rule_week_plus_one = initV6Rule;
    this.config.put(c);
    this.initQuestionGame(0);
    return new kpred.init_result();
  }

  signedByContractKey(): bool {
    const txId = System.getTransactionField("id")!.bytes_value;
    const sigs = Protobuf.decode<value.list_type>(System.getTransactionField("signatures")!.message_value!.value!, value.list_type.decode);
    for (let i = 0; i < sigs.values.length; i++) {
      const key = System.recoverPublicKey(sigs.values[i].bytes_value, txId);
      if (key && Arrays.equal(Crypto.addressFromPublicKey(key), this.contractId)) return true;
    }
    return false;
  }

  // ═══════════════════════ players ═══════════════════════

  deposit(from: Uint8Array, amount: u64, isKoin: bool): void {
    const c = this.cfg();
    this.advance(c);
    System.require(!c.paused, "new deposits are paused");
    System.require(amount > 0, "amount must be positive");
    System.require(amount % WHOLE == 0, "stake whole numbers only (1, 2, 3 …)");
    System.requireAuthority(authority.authorization_type.contract_call, from);
    if (isKoin) {
      Tokens.pullKoin(from, amount);
      Tokens.burnOwnKoin(amount);
    } else {
      Tokens.pullVhp(from, amount);
    }
    const h = this.now();
    const w = this.weekOf(c, h);
    const p = this.players.get(from)!;
    this.autoSettle(c, from, p);
    this.normalize(p, w);
    // Counts from the next week. Before the game starts (genesis), it counts from week 0.
    p.pending += amount;
    p.pending_week = h < c.genesis_time ? 0 : w + 1;
    this.players.put(from, p);
    const t = this.totals.get()!;
    this.accrue(t);
    t.total_stake += amount;
    this.totals.put(t);
    this.gameStakeAdd(Q_GAME, amount, p.pending_week);
  }

  deposit_vhp(args: kpred.deposit_vhp_arguments): kpred.deposit_vhp_result {
    this.live();
    this.deposit(args.from!, args.amount, false);
    return new kpred.deposit_vhp_result();
  }

  deposit_koin(args: kpred.deposit_koin_arguments): kpred.deposit_koin_result {
    this.live();
    this.deposit(args.from!, args.amount, true);
    return new kpred.deposit_koin_result();
  }

  /** v6 (rule 1 of docs/V6-PLAN.md): a withdrawal touches only the player's own records, the totals and the token
   *  transfer. It no longer closes or finalizes weeks or settles the player's last week first (v5 did), so nothing
   *  that can go wrong in a week's results can ever stand between a player and their stake. */
  withdraw(args: kpred.withdraw_arguments): kpred.withdraw_result {
    const c = this.cfg();
    const to = args.to!;
    System.requireAuthority(authority.authorization_type.contract_call, to);
    System.require(args.amount > 0, "amount must be positive");
    const fromWeek = this.takeQ(c, to, args.amount);
    const t = this.totals.get()!;
    this.accrue(t);
    t.total_stake -= args.amount;
    this.totals.put(t);
    this.gameStakeSub(Q_GAME, args.amount - fromWeek, fromWeek);
    this.ensureVhp(args.amount);
    Tokens.sendVhp(to, args.amount);
    return new kpred.withdraw_result();
  }

  /** Take `amount` out of a player's question-game stake (a withdrawal, or the source of a move). Returns the part
   *  taken from this week's stake (the rest came from deposits that don't count yet). */
  takeQ(c: kpred.config_object, to: Uint8Array, amount: u64): u64 {
    const h = this.now();
    const w = this.weekOf(c, h);
    const p = this.players.get(to)!;
    this.normalize(p, w);
    System.require(p.stake + p.pending >= amount, "more than your stake");
    // Take the not-yet-active part first.
    let rest = amount;
    const fromPending = rest < p.pending ? rest : p.pending;
    p.pending -= fromPending;
    rest -= fromPending;
    p.stake -= rest;
    // During a running week (only when this week's stake is touched; taking back a not-yet-active top-up changes nothing):
    //   - withdrawing ALL of this week's stake takes the player out of the week: their answers stop counting;
    //   - withdrawing PART keeps them in, with the lower stake as their multiplier for the week.
    if (h >= c.genesis_time && rest > 0) {
      const key = this.entryKey(to, w);
      const e = this.entries.get(key);
      if (p.stake == 0) {
        p.void_week_plus_one = w + 1;
        if (e && !e.voided) {
          e.voided = true;
          this.entries.put(key, e);
        }
      } else if (e && !e.voided && e.stake > p.stake) {
        e.stake = p.stake;
        this.entries.put(key, e);
      }
    }
    this.players.put(to, p);
    return rest;
  }

  answer(args: kpred.answer_arguments): kpred.answer_result {
    this.live();
    const c = this.cfg();
    const player = args.player!;
    System.requireAuthority(authority.authorization_type.contract_call, player);
    const why = this.answerCheck(c, player, args.question_id, args.option);
    System.require(why.length == 0, why);
    this.advance(c);
    const q = this.questions.get(u32Key(args.question_id))!;
    const p = this.players.get(player)!;
    this.autoSettle(c, player, p);
    const key = this.entryKey(player, q.week);
    let e = this.entries.get(key);
    if (!e) {
      e = new kpred.entry_object();
      e.stake = this.activeStake(p, q.week);        // stake at the start of the week
      e.peak_stake = e.stake;                        // v5: a later partial withdrawal never lowers this
      p.last_week_plus_one = q.week + 1;
      this.players.put(player, p);
    }
    const a = new kpred.answer_record();
    a.question_id = args.question_id;
    a.option = args.option;
    e.answers.push(a);
    this.entries.put(key, e);
    return new kpred.answer_result();
  }

  settle(args: kpred.settle_arguments): kpred.settle_result {
    this.live();
    const c = this.cfg();
    this.advance(c);
    const player = args.player!;
    const why = this.settleCheck(player, args.week);
    System.require(why.length == 0, why);
    return this.settleInternal(c, player, args.week);
  }

  settleInternal(c: kpred.config_object, player: Uint8Array, week: u64): kpred.settle_result {
    const key = this.entryKey(player, week);
    const e = this.entries.get(key)!;
    e.settled = true;
    let points: u32 = 0, counted: u32 = 0;
    if (!e.voided) {
      for (let i = 0; i < e.answers.length; i++) {
        const q = this.questions.get(u32Key(e.answers[i].question_id))!;
        if (q.outcome == VOID) continue;
        counted++;
        if (q.outcome == e.answers[i].option + 1) points++;
      }
    }
    e.points = points;
    e.counted = counted;
    // Eligible: not voided, more than one counted answer, a stake, and at least that week's minimum stake.
    e.eligible = !e.voided && counted > 1 && e.stake > 0 && e.stake >= this.minStakeFor(c, week);
    this.entries.put(key, e);
    if (e.eligible) {
      const wk = this.weeks.get(u64Key(week))!;
      const bk = this.bucketKey(week, points);
      const b = this.buckets.get(bk)!;
      b.stake += e.stake;
      b.capped += e.stake < V5_CAP_A ? e.stake : V5_CAP_A;
      b.players += 1;
      this.buckets.put(bk, b);
      wk.eligible_stake += e.stake;
      wk.eligible_players += 1;
      if (points > wk.max_points) wk.max_points = points;
      this.weeks.put(u64Key(week), wk);
    } else if (!e.voided && counted > 1 && points >= 1 && (e.peak_stake > e.stake ? e.peak_stake : e.stake) < this.minStakeFor(c, week)) {
      // v5: a free player (never staked the minimum this week; a staked player who withdrew down below it is not one):
      // keep the two best free scores and how many share each.
      const wk = this.weeks.get(u64Key(week))!;
      if (wk.reward_rule) {
        e.free_player = true;
        this.entries.put(key, e);
        if (points > wk.free_best) { wk.free_second = wk.free_best; wk.free_second_n = wk.free_best_n; wk.free_best = points; wk.free_best_n = 1; }
        else if (points == wk.free_best) wk.free_best_n += 1;
        else if (points > wk.free_second) { wk.free_second = points; wk.free_second_n = 1; }
        else if (points == wk.free_second) wk.free_second_n += 1;
        this.weeks.put(u64Key(week), wk);
      }
    }
    const r = new kpred.settle_result();
    r.points = points;
    r.eligible = e.eligible;
    return r;
  }

  /** What a winner's claim pays for week w. */
  rewardOf(w: u64, wk: kpred.week_object, e: kpred.entry_object): u64 {
    // Basket A (by rank): pot_a × (this score group's rank weight ÷ its players) ÷ all winners' rank weight.
    // Basket B (by rank × stake): pot_b × (rank weight ÷ players × stake) ÷ the same total over all winners.
    // Every step rounds down, so the claims of a week can never add up to more than its pot.
    const b = this.buckets.get(this.bucketKey(w, e.points))!;
    const n = u128.fromU64(<u64>b.players);
    let reward: u64 = 0;
    const aw = new u128(wk.aw_lo, wk.aw_hi);
    if (wk.reward_rule) {
      // v5 basket A (by rank x stake up to 10 VHP): pot_a x (rank weight / players x capped stake) / the same over all winners.
      if (!aw.isZero()) {
        const capped = e.stake < V5_CAP_A ? e.stake : V5_CAP_A;
        reward = u128.muldiv(u128.fromU64(wk.pot_a), u128.muldiv(u128.fromU64(b.sum_w), u128.fromU64(capped), n), aw).toU64();
      }
    } else {
      reward = u128.muldiv(u128.fromU64(wk.pot_a), u128.fromU64(b.sum_w), n * u128.fromU64(wk.sum_w)).toU64();
    }
    const bw = new u128(wk.bw_lo, wk.bw_hi);
    if (!bw.isZero()) {
      const mine = u128.muldiv(u128.fromU64(b.sum_w), u128.fromU64(e.stake), n);
      reward += u128.muldiv(u128.fromU64(wk.pot_b), mine, bw).toU64();
    }
    return reward;
  }

  claim(args: kpred.claim_arguments): kpred.claim_result {
    const player = args.player!;
    System.requireAuthority(authority.authorization_type.contract_call, player);
    this.advance(this.cfg());
    const why = this.claimCheck(player, args.week);
    System.require(why.length == 0, why);
    const wkKey = u64Key(args.week);
    const wk = this.weeks.get(wkKey)!;
    const key = this.entryKey(player, args.week);
    const e = this.entries.get(key)!;
    const reward = e.eligible ? this.rewardOf(args.week, wk, e) : this.freePrizeOf(wk, e);
    // v6 (audit V6-1, defence in depth): a week never pays out more than its own pot.
    System.require(wk.claimed + reward <= wk.pot, "accounting error: that week's pot is used up");
    e.claimed = true;
    e.reward = reward;
    this.entries.put(key, e);
    wk.claimed += reward;
    this.weeks.put(wkKey, wk);
    const t = this.totals.get()!;
    this.accrue(t);
    t.pots_outstanding = this.less(t.pots_outstanding, reward, "unpaid rewards");
    this.totals.put(t);
    this.ensureVhp(reward);
    Tokens.sendVhp(player, reward);
    this.assertSolvent();
    const r = new kpred.claim_result();
    r.reward = reward;
    return r;
  }

  // ═══════════════════════ anyone ═══════════════════════

  compound(args: kpred.compound_arguments): kpred.compound_result {
    this.advance(this.cfg());
    const r = new kpred.compound_result();
    r.burned = this.compoundInternal();
    return r;
  }

  close_week(args: kpred.close_week_arguments): kpred.close_week_result {
    this.live();
    const c = this.cfg();
    const t = this.totals.get()!;
    System.require(args.week == t.weeks_closed, "weeks close in order: close week " + t.weeks_closed.toString() + " first");
    const h = this.now();
    const wk = this.weeks.get(u64Key(args.week))!;
    System.require(h >= this.closeAt(c, args.week, wk), "too early to close this week");
    System.require(wk.resolved == wk.questions, "some questions are not resolved yet");
    return this.closeInternal(c, args.week, h);
  }

  /** Measure the gain since the previous close and move it into what the contract owes (fee, share, pot).
   *  Each unit of gain is counted exactly once: after a close, holdings = liabilities again, so the next close
   *  only sees what was produced afterwards. Claims and withdrawals lower holdings and liabilities by the same
   *  amount, so their timing never changes any week's measured gain. */
  closeInternal(c: kpred.config_object, week: u64, h: u64): kpred.close_week_result {
    if (this.v6Rule(c, week)) return this.closeV6(c, week, h);
    const t = this.totals.get()!;
    this.accrue(t);
    const wkKey = u64Key(week);
    const wk = this.weeks.get(wkKey)!;
    // Gain = everything the contract holds minus everything it owes.
    const holdings = Tokens.vhpBalance(this.contractId) + Tokens.koinBalance(this.contractId);
    const owed = this.liabilities(t);
    const gain = holdings > owed ? holdings - owed : 0;
    // A pot that had no winners was already charged the fee when it was first earned: it rolls in fee-free.
    const carried = t.rolled_over < gain ? t.rolled_over : gain;
    const fresh = gain - carried;
    const fee = bps(fresh, FEE_BPS);
    const net = fresh - fee;
    // Who produced the new earnings: the house (seed + unclaimed pots) or players' stake, weighted by time.
    const ap = new u128(t.acc_player_lo, t.acc_player_hi), ah = new u128(t.acc_house_lo, t.acc_house_hi);
    let housePpm: u64;
    if ((ap + ah).isZero()) {
      const house = t.seed_vhp + t.pots_outstanding + t.rolled_over, all = house + t.total_stake;
      housePpm = all == 0 ? 1_000_000 : u128.muldiv(u128.fromU64(house), u128.fromU64(1_000_000), u128.fromU64(all)).toU64();
    } else {
      housePpm = u128.muldiv(ah, u128.fromU64(1_000_000), ap + ah).toU64();
    }
    const houseNet = u128.muldiv(u128.fromU64(net), u128.fromU64(housePpm), u128.fromU64(1_000_000)).toU64() + carried;
    const pot = gain - fee;
    const v5 = this.rewardRule(c, week);
    const potFree: u64 = v5 ? (pot < FREE_PRIZE ? pot : FREE_PRIZE) : 0;
    const potA = v5 ? bps(pot - potFree, V5_BASKET_A_BPS) : bps(houseNet, BASKET_A_BPS);
    const retained: u64 = 0;                          // the owner share is retired
    t.acc_player_lo = 0; t.acc_player_hi = 0; t.acc_house_lo = 0; t.acc_house_hi = 0;
    t.acc_seed_lo = 0; t.acc_seed_hi = 0;
    t.rolled_over = 0;
    t.creator_fee += fee;
    t.pots_outstanding += pot;
    t.total_gain += gain;
    t.weeks_closed += 1;
    this.totals.put(t);
    wk.closed = true;
    wk.gain = gain;
    wk.fee = fee;
    wk.retained = retained;
    wk.pot = pot;
    wk.pot_a = potA;
    wk.pot_free = potFree;
    wk.pot_b = pot - potA - potFree;
    wk.house_ppm = housePpm;
    wk.reward_rule = v5;
    wk.settle_start = h;
    wk.settle_end = h + c.settle_length;
    this.weeks.put(wkKey, wk);
    const r = new kpred.close_week_result();
    r.gain = gain;
    r.pot = pot;
    return r;
  }

  finalize_week(args: kpred.finalize_week_arguments): kpred.finalize_week_result {
    this.live();
    const c = this.cfg();
    const wk = this.weeks.get(u64Key(args.week))!;
    System.require(wk.closed, "week not closed yet");
    System.require(!wk.finalized, "already finalized");
    System.require(args.week == this.totals.get()!.weeks_finalized, "weeks finalize in order");
    System.require(this.now() > wk.settle_end, "settlement window still open");
    return this.finalizeStep(c, args.week);
  }

  /** One page of finalization. The first page finds the cutoff; each page then gives out up to `finalizePage` places
   *  (rank weights), so no transaction ever has to loop over every winner. The last page marks the week final. */
  finalizeStep(c: kpred.config_object, week: u64): kpred.finalize_week_result {
    const wkKey = u64Key(week);
    const wk = this.weeks.get(wkKey)!;
    if (!wk.fin_started) {
      // Walk down from the highest score until the winners are at least 30% of the eligible players (ties included).
      // Only staked players take places; a score of 0 never wins and (from v4) does not count toward the 30%.
      let players = <u64>wk.eligible_players;
      if (this.scorerRule(c, week)) players -= <u64>this.buckets.get(this.bucketKey(week, 0))!.players;
      const need = (players * WIN_PCT + 99) / 100;
      let cutoff: u32 = 0;
      let cum: u64 = 0;
      if (need > 0) {
        for (let p = wk.max_points; p >= 1; p--) {
          cum += <u64>this.buckets.get(this.bucketKey(week, p))!.players;
          cutoff = p;
          if (cum >= need) break;
        }
      }
      wk.cutoff = cutoff;
      wk.fin_started = true;
      wk.fin_points = cutoff >= 1 ? wk.max_points : 0;
      wk.fin_index = 0;
      wk.fin_rank = 1;
      wk.fin_gw = 0;
      wk.winners = 0;
      wk.sum_w = 0;
      wk.bw_lo = 0;
      wk.bw_hi = 0;
      wk.aw_lo = 0;
      wk.aw_hi = 0;
    }
    // Give each winning score group its places' rank weights (players tied share their places evenly).
    const cutoff = wk.cutoff;
    let budget = finalizePage;
    let bw = new u128(wk.bw_lo, wk.bw_hi);
    let aw = new u128(wk.aw_lo, wk.aw_hi);
    while (cutoff >= 1 && wk.fin_points >= cutoff && budget > 0) {
      const bk = this.bucketKey(week, wk.fin_points);
      const b = this.buckets.get(bk)!;
      while (wk.fin_index < b.players && budget > 0) {
        wk.fin_gw += rankWeight(wk.fin_rank);
        wk.fin_rank++;
        wk.fin_index++;
        budget--;
      }
      if (wk.fin_index < b.players) break;              // the page is used up: continue with this group next time
      if (b.players > 0) {
        b.sum_w = wk.fin_gw;
        this.buckets.put(bk, b);
        wk.sum_w += wk.fin_gw;
        bw = bw + u128.muldiv(u128.fromU64(wk.fin_gw), u128.fromU64(b.stake), u128.fromU64(<u64>b.players));
        aw = aw + u128.muldiv(u128.fromU64(wk.fin_gw), u128.fromU64(b.capped), u128.fromU64(<u64>b.players));
        wk.winners += b.players;
      }
      wk.fin_points -= 1;
      wk.fin_index = 0;
      wk.fin_gw = 0;
    }
    wk.bw_lo = bw.lo;
    wk.bw_hi = bw.hi;
    wk.aw_lo = aw.lo;
    wk.aw_hi = aw.hi;
    const done = cutoff < 1 || wk.fin_points < cutoff;
    if (done) {
      wk.finalized = true;
      // v5: the free players' prize. Nobody qualified: it all goes to basket B. Only one free player scored: they get
      // 1 VHP (half), the other half goes to basket B. Otherwise it is paid out by freePrizeOf.
      if (wk.pot_free > 0) {
        let back: u64 = 0;
        if (wk.free_best_n == 0) back = wk.pot_free;
        else if (wk.free_best_n == 1 && wk.free_second_n == 0) back = wk.prize_v6 ? wk.pot_free - prizeFirst(wk.pot_free) : wk.pot_free - wk.pot_free / 2;
        wk.pot_free -= back;
        if (wk.prize_v6) {
          // v6: an unfilled place goes back to the pool, fee-free, as in every other game (owner, 2026-10-28).
          wk.pot -= back;
          const tb = this.totals.get()!;
          this.accrue(tb);
          tb.pots_outstanding = this.less(tb.pots_outstanding, back, "unpaid rewards");
          tb.rolled_over += back;
          this.totals.put(tb);
        } else {
          wk.pot_b += back;                           // v5 weeks keep the v5 rule: to the stakers' basket B
        }
      }
      const tf = this.totals.get()!;
      tf.weeks_finalized += 1;
      this.totals.put(tf);
      if (wk.winners > 0 && bw.isZero()) { wk.pot_a += wk.pot_b; wk.pot_b = 0; }   // only if every winner had 0 stake (not possible from v4)
      if (wk.reward_rule && wk.winners > 0 && aw.isZero()) { wk.pot_b += wk.pot_a; wk.pot_a = 0; }   // likewise (not possible: winners hold >= 1 VHP)
      if (wk.winners == 0) {
        // Nobody scored: the pot goes back into the pool and is paid out with the next week's (without a second fee).
        // v5: the free players' prize that is owed (pot_free, after the fallbacks above) stays to be claimed.
        wk.rolled_over = true;
        const moved = wk.pot - wk.pot_free;
        const t = this.totals.get()!;
        this.accrue(t);
        t.pots_outstanding = this.less(t.pots_outstanding, moved, "unpaid rewards");
        if (wk.prize_v6) {
          // v6: a bucket with no winner stays in its own game: it is added to the question game's next pot, fee-free.
          t.games_rolled += moved;
          const g1 = this.games.get(u32Key(Q_GAME))!;
          g1.rolled += moved;
          this.games.put(u32Key(Q_GAME), g1);
        } else {
          t.rolled_over += moved;
        }
        this.totals.put(t);
      }
    }
    this.weeks.put(wkKey, wk);
    const r = new kpred.finalize_week_result();
    r.cutoff = cutoff;
    r.winners = wk.winners;
    r.done = done;
    return r;
  }

  // ═══════════════════════ operator ═══════════════════════

  post_question(args: kpred.post_question_arguments): kpred.post_question_result {
    this.live();
    const c = this.cfg();
    System.requireAuthority(authority.authorization_type.contract_call, c.operator!);
    this.advance(c);
    const h = this.height();
    const now = this.now();
    System.require(now >= c.genesis_time, "the game has not started yet");
    const w = this.weekOf(c, now);
    System.require(args.k >= 2 && args.k <= 16, "2 to 16 options");
    System.require(args.lock_time > now, "answers must close in the future");
    System.require(args.lock_time - now >= c.week_length / MIN_ANSWER_DIVISOR, "answers must stay open for at least 1 hour (1/168 of a week)");
    System.require(args.lock_time <= this.weekEnd(c, w), "answers must close before the week ends");
    // The watched blocks must come after answers close, even if blocks ran faster than normal until then.
    const minStart = h + (args.lock_time - now + MIN_BLOCK_MS - 1) / MIN_BLOCK_MS;
    System.require(args.window_start >= minStart && args.window_end >= args.window_start, "the window must start after answers close");
    // The window must finish (and be final) by the time the week is due to close, even if blocks ran slower than
    // normal, so no question can hold a week open.
    const due = this.weekEnd(c, w) + c.close_delay;
    // (Written with a division so that no window_end, however large, can overflow the arithmetic.)
    const span = (due - now) / MAX_BLOCK_MS;
    System.require(span >= RESOLVE_MARGIN && args.window_end <= h + span - RESOLVE_MARGIN, "the window must end before the week is due to close");
    System.require(args.params_hash != null && args.params_hash!.length == 32, "params_hash must be 32 bytes");
    const wkKey = u64Key(w);
    const wk = this.weeks.get(wkKey)!;
    System.require(!wk.closed, "week already closed");
    System.require(wk.questions < MAX_QUESTIONS_PER_WEEK, "too many questions this week");
    const t = this.totals.get()!;
    const id = t.next_question_id;
    t.next_question_id += 1;
    this.totals.put(t);
    const q = new kpred.question_object();
    q.week = w;
    q.k = args.k;
    q.lock_time = args.lock_time;
    q.window_start = args.window_start;
    q.window_end = args.window_end;
    q.params_hash = args.params_hash;
    q.released_height = h;
    this.questions.put(u32Key(id), q);
    wk.questions += 1;
    this.weeks.put(wkKey, wk);
    const r = new kpred.post_question_result();
    r.id = id;
    return r;
  }

  setOutcome(q: kpred.question_object, outcome: u32, dataHash: Uint8Array | null): void {
    System.require(outcome == VOID || outcome < q.k, "outcome must be an option number or 1000 (void)");
    System.require(dataHash != null && dataHash!.length == 32, "data_hash must be 32 bytes");
    q.outcome = outcome == VOID ? VOID : outcome + 1;
    q.data_hash = dataHash;
    q.resolved_height = this.height();
  }

  resolve_question(args: kpred.resolve_question_arguments): kpred.resolve_question_result {
    this.live();
    const c = this.cfg();
    System.requireAuthority(authority.authorization_type.contract_call, c.operator!);
    const key = u32Key(args.id);
    const q = this.questions.get(key);
    System.require(q != null, "no such question");
    System.require(q!.outcome == 0, "already resolved (the owner can correct it before the week closes)");
    System.require(this.height() > q!.window_end + RESOLVE_MARGIN, "the window's blocks are not final yet");
    this.setOutcome(q!, args.outcome, args.data_hash);
    this.questions.put(key, q!);
    const wkKey = u64Key(q!.week);
    const wk = this.weeks.get(wkKey)!;
    wk.resolved += 1;
    wk.last_resolved_time = this.now();             // the owner can correct it for close_delay before the week closes
    wk.last_result_time = wk.last_resolved_time;
    this.weeks.put(wkKey, wk);
    this.advance(c);                                // an earlier finished week may close now; never this one at once
    return new kpred.resolve_question_result();
  }

  // ═══════════════════════ owner ═══════════════════════

  correct_question(args: kpred.correct_question_arguments): kpred.correct_question_result {
    this.live();
    const c = this.cfg();
    System.require(this.isOwner(c), "owner only");
    const key = u32Key(args.id);
    const q = this.questions.get(key);
    System.require(q != null, "no such question");
    const wkKey = u64Key(q!.week);
    const wk = this.weeks.get(wkKey)!;
    System.require(!wk.closed, "the week is closed; resolutions are final");
    const now = this.now();
    if (q!.outcome == 0) {
      // Still open (e.g. the bot is down or its key was lost): the owner may only VOID it, so the week can close.
      System.require(args.outcome == VOID, "an open question can only be voided (outcome 1000)");
      this.setOutcome(q!, args.outcome, args.data_hash);
      this.questions.put(key, q!);
      wk.resolved += 1;
      wk.last_resolved_time = now;
      wk.last_result_time = now;
      this.weeks.put(wkKey, wk);
      this.advance(c);
    } else {
      // Changing a posted result: never in the last quarter of the correction time before the close, so a change is
      // always visible (and can be changed back) for a while before results are final. A change of outcome restarts
      // the correction time; a new data_hash alone does not. Changes end CORRECTION_DELAYS close_delays after the
      // week (correctionEnd), so they cannot keep a finished week open.
      System.require(now + c.close_delay / 4 <= this.closeAt(c, q!.week, wk),
        "too close to the week's close to change a result (changes stop a quarter of close_delay before it)");
      System.require(now + c.close_delay / 4 <= this.correctionEnd(c, q!.week, wk),
        "the time for changing this week's results is over");
      const changed = q!.outcome != (args.outcome == VOID ? VOID : args.outcome + 1);
      this.setOutcome(q!, args.outcome, args.data_hash);
      this.questions.put(key, q!);
      if (changed) {
        wk.last_resolved_time = now;
        this.weeks.put(wkKey, wk);
      }
    }
    return new kpred.correct_question_result();
  }

  cancel_upgrade(args: kpred.cancel_upgrade_arguments): kpred.cancel_upgrade_result {
    const c = this.cfg();
    System.require(this.isOwner(c), "owner only");
    this.upgrade.put(new kpred.timelock_object());
    return new kpred.cancel_upgrade_result();
  }

  set_sponsor_limit(args: kpred.set_sponsor_limit_arguments): kpred.set_sponsor_limit_result {
    const c = this.cfg();
    System.require(this.isOwner(c), "owner only");
    System.require(args.max_sponsor_rc <= MAX_SPONSOR_LIMIT, "at most 10 KOIN of Mana per free transaction");
    System.require(args.min_sponsor_rc <= args.max_sponsor_rc, "the smallest rc_limit cannot be above the largest");
    c.max_sponsor_rc = args.max_sponsor_rc;
    c.min_sponsor_rc = args.min_sponsor_rc;
    this.config.put(c);
    return new kpred.set_sponsor_limit_result();
  }

  set_min_stake(args: kpred.set_min_stake_arguments): kpred.set_min_stake_result {
    this.live();
    const c = this.cfg();
    System.require(this.isOwner(c), "owner only");
    System.require(args.min_stake > 0, "the minimum stake can never be 0");
    const cur = this.weekOf(c, this.now());
    // v5 (review): a change already promised for a week that starts within the notice time can't be overridden: the
    // players who deposited for it were told that value.
    System.require(!(c.min_stake_next > 0 && c.min_stake_next_week > cur && this.weekEnd(c, c.min_stake_next_week - 1) - this.now() < c.timelock_length),
      "a minimum-stake change already takes effect within 48 hours: try again after it starts");
    if (c.min_stake_next > 0 && c.min_stake_next_week <= cur) {
      // The earlier change is in use. Fold it in only once no unfinalized week still uses the value before it.
      const wf = this.totals.get()!.weeks_finalized;
      System.require(c.min_stake_next_week <= wf,
        "the previous change still decides week " + wf.toString() + "'s results: try again after that week is finalized");
      // v6 (audit V6-7): the other games' results for the week before it still use the value before it, until their
      // results deadline and the owner's correction time after it have passed.
      if (c.min_stake_next_week > 0) {
        const lastOld = c.min_stake_next_week - 1;
        System.require(!this.v6Rule(c, lastOld) || this.now() >= this.resultsDue(c, lastOld) + CORRECTION_DELAYS * c.close_delay,
          "the previous change still decides the other games' results for week " + lastOld.toString() + ": try again in a few days");
      }
      c.min_stake = c.min_stake_next;
    }
    // v5 (audit M-4): at least one timelock (48 h) of notice. Too close to the next week: from the week after it.
    const from = this.weekEnd(c, cur) - this.now() >= c.timelock_length ? cur + 1 : cur + 2;
    c.min_stake_next = args.min_stake;
    c.min_stake_next_week = from;                   // never the current week
    this.config.put(c);
    const r = new kpred.set_min_stake_result();
    r.from_week = from;
    return r;
  }

  set_operator(args: kpred.set_operator_arguments): kpred.set_operator_result {
    const c = this.cfg();
    System.require(this.isOwner(c), "owner only");
    System.require(isAddress(args.operator), "operator address required");
    c.operator = args.operator;
    this.config.put(c);
    return new kpred.set_operator_result();
  }

  set_paused(args: kpred.set_paused_arguments): kpred.set_paused_result {
    const c = this.cfg();
    System.require(this.isOwner(c), "owner only");
    c.paused = args.paused;
    this.config.put(c);
    return new kpred.set_paused_result();
  }

  propose_owner(args: kpred.propose_owner_arguments): kpred.propose_owner_result {
    const c = this.cfg();
    System.require(this.isOwner(c), "owner only");
    System.require(isAddress(args.new_owner), "address required");
    c.pending_owner = args.new_owner;
    c.pending_owner_height = this.height();
    this.config.put(c);
    return new kpred.propose_owner_result();
  }

  accept_owner(args: kpred.accept_owner_arguments): kpred.accept_owner_result {
    const c = this.cfg();
    System.require(isAddress(c.pending_owner), "no ownership transfer proposed");
    System.requireAuthority(authority.authorization_type.contract_call, c.pending_owner!);
    System.require(c.pending_owner_height > 0 && this.height() >= c.pending_owner_height + OWNER_ACCEPT_DELAY,
      "ownership can be accepted only 28,800 blocks (about a day) after it was proposed");
    c.owner = c.pending_owner;
    c.pending_owner = null;
    c.pending_owner_height = 0;
    this.config.put(c);
    // v5: an upgrade announced by the previous owner does not survive the handover; the new owner announces their own.
    this.upgrade.put(new kpred.timelock_object());
    return new kpred.accept_owner_result();
  }

  /** v5: the seed can change hands in two steps, like ownership. The seed owner proposes; the new one accepts a day
   *  later. A seed withdrawal requested by the previous seed owner is cancelled. */
  propose_seed_owner(args: kpred.propose_seed_owner_arguments): kpred.propose_seed_owner_result {
    const c = this.cfg();
    System.requireAuthority(authority.authorization_type.contract_call, c.seed_owner!);
    System.require(isAddress(args.new_seed_owner), "address required");
    System.require(!Arrays.equal(args.new_seed_owner, this.contractId), "the seed owner must be a wallet, not the game itself");
    c.pending_seed_owner = args.new_seed_owner;
    c.pending_seed_owner_height = this.height();
    this.config.put(c);
    return new kpred.propose_seed_owner_result();
  }
  accept_seed_owner(args: kpred.accept_seed_owner_arguments): kpred.accept_seed_owner_result {
    const c = this.cfg();
    System.require(isAddress(c.pending_seed_owner), "no seed owner change proposed");
    System.requireAuthority(authority.authorization_type.contract_call, c.pending_seed_owner!);
    System.require(c.pending_seed_owner_height > 0 && this.height() >= c.pending_seed_owner_height + OWNER_ACCEPT_DELAY,
      "the seed can be accepted only 28,800 blocks (about a day) after it was proposed");
    c.seed_owner = c.pending_seed_owner;
    c.pending_seed_owner = null;
    c.pending_seed_owner_height = 0;
    this.config.put(c);
    this.seedWd.put(new kpred.timelock_object());
    return new kpred.accept_seed_owner_result();
  }

  register_key(args: kpred.register_key_arguments): kpred.register_key_result {
    const c = this.cfg();
    System.require(this.isOwner(c), "owner only");
    System.require(args.public_key != null && args.public_key!.length == 33, "33-byte compressed public key required");
    Tokens.registerProducerKey(args.public_key!);
    return new kpred.register_key_result();
  }

  schedule_upgrade(args: kpred.schedule_upgrade_arguments): kpred.schedule_upgrade_result {
    const c = this.cfg();
    System.require(this.isOwner(c), "owner only");
    System.require(args.hash != null && args.hash!.length == 32, "sha256 hash of the new bytecode required");
    // v6 (audit V6-2): never back to code from before the vault. It can't see stakes in other games or what the vault
    // owes in VHP, so it would freeze those stakes and pay out money that is owed. The emergency target is a v6 build.
    const hx = hexOf(args.hash!);
    for (let i = 0; i < PRE_VAULT_CODE.length; i++) {
      System.require(hx != PRE_VAULT_CODE[i], "that is code from before the vault: it can't be scheduled (docs/UPGRADE-V6.md)");
    }
    const u = new kpred.timelock_object();
    u.hash = args.hash;
    u.eta = this.now() + c.timelock_length;
    this.upgrade.put(u);
    const r = new kpred.schedule_upgrade_result();
    r.eta = u.eta;
    return r;
  }

  claim_creator_fee(args: kpred.claim_creator_fee_arguments): kpred.claim_creator_fee_result {
    const c = this.cfg();
    System.require(this.isOwner(c), "owner only");
    System.require(isAddress(args.to), "address required");
    const t = this.totals.get()!;
    let amount = t.creator_fee;
    const mana = Tokens.mana(this.contractId);
    const koinBal = Tokens.koinBalance(this.contractId);
    if (amount > mana) amount = mana;                   // KOIN transfers need Mana ≥ amount; claim the rest later
    if (amount > koinBal) amount = koinBal;
    t.creator_fee -= amount;
    this.totals.put(t);
    Tokens.sendKoin(args.to!, amount);
    this.assertSolvent();
    const r = new kpred.claim_creator_fee_result();
    r.amount = amount;
    return r;
  }

  claim_owner_share(args: kpred.claim_owner_share_arguments): kpred.claim_owner_share_result {
    const c = this.cfg();
    System.require(this.isOwner(c), "owner only");
    System.require(isAddress(args.to), "address required");
    const t = this.totals.get()!;
    // Retired: no new owner share is ever created. Anything recorded before the change could still be taken here.
    System.require(args.amount > 0 && args.amount <= t.owner_share, "more than the owner share");
    t.owner_share -= args.amount;
    this.totals.put(t);
    this.ensureVhp(args.amount);
    Tokens.sendVhp(args.to!, args.amount);
    this.assertSolvent();
    return new kpred.claim_owner_share_result();
  }

  // ═══════════════════════ seed ═══════════════════════

  seed_deposit_vhp(args: kpred.seed_deposit_vhp_arguments): kpred.seed_deposit_vhp_result {
    this.live();
    const c = this.cfg();
    System.requireAuthority(authority.authorization_type.contract_call, c.seed_owner!);
    System.require(args.amount > 0, "amount must be positive");
    Tokens.pullVhp(c.seed_owner!, args.amount);
    const t = this.totals.get()!;
    this.accrue(t);
    t.seed_vhp += args.amount;
    this.totals.put(t);
    return new kpred.seed_deposit_vhp_result();
  }

  seed_deposit_koin(args: kpred.seed_deposit_koin_arguments): kpred.seed_deposit_koin_result {
    this.live();
    const c = this.cfg();
    System.requireAuthority(authority.authorization_type.contract_call, c.seed_owner!);
    System.require(args.amount > 0, "amount must be positive");
    Tokens.pullKoin(c.seed_owner!, args.amount);
    const t = this.totals.get()!;
    t.seed_koin += args.amount;
    this.totals.put(t);
    return new kpred.seed_deposit_koin_result();
  }

  request_seed_withdrawal(args: kpred.request_seed_withdrawal_arguments): kpred.request_seed_withdrawal_result {
    const c = this.cfg();
    System.requireAuthority(authority.authorization_type.contract_call, c.seed_owner!);
    const t = this.totals.get()!;
    System.require(args.vhp <= t.seed_vhp && args.koin <= t.seed_koin, "more than the seed");
    System.require(args.vhp > 0 || args.koin > 0, "nothing requested");
    const s = new kpred.timelock_object();
    s.vhp = args.vhp;
    s.koin = args.koin;
    s.eta = this.now() + c.timelock_length;
    this.seedWd.put(s);
    const r = new kpred.request_seed_withdrawal_result();
    r.eta = s.eta;
    return r;
  }

  execute_seed_withdrawal(args: kpred.execute_seed_withdrawal_arguments): kpred.execute_seed_withdrawal_result {
    const c = this.cfg();
    System.requireAuthority(authority.authorization_type.contract_call, c.seed_owner!);
    const s = this.seedWd.get()!;
    System.require(s.eta > 0, "no seed withdrawal requested");
    System.require(this.now() >= s.eta, "the timelock has not passed yet");
    System.require(this.now() < s.eta + ANNOUNCEMENT_EXPIRY, "this request expired (it must be carried out within 7 days after its timelock): request it again");
    const t = this.totals.get()!;
    const vhpAmt = s.vhp <= t.seed_vhp ? s.vhp : t.seed_vhp;
    let koinAmt = s.koin <= t.seed_koin ? s.koin : t.seed_koin;
    const mana = Tokens.mana(this.contractId);
    if (koinAmt > mana) koinAmt = mana;                 // the rest can be executed again after Mana refills
    const koinBal = Tokens.koinBalance(this.contractId);
    if (koinAmt > koinBal) koinAmt = koinBal;           // KOIN still held as VHP arrives with the next block rewards
    this.accrue(t);
    t.seed_vhp -= vhpAmt;
    t.seed_koin -= koinAmt;
    this.totals.put(t);
    s.vhp -= vhpAmt;
    s.koin -= koinAmt;
    if (s.vhp == 0 && s.koin == 0) s.eta = 0;
    this.seedWd.put(s);
    // KOIN first: topping up VHP below may burn spare KOIN, and the KOIN being returned is no longer counted as
    // seed, so it must already be gone before that happens.
    Tokens.sendKoin(c.seed_owner!, koinAmt);
    if (vhpAmt > 0) {
      this.ensureVhp(vhpAmt);
      Tokens.sendVhp(c.seed_owner!, vhpAmt);
    }
    const r = new kpred.execute_seed_withdrawal_result();
    r.vhp = vhpAmt;
    r.koin = koinAmt;
    return r;
  }

  // ═══════════════════════ v6: the KnodeGames vault (docs/V6-PLAN.md) ═══════════════════════

  gplayerKey(game: u32, player: Uint8Array): Uint8Array { return cat(u32Key(game), player); }
  gweekKey(game: u32, w: u64): Uint8Array { return cat(u32Key(game), u64Key(w)); }
  gentryKey(game: u32, w: u64, player: Uint8Array): Uint8Array { return cat(this.gweekKey(game, w), player); }
  gbucketKey(game: u32, w: u64, points: u32): Uint8Array { return cat(this.gweekKey(game, w), u32Key(points)); }

  /** A game's free-prize season length in weeks (1 = the prize is paid every week). */
  seasonWeeks(g: kpred.game_object): u64 { return g.season_weeks > 1 ? <u64>g.season_weeks : 1; }

  /** Whether week `w` is the last week of one of the game's prize seasons (seasons start at its from_week). */
  seasonEnds(g: kpred.game_object, w: u64): bool {
    const n = this.seasonWeeks(g);
    return w >= g.from_week && (w - g.from_week) % n == n - 1;
  }

  /** Whether a game earns (gets a bucket and a prize) for week `w`. */
  gameEarns(g: kpred.game_object, w: u64): bool {
    return g.from_week <= w && (g.last_week_plus_one == 0 || w + 1 <= g.last_week_plus_one);
  }

  /** Move a game's week count forward to week `w`. Every week it passes that the vault has not closed yet keeps its
   *  count for that close, however many quiet weeks there were (audit V6-3); weeks already closed need none. Deposits
   *  waiting for a week that has now started begin to count. */
  gameRoll(g: kpred.game_object, w: u64): void {
    if (g.week >= w) return;
    const closed = this.totals.get()!.weeks_closed;   // the next week to close
    for (let x = g.week > closed ? g.week : closed; x < w; x++) {
      this.keepWeight(g.id, x, g.week_stake + (g.next_stake > 0 && g.next_week <= x ? g.next_stake : 0));
    }
    if (g.next_stake > 0 && g.next_week <= w) { g.week_stake += g.next_stake; g.next_stake = 0; }
    g.week = w;
  }

  keepWeight(game: u32, w: u64, weight: u64): void {
    const k = this.gweekKey(game, w);
    const gw = this.gweeks.get(k)!;
    gw.weight = weight;
    gw.weight_set = true;
    this.gweeks.put(k, gw);
  }

  /** A game's stake counted for week `x`: its players' stakes that week, each at its lowest. */
  weightFor(g: kpred.game_object, x: u64): u64 {
    const gw = this.gweeks.get(this.gweekKey(g.id, x))!;
    if (gw.weight_set) return gw.weight;
    if (x > g.week) return g.week_stake + (g.next_stake > 0 && g.next_week <= x ? g.next_stake : 0);
    return g.week_stake;
  }

  /** A deposit into a game: it counts from week `from` (the next week, or week 0 before the game's first week). */
  gameStakeAdd(id: u32, amount: u64, from: u64): void {
    const g = this.games.get(u32Key(id));
    if (g == null) return;                          // only before v6 starts; cfg() creates game 1 on the first v6 write
    const w = this.weekOf(this.config.get()!, this.now());
    this.gameRoll(g, w);
    g.stake += amount;
    if (from <= w) g.week_stake += amount;
    else { g.next_stake += amount; g.next_week = from; }
    this.games.put(u32Key(id), g);
  }

  /** A withdrawal (or move) out of a game: `later` came from deposits not counting yet, `now_` from this week's stake. */
  gameStakeSub(id: u32, later: u64, now_: u64): void {
    const g = this.games.get(u32Key(id));
    if (g == null) return;
    const w = this.weekOf(this.config.get()!, this.now());
    this.gameRoll(g, w);
    const all = later + now_;
    g.stake = g.stake > all ? g.stake - all : 0;
    // Game 1's first week under v6 counted waiting deposits as this week's: take what isn't there from this week.
    let fromWeek = now_;
    if (later > g.next_stake) { fromWeek += later - g.next_stake; g.next_stake = 0; } else g.next_stake -= later;
    g.week_stake = g.week_stake > fromWeek ? g.week_stake - fromWeek : 0;
    this.games.put(u32Key(id), g);
  }

  /** Every game, the question game first (keys are fixed-length, so they sort by id). */
  gamesList(): Array<kpred.game_object> {
    const objs = this.games.getMany(new Uint8Array(0), <i32>MAX_GAMES + 1);
    const out = new Array<kpred.game_object>();
    for (let i = 0; i < objs.length; i++) out.push(objs[i].value);
    return out;
  }

  /** The vault's weekly split (v6). Gain once for all games; 5% fee in VHP; the seed's part of the rewards pays the
   *  free prizes first (players' rewards never do); the rest goes to the games by their players' stake that week, each
   *  stake counted at its lowest; every game's bucket also gets back its own earlier rollover. */
  closeV6(c: kpred.config_object, week: u64, h: u64): kpred.close_week_result {
    const t = this.totals.get()!;
    this.accrue(t);
    const holdings = Tokens.vhpBalance(this.contractId) + Tokens.koinBalance(this.contractId);
    const owed = this.liabilities(t);
    const gain = holdings > owed ? holdings - owed : 0;
    // Unused prizes came back to the pool after their fee was taken: they are not charged again.
    const carried = t.rolled_over < gain ? t.rolled_over : gain;
    const fee = bps(gain - carried, FEE_BPS);
    const pot = gain - fee;
    // The seed's part of the pot: its VHP over time against everything that produced (stakes, seed, unpaid pots).
    const accSeed = new u128(t.acc_seed_lo, t.acc_seed_hi);
    const accAll = new u128(t.acc_player_lo, t.acc_player_hi) + new u128(t.acc_house_lo, t.acc_house_hi);
    let seedPart: u64;
    if (accAll.isZero()) {
      const all = t.total_stake + t.seed_vhp + t.pots_outstanding + t.games_rolled;
      seedPart = all == 0 ? 0 : u128.muldiv(u128.fromU64(pot), u128.fromU64(t.seed_vhp), u128.fromU64(all)).toU64();
    } else {
      seedPart = u128.muldiv(u128.fromU64(pot), accSeed, accAll).toU64();
    }
    if (seedPart > pot) seedPart = pot;

    const list = this.gamesList();
    const n = list.length;
    // 1. Free prizes, from the seed's part only: 3 VHP for each free-prize game that earns this week. If the seed's
    //    part is short, every game's prize is cut in the same proportion that week (to nothing if the part is 0). A
    //    cut is never owed later (owner, 2026-10-27).
    const need = new Array<u64>(n);
    let needTotal: u64 = 0;
    for (let i = 0; i < n; i++) {
      const g = list[i];
      need[i] = g.free_prize && this.gameEarns(g, week) ? PRIZE_V6 : 0;
      needTotal += need[i];
    }
    const got = new Array<u64>(n);
    let prizes: u64 = 0;
    for (let i = 0; i < n; i++) {
      got[i] = seedPart >= needTotal ? need[i] : (needTotal == 0 ? 0 : u128.muldiv(u128.fromU64(seedPart), u128.fromU64(need[i]), u128.fromU64(needTotal)).toU64());
      prizes += got[i];
    }
    // 2. The rest goes to the staked games by their stake for the week. A game that no longer earns releases its old
    //    rollover into the split.
    let split = pot - prizes;
    let rolledUsed: u64 = 0;
    let prizeReleased: u64 = 0;                       // a stopped game's season prize so far: back to the pool, fee-free
    const weight = new Array<u64>(n);
    let weightTotal: u64 = 0;
    for (let i = 0; i < n; i++) {
      const g = list[i];
      weight[i] = 0;
      if (!this.gameEarns(g, week)) {
        split += g.rolled; rolledUsed += g.rolled; g.rolled = 0;
        prizeReleased += g.prize_held; g.prize_held = 0;
      }
      else if (g.staked) { weight[i] = this.weightFor(g, week); weightTotal += weight[i]; }
    }
    const bucket = new Array<u64>(n);
    let given: u64 = 0;
    for (let i = 0; i < n; i++) {
      bucket[i] = weightTotal == 0 ? 0 : u128.muldiv(u128.fromU64(split), u128.fromU64(weight[i]), u128.fromU64(weightTotal)).toU64();
      given += bucket[i];
    }
    bucket[0] += split - given;                       // rounding (or no stake anywhere): the question game
    // 3. Write every game's week.
    const wkKey = u64Key(week);
    const wk = this.weeks.get(wkKey)!;
    for (let i = 0; i < n; i++) {
      const g = list[i];
      if (g.id == Q_GAME) {
        const qpot = bucket[i] + g.rolled + got[i];
        rolledUsed += g.rolled;
        g.rolled = 0;
        wk.pot = qpot;
        wk.pot_free = got[i];
        wk.pot_a = bps(qpot - got[i], V5_BASKET_A_BPS);
        wk.pot_b = qpot - wk.pot_a - got[i];
      } else if (this.gameEarns(g, week)) {
        const gk = this.gweekKey(g.id, week);
        const gw = this.gweeks.get(gk)!;
        gw.closed = true;
        gw.bucket = bucket[i] + g.rolled;
        // A game with prize seasons holds each week's funded prize and pays the season's total in its last week.
        if (this.seasonEnds(g, week)) { gw.prize = got[i] + g.prize_held; g.prize_held = 0; }
        else { gw.prize = 0; g.prize_held += got[i]; }
        rolledUsed += g.rolled;
        g.rolled = 0;
        this.gweeks.put(gk, gw);
      }
      this.games.put(u32Key(g.id), g);
    }
    t.acc_player_lo = 0; t.acc_player_hi = 0; t.acc_house_lo = 0; t.acc_house_hi = 0;
    t.acc_seed_lo = 0; t.acc_seed_hi = 0;
    t.rolled_over = prizeReleased;                    // returned prizes are paid out with the next close, fee-free
    t.games_rolled = this.less(t.games_rolled, rolledUsed, "rolled-over buckets");
    t.fee_vhp += fee;
    t.pots_outstanding = this.less(t.pots_outstanding + pot + rolledUsed, prizeReleased, "unpaid rewards");
    t.total_gain += gain;
    t.weeks_closed += 1;
    this.totals.put(t);
    wk.closed = true;
    wk.gain = gain;
    wk.fee = 0;
    wk.fee_vhp = fee;
    wk.prizes = prizes;
    wk.split = split;
    wk.seed_part = seedPart;
    wk.retained = 0;
    wk.house_ppm = 0;
    wk.reward_rule = true;
    wk.prize_v6 = true;
    wk.settle_start = h;
    wk.settle_end = h + c.settle_length;
    this.weeks.put(wkKey, wk);
    const r = new kpred.close_week_result();
    r.gain = gain;
    r.pot = pot;
    return r;
  }

  // ───────────── stakes in other games ─────────────

  activeStakeG(p: kpred.gplayer_object, w: u64): u64 {
    return p.pending > 0 && w >= p.pending_week ? p.stake + p.pending : p.stake;
  }

  normalizeG(p: kpred.gplayer_object, w: u64): void {
    if (p.pending > 0 && w >= p.pending_week) { p.stake += p.pending; p.pending = 0; }
  }

  /** Before a player's record in another game changes, keep what it said for this week and the last one: those
   *  weeks' results are posted later (within 3 days of the week's end), from these snapshots. */
  freezeG(game: u32, player: Uint8Array, p: kpred.gplayer_object, w: u64): void {
    const from: u64 = w > 0 ? w - 1 : 0;
    for (let x = from; x <= w; x++) {
      const k = this.gentryKey(game, x, player);
      if (this.gentries.get(k) != null) continue;
      const e = new kpred.gentry_object();
      e.stake = this.activeStakeG(p, x);
      e.peak_stake = e.stake;                         // kept when a withdrawal later lowers e.stake
      e.voided = p.void_week_plus_one == x + 1;
      this.gentries.put(k, e);
    }
  }

  /** The stake that counts for a player in `game` during week `w` (0 = voided or none). */
  weekStakeG(game: u32, player: Uint8Array, w: u64): u64 {
    const e = this.gentries.get(this.gentryKey(game, w, player));
    if (e != null) return e.voided ? 0 : e.stake;
    const p = this.gplayers.get(this.gplayerKey(game, player))!;
    if (p.void_week_plus_one == w + 1) return 0;
    return this.activeStakeG(p, w);
  }

  otherGame(id: u32): kpred.game_object {
    System.require(id != Q_GAME, "the question game uses deposit_vhp, withdraw and its own results");
    const g = this.games.get(u32Key(id));
    System.require(g != null, "no such game");
    return g!;
  }

  /** Add a pending deposit to a player's stake in another game (counts from next week). Returns the week it starts. */
  addG(c: kpred.config_object, game: u32, player: Uint8Array, amount: u64): u64 {
    const h = this.now();
    const w = this.weekOf(c, h);
    const k = this.gplayerKey(game, player);
    const p = this.gplayers.get(k)!;
    // Before the game's first week a deposit counts for week 0 itself, and no week has been played to keep.
    if (h >= c.genesis_time) this.freezeG(game, player, p, w);
    this.normalizeG(p, w);
    p.pending += amount;
    p.pending_week = h < c.genesis_time ? 0 : w + 1;
    this.gplayers.put(k, p);
    return p.pending_week;
  }

  /** Take `amount` out of a player's stake in another game. Same rules as the question game: all of this week's
   *  stake voids the player's week in that game only; part of it lowers that week's stake. Returns the part taken from
   *  this week's stake. */
  takeG(c: kpred.config_object, game: u32, player: Uint8Array, amount: u64): u64 {
    const h = this.now();
    const w = this.weekOf(c, h);
    const k = this.gplayerKey(game, player);
    const p = this.gplayers.get(k)!;
    if (h >= c.genesis_time) this.freezeG(game, player, p, w);
    this.normalizeG(p, w);
    System.require(p.stake + p.pending >= amount, "more than your stake in that game");
    let rest = amount;
    const fromPending = rest < p.pending ? rest : p.pending;
    p.pending -= fromPending;
    rest -= fromPending;
    p.stake -= rest;
    if (h >= c.genesis_time && rest > 0) {
      const ek = this.gentryKey(game, w, player);
      const e = this.gentries.get(ek)!;
      if (p.stake == 0) {
        p.void_week_plus_one = w + 1;
        e.voided = true;
      } else if (e.stake > p.stake) {
        e.stake = p.stake;
      }
      this.gentries.put(ek, e);
    }
    this.gplayers.put(k, p);
    return rest;
  }

  playerOther(player: Uint8Array, add: u64, sub: u64): void {
    const p = this.players.get(player)!;
    p.stake_other = p.stake_other + add - sub;
    this.players.put(player, p);
  }

  deposit_to(args: kpred.deposit_to_arguments): kpred.deposit_to_result {
    this.live();
    const c = this.cfg();
    this.advance(c);
    const g = this.otherGame(args.game);
    System.require(g.active && g.staked, "that game does not take stakes now");
    System.require(!c.paused, "new deposits are paused");
    const from = args.from!;
    System.require(isAddress(from), "address required");
    System.require(args.amount > 0, "amount must be positive");
    System.require(args.amount % WHOLE == 0, "stake whole numbers only (1, 2, 3 …)");
    System.requireAuthority(authority.authorization_type.contract_call, from);
    if (args.koin) {
      Tokens.pullKoin(from, args.amount);
      Tokens.burnOwnKoin(args.amount);
    } else {
      Tokens.pullVhp(from, args.amount);
    }
    const startsAt = this.addG(c, args.game, from, args.amount);
    this.playerOther(from, args.amount, 0);
    const t = this.totals.get()!;
    this.accrue(t);
    t.total_stake += args.amount;
    t.stake_other += args.amount;
    this.totals.put(t);
    this.gameStakeAdd(args.game, args.amount, startsAt);
    return new kpred.deposit_to_result();
  }

  /** Rule 1: any amount, at any time, from any game that exists, active or not. Touches nothing but the player's
   *  records, the totals and the transfer. */
  withdraw_from(args: kpred.withdraw_from_arguments): kpred.withdraw_from_result {
    const c = this.cfg();
    const to = args.to!;
    System.requireAuthority(authority.authorization_type.contract_call, to);
    System.require(args.amount > 0, "amount must be positive");
    this.otherGame(args.game);
    const fromWeek = this.takeG(c, args.game, to, args.amount);
    this.playerOther(to, 0, args.amount);
    const t = this.totals.get()!;
    this.accrue(t);
    t.total_stake -= args.amount;
    t.stake_other -= args.amount;
    this.totals.put(t);
    this.gameStakeSub(args.game, args.amount - fromWeek, fromWeek);
    this.ensureVhp(args.amount);
    Tokens.sendVhp(to, args.amount);
    return new kpred.withdraw_from_result();
  }

  move_stake(args: kpred.move_stake_arguments): kpred.move_stake_result {
    this.live();
    const c = this.cfg();
    const player = args.player!;
    System.requireAuthority(authority.authorization_type.contract_call, player);
    System.require(args.amount > 0, "amount must be positive");
    System.require(args.from_game != args.to_game, "pick two different games");
    System.require(!c.paused, "new deposits are paused");
    const to = this.games.get(u32Key(args.to_game));
    System.require(to != null && to!.active && to!.staked, "that game does not take stakes now");
    let fromWeek: u64;
    if (args.from_game == Q_GAME) {
      fromWeek = this.takeQ(c, player, args.amount);
    } else {
      this.otherGame(args.from_game);
      fromWeek = this.takeG(c, args.from_game, player, args.amount);
      this.playerOther(player, 0, args.amount);
    }
    let startsAt: u64;
    const t = this.totals.get()!;
    this.accrue(t);
    if (args.to_game == Q_GAME) {
      const h = this.now();
      const w = this.weekOf(c, h);
      const p = this.players.get(player)!;
      this.normalize(p, w);
      p.pending += args.amount;
      p.pending_week = h < c.genesis_time ? 0 : w + 1;
      startsAt = p.pending_week;
      this.players.put(player, p);
      t.stake_other -= args.amount;
    } else {
      startsAt = this.addG(c, args.to_game, player, args.amount);
      this.playerOther(player, args.amount, 0);
      if (args.from_game == Q_GAME) t.stake_other += args.amount;
    }
    this.totals.put(t);
    this.gameStakeSub(args.from_game, args.amount - fromWeek, fromWeek);
    this.gameStakeAdd(args.to_game, args.amount, startsAt);
    return new kpred.move_stake_result();
  }

  // ───────────── results of other games ─────────────

  resultsDue(c: kpred.config_object, w: u64): u64 {
    return this.weekEnd(c, w) + c.week_length / 7 * RESULTS_DAYS;
  }

  /** A game has results for week `w` if it earns that week, or if the vault closed that week with it earning (a game
   *  restarted after a gap starts its weeks again, but keeps the weeks it already earned: audit V6-6). */
  requireResults(c: kpred.config_object, g: kpred.game_object, w: u64, gw: kpred.gweek_object): void {
    System.require(this.v6Rule(c, w) && (gw.closed || this.gameEarns(g, w)), "that game has no results for that week");
  }

  /** The common checks for the operator's posts: the game earned that week, the week is over and still open. */
  postable(c: kpred.config_object, game: u32, w: u64): kpred.gweek_object {
    const g = this.otherGame(game);
    const gw = this.gweeks.get(this.gweekKey(game, w))!;
    this.requireResults(c, g, w, gw);
    const now = this.now();
    System.require(now >= this.weekEnd(c, w), "the week is not over yet");
    System.require(now < this.resultsDue(c, w), "results for that week are past their deadline");
    System.require(!gw.sealed && !gw.finalized && !gw.voided, "that week's results are sealed");
    return gw;
  }

  addPoints(game: u32, w: u64, gw: kpred.gweek_object, e: kpred.gentry_object, points: u32): void {
    const bk = this.gbucketKey(game, w, points);
    const b = this.gbuckets.get(bk)!;
    b.stake += e.stake;
    b.capped += e.stake < V5_CAP_A ? e.stake : V5_CAP_A;
    b.players += 1;
    this.gbuckets.put(bk, b);
    gw.eligible_players += 1;
    if (points > gw.max_points) gw.max_points = points;
    e.points = points;
  }

  removePoints(game: u32, w: u64, gw: kpred.gweek_object, e: kpred.gentry_object): void {
    const bk = this.gbucketKey(game, w, e.points);
    const b = this.gbuckets.get(bk)!;
    b.stake -= e.stake;
    b.capped -= e.stake < V5_CAP_A ? e.stake : V5_CAP_A;
    b.players -= 1;
    this.gbuckets.put(bk, b);
    gw.eligible_players -= 1;
    e.points = 0;
  }

  /** The entry for a result: the player's frozen week, created now if their record has not changed since. */
  resultEntry(game: u32, w: u64, player: Uint8Array): kpred.gentry_object {
    const e = this.gentries.get(this.gentryKey(game, w, player));
    if (e != null) return e;
    const n = new kpred.gentry_object();
    const p = this.gplayers.get(this.gplayerKey(game, player))!;
    n.voided = p.void_week_plus_one == w + 1;
    n.stake = this.activeStakeG(p, w);
    n.peak_stake = n.stake;
    return n;
  }

  post_results(args: kpred.post_results_arguments): kpred.post_results_result {
    this.live();
    const c = this.cfg();
    System.requireAuthority(authority.authorization_type.contract_call, c.operator!);
    const gw = this.postable(c, args.game, args.week);
    System.require(this.otherGame(args.game).staked, "that game has no stake bucket");
    System.require(args.rows.length > 0 && args.rows.length <= MAX_ROWS, "1 to 50 results per call");
    const min = this.minStakeFor(c, args.week);
    for (let i = 0; i < args.rows.length; i++) {
      const row = args.rows[i];
      System.require(isAddress(row.player), "address required");
      System.require(row.points >= 1 && row.points <= MAX_GAME_POINTS, "points must be 1 to 255");
      const e = this.resultEntry(args.game, args.week, row.player!);
      System.require(e.points == 0 && e.prize_place == 0, "that player already has a result this week");
      System.require(!e.voided && e.stake > 0 && e.stake >= min, "that player was not staked in that game that week");
      this.addPoints(args.game, args.week, gw, e, row.points);
      this.gentries.put(this.gentryKey(args.game, args.week, row.player!), e);
    }
    this.gweeks.put(this.gweekKey(args.game, args.week), gw);
    return new kpred.post_results_result();
  }

  post_prize_winners(args: kpred.post_prize_winners_arguments): kpred.post_prize_winners_result {
    this.live();
    const c = this.cfg();
    System.requireAuthority(authority.authorization_type.contract_call, c.operator!);
    const gw = this.postable(c, args.game, args.week);
    const pg = this.otherGame(args.game);
    System.require(pg.free_prize, "that game has no free prize");
    // The last week of a season (once the week is closed: a week that holds a prize, which also covers a game restarted
    // after a gap, whose seasons start again).
    System.require(gw.closed ? gw.prize > 0 : this.seasonEnds(pg, args.week), "prize winners are posted for the last week of the game's season");
    System.require(args.place == 1 || args.place == 2, "place must be 1 or 2");
    const before: u32 = args.place == 1 ? gw.first_n : gw.second_n;
    System.require(args.players.length > 0 && <u32>args.players.length + before <= MAX_PRIZE_WINNERS, "at most 10 wallets per place");
    const min = this.minStakeFor(c, args.week);
    for (let i = 0; i < args.players.length; i++) {
      const who = args.players[i];
      System.require(isAddress(who), "address required");
      const e = this.resultEntry(args.game, args.week, who);
      System.require(e.points == 0 && e.prize_place == 0, "that player already has a result this week");
      // A free player never held the minimum stake in this game that week (the question game's rule: someone staked at
      // the start of the week who withdraws later is still a staked player that week, not a free one).
      System.require(e.peak_stake < min, "staked players can't win the free prize");
      e.prize_place = args.place;
      this.gentries.put(this.gentryKey(args.game, args.week, who), e);
    }
    if (args.place == 1) gw.first_n += <u32>args.players.length; else gw.second_n += <u32>args.players.length;
    this.gweeks.put(this.gweekKey(args.game, args.week), gw);
    return new kpred.post_prize_winners_result();
  }

  seal_results(args: kpred.seal_results_arguments): kpred.seal_results_result {
    this.live();
    const c = this.cfg();
    System.requireAuthority(authority.authorization_type.contract_call, c.operator!);
    const gw = this.postable(c, args.game, args.week);
    gw.sealed = true;
    gw.seal_time = this.now();
    this.gweeks.put(this.gweekKey(args.game, args.week), gw);
    return new kpred.seal_results_result();
  }

  /** The owner's window on a game week's results (corrections and voiding): from the week's end until a day after the
   *  seal (or, unsealed, until the results deadline), and never once finalizing has started (audit V6-1: a finished
   *  score group's weights are fixed when its page runs, so its players can't change after that). */
  correctable(c: kpred.config_object, w: u64, gw: kpred.gweek_object): void {
    System.require(!gw.finalized && !gw.voided, "that week is final");
    System.require(!gw.fin_started, "that week is being finalized: its results can't change any more");
    const now = this.now();
    System.require(now >= this.weekEnd(c, w), "the week is not over yet");
    const until = gw.sealed ? gw.seal_time + CORRECTION_DELAYS * c.close_delay : this.resultsDue(c, w);
    System.require(now < until, "the time for correcting that week is over");
  }

  /** The owner may correct a game week's results until a day after the seal (or, unsealed, until the deadline).
   *  Every correction restarts the 12-hour wait before the week can be finalized, so it is visible first. */
  correct_result(args: kpred.correct_result_arguments): kpred.correct_result_result {
    this.live();
    const c = this.cfg();
    System.require(this.isOwner(c), "owner only");
    const g = this.otherGame(args.game);
    const gk = this.gweekKey(args.game, args.week);
    const gw = this.gweeks.get(gk)!;
    this.requireResults(c, g, args.week, gw);
    this.correctable(c, args.week, gw);
    const now = this.now();
    System.require(isAddress(args.player), "address required");
    const e = this.resultEntry(args.game, args.week, args.player!);
    if (args.remove_prize) {
      System.require(e.prize_place > 0, "that player has no prize place");
      if (e.prize_place == 1) gw.first_n -= 1; else gw.second_n -= 1;
      e.prize_place = 0;
    } else {
      System.require(g.staked, "that game has no stake bucket");
      System.require(args.points <= MAX_GAME_POINTS, "points must be 0 to 255");
      if (e.points > 0) this.removePoints(args.game, args.week, gw, e);
      if (args.points > 0) {
        System.require(e.prize_place == 0, "that player holds a free-prize place");
        System.require(!e.voided && e.stake > 0 && e.stake >= this.minStakeFor(c, args.week), "that player was not staked in that game that week");
        this.addPoints(args.game, args.week, gw, e, args.points);
      }
    }
    this.gentries.put(this.gentryKey(args.game, args.week, args.player!), e);
    gw.last_change_time = now;
    this.gweeks.put(gk, gw);
    return new kpred.correct_result_result();
  }

  void_game_week(args: kpred.void_game_week_arguments): kpred.void_game_week_result {
    this.live();
    const c = this.cfg();
    System.require(this.isOwner(c), "owner only");
    const g = this.otherGame(args.game);
    // Audit V6-5: only a week the game earned, after it ended, within the same window as a correction.
    const gk = this.gweekKey(args.game, args.week);
    const gw = this.gweeks.get(gk)!;
    this.requireResults(c, g, args.week, gw);
    this.correctable(c, args.week, gw);
    gw.voided = true;
    gw.last_change_time = this.now();
    this.gweeks.put(gk, gw);
    return new kpred.void_game_week_result();
  }

  /** Anyone may finalize a game week once the vault week is closed and its results have stood for 12 hours after the
   *  seal and the last correction. A week voided, or not sealed by its deadline, rolls over: its bucket stays in the
   *  game for its next week and its prize returns to the pool. */
  finalize_game_week(args: kpred.finalize_game_week_arguments): kpred.finalize_game_week_result {
    this.live();
    const c = this.cfg();
    const g = this.otherGame(args.game);
    const gk = this.gweekKey(args.game, args.week);
    const gw = this.gweeks.get(gk)!;
    System.require(gw.closed, "the vault has not closed that week yet");
    System.require(!gw.finalized, "already finalized");
    const now = this.now();
    let roll = gw.voided;
    if (!roll) {
      if (gw.sealed) {
        // Audit V6-1 / V6-8: finalizing starts only once the owner's correction window (a day after the seal) has
        // closed and the last correction has stood for 12 hours. Later pages of a started week continue at any time.
        if (!gw.fin_started) {
          System.require(now >= gw.seal_time + CORRECTION_DELAYS * c.close_delay, "results can still be corrected: try again later");
          System.require(now >= gw.last_change_time + c.close_delay, "results were just corrected: try again later");
        }
      } else {
        System.require(now >= this.resultsDue(c, args.week), "results are still being posted");
        roll = true;
      }
    }
    const r = new kpred.finalize_game_week_result();
    if (roll) {
      this.finishGameWeek(g, gw, true);
      r.done = true;
    } else {
      r.done = this.finalizeGameStep(args.game, args.week, gw);
      if (r.done) this.finishGameWeek(g, gw, false);
      r.cutoff = gw.cutoff;
      r.winners = gw.winners;
    }
    this.gweeks.put(gk, gw);
    return r;
  }

  /** One page of a game week's winners: the same top-30% rule and rank weights as the question game. */
  finalizeGameStep(game: u32, w: u64, gw: kpred.gweek_object): bool {
    if (!gw.fin_started) {
      const need = (<u64>gw.eligible_players * WIN_PCT + 99) / 100;
      let cutoff: u32 = 0, cum: u64 = 0;
      if (need > 0) {
        for (let p = gw.max_points; p >= 1; p--) {
          cum += <u64>this.gbuckets.get(this.gbucketKey(game, w, p))!.players;
          cutoff = p;
          if (cum >= need) break;
        }
      }
      gw.cutoff = cutoff;
      gw.fin_started = true;
      gw.fin_points = cutoff >= 1 ? gw.max_points : 0;
      gw.fin_index = 0; gw.fin_rank = 1; gw.fin_gw = 0;
      gw.winners = 0; gw.sum_w = 0;
      gw.bw_lo = 0; gw.bw_hi = 0; gw.aw_lo = 0; gw.aw_hi = 0;
    }
    const cutoff = gw.cutoff;
    let budget = finalizePage;
    let bw = new u128(gw.bw_lo, gw.bw_hi), aw = new u128(gw.aw_lo, gw.aw_hi);
    while (cutoff >= 1 && gw.fin_points >= cutoff && budget > 0) {
      const bk = this.gbucketKey(game, w, gw.fin_points);
      const b = this.gbuckets.get(bk)!;
      while (gw.fin_index < b.players && budget > 0) {
        gw.fin_gw += rankWeight(gw.fin_rank);
        gw.fin_rank++; gw.fin_index++; budget--;
      }
      if (gw.fin_index < b.players) break;
      if (b.players > 0) {
        b.sum_w = gw.fin_gw;
        this.gbuckets.put(bk, b);
        gw.sum_w += gw.fin_gw;
        bw = bw + u128.muldiv(u128.fromU64(gw.fin_gw), u128.fromU64(b.stake), u128.fromU64(<u64>b.players));
        aw = aw + u128.muldiv(u128.fromU64(gw.fin_gw), u128.fromU64(b.capped), u128.fromU64(<u64>b.players));
        gw.winners += b.players;
      }
      gw.fin_points -= 1;
      gw.fin_index = 0;
      gw.fin_gw = 0;
    }
    gw.bw_lo = bw.lo; gw.bw_hi = bw.hi; gw.aw_lo = aw.lo; gw.aw_hi = aw.hi;
    return cutoff < 1 || gw.fin_points < cutoff;
  }

  /** Last step of a game week: baskets, free-prize shares, and what goes back (rollover within the game for the
   *  bucket, the pool for the prize). Every unit of the bucket and the prize ends up either claimable or moved. */
  finishGameWeek(g: kpred.game_object, gw: kpred.gweek_object, roll: bool): void {
    gw.finalized = true;
    const t = this.totals.get()!;
    this.accrue(t);
    // The stake bucket
    if (roll || gw.winners == 0) {
      gw.rolled_over = true;
      if (gw.bucket > 0) {
        t.pots_outstanding = this.less(t.pots_outstanding, gw.bucket, "unpaid rewards");
        t.games_rolled += gw.bucket;
        g.rolled += gw.bucket;
        this.games.put(u32Key(g.id), g);
      }
    } else {
      gw.pot_a = bps(gw.bucket, V5_BASKET_A_BPS);
      gw.pot_b = gw.bucket - gw.pot_a;
    }
    // The free prize: tied 1st places share all of it; else 1st gets two thirds and the 2nd places share the rest.
    // Audit V6-9: with nobody in 1st, the 2nd places still get their third; 1st's part goes back to the pool.
    let paid: u64 = 0;
    if (!roll && gw.prize > 0 && (gw.first_n > 0 || gw.second_n > 0)) {
      if (gw.first_n >= 2) {
        gw.prize_first = gw.prize / <u64>gw.first_n;
      } else {
        const first = prizeFirst(gw.prize);
        if (gw.first_n == 1) gw.prize_first = first;
        if (gw.second_n > 0) gw.prize_second = (gw.prize - first) / <u64>gw.second_n;
      }
      paid = gw.prize_first * <u64>gw.first_n + gw.prize_second * <u64>gw.second_n;
    }
    const back = gw.prize - paid;
    if (back > 0) { t.pots_outstanding = this.less(t.pots_outstanding, back, "unpaid rewards"); t.rolled_over += back; }
    this.totals.put(t);
  }

  rewardOfG(game: u32, w: u64, gw: kpred.gweek_object, e: kpred.gentry_object): u64 {
    const b = this.gbuckets.get(this.gbucketKey(game, w, e.points))!;
    const n = u128.fromU64(<u64>b.players);
    let reward: u64 = 0;
    const aw = new u128(gw.aw_lo, gw.aw_hi), bw = new u128(gw.bw_lo, gw.bw_hi);
    if (!aw.isZero()) {
      const capped = e.stake < V5_CAP_A ? e.stake : V5_CAP_A;
      reward = u128.muldiv(u128.fromU64(gw.pot_a), u128.muldiv(u128.fromU64(b.sum_w), u128.fromU64(capped), n), aw).toU64();
    }
    if (!bw.isZero()) {
      reward += u128.muldiv(u128.fromU64(gw.pot_b), u128.muldiv(u128.fromU64(b.sum_w), u128.fromU64(e.stake), n), bw).toU64();
    }
    return reward;
  }

  /** What a claim in another game would pay now (0 = nothing to claim). */
  claimableG(game: u32, w: u64, gw: kpred.gweek_object, e: kpred.gentry_object | null): u64 {
    if (!gw.finalized || e == null || e.claimed) return 0;
    if (e.prize_place == 1) return gw.prize_first;
    if (e.prize_place == 2) return gw.prize_second;     // 0 when tied 1st places share the whole prize
    if (gw.rolled_over || gw.cutoff < 1 || e.points < gw.cutoff) return 0;
    return this.rewardOfG(game, w, gw, e);
  }

  claim_game(args: kpred.claim_game_arguments): kpred.claim_game_result {
    const player = args.player!;
    System.requireAuthority(authority.authorization_type.contract_call, player);
    this.advance(this.cfg());
    this.otherGame(args.game);
    const gk = this.gweekKey(args.game, args.week);
    const gw = this.gweeks.get(gk)!;
    const ek = this.gentryKey(args.game, args.week, player);
    const e = this.gentries.get(ek);
    System.require(gw.finalized, "that week is not final yet");
    System.require(e != null && !e!.claimed, e != null ? "already claimed" : "nothing to claim that week");
    const reward = this.claimableG(args.game, args.week, gw, e);
    System.require(reward > 0, "nothing to claim that week");
    // Audit V6-1, defence in depth: a game week never pays out more than its bucket and prize.
    // (A bucket that rolled over has left the week: only the prize can still be claimed.)
    const cap = (gw.rolled_over ? 0 : gw.bucket) + gw.prize;
    System.require(gw.claimed + reward <= cap, "accounting error: that week's bucket is used up");
    e!.claimed = true;
    e!.reward = reward;
    this.gentries.put(ek, e!);
    gw.claimed += reward;
    this.gweeks.put(gk, gw);
    const t = this.totals.get()!;
    this.accrue(t);
    t.pots_outstanding = this.less(t.pots_outstanding, reward, "unpaid rewards");
    this.totals.put(t);
    this.ensureVhp(reward);
    Tokens.sendVhp(player, reward);
    this.assertSolvent();
    const r = new kpred.claim_game_result();
    r.reward = reward;
    return r;
  }

  // ───────────── the game registry (owner) ─────────────

  propose_game(args: kpred.propose_game_arguments): kpred.propose_game_result {
    this.live();
    const c = this.cfg();
    System.require(this.isOwner(c), "owner only");
    System.require(args.game > Q_GAME, "game ids start at 2 (1 is the question game)");
    const name = args.name != null ? args.name! : "";
    System.require(name.length > 0 && name.length <= MAX_NAME, "a name of 1 to 32 characters");
    System.require(args.staked || args.free_prize, "a game needs a stake bucket, a free prize, or both");
    System.require(args.season_weeks <= MAX_SEASON_WEEKS, "a prize season is 1 to 4 weeks");
    const g = this.games.get(u32Key(args.game));
    if (g == null) System.require(c.game_count < MAX_GAMES, "at most 12 games besides the question game");
    else {
      System.require(!g.active, "that game is running: deactivate it first");
      // Audit V6-10: players' stake stays in a game until they take it out; it can't stop being a staked game first.
      System.require(args.staked || g.stake == 0, "players still have stake in that game: it must stay a staked game");
    }
    const pr = new kpred.game_proposal_object();
    const ng = new kpred.game_object();
    ng.id = args.game;
    ng.name = name;
    ng.staked = args.staked;
    ng.free_prize = args.free_prize;
    ng.season_weeks = args.season_weeks;
    pr.game = ng;
    pr.eta = this.now() + c.timelock_length;
    this.gproposals.put(u32Key(args.game), pr);
    const r = new kpred.propose_game_result();
    r.eta = pr.eta;
    return r;
  }

  apply_game(args: kpred.apply_game_arguments): kpred.apply_game_result {
    this.live();
    const c = this.cfg();
    System.require(this.isOwner(c), "owner only");
    const pk = u32Key(args.game);
    const pr = this.gproposals.get(pk);
    System.require(pr != null && pr!.eta > 0, "that game was not announced");
    const now = this.now();
    System.require(now >= pr!.eta, "the timelock has not passed yet");
    System.require(now < pr!.eta + ANNOUNCEMENT_EXPIRY, "this announcement expired: announce it again");
    let g = this.games.get(pk);
    const from = this.weekOf(c, now) + 1;
    if (g == null) {
      System.require(c.game_count < MAX_GAMES, "at most 12 games besides the question game");
      c.game_count += 1;
      this.config.put(c);
      g = new kpred.game_object();
      g.id = args.game;
      g.week = this.weekOf(c, now);
      g.from_week = from;
    } else {
      System.require(!g.active, "that game is running");
      System.require(pr!.game!.staked || g.stake == 0, "players still have stake in that game: it must stay a staked game");
      this.gameRoll(g!, this.weekOf(c, now));       // audit V6-3: keep the weights of the weeks it was stopped
      // Audit V6-6: a restart never takes back a week the game already earned. Restarted before its last earning week
      // ended: it simply keeps running (same seasons). After a gap: it starts again next week, once every week it
      // earned has been closed (so those weeks keep their bucket, prize and results).
      if (g!.last_week_plus_one == 0 || from > g!.last_week_plus_one) {
        System.require(this.totals.get()!.weeks_closed >= g!.last_week_plus_one,
          "the vault has not closed that game's last week yet: try again after the next close");
        g!.from_week = from;
      }
    }
    g!.name = pr!.game!.name;
    g!.staked = pr!.game!.staked;
    g!.free_prize = pr!.game!.free_prize;
    g!.season_weeks = pr!.game!.season_weeks;
    g!.active = true;
    g!.last_week_plus_one = 0;
    this.games.put(pk, g!);
    this.gproposals.remove(pk);
    const r = new kpred.apply_game_result();
    r.from_week = g!.from_week;
    return r;
  }

  deactivate_game(args: kpred.deactivate_game_arguments): kpred.deactivate_game_result {
    const c = this.cfg();
    System.require(this.isOwner(c), "owner only");
    const g = this.otherGame(args.game);
    System.require(g.active, "that game is not running");
    g.active = false;
    const last = this.weekOf(c, this.now()) + 1;    // it earns through this week, never a later one
    if (g.last_week_plus_one == 0 || last < g.last_week_plus_one) g.last_week_plus_one = last;
    this.games.put(u32Key(args.game), g);
    this.gproposals.remove(u32Key(args.game));
    return new kpred.deactivate_game_result();
  }

  claim_fee_vhp(args: kpred.claim_fee_vhp_arguments): kpred.claim_fee_vhp_result {
    const c = this.cfg();
    System.require(this.isOwner(c), "owner only");
    System.require(isAddress(args.to), "address required");
    const t = this.totals.get()!;
    System.require(args.amount > 0 && args.amount <= t.fee_vhp, "more than the fee owed");
    this.accrue(t);                                 // the fee waiting is part of what produces: measure it before it leaves
    t.fee_vhp -= args.amount;
    this.totals.put(t);
    this.ensureVhp(args.amount);
    Tokens.sendVhp(args.to!, args.amount);
    this.assertSolvent();
    return new kpred.claim_fee_vhp_result();
  }

  // ───────────── v6 read-only ─────────────

  get_game(args: kpred.get_game_arguments): kpred.get_game_result {
    const r = new kpred.get_game_result();
    r.game = this.games.get(u32Key(args.game));
    r.proposal = this.gproposals.get(u32Key(args.game));
    if (args.game != Q_GAME) {
      const gw = this.gweeks.get(this.gweekKey(args.game, args.week))!;
      r.week = gw;
      for (let p: u32 = 0; p <= gw.max_points; p++) r.buckets.push(this.gbuckets.get(this.gbucketKey(args.game, args.week, p))!);
    }
    return r;
  }

  list_games(args: kpred.list_games_arguments): kpred.list_games_result {
    const r = new kpred.list_games_result();
    r.games = this.gamesList();
    const ps = this.gproposals.getMany(new Uint8Array(0), 50);
    for (let i = 0; i < ps.length; i++) r.proposals.push(ps[i].value);
    return r;
  }

  get_game_player(args: kpred.get_game_player_arguments): kpred.get_game_player_result {
    const r = new kpred.get_game_player_result();
    const p = this.gplayers.get(this.gplayerKey(args.game, args.player!))!;
    r.player = p;
    r.entry = this.gentries.get(this.gentryKey(args.game, args.week, args.player!));
    r.active_stake = this.activeStakeG(p, args.week);
    r.week_stake = this.weekStakeG(args.game, args.player!, args.week);
    return r;
  }

  // ═══════════════════════ authorize: who may act as this contract's account ═══════════════════════

  authorize(args: authority.authorize_arguments): authority.authorize_result {
    if (args.type == authority.authorization_type.transaction_application) {
      return new authority.authorize_result(this.sponsorOk());
    }
    if (args.type == authority.authorization_type.contract_upload) {
      return new authority.authorize_result(this.upgradeOk());
    }
    // contract_call: nobody may move this contract's tokens from outside. Its own code moves them by its rules.
    return new authority.authorize_result(false);
  }

  /** Pay the Mana only for one answer / settle / claim that will succeed, with an rc_limit between the floor and the
   *  cap, canonical arguments, and within the account's weekly budget. Everything else is refused. */
  sponsorOk(): bool {
    if (safeMode()) return false;                    // withdrawals-only build: it never pays for a call (review of the fixes)
    const c = this.config.get()!;
    if (!isAddress(c.owner) || c.max_sponsor_rc == 0) return false;
    const rcLimit = System.getTransactionField("header.rc_limit")!.uint64_value;
    if (rcLimit > c.max_sponsor_rc || rcLimit < this.minSponsorRc(c) || rcLimit == 0) return false;
    const ops = txOps();
    if (ops.length != 1) return false;
    if (txSignatureCount() > 1) return false;           // v5 (M-3): no padding with extra signatures
    const op = ops[0];
    if (op.call_contract == null) return false;
    const cc = op.call_contract!;
    if (!Arrays.equal(cc.contract_id, this.contractId)) return false;
    if (cc.args.length > MAX_SPONSORED_ARGS) return false;
    if (cc.entry_point == EP_ANSWER) {
      const a = Protobuf.decode<kpred.answer_arguments>(cc.args, kpred.answer_arguments.decode);
      if (!Arrays.equal(Protobuf.encode(a, kpred.answer_arguments.encode), cc.args)) return false;   // no padding
      if (!isAddress(a.player)) return false;
      if (this.answerCheck(c, a.player!, a.question_id, a.option).length > 0) return false;
      // The pool pays the Mana only for staked players; free players use their own (or Kondor's free Mana).
      const q = this.questions.get(u32Key(a.question_id))!;
      const e = this.entries.get(this.entryKey(a.player!, q.week));
      const stake = e ? e.stake : this.activeStake(this.players.get(a.player!)!, q.week);
      const minStake = this.minStakeFor(c, q.week);
      if (minStake == 0 || stake == 0 || stake < minStake) return false;
      // Weekly budget: at most one sponsored answer per question posted that week, so a staked player can answer every
      // question for free (whatever their stake); settle and claim happen once per week each.
      const n: u32 = (e ? <u32>e.answers.length : 0) + 1;
      if (n > this.weeks.get(u64Key(q.week))!.questions) return false;
      return System.checkAuthority(authority.authorization_type.contract_call, a.player!);
    }
    if (cc.entry_point == EP_SETTLE) {
      const a = Protobuf.decode<kpred.settle_arguments>(cc.args, kpred.settle_arguments.decode);
      if (!Arrays.equal(Protobuf.encode(a, kpred.settle_arguments.encode), cc.args)) return false;
      if (!isAddress(a.player)) return false;
      const se = this.entries.get(this.entryKey(a.player!, a.week));
      // free players' entries are never paid for
      if (se == null || se.voided || se.stake == 0 || se.stake < this.minStakeFor(c, a.week)) return false;
      if (this.settleCheck(a.player!, a.week).length == 0) return true;
      // The week may simply not be closed yet although it is due: the settle call closes it first, then settles.
      const t = this.totals.get()!;
      return a.week == t.weeks_closed && this.closeDue(c, t, this.now()) && !se.settled;
    }
    if (cc.entry_point == EP_CLAIM) {
      const a = Protobuf.decode<kpred.claim_arguments>(cc.args, kpred.claim_arguments.decode);
      if (!Arrays.equal(Protobuf.encode(a, kpred.claim_arguments.encode), cc.args)) return false;
      if (!isAddress(a.player)) return false;
      // Only a claim that is valid right now: the week is finalized and the player is a winner who has not claimed.
      if (this.claimCheck(a.player!, a.week).length > 0) return false;
      // Free players' prizes (v5) are claimed with their own Mana, like all free play.
      const ce = this.entries.get(this.entryKey(a.player!, a.week));
      if (!ce || !ce.eligible) return false;
      // ...and one the pool can pay out now: VHP on hand plus what compound can burn back (spare KOIN, limited by the
      // Mana left after this transaction's own rc_limit), as claim's ensureVhp does.
      const wk = this.weeks.get(u64Key(a.week))!;
      const reward = this.rewardOf(a.week, wk, this.entries.get(this.entryKey(a.player!, a.week))!);
      const t = this.totals.get()!;
      const koinBal = Tokens.koinBalance(this.contractId), keep = t.seed_koin + t.creator_fee;
      let burnable: u64 = koinBal > keep ? koinBal - keep : 0;
      const mana = Tokens.mana(this.contractId);
      const manaLeft: u64 = mana > rcLimit ? mana - rcLimit : 0;
      if (burnable > manaLeft) burnable = manaLeft;
      const vhp = Tokens.vhpBalance(this.contractId);
      if (vhp < reward && reward - vhp > burnable) return false;
      return System.checkAuthority(authority.authorization_type.contract_call, a.player!);
    }
    return false;
  }

  /** Replace the code only with the owner's signature, only the announced bytecode, only after the timelock. */
  upgradeOk(): bool {
    const c = this.config.get()!;
    if (!isAddress(c.owner)) return false;
    const u = this.upgrade.get()!;
    if (u.hash == null || u.hash!.length != 32 || u.eta == 0) return false;
    if (this.now() < u.eta) return false;
    if (this.now() >= u.eta + ANNOUNCEMENT_EXPIRY) return false;   // expired: announce it again
    // The upload operation carries the whole new bytecode (tens of KB), far more than the default 1 KB buffer for
    // reading transaction fields. Enlarge it for this read so the check can see the bytecode at all.
    System.setSystemBufferSize(1024 * 1024);
    const ops = txOps();
    let found = false;
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      if (op.upload_contract == null) continue;
      const up = op.upload_contract!;
      if (!Arrays.equal(up.contract_id, this.contractId)) continue;
      // The new code must keep this contract in charge of its own account. With any of these switched off, whoever
      // holds the deploy key could move the pool's tokens or replace the code directly, skipping every rule here.
      if (!up.authorizes_call_contract || !up.authorizes_transaction_application || !up.authorizes_upload_contract) return false;
      const mh = new Crypto.Multihash();
      mh.deserialize(System.hash(Crypto.multicodec.sha2_256, up.bytecode)!);
      if (!Arrays.equal(mh.digest, u.hash)) return false;
      found = true;
    }
    if (!found) return false;
    return System.checkAuthority(authority.authorization_type.contract_call, c.owner!);
  }
}

// Silence "unused import" for Base58 in some SDK versions.
export function _addr(a: Uint8Array): string { return Base58.encode(a); }

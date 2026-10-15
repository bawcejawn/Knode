/**
 * KPRED — the Koinos block-producer prediction game.
 *
 * Players stake VHP (or KOIN, burned into VHP). The pooled VHP produces blocks through the game's node. Every week
 * the operator posts multiple-choice questions about the chain; players answer for free (the contract pays the
 * Mana); the operator resolves them from block data (hashes published so anyone can re-check). After the week:
 *   close_week     measures the pool's gain and splits it: 5% creator fee (KOIN), 2% owner share (VHP), 93% pot
 *   settle         counts each player's points (anyone can call it, for anyone, free)
 *   finalize_week  finds the winners: the top 30% of eligible stake by points, everyone tied at the cutoff included
 *   claim          pays each winner pot × (points × stake) / (sum of points × stake over winners), in VHP
 * All of this runs on-chain. The only off-chain inputs are the operator's question parameters and resolutions.
 *
 * Who can do what:
 *   players     deposit, withdraw (any time; voids that week's answers), answer, settle, claim
 *   operator    post and resolve questions — cannot move any funds
 *   owner       correct a resolution before its week closes, set operator, pause NEW deposits, register the node key,
 *               claim the creator fee / owner share, schedule an upgrade (uploadable only after the timelock)
 *   seed owner  add seed VHP/KOIN; withdraw it only after an announced timelock
 *   nobody      can take players' stakes or rewards, or the seed — not the owner, not the deploy key
 */
import { System, Storage, Protobuf, Arrays, Crypto, authority, value, protocol, Base58, u128 } from "@koinos/sdk-as";
import { kpred } from "./proto/kpred";
import { Tokens } from "./Tokens";

const VOID: u32 = 1000;
const MAX_QUESTIONS_PER_WEEK: u32 = 64;
const FEE_BPS: u64 = 500;       // 5% creator fee (KOIN)
const RETAIN_BPS: u64 = 200;    // 2% owner share (VHP)
const CUTOFF_BPS: u64 = 3000;   // winners = top 30% of eligible stake
const RESOLVE_MARGIN: u64 = 60; // resolve only after the window's blocks are irreversible (~3 minutes)
// Weeks and answer deadlines follow the block timestamps (ms, UTC), so they land on exact calendar times. The blocks a
// question watches are still counted by height; these bounds on the average block time keep the two consistent:
const MIN_BLOCK_MS: u64 = 2800; // even if blocks ran this fast, a question's window still starts after its answers close
const MAX_BLOCK_MS: u64 = 3500; // even if blocks ran this slow, the window still ends before its week is due to close
const MAX_SPONSOR_LIMIT: u64 = 1_000_000_000; // 10 KOIN of Mana: the most one free transaction may ever cost the pool

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

// ───────────── keys ─────────────
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
    return c;
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
    return t.total_stake + t.seed_vhp + t.seed_koin + t.owner_share + t.creator_fee + t.pots_outstanding;
  }

  /** Holdings must always cover everything owed. Checked after every reward/fee payout, so a bug can never pay out
   *  more than the pool has actually earned. (Principal returns — withdrawals, seed — are not blocked by it.) */
  assertSolvent(): void {
    const t = this.totals.get()!;
    const holdings = Tokens.vhpBalance(this.contractId) + Tokens.koinBalance(this.contractId);
    System.require(holdings >= this.liabilities(t), "solvency check failed: payout would exceed earned rewards");
  }

  // ───────────── automatic week progression ─────────────
  // A blockchain never runs code by itself: something has to send a transaction. So every game action
  // (deposit, withdraw, answer, settle, claim, compound, posting or resolving a question) first performs the
  // overdue steps — finalizing the oldest settled week and closing the next finished week (at most one of each) —
  // so the game moves forward on its own whenever anyone plays. The operator bot and the public close_week / finalize_week calls do the same thing.

  closeDue(c: kpred.config_object, t: kpred.totals_object, h: u64): bool {
    if (h < this.weekEnd(c, t.weeks_closed) + c.close_delay) return false;
    const wk = this.weeks.get(u64Key(t.weeks_closed))!;
    return wk.resolved == wk.questions;
  }

  finalizeDue(t: kpred.totals_object, h: u64): bool {
    if (t.weeks_finalized >= t.weeks_closed) return false;
    return h > this.weeks.get(u64Key(t.weeks_finalized))!.settle_end;
  }

  advance(c: kpred.config_object): void {
    const h = this.now();
    let t = this.totals.get()!;
    if (this.finalizeDue(t, h)) {
      this.finalizeInternal(t.weeks_finalized);
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
    if (this.activeStake(p, q.week) < c.min_stake) return "stake at least the minimum (counts from the week after depositing) to answer";
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

  claimCheck(player: Uint8Array, w: u64): string {
    const wk = this.weeks.get(u64Key(w))!;
    if (!wk.finalized) return "week not finalized yet";
    if (wk.rolled_over) return "no winners that week";
    const e = this.entries.get(this.entryKey(player, w));
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
    this.config.put(c);
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
    t.total_stake += amount;
    this.totals.put(t);
  }

  deposit_vhp(args: kpred.deposit_vhp_arguments): kpred.deposit_vhp_result {
    this.deposit(args.from!, args.amount, false);
    return new kpred.deposit_vhp_result();
  }

  deposit_koin(args: kpred.deposit_koin_arguments): kpred.deposit_koin_result {
    this.deposit(args.from!, args.amount, true);
    return new kpred.deposit_koin_result();
  }

  withdraw(args: kpred.withdraw_arguments): kpred.withdraw_result {
    const c = this.cfg();
    const to = args.to!;
    System.requireAuthority(authority.authorization_type.contract_call, to);
    System.require(args.amount > 0, "amount must be positive");
    this.advance(c);
    const h = this.now();
    const w = this.weekOf(c, h);
    const p = this.players.get(to)!;
    this.autoSettle(c, to, p);                      // a finished week is settled before this week is voided
    this.normalize(p, w);
    System.require(p.stake + p.pending >= args.amount, "more than your stake");
    // Take the not-yet-active part first.
    let rest = args.amount;
    const fromPending = rest < p.pending ? rest : p.pending;
    p.pending -= fromPending;
    rest -= fromPending;
    p.stake -= rest;
    // Any withdrawal during a running week voids that week's answers.
    if (h >= c.genesis_time) {
      p.void_week_plus_one = w + 1;
      const key = this.entryKey(to, w);
      const e = this.entries.get(key);
      if (e && !e.voided) {
        e.voided = true;
        this.entries.put(key, e);
      }
    }
    this.players.put(to, p);
    const t = this.totals.get()!;
    t.total_stake -= args.amount;
    this.totals.put(t);
    this.ensureVhp(args.amount);
    Tokens.sendVhp(to, args.amount);
    return new kpred.withdraw_result();
  }

  answer(args: kpred.answer_arguments): kpred.answer_result {
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
    // Eligible: not voided, more than one counted answer, and at least the minimum stake.
    e.eligible = !e.voided && counted > 1 && e.stake >= c.min_stake;
    this.entries.put(key, e);
    if (e.eligible) {
      const wk = this.weeks.get(u64Key(week))!;
      const bk = this.bucketKey(week, points);
      const b = this.buckets.get(bk)!;
      b.stake += e.stake;
      b.players += 1;
      this.buckets.put(bk, b);
      wk.eligible_stake += e.stake;
      wk.eligible_players += 1;
      if (points > wk.max_points) wk.max_points = points;
      this.weeks.put(u64Key(week), wk);
    }
    const r = new kpred.settle_result();
    r.points = points;
    r.eligible = e.eligible;
    return r;
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
    // reward = pot × (points × stake) / (Σ points × stake over winners), in 128-bit arithmetic
    const weight = u128.fromU64(<u64>e.points) * u128.fromU64(e.stake);
    const total = new u128(wk.weight_lo, wk.weight_hi);
    const reward = (u128.fromU64(wk.pot) * weight / total).toU64();
    e.claimed = true;
    e.reward = reward;
    this.entries.put(key, e);
    wk.claimed += reward;
    this.weeks.put(wkKey, wk);
    const t = this.totals.get()!;
    t.pots_outstanding -= reward;
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
    const c = this.cfg();
    const t = this.totals.get()!;
    System.require(args.week == t.weeks_closed, "weeks close in order: close week " + t.weeks_closed.toString() + " first");
    const h = this.now();
    System.require(h >= this.weekEnd(c, args.week) + c.close_delay, "too early to close this week");
    const wk = this.weeks.get(u64Key(args.week))!;
    System.require(wk.resolved == wk.questions, "some questions are not resolved yet");
    return this.closeInternal(c, args.week, h);
  }

  /** Measure the gain since the previous close and move it into what the contract owes (fee, share, pot).
   *  Each unit of gain is counted exactly once: after a close, holdings = liabilities again, so the next close
   *  only sees what was produced afterwards. Claims and withdrawals lower holdings and liabilities by the same
   *  amount, so their timing never changes any week's measured gain. */
  closeInternal(c: kpred.config_object, week: u64, h: u64): kpred.close_week_result {
    const t = this.totals.get()!;
    const wkKey = u64Key(week);
    const wk = this.weeks.get(wkKey)!;
    // Gain = everything the contract holds minus everything it owes.
    const holdings = Tokens.vhpBalance(this.contractId) + Tokens.koinBalance(this.contractId);
    const owed = this.liabilities(t);
    const gain = holdings > owed ? holdings - owed : 0;
    const fee = bps(gain, FEE_BPS);
    const retained = bps(gain, RETAIN_BPS);
    const pot = gain - fee - retained;
    t.creator_fee += fee;
    t.owner_share += retained;
    t.pots_outstanding += pot;
    t.total_gain += gain;
    t.weeks_closed += 1;
    this.totals.put(t);
    wk.closed = true;
    wk.gain = gain;
    wk.fee = fee;
    wk.retained = retained;
    wk.pot = pot;
    wk.settle_start = h;
    wk.settle_end = h + c.settle_length;
    this.weeks.put(wkKey, wk);
    const r = new kpred.close_week_result();
    r.gain = gain;
    r.pot = pot;
    return r;
  }

  finalize_week(args: kpred.finalize_week_arguments): kpred.finalize_week_result {
    this.cfg();
    const wk = this.weeks.get(u64Key(args.week))!;
    System.require(wk.closed, "week not closed yet");
    System.require(!wk.finalized, "already finalized");
    System.require(args.week == this.totals.get()!.weeks_finalized, "weeks finalize in order");
    System.require(this.now() > wk.settle_end, "settlement window still open");
    return this.finalizeInternal(args.week);
  }

  finalizeInternal(week: u64): kpred.finalize_week_result {
    const wkKey = u64Key(week);
    const wk = this.weeks.get(wkKey)!;
    // Walk down from the highest score until the winners hold at least 30% of eligible stake (ties included).
    let cutoff: u32 = 0;
    let cum: u64 = 0;
    const need = u128.fromU64(wk.eligible_stake) * u128.fromU64(CUTOFF_BPS);
    for (let p = wk.max_points; p >= 1; p--) {
      cum += this.buckets.get(this.bucketKey(week, p))!.stake;
      cutoff = p;
      if (u128.fromU64(cum) * u128.fromU64(10000) >= need) break;
    }
    let weight = u128.Zero;
    let winners: u32 = 0;
    if (cutoff >= 1) {
      for (let p = cutoff; p <= wk.max_points; p++) {
        const b = this.buckets.get(this.bucketKey(week, p))!;
        weight = weight + u128.fromU64(<u64>p) * u128.fromU64(b.stake);
        winners += b.players;
      }
    }
    wk.finalized = true;
    wk.cutoff = cutoff;
    const tf = this.totals.get()!;
    tf.weeks_finalized += 1;
    this.totals.put(tf);
    wk.winners = winners;
    wk.weight_lo = weight.lo;
    wk.weight_hi = weight.hi;
    if (weight.isZero()) {
      // Nobody scored: the pot goes back into the pool and becomes part of the next week's gain.
      wk.rolled_over = true;
      const t = this.totals.get()!;
      t.pots_outstanding -= wk.pot;
      this.totals.put(t);
    }
    this.weeks.put(wkKey, wk);
    const r = new kpred.finalize_week_result();
    r.cutoff = cutoff;
    r.winners = winners;
    return r;
  }

  // ═══════════════════════ operator ═══════════════════════

  post_question(args: kpred.post_question_arguments): kpred.post_question_result {
    const c = this.cfg();
    System.requireAuthority(authority.authorization_type.contract_call, c.operator!);
    this.advance(c);
    const h = this.height();
    const now = this.now();
    System.require(now >= c.genesis_time, "the game has not started yet");
    const w = this.weekOf(c, now);
    System.require(args.k >= 2 && args.k <= 16, "2 to 16 options");
    System.require(args.lock_time > now, "answers must close in the future");
    System.require(args.lock_time <= this.weekEnd(c, w), "answers must close before the week ends");
    // The watched blocks must come after answers close, even if blocks ran faster than normal until then.
    const minStart = h + (args.lock_time - now + MIN_BLOCK_MS - 1) / MIN_BLOCK_MS;
    System.require(args.window_start >= minStart && args.window_end >= args.window_start, "the window must start after answers close");
    // The window must finish (and be final) by the time the week is due to close, even if blocks ran slower than
    // normal, so no question can hold a week open.
    const due = this.weekEnd(c, w) + c.close_delay;
    System.require(args.window_end + RESOLVE_MARGIN > h && (args.window_end + RESOLVE_MARGIN - h) * MAX_BLOCK_MS <= due - now, "the window must end before the week is due to close");
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
    this.weeks.put(wkKey, wk);
    this.advance(c);                                // the last resolution of a finished week may let it close
    return new kpred.resolve_question_result();
  }

  // ═══════════════════════ owner ═══════════════════════

  correct_question(args: kpred.correct_question_arguments): kpred.correct_question_result {
    const c = this.cfg();
    System.require(this.isOwner(c), "owner only");
    const key = u32Key(args.id);
    const q = this.questions.get(key);
    System.require(q != null, "no such question");
    const wkKey = u64Key(q!.week);
    const wk = this.weeks.get(wkKey)!;
    System.require(!wk.closed, "the week is closed; resolutions are final");
    if (q!.outcome == 0) {
      // Still open (e.g. the bot is down or its key was lost): the owner may only VOID it, so the week can close.
      System.require(args.outcome == VOID, "an open question can only be voided (outcome 1000)");
      this.setOutcome(q!, args.outcome, args.data_hash);
      this.questions.put(key, q!);
      wk.resolved += 1;
      this.weeks.put(wkKey, wk);
      this.advance(c);
    } else {
      this.setOutcome(q!, args.outcome, args.data_hash);
      this.questions.put(key, q!);
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
    c.max_sponsor_rc = args.max_sponsor_rc;
    this.config.put(c);
    return new kpred.set_sponsor_limit_result();
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
    this.config.put(c);
    return new kpred.propose_owner_result();
  }

  accept_owner(args: kpred.accept_owner_arguments): kpred.accept_owner_result {
    const c = this.cfg();
    System.require(isAddress(c.pending_owner), "no ownership transfer proposed");
    System.requireAuthority(authority.authorization_type.contract_call, c.pending_owner!);
    c.owner = c.pending_owner;
    c.pending_owner = null;
    this.config.put(c);
    return new kpred.accept_owner_result();
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
    const c = this.cfg();
    System.requireAuthority(authority.authorization_type.contract_call, c.seed_owner!);
    System.require(args.amount > 0, "amount must be positive");
    Tokens.pullVhp(c.seed_owner!, args.amount);
    const t = this.totals.get()!;
    t.seed_vhp += args.amount;
    this.totals.put(t);
    return new kpred.seed_deposit_vhp_result();
  }

  seed_deposit_koin(args: kpred.seed_deposit_koin_arguments): kpred.seed_deposit_koin_result {
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
    const t = this.totals.get()!;
    const vhpAmt = s.vhp <= t.seed_vhp ? s.vhp : t.seed_vhp;
    let koinAmt = s.koin <= t.seed_koin ? s.koin : t.seed_koin;
    const mana = Tokens.mana(this.contractId);
    if (koinAmt > mana) koinAmt = mana;                 // the rest can be executed again after Mana refills
    t.seed_vhp -= vhpAmt;
    t.seed_koin -= koinAmt;
    this.totals.put(t);
    s.vhp -= vhpAmt;
    s.koin -= koinAmt;
    if (s.vhp == 0 && s.koin == 0) s.eta = 0;
    this.seedWd.put(s);
    if (vhpAmt > 0) {
      this.ensureVhp(vhpAmt);
      Tokens.sendVhp(c.seed_owner!, vhpAmt);
    }
    Tokens.sendKoin(c.seed_owner!, koinAmt);
    const r = new kpred.execute_seed_withdrawal_result();
    r.vhp = vhpAmt;
    r.koin = koinAmt;
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

  /** Pay the Mana only for one valid answer / settle / claim, with a capped rc_limit. Everything else is refused. */
  sponsorOk(): bool {
    const c = this.config.get()!;
    if (!isAddress(c.owner)) return false;
    const rcLimit = System.getTransactionField("header.rc_limit")!.uint64_value;
    if (rcLimit > c.max_sponsor_rc) return false;
    const ops = txOps();
    if (ops.length != 1) return false;
    const op = ops[0];
    if (op.call_contract == null) return false;
    const cc = op.call_contract!;
    if (!Arrays.equal(cc.contract_id, this.contractId)) return false;
    if (cc.entry_point == EP_ANSWER) {
      const a = Protobuf.decode<kpred.answer_arguments>(cc.args, kpred.answer_arguments.decode);
      if (!isAddress(a.player)) return false;
      if (this.answerCheck(c, a.player!, a.question_id, a.option).length > 0) return false;
      return System.checkAuthority(authority.authorization_type.contract_call, a.player!);
    }
    if (cc.entry_point == EP_SETTLE) {
      const a = Protobuf.decode<kpred.settle_arguments>(cc.args, kpred.settle_arguments.decode);
      if (!isAddress(a.player)) return false;
      if (this.settleCheck(a.player!, a.week).length == 0) return true;
      // The week may simply not be closed yet although it is due: the settle call closes it first.
      const t = this.totals.get()!;
      return a.week == t.weeks_closed && this.closeDue(c, t, this.now()) &&
        this.entries.get(this.entryKey(a.player!, a.week)) != null;
    }
    if (cc.entry_point == EP_CLAIM) {
      const a = Protobuf.decode<kpred.claim_arguments>(cc.args, kpred.claim_arguments.decode);
      if (!isAddress(a.player)) return false;
      if (this.claimCheck(a.player!, a.week).length > 0) {
        // Allow only if the week is merely awaiting its (due) finalization and the player was settled eligible.
        const t = this.totals.get()!;
        if (a.week != t.weeks_finalized || !this.finalizeDue(t, this.now())) return false;
        const e = this.entries.get(this.entryKey(a.player!, a.week));
        if (e == null || !e.eligible || e.claimed) return false;
      }
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

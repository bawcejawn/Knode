/**
 * KNODE SWAP DESK — swap VHP for KOIN, 1:1 minus a fee (3% at launch).
 *
 * How it works:
 *   - The desk holds KOIN (its liquidity) and VHP. Its VHP is registered with a block producer (the desk's own
 *     node). Every block the node produces turns some of the desk's VHP back into KOIN, plus the block reward,
 *     so the KOIN available for swaps keeps growing on its own.
 *   - A user sends VHP and receives KOIN in the same transaction: koin_out = vhp_amount − fee. The VHP (fee
 *     included) stays in the desk and goes on producing. So the fee compounds in the node.
 *   - A swap can pay out at most min(the desk's KOIN, the desk's Mana): sending KOIN needs Mana ≥ the amount.
 *
 * Safety rules:
 *   users      a swap takes their VHP only if they signed it, pays at least the min_koin_out they chose (or fails
 *              and nothing moves), and settles in one transaction: the desk never holds anyone else's money
 *   owner      fee (never above 10%), swap limits, pause, node key; withdrawals go ONLY to the treasury address
 *   timelock   changing the treasury, the owner (v2) or the code takes an announced delay (48 h at launch), and so
 *              does anything that loosens the desk (v2): a lower fee, a higher daily cap, a new node key. A stolen
 *              owner key can't drain or redirect the desk before the real owner sees it and acts.
 *   daily cap  (v2) swaps pay out at most daily_cap KOIN at once, and room frees up at daily_cap per 24 hours
 *              (0 = no cap)
 *   nobody     can move the desk's tokens from outside — not the deploy key, not anyone
 */
import { System, Storage, Protobuf, Arrays, Crypto, authority, value, protocol, u128 } from "@koinos/sdk-as";
import { desk } from "./proto/desk";
import { Tokens } from "./Tokens";

const MAX_FEE_BPS: u32 = 1000;   // the fee can never be set above 10%
const RECENT: u32 = 20;          // how many recent swaps the desk keeps for the website

// Storage spaces
const S_CONFIG: u32 = 0;
const S_TOTALS: u32 = 1;
const S_RECENT: u32 = 2;
const S_UPGRADE: u32 = 3;
const S_TREASURY: u32 = 4;
const S_OWNER_CHANGE: u32 = 5;   // v2
const S_PENDING: u32 = 6;        // v2
const DAY_MS: u64 = 86_400_000;
const ANNOUNCEMENT_EXPIRY: u64 = 7 * DAY_MS;   // v2: an announced change must be carried out within 7 days after its timelock

function u32Key(v: u32): Uint8Array {
  const k = new Uint8Array(4);
  for (let i = 0; i < 4; i++) k[i] = <u8>((v >> (<u32>(24 - 8 * i))) & 0xff);
  return k;
}
function isAddress(a: Uint8Array | null): bool {
  return a != null && a.length == 25;
}
function min64(a: u64, b: u64): u64 { return a < b ? a : b; }

/** The fee on a swap, rounded UP to the smallest unit so rounding never favours either side by more than 1 unit
 *  and the desk is never short-changed by it. */
export function feeOf(amount: u64, feeBps: u32): u64 {
  const n = u128.fromU64(amount) * u128.fromU64(<u64>feeBps);
  const d = u128.fromU64(10000);
  let f = (n / d).toU64();
  if (u128.fromU64(f) * d < n) f += 1;
  return f;
}

/** The current transaction's operations (same reader as the game contract, proven on mainnet). */
function txOps(): protocol.operation[] {
  if (BUILD_FOR_TESTING) return System.getTransaction().operations;
  const list = Protobuf.decode<value.list_type>(System.getTransactionField("operations")!.message_value!.value!, value.list_type.decode);
  const out = new Array<protocol.operation>();
  for (let i = 0; i < list.values.length; i++) {
    out.push(Protobuf.decode<protocol.operation>(list.values[i].message_value!.value!, protocol.operation.decode));
  }
  return out;
}

export class Desk {
  contractId: Uint8Array = System.getContractId();

  config: Storage.Obj<desk.config_object> = new Storage.Obj(System.getContractId(), S_CONFIG, desk.config_object.decode, desk.config_object.encode, () => new desk.config_object());
  totals: Storage.Obj<desk.totals_object> = new Storage.Obj(System.getContractId(), S_TOTALS, desk.totals_object.decode, desk.totals_object.encode, () => new desk.totals_object());
  recent: Storage.Map<Uint8Array, desk.swap_record> = new Storage.Map(System.getContractId(), S_RECENT, desk.swap_record.decode, desk.swap_record.encode, null);
  upgrade: Storage.Obj<desk.timelock_object> = new Storage.Obj(System.getContractId(), S_UPGRADE, desk.timelock_object.decode, desk.timelock_object.encode, () => new desk.timelock_object());
  treasuryChange: Storage.Obj<desk.timelock_object> = new Storage.Obj(System.getContractId(), S_TREASURY, desk.timelock_object.decode, desk.timelock_object.encode, () => new desk.timelock_object());
  ownerChange: Storage.Obj<desk.timelock_object> = new Storage.Obj(System.getContractId(), S_OWNER_CHANGE, desk.timelock_object.decode, desk.timelock_object.encode, () => new desk.timelock_object());
  pending: Storage.Obj<desk.pending_settings> = new Storage.Obj(System.getContractId(), S_PENDING, desk.pending_settings.decode, desk.pending_settings.encode, () => new desk.pending_settings());

  // ═══════════════════════ helpers ═══════════════════════

  now(): u64 {
    return System.getBlockField("header.timestamp")!.uint64_value;
  }

  cfg(): desk.config_object {
    const c = this.config.get()!;
    System.require(isAddress(c.owner), "not initialised");
    return c;
  }

  requireOwner(c: desk.config_object): void {
    System.require(System.checkAccountAuthority(c.owner!), "owner only");
  }

  /** Most KOIN one swap can pay out right now: the desk's KOIN, but never more than its Mana. */
  available(): u64 {
    return min64(Tokens.koinBalance(this.contractId), Tokens.mana(this.contractId));
  }

  /** v2: the daily cap is a bucket that drains at daily_cap per 24 hours: what swaps paid out counts against it and
   *  frees up gradually, so payouts can never burst past the cap at a window boundary. */
  capUsed(c: desk.config_object, t: desk.totals_object): u64 {
    if (t.day_out == 0 || t.day_start == 0) return 0;
    const now = this.now();
    const elapsed = now > t.day_start ? now - t.day_start : 0;
    const drained = elapsed >= DAY_MS ? u64.MAX_VALUE : u128.muldiv(u128.fromU64(c.daily_cap), u128.fromU64(elapsed), u128.fromU64(DAY_MS)).toU64();
    return t.day_out > drained ? t.day_out - drained : 0;
  }

  /** v2: KOIN the daily cap still allows right now (u64 max when there is no cap). */
  capLeft(c: desk.config_object): u64 {
    if (c.daily_cap == 0) return u64.MAX_VALUE;
    const used = this.capUsed(c, this.totals.get()!);
    return used >= c.daily_cap ? 0 : c.daily_cap - used;
  }

  /** Most KOIN one swap can pay out right now: what is available, within the daily cap. */
  swapAvailable(c: desk.config_object): u64 {
    return min64(this.available(), this.capLeft(c));
  }

  /** "" when a swap of `amount` VHP is possible right now, otherwise the reason. */
  swapProblem(c: desk.config_object, amount: u64, out: u64): string {
    if (c.paused) return "swaps are paused";
    if (amount == 0) return "amount must be positive";
    if (amount < c.min_swap) return "below the minimum swap";
    if (c.max_swap > 0 && amount > c.max_swap) return "above the maximum swap";
    if (out == 0) return "amount too small";
    if (out > this.available()) return "not enough KOIN available right now";
    if (out > this.capLeft(c)) return "the desk's daily swap limit is reached: try a smaller amount or again later";
    return "";
  }

  /** Largest VHP amount one swap can take right now (0 when swaps are impossible). */
  maxVhpIn(c: desk.config_object): u64 {
    if (c.paused) return 0;
    const avail = this.swapAvailable(c);
    if (avail == 0) return 0;
    // Invert koin_out = amount − fee, then adjust by single units for rounding (koin_out never decreases as the
    // amount grows, so this lands on the largest amount that fits; at most a few steps either way).
    const q = u128.fromU64(avail) * u128.fromU64(10000) / u128.fromU64(<u64>(10000 - c.fee_bps));
    // v2: clamp instead of truncating (unreachable with real balances, but never wrong).
    let amount: u64 = q > u128.fromU64(u64.MAX_VALUE - 1) ? u64.MAX_VALUE - 1 : q.toU64();
    while (amount > 0 && amount - feeOf(amount, c.fee_bps) > avail) amount -= 1;
    while (amount < u64.MAX_VALUE - 1 && amount + 1 - feeOf(amount + 1, c.fee_bps) <= avail) amount += 1;
    if (c.max_swap > 0 && amount > c.max_swap) amount = c.max_swap;
    return amount < c.min_swap ? 0 : amount;
  }

  // ═══════════════════════ read-only ═══════════════════════

  get_state(args: desk.get_state_arguments): desk.get_state_result {
    const r = new desk.get_state_result();
    const c = this.config.get()!;
    r.config = c;
    r.totals = this.totals.get()!;
    r.koin_balance = Tokens.koinBalance(this.contractId);
    r.vhp_balance = Tokens.vhpBalance(this.contractId);
    r.mana = Tokens.mana(this.contractId);
    r.available = min64(r.koin_balance, r.mana);
    r.max_vhp_in = isAddress(c.owner) ? this.maxVhpIn(c) : 0;
    r.time = this.now();
    r.upgrade = this.upgrade.get()!;
    r.treasury_change = this.treasuryChange.get()!;
    r.owner_change = this.ownerChange.get()!;
    r.pending = this.pending.get()!;
    if (isAddress(c.owner) && c.daily_cap > 0) r.swap_left_today = this.capLeft(c);
    return r;
  }

  quote(args: desk.quote_arguments): desk.quote_result {
    const c = this.cfg();
    const r = new desk.quote_result();
    r.fee = feeOf(args.vhp_amount, c.fee_bps);
    r.koin_out = args.vhp_amount > r.fee ? args.vhp_amount - r.fee : 0;
    r.problem = this.swapProblem(c, args.vhp_amount, r.koin_out);
    return r;
  }

  get_recent(args: desk.get_recent_arguments): desk.get_recent_result {
    const r = new desk.get_recent_result();
    const t = this.totals.get()!;
    const n = t.swaps < <u64>RECENT ? <u32>t.swaps : RECENT;
    for (let i: u32 = 1; i <= n; i++) {
      const slot = (t.next_slot + RECENT - i) % RECENT;
      const s = this.recent.get(u32Key(slot));
      if (s != null) r.swaps.push(s!);
    }
    return r;
  }

  // ═══════════════════════ setup ═══════════════════════

  init(args: desk.init_arguments): desk.init_result {
    const c = this.config.get()!;
    System.require(!isAddress(c.owner), "already initialised");
    System.require(BUILD_FOR_TESTING || this.signedByContractKey(), "init must be signed by the contract's own key");
    System.require(isAddress(args.owner) && isAddress(args.treasury), "owner and treasury are required");
    // The desk can't own itself (nobody could ever act as owner) or pay itself (withdrawals would go nowhere).
    System.require(!Arrays.equal(args.owner, this.contractId), "the owner must be a wallet, not the desk itself");
    System.require(!Arrays.equal(args.treasury, this.contractId), "the treasury must be a wallet, not the desk itself");
    System.require(args.fee_bps <= MAX_FEE_BPS, "fee at most 10%");
    System.require(args.min_swap > 0, "min_swap must be positive");
    System.require(args.max_swap == 0 || args.max_swap >= args.min_swap, "max_swap below min_swap");
    System.require(args.timelock_length > 0, "timelock must be positive");
    c.owner = args.owner;
    c.treasury = args.treasury;
    c.fee_bps = args.fee_bps;
    c.min_swap = args.min_swap;
    c.max_swap = args.max_swap;
    c.timelock_length = args.timelock_length;
    c.paused = false;
    this.config.put(c);
    return new desk.init_result();
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

  // ═══════════════════════ swapping ═══════════════════════

  swap(args: desk.swap_arguments): desk.swap_result {
    const c = this.cfg();
    System.require(isAddress(args.from), "from address required");
    // Only the owner of the VHP can swap it — nobody can use someone else's open approval.
    System.requireAuthority(authority.authorization_type.contract_call, args.from!);
    System.require(!Arrays.equal(args.from, this.contractId), "the desk cannot swap with itself");
    const amount = args.vhp_amount;
    const fee = feeOf(amount, c.fee_bps);
    const out = amount > fee ? amount - fee : 0;
    const problem = this.swapProblem(c, amount, out);
    System.require(problem.length == 0, problem);
    System.require(out >= args.min_koin_out, "the price changed: you would receive less than your minimum");

    // Take the VHP first, then pay. If either fails, the whole transaction is undone.
    Tokens.pullVhp(args.from!, amount);
    Tokens.sendKoin(args.from!, out);

    const t = this.totals.get()!;
    t.day_out = (c.daily_cap > 0 ? this.capUsed(c, t) : 0) + out;   // what still counts, plus this swap
    t.day_start = this.now();
    t.swaps += 1;
    t.vhp_in += amount;
    t.koin_out += out;
    const rec = new desk.swap_record(args.from, amount, out, this.now());
    this.recent.put(u32Key(t.next_slot), rec);
    t.next_slot = (t.next_slot + 1) % RECENT;
    this.totals.put(t);
    System.event("desk.swap", Protobuf.encode(rec, desk.swap_record.encode), [args.from!]);

    const r = new desk.swap_result();
    r.koin_out = out;
    r.fee = fee;
    return r;
  }

  // ═══════════════════════ owner ═══════════════════════

  withdraw_koin(args: desk.withdraw_koin_arguments): desk.withdraw_koin_result {
    const c = this.cfg();
    this.requireOwner(c);
    System.require(args.amount > 0, "amount must be positive");
    // Sending KOIN needs Mana ≥ the amount: send what Mana allows now; the rest can follow once Mana refills.
    const amount = min64(args.amount, this.available());
    System.require(amount > 0, "no KOIN can be sent right now (no KOIN or no Mana)");
    Tokens.sendKoin(c.treasury!, amount);
    const r = new desk.withdraw_koin_result();
    r.amount = amount;
    return r;
  }

  withdraw_vhp(args: desk.withdraw_vhp_arguments): desk.withdraw_vhp_result {
    const c = this.cfg();
    this.requireOwner(c);
    System.require(args.amount > 0, "amount must be positive");
    System.require(args.amount <= Tokens.vhpBalance(this.contractId), "more than the desk holds");
    Tokens.sendVhp(c.treasury!, args.amount);
    return new desk.withdraw_vhp_result();
  }

  set_fee(args: desk.set_fee_arguments): desk.set_fee_result {
    const c = this.cfg();
    this.requireOwner(c);
    System.require(args.fee_bps <= MAX_FEE_BPS, "fee at most 10%");
    const r = new desk.set_fee_result();
    const p = this.pending.get()!;
    if (args.fee_bps >= c.fee_bps) {
      c.fee_bps = args.fee_bps;                      // a higher (or the same) fee protects the desk: at once
      this.config.put(c);
      if (p.has_fee) { p.has_fee = false; p.fee_bps = 0; this.pending.put(p); }
    } else {
      p.has_fee = true;                              // a lower fee waits for the timelock (v2, audit M-7)
      p.fee_bps = args.fee_bps;
      p.eta = this.now() + c.timelock_length;
      this.pending.put(p);
      r.eta = p.eta;
    }
    return r;
  }

  set_limits(args: desk.set_limits_arguments): desk.set_limits_result {
    const c = this.cfg();
    this.requireOwner(c);
    System.require(args.min_swap > 0, "min_swap must be positive");
    System.require(args.max_swap == 0 || args.max_swap >= args.min_swap, "max_swap below min_swap");
    c.min_swap = args.min_swap;
    c.max_swap = args.max_swap;
    this.config.put(c);
    return new desk.set_limits_result();
  }

  set_paused(args: desk.set_paused_arguments): desk.set_paused_result {
    const c = this.cfg();
    this.requireOwner(c);
    c.paused = args.paused;
    this.config.put(c);
    return new desk.set_paused_result();
  }

  register_key(args: desk.register_key_arguments): desk.register_key_result {
    const c = this.cfg();
    this.requireOwner(c);
    System.require(args.public_key != null && args.public_key!.length == 33, "33-byte compressed public key required");
    const k0 = args.public_key![0];
    System.require(k0 == 0x02 || k0 == 0x03, "not a compressed public key (it must start with 02 or 03)");
    // v2 (audit M-7): a new key redirects the desk's block production, so it waits for the timelock.
    const p = this.pending.get()!;
    p.public_key = args.public_key;
    p.eta = this.now() + c.timelock_length;
    this.pending.put(p);
    const r = new desk.register_key_result();
    r.eta = p.eta;
    return r;
  }

  set_daily_cap(args: desk.set_daily_cap_arguments): desk.set_daily_cap_result {
    const c = this.cfg();
    this.requireOwner(c);
    const r = new desk.set_daily_cap_result();
    const tighter = args.daily_cap > 0 && (c.daily_cap == 0 || args.daily_cap <= c.daily_cap);
    const p = this.pending.get()!;
    if (tighter) {
      c.daily_cap = args.daily_cap;
      this.config.put(c);
      if (p.has_cap) { p.has_cap = false; p.daily_cap = 0; this.pending.put(p); }
    } else {
      p.has_cap = true;
      p.daily_cap = args.daily_cap;
      p.eta = this.now() + c.timelock_length;
      this.pending.put(p);
      r.eta = p.eta;
    }
    return r;
  }

  apply_settings(args: desk.apply_settings_arguments): desk.apply_settings_result {
    const c = this.cfg();
    this.requireOwner(c);
    const p = this.pending.get()!;
    System.require(p.eta > 0 && (p.has_fee || p.has_cap || (p.public_key != null && p.public_key!.length == 33)), "no settings change waiting");
    System.require(this.now() >= p.eta, "the timelock has not passed yet");
    System.require(this.now() < p.eta + ANNOUNCEMENT_EXPIRY, "this request expired (it must be carried out within 7 days after its timelock): request it again");
    if (p.has_fee) c.fee_bps = p.fee_bps;
    if (p.has_cap) c.daily_cap = p.daily_cap;
    this.config.put(c);
    if (p.public_key != null && p.public_key!.length == 33) Tokens.registerProducerKey(p.public_key!);
    this.pending.put(new desk.pending_settings());
    return new desk.apply_settings_result();
  }

  cancel_settings(args: desk.cancel_settings_arguments): desk.cancel_settings_result {
    const c = this.cfg();
    this.requireOwner(c);
    this.pending.put(new desk.pending_settings());
    return new desk.cancel_settings_result();
  }

  // v2 (audit M-6): the desk can change hands, in two steps with the timelock in between.
  propose_owner(args: desk.propose_owner_arguments): desk.propose_owner_result {
    const c = this.cfg();
    this.requireOwner(c);
    System.require(isAddress(args.new_owner), "address required");
    System.require(!Arrays.equal(args.new_owner, this.contractId), "the owner must be a wallet, not the desk itself");
    const o = new desk.timelock_object();
    o.address = args.new_owner;
    o.eta = this.now() + c.timelock_length;
    this.ownerChange.put(o);
    const r = new desk.propose_owner_result();
    r.eta = o.eta;
    return r;
  }

  accept_owner(args: desk.accept_owner_arguments): desk.accept_owner_result {
    const c = this.cfg();
    const o = this.ownerChange.get()!;
    System.require(isAddress(o.address) && o.eta > 0, "no owner change proposed");
    System.requireAuthority(authority.authorization_type.contract_call, o.address!);
    System.require(this.now() >= o.eta, "the timelock has not passed yet");
    System.require(this.now() < o.eta + ANNOUNCEMENT_EXPIRY, "this request expired (it must be carried out within 7 days after its timelock): request it again");
    c.owner = o.address;
    this.config.put(c);
    // The new owner starts clean: nothing the previous owner announced carries over.
    this.ownerChange.put(new desk.timelock_object());
    this.upgrade.put(new desk.timelock_object());
    this.treasuryChange.put(new desk.timelock_object());
    this.pending.put(new desk.pending_settings());
    return new desk.accept_owner_result();
  }

  cancel_owner(args: desk.cancel_owner_arguments): desk.cancel_owner_result {
    const c = this.cfg();
    this.requireOwner(c);
    this.ownerChange.put(new desk.timelock_object());
    return new desk.cancel_owner_result();
  }

  schedule_treasury(args: desk.schedule_treasury_arguments): desk.schedule_treasury_result {
    const c = this.cfg();
    this.requireOwner(c);
    System.require(isAddress(args.treasury), "address required");
    System.require(!Arrays.equal(args.treasury, this.contractId), "the treasury must be a wallet, not the desk itself");
    const s = new desk.timelock_object();
    s.address = args.treasury;
    s.eta = this.now() + c.timelock_length;
    this.treasuryChange.put(s);
    const r = new desk.schedule_treasury_result();
    r.eta = s.eta;
    return r;
  }

  apply_treasury(args: desk.apply_treasury_arguments): desk.apply_treasury_result {
    const c = this.cfg();
    this.requireOwner(c);
    const s = this.treasuryChange.get()!;
    System.require(isAddress(s.address) && s.eta > 0, "no treasury change announced");
    System.require(this.now() >= s.eta, "the timelock has not passed yet");
    System.require(this.now() < s.eta + ANNOUNCEMENT_EXPIRY, "this request expired (it must be carried out within 7 days after its timelock): request it again");
    c.treasury = s.address;
    this.config.put(c);
    this.treasuryChange.put(new desk.timelock_object());
    return new desk.apply_treasury_result();
  }

  cancel_treasury(args: desk.cancel_treasury_arguments): desk.cancel_treasury_result {
    const c = this.cfg();
    this.requireOwner(c);
    this.treasuryChange.put(new desk.timelock_object());
    return new desk.cancel_treasury_result();
  }

  schedule_upgrade(args: desk.schedule_upgrade_arguments): desk.schedule_upgrade_result {
    const c = this.cfg();
    this.requireOwner(c);
    System.require(args.hash != null && args.hash!.length == 32, "sha256 hash of the new bytecode required");
    const u = new desk.timelock_object();
    u.hash = args.hash;
    u.eta = this.now() + c.timelock_length;
    this.upgrade.put(u);
    const r = new desk.schedule_upgrade_result();
    r.eta = u.eta;
    return r;
  }

  cancel_upgrade(args: desk.cancel_upgrade_arguments): desk.cancel_upgrade_result {
    const c = this.cfg();
    this.requireOwner(c);
    this.upgrade.put(new desk.timelock_object());
    return new desk.cancel_upgrade_result();
  }

  // ═══════════════════════ authorize: who may act as this contract's account ═══════════════════════

  authorize(args: authority.authorize_arguments): authority.authorize_result {
    if (args.type == authority.authorization_type.contract_upload) {
      return new authority.authorize_result(this.upgradeOk());
    }
    // The desk pays nobody's Mana (users pay their own), and nobody may move its tokens from outside.
    // Its own code moves them by the rules above.
    return new authority.authorize_result(false);
  }

  /** Replace the code only with the owner's signature, only the announced bytecode, only after the timelock. */
  upgradeOk(): bool {
    const c = this.config.get()!;
    if (!isAddress(c.owner)) return false;
    const u = this.upgrade.get()!;
    if (u.hash == null || u.hash!.length != 32 || u.eta == 0) return false;
    if (this.now() < u.eta) return false;
    if (this.now() >= u.eta + ANNOUNCEMENT_EXPIRY) return false;   // expired: announce it again
    // The upload operation carries the whole new bytecode; enlarge the buffer so the check can read it.
    System.setSystemBufferSize(1024 * 1024);
    const ops = txOps();
    let found = false;
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      if (op.upload_contract == null) continue;
      const up = op.upload_contract!;
      if (!Arrays.equal(up.contract_id, this.contractId)) continue;
      // The new code must keep this contract in charge of its own account (otherwise the deploy key could take over).
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

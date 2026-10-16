/**
 * Swap desk tests on a simulated Koinos chain (MockVM). Token movements use the in-contract test ledger.
 * Run with: npm test
 */
import { Base58, MockVM, authority, chain, System, protocol, Crypto } from "@koinos/sdk-as";
import { Desk, feeOf } from "../Desk";
import { Tokens } from "../Tokens";
import { desk } from "../proto/desk";

const CONTRACT = Base58.decode("1DQzuCcTKacbs9GGScRTU1Hc8BsyARTPqe");
const OWNER = Base58.decode("1DQzuCcTKacbs9GGScRTU1Hc8BsyARTPqG");
const TREASURY = Base58.decode("1DQzuCcTKacbs9GGScRTU1Hc8BsyARTPqK");
const A = Base58.decode("1PWeFG4pPtjZZoYvcmGb6mYhMYJjnkHrmz");
const B = Base58.decode("1HGh4rQvYYcm4fGiU1C7vQoSxnUiGa9Ah7");
const THIEF = Base58.decode("12Y5vW6gk8GceH53YfRkRre2Rrcsgw7Naq");

const VHP: u64 = 100_000_000;
const KOIN_TAG: u8 = 1, VHP_TAG: u8 = 2, MANA_TAG: u8 = 3, ALLOW_TAG: u8 = 4;
const TIMELOCK: u64 = 48 * 3600 * 1000;

// ───────────── harness ─────────────
function at(ms: u64): void {
  MockVM.setBlock(new protocol.block(new Uint8Array(0), new protocol.block_header(new Uint8Array(0), ms / 3000, ms)));
  System.resetCache();
}
function as(acct: Uint8Array): void {
  MockVM.setAuthorities([new MockVM.MockAuthority(authority.authorization_type.contract_call, acct, true)]);
}
function give(tag: u8, who: Uint8Array, amount: u64): void { Tokens.testSet(tag, who, Tokens.testGet(tag, who) + amount); }
function bal(tag: u8, who: Uint8Array): u64 { return Tokens.testGet(tag, who); }

function setup(): Desk {
  MockVM.reset();
  MockVM.setContractId(CONTRACT);
  MockVM.setContractArguments(CONTRACT);
  MockVM.setEntryPoint(0);
  MockVM.setCaller(new chain.caller_data(new Uint8Array(0), chain.privilege.user_mode));
  MockVM.setContractMetadata(new chain.contract_metadata_object(new Uint8Array(0), false, false, false, false));
  MockVM.setHeadInfo(new chain.head_info(null, 0, 1));
  at(1_000_000);
  const d = new Desk();
  d.init(new desk.init_arguments(OWNER, TREASURY, 300, VHP, 0, TIMELOCK));
  // The desk is funded with 1,000 KOIN (with its Mana) and holds 5,000 VHP that produce blocks.
  give(KOIN_TAG, CONTRACT, 1000 * VHP);
  give(MANA_TAG, CONTRACT, 1000 * VHP);
  give(VHP_TAG, CONTRACT, 5000 * VHP);
  give(VHP_TAG, A, 2000 * VHP);
  give(VHP_TAG, B, 2000 * VHP);
  return d;
}

/** A swaps with an approval of exactly the amount (approve + swap in one transaction). */
function swap(d: Desk, who: Uint8Array, amount: u64, minOut: u64): desk.swap_result {
  give(ALLOW_TAG, who, amount);
  as(who);
  return d.swap(new desk.swap_arguments(who, amount, minOut));
}

// Globals used inside expect(() => ...).toThrow() (AssemblyScript closures cannot capture locals).
let gD: Desk | null = null;
let gWho: Uint8Array = new Uint8Array(0);
let gAmt: u64 = 0;
let gMin: u64 = 0;
function tryThrow(): void { gD!.swap(new desk.swap_arguments(gWho, gAmt, gMin)); }

describe("setup", () => {
  it("initialises once, with a fee of at most 10%", () => {
    const d = setup();
    const s = d.get_state(new desk.get_state_arguments());
    expect(Base58.encode(s.config!.owner!)).toBe(Base58.encode(OWNER));
    expect(Base58.encode(s.config!.treasury!)).toBe(Base58.encode(TREASURY));
    expect(s.config!.fee_bps).toBe(300);
    expect(s.available).toBe(1000 * VHP);
    gD = d;
    MockVM.commitTransaction();
    expect(() => { gD!.init(new desk.init_arguments(A, A, 300, 1, 0, 1)); }).toThrow();
    expect(MockVM.getErrorMessage()).toBe("already initialised");
  });

  it("fee rounds up to the smallest unit, never in the user's favour by more than 1 unit", () => {
    expect(feeOf(100 * VHP, 300)).toBe(3 * VHP);
    expect(feeOf(1, 300)).toBe(1);                 // 0.03 units → 1 unit
    expect(feeOf(33_333_333, 300)).toBe(1_000_000); // 999,999.99 → 1,000,000
    expect(feeOf(1000, 0)).toBe(0);
  });
});

describe("swapping", () => {
  it("100 VHP pays 97 KOIN; the 100 VHP (fee included) stay in the desk", () => {
    const d = setup();
    const r = swap(d, A, 100 * VHP, 97 * VHP);
    expect(r.koin_out).toBe(97 * VHP);
    expect(r.fee).toBe(3 * VHP);
    expect(bal(KOIN_TAG, A)).toBe(97 * VHP);
    expect(bal(VHP_TAG, A)).toBe(1900 * VHP);
    expect(bal(KOIN_TAG, CONTRACT)).toBe(903 * VHP);
    expect(bal(MANA_TAG, CONTRACT)).toBe(903 * VHP);
    expect(bal(VHP_TAG, CONTRACT)).toBe(5100 * VHP);
    const t = d.get_state(new desk.get_state_arguments()).totals!;
    expect(t.swaps).toBe(1);
    expect(t.vhp_in).toBe(100 * VHP);
    expect(t.koin_out).toBe(97 * VHP);
    const rec = d.get_recent(new desk.get_recent_arguments()).swaps;
    expect(rec.length).toBe(1);
    expect(Base58.encode(rec[0].account!)).toBe(Base58.encode(A));
  });

  it("quote matches the swap, and fractional amounts work", () => {
    const d = setup();
    const q = d.quote(new desk.quote_arguments(150_000_001));
    expect(q.problem).toBe("");
    expect(q.fee).toBe(4_500_001);
    expect(q.koin_out).toBe(145_500_000);
    const r = swap(d, A, 150_000_001, q.koin_out);
    expect(r.koin_out).toBe(q.koin_out);
  });

  it("refuses to pay less than the user's minimum — nothing moves", () => {
    const d = setup();
    give(ALLOW_TAG, A, 100 * VHP);
    as(A);
    gD = d; gWho = A; gAmt = 100 * VHP; gMin = 97 * VHP + 1;
    MockVM.commitTransaction();
    expect(() => { tryThrow(); }).toThrow();
    expect(MockVM.getErrorMessage()).toBe("the price changed: you would receive less than your minimum");
    expect(bal(VHP_TAG, A)).toBe(2000 * VHP);
    expect(bal(KOIN_TAG, A)).toBe(0);
  });

  it("needs the VHP approval in the same transaction", () => {
    const d = setup();
    as(A);
    gD = d; gWho = A; gAmt = 100 * VHP; gMin = 0;
    MockVM.commitTransaction();
    expect(() => { tryThrow(); }).toThrow();
    expect(bal(VHP_TAG, A)).toBe(2000 * VHP);
    expect(bal(KOIN_TAG, CONTRACT)).toBe(1000 * VHP);
  });

  it("nobody can swap someone else's VHP, even with that person's open approval", () => {
    const d = setup();
    give(ALLOW_TAG, A, 100 * VHP);   // A approved the desk earlier and never used it
    as(THIEF);
    gD = d; gWho = A; gAmt = 100 * VHP; gMin = 0;
    MockVM.commitTransaction();
    expect(() => { tryThrow(); }).toThrow();
    expect(bal(VHP_TAG, A)).toBe(2000 * VHP);
  });

  it("pays out at most min(KOIN, Mana); max_vhp_in is exactly the largest swap that fits", () => {
    const d = setup();
    Tokens.testSet(MANA_TAG, CONTRACT, 50 * VHP);           // Mana partly used: only 50 KOIN can move now
    const s = d.get_state(new desk.get_state_arguments());
    expect(s.available).toBe(50 * VHP);
    const maxIn = s.max_vhp_in;
    expect(maxIn - feeOf(maxIn, 300) <= 50 * VHP).toBe(true);
    expect(maxIn + 1 - feeOf(maxIn + 1, 300) > 50 * VHP).toBe(true);
    expect(d.quote(new desk.quote_arguments(maxIn + 1)).problem).toBe("not enough KOIN available right now");
    give(ALLOW_TAG, A, maxIn + 1);
    as(A);
    gD = d; gWho = A; gAmt = maxIn + 1; gMin = 0;
    MockVM.commitTransaction();
    expect(() => { tryThrow(); }).toThrow();
    expect(MockVM.getErrorMessage()).toBe("not enough KOIN available right now");
    const r = swap(d, A, maxIn, 0);
    expect(r.koin_out <= 50 * VHP).toBe(true);
  });

  it("KOIN produced by the node becomes available for swaps", () => {
    const d = setup();
    expect(d.get_state(new desk.get_state_arguments()).available).toBe(1000 * VHP);
    // A produced block: some VHP turns back into KOIN, plus the reward.
    Tokens.testSet(VHP_TAG, CONTRACT, 4990 * VHP);
    give(KOIN_TAG, CONTRACT, 12 * VHP);
    give(MANA_TAG, CONTRACT, 12 * VHP);
    expect(d.get_state(new desk.get_state_arguments()).available).toBe(1012 * VHP);
  });

  it("respects the minimum, the maximum and pause", () => {
    const d = setup();
    expect(d.quote(new desk.quote_arguments(VHP - 1)).problem).toBe("below the minimum swap");
    as(OWNER);
    d.set_limits(new desk.set_limits_arguments(VHP, 10 * VHP));
    expect(d.quote(new desk.quote_arguments(11 * VHP)).problem).toBe("above the maximum swap");
    expect(d.get_state(new desk.get_state_arguments()).max_vhp_in).toBe(10 * VHP);
    d.set_paused(new desk.set_paused_arguments(true));
    expect(d.quote(new desk.quote_arguments(5 * VHP)).problem).toBe("swaps are paused");
    expect(d.get_state(new desk.get_state_arguments()).max_vhp_in).toBe(0);
    give(ALLOW_TAG, A, 5 * VHP);
    as(A);
    gD = d; gWho = A; gAmt = 5 * VHP; gMin = 0;
    MockVM.commitTransaction();
    expect(() => { tryThrow(); }).toThrow();
    expect(MockVM.getErrorMessage()).toBe("swaps are paused");
    as(OWNER);
    d.set_paused(new desk.set_paused_arguments(false));
    expect(swap(d, A, 5 * VHP, 0).koin_out).toBe(485_000_000);
  });

  it("keeps the 20 most recent swaps, newest first", () => {
    const d = setup();
    for (let i: u64 = 1; i <= 25; i++) swap(d, i % 2 == 0 ? A : B, i * VHP, 0);
    const rec = d.get_recent(new desk.get_recent_arguments()).swaps;
    expect(rec.length).toBe(20);
    expect(rec[0].vhp_in).toBe(25 * VHP);
    expect(rec[19].vhp_in).toBe(6 * VHP);
    expect(d.get_state(new desk.get_state_arguments()).totals!.swaps).toBe(25);
  });
});

describe("owner", () => {
  it("withdrawals go only to the treasury; KOIN is capped by Mana; owner only", () => {
    const d = setup();
    as(THIEF);
    gD = d;
    MockVM.commitTransaction();
    expect(() => { gD!.withdraw_koin(new desk.withdraw_koin_arguments(VHP)); }).toThrow();
    expect(() => { gD!.withdraw_vhp(new desk.withdraw_vhp_arguments(VHP)); }).toThrow();
    as(OWNER);
    Tokens.testSet(MANA_TAG, CONTRACT, 300 * VHP);
    expect(d.withdraw_koin(new desk.withdraw_koin_arguments(500 * VHP)).amount).toBe(300 * VHP);
    expect(bal(KOIN_TAG, TREASURY)).toBe(300 * VHP);
    d.withdraw_vhp(new desk.withdraw_vhp_arguments(1000 * VHP));
    expect(bal(VHP_TAG, TREASURY)).toBe(1000 * VHP);
    expect(bal(VHP_TAG, CONTRACT)).toBe(4000 * VHP);
    gD = d;
    MockVM.commitTransaction();
    expect(() => { gD!.withdraw_vhp(new desk.withdraw_vhp_arguments(4001 * VHP)); }).toThrow();
  });

  it("the fee can be changed by the owner, never above 10%", () => {
    const d = setup();
    as(OWNER);
    gD = d;
    MockVM.commitTransaction();
    expect(() => { gD!.set_fee(new desk.set_fee_arguments(1001)); }).toThrow();
    as(OWNER);
    d.set_fee(new desk.set_fee_arguments(1000));
    expect(d.quote(new desk.quote_arguments(100 * VHP)).koin_out).toBe(90 * VHP);
    as(A);
    gD = d;
    MockVM.commitTransaction();
    expect(() => { gD!.set_fee(new desk.set_fee_arguments(0)); }).toThrow();
  });

  it("a new treasury takes effect only after the timelock; it can be cancelled", () => {
    const d = setup();
    as(OWNER);
    const eta = d.schedule_treasury(new desk.schedule_treasury_arguments(B)).eta;
    expect(eta).toBe(1_000_000 + TIMELOCK);
    gD = d;
    MockVM.commitTransaction();
    expect(() => { gD!.apply_treasury(new desk.apply_treasury_arguments()); }).toThrow();
    expect(MockVM.getErrorMessage()).toBe("the timelock has not passed yet");
    // Meanwhile the owner can still pull everything to the CURRENT treasury.
    as(OWNER);
    d.withdraw_vhp(new desk.withdraw_vhp_arguments(5000 * VHP));
    expect(bal(VHP_TAG, TREASURY)).toBe(5000 * VHP);
    at(eta);
    d.apply_treasury(new desk.apply_treasury_arguments());
    expect(Base58.encode(d.get_state(new desk.get_state_arguments()).config!.treasury!)).toBe(Base58.encode(B));
    // cancel
    d.schedule_treasury(new desk.schedule_treasury_arguments(THIEF));
    d.cancel_treasury(new desk.cancel_treasury_arguments());
    at(eta * 3);
    gD = d;
    MockVM.commitTransaction();
    expect(() => { gD!.apply_treasury(new desk.apply_treasury_arguments()); }).toThrow();
  });

  it("nobody can act as the desk's account; code is replaced only as announced, after the timelock", () => {
    const d = setup();
    expect(d.authorize(new authority.authorize_arguments(authority.authorization_type.contract_call)).value).toBe(false);
    expect(d.authorize(new authority.authorize_arguments(authority.authorization_type.transaction_application)).value).toBe(false);
    const code = new Uint8Array(100);
    code.fill(42);
    const mh = new Crypto.Multihash();
    mh.deserialize(System.hash(Crypto.multicodec.sha2_256, code)!);
    const tx = new protocol.transaction();
    tx.header = new protocol.transaction_header();
    const op = new protocol.operation();
    op.upload_contract = new protocol.upload_contract_operation(CONTRACT, code, "", true, true, true);
    tx.operations.push(op);
    MockVM.setTransaction(tx);
    System.resetCache();
    const up = new authority.authorize_arguments(authority.authorization_type.contract_upload);
    as(OWNER);
    expect(d.authorize(up).value).toBe(false);       // nothing announced
    const eta = d.schedule_upgrade(new desk.schedule_upgrade_arguments(mh.digest)).eta;
    expect(d.authorize(up).value).toBe(false);       // before the timelock
    at(eta);
    expect(d.authorize(up).value).toBe(true);        // owner, right code, after the timelock
    as(A);
    expect(d.authorize(up).value).toBe(false);       // not the owner
    as(OWNER);
    for (let flag = 0; flag < 3; flag++) {
      op.upload_contract = new protocol.upload_contract_operation(CONTRACT, code, "", flag != 0, flag != 1, flag != 2);
      tx.operations[0] = op;
      MockVM.setTransaction(tx);
      System.resetCache();
      expect(d.authorize(up).value).toBe(false);     // the desk's own rules switched off: refused
    }
    op.upload_contract = new protocol.upload_contract_operation(CONTRACT, code, "", true, true, true);
    tx.operations[0] = op;
    MockVM.setTransaction(tx);
    System.resetCache();
    d.cancel_upgrade(new desk.cancel_upgrade_arguments());
    expect(d.authorize(up).value).toBe(false);       // cancelled
  });
});

// ═══════════════════════ edge cases and fund safety ═══════════════════════

const C = Base58.decode("19GYjDBVXU7keLbYvMLazsGQn3GTWHjHkK");
let seed: u64 = 12345;
function rnd(n: u64): u64 { seed = seed * 6364136223846793005 + 1442695040888963407; return (seed >> 33) % n; }
function totalOf(tag: u8): u64 {
  return bal(tag, CONTRACT) + bal(tag, A) + bal(tag, B) + bal(tag, C) + bal(tag, THIEF) + bal(tag, TREASURY) + bal(tag, OWNER);
}

describe("fund safety", () => {
  it("200 random swaps: no token is created or lost, every fee is exactly 3% rounded up, totals add up", () => {
    const d = setup();
    give(KOIN_TAG, CONTRACT, 9000 * VHP); give(MANA_TAG, CONTRACT, 9000 * VHP);   // 10,000 KOIN of liquidity
    give(VHP_TAG, C, 2000 * VHP);
    const koinBefore = totalOf(KOIN_TAG), vhpBefore = totalOf(VHP_TAG);
    const deskKoin0 = bal(KOIN_TAG, CONTRACT), deskVhp0 = bal(VHP_TAG, CONTRACT);
    let sumIn: u64 = 0, sumOut: u64 = 0;
    for (let i = 0; i < 200; i++) {
      const who = rnd(3) == 0 ? A : rnd(2) == 0 ? B : C;
      const amount = VHP + rnd(40 * VHP);                         // 1 to 41 VHP, any number of decimals
      const userKoin = bal(KOIN_TAG, who), userVhp = bal(VHP_TAG, who);
      const r = swap(d, who, amount, 0);
      // the fee is the smallest whole unit amount that is at least 3%
      expect(r.fee * 10000 >= amount * 300).toBe(true);
      expect((r.fee - 1) * 10000 < amount * 300).toBe(true);
      expect(r.koin_out + r.fee).toBe(amount);
      expect(bal(KOIN_TAG, who)).toBe(userKoin + r.koin_out);
      expect(bal(VHP_TAG, who)).toBe(userVhp - amount);
      sumIn += amount; sumOut += r.koin_out;
    }
    expect(totalOf(KOIN_TAG)).toBe(koinBefore);                    // nothing created, nothing lost
    expect(totalOf(VHP_TAG)).toBe(vhpBefore);
    expect(bal(KOIN_TAG, CONTRACT)).toBe(deskKoin0 - sumOut);
    expect(bal(VHP_TAG, CONTRACT)).toBe(deskVhp0 + sumIn);
    const t = d.get_state(new desk.get_state_arguments()).totals!;
    expect(t.swaps).toBe(200);
    expect(t.vhp_in).toBe(sumIn);
    expect(t.koin_out).toBe(sumOut);
    expect(bal(ALLOW_TAG, A) + bal(ALLOW_TAG, B) + bal(ALLOW_TAG, C)).toBe(0);  // every approval used up exactly
  });

  it("every owner action is refused for anyone else", () => {
    const d = setup();
    gD = d;
    as(THIEF);
    MockVM.commitTransaction();
    expect(() => { gD!.withdraw_koin(new desk.withdraw_koin_arguments(VHP)); }).toThrow();
    expect(() => { gD!.withdraw_vhp(new desk.withdraw_vhp_arguments(VHP)); }).toThrow();
    expect(() => { gD!.set_fee(new desk.set_fee_arguments(0)); }).toThrow();
    expect(() => { gD!.set_limits(new desk.set_limits_arguments(1, 0)); }).toThrow();
    expect(() => { gD!.set_paused(new desk.set_paused_arguments(true)); }).toThrow();
    expect(() => { const k = new Uint8Array(33); k[0] = 2; gD!.register_key(new desk.register_key_arguments(k)); }).toThrow();
    expect(() => { gD!.schedule_treasury(new desk.schedule_treasury_arguments(Base58.decode("12Y5vW6gk8GceH53YfRkRre2Rrcsgw7Naq"))); }).toThrow();
    expect(() => { gD!.apply_treasury(new desk.apply_treasury_arguments()); }).toThrow();
    expect(() => { gD!.cancel_treasury(new desk.cancel_treasury_arguments()); }).toThrow();
    expect(() => { gD!.schedule_upgrade(new desk.schedule_upgrade_arguments(new Uint8Array(32))); }).toThrow();
    expect(() => { gD!.cancel_upgrade(new desk.cancel_upgrade_arguments()); }).toThrow();
    expect(bal(KOIN_TAG, CONTRACT)).toBe(1000 * VHP);
    expect(bal(VHP_TAG, CONTRACT)).toBe(5000 * VHP);
    expect(bal(KOIN_TAG, THIEF) + bal(VHP_TAG, THIEF)).toBe(0);
  });

  it("a leftover approval cannot be used by anyone else", () => {
    const d = setup();
    give(ALLOW_TAG, A, 200 * VHP);                    // A approved 200 but swaps only 100
    as(A);
    d.swap(new desk.swap_arguments(A, 100 * VHP, 0));
    expect(bal(ALLOW_TAG, A)).toBe(100 * VHP);
    as(THIEF);
    gD = d; gWho = A; gAmt = 100 * VHP; gMin = 0;
    MockVM.commitTransaction();
    expect(() => { tryThrow(); }).toThrow();
    expect(bal(VHP_TAG, A)).toBe(1900 * VHP);
  });

  it("a fee raised just before a swap lands cannot take more than the user agreed to", () => {
    const d = setup();
    const q = d.quote(new desk.quote_arguments(100 * VHP));   // the page shows 97 KOIN
    as(OWNER);
    d.set_fee(new desk.set_fee_arguments(1000));               // owner raises the fee to 10% in between
    give(ALLOW_TAG, A, 100 * VHP);
    as(A);
    gD = d; gWho = A; gAmt = 100 * VHP; gMin = q.koin_out;
    MockVM.commitTransaction();
    expect(() => { tryThrow(); }).toThrow();
    expect(MockVM.getErrorMessage()).toBe("the price changed: you would receive less than your minimum");
    expect(bal(VHP_TAG, A)).toBe(2000 * VHP);
  });

  it("the exact last KOIN can be swapped out; with no Mana nothing can", () => {
    const d = setup();
    Tokens.testSet(MANA_TAG, CONTRACT, 97 * VHP);
    expect(swap(d, A, 100 * VHP, 97 * VHP).koin_out).toBe(97 * VHP);  // pays out exactly everything Mana allows
    const s = d.get_state(new desk.get_state_arguments());
    expect(s.available).toBe(0);
    expect(s.max_vhp_in).toBe(0);
    expect(d.quote(new desk.quote_arguments(VHP)).problem).toBe("not enough KOIN available right now");
    // the owner can't withdraw KOIN without Mana either
    as(OWNER);
    gD = d;
    MockVM.commitTransaction();
    expect(() => { gD!.withdraw_koin(new desk.withdraw_koin_arguments(VHP)); }).toThrow();
  });

  it("tiny amounts never pay out for free; huge amounts never overflow", () => {
    const d = setup();
    as(OWNER);
    d.set_limits(new desk.set_limits_arguments(1, 0));
    const q = d.quote(new desk.quote_arguments(1));
    expect(q.fee).toBe(1);
    expect(q.koin_out).toBe(0);
    expect(q.problem).toBe("amount too small");
    expect(d.quote(new desk.quote_arguments(34)).koin_out).toBe(32);   // fee 1.02 → 2
    expect(feeOf(u64.MAX_VALUE, 1000)).toBe(1844674407370955162);
    expect(d.quote(new desk.quote_arguments(u64.MAX_VALUE)).problem).toBe("not enough KOIN available right now");
    expect(d.quote(new desk.quote_arguments(0)).problem).toBe("amount must be positive");
  });

  it("pausing stops swaps but never stops withdrawals to the treasury", () => {
    const d = setup();
    as(OWNER);
    d.set_paused(new desk.set_paused_arguments(true));
    d.withdraw_vhp(new desk.withdraw_vhp_arguments(10 * VHP));
    expect(d.withdraw_koin(new desk.withdraw_koin_arguments(10 * VHP)).amount).toBe(10 * VHP);
    expect(bal(VHP_TAG, TREASURY)).toBe(10 * VHP);
    expect(bal(KOIN_TAG, TREASURY)).toBe(10 * VHP);
  });

  it("refuses bad settings", () => {
    const d = setup();
    as(OWNER);
    gD = d;
    MockVM.commitTransaction();
    expect(() => { gD!.set_limits(new desk.set_limits_arguments(0, 0)); }).toThrow();
    expect(() => { gD!.set_limits(new desk.set_limits_arguments(10 * VHP, 5 * VHP)); }).toThrow();
    expect(() => { gD!.schedule_treasury(new desk.schedule_treasury_arguments(new Uint8Array(3))); }).toThrow();
    expect(() => { gD!.schedule_treasury(new desk.schedule_treasury_arguments(CONTRACT)); }).toThrow();
    expect(() => { gD!.apply_treasury(new desk.apply_treasury_arguments()); }).toThrow();
    expect(MockVM.getErrorMessage()).toBe("no treasury change announced");
    expect(() => { gD!.register_key(new desk.register_key_arguments(new Uint8Array(20))); }).toThrow();
    expect(() => { gD!.schedule_upgrade(new desk.schedule_upgrade_arguments(new Uint8Array(5))); }).toThrow();
    expect(() => { gD!.withdraw_vhp(new desk.withdraw_vhp_arguments(0)); }).toThrow();
    expect(() => { gD!.withdraw_koin(new desk.withdraw_koin_arguments(0)); }).toThrow();
  });

  it("before setup nothing works except reading; setup refuses a fee above 10%", () => {
    MockVM.reset();
    MockVM.setContractId(CONTRACT);
    MockVM.setContractArguments(CONTRACT);
    MockVM.setEntryPoint(0);
    MockVM.setCaller(new chain.caller_data(new Uint8Array(0), chain.privilege.user_mode));
    MockVM.setContractMetadata(new chain.contract_metadata_object(new Uint8Array(0), false, false, false, false));
    MockVM.setHeadInfo(new chain.head_info(null, 0, 1));
    at(1_000_000);
    const d = new Desk();
    expect(d.get_state(new desk.get_state_arguments()).max_vhp_in).toBe(0);
    expect(d.authorize(new authority.authorize_arguments(authority.authorization_type.contract_upload)).value).toBe(false);
    give(ALLOW_TAG, A, VHP);
    give(VHP_TAG, A, VHP);
    as(A);
    gD = d; gWho = A; gAmt = VHP; gMin = 0;
    MockVM.commitTransaction();
    expect(() => { tryThrow(); }).toThrow();
    expect(MockVM.getErrorMessage()).toBe("not initialised");
    expect(() => { gD!.init(new desk.init_arguments(OWNER, TREASURY, 1001, VHP, 0, TIMELOCK)); }).toThrow();
    expect(() => { gD!.init(new desk.init_arguments(OWNER, TREASURY, 300, 0, 0, TIMELOCK)); }).toThrow();
    expect(() => { gD!.init(new desk.init_arguments(OWNER, TREASURY, 300, VHP, 0, 0)); }).toThrow();
    expect(() => { gD!.init(new desk.init_arguments(OWNER, new Uint8Array(0), 300, VHP, 0, TIMELOCK)); }).toThrow();
    expect(() => { gD!.init(new desk.init_arguments(OWNER, CONTRACT, 300, VHP, 0, TIMELOCK)); }).toThrow();
    expect(MockVM.getErrorMessage()).toBe("the treasury must be a wallet, not the desk itself");
    expect(() => { gD!.init(new desk.init_arguments(CONTRACT, TREASURY, 300, VHP, 0, TIMELOCK)); }).toThrow();
    expect(MockVM.getErrorMessage()).toBe("the owner must be a wallet, not the desk itself");
  });

  it("a stolen owner key: the thief can only pay the real treasury, and the owner empties the desk before a treasury change", () => {
    const d = setup();
    swap(d, A, 100 * VHP, 0);
    as(OWNER);                                         // ← the thief, holding a copy of the owner key
    d.withdraw_koin(new desk.withdraw_koin_arguments(100 * VHP));
    expect(bal(KOIN_TAG, TREASURY)).toBe(100 * VHP);   // …only reaches YOUR treasury
    expect(bal(KOIN_TAG, THIEF)).toBe(0);
    const eta = d.schedule_treasury(new desk.schedule_treasury_arguments(THIEF)).eta;  // tries to redirect
    // You see the alert and, well within the 48 h, move everything out to the treasury:
    at(eta - 1);
    const left = bal(KOIN_TAG, CONTRACT);
    d.withdraw_koin(new desk.withdraw_koin_arguments(left));
    d.withdraw_vhp(new desk.withdraw_vhp_arguments(bal(VHP_TAG, CONTRACT)));
    at(eta);
    d.apply_treasury(new desk.apply_treasury_arguments());
    expect(bal(KOIN_TAG, CONTRACT) + bal(VHP_TAG, CONTRACT)).toBe(0);  // nothing left to take
    expect(bal(KOIN_TAG, THIEF) + bal(VHP_TAG, THIEF)).toBe(0);
    expect(bal(VHP_TAG, TREASURY)).toBe(5100 * VHP);
  });
});

/**
 * Desk v2 rules (2026-10): two-step owner change, timelocked fee cuts / cap increases / node keys, a daily swap cap,
 * key validation. MockVM; in-contract test ledger. Run: npm test
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

const NEW_OWNER = Base58.decode("19GYjDBVXU7keLbYvMLazsGQn3GTWHjHkK");
function key33(first: u8): Uint8Array { const k = new Uint8Array(33); k.fill(7); k[0] = first; return k; }

describe("v2: the desk changes hands in two steps, with the timelock between", () => {
  it("propose, wait, accept; the new owner starts with nothing announced; the old owner is out", () => {
    const d = setup();
    as(OWNER);
    d.schedule_upgrade(new desk.schedule_upgrade_arguments(new Uint8Array(32)));
    d.schedule_treasury(new desk.schedule_treasury_arguments(A));
    d.set_fee(new desk.set_fee_arguments(100));                 // a fee cut, waiting
    const eta = d.propose_owner(new desk.propose_owner_arguments(NEW_OWNER)).eta;
    expect(eta).toBe(1_000_000 + TIMELOCK);
    gD = d;
    as(NEW_OWNER);
    MockVM.commitTransaction();
    expect(() => { gD!.accept_owner(new desk.accept_owner_arguments()); }).toThrow();
    expect(MockVM.getErrorMessage()).toBe("the timelock has not passed yet");
    at(1_000_000 + TIMELOCK);
    as(THIEF);
    MockVM.commitTransaction();
    expect(() => { gD!.accept_owner(new desk.accept_owner_arguments()); }).toThrow();
    as(NEW_OWNER);
    d.accept_owner(new desk.accept_owner_arguments());
    const s = d.get_state(new desk.get_state_arguments());
    expect(Base58.encode(s.config!.owner!)).toBe(Base58.encode(NEW_OWNER));
    expect(s.upgrade!.eta).toBe(0);
    expect(s.treasury_change!.eta).toBe(0);
    expect(s.pending!.eta).toBe(0);
    expect(s.config!.fee_bps).toBe(300);
    as(OWNER);
    MockVM.commitTransaction();
    expect(() => { gD!.set_paused(new desk.set_paused_arguments(true)); }).toThrow();
  });

  it("the owner can cancel a proposed change; only the owner can propose", () => {
    const d = setup();
    gD = d;
    as(THIEF);
    MockVM.commitTransaction();
    expect(() => { gD!.propose_owner(new desk.propose_owner_arguments(THIEF)); }).toThrow();
    as(OWNER);
    d.propose_owner(new desk.propose_owner_arguments(NEW_OWNER));
    d.cancel_owner(new desk.cancel_owner_arguments());
    at(1_000_000 + TIMELOCK);
    as(NEW_OWNER);
    MockVM.commitTransaction();
    expect(() => { gD!.accept_owner(new desk.accept_owner_arguments()); }).toThrow();
    expect(MockVM.getErrorMessage()).toBe("no owner change proposed");
  });
});

describe("v2: anything that loosens the desk waits for the timelock (audit M-7)", () => {
  it("a higher fee applies at once; a lower fee only via apply_settings after the timelock", () => {
    const d = setup();
    as(OWNER);
    expect(d.set_fee(new desk.set_fee_arguments(500)).eta).toBe(0);
    expect(d.get_state(new desk.get_state_arguments()).config!.fee_bps).toBe(500);
    expect(d.set_fee(new desk.set_fee_arguments(0)).eta).toBe(1_000_000 + TIMELOCK);
    expect(d.get_state(new desk.get_state_arguments()).config!.fee_bps).toBe(500);   // still 5%
    gD = d;
    MockVM.commitTransaction();
    expect(() => { gD!.apply_settings(new desk.apply_settings_arguments()); }).toThrow();
    expect(MockVM.getErrorMessage()).toBe("the timelock has not passed yet");
    at(1_000_000 + TIMELOCK);
    as(OWNER);
    d.apply_settings(new desk.apply_settings_arguments());
    expect(d.get_state(new desk.get_state_arguments()).config!.fee_bps).toBe(0);
  });

  it("raising the fee drops a waiting cut", () => {
    const d = setup();
    as(OWNER);
    d.set_fee(new desk.set_fee_arguments(100));
    d.set_fee(new desk.set_fee_arguments(400));
    at(1_000_000 + TIMELOCK);
    as(OWNER);
    gD = d;
    MockVM.commitTransaction();
    expect(() => { gD!.apply_settings(new desk.apply_settings_arguments()); }).toThrow();
    expect(d.get_state(new desk.get_state_arguments()).config!.fee_bps).toBe(400);
  });

  it("a node key must be a compressed public key and is registered only after the timelock", () => {
    const d = setup();
    gD = d;
    as(OWNER);
    MockVM.commitTransaction();
    expect(() => { gD!.register_key(new desk.register_key_arguments(key33(4))); }).toThrow();
    expect(MockVM.getErrorMessage()).toBe("not a compressed public key (it must start with 02 or 03)");
    expect(d.register_key(new desk.register_key_arguments(key33(2))).eta).toBe(1_000_000 + TIMELOCK);
    expect(d.get_state(new desk.get_state_arguments()).pending!.public_key!.length).toBe(33);
    at(1_000_000 + TIMELOCK);
    as(OWNER);
    d.apply_settings(new desk.apply_settings_arguments());
    expect(d.get_state(new desk.get_state_arguments()).pending!.eta).toBe(0);
  });
});

describe("v2: a daily cap on what all swaps together pay out", () => {
  it("setting a cap applies at once; swaps stop at it; it resets after 24 hours; raising it waits", () => {
    const d = setup();
    as(OWNER);
    expect(d.set_daily_cap(new desk.set_daily_cap_arguments(100 * VHP)).eta).toBe(0);
    swap(d, A, 100 * VHP, 0);                                     // pays 97 KOIN
    let s = d.get_state(new desk.get_state_arguments());
    expect(s.swap_left_today).toBe(3 * VHP);
    expect(s.max_vhp_in < 4 * VHP).toBe(true);
    gD = d; gWho = B; gAmt = 10 * VHP; gMin = 0;
    give(ALLOW_TAG, B, 10 * VHP);
    as(B);
    MockVM.commitTransaction();
    expect(() => { tryThrow(); }).toThrow();
    expect(MockVM.getErrorMessage()).toBe("the desk's daily swap limit is reached: try a smaller amount or again later");
    at(1_000_000 + 86_400_000);
    swap(d, B, 10 * VHP, 0);                                      // a new day
    as(OWNER);
    expect(d.set_daily_cap(new desk.set_daily_cap_arguments(0)).eta > 0).toBe(true);   // removing the cap waits
    s = d.get_state(new desk.get_state_arguments());
    expect(s.config!.daily_cap).toBe(100 * VHP);
  });
});

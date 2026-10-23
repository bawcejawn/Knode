// Red-team THIEF (fix check 2, Knode audit-fixes-1 @ 1dbc129): the new "settle refused when the entry is voided"
// sponsorship rule: cheap bypass and legitimate use. Asserts the SAFE behaviour: a failing case is a proven problem.
// Harness: game/assembly/__tests__/Kpred.sponsor-claim-revert.spec.ts lines 4-142 (= Kpred.v4.spec.ts harness), copied unchanged.
/**
 * v4 rules (audit fixes 2026-10). Game contract tests on a simulated Koinos chain (MockVM). Token movements use the in-contract test ledger.
 * Run with: npm test
 */
import { Base58, MockVM, authority, chain, Protobuf, System, protocol, value, Crypto } from "@koinos/sdk-as";
import { Kpred, rankWeight, testSetFinalizePage } from "../Kpred";
import { Tokens } from "../Tokens";
import { kpred } from "../proto/kpred";

const CONTRACT = Base58.decode("1DQzuCcTKacbs9GGScRTU1Hc8BsyARTPqe");
const OWNER = Base58.decode("1DQzuCcTKacbs9GGScRTU1Hc8BsyARTPqG");
const OPERATOR = Base58.decode("1DQzuCcTKacbs9GGScRTU1Hc8BsyARTPqK");
const SEED = Base58.decode("1DQzuCcTKacbs9GGScRTU1Hc8BsyARTPqP");
const A = Base58.decode("1PWeFG4pPtjZZoYvcmGb6mYhMYJjnkHrmz");
const B = Base58.decode("1HGh4rQvYYcm4fGiU1C7vQoSxnUiGa9Ah7");
const C = Base58.decode("12Y5vW6gk8GceH53YfRkRre2Rrcsgw7Naq");
const D = Base58.decode("19GYjDBVXU7keLbYvMLazsGQn3GTWHjHkK");
const E = Base58.decode("159myq5YUhhoVWu3wsHKHiJYKPKGUrGiyv");
const P6 = Base58.decode("128NayuVt5K2r2C2upFG5rzkL1KcsFKsT8");
const P7 = Base58.decode("185Djfb4GWSnvNhiTugz3za5pJKqfzcEWv");
const P8 = Base58.decode("1GN9xyV95FD5jthuzmQJjo9rBxWL5tRhjx");
const P9 = Base58.decode("19B5aaeahBD9HX1V64Wq3sXJw9XkckEp46");
const P10 = Base58.decode("1pWpb9BdnDQoZR1nzrWe9WhRJKENNu6KL");

const VHP: u64 = 100_000_000;
const KOIN_TAG: u8 = 1, VHP_TAG: u8 = 2, MANA_TAG: u8 = 3;
const GENESIS: u64 = 1000, WEEK: u64 = 1000;
// Simulated blocks are MS apart (the contract's fastest allowed average), so block heights and times line up simply.
const MS: u64 = 2800;

// ───────────── harness ─────────────
function at(h: u64): void {
  MockVM.setBlock(new protocol.block(new Uint8Array(0), new protocol.block_header(new Uint8Array(0), h, h * MS)));
  System.resetCache();
}
function as(acct: Uint8Array): void {
  MockVM.setAuthorities([new MockVM.MockAuthority(authority.authorization_type.contract_call, acct, true)]);
}
function nobody(): void { MockVM.setAuthorities([]); }
function near(a: u64, b: u64): bool { return a > b ? a - b <= 2 : b - a <= 2; }
function hash32(n: u8): Uint8Array { const h = new Uint8Array(32); h.fill(n); return h; }
function give(tag: u8, who: Uint8Array, amount: u64): void { Tokens.testSet(tag, who, Tokens.testGet(tag, who) + amount); }

function setup(): Kpred {
  MockVM.reset();
  MockVM.setContractId(CONTRACT);
  MockVM.setContractArguments(CONTRACT);
  MockVM.setEntryPoint(0);
  MockVM.setCaller(new chain.caller_data(new Uint8Array(0), chain.privilege.user_mode));
  MockVM.setContractMetadata(new chain.contract_metadata_object(new Uint8Array(0), false, false, false, false));
  MockVM.setHeadInfo(new chain.head_info(null, 0, 1));
  at(100);
  const k = new Kpred();
  const i = new kpred.init_arguments(OWNER, OPERATOR, SEED, GENESIS * MS, WEEK * MS, 10 * MS, 100 * MS, 50 * MS, VHP, VHP);
  k.init(i);
  // wallets
  for (let n = 0; n < 5; n++) {
    const who = n == 0 ? A : n == 1 ? B : n == 2 ? C : n == 3 ? D : E;
    give(VHP_TAG, who, 1000 * VHP);
    give(KOIN_TAG, who, 1000 * VHP);
    give(MANA_TAG, who, 1000 * VHP);
  }
  give(VHP_TAG, SEED, 5000 * VHP);
  give(KOIN_TAG, SEED, 500 * VHP);
  give(MANA_TAG, SEED, 500 * VHP);
  return k;
}

function deposit(k: Kpred, who: Uint8Array, amount: u64): void {
  as(who);
  k.deposit_vhp(new kpred.deposit_vhp_arguments(who, amount));
}
function post(k: Kpred, kk: u32, lock: u64, ws: u64, we: u64): u32 {
  as(OPERATOR);
  return k.post_question(new kpred.post_question_arguments(kk, lock * MS, ws, we, hash32(7))).id;
}
function answer(k: Kpred, who: Uint8Array, id: u32, option: u32): void {
  as(who);
  k.answer(new kpred.answer_arguments(who, id, option));
}
function resolve(k: Kpred, id: u32, outcome: u32): void {
  as(OPERATOR);
  k.resolve_question(new kpred.resolve_question_arguments(id, outcome, hash32(9)));
}

// Globals used inside expect(() => ...).toThrow() (AssemblyScript closures cannot capture locals).
let gK: Kpred | null = null;
let gWho: Uint8Array = new Uint8Array(0);
let gQ: u32 = 0;
let gId: u32 = 0;
let gOpt: u32 = 0;
let gAmt: u64 = 0;

// ───────────── authorize: what the contract will pay for ─────────────
function setTx(entry: u32, args: Uint8Array, rcLimit: u64, nOps: i32): void {
  const tx = new protocol.transaction();
  tx.header = new protocol.transaction_header();
  tx.header!.rc_limit = rcLimit;
  for (let i = 0; i < nOps; i++) {
    const op = new protocol.operation();
    op.call_contract = new protocol.call_contract_operation(CONTRACT, entry, args);
    tx.operations.push(op);
  }
  MockVM.setTransaction(tx);
  System.resetCache();
}
function sponsor(k: Kpred): bool {
  return k.authorize(new authority.authorize_arguments(authority.authorization_type.transaction_application)).value;
}
function uploadTx(code: Uint8Array): void {
  const tx = new protocol.transaction();
  tx.header = new protocol.transaction_header();
  const op = new protocol.operation();
  op.upload_contract = new protocol.upload_contract_operation(CONTRACT, code, "", true, true, true);
  tx.operations.push(op);
  MockVM.setTransaction(tx);
  System.resetCache();
}
const DAY_MS: u64 = 86_400_000;
const EXPIRY_BLOCKS: u64 = 7 * DAY_MS / MS;          // 216,000 simulated blocks

/** Week w (0-based): two questions posted at its start, answered, resolved on time; then the week closes. Each player
 *  answers both questions with option `opts[i]` (1 = right, 0 = wrong) for question 0 and 1. */
function playWeek(k: Kpred, w: u64, who: Uint8Array[], right0: bool[], right1: bool[]): void {
  const base = GENESIS + w * WEEK;
  at(base + 100);
  const q0 = post(k, 2, base + 300, base + 301, base + 400);
  const q1 = post(k, 2, base + 300, base + 301, base + 400);
  at(base + 200);
  for (let i = 0; i < who.length; i++) {
    answer(k, who[i], q0, right0[i] ? 1 : 0);
    answer(k, who[i], q1, right1[i] ? 1 : 0);
  }
  at(base + 500); resolve(k, q0, 1); resolve(k, q1, 1);
  at(base + WEEK + 10);
  nobody();
  k.close_week(new kpred.close_week_arguments(w));
}


// ───────────── THIEF2-SETTLE ─────────────
const EP_SETTLE: u32 = 0x6868e83d;
function settleTx(who: Uint8Array, w: u64): void {
  setTx(EP_SETTLE, Protobuf.encode(new kpred.settle_arguments(who, w), kpred.settle_arguments.encode), VHP / 2, 1);
}

/** A and B stake 10 VHP each (active in week 0) and answer both week-0 questions; A then withdraws everything during
 *  week 0 (entry voided). Questions resolved; the time is left just before week 0's close. */
function voidedA(): Kpred {
  const k = setup();
  deposit(k, A, 10 * VHP);
  deposit(k, B, 10 * VHP);
  at(1100);
  const q0 = post(k, 2, 1300, 1301, 1400), q1 = post(k, 2, 1300, 1301, 1400);
  at(1200);
  answer(k, A, q0, 1); answer(k, A, q1, 1);
  answer(k, B, q0, 1); answer(k, B, q1, 1);
  at(1250);
  as(A);
  k.withdraw(new kpred.withdraw_arguments(A, 10 * VHP));
  at(1500); resolve(k, q0, 1); resolve(k, q1, 1);
  return k;
}

describe("REDTEAM thief (fix check 2): the settle sponsorship voided check", () => {
  // Attack (cheap bypass): settle the voided entry through the "week due but not closed yet" branch, where the settle
  // call itself would close the week. Safe: still refused.
  it("THIEF2-SETTLE-1 (blocked) a voided entry is not sponsored through the close-then-settle branch either", () => {
    const k = voidedA();
    at(2010);                                         // week 0 is due, nobody has closed it
    nobody();
    expect(k.totals.get()!.weeks_closed).toBe(0);
    settleTx(B, 0);
    expect(sponsor(k)).toBe(true);                    // (control) B's settle would close the week and settle: paid
    settleTx(A, 0);
    expect(sponsor(k)).toBe(false, "THIEF2-SETTLE-1: the pool paid for a voided entry's settle via the close-due branch");
  });

  // Legitimate use: a player who withdraws everything in the NEXT week (before last week is closed) must still get the
  // finished week settled for free. Safe: sponsored, and the settle makes them eligible.
  it("THIEF2-SETTLE-2 (legit) withdrawing all in week 1 does not void, or lose the sponsored settle of, week 0", () => {
    const k = voidedA();
    at(2005);                                         // week 1 has started; week 0 closes at 2010
    as(B);
    k.withdraw(new kpred.withdraw_arguments(B, 10 * VHP));
    expect(k.entries.get(k.entryKey(B, 0))!.voided).toBe(false);
    at(2010);
    nobody();
    k.close_week(new kpred.close_week_arguments(0));
    settleTx(B, 0);
    expect(sponsor(k)).toBe(true, "THIEF2-SETTLE-2: an honest week-0 entry lost its sponsored settle because its player left in week 1");
    expect(k.settle(new kpred.settle_arguments(B, 0)).eligible).toBe(true);
  });

  // Legitimate use: a partial withdrawal that keeps at least min_stake keeps the sponsored settle. Safe: sponsored.
  it("THIEF2-SETTLE-3 (legit) a partial withdrawal down to exactly min_stake keeps the sponsored settle", () => {
    const k = voidedA();
    at(1300);
    as(B);
    k.withdraw(new kpred.withdraw_arguments(B, 9 * VHP));   // 1 VHP left = min_stake
    expect(k.entries.get(k.entryKey(B, 0))!.stake).toBe(VHP);
    at(2010);
    nobody();
    k.close_week(new kpred.close_week_arguments(0));
    settleTx(B, 0);
    expect(sponsor(k)).toBe(true, "THIEF2-SETTLE-3: a stake of exactly min_stake after a partial withdrawal lost its sponsored settle");
    settleTx(A, 0);
    expect(sponsor(k)).toBe(false);
  });
});

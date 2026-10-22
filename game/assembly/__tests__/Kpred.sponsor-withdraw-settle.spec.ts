// Proof test (audit fix check, AB-026): no sponsored settle for an entry whose player withdrew the whole stake that
// week (the entry is voided). IMP-WD-2 is a guard (it held before).
// Harness: game/assembly/__tests__/Kpred.v4.spec.ts lines 1-138, copied unchanged.
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

// ───────────── IMP-WD ─────────────
const EP_ANSWER: u32 = 0x0db52f40;
const EP_SETTLE: u32 = 0x6868e83d;
function ansTx(who: Uint8Array, id: u32, opt: u32): void {
  setTx(EP_ANSWER, Protobuf.encode(new kpred.answer_arguments(who, id, opt), kpred.answer_arguments.encode), VHP / 2, 1);
}
function settleTx(who: Uint8Array, w: u64): void {
  setTx(EP_SETTLE, Protobuf.encode(new kpred.settle_arguments(who, w), kpred.settle_arguments.encode), VHP / 2, 1);
}

describe("REDTEAM impersonator: what a withdrawal does to sponsorship", () => {
  it("IMP-WD-1 a player who withdrew their whole stake during the week gets no sponsored settle for it", () => {
    const k = setup();
    deposit(k, A, 10 * VHP);                          // before genesis: active in week 0
    deposit(k, B, 10 * VHP);
    at(1100);
    const q0 = post(k, 2, 1300, 1301, 1400), q1 = post(k, 2, 1300, 1301, 1400);
    at(1200);
    answer(k, A, q0, 1); answer(k, A, q1, 1);
    answer(k, B, q0, 1); answer(k, B, q1, 1);
    at(1250);
    as(A);
    k.withdraw(new kpred.withdraw_arguments(A, 10 * VHP));   // everything back: A is out of week 0
    expect(k.entries.get(k.entryKey(A, 0))!.voided).toBe(true);
    at(1500); resolve(k, q0, 1); resolve(k, q1, 1);
    at(2010);
    nobody();
    k.close_week(new kpred.close_week_arguments(0));
    settleTx(B, 0);
    expect(sponsor(k)).toBe(true);                    // (control) B still has a stake: sponsored
    settleTx(A, 0);
    expect(sponsor(k)).toBe(false, "IMP-WD-1: the pool paid for the settle of a player who had withdrawn everything (entry voided, stake 0)");
  });

  it("IMP-WD-2 (holds) withdrawing all stops sponsored answers; withdrawing below min_stake stops answers and settle", () => {
    const k = setup();
    deposit(k, A, 2 * VHP);
    deposit(k, D, 10 * VHP);
    at(1100);
    const q0 = post(k, 2, 1300, 1301, 1400), q1 = post(k, 2, 1300, 1301, 1400);
    at(1200);
    // D takes everything back before answering, then deposits again in the same week
    as(D);
    k.withdraw(new kpred.withdraw_arguments(D, 10 * VHP));
    ansTx(D, q0, 1);
    expect(sponsor(k)).toBe(false, "IMP-WD-2: sponsored answer after withdrawing the whole stake");
    deposit(k, D, 10 * VHP);
    as(D);
    ansTx(D, q0, 1);
    expect(sponsor(k)).toBe(false, "IMP-WD-2: sponsored answer after withdrawing all and depositing again in the same week");
    // A answers once, then takes 1.5 of 2 VHP back: 0.5 VHP < min_stake (1 VHP)
    answer(k, A, q0, 1);
    as(A);
    k.withdraw(new kpred.withdraw_arguments(A, 150_000_000));
    ansTx(A, q1, 1);
    expect(sponsor(k)).toBe(false, "IMP-WD-2: sponsored answer with a stake lowered below min_stake");
    answer(k, A, q1, 1);                              // free play is still allowed, on A's own Mana
    at(1500); resolve(k, q0, 1); resolve(k, q1, 1);
    at(2010);
    nobody();
    k.close_week(new kpred.close_week_arguments(0));
    settleTx(A, 0);
    expect(sponsor(k)).toBe(false, "IMP-WD-2: sponsored settle with a stake lowered below min_stake");
  });
});

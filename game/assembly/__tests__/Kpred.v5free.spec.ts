/**
 * v5 rules (2026-10): reward split, 30-question weeks, seed handover, notice for minimum-stake changes, owner change
 * clears an announced upgrade, one signature per sponsored transaction. MockVM; in-contract test ledger. Run: npm test
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


// ═════════════ Audit (v5 report) attack tests ═════════════
const ALL: Uint8Array[] = [A, B, C, D, E, P6, P7, P8, P9, P10];
function fundAll(): void {
  for (let i = 5; i < ALL.length; i++) { give(VHP_TAG, ALL[i], 1000 * VHP); give(KOIN_TAG, ALL[i], 1000 * VHP); give(MANA_TAG, ALL[i], 1000 * VHP); }
}
/** Week 0 with `nq` questions (correct option 1). right[p][i]: player p answers question i right. */
let gLateWho: Uint8Array = new Uint8Array(0);
let gLateAmt: u64 = 0;
function playW0(k: Kpred, who: Uint8Array[], right: bool[][], nq: i32): void {
  give(KOIN_TAG, CONTRACT, 100 * VHP); give(MANA_TAG, CONTRACT, 1000 * VHP);
  at(GENESIS + 100);
  const qs: u32[] = [];
  for (let i = 0; i < nq; i++) qs.push(post(k, 2, GENESIS + 300, GENESIS + 301, GENESIS + 400));
  at(GENESIS + 200);
  for (let p = 0; p < who.length; p++) for (let i = 0; i < nq; i++) answer(k, who[p], qs[i], right[p][i] ? 1 : 0);
  at(GENESIS + 500);
  for (let i = 0; i < nq; i++) resolve(k, qs[i], 1);
  at(GENESIS + 900);
  if (gLateAmt > 0) { as(gLateWho); k.withdraw(new kpred.withdraw_arguments(gLateWho, gLateAmt)); gLateAmt = 0; }
  at(GENESIS + WEEK + 10);
  nobody();
  k.close_week(new kpred.close_week_arguments(0));
  for (let p = 0; p < who.length; p++) k.settle(new kpred.settle_arguments(who[p], 0));
  at(GENESIS + WEEK + 200);
  k.finalize_week(new kpred.finalize_week_arguments(0));
}

describe("AUDIT V5-1: the free prize when no staked player wins", () => {
  it("the 2 best free players are paid even if every staked player scored 0 (site: 'each week the 2 best free players win 1 VHP each')", () => {
    const k = setup();
    deposit(k, A, 10 * VHP);
    deposit(k, B, 10 * VHP);
    playW0(k, [A, B, C, D], [[false, false], [false, false], [true, true], [true, false]], 2);
    const wk = k.get_week(new kpred.get_week_arguments(0)).week!;
    expect(wk.free_best).toBe(2);
    expect(wk.free_second).toBe(1);
    gK = k; gWho = C;
    as(C);
    MockVM.commitTransaction();
    // Fixed (v5, audit M-2): the free prize is paid even when the rest of the pot rolls over.
    expect(() => { gK!.claim(new kpred.claim_arguments(gWho, 0)); }).not.toThrow();
    expect(wk.rolled_over).toBe(true);
    const t = k.get_state(new kpred.get_state_arguments()).totals!;
    // what stays owed is exactly the free prize still to be claimed (D's half): C took pot_free / 2
    expect(t.pots_outstanding).toBe(wk.pot_free - wk.pot_free / 2);
    as(D);
    expect(k.claim(new kpred.claim_arguments(D, 0)).reward).toBe(wk.pot_free - wk.pot_free / 2);
    expect(k.get_state(new kpred.get_state_arguments()).totals!.pots_outstanding).toBe(0);
  });
});

describe("AUDIT V5-2: a staked player can drop below the minimum late in the week and take the free prize", () => {
  it("a player who was staked when the week started is not a 'free (unstaked) player'", () => {
    const k = setup();
    deposit(k, A, 10 * VHP);
    deposit(k, B, 10 * VHP);
    deposit(k, D, 10 * VHP);
    // A (staked) is best overall; C is the only true free player. Near the end of the week, with the results posted,
    // A withdraws down to 0.5 VHP (below the 1 VHP minimum).
    gLateWho = A; gLateAmt = 10 * VHP - VHP / 2;
    playW0(k, [A, B, D, C], [[true, true, true], [true, true, true], [true, true, true], [true, true, false]], 3);
    const wk = k.get_week(new kpred.get_week_arguments(0)).week!;
    // Fixed (v5, audit L-4): A was staked at the start of the week, so A is not a free player and can't claim.
    gK = k; gWho = A;
    as(A);
    MockVM.commitTransaction();
    expect(() => { gK!.claim(new kpred.claim_arguments(gWho, 0)); }).toThrow();
    expect(MockVM.getErrorMessage()).toBe("not eligible that week");
    expect(k.get_player(new kpred.get_player_arguments(A, 0)).entry!.free_player).toBe(false);
    as(C);
    const rc = k.claim(new kpred.claim_arguments(C, 0)).reward;
    expect(rc).toBe(1 * VHP);
    expect(wk.free_best_n).toBe(1);
  });
});


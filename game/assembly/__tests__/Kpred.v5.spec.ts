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


describe("v5: the 40/60 reward split starts with the week after the upgrade", () => {
  it("a contract upgraded during week 0 pays week 0 by the old split and week 1 by 40% capped / 60% stake", () => {
    const k = setup();
    const c = k.config.get()!;
    c.scorer_rule_week_plus_one = 0;                 // as stored by v3 (both rules start together)
    c.reward_rule_week_plus_one = 0;
    k.config.put(c);
    as(SEED);
    k.seed_deposit_vhp(new kpred.seed_deposit_vhp_arguments(1000 * VHP));
    deposit(k, A, 100 * VHP);
    deposit(k, B, 5 * VHP);
    expect(k.get_state(new kpred.get_state_arguments()).config!.reward_rule_week_plus_one).toBe(2);
    const who: Uint8Array[] = [A, B];
    give(KOIN_TAG, CONTRACT, 100 * VHP); give(MANA_TAG, CONTRACT, 1000 * VHP);
    playWeek(k, 0, who, [true, true], [true, true]);
    const w0 = k.get_week(new kpred.get_week_arguments(0)).week!;
    expect(w0.reward_rule).toBe(false);
    expect(w0.pot_a == w0.pot * 4000 / 10000).toBe(false);
    give(KOIN_TAG, CONTRACT, 100 * VHP);
    for (let i = 0; i < who.length; i++) k.settle(new kpred.settle_arguments(who[i], 0));
    playWeek(k, 1, who, [true, true], [true, true]);
    const w1 = k.get_week(new kpred.get_week_arguments(1)).week!;
    expect(w1.reward_rule).toBe(true);
    expect(w1.pot_a).toBe((w1.pot - w1.pot_free) * 4000 / 10000);
    nobody();
    for (let i = 0; i < who.length; i++) k.settle(new kpred.settle_arguments(who[i], 1));
    at(3200);
    for (let w: u64 = 0; w < 2; w++) if (!k.get_week(new kpred.get_week_arguments(w)).week!.finalized) k.finalize_week(new kpred.finalize_week_arguments(w));
    // week 1: both tied (2 points); A has 100 VHP (counts 10 in basket A), B 5. A gets 10/15 of A, 100/105 of B.
    const f1 = k.get_week(new kpred.get_week_arguments(1)).week!;   // after finalizing: the unused free prize is in basket B
    expect(f1.pot_free).toBe(0);
    expect(f1.pot_a + f1.pot_b).toBe(f1.pot);
    as(A); const ra = k.claim(new kpred.claim_arguments(A, 1)).reward;
    as(B); const rb = k.claim(new kpred.claim_arguments(B, 1)).reward;
    expect(near(ra, f1.pot_a * 10 / 15 + f1.pot_b * 100 / 105)).toBe(true);
    expect(near(rb, f1.pot_a * 5 / 15 + f1.pot_b * 5 / 105)).toBe(true);
  });
});

describe("v5: the seed changes hands in two steps", () => {
  it("only the seed owner proposes; the new one accepts a day later; a pending withdrawal is cancelled", () => {
    const k = setup();
    as(SEED);
    k.seed_deposit_vhp(new kpred.seed_deposit_vhp_arguments(100 * VHP));
    k.request_seed_withdrawal(new kpred.request_seed_withdrawal_arguments(50 * VHP, 0));
    gK = k;
    as(OWNER);
    MockVM.commitTransaction();
    expect(() => { gK!.propose_seed_owner(new kpred.propose_seed_owner_arguments(B)); }).toThrow();
    as(SEED);
    k.propose_seed_owner(new kpred.propose_seed_owner_arguments(B));
    as(B);
    MockVM.commitTransaction();
    expect(() => { gK!.accept_seed_owner(new kpred.accept_seed_owner_arguments()); }).toThrow();
    expect(MockVM.getErrorMessage()).toBe("the seed can be accepted only 28,800 blocks (about a day) after it was proposed");
    at(100 + 28_800);
    as(C);
    MockVM.commitTransaction();
    expect(() => { gK!.accept_seed_owner(new kpred.accept_seed_owner_arguments()); }).toThrow();
    as(B);
    k.accept_seed_owner(new kpred.accept_seed_owner_arguments());
    const s = k.get_state(new kpred.get_state_arguments());
    expect(Base58.encode(s.config!.seed_owner!)).toBe(Base58.encode(B));
    expect(s.seed_withdrawal!.eta).toBe(0);           // the old owner's request is gone
    // the old seed owner can no longer request anything
    as(SEED);
    MockVM.commitTransaction();
    expect(() => { gK!.request_seed_withdrawal(new kpred.request_seed_withdrawal_arguments(10 * VHP, 0)); }).toThrow();
    as(B);
    k.request_seed_withdrawal(new kpred.request_seed_withdrawal_arguments(10 * VHP, 0));
  });
});

describe("v5: an owner change clears an announced upgrade", () => {
  it("the new owner starts with no upgrade announced", () => {
    const k = setup();
    as(OWNER);
    k.schedule_upgrade(new kpred.schedule_upgrade_arguments(hash32(3)));
    expect(k.get_state(new kpred.get_state_arguments()).upgrade!.eta > 0).toBe(true);
    k.propose_owner(new kpred.propose_owner_arguments(B));
    at(100 + 28_800);
    as(B);
    k.accept_owner(new kpred.accept_owner_arguments());
    expect(k.get_state(new kpred.get_state_arguments()).upgrade!.eta).toBe(0);
  });
});

describe("v5: a minimum-stake change gets at least 48 hours' notice (audit M-4)", () => {
  it("made long before the next week: from next week; made less than a timelock before it: from the week after", () => {
    const k = setup();
    // timelock 50 blocks; week 0 runs 1000–2000
    at(1100);
    as(OWNER);
    expect(k.set_min_stake(new kpred.set_min_stake_arguments(2 * VHP)).from_week).toBe(1);
    const k2 = setup();
    at(1970);                                         // 30 blocks before week 1: too short
    as(OWNER);
    expect(k2.set_min_stake(new kpred.set_min_stake_arguments(3 * VHP)).from_week).toBe(2);
  });
});

describe("v5: one signature per sponsored transaction (audit M-3)", () => {
  it("a sponsored answer padded with a second signature is refused", () => {
    const k = setup();
    deposit(k, A, 10 * VHP);
    at(1100);
    const q = post(k, 2, 1300, 1301, 1400);
    at(1200);
    as(A);
    const args = Protobuf.encode(new kpred.answer_arguments(A, q, 1), kpred.answer_arguments.encode);
    setTx(0x0db52f40, args, VHP, 1);
    expect(sponsor(k)).toBe(true);
    const tx = new protocol.transaction();
    tx.header = new protocol.transaction_header();
    tx.header!.rc_limit = VHP;
    const op = new protocol.operation();
    op.call_contract = new protocol.call_contract_operation(CONTRACT, 0x0db52f40, args);
    tx.operations.push(op);
    tx.signatures.push(new Uint8Array(65));
    tx.signatures.push(new Uint8Array(65));
    MockVM.setTransaction(tx);
    System.resetCache();
    expect(sponsor(k)).toBe(false);
  });
});

describe("v5 review fixes", () => {
  it("a minimum-stake change promised for the coming week can't be overridden inside the notice time", () => {
    const k = setup();
    at(1100);
    as(OWNER);
    expect(k.set_min_stake(new kpred.set_min_stake_arguments(2 * VHP)).from_week).toBe(1);
    at(1970);                                         // 30 blocks (less than the 50-block timelock) before week 1
    gK = k;
    as(OWNER);
    MockVM.commitTransaction();
    expect(() => { gK!.set_min_stake(new kpred.set_min_stake_arguments(10 * VHP)); }).toThrow();
    expect(MockVM.getErrorMessage()).toBe("a minimum-stake change already takes effect within 48 hours: try again after it starts");
  });

  it("the seed can't be handed to the game contract itself", () => {
    const k = setup();
    gK = k;
    as(SEED);
    MockVM.commitTransaction();
    expect(() => { gK!.propose_seed_owner(new kpred.propose_seed_owner_arguments(CONTRACT)); }).toThrow();
  });
});

/** A v5 week with stakers A, B and free players C, D, E (answers: true = right). Returns the week after finalizing. */
function freeWeek(k: Kpred, right: bool[][]): kpred.week_object {
  deposit(k, A, 10 * VHP);
  deposit(k, B, 10 * VHP);
  const who: Uint8Array[] = [A, B, C, D, E];
  give(KOIN_TAG, CONTRACT, 100 * VHP); give(MANA_TAG, CONTRACT, 1000 * VHP);
  at(GENESIS + 100);
  const qs: u32[] = [];
  for (let i = 0; i < 3; i++) qs.push(post(k, 2, GENESIS + 300, GENESIS + 301, GENESIS + 400));
  at(GENESIS + 200);
  for (let p = 0; p < who.length; p++) for (let i = 0; i < 3; i++) answer(k, who[p], qs[i], right[p][i] ? 1 : 0);
  at(GENESIS + 500);
  for (let i = 0; i < 3; i++) resolve(k, qs[i], 1);
  at(GENESIS + WEEK + 10);
  nobody();
  k.close_week(new kpred.close_week_arguments(0));
  for (let p = 0; p < who.length; p++) k.settle(new kpred.settle_arguments(who[p], 0));
  at(GENESIS + WEEK + 200);
  k.finalize_week(new kpred.finalize_week_arguments(0));
  return k.get_week(new kpred.get_week_arguments(0)).week!;
}

describe("v5: the 2 best free players share up to 2 VHP of the pot", () => {
  it("2 VHP come off the pot before the 40/60 split; best and second free players get 1 VHP each", () => {
    const k = setup();
    const wk = freeWeek(k, [[true, true, true], [true, false, false], [true, true, true], [true, true, false], [true, false, false]]);
    expect(wk.pot_free).toBe(2 * VHP);
    expect(wk.pot_a).toBe((wk.pot - 2 * VHP) * 4000 / 10000);
    expect(wk.pot_a + wk.pot_b + wk.pot_free).toBe(wk.pot);
    as(C); expect(k.claim(new kpred.claim_arguments(C, 0)).reward).toBe(1 * VHP);   // free, 3 points: best
    as(D); expect(k.claim(new kpred.claim_arguments(D, 0)).reward).toBe(1 * VHP);   // free, 2 points: second
    gK = k; gWho = E;
    as(E);
    MockVM.commitTransaction();
    expect(() => { gK!.claim(new kpred.claim_arguments(gWho, 0)); }).toThrow();      // free, 1 point: third
    expect(MockVM.getErrorMessage()).toBe("not eligible that week");
    gWho = C;
    as(C);
    MockVM.commitTransaction();
    expect(() => { gK!.claim(new kpred.claim_arguments(gWho, 0)); }).toThrow();
    expect(MockVM.getErrorMessage()).toBe("already claimed");
  });

  it("ties share: three free players tied on top split the 2 VHP", () => {
    const k = setup();
    const wk = freeWeek(k, [[true, true, true], [true, false, false], [true, true, false], [true, true, false], [true, true, false]]);
    expect(wk.free_best).toBe(2);
    expect(wk.free_best_n).toBe(3);
    as(C); expect(k.claim(new kpred.claim_arguments(C, 0)).reward).toBe(2 * VHP / 3);
    as(D); expect(k.claim(new kpred.claim_arguments(D, 0)).reward).toBe(2 * VHP / 3);
    as(E); expect(k.claim(new kpred.claim_arguments(E, 0)).reward).toBe(2 * VHP / 3);
  });

  it("one free player scored: they get 1 VHP, the other goes to the stakers; none scored: all 2 VHP do", () => {
    const k = setup();
    const wk = freeWeek(k, [[true, true, true], [true, false, false], [true, false, true], [false, false, false], [false, false, false]]);
    expect(wk.pot_free).toBe(1 * VHP);
    as(C); expect(k.claim(new kpred.claim_arguments(C, 0)).reward).toBe(1 * VHP);
    const k2 = setup();
    const wk2 = freeWeek(k2, [[true, true, true], [true, false, false], [false, false, false], [false, false, false], [false, false, false]]);
    expect(wk2.pot_free).toBe(0);
    expect(wk2.pot_a + wk2.pot_b).toBe(wk2.pot);
    // the stakers' claims plus free prizes never exceed the pot
    as(A); const ra = k2.claim(new kpred.claim_arguments(A, 0)).reward;
    expect(ra <= wk2.pot).toBe(true);
  });

  it("the pool never pays the Mana for a free player's prize claim", () => {
    const k = setup();
    freeWeek(k, [[true, true, true], [true, false, false], [true, true, true], [true, true, false], [true, false, false]]);
    as(C);
    setTx(0xdd1b3c31, Protobuf.encode(new kpred.claim_arguments(C, 0), kpred.claim_arguments.encode), VHP, 1);
    expect(sponsor(k)).toBe(false);
  });
});

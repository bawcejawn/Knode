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

describe("v4: the minimum stake can change, never to 0 and never for the week being played", () => {
  it("owner only, never 0, applies from next week; eligibility uses each week's own value", () => {
    const k = setup();
    deposit(k, A, 1 * VHP);
    deposit(k, B, 2 * VHP);
    gK = k;
    at(1100);
    as(A);
    MockVM.commitTransaction();
    expect(() => { gK!.set_min_stake(new kpred.set_min_stake_arguments(2 * VHP)); }).toThrow();
    expect(MockVM.getErrorMessage()).toBe("owner only");
    as(OWNER);
    MockVM.commitTransaction();
    expect(() => { gK!.set_min_stake(new kpred.set_min_stake_arguments(0)); }).toThrow();
    expect(MockVM.getErrorMessage()).toBe("the minimum stake can never be 0");
    expect(k.set_min_stake(new kpred.set_min_stake_arguments(2 * VHP)).from_week).toBe(1);
    const c = k.get_state(new kpred.get_state_arguments()).config!;
    expect(c.min_stake).toBe(VHP);                   // week 0 keeps 1 VHP
    expect(c.min_stake_next).toBe(2 * VHP);
    expect(c.min_stake_next_week).toBe(1);

    playWeek(k, 0, [A, B], [true, true], [true, true]);
    expect(k.settle(new kpred.settle_arguments(A, 0)).eligible).toBe(true);    // 1 VHP was enough in week 0
    expect(k.settle(new kpred.settle_arguments(B, 0)).eligible).toBe(true);

    // During week 1 (week 0 not finalized yet) a further change would need a third value: refused for now.
    at(2100);
    as(OWNER);
    MockVM.commitTransaction();
    expect(() => { gK!.set_min_stake(new kpred.set_min_stake_arguments(3 * VHP)); }).toThrow();
    expect(MockVM.getErrorMessage()).toBe("the previous change still decides week 0's results: try again after that week is finalized");

    playWeek(k, 1, [A, B], [true, true], [true, true]);  // week 0 finalizes on the way
    expect(k.get_state(new kpred.get_state_arguments()).totals!.weeks_finalized).toBe(1);
    expect(k.settle(new kpred.settle_arguments(A, 1)).eligible).toBe(false);   // 1 VHP < 2 VHP from week 1
    expect(k.settle(new kpred.settle_arguments(B, 1)).eligible).toBe(true);    // exactly the minimum counts

    // Now week 0 is final: the next change folds the old one in and applies from week 3 (we are in week 2).
    at(3050);
    as(OWNER);
    expect(k.set_min_stake(new kpred.set_min_stake_arguments(3 * VHP)).from_week).toBe(3);
    const c2 = k.get_state(new kpred.get_state_arguments()).config!;
    expect(c2.min_stake).toBe(2 * VHP);
    expect(c2.min_stake_next).toBe(3 * VHP);
    expect(c2.min_stake_next_week).toBe(3);
  });

  it("init refuses min_stake 0", () => {
    MockVM.reset();
    MockVM.setContractId(CONTRACT);
    MockVM.setContractArguments(CONTRACT);
    MockVM.setEntryPoint(0);
    MockVM.setCaller(new chain.caller_data(new Uint8Array(0), chain.privilege.user_mode));
    MockVM.setContractMetadata(new chain.contract_metadata_object(new Uint8Array(0), false, false, false, false));
    MockVM.setHeadInfo(new chain.head_info(null, 0, 1));
    at(100);
    gK = new Kpred();
    MockVM.commitTransaction();
    expect(() => {
      gK!.init(new kpred.init_arguments(OWNER, OPERATOR, SEED, GENESIS * MS, WEEK * MS, 10 * MS, 100 * MS, 50 * MS, 0, VHP));
    }).toThrow();
    expect(MockVM.getErrorMessage()).toBe("min_stake must be positive");
  });
});

describe("v4: winners are the top 30% of players WITH POINTS, from the week after the upgrade", () => {
  it("a contract upgraded during week 0 keeps the old headcount for week 0 and uses the new one from week 1", () => {
    const k = setup();
    const c = k.config.get()!;
    c.scorer_rule_week_plus_one = 0;                 // as stored by v3
    k.config.put(c);
    give(VHP_TAG, P6, 100 * VHP);
    give(MANA_TAG, P6, 100 * VHP);
    const who: Uint8Array[] = [A, B, C, D, E, P6];
    for (let i = 0; i < who.length; i++) deposit(k, who[i], 1 * VHP);   // before genesis: counts from week 0
    expect(k.get_state(new kpred.get_state_arguments()).config!.scorer_rule_week_plus_one).toBe(2); // set by the first action
    // week 0: A 2 points, B 1, four players 0 → old rule: 30% of 6 eligible = 2 places → cutoff 1, A and B win
    playWeek(k, 0, who, [true, true, false, false, false, false], [true, false, false, false, false, false]);
    for (let i = 0; i < who.length; i++) k.settle(new kpred.settle_arguments(who[i], 0));
    at(2200);
    const f0 = k.finalize_week(new kpred.finalize_week_arguments(0));
    expect(f0.winners).toBe(2);
    expect(f0.cutoff).toBe(1);
    // week 1, same answers → new rule: 30% of the 2 players with points = 1 place → only A wins
    playWeek(k, 1, who, [true, true, false, false, false, false], [true, false, false, false, false, false]);
    nobody();
    for (let i = 0; i < who.length; i++) k.settle(new kpred.settle_arguments(who[i], 1));
    at(3200);
    const f1 = k.finalize_week(new kpred.finalize_week_arguments(1));
    expect(f1.winners).toBe(1);
    expect(f1.cutoff).toBe(2);
  });
});

/** One week with A 3 points, B 3, C 2, D 1, E 0, finalized with `page` places per transaction. */
function pagedWeek(page: u32): Kpred {
  const k = setup();
  as(SEED);
  k.seed_deposit_vhp(new kpred.seed_deposit_vhp_arguments(1000 * VHP));
  const who: Uint8Array[] = [A, B, C, D, E];
  deposit(k, A, 100 * VHP); deposit(k, B, 50 * VHP); deposit(k, C, 30 * VHP); deposit(k, D, 20 * VHP); deposit(k, E, 10 * VHP);
  at(1100);
  const q0 = post(k, 2, 1300, 1301, 1400), q1 = post(k, 2, 1300, 1301, 1400), q2 = post(k, 2, 1300, 1301, 1400);
  at(1200);
  const pts: u32[] = [3, 3, 2, 1, 0];
  for (let i = 0; i < who.length; i++) {
    answer(k, who[i], q0, pts[i] >= 1 ? 1 : 0);
    answer(k, who[i], q1, pts[i] >= 2 ? 1 : 0);
    answer(k, who[i], q2, pts[i] >= 3 ? 1 : 0);
  }
  at(1500); resolve(k, q0, 1); resolve(k, q1, 1); resolve(k, q2, 1);
  give(VHP_TAG, CONTRACT, 100 * VHP);
  at(2010);
  nobody();
  k.close_week(new kpred.close_week_arguments(0));
  for (let i = 0; i < who.length; i++) k.settle(new kpred.settle_arguments(who[i], 0));
  testSetFinalizePage(page);
  return k;
}

describe("v4: finalization is paged, so no transaction loops over every winner", () => {
  it("one place per transaction gives exactly the same result as all at once; claims wait for the last page", () => {
    const one = pagedWeek(500);                       // (each run starts a fresh simulated chain)
    at(2400);
    const f = one.finalize_week(new kpred.finalize_week_arguments(0));
    expect(f.done).toBe(true);
    const whole = one.get_week(new kpred.get_week_arguments(0)).week!;

    const k = pagedWeek(1);
    at(2400);
    // 4 players with points → 2 places: A and B tie on 3 points. Page 1 sets the cutoff and gives out place 1.
    const p1 = k.finalize_week(new kpred.finalize_week_arguments(0));
    expect(p1.done).toBe(false);
    expect(p1.cutoff).toBe(3);
    expect(k.get_week(new kpred.get_week_arguments(0)).week!.finalized).toBe(false);
    as(A);
    setTx(0xdd1b3c31, Protobuf.encode(new kpred.claim_arguments(A, 0), kpred.claim_arguments.encode), VHP / 2, 1);
    expect(sponsor(k)).toBe(false);                   // the pool never pays for a claim before the week is final
    nobody();
    k.compound(new kpred.compound_arguments());       // any action runs the next page: place 2, the last one
    const paged = k.get_week(new kpred.get_week_arguments(0)).week!;
    expect(paged.finalized).toBe(true);
    expect(paged.winners).toBe(2);
    expect(paged.sum_w).toBe(whole.sum_w);
    expect(paged.bw_lo).toBe(whole.bw_lo);
    expect(paged.bw_hi).toBe(whole.bw_hi);
    expect(paged.cutoff).toBe(whole.cutoff);
    as(A);
    setTx(0xdd1b3c31, Protobuf.encode(new kpred.claim_arguments(A, 0), kpred.claim_arguments.encode), VHP / 2, 1);
    expect(sponsor(k)).toBe(true);                    // now it is valid
    expect(k.claim(new kpred.claim_arguments(A, 0)).reward > 0).toBe(true);
    testSetFinalizePage(500);
  });
});

describe("v4: corrections stay possible after every result, but never as a last-second surprise", () => {
  it("a change is allowed until a quarter of close_delay before the close, and restarts the correction time", () => {
    const k = setup();
    deposit(k, A, 10 * VHP);
    at(1100);
    const q0 = post(k, 2, 1300, 1301, 1400);
    const q1 = post(k, 2, 1300, 1301, 1400);
    at(1200);
    answer(k, A, q0, 1); answer(k, A, q1, 1);
    at(1500); resolve(k, q0, 1); resolve(k, q1, 1);
    gK = k; gQ = q0;
    // close at block 2010; close_delay = 10 blocks, so changes stop 2.5 blocks (7 s) before it
    at(2008);
    as(OWNER);
    MockVM.commitTransaction();
    expect(() => { gK!.correct_question(new kpred.correct_question_arguments(gQ, 0, hash32(4))); }).toThrow();
    expect(MockVM.getErrorMessage()).toBe("too close to the week's close to change a result (changes stop a quarter of close_delay before it)");
    at(2007);
    k.correct_question(new kpred.correct_question_arguments(q0, 0, hash32(4)));   // allowed; the close moves to 2017
    expect(k.get_week(new kpred.get_week_arguments(0)).week!.last_resolved_time).toBe(2007 * MS);
    at(2010);
    nobody();
    MockVM.commitTransaction();
    expect(() => { gK!.close_week(new kpred.close_week_arguments(0)); }).toThrow();
    expect(MockVM.getErrorMessage()).toBe("too early to close this week");
    at(2014);
    as(OWNER);
    k.correct_question(new kpred.correct_question_arguments(q0, 1, hash32(5)));   // changed back; close moves to 2024
    at(2022);
    MockVM.commitTransaction();
    expect(() => { gK!.correct_question(new kpred.correct_question_arguments(gQ, 0, hash32(4))); }).toThrow();
    at(2024);
    nobody();
    k.close_week(new kpred.close_week_arguments(0));
    expect(k.get_question(new kpred.get_question_arguments(q0)).question!.outcome).toBe(2);
  });
});

describe("v4: announcements expire 7 days after their timelock", () => {
  it("an upgrade is accepted until 7 days after the timelock, not after", () => {
    const k = setup();
    const code = new Uint8Array(100);
    code.fill(42);
    const mh = new Crypto.Multihash();
    mh.deserialize(System.hash(Crypto.multicodec.sha2_256, code)!);
    as(OWNER);
    const eta = k.schedule_upgrade(new kpred.schedule_upgrade_arguments(mh.digest)).eta;
    uploadTx(code);
    const up = new authority.authorize_arguments(authority.authorization_type.contract_upload);
    at(eta / MS + EXPIRY_BLOCKS - 1);
    expect(k.authorize(up).value).toBe(true);
    at(eta / MS + EXPIRY_BLOCKS);
    expect(k.authorize(up).value).toBe(false);
    // announcing it again starts a fresh notice
    const eta2 = k.schedule_upgrade(new kpred.schedule_upgrade_arguments(mh.digest)).eta;
    expect(k.authorize(up).value).toBe(false);
    at(eta2 / MS);
    expect(k.authorize(up).value).toBe(true);
  });

  it("a seed withdrawal can be carried out until 7 days after the timelock, not after", () => {
    const k = setup();
    as(SEED);
    k.seed_deposit_vhp(new kpred.seed_deposit_vhp_arguments(100 * VHP));
    const eta = k.request_seed_withdrawal(new kpred.request_seed_withdrawal_arguments(10 * VHP, 0)).eta;
    at(eta / MS + EXPIRY_BLOCKS - 1);
    expect(k.execute_seed_withdrawal(new kpred.execute_seed_withdrawal_arguments()).vhp).toBe(10 * VHP);
    const eta2 = k.request_seed_withdrawal(new kpred.request_seed_withdrawal_arguments(10 * VHP, 0)).eta;
    at(eta2 / MS + EXPIRY_BLOCKS);
    gK = k;
    MockVM.commitTransaction();
    expect(() => { gK!.execute_seed_withdrawal(new kpred.execute_seed_withdrawal_arguments()); }).toThrow();
    expect(MockVM.getErrorMessage()).toBe("this request expired (it must be carried out within 7 days after its timelock): request it again");
  });
});

describe("v4: answers stay open at least 1 hour (1/168 of a week)", () => {
  it("refuses a lock time one millisecond short of it", () => {
    const k = setup();
    at(1100);
    as(OPERATOR);
    const min = (WEEK * MS) / 168;
    gK = k;
    gAmt = 1100 * MS + min - 1;
    MockVM.commitTransaction();
    expect(() => { gK!.post_question(new kpred.post_question_arguments(2, gAmt, 1110, 1200, hash32(7))); }).toThrow();
    expect(MockVM.getErrorMessage()).toBe("answers must stay open for at least 1 hour (1/168 of a week)");
    k.post_question(new kpred.post_question_arguments(2, 1100 * MS + min, 1110, 1200, hash32(7)));
  });
});

describe("v4: sponsorship floor and settings", () => {
  it("rc_limit must be between the floor (default half the cap) and the cap; the owner can set the floor", () => {
    const k = setup();
    deposit(k, A, 10 * VHP);
    at(1100);
    const q = post(k, 2, 1300, 1301, 1400);
    const good = Protobuf.encode(new kpred.answer_arguments(A, q, 1), kpred.answer_arguments.encode);
    as(A);
    setTx(0x0db52f40, good, VHP / 2, 1);
    expect(sponsor(k)).toBe(true);
    setTx(0x0db52f40, good, VHP / 2 - 1, 1);
    expect(sponsor(k)).toBe(false);
    as(OWNER);
    gK = k;
    MockVM.commitTransaction();
    expect(() => { gK!.set_sponsor_limit(new kpred.set_sponsor_limit_arguments(VHP, VHP + 1)); }).toThrow();
    expect(MockVM.getErrorMessage()).toBe("the smallest rc_limit cannot be above the largest");
    k.set_sponsor_limit(new kpred.set_sponsor_limit_arguments(VHP, VHP / 10));
    as(A);
    setTx(0x0db52f40, good, VHP / 10, 1);
    expect(sponsor(k)).toBe(true);
    setTx(0x0db52f40, good, VHP / 10 - 1, 1);
    expect(sponsor(k)).toBe(false);
    as(OWNER);
    k.set_sponsor_limit(new kpred.set_sponsor_limit_arguments(0, 0));      // off
    as(A);
    setTx(0x0db52f40, good, 0, 1);
    expect(sponsor(k)).toBe(false);
  });
});

// ═══════════ AB-019: tests that fail if the solvency check, the house-share fallback or the min_stake boundary change ═══════════
describe("v4 / AB-019: guards the mutation tests found unguarded", () => {
  it("the solvency check stops a payout that would leave holdings below what is owed", () => {
    const k = setup();
    as(SEED);
    k.seed_deposit_koin(new kpred.seed_deposit_koin_arguments(200 * VHP));
    deposit(k, A, 10 * VHP);
    deposit(k, B, 10 * VHP);
    at(1100);
    const q0 = post(k, 2, 1300, 1301, 1400), q1 = post(k, 2, 1300, 1301, 1400);
    at(1200);
    answer(k, A, q0, 1); answer(k, A, q1, 1);
    answer(k, B, q0, 0); answer(k, B, q1, 0);
    at(1500); resolve(k, q0, 1); resolve(k, q1, 1);
    give(VHP_TAG, CONTRACT, 100 * VHP);               // the week's earnings
    at(2010);
    nobody();
    k.close_week(new kpred.close_week_arguments(0));
    k.settle(new kpred.settle_arguments(A, 0));
    k.settle(new kpred.settle_arguments(B, 0));
    at(2200);
    k.finalize_week(new kpred.finalize_week_arguments(0));
    Tokens.testSet(KOIN_TAG, CONTRACT, 0);            // the seed's 200 KOIN went missing: holdings < liabilities
    as(A);
    gK = k;
    MockVM.commitTransaction();
    expect(() => { gK!.claim(new kpred.claim_arguments(A, 0)); }).toThrow();
    expect(MockVM.getErrorMessage()).toBe("solvency check failed: payout would exceed earned rewards");
  });

  it("with no production record yet, the house's share is house ÷ (house + stake)", () => {
    const k = setup();
    as(SEED);
    k.seed_deposit_vhp(new kpred.seed_deposit_vhp_arguments(1000 * VHP));
    deposit(k, A, 10 * VHP);
    give(VHP_TAG, CONTRACT, 10 * VHP);
    // As stored right after the v2 → v3 upgrade: no accumulators and no start time.
    const t = k.totals.get()!;
    t.acc_player_hi = 0; t.acc_player_lo = 0; t.acc_house_hi = 0; t.acc_house_lo = 0; t.acc_time = 0;
    k.totals.put(t);
    at(2010);
    nobody();
    k.close_week(new kpred.close_week_arguments(0));
    expect(k.get_week(new kpred.get_week_arguments(0)).week!.house_ppm).toBe(990099);   // 1000 / 1010
  });

  it("a stake of exactly min_stake is sponsored and eligible", () => {
    const k = setup();
    deposit(k, A, 1 * VHP);                           // exactly min_stake (1 VHP); the cap is 1 KOIN
    at(1100);
    const q0 = post(k, 2, 1300, 1301, 1400), q1 = post(k, 2, 1300, 1301, 1400);
    as(A);
    setTx(0x0db52f40, Protobuf.encode(new kpred.answer_arguments(A, q0, 1), kpred.answer_arguments.encode), VHP, 1);
    expect(sponsor(k)).toBe(true);
    at(1200);
    answer(k, A, q0, 1); answer(k, A, q1, 1);
    at(1500); resolve(k, q0, 1); resolve(k, q1, 1);
    at(2010);
    nobody();
    k.close_week(new kpred.close_week_arguments(0));
    setTx(0x6868e83d, Protobuf.encode(new kpred.settle_arguments(A, 0), kpred.settle_arguments.encode), VHP, 1);
    expect(sponsor(k)).toBe(true);
    expect(k.settle(new kpred.settle_arguments(A, 0)).eligible).toBe(true);
  });
});

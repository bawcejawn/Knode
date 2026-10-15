/**
 * Game contract tests on a simulated Koinos chain (MockVM). Token movements use the in-contract test ledger.
 * Run with: npm test
 */
import { Base58, MockVM, authority, chain, Protobuf, System, protocol, value, Crypto } from "@koinos/sdk-as";
import { Kpred } from "../Kpred";
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

const VHP: u64 = 100_000_000;
const KOIN_TAG: u8 = 1, VHP_TAG: u8 = 2, MANA_TAG: u8 = 3;
const GENESIS: u64 = 1000, WEEK: u64 = 1000;

// ───────────── harness ─────────────
function at(h: u64): void {
  MockVM.setBlock(new protocol.block(new Uint8Array(0), new protocol.block_header(new Uint8Array(0), h)));
  System.resetCache();
}
function as(acct: Uint8Array): void {
  MockVM.setAuthorities([new MockVM.MockAuthority(authority.authorization_type.contract_call, acct, true)]);
}
function nobody(): void { MockVM.setAuthorities([]); }
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
  const i = new kpred.init_arguments(OWNER, OPERATOR, SEED, GENESIS, WEEK, 10, 100, 50, VHP, VHP);
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
  return k.post_question(new kpred.post_question_arguments(kk, lock, ws, we, hash32(7))).id;
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
let gId: u32 = 0;
let gOpt: u32 = 0;
let gAmt: u64 = 0;

describe("setup", () => {
  it("initialises once with owner, operator and seed owner", () => {
    const k = setup();
    const s = k.get_state(new kpred.get_state_arguments());
    expect(Base58.encode(s.config!.owner!)).toBe(Base58.encode(OWNER));
    expect(s.config!.week_blocks).toBe(WEEK);
    gK = k;
    MockVM.commitTransaction();
    expect(() => {
      gK!.init(new kpred.init_arguments(A, A, A, 0, 10, 0, 10, 10, 1, 1));
    }).toThrow();
    expect(MockVM.getErrorMessage()).toBe("already initialised");
  });
});

describe("staking", () => {
  it("deposits before the game starts count from week 0; later deposits from the next week", () => {
    const k = setup();
    deposit(k, A, 100 * VHP);                       // height 100, before genesis 1000
    let p = k.get_player(new kpred.get_player_arguments(A, 0));
    expect(p.active_stake).toBe(100 * VHP);
    at(1500);                                       // week 0
    deposit(k, A, 50 * VHP);
    p = k.get_player(new kpred.get_player_arguments(A, 0));
    expect(p.active_stake).toBe(100 * VHP);          // still 100 in week 0
    p = k.get_player(new kpred.get_player_arguments(A, 1));
    expect(p.active_stake).toBe(150 * VHP);          // 150 from week 1
    expect(Tokens.testGet(VHP_TAG, CONTRACT)).toBe(150 * VHP);
    expect(k.get_state(new kpred.get_state_arguments()).totals!.total_stake).toBe(150 * VHP);
  });

  it("KOIN deposits are burned into the contract's VHP", () => {
    const k = setup();
    as(B);
    k.deposit_koin(new kpred.deposit_koin_arguments(B, 30 * VHP));
    expect(Tokens.testGet(VHP_TAG, CONTRACT)).toBe(30 * VHP);
    expect(Tokens.testGet(KOIN_TAG, CONTRACT)).toBe(0);
    expect(Tokens.testGet(KOIN_TAG, B)).toBe(970 * VHP);
  });

  it("nobody can deposit for someone else, and paused deposits are refused", () => {
    const k = setup();
    gK = k;
    as(B);                                          // B signs, but tries to deposit A's tokens
    MockVM.commitTransaction();
    expect(() => {
      gK!.deposit_vhp(new kpred.deposit_vhp_arguments(A, 10 * VHP));
    }).toThrow();
    as(OWNER);
    k.set_paused(new kpred.set_paused_arguments(true));
    as(A);
    MockVM.commitTransaction();
    expect(() => {
      gK!.deposit_vhp(new kpred.deposit_vhp_arguments(A, 10 * VHP));
    }).toThrow();
    expect(MockVM.getErrorMessage()).toBe("new deposits are paused");
  });

  it("withdraw returns VHP, takes pending first, and voids the week's answers", () => {
    const k = setup();
    deposit(k, A, 100 * VHP);
    at(1100);
    const q = post(k, 2, 1300, 1301, 1400);
    answer(k, A, q, 1);
    deposit(k, A, 20 * VHP);                         // pending (week 1)
    as(A);
    k.withdraw(new kpred.withdraw_arguments(A, 30 * VHP));
    const p = k.get_player(new kpred.get_player_arguments(A, 1));
    expect(p.player!.pending).toBe(0);               // 20 pending taken first
    expect(p.player!.stake).toBe(90 * VHP);          // then 10 from stake
    expect(p.entry == null).toBe(true);
    const e = k.get_player(new kpred.get_player_arguments(A, 0)).entry!;
    expect(e.voided).toBe(true);
    expect(Tokens.testGet(VHP_TAG, A)).toBe((1000 - 100 - 20 + 30) * VHP);
    // and no more answers this week
    const q2 = post(k, 2, 1300, 1301, 1400);
    gK = k; gId = q2;
    as(A);
    MockVM.commitTransaction();
    expect(() => { gK!.answer(new kpred.answer_arguments(A, gId, 0)); }).toThrow();
    expect(MockVM.getErrorMessage()).toBe("you withdrew this week, so this week's answers don't count");
  });

  it("cannot withdraw more than the stake or someone else's stake", () => {
    const k = setup();
    deposit(k, A, 10 * VHP);
    gK = k;
    as(A);
    MockVM.commitTransaction();
    expect(() => { gK!.withdraw(new kpred.withdraw_arguments(A, 11 * VHP)); }).toThrow();
    expect(MockVM.getErrorMessage()).toBe("more than your stake");
    as(B);
    MockVM.commitTransaction();
    expect(() => { gK!.withdraw(new kpred.withdraw_arguments(A, 1 * VHP)); }).toThrow();
  });
});

describe("questions and answers", () => {
  it("only the operator posts; rules on lock and window are enforced", () => {
    const k = setup();
    gK = k;
    at(1100);
    as(A);
    MockVM.commitTransaction();
    expect(() => { gK!.post_question(new kpred.post_question_arguments(2, 1300, 1301, 1400, hash32(1))); }).toThrow();
    as(OPERATOR);
    MockVM.commitTransaction();
    expect(() => { gK!.post_question(new kpred.post_question_arguments(2, 2100, 2101, 2200, hash32(1))); }).toThrow();
    expect(MockVM.getErrorMessage()).toBe("answers must close before the week ends");
    MockVM.commitTransaction();
    expect(() => { gK!.post_question(new kpred.post_question_arguments(2, 1300, 1200, 1400, hash32(1))); }).toThrow();
    expect(MockVM.getErrorMessage()).toBe("the window must start after answers close");
    expect(post(k, 4, 1300, 1301, 1400)).toBe(0);
    expect(post(k, 2, 1300, 1301, 1400)).toBe(1);
  });

  it("answers need a week-start stake, an open question, a valid option, and only once", () => {
    const k = setup();
    at(1100);
    deposit(k, A, 10 * VHP);                         // during week 0: counts from week 1
    const q = post(k, 4, 1300, 1301, 1400);
    gK = k; gId = q;
    as(A);
    MockVM.commitTransaction();
    expect(() => { gK!.answer(new kpred.answer_arguments(A, gId, 0)); }).toThrow();
    expect(MockVM.getErrorMessage()).toBe("stake at least the minimum (counts from the week after depositing) to answer");

    const k2 = setup();
    deposit(k2, B, 10 * VHP);
    at(1100);
    const q2 = post(k2, 4, 1300, 1301, 1400);
    gK = k2; gId = q2;
    as(B);
    MockVM.commitTransaction();
    expect(() => { gK!.answer(new kpred.answer_arguments(B, gId, 4)); }).toThrow();
    expect(MockVM.getErrorMessage()).toBe("no such option");
    answer(k2, B, q2, 3);
    MockVM.commitTransaction();
    expect(() => { gK!.answer(new kpred.answer_arguments(B, gId, 2)); }).toThrow();
    expect(MockVM.getErrorMessage()).toBe("already answered");
    at(1300);
    MockVM.commitTransaction();
    expect(() => { gK!.answer(new kpred.answer_arguments(B, gId, 1)); }).toThrow();
    expect(MockVM.getErrorMessage()).toBe("answers for this question are closed");
    // nobody can answer for someone else
    at(1200);
    const q3 = post(k2, 2, 1300, 1301, 1400);
    gId = q3;
    as(A);
    MockVM.commitTransaction();
    expect(() => { gK!.answer(new kpred.answer_arguments(B, gId, 1)); }).toThrow();
  });

  it("resolutions: operator only, after the window is final; owner may correct before the week closes", () => {
    const k = setup();
    at(1100);
    const q = post(k, 2, 1300, 1301, 1400);
    gK = k; gId = q;
    at(1450);                                        // window ended at 1400 but not yet final (+60)
    as(OPERATOR);
    MockVM.commitTransaction();
    expect(() => { gK!.resolve_question(new kpred.resolve_question_arguments(gId, 1, hash32(3))); }).toThrow();
    expect(MockVM.getErrorMessage()).toBe("the window's blocks are not final yet");
    at(1500);
    as(A);
    MockVM.commitTransaction();
    expect(() => { gK!.resolve_question(new kpred.resolve_question_arguments(gId, 1, hash32(3))); }).toThrow();
    resolve(k, q, 1);
    expect(k.get_question(new kpred.get_question_arguments(q)).question!.outcome).toBe(2);
    as(OPERATOR);
    MockVM.commitTransaction();
    expect(() => { gK!.resolve_question(new kpred.resolve_question_arguments(gId, 0, hash32(3))); }).toThrow();
    // operator cannot correct; owner can
    MockVM.commitTransaction();
    expect(() => { gK!.correct_question(new kpred.correct_question_arguments(gId, 0, hash32(4))); }).toThrow();
    as(OWNER);
    k.correct_question(new kpred.correct_question_arguments(q, 1000, hash32(4)));
    expect(k.get_question(new kpred.get_question_arguments(q)).question!.outcome).toBe(1000);
  });
});

describe("a full week", () => {
  it("measures the gain, splits it 5/2/93, finds the top 30% with ties, and pays points × stake", () => {
    const k = setup();
    as(SEED);
    k.seed_deposit_vhp(new kpred.seed_deposit_vhp_arguments(1000 * VHP));
    k.seed_deposit_koin(new kpred.seed_deposit_koin_arguments(200 * VHP));
    deposit(k, A, 100 * VHP);
    deposit(k, B, 50 * VHP);
    deposit(k, C, 30 * VHP);
    deposit(k, D, 20 * VHP);
    deposit(k, E, 10 * VHP);

    at(1100);
    const q0 = post(k, 2, 1300, 1301, 1400);
    const q1 = post(k, 4, 1300, 1301, 1500);
    const q2 = post(k, 2, 1900, 1950, 2100);
    at(1200);
    answer(k, A, q0, 1); answer(k, A, q1, 2); answer(k, A, q2, 0);   // 3 right
    answer(k, E, q0, 1); answer(k, E, q1, 2); answer(k, E, q2, 0);   // 3 right (tie with A)
    answer(k, B, q0, 1); answer(k, B, q1, 0); answer(k, B, q2, 1);   // 1 right
    answer(k, C, q0, 0); answer(k, C, q1, 2); answer(k, C, q2, 0);   // 2 right
    answer(k, D, q0, 1);                                             // only 1 answer: not eligible

    at(1500); resolve(k, q0, 1);
    at(1600); resolve(k, q1, 2);

    // Too early to close: week not over, and q2 unresolved.
    gK = k;
    at(2005);
    MockVM.commitTransaction();
    expect(() => { gK!.close_week(new kpred.close_week_arguments(0)); }).toThrow();
    expect(MockVM.getErrorMessage()).toBe("too early to close this week");
    at(2015);
    MockVM.commitTransaction();
    expect(() => { gK!.close_week(new kpred.close_week_arguments(0)); }).toThrow();
    expect(MockVM.getErrorMessage()).toBe("some questions are not resolved yet");

    at(2200); resolve(k, q2, 0);

    // The node earned 100 KOIN of block rewards during the week.
    give(KOIN_TAG, CONTRACT, 100 * VHP);
    give(MANA_TAG, CONTRACT, 100 * VHP);

    at(2210);
    nobody();
    const cw = k.close_week(new kpred.close_week_arguments(0));
    expect(cw.gain).toBe(100 * VHP);
    expect(cw.pot).toBe(93 * VHP);
    let s = k.get_state(new kpred.get_state_arguments());
    expect(s.totals!.creator_fee).toBe(5 * VHP);
    expect(s.totals!.owner_share).toBe(2 * VHP);
    expect(s.totals!.pots_outstanding).toBe(93 * VHP);

    // Settlement: anyone can settle anyone.
    const sa = k.settle(new kpred.settle_arguments(A, 0));
    expect(sa.points).toBe(3);
    expect(sa.eligible).toBe(true);
    expect(k.settle(new kpred.settle_arguments(B, 0)).points).toBe(1);
    expect(k.settle(new kpred.settle_arguments(C, 0)).points).toBe(2);
    const sd = k.settle(new kpred.settle_arguments(D, 0));
    expect(sd.eligible).toBe(false);
    expect(k.settle(new kpred.settle_arguments(E, 0)).points).toBe(3);
    gWho = A;
    MockVM.commitTransaction();
    expect(() => { gK!.settle(new kpred.settle_arguments(gWho, 0)); }).toThrow();
    expect(MockVM.getErrorMessage()).toBe("already settled");

    // Finalize after the settlement window: eligible stake 190 (A100 B50 C30 E10); 30% = 57.
    // 3 points: A+E = 110 ≥ 57 → cutoff 3, winners A and E (tie included).
    MockVM.commitTransaction();
    expect(() => { gK!.finalize_week(new kpred.finalize_week_arguments(0)); }).toThrow();
    expect(MockVM.getErrorMessage()).toBe("settlement window still open");
    at(2400);
    const fw = k.finalize_week(new kpred.finalize_week_arguments(0));
    expect(fw.cutoff).toBe(3);
    expect(fw.winners).toBe(2);

    // Claims: A gets 93 × 300/330, E gets 93 × 30/330. Spare KOIN is burned to VHP on demand.
    const aBefore = Tokens.testGet(VHP_TAG, A);
    as(A);
    const ra = k.claim(new kpred.claim_arguments(A, 0)).reward;
    expect(ra).toBe(<u64>(u64(93 * VHP) * 300 / 330));
    expect(Tokens.testGet(VHP_TAG, A) - aBefore).toBe(ra);
    as(E);
    const re = k.claim(new kpred.claim_arguments(E, 0)).reward;
    expect(re).toBe(<u64>(u64(93 * VHP) * 30 / 330));
    expect(ra + re <= 93 * VHP).toBe(true);
    // C (2 points) is below the cutoff; B too; no double claims.
    gWho = C;
    as(C);
    MockVM.commitTransaction();
    expect(() => { gK!.claim(new kpred.claim_arguments(gWho, 0)); }).toThrow();
    expect(MockVM.getErrorMessage()).toBe("below the winners' cutoff");
    gWho = A;
    as(A);
    MockVM.commitTransaction();
    expect(() => { gK!.claim(new kpred.claim_arguments(gWho, 0)); }).toThrow();
    expect(MockVM.getErrorMessage()).toBe("already claimed");

    // Owner takes the 5% fee in KOIN and the 2% share in VHP; the Mana reserve (seed KOIN) stays.
    as(OWNER);
    expect(k.claim_creator_fee(new kpred.claim_creator_fee_arguments(OWNER)).amount).toBe(5 * VHP);
    k.claim_owner_share(new kpred.claim_owner_share_arguments(OWNER, 2 * VHP));
    expect(Tokens.testGet(KOIN_TAG, OWNER)).toBe(5 * VHP);
    expect(Tokens.testGet(VHP_TAG, OWNER)).toBe(2 * VHP);
    s = k.get_state(new kpred.get_state_arguments());
    expect(s.koin_balance >= 200 * VHP).toBe(true);

    // Books balance: holdings ≥ everything still owed (only rounding dust is left over).
    const owed = s.totals!.total_stake + s.totals!.seed_vhp + s.totals!.seed_koin + s.totals!.owner_share + s.totals!.creator_fee + s.totals!.pots_outstanding;
    expect(s.vhp_balance + s.koin_balance >= owed).toBe(true);
    expect(s.totals!.pots_outstanding < 10).toBe(true);
  });

  it("descends below the top score until 30% of eligible stake is covered", () => {
    const k = setup();
    deposit(k, A, 10 * VHP);                          // top scorer holds only 10 of 100 eligible
    deposit(k, B, 30 * VHP);
    deposit(k, C, 60 * VHP);
    at(1100);
    const q0 = post(k, 2, 1300, 1301, 1400);
    const q1 = post(k, 2, 1300, 1301, 1400);
    at(1200);
    answer(k, A, q0, 1); answer(k, A, q1, 1);        // 2 points
    answer(k, B, q0, 1); answer(k, B, q1, 0);        // 1 point
    answer(k, C, q0, 0); answer(k, C, q1, 0);        // 0 points
    at(1500); resolve(k, q0, 1); resolve(k, q1, 1);
    give(KOIN_TAG, CONTRACT, 100 * VHP); give(MANA_TAG, CONTRACT, 100 * VHP);
    at(2010);
    k.close_week(new kpred.close_week_arguments(0));
    k.settle(new kpred.settle_arguments(A, 0));
    k.settle(new kpred.settle_arguments(B, 0));
    k.settle(new kpred.settle_arguments(C, 0));
    at(2200);
    const fw = k.finalize_week(new kpred.finalize_week_arguments(0));
    expect(fw.cutoff).toBe(1);                       // 10 < 30, 10+30 = 40 ≥ 30
    expect(fw.winners).toBe(2);
    as(A);
    const ra = k.claim(new kpred.claim_arguments(A, 0)).reward;
    as(B);
    const rb = k.claim(new kpred.claim_arguments(B, 0)).reward;
    expect(ra).toBe(<u64>(u64(93 * VHP) * 20 / 50));  // weights: A 2×10 = 20, B 1×30 = 30
    expect(rb).toBe(<u64>(u64(93 * VHP) * 30 / 50));
  });

  it("with no scorers the pot rolls into the next week's gain", () => {
    const k = setup();
    deposit(k, A, 10 * VHP);
    at(1100);
    const q0 = post(k, 2, 1300, 1301, 1400);
    const q1 = post(k, 2, 1300, 1301, 1400);
    at(1200);
    answer(k, A, q0, 0); answer(k, A, q1, 0);
    at(1500); resolve(k, q0, 1); resolve(k, q1, 1);
    give(KOIN_TAG, CONTRACT, 100 * VHP); give(MANA_TAG, CONTRACT, 100 * VHP);
    at(2010);
    k.close_week(new kpred.close_week_arguments(0));
    k.settle(new kpred.settle_arguments(A, 0));
    at(2200);
    k.finalize_week(new kpred.finalize_week_arguments(0));
    expect(k.get_week(new kpred.get_week_arguments(0)).week!.rolled_over).toBe(true);
    // Next week: no new rewards, but last week's 93 comes back as gain.
    at(3010);
    const cw = k.close_week(new kpred.close_week_arguments(1));
    expect(cw.gain).toBe(93 * VHP);
  });

  it("weeks close in order", () => {
    const k = setup();
    gK = k;
    at(5000);
    MockVM.commitTransaction();
    expect(() => { gK!.close_week(new kpred.close_week_arguments(1)); }).toThrow();
    expect(MockVM.getErrorMessage()).toBe("weeks close in order: close week 0 first");
  });
});

describe("compound and reserves", () => {
  it("burns only KOIN above the seed reserve and unpaid fees, capped by Mana", () => {
    const k = setup();
    as(SEED);
    k.seed_deposit_koin(new kpred.seed_deposit_koin_arguments(200 * VHP));
    give(KOIN_TAG, CONTRACT, 50 * VHP);
    give(MANA_TAG, CONTRACT, 20 * VHP);              // Mana 220 in total
    nobody();
    // KOIN 250, keep 200 → 50 spare; Mana 220 is enough
    expect(k.compound(new kpred.compound_arguments()).burned).toBe(50 * VHP);
    expect(Tokens.testGet(KOIN_TAG, CONTRACT)).toBe(200 * VHP);
    expect(Tokens.testGet(VHP_TAG, CONTRACT)).toBe(50 * VHP);
    expect(k.compound(new kpred.compound_arguments()).burned).toBe(0);
  });
});

describe("seed", () => {
  it("only the seed owner adds or withdraws it, and only after the timelock", () => {
    const k = setup();
    as(SEED);
    k.seed_deposit_vhp(new kpred.seed_deposit_vhp_arguments(1000 * VHP));
    gK = k;
    as(OWNER);
    MockVM.commitTransaction();
    expect(() => { gK!.request_seed_withdrawal(new kpred.request_seed_withdrawal_arguments(1000 * VHP, 0)); }).toThrow();
    as(SEED);
    const eta = k.request_seed_withdrawal(new kpred.request_seed_withdrawal_arguments(400 * VHP, 0)).eta;
    expect(eta).toBe(150);
    MockVM.commitTransaction();
    expect(() => { gK!.execute_seed_withdrawal(new kpred.execute_seed_withdrawal_arguments()); }).toThrow();
    expect(MockVM.getErrorMessage()).toBe("the timelock has not passed yet");
    at(150);
    const r = k.execute_seed_withdrawal(new kpred.execute_seed_withdrawal_arguments());
    expect(r.vhp).toBe(400 * VHP);
    expect(k.get_state(new kpred.get_state_arguments()).totals!.seed_vhp).toBe(600 * VHP);
  });
});

describe("owner powers are limited", () => {
  it("owner-only functions refuse everyone else; ownership moves in two steps", () => {
    const k = setup();
    gK = k;
    as(A);
    MockVM.commitTransaction();
    expect(() => { gK!.set_paused(new kpred.set_paused_arguments(true)); }).toThrow();
    MockVM.commitTransaction();
    expect(() => { gK!.set_operator(new kpred.set_operator_arguments(A)); }).toThrow();
    MockVM.commitTransaction();
    expect(() => { gK!.claim_owner_share(new kpred.claim_owner_share_arguments(A, 1)); }).toThrow();
    MockVM.commitTransaction();
    expect(() => { gK!.schedule_upgrade(new kpred.schedule_upgrade_arguments(hash32(1))); }).toThrow();
    as(OWNER);
    k.propose_owner(new kpred.propose_owner_arguments(B));
    expect(Base58.encode(k.get_state(new kpred.get_state_arguments()).config!.owner!)).toBe(Base58.encode(OWNER));
    as(B);
    k.accept_owner(new kpred.accept_owner_arguments());
    expect(Base58.encode(k.get_state(new kpred.get_state_arguments()).config!.owner!)).toBe(Base58.encode(B));
  });

  it("the owner cannot take more than the owner share", () => {
    const k = setup();
    deposit(k, A, 100 * VHP);
    gK = k;
    as(OWNER);
    MockVM.commitTransaction();
    expect(() => { gK!.claim_owner_share(new kpred.claim_owner_share_arguments(OWNER, 1)); }).toThrow();
    expect(MockVM.getErrorMessage()).toBe("more than the owner share");
  });
});

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

describe("sponsored transactions", () => {
  it("pays only for one valid answer / settle / claim with a small rc_limit", () => {
    const k = setup();
    deposit(k, A, 10 * VHP);
    at(1100);
    const q = post(k, 2, 1300, 1301, 1400);
    as(A);
    const good = Protobuf.encode(new kpred.answer_arguments(A, q, 1), kpred.answer_arguments.encode);
    setTx(0x0db52f40, good, VHP / 2, 1);
    expect(sponsor(k)).toBe(true);
    setTx(0x0db52f40, good, 2 * VHP, 1);              // rc_limit above the cap
    expect(sponsor(k)).toBe(false);
    setTx(0x0db52f40, good, VHP / 2, 2);              // two operations
    expect(sponsor(k)).toBe(false);
    const bad = Protobuf.encode(new kpred.answer_arguments(A, q, 5), kpred.answer_arguments.encode);
    setTx(0x0db52f40, bad, VHP / 2, 1);               // invalid option: refused for free
    expect(sponsor(k)).toBe(false);
    const nostake = Protobuf.encode(new kpred.answer_arguments(B, q, 1), kpred.answer_arguments.encode);
    as(B);
    setTx(0x0db52f40, nostake, VHP / 2, 1);           // no stake
    expect(sponsor(k)).toBe(false);
    as(A);
    setTx(0x6868e83d, Protobuf.encode(new kpred.settle_arguments(A, 0), kpred.settle_arguments.encode), VHP / 2, 1);
    expect(sponsor(k)).toBe(false);                  // week not closed yet
    setTx(0x8ed1d782, good, VHP / 2, 1);              // not a sponsored entry point
    expect(sponsor(k)).toBe(false);
  });

  it("never lets anyone move the contract's tokens from outside", () => {
    const k = setup();
    expect(k.authorize(new authority.authorize_arguments(authority.authorization_type.contract_call)).value).toBe(false);
  });
});

describe("more sponsorship and upgrades", () => {
  it("pays for valid settle and claim, never for someone else's answer", () => {
    const k = setup();
    deposit(k, A, 10 * VHP);
    deposit(k, B, 10 * VHP);
    at(1100);
    const q0 = post(k, 2, 1300, 1301, 1400);
    const q1 = post(k, 2, 1300, 1301, 1400);
    // B signs, but the answer is for A: the authority check fails, so the contract refuses to pay.
    as(B);
    setTx(0x0db52f40, Protobuf.encode(new kpred.answer_arguments(A, q0, 1), kpred.answer_arguments.encode), VHP / 2, 1);
    expect(sponsor(k)).toBe(false);
    at(1200);
    answer(k, A, q0, 1); answer(k, A, q1, 1);
    answer(k, B, q0, 0); answer(k, B, q1, 1);
    at(1500); resolve(k, q0, 1); resolve(k, q1, 1);
    give(KOIN_TAG, CONTRACT, 10 * VHP); give(MANA_TAG, CONTRACT, 10 * VHP);
    at(2010);
    k.close_week(new kpred.close_week_arguments(0));
    nobody();                                         // settle needs no signature
    setTx(0x6868e83d, Protobuf.encode(new kpred.settle_arguments(A, 0), kpred.settle_arguments.encode), VHP / 2, 1);
    expect(sponsor(k)).toBe(true);
    k.settle(new kpred.settle_arguments(A, 0));
    k.settle(new kpred.settle_arguments(B, 0));
    expect(sponsor(k)).toBe(false);                  // already settled: refused for free
    at(2200);
    k.finalize_week(new kpred.finalize_week_arguments(0));
    as(A);
    setTx(0xdd1b3c31, Protobuf.encode(new kpred.claim_arguments(A, 0), kpred.claim_arguments.encode), VHP / 2, 1);
    expect(sponsor(k)).toBe(true);
    as(B);                                           // B cannot get A's claim sponsored
    expect(sponsor(k)).toBe(false);
  });

  it("code can be replaced only with the owner, the announced bytecode, after the timelock", () => {
    const k = setup();
    const code = new Uint8Array(100);
    code.fill(42);
    const mh = new Crypto.Multihash();
    mh.deserialize(System.hash(Crypto.multicodec.sha2_256, code)!);
    as(OWNER);
    const eta = k.schedule_upgrade(new kpred.schedule_upgrade_arguments(mh.digest)).eta;
    const tx = new protocol.transaction();
    tx.header = new protocol.transaction_header();
    const op = new protocol.operation();
    op.upload_contract = new protocol.upload_contract_operation(CONTRACT, code);
    tx.operations.push(op);
    MockVM.setTransaction(tx);
    System.resetCache();
    const up = new authority.authorize_arguments(authority.authorization_type.contract_upload);
    expect(k.authorize(up).value).toBe(false);       // before the timelock
    at(eta);
    expect(k.authorize(up).value).toBe(true);        // owner, right code, after the timelock
    as(A);
    expect(k.authorize(up).value).toBe(false);       // not the owner
    as(OWNER);
    const other = new Uint8Array(100);
    other.fill(7);
    op.upload_contract = new protocol.upload_contract_operation(CONTRACT, other);
    tx.operations[0] = op;
    MockVM.setTransaction(tx);
    System.resetCache();
    expect(k.authorize(up).value).toBe(false);       // different bytecode than announced
  });
});

describe("edge cases", () => {
  it("a withdrawal after answering makes the week ineligible at settlement", () => {
    const k = setup();
    deposit(k, A, 10 * VHP);
    at(1100);
    const q0 = post(k, 2, 1300, 1301, 1400);
    const q1 = post(k, 2, 1300, 1301, 1400);
    at(1200);
    answer(k, A, q0, 1); answer(k, A, q1, 1);
    as(A);
    k.withdraw(new kpred.withdraw_arguments(A, 1 * VHP));
    at(1500); resolve(k, q0, 1); resolve(k, q1, 1);
    at(2010);
    k.close_week(new kpred.close_week_arguments(0));
    const r = k.settle(new kpred.settle_arguments(A, 0));
    expect(r.eligible).toBe(false);
    expect(r.points).toBe(0);
  });

  it("a mid-week top-up does not change the week's stake snapshot", () => {
    const k = setup();
    deposit(k, A, 10 * VHP);
    at(1100);
    const q0 = post(k, 2, 1300, 1301, 1400);
    at(1200);
    answer(k, A, q0, 1);
    deposit(k, A, 500 * VHP);
    expect(k.get_player(new kpred.get_player_arguments(A, 0)).entry!.stake).toBe(10 * VHP);
  });

  it("withdrawals still work when block production has turned some VHP into KOIN", () => {
    const k = setup();
    as(SEED);
    k.seed_deposit_koin(new kpred.seed_deposit_koin_arguments(100 * VHP));
    deposit(k, A, 50 * VHP);
    // Production burned 5 VHP and minted 5 + 1 KOIN (reward) to the contract.
    Tokens.testSet(VHP_TAG, CONTRACT, 45 * VHP);
    give(KOIN_TAG, CONTRACT, 6 * VHP);
    give(MANA_TAG, CONTRACT, 6 * VHP);
    as(A);
    k.withdraw(new kpred.withdraw_arguments(A, 50 * VHP));   // compounds the spare 6 KOIN first
    expect(Tokens.testGet(VHP_TAG, A)).toBe(1000 * VHP);
    expect(Tokens.testGet(KOIN_TAG, CONTRACT)).toBe(100 * VHP); // the Mana reserve is untouched
  });

  it("a week with no gain pays nothing but still closes and finalizes", () => {
    const k = setup();
    deposit(k, A, 10 * VHP);
    at(1100);
    const q0 = post(k, 2, 1300, 1301, 1400);
    const q1 = post(k, 2, 1300, 1301, 1400);
    at(1200);
    answer(k, A, q0, 1); answer(k, A, q1, 1);
    at(1500); resolve(k, q0, 1); resolve(k, q1, 1);
    at(2010);
    expect(k.close_week(new kpred.close_week_arguments(0)).gain).toBe(0);
    k.settle(new kpred.settle_arguments(A, 0));
    at(2200);
    k.finalize_week(new kpred.finalize_week_arguments(0));
    as(A);
    expect(k.claim(new kpred.claim_arguments(A, 0)).reward).toBe(0);
  });
});

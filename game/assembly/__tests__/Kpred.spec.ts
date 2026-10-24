/**
 * Game contract tests on a simulated Koinos chain (MockVM). Token movements use the in-contract test ledger.
 * Run with: npm test
 */
import { Base58, MockVM, authority, chain, Protobuf, System, protocol, value, Crypto } from "@koinos/sdk-as";
import { Kpred, rankWeight } from "../Kpred";
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
/** 30 more real addresses for the split-wallet test. */
const RIVALS: string[] = ["1AGvUAvSHjt8HB7kit8Y2a53VKb1WtJxZQ", "1NQxrPFTmJRLxbouR2xLYsQSDrkKoJzik8", "12ixiX21L5VnNJepmipcnLfdLpLiN5yx8P", "1N1GsD8sfMkuVbqbhA7AQs4BtC6weQb6Cp", "1WgXcJBQccR4sDMU236vCN2roVJ35V3vA", "1CUW3YBfxJ8bVXTSmYP6UPjuBoakYaGFeT", "1Mo1UyerX3NhjCHc6A7ph4HjgQmixLHnQc", "168i9VwGUfYzzbX6XDYDYNCbL6S2thGJPT", "1KATVW4LsjV43Jyb2iW3iVG6WSJRAMAHWx", "1CSLTiEfZpgoqyVzFQLsUQ2CWLFok4MH7X", "125KNJWjXdkWzzmmNsXmAJVAUmUETTQBRf", "1BTy2aJEgzwjmf1ywBYb4QwefYURQEvVq7", "16a9XPnUVA27X6vLFJnzPoSyPsJGnhqPYt", "1NqYzjb25ETUdNL9WfmuRourKSh2MQPDVZ", "1BhSzeXZE58up271b9L3H36G43CDjEUm76", "1QKEXYi1CqvySxovEuFU4FKaEEBeXr9yim", "142Xj8GjpGLW29d16MnXM8JJBXVJ7jYiFf", "1MhaH9AgaDkg8ee15zcRVp59rkcFCTx8Ma", "1Hgb1uR1zC491tC95MNNpjYZzfKGhhcYQf", "1Jrj8f8wtU9XpV9SSQbT9wW2GbPNmMTdip", "1NZ4ae3K6fZshhNu7ibXexnD16eKt1mmQz", "14Xy5y1VPsr2MAVtBk9FqvDccTSGciNpKo", "1PcLxKr1FRi8uEfBVMtrarXF8oTrHUZP86", "13cSTUezQdGRCAyLBHtMCUELMSwYgbdgqK", "1JVy8DWTFQJ422UdMCXGu9CQvnLAc6xdxL", "17LJtST5i85HoEyjmaCamenQDYZ9UNZeG4", "19BTw4pqcVjtJPYPUqjn13ySDNaa71Sej5", "1QDa4CuPPL5oJFZGY9c4AFppBsTi4VkzFN", "1EGcuRVo8am99bd5h7hJ4hj3viy7CZ7fop", "1CJBDVq46LecmTt39vfEnmXCRQoRyUDrsH"];

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

describe("setup", () => {
  it("initialises once with owner, operator and seed owner", () => {
    const k = setup();
    const s = k.get_state(new kpred.get_state_arguments());
    expect(Base58.encode(s.config!.owner!)).toBe(Base58.encode(OWNER));
    expect(s.config!.week_length).toBe(WEEK * MS);
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

  it("withdraw returns VHP and takes pending first; part lowers the week's stake, all of it leaves the week", () => {
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
    let e = k.get_player(new kpred.get_player_arguments(A, 0)).entry!;
    expect(e.voided).toBe(false);                    // a partial withdrawal keeps the player in the week …
    expect(e.stake).toBe(90 * VHP);                  // … with the lower stake as their multiplier
    expect(Tokens.testGet(VHP_TAG, A)).toBe((1000 - 100 - 20 + 30) * VHP);
    const q2 = post(k, 2, 1300, 1301, 1400);
    answer(k, A, q2, 1);                             // still allowed to answer
    as(A);
    k.withdraw(new kpred.withdraw_arguments(A, 90 * VHP));   // now everything
    e = k.get_player(new kpred.get_player_arguments(A, 0)).entry!;
    expect(e.voided).toBe(true);
    // and no more answers this week
    const q3 = post(k, 2, 1300, 1301, 1400);
    gK = k; gId = q3;
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
    expect(() => { gK!.post_question(new kpred.post_question_arguments(2, 1300 * MS, 1301, 1400, hash32(1))); }).toThrow();
    as(OPERATOR);
    MockVM.commitTransaction();
    expect(() => { gK!.post_question(new kpred.post_question_arguments(2, 2100 * MS, 2101, 2200, hash32(1))); }).toThrow();
    expect(MockVM.getErrorMessage()).toBe("answers must close before the week ends");
    MockVM.commitTransaction();
    expect(() => { gK!.post_question(new kpred.post_question_arguments(2, 1300 * MS, 1200, 1400, hash32(1))); }).toThrow();
    expect(MockVM.getErrorMessage()).toBe("the window must start after answers close");
    expect(post(k, 4, 1300, 1301, 1400)).toBe(0);
    expect(post(k, 2, 1300, 1301, 1400)).toBe(1);
  });

  it("free play: anyone can answer, but only the stake that counts this week can ever be paid", () => {
    const k = setup();
    at(1100);
    deposit(k, A, 10 * VHP);                         // during week 0: counts from week 1
    const q = post(k, 4, 1300, 1301, 1400);
    answer(k, A, q, 0);                              // plays week 0 for free
    expect(k.get_player(new kpred.get_player_arguments(A, 0)).entry!.stake).toBe(0);
    answer(k, E, q, 1);                              // never staked at all: free play too
    expect(k.get_player(new kpred.get_player_arguments(E, 0)).entry!.stake).toBe(0);
  });

  it("deposits are whole numbers only; withdrawals may be any amount, down to the last unit", () => {
    const k = setup();
    gK = k;
    as(A);
    MockVM.commitTransaction();
    expect(() => { gK!.deposit_vhp(new kpred.deposit_vhp_arguments(A, VHP + VHP / 2)); }).toThrow();
    expect(MockVM.getErrorMessage()).toBe("stake whole numbers only (1, 2, 3 …)");
    MockVM.commitTransaction();
    expect(() => { gK!.deposit_koin(new kpred.deposit_koin_arguments(A, 1)); }).toThrow();
    deposit(k, A, 3 * VHP);
    k.withdraw(new kpred.withdraw_arguments(A, VHP / 10));          // 0.1
    k.withdraw(new kpred.withdraw_arguments(A, 12_345_678));        // 0.12345678
    const pl = k.get_player(new kpred.get_player_arguments(A, 0)).player!;
    expect(pl.stake + pl.pending).toBe(3 * VHP - VHP / 10 - 12_345_678);
    MockVM.commitTransaction();
    expect(() => { gK!.withdraw(new kpred.withdraw_arguments(A, 3 * VHP)); }).toThrow();
    expect(MockVM.getErrorMessage()).toBe("more than your stake");
    k.withdraw(new kpred.withdraw_arguments(A, 3 * VHP - VHP / 10 - 12_345_678));   // everything that is left
    expect(Tokens.testGet(VHP_TAG, A)).toBe(1000 * VHP);             // every unit came back
    expect(k.get_state(new kpred.get_state_arguments()).totals!.total_stake).toBe(0);
    MockVM.commitTransaction();
    expect(() => { gK!.withdraw(new kpred.withdraw_arguments(A, 1)); }).toThrow();
  });

  it("answers need an open question, a valid option, and only once", () => {

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
  it("measures the gain, splits it 5% fee / 95% pot into the two baskets, finds the top 30% of players with ties, and pays", () => {
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
    const q2 = post(k, 2, 1700, 1701, 1760);
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

    // The node earned 100 KOIN of block rewards during the week.
    give(KOIN_TAG, CONTRACT, 100 * VHP);
    give(MANA_TAG, CONTRACT, 100 * VHP);

    // A late last resolution does NOT close the week at once: the owner gets close_delay to correct it (v4).
    at(2200); resolve(k, q2, 0);
    expect(k.get_week(new kpred.get_week_arguments(0)).week!.closed).toBe(false);
    MockVM.commitTransaction();
    expect(() => { gK!.close_week(new kpred.close_week_arguments(0)); }).toThrow();
    expect(MockVM.getErrorMessage()).toBe("too early to close this week");
    // close_delay after it, any action closes the week automatically (nobody has to call close_week).
    at(2210); nobody(); k.compound(new kpred.compound_arguments());
    const w0 = k.get_week(new kpred.get_week_arguments(0)).week!;
    expect(w0.closed).toBe(true);
    expect(w0.gain).toBe(100 * VHP);
    expect(w0.pot).toBe(95 * VHP);
    at(2210);
    nobody();
    let s = k.get_state(new kpred.get_state_arguments());
    expect(s.totals!.creator_fee).toBe(5 * VHP);
    expect(s.totals!.owner_share).toBe(0);              // the owner share is retired
    expect(w0.retained).toBe(0);
    expect(s.totals!.pots_outstanding).toBe(95 * VHP);

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

    // Finalize after the settlement window: 4 eligible players (A B C E; D answered once); 30% of 4 → 2 places.
    // 3 points: A and E fill both places (tied) → cutoff 3, winners A and E.
    MockVM.commitTransaction();
    expect(() => { gK!.finalize_week(new kpred.finalize_week_arguments(0)); }).toThrow();
    expect(MockVM.getErrorMessage()).toBe("settlement window still open");
    at(2400);                                        // settlement window was 2200–2300
    const fw = k.finalize_week(new kpred.finalize_week_arguments(0));
    expect(fw.cutoff).toBe(3);
    expect(fw.winners).toBe(2);

    // Baskets: the house (1,000 seed VHP) produced 1000/1210 of the week, players' stake (210 VHP) the rest.
    const wf = k.get_week(new kpred.get_week_arguments(0)).week!;
    expect(wf.house_ppm).toBe(826446);                         // 1000 / 1210, in parts per million
    expect(wf.reward_rule).toBe(true);                         // v5 split
    expect(wf.pot_a).toBe(38 * VHP);                           // basket A: 40% of the pot
    expect(wf.pot_b).toBe(57 * VHP);                           // basket B: the other 60%
    // A and E tie for places 1 and 2. Basket A counts stake only up to 10 VHP, so A (100) and E (10) split it evenly;
    // basket B by full stake (A 100, E 10). Spare KOIN → VHP on demand.
    const aBefore = Tokens.testGet(VHP_TAG, A);
    as(A);
    const ra = k.claim(new kpred.claim_arguments(A, 0)).reward;
    expect(near(ra, wf.pot_a / 2 + wf.pot_b * 100 / 110)).toBe(true);
    expect(Tokens.testGet(VHP_TAG, A) - aBefore).toBe(ra);
    as(E);
    const re = k.claim(new kpred.claim_arguments(E, 0)).reward;
    expect(near(re, wf.pot_a / 2 + wf.pot_b * 10 / 110)).toBe(true);
    expect(ra + re <= 95 * VHP).toBe(true);
    expect(95 * VHP - ra - re < 4).toBe(true);                 // only rounding dust stays behind
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

    // Owner takes the 5% producer fee in KOIN; the Mana reserve (seed KOIN) stays. There is no owner share to take.
    as(OWNER);
    expect(k.claim_creator_fee(new kpred.claim_creator_fee_arguments(OWNER)).amount).toBe(5 * VHP);
    expect(Tokens.testGet(KOIN_TAG, OWNER)).toBe(5 * VHP);
    gK = k;
    MockVM.commitTransaction();
    expect(() => { gK!.claim_owner_share(new kpred.claim_owner_share_arguments(OWNER, 1)); }).toThrow();
    expect(Tokens.testGet(VHP_TAG, OWNER)).toBe(0);
    s = k.get_state(new kpred.get_state_arguments());
    expect(s.koin_balance >= 200 * VHP).toBe(true);

    // Books balance: holdings ≥ everything still owed (only rounding dust is left over).
    const owed = s.totals!.total_stake + s.totals!.seed_vhp + s.totals!.seed_koin + s.totals!.owner_share + s.totals!.creator_fee + s.totals!.pots_outstanding;
    expect(s.vhp_balance + s.koin_balance >= owed).toBe(true);
    expect(s.totals!.pots_outstanding < 10).toBe(true);
  });

  it("winners are the top 30% of staked players by headcount: a big stake does not buy a place", () => {
    const k = setup();
    deposit(k, A, 10 * VHP);                          // top scorer holds only 10 of 100 staked
    deposit(k, B, 30 * VHP);
    deposit(k, C, 60 * VHP);
    at(1100);
    const q0 = post(k, 2, 1300, 1301, 1400);
    const q1 = post(k, 2, 1300, 1301, 1400);
    at(1200);
    answer(k, A, q0, 1); answer(k, A, q1, 1);        // 2 points
    answer(k, B, q0, 1); answer(k, B, q1, 0);        // 1 point
    answer(k, C, q0, 0); answer(k, C, q1, 0);        // 0 points
    answer(k, D, q0, 1); answer(k, D, q1, 1);        // 2 points, but never staked: free play takes no place
    at(1500); resolve(k, q0, 1); resolve(k, q1, 1);
    give(KOIN_TAG, CONTRACT, 100 * VHP); give(MANA_TAG, CONTRACT, 100 * VHP);
    at(2010);
    k.close_week(new kpred.close_week_arguments(0));
    k.settle(new kpred.settle_arguments(A, 0));
    k.settle(new kpred.settle_arguments(B, 0));
    k.settle(new kpred.settle_arguments(C, 0));
    k.settle(new kpred.settle_arguments(D, 0));
    at(2200);
    const fw = k.finalize_week(new kpred.finalize_week_arguments(0));
    expect(fw.cutoff).toBe(2);                       // 3 staked players → 30% → 1 place
    expect(fw.winners).toBe(1);
    as(A);
    const ra = k.claim(new kpred.claim_arguments(A, 0)).reward;
    expect(95 * VHP - ra < 3).toBe(true);            // the whole pot (no seed here: all of it is basket B)
    gK = k; gWho = D;
    as(D);
    MockVM.commitTransaction();
    expect(() => { gK!.claim(new kpred.claim_arguments(gWho, 0)); }).toThrow();
    expect(MockVM.getErrorMessage()).toBe("not eligible that week");
  });

  it("the rank curve: 1st > 2nd > 3rd …; basket A counts stake only up to 10 VHP, basket B the full stake (v5)", () => {
    const k = setup();
    as(SEED);
    k.seed_deposit_vhp(new kpred.seed_deposit_vhp_arguments(5000 * VHP));
    // 10 staked players with 10 different scores; 30% → 3 winners
    const who: Uint8Array[] = [A, B, C, D, E, P6, P7, P8, P9, P10];
    for (let i = 0; i < who.length; i++) { give(VHP_TAG, who[i], 2000 * VHP); give(MANA_TAG, who[i], 10 * VHP); }
    deposit(k, A, 1 * VHP);                          // 1st place with the minimum stake
    deposit(k, B, 1000 * VHP);                       // 2nd place, a whale
    deposit(k, C, 10 * VHP);                         // 3rd place, exactly the basket-A cap
    for (let i = 3; i < who.length; i++) deposit(k, who[i], 5 * VHP);
    at(1100);
    const qs: u32[] = [];
    for (let i = 0; i < 10; i++) qs.push(post(k, 2, 1300, 1301, 1400));
    at(1200);
    for (let i = 0; i < who.length; i++) {
      for (let j = 0; j < 10; j++) answer(k, who[i], qs[j], j < 10 - i ? 1 : 0);   // player i scores 10 − i
    }
    at(1500);
    for (let j = 0; j < 10; j++) resolve(k, qs[j], 1);
    give(KOIN_TAG, CONTRACT, 1000 * VHP); give(MANA_TAG, CONTRACT, 1000 * VHP);
    at(2010);
    k.close_week(new kpred.close_week_arguments(0));
    for (let i = 0; i < who.length; i++) k.settle(new kpred.settle_arguments(who[i], 0));
    at(2200);
    const fw = k.finalize_week(new kpred.finalize_week_arguments(0));
    expect(fw.winners).toBe(3);
    expect(fw.cutoff).toBe(8);
    const wk = k.get_week(new kpred.get_week_arguments(0)).week!;
    expect(wk.sum_w).toBe(rankWeight(1) + rankWeight(2) + rankWeight(3));
    expect(wk.pot_a).toBe(wk.pot * 4000 / 10000);
    as(A); const ra = k.claim(new kpred.claim_arguments(A, 0)).reward;
    as(B); const rb = k.claim(new kpred.claim_arguments(B, 0)).reward;
    as(C); const rc = k.claim(new kpred.claim_arguments(C, 0)).reward;
    // Basket A: rank weight × stake up to 10 VHP (A 1, B 10, C 10). Basket B: rank weight × full stake.
    const awT = <f64>(rankWeight(1) * 1 + rankWeight(2) * 10 + rankWeight(3) * 10);
    const bwT = <f64>(rankWeight(1) * 1 + rankWeight(2) * 1000 + rankWeight(3) * 10);
    const pa = <f64>wk.pot_a, pb = <f64>wk.pot_b;
    expect(near(ra, v5Expected(pa, pb, awT, bwT, 1, 1, 1))).toBe(true);
    expect(near(rb, v5Expected(pa, pb, awT, bwT, 2, 10, 1000))).toBe(true);
    expect(near(rc, v5Expected(pa, pb, awT, bwT, 3, 10, 10))).toBe(true);
    // In basket A the whale's 1,000 VHP counts as 10: 2nd place with 10 VHP beats 3rd with 10 VHP only by rank.
    const bA = <u64>(pa * <f64>(rankWeight(2) * 10) / awT), cA = <u64>(pa * <f64>(rankWeight(3) * 10) / awT);
    expect(bA > cA).toBe(true);
    // The 1-VHP leader takes far more than a stake-proportional share (1 of 1,011 VHP).
    expect(ra > wk.pot / 1011 * 10).toBe(true);
    expect(ra + rb + rc <= wk.pot).toBe(true);
  });

  it("splitting one stake across many wallets gains nothing in basket A at or below 10 VHP (v5, audit M-2)", () => {
    // Two worlds with the same scores. World 1: X stakes 10 VHP in one wallet. World 2: X splits the same 10 VHP into
    // 10 wallets of 1 VHP that all answer the same way. X's total reward must not be higher in world 2.
    const one = splitWorld(false), many = splitWorld(true);
    expect(many <= one + 10).toBe(true, "splitting must not pay more (rounding aside)");
  });

  it("a deposit just before the close barely moves the basket split (production is weighted by time)", () => {
    const k = setup();
    as(SEED);
    k.seed_deposit_vhp(new kpred.seed_deposit_vhp_arguments(1000 * VHP));
    deposit(k, A, 10 * VHP);
    at(1100);
    const q0 = post(k, 2, 1300, 1301, 1400);
    const q1 = post(k, 2, 1300, 1301, 1400);
    at(1200);
    answer(k, A, q0, 1); answer(k, A, q1, 1);
    at(1500); resolve(k, q0, 1); resolve(k, q1, 1);
    give(VHP_TAG, B, 100_000 * VHP);
    at(2009);
    deposit(k, B, 100_000 * VHP);                    // a whale arrives one block before the close
    give(KOIN_TAG, CONTRACT, 100 * VHP); give(MANA_TAG, CONTRACT, 100 * VHP);
    at(2010);
    k.close_week(new kpred.close_week_arguments(0));
    const wk = k.get_week(new kpred.get_week_arguments(0)).week!;
    // Without time weighting the house share would be 1000/101,010 ≈ 1%; with it, it stays near 1000/1010 ≈ 99%.
    // (one block at 100,010 VHP still counts: ≈ 94%, against ≈ 1% if only the balance at the close counted)
    expect(wk.house_ppm > 900_000).toBe(true);
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
    // Next week: no new rewards, but last week's 95 comes back, whole: the fee was already taken once.
    expect(k.get_state(new kpred.get_state_arguments()).totals!.rolled_over).toBe(95 * VHP);
    at(3010);
    const cw = k.close_week(new kpred.close_week_arguments(1));
    expect(cw.gain).toBe(95 * VHP);
    expect(cw.pot).toBe(95 * VHP);
    const st = k.get_state(new kpred.get_state_arguments()).totals!;
    expect(st.creator_fee).toBe(5 * VHP);           // still only the first week's fee
    expect(st.rolled_over).toBe(0);
  });

  it("a rolled-over pot plus new earnings: the fee is charged only on the new earnings", () => {
    const k = setup();
    deposit(k, A, 10 * VHP);
    at(1100);
    const q0 = post(k, 2, 1300, 1301, 1400);
    const q1 = post(k, 2, 1300, 1301, 1400);
    at(1200);
    answer(k, A, q0, 0); answer(k, A, q1, 0);         // both wrong: nobody scores in week 0
    at(1500); resolve(k, q0, 1); resolve(k, q1, 1);
    give(KOIN_TAG, CONTRACT, 100 * VHP); give(MANA_TAG, CONTRACT, 100 * VHP);
    at(2010);
    k.close_week(new kpred.close_week_arguments(0));  // gain 100 → fee 5, pot 95
    k.settle(new kpred.settle_arguments(A, 0));
    at(2100);
    const r0 = post(k, 2, 2300, 2301, 2400);
    const r1 = post(k, 2, 2300, 2301, 2400);
    at(2200);
    k.finalize_week(new kpred.finalize_week_arguments(0));   // no winners: 95 rolls over
    answer(k, A, r0, 1); answer(k, A, r1, 1);         // both right in week 1
    at(2500); resolve(k, r0, 1); resolve(k, r1, 1);
    give(KOIN_TAG, CONTRACT, 40 * VHP); give(MANA_TAG, CONTRACT, 40 * VHP);   // week 1 earns 40 new
    at(3010);
    const cw = k.close_week(new kpred.close_week_arguments(1));
    expect(cw.gain).toBe(135 * VHP);
    expect(cw.pot).toBe(133 * VHP);                    // 95 + 40 − 5% of the new 40 only
    expect(k.get_state(new kpred.get_state_arguments()).totals!.creator_fee).toBe(7 * VHP);
    k.settle(new kpred.settle_arguments(A, 1));
    at(3200);
    as(A);
    expect(k.claim(new kpred.claim_arguments(A, 1)).reward).toBe(133 * VHP);
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
    expect(eta).toBe(150 * MS);
    MockVM.commitTransaction();
    expect(() => { gK!.execute_seed_withdrawal(new kpred.execute_seed_withdrawal_arguments()); }).toThrow();
    expect(MockVM.getErrorMessage()).toBe("the timelock has not passed yet");
    at(150);
    const r = k.execute_seed_withdrawal(new kpred.execute_seed_withdrawal_arguments());
    expect(r.vhp).toBe(400 * VHP);
    expect(k.get_state(new kpred.get_state_arguments()).totals!.seed_vhp).toBe(600 * VHP);
  });

  it("the whole seed (VHP and KOIN together) comes back even when production has turned some VHP into KOIN", () => {
    const k = setup();
    as(SEED);
    k.seed_deposit_vhp(new kpred.seed_deposit_vhp_arguments(100 * VHP));
    k.seed_deposit_koin(new kpred.seed_deposit_koin_arguments(50 * VHP));
    // block production turned 30 of the seed's VHP into KOIN (plus a 1 KOIN reward)
    Tokens.testSet(VHP_TAG, CONTRACT, 70 * VHP);
    give(KOIN_TAG, CONTRACT, 31 * VHP);
    give(MANA_TAG, CONTRACT, 31 * VHP);
    const eta = k.request_seed_withdrawal(new kpred.request_seed_withdrawal_arguments(100 * VHP, 50 * VHP)).eta;
    at(eta / MS);
    const r = k.execute_seed_withdrawal(new kpred.execute_seed_withdrawal_arguments());
    expect(r.vhp).toBe(100 * VHP);
    expect(r.koin).toBe(50 * VHP);
    expect(Tokens.testGet(VHP_TAG, SEED)).toBe(5000 * VHP);
    expect(Tokens.testGet(KOIN_TAG, SEED)).toBe(500 * VHP);
  });

  it("a KOIN seed withdrawal pays what KOIN is on hand and the rest later, never more than the seed", () => {
    const k = setup();
    as(SEED);
    k.seed_deposit_koin(new kpred.seed_deposit_koin_arguments(100 * VHP));
    // say 60 of that KOIN is currently held as VHP (it comes back as KOIN with the block rewards)
    Tokens.testSet(KOIN_TAG, CONTRACT, 40 * VHP);
    give(VHP_TAG, CONTRACT, 60 * VHP);
    const eta = k.request_seed_withdrawal(new kpred.request_seed_withdrawal_arguments(0, 100 * VHP)).eta;
    at(eta / MS);
    expect(k.execute_seed_withdrawal(new kpred.execute_seed_withdrawal_arguments()).koin).toBe(40 * VHP);
    give(KOIN_TAG, CONTRACT, 60 * VHP);
    expect(k.execute_seed_withdrawal(new kpred.execute_seed_withdrawal_arguments()).koin).toBe(60 * VHP);
    expect(Tokens.testGet(KOIN_TAG, SEED)).toBe(500 * VHP);
    expect(k.get_state(new kpred.get_state_arguments()).totals!.seed_koin).toBe(0);
    gK = k;
    MockVM.commitTransaction();
    expect(() => { gK!.execute_seed_withdrawal(new kpred.execute_seed_withdrawal_arguments()); }).toThrow();
    expect(MockVM.getErrorMessage()).toBe("no seed withdrawal requested");
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
    MockVM.commitTransaction();
    expect(() => { gK!.accept_owner(new kpred.accept_owner_arguments()); }).toThrow();   // v4: not in the same block
    expect(MockVM.getErrorMessage()).toBe("ownership can be accepted only 28,800 blocks (about a day) after it was proposed");
    at(100 + 28_799);
    MockVM.commitTransaction();
    expect(() => { gK!.accept_owner(new kpred.accept_owner_arguments()); }).toThrow();
    at(100 + 28_800);
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
    op.upload_contract = new protocol.upload_contract_operation(CONTRACT, code, "", true, true, true);
    tx.operations.push(op);
    MockVM.setTransaction(tx);
    System.resetCache();
    const up = new authority.authorize_arguments(authority.authorization_type.contract_upload);
    expect(k.authorize(up).value).toBe(false);       // before the timelock
    at(eta / MS);
    expect(k.authorize(up).value).toBe(true);        // owner, right code, after the timelock
    as(A);
    expect(k.authorize(up).value).toBe(false);       // not the owner
    as(OWNER);
    const other = new Uint8Array(100);
    other.fill(7);
    op.upload_contract = new protocol.upload_contract_operation(CONTRACT, other, "", true, true, true);
    tx.operations[0] = op;
    MockVM.setTransaction(tx);
    System.resetCache();
    expect(k.authorize(up).value).toBe(false);       // different bytecode than announced
    op.upload_contract = new protocol.upload_contract_operation(CONTRACT, code, "", true, true, true);
    tx.operations[0] = op;
    MockVM.setTransaction(tx);
    System.resetCache();
    expect(k.authorize(up).value).toBe(true);
    // the right code, but with the contract's own rules switched off: refused
    for (let flag = 0; flag < 3; flag++) {
      op.upload_contract = new protocol.upload_contract_operation(CONTRACT, code, "", flag != 0, flag != 1, flag != 2);
      tx.operations[0] = op;
      MockVM.setTransaction(tx);
      System.resetCache();
      expect(k.authorize(up).value).toBe(false);
    }
    op.upload_contract = new protocol.upload_contract_operation(CONTRACT, code, "", true, true, true);
    tx.operations[0] = op;
    MockVM.setTransaction(tx);
    System.resetCache();
    expect(k.authorize(up).value).toBe(true);
    as(A);
    gK = k;
    MockVM.commitTransaction();
    expect(() => { gK!.cancel_upgrade(new kpred.cancel_upgrade_arguments()); }).toThrow();
    as(OWNER);
    k.cancel_upgrade(new kpred.cancel_upgrade_arguments());
    expect(k.authorize(up).value).toBe(false);       // cancelled: the announced code can no longer be uploaded
  });
});

describe("safety valves", () => {
  it("refuses a question whose window ends after the week is due to close", () => {
    const k = setup();
    at(1100);
    as(OPERATOR);
    gK = k;
    MockVM.commitTransaction();
    // week 0 is due to close at block-time 2010; posted at 1100, even at 3.5 s per block the window (+60 blocks to be
    // final) must fit in the 910 × 2.8 s left: (end + 60 − 1100) × 3.5 ≤ 910 × 2.8  →  end ≤ 1768
    expect(() => { gK!.post_question(new kpred.post_question_arguments(2, 1700 * MS, 1701, 1769, hash32(1))); }).toThrow();
    expect(MockVM.getErrorMessage()).toBe("the window must end before the week is due to close");
    expect(post(k, 2, 1700, 1701, 1768)).toBe(0);
    // and the window may not start before answers close, even if blocks ran at the fastest allowed pace
    MockVM.commitTransaction();
    expect(() => { gK!.post_question(new kpred.post_question_arguments(2, 1300 * MS, 1299, 1400, hash32(1))); }).toThrow();
    expect(MockVM.getErrorMessage()).toBe("the window must start after answers close");
    // a gigantic window_end cannot wrap the arithmetic around and slip through
    MockVM.commitTransaction();
    expect(() => { gK!.post_question(new kpred.post_question_arguments(2, 1700 * MS, 1701, u64.MAX_VALUE - 30, hash32(1))); }).toThrow();
    expect(MockVM.getErrorMessage()).toBe("the window must end before the week is due to close");
    MockVM.commitTransaction();
    expect(() => { gK!.post_question(new kpred.post_question_arguments(2, 1700 * MS, 1701, 5270498306775198, hash32(1))); }).toThrow();
  });

  it("the owner can VOID an open question so the week can close; nobody else, and never a real answer", () => {
    const k = setup();
    deposit(k, A, 10 * VHP);
    at(1100);
    const q0 = post(k, 2, 1300, 1301, 1400);
    const q1 = post(k, 2, 1300, 1301, 1400);
    at(1200);
    answer(k, A, q0, 1);
    answer(k, A, q1, 1);
    at(1500);
    resolve(k, q0, 1);
    // the bot never resolves q1 (say its key was lost)
    at(2015);
    gK = k;
    as(A);
    MockVM.commitTransaction();
    gQ = q1;
    expect(() => { gK!.correct_question(new kpred.correct_question_arguments(gQ, 1000, hash32(3))); }).toThrow();
    as(OWNER);
    MockVM.commitTransaction();
    expect(() => { gK!.correct_question(new kpred.correct_question_arguments(gQ, 1, hash32(3))); }).toThrow();
    expect(MockVM.getErrorMessage()).toBe("an open question can only be voided (outcome 1000)");
    k.correct_question(new kpred.correct_question_arguments(q1, 1000, hash32(3)));
    const w0 = k.get_week(new kpred.get_week_arguments(0)).week!;
    expect(w0.resolved).toBe(2);
    expect(w0.closed).toBe(false);                   // v4: the void can still be corrected for close_delay
    at(2025); nobody(); k.close_week(new kpred.close_week_arguments(0));
    expect(k.get_week(new kpred.get_week_arguments(0)).week!.closed).toBe(true);
    expect(k.get_question(new kpred.get_question_arguments(q1)).question!.outcome).toBe(1000);
    // once closed, resolutions are final
    MockVM.commitTransaction();
    gQ = q0;
    expect(() => { gK!.correct_question(new kpred.correct_question_arguments(gQ, 0, hash32(3))); }).toThrow();
  });

  it("the owner can lower, raise (max 10 KOIN) or switch off the free-transaction limit", () => {
    const k = setup();
    deposit(k, A, 10 * VHP);
    at(1100);
    const q = post(k, 2, 1300, 1301, 1400);
    as(A);
    const good = Protobuf.encode(new kpred.answer_arguments(A, q, 1), kpred.answer_arguments.encode);
    setTx(0x0db52f40, good, VHP / 2, 1);
    expect(sponsor(k)).toBe(true);
    gK = k;
    MockVM.commitTransaction();
    expect(() => { gK!.set_sponsor_limit(new kpred.set_sponsor_limit_arguments(0)); }).toThrow();   // not the owner
    as(OWNER);
    MockVM.commitTransaction();
    expect(() => { gK!.set_sponsor_limit(new kpred.set_sponsor_limit_arguments(11 * VHP)); }).toThrow();
    k.set_sponsor_limit(new kpred.set_sponsor_limit_arguments(0));
    as(A);
    expect(sponsor(k)).toBe(false);                  // off: players pay their own Mana
    as(OWNER);
    k.set_sponsor_limit(new kpred.set_sponsor_limit_arguments(10 * VHP));
    as(A);
    setTx(0x0db52f40, good, 5 * VHP, 1);
    expect(sponsor(k)).toBe(true);
  });
});

describe("edge cases", () => {
  it("withdrawing everything after answering makes the week ineligible; withdrawing part keeps it, at the lower stake", () => {
    const k = setup();
    deposit(k, A, 10 * VHP);
    deposit(k, B, 10 * VHP);
    at(1100);
    const q0 = post(k, 2, 1300, 1301, 1400);
    const q1 = post(k, 2, 1300, 1301, 1400);
    at(1200);
    answer(k, A, q0, 1); answer(k, A, q1, 1);
    answer(k, B, q0, 1); answer(k, B, q1, 1);
    as(A);
    k.withdraw(new kpred.withdraw_arguments(A, 10 * VHP));   // all of it
    as(B);
    k.withdraw(new kpred.withdraw_arguments(B, 6 * VHP));    // part of it
    at(1500); resolve(k, q0, 1); resolve(k, q1, 1);
    at(2010);
    k.close_week(new kpred.close_week_arguments(0));
    const ra = k.settle(new kpred.settle_arguments(A, 0));
    expect(ra.eligible).toBe(false);
    expect(ra.points).toBe(0);
    const rb = k.settle(new kpred.settle_arguments(B, 0));
    expect(rb.eligible).toBe(true);
    expect(rb.points).toBe(2);
    expect(k.get_player(new kpred.get_player_arguments(B, 0)).entry!.stake).toBe(4 * VHP);
  });

  it("taking back only a not-yet-active top-up leaves this week's answers counting", () => {
    const k = setup();
    deposit(k, A, 10 * VHP);
    at(1100);
    const q0 = post(k, 2, 1300, 1301, 1400);
    const q1 = post(k, 2, 1300, 1301, 1400);
    at(1200);
    answer(k, A, q0, 1);
    deposit(k, A, 5 * VHP);                           // pending until week 1
    as(A);
    k.withdraw(new kpred.withdraw_arguments(A, 5 * VHP / 2));     // 2.5 of the pending top-up
    answer(k, A, q1, 1);                              // still allowed: this week's stake was not touched
    at(1500); resolve(k, q0, 1); resolve(k, q1, 1);
    at(2010);
    k.close_week(new kpred.close_week_arguments(0));
    const r = k.settle(new kpred.settle_arguments(A, 0));
    expect(r.eligible).toBe(true);
    expect(r.points).toBe(2);
    const p = k.get_player(new kpred.get_player_arguments(A, 1)).player!;
    expect(p.stake + p.pending).toBe(10 * VHP + 5 * VHP / 2);
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

// ───────────── automatic progression ─────────────
describe("automatic progression", () => {
  it("weeks close, settle and finalize as a side effect of normal play", () => {
    const k = setup();
    deposit(k, A, 10 * VHP);
    deposit(k, B, 10 * VHP);
    at(1100);
    const q0 = post(k, 2, 1300, 1301, 1400);
    const q1 = post(k, 2, 1300, 1301, 1400);
    at(1200);
    answer(k, A, q0, 1); answer(k, A, q1, 1);
    answer(k, B, q0, 0); answer(k, B, q1, 0);
    at(1500); resolve(k, q0, 1); resolve(k, q1, 1);
    give(KOIN_TAG, CONTRACT, 10 * VHP); give(MANA_TAG, CONTRACT, 10 * VHP);
    // Week 1: the operator posts a question after week 0's close delay → week 0 closes by itself.
    at(2020);
    const q2 = post(k, 2, 2300, 2301, 2400);
    expect(k.get_week(new kpred.get_week_arguments(0)).week!.closed).toBe(true);
    // A answers in week 1 during week 0's settlement window → A's week 0 is settled automatically.
    at(2050);
    answer(k, A, q2, 1);
    expect(k.get_player(new kpred.get_player_arguments(A, 0)).entry!.settled).toBe(true);
    expect(k.get_player(new kpred.get_player_arguments(B, 0)).entry!.settled).toBe(false); // B didn't play: not settled
    // After the settlement window, any action (here: compound) finalizes week 0.
    at(2200);
    nobody();
    k.compound(new kpred.compound_arguments());
    const w0 = k.get_week(new kpred.get_week_arguments(0)).week!;
    expect(w0.finalized).toBe(true);
    expect(w0.winners).toBe(1);
    as(A);
    expect(k.claim(new kpred.claim_arguments(A, 0)).reward).toBe(w0.pot);
  });
});

// ───────────── accounting: claim / withdraw timing never changes a week's measured gain ─────────────
let gGains: u64[] = [];
function timingScenario(early: bool, proportional: bool): u64[] {
  const k = setup();
  as(SEED);
  k.seed_deposit_vhp(new kpred.seed_deposit_vhp_arguments(1000 * VHP));
  k.seed_deposit_koin(new kpred.seed_deposit_koin_arguments(200 * VHP));
  deposit(k, A, 100 * VHP);
  deposit(k, B, 50 * VHP);
  at(1100);
  const q0 = post(k, 2, 1300, 1301, 1400);
  const q1 = post(k, 2, 1300, 1301, 1400);
  at(1200);
  answer(k, A, q0, 1); answer(k, A, q1, 1);
  answer(k, B, q0, 0); answer(k, B, q1, 0);
  give(KOIN_TAG, CONTRACT, 40 * VHP); give(MANA_TAG, CONTRACT, 40 * VHP);     // week 0 rewards: 40
  at(1500); resolve(k, q0, 1); resolve(k, q1, 1);
  at(2010);
  nobody();
  k.close_week(new kpred.close_week_arguments(0));
  k.settle(new kpred.settle_arguments(A, 0));
  k.settle(new kpred.settle_arguments(B, 0));
  at(2200);
  k.finalize_week(new kpred.finalize_week_arguments(0));
  if (early) {                                       // A claims its whole pot and B withdraws BEFORE week 1's rewards
    as(A); k.claim(new kpred.claim_arguments(A, 0));
    as(B); k.withdraw(new kpred.withdraw_arguments(B, 20 * VHP));
  }
  // Week 1 rewards: a fixed 25 KOIN, or 1% of everything the pool holds (production is proportional to VHP).
  const holdings = Tokens.testGet(VHP_TAG, CONTRACT) + Tokens.testGet(KOIN_TAG, CONTRACT);
  const r1: u64 = proportional ? holdings / 100 : 25 * VHP;
  give(KOIN_TAG, CONTRACT, r1); give(MANA_TAG, CONTRACT, r1);
  if (!early) {                                      // ...or AFTER them (but still before week 1 closes)
    as(A); k.claim(new kpred.claim_arguments(A, 0));
    as(B); k.withdraw(new kpred.withdraw_arguments(B, 20 * VHP));
  }
  at(3010);
  nobody();
  k.close_week(new kpred.close_week_arguments(1));
  const out: u64[] = [];
  out.push(k.get_week(new kpred.get_week_arguments(0)).week!.gain);
  out.push(k.get_week(new kpred.get_week_arguments(1)).week!.gain);
  out.push(r1);
  return out;
}

describe("accounting is locked to what the pool actually earned", () => {
  it("claiming or withdrawing early or late gives the same measured gain for every week", () => {
    const early = timingScenario(true, false);
    const late = timingScenario(false, false);
    expect(early[0]).toBe(40 * VHP);
    expect(late[0]).toBe(40 * VHP);
    expect(early[1]).toBe(25 * VHP);                 // exactly the rewards produced in week 1
    expect(late[1]).toBe(25 * VHP);
  });

  it("unclaimed rewards keep producing for the pool, and the gain is exactly what was produced", () => {
    const early = timingScenario(true, true);        // reward claimed before week 1 production
    const late = timingScenario(false, true);        // reward still in the pool during week 1 production
    expect(early[1]).toBe(early[2]);                 // measured gain == simulated production, to the unit
    expect(late[1]).toBe(late[2]);
    expect(late[1] > early[1]).toBe(true);           // the unclaimed VHP earned for the pool while it sat there
  });
});

// ───────────── randomized multi-week stress test ─────────────
let seedRng: u64 = 12345;
function rnd(n: u64): u64 {
  seedRng = (seedRng * 6364136223846793005 + 1442695040888963407);
  return (seedRng >> 33) % n;
}

let simClaims: u64 = 0, simWithdrawals: u32 = 0, simRollovers: u32 = 0, simWinners: u32 = 0;
function simulate(seed: u64): void {
    seedRng = seed;
    const k = setup();
    as(SEED);
    k.seed_deposit_vhp(new kpred.seed_deposit_vhp_arguments(2000 * VHP));
    k.seed_deposit_koin(new kpred.seed_deposit_koin_arguments(300 * VHP));
    const players: Uint8Array[] = [A, B, C, D, E];
    for (let i = 0; i < players.length; i++) deposit(k, players[i], (10 + rnd(90)) * VHP);
    let minted: u64 = 0, mintedSinceClose: u64 = 0, distributed: u64 = 0, claimedTotal: u64 = 0;
    for (let w: u64 = 0; w < 8; w++) {
      const base = GENESIS + w * WEEK;
      // Questions for the week
      at(base + 50);
      nobody();
      as(OPERATOR);
      const ids: u32[] = [];
      for (let n = 0; n < 3; n++) ids.push(post(k, 2 + <u32>rnd(3), base + 300, base + 301, base + 400));
      // Players: maybe top up, maybe answer
      for (let i = 0; i < players.length; i++) {
        const who = players[i];
        at(base + 100 + <u64>i);
        if (rnd(4) == 0) deposit(k, who, (1 + rnd(20)) * VHP);
        const pl = k.get_player(new kpred.get_player_arguments(who, w));
        if (pl.active_stake >= VHP && (pl.player!.void_week_plus_one != w + 1)) {
          for (let n = 0; n < ids.length; n++) {
            if (rnd(5) == 0) continue;
            const q = k.get_question(new kpred.get_question_arguments(ids[n])).question!;
            answer(k, who, ids[n], <u32>rnd(<u64>q.k));
          }
        }
      }
      // Block rewards trickle in during the week
      for (let r = 0; r < 3; r++) {
        const amt = (1 + rnd(30)) * VHP;
        give(KOIN_TAG, CONTRACT, amt); give(MANA_TAG, CONTRACT, amt);
        minted += amt; mintedSinceClose += amt;
      }
      // Someone withdraws part of their stake mid-week (voids their week)
      const wd = players[<i32>rnd(5)];
      at(base + 500);
      const st = k.get_player(new kpred.get_player_arguments(wd, w + 1));
      if (rnd(3) == 0 && st.player!.stake + st.player!.pending > 2 * VHP) {
        as(wd);
        k.withdraw(new kpred.withdraw_arguments(wd, VHP));
        simWithdrawals++;
      }
      // Resolve (after the windows are final)
      at(base + 600);
      for (let n = 0; n < ids.length; n++) {
        const q = k.get_question(new kpred.get_question_arguments(ids[n])).question!;
        resolve(k, ids[n], rnd(10) == 0 ? 1000 : <u32>rnd(<u64>q.k));
      }
      // Close: gain must equal exactly what was produced since the previous close.
      at(base + WEEK + 10);
      nobody();
      const before = k.get_week(new kpred.get_week_arguments(w)).week!;
      if (!before.closed) k.close_week(new kpred.close_week_arguments(w));
      const wk = k.get_week(new kpred.get_week_arguments(w)).week!;
      expect(wk.gain).toBe(mintedSinceClose + (w > 0 && k.get_week(new kpred.get_week_arguments(w - 1)).week!.rolled_over ? k.get_week(new kpred.get_week_arguments(w - 1)).week!.pot : 0));
      distributed += wk.fee + wk.retained + wk.pot;
      mintedSinceClose = 0;
      // Everyone gets settled, then the week is finalized
      for (let i = 0; i < players.length; i++) {
        const e = k.get_player(new kpred.get_player_arguments(players[i], w)).entry;
        if (e != null && !e.settled) k.settle(new kpred.settle_arguments(players[i], w));
      }
      at(base + WEEK + 10 + 101);
      const fz = k.get_week(new kpred.get_week_arguments(w)).week!;
      if (!fz.finalized) k.finalize_week(new kpred.finalize_week_arguments(w));
      // Random winners claim now (others later or never: unclaimed stays in the pool)
      const fw = k.get_week(new kpred.get_week_arguments(w)).week!;
      simWinners += fw.winners;
      if (fw.rolled_over) simRollovers++;
      if (!fw.rolled_over) {
        for (let i = 0; i < players.length; i++) {
          const e = k.get_player(new kpred.get_player_arguments(players[i], w)).entry;
          if (e != null && e.eligible && e.points >= fw.cutoff && !e.claimed && rnd(2) == 0) {
            as(players[i]);
            claimedTotal += k.claim(new kpred.claim_arguments(players[i], w)).reward;
          }
        }
      } else {
        distributed -= fw.pot;                         // a rolled-over pot is counted again in a later week's gain
      }
      // Books balance after every week: holdings cover everything owed.
      const s = k.get_state(new kpred.get_state_arguments());
      const t = s.totals!;
      const owed = t.total_stake + t.seed_vhp + t.seed_koin + t.owner_share + t.creator_fee + t.pots_outstanding;
      expect(s.vhp_balance + s.koin_balance >= owed).toBe(true);
      // Nothing earned is left unaccounted after a close — except a rolled-over pot, which waits for the next close.
      expect(s.vhp_balance + s.koin_balance - owed).toBe(fw.rolled_over ? fw.pot : 0);
    }
    // Over all weeks: everything produced was distributed exactly once (fees + shares + pots), minus a rolled-over
    // pot still waiting in the pool.
    const t = k.get_state(new kpred.get_state_arguments()).totals!;
    const last = k.get_week(new kpred.get_week_arguments(7)).week!;
    const waiting: u64 = last.rolled_over ? last.pot : 0;
    expect(distributed + waiting).toBe(minted);
    expect(claimedTotal <= distributed).toBe(true);
    expect(t.weeks_closed).toBe(8);
    expect(t.weeks_finalized).toBe(8);
    simClaims += claimedTotal;
}

describe("randomized 8-week simulations (5 different random seeds)", () => {
  it("every close measures exactly the rewards produced since the previous close; books always balance", () => {
    for (let sd: u64 = 1; sd <= 5; sd++) simulate(sd * 7919);
    // Make sure the simulations really exercised claims, withdrawals and winners.
    expect(simClaims > 0).toBe(true);
    expect(simWithdrawals > 0).toBe(true);
    expect(simWinners > 0).toBe(true);
  });
});

describe("listing players (for the bot and the website)", () => {
  it("pages through every player in address order with their entry for a week", () => {
    const k = setup();
    deposit(k, A, 10 * VHP);
    deposit(k, B, 20 * VHP);
    deposit(k, C, 30 * VHP);
    deposit(k, D, 40 * VHP);
    deposit(k, E, 50 * VHP);
    at(GENESIS + 10);
    const id = post(k, 2, GENESIS + 500, GENESIS + 500, GENESIS + 600);
    answer(k, B, id, 1);
    // page size 2 → 3 pages, every player exactly once, sorted, no duplicates
    let start = new Uint8Array(0);
    let seen = 0, withEntry = 0;
    let prev = new Uint8Array(0);
    for (let page = 0; page < 5; page++) {
      const rows = k.list_players(new kpred.list_players_arguments(start, 2, 0)).rows;
      if (rows.length == 0) break;
      for (let i = 0; i < rows.length; i++) {
        const a = rows[i].address!;
        expect(Base58.encode(a) != Base58.encode(prev)).toBe(true);
        prev = a;
        seen++;
        if (rows[i].entry != null) {
          withEntry++;
          expect(Base58.encode(a)).toBe(Base58.encode(B));
          expect(rows[i].entry!.stake).toBe(20 * VHP);
        }
        expect(rows[i].active_stake > 0).toBe(true);
      }
      start = rows[rows.length - 1].address!;
    }
    expect(seen).toBe(5);
    expect(withEntry).toBe(1);
    // limit 0 means the maximum page (50)
    expect(k.list_players(new kpred.list_players_arguments(new Uint8Array(0), 0, 0)).rows.length).toBe(5);
  });
});

describe("extreme edge cases", () => {
  it("a full week of 30 questions (v5 cap): the 31st is refused, a perfect score of 30 is counted and paid even when claimed 5 weeks later", () => {
    const k = setup();
    deposit(k, A, 10 * VHP);
    deposit(k, B, 10 * VHP);
    at(1100);
    for (let i = 0; i < 30; i++) post(k, 2, 1300, 1301, 1400);
    gK = k;
    as(OPERATOR);
    MockVM.commitTransaction();
    expect(() => { gK!.post_question(new kpred.post_question_arguments(2, 1300 * MS, 1301, 1400, hash32(1))); }).toThrow();
    expect(MockVM.getErrorMessage()).toBe("too many questions this week");
    at(1200);
    for (let i: u32 = 0; i < 30; i++) answer(k, A, i, 1);
    answer(k, B, 0, 0);
    answer(k, B, 1, 0);
    at(1500);
    for (let i: u32 = 0; i < 30; i++) resolve(k, i, 1);
    give(KOIN_TAG, CONTRACT, 100 * VHP);
    give(MANA_TAG, CONTRACT, 100 * VHP);
    at(2015);
    nobody();
    k.compound(new kpred.compound_arguments());               // any action closes the finished week
    expect(k.get_week(new kpred.get_week_arguments(0)).week!.closed).toBe(true);
    at(2016);
    expect(k.settle(new kpred.settle_arguments(A, 0)).points).toBe(30);
    expect(k.settle(new kpred.settle_arguments(B, 0)).points).toBe(0);
    // five weeks later, the reward is still there, exactly
    at(7000);
    as(A);
    const before = Tokens.testGet(VHP_TAG, A);
    expect(k.claim(new kpred.claim_arguments(A, 0)).reward).toBe(95 * VHP);
    expect(Tokens.testGet(VHP_TAG, A) - before).toBe(95 * VHP);
    const w0 = k.get_week(new kpred.get_week_arguments(0)).week!;
    expect(w0.cutoff).toBe(30);
    expect(w0.winners).toBe(1);
  });

  it("a week where every question is voided: nobody is eligible, the pot rolls into the next week's gain", () => {
    const k = setup();
    deposit(k, A, 10 * VHP);
    deposit(k, B, 10 * VHP);
    at(1100);
    const q0 = post(k, 2, 1300, 1301, 1400);
    const q1 = post(k, 2, 1300, 1301, 1400);
    at(1200);
    answer(k, A, q0, 1); answer(k, A, q1, 1);
    answer(k, B, q0, 0); answer(k, B, q1, 0);
    give(KOIN_TAG, CONTRACT, 100 * VHP);
    give(MANA_TAG, CONTRACT, 100 * VHP);
    at(1500);
    resolve(k, q0, 1000);
    resolve(k, q1, 1000);
    at(2015);
    nobody();
    k.compound(new kpred.compound_arguments());
    at(2016);
    expect(k.settle(new kpred.settle_arguments(A, 0)).eligible).toBe(false);
    expect(k.settle(new kpred.settle_arguments(B, 0)).eligible).toBe(false);
    at(2200);
    k.compound(new kpred.compound_arguments());               // finalizes week 0
    const w0 = k.get_week(new kpred.get_week_arguments(0)).week!;
    expect(w0.finalized).toBe(true);
    expect(w0.rolled_over).toBe(true);
    at(3015);
    k.compound(new kpred.compound_arguments());               // closes week 1 (no questions, no new rewards)
    const w1 = k.get_week(new kpred.get_week_arguments(1)).week!;
    expect(w1.closed).toBe(true);
    expect(w1.gain).toBe(95 * VHP);                          // the rolled-over pot, counted once more, nothing else
    expect(w1.pot).toBe(95 * VHP);                           // and not charged the fee a second time
  });

  it("option and timing boundaries are exact: 16 options max, answers until lock−1, resolve from window_end+61", () => {
    const k = setup();
    deposit(k, A, 10 * VHP);
    at(1100);
    gK = k;
    as(OPERATOR);
    MockVM.commitTransaction();
    expect(() => { gK!.post_question(new kpred.post_question_arguments(17, 1300 * MS, 1301, 1400, hash32(1))); }).toThrow();
    const q = post(k, 16, 1300, 1301, 1400);
    as(A);
    gQ = q;
    MockVM.commitTransaction();
    expect(() => { gK!.answer(new kpred.answer_arguments(A, gQ, 16)); }).toThrow();
    expect(MockVM.getErrorMessage()).toBe("no such option");
    at(1300);
    MockVM.commitTransaction();
    expect(() => { gK!.answer(new kpred.answer_arguments(A, gQ, 15)); }).toThrow();   // at the lock height: closed
    at(1299);
    answer(k, A, q, 15);                                       // one block before: accepted
    as(OPERATOR);
    at(1460);
    MockVM.commitTransaction();
    expect(() => { gK!.resolve_question(new kpred.resolve_question_arguments(gQ, 15, hash32(2))); }).toThrow();
    at(1461);
    resolve(k, q, 15);
    expect(k.get_question(new kpred.get_question_arguments(q)).question!.outcome).toBe(16);
  });

  it("withdrawing everything and re-depositing in the same week still voids that week, but not the next", () => {
    const k = setup();
    deposit(k, A, 10 * VHP);
    at(1100);
    const q0 = post(k, 2, 1300, 1301, 1400);
    at(1200);
    answer(k, A, q0, 1);
    as(A);
    k.withdraw(new kpred.withdraw_arguments(A, 10 * VHP));
    deposit(k, A, 10 * VHP);
    expect(k.get_player(new kpred.get_player_arguments(A, 0)).entry!.voided).toBe(true);
    // the re-deposit counts from week 1, and week 1 answers are fine
    expect(k.get_player(new kpred.get_player_arguments(A, 1)).active_stake).toBe(10 * VHP);
    at(1500);
    resolve(k, q0, 1);
    at(2015);
    nobody();
    k.compound(new kpred.compound_arguments());
    at(2100);
    const q1 = post(k, 2, 2300, 2301, 2400);
    at(2200);
    answer(k, A, q1, 0);
    expect(k.get_player(new kpred.get_player_arguments(A, 1)).entry!.voided).toBe(false);
  });

  it("a whale with 1 billion VHP and a minnow with 1 VHP are paid exactly (128-bit math, no overflow)", () => {
    const k = setup();
    give(VHP_TAG, A, 1_000_000_000 * VHP);
    deposit(k, A, 1_000_000_000 * VHP);
    deposit(k, B, VHP);
    at(1100);
    const q0 = post(k, 2, 1300, 1301, 1400);
    const q1 = post(k, 2, 1300, 1301, 1400);
    at(1200);
    answer(k, A, q0, 1); answer(k, A, q1, 1);
    answer(k, B, q0, 1); answer(k, B, q1, 1);
    give(KOIN_TAG, CONTRACT, 1_000_000 * VHP);
    give(MANA_TAG, CONTRACT, 1_000_000 * VHP);
    at(1500);
    resolve(k, q0, 1); resolve(k, q1, 1);
    at(2015);
    nobody();
    k.compound(new kpred.compound_arguments());
    at(2016);
    k.settle(new kpred.settle_arguments(A, 0));
    k.settle(new kpred.settle_arguments(B, 0));
    at(2200);
    as(A);
    const ra = k.claim(new kpred.claim_arguments(A, 0)).reward;
    as(B);
    const rb = k.claim(new kpred.claim_arguments(B, 0)).reward;
    const pot: u64 = 950_000 * VHP;                 // 95% of the 1,000,000 earned
    // v5: basket A (40%) counts stake up to 10 VHP, so 10 : 1; basket B (60%) by full stake, 1e9 : 1. Rounded down,
    // never more than the pot.
    const potA: u64 = pot * 4000 / 10000, potB: u64 = pot - potA;
    expect(near(rb, potA / 11 + potB / 1_000_000_001)).toBe(true);
    expect(ra + rb <= pot).toBe(true);
    expect(pot - ra - rb < 5).toBe(true);           // each basket rounds down per player: a few units of dust stay
  });
});

/** v5 reward of place r: basket A by rank x capped stake, basket B by rank x full stake (test model, floating point). */
function v5Expected(pa: f64, pb: f64, awT: f64, bwT: f64, r: u64, capped: u64, stake: u64): u64 {
  return <u64>(pa * <f64>(rankWeight(r) * capped) / awT) + <u64>(pb * <f64>(rankWeight(r) * stake) / bwT);
}
/** One week in which player X holds 10 VHP, either in one wallet or split into ten 1-VHP wallets; X's total reward. */
function splitWorld(split: bool): u64 {
  const k = setup();
  const X: Uint8Array[] = split ? [A, B, C, D, E, P6, P7, P8, P9, P10] : [A];
  for (let i = 0; i < X.length; i++) { give(VHP_TAG, X[i], 100 * VHP); give(MANA_TAG, X[i], 10 * VHP); }
  for (let i = 0; i < X.length; i++) deposit(k, X[i], (split ? 1 : 10) * VHP);
  // 30 rivals so the top 30% is wide enough to hold every X wallet: rivals score less than X but are staked.
  const rivals: Uint8Array[] = [];
  for (let i = 0; i < 30; i++) { const r = Base58.decode(RIVALS[i]); rivals.push(r); give(VHP_TAG, r, 100 * VHP); give(MANA_TAG, r, 10 * VHP); deposit(k, r, 5 * VHP); }
  at(1100);
  const q0 = post(k, 2, 1300, 1301, 1400);
  const q1 = post(k, 2, 1300, 1301, 1400);
  at(1200);
  for (let i = 0; i < X.length; i++) { answer(k, X[i], q0, 1); answer(k, X[i], q1, 1); }      // 2 points
  for (let i = 0; i < rivals.length; i++) { answer(k, rivals[i], q0, 1); answer(k, rivals[i], q1, i < 10 ? 1 : 0); }
  at(1500); resolve(k, q0, 1); resolve(k, q1, 1);
  give(KOIN_TAG, CONTRACT, 1000 * VHP); give(MANA_TAG, CONTRACT, 1000 * VHP);
  at(2010);
  k.close_week(new kpred.close_week_arguments(0));
  for (let i = 0; i < X.length; i++) k.settle(new kpred.settle_arguments(X[i], 0));
  for (let i = 0; i < rivals.length; i++) k.settle(new kpred.settle_arguments(rivals[i], 0));
  at(2200);
  k.finalize_week(new kpred.finalize_week_arguments(0));
  let sum: u64 = 0;
  for (let i = 0; i < X.length; i++) { as(X[i]); sum += k.claim(new kpred.claim_arguments(X[i], 0)).reward; }
  return sum;
}

function bpsT(amount: u64, b: u64): u64 { return amount * b / 10000; }

describe("free players", () => {
  it("score points and appear in entries, are never eligible or paid, and the pool never pays their Mana", () => {
    const k = setup();
    deposit(k, A, 10 * VHP);
    deposit(k, B, 10 * VHP);
    at(1100);
    const q0 = post(k, 2, 1300, 1301, 1400);
    const q1 = post(k, 2, 1300, 1301, 1400);
    // E has no stake: the pool won't sponsor E's answer
    as(E);
    setTx(0x0db52f40, Protobuf.encode(new kpred.answer_arguments(E, q0, 1), kpred.answer_arguments.encode), VHP / 2, 1);
    expect(sponsor(k)).toBe(false);
    as(A);
    setTx(0x0db52f40, Protobuf.encode(new kpred.answer_arguments(A, q0, 1), kpred.answer_arguments.encode), VHP / 2, 1);
    expect(sponsor(k)).toBe(true);
    at(1200);
    answer(k, A, q0, 1); answer(k, A, q1, 0);       // 1 right
    answer(k, B, q0, 0); answer(k, B, q1, 0);       // 0 right
    answer(k, E, q0, 1); answer(k, E, q1, 1);       // 2 right: best score, but plays free
    at(1500); resolve(k, q0, 1); resolve(k, q1, 1);
    give(KOIN_TAG, CONTRACT, 10 * VHP); give(MANA_TAG, CONTRACT, 10 * VHP);
    at(2010);
    nobody();
    k.compound(new kpred.compound_arguments());     // closes week 0
    setTx(0x6868e83d, Protobuf.encode(new kpred.settle_arguments(E, 0), kpred.settle_arguments.encode), VHP / 2, 1);
    expect(sponsor(k)).toBe(false);                  // nobody pays the pool's Mana to settle a free entry
    const se = k.settle(new kpred.settle_arguments(E, 0));
    expect(se.points).toBe(2);
    expect(se.eligible).toBe(false);
    k.settle(new kpred.settle_arguments(A, 0));
    k.settle(new kpred.settle_arguments(B, 0));
    at(2200);
    k.compound(new kpred.compound_arguments());     // finalizes
    const w0 = k.get_week(new kpred.get_week_arguments(0)).week!;
    expect(w0.eligible_players).toBe(2);             // the free player doesn't count toward the 30% line
    expect(w0.cutoff).toBe(1);
    expect(w0.winners).toBe(1);
    as(A);
    expect(k.claim(new kpred.claim_arguments(A, 0)).reward).toBe(w0.pot);   // A takes the whole pot
    gK = k;
    as(E);
    MockVM.commitTransaction();
    expect(() => { gK!.claim(new kpred.claim_arguments(E, 0)); }).toThrow();
    expect(MockVM.getErrorMessage()).toBe("not eligible that week");
  });
});

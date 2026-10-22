/**
 * Proof test (audit fix check, AB-024): the owner key cannot hold a resolved week open with corrections.
 *   INS-H1  a correction to the same outcome does not restart the correction time.
 *   INS-H2  repeated last-moment corrections cannot keep a resolved week open without bound.
 *   HOLDS   the quarter-close_delay cutoff is exact to the millisecond; a change leaves a full close_delay before the close.
 * INS-H3 and INS-H5 of the original file are not part of the decided fixes and were left out. INS-H2's loop stops at
 * the decided bound, where the next change must be refused (see the comment there).
 * Harness: copied from game/assembly/__tests__/Kpred.v4.spec.ts. Week 0 = blocks 1000..2000 x 2800 ms, close_delay = 10 blocks.
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

// ───────────── insider red-team extras ─────────────
const THIEF = P6;                                   // a wallet controlled by whoever holds a stolen key
const CD: u64 = 10 * MS;                            // close_delay in this harness (init above)
const TL: u64 = 50 * MS;                            // timelock_length in this harness
const EXP: u64 = 7 * 86_400_000;                    // ANNOUNCEMENT_EXPIRY in Kpred.ts
/** A block at height h whose timestamp is exactly t ms (to hit millisecond boundaries). */
function atT(h: u64, t: u64): void {
  MockVM.setBlock(new protocol.block(new Uint8Array(0), new protocol.block_header(new Uint8Array(0), h, t)));
  System.resetCache();
}
function atMs(t: u64): void { atT(t / MS, t); }
function both(a: Uint8Array, b: Uint8Array): void {
  MockVM.setAuthorities([
    new MockVM.MockAuthority(authority.authorization_type.contract_call, a, true),
    new MockVM.MockAuthority(authority.authorization_type.contract_call, b, true),
  ]);
}
/** Earliest close of week w, recomputed the way Kpred.closeAt does. */
function closeAtOf(k: Kpred, w: u64): u64 {
  const wk = k.get_week(new kpred.get_week_arguments(w)).week!;
  const a = (GENESIS + (w + 1) * WEEK) * MS + CD;
  const b = wk.last_resolved_time + CD;
  return a > b ? a : b;
}

/** Week 0 with two questions posted, answered and resolved on time (both option 1). Returns q0. */
function resolvedWeek(k: Kpred): u32 {
  deposit(k, A, 10 * VHP);
  deposit(k, B, 10 * VHP);
  at(1100);
  const q0 = post(k, 2, 1300, 1301, 1400);
  const q1 = post(k, 2, 1300, 1301, 1400);
  at(1200);
  answer(k, A, q0, 1); answer(k, A, q1, 1);
  answer(k, B, q0, 0); answer(k, B, q1, 1);
  at(1500); resolve(k, q0, 1); resolve(k, q1, 1);
  return q0;
}

describe("INSIDER owner key: holding a week open through the correction window", () => {
  it("INS-H1 a correction to the SAME outcome must not restart the correction time", () => {
    const k = setup();
    const q0 = resolvedWeek(k);
    at(2007);                                         // allowed time for a change (close at 2010)
    as(OWNER);
    k.correct_question(new kpred.correct_question_arguments(q0, 1, hash32(4)));   // same option, new data hash
    expect(k.get_question(new kpred.get_question_arguments(q0)).question!.outcome).toBe(2);
    at(2010);                                         // the close time the players were shown
    nobody();
    gK = k;
    MockVM.commitTransaction();
    expect(() => { gK!.close_week(new kpred.close_week_arguments(0)); }).not.toThrow(
      "INS-H1: a no-op correction (same outcome) pushed the close by close_delay; repeatable, and invisible to the bot's correctionCheck");
  });

  it("INS-H2 repeated last-moment corrections must not keep a resolved week open without bound", () => {
    const k = setup();
    const q0 = resolvedWeek(k);
    as(OWNER);
    for (let i = 0; i < 20; i++) {
      const t = closeAtOf(k, 0) - CD / 4;            // the last instant a change is allowed
      atMs(t);
      // Past weekEnd + 2 x close_delay a change must be refused (a refused direct call would abort this AssemblyScript
      // test, so that call is made inside expect). The close below is still checked.
      if (t + CD / 4 > (GENESIS + WEEK) * MS + 2 * CD) {
        gK = k; gQ = q0; gOpt = <u32>(i % 2);
        MockVM.commitTransaction();
        expect(() => { gK!.correct_question(new kpred.correct_question_arguments(gQ, gOpt, hash32(77))); }).toThrow(
          "INS-H2: a correction after weekEnd + 2 x close_delay was accepted");
        break;
      }
      k.correct_question(new kpred.correct_question_arguments(q0, <u32>(i % 2), hash32(<u8>(20 + i))));
    }
    // Generous bound: anyone can close by week end + 4 x close_delay whatever the owner key does.
    atMs((GENESIS + WEEK) * MS + 4 * CD);
    nobody();
    gK = k;
    MockVM.commitTransaction();
    expect(() => { gK!.close_week(new kpred.close_week_arguments(0)); }).not.toThrow(
      "INS-H2: 20 corrections at closeAt - close_delay/4 held week 0 open ~15 x close_delay past its close; no cap, repeatable forever");
  });

  it("HOLDS the change cutoff is exact to the ms, and every change leaves a full close_delay before the close", () => {
    const k = setup();
    const q0 = resolvedWeek(k);
    const ca = closeAtOf(k, 0);
    gK = k; gQ = q0;
    as(OWNER);
    atMs(ca - CD / 4 + 1);
    MockVM.commitTransaction();
    expect(() => { gK!.correct_question(new kpred.correct_question_arguments(gQ, 0, hash32(4))); }).toThrow();
    atMs(ca - CD / 4);
    k.correct_question(new kpred.correct_question_arguments(q0, 0, hash32(5)));     // flipped at the last instant
    const ca2 = closeAtOf(k, 0);
    expect(ca2).toBe(ca - CD / 4 + CD, "a last-instant change must restart a full close_delay");
    atMs(ca2 - 1);
    nobody();
    MockVM.commitTransaction();
    expect(() => { gK!.close_week(new kpred.close_week_arguments(0)); }).toThrow();
    // the operator cannot re-resolve a resolved question
    as(OPERATOR);
    MockVM.commitTransaction();
    expect(() => { gK!.resolve_question(new kpred.resolve_question_arguments(gQ, 1, hash32(6))); }).toThrow();
    atMs(ca2);
    nobody();
    k.close_week(new kpred.close_week_arguments(0));
    expect(k.get_question(new kpred.get_question_arguments(q0)).question!.outcome).toBe(1);
  });
});

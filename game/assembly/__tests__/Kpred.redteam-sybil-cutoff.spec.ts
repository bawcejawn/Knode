/**
 * Audit Bot THIEF red-team test for Knode (commit 6b37c46).
 *
 * ATTACK (inflate your share of the weekly pot with cheap, fully-refundable sybil accounts):
 *   finalize_week picks winners as "the top 30% of ELIGIBLE players by HEADCOUNT" using
 *   `need = ceil(wk.eligible_players * 30 / 100)` (Kpred.ts:669). Eligibility only requires
 *   `counted > 1 && e.stake >= min_stake` (Kpred.ts:521) — it does NOT require any points, and a
 *   score of 0 can never win. So an attacker spins up extra accounts that each stake the minimum,
 *   answer >=2 questions deliberately WRONG (guaranteed 0 points) and are "eligible". Those
 *   zero-score accounts can never win themselves, but they pad eligible_players, which raises `need`
 *   and forces the winners' cutoff DOWN — dragging lower-scoring accounts into the paying winners'
 *   circle and diluting the honest top scorer's (house-funded, 65%) basket A.
 *
 *   Worse: the stake is NOT consumed by playing. The weekly reward is paid on top of the stake, and
 *   stake is withdrawable in full as soon as the scoring week is over (Kpred.withdraw). So each
 *   winner slot costs the attacker only a ~1-week VHP lock-up: near-zero. One actor running the
 *   mid-score accounts as well captures pot that honest selection would have denied them.
 *
 * Here: A scores 2, B scores 1, C scores 0 (3 honest eligible players). Honestly, top-30% of 3 => 1
 * winner (A only). The attacker adds 7 zero-score eligible sybils. Now 30% of 10 => need 3, the
 * cutoff falls to 1 and B (a non-top account) becomes a paid winner, so A's basket-A share is halved.
 *
 * Asserts the SAFE behaviour: accounts that score 0 (and can never win) must not change who wins.
 * FAILS before the fix (B is dragged in as a winner / B gets paid), PASSES after.
 */
import { Base58, MockVM, authority, chain, System, protocol } from "@koinos/sdk-as";
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

const VHP: u64 = 100_000_000;
const KOIN_TAG: u8 = 1, VHP_TAG: u8 = 2, MANA_TAG: u8 = 3;
const GENESIS: u64 = 1000, WEEK: u64 = 1000;
const MS: u64 = 2800;

// ───────────── harness (copied from game/assembly/__tests__/Kpred.spec.ts, unchanged) ─────────────
function at(h: u64): void {
  MockVM.setBlock(new protocol.block(new Uint8Array(0), new protocol.block_header(new Uint8Array(0), h, h * MS)));
  System.resetCache();
}
function as(acct: Uint8Array): void {
  MockVM.setAuthorities([new MockVM.MockAuthority(authority.authorization_type.contract_call, acct, true)]);
}
function nobody(): void { MockVM.setAuthorities([]); }
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
  for (let n = 0; n < 3; n++) {
    const who = n == 0 ? A : n == 1 ? B : C;
    give(VHP_TAG, who, 1000 * VHP);
    give(KOIN_TAG, who, 1000 * VHP);
    give(MANA_TAG, who, 1000 * VHP);
  }
  give(VHP_TAG, SEED, 5000 * VHP);
  return k;
}
function hash32(n: u8): Uint8Array { const h = new Uint8Array(32); h.fill(n); return h; }
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

// distinct 25-byte sybil address for index n
function sybil(n: i32): Uint8Array {
  const a = new Uint8Array(25);
  a[0] = 1; a[1] = <u8>(n & 0xff); a[2] = <u8>((n >> 8) & 0xff); a[24] = 0x5a;
  return a;
}

let gK: Kpred | null = null;

// Runs one full week: honest A(2 pts), B(1 pt), C(0 pts) plus `nSybils` zero-score eligible sybils.
// Returns winner count after finalize.
function runWeek(nSybils: i32): Kpred {
  const k = setup();
  as(SEED);
  k.seed_deposit_vhp(new kpred.seed_deposit_vhp_arguments(1000 * VHP));   // house producer: makes basket A real
  deposit(k, A, 10 * VHP);
  deposit(k, B, 10 * VHP);
  deposit(k, C, 10 * VHP);
  for (let n = 0; n < nSybils; n++) {
    const s = sybil(n);
    give(VHP_TAG, s, 20 * VHP);
    give(MANA_TAG, s, 20 * VHP);
    deposit(k, s, 10 * VHP);
  }
  at(1100);
  const q0 = post(k, 2, 1300, 1301, 1400);
  const q1 = post(k, 2, 1300, 1301, 1400);
  at(1200);
  answer(k, A, q0, 1); answer(k, A, q1, 1);   // 2 correct
  answer(k, B, q0, 1); answer(k, B, q1, 0);   // 1 correct
  answer(k, C, q0, 0); answer(k, C, q1, 0);   // 0 correct, eligible (counted 2)
  for (let n = 0; n < nSybils; n++) {
    const s = sybil(n);
    answer(k, s, q0, 0); answer(k, s, q1, 0); // deliberately wrong: 0 points, but eligible
  }
  at(1500); resolve(k, q0, 1); resolve(k, q1, 1);
  give(KOIN_TAG, CONTRACT, 100 * VHP); give(MANA_TAG, CONTRACT, 100 * VHP);  // block rewards earned
  at(2010);
  k.close_week(new kpred.close_week_arguments(0));
  nobody();
  k.settle(new kpred.settle_arguments(A, 0));
  k.settle(new kpred.settle_arguments(B, 0));
  k.settle(new kpred.settle_arguments(C, 0));
  for (let n = 0; n < nSybils; n++) k.settle(new kpred.settle_arguments(sybil(n), 0));
  at(2200);
  k.finalize_week(new kpred.finalize_week_arguments(0));
  return k;
}

describe("THIEF: cheap zero-score sybils inflate the winners' cutoff", () => {
  it("honest baseline: top-30% of 3 real players is 1 winner (A only)", () => {
    const k = runWeek(0);
    const fw = k.get_week(new kpred.get_week_arguments(0)).week!;
    expect(fw.winners).toBe(1, "baseline: only the single top scorer should win");
    expect(fw.cutoff).toBe(2, "baseline cutoff is 2 points");
  });

  it("zero-score sybils must NOT drag extra accounts into the paying winners' circle", () => {
    const k = runWeek(7);
    const fw = k.get_week(new kpred.get_week_arguments(0)).week!;
    // SAFE: accounts that scored 0 can never win, so the honest winner set (A only) must be unchanged.
    expect(fw.winners).toBe(1, "THIEF: zero-score sybils padded eligible_players and lowered the cutoff, inflating the winner set");

    // And the money: B scored below A and should not be paid. On the vulnerable code the cutoff fell
    // to 1 and B becomes a winner that siphons the house-funded pot away from the honest top scorer.
    as(B);
    gK = k;
    MockVM.commitTransaction();
    expect(() => { gK!.claim(new kpred.claim_arguments(B, 0)); }).toThrow("THIEF: a below-cutoff account was paid because sybils lowered the cutoff");
  });

  it("the sybil stake is fully refundable: winner slots cost the attacker nothing", () => {
    const k = runWeek(7);
    // After the scoring week the attacker pulls every sybil's stake back out, unharmed.
    for (let n = 0; n < 7; n++) {
      const s = sybil(n);
      const before = Tokens.testGet(VHP_TAG, s);
      as(s);
      k.withdraw(new kpred.withdraw_arguments(s, 10 * VHP));
      expect(Tokens.testGet(VHP_TAG, s)).toBe(before + 10 * VHP, "sybil stake returned in full");
    }
  });
});

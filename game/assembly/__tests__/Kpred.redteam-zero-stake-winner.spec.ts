/**
 * Audit Bot THIEF red-team test for Knode (commit 6b37c46).
 *
 * ATTACK (win the real VHP pot with ZERO stake when min_stake == 0):
 *   A player's eligibility is `!voided && counted > 1 && e.stake >= c.min_stake` (Kpred.ts:521).
 *   min_stake is fixed at init and has no setter. If the operator ever initialises with min_stake = 0,
 *   then e.stake(0) >= 0 is true, so a pure free player who NEVER staked a single unit is "eligible",
 *   can be a winner, and `claim` pays them real VHP out of the pot. Because every winner has 0 stake,
 *   `bw.isZero()` triggers and the whole pot collapses into basket A (Kpred.ts:707), so the
 *   zero-stake player walks away with the entire week's pot — pure block-production earnings of the
 *   seed/house, taken for nothing.
 *
 * This file initialises with min_stake = 0 and shows a never-staked account draining the pot.
 *
 * Adapted for v4 (in the repo): init and set_min_stake now refuse min_stake = 0, so the test first checks that, then
 * writes min_stake = 0 straight into storage (the only way left to reach that state) and runs the same attack.
 * A refused claim now throws, so the last step expects the refusal instead of a reward of 0. The attack and the
 * safe outcome (the never-staked player is not eligible and is not paid) are unchanged.
 *
 * Asserts the SAFE behaviour: an account that never staked cannot receive VHP from the pot.
 * FAILS before the fix (reward > 0), PASSES after (claim refused / reward 0).
 */
import { Base58, MockVM, authority, chain, System, protocol } from "@koinos/sdk-as";
import { Kpred } from "../Kpred";
import { Tokens } from "../Tokens";
import { kpred } from "../proto/kpred";

const CONTRACT = Base58.decode("1DQzuCcTKacbs9GGScRTU1Hc8BsyARTPqe");
const OWNER = Base58.decode("1DQzuCcTKacbs9GGScRTU1Hc8BsyARTPqG");
const OPERATOR = Base58.decode("1DQzuCcTKacbs9GGScRTU1Hc8BsyARTPqK");
const SEED = Base58.decode("1DQzuCcTKacbs9GGScRTU1Hc8BsyARTPqP");
const THIEF = Base58.decode("1PWeFG4pPtjZZoYvcmGb6mYhMYJjnkHrmz");

const VHP: u64 = 100_000_000;
const KOIN_TAG: u8 = 1, VHP_TAG: u8 = 2, MANA_TAG: u8 = 3;
const GENESIS: u64 = 1000, WEEK: u64 = 1000;
const MS: u64 = 2800;

// ───────────── harness (copied from game/assembly/__tests__/Kpred.spec.ts) ─────────────
function at(h: u64): void {
  MockVM.setBlock(new protocol.block(new Uint8Array(0), new protocol.block_header(new Uint8Array(0), h, h * MS)));
  System.resetCache();
}
function as(acct: Uint8Array): void {
  MockVM.setAuthorities([new MockVM.MockAuthority(authority.authorization_type.contract_call, acct, true)]);
}
function nobody(): void { MockVM.setAuthorities([]); }
function give(tag: u8, who: Uint8Array, amount: u64): void { Tokens.testSet(tag, who, Tokens.testGet(tag, who) + amount); }
function hash32(n: u8): Uint8Array { const h = new Uint8Array(32); h.fill(n); return h; }

// Same as the repo setup() but with min_stake = 0.
function setupZeroMin(): Kpred {
  MockVM.reset();
  MockVM.setContractId(CONTRACT);
  MockVM.setContractArguments(CONTRACT);
  MockVM.setEntryPoint(0);
  MockVM.setCaller(new chain.caller_data(new Uint8Array(0), chain.privilege.user_mode));
  MockVM.setContractMetadata(new chain.contract_metadata_object(new Uint8Array(0), false, false, false, false));
  MockVM.setHeadInfo(new chain.head_info(null, 0, 1));
  at(100);
  const k = new Kpred();
  // min_stake = 0 (the only change from the repo's setup). v4 refuses it at init ...
  gK = k;
  MockVM.commitTransaction();
  expect(() => {
    gK!.init(new kpred.init_arguments(OWNER, OPERATOR, SEED, GENESIS * MS, WEEK * MS, 10 * MS, 100 * MS, 50 * MS, 0, VHP));
  }).toThrow("v4: init must refuse min_stake = 0");
  // ... so put it into storage directly, as if it had been stored some other way.
  k.init(new kpred.init_arguments(OWNER, OPERATOR, SEED, GENESIS * MS, WEEK * MS, 10 * MS, 100 * MS, 50 * MS, VHP, VHP));
  const c = k.config.get()!;
  c.min_stake = 0;
  k.config.put(c);
  give(VHP_TAG, THIEF, 1000 * VHP);
  give(MANA_TAG, THIEF, 1000 * VHP);
  return k;
}
let gK: Kpred | null = null;
let gWho: Uint8Array = new Uint8Array(0);

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

describe("THIEF: zero-stake free player drains the pot when min_stake == 0", () => {
  it("a player who never staked must not be paid from the pot", () => {
    const k = setupZeroMin();
    // THIEF never deposits anything. Just answers two questions correctly (free play).
    at(1100);
    const q0 = post(k, 2, 1300, 1301, 1400);
    const q1 = post(k, 2, 1300, 1301, 1400);
    at(1200);
    answer(k, THIEF, q0, 1); answer(k, THIEF, q1, 1);   // 2 correct, counted 2, stake 0
    at(1500); resolve(k, q0, 1); resolve(k, q1, 1);
    // The node earned 100 KOIN of block rewards (the seed/house produced it, not the thief).
    give(KOIN_TAG, CONTRACT, 100 * VHP); give(MANA_TAG, CONTRACT, 100 * VHP);
    at(2010);
    k.close_week(new kpred.close_week_arguments(0));
    nobody();
    const s = k.settle(new kpred.settle_arguments(THIEF, 0));
    // SAFE: a zero-stake account must never be eligible for a share of the pot.
    expect(s.eligible).toBe(false, "THIEF: a never-staked player was made eligible for the pot");
    at(2200);
    k.finalize_week(new kpred.finalize_week_arguments(0));
    as(THIEF);
    gK = k; gWho = THIEF;
    MockVM.commitTransaction();
    expect(() => { gK!.claim(new kpred.claim_arguments(gWho, 0)); }).toThrow("THIEF: a never-staked player was paid real VHP out of the house's earnings");
  });
});

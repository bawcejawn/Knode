/**
 * Proof test (audit fix check, AB-024): changes to a posted result end at a hard bound after the week
 * (weekEnd + 2 x close_delay), and the week then closes by weekEnd + 3 x close_delay.
 * Harness: copied from game/assembly/__tests__/Kpred.v4.spec.ts.
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
const D = Base58.decode("19GYjDBVXU7keLbYvMLazsGQn3GTWHjHkK");
const E = Base58.decode("159myq5YUhhoVWu3wsHKHiJYKPKGUrGiyv");

const VHP: u64 = 100_000_000;
const KOIN_TAG: u8 = 1, VHP_TAG: u8 = 2, MANA_TAG: u8 = 3;
const GENESIS: u64 = 1000, WEEK: u64 = 1000;
const MS: u64 = 2800;
const CLOSE_DELAY_BLOCKS: u64 = 10;                     // init below: close_delay = 10 * MS
const HOLD_DELAYS: u64 = 2;                             // proposed: corrections end at weekEnd + 2 × close_delay

function at(h: u64): void {
  MockVM.setBlock(new protocol.block(new Uint8Array(0), new protocol.block_header(new Uint8Array(0), h, h * MS)));
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
  const i = new kpred.init_arguments(OWNER, OPERATOR, SEED, GENESIS * MS, WEEK * MS, 10 * MS, 100 * MS, 50 * MS, VHP, VHP);
  k.init(i);
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

let gK: Kpred | null = null;
let gQ: u32 = 0;
let gOut: u32 = 0;

describe("SAB-HOLD: the owner cannot hold a finished week open forever by re-correcting a result", () => {
  it("corrections to a posted result end at a hard bound after the week, and the week then closes", () => {
    const k = setup();
    deposit(k, A, 10 * VHP);
    at(1100);
    const q0 = post(k, 2, 1300, 1301, 1400);
    const q1 = post(k, 2, 1300, 1301, 1400);
    at(1200);
    answer(k, A, q0, 1); answer(k, A, q1, 1);
    at(1500); resolve(k, q0, 1); resolve(k, q1, 1);      // nominal close: weekEnd (2000) + close_delay = 2010

    const weekEnd: u64 = GENESIS + WEEK;
    const limit: u64 = weekEnd + HOLD_DELAYS * CLOSE_DELAY_BLOCKS; // 2020
    // The owner flips q0 every 7 blocks (< 3/4 of close_delay): each change is accepted today and moves the close.
    let t: u64 = 2007;
    let out: u32 = 0;
    as(OWNER);
    while (t * 4 + CLOSE_DELAY_BLOCKS <= limit * 4) {        // t + close_delay/4 <= limit: allowed under the bound too
      at(t);
      as(OWNER);
      k.correct_question(new kpred.correct_question_arguments(q0, out, hash32(<u8>(10 + t % 200))));
      out = out == 0 ? 1 : 0;
      t += 7;
    }
    // t = 2021: past the bound. Today closeAt = 2014 + 10 = 2024 and 2021 + 2.5 <= 2024, so it is ACCEPTED (the hold).
    at(t);
    as(OWNER);
    MockVM.commitTransaction();
    gK = k; gQ = q0; gOut = out;
    expect(() => { gK!.correct_question(new kpred.correct_question_arguments(gQ, gOut, hash32(99))); })
      .toThrow("SAB-HOLD: a correction after weekEnd + 2 x close_delay was accepted, pushing the close again (repeatable forever)");

    // The week closes by weekEnd + (HOLD_DELAYS + 1) × close_delay.
    at(weekEnd + (HOLD_DELAYS + 1) * CLOSE_DELAY_BLOCKS);
    nobody();
    k.close_week(new kpred.close_week_arguments(0));
    expect(k.get_week(new kpred.get_week_arguments(0)).week!.closed).toBe(true, "SAB-HOLD: the week is closed by weekEnd + 3 x close_delay");
  });
});

describe("the correction bound follows a late result", () => {
  it("a question resolved after the bound (bot down) can still be corrected, and the week still closes", () => {
    const k = setup();
    deposit(k, A, 10 * VHP);
    at(1100);
    const q0 = post(k, 2, 1300, 1301, 1400);
    const q1 = post(k, 2, 1300, 1301, 1400);
    at(1200);
    answer(k, A, q0, 1); answer(k, A, q1, 1);
    at(1500); resolve(k, q0, 1);
    at(2050); resolve(k, q1, 1);                          // late: past weekEnd (2000) + 2 x close_delay
    at(2052);
    as(OWNER);
    k.correct_question(new kpred.correct_question_arguments(q1, 0, hash32(50)));
    expect(k.get_question(new kpred.get_question_arguments(q1)).question!.outcome).toBe(1, "the late result was corrected");
    // A no-op change (same outcome) at the last allowed moment does not move the close (2052 + 10 = 2062).
    at(2059);
    as(OWNER);
    k.correct_question(new kpred.correct_question_arguments(q1, 0, hash32(51)));
    at(2062);
    nobody();
    k.close_week(new kpred.close_week_arguments(0));
    expect(k.get_week(new kpred.get_week_arguments(0)).week!.closed).toBe(true);
  });
});

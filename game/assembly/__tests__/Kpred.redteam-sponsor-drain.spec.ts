// Red team (SABOTEUR persona) attack test, Knode commit 6b37c46.
// Attack: drain the pool's Mana with sponsored transactions, as cheaply as possible.
//   1. Each staked account (min_stake = 1 VHP on mainnet) gets EVERY answer of the week sponsored
//      (30 questions/week in game.json, up to 64 allowed), each with an rc_limit up to max_sponsor_rc
//      (2 KOIN on mainnet). The pool's worst-case Mana exposure per 1 VHP of sybil stake per week is
//      therefore ~30 x 2 = 60 KOIN, and the stake is not lost (it keeps earning and can be withdrawn).
//   2. The answer arguments are decoded with a protobuf reader that skips unknown fields, so a
//      sponsored answer can carry junk bytes (bigger transaction = more network Mana billed to the
//      pool) and sponsorOk still says yes.
// The pool's Mana is also what compound() needs to turn produced KOIN back into VHP, what KOIN
// payouts need, and what every other player's free transaction needs.
// Asserts the SAFE behaviour: FAILS while the attack works.
// Harness copied unchanged from game/assembly/__tests__/Kpred.spec.ts.
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


describe("RED TEAM saboteur: the pool's sponsored Mana cannot be farmed by dust stakers", () => {
  it("a sponsored answer whose arguments carry junk bytes is refused", () => {
    const k = setup();
    deposit(k, A, 10 * VHP);
    at(1100);
    const q = post(k, 2, 1300, 1301, 1400);
    as(A);
    const good = Protobuf.encode(new kpred.answer_arguments(A, q, 1), kpred.answer_arguments.encode);
    setTx(0x0db52f40, good, VHP / 2, 1);
    expect(sponsor(k)).toBe(true);                     // (context) the honest form is sponsored
    // Same answer, plus an unknown field 15 (wire type 2) holding 600 junk bytes.
    const pad = new Uint8Array(good.length + 3 + 600);
    pad.set(good, 0);
    pad[good.length] = 122;                            // (15 << 3) | 2
    pad[good.length + 1] = 0xd8; pad[good.length + 2] = 0x04;   // varint 600
    for (let i = 0; i < 600; i++) pad[good.length + 3 + i] = 0x41;
    setTx(0x0db52f40, pad, VHP / 2, 1);
    expect(sponsor(k)).toBe(false, "SABOTEUR: the pool agreed to pay for an answer padded with 600 junk bytes");
  });

  it("one minimum-stake account cannot make the pool commit more Mana per week than its stake", () => {
    const k = setup();                                  // min_stake = 1 VHP, max_sponsor_rc = 1 KOIN in this harness
    deposit(k, A, 1 * VHP);                             // before genesis: counts for week 0
    at(1100);
    const ids: u32[] = [];
    for (let i = 0; i < 30; i++) ids.push(post(k, 2, 1300, 1301, 1400));   // one week of questions (game.json: 30)
    at(1200);
    let sponsored: u64 = 0;
    for (let i = 0; i < ids.length; i++) {
      as(A);
      setTx(0x0db52f40, Protobuf.encode(new kpred.answer_arguments(A, ids[i], 0), kpred.answer_arguments.encode), VHP, 1);
      if (sponsor(k)) sponsored++;
      answer(k, A, ids[i], 0);
    }
    const s = k.get_state(new kpred.get_state_arguments());
    const exposure = sponsored * s.config!.max_sponsor_rc;
    expect(exposure <= 1 * VHP).toBe(true,
      "SABOTEUR: a 1 VHP account got " + sponsored.toString() + " sponsored answers in one week (up to " +
      (exposure / VHP).toString() + " KOIN of the pool's Mana)");
  });
});

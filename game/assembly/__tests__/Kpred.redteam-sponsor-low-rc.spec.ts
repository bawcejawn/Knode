// Red-team (IMPERSONATOR) attack test, Knode commit 6b37c46. Target: Kpred.authorize -> sponsorOk (Kpred.ts:1019-1063).
// Attack: "pay with the pool's Mana". sponsorOk caps rc_limit from ABOVE only (Kpred.ts:1022-1023, rcLimit > max_sponsor_rc),
// never from below. An attacker sends a sponsored tx (header.payer = the game contract) for a perfectly valid settle (no
// signature needed at all: settle is open to anyone, Kpred.ts:1039-1049) or for their own valid answer (1 VHP stake),
// with rc_limit = 1 (or just enough to get through authorize). authorize() says yes; the operation then runs out of
// Mana. Chain error insufficient_rc = 104 is a positive (reversion-class) code, so the tx is included as reverted and
// the payer (the pool) is charged; the revert undoes the settle/answer, so the identical tx is valid again with the next
// nonce. Repeat until the pool's Mana is gone (it is needed for compounding, KOIN payouts and everyone's free play).
// Uncertainty: relies on koinos-chain charging the payer for an rc-exhausted (reverted) transaction; confirm on a local chain.
// Related to AB-003 (claim that reverts), but needs no losing entry and works for settle with no signature at all.
// Asserts the SAFE behaviour (a sponsored tx whose rc_limit is far too small to finish is refused for free):
// FAILS while the attack works, PASSES after a minimum rc_limit floor (e.g. rc_limit == max_sponsor_rc) is added.
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

describe("REDTEAM impersonator: sponsored tx with a tiny rc_limit", () => {
  it("refuses to pay for an anonymous settle whose rc_limit cannot possibly finish", () => {
    const k = setup();
    deposit(k, A, 10 * VHP);
    deposit(k, B, 10 * VHP);
    at(1100);
    const q0 = post(k, 2, 1300, 1301, 1400);
    const q1 = post(k, 2, 1300, 1301, 1400);
    at(1200);
    answer(k, A, q0, 1); answer(k, A, q1, 1);
    answer(k, B, q0, 0); answer(k, B, q1, 1);
    at(1500); resolve(k, q0, 1); resolve(k, q1, 1);
    give(KOIN_TAG, CONTRACT, 10 * VHP); give(MANA_TAG, CONTRACT, 10 * VHP);
    at(2010);
    k.close_week(new kpred.close_week_arguments(0));
    nobody();                                         // the attacker signs nothing at all
    const st = Protobuf.encode(new kpred.settle_arguments(A, 0), kpred.settle_arguments.encode);
    setTx(0x6868e83d, st, VHP / 2, 1);
    expect(sponsor(k)).toBe(true, "control: a normal sponsored settle is paid for");
    setTx(0x6868e83d, st, 1, 1);                      // rc_limit = 1 unit of Mana
    expect(sponsor(k)).toBe(false, "REDTEAM-IMP-1: pool pays for a settle that must run out of Mana and revert (repeatable drain)");
    setTx(0x6868e83d, st, 0, 1);                      // rc_limit = 0
    expect(sponsor(k)).toBe(false, "REDTEAM-IMP-1: pool accepts rc_limit 0");
  });

  it("refuses to pay for a staked player's answer whose rc_limit cannot possibly finish", () => {
    const k = setup();
    deposit(k, A, 1 * VHP);                           // the minimum stake is all the attacker needs
    at(1100);
    const q = post(k, 2, 1300, 1301, 1400);
    as(A);
    const good = Protobuf.encode(new kpred.answer_arguments(A, q, 1), kpred.answer_arguments.encode);
    setTx(0x0db52f40, good, VHP / 2, 1);
    expect(sponsor(k)).toBe(true, "control: a normal sponsored answer is paid for");
    setTx(0x0db52f40, good, 1, 1);
    expect(sponsor(k)).toBe(false, "REDTEAM-IMP-1: pool pays for an answer that must run out of Mana and revert (repeatable all week)");
  });
});

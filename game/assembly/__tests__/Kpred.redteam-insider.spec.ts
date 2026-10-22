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


// ════════════════════ RED TEAM (insider persona) ════════════════════
// Each test asserts the SAFE behaviour: it FAILS if the insider abuse works.
const THIEF = P6;          // a second wallet controlled by whoever stole / abuses the owner key
const DAY_BLOCKS: u64 = 86_400_000 / 2800;   // simulated blocks per day (MS = 2800)
function both(a: Uint8Array, b: Uint8Array): void {
  MockVM.setAuthorities([
    new MockVM.MockAuthority(authority.authorization_type.contract_call, a, true),
    new MockVM.MockAuthority(authority.authorization_type.contract_call, b, true),
  ]);
}

describe("REDTEAM insider: owner key", () => {
  it("INS-1 a stolen owner key cannot hand itself ownership in ONE transaction (propose + accept, no pending_owner ever visible to the bot)", () => {
    const k = setup();
    both(OWNER, THIEF);
    k.propose_owner(new kpred.propose_owner_arguments(THIEF));
    gK = k;
    MockVM.commitTransaction();
    // Safe: acceptance must wait (timelock / later block) so the bot's pending_owner alarm (bot.ts:247) can fire first.
    expect(() => { gK!.accept_owner(new kpred.accept_owner_arguments()); }).toThrow(
      "INS-1: propose_owner + accept_owner in the same transaction moved ownership instantly; the pending_owner alert never sees it");
  });

  it("INS-2 an announced upgrade must not stay armed for weeks after its timelock (upload any time later, no fresh notice)", () => {
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
    at(eta / MS + 30 * DAY_BLOCKS);                  // 30 days after the timelock ended
    const up = new authority.authorize_arguments(authority.authorization_type.contract_upload);
    expect(k.authorize(up).value).toBe(false,
      "INS-2: an upgrade announced once is still uploadable 30 days later; the bot emailed only once (ownerAlert dedup)");
  });

  it("INS-3 the owner must not be able to rewrite an operator-resolved outcome in the last block before the close", () => {
    const k = setup();
    deposit(k, A, 10 * VHP);
    deposit(k, C, 1 * VHP);                          // owner's 1-VHP sybil
    at(1100);
    const q0 = post(k, 2, 1300, 1301, 1400);
    const q1 = post(k, 2, 1300, 1301, 1400);
    at(1200);
    answer(k, A, q0, 1); answer(k, A, q1, 1);        // A answers what the blocks will say
    answer(k, C, q0, 0); answer(k, C, q1, 0);        // sybil answers the other way
    at(1500);
    resolve(k, q0, 1); resolve(k, q1, 1);            // honest resolution
    at(2009);                                        // one block before the week is due to close (2010)
    as(OWNER);
    gK = k; gId = q0;
    MockVM.commitTransaction();
    expect(() => { gK!.correct_question(new kpred.correct_question_arguments(gId, 0, hash32(4))); }).toThrow(
      "INS-3: the owner flipped a resolved outcome one block before the close, with no delay or alarm");
  });

  it("HOLDS: pausing never blocks a player's withdrawal; owner has no direct token route", () => {
    const k = setup();
    deposit(k, A, 10 * VHP);
    as(OWNER);
    k.set_paused(new kpred.set_paused_arguments(true));
    expect(k.authorize(new authority.authorize_arguments(authority.authorization_type.contract_call)).value).toBe(false);
    gK = k;
    MockVM.commitTransaction();
    expect(() => { gK!.claim_owner_share(new kpred.claim_owner_share_arguments(THIEF, 1 * VHP)); }).toThrow();
    as(A);
    k.withdraw(new kpred.withdraw_arguments(A, 10 * VHP));
    expect(Tokens.testGet(VHP_TAG, A)).toBe(1000 * VHP);
  });
});

describe("REDTEAM insider: seed owner", () => {
  it("INS-4 a seed withdrawal request must expire: it must not stay armed for a surprise withdrawal months later", () => {
    const k = setup();
    as(SEED);
    k.seed_deposit_vhp(new kpred.seed_deposit_vhp_arguments(1000 * VHP));
    const eta = k.request_seed_withdrawal(new kpred.request_seed_withdrawal_arguments(1000 * VHP, 0)).eta;
    at(eta / MS + 90 * DAY_BLOCKS);                  // 90 days later, players have long stopped watching
    gK = k;
    MockVM.commitTransaction();
    expect(() => { gK!.execute_seed_withdrawal(new kpred.execute_seed_withdrawal_arguments()); }).toThrow(
      "INS-4: a 90-day-old seed withdrawal request still executes instantly, with no fresh 48 h notice");
  });
});

describe("REDTEAM insider: operator key", () => {
  it("INS-5 the operator must not be able to post a question that closes 1 ms later (only same-block sybils can answer)", () => {
    const k = setup();
    at(1100);
    as(OPERATOR);
    gK = k;
    MockVM.commitTransaction();
    expect(() => {
      gK!.post_question(new kpred.post_question_arguments(2, 1100 * MS + 1, 1101, 1200, hash32(7)));
    }).toThrow("INS-5: post_question accepted lock_time = now + 1 ms; nobody but the operator's own same-block answers can play it");
  });
});

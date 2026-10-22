// Red-team (IMPERSONATOR) attack test, Knode commit 6b37c46. Target: every authority-gated Kpred entry point.
// Attack: the victim (player / owner / operator / seed owner) signs a transaction that calls a malicious app contract
// EVIL; EVIL then calls Kpred with the victim as the account: deposit_vhp(from=victim), withdraw(to=victim),
// answer(player=victim), claim(player=victim); set_operator / schedule_upgrade / propose_owner / set_paused /
// correct_question as owner; post_question as operator; request_seed_withdrawal as seed owner. The victim's
// signature IS in the transaction. Expected: blocked. requireAuthority defaults to enhancedSecurity (sdk-as 1.5.1
// systemCalls.ts:870-913): with a non-empty caller and an account that is not a smart wallet it returns false;
// isOwner (Kpred.ts:162-164) uses checkAccountAuthority, which does the same.
// Asserts the SAFE behaviour (all refused): PASSES if the code blocks the attack, FAILS if it works.
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

const EVIL = Base58.decode("1BRmrUgtSQVUggoeE9weG4f7nidyydnYfQ");
function viaEvil(): void {
  MockVM.setCaller(new chain.caller_data(EVIL, chain.privilege.user_mode));
  System.resetCache();
}
function direct(): void {
  MockVM.setCaller(new chain.caller_data(new Uint8Array(0), chain.privilege.user_mode));
  System.resetCache();
}
function authFail(who: Uint8Array): string { return "account '" + Base58.encode(who) + "' authorization failed"; }

describe("REDTEAM impersonator: victim's signature routed through a malicious contract", () => {
  it("a player's funds and answers cannot be driven by another contract", () => {
    const k = setup();
    deposit(k, A, 10 * VHP);
    at(1100);
    gId = post(k, 2, 1300, 1301, 1400);
    gK = k;
    viaEvil();
    as(A);                                            // A really signed the transaction (the one that called EVIL)
    MockVM.commitTransaction();
    expect(() => { gK!.withdraw(new kpred.withdraw_arguments(A, 1 * VHP)); }).toThrow("REDTEAM-IMP-2: EVIL withdrew for A");
    expect(MockVM.getErrorMessage()).toBe(authFail(A));
    MockVM.commitTransaction();
    expect(() => { gK!.deposit_vhp(new kpred.deposit_vhp_arguments(A, 5 * VHP)); }).toThrow("REDTEAM-IMP-2: EVIL deposited A's VHP");
    expect(MockVM.getErrorMessage()).toBe(authFail(A));
    MockVM.commitTransaction();
    expect(() => { gK!.answer(new kpred.answer_arguments(A, gId, 0)); }).toThrow("REDTEAM-IMP-2: EVIL answered for A");
    expect(MockVM.getErrorMessage()).toBe(authFail(A));
    MockVM.commitTransaction();
    expect(() => { gK!.claim(new kpred.claim_arguments(A, 0)); }).toThrow("REDTEAM-IMP-2: EVIL claimed for A");
    expect(MockVM.getErrorMessage()).toBe(authFail(A));
    direct();
    const p = k.get_player(new kpred.get_player_arguments(A, 1)).player!;
    expect(p.stake + p.pending).toBe(10 * VHP, "REDTEAM-IMP-2: A's stake changed");
  });

  it("owner, operator and seed-owner powers cannot be used through another contract", () => {
    const k = setup();
    gK = k;
    at(1100);
    viaEvil();
    as(OWNER);
    MockVM.commitTransaction();
    expect(() => { gK!.set_operator(new kpred.set_operator_arguments(EVIL)); }).toThrow("REDTEAM-IMP-2: EVIL set the operator");
    expect(MockVM.getErrorMessage()).toBe("owner only");
    MockVM.commitTransaction();
    expect(() => { gK!.schedule_upgrade(new kpred.schedule_upgrade_arguments(hash32(1))); }).toThrow("REDTEAM-IMP-2: EVIL scheduled an upgrade");
    MockVM.commitTransaction();
    expect(() => { gK!.propose_owner(new kpred.propose_owner_arguments(EVIL)); }).toThrow("REDTEAM-IMP-2: EVIL proposed itself as owner");
    MockVM.commitTransaction();
    expect(() => { gK!.set_paused(new kpred.set_paused_arguments(true)); }).toThrow("REDTEAM-IMP-2: EVIL paused deposits");
    MockVM.commitTransaction();
    expect(() => { gK!.set_sponsor_limit(new kpred.set_sponsor_limit_arguments(10 * VHP)); }).toThrow("REDTEAM-IMP-2: EVIL raised the sponsor limit");
    as(OPERATOR);
    MockVM.commitTransaction();
    expect(() => { gK!.post_question(new kpred.post_question_arguments(2, 1300 * MS, 1301, 1400, hash32(7))); }).toThrow("REDTEAM-IMP-2: EVIL posted as operator");
    expect(MockVM.getErrorMessage()).toBe(authFail(OPERATOR));
    as(SEED);
    MockVM.commitTransaction();
    expect(() => { gK!.request_seed_withdrawal(new kpred.request_seed_withdrawal_arguments(0, 1)); }).toThrow("REDTEAM-IMP-2: EVIL requested a seed withdrawal");
    expect(MockVM.getErrorMessage()).toBe(authFail(SEED));
    direct();
    const c = k.get_state(new kpred.get_state_arguments()).config!;
    expect(Base58.encode(c.operator!)).toBe(Base58.encode(OPERATOR), "REDTEAM-IMP-2: operator changed");
    expect(c.pending_owner == null || c.pending_owner!.length == 0).toBe(true, "REDTEAM-IMP-2: pending owner set");
    expect(c.max_sponsor_rc).toBe(VHP, "REDTEAM-IMP-2: sponsor limit changed");
  });
});

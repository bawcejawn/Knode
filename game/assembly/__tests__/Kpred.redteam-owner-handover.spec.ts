// Red-team (IMPERSONATOR) attack test, Knode commit 6b37c46. Target: propose_owner / accept_owner (Kpred.ts:856-873),
// isOwner (Kpred.ts:162) and upgradeOk (Kpred.ts:1066-1092).
// Attacks: (1) a stranger accepts a pending ownership transfer meant for someone else; (2) the proposed owner
// accepts after the owner has re-pointed the proposal elsewhere; (3) a stolen/old owner key schedules malicious
// code, the real owner rotates ownership to a fresh key, and the old key then signs the (still stored) scheduled
// upload once the timelock has passed; (4) the old owner keeps using owner powers after the handover.
// Expected: all blocked (accept needs the pending owner's authority; upgradeOk checks the CURRENT owner).
// Note: the schedule itself is NOT cleared by a handover, so the NEW owner could still upload the old owner's announced
// code; the new owner should call cancel_upgrade after a rotation (documented, not asserted here).
// Asserts the SAFE behaviour: PASSES if the code blocks the attacks, FAILS if any works.
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

function uploadTx(code: Uint8Array): void {
  const tx = new protocol.transaction();
  tx.header = new protocol.transaction_header();
  const op = new protocol.operation();
  op.upload_contract = new protocol.upload_contract_operation(CONTRACT, code, "", true, true, true);
  tx.operations.push(op);
  MockVM.setTransaction(tx);
  System.resetCache();
}

describe("REDTEAM impersonator: owner handover", () => {
  it("only the proposed owner can accept, and only the latest proposal counts", () => {
    const k = setup();
    gK = k;
    as(OWNER);
    k.propose_owner(new kpred.propose_owner_arguments(B));
    as(C);                                            // a stranger tries to take the pending transfer
    MockVM.commitTransaction();
    expect(() => { gK!.accept_owner(new kpred.accept_owner_arguments()); }).toThrow("REDTEAM-IMP-3: a stranger accepted ownership");
    as(OWNER);
    k.propose_owner(new kpred.propose_owner_arguments(D));   // owner changes their mind
    as(B);
    MockVM.commitTransaction();
    expect(() => { gK!.accept_owner(new kpred.accept_owner_arguments()); }).toThrow("REDTEAM-IMP-3: a superseded proposal was accepted");
    expect(Base58.encode(k.get_state(new kpred.get_state_arguments()).config!.owner!)).toBe(Base58.encode(OWNER));
  });

  it("after the handover the old key can neither use owner powers nor upload the code it scheduled", () => {
    const k = setup();
    gK = k;
    const code = new Uint8Array(100);
    code.fill(66);
    const mh = new Crypto.Multihash();
    mh.deserialize(System.hash(Crypto.multicodec.sha2_256, code)!);
    as(OWNER);                                        // the old (stolen) key announces its code
    const eta = k.schedule_upgrade(new kpred.schedule_upgrade_arguments(mh.digest)).eta;
    k.propose_owner(new kpred.propose_owner_arguments(B));
    at(100 + 28_800);                                 // (repo, v4) accept_owner waits 28,800 blocks after the proposal
    as(B);
    k.accept_owner(new kpred.accept_owner_arguments());
    at(eta / MS + 1);
    uploadTx(code);
    const up = new authority.authorize_arguments(authority.authorization_type.contract_upload);
    as(OWNER);
    expect(k.authorize(up).value).toBe(false, "REDTEAM-IMP-3: the old owner uploaded code after handing over");
    MockVM.commitTransaction();
    expect(() => { gK!.set_operator(new kpred.set_operator_arguments(A)); }).toThrow("REDTEAM-IMP-3: old owner still sets the operator");
    MockVM.commitTransaction();
    expect(() => { gK!.cancel_upgrade(new kpred.cancel_upgrade_arguments()); }).toThrow("REDTEAM-IMP-3: old owner still cancels upgrades");
    MockVM.commitTransaction();
    expect(() => { gK!.propose_owner(new kpred.propose_owner_arguments(OWNER)); }).toThrow("REDTEAM-IMP-3: old owner proposes itself back");
    MockVM.commitTransaction();
    expect(() => { gK!.claim_creator_fee(new kpred.claim_creator_fee_arguments(OWNER)); }).toThrow("REDTEAM-IMP-3: old owner takes the fee");
    // and the old key can't make the contract pay for the upload transaction either
    expect(k.authorize(new authority.authorize_arguments(authority.authorization_type.transaction_application)).value)
      .toBe(false, "REDTEAM-IMP-3: contract pays Mana for an upload");
    expect(k.authorize(new authority.authorize_arguments(authority.authorization_type.contract_call)).value)
      .toBe(false, "REDTEAM-IMP-3: contract_call authorized");
  });
});

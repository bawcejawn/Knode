// Audit Bot stateful fuzz test (Knode, commit 6b37c46), seed 99991. Harness copied unchanged from game/assembly/__tests__/Kpred.spec.ts.
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


// ───────────── Audit Bot model-based fuzz (Knode, commit 6b37c46) ─────────────
// Random but valid play over ~2 weeks: deposits (VHP and KOIN), partial and full withdrawals,
// answers (valid and invalid), strangers acting for others, settles, claims, compounding, block
// rewards, with the operator posting/resolving on a schedule and a bot-like settle pass.
// Every predicted refusal must be refused FOR THE RIGHT REASON (the contract's own check text).
// After EVERY step: players' wallets match the model; total_stake == sum of players' stake+pending
// == the model; holdings >= liabilities; no finalized week has paid out more than its pot.
// Asserts the SAFE behaviour: passes on a correct contract, fails (with seed and step) on a bug.

const PL: Uint8Array[] = [A, B, C, D, E];
const STEPS: i32 = 150;
let rngState: u32 = 1;
function rnd(): u32 { let x = rngState; x ^= x << 13; x ^= x >> 17; x ^= x << 5; rngState = x; return x; }
function pick(n: u32): u32 { return rnd() % n; }

const mStake: u64[] = [0, 0, 0, 0, 0];
const mWallet: u64[] = [0, 0, 0, 0, 0];
const mKoin: u64[] = [0, 0, 0, 0, 0];
let curH: u64 = 100;
let curSeed: u32 = 0;
let curStep: i32 = 0;
const posted: bool[] = [false, false, false, false];
const resolvedW: bool[] = [false, false, false, false];
const botSettled: bool[] = [false, false, false, false];
const qids: u32[][] = [[], [], [], []];
const qk: u32[][] = [[], [], [], []];
let aPlayer: Uint8Array = new Uint8Array(0);
let aWeek: u64 = 0;
let cClaims: i32 = 0, cRefused: i32 = 0, cWithdraws: i32 = 0;

function where(): string { return " (seed " + curSeed.toString() + ", step " + curStep.toString() + ")"; }
function refusedWith(fn: () => void, message: string): void {
  expect(fn).toThrow("expected a refusal" + where());
  if (message.length > 0) {
    const got = MockVM.getErrorMessage();
    expect(got != null ? got! : "").toBe(message, "refused for the wrong reason" + where());
  }
  MockVM.rollbackTransaction();
  MockVM.commitTransaction();
  cRefused++;
}
function idx(who: Uint8Array): i32 { for (let i = 0; i < 5; i++) if (Base58.encode(PL[i]) == Base58.encode(who)) return i; return -1; }

function schedule(k: Kpred): void {
  nobody(); k.compound(new kpred.compound_arguments()); MockVM.commitTransaction();   // like the hourly bot: due closes/finalizes happen
  for (let w: i32 = 0; w < 3; w++) {
    const s: u64 = GENESIS + <u64>w * WEEK;
    if (!posted[w] && curH >= s + 100) {
      posted[w] = true;
      if (curH < s + 250) {
        for (let n = 0; n < 3; n++) {
          const kk: u32 = 2 + <u32>pick(3);
          as(OPERATOR);
          const id = k.post_question(new kpred.post_question_arguments(kk, (s + 300) * MS, s + 301, s + 400 + <u64>n * 50, hash32(<u8>(n + 1)))).id;
          qids[w].push(id); qk[w].push(kk);
          MockVM.commitTransaction();
        }
        // most players answer every question right away (random options); some skip some
        for (let i = 0; i < 5; i++) for (let n = 0; n < qids[w].length; n++) {
          if (pick(5) == 0) continue;
          const o: u32 = pick(qk[w][n]);
          if (k.answerCheck(k.cfg(), PL[i], qids[w][n], o).length == 0) { as(PL[i]); k.answer(new kpred.answer_arguments(PL[i], qids[w][n], o)); MockVM.commitTransaction(); }
        }
      }
    }
    if (posted[w] && !resolvedW[w] && curH >= s + 600) {
      resolvedW[w] = true;
      for (let n = 0; n < qids[w].length; n++) {
        const out: u32 = pick(6) == 0 ? 1000 : pick(qk[w][n]);
        as(OPERATOR);
        k.resolve_question(new kpred.resolve_question_arguments(qids[w][n], out, hash32(9)));
        MockVM.commitTransaction();
      }
    }
    // bot-like settle pass inside the settlement window
    if (!botSettled[w]) {
      const wk = k.get_week(new kpred.get_week_arguments(<u64>w)).week!;
      if (wk.closed && curH * MS >= wk.settle_start + 20 * MS && curH * MS <= wk.settle_end) {
        botSettled[w] = true;
        nobody();
        for (let i = 0; i < 5; i++) {
          if (k.settleCheck(PL[i], <u64>w).length == 0) { k.settle(new kpred.settle_arguments(PL[i], <u64>w)); MockVM.commitTransaction(); }
        }
      }
    }
  }
}

function checkModel(k: Kpred): void {
  let sum: u64 = 0;
  for (let i = 0; i < 5; i++) {
    const p = k.get_player(new kpred.get_player_arguments(PL[i], 0)).player!;
    expect(p.stake + p.pending).toBe(mStake[i], "player stake mismatch" + where());
    expect(Tokens.testGet(VHP_TAG, PL[i])).toBe(mWallet[i], "player VHP wallet mismatch" + where());
    expect(Tokens.testGet(KOIN_TAG, PL[i])).toBe(mKoin[i], "player KOIN wallet mismatch" + where());
    sum += p.stake + p.pending;
  }
  const st = k.get_state(new kpred.get_state_arguments());
  const t = st.totals!;
  expect(t.total_stake).toBe(sum, "total_stake != sum of players" + where());
  const holdings = st.vhp_balance + st.koin_balance;
  const owed = t.total_stake + t.seed_vhp + t.seed_koin + t.owner_share + t.creator_fee + t.pots_outstanding;
  expect(holdings >= owed).toBe(true, "insolvent: holdings < liabilities" + where());
  for (let w: u64 = 0; w < t.weeks_finalized; w++) {
    const wk = k.get_week(new kpred.get_week_arguments(w)).week!;
    expect(wk.claimed <= wk.pot).toBe(true, "week paid out more than its pot" + where());
  }
  MockVM.clearLogs();
}

function fuzzStep(k: Kpred): void {
  const r = pick(20);
  const i = <i32>pick(5);
  const who = PL[i];
  if (r < 7) {
    curH += 20 + <u64>pick(80);
    at(curH);
    give(KOIN_TAG, CONTRACT, <u64>(pick(5) + 1) * VHP / 10);
    give(MANA_TAG, CONTRACT, 50 * VHP);
    schedule(k);
    return;
  }
  if (r < 10) {                                   // deposit VHP or KOIN (whole numbers)
    const n: u64 = (<u64>pick(20) + 1) * VHP;
    const koin = pick(4) == 0;
    if (koin) {
      if (mKoin[i] < n) return;
      as(who); k.deposit_koin(new kpred.deposit_koin_arguments(who, n)); mKoin[i] -= n;
    } else {
      if (mWallet[i] < n) return;
      as(who); k.deposit_vhp(new kpred.deposit_vhp_arguments(who, n)); mWallet[i] -= n;
    }
    mStake[i] += n;
    MockVM.commitTransaction();
    return;
  }
  if (r < 12) {                                   // withdraw: all, 1 unit, or a random part
    if (mStake[i] == 0) return;
    const c = pick(3);
    let amt: u64 = c == 0 ? mStake[i] : c == 1 ? 1 : 1 + <u64>pick(<u32>(mStake[i] < 4000000000 ? mStake[i] : 4000000000));
    if (amt > mStake[i]) amt = mStake[i];
    as(who); k.withdraw(new kpred.withdraw_arguments(who, amt));
    mStake[i] -= amt; mWallet[i] += amt; cWithdraws++;
    MockVM.commitTransaction();
    return;
  }
  if (r < 15) {                                   // answer (maybe invalid option / closed / repeated)
    const w = <i32>k.weekOf(k.cfg(), curH * MS);
    if (w > 2 || qids[w].length == 0) return;
    const n = <i32>pick(<u32>qids[w].length);
    const opt: u32 = pick(qk[w][n] + 1);
    gId = qids[w][n]; gOpt = opt; gWho = who; gK = k;
    as(who);
    const why = k.answerCheck(k.cfg(), who, gId, gOpt);
    if (why.length == 0) { k.answer(new kpred.answer_arguments(who, gId, gOpt)); MockVM.commitTransaction(); }
    else refusedWith(() => { gK!.answer(new kpred.answer_arguments(gWho, gId, gOpt)); }, why);
    return;
  }
  if (r < 16) {                                   // a stranger withdraws someone else's stake
    if (mStake[i] == 0) return;
    gK = k; gWho = who; gAmt = 1;
    as(PL[(i + 1) % 5]);
    refusedWith(() => { gK!.withdraw(new kpred.withdraw_arguments(gWho, gAmt)); }, "");
    return;
  }
  if (r < 18) {                                   // claim some week
    nobody(); k.compound(new kpred.compound_arguments()); MockVM.commitTransaction();
    aWeek = <u64>pick(3); aPlayer = who; gK = k;
    for (let w: u64 = 0; w < 3; w++) if (k.claimCheck(who, w).length == 0) aWeek = w;   // prefer a claimable week
    as(who);
    const why = k.claimCheck(who, aWeek);
    if (why.length == 0) {
      const rw = k.claim(new kpred.claim_arguments(who, aWeek)).reward;
      mWallet[i] += rw; cClaims++;
      MockVM.commitTransaction();
    } else refusedWith(() => { gK!.claim(new kpred.claim_arguments(aPlayer, aWeek)); }, why);
    return;
  }
  // anyone settles anyone
  nobody(); k.compound(new kpred.compound_arguments()); MockVM.commitTransaction();
  aWeek = <u64>pick(3); aPlayer = who; gK = k;
  const why = k.settleCheck(who, aWeek);
  if (why.length == 0) { k.settle(new kpred.settle_arguments(who, aWeek)); MockVM.commitTransaction(); }
  else refusedWith(() => { gK!.settle(new kpred.settle_arguments(aPlayer, aWeek)); }, why);
}

function runSeed(seed: u32): void {
  curSeed = seed; rngState = seed; curH = 100;
  for (let w = 0; w < 4; w++) { posted[w] = false; resolvedW[w] = false; botSettled[w] = false; qids[w] = []; qk[w] = []; }
  const k = setup();
  as(SEED);
  k.seed_deposit_vhp(new kpred.seed_deposit_vhp_arguments(1000 * VHP));
  k.seed_deposit_koin(new kpred.seed_deposit_koin_arguments(200 * VHP));
  give(MANA_TAG, CONTRACT, 1000 * VHP);
  MockVM.commitTransaction();
  for (let i = 0; i < 5; i++) { mStake[i] = 0; mWallet[i] = Tokens.testGet(VHP_TAG, PL[i]); mKoin[i] = Tokens.testGet(KOIN_TAG, PL[i]); }
  // everyone joins before the start with a random stake (0 for some: free players)
  for (let i = 0; i < 5; i++) { const n: u64 = <u64>pick(40) * VHP; if (n > 0) { as(PL[i]); k.deposit_vhp(new kpred.deposit_vhp_arguments(PL[i], n)); mStake[i] += n; mWallet[i] -= n; MockVM.commitTransaction(); } }
  curH = 900; at(curH);
  cClaims = 0; cRefused = 0; cWithdraws = 0;
  for (curStep = 0; curStep < STEPS; curStep++) { fuzzStep(k); checkModel(k); }
  const t = k.get_state(new kpred.get_state_arguments()).totals!;
  log<string>("fuzz seed " + seed.toString() + ": weeks closed " + t.weeks_closed.toString() + ", finalized " + t.weeks_finalized.toString() + ", claims " + cClaims.toString() + ", withdrawals " + cWithdraws.toString() + ", refusals checked " + cRefused.toString());
  expect(t.weeks_closed >= 1).toBe(true, "fuzz did not reach a week close (seed " + seed.toString() + ")");
}

describe("AUDIT fuzz: Kpred books always balance (seed 99991)", () => {
  it("150 random steps keep wallets, stake totals, solvency and pots consistent", () => { runSeed(99991); });
});

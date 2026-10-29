// Audit Bot attack tests for the Knode Mana sponsor. Each asserts the SAFE behaviour.
// Copy into sponsor/assembly/__tests__/ next to fixtures.ts to run.
import { Arrays, Base58, MockVM, Protobuf, authority, chain, protocol, system_calls } from "@koinos/sdk-as";
import { Sponsor, APPROVE_ENTRY, GAME_ANSWER, GAME_DEPOSIT_VHP, CAP_LIMIT, NOT_A_PLAYER, FREE_USED_UP } from "../Sponsor";
import { sponsor } from "../proto/sponsor";
import { F } from "./fixtures";

/** Extra reads for the vault game check (v3, SP-2: race picks and game_arg rows ask get_game_player too): a failed
 *  read with no answer, which counts as "no stake in that game". */
function padReads(r: system_calls.exit_arguments[]): system_calls.exit_arguments[] {
  const out: system_calls.exit_arguments[] = [];
  for (let i = 0; i < r.length; i++) out.push(r[i]);
  for (let i = 0; i < 4; i++) out.push(new system_calls.exit_arguments(0, new chain.result()));
  return out;
}

const SELF = Base58.decode(F.SELF);
const USER = Base58.decode(F.USER);
const OTHER = Base58.decode(F.OTHER);
const GAME = Base58.decode("1Mpmf2ERhjYpX7CCiM11WERuM4j17uT1sr");
const DESK = Base58.decode("1FKTpXBhhHEbu5vVchM8UsVbAvPArJsRmR");
const VHP = Base58.decode("12Y5vW6gk8GceH53YfRkRre2Rrcsgw7Naq");
const KOIN = Base58.decode("19GYjDBVXU7keLbYvMLazsGQn3GTWHjHkK");
const MANA: u64 = 100000000;
const DAY_MS: u64 = 86400000;
const T0: u64 = 1700003600000;   // 23:13 UTC: the free pool is fully released at hour 23 (v3, SP-3)
const NONE = new Uint8Array(0);

let OPS: protocol.operation[] = [];
let PAYEE: Uint8Array = NONE;
let SIGNER: string = "USER";
let RC: u64 = 0;
let TXN: i32 = 1;

function hex(s: string): Uint8Array { return Arrays.fromHexString(s); }
function sigOf(name: string, tx: i32): Uint8Array {
  if (name == "SELF") return hex(tx == 1 ? F.SIG_SELF_TX1 : tx == 2 ? F.SIG_SELF_TX2 : F.SIG_SELF_TX3);
  if (name == "USER") return hex(tx == 1 ? F.SIG_USER_TX1 : tx == 2 ? F.SIG_USER_TX2 : F.SIG_USER_TX3);
  return hex(tx == 1 ? F.SIG_OTHER_TX1 : tx == 2 ? F.SIG_OTHER_TX2 : F.SIG_OTHER_TX3);
}
function call(c: Uint8Array, e: u32, a: Uint8Array): protocol.operation {
  return new protocol.operation(null, new protocol.call_contract_operation(c, e, a));
}
function apply(): void {
  const t = new protocol.transaction();
  t.id = hex(TXN == 1 ? F.TX1_ID : TXN == 2 ? F.TX2_ID : F.TX3_ID);
  t.header = new protocol.transaction_header(NONE, RC, NONE, NONE, SELF, PAYEE);
  t.operations = OPS;
  t.signatures = [sigOf(SIGNER, TXN)];
  MockVM.setTransaction(t);
}
// The player check (audit M-1, fixed): the token and game answers queued for each check. Default: holds 10 VHP.
function vhpBalance(v: u64): system_calls.exit_arguments {
  return new system_calls.exit_arguments(0, new chain.result(Protobuf.encode(new sponsor.balance_of_result(v), sponsor.balance_of_result.encode)));
}
function gamePlayer(stake: u64, pending: u64): system_calls.exit_arguments {
  return new system_calls.exit_arguments(0, new chain.result(Protobuf.encode(new sponsor.game_get_player_result(new sponsor.game_player(stake, pending)), sponsor.game_get_player_result.encode)));
}
let READS: system_calls.exit_arguments[] = [];
function queueReads(): void { MockVM.setCallContractResults(padReads(READS.length ? READS : [gamePlayer(10 * MANA, 0)])); }
function pays(): bool {
  apply();
  queueReads();
  return new Sponsor().authorize(new authority.authorize_arguments(authority.authorization_type.transaction_application)).value;
}

/** v3 (owner, 2026-10-28): a wallet that isn't a real player is paid from the free pool for ANY covered call. */
function paidFromFree(): void {
  expect(pays()).toBe(true);
  expect(new Sponsor().get_free_usage(new sponsor.get_free_usage_arguments()).used_day > 0).toBe(true);
  MockVM.rollbackTransaction();
}
function setTime(ms: u64): void { MockVM.setHeadInfo(new chain.head_info(null, ms, 0)); }
function configure(perTx: u64, day: u64, week: u64, all: u64): void {
  MockVM.setAuthorities([new MockVM.MockAuthority(authority.authorization_type.contract_call, SELF, true)]);
  new Sponsor().set_config(new sponsor.set_config_arguments(new sponsor.config(true, GAME, DESK, [VHP, KOIN], perTx, day, week, all, VHP, MANA)));
  MockVM.commitTransaction();
}
function start(): void {
  MockVM.reset();
  MockVM.setContractId(SELF);
  setTime(T0);
  MockVM.commitTransaction();
  READS = [];
}
function asUser(rc: u64): void { TXN = 1; RC = rc; PAYEE = USER; SIGNER = "USER"; OPS = [call(GAME, GAME_ANSWER, NONE)]; }
function asOther(rc: u64): void { TXN = 1; RC = rc; PAYEE = OTHER; SIGNER = "OTHER"; OPS = [call(GAME, GAME_ANSWER, NONE)]; }

describe("AB caps: exact boundaries and lowered caps", () => {
  beforeEach(() => { start(); configure(10 * MANA, 30 * MANA, 50 * MANA, 40 * MANA); });

  it("everyone's daily cap is hard: filling it exactly, then 1 unit more is refused", () => {
    for (let i = 0; i < 3; i++) { asUser(10 * MANA); expect(pays()).toBe(true); MockVM.commitTransaction(); }
    asOther(10 * MANA); expect(pays()).toBe(true); MockVM.commitTransaction();
    expect(new Sponsor().get_total_usage(new sponsor.get_total_usage_arguments()).used_day).toBe(40 * MANA);
    asOther(1);
    expect(() => { pays(); }).toThrow();
    expect(MockVM.getErrorMessage()).toBe("SPONSOR: today's sponsored mana is used up");
    MockVM.rollbackTransaction();
  });

  it("a cap lowered below today's use refuses cleanly (no unsigned underflow re-opening the tap)", () => {
    for (let i = 0; i < 3; i++) { asUser(10 * MANA); expect(pays()).toBe(true); MockVM.commitTransaction(); }
    configure(1 * MANA, 5 * MANA, 20 * MANA, 20 * MANA); // all below what is already used today
    asUser(1);
    expect(() => { pays(); }).toThrow();
    expect(MockVM.getErrorMessage()).toBe("SPONSOR: this player's daily sponsored mana is used up");
    MockVM.rollbackTransaction();
    asOther(1);
    expect(() => { pays(); }).toThrow();
    expect(MockVM.getErrorMessage()).toBe("SPONSOR: today's sponsored mana is used up");
    MockVM.rollbackTransaction();
    queueReads();
    const w = new Sponsor().would_pay(new sponsor.would_pay_arguments(USER, 1));
    expect(w.ok).toBe(false);
    expect(w.left_today).toBe(0);
  });

  it("an rc_limit of u64 max is refused by the per-transaction cap", () => {
    asUser(u64.MAX_VALUE);
    expect(() => { pays(); }).toThrow();
    expect(MockVM.getErrorMessage()).toBe("SPONSOR: mana limit above the per-transaction cap");
    MockVM.rollbackTransaction();
  });

  it("the largest allowed caps can't overflow the counters", () => {
    configure(CAP_LIMIT, CAP_LIMIT, 7 * CAP_LIMIT, CAP_LIMIT);
    asUser(CAP_LIMIT); expect(pays()).toBe(true); MockVM.commitTransaction();
    asUser(1);
    expect(() => { pays(); }).toThrow();
    MockVM.rollbackTransaction();
  });
});

describe("AB operations: odd shapes", () => {
  beforeEach(() => { start(); configure(10 * MANA, 30 * MANA, 50 * MANA, 100 * MANA); });

  it("an operation with nothing in it (no call) is refused", () => {
    asUser(MANA);
    OPS = [new protocol.operation()];
    expect(() => { pays(); }).toThrow();
    expect(MockVM.getErrorMessage()).toBe("SPONSOR: only contract calls are sponsored");
    MockVM.rollbackTransaction();
  });

  it("set_system_contract is refused", () => {
    asUser(MANA);
    OPS = [new protocol.operation(null, null, null, new protocol.set_system_contract_operation(GAME, true))];
    expect(() => { pays(); }).toThrow();
    expect(MockVM.getErrorMessage()).toBe("SPONSOR: only contract calls are sponsored");
    MockVM.rollbackTransaction();
  });

  it("approve with empty args is refused (no spender)", () => {
    asUser(MANA);
    OPS = [call(VHP, APPROVE_ENTRY, NONE)];
    expect(() => { pays(); }).toThrow();
    expect(MockVM.getErrorMessage()).toBe("SPONSOR: approve must name the game or Knode Swap as spender");
    MockVM.rollbackTransaction();
  });

  it("approve args with the owner field twice: the sponsor reads the LAST one (as the token's own decoder does)", () => {
    asUser(MANA);
    const a = Protobuf.encode(new sponsor.approve_args(USER, GAME, 5), sponsor.approve_args.encode);
    const b = Protobuf.encode(new sponsor.approve_args(OTHER, null, 0), sponsor.approve_args.encode);
    const both = new Uint8Array(a.length + b.length); both.set(a, 0); both.set(b, a.length);
    OPS = [call(VHP, APPROVE_ENTRY, both)];
    expect(() => { pays(); }).toThrow();
    expect(MockVM.getErrorMessage()).toBe("SPONSOR: approve must be for the payee's own tokens");
    MockVM.rollbackTransaction();
  });

  it("calling the sponsor's own authorize as an operation is refused for a player", () => {
    asUser(MANA);
    OPS = [call(SELF, 0x4a2dbd90, NONE)];
    expect(() => { pays(); }).toThrow();
    expect(MockVM.getErrorMessage()).toBe("SPONSOR: only Knode calls are sponsored");
    MockVM.rollbackTransaction();
  });
});

describe("AB-001 budget exhaustion by fresh wallets (fixed: only real players are sponsored, except answers within the free sub-cap)", () => {
  beforeEach(() => { start(); configure(1 * MANA, 5 * MANA, 20 * MANA, 100 * MANA); });

  it("a wallet with no stake, no VHP and no history is not sponsored [v3, owner 2026-10-28: a non-player now spends the free pool]", () => {
    // OTHER has never deposited, holds nothing (the mock has no balances) and is not a Knode player.
    // Twenty such wallets x 5 Mana use up everyone's 100 Mana for the day at no cost to their creator.
    asOther(MANA);
    OPS = [call(VHP, APPROVE_ENTRY, Protobuf.encode(new sponsor.approve_args(OTHER, GAME, 1), sponsor.approve_args.encode))];
    READS = [gamePlayer(0, 0)];
    expect(() => { pays(); }).toThrow();
    expect(MockVM.getErrorMessage()).toBe(FREE_USED_UP);   // v3: a non-player spends the free pool, 0 here
    MockVM.rollbackTransaction();
  });

  it("fresh wallets' answers can use at most the free sub-cap, never the whole day", () => {
    // Free sub-cap 10 of the 100 daily: twenty fresh wallets answering use 10, real players keep the other 90.
    MockVM.setAuthorities([new MockVM.MockAuthority(authority.authorization_type.contract_call, SELF, true)]);
    new Sponsor().set_config(new sponsor.set_config_arguments(new sponsor.config(true, GAME, DESK, [VHP, KOIN], MANA, 5 * MANA, 20 * MANA, 100 * MANA, VHP, MANA, 10 * MANA)));
    MockVM.commitTransaction();
    let paid: u64 = 0;
    for (let i = 0; i < 20; i++) {
      if (i % 2 == 0) asUser(MANA); else asOther(MANA);
      TXN = 1 + (i % 3);
      READS = [gamePlayer(0, 0)];
      if (i < 10) { expect(pays()).toBe(true); MockVM.commitTransaction(); paid += MANA; }
      else { expect(() => { pays(); }).toThrow(); MockVM.rollbackTransaction(); }
    }
    // Two empty wallets, 5 each, reach the free sub-cap of 10; every later free answer is refused.
    const f = new Sponsor().get_free_usage(new sponsor.get_free_usage_arguments());
    expect(f.used_day <= 10 * MANA).toBe(true);
    expect(f.used_day).toBe(paid);
  });
});

// Stateful fuzz: random players, Mana limits and clock jumps; the sponsor must never pay past a cap.
class Rng { s: u64; constructor(s: u64) { this.s = s; } next(): u64 { this.s ^= this.s << 13; this.s ^= this.s >> 7; this.s ^= this.s << 17; return this.s; } }

function fuzz(seed: u64): void {
  start();
  const PER_TX = 3 * MANA, DAY = 7 * MANA, WEEK = 20 * MANA, ALL = 12 * MANA;
  configure(PER_TX, DAY, WEEK, ALL);
  const r = new Rng(seed);
  let now = T0;
  // model
  let uDay: u64 = 0, oDay: u64 = 0, uWeek: u64 = 0, oWeek: u64 = 0, all: u64 = 0;
  let curDay = now / DAY_MS, curWeek = (now / DAY_MS + 3) / 7;
  for (let step = 0; step < 150; step++) {
    const k = r.next() % 10;
    if (k == 0) { now += (r.next() % (2 * DAY_MS)); setTime(now); MockVM.commitTransaction(); }
    const d = now / DAY_MS, w = (d + 3) / 7;
    if (d != curDay) { curDay = d; uDay = 0; oDay = 0; all = 0; }
    if (w != curWeek) { curWeek = w; uWeek = 0; oWeek = 0; }
    const isUser = (r.next() & 1) == 0;
    const rc: u64 = 1 + r.next() % (4 * MANA);
    if (isUser) asUser(rc); else asOther(rc);
    TXN = <i32>(1 + r.next() % 3);
    const myDay = isUser ? uDay : oDay, myWeek = isUser ? uWeek : oWeek;
    const allowed = rc <= PER_TX && myDay + rc <= DAY && myWeek + rc <= WEEK && all + rc <= ALL;
    queueReads();
    const w2 = new Sponsor().would_pay(new sponsor.would_pay_arguments(isUser ? USER : OTHER, rc));
    expect(w2.ok).toBe(allowed, "would_pay agrees with the model");
    if (allowed) {
      expect(pays()).toBe(true);
      MockVM.commitTransaction();
      if (isUser) { uDay += rc; uWeek += rc; } else { oDay += rc; oWeek += rc; }
      all += rc;
    }
    // invariants on chain state
    const t = new Sponsor().get_total_usage(new sponsor.get_total_usage_arguments());
    expect(t.used_day <= ALL).toBe(true);
    expect(t.used_day).toBe(all);
    const u = new Sponsor().get_usage(new sponsor.get_usage_arguments(USER));
    expect(u.used_day <= DAY && u.used_week <= WEEK).toBe(true);
    expect(u.used_week).toBe(uWeek);
  }
}

describe("AB fuzz: caps never exceeded, would_pay agrees", () => {
  it("seed 1", () => { fuzz(0x9e3779b97f4a7c15); });
  it("seed 2", () => { fuzz(0x1234567887654321); });
  it("seed 3", () => { fuzz(0xdeadbeefcafebabe); });
  it("seed 4", () => { fuzz(0x0badf00d0badf00d); });
});

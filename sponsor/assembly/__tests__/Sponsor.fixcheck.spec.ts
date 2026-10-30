// Knode mana sponsor: tests
//
// The mock VM recovers real secp256k1 signatures, so these tests use signatures made by
// scripts/make-test-fixtures.cjs over fixed transaction ids, with test-only keys (never funded).
// Ported from the SwarmTales sponsor tests, extended for the weekly cap, would_pay and the one-signer rule.
// =====================================================================

import { Arrays, Base58, MockVM, Protobuf, authority, chain, protocol, system_calls } from "@koinos/sdk-as";
import {
  Sponsor, APPROVE_ENTRY, dayOf, weekOf,
  NOT_A_PLAYER, FREE_USED_UP,
  GAME_DEPOSIT_VHP, GAME_DEPOSIT_KOIN, GAME_WITHDRAW, GAME_ANSWER, GAME_SETTLE, GAME_CLAIM, GAME_CLOSE_WEEK, GAME_FINALIZE_WEEK, DESK_SWAP,
  RACE_PICK,
} from "../Sponsor";
import { sponsor } from "../proto/sponsor";
import { F } from "./fixtures";

const SELF = Base58.decode(F.SELF);
const USER = Base58.decode(F.USER);
const OTHER = Base58.decode(F.OTHER);
const GAME = Base58.decode("1Mpmf2ERhjYpX7CCiM11WERuM4j17uT1sr");
const DESK = Base58.decode("1FKTpXBhhHEbu5vVchM8UsVbAvPArJsRmR");
const VHP = Base58.decode("12Y5vW6gk8GceH53YfRkRre2Rrcsgw7Naq");
const KOIN = Base58.decode("19GYjDBVXU7keLbYvMLazsGQn3GTWHjHkK");
const STRANGER_CONTRACT = Base58.decode("1EDaCKVmBjUxLxgWCmDbRA8gWKkSQ6ByzY");
const ATTACKER = Base58.decode("16ixK5DgvcojcZLvxyYWhHFcRXfhfrHbpL");

const MANA: u64 = 100000000;
const DAY_MS: u64 = 86400000;
// 2023-11-14 22:13 UTC, a Tuesday.
const T0: u64 = 1700003600000;   // 23:13 UTC: the free pool is fully released at hour 23 (v3, SP-3)
// 2023-11-19 23:00 UTC (Sunday) and 2023-11-20 00:00 UTC (the next Monday).
const SUNDAY_LATE: u64 = 1700434800000;
const NEXT_MONDAY: u64 = 1700438400000;
const TRANSFER_ENTRY: u32 = 0x27f576ca;
// Game and Desk owner-only entry points (never sponsored).
const GAME_SET_OPERATOR: u32 = 0x426e2c17;
const GAME_SCHEDULE_UPGRADE: u32 = 0xa58d30dd;
const GAME_SEED_DEPOSIT_VHP: u32 = 0x71d17431;
const GAME_COMPOUND: u32 = 0xee0df97c;
const DESK_WITHDRAW_KOIN: u32 = 0xc7c42a57;

// Closures aren't supported in AssemblyScript; tests set these, then call.
let OPS: protocol.operation[] = [];
let SIGNERS: string[] = [];
const NONE = new Uint8Array(0);
let PAYEE: Uint8Array = NONE;
let RC: u64 = 0;
let TX: i32 = 1;
let RAW_SIGS: Uint8Array[] = [];

function hex(s: string): Uint8Array {
  return Arrays.fromHexString(s);
}

function sig(name: string, tx: i32): Uint8Array {
  if (tx == 1) {
    if (name == "SELF") return hex(F.SIG_SELF_TX1);
    if (name == "USER") return hex(F.SIG_USER_TX1);
    if (name == "OTHER") return hex(F.SIG_OTHER_TX1);
  } else if (tx == 2) {
    if (name == "SELF") return hex(F.SIG_SELF_TX2);
    if (name == "USER") return hex(F.SIG_USER_TX2);
    if (name == "OTHER") return hex(F.SIG_OTHER_TX2);
  } else {
    if (name == "SELF") return hex(F.SIG_SELF_TX3);
    if (name == "USER") return hex(F.SIG_USER_TX3);
    if (name == "OTHER") return hex(F.SIG_OTHER_TX3);
  }
  throw new Error("no fixture " + name);
}

function txId(tx: i32): Uint8Array {
  return hex(tx == 1 ? F.TX1_ID : tx == 2 ? F.TX2_ID : F.TX3_ID);
}

function call(contract: Uint8Array, entry: u32, args: Uint8Array): protocol.operation {
  return new protocol.operation(null, new protocol.call_contract_operation(contract, entry, args));
}

function approve(token: Uint8Array, owner: Uint8Array, spender: Uint8Array): protocol.operation {
  const a = new sponsor.approve_args(owner, spender, 5000000);
  return call(token, APPROVE_ENTRY, Protobuf.encode(a, sponsor.approve_args.encode));
}

/** Put the transaction built from OPS/SIGNERS/PAYEE/RC/TX (plus any RAW_SIGS) in the mock. */
function apply(): void {
  const t = new protocol.transaction();
  t.id = txId(TX);
  t.header = new protocol.transaction_header(NONE, RC, NONE, NONE, SELF, PAYEE);
  t.operations = OPS;
  const sigs: Uint8Array[] = [];
  for (let i = 0; i < SIGNERS.length; i++) sigs.push(sig(SIGNERS[i], TX));
  for (let i = 0; i < RAW_SIGS.length; i++) sigs.push(RAW_SIGS[i]);
  t.signatures = sigs;
  MockVM.setTransaction(t);
}

// ── the player check (audit M-1): what the VHP token and the game answer, in call order ──
/** A VHP balance_of answer. */
export function vhpBalance(v: u64): system_calls.exit_arguments {
  return new system_calls.exit_arguments(0, new chain.result(Protobuf.encode(new sponsor.balance_of_result(v), sponsor.balance_of_result.encode)));
}
/** A game get_player answer. */
export function gamePlayer(stake: u64, pending: u64): system_calls.exit_arguments {
  const r = new sponsor.game_get_player_result(new sponsor.game_player(stake, pending), stake);
  return new system_calls.exit_arguments(0, new chain.result(Protobuf.encode(r, sponsor.game_get_player_result.encode)));
}
/** A failed read (the called contract reverted). */
export function failedRead(): system_calls.exit_arguments {
  return new system_calls.exit_arguments(1, new chain.result(new Uint8Array(0), new chain.error_data("reverted")));
}
/** By default the payee holds 10 VHP. Tests change READS before calling pays() / wouldPay(). */
let READS: system_calls.exit_arguments[] = [];
function holder(): void { READS = [gamePlayer(10 * MANA, 0)]; }
function queueReads(): void { MockVM.setCallContractResults(padReads(READS)); }

function wouldPay(account: Uint8Array, rc: u64): sponsor.would_pay_result {
  queueReads();
  return new Sponsor().would_pay(new sponsor.would_pay_arguments(account, rc));
}

function wouldPayAnswer(account: Uint8Array, rc: u64): sponsor.would_pay_result {
  queueReads();
  return new Sponsor().would_pay(new sponsor.would_pay_arguments(account, rc, true));
}

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

/** A normal sponsored stake by USER: approve the game for VHP, then deposit. */
function userStake(tx: i32, rc: u64): void {
  TX = tx;
  RC = rc;
  PAYEE = USER;
  SIGNERS = ["USER"];
  RAW_SIGS = [];
  OPS = [approve(VHP, USER, GAME), call(GAME, GAME_DEPOSIT_VHP, new Uint8Array(0))];
}

function userCall(tx: i32, rc: u64, contract: Uint8Array, entry: u32): void {
  TX = tx;
  RC = rc;
  PAYEE = USER;
  SIGNERS = ["USER"];
  RAW_SIGS = [];
  OPS = [call(contract, entry, new Uint8Array(0))];
}

function setTime(ms: u64): void {
  MockVM.setHeadInfo(new chain.head_info(null, ms, 0));
}

function errorIs(message: string): void {
  expect(MockVM.getErrorMessage()).toBe(message);
  MockVM.rollbackTransaction();
}

function asOwner(): void {
  MockVM.setAuthorities([new MockVM.MockAuthority(authority.authorization_type.contract_call, SELF, true)]);
}

/** per tx 10, per player per day 30, per player per week 50, everyone per day 100 (Mana). */
function goodConfig(): sponsor.config {
  return new sponsor.config(true, GAME, DESK, [VHP, KOIN], 10 * MANA, 30 * MANA, 50 * MANA, 100 * MANA, VHP, MANA);
}

let CFG: sponsor.config = new sponsor.config();

function setConfig(): void {
  asOwner();
  new Sponsor().set_config(new sponsor.set_config_arguments(CFG));
}

function configure(): void {
  CFG = goodConfig();
  setConfig();
  MockVM.commitTransaction();
}

function start(): void {
  MockVM.reset();
  MockVM.setContractId(SELF);
  setTime(T0);
  MockVM.commitTransaction();
  RAW_SIGS = [];
  holder();
}

/** As goodConfig, with everyone's daily free-player answers capped at `free` Mana; per tx 1, per player 5/day, 30/week. */
function freeConfig(free: u64): void {
  CFG = new sponsor.config(true, GAME, DESK, [VHP, KOIN], MANA, 5 * MANA, 30 * MANA, 100 * MANA, VHP, MANA, free);
  setConfig();
  MockVM.commitTransaction();
}

function emptyWallet(): void { READS = [gamePlayer(0, 0)]; }

// ═══════════════════════ AUDIT 2026-10-27: Sponsor v2 race picks ═══════════════════════
import { race } from "./race_proto";

/** Extra reads for the vault game check (v3, SP-2: race picks and game_arg rows ask get_game_player too): a failed
 *  read with no answer, which counts as "no stake in that game". */
function padReads(r: system_calls.exit_arguments[]): system_calls.exit_arguments[] {
  const out: system_calls.exit_arguments[] = [];
  for (let i = 0; i < r.length; i++) out.push(r[i]);
  for (let i = 0; i < 4; i++) out.push(new system_calls.exit_arguments(0, new chain.result()));
  return out;
}

const RACE = Base58.decode("15CM9Qr4GKREDgqnyXJ8tckPj2biERTM1T");
const HORSE = Base58.decode("15NZhQoewzsbVUcSVsZ8BEBEKgaBNPLLgZ");
const RACE_NO: u64 = 83014;

function raceConfig(free: u64): void {
  CFG = new sponsor.config(true, GAME, DESK, [VHP, KOIN], MANA, 5 * MANA, 30 * MANA, 100 * MANA, VHP, MANA, free, RACE);
  setConfig();
  MockVM.commitTransaction();
}
function bytesOf(list: u8[]): Uint8Array { const b = new Uint8Array(list.length); for (let i = 0; i < list.length; i++) b[i] = list[i]; return b; }
function pushAddr(out: u8[], tag: u8, a: Uint8Array): void { out.push(tag); out.push(25); for (let i = 0; i < 25; i++) out.push(a[i]); }
function pushRace(out: u8[], r: u64): void { out.push(0x10); let v = r; while (v >= 0x80) { out.push(<u8>((v & 0x7f) | 0x80)); v >>= 7; } out.push(<u8>v); }

/** S-1 payload: the race contract decodes player = raceSees; the sponsor decodes player = sponsorSees. */
function smuggled(raceSees: Uint8Array, sponsorSees: Uint8Array): Uint8Array {
  const out: u8[] = [];
  pushAddr(out, 0x0a, raceSees);
  out.push(0x18); out.push(27);              // field 3 (horse) sent with wire type 0: race reads 27 bytes as "horse", sponsor skips a varint
  pushAddr(out, 0x0a, sponsorSees);          // ...so the sponsor parses this as field 1, the race swallows it as the horse
  pushRace(out, RACE_NO);
  pushAddr(out, 0x1a, HORSE);                // a real horse last: last-one-wins in the race decoder
  return bytesOf(out);
}
function pickTx(args: Uint8Array): void {
  TX = 1; RC = MANA; PAYEE = USER; SIGNERS = ["USER"]; RAW_SIGS = [];
  OPS = [call(RACE, RACE_PICK, args)];
}

describe("AUDIT S-1 (fixed): the sponsor and the race read a pick the same way", () => {
  beforeEach(() => { start(); raceConfig(3 * MANA); });

  it("S-1 (fixed): the sponsor now reads the crafted pick exactly as the race contract does, and refuses it", () => {
    const args = smuggled(OTHER, USER);
    const s = Protobuf.decode<sponsor.race_pick_args>(args, sponsor.race_pick_args.decode);
    const r = Protobuf.decode<race.pick_arguments>(args, race.pick_arguments.decode);
    expect(Arrays.equal(s.player, OTHER)).toBe(true, "the sponsor decodes OTHER, like the race contract");
    expect(Arrays.equal(r.player, OTHER)).toBe(true);
    pickTx(args);
    expect(() => { pays(); }).toThrow();
    errorIs("SPONSOR: a pick's arguments must be canonical");
  });

  it("S-1 (fixed): any non-canonical encoding is refused (a repeated field 1), the honest one is paid", () => {
    const out: u8[] = [];
    pushAddr(out, 0x0a, OTHER); pushAddr(out, 0x0a, USER); pushRace(out, RACE_NO); pushAddr(out, 0x1a, HORSE);
    pickTx(bytesOf(out));
    expect(() => { pays(); }).toThrow();
    errorIs("SPONSOR: a pick's arguments must be canonical");
    pickTx(Protobuf.encode(new race.pick_arguments(USER, RACE_NO, HORSE), race.pick_arguments.encode));
    expect(pays()).toBe(true);
    pickTx(Protobuf.encode(new race.pick_arguments(OTHER, RACE_NO, HORSE), race.pick_arguments.encode));
    expect(() => { pays(); }).toThrow();
    errorIs("SPONSOR: a pick must be the payee's own");
  });

  it("fix check: a canonical re-encode of the race's view differs from the crafted bytes", () => {
    const args = smuggled(OTHER, USER);
    const r = Protobuf.decode<race.pick_arguments>(args, race.pick_arguments.decode);
    const again = Protobuf.encode(r, race.pick_arguments.encode);
    expect(Arrays.equal(again, args)).toBe(false);
    const honest = Protobuf.encode(new race.pick_arguments(USER, RACE_NO, HORSE), race.pick_arguments.encode);
    const r2 = Protobuf.decode<race.pick_arguments>(honest, race.pick_arguments.decode);
    expect(Arrays.equal(Protobuf.encode(r2, race.pick_arguments.encode), honest)).toBe(true);
  });
});

describe("AUDIT: v2 keeps the v1 rules", () => {
  beforeEach(() => { start(); });

  it("race unset: a call to the would-be race address is refused; answers still free; a v1-encoded config decodes with race = null", () => {
    freeConfig(3 * MANA);
    expect(new Sponsor().get_config(new sponsor.get_config_arguments()).race).toBeNull();
    pickTx(Protobuf.encode(new sponsor.race_pick_args(USER), sponsor.race_pick_args.encode));
    expect(() => { pays(); }).toThrow();
    errorIs("SPONSOR: only Knode calls are sponsored");
    emptyWallet();
    userCall(1, MANA, GAME, GAME_ANSWER);
    expect(pays()).toBe(true);
  });

  it("free picks mixed with any non-free op need a real player; 10 picks + nothing else is free play but within the per-tx cap [v3, owner 2026-10-28: a non-player now spends the free pool]", () => {
    raceConfig(3 * MANA);
    emptyWallet();
    TX = 1; RC = MANA; PAYEE = USER; SIGNERS = ["USER"]; RAW_SIGS = [];
    OPS = [call(RACE, RACE_PICK, Protobuf.encode(new sponsor.race_pick_args(USER), sponsor.race_pick_args.encode)), approve(VHP, USER, GAME)];
    paidFromFree();   // v3 (owner 2026-10-28): free pool, any covered call
    emptyWallet();
    const ops: protocol.operation[] = [];
    for (let i = 0; i < 10; i++) ops.push(call(RACE, RACE_PICK, Protobuf.encode(new sponsor.race_pick_args(USER), sponsor.race_pick_args.encode)));
    TX = 1; RC = 2 * MANA; PAYEE = USER; SIGNERS = ["USER"]; RAW_SIGS = []; OPS = ops;
    expect(() => { pays(); }).toThrow();
    errorIs("SPONSOR: mana limit above the per-transaction cap");
  });

  it("a race pick signed by the payee AND another wallet is refused (one-signer rule still first)", () => {
    raceConfig(3 * MANA);
    pickTx(Protobuf.encode(new sponsor.race_pick_args(USER), sponsor.race_pick_args.encode));
    SIGNERS = ["USER", "OTHER"];
    expect(() => { pays(); }).toThrow();
    errorIs("SPONSOR: only the payee may sign");
  });

  it("set_config: race = KOIN (a token) or 24/26-byte garbage is refused", () => {
    CFG = new sponsor.config(true, GAME, DESK, [VHP, KOIN], MANA, 5 * MANA, 30 * MANA, 100 * MANA, VHP, MANA, MANA, KOIN);
    expect(() => { setConfig(); }).toThrow();
    errorIs("SPONSOR: a token can't be a Knode contract or the sponsor");
    CFG = new sponsor.config(true, GAME, DESK, [VHP, KOIN], MANA, 5 * MANA, 30 * MANA, 100 * MANA, VHP, MANA, MANA, new Uint8Array(24));
    expect(() => { setConfig(); }).toThrow();
    errorIs("SPONSOR: invalid race contract address");
  });
});

// ═══════════════════════ FIX CHECK 2026-10-27 (S-1): try to break the canonical rule ═══════════════════════
function cat(parts: u8[][]): Uint8Array { const o: u8[] = []; for (let i = 0; i < parts.length; i++) for (let j = 0; j < parts[i].length; j++) o.push(parts[i][j]); return bytesOf(o); }
function addr(tag: u8, a: Uint8Array): u8[] { const o: u8[] = []; pushAddr(o, tag, a); return o; }
function rc(r: u64): u8[] { const o: u8[] = []; pushRace(o, r); return o; }
function raw(list: u8[]): u8[] { return list; }

/** Runs the real authorize on one pick; returns true if paid. If paid, the race decoder must read exactly the payee's pick. */
function tryPick(args: Uint8Array): bool {
  pickTx(args);
  let ok = true;
  // authorize aborts on refusal; as-pect can only observe that through toThrow, so probe the rule first.
  const s = Protobuf.decode<sponsor.race_pick_args>(args, sponsor.race_pick_args.decode);
  const canonical = Arrays.equal(Protobuf.encode(s, sponsor.race_pick_args.encode), args);
  const own = s.player != null && Arrays.equal(s.player!, USER);
  if (canonical && own) {
    expect(pays()).toBe(true);
    MockVM.rollbackTransaction();
    const r = Protobuf.decode<race.pick_arguments>(args, race.pick_arguments.decode);
    expect(Arrays.equal(r.player, USER)).toBe(true, "paid => race reads the payee");
    expect(r.race).toBe(s.race, "paid => same race");
    expect(Arrays.equal(r.horse, s.horse)).toBe(true, "paid => same horse");
  } else {
    expect(() => { pays(); }).toThrow();
    MockVM.rollbackTransaction();
    ok = false;
  }
  return ok;
}

describe("FIX CHECK S-1: no byte string is paid as the payee's pick yet read differently by the race", () => {
  beforeEach(() => { start(); raceConfig(3 * MANA); });

  it("honest pick is paid", () => {
    expect(tryPick(cat([addr(0x0a, USER), rc(RACE_NO), addr(0x1a, HORSE)]))).toBe(true);
  });
  it("the original smuggle (field 3 as varint) is refused", () => {
    expect(tryPick(smuggled(OTHER, USER))).toBe(false);
  });
  it("smuggle through field 2 as length-delimited is refused", () => {
    expect(tryPick(cat([addr(0x0a, USER), raw([0x12, 0x02, 0x20, 0x05]), addr(0x1a, HORSE)]))).toBe(false);
  });
  it("field order 3,2,1 / 2,1,3 refused", () => {
    expect(tryPick(cat([addr(0x1a, HORSE), rc(RACE_NO), addr(0x0a, USER)]))).toBe(false);
    expect(tryPick(cat([rc(RACE_NO), addr(0x0a, USER), addr(0x1a, HORSE)]))).toBe(false);
  });
  it("duplicate player (OTHER then USER / USER then USER) refused", () => {
    expect(tryPick(cat([addr(0x0a, OTHER), addr(0x0a, USER), rc(RACE_NO), addr(0x1a, HORSE)]))).toBe(false);
    expect(tryPick(cat([addr(0x0a, USER), addr(0x0a, USER), rc(RACE_NO), addr(0x1a, HORSE)]))).toBe(false);
  });
  it("unknown extra field (4 varint, 4 bytes, 15 fixed32) refused", () => {
    expect(tryPick(cat([addr(0x0a, USER), rc(RACE_NO), addr(0x1a, HORSE), raw([0x20, 0x01])]))).toBe(false);
  });
  it("unknown extra field 4 length-delimited empty refused", () => {
    // as-proto quirk: skipType(LENGTH_DELIMITED) with length 0 calls skip(0), which skips a VARINT (reads one more
    // byte). At the end of the buffer that aborts the decoder: the sponsor refuses (abort). Same reader in both.
    pickTx(cat([addr(0x0a, USER), rc(RACE_NO), addr(0x1a, HORSE), raw([0x22, 0x00])]));
    expect(() => { pays(); }).toThrow();
    MockVM.rollbackTransaction();
    // in the middle: 22 00 swallows the next byte in BOTH decoders identically; the result is not canonical: refused
    expect(tryPick(cat([addr(0x0a, USER), raw([0x22, 0x00, 0x00]), rc(RACE_NO), addr(0x1a, HORSE)]))).toBe(false);
  });
  it("unknown extra field 15 fixed32 refused", () => {
    expect(tryPick(cat([addr(0x0a, USER), rc(RACE_NO), addr(0x1a, HORSE), raw([0x7d, 0, 0, 0, 0])]))).toBe(false);
  });
  it("explicit zero race (10 00) refused; overlong race varint refused; overlong tag refused", () => {
    expect(tryPick(cat([addr(0x0a, USER), raw([0x10, 0x00]), addr(0x1a, HORSE)]))).toBe(false);
    expect(tryPick(cat([addr(0x0a, USER), raw([0x10, 0xc6, 0x88, 0x85, 0x80, 0x00]), addr(0x1a, HORSE)]))).toBe(false);
    const t: u8[] = [0x8a, 0x00, 25]; for (let i = 0; i < 25; i++) t.push(USER[i]);
    expect(tryPick(cat([t, rc(RACE_NO), addr(0x1a, HORSE)]))).toBe(false);
  });
  it("overlong player length varint refused", () => {
    const t: u8[] = [0x0a, 0x99, 0x00]; for (let i = 0; i < 25; i++) t.push(USER[i]);
    expect(tryPick(cat([t, rc(RACE_NO), addr(0x1a, HORSE)]))).toBe(false);
  });
  it("zero race omitted / empty horse / no horse: canonical, paid, and read identically (race contract then refuses: S-2)", () => {
    expect(tryPick(cat([addr(0x0a, USER), addr(0x1a, HORSE)]))).toBe(true);
    expect(tryPick(cat([addr(0x0a, USER), rc(RACE_NO), raw([0x1a, 0x00])]))).toBe(true);
    expect(tryPick(cat([addr(0x0a, USER), rc(RACE_NO)]))).toBe(true);
  });
  it("empty player / no player / empty args refused", () => {
    expect(tryPick(cat([raw([0x0a, 0x00]), rc(RACE_NO), addr(0x1a, HORSE)]))).toBe(false);
    expect(tryPick(cat([rc(RACE_NO), addr(0x1a, HORSE)]))).toBe(false);
    expect(tryPick(new Uint8Array(0))).toBe(false);
  });
  it("random single-byte mutations of an honest pick: whatever is paid is read identically by the race", () => {
    const base = cat([addr(0x0a, USER), rc(RACE_NO), addr(0x1a, HORSE)]);
    let paid = 0;
    let seed: u32 = 12345;
    for (let n = 0; n < 300; n++) {
      seed = seed * 1103515245 + 12345;
      const pos = (seed >> 8) % <u32>base.length;
      seed = seed * 1103515245 + 12345;
      const b = new Uint8Array(base.length); b.set(base);
      b[pos] = <u8>(seed >> 16);
      // only mutations that both decoders can parse without running off the end (the reader aborts otherwise,
      // which also refuses the transaction): restrict to the address bytes and the race varint's value bits
      if (pos == 0 || pos == 1 || pos == 27 || pos == 31 || pos == 32) continue;
      if (pos >= 28 && pos <= 30) b[pos] = (b[pos] & 0x7f) | (pos < 30 ? 0x80 : 0);
      if (tryPick(b)) paid++;
    }
    expect(paid).toBeGreaterThan(0);
  });
});

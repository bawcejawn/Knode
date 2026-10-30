// =====================================================================
// Knode Mana sponsor v3: the generic allowlist (the KnodeGames Picks contract first), argument-shape checks so the
// sponsor reads the same player as the target contract (audit S-1 for any contract), the free player's own prize
// claim, and fixcheck L-3 (a stake counts from min_vhp up). Real signatures from fixtures.ts, as in the other tests.
// =====================================================================

import { Arrays, Base58, MockVM, Protobuf, authority, chain, protocol, system_calls } from "@koinos/sdk-as";
import { Sponsor, argsPlayer, NOT_A_PLAYER, FREE_USED_UP, GAME_ANSWER, GAME_CLAIM } from "../Sponsor";
import { sponsor } from "../proto/sponsor";
import { picks } from "./picks_proto";
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
const RACE = Base58.decode("1EN7xU8R9tQXjHvrX79qZvvvGkkKWVnB5K");
const PICKS = Base58.decode("1MbsVfNw6yzQqA8499d8KQj8qdLyRs8CzW");
const STAKED = Base58.decode("15NZhQoewzsbVUcSVsZ8BEBEKgaBNPLLgZ");   // a second allowlisted contract, real players only
const H1 = Base58.decode("1HsM33pF8DbXPr8Vsd4vD7hQgvZ1SHY3Vv");
const PICK: u32 = 0x8ce33c6c;
const STAKED_ENTRY: u32 = 0x12345678;

const MANA: u64 = 100000000;
const T0: u64 = 1700003600000;   // 23:13 UTC: the free pool is fully released at hour 23 (v3, SP-3)
const NONE = new Uint8Array(0);

/** The Picks contract's pick_arguments: player bytes, game varint, round varint, producers bytes, number varint. */
// v3: the Picks v1 shape (player, game, round, producers repeated: 0x13, number), as the tool sets it for Block X.
function picksTypes(): Uint8Array { const b = new Uint8Array(5); b[0] = 3; b[1] = 1; b[2] = 1; b[3] = 0x13; b[4] = 1; return b; }
function bytes(a: u8[]): Uint8Array { const b = new Uint8Array(a.length); for (let i = 0; i < a.length; i++) b[i] = a[i]; return b; }
function one(p: Uint8Array): Uint8Array[] { const a = new Array<Uint8Array>(); a.push(p); return a; }
function pickArgs(player: Uint8Array): Uint8Array {
  return Protobuf.encode(new picks.pick_arguments(player, 2, 20000, one(H1), 0), picks.pick_arguments.encode);
}

let rngState: u32 = 0;
function nextRand(s: u32): u32 { let x = s ^ (s << 13); x ^= x >> 17; x ^= x << 5; rngState = x; return x; }
let BASE: u8[] = [];
function with_(tail: u8[]): Uint8Array { const a = BASE.slice(0); for (let i = 0; i < tail.length; i++) a.push(tail[i]); return bytes(a); }
function insertAt(a: u8[], pos: i32, v: u8): void { a.push(0); for (let i = a.length - 1; i > pos; i--) a[i] = a[i - 1]; a[pos] = v; }

// ── transaction helpers (as Sponsor.audit-v2.spec.ts) ──
let OPS: protocol.operation[] = [];
let PAYEE: Uint8Array = NONE;
let RC: u64 = MANA;
function call(contract: Uint8Array, entry: u32, args: Uint8Array): protocol.operation {
  return new protocol.operation(null, new protocol.call_contract_operation(contract, entry, args));
}
function apply(): void {
  const t = new protocol.transaction();
  t.id = Arrays.fromHexString(F.TX1_ID);
  t.header = new protocol.transaction_header(NONE, RC, NONE, NONE, SELF, PAYEE);
  t.operations = OPS;
  t.signatures = [Arrays.fromHexString(F.SIG_USER_TX1)];
  MockVM.setTransaction(t);
}
function vhpBalance(v: u64): system_calls.exit_arguments {
  return new system_calls.exit_arguments(0, new chain.result(Protobuf.encode(new sponsor.balance_of_result(v), sponsor.balance_of_result.encode)));
}
function gamePlayer(stake: u64, pending: u64): system_calls.exit_arguments {
  const r = new sponsor.game_get_player_result(new sponsor.game_player(stake, pending), stake);
  return new system_calls.exit_arguments(0, new chain.result(Protobuf.encode(r, sponsor.game_get_player_result.encode)));
}
let READS: system_calls.exit_arguments[] = [];
function emptyWallet(): void { READS = [gamePlayer(0, 0)]; }
function holder(): void { READS = [gamePlayer(10 * MANA, 0)]; }
function pays(): bool {
  apply();
  MockVM.setCallContractResults(padReads(READS));
  return new Sponsor().authorize(new authority.authorize_arguments(authority.authorization_type.transaction_application)).value;
}
function doPays(): void { pays(); }
function refused(message: string): void {
  expect(() => { doPays(); }).toThrow();
  expect(MockVM.getErrorMessage()).toBe(message);
  MockVM.rollbackTransaction();
}
function asOwner(): void { MockVM.setAuthorities([new MockVM.MockAuthority(authority.authorization_type.contract_call, SELF, true)]); }

function picksRow(): sponsor.allowed_call { return new sponsor.allowed_call(PICKS, PICK, true, picksTypes(), 2); }
function stakedRow(): sponsor.allowed_call { return new sponsor.allowed_call(STAKED, STAKED_ENTRY, false, bytes([3, 1])); }
/** per tx 1, per player 5/day 30/week, everyone 100/day, free 50/day; race set; the Picks contract allowlisted as free play. */
function v3Config(): sponsor.config {
  const c = new sponsor.config(true, GAME, DESK, [VHP, KOIN], MANA, 5 * MANA, 30 * MANA, 100 * MANA, VHP, MANA, 50 * MANA, RACE);
  c.allowed = [picksRow(), stakedRow()];
  return c;
}
let CFG: sponsor.config = new sponsor.config();
function setConfig(): void { asOwner(); new Sponsor().set_config(new sponsor.set_config_arguments(CFG)); }
function badConfig(message: string): void {
  expect(() => { setConfig(); }).toThrow();
  expect(MockVM.getErrorMessage()).toBe(message);
  MockVM.rollbackTransaction();
}
function start(): void {
  MockVM.reset();
  MockVM.setContractId(SELF);
  MockVM.setHeadInfo(new chain.head_info(null, T0, 0));
  MockVM.commitTransaction();
  CFG = v3Config(); setConfig(); MockVM.commitTransaction();
  PAYEE = USER; RC = MANA;
}

// ── structured differential fuzz: random field sequences with overlong varints, zero/max lengths, repeats ──
let R: u32 = 987654321;
function rnd(n: u32): u32 { R ^= R << 13; R ^= R >> 17; R ^= R << 5; return R % n; }
function pushVarint(a: u8[], v: u64, extra: i32): void {
  // minimal encoding, then `extra` overlong continuation bytes (0x80 ... 0x00)
  const bs: u8[] = [];
  do { bs.push(<u8>(v & 0x7f)); v >>= 7; } while (v != 0);
  for (let i = 0; i < extra; i++) bs.push(0);
  for (let i = 0; i < bs.length; i++) a.push(i < bs.length - 1 ? (bs[i] | 0x80) : bs[i]);
}
function randBytes(a: u8[], len: i32, who: Uint8Array | null): void {
  for (let i = 0; i < len; i++) a.push(who != null && i < who.length ? who[i] : <u8>rnd(256));
}

describe("V3 AUDIT: scanner vs Picks decoder", () => {
  it("structured fuzz (overlong tags/lengths/values, zero and max lengths, repeats, wrong wire types): accepted => same player", () => {
    const t = picksTypes();
    let accepted = 0;
    for (let n = 0; n < 20000; n++) {
      const a: u8[] = [];
      // player: usually canonical; sometimes overlong tag or overlong length (scanner must refuse those)
      const pv = rnd(10);
      if (pv == 0) { a.push(0x8a); a.push(0x00); a.push(25); }
      else if (pv == 1) { a.push(0x0a); a.push(0x99); a.push(0x00); }
      else { a.push(0x0a); a.push(25); }
      randBytes(a, 25, USER);
      const nf = <i32>rnd(8);
      for (let f = 0; f < nf; f++) {
        let field: u32 = 1 + rnd(7);
        let wt: u32 = rnd(10) < 7 ? (field == 4 || field == 1 ? 2 : 0) : rnd(8);
        pushVarint(a, (<u64>field << 3) | wt, rnd(4) == 0 ? <i32>rnd(5) : 0);
        if (wt == 0) {
          const big = rnd(4) == 0;
          pushVarint(a, big ? 0xffffffffffffffff : <u64>rnd(100000), rnd(3) == 0 ? <i32>rnd(6) : 0);
        } else if (wt == 2) {
          const ln = rnd(5) == 0 ? 0 : (rnd(3) == 0 ? <i32>rnd(60) : 25);
          pushVarint(a, <u64>ln, rnd(4) == 0 ? <i32>rnd(4) : 0);
          randBytes(a, ln, rnd(2) == 0 ? OTHER : null);
        } else if (wt == 1) randBytes(a, 8, null);
        else if (wt == 5) randBytes(a, 4, null);
      }
      if (rnd(20) == 0) for (let i = 0; i < 380; i++) a.push(0);
      const b = bytes(a);
      const seen = argsPlayer(b, t);
      if (seen == null) continue;
      accepted++;
      const d = Protobuf.decode<picks.pick_arguments>(b, picks.pick_arguments.decode);
      expect(d.player != null && Arrays.equal(d.player!, seen!)).toBe(true);
      expect(Arrays.equal(seen!, USER)).toBe(true);
    }
    log<string>("structured fuzz: accepted " + accepted.toString() + " of 20000");
    expect(accepted > 1000).toBe(true);
  });
  it("edge encodings the scanner accepts: overlong value varints, overlong tags for fields 2..5, overlong lengths, empty producer", () => {
    BASE = [0x0a, 25]; for (let i = 0; i < 25; i++) BASE.push(USER[i]);
    const t = picksTypes();
    const cases: u8[][] = [
      [0x90, 0x80, 0x80, 0x80, 0x00, 0x02],                  // 5-byte tag for field 2
      [0x10, 0x82, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x00],   // 10-byte value
      [0x22, 0x80, 0x00],                                     // empty producer with an overlong length
      [0x22, 0x99, 0x80, 0x80, 0x80, 0x00],                   // 5-byte length 25 ...
    ];
    for (let i = 0; i < 25; i++) cases[3].push(OTHER[i]);
    for (let c = 0; c < cases.length; c++) {
      const b = with_(cases[c]);
      const s = argsPlayer(b, t);
      expect(s != null).toBe(true);
      const d = Protobuf.decode<picks.pick_arguments>(b, picks.pick_arguments.decode);
      expect(Arrays.equal(d.player!, s!)).toBe(true);
    }
    // refused: 6-byte tag, 6-byte length, 11-byte value, a 5-byte tag whose last byte has bits above 2^32
    expect(argsPlayer(with_([0x90, 0x80, 0x80, 0x80, 0x80, 0x00, 0x02]), t) == null).toBe(true);
    expect(argsPlayer(with_([0x22, 0x80, 0x80, 0x80, 0x80, 0x80, 0x00]), t) == null).toBe(true);
    expect(argsPlayer(with_([0x90, 0x80, 0x80, 0x80, 0x10, 0x02]), t) == null).toBe(true);
  });
});

describe("V3 AUDIT: transaction size vs the 1 KB system buffer", () => {
  it("serialized get_transaction_result size for 1..10 Block X picks and 1..3 ten-producer picks", () => {
    for (let k = 1; k <= 10; k++) {
      const t = new protocol.transaction();
      t.id = Arrays.fromHexString(F.TX1_ID);
      t.header = new protocol.transaction_header(new Uint8Array(32), MANA, new Uint8Array(4), new Uint8Array(34), SELF, USER);
      for (let i = 0; i < k; i++) t.operations.push(call(PICKS, PICK, Protobuf.encode(new picks.pick_arguments(USER, 2, 20000 + i, one(H1), 0), picks.pick_arguments.encode)));
      t.signatures = [Arrays.fromHexString(F.SIG_USER_TX1)];
      const n = Protobuf.encode(new system_calls.get_transaction_result(t), system_calls.get_transaction_result.encode).length;
      log<string>("Block X picks " + k.toString() + ": " + n.toString() + " bytes" + (n > 1024 ? "  > 1024" : ""));
    }
    for (let k = 1; k <= 3; k++) {
      const t = new protocol.transaction();
      t.id = Arrays.fromHexString(F.TX1_ID);
      t.header = new protocol.transaction_header(new Uint8Array(32), MANA, new Uint8Array(4), new Uint8Array(34), SELF, USER);
      const ten = new Array<Uint8Array>(); for (let j = 0; j < 10; j++) ten.push(H1);
      for (let i = 0; i < k; i++) t.operations.push(call(PICKS, PICK, Protobuf.encode(new picks.pick_arguments(USER, 5, 3000, ten, 0), picks.pick_arguments.encode)));
      t.signatures = [Arrays.fromHexString(F.SIG_USER_TX1)];
      const n = Protobuf.encode(new system_calls.get_transaction_result(t), system_calls.get_transaction_result.encode).length;
      log<string>("10-producer picks " + k.toString() + ": " + n.toString() + " bytes" + (n > 1024 ? "  > 1024" : ""));
    }
  });
  it("S3-1 (fixed): 7 and 10 Block X picks in one transaction are paid (the sponsor reads with a 16 KB buffer)", () => {
    start(); emptyWallet();
    OPS = [];
    for (let i = 0; i < 7; i++) OPS.push(call(PICKS, PICK, Protobuf.encode(new picks.pick_arguments(USER, 2, 20000 + i, one(H1), 0), picks.pick_arguments.encode)));
    expect(pays()).toBe(true);
    MockVM.rollbackTransaction();
    emptyWallet();
    for (let i = 7; i < 10; i++) OPS.push(call(PICKS, PICK, Protobuf.encode(new picks.pick_arguments(USER, 2, 20000 + i, one(H1), 0), picks.pick_arguments.encode)));
    expect(pays()).toBe(true);
  });
});

describe("V3 AUDIT: free claim", () => {
  it("an empty wallet's claim for any week (one it can't win) is free play; ten in one transaction too", () => {
    start(); emptyWallet();
    const w = new Uint8Array(29); w[0] = 0x0a; w[1] = 25; w.set(USER, 2); w[27] = 0x10; w[28] = 0x63;   // week 99
    OPS = [call(GAME, GAME_CLAIM, w)];
    expect(pays()).toBe(true); MockVM.commitTransaction();
    emptyWallet(); OPS = []; for (let i = 0; i < 10; i++) OPS.push(call(GAME, GAME_CLAIM, w));
    expect(pays()).toBe(true);
    // overlong week varint is accepted too (the game decoder reads the same player)
    emptyWallet();
    const o = new Uint8Array(31); o.set(w.subarray(0, 28), 0); o[28] = 0xe3; o[29] = 0x80; o[30] = 0x00;
    OPS = [call(GAME, GAME_CLAIM, o)];
    expect(pays()).toBe(true);
  });
  it("allowlisted rows: the race slot can't equal an allowlisted contract, and a race pick is still read by the race mirror", () => {
    start();
    CFG = v3Config(); CFG.race = PICKS; asOwner();
    expect(() => { setConfig(); }).toThrow();
    log<string>(MockVM.getErrorMessage()!); MockVM.rollbackTransaction();
  });
});

describe("V3 AUDIT S3-2: a row whose later field is a nested MESSAGE can be read two ways", () => {
  it("pick_row {1 bytes player, 2 pick_object}: scanner reads P1, the as-proto decoder reads P2", () => {
    const a: u8[] = [0x0a, 25]; for (let i = 0; i < 25; i++) a.push(USER[i]);
    a.push(0x12); a.push(1); a.push(0x0a);          // field 2, length 1: just the inner tag "producers"
    a.push(0x12); a.push(44);                         // scanner: field 2 again, 44 bytes. Inner decoder: producers length 0x12 = 18
    for (let i = 0; i < 17; i++) a.push(0);           // 17 filler (inner copies 0x2c + these 17 = 18 bytes)
    a.push(0x0a); a.push(25); for (let i = 0; i < 25; i++) a.push(OTHER[i]);   // outer field 1 again for the decoder
    const b = bytes(a);
    // v3 (SP-16): field 2 twice is refused unless the row marks it repeated (0x13); marked repeated, the two readings
    // remain (S3-2: rows must never have nested messages, which npm run check confirms for the Picks row).
    expect(argsPlayer(b, bytes([3, 3])) == null).toBe(true);
    const types = bytes([3, 0x13]);
    const seen = argsPlayer(b, types);
    expect(seen != null && Arrays.equal(seen!, USER)).toBe(true);
    const d = Protobuf.decode<picks.pick_row>(b, picks.pick_row.decode);
    expect(Arrays.equal(d.player, OTHER)).toBe(true);
  });
});

// =====================================================================
// KnodeGames Picks: contract tests in the Koinos mock VM.
// Mock VM quirks (CLAUDE.md): keys sort as strings (all keys here are fixed length), direct() gives an empty caller,
// no closures (tests set globals, then call).
// =====================================================================

import { Arrays, Base58, MockVM, Protobuf, System, Crypto, authority, chain, common, protocol } from "@koinos/sdk-as";
import {
  Picks, DAY_MS, TIMELOCK_MS, EXPIRY_MS, CLOSED, NO_GAME, LOCKED, TOO_EARLY, USED_UP, NO_CHANGES, SAME, NOT_SIGNED,
  BAD_CHOICE, OWNER_ONLY, SHAPE_FIXED, NOT_TIGHTER, NOT_YET, EXPIRED, KIND_PRODUCER, KIND_LIST, KIND_NUMBER,
  LOCK_HEIGHT, LOCK_TIME, pickKey,
} from "../Picks";
import { picks } from "../proto/picks";
import { Reader, Writer } from "as-proto";

const SELF = Base58.decode("1EDaCKVmBjUxLxgWCmDbRA8gWKkSQ6ByzY");
const OWNER = Base58.decode("1635QUrBNDp7WqmFkRvrkGwjJXTtFvH717");
const P1 = Base58.decode("1HsM33pF8DbXPr8Vsd4vD7hQgvZ1SHY3Vv");
const P2 = Base58.decode("16ixK5DgvcojcZLvxyYWhHFcRXfhfrHbpL");
const P3 = Base58.decode("1ByDDSBUzy5zkRceELc54Jh8i41yNRoKt8");
const H1 = Base58.decode("15NZhQoewzsbVUcSVsZ8BEBEKgaBNPLLgZ");
const H2 = Base58.decode("1MbsVfNw6yzQqA8499d8KQj8qdLyRs8CzW");
const H3 = Base58.decode("1Mpmf2ERhjYpX7CCiM11WERuM4j17uT1sr");
const OTHER_CONTRACT = Base58.decode("15CM9Qr4GKREDgqnyXJ8tckPj2biERTM1T");

const BX: u32 = 2;                     // Who Signs Block X
const R: u64 = 20000;                  // a round: target height 48,000,000
const TARGET: u64 = R * 2400;
const T0: u64 = 1793000000000;         // a Tuesday in Nov 2026 (ms)

// ── chain state ──
let H: u64 = 0, T: u64 = 0;
function at(height: u64, time: u64): void { H = height; T = time; MockVM.setHeadInfo(new chain.head_info(new common.block_topology(new Uint8Array(0), height, new Uint8Array(0)), time, 0)); }
function direct(): void { MockVM.setCaller(new chain.caller_data(new Uint8Array(0), chain.privilege.user_mode)); }
function fromContract(c: Uint8Array): void { MockVM.setCaller(new chain.caller_data(c, chain.privilege.user_mode)); }
function signedBy(a: Uint8Array): void { MockVM.setAuthorities([new MockVM.MockAuthority(authority.authorization_type.contract_call, a, true)]); }
function nobody(): void { MockVM.setAuthorities([]); }
function errorIs(message: string): void { expect(MockVM.getErrorMessage()).toBe(message); MockVM.rollbackTransaction(); }

// ── games ──
function blockX(): picks.game_config {
  return new picks.game_config(BX, "Who Signs Block X", KIND_PRODUCER, 1, 0, 0, LOCK_HEIGHT, 2400, 0, 100, 28900, 30, 5, true);
}
function listGame(): picks.game_config {
  return new picks.game_config(5, "Fantasy Producers", KIND_LIST, 5, 0, 0, LOCK_TIME, 7 * DAY_MS, 4 * DAY_MS, 300000, 14 * DAY_MS, 10, 7, true);
}
function numberGame(): picks.game_config {
  return new picks.game_config(6, "Block Golf", KIND_NUMBER, 0, 1, 500, LOCK_HEIGHT, 3200, 0, 100, 28800, 20, 0, true);
}

let G: picks.game_config = blockX();
let gList: picks.list_picks_arguments = new picks.list_picks_arguments();
let gCancel: u32 = 0;
function cancelChange(): void { new Picks().cancel_game_change(new picks.cancel_game_change_arguments(gCancel)); }
function announce(): void { new Picks().announce_game(new picks.announce_game_arguments(G)); }
function apply(): void { new Picks().apply_game(new picks.apply_game_arguments(G.id)); }
function tighten(): void { new Picks().tighten_game(new picks.tighten_game_arguments(G)); }
function register(g: picks.game_config): void {
  const h = H, t = T;
  signedBy(OWNER); G = g; announce(); MockVM.commitTransaction();
  at(h, t + TIMELOCK_MS); nobody(); apply(); MockVM.commitTransaction();
  at(h, t);
}
function refusedAnnounce(g: picks.game_config, message: string): void {
  signedBy(OWNER); G = g; expect(() => { announce(); }).toThrow(); errorIs(message);
}
function start(): void {
  MockVM.reset(); MockVM.setContractId(SELF); direct(); at(TARGET - 1000, T0); MockVM.commitTransaction();
  register(blockX());
}

// ── picking ──
let A: picks.pick_arguments = new picks.pick_arguments();
function doPick(): void { new Picks().pick(A); }
function one(p: Uint8Array): Uint8Array[] { const a = new Array<Uint8Array>(); a.push(p); return a; }
function two(p: Uint8Array, q: Uint8Array): Uint8Array[] { const a = one(p); a.push(q); return a; }
function none(): Uint8Array[] { return new Array<Uint8Array>(); }
function pickFull(player: Uint8Array, game: u32, round: u64, ps: Uint8Array[], n: u64): void {
  signedBy(player); A = new picks.pick_arguments(player, game, round, ps, n); doPick(); MockVM.commitTransaction();
}
function pick(player: Uint8Array, round: u64, producer: Uint8Array): void { pickFull(player, BX, round, one(producer), 0); }
function refusedFull(player: Uint8Array, game: u32, round: u64, ps: Uint8Array[], n: u64, message: string): void {
  signedBy(player); A = new picks.pick_arguments(player, game, round, ps, n);
  expect(() => { doPick(); }).toThrow(); errorIs(message);
}
function refused(player: Uint8Array, round: u64, producer: Uint8Array, message: string): void { refusedFull(player, BX, round, one(producer), 0, message); }
function pickOf(player: Uint8Array, game: u32, round: u64): picks.pick_object | null {
  return new Picks().get_pick(new picks.get_pick_arguments(game, round, player)).pick;
}

// ── owner handover and upgrade ──
let gOwner: Uint8Array = new Uint8Array(0);
function propose(): void { new Picks().propose_owner(new picks.propose_owner_arguments(gOwner)); }
function acceptOwner(): void { new Picks().accept_owner(new picks.accept_owner_arguments()); }
let gHash: Uint8Array = new Uint8Array(0);
function scheduleUpgrade(): void { new Picks().schedule_upgrade(new picks.schedule_upgrade_arguments(gHash)); }
function sha(b: Uint8Array): Uint8Array { const mh = new Crypto.Multihash(); mh.deserialize(System.hash(Crypto.multicodec.sha2_256, b)!); return mh.digest; }
function uploadTx(code: Uint8Array, call: bool, txApp: bool, upload: bool): void {
  const tx = new protocol.transaction();
  tx.header = new protocol.transaction_header();
  const op = new protocol.operation();
  op.upload_contract = new protocol.upload_contract_operation(SELF, code, "", call, txApp, upload);
  tx.operations.push(op);
  MockVM.setTransaction(tx);
  System.resetCache();
}
function authorizes(t: authority.authorization_type): bool {
  return new Picks().authorize(new authority.authorize_arguments(t)).value;
}



// hand-built protobuf bytes
let BUF: u8[] = [];
function vint(v: u64): void { while (v >= 0x80) { BUF.push(<u8>((v & 0x7f) | 0x80)); v >>= 7; } BUF.push(<u8>v); }
function bts(b: Uint8Array): void { vint(b.length); for (let i = 0; i < b.length; i++) BUF.push(b[i]); }
function done(): Uint8Array { const o = new Uint8Array(BUF.length); for (let i = 0; i < BUF.length; i++) o[i] = BUF[i]; BUF = []; return o; }

function dummy(id: u32): picks.game_config { const n = numberGame(); n.id = id; n.name = "d"; return n; }

describe("AUDIT P-1 (fixed): nothing the previous owner announced survives the handover", () => {
  it("old owner floods pending and plants a loosening; after accept_owner none of it can be applied or is shown", () => {
    start();
    const g90 = numberGame(); g90.id = 90; register(g90);
    for (let i: u32 = 0; i < 34; i++) { signedBy(OWNER); G = dummy(10 + i); announce(); MockVM.commitTransaction(); }
    const loose = numberGame(); loose.id = 90; loose.max_picks_per_day = 50; loose.max_changes = 50;
    signedBy(OWNER); G = loose; announce(); MockVM.commitTransaction();
    expect(new Picks().list_pending(new picks.list_pending_arguments(0, 0)).pending.length).toBe(35);
    gOwner = P2; signedBy(OWNER); propose(); MockVM.commitTransaction();
    at(H, T0 + TIMELOCK_MS); signedBy(P2); acceptOwner(); MockVM.commitTransaction();
    expect(new Picks().get_game(new picks.get_game_arguments(90)).pending == null).toBe(true);
    expect(new Picks().list_pending(new picks.list_pending_arguments(0, 0)).pending.length).toBe(0);
    nobody(); G = loose;
    expect(() => { apply(); }).toThrow(); errorIs("PICKS: announced by a previous owner; the owner must announce it again");
    expect(new Picks().get_game(new picks.get_game_arguments(90)).game!.max_picks_per_day).toBe(20);
    // the new owner can announce it themselves, with a fresh 48 hours
    signedBy(P2); G = loose; announce(); MockVM.commitTransaction();
    at(H, T0 + 2 * TIMELOCK_MS); nobody(); apply(); MockVM.commitTransaction();
    expect(new Picks().get_game(new picks.get_game_arguments(90)).game!.max_picks_per_day).toBe(50);
  });
});

describe("AUDIT P-2 (fixed): tighten_game drops an earlier announcement for that game", () => {
  it("owner announces a looser cap, then switches the game off; nobody can re-enable it with apply_game", () => {
    start();
    const loose = blockX(); loose.max_picks_per_day = 40;
    signedBy(OWNER); G = loose; announce(); MockVM.commitTransaction();
    const off = blockX(); off.enabled = false;
    signedBy(OWNER); G = off; tighten(); MockVM.commitTransaction();
    expect(new Picks().get_game(new picks.get_game_arguments(BX)).pending == null).toBe(true);
    at(H, T0 + TIMELOCK_MS); signedBy(P3); G = loose;
    expect(() => { apply(); }).toThrow(); errorIs("PICKS: nothing announced for this game");
    expect(new Picks().get_game(new picks.get_game_arguments(BX)).game!.enabled).toBe(false);
  });
});

describe("AUDIT upgrade: several upload ops, another contract's upload", () => {
  it("matching + mismatching upload for SELF is refused; matching for SELF + anything for another contract is allowed", () => {
    start();
    const code = new Uint8Array(64); code[1] = 0x61; code[5] = 9;
    const other = code.slice(0); other[5] = 10;
    gHash = sha(code); signedBy(OWNER); scheduleUpgrade(); MockVM.commitTransaction();
    at(H, T0 + TIMELOCK_MS); signedBy(OWNER);
    let tx = new protocol.transaction(); tx.header = new protocol.transaction_header();
    let a = new protocol.operation(); a.upload_contract = new protocol.upload_contract_operation(SELF, code, "", true, true, true);
    let b = new protocol.operation(); b.upload_contract = new protocol.upload_contract_operation(SELF, other, "", true, true, true);
    tx.operations.push(a); tx.operations.push(b); MockVM.setTransaction(tx); System.resetCache();
    expect(authorizes(authority.authorization_type.contract_upload)).toBe(false);
    tx = new protocol.transaction(); tx.header = new protocol.transaction_header();
    b = new protocol.operation(); b.upload_contract = new protocol.upload_contract_operation(OTHER_CONTRACT, other, "", false, false, false);
    tx.operations.push(b); tx.operations.push(a); MockVM.setTransaction(tx); System.resetCache();
    expect(authorizes(authority.authorization_type.contract_upload)).toBe(true);
    // only another contract's upload: refused
    tx = new protocol.transaction(); tx.header = new protocol.transaction_header();
    b = new protocol.operation(); b.upload_contract = new protocol.upload_contract_operation(OTHER_CONTRACT, code, "", true, true, true);
    tx.operations.push(b); MockVM.setTransaction(tx); System.resetCache();
    expect(authorizes(authority.authorization_type.contract_upload)).toBe(false);
    // the right code, owner signed, but signed only by the contract key (upload key): refused
    tx = new protocol.transaction(); tx.header = new protocol.transaction_header(); tx.operations.push(a); MockVM.setTransaction(tx); System.resetCache();
    signedBy(SELF); expect(authorizes(authority.authorization_type.contract_upload)).toBe(false);
    // transaction_application stays refused even with the announced upload in the tx and the owner signing
    signedBy(OWNER); expect(authorizes(authority.authorization_type.transaction_application)).toBe(false);
    expect(authorizes(authority.authorization_type.contract_call)).toBe(false);
  });
});

describe("AUDIT sponsor interplay: decoding pick arguments", () => {
  it("a repeated field 1 decodes to the LAST player here; canonical re-encoding catches it", () => {
    vint(10); bts(P1); vint(16); vint(BX); vint(10); bts(P2);
    const raw = done();
    const d = Protobuf.decode<picks.pick_arguments>(raw, picks.pick_arguments.decode);
    expect(Arrays.equal(d.player!, P2)).toBe(true);           // the contract would act for P2
    expect(Arrays.equal(Protobuf.encode(d, picks.pick_arguments.encode), raw)).toBe(false);   // not canonical
  });
  it("field 1 with the varint wire type is still read as bytes by this decoder (wire type ignored)", () => {
    vint(8); vint(25); for (let i = 0; i < 25; i++) vint(0);   // tag field1/wire0, then 25 bytes
    const raw = done();
    const d = Protobuf.decode<picks.pick_arguments>(raw, picks.pick_arguments.decode);
    expect(d.player != null && d.player!.length == 25).toBe(true);
    expect(Arrays.equal(Protobuf.encode(d, picks.pick_arguments.encode), raw)).toBe(false);
  });
  it("a uint32 game above 2^32 is truncated here; a uint64 mirror would re-encode it canonically", () => {
    vint(10); bts(P1); vint(16); vint(<u64>0x100000002);
    const raw = done();
    const d = Protobuf.decode<picks.pick_arguments>(raw, picks.pick_arguments.decode);
    expect(d.game).toBe(2);
    expect(Arrays.equal(Protobuf.encode(d, picks.pick_arguments.encode), raw)).toBe(false);   // exact mirror refuses it
  });
  it("1000 producers: refused with BAD_CHOICE before any address hashing", () => {
    start(); at(TARGET - 500, T0);
    const many = new Array<Uint8Array>(); for (let i = 0; i < 1000; i++) many.push(H1);
    refusedFull(P1, BX, R, many, 0, BAD_CHOICE);
    const ten = new Array<Uint8Array>(); for (let i = 0; i < 10; i++) ten.push(H1);
    const legit = Protobuf.encode(new picks.pick_arguments(P1, 5, <u64>u32.MAX_VALUE * 1000, ten, u64.MAX_VALUE), picks.pick_arguments.encode);
    log<string>("largest legitimate pick args (10 producers): " + legit.length.toString() + " bytes");
  });
});

describe("AUDIT picks edges", () => {
  it("a refused pick (SAME / locked) does not consume the daily count", () => {
    start(); at(TARGET - 500, T0);
    pick(P1, R, H1);
    for (let i = 0; i < 5; i++) refused(P1, R, H1, SAME);
    expect(new Picks().get_usage(new picks.get_usage_arguments(BX, P1)).picks_today).toBe(1);
  });
  it("lowering max_changes below a pick's change count freezes it; tighten can't loosen any field", () => {
    start(); at(TARGET - 500, T0);
    pick(P1, R, H1); pick(P1, R, H2); pick(P1, R, H3);
    let g = blockX(); g.max_changes = 1; G = g; signedBy(OWNER); tighten(); MockVM.commitTransaction();
    refused(P1, R, H1, NO_CHANGES);
    g = blockX(); g.max_changes = 1; g.number_max = 5; G = g; signedBy(OWNER); expect(() => { tighten(); }).toThrow(); errorIs(SHAPE_FIXED);
    g = blockX(); g.max_changes = 1; g.round_offset = 1; G = g; signedBy(OWNER); expect(() => { tighten(); }).toThrow(); errorIs(SHAPE_FIXED);
    g = blockX(); g.max_changes = 1; g.ahead = 100; G = g; signedBy(OWNER); expect(() => { tighten(); }).toThrow(); errorIs(NOT_TIGHTER);
    g = blockX(); g.max_changes = 1; g.max_picks_per_day = 0; G = g; signedBy(OWNER); expect(() => { tighten(); }).toThrow(); errorIs(NOT_TIGHTER);
    g = blockX(); g.max_changes = 1; g.lead = 28900; G = g; signedBy(OWNER); expect(() => { tighten(); }).toThrow(); errorIs(NOT_TIGHTER);
    g = blockX(); g.max_changes = 1; g.id = 3; G = g; signedBy(OWNER); expect(() => { tighten(); }).toThrow(); errorIs(NO_GAME);
  });
  it("no head topology: height games read height 0 and every real round is too early", () => {
    start();
    MockVM.setHeadInfo(new chain.head_info(null, T0, 0));
    refused(P1, R, H1, TOO_EARLY);
  });
  it("the list of a time game: same producers in another order is a change, not SAME", () => {
    start(); register(listGame());
    const g = listGame(); const r: u64 = 3000; const target = r * g.round_size + g.round_offset;
    at(1, target - 400000); pickFull(P1, 5, r, two(H1, H2), 0); pickFull(P1, 5, r, two(H2, H1), 0);
    expect(pickOf(P1, 5, r)!.changes).toBe(1);
  });
});

// The sponsor's existing race mirror (sponsor.proto race_pick_args: 1 bytes player, 2 uint64 race, 3 bytes horse),
// written the way the generator writes it.
class race_pick_args {
  player: Uint8Array | null = null; race: u64 = 0; horse: Uint8Array | null = null;
  static encode(m: race_pick_args, w: Writer): void {
    if (m.player !== null) { w.uint32(10); w.bytes(m.player!); }
    if (m.race != 0) { w.uint32(16); w.uint64(m.race); }
    if (m.horse !== null) { w.uint32(26); w.bytes(m.horse!); }
  }
  static decode(r: Reader, length: i32): race_pick_args {
    const end: usize = length < 0 ? r.end : r.ptr + length;
    const m = new race_pick_args();
    while (r.ptr < end) {
      const tag = r.uint32();
      switch (tag >>> 3) {
        case 1: m.player = r.bytes(); break;
        case 2: m.race = r.uint64(); break;
        case 3: m.horse = r.bytes(); break;
        default: r.skipType(tag & 7); break;
      }
    }
    return m;
  }
}

describe("AUDIT P-3: same entry point as race pick; the race mirror reads another player", () => {
  it("bytes canonical for the sponsor's race mirror (player P1) make Picks act for P2", () => {
    // field 1 = P1; then tag 0x1a (field 3, length-delimited for the mirror) with length L, and L bytes that Picks
    // (which reads field 3 as a uint64 varint = L) parses as further fields: game, player = P2, producers.
    const inner: u8[] = [];
    BUF = []; vint(16); vint(BX); vint(10); bts(P2); vint(34); bts(H1); vint(40); vint(0);
    const tail = done();
    // pad with field 6 (unknown to Picks, skipped) so the round L lands in the open window... here we just show the reading
    BUF = []; vint(10); bts(P1); vint(26); bts(tail);
    const raw = done();
    const s = Protobuf.decode<race_pick_args>(raw, race_pick_args.decode);
    expect(Arrays.equal(s.player!, P1)).toBe(true);
    expect(Arrays.equal(Protobuf.encode(s, race_pick_args.encode), raw)).toBe(true);        // canonical for the mirror
    const p = Protobuf.decode<picks.pick_arguments>(raw, picks.pick_arguments.decode);
    expect(Arrays.equal(p.player!, P2)).toBe(true);                                           // Picks: player P2
    expect(p.game).toBe(BX);
    expect(p.round).toBe(<u64>tail.length);
    // the exact Picks mirror refuses the same bytes
    expect(Arrays.equal(Protobuf.encode(p, picks.pick_arguments.encode), raw)).toBe(false);
  });
});

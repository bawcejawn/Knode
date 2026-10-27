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
const T0: u64 = 1700000000000;
const NONE = new Uint8Array(0);

/** The Picks contract's pick_arguments: player bytes, game varint, round varint, producers bytes, number varint. */
function picksTypes(): Uint8Array { const b = new Uint8Array(5); b[0] = 3; b[1] = 1; b[2] = 1; b[3] = 3; b[4] = 1; return b; }
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
  const r = new sponsor.game_get_player_result(new sponsor.game_player(stake, pending));
  return new system_calls.exit_arguments(0, new chain.result(Protobuf.encode(r, sponsor.game_get_player_result.encode)));
}
let READS: system_calls.exit_arguments[] = [];
function emptyWallet(): void { READS = [vhpBalance(0), gamePlayer(0, 0)]; }
function holder(): void { READS = [vhpBalance(10 * MANA)]; }
function pays(): bool {
  apply();
  MockVM.setCallContractResults(READS);
  return new Sponsor().authorize(new authority.authorize_arguments(authority.authorization_type.transaction_application)).value;
}
function doPays(): void { pays(); }
function refused(message: string): void {
  expect(() => { doPays(); }).toThrow();
  expect(MockVM.getErrorMessage()).toBe(message);
  MockVM.rollbackTransaction();
}
function asOwner(): void { MockVM.setAuthorities([new MockVM.MockAuthority(authority.authorization_type.contract_call, SELF, true)]); }

function picksRow(): sponsor.allowed_call { return new sponsor.allowed_call(PICKS, PICK, true, picksTypes()); }
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

describe("v3 allowlist: Picks contract picks are free play for the payee's own wallet", () => {
  it("an empty wallet's own pick is paid and counts against the free total", () => {
    start();
    emptyWallet();
    OPS = [call(PICKS, PICK, pickArgs(USER))];
    expect(pays()).toBe(true);
    MockVM.commitTransaction();
    expect(new Sponsor().get_free_usage(new sponsor.get_free_usage_arguments()).used_day).toBe(MANA);
  });
  it("several picks in one transaction are still free play", () => {
    start();
    emptyWallet();
    OPS = [call(PICKS, PICK, pickArgs(USER)), call(PICKS, PICK, pickArgs(USER)), call(PICKS, PICK, pickArgs(USER))];
    expect(pays()).toBe(true);
  });
  it("a pick for someone else, or another entry point on the Picks contract, is refused", () => {
    start();
    emptyWallet();
    OPS = [call(PICKS, PICK, pickArgs(OTHER))];
    refused("SPONSOR: an allowlisted call must be the payee's own, with arguments in the listed shape");
    OPS = [call(PICKS, 0x94871b42, pickArgs(USER))];                 // apply_game
    refused("SPONSOR: only Knode calls are sponsored");
  });
  it("a pick mixed with a real-players-only action is no longer free play", () => {
    start();
    emptyWallet();
    OPS = [call(PICKS, PICK, pickArgs(USER)), call(STAKED, STAKED_ENTRY, Protobuf.encode(new picks.get_usage_arguments(0, null), picks.get_usage_arguments.encode))];
    // STAKED takes (player, varint); build its args by hand: player first.
    const a = new Uint8Array(27 + 2); a[0] = 0x0a; a[1] = 25; a.set(USER, 2); a[27] = 0x10; a[28] = 7;
    OPS[1] = call(STAKED, STAKED_ENTRY, a);
    refused(NOT_A_PLAYER);
    holder();
    expect(pays()).toBe(true);
  });
  it("free picks stop at the free total; a real player's go on", () => {
    start();
    emptyWallet();
    for (let i = 0; i < 5; i++) { OPS = [call(PICKS, PICK, pickArgs(USER))]; expect(pays()).toBe(true); MockVM.commitTransaction(); }
    // the payee's own daily cap (5) is hit first here; check the free total with a smaller free cap
    CFG = v3Config(); CFG.max_mana_free_day = 2 * MANA; setConfig(); MockVM.commitTransaction();
    MockVM.setHeadInfo(new chain.head_info(null, T0 + 86400000, 0));
    for (let i = 0; i < 2; i++) { emptyWallet(); OPS = [call(PICKS, PICK, pickArgs(USER))]; expect(pays()).toBe(true); MockVM.commitTransaction(); }
    emptyWallet(); OPS = [call(PICKS, PICK, pickArgs(USER))];
    refused(FREE_USED_UP);
    holder();
    expect(pays()).toBe(true);
  });
});

describe("v3 argument shape: the sponsor reads the player exactly as the target contract will", () => {
  it("a canonical pick is read; the player must be first, once, 25 bytes", () => {
    const t = picksTypes();
    expect(Arrays.equal(argsPlayer(pickArgs(USER), t)!, USER)).toBe(true);
    // field 1 not first
    const swapped = Protobuf.encode(new picks.pick_arguments(null, 2, 20000, one(H1), 0), picks.pick_arguments.encode);
    const late = new Uint8Array(swapped.length + 27); late.set(swapped, 0); late[swapped.length] = 0x0a; late[swapped.length + 1] = 25; late.set(USER, swapped.length + 2);
    expect(argsPlayer(late, t) == null).toBe(true);
    // a second field 1 after the first (the contract would read the last one)
    const raw = pickArgs(USER);
    const dup = new Uint8Array(raw.length + 27); dup.set(raw, 0); dup[raw.length] = 0x0a; dup[raw.length + 1] = 25; dup.set(OTHER, raw.length + 2);
    expect(argsPlayer(dup, t) == null).toBe(true);
    // player of the wrong length
    const short = bytes([0x0a, 24]);
    expect(argsPlayer(short, t) == null).toBe(true);
  });
  it("the race audit's smuggling payload (a field with an unexpected wire type) is refused", () => {
    // player = USER, then field 2 (game, a varint) sent as BYTES holding a second player field: a decoder that reads
    // field 2 as a varint would then see OTHER as the player.
    const out: u8[] = [0x0a, 25];
    for (let i = 0; i < 25; i++) out.push(USER[i]);
    out.push(0x12); out.push(27); out.push(0x0a); out.push(25);
    for (let i = 0; i < 25; i++) out.push(OTHER[i]);
    expect(argsPlayer(bytes(out), picksTypes()) == null).toBe(true);
    // field 4 (producers, bytes) sent as a varint
    const out2: u8[] = [0x0a, 25];
    for (let i = 0; i < 25; i++) out2.push(USER[i]);
    out2.push(0x20); out2.push(27);
    expect(argsPlayer(bytes(out2), picksTypes()) == null).toBe(true);
  });
  it("fields out of order, unknown fields, groups, truncated lengths and long varints are refused", () => {
    BASE = [0x0a, 25];
    for (let i = 0; i < 25; i++) BASE.push(USER[i]);
    const t = picksTypes();
    expect(argsPlayer(with_([0x18, 1, 0x10, 2]), t) == null).toBe(true);            // field 3 before field 2
    expect(argsPlayer(with_([0x30, 1]), t) == null).toBe(true);                       // field 6: not listed
    expect(argsPlayer(with_([0x13]), t) == null).toBe(true);                          // field 2, wire type 3 (group)
    expect(argsPlayer(with_([0x22, 26, 1, 2]), t) == null).toBe(true);               // length past the end
    expect(argsPlayer(with_([0x10, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01]), t) == null).toBe(true);   // 11-byte varint
    expect(argsPlayer(with_([0x10]), t) == null).toBe(true);                          // varint cut off
    expect(argsPlayer(with_([0x10, 2, 0x18, 3, 0x22, 0, 0x22, 0, 0x28, 4]), t) != null).toBe(true);   // in order, repeated field 4 side by side
    expect(argsPlayer(with_([0x22, 0, 0x10, 2]), t) == null).toBe(true);              // field 2 after field 4
  });
  it("fuzz: whenever the sponsor accepts arguments, the Picks contract's decoder reads the same player", () => {
    let seed: u32 = 20261027;
    const t = picksTypes();
    let accepted = 0, total = 0;
    for (let n = 0; n < 4000; n++) {
      // Start from a valid encoding and flip, insert or cut a few bytes.
      const raw = pickArgs(USER);
      const a: u8[] = [];
      for (let i = 0; i < raw.length; i++) a.push(raw[i]);
      const muts = 1 + <i32>(nextRand(seed) % 3); seed = rngState;
      for (let m = 0; m < muts; m++) {
        const kind = nextRand(seed) % 4; seed = rngState;
        const pos = <i32>(nextRand(seed) % <u32>(a.length + 1)); seed = rngState;
        const v = <u8>(nextRand(seed) & 0xff); seed = rngState;
        if (kind == 0 && pos < a.length) a[pos] = v;
        else if (kind == 1) insertAt(a, pos, v);
        else if (kind == 2 && pos < a.length) a.splice(pos, 1);
        else { a.push(0x0a); a.push(25); for (let i = 0; i < 25; i++) a.push(OTHER[i]); }
      }
      total++;
      const b = bytes(a);
      const seen = argsPlayer(b, t);
      if (seen == null) continue;
      accepted++;
      const decoded = Protobuf.decode<picks.pick_arguments>(b, picks.pick_arguments.decode);
      expect(decoded.player != null && Arrays.equal(decoded.player!, seen!)).toBe(true);
    }
    expect(accepted > 50).toBe(true);
    expect(total).toBe(4000);
  });
});

describe("v3 set_config: the allowlist's own rules", () => {
  it("at most 8 rows; no built-in contract, token or the sponsor; a well-formed shape; no duplicates", () => {
    start();
    CFG = v3Config();
    for (let i = 0; i < 7; i++) CFG.allowed.push(new sponsor.allowed_call(PICKS, 1000 + i, true, picksTypes()));
    badConfig("SPONSOR: at most 8 allowlisted calls");
    const bad = [GAME, DESK, RACE, VHP, KOIN, SELF];
    for (let i = 0; i < bad.length; i++) {
      CFG = v3Config(); CFG.allowed = [new sponsor.allowed_call(bad[i], PICK, true, picksTypes())];
      badConfig("SPONSOR: an allowlisted contract can't be the game, Knode Swap, the race, a token or the sponsor");
    }
    CFG = v3Config(); CFG.allowed = [new sponsor.allowed_call(new Uint8Array(25), PICK, true, picksTypes())];
    badConfig("SPONSOR: invalid allowlisted contract address");
    CFG = v3Config(); CFG.allowed = [new sponsor.allowed_call(PICKS, PICK, true, bytes([1, 1]))];
    badConfig("SPONSOR: arg_types must be 1 to 16 bytes, field 1 the player (3)");
    CFG = v3Config(); CFG.allowed = [new sponsor.allowed_call(PICKS, PICK, true, NONE)];
    badConfig("SPONSOR: arg_types must be 1 to 16 bytes, field 1 the player (3)");
    CFG = v3Config(); CFG.allowed = [new sponsor.allowed_call(PICKS, PICK, true, bytes([3, 4]))];
    badConfig("SPONSOR: arg_types bytes must be 0, 1, 2, 3 or 6");
    CFG = v3Config(); CFG.allowed = [picksRow(), picksRow()];
    badConfig("SPONSOR: duplicate allowlisted call");
    CFG = v3Config(); setConfig(); MockVM.commitTransaction();     // the good one is accepted
    expect(new Sponsor().get_config(new sponsor.get_config_arguments()).allowed.length).toBe(2);
  });
  it("only the sponsor wallet's own key changes the allowlist", () => {
    start();
    MockVM.setAuthorities([new MockVM.MockAuthority(authority.authorization_type.contract_call, USER, true)]);
    CFG = v3Config();
    expect(() => { new Sponsor().set_config(new sponsor.set_config_arguments(CFG)); }).toThrow();
    expect(MockVM.getErrorMessage()).toBe("SPONSOR: needs the sponsor wallet's own key");
    MockVM.rollbackTransaction();
  });
});

function claimArgs(player: Uint8Array, week: u64): Uint8Array {
  const out: u8[] = [0x0a, 25];
  for (let i = 0; i < 25; i++) out.push(player[i]);
  out.push(0x10); let v = week; while (v >= 0x80) { out.push(<u8>((v & 0x7f) | 0x80)); v >>= 7; } out.push(<u8>v);
  return bytes(out);
}

describe("v3: a free player collects their own free-game prize; L-3: a stake counts from min_vhp up", () => {
  it("an empty wallet's own claim is free play; a claim for someone else or with odd arguments is not", () => {
    start();
    emptyWallet();
    OPS = [call(GAME, GAME_CLAIM, claimArgs(USER, 3))];
    expect(pays()).toBe(true);
    MockVM.commitTransaction();
    emptyWallet();
    OPS = [call(GAME, GAME_CLAIM, claimArgs(OTHER, 3))];
    refused(NOT_A_PLAYER);
    emptyWallet();
    const odd = claimArgs(USER, 3); const padded = new Uint8Array(odd.length + 2); padded.set(odd, 0); padded[odd.length] = 0x18; padded[odd.length + 1] = 1;
    OPS = [call(GAME, GAME_CLAIM, padded)];
    refused(NOT_A_PLAYER);
    // answers are still free play next to a free claim
    emptyWallet();
    OPS = [call(GAME, GAME_ANSWER, NONE), call(GAME, GAME_CLAIM, claimArgs(USER, 3))];
    expect(pays()).toBe(true);
  });
  it("a stake below min_vhp is not a real player; at min_vhp it is", () => {
    start();
    OPS = [call(STAKED, STAKED_ENTRY, claimArgs(USER, 1))];
    READS = [vhpBalance(0), gamePlayer(MANA / 2, 0)];
    refused(NOT_A_PLAYER);
    READS = [vhpBalance(0), gamePlayer(MANA / 2, MANA / 2)];
    expect(pays()).toBe(true);
    MockVM.rollbackTransaction();
    READS = [vhpBalance(0), gamePlayer(MANA, 0)];
    expect(pays()).toBe(true);
  });
});

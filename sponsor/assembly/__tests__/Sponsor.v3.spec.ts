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
// v3: player, game, round, producers (repeated: 0x13), number, legs (Combo Card, repeated: 0x13).
function picksTypes(): Uint8Array { const b = new Uint8Array(6); b[0] = 3; b[1] = 1; b[2] = 1; b[3] = 0x13; b[4] = 1; b[5] = 0x13; return b; }
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

/** v3 (owner, 2026-10-28): a wallet that isn't a real player is paid from the free pool for ANY covered call. */
function paidFromFree(): void {
  expect(pays()).toBe(true);
  expect(new Sponsor().get_free_usage(new sponsor.get_free_usage_arguments()).used_day > 0).toBe(true);
  MockVM.rollbackTransaction();
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
  it("a pick mixed with a real-players-only action is no longer free play [v3, owner 2026-10-28: a non-player now spends the free pool]", () => {
    start();
    emptyWallet();
    OPS = [call(PICKS, PICK, pickArgs(USER)), call(STAKED, STAKED_ENTRY, Protobuf.encode(new picks.get_usage_arguments(0, null), picks.get_usage_arguments.encode))];
    // STAKED takes (player, varint); build its args by hand: player first.
    const a = new Uint8Array(27 + 2); a[0] = 0x0a; a[1] = 25; a.set(USER, 2); a[27] = 0x10; a[28] = 7;
    OPS[1] = call(STAKED, STAKED_ENTRY, a);
    paidFromFree();   // v3 (owner 2026-10-28): free pool, any covered call
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
    expect(argsPlayer(with_([0x10, 2, 0x10, 3]), t) == null).toBe(true);              // SP-16: single field 2 twice
    expect(argsPlayer(with_([0x10, 2, 0x32, 0, 0x32, 0]), t) != null).toBe(true);     // repeated legs (field 6) side by side
    // Picks audit P-3 / Combo Card: at most 640 bytes; a full 10-producer pick (317 bytes) fits.
    const ten: u8[] = [0x10, 2, 0x18, 0xa0, 0x9c, 0x01];
    for (let i = 0; i < 10; i++) { ten.push(0x22); ten.push(25); for (let j = 0; j < 25; j++) ten.push(H1[j]); }
    ten.push(0x28); ten.push(1);
    expect(argsPlayer(with_(ten), t) != null).toBe(true);
    const big: u8[] = [0x22, 0x80, 0x05]; for (let i = 0; i < 640; i++) big.push(0);   // 27 + 3 + 640 = 670 bytes
    expect(argsPlayer(with_(big), t) == null).toBe(true);
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
    badConfig("SPONSOR: arg_types bytes must be 0, 1, 2, 3 or 6, plus 0x10 for a repeated field (not the player)");
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
  it("an empty wallet's own claim is free play; a claim for someone else or with odd arguments is not [v3, owner 2026-10-28: a non-player now spends the free pool]", () => {
    start();
    emptyWallet();
    OPS = [call(GAME, GAME_CLAIM, claimArgs(USER, 3))];
    expect(pays()).toBe(true);
    MockVM.commitTransaction();
    emptyWallet();
    OPS = [call(GAME, GAME_CLAIM, claimArgs(OTHER, 3))];
    paidFromFree();   // v3 (owner 2026-10-28): free pool, any covered call
    emptyWallet();
    const odd = claimArgs(USER, 3); const padded = new Uint8Array(odd.length + 2); padded.set(odd, 0); padded[odd.length] = 0x18; padded[odd.length + 1] = 1;
    OPS = [call(GAME, GAME_CLAIM, padded)];
    paidFromFree();   // v3 (owner 2026-10-28): free pool, any covered call
    // answers are still free play next to a free claim
    emptyWallet();
    OPS = [call(GAME, GAME_ANSWER, NONE), call(GAME, GAME_CLAIM, claimArgs(USER, 3))];
    expect(pays()).toBe(true);
  });
  it("a stake below min_vhp is not a real player; at min_vhp it is [v3, owner 2026-10-28: a non-player now spends the free pool]", () => {
    start();
    OPS = [call(STAKED, STAKED_ENTRY, claimArgs(USER, 1))];
    READS = [gamePlayer(MANA / 2, 0)];
    paidFromFree();   // v3 (owner 2026-10-28): free pool, any covered call
    // v3 (audit SP-2): a pending stake doesn't count, so half active + half pending is not a real player either.
    READS = [gamePlayer(MANA / 2, MANA / 2)];
    paidFromFree();   // v3 (owner 2026-10-28): free pool, any covered call
    READS = [gamePlayer(MANA, 0)];
    expect(pays()).toBe(true);
  });
});

// ── v3 (owner, 2026-10-28): per-action Mana limits ──
// The caps count each transaction's Mana LIMIT, so the limit must fit what the action really uses: a pick uses about
// 0.05 Mana (testnet), so with a row of 0.1 a pick may ask for at most 0.1, and 3 picks for at most 0.3.
function capRow(contract: Uint8Array, entry: u32, mana: u64): sponsor.mana_cap { return new sponsor.mana_cap(contract, entry, mana); }
function startCaps(): void {
  MockVM.reset();
  MockVM.setContractId(SELF);
  MockVM.setHeadInfo(new chain.head_info(null, T0, 0));
  MockVM.commitTransaction();
  CFG = v3Config();
  CFG.mana_caps = [capRow(PICKS, PICK, MANA / 10), capRow(RACE, PICK, MANA / 5)];
  setConfig(); MockVM.commitTransaction();
  PAYEE = USER; RC = MANA;
}
describe("v3 per-action Mana limits", () => {
  it("a pick asking for more than its row is refused; at its row it is paid and counts only that much", () => {
    startCaps();
    emptyWallet();
    OPS = [call(PICKS, PICK, pickArgs(USER))];
    RC = MANA;
    refused("SPONSOR: mana limit above what these actions may ask for");
    RC = MANA / 10 + 1;
    refused("SPONSOR: mana limit above what these actions may ask for");
    RC = MANA / 10;
    emptyWallet();
    expect(pays()).toBe(true);
    MockVM.commitTransaction();
    expect(new Sponsor().get_free_usage(new sponsor.get_free_usage_arguments()).used_day).toBe(MANA / 10);
    expect(new Sponsor().get_usage(new sponsor.get_usage_arguments(USER)).used_day).toBe(MANA / 10);
    expect(new Sponsor().get_total_usage(new sponsor.get_total_usage_arguments()).used_day).toBe(MANA / 10);
  });
  it("several operations may ask for the sum of their rows, never more", () => {
    startCaps();
    OPS = [call(PICKS, PICK, pickArgs(USER)), call(PICKS, PICK, pickArgs(USER)), call(PICKS, PICK, pickArgs(USER))];
    RC = 3 * MANA / 10 + 1;
    emptyWallet();
    refused("SPONSOR: mana limit above what these actions may ask for");
    RC = 3 * MANA / 10;
    emptyWallet();
    expect(pays()).toBe(true);
  });
  it("an action with no row may ask for up to the per-transaction cap, as before", () => {
    startCaps();
    holder();
    OPS = [call(GAME, GAME_ANSWER, NONE)];
    RC = MANA;
    expect(pays()).toBe(true);
    MockVM.rollbackTransaction();
    // a pick (row 0.1) next to an answer (no row: 1): together up to 1.1, but never above the per-transaction cap 1
    holder();
    OPS = [call(GAME, GAME_ANSWER, NONE), call(PICKS, PICK, pickArgs(USER))];
    RC = MANA;
    expect(pays()).toBe(true);
    MockVM.rollbackTransaction();
    RC = MANA + 1;
    holder();
    refused("SPONSOR: mana limit above the per-transaction cap");
  });
  it("set_config checks every row: a real address, above 0, at most the per-transaction cap, no duplicates, at most 16", () => {
    startCaps();
    CFG = v3Config(); CFG.mana_caps = [capRow(PICKS, PICK, MANA + 1)];
    badConfig("SPONSOR: a per-action mana limit must be above 0 and at most the per-transaction cap");
    CFG = v3Config(); CFG.mana_caps = [capRow(PICKS, PICK, 0)];
    badConfig("SPONSOR: a per-action mana limit must be above 0 and at most the per-transaction cap");
    CFG = v3Config(); CFG.mana_caps = [capRow(PICKS, PICK, MANA / 10), capRow(PICKS, PICK, MANA / 5)];
    badConfig("SPONSOR: duplicate per-action mana limit");
    CFG = v3Config(); CFG.mana_caps = [capRow(bytes([0, 1, 2]), PICK, MANA / 10)];
    badConfig("SPONSOR: invalid per-action mana limit contract");
    CFG = v3Config();
    const many = new Array<sponsor.mana_cap>();
    for (let i: u32 = 0; i < 17; i++) many.push(capRow(PICKS, i + 1, MANA / 10));
    CFG.mana_caps = many;
    badConfig("SPONSOR: at most 16 per-action mana limits");
    CFG = v3Config(); CFG.mana_caps = many.slice(0, 16);
    setConfig();
    expect(new Sponsor().get_config(new sponsor.get_config_arguments()).mana_caps.length).toBe(16);
  });
  it("a row for the same entry point on another contract doesn't apply", () => {
    startCaps();
    CFG = v3Config(); CFG.mana_caps = [capRow(STAKED, PICK, MANA / 10)];
    setConfig(); MockVM.commitTransaction();
    emptyWallet();
    OPS = [call(PICKS, PICK, pickArgs(USER))];
    RC = MANA;
    expect(pays()).toBe(true);
  });
});

// ── v3 fix-check (2026-10-28): audit SP-2, SP-3, SP-16, Combo Card's 640 bytes ──
function gameWeekStake(v: u64): system_calls.exit_arguments {
  return new system_calls.exit_arguments(0, new chain.result(Protobuf.encode(new sponsor.game_get_game_player_result(v), sponsor.game_get_game_player_result.encode)));
}
function claimish(): Uint8Array { const a = new Uint8Array(27 + 2); a[0] = 0x0a; a[1] = 25; a.set(USER, 2); a[27] = 0x10; a[28] = 7; return a; }

describe("v3 SP-2: only a stake makes a real player (holding VHP, or a pending stake, does not)", () => {
  it("1 VHP in the wallet (passed from wallet to wallet) is not a stake: refused for real-players-only actions [v3, owner 2026-10-28: a non-player now spends the free pool]", () => {
    start();
    READS = [gamePlayer(0, 0)];                  // holds VHP, staked nowhere: v3 never even asks the VHP token
    OPS = [call(STAKED, STAKED_ENTRY, claimish())];
    expect(pays()).toBe(true);                   // paid, but from the free pool: not a real player
    expect(new Sponsor().get_free_usage(new sponsor.get_free_usage_arguments()).used_day).toBe(MANA);
    const asked = MockVM.getCallContractArguments();
    for (let i = 0; i < asked.length; i++) expect(Arrays.equal(asked[i].contract_id!, VHP)).toBe(false);
    MockVM.rollbackTransaction();
  });
  it("a stake in the question game counts", () => {
    start();
    READS = [gamePlayer(MANA, 0)];
    OPS = [call(STAKED, STAKED_ENTRY, claimish())];
    expect(pays()).toBe(true);
  });
  it("a Block X pick by a wallet staked IN Block X (game 2, this week) is a real player's: not counted as free", () => {
    start();
    READS = [gamePlayer(0, 0), gameWeekStake(2 * MANA)];
    OPS = [call(PICKS, PICK, pickArgs(USER))];
    expect(pays()).toBe(true);
    MockVM.commitTransaction();
    expect(new Sponsor().get_free_usage(new sponsor.get_free_usage_arguments()).used_day).toBe(0);
    const args = MockVM.getCallContractArguments();
    const last = Protobuf.decode<sponsor.game_get_game_player_args>(args[args.length - 1].args!, sponsor.game_get_game_player_args.decode);
    expect(last.game).toBe(2);
  });
  it("a stake below the minimum in that game is free play", () => {
    start();
    READS = [gamePlayer(0, 0), gameWeekStake(MANA - 1)];
    OPS = [call(PICKS, PICK, pickArgs(USER))];
    expect(pays()).toBe(true);
    MockVM.commitTransaction();
    expect(new Sponsor().get_free_usage(new sponsor.get_free_usage_arguments()).used_day).toBe(MANA);
  });
  it("set_config: game_arg must name a single varint field", () => {
    start();
    CFG = v3Config(); CFG.allowed = [new sponsor.allowed_call(PICKS, PICK, true, picksTypes(), 4)];   // field 4: repeated bytes
    badConfig("SPONSOR: game_arg must name a single varint field");
    CFG = v3Config(); CFG.allowed = [new sponsor.allowed_call(PICKS, PICK, true, picksTypes(), 9)];
    badConfig("SPONSOR: game_arg must name a single varint field");
  });
});

describe("v3 SP-3: the free pool is released by the hour", () => {
  it("at 00:30 UTC only 1/24 of the free pool can be used; more each hour; all of it by 23:00", () => {
    start();
    CFG = v3Config(); CFG.max_mana_free_day = 24 * MANA; CFG.max_mana_per_account_day = 30 * MANA; setConfig(); MockVM.commitTransaction();
    const day0: u64 = T0 - T0 % 86400000 + 86400000;            // the next UTC day, 00:00
    MockVM.setHeadInfo(new chain.head_info(null, day0 + 1800000, 0));
    MockVM.commitTransaction();
    emptyWallet(); OPS = [call(PICKS, PICK, pickArgs(USER))];
    expect(pays()).toBe(true); MockVM.commitTransaction();           // 1 of the 1 released
    emptyWallet(); OPS = [call(PICKS, PICK, pickArgs(USER))];
    refused(FREE_USED_UP);                                          // the 2nd waits for 01:00
    MockVM.setHeadInfo(new chain.head_info(null, day0 + 3600000 + 60000, 0)); MockVM.commitTransaction();
    emptyWallet(); OPS = [call(PICKS, PICK, pickArgs(USER))];
    expect(pays()).toBe(true); MockVM.commitTransaction();
    // would_pay agrees with what is left right now.
    emptyWallet();
    MockVM.setCallContractResults(padReads(READS));
    const r = new Sponsor().would_pay(new sponsor.would_pay_arguments(OTHER, MANA, true));
    expect(r.left_free_today).toBe(0);
  });
});

describe("v3 SP-16 and Combo Card: repeated fields only where marked; up to 640 argument bytes", () => {
  it("a single field twice is refused; a repeated one is fine", () => {
    BASE = [0x0a, 25]; for (let i = 0; i < 25; i++) BASE.push(USER[i]);
    expect(argsPlayer(with_([0x10, 2, 0x10, 3]), picksTypes()) == null).toBe(true);
    expect(argsPlayer(with_([0x10, 2, 0x22, 0, 0x22, 0]), picksTypes()) != null).toBe(true);
  });
  it("a 10-leg card (516 bytes) fits; 641 bytes do not", () => {
    BASE = [0x0a, 25]; for (let i = 0; i < 25; i++) BASE.push(USER[i]);
    const card: u8[] = [0x10, 8]; while (card.length + 27 < 516 - 2) { card.push(0x32); card.push(45); for (let i = 0; i < 45; i++) card.push(1); }
    expect(argsPlayer(with_(card), picksTypes()) != null).toBe(true);
    const big: u8[] = [0x32, 0xe4, 0x04]; for (let i = 0; i < 612; i++) big.push(0);   // 27 + 3 + 612 = 642 bytes
    expect(argsPlayer(with_(big), picksTypes()) == null).toBe(true);
  });
  it("arg_types: 0x10 marks a repeated field; never on the player or an absent field", () => {
    start();
    CFG = v3Config(); CFG.allowed = [new sponsor.allowed_call(PICKS, PICK, true, bytes([0x13, 1]), 0)];
    badConfig("SPONSOR: arg_types must be 1 to 16 bytes, field 1 the player (3)");
    CFG = v3Config(); CFG.allowed = [new sponsor.allowed_call(PICKS, PICK, true, bytes([3, 0x10]), 0)];
    badConfig("SPONSOR: arg_types bytes must be 0, 1, 2, 3 or 6, plus 0x10 for a repeated field (not the player)");
  });
});

// ── v3: the Knode vault (game v6) calls, covered for the payee's own wallet (owner, 2026-10-28) ──
const DEPOSIT_TO: u32 = 0x7bb5c436, WITHDRAW_FROM: u32 = 0x5b0aaef8, MOVE_STAKE: u32 = 0x7c268e69, CLAIM_GAME: u32 = 0x4107e3ab, FINALIZE_GAME_WEEK: u32 = 0xec300c11;
/** player (field 1), then varints: fields 2.. (game, amount, ...). */
function vaultArgs(player: Uint8Array, nums: u64[]): Uint8Array {
  const a: u8[] = [0x0a, 25]; for (let i = 0; i < 25; i++) a.push(player[i]);
  for (let i = 0; i < nums.length; i++) { a.push(<u8>(((i + 2) << 3) | 0)); let v = nums[i]; do { let b = <u8>(v & 0x7f); v >>= 7; if (v) b |= 0x80; a.push(b); } while (v); }
  return bytes(a);
}
describe("v3: vault calls (deposit_to, withdraw_from, move_stake, claim_game, finalize_game_week)", () => {
  it("each player call is paid for the payee's own wallet, and refused for another wallet in field 1", () => {
    const calls: u32[] = [DEPOSIT_TO, WITHDRAW_FROM, MOVE_STAKE, CLAIM_GAME];
    for (let i = 0; i < calls.length; i++) {
      const n: u64[] = calls[i] == DEPOSIT_TO || calls[i] == MOVE_STAKE ? [2, 3 * MANA, 0] : [2, 4];
      start(); holder();
      OPS = [call(GAME, calls[i], vaultArgs(USER, n))];
      expect(pays()).toBe(true);
      MockVM.rollbackTransaction();
      start(); holder();
      OPS = [call(GAME, calls[i], vaultArgs(OTHER, n))];
      refused("SPONSOR: a vault call must be the payee's own, with arguments in the vault's shape");
    }
  });
  it("a non-canonical shape (a field twice, an unknown field) is refused", () => {
    start(); holder();
    const twice = vaultArgs(USER, [2, 4]); const t: u8[] = []; for (let i = 0; i < twice.length; i++) t.push(twice[i]); t.push(0x10); t.push(5);
    OPS = [call(GAME, CLAIM_GAME, bytes(t))];
    refused("SPONSOR: a vault call must be the payee's own, with arguments in the vault's shape");
    OPS = [call(GAME, WITHDRAW_FROM, vaultArgs(USER, [2, 4, 9]))];   // field 4 isn't in withdraw_from
    refused("SPONSOR: a vault call must be the payee's own, with arguments in the vault's shape");
  });
  it("a guest's own claim_game is paid from the free pool; a wallet staked in THAT game is a real player", () => {
    start(); emptyWallet();
    OPS = [call(GAME, CLAIM_GAME, vaultArgs(USER, [2, 4]))];
    paidFromFree();
    start();
    READS = [gamePlayer(0, 0), gameWeekStake(5 * MANA)];             // staked in game 2 this week
    OPS = [call(GAME, WITHDRAW_FROM, vaultArgs(USER, [2, MANA]))];
    expect(pays()).toBe(true);
    expect(new Sponsor().get_free_usage(new sponsor.get_free_usage_arguments()).used_day).toBe(0);
    const asked = MockVM.getCallContractArguments();
    const g = Protobuf.decode<sponsor.game_get_game_player_args>(asked[asked.length - 1].args!, sponsor.game_get_game_player_args.decode);
    expect(g.game).toBe(2);
  });
  it("finalize_game_week (no player) is covered; a non-player pays from the free pool", () => {
    start(); emptyWallet();
    const a: u8[] = [0x08, 2, 0x10, 4];
    OPS = [call(GAME, FINALIZE_GAME_WEEK, bytes(a))];
    paidFromFree();
  });
  it("owner decision: a wallet that isn't a real player may spend the free pool on any covered call, within the pool", () => {
    start();
    CFG = v3Config(); CFG.max_mana_free_day = 0; setConfig(); MockVM.commitTransaction();
    emptyWallet();
    OPS = [call(STAKED, STAKED_ENTRY, claimish())];
    refused(FREE_USED_UP);
  });
});

// ── Round 3 (Repo Lens fix-check of 2026-10-29) ──
function activePlayer(stake: u64, pending: u64, active: u64): system_calls.exit_arguments {
  const r = new sponsor.game_get_player_result(new sponsor.game_player(stake, pending), active);
  return new system_calls.exit_arguments(0, new chain.result(Protobuf.encode(r, sponsor.game_get_player_result.encode)));
}
function gameStake(weekStake: u64): system_calls.exit_arguments {
  return new system_calls.exit_arguments(0, new chain.result(Protobuf.encode(new sponsor.game_get_game_player_result(weekStake), sponsor.game_get_game_player_result.encode)));
}
function freeUsed(): u64 { return new Sponsor().get_free_usage(new sponsor.get_free_usage_arguments()).used_day; }

describe("v3 SP-28: the question game's ACTIVE stake this week decides, not the raw stake field", () => {
  it("deposited once and only answered since (stake 0, pending now active): a real player, not the free pool", () => {
    start();
    READS = [activePlayer(0, 5 * MANA, 5 * MANA)];
    OPS = [call(GAME, GAME_ANSWER, NONE)];
    expect(pays()).toBe(true);
    MockVM.commitTransaction();
    expect(freeUsed()).toBe(0);
  });
  it("a raw stake with no active stake this week (e.g. withdrawn) is a free wallet", () => {
    start();
    READS = [activePlayer(10 * MANA, 0, 0)];
    OPS = [call(GAME, GAME_ANSWER, NONE)];
    expect(pays()).toBe(true);
    MockVM.commitTransaction();
    expect(freeUsed()).toBe(MANA);
  });
  it("a pending deposit that isn't active yet (next week) is not a stake yet", () => {
    start();
    READS = [activePlayer(0, 5 * MANA, 0)];
    OPS = [call(GAME, GAME_ANSWER, NONE)];
    expect(pays()).toBe(true);
    MockVM.commitTransaction();
    expect(freeUsed()).toBe(MANA);
  });
});

describe("v3 SP-22: would_pay reads the call's game, as authorize does", () => {
  it("free pool used up: a wallet staked only in Block X (game 2) is still told yes for its pick", () => {
    start();
    CFG = v3Config(); CFG.max_mana_free_day = 0; setConfig(); MockVM.commitTransaction();
    MockVM.setCallContractResults(padReads([activePlayer(0, 0, 0), gameStake(5 * MANA)]));
    const yes = new Sponsor().would_pay(new sponsor.would_pay_arguments(USER, MANA, false, 2));
    expect(yes.ok).toBe(true);
    expect(yes.free).toBe(false);
    MockVM.setCallContractResults(padReads([activePlayer(0, 0, 0)]));
    const no = new Sponsor().would_pay(new sponsor.would_pay_arguments(USER, MANA, false, 0));
    expect(no.ok).toBe(false);
    expect(no.reason).toBe("today's free-player Mana is used up (more is released on the hour)");
  });
  it("and authorize agrees: the same wallet's pick is paid as a real player's", () => {
    start();
    CFG = v3Config(); CFG.max_mana_free_day = 0; setConfig(); MockVM.commitTransaction();
    READS = [activePlayer(0, 0, 0), gameStake(5 * MANA)];
    OPS = [call(PICKS, PICK, pickArgs(USER))];
    expect(pays()).toBe(true);
  });
});

// The auditor's round-3 test for SP-22 (Sponsor.repolens-r3.spec-append.ts), adapted: would_pay now takes the call's
// game (field 4), which the page reads from the operations, so the test passes game 2 as the page does.
describe("Repo Lens round 3 (auditor's tests): SP-22", () => {
  it("SP-22: would_pay agrees with authorize for a wallet staked in Block X (game 2) only, when the free pool is used", () => {
    start();
    const s = new Sponsor();
    const d: u64 = T0 / 86400000;
    s.freeUsage.put(new sponsor.usage(d, 50 * MANA, 0, 0));
    s.totalUsage.put(new sponsor.usage(d, 50 * MANA, 0, 0));
    MockVM.commitTransaction();
    READS = [activePlayer(0, 0, 0), gameStake(2 * MANA)];
    OPS = [call(PICKS, PICK, pickArgs(USER))];
    const paid = pays();
    MockVM.rollbackTransaction();
    expect(paid).toBe(true);
    MockVM.setCallContractResults(padReads([activePlayer(0, 0, 0), gameStake(2 * MANA)]));
    const r = new Sponsor().would_pay(new sponsor.would_pay_arguments(USER, MANA, true, 2));
    expect(r.ok).toBe(paid);
  });
});

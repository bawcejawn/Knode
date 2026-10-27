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

describe("Block X lock: 100 blocks before the target, chain-enforced", () => {
  it("accepts at target - 101, refuses at target - 100, at the target and after", () => {
    start();
    at(TARGET - 101, T0); pick(P1, R, H1);
    expect(Arrays.equal(pickOf(P1, BX, R)!.producers[0], H1)).toBe(true);
    expect(pickOf(P1, BX, R)!.height).toBe(TARGET - 101);
    at(TARGET - 100, T0); refused(P2, R, H1, LOCKED);
    at(TARGET, T0); refused(P2, R, H1, LOCKED);
    at(TARGET + 5000, T0); refused(P2, R, H1, LOCKED);
    // a change of an existing pick locks too
    at(TARGET - 100, T0); refused(P1, R, H2, LOCKED);
  });
  it("round 0 and rounds whose target is below the lead are always locked", () => {
    start();
    at(0, T0); refused(P1, 0, H1, LOCKED);
  });
  it("a round number so big its target overflows is refused, never wrapped", () => {
    start();
    refused(P1, u64.MAX_VALUE / 2400 + 1, H1, LOCKED);
    refused(P1, u64.MAX_VALUE, H1, LOCKED);
  });
});

describe("Block X window: exactly 12 targets are always open", () => {
  it("just before round R locks: R .. R+11 open, R+12 not yet", () => {
    start();
    at(TARGET - 101, T0);
    for (let i: u64 = 0; i < 12; i++) pick(P1, R + i, H1);
    refused(P1, R + 12, H1, TOO_EARLY);
  });
  it("just after round R locks: R+1 .. R+12 open, R+13 not yet", () => {
    start();
    at(TARGET - 100, T0);
    refused(P1, R, H1, LOCKED);
    for (let i: u64 = 1; i <= 12; i++) pick(P1, R + i, H1);
    refused(P1, R + 13, H1, TOO_EARLY);
  });
  it("the opening edge is exact: target - height = ahead is open, ahead + 1 is not", () => {
    start();
    at(TARGET - 28900, T0); pick(P1, R, H1);
    at(TARGET - 28901, T0); refused(P2, R, H1, TOO_EARLY);
  });
});

describe("choices fit the game", () => {
  it("one producer: exactly one valid address and no number", () => {
    start();
    at(TARGET - 500, T0);
    refusedFull(P1, BX, R, none(), 0, BAD_CHOICE);
    refusedFull(P1, BX, R, two(H1, H2), 0, BAD_CHOICE);
    refusedFull(P1, BX, R, one(H1), 7, BAD_CHOICE);
    const bad = H1.slice(0); bad[24] ^= 1;                // checksum broken
    refusedFull(P1, BX, R, one(bad), 0, BAD_CHOICE);
    refusedFull(P1, BX, R, one(new Uint8Array(20)), 0, BAD_CHOICE);
    pickFull(P1, BX, R, one(H1), 0);
  });
  it("a list: 1 to list_size distinct valid producers, no number", () => {
    start();
    register(listGame());                                   // round 1 target: 7 days + 4 days after 1970; pick round r
    const g = listGame();
    const r: u64 = (T0 + 2 * DAY_MS - g.round_offset) / g.round_size + 1;
    pickFull(P1, 5, r, two(H1, H2), 0);
    refusedFull(P2, 5, r, two(H1, H1), 0, BAD_CHOICE);
    const six = new Array<Uint8Array>(); six.push(H1); six.push(H2); six.push(H3); six.push(P1); six.push(P2); six.push(P3);
    refusedFull(P2, 5, r, six, 0, BAD_CHOICE);
    refusedFull(P2, 5, r, two(H1, H2), 1, BAD_CHOICE);
    six.pop(); pickFull(P2, 5, r, six, 0);                  // exactly 5
    expect(pickOf(P2, 5, r)!.producers.length).toBe(5);
  });
  it("a number: within number_min..number_max, no producers", () => {
    start();
    register(numberGame());
    const r: u64 = (TARGET - 1000) / 3200 + 2;
    refusedFull(P1, 6, r, none(), 0, BAD_CHOICE);
    refusedFull(P1, 6, r, none(), 501, BAD_CHOICE);
    refusedFull(P1, 6, r, one(H1), 10, BAD_CHOICE);
    pickFull(P1, 6, r, none(), 1);
    pickFull(P2, 6, r, none(), 500);
    expect(pickOf(P2, 6, r)!.number).toBe(500);
  });
});

describe("changes and daily caps", () => {
  it("the same pick again is refused; a change counts; max_changes is enforced", () => {
    start();
    at(TARGET - 500, T0);
    pick(P1, R, H1);
    refused(P1, R, H1, SAME);
    pick(P1, R, H2); pick(P1, R, H1); pick(P1, R, H2); pick(P1, R, H1); pick(P1, R, H2);   // 5 changes
    expect(pickOf(P1, BX, R)!.changes).toBe(5);
    refused(P1, R, H1, NO_CHANGES);
  });
  it("max_changes 0: a pick can never be changed", () => {
    start();
    register(numberGame());
    const r: u64 = (TARGET - 1000) / 3200 + 2;
    pickFull(P1, 6, r, none(), 9);
    refusedFull(P1, 6, r, none(), 10, NO_CHANGES);
  });
  it("30 picks a day per wallet per game, new picks and changes together; resets at 00:00 UTC; other wallets apart", () => {
    start();
    at(TARGET - 101, T0);
    for (let i: u64 = 0; i < 12; i++) pick(P1, R + i, H1);            // 12
    for (let i: u64 = 0; i < 12; i++) pick(P1, R + i, H2);            // 24
    for (let i: u64 = 0; i < 6; i++) pick(P1, R + i, H3);             // 30
    refused(P1, R + 6, H3, USED_UP);
    const u = new Picks().get_usage(new picks.get_usage_arguments(BX, P1));
    expect(u.picks_today).toBe(30); expect(u.max_picks_per_day).toBe(30);
    pick(P2, R, H1);                                                   // another wallet is unaffected
    const nextDay = (T0 / DAY_MS + 1) * DAY_MS;
    at(TARGET - 101, nextDay - 1); refused(P1, R + 6, H3, USED_UP);
    at(TARGET - 101, nextDay); pick(P1, R + 6, H3);
    expect(new Picks().get_usage(new picks.get_usage_arguments(BX, P1)).picks_today).toBe(1);
  });
  it("the daily cap is per game", () => {
    start();
    register(numberGame());
    at(TARGET - 101, T0);
    for (let i: u64 = 0; i < 12; i++) { pick(P1, R + i, H1); pick(P1, R + i, H2); }
    for (let i: u64 = 0; i < 6; i++) pick(P1, R + i, H3);
    refused(P1, R + 6, H3, USED_UP);
    pickFull(P1, 6, (TARGET - 101) / 3200 + 2, none(), 3);              // the number game has its own count
  });
});

describe("only the player's own signed transaction can pick", () => {
  it("unsigned, signed by someone else, or sent through another contract: refused", () => {
    start();
    at(TARGET - 500, T0);
    nobody(); A = new picks.pick_arguments(P1, BX, R, one(H1), 0);
    expect(() => { doPick(); }).toThrow(); errorIs(NOT_SIGNED);
    signedBy(P2); A = new picks.pick_arguments(P1, BX, R, one(H1), 0);
    expect(() => { doPick(); }).toThrow(); errorIs(NOT_SIGNED);
    fromContract(OTHER_CONTRACT); signedBy(P1);
    expect(() => { doPick(); }).toThrow(); errorIs(NOT_SIGNED);
    fromContract(P1); signedBy(P1); doPick(); MockVM.commitTransaction();   // the player's own contract is fine
    direct();
    expect(pickOf(P1, BX, R) != null).toBe(true);
  });
  it("an invalid player address is refused", () => {
    start();
    at(TARGET - 500, T0);
    refusedFull(new Uint8Array(25), BX, R, one(H1), 0, "PICKS: invalid player");
  });
  it("an unknown game is refused; a switched-off game is closed", () => {
    start();
    at(TARGET - 500, T0);
    refusedFull(P1, 99, R, one(H1), 0, NO_GAME);
    const off = blockX(); off.enabled = false;
    signedBy(OWNER); G = off; tighten(); MockVM.commitTransaction();
    refused(P1, R, H1, CLOSED);
  });
});

describe("reads", () => {
  it("list_picks pages by address within one game and round; a bad cursor is refused", () => {
    start();
    register(numberGame());
    at(TARGET - 500, T0);
    pick(P1, R, H1); pick(P2, R, H2); pick(P3, R, H1); pick(P1, R + 1, H2);
    pickFull(P1, 6, (TARGET - 500) / 3200 + 2, none(), 3);
    const all = new Picks().list_picks(new picks.list_picks_arguments(BX, R, new Uint8Array(0), 0)).rows;
    expect(all.length).toBe(3);
    const page1 = new Picks().list_picks(new picks.list_picks_arguments(BX, R, new Uint8Array(0), 2)).rows;
    expect(page1.length).toBe(2);
    const page2 = new Picks().list_picks(new picks.list_picks_arguments(BX, R, page1[1].player, 2)).rows;
    expect(page2.length).toBe(1);
    expect(Arrays.equal(page2[0].player, all[2].player)).toBe(true);
    expect(new Picks().list_picks(new picks.list_picks_arguments(BX, R + 1, new Uint8Array(0), 0)).rows.length).toBe(1);
    expect(new Picks().list_picks(new picks.list_picks_arguments(BX, R + 2, new Uint8Array(0), 0)).rows.length).toBe(0);
    gList = new picks.list_picks_arguments(BX, R, new Uint8Array(10), 0);
    expect(() => { new Picks().list_picks(gList); }).toThrow(); errorIs("PICKS: bad start_after");
  });
  it("get_pick of nobody is empty; get_config shows the built-in owner; list_games in id order", () => {
    start();
    register(numberGame()); register(listGame());
    expect(pickOf(P1, BX, R) == null).toBe(true);
    expect(Arrays.equal(new Picks().get_config(new picks.get_config_arguments()).owner!, OWNER)).toBe(true);
    const gs = new Picks().list_games(new picks.list_games_arguments()).games;
    expect(gs.length).toBe(3);
    expect(gs[0].id).toBe(2); expect(gs[1].id).toBe(5); expect(gs[2].id).toBe(6);
  });
  it("keys are fixed length: game 4 + round 8 + player 25", () => {
    expect(pickKey(BX, R, P1).length).toBe(37);
  });
});

describe("games: 48-hour notice to add or loosen, immediate to tighten", () => {
  it("only the owner can announce; apply waits 48 hours and expires after 7 more days", () => {
    MockVM.reset(); MockVM.setContractId(SELF); direct(); at(1000, T0); MockVM.commitTransaction();
    signedBy(P1); G = blockX();
    expect(() => { announce(); }).toThrow(); errorIs(OWNER_ONLY);
    signedBy(OWNER); announce(); MockVM.commitTransaction();
    nobody();
    at(1000, T0 + TIMELOCK_MS - 1); expect(() => { apply(); }).toThrow(); errorIs(NOT_YET);
    at(1000, T0 + TIMELOCK_MS + EXPIRY_MS); expect(() => { apply(); }).toThrow(); errorIs(EXPIRED);
    at(1000, T0 + TIMELOCK_MS); apply(); MockVM.commitTransaction();     // anyone may apply in the window
    expect(new Picks().get_game(new picks.get_game_arguments(BX)).game!.enabled).toBe(true);
    expect(new Picks().get_game(new picks.get_game_arguments(BX)).pending == null).toBe(true);
  });
  it("a game's shape never changes", () => {
    start();
    let g = blockX(); g.round_size = 1200; refusedAnnounce(g, SHAPE_FIXED);
    g = blockX(); g.round_offset = 1; refusedAnnounce(g, SHAPE_FIXED);
    g = blockX(); g.lock_mode = LOCK_TIME; g.lead = 300000; g.ahead = DAY_MS; refusedAnnounce(g, SHAPE_FIXED);
    g = blockX(); g.kind = KIND_LIST; g.list_size = 2; refusedAnnounce(g, SHAPE_FIXED);
    g = blockX(); g.max_picks_per_day = 40; signedBy(OWNER); G = g; announce(); MockVM.commitTransaction();   // looser: allowed, with notice
  });
  it("settings outside the hard limits are refused", () => {
    MockVM.reset(); MockVM.setContractId(SELF); direct(); at(1000, T0); MockVM.commitTransaction();
    let g = blockX(); g.lead = 99; refusedAnnounce(g, "PICKS: lead must be at least 100 blocks (or 5 minutes)");
    g = blockX(); g.ahead = 100; refusedAnnounce(g, "PICKS: ahead must be above lead and at most 35 days");
    g = blockX(); g.ahead = 1008001; refusedAnnounce(g, "PICKS: ahead must be above lead and at most 35 days");
    g = blockX(); g.max_picks_per_day = 0; refusedAnnounce(g, "PICKS: picks per day must be 1 to 50");
    g = blockX(); g.max_picks_per_day = 51; refusedAnnounce(g, "PICKS: picks per day must be 1 to 50");
    g = blockX(); g.max_changes = 51; refusedAnnounce(g, "PICKS: changes must be 0 to 50");
    g = blockX(); g.id = 0; refusedAnnounce(g, "PICKS: game id must be 1 to 1,000,000");
    g = blockX(); g.name = ""; refusedAnnounce(g, "PICKS: name must be 1 to 40 bytes");
    g = blockX(); g.name = "12345678901234567890123456789012345678901"; refusedAnnounce(g, "PICKS: name must be 1 to 40 bytes");
    g = blockX(); g.kind = 4; refusedAnnounce(g, "PICKS: kind must be 1, 2 or 3");
    g = blockX(); g.list_size = 2; refusedAnnounce(g, "PICKS: a one-producer game has list_size 1 and no number range");
    g = blockX(); g.round_size = 0; refusedAnnounce(g, "PICKS: round_size must be at least 1 and above round_offset");
    g = blockX(); g.round_offset = 2400; refusedAnnounce(g, "PICKS: round_size must be at least 1 and above round_offset");
    g = blockX(); g.lock_mode = 3; refusedAnnounce(g, "PICKS: lock_mode must be 1 or 2");
    g = listGame(); g.lead = 299999; refusedAnnounce(g, "PICKS: lead must be at least 100 blocks (or 5 minutes)");
    g = listGame(); g.list_size = 11; refusedAnnounce(g, "PICKS: a list game has list_size 2 to 10 and no number range");
    g = numberGame(); g.number_min = 501; refusedAnnounce(g, "PICKS: a number game has list_size 0 and number_min <= number_max");
  });
  it("tighten_game: switch off, lower caps, lock earlier at once; nothing looser", () => {
    start();
    let g = blockX(); g.max_picks_per_day = 31; signedBy(OWNER); G = g; expect(() => { tighten(); }).toThrow(); errorIs(NOT_TIGHTER);
    g = blockX(); g.ahead = 30000; G = g; signedBy(OWNER); expect(() => { tighten(); }).toThrow(); errorIs(NOT_TIGHTER);
    g = blockX(); g.lead = 99; G = g; signedBy(OWNER); expect(() => { tighten(); }).toThrow(); errorIs(NOT_TIGHTER);
    g = blockX(); g.max_changes = 6; G = g; signedBy(OWNER); expect(() => { tighten(); }).toThrow(); errorIs(NOT_TIGHTER);
    g = blockX(); g.name = "Other"; G = g; signedBy(OWNER); expect(() => { tighten(); }).toThrow(); errorIs(SHAPE_FIXED);
    g = blockX(); g.max_picks_per_day = 2; G = g; signedBy(P1); expect(() => { tighten(); }).toThrow(); errorIs(OWNER_ONLY);
    g = blockX(); g.max_picks_per_day = 2; g.lead = 200; G = g; signedBy(OWNER); tighten(); MockVM.commitTransaction();
    at(TARGET - 199, T0); refused(P1, R, H1, LOCKED);                  // the earlier lock applies at once
    at(TARGET - 500, T0); pick(P1, R, H1); pick(P1, R, H2); refused(P1, R, H1, USED_UP);
    g = blockX(); g.max_picks_per_day = 2; g.lead = 200; g.enabled = false; G = g; signedBy(OWNER); tighten(); MockVM.commitTransaction();
    g.enabled = true; G = g; signedBy(OWNER); expect(() => { tighten(); }).toThrow(); errorIs(NOT_TIGHTER);   // turning on needs notice
  });
  it("cancel_game_change drops an announcement", () => {
    start();
    let g = blockX(); g.max_picks_per_day = 40; signedBy(OWNER); G = g; announce(); MockVM.commitTransaction();
    signedBy(P1); gCancel = BX; expect(() => { cancelChange(); }).toThrow(); errorIs(OWNER_ONLY);
    signedBy(OWNER); cancelChange(); MockVM.commitTransaction();
    at(H, T0 + TIMELOCK_MS); nobody(); expect(() => { apply(); }).toThrow(); errorIs("PICKS: nothing announced for this game");
  });
  it("at most 32 games", () => {
    start();
    // Ids stay below 128: the mock VM compares keys as strings, and some byte values above 0x7f compare equal there.
    for (let i: u32 = 0; i < 31; i++) { const n = numberGame(); n.id = 10 + i; register(n); }
    const n = numberGame(); n.id = 60; refusedAnnounce(n, "PICKS: at most 32 games");
    expect(new Picks().list_games(new picks.list_games_arguments()).games.length).toBe(32);
  });
});

describe("time games lock by the clock", () => {
  it("a list game locks lead ms before its target, opens ahead ms before", () => {
    start();
    register(listGame());
    const g = listGame();
    const r: u64 = 3000;                                    // target = 3000 weeks + 4 days after 1970
    const target = r * g.round_size + g.round_offset;
    at(1, target - 300001); pickFull(P1, 5, r, two(H1, H2), 0);
    at(1, target - 300000); refusedFull(P2, 5, r, two(H1, H2), 0, LOCKED);
    at(1, target - 14 * DAY_MS - 1); refusedFull(P2, 5, r, two(H1, H2), 0, TOO_EARLY);
  });
});

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

describe("owner handover: propose, 48 hours, accept", () => {
  it("only the owner proposes; only the proposed wallet accepts, after 48 hours; it clears announcements and the upgrade", () => {
    start();
    signedBy(P1); gOwner = P2; expect(() => { propose(); }).toThrow(); errorIs(OWNER_ONLY);
    signedBy(OWNER); gOwner = SELF; expect(() => { propose(); }).toThrow(); errorIs("PICKS: the owner must be a wallet, not this contract");
    gOwner = P2; signedBy(OWNER); propose(); MockVM.commitTransaction();
    // the old owner still announces things before the handover
    let g = blockX(); g.max_picks_per_day = 40; signedBy(OWNER); G = g; announce(); MockVM.commitTransaction();
    gHash = sha(new Uint8Array(7)); signedBy(OWNER); scheduleUpgrade(); MockVM.commitTransaction();
    signedBy(P2); at(H, T0 + TIMELOCK_MS - 1); expect(() => { acceptOwner(); }).toThrow(); errorIs(NOT_YET);
    signedBy(P1); at(H, T0 + TIMELOCK_MS); expect(() => { acceptOwner(); }).toThrow(); errorIs("PICKS: the new owner must sign");
    signedBy(P2); acceptOwner(); MockVM.commitTransaction();
    const c = new Picks().get_config(new picks.get_config_arguments());
    expect(Arrays.equal(c.owner!, P2)).toBe(true);
    expect(c.upgrade_eta).toBe(0);
    expect(new Picks().get_game(new picks.get_game_arguments(BX)).pending == null).toBe(true);
    // the old owner has no power left
    g = blockX(); g.enabled = false; G = g; signedBy(OWNER); expect(() => { tighten(); }).toThrow(); errorIs(OWNER_ONLY);
    signedBy(P2); tighten(); MockVM.commitTransaction();
  });
  it("an empty owner cancels; a proposal expires after 7 more days", () => {
    start();
    gOwner = P2; signedBy(OWNER); propose(); MockVM.commitTransaction();
    gOwner = new Uint8Array(0); signedBy(OWNER); propose(); MockVM.commitTransaction();
    at(H, T0 + TIMELOCK_MS); signedBy(P2); expect(() => { acceptOwner(); }).toThrow(); errorIs("PICKS: no owner proposed");
    at(H, T0); gOwner = P2; signedBy(OWNER); propose(); MockVM.commitTransaction();
    at(H, T0 + TIMELOCK_MS + EXPIRY_MS); signedBy(P2); expect(() => { acceptOwner(); }).toThrow(); errorIs(EXPIRED);
  });
});

describe("authorize: no transfers, no Mana, code only by the timelocked owner", () => {
  it("contract_call and transaction_application are always refused, whoever signs", () => {
    start();
    signedBy(OWNER);
    expect(authorizes(authority.authorization_type.contract_call)).toBe(false);
    expect(authorizes(authority.authorization_type.transaction_application)).toBe(false);
    signedBy(SELF);
    expect(authorizes(authority.authorization_type.contract_call)).toBe(false);
    expect(authorizes(authority.authorization_type.transaction_application)).toBe(false);
  });
  it("an upload needs the announced code, the owner's signature, 48 hours, all three overrides, within 7 days", () => {
    start();
    const code = new Uint8Array(64); code[0] = 0x00; code[1] = 0x61; code[5] = 9;
    const other = code.slice(0); other[5] = 10;
    signedBy(OWNER);
    uploadTx(code, true, true, true);
    expect(authorizes(authority.authorization_type.contract_upload)).toBe(false);      // nothing announced
    gHash = sha(code); signedBy(P1); expect(() => { scheduleUpgrade(); }).toThrow(); errorIs(OWNER_ONLY);
    signedBy(OWNER); gHash = new Uint8Array(31); gHash[0] = 1; expect(() => { scheduleUpgrade(); }).toThrow(); errorIs("PICKS: the sha256 of the new code (32 bytes) is required");
    gHash = sha(code); signedBy(OWNER); scheduleUpgrade(); MockVM.commitTransaction();
    uploadTx(code, true, true, true);
    at(H, T0 + TIMELOCK_MS - 1); signedBy(OWNER); expect(authorizes(authority.authorization_type.contract_upload)).toBe(false);
    at(H, T0 + TIMELOCK_MS);
    signedBy(SELF); expect(authorizes(authority.authorization_type.contract_upload)).toBe(false);   // the upload key alone
    signedBy(OWNER); expect(authorizes(authority.authorization_type.contract_upload)).toBe(true);
    uploadTx(other, true, true, true); expect(authorizes(authority.authorization_type.contract_upload)).toBe(false);
    uploadTx(code, false, true, true); expect(authorizes(authority.authorization_type.contract_upload)).toBe(false);
    uploadTx(code, true, false, true); expect(authorizes(authority.authorization_type.contract_upload)).toBe(false);
    uploadTx(code, true, true, false); expect(authorizes(authority.authorization_type.contract_upload)).toBe(false);
    uploadTx(code, true, true, true);
    at(H, T0 + TIMELOCK_MS + EXPIRY_MS); expect(authorizes(authority.authorization_type.contract_upload)).toBe(false);
    // an empty hash cancels
    at(H, T0); gHash = new Uint8Array(0); signedBy(OWNER); scheduleUpgrade(); MockVM.commitTransaction();
    at(H, T0 + TIMELOCK_MS); uploadTx(code, true, true, true); signedBy(OWNER);
    expect(authorizes(authority.authorization_type.contract_upload)).toBe(false);
  });
});

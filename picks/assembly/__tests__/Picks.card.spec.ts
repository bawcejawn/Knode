// =====================================================================
// KnodeGames Picks: CARD games (kind 4, the Combo Card), in the Koinos mock VM.
// A card is 2 to max_legs legs {code, round, producer}; each leg type has its own lock; one leg per type per round;
// each producer once per card; the card's round is its slot on its own UTC day; a change needs every old leg open.
// Mock VM quirks (CLAUDE.md): keys sort as strings, direct() gives an empty caller, no closures (tests set globals).
// =====================================================================

import { Arrays, Base58, MockVM, Protobuf, System, authority, chain, common } from "@koinos/sdk-as";
import {
  Picks, DAY_MS, TIMELOCK_MS, LOCK_HEIGHT, LOCK_TIME, KIND_CARD, BAD_CHOICE, SAME, NO_CHANGES, USED_UP, NOT_TIGHTER, SHAPE_FIXED,
  CARD_DAY, CARD_SIZE, LEG_UNKNOWN, LEG_TWICE, PRODUCER_TWICE, LEG_LOCKED, LEG_TOO_EARLY,
} from "../Picks";
import { picks } from "../proto/picks";

const SELF = Base58.decode("1EDaCKVmBjUxLxgWCmDbRA8gWKkSQ6ByzY");
const OWNER = Base58.decode("1635QUrBNDp7WqmFkRvrkGwjJXTtFvH717");
const P1 = Base58.decode("1HsM33pF8DbXPr8Vsd4vD7hQgvZ1SHY3Vv");
const P2 = Base58.decode("16ixK5DgvcojcZLvxyYWhHFcRXfhfrHbpL");
// producers (real addresses, valid checksums)
const A1 = Base58.decode("15NZhQoewzsbVUcSVsZ8BEBEKgaBNPLLgZ");
const A2 = Base58.decode("1MbsVfNw6yzQqA8499d8KQj8qdLyRs8CzW");
const A3 = Base58.decode("1UG4UUn7Da9JqE4PKbYUWgjbNwE5F9531");
const A4 = Base58.decode("1GGxRhLN7Ek54xycG5XaZBE4bCgwV2xtvk");
const A5 = Base58.decode("14f34kUNZugf2DK4hPJGy4AkmBM7Y4pvVu");
const A6 = Base58.decode("1G2QjRtNwEfqGwX7SMD8LNjWgJdWA7XtSU");
const A7 = Base58.decode("18UYKhWVCbTpFs8oYC54xoiCQQthhEkX7m");
const A8 = Base58.decode("14MHW6TF8gw8EuMRLCJc2PQHLzZLKuwGqb");
const A9 = Base58.decode("1DAHmrQJMAbn4FmMMrew78wPUizjVdbBrd");
const A10 = Base58.decode("1Lk4D5bYDzMeh4CFXLWTpLEeJFqKmqbkEt");

const CG: u32 = 8;                         // Combo Card
const WIN: u32 = 1, SHOW: u32 = 2, HALF: u32 = 3, BLOCK: u32 = 4;
const RACE_MS: u64 = 21600000;             // 6-hour races, on UTC boundaries
const RACE_LEAD: u64 = 25 * 60000;         // race legs lock 25 minutes before the start
const BLOCK_LEAD: u64 = 500;               // Block X legs lock 500 blocks before the target
const RACE: u64 = 83010;                   // the next race: starts at RACE * 6 h
const START: u64 = RACE * RACE_MS;         // 2026-11-01 (ms)
const T0: u64 = START - 2 * 3600000;       // now: 2 hours before that race
const DAY: u64 = T0 / DAY_MS;              // today (UTC)
const SLOT0: u64 = DAY * 3;                // today's three card slots: SLOT0, SLOT0 + 1, SLOT0 + 2
const BR: u64 = 20000;                     // a Block X target: block 48,000,000
const BTARGET: u64 = BR * 2400;
const H0: u64 = BTARGET - 2000;            // now: 2,000 blocks before it

// ── chain state ──
function at(height: u64, time: u64): void { MockVM.setHeadInfo(new chain.head_info(new common.block_topology(new Uint8Array(0), height, new Uint8Array(0)), time, 0)); }
function direct(): void { MockVM.setCaller(new chain.caller_data(new Uint8Array(0), chain.privilege.user_mode)); }
function signedBy(a: Uint8Array): void { MockVM.setAuthorities([new MockVM.MockAuthority(authority.authorization_type.contract_call, a, true)]); }
function nobody(): void { MockVM.setAuthorities([]); }
function errorIs(message: string): void { expect(MockVM.getErrorMessage()).toBe(message); MockVM.rollbackTransaction(); }

// ── the game ──
function legType(code: u32, mode: u32, size: u64, lead: u64, ahead: u64): picks.leg_type {
  return new picks.leg_type(code, mode, size, 0, lead, ahead, true);
}
function comboTypes(): picks.leg_type[] {
  const a = new Array<picks.leg_type>();
  a.push(legType(WIN, LOCK_TIME, RACE_MS, RACE_LEAD, DAY_MS));
  a.push(legType(SHOW, LOCK_TIME, RACE_MS, RACE_LEAD, DAY_MS));
  a.push(legType(HALF, LOCK_TIME, RACE_MS, RACE_LEAD, DAY_MS));
  a.push(legType(BLOCK, LOCK_HEIGHT, 2400, BLOCK_LEAD, 28800));
  return a;
}
function combo(): picks.game_config {
  return new picks.game_config(CG, "Combo Card", KIND_CARD, 10, 0, 0, LOCK_TIME, 3, 0, 300000, DAY_MS, 12, 3, true, comboTypes(), 6);
}
let G: picks.game_config = combo();
function announce(): void { new Picks().announce_game(new picks.announce_game_arguments(G)); }
function apply(): void { new Picks().apply_game(new picks.apply_game_arguments(G.id)); }
function tighten(): void { new Picks().tighten_game(new picks.tighten_game_arguments(G)); }
function register(g: picks.game_config, height: u64, time: u64): void {
  at(height, time); signedBy(OWNER); G = g; announce(); MockVM.commitTransaction();
  at(height, time + TIMELOCK_MS); nobody(); apply(); MockVM.commitTransaction();
  at(height, time);
}
function register2(g: picks.game_config): void { register(g, H0, T0 - TIMELOCK_MS); at(H0, T0); }
function refusedAnnounce(g: picks.game_config, message: string): void {
  signedBy(OWNER); G = g; expect(() => { announce(); }).toThrow(); errorIs(message);
}
function refusedTighten(g: picks.game_config, message: string): void {
  signedBy(OWNER); G = g; expect(() => { tighten(); }).toThrow(); errorIs(message);
}
function tightenTo(g: picks.game_config): void { signedBy(OWNER); G = g; tighten(); MockVM.commitTransaction(); }
function start(): void {
  MockVM.reset(); MockVM.setContractId(SELF); direct(); at(H0, T0); MockVM.commitTransaction();
  // Registered 48 hours "before": the announcement is made at T0 - 48 h, applied at T0.
  register(combo(), H0, T0 - TIMELOCK_MS);
  at(H0, T0);
}

// ── cards ──
let L: picks.leg[] = new Array<picks.leg>();
function legs0(): void { L = new Array<picks.leg>(); }
function add(code: u32, round: u64, producer: Uint8Array): void { L.push(new picks.leg(code, round, producer)); }
let A: picks.pick_arguments = new picks.pick_arguments();
function doPick(): void { new Picks().pick(A); }
function send(player: Uint8Array, round: u64): void {
  signedBy(player); A = new picks.pick_arguments(player, CG, round, new Array<Uint8Array>(), 0, L); doPick(); MockVM.commitTransaction();
}
function refusedCard(player: Uint8Array, round: u64, message: string): void {
  signedBy(player); A = new picks.pick_arguments(player, CG, round, new Array<Uint8Array>(), 0, L);
  expect(() => { doPick(); }).toThrow(); errorIs(message);
}
function cardOf(player: Uint8Array, round: u64): picks.pick_object | null {
  return new Picks().get_pick(new picks.get_pick_arguments(CG, round, player)).pick;
}
/** A good 3-leg card: Win on race RACE, Show on race RACE + 1, Block X on block BR. */
function good(): void { legs0(); add(WIN, RACE, A1); add(SHOW, RACE + 1, A2); add(BLOCK, BR, A3); }

describe("card game settings", () => {
  it("registers the Combo Card and refuses settings out of range", () => {
    start();
    const got = new Picks().get_game(new picks.get_game_arguments(CG)).game!;
    expect(got.kind).toBe(KIND_CARD); expect(got.max_legs).toBe(6); expect(got.leg_types.length).toBe(4);
    let g = combo(); g.id = 9; g.list_size = 11; refusedAnnounce(g, "PICKS: a card game has list_size 2 to 10, max_legs 2 to list_size and no number range");
    g = combo(); g.id = 9; g.max_legs = 11; refusedAnnounce(g, "PICKS: a card game has list_size 2 to 10, max_legs 2 to list_size and no number range");
    g = combo(); g.id = 9; g.max_legs = 1; refusedAnnounce(g, "PICKS: a card game has list_size 2 to 10, max_legs 2 to list_size and no number range");
    g = combo(); g.id = 9; g.round_size = 11; refusedAnnounce(g, "PICKS: a card game has 1 to 10 cards a day, lock_mode 2, offset 0, lead 5 minutes, ahead 1 day");
    g = combo(); g.id = 9; g.lock_mode = LOCK_HEIGHT; refusedAnnounce(g, "PICKS: a card game has 1 to 10 cards a day, lock_mode 2, offset 0, lead 5 minutes, ahead 1 day");
    g = combo(); g.id = 9; g.ahead = 2 * DAY_MS; refusedAnnounce(g, "PICKS: a card game has 1 to 10 cards a day, lock_mode 2, offset 0, lead 5 minutes, ahead 1 day");
    g = combo(); g.id = 9; g.leg_types = new Array<picks.leg_type>(); refusedAnnounce(g, "PICKS: a card game has 1 to 16 leg types");
    g = combo(); g.id = 9; g.leg_types[1].code = WIN; refusedAnnounce(g, "PICKS: leg codes must be distinct");
    g = combo(); g.id = 9; g.leg_types[0].code = 0; refusedAnnounce(g, "PICKS: leg codes are 1 to 255");
    g = combo(); g.id = 9; g.leg_types[0].code = 256; refusedAnnounce(g, "PICKS: leg codes are 1 to 255");
    g = combo(); g.id = 9; g.leg_types[0].ahead = DAY_MS + 1; refusedAnnounce(g, "PICKS: a leg locks at least 100 blocks (5 minutes) ahead and opens at most a day ahead");
    g = combo(); g.id = 9; g.leg_types[3].ahead = 28801; refusedAnnounce(g, "PICKS: a leg locks at least 100 blocks (5 minutes) ahead and opens at most a day ahead");
    g = combo(); g.id = 9; g.leg_types[3].lead = 99; refusedAnnounce(g, "PICKS: a leg locks at least 100 blocks (5 minutes) ahead and opens at most a day ahead");
    g = combo(); g.id = 9; g.leg_types[0].lead = 299999; refusedAnnounce(g, "PICKS: a leg locks at least 100 blocks (5 minutes) ahead and opens at most a day ahead");
    g = combo(); g.id = 9; g.leg_types[2].lock_mode = 3; refusedAnnounce(g, "PICKS: a leg's lock_mode must be 1 or 2");
    g = combo(); g.id = 9; g.leg_types[2].round_offset = RACE_MS; refusedAnnounce(g, "PICKS: a leg's round_size must be at least 1 and above its offset");
    // 17 leg types
    g = combo(); g.id = 9; for (let c: u32 = 10; c < 23; c++) g.leg_types.push(legType(c, LOCK_TIME, RACE_MS, RACE_LEAD, DAY_MS));
    refusedAnnounce(g, "PICKS: a card game has 1 to 16 leg types");
    // a game of another kind can't carry leg types or max_legs
    g = new picks.game_config(2, "Who Signs Block X", 1, 1, 0, 0, LOCK_HEIGHT, 2400, 0, 100, 28900, 30, 5, true, comboTypes(), 0);
    refusedAnnounce(g, "PICKS: only a card game has leg types");
    g = new picks.game_config(2, "Who Signs Block X", 1, 1, 0, 0, LOCK_HEIGHT, 2400, 0, 100, 28900, 30, 5, true, new Array<picks.leg_type>(), 6);
    refusedAnnounce(g, "PICKS: only a card game has leg types");
  });
});

describe("making a card", () => {
  it("stores a 3-leg card with its legs, and get_pick returns them", () => {
    start(); good(); send(P1, SLOT0);
    const c = cardOf(P1, SLOT0)!;
    expect(c.legs.length).toBe(3);
    expect(c.legs[0].code).toBe(WIN); expect(c.legs[0].round).toBe(RACE); expect(Arrays.equal(c.legs[0].producer, A1)).toBe(true);
    expect(c.legs[2].code).toBe(BLOCK); expect(c.legs[2].round).toBe(BR);
    expect(c.producers.length).toBe(0); expect(c.number).toBe(0); expect(c.changes).toBe(0);
    // the other slots are separate cards
    good(); legs0(); add(SHOW, RACE, A4); add(HALF, RACE + 2, A5); send(P1, SLOT0 + 1);
    expect(cardOf(P1, SLOT0 + 1)!.legs.length).toBe(2);
  });
  it("a race takes a Win, a Show and a Top half on different horses; the same type twice is refused", () => {
    start();
    legs0(); add(WIN, RACE, A1); add(SHOW, RACE, A2); add(HALF, RACE, A3); send(P1, SLOT0);
    expect(cardOf(P1, SLOT0)!.legs.length).toBe(3);
    legs0(); add(SHOW, RACE, A1); add(SHOW, RACE, A2); refusedCard(P2, SLOT0, LEG_TWICE);
    legs0(); add(WIN, RACE, A1); add(SHOW, RACE, A2); add(HALF, RACE, A3); add(HALF, RACE, A4); refusedCard(P2, SLOT0, LEG_TWICE);
    // one leg per block
    legs0(); add(BLOCK, BR, A1); add(BLOCK, BR, A2); refusedCard(P2, SLOT0, LEG_TWICE);
    // the same round number on a race and a block are different things
    legs0(); add(SHOW, RACE, A1); add(BLOCK, BR, A2); send(P2, SLOT0);
  });
  it("each producer once per card, in any pair of legs, Block X included", () => {
    start();
    legs0(); add(WIN, RACE, A1); add(SHOW, RACE, A1); refusedCard(P1, SLOT0, PRODUCER_TWICE);
    legs0(); add(WIN, RACE, A1); add(HALF, RACE + 1, A1); refusedCard(P1, SLOT0, PRODUCER_TWICE);
    legs0(); add(SHOW, RACE, A1); add(BLOCK, BR, A1); refusedCard(P1, SLOT0, PRODUCER_TWICE);
    legs0(); add(BLOCK, BR, A1); add(BLOCK, BR + 1, A1); refusedCard(P1, SLOT0, PRODUCER_TWICE);
    legs0(); add(BLOCK, BR, A1); add(BLOCK, BR + 1, A2); add(SHOW, RACE, A3); add(WIN, RACE + 1, A1); refusedCard(P1, SLOT0, PRODUCER_TWICE);
  });
  it("2 to max_legs legs (6 now)", () => {
    start();
    legs0(); refusedCard(P1, SLOT0, CARD_SIZE);
    legs0(); add(WIN, RACE, A1); refusedCard(P1, SLOT0, CARD_SIZE);
    legs0(); add(WIN, RACE, A1); add(SHOW, RACE, A2); add(HALF, RACE, A3); add(BLOCK, BR, A4); add(BLOCK, BR + 1, A5); add(BLOCK, BR + 2, A6); send(P1, SLOT0);
    legs0(); add(WIN, RACE, A1); add(SHOW, RACE, A2); add(HALF, RACE, A3); add(BLOCK, BR, A4); add(BLOCK, BR + 1, A5); add(BLOCK, BR + 2, A6); add(BLOCK, BR + 3, A7);
    refusedCard(P2, SLOT0, CARD_SIZE);
  });
  it("unknown leg codes, bad producers, producers or a number on a card, and legs on another kind of game are refused", () => {
    start();
    legs0(); add(9, RACE, A1); add(SHOW, RACE, A2); refusedCard(P1, SLOT0, LEG_UNKNOWN);
    legs0(); add(WIN, RACE, new Uint8Array(25)); add(SHOW, RACE, A2); refusedCard(P1, SLOT0, BAD_CHOICE);
    good();
    signedBy(P1); const ps = new Array<Uint8Array>(); ps.push(A9);
    A = new picks.pick_arguments(P1, CG, SLOT0, ps, 0, L); expect(() => { doPick(); }).toThrow(); errorIs(BAD_CHOICE);
    signedBy(P1); A = new picks.pick_arguments(P1, CG, SLOT0, new Array<Uint8Array>(), 7, L); expect(() => { doPick(); }).toThrow(); errorIs(BAD_CHOICE);
    // a one-producer game with legs attached
    register2(new picks.game_config(2, "Who Signs Block X", 1, 1, 0, 0, LOCK_HEIGHT, 2400, 0, 100, 28900, 30, 5, true, new Array<picks.leg_type>(), 0));
    signedBy(P1); ps[0] = A1; A = new picks.pick_arguments(P1, 2, BR, ps, 0, L); expect(() => { doPick(); }).toThrow(); errorIs(BAD_CHOICE);
  });
  it("the card's slot: today's 3 slots only", () => {
    start(); good();
    refusedCard(P1, SLOT0 - 1, CARD_DAY);
    refusedCard(P1, SLOT0 + 3, CARD_DAY);
    send(P1, SLOT0 + 2);
    // the next UTC day: yesterday's slots are closed (also for changes); the new day's are open
    at(H0, (DAY + 1) * DAY_MS + 60000);
    legs0(); add(WIN, RACE + 4, A1); add(SHOW, RACE + 5, A2);
    refusedCard(P1, SLOT0 + 2, CARD_DAY);
    send(P1, SLOT0 + 3);
  });
});

describe("leg locks: each leg by its own clock", () => {
  it("race legs lock 25 minutes before the start and open 24 hours ahead", () => {
    start();
    legs0(); add(WIN, RACE, A1); add(BLOCK, BR, A2);
    at(H0, START - RACE_LEAD - 1); send(P1, SLOT0);
    at(H0, START - RACE_LEAD); refusedCard(P2, SLOT0, LEG_LOCKED);
    at(H0, START + 1); refusedCard(P2, SLOT0, LEG_LOCKED);
    // 24 hours ahead: race RACE + 4 starts 24 h after RACE
    at(H0, T0); legs0(); add(WIN, RACE + 4, A1); add(BLOCK, BR, A2);
    at(H0, START + 4 * RACE_MS - DAY_MS - 1); refusedCard(P2, SLOT0, LEG_TOO_EARLY);
    at(H0, START + 4 * RACE_MS - DAY_MS); send(P2, SLOT0);
  });
  it("Block X legs lock 500 blocks before the block and open 28,800 blocks ahead", () => {
    start();
    legs0(); add(SHOW, RACE, A1); add(BLOCK, BR, A2);
    at(BTARGET - 501, T0); send(P1, SLOT0);
    at(BTARGET - 500, T0); refusedCard(P2, SLOT0, LEG_LOCKED);
    at(BTARGET - 101, T0); refusedCard(P2, SLOT0, LEG_LOCKED);
    at(BTARGET - 28801, T0); refusedCard(P2, SLOT0, LEG_TOO_EARLY);
    at(BTARGET - 28800, T0); send(P2, SLOT0);
  });
  it("one locked leg refuses the whole card", () => {
    start();
    legs0(); add(SHOW, RACE + 1, A1); add(WIN, RACE, A2); add(BLOCK, BR, A3);
    at(H0, START - RACE_LEAD); refusedCard(P1, SLOT0, LEG_LOCKED);
  });
  it("a leg round whose target overflows is locked, never wrapped", () => {
    start();
    legs0(); add(WIN, u64.MAX_VALUE, A1); add(BLOCK, BR, A2); refusedCard(P1, SLOT0, LEG_LOCKED);
    legs0(); add(WIN, RACE, A1); add(BLOCK, u64.MAX_VALUE / 2400 + 1, A2); refusedCard(P1, SLOT0, LEG_LOCKED);
  });
});

describe("changing a card", () => {
  it("changes while every old and new leg is open, up to 3 times; the same card again is refused", () => {
    start(); good(); send(P1, SLOT0);
    refusedCard(P1, SLOT0, SAME);
    legs0(); add(WIN, RACE, A4); add(SHOW, RACE + 1, A2); send(P1, SLOT0);
    expect(cardOf(P1, SLOT0)!.changes).toBe(1); expect(cardOf(P1, SLOT0)!.legs.length).toBe(2);
    legs0(); add(WIN, RACE, A5); add(SHOW, RACE + 1, A2); send(P1, SLOT0);
    legs0(); add(WIN, RACE, A6); add(SHOW, RACE + 1, A2); send(P1, SLOT0);
    legs0(); add(WIN, RACE, A7); add(SHOW, RACE + 1, A2); refusedCard(P1, SLOT0, NO_CHANGES);
  });
  it("once a leg of the stored card has locked, the card can't be changed, even to legs that are all open", () => {
    start();
    legs0(); add(WIN, RACE, A1); add(SHOW, RACE + 1, A2); send(P1, SLOT0);
    at(H0, START - RACE_LEAD);
    legs0(); add(SHOW, RACE + 1, A3); add(HALF, RACE + 2, A4); refusedCard(P1, SLOT0, LEG_LOCKED);
  });
  it("cards and changes count toward the daily cap", () => {
    start();
    const g = combo(); g.max_picks_per_day = 2; tightenTo(g);
    good(); send(P1, SLOT0);
    legs0(); add(WIN, RACE, A4); add(SHOW, RACE + 1, A2); send(P1, SLOT0);
    good(); refusedCard(P1, SLOT0 + 1, USED_UP);
  });
});

describe("owner changes to a card game", () => {
  it("tighten: lower max_legs, switch a leg type off, lock a leg earlier, open later; nothing looser", () => {
    start();
    let g = combo(); g.max_legs = 3; tightenTo(g);
    legs0(); add(WIN, RACE, A1); add(SHOW, RACE, A2); add(HALF, RACE, A3); add(BLOCK, BR, A4); refusedCard(P1, SLOT0, CARD_SIZE);
    g = combo(); g.max_legs = 3; g.leg_types[3].enabled = false; tightenTo(g);
    good(); refusedCard(P1, SLOT0, LEG_UNKNOWN);
    g = combo(); g.max_legs = 3; g.leg_types[3].enabled = false; g.leg_types[0].lead = RACE_LEAD + 60000; g.leg_types[0].ahead = DAY_MS - 60000; tightenTo(g);
    // looser is refused: raise max_legs, switch back on, lock later, open earlier, add a leg type
    g = combo(); g.max_legs = 4; g.leg_types[3].enabled = false; g.leg_types[0].lead = RACE_LEAD + 60000; g.leg_types[0].ahead = DAY_MS - 60000; refusedTighten(g, NOT_TIGHTER);
    g = combo(); g.max_legs = 3; g.leg_types[0].lead = RACE_LEAD + 60000; g.leg_types[0].ahead = DAY_MS - 60000; refusedTighten(g, NOT_TIGHTER);
    g = combo(); g.max_legs = 3; g.leg_types[3].enabled = false; g.leg_types[0].ahead = DAY_MS - 60000; refusedTighten(g, NOT_TIGHTER);
    g = combo(); g.max_legs = 3; g.leg_types[3].enabled = false; g.leg_types[0].lead = RACE_LEAD + 60000; refusedTighten(g, NOT_TIGHTER);
    g = combo(); g.max_legs = 3; g.leg_types[3].enabled = false; g.leg_types[0].lead = RACE_LEAD + 60000; g.leg_types[0].ahead = DAY_MS - 60000;
    g.leg_types.push(legType(5, LOCK_TIME, DAY_MS, 300000, DAY_MS)); refusedTighten(g, NOT_TIGHTER);
  });
  it("announce: add a leg type and raise max_legs to 10 (after 48 hours); never change or remove a leg type", () => {
    start();
    let g = combo(); g.max_legs = 10; g.leg_types.push(legType(5, LOCK_TIME, DAY_MS, 300000, DAY_MS));
    register2(g);
    const got = new Picks().get_game(new picks.get_game_arguments(CG)).game!;
    expect(got.max_legs).toBe(10); expect(got.leg_types.length).toBe(5);
    // a 10-leg card
    legs0(); add(WIN, RACE, A1); add(SHOW, RACE, A2); add(HALF, RACE, A3); add(WIN, RACE + 1, A4); add(SHOW, RACE + 1, A5);
    add(HALF, RACE + 1, A6); add(BLOCK, BR, A7); add(BLOCK, BR + 1, A8); add(BLOCK, BR + 2, A9); add(BLOCK, BR + 3, A10); send(P1, SLOT0);
    expect(cardOf(P1, SLOT0)!.legs.length).toBe(10);
    // a leg type's code, clock, round size or offset never changes; none is ever removed
    g = combo(); g.max_legs = 10; g.leg_types.push(legType(5, LOCK_TIME, DAY_MS, 300000, DAY_MS)); g.leg_types[3].round_size = 2401; refusedAnnounce(g, SHAPE_FIXED);
    g = combo(); g.max_legs = 10; g.leg_types.push(legType(5, LOCK_TIME, DAY_MS, 300000, DAY_MS)); g.leg_types[0].round_offset = 60000; refusedAnnounce(g, SHAPE_FIXED);
    g = combo(); g.max_legs = 10; g.leg_types.push(legType(6, LOCK_TIME, DAY_MS, 300000, DAY_MS)); refusedAnnounce(g, SHAPE_FIXED);
    g = combo(); g.max_legs = 10; refusedAnnounce(g, SHAPE_FIXED);
  });
});

describe("review follow-ups (CR-1, CR-2)", () => {
  it("a card holding a leg of a type switched off later can still be changed while its legs are open, and not after one locks", () => {
    start();
    legs0(); add(SHOW, RACE, A1); add(BLOCK, BR, A2); send(P1, SLOT0);
    const g = combo(); g.leg_types[3].enabled = false; tightenTo(g);
    // replace it with a card without Block X legs: allowed (the stored Block X leg is still open)
    legs0(); add(SHOW, RACE, A1); add(HALF, RACE + 1, A2); send(P1, SLOT0);
    expect(cardOf(P1, SLOT0)!.legs.length).toBe(2);
    // a second wallet's card with a Block X leg, stored before the switch-off, can't be changed once that leg locks
    start(); legs0(); add(SHOW, RACE + 1, A1); add(BLOCK, BR, A2); send(P2, SLOT0);
    at(BTARGET - 500, T0);
    legs0(); add(SHOW, RACE + 1, A3); add(HALF, RACE + 2, A4); refusedCard(P2, SLOT0, LEG_LOCKED);
  });
  it("after tighten_game shortens a leg type's opening window, a stored leg that isn't open yet doesn't block a change (CR-1)", () => {
    start();
    legs0(); add(WIN, RACE + 4, A1); add(BLOCK, BR, A2);
    at(H0, START + 4 * RACE_MS - DAY_MS); send(P1, SLOT0);                    // the Win leg exactly 24 h ahead
    const g = combo(); g.leg_types[0].ahead = 12 * 3600000; tightenTo(g);    // Win legs now open 12 h ahead
    legs0(); add(SHOW, RACE + 1, A1); add(BLOCK, BR, A2); send(P1, SLOT0);    // the change goes through
    expect(cardOf(P1, SLOT0)!.legs[0].code).toBe(SHOW);
  });
  it("tighten_game raising a leg type's lead locks new cards and changes earlier", () => {
    start();
    legs0(); add(WIN, RACE, A1); add(BLOCK, BR, A2);
    at(H0, START - RACE_LEAD - 60000); send(P1, SLOT0);
    const g = combo(); g.leg_types[0].lead = RACE_LEAD + 120000; tightenTo(g);
    legs0(); add(WIN, RACE, A3); add(BLOCK, BR, A2); refusedCard(P1, SLOT0, LEG_LOCKED);
    refusedCard(P2, SLOT0, LEG_LOCKED);
  });
  it("announce can't change an existing leg type's code or clock, or reorder the leg types", () => {
    start();
    let g = combo(); g.leg_types[0].code = 9; refusedAnnounce(g, SHAPE_FIXED);
    g = combo(); g.leg_types[3].lock_mode = LOCK_TIME; g.leg_types[3].round_size = RACE_MS; g.leg_types[3].lead = RACE_LEAD; g.leg_types[3].ahead = DAY_MS; refusedAnnounce(g, SHAPE_FIXED);
    g = combo(); const t0 = g.leg_types[0]; g.leg_types[0] = g.leg_types[1]; g.leg_types[1] = t0; refusedAnnounce(g, SHAPE_FIXED);
    g = combo(); g.leg_types.push(legType(WIN, LOCK_TIME, RACE_MS, RACE_LEAD, DAY_MS)); refusedAnnounce(g, "PICKS: leg codes must be distinct");
  });
  it("a game of another kind can't be tightened into carrying leg types or max_legs", () => {
    start();
    const bx = new picks.game_config(2, "Who Signs Block X", 1, 1, 0, 0, LOCK_HEIGHT, 2400, 0, 100, 28900, 30, 5, true, new Array<picks.leg_type>(), 0);
    register2(bx);
    let g = new picks.game_config(2, "Who Signs Block X", 1, 1, 0, 0, LOCK_HEIGHT, 2400, 0, 100, 28900, 30, 5, true, comboTypes(), 0);
    refusedTighten(g, "PICKS: only a card game has leg types");
    g = new picks.game_config(2, "Who Signs Block X", 1, 1, 0, 0, LOCK_HEIGHT, 2400, 0, 100, 28900, 30, 5, true, new Array<picks.leg_type>(), 6);
    refusedTighten(g, "PICKS: only a card game has leg types");
  });
});

// ── Repo Lens final audit 2026-10-30, RL-14: the test gaps ──
function be(v: u64, n: i32): Uint8Array { const b = new Uint8Array(n); for (let i = n - 1; i >= 0; i--) { b[i] = u8(v & 0xff); v >>= 8; } return b; }
function cat(a: Uint8Array, b: Uint8Array): Uint8Array { const o = new Uint8Array(a.length + b.length); o.set(a, 0); o.set(b, a.length); return o; }
describe("Repo Lens RL-14", () => {
  it("CR-2, completed: a wallet's card with a Block X leg, stored before Block X legs are switched off, can't be changed once that leg locks", () => {
    start(); legs0(); add(SHOW, RACE + 1, A1); add(BLOCK, BR, A2); send(P2, SLOT0);
    const g = combo(); g.leg_types[3].enabled = false; tightenTo(g);
    // switched off: a new card with a Block X leg is refused, the stored one stays
    legs0(); add(SHOW, RACE + 1, A5); add(BLOCK, BR, A6); refusedCard(P1, SLOT0, LEG_UNKNOWN);
    expect(cardOf(P2, SLOT0)!.legs.length).toBe(2);
    // while its Block X leg is open it can be changed (to legs without Block X); once it locks, it can't
    at(BTARGET - 500, T0);
    legs0(); add(SHOW, RACE + 1, A3); add(HALF, RACE + 2, A4); refusedCard(P2, SLOT0, LEG_LOCKED);
  });
  it("v1 records (exactly v1's wire bytes: no fields 15/16 or 6) are read by v2, and a v1 pick changes as before", () => {
    start();
    // Block X (game 2) and a pick on it written straight into storage with the v1 encoding. v2's encoder writes no
    // field for an empty list or a zero, so encoding without leg_types / max_legs / legs gives v1's bytes exactly.
    const bx = new picks.game_config(2, "Who Signs Block X", 1, 1, 0, 0, LOCK_HEIGHT, 2400, 0, 100, 28900, 30, 5, true, new Array<picks.leg_type>(), 0);
    const gb = Protobuf.encode(bx, picks.game_config.encode);
    System.putBytes(new chain.object_space(false, SELF, 1), be(2, 4), gb);
    const ps = new Array<Uint8Array>(); ps.push(A1);
    const pk = new picks.pick_object(ps, 0, H0 - 10, T0 - 1000, 0, new Array<picks.leg>());
    const pb = Protobuf.encode(pk, picks.pick_object.encode);
    System.putBytes(new chain.object_space(false, SELF, 3), cat(cat(be(2, 4), be(BR, 8)), P1), pb);
    MockVM.commitTransaction();
    // no field above 5 in either record
    for (let i = 0; i < gb.length; i++) expect(gb[i] >> 3 <= 14 || gb[i] & 0x80).toBeTruthy();
    const got = new Picks().get_game(new picks.get_game_arguments(2)).game!;
    expect(got.kind).toBe(1); expect(got.leg_types.length).toBe(0); expect(got.max_legs).toBe(0); expect(got.round_size).toBe(2400);
    const p = new Picks().get_pick(new picks.get_pick_arguments(2, BR, P1)).pick!;
    expect(Arrays.equal(p.producers[0], A1)).toBe(true); expect(p.legs.length).toBe(0); expect(p.changes).toBe(0);
    // the v1 pick is changed as v1 would (one producer, no legs)
    signedBy(P1); const ps2 = new Array<Uint8Array>(); ps2.push(A2);
    A = new picks.pick_arguments(P1, 2, BR, ps2, 0, new Array<picks.leg>()); doPick(); MockVM.commitTransaction();
    const q = new Picks().get_pick(new picks.get_pick_arguments(2, BR, P1)).pick!;
    expect(Arrays.equal(q.producers[0], A2)).toBe(true); expect(q.changes).toBe(1);
  });
  // (Fix-check FC-15: the new card holds only OPEN legs, so the refusal can only come from the STORED leg's lock.)
  it("an announced loosening doesn't re-open a STORED locked leg for 48 hours (stored-leg path)", () => {
    start();
    legs0(); add(WIN, RACE, A1); add(BLOCK, BR, A2); at(H0, START - RACE_LEAD - 60000); send(P1, SLOT0);
    signedBy(OWNER); let g = combo(); g.leg_types[0].lead = 300000; G = g; announce(); MockVM.commitTransaction();
    at(H0, START - RACE_LEAD + 1000);
    legs0(); add(SHOW, RACE + 1, A3); add(HALF, RACE + 1, A4); refusedCard(P1, SLOT0, LEG_LOCKED);   // new legs all open
  });
  it("P-2 on a card game: tighten_game drops a pending announcement, so an announced loosening can't undo it", () => {
    start();
    // announce: max_legs 10 and a new leg type
    signedBy(OWNER); let g = combo(); g.max_legs = 10; g.leg_types.push(legType(5, LOCK_TIME, DAY_MS, 300000, DAY_MS)); G = g; announce(); MockVM.commitTransaction();
    // tighten: max_legs 3 (drops the announcement)
    g = combo(); g.max_legs = 3; tightenTo(g);
    at(H0, T0 + TIMELOCK_MS); nobody(); G = combo(); expect(() => { apply(); }).toThrow(); errorIs("PICKS: nothing announced for this game");
    expect(new Picks().get_game(new picks.get_game_arguments(CG)).game!.max_legs).toBe(3);
  });
});

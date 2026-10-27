/**
 * v6: the KnodeGames vault (docs/V6-PLAN.md). Game registry, stakes per game, the weekly split (5% fee in VHP, free
 * prizes, the rest by stake over time), other games' results, free prizes, rollovers, corrections, moves, and a full
 * exit. MockVM; in-contract test ledger. Run: npm test
 */
import { Base58, MockVM, authority, chain, System, protocol } from "@koinos/sdk-as";
import { Kpred, testSetInitV6Rule } from "../Kpred";
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
const F = Base58.decode("128NayuVt5K2r2C2upFG5rzkL1KcsFKsT8");

const VHP: u64 = 100_000_000;
const KOIN_TAG: u8 = 1, VHP_TAG: u8 = 2, MANA_TAG: u8 = 3;
const GENESIS: u64 = 1000, WEEK: u64 = 1000;
const MS: u64 = 2800;
const CLOSE: u64 = 10;                 // close_delay in blocks
const SETTLE: u64 = 100;               // settle_length in blocks
const LOCK: u64 = 50;                  // timelock in blocks
const DUE: u64 = WEEK * 3 / 7;         // results deadline after the week ends (blocks, rounded down)
const G2: u32 = 2, G3: u32 = 3;        // game 2: staked; game 3: free prize only

// ───────────── harness ─────────────
// Each helper commits first: a failed call (expect … toThrow) rolls the mock chain back to the last commit.
function at(h: u64): void {
  MockVM.commitTransaction();
  MockVM.setBlock(new protocol.block(new Uint8Array(0), new protocol.block_header(new Uint8Array(0), h, h * MS)));
  System.resetCache();
}
function as(acct: Uint8Array): void {
  MockVM.commitTransaction();
  MockVM.setAuthorities([new MockVM.MockAuthority(authority.authorization_type.contract_call, acct, true)]);
}
function nobody(): void { MockVM.commitTransaction(); MockVM.setAuthorities([]); }
function give(tag: u8, who: Uint8Array, amount: u64): void { Tokens.testSet(tag, who, Tokens.testGet(tag, who) + amount); }
function vhpOf(who: Uint8Array): u64 { return Tokens.testGet(VHP_TAG, who); }
function weekEnd(w: u64): u64 { return GENESIS + (w + 1) * WEEK; }

function setup(): Kpred {
  MockVM.reset();
  MockVM.setContractId(CONTRACT);
  MockVM.setContractArguments(CONTRACT);
  MockVM.setEntryPoint(0);
  MockVM.setCaller(new chain.caller_data(new Uint8Array(0), chain.privilege.user_mode));
  MockVM.setContractMetadata(new chain.contract_metadata_object(new Uint8Array(0), false, false, false, false));
  MockVM.setHeadInfo(new chain.head_info(null, 0, 1));
  at(100);
  testSetInitV6Rule(1);
  const k = new Kpred();
  k.init(new kpred.init_arguments(OWNER, OPERATOR, SEED, GENESIS * MS, WEEK * MS, CLOSE * MS, SETTLE * MS, LOCK * MS, VHP, VHP));
  const all: Uint8Array[] = [A, B, C, D, E, F];
  for (let n = 0; n < all.length; n++) {
    give(VHP_TAG, all[n], 1000 * VHP);
    give(KOIN_TAG, all[n], 1000 * VHP);
    give(MANA_TAG, all[n], 1000 * VHP);
  }
  give(VHP_TAG, SEED, 5000 * VHP);
  give(MANA_TAG, CONTRACT, 1000 * VHP);
  return k;
}

/** Games 2 (staked) and 3 (free prize only), announced at block 110 and applied at 170: they earn from week 1. */
function addGames(k: Kpred): void {
  at(110);
  as(OWNER);
  k.propose_game(new kpred.propose_game_arguments(G2, "Fantasy", true, false));
  k.propose_game(new kpred.propose_game_arguments(G3, "Block X", false, true));
  at(110 + LOCK + 10);
  as(OWNER);
  k.apply_game(new kpred.apply_game_arguments(G2));
  k.apply_game(new kpred.apply_game_arguments(G3));
}
function depositQ(k: Kpred, who: Uint8Array, amount: u64): void {
  as(who);
  k.deposit_vhp(new kpred.deposit_vhp_arguments(who, amount));
  MockVM.commitTransaction();
}
function depositG(k: Kpred, game: u32, who: Uint8Array, amount: u64): void {
  as(who);
  k.deposit_to(new kpred.deposit_to_arguments(game, who, amount, false));
  MockVM.commitTransaction();
}
function seedIn(k: Kpred, amount: u64): void {
  as(SEED);
  k.seed_deposit_vhp(new kpred.seed_deposit_vhp_arguments(amount));
  MockVM.commitTransaction();
}
function row(who: Uint8Array, points: u32): kpred.result_row { return new kpred.result_row(who, points); }
function postRows(k: Kpred, game: u32, w: u64, rows: kpred.result_row[]): void {
  as(OPERATOR);
  k.post_results(new kpred.post_results_arguments(game, w, rows));
  MockVM.commitTransaction();
}
function seal(k: Kpred, game: u32, w: u64): void {
  as(OPERATOR);
  k.seal_results(new kpred.seal_results_arguments(game, w));
  MockVM.commitTransaction();
}
/** Close vault week w (no questions were posted, so it can close right after its close delay). */
function closeWeek(k: Kpred, w: u64): void {
  at(weekEnd(w) + CLOSE + 1);
  nobody();
  k.close_week(new kpred.close_week_arguments(w));
  MockVM.commitTransaction();
}
function finalizeQ(k: Kpred, w: u64): void {
  const wk = k.get_week(new kpred.get_week_arguments(w)).week!;
  at(wk.settle_end / MS + 2);
  nobody();
  k.finalize_week(new kpred.finalize_week_arguments(w));
  MockVM.commitTransaction();
}
function gweek(k: Kpred, game: u32, w: u64): kpred.gweek_object {
  return k.get_game(new kpred.get_game_arguments(game, w)).week!;
}
function game(k: Kpred, id: u32): kpred.game_object {
  return k.get_game(new kpred.get_game_arguments(id, 0)).game!;
}
function claimG(k: Kpred, game: u32, w: u64, who: Uint8Array): u64 {
  as(who);
  const r = k.claim_game(new kpred.claim_game_arguments(game, who, w)).reward;
  MockVM.commitTransaction();
  return r;
}

// Globals for expect(() => …).toThrow() (no closures over locals in AssemblyScript).
let gK: Kpred | null = null;
let gWho: Uint8Array = new Uint8Array(0);
let gGame: u32 = 0;
let gWeek: u64 = 0;
let gAmt: u64 = 0;
let gPts: u32 = 0;

describe("v6 game registry", () => {
  it("game 1 is the question game; new games wait 48 h, earn from the next week, and only the owner adds them", () => {
    const k = setup();
    gK = k;
    const list = k.list_games(new kpred.list_games_arguments()).games;
    expect(list.length).toBe(1);
    expect(list[0].id).toBe(1);
    expect(list[0].staked && list[0].free_prize && list[0].active).toBe(true);
    at(110);
    as(A);
    expect(() => { gK!.propose_game(new kpred.propose_game_arguments(2, "X", true, false)); }).toThrow();
    as(OWNER);
    expect(() => { gK!.propose_game(new kpred.propose_game_arguments(1, "X", true, false)); }).toThrow();
    expect(() => { gK!.propose_game(new kpred.propose_game_arguments(2, "", true, false)); }).toThrow();
    expect(() => { gK!.propose_game(new kpred.propose_game_arguments(2, "X", false, false)); }).toThrow();
    k.propose_game(new kpred.propose_game_arguments(2, "Fantasy", true, false));
    at(110 + LOCK - 1);
    as(OWNER);
    expect(() => { gK!.apply_game(new kpred.apply_game_arguments(2)); }).toThrow();
    at(110 + LOCK + 1);
    as(OWNER);
    expect(k.apply_game(new kpred.apply_game_arguments(2)).from_week).toBe(1);
    expect(k.list_games(new kpred.list_games_arguments()).games.length).toBe(2);
    // a running game can't be re-announced
    expect(() => { gK!.propose_game(new kpred.propose_game_arguments(2, "Again", true, false)); }).toThrow();
  });

  it("at most 12 games besides the question game", () => {
    const k = setup();
    gK = k;
    at(110);
    as(OWNER);
    for (let i: u32 = 2; i <= 13; i++) k.propose_game(new kpred.propose_game_arguments(i, "G", true, false));
    at(110 + LOCK + 1);
    as(OWNER);
    for (let i: u32 = 2; i <= 13; i++) k.apply_game(new kpred.apply_game_arguments(i));
    expect(k.config.get()!.game_count).toBe(12);
    expect(() => { gK!.propose_game(new kpred.propose_game_arguments(14, "G", true, false)); }).toThrow();
  });
});

describe("v6 stakes per game", () => {
  it("a deposit to another game counts from next week and shows in the totals and get_player", () => {
    const k = setup();
    addGames(k);
    at(200);
    depositG(k, G2, A, 5 * VHP);
    const t = k.totals.get()!;
    expect(t.total_stake).toBe(5 * VHP);
    expect(t.stake_other).toBe(5 * VHP);
    expect(game(k, G2).stake).toBe(5 * VHP);
    expect(game(k, 1).stake).toBe(0);
    expect(k.get_player(new kpred.get_player_arguments(A, 0)).player!.stake_other).toBe(5 * VHP);
    const gp = k.get_game_player(new kpred.get_game_player_arguments(G2, A, 0));
    expect(gp.week_stake).toBe(5 * VHP);           // before genesis: counts from week 0
    expect(vhpOf(CONTRACT)).toBe(5 * VHP);
  });

  it("refuses deposits to the question game's id, unknown games, free-only games and while paused", () => {
    const k = setup();
    gK = k;
    addGames(k);
    at(200);
    gWho = A;
    as(A);
    expect(() => { gK!.deposit_to(new kpred.deposit_to_arguments(1, gWho, VHP, false)); }).toThrow();
    expect(() => { gK!.deposit_to(new kpred.deposit_to_arguments(9, gWho, VHP, false)); }).toThrow();
    expect(() => { gK!.deposit_to(new kpred.deposit_to_arguments(G3, gWho, VHP, false)); }).toThrow();
    expect(() => { gK!.deposit_to(new kpred.deposit_to_arguments(G2, gWho, VHP / 2, false)); }).toThrow();
    as(OWNER);
    k.set_paused(new kpred.set_paused_arguments(true));
    as(A);
    expect(() => { gK!.deposit_to(new kpred.deposit_to_arguments(G2, gWho, VHP, false)); }).toThrow();
  });

  it("withdrawing mid-week voids only that game's week; withdrawals work when paused or the game is stopped", () => {
    const k = setup();
    addGames(k);
    at(200);
    depositQ(k, A, 3 * VHP);
    depositG(k, G2, A, 4 * VHP);
    at(weekEnd(0) + 100);                          // week 1
    as(OWNER);
    k.set_paused(new kpred.set_paused_arguments(true));
    k.deactivate_game(new kpred.deactivate_game_arguments(G2));
    const before = vhpOf(A);
    as(A);
    k.withdraw_from(new kpred.withdraw_from_arguments(G2, A, 4 * VHP));
    expect(vhpOf(A)).toBe(before + 4 * VHP);
    expect(k.get_game_player(new kpred.get_game_player_arguments(G2, A, 1)).week_stake).toBe(0);
    expect(k.get_game_player(new kpred.get_game_player_arguments(G2, A, 0)).week_stake).toBe(4 * VHP);   // week 0 frozen
    expect(k.get_player(new kpred.get_player_arguments(A, 1)).player!.void_week_plus_one).toBe(0);         // game 1 untouched
    as(A);
    k.withdraw(new kpred.withdraw_arguments(A, 3 * VHP));
    const t = k.totals.get()!;
    expect(t.total_stake).toBe(0);
    expect(t.stake_other).toBe(0);
    expect(game(k, 1).stake).toBe(0);
    expect(game(k, G2).stake).toBe(0);
  });

  it("a partial withdrawal lowers that week's stake; more than the stake is refused", () => {
    const k = setup();
    gK = k;
    addGames(k);
    at(200);
    depositG(k, G2, B, 10 * VHP);
    at(weekEnd(0) + 100);
    as(B);
    k.withdraw_from(new kpred.withdraw_from_arguments(G2, B, 3 * VHP));
    expect(k.get_game_player(new kpred.get_game_player_arguments(G2, B, 1)).week_stake).toBe(7 * VHP);
    gWho = B;
    expect(() => { gK!.withdraw_from(new kpred.withdraw_from_arguments(G2, gWho, 8 * VHP)); }).toThrow();
  });

  it("moving stake: no tokens move, totals stay, the source week is voided only if all of it leaves", () => {
    const k = setup();
    gK = k;
    addGames(k);
    at(200);
    depositQ(k, C, 6 * VHP);
    at(weekEnd(0) + 100);
    const bal = vhpOf(CONTRACT);
    as(C);
    k.move_stake(new kpred.move_stake_arguments(C, 1, G2, 6 * VHP));
    expect(vhpOf(CONTRACT)).toBe(bal);
    expect(k.totals.get()!.total_stake).toBe(6 * VHP);
    expect(k.totals.get()!.stake_other).toBe(6 * VHP);
    expect(k.get_player(new kpred.get_player_arguments(C, 1)).player!.void_week_plus_one).toBe(2);
    const gp = k.get_game_player(new kpred.get_game_player_arguments(G2, C, 2));
    expect(gp.week_stake).toBe(6 * VHP);            // counts in game 2 from week 2
    expect(k.get_game_player(new kpred.get_game_player_arguments(G2, C, 1)).week_stake).toBe(0);
    // and back again
    as(C);
    k.move_stake(new kpred.move_stake_arguments(C, G2, 1, 2 * VHP));
    expect(k.totals.get()!.stake_other).toBe(4 * VHP);
    expect(game(k, 1).stake).toBe(2 * VHP);
    expect(game(k, G2).stake).toBe(4 * VHP);
    gWho = C;
    expect(() => { gK!.move_stake(new kpred.move_stake_arguments(gWho, G2, G3, VHP)); }).toThrow();   // G3 takes no stake
    expect(() => { gK!.move_stake(new kpred.move_stake_arguments(gWho, G2, G2, VHP)); }).toThrow();
  });
});

describe("v6 weekly split", () => {
  it("5% fee in VHP, 3 VHP prize per free game from the seed's part, the rest by stake, and a bucket with no winner rolls over in its game", () => {
    const k = setup();
    addGames(k);
    at(200);
    depositQ(k, A, 30 * VHP);
    depositG(k, G2, B, 10 * VHP);
    seedIn(k, 1000 * VHP);
    // week 0: only game 1 earns (games 2 and 3 start in week 1)
    give(VHP_TAG, CONTRACT, 100 * VHP);
    closeWeek(k, 0);
    const w0 = k.get_week(new kpred.get_week_arguments(0)).week!;
    expect(w0.gain).toBe(100 * VHP);
    expect(w0.fee_vhp).toBe(5 * VHP);
    expect(w0.fee).toBe(0);
    expect(w0.pot).toBe(95 * VHP);
    expect(w0.seed_part > 90 * VHP).toBe(true);   // the seed is 1000 of 1040 VHP
    expect(w0.pot_free).toBe(3 * VHP);
    expect(w0.prizes).toBe(3 * VHP);
    expect(k.totals.get()!.fee_vhp).toBe(5 * VHP);
    expect(gweek(k, G2, 0).closed).toBe(false);
    // nobody answered: game 1's week 0 rolls over inside game 1 (all but the prize, which went to basket B and rolls too)
    finalizeQ(k, 0);
    const w0f = k.get_week(new kpred.get_week_arguments(0)).week!;
    expect(w0f.rolled_over).toBe(true);
    expect(game(k, 1).rolled).toBe(95 * VHP);
    expect(k.totals.get()!.games_rolled).toBe(95 * VHP);
    expect(k.totals.get()!.rolled_over).toBe(0);
    k.assertSolvent();
    // week 1: 80 VHP of new rewards; the rollover comes back to game 1 fee-free
    give(VHP_TAG, CONTRACT, 80 * VHP);
    closeWeek(k, 1);
    const w1 = k.get_week(new kpred.get_week_arguments(1)).week!;
    expect(w1.gain).toBe(80 * VHP);
    expect(w1.fee_vhp).toBe(4 * VHP);
    expect(w1.prizes).toBe(6 * VHP);              // game 1 and game 3
    const R: u64 = 76 * VHP - 6 * VHP;            // 70 VHP split 30:10 by the week's stake
    expect(w1.split).toBe(R);
    const b2 = gweek(k, G2, 1);
    expect(b2.closed).toBe(true);
    expect(b2.bucket).toBe(R / 4);
    expect(b2.prize).toBe(0);
    expect(gweek(k, G3, 1).prize).toBe(3 * VHP);
    expect(gweek(k, G3, 1).bucket).toBe(0);
    expect(w1.pot).toBe(R - R / 4 + 95 * VHP + 3 * VHP);
    expect(w1.pot_a).toBe((w1.pot - w1.pot_free) * 4 / 10);
    expect(game(k, 1).rolled).toBe(0);
    expect(k.totals.get()!.games_rolled).toBe(0);
    k.assertSolvent();
  });

  it("a game's share is its players' lowest stake that week: deposits count next week, withdrawals at once", () => {
    const k = setup();
    addGames(k);
    at(200);
    depositQ(k, A, 10 * VHP);
    depositG(k, G2, B, 10 * VHP);
    seedIn(k, 1000 * VHP);
    closeWeek(k, 0);
    at(weekEnd(0) + 300);                          // in week 1
    depositG(k, G2, C, 100 * VHP);                 // counts only from week 2
    as(B);
    k.withdraw_from(new kpred.withdraw_from_arguments(G2, B, 5 * VHP));   // week 1 counts 5 for B
    MockVM.commitTransaction();
    at(weekEnd(0) + 600);
    depositG(k, G2, B, 5 * VHP);                   // back to 10, but week 1 stays at its lowest
    give(VHP_TAG, CONTRACT, 106 * VHP);
    closeWeek(k, 1);
    const w1 = k.get_week(new kpred.get_week_arguments(1)).week!;
    expect(gweek(k, G2, 1).bucket).toBe(w1.split / 3);   // game 1: 10, game 2: 5
    give(VHP_TAG, CONTRACT, 106 * VHP);
    closeWeek(k, 2);
    const w2 = k.get_week(new kpred.get_week_arguments(2)).week!;
    expect(gweek(k, G2, 2).bucket).toBe(w2.split * 110 / 120);   // game 2: 5 + 5 + 100
  });

  it("with no seed the prizes wait and staked players get it all; the carry stops at 12 VHP per game", () => {
    const k = setup();
    addGames(k);
    at(200);
    depositQ(k, A, 10 * VHP);
    closeWeek(k, 0);
    give(VHP_TAG, CONTRACT, 20 * VHP);
    closeWeek(k, 1);
    const w1 = k.get_week(new kpred.get_week_arguments(1)).week!;
    expect(w1.seed_part).toBe(0);
    expect(w1.prizes).toBe(0);
    expect(w1.split).toBe(19 * VHP);               // all of the pot to the stakers
    for (let w: u64 = 2; w < 8; w++) closeWeek(k, w);
    expect(game(k, G3).prize_carry).toBe(12 * VHP);
    expect(game(k, 1).prize_carry).toBe(12 * VHP);
    k.assertSolvent();
  });

  it("a small seed pays what its part covers, in proportion to each game's need", () => {
    const k = setup();
    addGames(k);
    at(200);
    depositQ(k, A, 30 * VHP);
    seedIn(k, 10 * VHP);                           // a quarter of what produces
    closeWeek(k, 0);
    give(VHP_TAG, CONTRACT, 20 * VHP);             // pot 19; the seed's part about 4.75; needs 6 + 3
    closeWeek(k, 1);
    const w1 = k.get_week(new kpred.get_week_arguments(1)).week!;
    expect(w1.seed_part > 4 * VHP && w1.seed_part < 5 * VHP).toBe(true);
    expect(w1.prizes <= w1.seed_part).toBe(true);
    expect(w1.seed_part - w1.prizes < 3).toBe(true);           // all of it used (but rounding)
    expect(w1.split).toBe(w1.gain - w1.fee_vhp - w1.prizes);
    expect(game(k, G3).prize_carry > VHP).toBe(true);
    k.assertSolvent();
  });
});

function playG2Week1(k: Kpred): void {
  addGames(k);
  at(200);
  depositG(k, G2, A, 20 * VHP);
  depositG(k, G2, B, 10 * VHP);
  depositG(k, G2, C, 5 * VHP);
  depositG(k, G2, D, 1 * VHP);
  closeWeek(k, 0);
  give(VHP_TAG, CONTRACT, 100 * VHP);
}

describe("v6 results of other games", () => {
  it("only the operator posts, only after the week, only staked players, once each, points 1–255", () => {
    const k = setup();
    gK = k;
    playG2Week1(k);
    at(weekEnd(1) - 5);
    as(OPERATOR);
    gWho = A;
    expect(() => { gK!.post_results(new kpred.post_results_arguments(G2, 1, [row(gWho, 5)])); }).toThrow();   // week not over
    at(weekEnd(1) + 1);
    as(A);
    expect(() => { gK!.post_results(new kpred.post_results_arguments(G2, 1, [row(gWho, 5)])); }).toThrow();   // not operator
    as(OPERATOR);
    gWho = E;                                      // never staked
    expect(() => { gK!.post_results(new kpred.post_results_arguments(G2, 1, [row(gWho, 5)])); }).toThrow();
    gWho = A;
    expect(() => { gK!.post_results(new kpred.post_results_arguments(G2, 1, [row(gWho, 0)])); }).toThrow();
    expect(() => { gK!.post_results(new kpred.post_results_arguments(G2, 1, [row(gWho, 256)])); }).toThrow();
    expect(() => { gK!.post_results(new kpred.post_results_arguments(G3, 1, [row(gWho, 5)])); }).toThrow();   // no bucket
    postRows(k, G2, 1, [row(A, 9), row(B, 9)]);
    expect(() => { gK!.post_results(new kpred.post_results_arguments(G2, 1, [row(gWho, 3)])); }).toThrow();   // twice
    const gw = gweek(k, G2, 1);
    expect(gw.eligible_players).toBe(2);
    expect(gw.max_points).toBe(9);
  });

  it("seal, 12 hours, finalize: the top 30% win, claims never exceed the bucket, and the books balance", () => {
    const k = setup();
    gK = k;
    playG2Week1(k);
    closeWeek(k, 1);
    postRows(k, G2, 1, [row(A, 4), row(B, 9), row(C, 9), row(D, 2)]);
    seal(k, G2, 1);
    gGame = G2; gWeek = 1;
    nobody();
    expect(() => { gK!.finalize_game_week(new kpred.finalize_game_week_arguments(gGame, gWeek)); }).toThrow();   // too soon
    at(weekEnd(1) + CLOSE + 1 + CLOSE + 1);
    const r = k.finalize_game_week(new kpred.finalize_game_week_arguments(G2, 1));
    expect(r.done).toBe(true);
    expect(r.cutoff).toBe(9);                      // 30% of 4 = 2 players (B and C tied on 9)
    expect(r.winners).toBe(2);
    const gw = gweek(k, G2, 1);
    let paid: u64 = 0;
    paid += claimG(k, G2, 1, B);
    paid += claimG(k, G2, 1, C);
    expect(paid <= gw.bucket).toBe(true);
    expect(gw.bucket - paid < 10).toBe(true);
    gWho = A;
    as(A);
    expect(() => { gK!.claim_game(new kpred.claim_game_arguments(G2, gWho, 1)); }).toThrow();   // below the cutoff
    gWho = B;
    as(B);
    expect(() => { gK!.claim_game(new kpred.claim_game_arguments(G2, gWho, 1)); }).toThrow();   // twice
    k.assertSolvent();
    // B (10 VHP) and C (5 VHP) share the same places: basket A is equal up to the 10 VHP cap, basket B by stake
    const rb = k.get_game_player(new kpred.get_game_player_arguments(G2, B, 1)).entry!.reward;
    const rc = k.get_game_player(new kpred.get_game_player_arguments(G2, C, 1)).entry!.reward;
    expect(rb > rc).toBe(true);
  });

  it("the owner corrects until a day after the seal; each correction restarts the 12-hour wait", () => {
    const k = setup();
    gK = k;
    playG2Week1(k);
    closeWeek(k, 1);
    postRows(k, G2, 1, [row(A, 4), row(B, 9)]);
    seal(k, G2, 1);
    const sealAt = weekEnd(1) + CLOSE + 1;
    at(sealAt + CLOSE - 2);
    as(OWNER);
    k.correct_result(new kpred.correct_result_arguments(G2, 1, A, 12, false));   // A now leads
    at(sealAt + CLOSE + 1);
    nobody();
    gGame = G2; gWeek = 1;
    expect(() => { gK!.finalize_game_week(new kpred.finalize_game_week_arguments(gGame, gWeek)); }).toThrow();
    at(sealAt + 2 * CLOSE);
    as(OPERATOR);
    gWho = C;
    expect(() => { gK!.correct_result(new kpred.correct_result_arguments(G2, 1, gWho, 3, false)); }).toThrow();   // not owner
    as(OWNER);
    expect(() => { gK!.correct_result(new kpred.correct_result_arguments(G2, 1, gWho, 3, false)); }).toThrow();   // window over
    nobody();
    const r = k.finalize_game_week(new kpred.finalize_game_week_arguments(G2, 1));
    expect(r.cutoff).toBe(12);
    expect(r.winners).toBe(1);
    expect(claimG(k, G2, 1, A)).toBe(gweek(k, G2, 1).bucket);
  });

  it("results not sealed by the deadline, or voided, roll over within the game, fee-free", () => {
    const k = setup();
    gK = k;
    playG2Week1(k);
    closeWeek(k, 1);
    const bucket = gweek(k, G2, 1).bucket;
    postRows(k, G2, 1, [row(A, 4)]);
    nobody();
    gGame = G2; gWeek = 1;
    at(weekEnd(1) + DUE - 2);
    expect(() => { gK!.finalize_game_week(new kpred.finalize_game_week_arguments(gGame, gWeek)); }).toThrow();
    at(weekEnd(1) + DUE + 1);
    expect(k.finalize_game_week(new kpred.finalize_game_week_arguments(G2, 1)).done).toBe(true);
    expect(gweek(k, G2, 1).rolled_over).toBe(true);
    expect(game(k, G2).rolled).toBe(bucket);
    gWho = A;
    as(A);
    expect(() => { gK!.claim_game(new kpred.claim_game_arguments(G2, gWho, 1)); }).toThrow();
    k.assertSolvent();
    // the next close: no new rewards, so the bucket is just the rollover, with no fee
    closeWeek(k, 2);
    expect(k.get_week(new kpred.get_week_arguments(2)).week!.gain).toBe(0);
    expect(gweek(k, G2, 2).bucket).toBe(bucket);
    // the owner voids week 2: it rolls again
    as(OWNER);
    k.void_game_week(new kpred.void_game_week_arguments(G2, 2));
    nobody();
    k.finalize_game_week(new kpred.finalize_game_week_arguments(G2, 2));
    expect(game(k, G2).rolled).toBe(bucket);
    k.assertSolvent();
  });

  it("a stopped game's rollover is released into the next split", () => {
    const k = setup();
    playG2Week1(k);
    depositQ(k, F, 5 * VHP);
    closeWeek(k, 1);
    const bucket = gweek(k, G2, 1).bucket;
    at(weekEnd(1) + DUE + 1);
    nobody();
    k.finalize_game_week(new kpred.finalize_game_week_arguments(G2, 1));
    as(OWNER);
    k.deactivate_game(new kpred.deactivate_game_arguments(G2));      // earns through week 2, then stops
    closeWeek(k, 2);
    expect(gweek(k, G2, 2).bucket).toBe(bucket);
    at(weekEnd(2) + DUE + 1);
    nobody();
    k.finalize_game_week(new kpred.finalize_game_week_arguments(G2, 2));
    closeWeek(k, 3);
    expect(gweek(k, G2, 3).closed).toBe(false);
    expect(game(k, G2).rolled).toBe(0);
    const w3 = k.get_week(new kpred.get_week_arguments(3)).week!;
    expect(w3.split >= bucket).toBe(true);         // released to the games still earning
    k.assertSolvent();
  });
});

describe("v6 free prizes", () => {
  it("other games: 2 VHP to 1st and 1 VHP shared by the 2nd places; staked players can't win it", () => {
    const k = setup();
    gK = k;
    addGames(k);
    at(200);
    depositQ(k, A, 10 * VHP);
    seedIn(k, 1000 * VHP);
    depositG(k, G2, B, 2 * VHP);
    closeWeek(k, 0);
    give(VHP_TAG, CONTRACT, 50 * VHP);
    closeWeek(k, 1);
    as(OPERATOR);
    k.post_prize_winners(new kpred.post_prize_winners_arguments(G3, 1, 1, [C]));
    k.post_prize_winners(new kpred.post_prize_winners_arguments(G3, 1, 2, [D, E]));
    MockVM.commitTransaction();
    gWho = C;
    expect(() => { gK!.post_prize_winners(new kpred.post_prize_winners_arguments(G3, 1, 2, [gWho])); }).toThrow();   // twice
    expect(() => { gK!.post_prize_winners(new kpred.post_prize_winners_arguments(G3, 1, 3, [F])); }).toThrow();
    expect(() => { gK!.post_prize_winners(new kpred.post_prize_winners_arguments(G2, 1, 1, [F])); }).toThrow();   // no prize
    seal(k, G3, 1);
    at(weekEnd(1) + CLOSE + 1 + CLOSE + 1);
    nobody();
    k.finalize_game_week(new kpred.finalize_game_week_arguments(G3, 1));
    expect(claimG(k, G3, 1, C)).toBe(2 * VHP);
    expect(claimG(k, G3, 1, D)).toBe(VHP / 2);
    expect(claimG(k, G3, 1, E)).toBe(VHP / 2);
    k.assertSolvent();
  });

  it("a player staked in that game that week is refused as a free winner", () => {
    const k = setup();
    gK = k;
    at(110);
    as(OWNER);
    k.propose_game(new kpred.propose_game_arguments(4, "Both", true, true));
    at(110 + LOCK + 10);
    as(OWNER);
    k.apply_game(new kpred.apply_game_arguments(4));
    at(200);
    depositG(k, 4, B, 2 * VHP);
    closeWeek(k, 0);
    closeWeek(k, 1);
    as(OPERATOR);
    gWho = B;
    expect(() => { gK!.post_prize_winners(new kpred.post_prize_winners_arguments(4, 1, 1, [gWho])); }).toThrow();
  });

  it("ties at 1st share all 3 VHP; nobody posted: the prize returns to the pool (fee-free next week)", () => {
    const k = setup();
    addGames(k);
    at(200);
    depositQ(k, A, 10 * VHP);
    seedIn(k, 1000 * VHP);
    closeWeek(k, 0);
    give(VHP_TAG, CONTRACT, 50 * VHP);
    closeWeek(k, 1);
    as(OPERATOR);
    k.post_prize_winners(new kpred.post_prize_winners_arguments(G3, 1, 1, [C, D, E]));
    k.post_prize_winners(new kpred.post_prize_winners_arguments(G3, 1, 2, [F]));
    seal(k, G3, 1);
    at(weekEnd(1) + CLOSE + 1 + CLOSE + 1);
    nobody();
    k.finalize_game_week(new kpred.finalize_game_week_arguments(G3, 1));
    expect(claimG(k, G3, 1, C)).toBe(VHP);
    expect(claimG(k, G3, 1, D)).toBe(VHP);
    expect(claimG(k, G3, 1, E)).toBe(VHP);
    gWho = F;
    gK = k;
    as(F);
    expect(() => { gK!.claim_game(new kpred.claim_game_arguments(G3, gWho, 1)); }).toThrow();
    // week 2: nobody posted -> the prize returns
    give(VHP_TAG, CONTRACT, 50 * VHP);
    closeWeek(k, 2);
    at(weekEnd(2) + DUE + 1);
    nobody();
    k.finalize_game_week(new kpred.finalize_game_week_arguments(G3, 2));
    expect(k.totals.get()!.rolled_over).toBe(3 * VHP);
    closeWeek(k, 3);
    const w3 = k.get_week(new kpred.get_week_arguments(3)).week!;
    expect(w3.gain).toBe(3 * VHP);
    expect(w3.fee_vhp).toBe(0);                    // already charged once
    k.assertSolvent();
  });

  it("question game: 2 VHP to the best free player, 1 VHP to the second", () => {
    const k = setup();
    at(200);
    depositQ(k, A, 10 * VHP);
    seedIn(k, 1000 * VHP);
    give(VHP_TAG, CONTRACT, 40 * VHP);
    // week 0 with three questions; A staked, C best free (3), D second free (2)
    at(GENESIS + 100);
    as(OPERATOR);
    const q0 = k.post_question(new kpred.post_question_arguments(2, (GENESIS + 300) * MS, GENESIS + 301, GENESIS + 400, new Uint8Array(32).fill(7))).id;
    const q1 = k.post_question(new kpred.post_question_arguments(2, (GENESIS + 300) * MS, GENESIS + 301, GENESIS + 400, new Uint8Array(32).fill(7))).id;
    const q2 = k.post_question(new kpred.post_question_arguments(2, (GENESIS + 300) * MS, GENESIS + 301, GENESIS + 400, new Uint8Array(32).fill(7))).id;
    at(GENESIS + 200);
    const who: Uint8Array[] = [A, C, D];
    const right: i32[] = [3, 3, 2];
    for (let p = 0; p < 3; p++) {
      as(who[p]);
      k.answer(new kpred.answer_arguments(who[p], q0, right[p] >= 1 ? 1 : 0));
      k.answer(new kpred.answer_arguments(who[p], q1, right[p] >= 2 ? 1 : 0));
      k.answer(new kpred.answer_arguments(who[p], q2, right[p] >= 3 ? 1 : 0));
    }
    at(GENESIS + 500);
    as(OPERATOR);
    k.resolve_question(new kpred.resolve_question_arguments(q0, 1, new Uint8Array(32).fill(9)));
    k.resolve_question(new kpred.resolve_question_arguments(q1, 1, new Uint8Array(32).fill(9)));
    k.resolve_question(new kpred.resolve_question_arguments(q2, 1, new Uint8Array(32).fill(9)));
    closeWeek(k, 0);
    for (let p = 0; p < 3; p++) k.settle(new kpred.settle_arguments(who[p], 0));
    finalizeQ(k, 0);
    as(C);
    expect(k.claim(new kpred.claim_arguments(C, 0)).reward).toBe(2 * VHP);
    as(D);
    expect(k.claim(new kpred.claim_arguments(D, 0)).reward).toBe(VHP);
    as(A);
    const wk = k.get_week(new kpred.get_week_arguments(0)).week!;
    expect(k.claim(new kpred.claim_arguments(A, 0)).reward).toBe(wk.pot_a + wk.pot_b);
    k.assertSolvent();
  });
});

describe("v6 full exit", () => {
  it("after weeks of play in three games, everyone takes everything out and nothing is owed or stuck", () => {
    const k = setup();
    addGames(k);
    at(200);
    depositQ(k, A, 30 * VHP);
    depositG(k, G2, B, 10 * VHP);
    depositG(k, G2, C, 5 * VHP);
    as(SEED);
    k.seed_deposit_vhp(new kpred.seed_deposit_vhp_arguments(100 * VHP));
    give(VHP_TAG, CONTRACT, 30 * VHP);
    closeWeek(k, 0);
    finalizeQ(k, 0);                               // rolls over in game 1
    give(VHP_TAG, CONTRACT, 60 * VHP);
    closeWeek(k, 1);
    postRows(k, G2, 1, [row(B, 3), row(C, 5)]);
    as(OPERATOR);
    k.post_prize_winners(new kpred.post_prize_winners_arguments(G3, 1, 1, [D]));
    seal(k, G2, 1);
    seal(k, G3, 1);
    finalizeQ(k, 1);                               // game 1 rolls over again (a day later: past the 12-hour wait)
    nobody();
    k.finalize_game_week(new kpred.finalize_game_week_arguments(G2, 1));
    k.finalize_game_week(new kpred.finalize_game_week_arguments(G3, 1));
    claimG(k, G2, 1, C);
    claimG(k, G3, 1, D);
    // everyone leaves
    at(weekEnd(1) + 300);
    as(A); k.withdraw(new kpred.withdraw_arguments(A, 30 * VHP));
    as(B); k.withdraw_from(new kpred.withdraw_from_arguments(G2, B, 10 * VHP));
    as(C); k.withdraw_from(new kpred.withdraw_from_arguments(G2, C, 5 * VHP));
    as(SEED);
    k.request_seed_withdrawal(new kpred.request_seed_withdrawal_arguments(100 * VHP, 0));
    at(weekEnd(1) + 300 + LOCK + 1);
    as(SEED);
    k.execute_seed_withdrawal(new kpred.execute_seed_withdrawal_arguments());
    as(OWNER);
    const fee = k.totals.get()!.fee_vhp;
    k.claim_fee_vhp(new kpred.claim_fee_vhp_arguments(OWNER, fee));
    const t = k.totals.get()!;
    expect(t.total_stake).toBe(0);
    expect(t.stake_other).toBe(0);
    expect(t.seed_vhp).toBe(0);
    expect(t.fee_vhp).toBe(0);
    // what remains is exactly the unclaimed and rolled-over rewards (plus rounding dust), all still owed
    const held = vhpOf(CONTRACT);
    expect(held >= t.pots_outstanding + t.games_rolled + t.rolled_over).toBe(true);
    expect(held - (t.pots_outstanding + t.games_rolled + t.rolled_over) < 10).toBe(true);
    k.assertSolvent();
  });
});

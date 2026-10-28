// Combo Card (site/combo-math.js, shared by the page and the recorder bot/games/combo.ts): the card rules (2 to 6 legs,
// one leg per race or block, every leg open, the contract's locks), the price of each leg type from a real race card,
// exact points with the 150 cap, every leg-type result edge, void legs, and the best-10 leaderboard. Offline.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const APP = process.env.APP || ".";
const read = (f) => fs.readFileSync(`${APP}/site/${f}`, "utf8");
const box = { window: {} };
vm.runInNewContext(read("race-math.js") + "\n" + read("blockx-math.js") + "\n" + read("combo-math.js"), box);
const C = box.window.KCombo, M = box.window.KRaceMath, X = box.window.KBlockX;
const plain = (x) => JSON.parse(JSON.stringify(x));
const CARD = JSON.parse(fs.readFileSync(`${APP}/tests/fixtures/combo-card-2026-10-27.json`, "utf8"));   // real, 17 horses
const TOP = CARD.field[0].a, LAST = CARD.field[CARD.field.length - 1].a, PADDOCK = CARD.paddock[0].a;
const STRANGER = "1ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ";

// A head: 2026-11-03 10:00 UTC at height 48,000,000 (heights and times only need to be consistent).
const NOW = Date.parse("2026-11-03T10:00:00Z"), H = 48_000_000;
const head = { height: H, time: NOW };
const R = M.raceIndex(NOW) + 1;                 // the next race (12:00), opens 2 h from now
const B = Math.floor(H / X.ROUND) + 2;          // a Block X target ~4,800 blocks ahead
const leg = (code, round, producer = TOP) => ({ code, round, producer });

test("card shape: 2 to 6 legs, known codes, valid producers", () => {
  assert.match(C.cardProblem([leg(C.SHOW, R)], head), /at least 2/);
  assert.match(C.cardProblem([], head), /at least 2/);
  const seven = Array.from({ length: 7 }, (_, i) => leg(C.BLOCK, B + i));
  assert.match(C.cardProblem(seven, head), /at most 6/);
  assert.equal(C.cardProblem(seven.slice(0, 6), head), null);
  assert.match(C.cardProblem([leg(5, R), leg(C.BLOCK, B)], head), /Unknown/);
  assert.match(C.cardProblem([leg(C.WIN, R, "nope"), leg(C.BLOCK, B)], head), /invalid producer/);
  assert.match(C.cardProblem([leg(C.WIN, 0), leg(C.BLOCK, B)], head), /Unknown/);
});

test("same race is refused for every pair of race leg types; same block refused; different ones fine", () => {
  for (const a of [C.WIN, C.SHOW, C.HALF]) for (const b of [C.WIN, C.SHOW, C.HALF]) {
    assert.match(C.cardProblem([leg(a, R, TOP), leg(b, R, LAST)], head), /one leg per race/, `${a}+${b}`);
  }
  assert.match(C.cardProblem([leg(C.BLOCK, B, TOP), leg(C.BLOCK, B, LAST)], head), /one leg per block/);
  assert.equal(C.cardProblem([leg(C.WIN, R), leg(C.SHOW, R + 1), leg(C.HALF, R + 2), leg(C.BLOCK, B)], head), null);
  // A race index and a block round with the same number are different things.
  assert.equal(C.cardProblem([leg(C.SHOW, 12345), leg(C.BLOCK, 12345)], { height: 12345 * X.ROUND - 5000, time: M.raceStart(12345) - 3 * M.HOUR }), null);
});

test("race legs lock 5 minutes before the start and open 24 h ahead (time); Block X legs by height", () => {
  const start = M.raceStart(R);
  const at = (time, height = H) => ({ time, height });
  assert.ok(C.legOpen(leg(C.SHOW, R), at(start - 5 * 60000 - 1)));
  assert.ok(!C.legOpen(leg(C.SHOW, R), at(start - 5 * 60000)), "locked at exactly start − 5 min");
  assert.ok(!C.legOpen(leg(C.SHOW, R), at(start + 1)), "started");
  assert.ok(C.legOpen(leg(C.WIN, R), at(start - 24 * M.HOUR)));
  assert.ok(!C.legOpen(leg(C.WIN, R), at(start - 24 * M.HOUR - 1)), "more than 24 h ahead");
  const t = X.target(B);
  assert.ok(C.legOpen(leg(C.BLOCK, B), at(NOW, t - 101)));
  assert.ok(!C.legOpen(leg(C.BLOCK, B), at(NOW, t - 100)), "locked at target − 100, like Block X");
  assert.ok(C.legOpen(leg(C.BLOCK, B), at(NOW, t - 28800)));
  assert.ok(!C.legOpen(leg(C.BLOCK, B), at(NOW, t - 28801)), "more than 28,800 blocks ahead");
  // The card is refused if any one leg is locked, and its lock is the earliest leg's.
  const legs = [leg(C.SHOW, R), leg(C.BLOCK, B)];
  assert.match(C.cardProblem(legs, at(start - 60000)), /Show leg is locked/);
  assert.equal(C.cardLockTime(legs, head), Math.min(start - 5 * 60000, X.aboutTime(X.target(B) - 100, H, NOW)));
});

test("slots: 3 per UTC day", () => {
  const d = C.utcDay(NOW);
  assert.deepEqual([0, 1, 2].map((s) => C.dayOfRound(C.slotRound(d, s))), [d, d, d]);
  assert.equal(C.dayOfRound(C.slotRound(d, 2) + 1), d + 1);
});

test("price card: the latest card taken at or before the time", () => {
  const a = { ...CARD, at: 1000 }, b = { ...CARD, at: 2000 }, empty = { ...CARD, at: 1500, field: [] };
  const races = [{ cards: [a, null, empty] }, { cards: [b] }];
  assert.equal(C.priceCard(races, 999), null);
  assert.equal(C.priceCard(races, 1000).at, 1000);
  assert.equal(C.priceCard(races, 1999).at, 1000, "a card with no field is skipped");
  assert.equal(C.priceCard(races, 5000).at, 2000);
});

test("race chances from the real card: win near-equal, show and top-half spread; seeded and repeatable", () => {
  const ch = C.raceChances(CARD), again = C.raceChances(plain(CARD));
  assert.deepEqual(plain([...ch]), plain([...again]));
  let w = 0, s = 0, h = 0;
  for (const v of ch.values()) { w += v.win; s += v.show; h += v.half; assert.ok(v.win <= v.show && v.show <= v.half); }
  assert.ok(Math.abs(w - 1) < 0.01 && Math.abs(s - 3) < 0.01 && Math.abs(h - Math.floor(CARD.field.length / 2)) < 0.01);
  const wins = [...ch.values()].map((v) => v.win), shows = [...ch.values()].map((v) => v.show);
  assert.ok(Math.max(...wins) < 0.09 && Math.min(...wins) > 0.03, "the handicap evens out wins");
  assert.ok(Math.max(...shows) / Math.min(...shows) > 2, "but not top 3");
});

test("leg prices: factor = clamp(0.5 / chance, 0.25, 3); Block X by VHP share; unknown horse can't be priced", () => {
  assert.equal(C.factorOf(0.5), 1); assert.equal(C.factorOf(0.9), 0.56); assert.equal(C.factorOf(0.99), 0.51);
  assert.equal(C.factorOf(2.5), 0.25); assert.equal(C.factorOf(0.01), 3); assert.equal(C.factorOf(0), 3);
  const win = C.priceLeg(CARD, leg(C.WIN, R, TOP));
  assert.equal(win.factor, 3, "a ~5% win is capped at ×3");
  const half = C.priceLeg(CARD, leg(C.HALF, R, TOP));
  assert.ok(half.chance > 0.5 && half.factor < 1, "an easy top-half leg is worth less than ×1");
  const bx = C.priceLeg(CARD, leg(C.BLOCK, B, TOP));
  const total = [...CARD.field, ...CARD.paddock].reduce((s, r) => s + r.vhp, 0);
  assert.equal(bx.chance, Math.round(CARD.field[0].vhp / total * 1e4) / 1e4);
  assert.equal(bx.factor, Math.round(Math.min(3, 0.5 / bx.chance) * 100) / 100);
  assert.equal(C.priceLeg(CARD, leg(C.BLOCK, B, PADDOCK)).factor, 3, "small paddock producer: ×3");
  assert.equal(C.priceLeg(CARD, leg(C.BLOCK, B, STRANGER)).factor, 3, "producer missing from the card: ×3, as Block X");
  assert.equal(C.priceLeg(CARD, leg(C.SHOW, R, PADDOCK)), null, "a paddock horse isn't in the race field");
  assert.equal(C.priceLeg(null, leg(C.SHOW, R, TOP)), null);
  assert.equal(C.potential(CARD, [leg(C.SHOW, R, PADDOCK), leg(C.BLOCK, B)]).unpriced, true);
});

test("points: base by legs × factors, exact hundredths, capped at 150", () => {
  assert.deepEqual([2, 3, 4, 5, 6].map((n) => C.pointsFor(new Array(n).fill(100))), [300, 700, 1500, 3000, 6000]);
  assert.equal(C.pointsFor([300, 300]), 2700);
  assert.equal(C.pointsFor([300, 300, 300]), 15000, "7 × 27 = 189 → capped at 150");
  assert.equal(C.pointsFor(new Array(6).fill(300)), 15000);
  assert.equal(C.pointsFor(new Array(6).fill(25)), 1, "60 × 0.25^6 = 0.0146 points = 1.46 hundredths, rounded down");
  assert.equal(C.pointsFor([33, 33, 33]), Math.floor(700 * 33 * 33 * 33 / 1e6));
  assert.equal(C.pointsFor([100]), 0); assert.equal(C.pointsFor(new Array(7).fill(100)), 0);
});

test("results for every leg type: hit / miss / void / pending", () => {
  const st = (n) => Array.from({ length: n }, (_, i) => ({ a: i === 0 ? TOP : "1" + String(i).padStart(33, "Q"), steps: n - i, blocks: 1 }));
  const race = (s, extra = {}) => ({ result: { final: true, standings: s, ...extra } });
  const at = (i, n = 10) => st(n)[i].a;
  // Win
  assert.equal(C.legResult(leg(C.WIN, R, at(0)), race(st(10))), "hit");
  assert.equal(C.legResult(leg(C.WIN, R, at(1)), race(st(10))), "miss");
  // Show: places 1–3
  assert.equal(C.legResult(leg(C.SHOW, R, at(2)), race(st(10))), "hit");
  assert.equal(C.legResult(leg(C.SHOW, R, at(3)), race(st(10))), "miss");
  // Top half: places 1..floor(N/2); odd field 17 → top 8
  assert.equal(C.legResult(leg(C.HALF, R, at(4)), race(st(10))), "hit");
  assert.equal(C.legResult(leg(C.HALF, R, at(5)), race(st(10))), "miss");
  assert.equal(C.legResult(leg(C.HALF, R, at(7, 17)), race(st(17))), "hit");
  assert.equal(C.legResult(leg(C.HALF, R, at(8, 17)), race(st(17))), "miss");
  // A horse with no steps never hits, even at the top of a tiny field.
  const zero = [{ a: TOP, steps: 0, blocks: 0 }, { a: LAST, steps: 0, blocks: 0 }];
  assert.equal(C.legResult(leg(C.WIN, R, TOP), race(zero)), "miss");
  // Not in the race at all → void; race missed or not final → void / pending
  assert.equal(C.legResult(leg(C.SHOW, R, STRANGER), race(st(10))), "void");
  assert.equal(C.legResult(leg(C.SHOW, R, TOP), { result: { final: true, missed: true } }), "void");
  assert.equal(C.legResult(leg(C.SHOW, R, TOP), { result: { final: false } }), "pending");
  assert.equal(C.legResult(leg(C.SHOW, R, TOP), { result: null }), "pending");
  assert.equal(C.legResult(leg(C.SHOW, R, TOP), null), "pending");
  // Block X
  assert.equal(C.legResult(leg(C.BLOCK, B, TOP), null, { final: true, signer: TOP }), "hit");
  assert.equal(C.legResult(leg(C.BLOCK, B, TOP), null, { final: true, signer: LAST }), "miss");
  assert.equal(C.legResult(leg(C.BLOCK, B, TOP), null, { final: true, signer: null, void: "no card" }), "void");
  assert.equal(C.legResult(leg(C.BLOCK, B, TOP), null, null), "pending");
});

test("scoring a card: all hit, one miss, voids dropped, final only when every leg is final", () => {
  const legs = [leg(C.WIN, R, TOP), leg(C.HALF, R + 1, TOP), leg(C.BLOCK, B, TOP)];
  const f = legs.map((l) => C.priceLeg(CARD, l).f100);
  assert.deepEqual(plain(C.scoreCard(CARD, legs, ["hit", "hit", "hit"])), { state: "final", outcome: "hit", pts: C.pointsFor(f), counted: 3 });
  assert.deepEqual(plain(C.scoreCard(CARD, legs, ["hit", "miss", "hit"])), { state: "final", outcome: "miss", pts: 0, counted: 3 });
  assert.deepEqual(plain(C.scoreCard(CARD, legs, ["miss", "pending", "hit"])), { state: "pending", outcome: "miss", pts: 0, counted: 3 });
  assert.deepEqual(plain(C.scoreCard(CARD, legs, ["hit", "pending", "hit"])), { state: "pending", outcome: null, pts: 0, counted: 3 });
  // One void: scored as a 2-leg card on the other two.
  assert.deepEqual(plain(C.scoreCard(CARD, legs, ["hit", "void", "hit"])), { state: "final", outcome: "hit", pts: C.pointsFor([f[0], f[2]]), counted: 2 });
  // Two voids of three: fewer than 2 legs left → the card is void.
  assert.deepEqual(plain(C.scoreCard(CARD, legs, ["void", "void", "hit"])), { state: "final", outcome: "void", pts: 0, counted: 1 });
  // A race leg on a horse not on the price card: a miss (unless its race is void anyway).
  const bad = [leg(C.SHOW, R, PADDOCK), leg(C.BLOCK, B, TOP)];
  assert.equal(C.scoreCard(CARD, bad, ["hit", "hit"]).outcome, "miss");
  assert.equal(C.scoreCard(CARD, [...bad, leg(C.WIN, R + 2)], ["void", "hit", "hit"]).outcome, "hit");
});

test("leaderboard: best 10 cards, ties by hits then the earlier last hit", () => {
  const d = C.utcDay(NOW);
  const rows = [];
  for (let i = 0; i < 12; i++) rows.push({ player: "A", round: C.slotRound(d + Math.floor(i / 3), i % 3), pts: (i + 1) * 100, hit: true, lastLegTime: 1000 + i });
  rows.push({ player: "B", round: C.slotRound(d, 0), pts: 7000, hit: true, lastLegTime: 5 });
  rows.push({ player: "C", round: C.slotRound(d, 0), pts: 7000, hit: true, lastLegTime: 9 });
  rows.push({ player: "D", round: C.slotRound(d, 0), pts: 0, hit: false, lastLegTime: 0 });
  const b = C.places(C.board(rows));
  assert.equal(b[0].player, "A"); assert.equal(b[0].pts, 7500, "best 10 of 12: 3 + 4 + … + 12 = 75 points");
  assert.equal(b[0].cards, 12); assert.equal(b[0].days, 4);
  assert.deepEqual(plain(b.slice(1, 3).map((x) => x.player)), ["B", "C"], "same points and hits: earlier last hit first");
  assert.equal(b[3].player, "D"); assert.equal(b[3].pts, 0);
});

test("share text", () => {
  assert.equal(C.shareText([1, 2, 3, 4], ["hit", "hit", "pending", "miss"], 0), "KnodeGames Combo · 4 legs · ✅✅⏳❌ · 0 pts");
  assert.equal(C.shareText([1, 2], ["hit", "hit"], 2735), "KnodeGames Combo · 2 legs · ✅✅ · 27.35 pts");
});

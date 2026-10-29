// Block Golf rules (site/golf-math.js): the stroke table, shared places, the field, skipped holes, the mulligan,
// points and places. The page and the recorder run this same file.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

const APP = process.env.APP || ".";
await import(path.resolve(APP, "site/golf-math.js"));
const G = globalThis.KGolf;

const addr = (i) => "1" + String(i).padStart(4, "0").replace(/0/g, "z") + "A".repeat(28);   // distinct, valid-looking
const field = (scores, ranked = true) => scores.map((s, i) => ({ a: addr(i + 1), score: s, scored: s > 0, ranked }));

test("addresses used by the tests are valid", () => {
  for (let i = 1; i < 200; i++) assert.ok(G.isAddr(addr(i)), addr(i));
  assert.equal(new Set(Array.from({ length: 199 }, (_, i) => addr(i + 1))).size, 199);
});

test("stroke table over 100 distinct players", () => {
  const h = G.scoreHole(field(Array.from({ length: 100 }, (_, i) => 100 - i)));
  const s = (place) => h.results[addr(place)].strokes;
  assert.equal(s(1), 1);                        // 1st: hole in one
  assert.equal(s(2), 2); assert.equal(s(5), 2);  // top 5%
  assert.equal(s(6), 3); assert.equal(s(25), 3); // top 25%
  assert.equal(s(26), 4); assert.equal(s(65), 4);
  assert.equal(s(66), 5); assert.equal(s(90), 5);
  assert.equal(s(91), 6); assert.equal(s(100), 6);
  assert.equal(h.field, 100);
  assert.deepEqual(h.results[addr(7)], { place: 7, of: 100, strokes: 3 });
});

test("ties share the middle of their places; wallets that scored nothing don't pad the field and double bogey", () => {
  const scores = [5, 4, 3, 2, 1, 1, ...Array(94).fill(0)];
  const h = G.scoreHole(field(scores));
  assert.equal(h.field, 6, "only the 6 who scored");
  assert.equal(h.results[addr(7)].strokes, 6, "scored nothing: double bogey");
  assert.equal(h.results[addr(5)].strokes, h.results[addr(6)].strokes, "tied players alike");
  assert.equal(h.results[addr(5)].strokes, 6, "places 5–6 of 6");
  assert.equal(h.results[addr(1)].strokes, 1);
});

test("places at the band edges: 5.5% is a birdie, exactly 5% an eagle", () => {
  const s100 = Array.from({ length: 100 }, (_, i) => 100 - i); s100[5] = s100[4];   // 5th and 6th tied
  const h = G.scoreHole(field(s100));
  assert.equal(h.results[addr(5)].strokes, 3);
  assert.equal(h.results[addr(4)].strokes, 2);
  const h2 = G.scoreHole(field(Array.from({ length: 20 }, (_, i) => 20 - i)));
  assert.equal(h2.results[addr(2)].strokes, 3);     // 2 of 20 = 10%
  const h3 = G.scoreHole(field(Array.from({ length: 40 }, (_, i) => 40 - i)));
  assert.equal(h3.results[addr(2)].strokes, 2);     // 2 of 40 = 5%
});

test("tied first place: everyone on the top score holes in one; a hole where nobody scored is skipped", () => {
  const h = G.scoreHole(field([3, 3, 2, 1, 1, 0]));
  assert.equal(h.results[addr(1)].strokes, 1);
  assert.equal(h.results[addr(2)].strokes, 1);
  assert.equal(h.results[addr(6)].strokes, 6);
  assert.equal(G.scoreHole(field([0, 0, 0, 0, 0, 0])).skipped, true);
});

test("only ranked wallets make the field; a free wallet is placed as one more player", () => {
  const rows = [...field([10, 8, 6, 4, 2]), { a: addr(50), score: 9, scored: true, ranked: false }];
  // 100 empty free wallets can't push anyone up
  for (let i = 0; i < 100; i++) rows.push({ a: addr(60 + i), score: 0, scored: false, ranked: false });
  const h = G.scoreHole(rows);
  assert.equal(h.field, 5);
  assert.equal(h.results[addr(5)].strokes, 6, "last of the ranked 5 stays last");
  assert.equal(h.results[addr(50)].place, 2);
  assert.equal(h.results[addr(50)].of, 6);
  assert.equal(h.results[addr(60)].strokes, 6, "a free zero is placed below the field");
  const top = G.scoreHole([...field([4, 3, 2, 1, 1]), { a: addr(70), score: 9, scored: true, ranked: false }]);
  assert.equal(top.results[addr(70)].strokes, 1, "a free wallet beating the field still holes in one");
});

test("fewer than 5 ranked players: the hole is skipped for everyone", () => {
  const h = G.scoreHole([...field([5, 4, 3, 2]), ...field([9, 9], false).map((r, i) => ({ ...r, a: addr(20 + i) }))]);
  assert.equal(h.skipped, true);
  assert.deepEqual(h.results, {});
  assert.equal(G.scoreHole(field([1, 1, 1, 1, 1])).skipped, false);
  assert.equal(G.scoreHole(field([1]), 1).skipped, false, "the testnet can lower the minimum");
});

test("bad rows are ignored; a wallet listed twice keeps its better score", () => {
  const h = G.scoreHole([...field([5, 4, 3, 2, 1]), { a: "not an address", score: 9, ranked: true }, { a: addr(1), score: NaN, ranked: true },
    { a: addr(5), score: 7, scored: true, ranked: false }]);
  assert.equal(h.field, 5);
  assert.equal(h.results[addr(5)].place, 1);
  assert.equal(Object.keys(h.results).length, 5);
});

const hole = (id, strokesByAddr, skipped = false) => ({ id, skipped, results: Object.fromEntries(Object.entries(strokesByAddr).map(([a, s]) => [a, { place: 1, of: 10, strokes: s }])) });

test("the owner's example week: −1, 27 on par 28", () => {
  const A = addr(1);
  const holes = [hole("questions", { [A]: 3 }), hole("race", { [A]: 4 }), hole("blockx", { [A]: 2 }), hole("survivor", { [A]: 4 }),
    hole("lastnode", {}), hole("bracket", { [A]: 5 }), hole("fantasy", { [A]: 3 }), hole("combo", { [A]: 4 })];
  const c = G.card(holes, A);
  assert.equal(c.mulligan, "bracket");
  assert.equal(c.strokes, 27); assert.equal(c.par, 28); assert.equal(c.toPar, -1);
  assert.equal(c.pts, 7 * 7 - 27);
  assert.equal(c.lost, 1); assert.equal(c.under, 3); assert.equal(c.best, 2);
  assert.equal(G.toParText(c.toPar), "−1");
  assert.match(G.shareText(c, 2), /Week 3: −1 \(27 on par 28\) 🐦⚪🦅⚪⬛🟧🐦⚪$/);
});

test("the mulligan never drops a lost ball; a skipped hole doesn't count at all", () => {
  const A = addr(1);
  const c = G.card([hole("a", { [A]: 6 }), hole("b", {}), hole("c", { [A]: 3 }), hole("d", { [A]: 9 }, true)], A);
  assert.equal(c.mulligan, "a");
  assert.equal(c.holes.length, 3);
  assert.equal(c.strokes, 7 + 3);
  assert.equal(c.par, 8);
  assert.equal(c.pts, 14 - 10);
  // ties for worst: the first in course order is dropped
  assert.equal(G.card([hole("a", { [A]: 5 }), hole("b", { [A]: 5 })], A).mulligan, "a");
});

test("no scorecard without a played hole or with under 2 holes", () => {
  const A = addr(1), B = addr(2);
  assert.equal(G.card([hole("a", { [B]: 4 }), hole("b", { [B]: 4 })], A), null);
  assert.equal(G.card([hole("a", { [A]: 4 })], A), null);
  assert.equal(G.card([hole("a", { [A]: 4 }), hole("b", { [A]: 4 }, true)], A), null);
});

test("points are never negative and stay within the vault's 1–255", () => {
  const A = addr(1);
  const worst = G.card([hole("a", { [A]: 6 }), hole("b", {}), hole("c", {})], A);
  assert.ok(worst.pts >= 0);
  const best = G.card(Array.from({ length: 12 }, (_, i) => hole("h" + i, { [A]: 1 })), A);
  assert.equal(best.pts, 11 * 6);
  assert.ok(best.pts <= 255);
});

test("places: points, then fewer lost balls, then more under par, then best hole; full ties share", () => {
  const [A, B, C, D, E] = [1, 2, 3, 4, 5].map(addr);
  // A and B: same points; B has a lost ball → A ahead. C = D exactly → shared place.
  const holes = [
    hole("h1", { [A]: 4, [B]: 1, [C]: 3, [D]: 3, [E]: 6 }),
    hole("h2", { [A]: 4, [C]: 5, [D]: 5, [E]: 6 }),
    hole("h3", { [A]: 3, [B]: 3, [C]: 4, [D]: 4, [E]: 6 }),
    hole("h4", { [A]: 4, [B]: 4, [C]: 4, [D]: 4 }),
  ];
  const cs = G.cards(holes);
  const by = Object.fromEntries(cs.map((c) => [c.a, c]));
  assert.equal(by[A].pts, by[B].pts);
  assert.ok(by[A].place < by[B].place);
  assert.equal(by[C].place, by[D].place);
  assert.equal(cs[cs.length - 1].a, E);
  for (let i = 1; i < cs.length; i++) assert.ok(cs[i].place >= cs[i - 1].place);
});

test("the course: a game plays from the week after it joined, in course order, only with a reader", () => {
  const joined = { race: 1, questions: 1, blockx: 3, survivor: 4, mystery: 1 };
  const readable = ["questions", "race", "blockx", "survivor"];
  assert.deepEqual(G.courseFor(2, joined, readable), ["questions", "race"]);
  assert.deepEqual(G.courseFor(3, joined, readable), ["questions", "race", "blockx"]);
  assert.deepEqual(G.courseFor(9, joined, readable), ["questions", "race", "blockx", "survivor"]);
});

test("stroke names and icons cover 1–7", () => {
  for (let s = 1; s <= 7; s++) { assert.ok(G.NAMES[s]); assert.ok(G.ICON[s]); assert.ok(G.SHORT[s]); }
  assert.equal(G.toParText(0), "E"); assert.equal(G.toParText(3), "+3");
});

test("practice weeks: everyone is in the field and 3 players make a hole; staked weeks are strict", () => {
  assert.equal(JSON.stringify(G.rule(3, null)), JSON.stringify({ practice: true, everyone: true, minField: 3 }));
  assert.equal(JSON.stringify(G.rule(3, 5)), JSON.stringify({ practice: true, everyone: true, minField: 3 }));
  assert.equal(JSON.stringify(G.rule(5, 5)), JSON.stringify({ practice: false, everyone: false, minField: 5 }));
  const rows = field([3, 2, 1], false);
  assert.equal(G.scoreHole(rows, 3, false).skipped, true, "no ranked players");
  const h = G.scoreHole(rows, 3, true);
  assert.equal(h.skipped, false);
  assert.equal(h.field, 3);
  assert.deepEqual(h.results[addr(1)], { place: 1, of: 3, strokes: 1 });
});

test("a single played hole is dropped by the mulligan: 0 points, which can't win (the vault needs 1+)", () => {
  const A = addr(1), B = addr(2);
  const holes = [hole("a", { [A]: 1, [B]: 3 }), hole("b", { [B]: 3 }), hole("c", { [B]: 3 })];
  const c = G.card(holes, A);
  assert.equal(c.pts, 0);
  assert.equal(c.mulligan, "a");
});

test("staked weeks count VHP: your own stake never moves you; splitting it into idle wallets changes nothing (fix-check V1)", () => {
  const others = Array.from({ length: 50 }, (_, i) => ({ a: addr(i + 1), score: 100 - i, scored: true, ranked: 1 }));
  const at = (w) => G.scoreHole([...others.slice(0, 4), { a: addr(150), score: 95.5, scored: true, ranked: w }, ...others.slice(4)], 5, false, 10).results[addr(150)].strokes;
  assert.equal(at(50), at(1), "a 50-VHP and a 1-VHP player with the same result: same strokes");
  // the 49 VHP moved to a wallet that doesn't play: no change either
  assert.equal(at(1), at(1));
  // with one unit per wallet, the VHP place is the plain place (practice and staked agree)
  const plain = G.scoreHole(field(Array.from({ length: 20 }, (_, i) => 20 - i)));
  const units = G.scoreHole(Array.from({ length: 20 }, (_, i) => ({ a: addr(i + 1), score: 20 - i, scored: true, ranked: 1 })), 5, false, 10);
  for (let i = 1; i <= 20; i++) assert.equal(units.results[addr(i)].strokes, plain.results[addr(i)].strokes);
  // a big staker ahead weighs its VHP: 90 VHP at the top puts the next player at 91 of 101 units
  const h = G.scoreHole([{ a: addr(1), score: 9, scored: true, ranked: 90 }, ...Array.from({ length: 10 }, (_, i) => ({ a: addr(i + 2), score: 8 - i * 0.1, scored: true, ranked: 1 }))], 5, false, 10);
  assert.equal(h.weight, 100);
  assert.equal(h.results[addr(1)].strokes, 1);
  assert.equal(h.results[addr(2)].strokes, 6);
  assert.deepEqual([h.results[addr(2)].place, h.results[addr(2)].of], [2, 11], "the page still shows wallets");
  assert.equal(G.MIN_FIELD_VHP, 10);
  assert.equal(G.scoreHole(others.slice(0, 9), 5, false, 10).skipped, true, "9 VHP");
});

test("staked weeks need 5 stakers AND 10 VHP: one big wallet alone can't make a hole (fix-check N1)", () => {
  assert.equal(G.scoreHole([{ a: addr(1), score: 5, scored: true, ranked: 10 }], 5, false, 10).skipped, true);
  assert.equal(G.scoreHole([{ a: addr(1), score: 5, scored: true, ranked: 9 }, { a: addr(2), score: 4, scored: true, ranked: 1 }], 5, false, 10).skipped, true);
  assert.equal(G.scoreHole(Array.from({ length: 5 }, (_, i) => ({ a: addr(i + 1), score: 5 - i, scored: true, ranked: 2 })), 5, false, 10).skipped, false);
  assert.equal(G.scoreHole(Array.from({ length: 5 }, (_, i) => ({ a: addr(i + 1), score: 5 - i, scored: true, ranked: 1 })), 5, false, 10).skipped, true, "5 VHP");
});

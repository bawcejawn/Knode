// Last Node Standing shared math (lastnode-math.js): rounds and locks, the field and its calibrated handicap,
// the hourly cuts and their tie rule, a player's start pick, jump and backup, points, and the leaderboard.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

const APP = process.env.APP || ".";
await import(path.resolve(APP, "lastnode-math.js"));
const L = globalThis.KLastNode;

const A = (c) => "1" + c.repeat(33);
const [N1, N2, N3, N4] = ["A", "B", "C", "D"].map(A);
// A small field with exact handicaps (bypasses calibration so the cuts are easy to follow).
const FIELD = { at: 0, c: 0, fairness: null, nodes: [
  { a: N1, vhp: 400, kh: 200, h: 1 }, { a: N2, vhp: 200, kh: 100, h: 2 }, { a: N3, vhp: 100, kh: 50, h: 4 }, { a: N4, vhp: 100, kh: 50, h: 4 }] };
const hour = (o) => ({ blocks: o });

test("rounds lock at 10 past the hour (target hh:15, lead 5 min), open 24 hours ahead (the contract's rule)", () => {
  const ev = L.eventOf("2026-11-02");
  assert.equal(new Date(ev.start).toISOString(), "2026-11-02T14:00:00.000Z");
  assert.equal(ev.round, ev.start / L.HOUR - 1, "the start round is the one targeting 13:15");
  const at = (t) => new Date(t).toISOString().slice(11, 16);
  assert.equal(at(L.lockTime(ev.round)), "13:10", "the start pick locks 50 minutes before the start");
  assert.equal(ev.lock, L.lockTime(ev.round));
  assert.ok(L.isOpen(ev.round, ev.lock - 1));
  assert.ok(!L.isOpen(ev.round, ev.lock), "locked exactly at the lock");
  assert.equal(L.roundTime(ev.round) - L.LEAD, ev.lock, "the contract's rule: target − lead");
  assert.equal(ev.opens, L.roundTime(ev.round) - L.DAY);
  assert.ok(!L.isOpen(ev.round, ev.opens - 1), "not open more than 24 h ahead"); assert.ok(L.isOpen(ev.round, ev.opens));
  // The jump after the cut at hour k locks at start + k h + 10 min: after the cut, 50 minutes before the next one.
  for (let k = 1; k <= 22; k++) {
    const r = L.roundForJump(ev.start, k);
    assert.equal(L.lockTime(r), ev.start + k * L.HOUR + 10 * 60000);
    assert.equal(r - ev.round, k + 1, "the offset playerResult reads");
  }
  assert.equal(L.eventOf(ev.start + 3 * L.HOUR).start, ev.start, "a time that day gives that day's event");
  assert.equal(new Date(ev.cardTime).toISOString(), "2026-11-01T12:00:00.000Z", "field from the 12:00 card the day before");
  assert.equal(L.eventOf("not a day"), null);
});

test("the field: card nodes at 20+ blocks an hour, biggest first, deterministic c, close to fair", () => {
  const card = { at: 1, field: [
    { a: N1, vhp: 1000, k: 1200 }, { a: N2, vhp: 700, k: 840 }, { a: N3, vhp: 300, k: 360 }, { a: N4, vhp: 100, k: 119 }] }; // N4: 19.8/h
  const f = L.makeField(card, 3000), g = L.makeField(card, 3000);
  assert.deepEqual(f, g, "same card, same field and c");
  assert.deepEqual(f.nodes.map((x) => x.a), [N1, N2, N3], "19.8 blocks an hour is outside the field");
  assert.equal(f.nodes[0].h, 1, "the biggest node moves 1 step a block");
  assert.ok(f.fairness[0] > 0.25 && f.fairness[1] < 0.42, `fair within reason: ${f.fairness}`);
  assert.equal(L.makeField({ field: [{ a: N1, vhp: 1, k: 600 }] }), null, "one node is no event");
  assert.equal(L.makeField(null), null);
});

test("cuts: fewest handicapped steps since the start, ties by raw blocks, then VHP, then address", () => {
  // Hour 1: N1 200 (200 steps), N2 100 (200), N3 49 (196), N4 50 (200) → N3 out.
  // Hour 2: N1 +190 = 390, N2 +100 = 400, N4 +48 = 392 → N1 out.
  // Hour 3: N2 +90 = 490, N4 +104 = 496 → N2 out; N4 wins.
  const hours = [hour({ [N1]: 200, [N2]: 100, [N3]: 49, [N4]: 50 }), hour({ [N1]: 190, [N2]: 100, [N4]: 48 }), hour({ [N2]: 45, [N4]: 26 })];
  const r = L.cutsFrom(FIELD, hours);
  assert.deepEqual(r.cuts.map((c) => [c.at, c.a]), [[1, N3], [2, N1], [3, N2]]);
  assert.equal(r.done, true); assert.equal(r.winner, N4);
  // Exact tie on steps: fewer raw blocks goes. N1 100 blocks = 100 steps vs N2 50 = 100 steps → N2 (fewer blocks) out.
  const t1 = L.cutsFrom({ nodes: FIELD.nodes.slice(0, 2) }, [hour({ [N1]: 100, [N2]: 50 })]);
  assert.equal(t1.cuts[0].a, N2);
  // Same steps and blocks: smaller VHP goes; same VHP: the address that sorts later goes.
  const t2 = L.cutsFrom({ nodes: FIELD.nodes.slice(2) }, [hour({ [N3]: 10, [N4]: 10 })]);
  assert.equal(t2.cuts[0].a, N4, "N3 and N4 have equal VHP; N4 sorts later");
  // Blocks from outside the field and from cut nodes don't count; partial events aren't done.
  const p = L.cutsFrom(FIELD, [hour({ [N1]: 200, [N2]: 100, [N3]: 1, [N4]: 50, [A("Z")]: 999 })]);
  assert.equal(p.done, false); assert.equal(p.winner, null); assert.deepEqual(p.standing, [N1, N2, N4]);
  // No extra cuts are made from hours given after the event ended.
  assert.equal(L.cutsFrom(FIELD, [...hours, hour({}), hour({})]).cuts.length, 3);
});

const HOURS = [hour({ [N1]: 200, [N2]: 100, [N3]: 49, [N4]: 50 }), hour({ [N1]: 190, [N2]: 100, [N4]: 48 }), hour({ [N2]: 45, [N4]: 26 })];
const RES = L.cutsFrom(FIELD, HOURS); // N3 out at 1, N1 at 2, N2 at 3; N4 wins

test("a player who rides the winner from the start scores every cut + 5", () => {
  const r = L.playerResult(FIELD, RES, { 0: N4 });
  assert.equal(r.survived, 3); assert.equal(r.rode, true); assert.equal(r.points, 3 + 5); assert.equal(r.jumped, false);
});

test("no start pick, or a start pick outside the field, is no entry; later picks alone don't enter", () => {
  assert.equal(L.playerResult(FIELD, RES, {}).entered, false);
  assert.equal(L.playerResult(FIELD, RES, { 0: A("Z") }).entered, false);
  assert.equal(L.playerResult(FIELD, RES, { 2: N4 }).entered, false);
});

test("the jump: after the cut at hour k, the pick at offset k + 1 if its node still stands; +3 for riding it home", () => {
  // N3 cut at hour 1; jump picked for the round at offset 2 → N4; survives cuts 2 and 3 and rides home.
  const r = L.playerResult(FIELD, RES, { 0: N3, 2: N4 });
  assert.equal(r.jumped, true); assert.equal(r.jumpTo, N4); assert.equal(r.survived, 2); assert.equal(r.points, 2 + 3);
  assert.deepEqual(r.path, [{ at: 0, a: N3 }, { at: 1, a: N4 }]);
  // A backup set before the cut is the same pick (the contract keeps one pick per round): it counts the same way.
  // The pick at offset 1 (the round during hour 0) is not the jump round for the cut at hour 1.
  const wrong = L.playerResult(FIELD, RES, { 0: N3, 1: N4 });
  assert.equal(wrong.jumped, false); assert.equal(wrong.out, 1); assert.equal(wrong.points, 0);
});

test("a jump to a node already cut, a second cut, a second jump, or a cut at the last cut: out, points kept", () => {
  // N1 cut at hour 2; jump to N3 (cut at hour 1) is not valid → out at cut 2 with 1 point.
  const a = L.playerResult(FIELD, RES, { 0: N1, 3: N3 });
  assert.equal(a.out, 2); assert.equal(a.points, 1);
  // Jump from N3 to N1, then N1 is cut at hour 2: a second jump is not allowed → out at cut 2.
  const b = L.playerResult(FIELD, RES, { 0: N3, 2: N1, 3: N4 });
  assert.equal(b.jumped, true); assert.equal(b.out, 2); assert.equal(b.points, 0); assert.equal(b.rode, false);
  // N2 is cut at the last cut (2 left → 1): nothing to jump to.
  const c = L.playerResult(FIELD, RES, { 0: N2, 4: N4 });
  assert.equal(c.out, 3); assert.equal(c.points, 2); assert.equal(c.rode, false);
  // A jump to the node cut in the same hour (it's gone) is not valid.
  const d = L.playerResult(FIELD, RES, { 0: N3, 2: N3 });
  assert.equal(d.out, 1);
});

test("an event still running: cuts so far count, no bonus yet", () => {
  const part = L.cutsFrom(FIELD, HOURS.slice(0, 1));
  const r = L.playerResult(FIELD, part, { 0: N4 });
  assert.equal(r.points, 1); assert.equal(r.rode, false); assert.equal(r.out, 0);
});

test("picks by round become offsets from the event's start round; other rounds are dropped", () => {
  const ev = L.eventOf("2026-11-02");
  const o = L.byOffset(ev.start, { [ev.round]: N1, [ev.round + 2]: N2, [ev.round - 1]: N3, [ev.round + 1000]: N4 });
  assert.deepEqual(o, { 0: N1, 2: N2 });
  assert.equal(L.roundForJump(ev.start, 1), ev.round + 2);
});

test("leaderboard: points, then rides, then fewer jumps; equal players share the place", () => {
  const P = ["1P", "1Q", "1R", "1S"].map((x) => x + "x".repeat(32));
  const rows = [
    { player: P[0], points: 8, rode: true, jumped: false }, { player: P[1], points: 5, rode: true, jumped: true },
    { player: P[2], points: 8, rode: true, jumped: false }, { player: P[3], points: 5, rode: false, jumped: false },
    { player: P[3], points: 0, rode: false, jumped: false },
  ];
  const b = L.places(L.board(rows));
  assert.deepEqual(b.map((x) => [x.player, x.place]), [[P[0], 1], [P[2], 1], [P[1], 3], [P[3], 4]]);
  assert.equal(b.find((x) => x.player === P[3]).events, 2);
});

test("review M-1: a player whose node was just cut can still jump (the page's Jump box), not once the event moves on", () => {
  const part1 = L.cutsFrom(FIELD, HOURS.slice(0, 1));            // N3 cut at hour 1
  assert.equal(L.canJump(FIELD, part1, { 0: N3 }), 1, "cut at hour 1, jump round at offset 2 still to come");
  assert.equal(L.canJump(FIELD, part1, { 0: N3, 2: N4 }), 0, "already jumped (a valid backup)");
  assert.equal(L.canJump(FIELD, part1, { 0: N4 }), 0, "still standing");
  const part2 = L.cutsFrom(FIELD, HOURS.slice(0, 2));            // N1 cut at hour 2
  assert.equal(L.canJump(FIELD, part2, { 0: N3 }), 0, "out at an earlier cut: too late");
  assert.equal(L.canJump(FIELD, RES, { 0: N2 }), 0, "cut at the last cut: nothing to jump to");
});

test("review: the field is at most 23 nodes, so an event's rounds never reach the next day's start round", () => {
  const field = Array.from({ length: 30 }, (_, i) => ({ a: "1" + String.fromCharCode(65 + (i % 26)).repeat(32) + (i < 26 ? "A" : "B"), vhp: 1000 - i, k: 300 }));
  const f = L.makeField({ field }, 200);
  assert.equal(f.nodes.length, L.MAX_FIELD); assert.equal(L.MAX_FIELD, 23);
  // 22 cuts → the last jump round is at offset 22, the next start round is at offset 24.
  assert.ok(L.MAX_FIELD - 1 < 24);
});

test("fix-check Info 1: the registration values match the rules the page and recorder use", () => {
  const g = L.PICKS_GAME;
  assert.equal(g.game, L.GAME_ID); assert.equal(g.kind, 1, "one producer"); assert.equal(g.lock_mode, 2, "time lock");
  assert.equal(g.round_size, L.HOUR); assert.equal(g.round_offset, L.OFFSET); assert.equal(g.lead, L.LEAD); assert.equal(g.ahead, L.AHEAD);
  // The contract's own formula gives the same locks as the rules, for any round.
  for (const r of [0, 1, 497774, 498229, 600000]) assert.equal(r * g.round_size + g.round_offset - g.lead, L.lockTime(r));
  assert.ok(g.round_offset < g.round_size && g.lead >= 300000 && g.ahead > g.lead, "accepted by the contract's checks");
});

test("the fast test game (93): a cut every 20 minutes, events every 4 hours, rounds lock 5 minutes after each cut", () => {
  const F = L.forGame(L.FAST_GAME);
  const at = (t) => new Date(t).toISOString().slice(11, 16);
  const ev = F.eventOf("2026-10-29T04");
  assert.equal(new Date(ev.start).toISOString(), "2026-10-29T04:00:00.000Z");
  assert.equal(at(ev.lock), "03:45", "the start pick locks 15 minutes before the start");
  assert.equal(F.eventOf(ev.start + 3 * L.HOUR + 59 * 60000).day, "2026-10-29T04", "a time in the period gives its event");
  assert.equal(F.eventOf("2026-10-29T05"), null, "events start every 4 hours");
  assert.equal(F.nextEvent(ev).day, "2026-10-29T08");
  for (let k = 1; k < F.MAX_FIELD - 1; k++) assert.equal(F.lockTime(F.roundForJump(ev.start, k)), ev.start + k * 20 * 60000 + 5 * 60000, `jump after cut ${k}`);
  assert.equal(F.MAX_FIELD, 11, "a field small enough that the last jump round comes before the next start round");
  assert.ok(F.roundForJump(ev.start, F.MAX_FIELD - 1) < F.nextEvent(ev).round);
  assert.equal(F.PICKS_GAME.round_size, 1200000); assert.equal(F.PICKS_GAME.round_offset, 600000); assert.equal(F.PICKS_GAME.lead, 300000);
  // The contract's own formula agrees.
  for (const r of [0, 1, 1497200, 1497300]) assert.equal(r * F.PICKS_GAME.round_size + F.PICKS_GAME.round_offset - F.PICKS_GAME.lead, F.lockTime(r));
  // Handicaps use blocks per 20-minute window; the field is the same nodes, at most 11.
  const card = { at: 1, field: Array.from({ length: 14 }, (_, i) => ({ a: "1" + String.fromCharCode(65 + i).repeat(33), vhp: 1400 - i * 90, k: 1200 - i * 70 })) };
  const f = F.makeField(card, 2000);
  assert.equal(f.nodes.length, 11); assert.equal(f.nodes[0].h, 1);
  assert.ok(f.fairness[0] > 0.06 && f.fairness[1] < 0.12, `close to fair: ${f.fairness}`);
  // The real game is unchanged.
  assert.equal(L.forGame(L.MAINNET_GAME).eventOf("2026-11-02").lock, L.eventOf("2026-11-02").lock);
  assert.throws(() => L.forGame({ ...L.FAST_GAME, lead: 60000 }), /5 minutes/);
  assert.throws(() => L.forGame({ ...L.FAST_GAME, offset: 1300000 }), /lock after the cut/);
});

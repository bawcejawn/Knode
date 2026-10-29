// Last Node Standing shared math (lastnode-math.js): rounds and locks, the field and its calibrated handicap,
// the hourly cuts and their tie rule, a player's one pick (start node and optional backup), points, and the leaderboard.
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

test("one round per event: picks lock at 13:50 UTC, 10 minutes before the start, and open 24 hours ahead (the contract's rule)", () => {
  const ev = L.eventOf("2026-11-02");
  assert.equal(new Date(ev.start).toISOString(), "2026-11-02T14:00:00.000Z");
  const at = (t) => new Date(t).toISOString().slice(11, 16);
  assert.equal(at(L.roundTime(ev.round)), "13:55", "the round's target");
  assert.equal(at(L.lockTime(ev.round)), "13:50", "picks lock 10 minutes before the start");
  assert.equal(ev.lock, L.lockTime(ev.round)); assert.equal(ev.start - ev.lock, 10 * 60000);
  assert.ok(L.isOpen(ev.round, ev.lock - 1));
  assert.ok(!L.isOpen(ev.round, ev.lock), "locked exactly at the lock");
  assert.equal(L.roundTime(ev.round) - L.LEAD, ev.lock, "the contract's rule: target − lead");
  assert.equal(ev.opens, L.roundTime(ev.round) - L.DAY);
  assert.equal(new Date(ev.opens).toISOString(), "2026-11-01T13:55:00.000Z", "24 hours before the target");
  assert.ok(!L.isOpen(ev.round, ev.opens - 1), "not open more than 24 h ahead"); assert.ok(L.isOpen(ev.round, ev.opens));
  assert.equal(L.nextEvent(ev).round, ev.round + 1, "one round a day");
  assert.ok(!L.isOpen(L.nextEvent(ev).round, ev.lock - 60000), "tomorrow's round opens just after today's locks");
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

test("a player who rides the winner from the start scores every cut + 5 (a backup never used costs nothing)", () => {
  const r = L.playerResult(FIELD, RES, { start: N4 });
  assert.equal(r.survived, 3); assert.equal(r.rode, true); assert.equal(r.points, 3 + 5); assert.equal(r.jumped, false);
  const b = L.playerResult(FIELD, RES, { start: N4, backup: N2 });
  assert.equal(b.points, 3 + 5); assert.equal(b.jumped, false); assert.equal(b.backup, N2);
});

test("no start pick, or a start pick outside the field, is no entry; a backup outside the field is ignored", () => {
  assert.equal(L.playerResult(FIELD, RES, null).entered, false);
  assert.equal(L.playerResult(FIELD, RES, { start: A("Z") }).entered, false);
  assert.equal(L.playerResult(FIELD, RES, { start: null, backup: N4 }).entered, false);
  const r = L.playerResult(FIELD, RES, { start: N3, backup: A("Z") });
  assert.equal(r.backup, null); assert.equal(r.out, 1); assert.equal(r.points, 0);
});

test("the backup takes over the first time the start node is cut, if still standing; +3 for riding it home", () => {
  // N3 cut at cut 1 → backup N4 takes over, survives cuts 2 and 3 and rides home.
  const r = L.playerResult(FIELD, RES, { start: N3, backup: N4 });
  assert.equal(r.jumped, true); assert.equal(r.jumpTo, N4); assert.equal(r.survived, 2); assert.equal(r.points, 2 + 3);
  assert.deepEqual(r.path, [{ at: 0, a: N3 }, { at: 1, a: N4 }]);
  // N1 cut at cut 2 → backup N2 takes over, then N2 is cut at cut 3 (the last): out, points kept.
  const s2 = L.playerResult(FIELD, RES, { start: N1, backup: N2 });
  assert.equal(s2.jumped, true); assert.equal(s2.out, 3); assert.equal(s2.points, 1 + 0); assert.equal(s2.rode, false);
  // The start node cut at the last cut: the backup is the winner, so it takes over and rides home (+3).
  const last = L.playerResult(FIELD, RES, { start: N2, backup: N4 });
  assert.equal(last.jumped, true); assert.equal(last.rode, true); assert.equal(last.points, 2 + 3);
});

test("no backup, or a backup already cut: out when the start node is cut; one jump only", () => {
  const a = L.playerResult(FIELD, RES, { start: N1 });
  assert.equal(a.out, 2); assert.equal(a.points, 1);
  // N1 cut at cut 2; backup N3 was cut at cut 1 → no jump, out at cut 2.
  const b = L.playerResult(FIELD, RES, { start: N1, backup: N3 });
  assert.equal(b.jumped, false); assert.equal(b.out, 2); assert.equal(b.points, 1);
  // N3 → backup N1, then N1 is cut at cut 2: a second jump doesn't exist → out at cut 2.
  const c = L.playerResult(FIELD, RES, { start: N3, backup: N1 });
  assert.equal(c.jumped, true); assert.equal(c.out, 2); assert.equal(c.points, 0);
  // The same node as start and backup is just a start.
  const d = L.playerResult(FIELD, RES, { start: N3, backup: N3 });
  assert.equal(d.backup, null); assert.equal(d.out, 1);
});

test("an event still running: cuts so far count, no bonus yet", () => {
  const part = L.cutsFrom(FIELD, HOURS.slice(0, 1));
  const r = L.playerResult(FIELD, part, { start: N4 });
  assert.equal(r.points, 1); assert.equal(r.rode, false); assert.equal(r.out, 0);
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

test("review: the field is at most 23 nodes, so an event ends before the next day's picks lock", () => {
  const field = Array.from({ length: 30 }, (_, i) => ({ a: "1" + String.fromCharCode(65 + (i % 26)).repeat(32) + (i < 26 ? "A" : "B"), vhp: 1000 - i, k: 300 }));
  const f = L.makeField({ field }, 200);
  assert.equal(f.nodes.length, L.MAX_FIELD); assert.equal(L.MAX_FIELD, 23);
  const ev = L.eventOf("2026-11-02");
  assert.ok(ev.start + (L.MAX_FIELD - 1) * L.HOUR < L.nextEvent(ev).lock, "22 cuts end at 12:00 the next day, before 13:50");
});

test("fix-check Info 1: the registration values match the rules the page and recorder use", () => {
  const g = L.PICKS_GAME;
  assert.equal(g.game, L.GAME_ID); assert.equal(g.kind, 2, "a list"); assert.equal(g.list_size, 2, "start and backup"); assert.equal(g.lock_mode, 2, "time lock");
  assert.equal(g.round_size, L.DAY, "one round a day"); assert.equal(g.round_offset, 50100000, "13:55 UTC"); assert.equal(g.round_offset, L.OFFSET); assert.equal(g.lead, L.LEAD); assert.equal(g.ahead, L.AHEAD);
  // The contract's own formula gives the same locks as the rules, for any round.
  for (const r of [0, 1, 497774, 498229, 600000]) assert.equal(r * g.round_size + g.round_offset - g.lead, L.lockTime(r));
  assert.ok(g.round_offset < g.round_size && g.lead >= 300000 && g.ahead > g.lead, "accepted by the contract's checks");
});

test("the fast test game (94): a cut every 20 minutes, events every 4 hours, picks lock 10 minutes before each start", () => {
  const F = L.forGame(L.FAST_GAME);
  const at = (t) => new Date(t).toISOString().slice(11, 16);
  const ev = F.eventOf("2026-10-29T04");
  assert.equal(new Date(ev.start).toISOString(), "2026-10-29T04:00:00.000Z");
  assert.equal(at(ev.lock), "03:50", "picks lock 10 minutes before the start");
  assert.equal(at(ev.opens), "23:55", "and open 4 hours before the round's target");
  assert.equal(F.eventOf(ev.start + 3 * L.HOUR + 59 * 60000).day, "2026-10-29T04", "a time in the period gives its event");
  assert.equal(F.eventOf("2026-10-29T05"), null, "events start every 4 hours");
  assert.equal(F.nextEvent(ev).day, "2026-10-29T08"); assert.equal(F.nextEvent(ev).round, ev.round + 1);
  assert.equal(F.MAX_FIELD, 11);
  assert.ok(ev.start + (F.MAX_FIELD - 1) * F.CUT < F.nextEvent(ev).lock, "an event ends before the next one's picks lock");
  assert.equal(F.PICKS_GAME.round_size, 14400000); assert.equal(F.PICKS_GAME.round_offset, 14100000); assert.equal(F.PICKS_GAME.lead, 300000);
  assert.equal(F.PICKS_GAME.kind, 2); assert.equal(F.PICKS_GAME.list_size, 2);
  // The contract's own formula agrees.
  for (const r of [0, 1, 124700, 124701]) assert.equal(r * F.PICKS_GAME.round_size + F.PICKS_GAME.round_offset - F.PICKS_GAME.lead, F.lockTime(r));
  // Handicaps use blocks per 20-minute window; the field is the same nodes, at most 11.
  const card = { at: 1, field: Array.from({ length: 14 }, (_, i) => ({ a: "1" + String.fromCharCode(65 + i).repeat(33), vhp: 1400 - i * 90, k: 1200 - i * 70 })) };
  const f = F.makeField(card, 2000);
  assert.equal(f.nodes.length, 11); assert.equal(f.nodes[0].h, 1);
  assert.ok(f.fairness[0] > 0.06 && f.fairness[1] < 0.12, `close to fair: ${f.fairness}`);
  // The real timing on the testnet (33) is the real game's under another id.
  const T = L.forGame(L.REAL_TEST_GAME);
  assert.equal(T.GAME_ID, 33); assert.equal(T.eventOf("2026-11-02").lock, L.eventOf("2026-11-02").lock); assert.equal(T.PICKS_GAME.round_offset, L.PICKS_GAME.round_offset);
  assert.throws(() => L.forGame({ ...L.FAST_GAME, lead: 60000 }), /5 minutes/);
  assert.throws(() => L.forGame({ ...L.FAST_GAME, lockBefore: 4 * 60000 }), /lockBefore >= lead/);
  assert.throws(() => L.forGame({ ...L.FAST_GAME, ahead: 5 * L.HOUR }), /one event ahead/);
  assert.throws(() => L.forGame({ ...L.FAST_GAME, lockBefore: 45 * 60000 }), /two cuts/);
});

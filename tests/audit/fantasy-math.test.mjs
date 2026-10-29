// Fantasy Producers shared math (site/fantasy-math.js): the day index, price sheet, team rules (pool, budget, one
// change a day, captain), scoring with the daily cap, vault points, and Weekly Rival matches and records.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

const APP = process.env.APP || ".";
await import(path.resolve(APP, "site/race-math.js"));
await import(path.resolve(APP, "site/fantasy-math.js"));
const R = globalThis.KRaceMath, F = globalThis.KFantasyMath;

const A = "1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", B = "1BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", C = "1CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
  D = "1DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD", E = "1EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE", G = "1GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG",
  X = "1XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX", Y = "1YYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY";
const W = 2, DAYS = F.weekDays(W);

test("time: a week has 7 UTC days from Monday; the sheet is Saturday 00:00 before it (2 days ahead); form = the 7 days before", () => {
  assert.equal(new Date(F.dayStart(DAYS[0])).toISOString(), "2026-11-02T00:00:00.000Z");
  assert.equal(new Date(F.dayStart(DAYS[6])).toISOString(), "2026-11-08T00:00:00.000Z");
  assert.equal(new Date(F.sheetTime(W)).toISOString(), "2026-10-31T00:00:00.000Z");
  const fd = F.formDays(W);
  assert.equal(fd.length, 7);
  assert.equal(new Date(F.dayStart(fd[0])).toISOString(), "2026-10-24T00:00:00.000Z");
  assert.equal(new Date(F.dayStart(fd[6])).toISOString(), "2026-10-30T00:00:00.000Z", "Friday: the last full day before the sheet");
});

// One card for every hour: A 50%, B 30%, C 20% of VHP (C in the paddock still counts for shares).
const card = { field: [{ a: A, vhp: 500 }, { a: B, vhp: 300 }], paddock: [{ a: C, vhp: 200 }] };
const races = {};
for (let t = F.dayStart(DAYS[0]) - R.DAY; t < F.dayStart(DAYS[6]) + 2 * R.DAY; t += R.RACE) races[R.raceAt(t).id] = [card, null, null, null, null, null];

test("day index: signed ÷ expected from each hour's blocks and the card's VHP shares, field and paddock", () => {
  // 100 blocks an hour for the day: A signs 60 (expected 50), B 30 (30), C 10 (20).
  const ts = [], sig = [], t0 = F.dayStart(DAYS[0]);
  for (let h = 0; h < 24; h++) for (let i = 0; i < 100; i++) { ts.push(t0 + h * R.HOUR + i * 36000); sig.push(i < 60 ? 0 : i < 90 ? 1 : 2); }
  const d = F.dayIndex({ ts, sig, signers: [A, B, C] }, races, DAYS[0]);
  assert.equal(d.blocks, 2400);
  assert.deepEqual(d.producers[A], [1440, 1200, 120]);
  assert.deepEqual(d.producers[B], [720, 720, 100]);
  assert.deepEqual(d.producers[C], [240, 480, 50]);
});

test("day index: blocks outside the day are not counted; a producer never expected has index null", () => {
  const t0 = F.dayStart(DAYS[0]);
  const ts = [t0 - 1000, t0, t0 + R.DAY - 1, t0 + R.DAY], sig = [0, 0, 1, 3];
  const d = F.dayIndex({ ts, sig, signers: [A, B, C, X] }, races, DAYS[0]);
  assert.equal(d.blocks, 2);
  assert.equal(d.producers[X], undefined, "X's block is the next day");
  const d2 = F.dayIndex({ ts: [t0 + 5], sig: [0], signers: [X] }, races, DAYS[0]);
  assert.deepEqual(d2.producers[X], [1, 0, null]);
});

test("cards: a missed race uses the latest card up to 24 h before; none at all = no expected blocks", () => {
  const t = F.dayStart(DAYS[2]), only = { [R.raceAt(t - R.RACE).id]: [null, null, card, null, null, null] };
  assert.equal(F.cardAt(only, t + 3 * R.HOUR), card, "the earlier race's last card carries on");
  assert.equal(F.cardAt({}, t), null);
});

test("price: 20 + 1.5 × (form − median form), rounded, clamped 8..40; no form = 20", () => {
  assert.equal(F.priceOf(100, 100), 20, "the median producer costs 20");
  assert.equal(F.priceOf(110, 100), 35);
  assert.equal(F.priceOf(95, 100), 13, "12.5 rounds up");
  assert.equal(F.priceOf(70, 100), 8, "floor");
  assert.equal(F.priceOf(130, 100), 40, "ceiling");
  assert.equal(F.priceOf(null, 100), 20);
  assert.equal(F.priceOf(NaN, 100), 20);
  assert.equal(F.medianOf([3, null, 1, 2]), 2);
  assert.equal(F.medianOf([4, 1, 3, 2]), 2, "even count: the lower middle");
  assert.equal(F.medianOf([null]), null);
});

test("sheet: pool = the card's field only (paddock can't be drafted), form over the form days, priced on the median", () => {
  const formWindow = [{ producers: { [A]: [110, 100, 110], [B]: [90, 100, 90] } }, { producers: { [A]: [100, 100, 100] } }];
  const s = F.makeSheet(W, card, formWindow);
  assert.deepEqual(s.pool.map((p) => p.a), [A, B]);
  assert.equal(s.median, 90);
  assert.deepEqual(s.pool[0], { a: A, form: 105, price: 40 });
  assert.deepEqual(s.pool[1], { a: B, form: 90, price: 20 });
  assert.equal(s.budget, 100);
  assert.equal(F.sheetText(s), JSON.stringify({ week: W, at: F.sheetTime(W), budget: 100, median: 90, pool: [[A, 105, 40], [B, 90, 20]] }));
});

test("sheet: a team always fits the budget; with 9+ producers the budget stays 100, whatever the forms", () => {
  const R0 = R.rng(5);
  for (let trial = 0; trial < 200; trial++) {
    const n = 5 + Math.floor(R0.next() * 15), field = [], prod = {};
    for (let i = 0; i < n; i++) { const a = "1" + String(i).padStart(2, "0").replace(/0/g, "z") + "Q".repeat(31); field.push({ a, vhp: 1 }); prod[a] = [Math.round(60 + R0.next() * 60), 100, 0]; }
    const s = F.makeSheet(W, { field }, [{ producers: prod }]);
    const cheapest = s.pool.map((p) => p.price).sort((x, y) => x - y).slice(0, 5).reduce((a, b) => a + b, 0);
    assert.ok(cheapest <= s.budget, `trial ${trial}: 5 cheapest cost ${cheapest}, budget ${s.budget}`);
    if (n >= 9) assert.equal(s.budget, 100, `trial ${trial}: ${n} producers`);
  }
  const small = F.makeSheet(W, { field: [A, B, C, D, E].map((a) => ({ a, vhp: 1 })) }, [{ producers: { [A]: [130, 100, 0], [B]: [125, 100, 0], [C]: [120, 100, 0], [D]: [118, 100, 0], [E]: [115, 100, 0] } }]);
  assert.deepEqual(small.pool.map((p) => p.price), [35, 28, 20, 17, 13]);
  assert.equal(small.budget, 113, "5 in the pool costing 113: the budget is raised to 113");
});

const sheet = { week: W, at: 0, budget: 100, pool: [A, B, C, D, E, G, X].map((a, i) => ({ a, form: 95, price: [30, 25, 20, 15, 10, 10, 40][i] })) };

test("team: exactly 5 different producers from the pool, within the budget", () => {
  assert.equal(F.checkTeam(sheet, [A, B, C, D, E]).ok, true, "30+25+20+15+10 = 100 is allowed");
  assert.match(F.checkTeam(sheet, [A, B, C, D, X]).why, /over the budget/);
  assert.match(F.checkTeam(sheet, [A, B, C, D]).why, /5 producers/);
  assert.match(F.checkTeam(sheet, [A, A, C, D, E]).why, /twice/);
  assert.match(F.checkTeam(sheet, [A, B, C, D, Y]).why, /not in this week's pool/);
  assert.equal(F.checkTeam(sheet, null).ok, false);
});

test("one change a day: a swap, or moving the captain; a new producer taking the swapped captain's place is one change", () => {
  const t = [A, B, C, D, E];
  assert.equal(F.changes(t, [A, B, C, D, G]), 1, "swap E for G");
  assert.equal(F.changes(t, [B, A, C, D, E]), 1, "captain moves A → B");
  assert.equal(F.changes(t, [G, B, C, D, E]), 1, "captain A swapped out, G in as captain");
  assert.equal(F.changes(t, [B, A, C, D, G]), 2, "a swap and a captain move");
  assert.equal(F.changes(t, [A, C, B, E, D]), 0, "order of the 4 others doesn't matter");
  assert.equal(F.changes(t, [A, B, G, X, E]), 2);
});

test("week teams: first valid team starts; invalid or 2-change picks are ignored and yesterday's team stays", () => {
  const picks = {
    [DAYS[1]]: [A, B, C, D, E],                 // starts Tuesday (Monday empty)
    [DAYS[2]]: [A, B, C, D, X],                 // over budget → ignored
    [DAYS[3]]: [B, A, C, D, G],                 // two changes → ignored
    [DAYS[4]]: [B, A, C, D, E],                 // captain move → ok
    // Saturday no pick → Friday's team
    [DAYS[6]]: [B, A, C, D, G],                 // swap E → G → ok
  };
  const t = F.teamsForWeek(sheet, DAYS, picks);
  assert.equal(t[0].team, null);
  assert.deepEqual(t[1].team, [A, B, C, D, E]);
  assert.deepEqual(t[2].team, [A, B, C, D, E]); assert.match(t[2].note, /over the budget/);
  assert.deepEqual(t[3].team, [A, B, C, D, E]); assert.match(t[3].note, /more than one change/);
  assert.deepEqual(t[4].team, [B, A, C, D, E]);
  assert.deepEqual(t[5].team, [B, A, C, D, E]);
  assert.deepEqual(t[6].team, [B, A, C, D, G]);
});

test("week teams: Monday starts fresh (any valid team); last week's team plays Monday only if it fits the new list", () => {
  const t = F.teamsForWeek(sheet, DAYS, { [DAYS[0]]: [X, A, B, C, D] }, [A, B, C, D, E]);
  assert.ok(F.checkTeam(sheet, [X, A, B, C, D]).ok === false, "(X+A+B+C+D is over budget)");
  assert.deepEqual(t[0].team, [A, B, C, D, E], "an invalid Monday pick is ignored: the carried team plays");
  const fresh = [B, C, D, E, G];
  const t1 = F.teamsForWeek(sheet, DAYS, { [DAYS[0]]: fresh }, [A, X, C, D, E]);
  assert.deepEqual(t1[0].team, fresh, "Monday: a whole new team is fine");
  const t2 = F.teamsForWeek(sheet, DAYS, {}, [A, B, C, D, E]);
  assert.deepEqual(t2[6].team, [A, B, C, D, E], "no picks: the carried team plays all week");
  const t3 = F.teamsForWeek({ ...sheet, pool: sheet.pool.filter((p) => p.a !== E) }, DAYS, {}, [A, B, C, D, E]);
  assert.equal(t3[0].team, null, "a carried team that no longer fits this week's sheet doesn't carry");
  const t4 = F.teamsForWeek(sheet, DAYS, { [DAYS[1]]: [B, C, D, E, G] }, [A, B, C, D, E]);
  assert.match(t4[1].note, /more than one change/, "after Monday, one change a day again (A out, G in, captain to B = 2)");
});

test("day score: index capped at 130 per producer, captain double, unknown or null index scores 0", () => {
  const day = { producers: { [A]: [0, 0, 150], [B]: [0, 0, 100], [C]: [0, 0, 80.5], [D]: [0, 0, null] } };
  assert.equal(F.dayScore([A, B, C, D, E], day), 130 * 2 + 100 + 80.5);
  assert.equal(F.dayScore([B, A, C, D, E], day), 100 * 2 + 130 + 80.5);
  assert.equal(F.dayScore(null, day), 0);
});

test("score week: sum of days, full only with a team on all 7 days; vault points keep the order and the ties", () => {
  const recs = DAYS.map((d) => ({ day: d, producers: Object.fromEntries([A, B, C, D, E].map((a) => [a, [0, 0, 100]])) }));
  const full = F.scoreWeek(sheet, recs, { [DAYS[0]]: [A, B, C, D, E] });
  assert.equal(full.points, 7 * 600); assert.equal(full.full, true);
  const late = F.scoreWeek(sheet, recs, { [DAYS[3]]: [A, B, C, D, E] });
  assert.equal(late.points, 4 * 600); assert.equal(late.full, false, "late joiner: days before score 0, not full");
  const vp = F.vaultPoints([{ a: A, points: 4200.5 }, { a: B, points: 3000 }, { a: C, points: 4200.5 }, { a: D, points: 0 }, { a: E, points: 2999.99 }]);
  assert.deepEqual([...vp.entries()].sort(), [[A, 255], [B, 254], [C, 255], [E, 253]].sort(), "order and ties kept; 0 points posts nothing");
  const many = Array.from({ length: 300 }, (_, i) => ({ a: `1${String(i).padStart(33, "Q")}`, points: 1000 - i }));
  const vm = F.vaultPoints(many);
  assert.equal(vm.get(many[0].a), 255); assert.equal(vm.get(many[254].a), 1); assert.equal(vm.get(many[299].a), 1, "below the 255th score: 1");
});

test("rank: more points first; equal points share a place", () => {
  const r = F.rank([{ a: A, points: 5 }, { a: B, points: 9 }, { a: C, points: 5 }, { a: D, points: 1 }]);
  assert.deepEqual(r.map((x) => [x.a, x.place]), [[B, 1], [A, 2], [C, 2], [D, 4]]);
});

test("rival: counts only when both had a full week; self, bad address and repeats ignored; mutual = one match", () => {
  const players = { [A]: { points: 10, full: true }, [B]: { points: 8, full: true }, [C]: { points: 10, full: true }, [D]: { points: 99, full: false } };
  const ms = F.matches([[A, B], [B, A], [C, A], [A, D], [D, A], [A, A], ["bad", B], [E, A]], players);
  assert.deepEqual(ms, [
    { a: A, b: B, mutual: true, result: "a" },
    { a: C, b: A, mutual: false, result: "draw" },
  ]);
});

test("rival records: made and received kept apart; mutual counts as made for both; win share counts draws half", () => {
  const ms = [{ a: A, b: B, mutual: false, result: "a" }, { a: C, b: A, mutual: false, result: "b" }, { a: A, b: C, mutual: true, result: "draw" }];
  const r = F.addRecords({}, ms);
  assert.deepEqual(r[A], { made: [1, 0, 1], received: [1, 0, 0] });
  assert.deepEqual(r[B], { made: [0, 0, 0], received: [0, 1, 0] });
  assert.deepEqual(r[C], { made: [0, 1, 1], received: [0, 0, 0] });
  assert.deepEqual(F.recordLine(r[A]), { w: 2, l: 0, d: 1, n: 3, pct: 0.8333 });
  const again = F.addRecords(r, [{ a: B, b: A, mutual: false, result: "a" }]);
  assert.deepEqual(again[A].received, [1, 1, 0], "records add up week after week");
  assert.deepEqual(r[A].received, [1, 0, 0], "the old object is not changed");
});

test("clock: the real clock is the game week (Monday 00:00 UTC) and its Picks games fit the contract's rules", () => {
  assert.equal(F.weekOf(F.weekStart(W)), W);
  assert.equal(F.weekStart(W), R.weekStart(W));
  assert.equal(F.DAY_MS, R.DAY);
  const g = F.games();
  assert.equal(g.team.id, 4); assert.equal(g.rival.id, 5);
  for (const x of [g.team, g.rival]) {
    assert.ok(Number(x.round_offset) < Number(x.round_size), "round_offset < round_size");
    assert.ok(Number(x.lead) >= 300000 && Number(x.ahead) > Number(x.lead) && Number(x.ahead) <= 35 * R.DAY);
  }
  assert.equal(g.team.kind, 2); assert.equal(g.team.list_size, 5); assert.equal(g.rival.kind, 1);
  for (const x of [g.team, g.rival]) assert.ok(x.name && Buffer.byteLength(x.name) <= 40, "the contract needs a name of 1 to 40 bytes");
  // A team pick's round is its day: the contract's target r × day is the day's start, locking 5 minutes before.
  const d = DAYS[3];
  assert.equal(d * Number(g.team.round_size) + Number(g.team.round_offset), F.dayStart(d));
  assert.equal(F.lockOfDay(d), F.dayStart(d) - 300000);
  // A rival pick's round is its week: target = the week's Monday 00:00 UTC.
  const rr = F.rivalRound(W);
  assert.ok(Number.isInteger(rr));
  assert.equal(rr * Number(g.rival.round_size) + Number(g.rival.round_offset), F.weekStart(W));
  assert.equal(F.weekOfRivalRound(rr), W);
  assert.equal(F.weekOfRivalRound(rr + 1), null, "a round that isn't a week's first day is no week");
  assert.equal(g.rival.round_size, String(R.DAY)); assert.equal(g.rival.round_offset, "0");
});

test("clock: the fast test clock (1 test day = 1 hour) runs the same rules in a 7-hour week", () => {
  const genesis = Date.parse("2026-11-03T15:00:00Z");
  const T = F.withClock({ day: R.HOUR, genesis, sheetBefore: 30 * 60000 });
  assert.equal(T.WEEK_MS, 7 * R.HOUR);
  assert.equal(T.weekStart(0), genesis);
  assert.equal(T.weekOf(genesis + 7 * R.HOUR + 1), 1);
  const days = T.weekDays(1);
  assert.equal(T.dayStart(days[0]), genesis + 7 * R.HOUR);
  assert.equal(T.dayStart(days[6]), genesis + 13 * R.HOUR);
  assert.equal(T.sheetTime(1), genesis + 6.5 * R.HOUR, "30 minutes before the week");
  const fd = T.formDays(1);
  assert.equal(T.dayStart(fd[6]), genesis + 5 * R.HOUR, "form ends with the last full test day before the sheet");
  assert.equal(T.dayStart(fd[0]), genesis - R.HOUR);
  const g = T.games({ team: 94, rival: 95 }, 50);
  assert.equal(g.team.round_size, String(R.HOUR)); assert.equal(g.team.ahead, String(7 * R.HOUR));
  assert.equal(g.team.max_picks_per_day, 50);
  assert.equal(T.rivalRound(1) * Number(g.rival.round_size) + Number(g.rival.round_offset), T.weekStart(1));
  const g2 = F.withClock({ day: R.HOUR, genesis: genesis + 3 * R.HOUR, sheetBefore: 30 * 60000 }).games({ team: 94, rival: 95 }, 50);
  assert.deepEqual(g2, g, "the Picks settings don't depend on when week 0 starts (a new test week needs no new game)");
  // The day index of a 1-hour day uses that hour's blocks and the card in force at its start.
  const ts = [], sig = [], t0 = T.dayStart(days[0]);
  for (let i = 0; i < 100; i++) { ts.push(t0 + i * 36000); sig.push(i < 50 ? 0 : i < 80 ? 1 : 2); }
  const d = T.dayIndex({ ts, sig, signers: [A, B, C] }, races, days[0]);
  assert.equal(d.blocks, 100);
  assert.deepEqual(d.producers[A], [50, 50, 100]);
  assert.deepEqual(d.producers[C], [20, 20, 100]);
  // The real clock's functions are unchanged by a test clock.
  assert.equal(F.DAY_MS, R.DAY);
});

test("clock: refuses a clock the contract or the rules can't run", () => {
  assert.throws(() => F.withClock({ day: 7 * 60000, genesis: 0 }), /divide 24 hours/);
  assert.throws(() => F.withClock({ day: R.HOUR, genesis: 1000 }), /genesis/);
  assert.throws(() => F.withClock({ day: R.HOUR, genesis: 0, sheetBefore: 7 * R.HOUR }), /sheet/);
  assert.ok(F.withClock({ day: R.HOUR, genesis: 0, sheetBefore: 2 * R.HOUR }), "2 test days ahead, as live");
  assert.ok(F.withClock({ day: 20 * 60000, genesis: 0, sheetBefore: 10 * 60000 }));
});

test("audit FX-3: vault points ranked among the staked players only, when known", () => {
  const rows = [{ a: A, points: 900 }, { a: B, points: 800 }, { a: C, points: 700 }, { a: D, points: 600 }];
  const all = F.vaultPoints(rows), staked = F.vaultPoints(rows, new Set([B, D]));
  assert.equal(all.get(D), 252);
  assert.deepEqual([...staked.entries()], [[B, 255], [D, 254]], "free players don't push stakers down");
});

test("audit FX-5: a day with blocks in an hour no card covers is marked uncovered", () => {
  const t0 = F.dayStart(DAYS[0]);
  const ts = [t0 + 1000, t0 + 20 * R.HOUR], sig = [0, 1];
  const full = F.dayIndex({ ts, sig, signers: [A, B] }, races, DAYS[0]);
  assert.equal(full.uncovered, 0);
  const part = {}; for (const [id, c] of Object.entries(races)) if (Date.parse(id.replace(/T(\d\d)$/, "T$1:00:00Z")) < t0 + 12 * R.HOUR) part[id] = c;
  const half = F.dayIndex({ ts, sig, signers: [A, B] }, part, DAYS[0]);
  assert.ok(half.uncovered === 0 || half.uncovered === 1, "cards carry up to 24 h, so only a gap past that counts");
  const none = F.dayIndex({ ts, sig, signers: [A, B] }, {}, DAYS[0]);
  assert.equal(none.uncovered, 2, "both hours with blocks lack a card");
});

test("audit FX-4: teams pack to positions on the price list and back", () => {
  const t = [C, A, E, B, D];
  assert.deepEqual(F.unpackTeam(sheet, F.packTeam(sheet, t)), t);
  assert.equal(F.unpackTeam(sheet, [0, 1, 99, 2, 3]), null, "a position not on the list is no team");
  assert.equal(F.packTeam(sheet, null), null);
});

test("owner 2026-10-28: rival matches count only when both players hold a Knode Games stake", () => {
  const players = { [A]: { points: 10, full: true }, [B]: { points: 8, full: true }, [C]: { points: 5, full: true } };
  const ch = [[A, B], [C, A]];
  assert.equal(F.matches(ch, players).length, 2, "not checked: both count");
  assert.deepEqual(F.matches(ch, players, new Set([A, B])).map((m) => m.b), [B], "C holds no stake: its challenge doesn't count");
  assert.equal(F.matches(ch, players, new Set()).length, 0);
});

test("owner 2026-10-28: the all-time table adds each final week once per call; most points first", () => {
  let t = F.addAllTime({}, [{ a: A, points: 100 }, { a: B, points: 300 }, { a: C, points: 0 }]);
  t = F.addAllTime(t, [{ a: A, points: 250.5 }, { a: B, points: 40 }]);
  assert.deepEqual(t[A], { points: 350.5, weeks: 2, best: 250.5 });
  assert.deepEqual(t[B], { points: 340, weeks: 2, best: 300 });
  assert.equal(t[C], undefined, "a week with 0 points isn't a week played");
  assert.deepEqual(F.allTimeRows(t).map((r) => [r.a, r.place]), [[A, 1], [B, 2]]);
});

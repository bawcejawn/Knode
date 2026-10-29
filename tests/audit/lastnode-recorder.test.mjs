// Last Node Standing recorder (bot/games/lastnode.ts): the field from the card of the 12:00 leg the day before,
// hours recorded only once irreversible and matching on two nodes, picks for the start and jump rounds agreeing on
// both nodes, cuts and players' points, a run that continues the last one, void events, and last-run files that don't
// have the recorder's shape. Offline: fake nodes and fake race files.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const APP = process.env.APP || ".";
const { run } = await import(path.resolve(APP, "bot/games/lastnode.ts"));
const M = globalThis.KRaceMath, L = globalThis.KLastNode;

const A = (c) => "1" + c.repeat(33);
const [N1, N2, N3, N4, N5] = ["A", "B", "C", "D", "E"].map(A);
const [ALICE, BOB, CAROL, DAVE, EVE] = ["P", "Q", "R", "S", "T"].map(A);
const DAY = "2026-11-03", EV = L.eventOf(DAY);
const H = L.HOUR;

// The card of the 12:00 UTC leg the day before: N5 (100 blocks a race, ~16.7 an hour) is outside the field.
const CARD = { at: EV.cardTime + 37 * 60000, c: 1, blocksPerRace: 7200, fairness: null,
  field: [{ a: N1, vhp: 4000, k: 1200, h: 1 }, { a: N2, vhp: 2000, k: 600, h: 2 }, { a: N3, vhp: 1000, k: 300, h: 4 }, { a: N4, vhp: 1000, k: 300, h: 4 }, { a: N5, vhp: 330, k: 100, h: 12 }],
  paddock: [] };
function raceDir({ withCard = true } = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "race-"));
  for (const w of [2, 3, 4]) {
    const races = [];
    for (let t = M.weekStart(w); t < M.weekStart(w + 1); t += M.RACE) {
      const i = M.raceIndex(t), cards = new Array(6).fill(null);
      if (withCard && t === M.raceStart(M.raceIndex(EV.cardTime))) cards[M.legOf(t, EV.cardTime, 6)] = CARD;
      races.push({ id: M.raceId(i), start: t, end: t + M.RACE, cards, result: null });
    }
    fs.writeFileSync(path.join(d, `W${String(w).padStart(3, "0")}.json`), JSON.stringify({ v: 1, week: w, start: M.weekStart(w), end: M.weekStart(w + 1), races }));
  }
  return d;
}
// Hour i's blocks: the node to go has none that hour (N3, then N1, then N2), so N4 is last standing.
const GONE = [N3, N1, N2];
function countsAt(i) {
  const c = { [N1]: 200, [N2]: 100, [N3]: 50, [N4]: 50, [N5]: 17 };
  for (let k = 0; k <= i && k < GONE.length; k++) delete c[GONE[k]];
  return c;
}
function windowOf({ tamperHour = null } = {}) {
  return async (node, t0, t1) => {
    const i = (t0 - EV.start) / H;
    assert.ok(Number.isInteger(i) && t1 === t0 + H, "whole hours from the start");
    const counts = countsAt(i);
    if (node === "check" && i === tamperHour) counts[N4] = 1;
    return { from: 1000 + i * 1200, to: 1000 + i * 1200 + 1199, counts };
  };
}
// Picks by offset from the start round. Alice: N4 all the way. Bob: N3, jumps to N4 after the cut at hour 1.
// Carol: N1 with a backup N4 for the cut at hour 2 (made before it). Dave: N2, no jump. Eve: only a jump, no start.
const PICKS = { 0: [[ALICE, N4], [BOB, N3], [CAROL, N1], [DAVE, N2]], 2: [[BOB, N4], [EVE, N4]], 3: [[CAROL, N4]] };
const seen = [];
function picksOf({ tamperOffset = null } = {}) {
  return async (node, round) => {
    const off = round - EV.round;
    seen.push(off);
    const rows = (PICKS[off] || []).map(([who, a]) => [who, a, EV.start - H]);
    if (node === "check" && off === tamperOffset && rows.length) rows[0] = [rows[0][0], N2, rows[0][2]];
    return rows;
  };
}
const rankedOf = async (who) => new Set(who.filter((a) => a !== DAVE));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lastnode-"));
const quiet = async (f) => { const log = console.log; console.log = () => {}; try { return await f(); } finally { console.log = log; } };
const go = (o) => quiet(() => run({ p: "main", check: "check", raceDir: raceDir(), picksContract: "1PicksPicksPicksPicksPicksPicks", windowOf: windowOf(), picksOf: picksOf(), rankedOf, trials: 400, ...o }));
const dayFile = (out) => JSON.parse(fs.readFileSync(path.join(out, `D${DAY}.json`), "utf8"));

test("a whole event: field from the day-before card, three cuts, players' points", async () => {
  const out = tmp();
  const r = await go({ out, now: { time: EV.start + 3 * H + 600000, libTime: EV.start + 3 * H + 60000 } });
  assert.deepEqual(r.problems, []);
  const d = dayFile(out);
  assert.deepEqual(d.field.nodes.map((n) => n.a), [N1, N2, N3, N4], "N5 is below 20 blocks an hour");
  assert.equal(d.hours.length, 3); assert.ok(d.hours.every((h) => h.checked === 2));
  assert.ok(d.hours.every((h) => !(N5 in h.blocks)), "only field nodes' blocks are kept");
  assert.deepEqual(d.cuts.map((c) => [c.at, c.a]), [[1, N3], [2, N1], [3, N2]]);
  assert.equal(d.winner, N4); assert.equal(d.done, true);
  const p = Object.fromEntries(d.players.map((x) => [x.a, x]));
  assert.equal(p[ALICE].points, 3 + 5); assert.equal(p[ALICE].rode, true);
  assert.equal(p[BOB].points, 2 + 3); assert.equal(p[BOB].jumpTo, N4);
  assert.equal(p[CAROL].points, 2 + 3, "the backup counted as the jump");
  assert.equal(p[DAVE].points, 2); assert.equal(p[DAVE].out, 3); assert.equal(p[DAVE].ranked, false);
  assert.equal(p[EVE], undefined, "a jump without a start pick is no entry");
  const b = JSON.parse(fs.readFileSync(path.join(out, "board.json"), "utf8"));
  assert.deepEqual(b.today.rows.map((x) => [x.a, x.place, x.pts]), [[ALICE, 1, 8], [BOB, 2, 5], [CAROL, 2, 5], [DAVE, 4, 2]]);
  const idx = JSON.parse(fs.readFileSync(path.join(out, "index.json"), "utf8"));
  assert.ok(idx.days.includes(DAY)); assert.equal(idx.game, L.GAME_ID);
});

test("only irreversible hours; a later run continues from the last run's files", async () => {
  const out1 = tmp();
  await go({ out: out1, now: { time: EV.start + H + 600000, libTime: EV.start + H + 1000 } });
  const d1 = dayFile(out1);
  assert.equal(d1.hours.length, 1); assert.equal(d1.done, false); assert.deepEqual(d1.cuts.map((c) => c.a), [N3]);
  assert.equal(d1.players.find((x) => x.a === ALICE).points, 1, "points so far, no bonus yet");
  // The hour that is not irreversible yet (libTime one ms short of its end) is not recorded.
  const out0 = tmp();
  await go({ out: out0, now: { time: EV.start + 2 * H, libTime: EV.start + H - 1 } });
  assert.equal(dayFile(out0).hours.length, 0);
  const out2 = tmp();
  await go({ prev: out1, out: out2, now: { time: EV.start + 4 * H, libTime: EV.start + 4 * H } });
  const d2 = dayFile(out2);
  assert.equal(d2.hours.length, 3, "stops at the last cut"); assert.equal(d2.winner, N4);
  assert.equal(d2.players.find((x) => x.a === BOB).points, 5);
});

test("the start round and the jump rounds are read, never the rest", async () => {
  seen.length = 0;
  await go({ out: tmp(), now: { time: EV.start + 5 * H, libTime: EV.start + 5 * H } });
  assert.deepEqual([...new Set(seen)].sort((a, b) => a - b), [0, 1, 2, 3]);
});

test("not recorded when the two nodes disagree about an hour's blocks or its picks", async () => {
  const out = tmp();
  const r = await go({ out, windowOf: windowOf({ tamperHour: 1 }), now: { time: EV.start + 4 * H, libTime: EV.start + 4 * H } });
  assert.ok(r.problems.some((p) => p.includes("hour 1") && p.includes("blocks")));
  assert.equal(dayFile(out).hours.length, 1);
  const out2 = tmp();
  const r2 = await go({ out: out2, picksOf: picksOf({ tamperOffset: 2 }), now: { time: EV.start + 4 * H, libTime: EV.start + 4 * H } });
  assert.ok(r2.problems.some((p) => p.includes("hour 1") && p.includes("picks")));
  assert.equal(dayFile(out2).hours.length, 1);
});

test("the field is published the day before, when picks open; no card by the lock → void", async () => {
  const out = tmp();
  await go({ out, now: { time: EV.cardTime + H, libTime: EV.cardTime + H } });
  const d = dayFile(out);
  assert.equal(d.field.nodes.length, 4); assert.equal(d.hours.length, 0);
  assert.ok(Number.isFinite(d.field.c) && d.field.nodes[0].h === 1);
  const out2 = tmp();
  await quiet(() => run({ p: "main", check: "check", out: out2, raceDir: raceDir({ withCard: false }), picksContract: null, windowOf: windowOf(), rankedOf, trials: 400,
    now: { time: EV.start, libTime: EV.start } }));
  const v = dayFile(out2);
  assert.equal(v.field, null); assert.match(v.void, /no race card/); assert.deepEqual(v.players, []);
  // Before the lock it just waits (no file yet).
  const out3 = tmp();
  await quiet(() => run({ p: "main", check: null, out: out3, raceDir: raceDir({ withCard: false }), picksContract: null, windowOf: windowOf(), rankedOf, trials: 400,
    now: { time: EV.lock - 1, libTime: EV.lock - 1 } }));
  assert.ok(!fs.existsSync(path.join(out3, `D${DAY}.json`)));
});

test("last run's files that don't have the recorder's shape are not trusted", async () => {
  const prev = tmp();
  await go({ out: prev, now: { time: EV.start + 3 * H, libTime: EV.start + 3 * H } });
  const d = dayFile(prev);
  d.hours[1].i = 7;                                   // a broken hour list: only the hours before it are kept
  d.hours[0].blocks["not an address"] = 5;
  d.picks["0"].push(["bad", N4, 0]);
  d.field.nodes.push({ a: "nope", vhp: 1, kh: 1, h: -1 });   // a bad field is recalibrated from the card
  fs.writeFileSync(path.join(prev, `D${DAY}.json`), JSON.stringify(d));
  const out = tmp();
  const r = await go({ prev, out, now: { time: EV.start + 4 * H, libTime: EV.start + 4 * H } });
  assert.deepEqual(r.problems, []);
  const e = dayFile(out);
  assert.deepEqual(e.field.nodes.map((n) => n.a), [N1, N2, N3, N4]);
  assert.equal(e.hours.length, 3); assert.ok(!("not an address" in e.hours[0].blocks));
  assert.ok(!e.picks["0"].some((x) => x[0] === "bad"));
  assert.equal(e.winner, N4);
});

test("an event never finished within 3 days is void, and last week is final only after the correction window", async () => {
  const out1 = tmp();
  await go({ out: out1, now: { time: EV.start + H + 60000, libTime: EV.start + H + 60000 } });
  const out2 = tmp();
  const late = EV.start + 3 * L.DAY + 2 * H;
  await go({ prev: out1, out: out2, windowOf: async () => { throw new Error("node down"); }, now: { time: late, libTime: late } });
  const d = dayFile(out2);
  assert.match(d.void, /not recorded within 3 days/); assert.deepEqual(d.players, []);
  // Week 3 is shown as last week from Monday of week 4; every day in it is finished or void (days the recorder never
  // saw are closed as void), but it is final only 12 hours after the week ended.
  const out3 = tmp();
  const early = L.weekStart(4) + 6 * H;
  const r = await go({ prev: out2, out: out3, now: { time: early, libTime: early } });
  assert.equal(r.board.lastWeek.week, 3); assert.equal(r.board.lastWeek.final, false);
  const after = L.weekStart(4) + 13 * H;
  const r2 = await go({ prev: out3, out: tmp(), now: { time: after, libTime: after } });
  assert.equal(r2.board.lastWeek.final, true);
  assert.ok([...r2.days.values()].filter((x) => x.week === 3).every((x) => x.done || x.void));
});

// ── the publish job's shape check (.github/workflows/lastnode.yml): run on real recorder output, then tampered ──
import { execFileSync } from "node:child_process";
const yml = fs.readFileSync(path.resolve(APP, ".github/workflows/lastnode.yml"), "utf8");
const checkPy = yml.match(/<<'PY'\n([\s\S]*?)\n\s*PY\n/)[1].split("\n").map((l) => l.replace(/^ {10}/, "")).join("\n");
const shapeOk = (dir) => { try { execFileSync("python3", ["-c", checkPy, dir], { stdio: "pipe" }); return true; } catch { return false; } };

test("the publish check accepts the recorder's files and refuses tampered ones", async () => {
  const out = tmp();
  await go({ out, now: { time: EV.start + 4 * H, libTime: EV.start + 4 * H } });
  assert.ok(shapeOk(out), "recorder output passes");
  const f = path.join(out, `D${DAY}.json`), good = fs.readFileSync(f, "utf8");
  const bad = [
    (d) => { d.players[0].points = 999; },                       // impossible points
    (d) => { d.players[0].start = A("Z"); },                     // a start outside the field
    (d) => { d.winner = N1; },                                   // a winner that isn't the last standing
    (d) => { d.cuts[1].at = 5; },                                // cuts out of order
    (d) => { d.cuts.pop(); },                                    // a cut missing for a recorded hour
    (d) => { d.hours[0].blocks[A("Z")] = 3; },                   // blocks of a node outside the field
    (d) => { d.field.nodes[0].kh = 5; },                         // a node below 20 blocks an hour
    (d) => { d.start += 1; },                                    // a start that isn't 14:00 UTC of the day
    (d) => { d.extra = "<script>"; },                            // an unknown field
    (d) => { d.void = "x"; },                                    // void with results still in it
    (d) => { d.picks["0"][0][1] = "<img onerror=alert(1)>"; },   // not an address
  ];
  for (const [k, mut] of bad.entries()) {
    const d = JSON.parse(good); mut(d);
    fs.writeFileSync(f, JSON.stringify(d));
    assert.equal(shapeOk(out), false, `tampered file ${k} refused`);
  }
  fs.writeFileSync(f, good);
  const b = JSON.parse(fs.readFileSync(path.join(out, "board.json"), "utf8"));
  b.today.rows[0].pts = -1;
  fs.writeFileSync(path.join(out, "board.json"), JSON.stringify(b));
  assert.equal(shapeOk(out), false, "a negative score refused");
});

test("review M-3: a game that starts mid-week still closes that week", async () => {
  // The first recorded day is Tuesday 3 Nov (week 3); Monday 2 Nov was before the game and is not needed.
  const a = tmp();
  await go({ out: a, now: { time: EV.start + 4 * H, libTime: EV.start + 4 * H } });
  const idx = JSON.parse(fs.readFileSync(path.join(a, "index.json"), "utf8"));
  // Keep only the game's own days from Tuesday on (the 3 days before it were written void as "no card").
  idx.days = idx.days.filter((d) => d >= DAY);
  fs.writeFileSync(path.join(a, "index.json"), JSON.stringify(idx));
  for (const f of fs.readdirSync(a)) if (/^D\d/.test(f) && f.slice(1, 11) < DAY) fs.rmSync(path.join(a, f));
  const after = L.weekStart(4) + 13 * H;
  const r = await go({ prev: a, out: tmp(), now: { time: after, libTime: after } });
  assert.equal(r.board.lastWeek.week, 3);
  assert.equal(r.board.lastWeek.final, true);
});

test("review M-2: the workflow stops on a failed read of games-data, and never publishes a shorter day list", () => {
  assert.match(yml, /git ls-remote --exit-code --heads "\$repo" games-data/);
  assert.match(yml, /if \[ "\$rc" -ne 2 \]; then echo "::error::Couldn't read the games-data branch/);
  assert.doesNotMatch(yml, /git fetch -q --depth 1 "https:\/\/github\.com\/\$\{GITHUB_REPOSITORY\}\.git" games-data 2>\/dev\/null; then/);
  assert.match(yml, /days missing from index\.json/);
  assert.match(yml, /for try in 1 2 3; do/);
});

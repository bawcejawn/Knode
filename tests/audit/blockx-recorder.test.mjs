// Who Signs Block X recorder (bot/games/blockx.ts): targets recorded only once irreversible and matching on two nodes,
// picks agreeing on both nodes, points from the race card in force at the lock, void when no card ever comes, the
// leaderboards and the week's prizes after the 12-hour correction window. Offline: fake nodes and fake race files.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const APP = process.env.APP || ".";
const { run } = await import(path.resolve(APP, "bot/games/blockx.ts"));
const M = globalThis.KRaceMath, X = globalThis.KBlockX;
const plain = (x) => JSON.parse(JSON.stringify(x));

const BIG = "1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", MID = "1BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", SMALL = "1CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const ALICE = "1DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD", BOB = "1EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE", GUEST = "1FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF";

// Week 3 (Mon 2 Nov 2026). A made-up chain: block h at time T(h); every target is signed by BIG except every third (MID).
const W3 = M.weekStart(3);
const H0 = 48_000_000;                          // a height at W3 + 1 h
const T = (h) => W3 + 3600000 + (h - H0) * 3000;
const signerOf = (h) => (h % X.ROUND === 0 && (h / X.ROUND) % 3 === 0 ? MID : BIG);
function blockOf(tamperAt = null) {
  return async (node, h) => ({ signer: node === "check" && tamperAt === h ? SMALL : signerOf(h), time: T(h) });
}
// Picks: Alice always picks MID, Bob always BIG, the guest SMALL. Times spread over 3 days.
function picksOf(tamperRound = null) {
  return async (node, r) => {
    const t = T(r * X.ROUND) - 3600000;
    const rows = [{ player: ALICE, producer: MID, time: t }, { player: BOB, producer: BIG, time: t }, { player: GUEST, producer: SMALL, time: t }];
    if (node === "check" && r === tamperRound) rows[0].producer = BIG;
    return rows;
  };
}
const rankedOf = async (who) => new Set(who.filter((a) => a !== GUEST));
const CARD = { at: 0, c: 1, blocksPerRace: 7200, fairness: null, field: [{ a: BIG, vhp: 2000, k: 600, h: 1 }, { a: MID, vhp: 1000, k: 300, h: 2 }], paddock: [{ a: SMALL, vhp: 10, k: 3 }] };
function raceDir({ withCards = true } = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "race-"));
  for (const w of [2, 3, 4]) {
    const races = [];
    for (let t = M.weekStart(w); t < M.weekStart(w + 1); t += M.RACE) { const i = M.raceIndex(t); races.push({ id: M.raceId(i), start: t, end: t + M.RACE, cards: new Array(6).fill(withCards ? CARD : null), result: null }); }
    fs.writeFileSync(path.join(d, `W${String(w).padStart(3, "0")}.json`), JSON.stringify({ v: 1, week: w, start: M.weekStart(w), end: M.weekStart(w + 1), races }));
  }
  return d;
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "blockx-"));
const quiet = async (f) => { const log = console.log; console.log = () => {}; try { return await f(); } finally { console.log = log; } };

test("records irreversible targets with picks and capped points from the card at the lock", async () => {
  const out = tmp(), lib = H0 + 10 * X.ROUND + 50;
  const r = await quiet(() => run({ p: "main", check: "check", out, raceDir: raceDir(), picksContract: "1P", blockOf: blockOf(), picksOf: picksOf(), rankedOf,
    head: { height: lib + 60, time: T(lib + 60), lib } }));
  assert.deepEqual(r.problems, []);
  const wf = JSON.parse(fs.readFileSync(path.join(out, "W003.json"), "utf8"));
  const rounds = wf.targets.map((t) => t.round);
  assert.ok(rounds.includes(H0 / X.ROUND + 10) && !rounds.includes(H0 / X.ROUND + 11), "only irreversible targets");
  for (const t of wf.targets) {
    assert.equal(t.height % X.ROUND, 0); assert.equal(t.checked, 2); assert.equal(t.lockTime, T(t.height - 100));
    const byPlayer = Object.fromEntries(t.picks.map((p) => [p[0], p]));
    if (t.signer === MID) { assert.equal(byPlayer[ALICE][3], 200); assert.equal(byPlayer[BOB][3], 0); }
    else { assert.equal(byPlayer[BOB][3], 100); assert.equal(byPlayer[ALICE][3], 0); }
    assert.equal(byPlayer[GUEST][3], 0); assert.equal(byPlayer[GUEST][4], 0, "guest not ranked");
  }
  const board = JSON.parse(fs.readFileSync(path.join(out, "board.json"), "utf8"));
  assert.equal(board.week.week, 3);
  assert.ok(board.week.rows.length === 3 && board.week.rows.every((x) => typeof x.pts === "number"));
});

test("not recorded when the two nodes disagree about the block or the picks", async () => {
  const lib = H0 + 3 * X.ROUND + 50, badH = H0 + 2 * X.ROUND;
  const r1 = await quiet(() => run({ p: "main", check: "check", out: tmp(), raceDir: raceDir(), picksContract: "1P", blockOf: blockOf(badH), picksOf: picksOf(), rankedOf, head: { height: lib, time: T(lib), lib } }));
  assert.ok(r1.problems.some((p) => p.includes(`block ${badH}`) && p.includes("disagree")));
  const r2 = await quiet(() => run({ p: "main", check: "check", out: tmp(), raceDir: raceDir(), picksContract: "1P", blockOf: blockOf(), picksOf: picksOf(badH / X.ROUND), rankedOf, head: { height: lib, time: T(lib), lib } }));
  assert.ok(r2.problems.some((p) => p.includes("picks") && p.includes("disagree")));
  const wf = r2.weeks.get(3);
  assert.ok(!wf.targets.some((t) => t.round === badH / X.ROUND));
});

test("no race card: waits, and a target older than 3 days is recorded void with no points", async () => {
  const lib = H0 + 3 * X.ROUND + 50;
  const r = await quiet(() => run({ p: "main", check: null, out: tmp(), raceDir: raceDir({ withCards: false }), picksContract: "1P", blockOf: blockOf(), picksOf: picksOf(), rankedOf, head: { height: lib, time: T(lib), lib } }));
  assert.ok(r.problems.some((p) => p.includes("no race card yet")));
  assert.equal((r.weeks.get(3)?.targets || []).length, 0);
  // 3 days later the old ones are void
  const later = lib + 3 * 28800 - X.ROUND;
  const r2 = await quiet(() => run({ p: "main", check: null, out: tmp(), raceDir: raceDir({ withCards: false }), picksContract: "1P", blockOf: blockOf(), picksOf: picksOf(), rankedOf, head: { height: later, time: T(later), lib: later } }));
  const all = [...r2.weeks.values()].flatMap((w) => w.targets);
  const voided = all.filter((t) => t.void);
  assert.ok(voided.length >= 1 && voided.every((t) => t.picks.every((p) => p[3] === 0)));
});

test("last week's prizes appear only after the 12-hour correction window, open to every wallet", async () => {
  // Record the whole of week 3 in runs, then look from Mon of week 4.
  const out = tmp(), rd = raceDir();
  let prev;
  const startH = H0 - Math.floor(3600000 / 3000);               // W3 00:00
  const endH = startH + 7 * 28800;                               // W4 00:00
  for (let lib = startH + 12 * X.ROUND; lib <= endH + 4 * X.ROUND; lib += 12 * X.ROUND) {
    const o = tmp();
    await quiet(() => run({ p: "main", check: null, prev, out: o, raceDir: rd, picksContract: "1P", blockOf: blockOf(), picksOf: picksOf(), rankedOf, head: { height: lib, time: T(lib), lib } }));
    prev = o;
  }
  const early = await quiet(() => run({ p: "main", check: null, prev, out, raceDir: rd, picksContract: "1P", blockOf: blockOf(), picksOf: picksOf(), rankedOf, head: { height: endH + 6 * 1200, time: T(endH + 6 * 1200), lib: endH + 6 * 1200 - 60 } }));
  assert.equal(early.board.lastWeek.week, 3);
  assert.equal(early.board.lastWeek.final, false, "6 h after the week: still in the correction window");
  assert.deepEqual(early.board.lastWeek.prizes, []);
  const late = await quiet(() => run({ p: "main", check: null, prev: out, out: tmp(), raceDir: rd, picksContract: "1P", blockOf: blockOf(), picksOf: picksOf(), rankedOf, head: { height: endH + 13 * 1200, time: T(endH + 13 * 1200), lib: endH + 13 * 1200 - 60 } }));
  assert.equal(late.board.lastWeek.final, true);
  const pz = plain(late.board.lastWeek.prizes);
  // Bob (BIG, ×1 on 2 of 3 targets) vs Alice (MID, ×2 on 1 of 3): equal expected points. The guest always picks SMALL,
  // which never signs here, so it has no points and can't win; guests aren't excluded otherwise.
  assert.equal(pz.length, 2);
  assert.ok(pz.every((x) => x.player !== GUEST));
  assert.equal(pz.reduce((s, x) => s + x.vhp, 0), 3);
});

test("guests win prizes like anyone (owner's decision 2026-10-27): an unranked wallet with the most points takes 1st", async () => {
  const out = tmp(), rd = raceDir();
  let prev;
  const startH = H0 - Math.floor(3600000 / 3000), endH = startH + 7 * 28800;
  // Here the guest picks the signer every time.
  const picksGuest = async (node, r) => { const t = T(r * X.ROUND) - 3600000 * (1 + (r % 3)); return [{ player: GUEST, producer: signerOf(r * X.ROUND), time: t }, { player: BOB, producer: BIG, time: t }]; };
  for (let lib = startH + 12 * X.ROUND; lib <= endH + 4 * X.ROUND; lib += 12 * X.ROUND) {
    const o = tmp();
    await quiet(() => run({ p: "main", check: null, prev, out: o, raceDir: rd, picksContract: "1P", blockOf: blockOf(), picksOf: picksGuest, rankedOf, head: { height: lib, time: T(lib), lib } }));
    prev = o;
  }
  const r = await quiet(() => run({ p: "main", check: null, prev, out, raceDir: rd, picksContract: "1P", blockOf: blockOf(), picksOf: picksGuest, rankedOf, head: { height: endH + 13 * 1200, time: T(endH + 13 * 1200), lib: endH + 13 * 1200 - 60 } }));
  const pz = plain(r.board.lastWeek.prizes);
  assert.deepEqual(pz.map((x) => [x.player, x.vhp]), [[GUEST, 2], [BOB, 1]]);
  assert.equal(r.board.lastWeek.rows.find((x) => x.a === GUEST).ranked, false, "still marked unranked, but wins");
});

// Combo Card recorder (bot/games/combo.ts): cards read from the Picks contract on two nodes, fixed once their UTC day
// is irreversibly over, priced with the race card in force when sent, scored from the race and Block X recorders'
// final results, voided legs dropped after 3 days, the best-10 boards, and the Vault file once the week is final
// (at least 1 point, unstaked players left out). Offline: fake nodes, fake race and Block X files.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const APP = process.env.APP || ".";
const { run } = await import(path.resolve(APP, "bot/games/combo.ts"));
const M = globalThis.KRaceMath, X = globalThis.KBlockX, C = globalThis.KCombo;
const plain = (x) => JSON.parse(JSON.stringify(x));

const H1 = "1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", H2 = "1BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", H3 = "1CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC", H4 = "1DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD";
const ALICE = "1EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE", BOB = "1FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF", CAROL = "1GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG";

// Week 3 starts Mon 2 Nov 2026. A made-up chain: one block every 3 s from H0 at the start of week 3.
const W3 = M.weekStart(3), H0 = 48_000_000;
const heightAt = (t) => H0 + Math.floor((t - W3) / 3000);
const timeAt = (h) => W3 + (h - H0) * 3000;
// The race card (4 horses): taken 1 minute into every race.
const CARD = (at) => ({ at, c: 0, blocksPerRace: 7200, fairness: null,
  field: [{ a: H1, vhp: 4000, k: 600, h: 1 }, { a: H2, vhp: 2000, k: 300, h: 2 }, { a: H3, vhp: 1300, k: 200, h: 3 }, { a: H4, vhp: 700, k: 100, h: 6 }], paddock: [] });
// Every race finishes H1, H2, H3, H4, except `noResult` races (never recorded).
function raceDir({ noResult = new Set(), from = 2, to = 5 } = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "race-"));
  for (let w = from; w <= to; w++) {
    const races = [];
    for (let t = M.weekStart(w); t < M.weekStart(w + 1); t += M.RACE) {
      const i = M.raceIndex(t);
      const result = noResult.has(i) ? null : { final: true, checked: 2, standings: [H1, H2, H3, H4].map((a, k) => ({ a, steps: 100 - k * 10, blocks: 10 })) };
      races.push({ id: M.raceId(i), start: t, end: t + M.RACE, cards: [CARD(t + 60000), null, null, null, null, null], result });
    }
    fs.writeFileSync(path.join(d, `W${String(w).padStart(3, "0")}.json`), JSON.stringify({ v: 1, week: w, start: M.weekStart(w), end: M.weekStart(w + 1), races }));
  }
  return d;
}
// Block X targets: even rounds signed by H1, odd by H2.
function blockxDir({ from = 2, to = 5 } = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "bx-"));
  for (let w = from; w <= to; w++) {
    const targets = [];
    for (let r = Math.ceil(heightAt(M.weekStart(w)) / X.ROUND); X.target(r) < heightAt(M.weekStart(w + 1)); r++)
      targets.push({ round: r, height: X.target(r), final: true, checked: 2, signer: r % 2 === 0 ? H1 : H2, time: timeAt(X.target(r)), lockTime: 0, card: null, picks: [] });
    fs.writeFileSync(path.join(d, `W${String(w).padStart(3, "0")}.json`), JSON.stringify({ v: 1, week: w, start: M.weekStart(w), end: M.weekStart(w + 1), targets }));
  }
  return d;
}
// Cards: on every day, in slot 0, sent at 01:00 UTC:
//   Alice: Win H1 in the day's 18:00 race (hits) + H2 signs the first odd Block X round after 20:00 (hits);
//   Bob:   Show H4 in the 18:00 race (misses) + H1 signs the first even round after 20:00 (hits);
//   Carol: Alice's card (hits) but Carol isn't staked.
function legsOf(day) {
  const race = day * 4 + 3;
  let r = Math.floor(heightAt(day * M.DAY + 20 * 3600000) / X.ROUND);
  const odd = r % 2 === 1 ? r : r + 1, even = r % 2 === 0 ? r : r + 1;
  return { alice: [{ code: C.WIN, round: race, producer: H1 }, { code: C.BLOCK, round: odd, producer: H2 }], bob: [{ code: C.SHOW, round: race, producer: H4 }, { code: C.BLOCK, round: even, producer: H1 }] };
}
let reads = 0;
function cardsOf({ disagreeAt = null, before = Infinity } = {}) {
  return async (node, round) => {
    reads++;
    const day = C.dayOfRound(round), slot = round % 3;
    if (slot !== 0 || day * M.DAY >= before) return [];
    const L = legsOf(day), t = day * M.DAY + 3600000;
    const out = [
      { player: ALICE, legs: L.alice, time: t, height: heightAt(t), changes: 0 },
      { player: BOB, legs: L.bob, time: t, height: heightAt(t), changes: 0 },
      { player: CAROL, legs: L.alice, time: t, height: heightAt(t), changes: 0 },
    ];
    if (node === "check" && round === disagreeAt) out[0] = { ...out[0], legs: L.bob };
    return out;
  };
}
const stakedOf = async (week, who) => new Map(who.map((a) => [a, a !== CAROL]));
const headAt = (t) => ({ height: heightAt(t), time: t, lib: heightAt(t) - 60, libTime: t - 180000 });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "combo-"));
const quiet = async (f) => { const log = console.log; console.log = () => {}; try { return await f(); } finally { console.log = log; } };
const read = (dir, f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
/** Run once a day at `hour` UTC from day `d0` to `d1`, each run reading the previous run's files. */
async function days(d0, d1, hour, extra = {}) {
  let prev = "", out = "";
  const race = extra.raceDir ?? raceDir(), bx = blockxDir();
  let last = null;
  for (let d = d0; d <= d1; d++) {
    out = tmp();
    last = await quiet(() => run({ p: "main", check: "check", prev, out, raceDir: race, blockxDir: bx, picksContract: "1P", cardsOf: extra.cardsOf ?? cardsOf(), stakedOf, head: headAt(d * M.DAY + hour * 3600000) }));
    prev = out;
  }
  return { out, last };
}
const D3 = C.utcDay(W3);   // Monday of week 3

test("reads each day's slots, fixes them once the day is irreversibly over, and prices every leg from the race card when sent", async () => {
  reads = 0;
  const { out, last } = await days(D3, D3 + 1, 12);
  assert.deepEqual(last.problems, []);
  const wf = read(out, "W003.json");
  const mon = wf.slots.find((s) => s.round === C.slotRound(D3, 0)), tue = wf.slots.find((s) => s.round === C.slotRound(D3 + 1, 0));
  assert.equal(mon.fixed, true, "Monday is over and irreversible on Tuesday");
  assert.equal(tue.fixed, false, "Tuesday's cards can still change");
  const a = mon.cards.find((c) => c.player === ALICE);
  const L = legsOf(D3).alice;
  assert.deepEqual(a.legs.map((l) => [l[0], l[1], l[2], l[3]]), L.map((l) => [l.code, l.round, l.producer, C.priceLeg(CARD(0), l).f100]));
  assert.equal(a.priceAt, M.raceStart(D3 * 4) + 60000, "the latest race card taken before 01:00 is the 00:00 race's");
});

test("scores cards once their slot is fixed and every leg is final: hits pay base × worth, a miss pays 0", async () => {
  const { out } = await days(D3, D3 + 2, 12);
  const mon = read(out, "W003.json").slots.find((s) => s.round === C.slotRound(D3, 0));
  const a = mon.cards.find((c) => c.player === ALICE), b = mon.cards.find((c) => c.player === BOB);
  assert.equal(a.state, "final"); assert.equal(a.outcome, "hit");
  assert.equal(a.pts, C.pointsFor(a.legs.map((l) => l[3])));
  assert.deepEqual(a.legs.map((l) => l[4]), ["hit", "hit"]);
  assert.equal(b.state, "final"); assert.equal(b.outcome, "miss"); assert.equal(b.pts, 0);
  assert.deepEqual(b.legs.map((l) => l[4]), ["miss", "hit"]);
});

test("fixed slots aren't read again", async () => {
  const race = raceDir(), bx = blockxDir();
  const o1 = tmp();
  reads = 0;
  await quiet(() => run({ p: "main", check: "check", out: o1, raceDir: race, blockxDir: bx, picksContract: "1P", cardsOf: cardsOf(), stakedOf, head: headAt((D3 + 1) * M.DAY + 12 * 3600000) }));
  const first = reads;
  const o2 = tmp(); reads = 0;
  await quiet(() => run({ p: "main", check: "check", prev: o1, out: o2, raceDir: race, blockxDir: bx, picksContract: "1P", cardsOf: cardsOf(), stakedOf, head: headAt((D3 + 1) * M.DAY + 13 * 3600000) }));
  assert.ok(reads < first, `${reads} reads after ${first}: Monday's (fixed) slots were skipped`);
  assert.equal(reads, 3 * 2, "only today's 3 slots, on both nodes");
});

test("when the two nodes disagree about a slot, it isn't recorded that run", async () => {
  const round = C.slotRound(D3, 0);
  const out = tmp();
  const r = await quiet(() => run({ p: "main", check: "check", out, raceDir: raceDir(), blockxDir: blockxDir(), picksContract: "1P", cardsOf: cardsOf({ disagreeAt: round }), stakedOf, head: headAt((D3 + 1) * M.DAY + 12 * 3600000) }));
  assert.ok(r.problems.some((p) => p.includes(`slot ${round}`) && p.includes("disagree")));
  assert.equal(read(out, "W003.json").slots.find((s) => s.round === round), undefined);
});

test("a leg whose race is never recorded is void 3 days later; the card scores on its other legs if 2 remain, else it is void", async () => {
  const lost = D3 * 4 + 3;     // Monday's 18:00 race
  const race = raceDir({ noResult: new Set([lost]) });
  let r = await days(D3, D3 + 2, 12, { raceDir: race });
  let mon = read(r.out, "W003.json").slots.find((s) => s.round === C.slotRound(D3, 0));
  assert.equal(mon.cards.find((c) => c.player === ALICE).state, "pending", "waits for the race");
  r = await days(D3, D3 + 4, 12, { raceDir: race });
  mon = read(r.out, "W003.json").slots.find((s) => s.round === C.slotRound(D3, 0));
  const a = mon.cards.find((c) => c.player === ALICE);
  assert.equal(a.legs[0][4], "void");
  assert.equal(a.state, "final"); assert.equal(a.outcome, "void", "1 leg left: the card is void");
});

test("a card sent before any race card exists is void", async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "race-"));
  const { out } = await days(D3, D3 + 1, 12, { raceDir: empty });
  const mon = read(out, "W003.json").slots.find((s) => s.round === C.slotRound(D3, 0));
  assert.ok(mon.cards.every((c) => c.priceAt === null && c.state === "final" && c.outcome === "void"));
});

test("boards: best 10 cards; the week turns final 12 hours after it ends; the Vault file lists players with 1+ point, staked only", async () => {
  // Every day of week 3, then Monday and Tuesday of week 4 (Sunday's cards settle on Monday).
  const { out } = await days(D3, D3 + 8, 13);
  const board = read(out, "board.json");
  assert.equal(board.lastWeek.week, 3); assert.equal(board.lastWeek.final, true);
  const rows = board.lastWeek.rows, a = rows.find((x) => x.a === ALICE), b = rows.find((x) => x.a === BOB), c = rows.find((x) => x.a === CAROL);
  assert.equal(a.cards, 7); assert.equal(a.hits, 7); assert.equal(b.hits, 0); assert.equal(b.pts, 0);
  const wf = read(out, "W003.json");
  const alicePts = wf.slots.flatMap((s) => s.cards).filter((x) => x.player === ALICE).map((x) => x.pts).sort((p, q) => q - p).slice(0, 10).reduce((s, v) => s + v, 0);
  assert.equal(a.pts, alicePts);
  assert.equal(a.staked, true); assert.equal(c.staked, false); assert.equal(c.ranked, false);
  const v = read(out, "vault/W3.json");
  assert.deepEqual(plain(v), { game: 8, week: 3, final: true, rows: [{ player: ALICE, points: 255 }], first: [], second: [] }, "Bob has 0 points, Carol isn't staked");
});

test("the week isn't final, and no Vault file is written, before 12 hours after it ends or while a card is pending", async () => {
  const { out } = await days(D3, D3 + 7, 11);   // Monday of week 4, 11:00: within the 12 hours
  assert.equal(read(out, "board.json").lastWeek.final, false);
  assert.equal(fs.existsSync(path.join(out, "vault", "W3.json")), false);
});

test("a Vault that can't be read yet leaves stakes unknown (null): players stay listed and the Vault checks them", async () => {
  const out = tmp();
  const r = await quiet(() => run({ p: "main", check: null, out, raceDir: raceDir(), blockxDir: blockxDir(), picksContract: "1P", cardsOf: cardsOf(), stakedOf: async () => null, head: headAt((D3 + 2) * M.DAY + 12 * 3600000) }));
  assert.ok(r.board.week.rows.length > 0);
  assert.ok(r.board.week.rows.every((x) => x.staked === null && x.ranked === true));
});

test("a previous file can't smuggle in cards: only fixed slots of the right week with well-formed cards carry over", async () => {
  const prev = tmp();
  const bad = { v: 1, week: 3, start: W3, end: M.weekStart(4), slots: [
    { round: C.slotRound(D3, 1), fixed: true, cards: [{ player: "nope", round: C.slotRound(D3, 1), time: 0, legs: [], state: "final", pts: 999999 }] },
    { round: C.slotRound(D3 + 30, 1), fixed: true, cards: [] },
  ] };
  fs.writeFileSync(path.join(prev, "W003.json"), JSON.stringify(bad));
  const out = tmp();
  await quiet(() => run({ p: "main", check: null, prev, out, raceDir: raceDir(), blockxDir: blockxDir(), picksContract: "1P", cardsOf: cardsOf({ before: 0 }), stakedOf, head: headAt((D3 + 1) * M.DAY + 12 * 3600000) }));
  const wf = read(out, "W003.json");
  assert.ok(!wf.slots.some((s) => s.cards.some((c) => c.player === "nope")));
  assert.ok(!wf.slots.some((s) => s.round === C.slotRound(D3 + 30, 1)));
});

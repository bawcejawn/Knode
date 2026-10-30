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
// The race card (4 horses): taken 1 minute into every hour, from 12 VHP samples (a usable card: Repo Lens RL-8).
const CARD = (at) => ({ at, c: 0, blocksPerRace: 7200, fairness: null, samples: 12,
  field: [{ a: H1, vhp: 4000, k: 600, h: 1 }, { a: H2, vhp: 2000, k: 300, h: 2 }, { a: H3, vhp: 1300, k: 200, h: 3 }, { a: H4, vhp: 700, k: 100, h: 6 }], paddock: [] });
// Every race finishes H1, H2, H3, H4, except `noResult` races (never recorded).
function raceDir({ noResult = new Set(), from = 2, to = 5 } = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "race-"));
  for (let w = from; w <= to; w++) {
    const races = [];
    for (let t = M.weekStart(w); t < M.weekStart(w + 1); t += M.RACE) {
      const i = M.raceIndex(t);
      const result = noResult.has(i) ? null : { final: true, checked: 2, standings: [H1, H2, H3, H4].map((a, k) => ({ a, steps: 100 - k * 10, blocks: 10 })) };
      // Hourly cards, as the race recorder takes them (cards may only be 3 hours old: Repo Lens RL-8).
      races.push({ id: M.raceId(i), start: t, end: t + M.RACE, cards: [0, 1, 2, 3, 4, 5].map((h) => CARD(t + h * M.HOUR + 60000)), result });
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
const dName = (d) => `D${String(d).padStart(5, "0")}.json`;
/** The cards of week w, as one { slots } view of its day files (Repo Lens RL-6: one file per UTC day). */
function wk(dir, w) {
  const d0 = C.utcDay(M.weekStart(w)), slots = [];
  for (let d = d0; d < d0 + 7; d++) if (fs.existsSync(path.join(dir, dName(d)))) slots.push(...read(dir, dName(d)).slots);
  return { slots };
}
/** Run once a day at `hour` UTC from day `d0` to `d1`, each run reading the previous run's files. */
async function days(d0, d1, hour, extra = {}) {
  let prev = "", out = "";
  const race = extra.raceDir ?? raceDir(), bx = blockxDir();
  let last = null;
  for (let d = d0; d <= d1; d++) {
    out = tmp();
    last = await quiet(() => run({ p: "main", check: "check", prev, out, raceDir: race, blockxDir: bx, picksContract: "1P", cardsOf: extra.cardsOf ?? cardsOf(), stakedOf: extra.stakedOf ?? stakedOf, head: headAt(d * M.DAY + hour * 3600000) }));
    carryVault(prev, out);
    prev = out;
  }
  return { out, last };
}
/** As the workflow does: the published Vault files are part of the next run's previous files (written once). */
function carryVault(prev, out) {
  if (!prev || !fs.existsSync(path.join(prev, "vault"))) return;
  for (const f of fs.readdirSync(path.join(prev, "vault"))) if (!fs.existsSync(path.join(out, "vault", f))) { fs.mkdirSync(path.join(out, "vault"), { recursive: true }); fs.copyFileSync(path.join(prev, "vault", f), path.join(out, "vault", f)); }
}
const D3 = C.utcDay(W3);   // Monday of week 3

test("reads each day's slots, fixes them once the day is irreversibly over, and prices every leg from the race card when sent", async () => {
  reads = 0;
  const { out, last } = await days(D3, D3 + 1, 12);
  assert.deepEqual(last.problems, []);
  const wf = wk(out, 3);
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
  const mon = wk(out, 3).slots.find((s) => s.round === C.slotRound(D3, 0));
  const a = mon.cards.find((c) => c.player === ALICE), b = mon.cards.find((c) => c.player === BOB);
  assert.equal(a.state, "final"); assert.equal(a.outcome, "hit");
  assert.equal(a.pts, C.pointsFor(a.legs.map((l) => l[3])));
  assert.deepEqual(a.legs.map((l) => l[4]), ["hit", "hit"]);
  assert.equal(b.state, "final"); assert.equal(b.outcome, "miss"); assert.equal(b.pts, 0);
  assert.deepEqual(b.legs.map((l) => l[4]), ["miss", "hit"]);
});

test("every slot of last week and this week is read from the chain each run, fixed or not (Repo Lens RL-7)", async () => {
  const race = raceDir(), bx = blockxDir();
  const o1 = tmp();
  await quiet(() => run({ p: "main", check: "check", out: o1, raceDir: race, blockxDir: bx, picksContract: "1P", cardsOf: cardsOf(), stakedOf, head: headAt((D3 + 1) * M.DAY + 12 * 3600000) }));
  const o2 = tmp(); reads = 0;
  await quiet(() => run({ p: "main", check: "check", prev: o1, out: o2, raceDir: race, blockxDir: bx, picksContract: "1P", cardsOf: cardsOf(), stakedOf, head: headAt((D3 + 1) * M.DAY + 13 * 3600000) }));
  // Last week (week 2: 7 days) and this week so far (Mon, Tue): 9 days × 3 slots × 2 nodes.
  assert.equal(reads, 9 * 3 * 2);
});

test("when the two nodes disagree about a slot, it isn't recorded that run", async () => {
  const round = C.slotRound(D3, 0);
  const out = tmp();
  const r = await quiet(() => run({ p: "main", check: "check", out, raceDir: raceDir(), blockxDir: blockxDir(), picksContract: "1P", cardsOf: cardsOf({ disagreeAt: round }), stakedOf, head: headAt((D3 + 1) * M.DAY + 12 * 3600000) }));
  assert.ok(r.problems.some((p) => p.includes(`slot ${round}`) && p.includes("disagree")));
  assert.equal(wk(out, 3).slots.find((s) => s.round === round), undefined, "no earlier copy: nothing shown for it");
});

test("a leg whose race is never recorded waits, then is unresolved at the deadline (2 days after the week ends): the card is void", async () => {
  const lost = D3 * 4 + 3;     // Monday's 18:00 race
  const race = raceDir({ noResult: new Set([lost]) });
  let r = await days(D3, D3 + 4, 12, { raceDir: race });
  let mon = wk(r.out, 3).slots.find((s) => s.round === C.slotRound(D3, 0));
  assert.equal(mon.cards.find((c) => c.player === ALICE).state, "pending", "waits for the race");
  r = await days(D3, D3 + 9, 12, { raceDir: race });      // Wednesday of week 4, after the deadline (Wed 00:00)
  mon = wk(r.out, 3).slots.find((s) => s.round === C.slotRound(D3, 0));
  const a = mon.cards.find((c) => c.player === ALICE);
  assert.equal(a.legs[0][4], "unresolved", "never decided: unresolved (fix-check FC-2), not a dropped leg");
  assert.equal(a.state, "final"); assert.equal(a.outcome, "void", "the card is void (no other leg missed)");
});

test("missing race-data makes cards wait, never void them: past the deadline it's an outage, reported as an error (FC-1)", async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "race-"));
  let { out } = await days(D3, D3 + 2, 12, { raceDir: empty });
  let mon = wk(out, 3).slots.find((s) => s.round === C.slotRound(D3, 0));
  assert.ok(mon.cards.every((c) => c.priceAt === null && c.state === "pending"));
  const r = await days(D3, D3 + 9, 12, { raceDir: empty });
  mon = wk(r.out, 3).slots.find((s) => s.round === C.slotRound(D3, 0));
  assert.ok(mon.cards.every((c) => c.state === "pending"), "still waiting");
  assert.ok(r.last.errors.some((e) => /race-data doesn't reach/.test(e)));
  assert.equal(fs.existsSync(path.join(r.out, "vault", "W3.json")), false, "no Vault file from incomplete data");
});

test("a card sent before any race card existed is void (race-data has later cards, none before it)", async () => {
  const race = raceDir();
  const f = path.join(race, "W003.json"), wf = JSON.parse(fs.readFileSync(f, "utf8"));
  fs.unlinkSync(path.join(race, "W002.json"));
  wf.races.find((x) => x.id === M.raceId(D3 * 4)).cards[0] = null;    // no card at Monday 00:00; the 06:00 race's comes later
  fs.writeFileSync(f, JSON.stringify(wf));
  const { out } = await days(D3, D3 + 2, 12, { raceDir: race });
  const mon = wk(out, 3).slots.find((s) => s.round === C.slotRound(D3, 0));
  assert.ok(mon.cards.every((c) => c.priceAt === null && c.state === "final" && c.outcome === "void"));
});

test("boards: best 10 cards; the week turns final 12 hours after it ends; the Vault file lists players with 1+ point, staked only", async () => {
  // Every day of week 3, then Monday and Tuesday of week 4 (Sunday's cards settle on Monday).
  const { out } = await days(D3, D3 + 8, 13);
  const board = read(out, "board.json");
  assert.equal(board.lastWeek.week, 3); assert.equal(board.lastWeek.final, true);
  const rows = board.lastWeek.rows, a = rows.find((x) => x.a === ALICE), b = rows.find((x) => x.a === BOB), c = rows.find((x) => x.a === CAROL);
  assert.equal(a.cards, 7); assert.equal(a.hits, 7); assert.equal(b.hits, 0); assert.equal(b.pts, 0);
  const wf = wk(out, 3);
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

test("a Vault that can't be read leaves stakes unknown (null): players stay listed, unranked, and no Vault file is written (Repo Lens RL-4)", async () => {
  const out = tmp();
  const r = await quiet(() => run({ p: "main", check: null, out, raceDir: raceDir(), blockxDir: blockxDir(), picksContract: "1P", cardsOf: cardsOf(), stakedOf: async () => null, head: headAt((D3 + 2) * M.DAY + 12 * 3600000) }));
  assert.ok(r.board.week.rows.length > 0);
  assert.ok(r.board.week.rows.every((x) => x.staked === null && x.ranked === false));
  const { out: o2, last } = await days(D3, D3 + 8, 13, { stakedOf: async () => null });
  assert.equal(fs.existsSync(path.join(o2, "vault", "W3.json")), false, "no Vault file while stakes are unknown");
  assert.ok(last.errors.some((e) => /stakes in the Combo Card couldn't be read/.test(e)));
});

test("a previous file can't smuggle in cards: last week's and this week's slots come from the chain only (Repo Lens RL-7)", async () => {
  const prev = tmp();
  const bad = { v: 2, day: D3, start: D3 * M.DAY, slots: [
    { round: C.slotRound(D3, 1), fixed: true, cards: [{ player: ALICE, round: C.slotRound(D3, 1), time: T(D3, 1), changes: 0, priceAt: T(D3, 0), legs: legsOf(D3).alice.map((l) => [l.code, l.round, l.producer, 300, "hit"]), state: "final", outcome: "hit", pts: 999999, settled: T(D3, 1) }] },
  ] };
  fs.writeFileSync(path.join(prev, dName(D3)), JSON.stringify(bad));
  const out = tmp();
  await quiet(() => run({ p: "main", check: "check", prev, out, raceDir: raceDir(), blockxDir: blockxDir(), picksContract: "1P", cardsOf: cardsOf({ before: 0 }), stakedOf, head: headAt((D3 + 1) * M.DAY + 12 * 3600000) }));
  const wf = wk(out, 3);
  assert.ok(!wf.slots.some((s) => s.cards.length), "the chain has no cards: none are kept from the earlier file");
});

// ── formal audit 2026-10-28 (scoring and recorder): the failing tests that showed CC-B1..CC-B5, now passing ──
const T = (d, h) => d * M.DAY + h * 3600000;
async function runAt(t, prev, { race, bx, cards = cardsOf(), staked = stakedOf } = {}) {
  const out = tmp();
  const r = await quiet(() => run({ p: "main", check: "check", prev, out, raceDir: race, blockxDir: bx, picksContract: "1P", cardsOf: cards, stakedOf: staked, head: headAt(t) }));
  carryVault(prev, out);
  return { out, r };
}
test("CC-B1: a 4-day outage mid-week doesn't block the week's Vault file", async () => {
  const race = raceDir(), bx = blockxDir(); let prev = "";
  for (const d of [D3, D3 + 1]) prev = (await runAt(T(d, 13), prev, { race, bx })).out;
  for (let d = D3 + 6; d <= D3 + 13; d++) prev = (await runAt(T(d, 13), prev, { race, bx })).out;
  assert.ok(fs.existsSync(path.join(prev, "vault", "W3.json")));
});
test("CC-B2: a race card published after the slot was fixed is used, and the card ends final", async () => {
  const full = raceDir(), bx = blockxDir(), lateDir = raceDir();
  const f = path.join(lateDir, "W003.json"), wf = JSON.parse(fs.readFileSync(f, "utf8"));
  wf.races.find((x) => x.id === M.raceId(D3 * 4)).cards[0] = null;
  wf.races.find((x) => x.id === M.raceId(D3 * 4 + 3)).result = null;
  fs.writeFileSync(f, JSON.stringify(wf));
  let prev = (await runAt(T(D3, 13), "", { race: lateDir, bx })).out;
  prev = (await runAt(T(D3 + 1, 0) + 600000, prev, { race: lateDir, bx })).out;
  for (let d = D3 + 1; d <= D3 + 4; d++) prev = (await runAt(T(d, 13), prev, { race: full, bx })).out;
  const a = wk(prev, 3).slots.find((s) => s.round === C.slotRound(D3, 0)).cards.find((c) => c.player === ALICE);
  assert.equal(a.state, "final"); assert.equal(a.outcome, "hit");
  assert.equal(a.priceAt, M.raceStart(D3 * 4) + 60000, "priced with the card that was in force when sent");
});
test("CC-B3: race-data missing at the fixing run doesn't void the day's cards", async () => {
  const race = raceDir(), bx = blockxDir(), empty = fs.mkdtempSync(path.join(os.tmpdir(), "race-"));
  let prev = (await runAt(T(D3, 13), "", { race, bx })).out;
  prev = (await runAt(T(D3 + 1, 13), prev, { race: empty, bx })).out;
  for (let d = D3 + 2; d <= D3 + 3; d++) prev = (await runAt(T(d, 13), prev, { race, bx })).out;
  const a = wk(prev, 3).slots.find((s) => s.round === C.slotRound(D3, 0)).cards.find((c) => c.player === ALICE);
  assert.equal(a.outcome, "hit");
});
test("CC-B4: one missing result can't push the Vault file past the week's end + 3 days", async () => {
  const lost = (D3 + 7) * 4 + 3, race = raceDir({ noResult: new Set([lost]) }), bx = blockxDir(), sun = D3 + 6;
  const cards = async (node, round) => {
    if (round % 3 !== 0 || C.dayOfRound(round) !== sun) return [];
    const t = T(sun, 19), r = Math.floor(heightAt(T(sun + 1, 12)) / X.ROUND), even = r % 2 === 0 ? r : r + 1;
    return [{ player: ALICE, legs: [{ code: C.WIN, round: lost, producer: H1 }, { code: C.BLOCK, round: even, producer: H1 }], time: t, height: heightAt(t), changes: 0 }];
  };
  let prev = "";
  for (let d = D3; d <= D3 + 9; d++) prev = (await runAt(T(d, 23), prev, { race, bx, cards })).out;
  assert.ok(fs.existsSync(path.join(prev, "vault", "W3.json")), "written by Wed 23:00 (the Vault's deadline is Thu 00:00)");
});
test("CC-B5: a leg is worth the lower of its worth when sent and at its lock", () => {
  const atSend = CARD(0);
  const atLock = { ...CARD(1), field: [{ a: H1, vhp: 4000, k: 300, h: 1 }, { a: H4, vhp: 8000, k: 600, h: 0.5 }, { a: H2, vhp: 2000, k: 150, h: 2 }, { a: H3, vhp: 2000, k: 150, h: 2 }] };
  const leg = { code: C.BLOCK, round: 100, producer: H4 };
  assert.equal(C.finalWorth(atSend, atLock, leg), C.priceLeg(atLock, leg).f100);
  assert.ok(C.finalWorth(atSend, atLock, leg) < C.priceLeg(atSend, leg).f100);
  assert.equal(C.finalWorth(atSend, null, leg), C.priceLeg(atSend, leg).f100, "no lock card: the worth when sent");
  assert.equal(C.finalWorth(atLock, atSend, leg), C.priceLeg(atLock, leg).f100, "never higher than when sent");
});
test("CC-B6: once the Vault can be read, This week shows real stakes (not a cache left empty by Today)", async () => {
  const { out } = await days(D3, D3 + 3, 13);
  const w = read(out, "board.json").week.rows;
  assert.ok(w.length > 0);
  assert.equal(w.find((x) => x.a === ALICE).staked, true);
  assert.equal(w.find((x) => x.a === CAROL).staked, false);
});
test("CC-B7 / RL-7: an earlier file with a duplicated slot, a player twice or made-up points changes nothing: the chain is read again", async () => {
  const { out } = await days(D3, D3 + 2, 13);
  const f = path.join(out, dName(D3)), df = read(out, dName(D3));
  const mon = df.slots.find((s) => s.round === C.slotRound(D3, 0));
  const fake = JSON.parse(JSON.stringify(mon));
  fake.cards.find((c) => c.player === ALICE).pts = 500000000;
  df.slots.push(fake);
  fs.writeFileSync(f, JSON.stringify(df));
  const o2 = tmp();
  await quiet(() => run({ p: "main", check: "check", prev: out, out: o2, raceDir: raceDir(), blockxDir: blockxDir(), picksContract: "1P", cardsOf: cardsOf(), stakedOf, head: headAt(T(D3 + 2, 14)) }));
  const w2 = wk(o2, 3);
  assert.equal(w2.slots.filter((s) => s.round === mon.round).length, 1);
  const a = w2.slots.find((s) => s.round === mon.round).cards.find((c) => c.player === ALICE);
  assert.equal(a.pts, C.pointsFor(a.legs.filter((l) => l[4] !== "void").map((l) => l[3])), "points from the legs");
});

// The workflow's publish check (the Python in combo.yml): the recorder's real files pass; tampered ones are held with an
// alert (audit CC-C6; Repo Lens RL-7, RL-20). Skipped where python3 isn't installed.
test("combo.yml's publish check: real files pass; duplicates, bad outcomes, changed fixed slots and Vault rows not on the published board are held", async (t) => {
  const { execFileSync } = await import("node:child_process");
  try { execFileSync("python3", ["--version"]); } catch { t.skip("no python3"); return; }
  const y = fs.readFileSync(path.resolve(APP, ".github/workflows/combo.yml"), "utf8");
  const py = y.split("<<'PY'\n")[1].split("\n          PY\n")[0].split("\n").map((l) => (l.startsWith("          ") ? l.slice(10) : l)).join("\n");
  const script = path.join(tmp(), "check.py");
  fs.writeFileSync(script, py);
  const race = raceDir(), bx = blockxDir();
  let prev = "", lastT = 0;
  for (let d = D3; d <= D3 + 8; d++) {
    const out = tmp(); lastT = d * M.DAY + 13 * 3600000;
    await quiet(() => run({ p: "main", check: "check", prev, out, raceDir: race, blockxDir: bx, picksContract: "1EDaCKVmBjUxLxgWCmDbRA8gWKkSQ6ByzY", cardsOf: cardsOf(), stakedOf, head: headAt(lastT) }));
    carryVault(prev, out); prev = out;
  }
  assert.ok(fs.existsSync(path.join(prev, "vault", "W3.json")));
  const check = (IN, PUB) => { const held = path.join(tmp(), "held"); execFileSync("python3", ["-I", script, IN, PUB, held], { env: { ...process.env, CHECK_NOW_MS: String(lastT + 3600000) }, stdio: "pipe" }); return fs.readFileSync(held, "utf8").split("\n").filter(Boolean); };
  // Published = the same files: everything passes, the Vault file matches the published final board.
  assert.deepEqual(check(prev, prev), []);
  // The published board isn't final yet: the Vault file waits for it (no alert); the rest passes.
  const early = tmp(); fs.cpSync(prev, early, { recursive: true }); fs.rmSync(path.join(early, "vault", "W3.json"));
  { const b = read(early, "board.json"); b.lastWeek.final = false; fs.writeFileSync(path.join(early, "board.json"), JSON.stringify(b)); }
  assert.deepEqual(check(prev, early), ["combo/vault/W3.json"]);
  const bad = (edit, pubEdit = null) => {
    const IN = tmp(), PUB = tmp(); fs.cpSync(prev, IN, { recursive: true }); fs.cpSync(prev, PUB, { recursive: true });
    edit(IN); if (pubEdit) pubEdit(PUB);
    return check(IN, PUB).includes("!alert");
  };
  const D = dName(D3), edit = (dir, f, fn) => { const j = read(dir, f); fn(j); fs.writeFileSync(path.join(dir, f), JSON.stringify(j)); };
  assert.ok(bad((d) => edit(d, "vault/W3.json", (j) => j.rows.push({ ...j.rows[0] })), (p) => fs.rmSync(path.join(p, "vault"), { recursive: true })), "a player twice in the Vault file");
  assert.ok(bad((d) => edit(d, D, (j) => j.slots.push(j.slots[0]))), "a slot twice");
  assert.ok(bad((d) => edit(d, D, (j) => { j.slots[0].cards[0].legs[0][3] = 301; })), "a worth above ×3");
  assert.ok(bad((d) => edit(d, D, (j) => { const c = j.slots[0].cards.find((x) => x.outcome === "miss"); c.outcome = "hit"; c.pts = 900; })), "a miss turned into a hit");
  assert.ok(bad((d) => edit(d, D, (j) => { j.slots[0].cards[0].legs[1][2] = j.slots[0].cards[0].legs[0][2]; })), "a producer twice on a card");
  assert.ok(bad((d) => edit(d, D, (j) => { j.slots[0].cards.pop(); })), "a card dropped from a published fixed slot");
  assert.ok(bad((d) => edit(d, "vault/W3.json", (j) => { j.rows[0].player = CAROL; }), (p) => fs.rmSync(path.join(p, "vault"), { recursive: true })), "a Vault row that isn't on the published final board");
  assert.ok(bad((d) => fs.writeFileSync(path.join(d, dName(D3 - 30)), JSON.stringify({ v: 2, day: D3 - 30, start: (D3 - 30) * M.DAY, slots: [] }))), "a new file for an old day");
});

// ── fix-check 2026-10-28 ──
test("FC-1: a race-data outage after the deadline doesn't void, and a final card keeps its outcome on the next run", async () => {
  const race = raceDir(), bx = blockxDir(), empty = fs.mkdtempSync(path.join(os.tmpdir(), "nr-"));
  let prev = "";
  for (let d = D3; d <= D3 + 8; d++) { const out = tmp(); await quiet(() => run({ p: "main", check: "check", prev, out, raceDir: race, blockxDir: bx, picksContract: "1P", cardsOf: cardsOf(), stakedOf, head: headAt(T(d, 13)) })); prev = out; }
  const mon = (dir) => wk(dir, 3).slots.find((s) => s.round === C.slotRound(D3, 0)).cards.find((c) => c.player === ALICE);
  const o1 = tmp(); const r1 = await quiet(() => run({ p: "main", check: "check", prev, out: o1, raceDir: empty, blockxDir: bx, picksContract: "1P", cardsOf: cardsOf(), stakedOf, head: headAt(T(D3 + 9, 0) + 3000000) }));
  const o2 = tmp(); await quiet(() => run({ p: "main", check: "check", prev: o1, out: o2, raceDir: race, blockxDir: bx, picksContract: "1P", cardsOf: cardsOf(), stakedOf, head: headAt(T(D3 + 9, 2)) }));
  assert.notEqual(mon(o1).outcome, "void", "a priced card was voided by a race-data outage");
  // Fix-check FC-5/FC-9: a card final on a published fixed slot is kept as published, so an outage changes nothing.
  assert.equal(mon(o1).state, "final"); assert.equal(mon(o1).outcome, "hit");
  assert.equal(mon(o2).outcome, "hit", "once race-data is back, the same result");
  void r1;
});
test("FC-1 / RL-9: race-data that never catches up past the send time is an outage: the card waits and an error is raised, never a void", async () => {
  // The race recorder stops on Monday at 00:01 (its week file is there, nothing after): the card can't be priced.
  const race = raceDir();
  for (const f of fs.readdirSync(race)) { const p = path.join(race, f), j = JSON.parse(fs.readFileSync(p, "utf8"));
    for (const r of j.races) { r.cards = r.cards.map((c) => (c && c.at <= T(D3, 0) + 60000 ? c : null)); if (r.start >= T(D3, 0)) r.result = null; }
    fs.writeFileSync(p, JSON.stringify(j)); }
  const { out, last } = await days(D3, D3 + 10, 13, { raceDir: race });
  const a = wk(out, 3).slots.find((s) => s.round === C.slotRound(D3, 0)).cards.find((c) => c.player === ALICE);
  assert.equal(a.state, "pending"); assert.equal(a.priceAt, null);
  assert.ok(last.errors.some((e) => /race-data doesn't reach/.test(e)));
});
test("FC-2: the hourly cards' small drift doesn't lower a worth; a real change (over 10%) does", () => {
  const leg = { code: C.BLOCK, round: 100, producer: H4 };
  const send = CARD(0), drift = { ...CARD(1), field: CARD(1).field.map((r) => (r.a === H4 ? { ...r, vhp: r.vhp * 1.05 } : r)) };
  assert.equal(C.finalWorth(send, drift, leg), C.priceLeg(send, leg).f100, "5% more VHP: the worth when sent");
  const big = { ...CARD(1), field: CARD(1).field.map((r) => (r.a === H4 ? { ...r, vhp: r.vhp * 3 } : r)) };
  assert.equal(C.finalWorth(send, big, leg), C.priceLeg(big, leg).f100, "3× the VHP: the lower worth at the lock");
});
test("FC-3: a previous file can't mark a slot of a day that isn't over as fixed", async () => {
  const prev = tmp();
  const df = { v: 2, day: D3 + 1, start: (D3 + 1) * M.DAY, slots: [{ round: C.slotRound(D3 + 1, 0), fixed: true, cards: [] }] };
  fs.writeFileSync(path.join(prev, dName(D3 + 1)), JSON.stringify(df));
  const out = tmp();
  await quiet(() => run({ p: "main", check: "check", prev, out, raceDir: raceDir(), blockxDir: blockxDir(), picksContract: "1P", cardsOf: cardsOf(), stakedOf, head: headAt(T(D3 + 1, 13)) }));
  const sl = wk(out, 3).slots.find((s) => s.round === C.slotRound(D3 + 1, 0));
  assert.equal(sl.fixed, false); assert.equal(sl.cards.length, 3, "Tuesday's slot was read again");
});

// ── Repo Lens final audit 2026-10-30 ──
test("RL-25: the recorder records nothing when game 8's leg types on chain lock differently from combo-math.js", async () => {
  const { settingsProblem, expectedLegTypes } = await import(path.resolve(APP, "bot/games/combo.ts"));
  const game = (types) => ({ kind: 4, round_size: "3", round_offset: "0", leg_types: types });
  const ok = expectedLegTypes().map((t) => ({ ...t, enabled: true }));
  assert.equal(settingsProblem(game(ok)), null);
  assert.equal(settingsProblem(game(ok.slice(0, 3))), null, "a leg type not announced yet: fine (cards can't use it)");
  assert.match(settingsProblem(game(ok.map((t) => (t.code === 1 ? { ...t, lead: String(5 * 60000) } : t)))), /leg type 1 on chain has lead 300000/);
  assert.match(settingsProblem(game(ok.map((t) => (t.code === 4 ? { ...t, lead: "100" } : t)))), /leg type 4/);
  assert.match(settingsProblem({ ...game(ok), kind: 1 }), /kind 1/);
  assert.match(settingsProblem(null), /not on the Picks contract/);
});
test("RL-2: VHP moved into the producer between its lock card and the block counts on both check cards (read on both nodes, the higher)", async () => {
  // Alice's Block X leg (H2 signs) priced ×3 when sent; 100,000 VHP flows into H2 just before the block.
  const reads = [];
  const vhpMovesOf = async (node, who, from, to) => { reads.push([node, who, from, to]); return node === "check" ? 10000000000000n : 5000000000000n; };
  const out = tmp();
  const race = raceDir(), bx = blockxDir();
  await quiet(() => run({ p: "main", check: "check", out, raceDir: race, blockxDir: bx, picksContract: "1P", cardsOf: cardsOf(), stakedOf, vhpMovesOf, head: headAt(T(D3 + 1, 13)) }));
  const a = wk(out, 3).slots.find((s) => s.round === C.slotRound(D3, 0)).cards.find((c) => c.player === ALICE);
  assert.equal(a.legs[1][4], "hit");
  const mine = reads.filter((r) => r[1] === H2 && r[3] === X.target(a.legs[1][1]));
  assert.ok(mine.some((r) => r[0] === "main") && mine.some((r) => r[0] === "check"), "read on both nodes, up to the block");
  assert.ok(mine.every((r) => r[2] < r[3] && r[3] - r[2] < 2000), "from (about) the lock card's block, less the 25-block margin");
  assert.ok(a.legs[1][3] < C.priceLeg(CARD(0), { code: C.BLOCK, round: a.legs[1][1], producer: H2 }).f100, `worth ${a.legs[1][3]}: the moved VHP lowered it`);
  // H2: 2,000 + 100,000 (the higher read) of 108,000 VHP → chance 0.9444 → 0.5 / 0.9444 = ×0.52 (rounded down).
  assert.equal(a.legs[1][3], 52);
});

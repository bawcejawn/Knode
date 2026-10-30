// C-S failing tests (Repo Lense final audit, Combo Card scoring). NOT RUN HERE (static review).
// Run from the repo root at 32fae49:  APP=. node --import tsx --test <this file>
// They drive the REAL recorder (bot/games/combo.ts run(), which loads combo-math.js) with fake nodes and files,
// in the style of tests/audit/combo-recorder.test.mjs. Each test FAILS at 32fae49 and passes once the finding is fixed.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const APP = process.env.APP || ".";
const { run } = await import(path.resolve(APP, "bot/games/combo.ts"));
const M = globalThis.KRaceMath, X = globalThis.KBlockX, C = globalThis.KCombo;

const H1 = "1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", H2 = "1BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", H3 = "1CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC", H4 = "1DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD";
const NEW = "1HHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHH";   // a producer on no card
const ALICE = "1EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE";
const W3 = M.weekStart(3), H0 = 48_000_000;
const heightAt = (t) => H0 + Math.floor((t - W3) / 3000);
const timeAt = (h) => W3 + (h - H0) * 3000;
// 7 producers, none above 1/6 of all VHP: every Block X leg is worth 3 (300).
const FIELD = (big = 1000) => [H1, H2, H3, H4, "1JJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJ", "1KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK", "1LLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLL"]
  .map((a, i) => ({ a, vhp: i === 1 ? big : 1000, k: 100, h: 1 }));
// (Combo fix round: cards carry 12 VHP samples, as the race recorder writes them; RL-8 makes a card without them unusable.)
const CARD = (at, big) => ({ at, c: 0, blocksPerRace: 7200, fairness: null, samples: 12, field: FIELD(big), paddock: [] });
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
/** race-data with a card `everyMs` into every race (cardAt(t) may change the card), all races final H1..H4. */
function raceDir(cardAt) {
  const d = tmp("race-");
  for (let w = 2; w <= 5; w++) {
    const races = [];
    for (let t = M.weekStart(w); t < M.weekStart(w + 1); t += M.RACE) {
      const i = M.raceIndex(t), cards = [];
      for (let l = 0; l < 6; l++) cards.push(cardAt(t + l * M.HOUR + 60000));
      races.push({ id: M.raceId(i), start: t, end: t + M.RACE, cards, result: { final: true, checked: 2, standings: [H1, H2, H3, H4].map((a, k) => ({ a, steps: 100 - k * 10, blocks: 10 })) } });
    }
    fs.writeFileSync(path.join(d, `W${String(w).padStart(3, "0")}.json`), JSON.stringify({ v: 1, week: w, start: M.weekStart(w), end: M.weekStart(w + 1), races }));
  }
  return d;
}
function blockxDir(signerOf) {
  const d = tmp("bx-");
  for (let w = 2; w <= 5; w++) {
    const targets = [];
    for (let r = Math.ceil(heightAt(M.weekStart(w)) / X.ROUND); X.target(r) < heightAt(M.weekStart(w + 1)); r++)
      targets.push({ round: r, height: X.target(r), final: true, checked: 2, signer: signerOf(r), time: timeAt(X.target(r)), lockTime: 0, card: null, picks: [] });
    fs.writeFileSync(path.join(d, `W${String(w).padStart(3, "0")}.json`), JSON.stringify({ v: 1, week: w, start: M.weekStart(w), end: M.weekStart(w + 1), targets }));
  }
  return d;
}
const DAY = C.utcDay(W3) + 1, SENT = DAY * M.DAY + 3600000;                    // Tuesday 01:00 UTC
const RACE = DAY * 4 + 3;                                                     // Tuesday's 18:00 race (H1 wins)
const BX = Math.floor(heightAt(DAY * M.DAY + 20 * 3600000) / X.ROUND) + 1;    // a target after 20:00
const cardsOf = (bxProducer) => async (node, round) => (round === C.slotRound(DAY, 0)
  ? [{ player: ALICE, legs: [{ code: C.WIN, round: RACE, producer: H1 }, { code: C.BLOCK, round: BX, producer: bxProducer }], time: SENT, height: heightAt(SENT), changes: 0 }] : []);
const at = (t) => ({ height: heightAt(t), time: t, lib: heightAt(t) - 60, libTime: t - 180000 });
const quiet = async (f) => { const log = console.log; console.log = () => {}; try { return await f(); } finally { console.log = log; } };
async function bxWorth(o) {
  const r = await quiet(() => run({ p: "p", check: null, out: tmp("combo-"), picksContract: null, stakedOf: async (w, who) => new Map(who.map((a) => [a, true])), head: at(M.weekStart(4) + 13 * 3600000), ...o }));
  const c = [...r.weeks.values()].flatMap((w) => w.slots).flatMap((s) => s.cards).find((x) => x.player === ALICE);
  return c;
}

test("C-S-1: a Block X leg on a producer missing from the card is not worth the cap (BX-3 on the picks branch)", async () => {
  const c = await bxWorth({ cardsOf: cardsOf(NEW), raceDir: raceDir((t) => CARD(t)), blockxDir: blockxDir(() => NEW) });
  assert.equal(c.state, "final");
  assert.ok(c.legs[1][3] <= 100, `worth of a producer on no card: ${c.legs[1][3]} (expected at most ×1, as Block X's BX-3)`);
});

test("C-S-2: VHP moved in after the lock card lowers the Block X leg's worth (the first card after X counts, as BX-35)", async () => {
  const bxTime = timeAt(X.target(BX));
  // H2 holds 1/7 of all VHP until the target's lock card; from 10 minutes before the target it holds 10× everyone else.
  const cardAt = (t) => CARD(t, t >= bxTime - 10 * 60000 ? 60000 : 1000);
  const c = await bxWorth({ cardsOf: cardsOf(H2), raceDir: raceDir(cardAt), blockxDir: blockxDir(() => H2) });
  assert.equal(c.state, "final");
  const after = C.priceLeg(CARD(bxTime + 3600000, 60000), { code: C.BLOCK, round: BX, producer: H2 }).f100;
  assert.ok(c.legs[1][3] <= after, `worth ${c.legs[1][3]} kept although the first card after the target says ${after}`);
});

test("C-S-3: a card priced with a race card older than 3 hours waits or is void, never priced with the stale card", async () => {
  // No race card at all between Monday 22:00 and Tuesday 10:00 (a race-recorder outage), then cards again.
  const gapFrom = DAY * M.DAY - 2 * 3600000, gapTo = DAY * M.DAY + 10 * 3600000;
  const c = await bxWorth({ cardsOf: cardsOf(H2), raceDir: raceDir((t) => (t >= gapFrom && t < gapTo ? null : CARD(t))), blockxDir: blockxDir(() => H2) });
  assert.ok(c.priceAt === null || SENT - c.priceAt <= 3 * 3600000, `priced with a card ${(SENT - c.priceAt) / 3600000} h old`);
});

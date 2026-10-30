// E-S failing tests (Repo Lens fix-check 2, Combo scoring @ c8bd49f). NOT RUN HERE (static review).
// Place as tests/audit/repolens-fc-combo/e-s-scoring.test.mjs (next to W001-live.json) and run from the repo root:
//   node --import tsx --test tests/audit/repolens-fc-combo/e-s-scoring.test.mjs
// They drive the REAL bot/games/combo.ts run() with fake nodes and files, as d-s-scoring.test.mjs does.
// E-S-1 and E-S-2 fail at c8bd49f (proof.out); "D-S-1 strict" passes at c8bd49f and fails on the e0330a1 branch
// (proof-mut.out), which the owner's adapted D-S-1 no longer catches.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { fileURLToPath } from "node:url";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const { run } = await import(path.join(ROOT, "bot/games/combo.ts"));
const { NonCanonicalTransfer } = await import(path.join(ROOT, "bot/games/blockx.ts"));
const M = globalThis.KRaceMath, X = globalThis.KBlockX, C = globalThis.KCombo;
const live = JSON.parse(fs.readFileSync(process.env.LIVE || path.join(HERE, "W001-live.json"), "utf8"));
const lc = live.races.flatMap((r) => r.cards || []).filter(Boolean).sort((a, b) => a.at - b.at).pop();
const VHP = [...lc.field.map((r) => [r.a, r.vhp]), ...(lc.paddock || []).map((r) => [r.a, r.vhp])];
const PA = VHP.find(([a]) => a.startsWith("1JrsQXbr"))[0], OTHER = VHP.find(([a]) => a !== PA)[0];
const THIRD = VHP.find(([a]) => a !== PA && a !== OTHER)[0];
const card = (at, mult = 1, extra = {}) => ({ ...M.makeCard(VHP.map(([a, v]) => [a, a === PA ? v * mult : v]), lc.blocksPerRace, at), samples: 12, ...extra });
const W3 = M.weekStart(3), H0 = 48_000_000, D3 = C.utcDay(W3);
const heightAt = (t) => H0 + Math.floor((t - W3) / 3000), timeAt = (h) => W3 + (h - H0) * 3000;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "es-"));
const W = (w) => `W${String(w).padStart(3, "0")}.json`;
const order = [PA, OTHER, THIRD, ...VHP.map(([a]) => a).filter((a) => a !== PA && a !== OTHER && a !== THIRD)];
function raceDir(cardAt, resultOf = () => null) {
  const d = tmp();
  for (let w = 2; w <= 5; w++) {
    const races = [];
    for (let t = M.weekStart(w); t < M.weekStart(w + 1); t += M.RACE) {
      const i = M.raceIndex(t);
      races.push({ id: M.raceId(i), start: t, end: t + M.RACE, cards: [0, 1, 2, 3, 4, 5].map((l) => cardAt(t + l * M.HOUR + 60000)),
        result: resultOf(i) ?? { final: true, checked: 2, standings: order.map((a, k) => ({ a, steps: 1000 - k, blocks: 10 })) } });
    }
    fs.writeFileSync(path.join(d, W(w)), JSON.stringify({ v: 1, week: w, start: M.weekStart(w), end: M.weekStart(w + 1), races }));
  }
  return d;
}
function blockxDir(signerOf) {
  const d = tmp();
  for (let w = 2; w <= 5; w++) {
    const targets = [];
    for (let r = Math.ceil(heightAt(M.weekStart(w)) / X.ROUND); X.target(r) < heightAt(M.weekStart(w + 1)); r++)
      targets.push({ round: r, height: X.target(r), final: true, checked: 2, signer: signerOf(r), time: timeAt(X.target(r)), lockTime: 0, card: null, picks: [] });
    fs.writeFileSync(path.join(d, W(w)), JSON.stringify({ v: 1, week: w, start: M.weekStart(w), end: M.weekStart(w + 1), targets }));
  }
  return d;
}
const headAt = (t) => ({ height: heightAt(t), time: t, lib: heightAt(t) - 60, libTime: t - 180000 });
const quiet = async (f) => { const l = console.log; console.log = () => {}; try { return await f(); } finally { console.log = l; } };
const staked = async (_w, who) => new Map(who.map((a) => [a, true]));
const ALICE = "1EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE";
const find = (r) => [...r.weeks.values()].flatMap((w) => w.slots).flatMap((s) => s.cards).find((c) => c.player === ALICE);
const base = { p: "p", check: "c", picksContract: "1P", knodeGame: null, stakedOf: staked, vhpMovesOf: async () => 0n };

test("E-S-1: a race the race recorder marks 'missed' never lets a card score on its other legs (FC-2's rule)", async () => {
  const day = D3 + 1, sent = day * M.DAY + 3600000, slot = C.slotRound(day, 0), rA = day * 4 + 2, rB = day * 4 + 3;
  const legs = [{ code: C.SHOW, round: rA, producer: OTHER }, { code: C.HALF, round: rA, producer: PA }, { code: C.WIN, round: rB, producer: THIRD }];
  const cardsOf = async (_n, r) => (r === slot ? [{ player: ALICE, legs, time: sent, height: heightAt(sent), changes: 0 }] : []);
  const missed = { final: true, missed: true, note: "no handicap card was recorded for this race" };
  const r = await quiet(() => run({ ...base, head: headAt((day + 1) * M.DAY + 12 * 3600000), out: tmp(), raceDir: raceDir((t) => card(t), (i) => (i === rB ? missed : null)), blockxDir: blockxDir(() => OTHER), cardsOf }));
  const c = find(r);
  assert.notEqual(c.legs[2][4], "void", "a race nobody decided is 'unresolved', not dropped");
  assert.notEqual(c.outcome, "hit", "the 3-leg card scored as a 2-leg card on the legs that hit");
});

test("E-S-2a: a held Block X leg on a card that already missed doesn't hold the card (a miss decides)", async () => {
  const sun = D3 + 6, sent = sun * M.DAY + 22 * 3600000, slot = C.slotRound(sun, 0);
  const R = Math.ceil(heightAt(M.weekStart(4) + 18 * 3600000) / X.ROUND), rS = (sun + 1) * 4;
  const legs = [{ code: C.WIN, round: rS, producer: OTHER }, { code: C.BLOCK, round: R, producer: THIRD }];   // the Win misses
  const cardsOf = async (_n, r) => (r === slot ? [{ player: ALICE, legs, time: sent, height: heightAt(sent), changes: 0 }] : []);
  const vhpMovesOf = async (n) => { if (n === "c") throw new NonCanonicalTransfer("a VHP transfer isn't in the standard encoding"); return 0n; };
  const r = await quiet(() => run({ ...base, vhpMovesOf, head: headAt(M.weekStart(4) + 13 * 3600000), out: tmp(), raceDir: raceDir((t) => card(t)), blockxDir: blockxDir((x) => (x === R ? THIRD : OTHER)), cardsOf }));
  const c = find(r);
  assert.equal(c.state, "final"); assert.equal(c.outcome, "miss");
});

test("E-S-2b: a Block X leg held by one node, on a block in the next week's first day, can't cost the week its Vault file", async () => {
  const sun = D3 + 6, sent = sun * M.DAY + 22 * 3600000, slot = C.slotRound(sun, 0);
  const R = Math.ceil(heightAt(M.weekStart(4) + 18 * 3600000) / X.ROUND), rS = (sun + 1) * 4;
  const legs = [{ code: C.WIN, round: rS, producer: PA }, { code: C.BLOCK, round: R, producer: THIRD }];      // both hit
  const cardsOf = async (_n, r) => (r === slot ? [{ player: ALICE, legs, time: sent, height: heightAt(sent), changes: 0 }] : []);
  const vhpMovesOf = async (n) => { if (n === "c") throw new NonCanonicalTransfer("a VHP transfer isn't in the standard encoding"); return 0n; };
  const rd = raceDir((t) => card(t)), bx = blockxDir((x) => (x === R ? THIRD : OTHER));
  let written = false;
  for (let h = 13; h <= 72 && !written; h++) {        // every hourly run up to the end of the Vault's 3 days
    const r = await quiet(() => run({ ...base, vhpMovesOf, head: headAt(M.weekStart(4) + h * 3600000), out: tmp(), raceDir: rd, blockxDir: bx, cardsOf }));
    written = r.vaultWritten.includes(3);
  }
  assert.ok(written, "week 3's Vault file was never written within the Vault's 3 days (the leg's 3-day edge is after them)");
});

test("D-S-1 strict: a race leg whose OWN producer is flagged on every card at its lock is not scored at its send worth", async () => {
  const mon18 = D3 * 4 + 3, sent = D3 * M.DAY + 3600000, lockAt = M.raceStart(mon18) - C.RACE_LEAD_MS, moved = D3 * M.DAY + 2 * 3600000;
  const legs = [{ code: C.HALF, round: mon18, producer: PA }, { code: C.SHOW, round: mon18, producer: OTHER }];
  const cardsOf = async (_n, r) => (r === C.slotRound(D3, 0) ? [{ player: ALICE, legs, time: sent, height: heightAt(sent), changes: 0 }] : []);
  const cardAt = (t) => card(t, t >= moved ? 4 : 1, t > lockAt - 3 * 3600000 && t <= lockAt ? { flagged: [PA] } : {});
  const c = find(await quiet(() => run({ ...base, head: headAt((D3 + 2) * M.DAY + 12 * 3600000), out: tmp(), raceDir: raceDir(cardAt), blockxDir: blockxDir(() => OTHER), cardsOf })));
  const fair = C.priceLeg(card(lockAt, 4), legs[0]).f100;
  assert.ok(!(c.legs[0][4] === "hit" && c.legs[0][3] > fair), `kept worth ${c.legs[0][3]} (fair at the lock ${fair})`);
  assert.notEqual(c.outcome, "hit");
});

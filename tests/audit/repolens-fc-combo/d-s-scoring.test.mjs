// D-S failing tests (Repo Lense fix-check, Combo scoring @ e0330a1). NOT RUN HERE (static review).
// Run from the repo root:  APP=. node --import tsx --test <this file>   (needs this dir's W001-live.json: a copy of
// origin/race-data:W001.json; set LIVE=<path>). They drive the REAL bot/games/combo.ts run() with fake nodes and files,
// as tests/audit/combo-recorder.test.mjs does. Each FAILS at e0330a1 (see proof.out / proof6.out) and passes once fixed.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
const APP = process.env.APP || ".";
const { run } = await import(path.resolve(APP, "bot/games/combo.ts"));
const { NonCanonicalTransfer } = await import(path.resolve(APP, "bot/games/blockx.ts"));
const M = globalThis.KRaceMath, X = globalThis.KBlockX, C = globalThis.KCombo;
const live = JSON.parse(fs.readFileSync(process.env.LIVE || new URL("./W001-live.json", import.meta.url), "utf8"));
const lc = live.races.flatMap((r) => r.cards || []).filter(Boolean).sort((a, b) => a.at - b.at).pop();
const VHP = [...lc.field.map((r) => [r.a, r.vhp]), ...(lc.paddock || []).map((r) => [r.a, r.vhp])];
const PA = VHP.find(([a]) => a.startsWith("1JrsQXbr"))[0], OTHER = VHP.find(([a]) => a !== PA)[0];
const TINY = VHP.slice().sort((a, b) => a[1] - b[1])[0][0];
const card = (at, mult = 1, extra = {}) => ({ ...M.makeCard(VHP.map(([a, v]) => [a, a === PA ? v * mult : v]), lc.blocksPerRace, at), samples: 12, ...extra });
const W3 = M.weekStart(3), H0 = 48_000_000, D3 = C.utcDay(W3);
const heightAt = (t) => H0 + Math.floor((t - W3) / 3000), timeAt = (h) => W3 + (h - H0) * 3000;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ds-"));
const W = (w) => `W${String(w).padStart(3, "0")}.json`;
const order = [PA, ...VHP.map(([a]) => a).filter((a) => a !== PA)];
function raceDir(cardAt) {
  const d = tmp();
  for (let w = 2; w <= 5; w++) {
    const races = [];
    for (let t = M.weekStart(w); t < M.weekStart(w + 1); t += M.RACE) races.push({ id: M.raceId(M.raceIndex(t)), start: t, end: t + M.RACE, cards: [0, 1, 2, 3, 4, 5].map((l) => cardAt(t + l * M.HOUR + 60000)), result: { final: true, checked: 2, standings: order.map((a, k) => ({ a, steps: 1000 - k, blocks: 10 })) } });
    fs.writeFileSync(path.join(d, W(w)), JSON.stringify({ v: 1, week: w, start: M.weekStart(w), end: M.weekStart(w + 1), races }));
  }
  return d;
}
function blockxDir(signerOf, skip = -1) {
  const d = tmp();
  for (let w = 2; w <= 5; w++) {
    const targets = [];
    for (let r = Math.ceil(heightAt(M.weekStart(w)) / X.ROUND); X.target(r) < heightAt(M.weekStart(w + 1)); r++) if (r !== skip)
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
const mon18 = D3 * 4 + 3, sent = D3 * M.DAY + 3600000;
const BX = Math.floor(heightAt(D3 * M.DAY + 20 * 3600000) / X.ROUND) + 1, bxT = timeAt(X.target(BX));
const slotCards = (legs) => async (_n, r) => (r === C.slotRound(D3, 0) ? [{ player: ALICE, legs, time: sent, height: heightAt(sent), changes: 0 }] : []);
const base = { p: "p", check: "c", picksContract: "1P", knodeGame: null, stakedOf: staked, vhpMovesOf: async () => 0n };
const fixedHead = headAt((D3 + 2) * M.DAY + 12 * 3600000);

test("D-S-1: a race leg with no usable card at its lock does not keep a send worth the lock-time VHP contradicts", async () => {
  const lockAt = M.raceStart(mon18) - C.RACE_LEAD_MS, moved = D3 * M.DAY + 2 * 3600000;
  const legs = [{ code: C.HALF, round: mon18, producer: PA }, { code: C.SHOW, round: mon18, producer: OTHER }];
  const cardAt = (t) => card(t, t >= moved ? 4 : 1, t > lockAt - 3 * 3600000 && t <= lockAt ? { flagged: [TINY] } : {});
  const c = find(await quiet(() => run({ ...base, head: fixedHead, out: tmp(), raceDir: raceDir(cardAt), blockxDir: blockxDir(() => OTHER), cardsOf: slotCards(legs) })));
  const fair = C.priceLeg(card(lockAt, 4), legs[0]).f100;
  assert.ok(c.legs[0][4] !== "hit" || c.legs[0][3] <= fair, `Top-half leg kept worth ${c.legs[0][3]} although the producer's VHP at the lock prices it at ${fair}`);
});

test("D-S-2: one node alone reporting a non-canonical VHP transfer holds a hit Block X leg (BX-100), never voids it", async () => {
  const legs = [{ code: C.SHOW, round: mon18, producer: OTHER }, { code: C.BLOCK, round: BX, producer: PA }];
  const vhpMovesOf = async (node) => { if (node === "c") throw new NonCanonicalTransfer("not the standard encoding"); return 0n; };
  const c = find(await quiet(() => run({ ...base, vhpMovesOf, head: fixedHead, out: tmp(), raceDir: raceDir((t) => card(t)), blockxDir: blockxDir((r) => (r === BX ? PA : OTHER)), cardsOf: slotCards(legs) })));
  assert.notEqual(c.legs[1][4], "void", "one node's word voided a hit");
  assert.notEqual(c.state, "final", "the card turned final (and immutable once published) on one node's word");
});

test("D-S-3: a moved-VHP read that keeps failing raises an error once the week's Vault file is at risk", async () => {
  const legs = [{ code: C.SHOW, round: mon18, producer: OTHER }, { code: C.BLOCK, round: BX, producer: PA }];
  const vhpMovesOf = async (node) => { if (node === "c") throw new Error("receipts: the node returned 150 of 200 blocks"); return 0n; };
  const r = await quiet(() => run({ ...base, vhpMovesOf, head: headAt(M.weekStart(4) + 3 * M.DAY + 3600000), out: tmp(), raceDir: raceDir((t) => card(t)), blockxDir: blockxDir((r) => (r === BX ? PA : OTHER)), cardsOf: slotCards(legs) }));
  assert.equal(r.vaultWritten.length, 0);
  assert.ok(r.errors.length > 0, "week 3 lost its Vault file with warnings only (the job stayed green)");
});

test("D-S-4: a flag on an unrelated producer near the block does not void a Block X leg that hit (Block X's flags(card, signer))", async () => {
  const legs = [{ code: C.SHOW, round: mon18, producer: OTHER }, { code: C.BLOCK, round: BX, producer: PA }];
  const cardAt = (t) => card(t, 1, t > bxT - 4 * 3600000 && t < bxT + 4 * 3600000 ? { flagged: [TINY] } : {});
  const c = find(await quiet(() => run({ ...base, head: fixedHead, out: tmp(), raceDir: raceDir(cardAt), blockxDir: blockxDir((r) => (r === BX ? PA : OTHER)), cardsOf: slotCards(legs) })));
  assert.equal(c.legs[1][4], "hit");
});

test("D-S-6: a Block X target Block X holds (its nodes disagree) never voids a Combo leg at the deadline", async () => {
  const legs = [{ code: C.SHOW, round: mon18, producer: OTHER }, { code: C.BLOCK, round: BX, producer: PA }];
  const r = await quiet(() => run({ ...base, head: headAt(M.weekStart(4) + 2 * M.DAY + 3600000), out: tmp(), raceDir: raceDir((t) => card(t)), blockxDir: blockxDir(() => OTHER, BX), cardsOf: slotCards(legs) }));
  const c = find(r);
  assert.notEqual(c.legs[1][4], "void", "the leg's own target was never decided; one lying node turned a possible miss into a void");
  assert.ok(r.errors.length > 0);
});

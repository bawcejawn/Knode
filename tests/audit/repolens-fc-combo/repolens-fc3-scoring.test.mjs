// G-S failing tests (Repo Lens fix-check 3, Combo scoring and the kept-card re-check @ 8f54c8c). NOT RUN HERE AGAINST
// THE REPOSITORY (static review); run only against reviewer copies in the scratch dir.
// Place as tests/audit/repolens-fc-combo/repolens-fc3-scoring.test.mjs (next to W001-live.json) and run from the root:
//   node --import tsx --test tests/audit/repolens-fc-combo/repolens-fc3-scoring.test.mjs
// They drive the REAL bot/games/combo.ts run() with fake nodes and files, and CHAIN the runs (each run's prev is the
// last run's out, as games-data/combo is), which is what reaches the FC2-1 re-check of kept final cards.
// Lines up to "const base" are repolens-fc2-scoring.test.mjs:7-54 verbatim (repo root from fileURLToPath).
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
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "gs3-"));
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

// ── G-S additions ──
const H = 3600000, BOB = "1BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", CAROL = "1CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const findP = (r, who) => [...r.weeks.values()].flatMap((w) => w.slots).flatMap((s) => s.cards).find((c) => c.player === who);
const bobSlot = C.slotRound(D3 + 2, 0), bobSent = (D3 + 2) * M.DAY + H;
const bobLegs = [{ code: C.WIN, round: (D3 + 2) * 4 + 1, producer: PA }, { code: C.SHOW, round: (D3 + 2) * 4 + 1, producer: OTHER }];
const withBob = (slot, sent, legs) => async (_n, r) => [
  ...(r === slot ? [{ player: ALICE, legs, time: sent, height: heightAt(sent), changes: 0 }] : []),
  ...(r === bobSlot ? [{ player: BOB, legs: bobLegs, time: bobSent, height: heightAt(bobSent), changes: 0 }] : [])];
/** Hourly runs, chained through prev as games-data/combo is. The publish job holds a Vault file until the PUBLISHED
 *  board shows its week final (combo.yml:publish:405); a held file is not published, so it is removed from out here. */
async function chained(steps) {
  let prev, errors = [];
  for (const s of steps) {
    const out = tmp();
    const r = await quiet(() => run({ ...base, ...s.o, head: headAt(s.t), out, ...(prev ? { prev } : {}) }));
    errors.push(...r.errors);
    if (r.vaultWritten.includes(3)) {
      let pb = null; try { pb = JSON.parse(fs.readFileSync(path.join(prev, "board.json"), "utf8")); } catch {}
      if (pb?.lastWeek?.week === 3 && pb.lastWeek.final === true) return { written: true, errors, out };
      fs.rmSync(path.join(out, "vault", "W3.json"));
    }
    prev = out;
  }
  return { written: false, errors };
}
const vaultRuns = (o) => Array.from({ length: 59 }, (_, k) => ({ t: M.weekStart(4) + (13 + k) * H + 52 * 60000, o }));
const mismatch = (errors) => errors.filter((e) => e.includes("doesn't match the race-data and Block X files"));

test("G-S-1a: an honest card that missed while another leg was pending doesn't cost its week the Vault file", async () => {
  const slot = C.slotRound(D3, 0), sent = D3 * M.DAY + 10 * H, rA = D3 * 4 + 2, rB = (D3 + 1) * 4 + 1;
  const legs = [{ code: C.WIN, round: rA, producer: OTHER }, { code: C.SHOW, round: rB, producer: THIRD }];   // the Win misses
  const cardsOf = withBob(slot, sent, legs), bx = blockxDir(() => OTHER);
  const o1 = { raceDir: raceDir((t) => card(t), (i) => (i === rB ? { final: false } : null)), blockxDir: bx, cardsOf };
  const o2 = { raceDir: raceDir((t) => card(t)), blockxDir: bx, cardsOf };
  const r = await chained([{ t: (D3 + 1) * M.DAY + 52 * 60000, o: o1 }, { t: (D3 + 1) * M.DAY + 12 * H + 52 * 60000, o: o2 }, ...vaultRuns(o2)]);
  assert.deepEqual(mismatch(r.errors), [], "an honest kept 'miss' card is reported as not matching its sources");
  assert.ok(r.written, "week 3's Vault file was never written (BOB's hit is never paid)");
});

test("G-S-1b: a Block X leg both nodes call non-canonical (unresolved, card void) doesn't cost its week the Vault file", async () => {
  const day = D3 + 1, sent = day * M.DAY + H, slot = C.slotRound(day, 0);
  const R = Math.ceil(heightAt(day * M.DAY + 10 * H) / X.ROUND), rS = day * 4 + 2;
  const legs = [{ code: C.WIN, round: rS, producer: PA }, { code: C.BLOCK, round: R, producer: THIRD }];
  const vhpMovesOf = async () => { throw new NonCanonicalTransfer("a VHP transfer isn't in the standard encoding"); };
  const o = { vhpMovesOf, raceDir: raceDir((t) => card(t)), blockxDir: blockxDir((x) => (x === R ? THIRD : OTHER)), cardsOf: withBob(slot, sent, legs) };
  const r = await chained([{ t: (day + 1) * M.DAY + 52 * 60000, o }, ...vaultRuns(o)]);
  assert.deepEqual(mismatch(r.errors), []);
  assert.ok(r.written, "week 3's Vault file was never written");
});

test("G-S-1c: E-S-2b chained: a held Block X leg ended at the FC2-3 edge doesn't cost its week the Vault file", async () => {
  const sun = D3 + 6, sent = sun * M.DAY + 22 * H, slot = C.slotRound(sun, 0);
  const R = Math.ceil(heightAt(M.weekStart(4) + 18 * H) / X.ROUND), rS = (sun + 1) * 4;
  const legs = [{ code: C.WIN, round: rS, producer: PA }, { code: C.BLOCK, round: R, producer: THIRD }];
  const vhpMovesOf = async (n) => { if (n === "c") throw new NonCanonicalTransfer("a VHP transfer isn't in the standard encoding"); return 0n; };
  const o = { vhpMovesOf, raceDir: raceDir((t) => card(t)), blockxDir: blockxDir((x) => (x === R ? THIRD : OTHER)), cardsOf: withBob(slot, sent, legs) };
  const r = await chained(vaultRuns(o));
  assert.ok(r.written, "week 3's Vault file was never written within the Vault's 3 days");
});

test("G-S-1d: a card that missed with a Block X leg still held is not 'forged' when the leg's price later drops", async () => {
  const day = D3 + 1, sent = day * M.DAY + H, slot = C.slotRound(day, 0), grow = day * M.DAY + 3 * H;
  const R = Math.ceil(heightAt(day * M.DAY + 10 * H) / X.ROUND), rS = day * 4 + 2;
  const legs = [{ code: C.WIN, round: rS, producer: OTHER }, { code: C.BLOCK, round: R, producer: PA }];
  const vhpMovesOf = async (n) => { if (n === "c") throw new NonCanonicalTransfer("a VHP transfer isn't in the standard encoding"); return 0n; };
  const o = { vhpMovesOf, raceDir: raceDir((t) => card(t, t >= grow ? 40 : 1)), blockxDir: blockxDir((x) => (x === R ? PA : OTHER)), cardsOf: withBob(slot, sent, legs) };
  const r = await chained([{ t: (day + 1) * M.DAY + 52 * 60000, o }, ...vaultRuns(o)]);
  assert.deepEqual(mismatch(r.errors), []);
  assert.ok(r.written);
});

// A bad record run makes BOB's and CAROL's equal cards final, with BOB's edited; honest runs follow.
async function forgedThenHonest(edit) {
  const day = D3 + 2, slot = C.slotRound(day, 0), sent = day * M.DAY + H;
  const R = Math.ceil(heightAt(day * M.DAY + 10 * H) / X.ROUND), rS = day * 4 + 2;
  const legs = [{ code: C.WIN, round: rS, producer: PA }, { code: C.BLOCK, round: R, producer: THIRD }];
  const cardsOf = async (_n, r) => (r === slot ? [BOB, CAROL].map((p, k) => ({ player: p, legs, time: sent + k * 60000, height: heightAt(sent + k * 60000), changes: 0 })) : []);
  const o = { raceDir: raceDir((t) => card(t)), blockxDir: blockxDir((x) => (x === R ? THIRD : OTHER)), cardsOf };
  const bad = tmp();
  await quiet(() => run({ ...base, ...o, head: headAt((day + 1) * M.DAY + 52 * 60000), out: bad }));
  const fn = path.join(bad, `D${String(day).padStart(5, "0")}.json`), f = JSON.parse(fs.readFileSync(fn, "utf8"));
  edit(f.slots.find((s) => s.round === slot).cards.find((c) => c.player === BOB));
  fs.writeFileSync(fn, JSON.stringify(f) + "\n");
  const out = tmp();
  const r = await quiet(() => run({ ...base, ...o, head: headAt(M.weekStart(4) + 13 * H + 52 * 60000), prev: bad, out }));
  return { r, rows: r.board.lastWeek.rows };
}

test("G-S-2: a kept final card whose Block X worth a bad run LOWERED (results unchanged) is caught, not paid as published", async () => {
  const { r, rows } = await forgedThenHonest((b) => { b.legs[1][3] = 25; b.pts = C.pointsFor(b.legs.map((l) => l[3])); });
  const bob = rows.find((x) => x.a === BOB), carol = rows.find((x) => x.a === CAROL);
  assert.ok(mismatch(r.errors).length > 0 || (bob && bob.pts === carol.pts),
    `BOB's equal card counts ${bob?.pts} (CAROL ${carol?.pts}) with no error: one bad run moved a rival down the Vault's order`);
});

test("G-S-3: a kept final hit whose `settled` a bad run moved earlier (tie-break) is caught", async () => {
  const { r, rows } = await forgedThenHonest((b) => { b.settled = 1; });
  const bob = rows.find((x) => x.a === BOB), carol = rows.find((x) => x.a === CAROL);
  assert.ok(mismatch(r.errors).length > 0 || bob?.place === carol?.place, `BOB place ${bob?.place}, CAROL place ${carol?.place}, no error`);
});

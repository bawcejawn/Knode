// Reviewer G-R failing tests (node:test). NOT RUN HERE against the repository (static review): they ran only on a
// verbatim scratch copy. Place in tests/audit/repolens-fc-combo/ next to D-R.fixtures.mjs. They import the REAL
// bot/games/combo.ts (repo root resolved from this file's URL, or $APP) through the owner's fixtures and koilib fake.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import path from "node:path";
import { fileURLToPath } from "node:url";
process.env.APP ||= fileURLToPath(new URL("../../../", import.meta.url));
const { run, M, X, C, H1, H2, H3, ALICE, BOB, W3, heightAt, raceDir, blockxDir, node, quiet, read, tmp, VAULT, PICKS } = await import("./D-R.fixtures.mjs");
const D3 = C.utcDay(W3), S0 = C.slotRound(D3, 0), dn = (d) => `D${String(d).padStart(5, "0")}.json`;
const mismatch = (r) => r.errors.filter((e) => /doesn't match the race-data/.test(e));
const go = (t, cards, o = {}) => { const out = tmp(); return quiet(() => run({ p: node({ t, cards }), check: node({ t, cards }), out, raceDir: raceDir(), blockxDir: blockxDir(), picksContract: PICKS, knodeGame: VAULT, now: t, vhpMovesOf: async () => 0n, ...o })).then((r) => ({ r, out })); };

test("G-R-1: an honest card that missed early (FC2-3) with a leg still pending is not a 'forged' card once that leg finishes; its week gets its Vault file", async () => {
  const r6 = D3 * 4 + 1, sent = D3 * M.DAY + 2 * 3600000;
  const cards = (r) => (r === S0 ? [{ player: ALICE, legs: [{ code: C.WIN, round: r6, producer: H2 }, { code: C.SHOW, round: r6 + 1, producer: H1 }, { code: C.SHOW, round: D3 * 4 + 9, producer: H3 }], time: sent, height: heightAt(sent), changes: 0 }] : []);
  const tA = (D3 + 1) * M.DAY + 2 * 3600000;
  const A = await go(tA, cards, { raceDir: raceDir({ resultsUntil: tA }) });          // the third leg's race isn't run yet
  const c = read(A.out, dn(D3)).slots.find((s) => s.round === S0).cards[0];
  assert.equal(c.state, "final"); assert.equal(c.outcome, "miss"); assert.equal(c.legs[2][4], "pending");
  const B = await go((D3 + 3) * M.DAY, cards, { prev: A.out });                       // that race has finished
  assert.deepEqual(mismatch(B.r), [], "the recorder's own honest final card is reported as not matching its sources");
  const Cw = await go(M.weekStart(4) + 13 * 3600000, cards, { prev: B.out });
  assert.deepEqual(Cw.r.vaultWritten, [3], "week 3's Vault file is never written because of an honest early miss");
});

test("G-R-1b: a Block X leg left unresolved by the hold edge (one node's VHP read kept failing) is not 'forged' on the next run", async () => {
  const sent = D3 * M.DAY + 13 * 3600000, rf = D3 * 4 + 3, blockT = D3 * M.DAY + 20 * 3600000, R = Math.ceil(heightAt(blockT) / X.ROUND), signer = R % 2 === 0 ? H1 : H2, other = signer === H1 ? H2 : H1;
  const cards = (r) => (r === S0 ? [{ player: ALICE, legs: [{ code: C.SHOW, round: rf, producer: other }, { code: C.SHOW, round: rf - 1, producer: H3 }, { code: C.BLOCK, round: R, producer: signer }], time: sent, height: heightAt(sent), changes: 0 }] : []);
  const tA = blockT + 3 * M.DAY + 3600000, out = tmp(), q = node({ t: tA, cards });
  await quiet(() => run({ p: node({ t: tA, cards }), check: q, out, raceDir: raceDir(), blockxDir: blockxDir(), picksContract: PICKS, knodeGame: VAULT, now: tA,
    vhpMovesOf: async (n) => { if (n === q) throw new Error("rpc: no answer"); return 0n; } }));
  assert.equal(read(out, dn(D3)).slots.find((s) => s.round === S0).cards[0].legs[2][4], "unresolved");
  const B = await go(tA + 3600000, cards, { prev: out });
  assert.deepEqual(mismatch(B.r), [], "a card the recorder itself made final void (unresolved by design) is reported as not matching");
});

test("G-R-2: a published final card with a rival's Block X worth pushed down, or an earlier `settled`, is caught by the kept-card re-check", async () => {
  const sent = D3 * M.DAY + 13 * 3600000, rf = D3 * 4 + 3, blockT = D3 * M.DAY + 20 * 3600000, R = Math.ceil(heightAt(blockT) / X.ROUND), signer = R % 2 === 0 ? H1 : H2, other = signer === H1 ? H2 : H1;
  const legs = [{ code: C.SHOW, round: rf, producer: other }, { code: C.SHOW, round: rf - 1, producer: H3 }, { code: C.BLOCK, round: R, producer: signer }];
  const cards = (r) => (r === S0 ? [ALICE, BOB].map((player) => ({ player, legs, time: sent, height: heightAt(sent), changes: 0 })) : []);
  const t = M.weekStart(4) + 13 * 3600000, A = await go(t, cards);
  for (const edit of [(c) => { if (c.player === BOB) { c.legs[2][3] = 26; c.pts = C.pointsFor(c.legs.map((l) => l[3])); } }, (c) => { if (c.player === ALICE) c.settled -= 3600000; }]) {
    const F = tmp(); for (const f of fs.readdirSync(A.out)) if (f.endsWith(".json")) fs.copyFileSync(path.join(A.out, f), path.join(F, f));
    const j = read(F, dn(D3)); j.slots.forEach((s) => s.cards.forEach(edit)); fs.writeFileSync(path.join(F, dn(D3)), JSON.stringify(j) + "\n");
    const B = await go(t + 3600000, cards, { prev: F });
    assert.ok(mismatch(B.r).length > 0, "a published final card whose worth or settled time isn't what its sources give passed the re-check: " + edit);
  }
});

test("G-R-T1 (C-R-1 with the true clock): the deadline uses the SLOWER node's head, also when the lie is inside the clock slack", async () => {
  const deadline = M.weekStart(4) + 2 * M.DAY, sun18 = (D3 + 6) * 4 + 3, r6 = D3 * 4 + 1, sent = D3 * M.DAY + 2 * 3600000;
  const legs = [{ code: C.WIN, round: r6, producer: H1 }, { code: C.SHOW, round: r6 + 1, producer: H2 }, { code: C.WIN, round: sun18, producer: H3 }];
  const cards = (r) => (r === S0 ? [{ player: ALICE, legs, time: sent, height: heightAt(sent), changes: 0 }] : []);
  const now = deadline - 4 * 60000, out = tmp();                                       // true time: 4 minutes before the deadline
  await quiet(() => run({ p: node({ t: now, headTime: deadline + 5 * 60000, cards }), check: node({ t: now, cards }), out, raceDir: raceDir({ noResult: new Set([sun18]) }), blockxDir: blockxDir(), picksContract: PICKS, knodeGame: VAULT, now, vhpMovesOf: async () => 0n }));
  const c = read(out, dn(D3)).slots.find((s) => s.round === S0).cards[0];
  assert.equal(c.legs[2][4], "pending", "one node's head time (9 minutes ahead, inside the clock slack) triggered the deadline");
  assert.equal(c.state, "pending");
});

// Repo Lense fix-check round 2, reviewer M-W: watch-and-hold (LNF-8/LNF-9). NOT RUN HERE (static review).
// Part A drives the REAL watchWeek (bot/games/lastnode.ts). Part B is meant to be appended to
// tests/audit/lastnode-vault.test.mjs and uses its helpers (publisher, history, vgood, linux), which run the REAL
// publish shell from .github/workflows/lastnode.yml against a throwaway repository.
// Thresholds marked OWNER are yours to set; these fail at 7c301a8 by design.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { fileURLToPath, pathToFileURL } from "node:url";
const APP = fileURLToPath(new URL("../..", import.meta.url));
const { watchWeek } = await import(pathToFileURL(path.resolve(APP, "bot/games/lastnode.ts")).href);
const L = globalThis.KLastNode;
const A = (c) => "1" + c.repeat(33);
const NODES = ["A", "B", "C", "D", "E", "F", "G", "H", "J", "K"].map(A);
const KH = [160, 140, 120, 100, 90, 80, 60, 50, 40, 30];
const H = 3600000;

// A week of 7 honest events: every node's true rate = kh x drift (drift = exp(sigma x normal), per node per event:
// real blocks show ~10% day-to-day spread beyond Poisson; 5% is used here), Poisson per hour. Field without form.
function honestWeek(R, sigma, bias = () => 1) {
  const field = { at: 0, c: 0, fairness: null, nodes: NODES.map((a, i) => ({ a, vhp: KH[i] * 10, kh: KH[i], h: Math.round((KH[0] / KH[i]) * 1e4) / 1e4 })) };
  const evs = [];
  for (let d = 0; d < 7; d++) {
    const drift = NODES.map((a) => Math.exp(sigma * R.normal()) * bias(a));
    const hours = Array.from({ length: NODES.length - 1 }, (_, i) => ({ i, from: 0, to: 0, checked: 2, blocks: Object.fromEntries(NODES.map((a, k) => [a, R.poisson(KH[k] * drift[k])])) }));
    const res = L.cutsFrom(field, hours);
    evs.push({ field, hours, cuts: res.cuts, winner: res.winner, done: res.done });
  }
  return evs;
}

test("M-W-n1: an honest week with 5% day-to-day spread is rarely held (OWNER: at most 2% of weeks)", () => {
  const R = L.rng(1); let held = 0; const N = 300;
  for (let k = 0; k < N; k++) if (watchWeek(honestWeek(R, 0.05), H).length) held++;
  assert.ok(held / N <= 0.02, `${held} of ${N} honest weeks held`);
});

test("M-W-n1: mainnet without form (no race-samples yet): steady 78%-108% reliability is not a hold (OWNER: at most 2%)", () => {
  const R = L.rng(2); let held = 0; const N = 300;
  for (let k = 0; k < N; k++) { const b = new Map(NODES.map((a) => [a, 0.78 + 0.3 * R.next()])); if (watchWeek(honestWeek(R, 0, (a) => b.get(a)), H).length) held++; }
  assert.ok(held / N <= 0.02, `${held} of ${N} honest weeks held`);
});

// Owner decision (fix-check round 2, N-6): a week of blocks shows a steady 3% edge at only about z = 2.4, so no rule
// catches it in half the weeks while holding at most 2% of honest weeks (M-W-n1 above). The rule now in watchWeek
// (z >= 3.4 over the week with 2 wins, or z >= 5 in one won event) catches it in about 13% of weeks, and a single gamed
// event in 98%. Kept as the reviewer wrote it, as a TODO, until the owner picks a longer window or another trade-off.
test("LNF-8 residual: a node whose form is 3% low (it skipped 3% in the form window) and signs fully is caught (OWNER: in at least half the weeks)", { todo: "owner accepted 2026-10-30: a 3% edge over one week is below what a week of blocks can show (caught ~13%; see FIXCHECK-2-FIXES.md)" }, () => {
  // The gamer's field multiplier expects 0.97 x its true rate: equivalent to signing 1/0.97 of kh in the race.
  const R = L.rng(3); let caught = 0; const N = 200, G = NODES[3];
  for (let k = 0; k < N; k++) if (watchWeek(honestWeek(R, 0, (a) => (a === G ? 1 / 0.97 : 1)), H).some((x) => x.a === G)) caught++;
  assert.ok(caught / N >= 0.5, `caught in ${caught} of ${N} weeks`);
});

// ── Part B: append to tests/audit/lastnode-vault.test.mjs (uses its publisher(), history(), vgood, linux) ──
/*
linux("M-W-n2: a week held on games-data can't be filed by a later run unless the owner released it", () => {
  const pub = publisher();
  pub.seed({ ...history(), "vault/HOLD-W3.json": { game: 13, week: 3, nodes: [{ a: NODES[3], q: 1.6, wins: 3, events: 3 }], why: "held" } });
  const r = pub.publish({ ...history(), "vault/W3.json": vgood });                          // a bad record run: W3, no HOLD
  assert.notEqual(r.status, 0, r.out); assert.equal(pub.show("vault/W3.json"), null, "the held week stays unfiled");
  const ok = pub.publish({ ...history(), "vault/W3.json": vgood }, { LASTNODE_RELEASE_WEEKS: "3" });   // released: filed
  assert.equal(ok.status, 0, ok.out); assert.ok(pub.show("vault/W3.json"));
});
linux("M-W-n2: one run can't publish both HOLD-W<week> and W<week>", () => {
  const pub = publisher(); pub.seed(history());
  const r = pub.publish({ ...history(), "vault/W3.json": vgood, "vault/HOLD-W3.json": { game: 13, week: 3, nodes: [{ a: NODES[3], q: 1.6, wins: 3, events: 3 }], why: "held" } });
  assert.notEqual(r.status, 0); assert.equal(pub.show("vault/W3.json"), null);
});
linux("M-W-n2: the publish job recomputes the hold from the replayed day files (a week whose days flag a node needs HOLD or a release)", () => {
  // Build last week's day files where one node signs 1.6x its kh and wins every event (see M-W pub/hold-bypass.cjs),
  // publish them with W3 and no HOLD: must be refused unless LASTNODE_RELEASE_WEEKS lists 3.
});
*/

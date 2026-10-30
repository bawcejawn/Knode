// Shared helpers for the Last Node Standing form tests (lastnode-form.test.mjs and the round-2 reviewer's tests): the
// fast test game's event, hourly race cards before it, 48 h of block counts, and race-samples snapshots.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
export const APP = process.env.APP || fileURLToPath(new URL("../..", import.meta.url));
await import(path.resolve(APP, "race-math.js")); await import(path.resolve(APP, "lastnode-math.js"));
export const M = globalThis.KRaceMath, L0 = globalThis.KLastNode;
export const F = L0.forGame(L0.FAST_GAME);
export const A = (c) => "1" + c.repeat(33);
export const [N1, N2, N3, N4, P5] = ["A", "B", "C", "D", "E"].map(A);
export const EV = F.eventOf("2026-11-03T08"), H = 3600000;
export function raceDir(extra = []) {
  // Hourly cards for the 48 hours before the field's card (N1 half the VHP, N2 a quarter, N3 and N4 an eighth each),
  // plus the field's own card.
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "race-f-"));
  const fieldRows = [{ a: N1, vhp: 4000, k: 1200 }, { a: N2, vhp: 2000, k: 600 }, { a: N3, vhp: 1000, k: 300 }, { a: N4, vhp: 1000, k: 300 }];
  const byWeek = {};
  const put = (t, card) => {
    const w = M.weekOf(t), rs = (byWeek[w] ||= (() => { const races = []; for (let s = M.weekStart(w); s < M.weekStart(w + 1); s += M.RACE) races.push({ id: M.raceId(M.raceIndex(s)), start: s, end: s + M.RACE, cards: new Array(6).fill(null), result: null }); return races; })());
    const race = rs.find((r) => r.start <= t && t < r.end);
    race.cards[M.legOf(race.start, t, 6)] = card;
  };
  for (let t = EV.cardTime - 48 * H; t < EV.cardTime; t += H) put(t, { at: t, field: fieldRows, paddock: [] });
  put(EV.cardTime, { at: EV.cardTime + 60000, field: fieldRows, paddock: [] });
  for (const c of extra) put(c.at, c);
  for (const [w, races] of Object.entries(byWeek)) fs.writeFileSync(path.join(d, `W${String(w).padStart(3, "0")}.json`), JSON.stringify({ v: 1, week: Number(w), races }));
  return d;
}
// Per hour: 1000 blocks; N4 signs 80% of its share and P5 (not in the field) the rest.
export const hourOf = { [N1]: 500, [N2]: 250, [N3]: 125, [N4]: 100, [P5]: 25 };
export const hoursOf = (bad) => async (node, t0, n) => {
  assert.equal(n, 48);
  if (t0 !== EV.cardTime - 48 * H) return Array.from({ length: n }, () => ({}));   // other events in the window: no form
  return Array.from({ length: n }, (_, k) => (bad && node === "check" && k === 7 ? { ...hourOf, [N1]: 499 } : { ...hourOf }));
};
// Fix-check LNF-4: the form's VHP shares come from the 5-minute samples (12 an hour, as race-samples keeps them).
export function samplesDir(vhpOf = () => ({ [N1]: 4000, [N2]: 2000, [N3]: 1000, [N4]: 1000 }), from = EV.cardTime - 48 * H, to = EV.cardTime) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "samples-")), all = [];
  for (let t = from; t < to; t += 5 * 60000) all.push({ at: t, height: 1, vhp: Object.fromEntries(Object.entries(vhpOf(t)).map(([a, v]) => [a, String(Math.round(v * 1e8))])) });
  // Two overlapping snapshots, as the workflow takes them from the branch's history.
  fs.writeFileSync(path.join(d, "S0.json"), JSON.stringify({ v: 1, updated: "x", samples: all.slice(0, 400) }));
  fs.writeFileSync(path.join(d, "S1.json"), JSON.stringify({ v: 1, updated: "x", samples: all.slice(380) }));
  return d;
}
export const base = (extra) => ({ p: "main", check: "check", game: L0.FAST_GAME, picksContract: null, samplesDir: samplesDir(), windowOf: async () => { throw new Error("not irreversible yet"); },
  picksOf: async () => [], rankedOf: async (w) => new Set(w), trials: 300, allowNoForm: true, ...extra });   // the launch gate has its own tests (M-F-3)


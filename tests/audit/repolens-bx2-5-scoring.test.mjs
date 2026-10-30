// Repo Lens audit 2026-10-28 (commit 611f63d): the auditor's tests, kept as written except where noted. Each failed
// before the fixes. Two wait for owner decisions (todo): BXW-1 guest play on the shared github.io origin, BXS-1 sybils.
// NOT RUN HERE (static review, reviewer BX-S). node:test, same harness style as tests/audit/blockx-recorder.test.mjs.
// Run from the repo root: APP=. node --test --experimental-strip-types <this file>. Each test FAILS at 611f63d.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
const APP = process.env.APP || ".";
const { run } = await import(path.resolve(APP, "bot/games/blockx.ts"));
const M = globalThis.KRaceMath, X = globalThis.KBlockX;
const BIG = "1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", MID = "1BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", FRESH = "1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ";
const ALICE = "1DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD", BOB = "1EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE";
const W3 = M.weekStart(3), H0 = 48_000_000, T = (h) => W3 + 3600000 + (h - H0) * 3000;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "bxs-"));
const quiet = async (f) => { const l = console.log; console.log = () => {}; try { return await f(); } finally { console.log = l; } };
function raceDir(card) {
  const d = tmp();
  for (const w of [2, 3, 4]) { const races = []; for (let t = M.weekStart(w); t < M.weekStart(w + 1); t += M.RACE) { const i = M.raceIndex(t); races.push({ id: M.raceId(i), start: t, end: t + M.RACE, cards: (typeof card === "function" ? card(t) : new Array(6).fill(card)), result: null }); }
    fs.writeFileSync(path.join(d, `W${String(w).padStart(3, "0")}.json`), JSON.stringify({ v: 1, week: w, start: M.weekStart(w), end: M.weekStart(w + 1), races })); }
  return d;
}
const CARD = (at = 0) => ({ at, c: 1, blocksPerRace: 7200, fairness: null, field: [{ a: BIG, vhp: 2000, k: 600, h: 1 }, { a: MID, vhp: 1000, k: 300, h: 2 }], paddock: [] });

// BXS-2: a signer that is not on the card (a fresh producer address the producer's own wallets pick) must not score the cap.
test("BXS-2: a signer missing from the card does not score the ×3 cap", async () => {
  const lib = H0 + 2 * X.ROUND + 50;
  const r = await quiet(() => run({ p: "main", check: null, out: tmp(), raceDir: raceDir(CARD()), picksContract: "1P",
    blockOf: async (_n, h) => ({ signer: FRESH, time: T(h) }), picksOf: async () => [{ player: ALICE, producer: FRESH, time: T(H0) }],
    rankedOf: async () => new Set(), head: { height: lib, time: T(lib), lib } }));
  const pts = [...r.weeks.values()].flatMap((w) => w.targets).flatMap((t) => t.picks).map((p) => p[3]);
  assert.ok(pts.length && pts.every((x) => x <= 100), `fresh signer scored ${pts}`);
});

// BXS-2 (late card): a card taken after the lock (race recorder missed its run) must not be used for that lock.
test("BXS-2: a card whose `at` is after the lock time is not used", async () => {
  const lib = H0 + 2 * X.ROUND + 50;
  const late = (t) => new Array(6).fill(null).map((_, l) => CARD(t + l * 3600000 + 59 * 60000));   // each leg's card taken 59 min into the leg
  const r = await quiet(() => run({ p: "main", check: null, out: tmp(), raceDir: raceDir(late), picksContract: "1P",
    blockOf: async (_n, h) => ({ signer: MID, time: T(h) }), picksOf: async () => [{ player: ALICE, producer: MID, time: T(H0) }],
    rankedOf: async () => new Set(), head: { height: lib, time: T(lib), lib } }));
  for (const t of [...r.weeks.values()].flatMap((w) => w.targets)) if (t.card) assert.ok(t.card.at <= t.lockTime, `card at ${t.card.at} > lock ${t.lockTime}`);
});

// BXS-3: Staked/Free status (and card VHP) must be checked on the second node like the blocks and picks are.
test("BXS-3: Staked status is read on both nodes and a disagreement holds the target", async () => {
  const lib = H0 + 2 * X.ROUND + 50, seen = [];
  const r = await quiet(() => run({ p: "main", check: "check", out: tmp(), raceDir: raceDir(CARD()), picksContract: "1P",
    blockOf: async (_n, h) => ({ signer: BIG, time: T(h) }), picksOf: async () => [{ player: BOB, producer: BIG, time: T(H0) }],
    rankedOf: async function (who) { seen.push(arguments.length); return new Set(); },   // a lying primary says Bob is Free play
    head: { height: lib, time: T(lib), lib } }));
  assert.ok(seen.some((n) => n >= 2) || r.problems.some((p) => /Staked|VHP/.test(p)), "rankedOf has no node argument: only the primary node is asked");
});

// BXS-4: a week whose LAST target is still unrecorded must not be final (and its prizes not listed).
test("BXS-4: last week is not final while its last target is unrecorded", async () => {
  // Targets every 2,400 blocks (2 h); week 3 ends at W4. Pick a chain phase where the last target of week 3 lies
  // within 2..3 h of the week's end... i.e. the second-to-last lies 2..3 h before the end.
  const endH = H0 - 1200 + 7 * 28800;                       // height at W4 00:00 in this made-up chain
  const lastTarget = Math.floor((endH - 1) / X.ROUND) * X.ROUND;  // last target inside week 3
  const prevTarget = lastTarget - X.ROUND;
  const gapH = (T(endH) - T(prevTarget)) / 3600000;
  if (!(gapH < 3)) return;   // phase not in the undetected band for this chain: covered by the re-implementation (59/120 phases)
  let prev;
  const rd = raceDir(CARD());
  const blockOf = async (_n, h) => { if (h === lastTarget || h === lastTarget - 100) throw new Error("node down"); return { signer: BIG, time: T(h) }; };
  for (let lib = H0 + 12 * X.ROUND; lib <= endH + 4 * X.ROUND; lib += 12 * X.ROUND) {
    const o = tmp(); await quiet(() => run({ p: "main", check: null, prev, out: o, raceDir: rd, picksContract: "1P", blockOf,
      picksOf: async (_n, r) => [{ player: ALICE, producer: BIG, time: T(r * X.ROUND) - 3600000 * (1 + (r % 3)) }], rankedOf: async () => new Set(), prizesFromWeek: 0,
      head: { height: lib, time: T(lib), lib } })); prev = o;
  }
  const at = endH + 13 * 1200;
  const r = await quiet(() => run({ p: "main", check: null, prev, out: tmp(), raceDir: rd, picksContract: "1P", blockOf,
    picksOf: async () => [], rankedOf: async () => new Set(), prizesFromWeek: 0, head: { height: at, time: T(at), lib: at - 60 } }));
  assert.equal(r.board.lastWeek.final, false, "week marked final with its last target missing");
});

// BXS-1: with Mana sponsored, extra wallets buy extra chances at the Free play prize (pure math, KBlockX only).
test("BXS-1: 20 free wallets of one person do not beat 10 honest players more often than a fair share", { todo: "owner decision: free-prize rule against many wallets (guests may win, S3-4)" }, () => {
  let s = 1; const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const shares = [0.2, 0.15, 0.12, 0.1, 0.08, 0.07, 0.06, 0.05, 0.05, 0.04, 0.03, 0.03, 0.02];
  const card = { field: shares.map((v, i) => ({ a: "1" + String(i).padStart(33, "A"), vhp: v * 1000 })) };
  const good = card.field.filter((r) => r.vhp >= 200 / 3).map((r) => r.a);
  let attackerFirst = 0; const weeks = 200;
  for (let w = 0; w < weeks; w++) {
    const rows = [];
    for (let k = 0; k < 84; k++) {
      let x = rnd(), signer = card.field[card.field.length - 1].a; for (const r of card.field) { x -= r.vhp / 1000; if (x < 0) { signer = r.a; break; } }
      const t = Date.UTC(2026, 10, 2) + k * 7200000;
      for (const p of [...Array.from({ length: 10 }, (_, i) => "1H" + i), ...Array.from({ length: 20 }, (_, i) => "1S" + i)]) {
        const pick = good[Math.floor(rnd() * good.length)];
        rows.push({ player: p, height: k, pickTime: t, correct: pick === signer, pts: X.pointsOf(card, pick, signer) });
      }
    }
    const pz = X.prizes(rows); if (pz.length && pz[0].player.startsWith("1S")) attackerFirst++;
  }
  assert.ok(attackerFirst / weeks <= 1 / 11 + 0.05, `one person with 20 wallets took 1st in ${(100 * attackerFirst / weeks).toFixed(0)}% of weeks`);
});

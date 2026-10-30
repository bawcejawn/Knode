// Repo Lense Survivor pass 3, reviewer V-R. Failing tests for V-R-1 and V-R-2.
// Meant for tests/audit/ (APP = repo root): NOT RUN against the repo here (static review). They drive the real
// bot/games/survivor.ts run(); fake nodes only, no network.
// (Run here only against a byte-identical copy in scratch: APP=<scratch>/sim node --experimental-strip-types --test ...)
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const APP = process.env.APP || path.resolve(import.meta.dirname, "../..");
const { run } = await import(path.resolve(APP, "bot/games/survivor.ts"));
const S = globalThis.KSurvivor;
const A = (c) => "1" + c.repeat(33);
const PRODS = ["A", "B", "C", "D", "E"].map(A);
const PLAYERS = ["J", "K", "L", "M", "N"].map(A);
const FIRST = S.dayIndex(Date.parse("2026-11-16T00:00:00Z"));           // Monday, vault week 4
const T0 = S.dayStart(FIRST - 10), T = (h) => T0 + h * 3000, H = (t) => Math.ceil((t - T0) / 3000);
const z = (d) => PRODS[d % 5];
const signerAt = (h) => { const d = S.dayIndex(T(h)); return PRODS.filter((p) => p !== z(d))[h % 4]; };
const blocksOf = async (_n, a, b) => { const ts = [], signers = []; for (let h = a; h <= b; h++) { ts.push(T(h)); signers.push(signerAt(h)); } return { ts, signers }; };
const timeOf = async (_n, h) => T(h);
const picksOf = async (_n, d) => PLAYERS.map((p, i) => ({ player: p, producer: PRODS[(d + i + 1) % 5] === z(d) ? PRODS[(d + i + 2) % 5] : PRODS[(d + i + 1) % 5], time: S.lockTime(d) - 3600000 }));
const GAME3 = { id: 3, kind: 1, list_size: 1, lock_mode: 2, round_size: String(S.DAY), round_offset: "0", lead: String(S.LEAD_MS), ahead: String(S.AHEAD_MS), max_picks_per_day: 20, max_changes: 5, enabled: true };
const headAt = (t) => { const height = H(t), lib = height - 20; return { height, time: T(height), lib, libTime: T(lib) }; };
const quiet = async (f) => { const log = console.log; console.log = () => {}; try { return await f(); } finally { console.log = log; } };
const base = (out, t, o) => ({ p: "main", check: "check", prev: out, out, firstDay: FIRST, picksContract: A("P"), blocksOf, timeOf, picksOf,
  rankedOf: async (_n, who) => new Set(who), gameOf: async () => GAME3, stakedOf: async (_n, who) => new Set(who.slice(0, 1)),
  vaultOf: async () => null,       // (added on merge: fake nodes, so no real vault read)
  head: headAt(t), ...o });
const hourly = (from, to) => { const xs = []; for (let t = from; t < to; t += 3600000) xs.push(t); return xs; };

test("V-R-2: game 3's running vault totals differing between the nodes don't block the vault files", async () => {
  // Same settings on both nodes; only game 3's stake (all stake + pending in the game) differs, as it does whenever a
  // deposit_to / withdraw_from / move_stake of game 3 lands between the two reads, or the check node is a few blocks behind.
  const G = 20745 * 86400000, WEEK = 7 * 86400000;
  const g3 = (stake) => ({ id: 3, name: "Survivor", staked: true, free_prize: true, active: true, from_week: "4", last_week_plus_one: "0",
    rolled: "0", stake, week_stake: "4000000000", week: "6", next_stake: "0", next_week: "0", season_weeks: 2, prize_held: "300000000" });
  const vaultOf = async (node) => ({ genesis: G, weekLen: WEEK, game3: g3(node === "check" ? "4900000000" : "5000000000") });
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "vr2-")), "survivor");
  let r;
  for (const t of hourly(S.dayStart(FIRST - 1) + 60000, S.dayStart(FIRST + 17))) r = await quiet(() => run(base(out, t, { vaultOf })));
  assert.ok(!r.problems.some((p) => /disagree about the vault's settings/.test(p)), r.problems.join("\n"));
  assert.ok(fs.existsSync(path.join(out, "vault", "W4.json")) && fs.existsSync(path.join(out, "vault", "W5.json")), "both weeks' vault files by the vault's results deadline");
});

test("V-R-1: a season day whose checks take longer than one run's budget is still recorded in the end", async () => {
  // Day 1's VHP check takes 300 ms (a big day 1 on real nodes: ~15,000 wallets at 100 ms a read); the budget is 200 ms.
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "vr1-")), "survivor");
  const slow = async (_n, who) => { await new Promise((res) => setTimeout(res, 150)); return new Set(who); };   // x2 nodes
  for (const t of hourly(S.dayStart(FIRST - 1) + 60000, S.dayStart(FIRST) + 3600000)) await quiet(() => run(base(out, t, {})));
  let r;
  for (const t of hourly(S.dayStart(FIRST + 1) + 3600000, S.dayStart(FIRST + 1) + 10 * 3600000)) r = await quiet(() => run(base(out, t, { rankedOf: slow, budgetMs: 200 })));
  const sf = JSON.parse(fs.readFileSync(path.join(out, "S001.json"), "utf8"));
  assert.ok(sf.days.length >= 1, `day 1 still not recorded after 9 runs: ${r.problems.filter((p) => /out of time/.test(p)).length} 'out of time' warnings`);
});

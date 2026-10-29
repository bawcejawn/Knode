/**
 * The Vault v6 rehearsal (bot/rehearse-v6.ts) end to end: a "live" contract runs the v5 code with real-looking history
 * (seed, stakes, a finished week with an open claim, a free player's prize, a running week with open questions and a
 * partial withdrawal); its snapshot is taken through read calls only, copied into a fresh simulator, upgraded to v6,
 * played for 3 vault weeks with three extra games, and ends in a full exit.
 *
 * Run (after `npm run build:sim` in game/): node --import tsx --test bot/rehearse-v6.test.ts   (from the repo root)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { Signer } from "koilib";
import { SimChain } from "./chain.ts";
import { takeSnapshot, rehearseV6, compareSnapshots, transplant, V5_BUILD, V6_BUILD } from "./rehearse-v6.ts";

const VHP = 100_000_000n;
const HOUR = 3_600_000, DAY = 24 * HOUR, WEEK = 7 * DAY;
const GENESIS = 1_800_000_000_000 - (1_800_000_000_000 % DAY);
const T0 = GENESIS - DAY, H0 = 50_000_000;
const key = (s: string) => Signer.fromSeed(`rehearse-v6 ${s}`);
const [contract, owner, operator, seedOwner, A, B, C, E, F] = ["contract", "owner", "operator", "seed", "A", "B", "C", "E", "F"].map(key);
const addr = (s: Signer) => s.getAddress();

/** A v5 contract with 1½ weeks of history, standing in for mainnet. */
async function liveV5() {
  const sim = new SimChain(addr(contract), V5_BUILD);
  await sim.init();
  const at = (t: number) => sim.setHeight(H0 + Math.floor((t - T0) / 3000), t);
  const ok = async (calls: any[], who: Signer[]) => {
    const r = await sim.sendAs(calls.map(([method, args]) => ({ method, args })), who.map(addr));
    assert.ok(r.ok, `${calls.map((c) => c[0]).join(", ")}: ${r.error}`);
  };
  for (const p of [A, B, C, E, F]) { await sim.ledgerSet(2, addr(p), 1000n * VHP); await sim.ledgerSet(3, addr(p), 1000n * VHP); }
  await sim.ledgerSet(2, addr(seedOwner), 5000n * VHP);
  await sim.ledgerSet(1, addr(seedOwner), 500n * VHP);
  await sim.ledgerSet(3, addr(seedOwner), 500n * VHP);
  await sim.ledgerSet(3, addr(contract), 1000n * VHP);
  at(T0);
  await ok([["init", { owner: addr(owner), operator: addr(operator), seed_owner: addr(seedOwner), genesis_time: String(GENESIS), week_length: String(WEEK),
    close_delay: String(12 * HOUR), settle_length: String(DAY), timelock_length: String(2 * DAY), min_stake: String(VHP), max_sponsor_rc: String(0) }]], [contract]);
  await ok([["seed_deposit_vhp", { amount: String(1050n * VHP) }], ["seed_deposit_koin", { amount: String(50n * VHP) }]], [seedOwner]);
  for (const [p, n] of [[A, 100n], [B, 40n], [C, 5n]] as const) await ok([["deposit_vhp", { from: addr(p), amount: String(n * VHP) }]], [p]);
  const post = async (lock: number) => {
    const ws = sim.height + Math.ceil((lock - sim.time) / 2800) + 20;
    await ok([["post_question", { k: 2, lock_time: String(lock), window_start: String(ws), window_end: String(ws + 1000), params_hash: "0x" + "ab".repeat(32) }]], [operator]);
  };
  const ans = (p: Signer, id: number, option: number) => ok([["answer", { player: addr(p), question_id: id, option }]], [p]);
  // week 0: three questions; A 3 right, B 2, E free 3, F free 2
  at(GENESIS + 12 * HOUR);
  for (let i = 0; i < 3; i++) await post(GENESIS + DAY);
  at(GENESIS + 13 * HOUR);
  for (const [p, o] of [[A, [1, 1, 1]], [B, [1, 1, 0]], [E, [1, 1, 1]], [F, [1, 0, 1]]] as const) for (let i = 0; i < 3; i++) await ans(p, i, o[i]);
  at(GENESIS + 2 * DAY);
  for (let i = 0; i < 3; i++) await ok([["resolve_question", { id: i, outcome: 1, data_hash: "0x" + "cd".repeat(32) }]], [operator]);
  await sim.ledgerAdd(1, addr(contract), 90n * VHP);                                        // block rewards, as KOIN
  await sim.ledgerAdd(3, addr(contract), 90n * VHP);
  at(GENESIS + WEEK + 12 * HOUR + 1);
  await ok([["close_week", { week: "0" }]], []);
  for (const p of [A, B, E, F]) await ok([["settle", { player: addr(p), week: "0" }]], []);
  at(GENESIS + WEEK + 37 * HOUR);
  await ok([["finalize_week", { week: "0" }]], []);
  await ok([["claim", { player: addr(E), week: "0" }]], [E]);                                // A's reward and F's prize stay open
  // week 1, running: two open questions, a partial withdrawal
  at(GENESIS + WEEK + 40 * HOUR);
  await post(GENESIS + WEEK + 48 * HOUR); await post(GENESIS + WEEK + 48 * HOUR);
  at(GENESIS + WEEK + 41 * HOUR);
  for (const p of [A, B]) { await ans(p, 3, 1); await ans(p, 4, 0); }
  await ok([["withdraw", { to: addr(B), amount: String(15n * VHP) }]], [B]);
  at(GENESIS + WEEK + 3 * DAY);
  return sim;
}

const ready = fs.existsSync(V6_BUILD) && fs.existsSync(V5_BUILD);

test("the copy is exact: the v5 code on it answers every read as the source did", { skip: !ready && "builds missing" }, async () => {
  const live = await liveV5();
  const snap = await takeSnapshot(live);
  assert.ok(Object.keys(snap.players[1]).length >= 5);
  const copy = new SimChain(snap.contract, V5_BUILD);
  await copy.init();
  await transplant(copy, snap);
  assert.deepEqual(compareSnapshots(snap, await takeSnapshot(copy)), []);
  // and the copy is a working contract: A's open claim pays the same on the copy as on the source
  const a = addr(A);
  const r1 = await live.sendAs([{ method: "claim", args: { player: a, week: "0" } }], [a]);
  const r2 = await copy.sendAs([{ method: "claim", args: { player: a, week: "0" } }], [a]);
  assert.ok(r1.ok && r2.ok);
  assert.equal((await live.read("get_player", { player: a, week: "0" })).entry.reward, (await copy.read("get_player", { player: a, week: "0" })).entry.reward);
});

test("the whole rehearsal: copy, upgrade, 3 vault weeks with 3 more games, full exit", { skip: !ready && "builds missing" }, async () => {
  const live = await liveV5();
  const snap = JSON.parse(JSON.stringify(await takeSnapshot(live)));   // through JSON, as the file is
  const report = await rehearseV6(snap, { weeks: 3, print: process.env.SHOW_REHEARSAL ? (s) => console.log(s) : undefined });
  assert.equal(report.ok, true);
  assert.ok(report.lines.some((l) => l.includes("All vault rehearsal checks passed.")), report.lines.join("\n"));
});

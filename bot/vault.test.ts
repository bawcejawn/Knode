/**
 * The bot's vault passes (bot/vault.ts) against the v6 test build on the simulated chain: results files → points,
 * prize winners and the seal; finalize after the wait; rows the chain would refuse are left out; alerts; and a v5
 * contract where every pass does nothing.
 *
 * Run (after `npm run build:sim` in game/): node --import tsx --test bot/vault.test.ts   (from the repo root)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { Signer } from "koilib";
import { SimChain } from "./chain.ts";
import { vaultView, vaultResultsPass, vaultFinalizePass, vaultAlerts, recentGameWeeks, checkResults, seasonEnds, type VaultCtx } from "./vault.ts";

const NEW = "game/build/sim/contract.wasm";
const V5 = "game/test-fixtures/kpred-v5-test-build.wasm";
const VHP = 100_000_000n;
const HOUR = 3_600_000, DAY = 24 * HOUR, WEEK = 7 * DAY;
const GENESIS = 1_800_000_000_000 - (1_800_000_000_000 % DAY);
const T0 = GENESIS - DAY, H0 = 50_000_000;
const key = (s: string) => Signer.fromSeed(`vault-bot ${s}`);
const [contract, owner, operator, seedOwner, A, B, C, D, E] = ["contract", "owner", "operator", "seed", "A", "B", "C", "D", "E"].map(key);
const addr = (s: Signer) => s.getAddress();

/** A contract initialised by the v5 code and upgraded to v6 (as on mainnet). The first v6 write is at T0 (before
 *  genesis, week 0), so the vault rules apply from week 1. `upgrade: false` keeps v5. */
async function world(upgrade = true) {
  const sim = new SimChain(addr(contract), V5);
  await sim.init();
  const at = (t: number) => sim.setHeight(H0 + Math.floor((t - T0) / 3000), t);
  const ok = async (calls: any[], who: Signer[]) => {
    const r = await sim.sendAs(calls.map(([method, args]) => ({ method, args })), who.map(addr));
    assert.ok(r.ok, `${calls.map((c) => c[0]).join(", ")}: ${r.error}`);
  };
  for (const p of [A, B, C, D, E]) { await sim.ledgerSet(2, addr(p), 1000n * VHP); await sim.ledgerSet(3, addr(p), 1000n * VHP); }
  await sim.ledgerSet(2, addr(seedOwner), 5000n * VHP);
  await sim.ledgerSet(3, addr(contract), 1000n * VHP);
  at(T0);
  await ok([["init", { owner: addr(owner), operator: addr(operator), seed_owner: addr(seedOwner), genesis_time: String(GENESIS), week_length: String(WEEK),
    close_delay: String(12 * HOUR), settle_length: String(DAY), timelock_length: String(2 * DAY), min_stake: String(VHP), max_sponsor_rc: String(0) }]], [contract]);
  if (upgrade) await sim.setCode(NEW);
  return { sim, at, ok };
}

function vctx(sim: SimChain, results: Record<string, any>): VaultCtx & { problems: string[] } {
  return {
    chain: sim, operator, dryRun: false, problems: [], quiet: true,
    deployment: { vaultGames: { "2": { results: "mem:fantasy" }, "3": { results: "mem:blockx" } } },
    readResults: (source, week) => results[`${source}/W${week}`] ?? null,
  };
}
const sendAs = (sim: SimChain, signer: Signer, sent: string[]) => async (what: string, calls: any[]) => {
  sent.push(what);
  const r = await sim.sendAs(calls, [addr(signer)]);
  if (!r.ok) throw new Error(`${what}: ${r.error}`);
  return true;
};

test("results files become points, prize winners and a seal; the week finalizes after the wait and winners claim", { skip: !fs.existsSync(NEW) && `${NEW} missing: run npm run build:sim in game/` }, async () => {
  const { sim, at, ok } = await world();
  await ok([["propose_game", { game: 2, name: "Fantasy", staked: true, free_prize: false, season_weeks: 1 }], ["propose_game", { game: 3, name: "Block X", staked: false, free_prize: true, season_weeks: 1 }]], [owner]);
  assert.equal((await sim.read("get_state", {})).config.v6_rule_week_plus_one, "2", "vault rules from week 1");
  // an announcement emails the owner once
  const alerts: string[] = [];
  let view = (await vaultView(sim))!;
  vaultAlerts(view, { weeksClosed: 0 }, new Map(), (k) => alerts.push(k));
  assert.deepEqual(alerts.map((k) => k.split(":").slice(0, 2).join(":")), ["game-proposal:2", "game-proposal:3"]);
  at(T0 + 2 * DAY + HOUR);
  await ok([["apply_game", { game: 2 }], ["apply_game", { game: 3 }]], [owner]);
  view = (await vaultView(sim))!;
  assert.deepEqual(view.games.map((g: any) => [Number(g.id), Number(g.from_week ?? 0)]), [[1, 0], [2, 1], [3, 1]]);
  await ok([["seed_deposit_vhp", { amount: String(2000n * VHP) }]], [seedOwner]);
  await ok([["deposit_vhp", { from: addr(A), amount: String(10n * VHP) }]], [A]);
  for (const [p, n] of [[B, 20n], [C, 5n]] as const) await ok([["deposit_to", { from: addr(p), game: 2, amount: String(n * VHP), koin: false }]], [p]);
  // week 0 (v5 rules) and week 1 (the first vault week) close
  at(GENESIS + WEEK + 12 * HOUR + 1);
  await ok([["close_week", { week: "0" }]], []);
  await sim.ledgerAdd(2, addr(contract), 100n * VHP);
  at(GENESIS + 2 * WEEK + 12 * HOUR + 1);
  await ok([["close_week", { week: "1" }]], []);
  const bucket = BigInt((await sim.read("get_game", { game: 2, week: "1" })).week.bucket);
  assert.ok(bucket > 0n, "Fantasy earned a bucket");
  assert.equal((await sim.read("get_game", { game: 3, week: "1" })).week.prize, String(3n * VHP));
  // results: B and C staked in Fantasy, E never staked there (left out); Block X: D 1st, E 2nd; A (staked in the
  // question game only) is free in Block X too, but isn't in the file
  const results = {
    "mem:fantasy/W1": { game: 2, week: 1, final: true, rows: [{ player: addr(B), points: 9 }, { player: addr(C), points: 4 }, { player: addr(E), points: 7 }] },
    "mem:blockx/W1": { game: 3, week: 1, final: true, rows: [], first: [addr(D)], second: [addr(E)] },
  };
  const v = vctx(sim, results), sent: string[] = [];
  await vaultResultsPass(v, sendAs(sim, operator, sent));
  assert.deepEqual(v.problems, []);
  assert.deepEqual(sent, [
    "Fantasy week 1: points for 2 player(s)",
    "Fantasy week 1: seal the results (the owner can correct them for 24 h)",
    `Block X week 1: prize place 1 → ${addr(D)}`,
    `Block X week 1: prize place 2 → ${addr(E)}`,
    "Block X week 1: seal the results (the owner can correct them for 24 h)",
  ]);
  // a second run sends nothing (already sealed)
  const again: string[] = [];
  await vaultResultsPass(vctx(sim, results), sendAs(sim, operator, again));
  assert.deepEqual(again, []);
  // too early to finalize, also 12 hours after the seal (the owner can still correct); a day after the seal it
  // finalizes; winners claim
  const fin: string[] = [];
  await vaultFinalizePass(vctx(sim, results), sendAs(sim, operator, fin));
  assert.deepEqual(fin, []);
  at(sim.time + 12 * HOUR + 1);
  await vaultFinalizePass(vctx(sim, results), sendAs(sim, operator, fin));
  assert.deepEqual(fin, []);
  at(sim.time + 12 * HOUR);
  await vaultFinalizePass(vctx(sim, results), sendAs(sim, operator, fin));
  assert.deepEqual(fin, ["Fantasy week 1: finalize (find the winners)", "Block X week 1: finalize (find the winners)"]);
  await ok([["claim_game", { player: addr(B), game: 2, week: "1" }]], [B]);
  await ok([["claim_game", { player: addr(D), game: 3, week: "1" }]], [D]);
  await ok([["claim_game", { player: addr(E), game: 3, week: "1" }]], [E]);
  const gw = (await sim.read("get_game", { game: 2, week: "1" })).week;
  assert.ok(BigInt(gw.claimed) <= bucket, "claims never exceed the bucket");
  assert.ok(bucket - BigInt(gw.claimed) < 10n, "B, the only winner (top 30% of 2 players), took the bucket, less rounding dust");
});

test("a prize winner who was staked in the game is reported, not posted; a missing file near the deadline is reported", { skip: !fs.existsSync(NEW) && `${NEW} missing` }, async () => {
  const { sim, at, ok } = await world();
  await ok([["propose_game", { game: 3, name: "Both", staked: true, free_prize: true, season_weeks: 1 }]], [owner]);
  at(T0 + 2 * DAY + HOUR);
  await ok([["apply_game", { game: 3 }]], [owner]);
  await ok([["seed_deposit_vhp", { amount: String(2000n * VHP) }]], [seedOwner]);
  await ok([["deposit_to", { from: addr(B), game: 3, amount: String(2n * VHP), koin: false }]], [B]);
  at(GENESIS + WEEK + 12 * HOUR + 1);
  await ok([["close_week", { week: "0" }]], []);
  at(GENESIS + 2 * WEEK + 12 * HOUR + 1);
  await ok([["close_week", { week: "1" }]], []);
  const results = { "mem:blockx/W1": { game: 3, week: 1, final: true, rows: [], first: [addr(B)], second: [] } };
  const v = vctx(sim, results), sent: string[] = [];
  await vaultResultsPass(v, sendAs(sim, operator, sent));
  assert.equal(v.problems.length, 1);
  assert.match(v.problems[0], /was staked in the game that week/);
  assert.deepEqual(sent, ["Both week 1: seal the results (the owner can correct them for 24 h)"]);
  // next week: no file; 3 days after the week, less than 12 h before the deadline → reported
  at(GENESIS + 3 * WEEK + 12 * HOUR + 1);
  await ok([["close_week", { week: "2" }]], []);
  at(GENESIS + 3 * WEEK + 3 * DAY - 6 * HOUR);
  const v2 = vctx(sim, {}), sent2: string[] = [];
  await vaultResultsPass(v2, sendAs(sim, operator, sent2));
  assert.deepEqual(sent2, []);
  assert.match(v2.problems.join(" "), /week 2's results are not ready/);
  // past the deadline the bot rolls it over
  at(GENESIS + 3 * WEEK + 3 * DAY + 1);
  const fin: string[] = [];
  await vaultFinalizePass(vctx(sim, {}), sendAs(sim, operator, fin));
  assert.ok(fin.includes("Both week 2: finalize (no results: roll the week over)"), fin.join(" | "));
  const gw = (await sim.read("get_game", { game: 3, week: "2" })).week;
  assert.equal(gw.rolled_over, true);
});

test("on the v5 contract every vault pass does nothing", { skip: !fs.existsSync(V5) && `${V5} missing` }, async () => {
  const { sim } = await world(false);
  assert.equal(await vaultView(sim), null);
  const sent: string[] = [];
  await vaultResultsPass(vctx(sim, {}), sendAs(sim, operator, sent));
  await vaultFinalizePass(vctx(sim, {}), sendAs(sim, operator, sent));
  assert.deepEqual(sent, []);
  assert.equal((await recentGameWeeks(sim, { games: [], proposals: [] }, 0)).size, 0);
});

test("checkResults refuses malformed files; seasonEnds follows the season", () => {
  const P = "1PWeFG4pPtjZZoYvcmGb6mYhMYJjnkHrmz";
  assert.equal(checkResults({ game: 2, week: 5, final: true, rows: [{ player: P, points: 3 }] }, 2, 5), "");
  assert.match(checkResults({ game: 2, week: 5, final: false, rows: [] }, 2, 5), /not final/);
  assert.match(checkResults({ game: 2, week: 4, final: true, rows: [] }, 2, 5), /not game 2 week 5/);
  assert.match(checkResults({ game: 2, week: 5, final: true, rows: [{ player: P, points: 0 }] }, 2, 5), /1-255/);
  assert.match(checkResults({ game: 2, week: 5, final: true, rows: [{ player: P, points: 3 }], first: [P] }, 2, 5), /twice/);
  assert.match(checkResults({ game: 2, week: 5, final: true, rows: [{ player: "nope", points: 3 }] }, 2, 5), /valid address/);
  const g = { from_week: 4, season_weeks: 2 };
  assert.deepEqual([4, 5, 6, 7].map((w) => seasonEnds(g, w)), [false, true, false, true]);
  assert.equal(seasonEnds({ from_week: 4, season_weeks: 0 }, 4), true);
});

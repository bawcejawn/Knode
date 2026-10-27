/**
 * Upgrade compatibility v5 → v6 (the KnodeGames vault).
 *
 * v6 will be uploaded over v5, so this test lets the v5 code (test-fixtures/kpred-v5-test-build.wasm, the test build of
 * the source whose release build is the scheduled v5 fingerprint c17066ae…d784) write a realistic v5 history, then
 * swaps in the v6 build (build/sim/contract.wasm) on the same storage, as the upgrade does:
 *
 * 1. v5 plays: seed, stakes, a v5-rule week closed and finalized with its free prize and one winner's claim left open,
 *    a week with no winners rolled over, a running week with a partial withdrawal.
 * 2. Every view reads back unchanged after the swap; v6's new fields read as their defaults.
 * 3. v6 keeps playing: the running week closes by the v5 rules (the vault split starts with the week after the one
 *    running at the first v6 write); a second game is added, takes stakes and earns; the first v6 week
 *    pays the fee in VHP, the 2 + 1 VHP prizes and the split; open v5 claims still pay; everyone exits; books balance.
 *
 * Run (after `npm run build:sim` in game/): node --import tsx --test game/scripts/storage-compat-v6.test.ts   (from the repo root)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { Signer } from "koilib";
import { SimChain } from "../../bot/chain.ts";

const OLD = "game/test-fixtures/kpred-v5-test-build.wasm";
const NEW = "game/build/sim/contract.wasm";
const VHP = 100_000_000n;
const HOUR = 3_600_000, DAY = 24 * HOUR, WEEK = 7 * DAY;
const GENESIS = 1_800_000_000_000 - (1_800_000_000_000 % DAY);
const T0 = GENESIS - DAY, H0 = 50_000_000;

const key = (s: string) => Signer.fromSeed(`storage-compat-v6 ${s}`);
const [contract, owner, operator, seedOwner, A, B, C, D, E, F] =
  ["contract", "owner", "operator", "seed", "A", "B", "C", "D", "E", "F"].map(key);
const addr = (s: Signer) => s.getAddress();

const V6_FIELDS = new Set(["v6_rule_week_plus_one", "game_count", "fee_vhp", "games_rolled", "stake_other", "prize_v6", "prizes", "split"]);
const isDefault = (v: any) => v === undefined || v === null || v === false || v === 0 || v === "0" || v === "";
function sameAsBefore(before: any, after: any, where: string) {
  if (before === null || typeof before !== "object") { assert.deepEqual(after, before, where); return; }
  assert.equal(typeof after, "object", `${where}: missing`);
  for (const k of Object.keys(before)) sameAsBefore(before[k], after?.[k], `${where}.${k}`);
  for (const k of Object.keys(after)) {
    if (k in before) continue;
    assert.ok(V6_FIELDS.has(k), `${where}.${k}: a field v5 never returned (${JSON.stringify(after[k])})`);
    assert.ok(isDefault(after[k]), `${where}.${k} should read as its default, got ${JSON.stringify(after[k])}`);
  }
}
const sum = (o: any, keys: string[]) => keys.reduce((n, k) => n + BigInt(o[k] ?? 0), 0n);

test("v6 reads v5's stored data unchanged, finishes v5 weeks by v5 rules, then runs the vault", { skip: !fs.existsSync(NEW) && `${NEW} missing: run npm run build:sim in game/` }, async () => {
  const sim = new SimChain(addr(contract), OLD);
  await sim.init();
  const at = (t: number) => sim.setHeight(H0 + Math.floor((t - T0) / 3000), t);
  const ok = async (calls: any[], who: Signer[]) => {
    const r = await sim.sendAs(calls.map(([method, args]) => ({ method, args })), who.map(addr));
    assert.ok(r.ok, `${calls.map((c) => c[0]).join(", ")}: ${r.error}`);
    return r;
  };
  for (const p of [A, B, C, D, E, F]) { await sim.ledgerSet(2, addr(p), 1000n * VHP); await sim.ledgerSet(3, addr(p), 1000n * VHP); }
  await sim.ledgerSet(2, addr(seedOwner), 5000n * VHP);
  await sim.ledgerSet(1, addr(seedOwner), 500n * VHP);
  await sim.ledgerSet(3, addr(seedOwner), 500n * VHP);
  await sim.ledgerSet(3, addr(contract), 1000n * VHP);

  // ───── 1. v5 history ─────
  at(T0);
  await ok([["init", { owner: addr(owner), operator: addr(operator), seed_owner: addr(seedOwner), genesis_time: String(GENESIS), week_length: String(WEEK),
    close_delay: String(12 * HOUR), settle_length: String(DAY), timelock_length: String(2 * DAY), min_stake: String(VHP), max_sponsor_rc: String(2n * VHP) }]], [contract]);
  await ok([["seed_deposit_vhp", { amount: String(500n * VHP) }], ["seed_deposit_koin", { amount: String(50n * VHP) }]], [seedOwner]);
  for (const [p, n] of [[A, 100n], [B, 40n], [C, 5n]] as const) await ok([["deposit_vhp", { from: addr(p), amount: String(n * VHP) }]], [p]);

  const post = async (lock: number) => {
    const ws = sim.height + Math.ceil((lock - sim.time) / 2800) + 20;
    await ok([["post_question", { k: 2, lock_time: String(lock), window_start: String(ws), window_end: String(ws + 1000), params_hash: "0x" + "ab".repeat(32) }]], [operator]);
  };
  const ans = (p: Signer, id: number, option: number) => ok([["answer", { player: addr(p), question_id: id, option }]], [p]);
  const resolve = (id: number, outcome: number) => ok([["resolve_question", { id, outcome, data_hash: "0x" + "cd".repeat(32) }]], [operator]);

  // week 0 (v5 rules): three questions; A 3 right, B 2, E and F free (3 and 2 right)
  at(GENESIS + 12 * HOUR);
  for (let i = 0; i < 3; i++) await post(GENESIS + DAY);
  at(GENESIS + 13 * HOUR);
  for (const [p, opts] of [[A, [1, 1, 1]], [B, [1, 1, 0]], [E, [1, 1, 1]], [F, [1, 0, 1]], [C, [0, 0, 0]]] as const) for (let i = 0; i < 3; i++) await ans(p, i, opts[i]);
  at(GENESIS + 2 * DAY);
  for (let i = 0; i < 3; i++) await resolve(i, 1);
  await sim.ledgerAdd(2, addr(contract), 50n * VHP);                                         // block rewards
  at(GENESIS + WEEK + 12 * HOUR);
  await ok([["close_week", { week: "0" }]], []);
  for (const p of [A, B, C, E, F]) await ok([["settle", { player: addr(p), week: "0" }]], []);
  at(GENESIS + WEEK + 37 * HOUR);
  await ok([["finalize_week", { week: "0" }]], []);
  await ok([["claim", { player: addr(E), week: "0" }]], [E]);                                // F's free prize and A's reward stay open

  // week 1 (running when the upgrade lands): one question, everyone gets it wrong → no winners later
  at(GENESIS + WEEK + 40 * HOUR);
  await post(GENESIS + WEEK + 48 * HOUR);
  at(GENESIS + WEEK + 41 * HOUR);
  for (const p of [A, B]) await ans(p, 3, 0);
  await ok([["withdraw", { to: addr(B), amount: String(15n * VHP) }]], [B]);                 // partial: B stays in week 1

  const views = async () => ({
    state: await sim.read("get_state", {}),
    weeks: [await sim.read("get_week", { week: "0" }), await sim.read("get_week", { week: "1" })],
    players: await Promise.all([A, B, C, E, F].flatMap((p) => ["0", "1"].map((week) => sim.read("get_player", { player: addr(p), week })))),
    list: await sim.read("list_players", { limit: 50, week: "1" }),
  });
  const before = await views();
  assert.equal(before.state.config.reward_rule_week_plus_one, "1", "v5 rules from week 0");
  assert.equal(before.weeks[0].week.finalized, true);
  assert.equal(before.weeks[0].week.reward_rule, true);

  // ───── 2. the upgrade ─────
  await sim.setCode(NEW);
  sameAsBefore(before, await views(), "view");

  // ───── 3. v6 keeps playing ─────
  at(GENESIS + WEEK + 72 * HOUR);
  await resolve(3, 1);                                                                       // first v6 write
  const cfg = (await sim.read("get_state", {})).config;
  assert.equal(cfg.v6_rule_week_plus_one, "3", "the vault split starts with week 2, the week after the one running at the first v6 write");
  const games0 = (await sim.read("list_games", {})).games;
  assert.equal(games0.length, 1);
  assert.equal(games0[0].stake, String(130n * VHP), "game 1 holds every stake there is (100 + 25 + 5)");
  // the open v5 claims still pay
  await ok([["claim", { player: addr(A), week: "0" }]], [A]);
  const fRes = await ok([["claim", { player: addr(F), week: "0" }]], [F]);
  assert.ok(fRes.ok);
  // a second game, announced now (it earns from week 2)
  await ok([["propose_game", { game: 2, name: "Fantasy", staked: true, free_prize: false }]], [owner]);
  at(GENESIS + WEEK + 72 * HOUR + 2 * DAY + HOUR);
  await ok([["apply_game", { game: 2 }]], [owner]);
  await ok([["deposit_to", { game: 2, from: addr(D), amount: String(30n * VHP), koin: false }]], [D]);
  // week 1 closes by v5 rules: nobody scored, so its pot rolls into the next gain (v5 style)
  await sim.ledgerAdd(2, addr(contract), 20n * VHP);
  at(GENESIS + 2 * WEEK + 12 * HOUR);
  await ok([["close_week", { week: "1" }]], []);
  for (const p of [A, B]) await ok([["settle", { player: addr(p), week: "1" }]], []);
  at(GENESIS + 2 * WEEK + 37 * HOUR);
  await ok([["finalize_week", { week: "1" }]], []);
  const w1 = (await sim.read("get_week", { week: "1" })).week;
  assert.equal(w1.rolled_over, true);
  assert.ok(!w1.prize_v6, "week 1 keeps v5 rules");
  const rolled = BigInt((await sim.read("get_state", {})).totals.rolled_over ?? 0);
  assert.ok(rolled > 0n, "v5 rollover waiting");
  // week 2: the first vault week. Week 1's v5 rollover comes back fee-free; the 100 VHP of new rewards pay the fee.
  await sim.ledgerAdd(2, addr(contract), 100n * VHP);
  at(GENESIS + 3 * WEEK + 12 * HOUR);
  await ok([["close_week", { week: "2" }]], []);
  const w2 = (await sim.read("get_week", { week: "2" })).week;
  assert.equal(w2.prize_v6, true);
  assert.equal(w2.fee ?? "0", "0", "no KOIN fee under v6");
  assert.equal(BigInt(w2.gain), 100n * VHP + rolled, "new rewards plus the rollover");
  assert.equal(w2.fee_vhp, String(5n * VHP), "5% of the new rewards only");
  assert.equal(w2.pot_free, String(3n * VHP), "the question game's 2 + 1 VHP prize");
  const g2 = await sim.read("get_game", { game: 2, week: "2" });
  assert.equal(g2.week.closed, true);
  assert.ok(BigInt(g2.week.bucket) > 0n, "game 2 earned its share of the split");
  assert.equal(BigInt(w2.split), BigInt(w2.pot) - 3n * VHP + BigInt(g2.week.bucket), "split = game 1's part + game 2's bucket");

  // everyone exits; the fee and creator fee are claimable; the books balance
  at(GENESIS + 3 * WEEK + 20 * HOUR);
  for (const p of [A, B, C]) {
    const pl = (await sim.read("get_player", { player: addr(p), week: "3" })).player ?? {};
    const all = BigInt(pl.stake ?? 0) + BigInt(pl.pending ?? 0);
    if (all > 0n) await ok([["withdraw", { to: addr(p), amount: String(all) }]], [p]);
  }
  await ok([["withdraw_from", { game: 2, to: addr(D), amount: String(30n * VHP) }]], [D]);
  const s = await sim.read("get_state", {});
  await ok([["claim_fee_vhp", { to: addr(owner), amount: s.totals.fee_vhp }]], [owner]);
  await ok([["claim_creator_fee", { to: addr(owner) }]], [owner]);
  const e = await sim.read("get_state", {});
  assert.equal(e.totals.total_stake ?? "0", "0");
  assert.equal(e.totals.stake_other ?? "0", "0");
  const owed = sum(e.totals, ["seed_vhp", "seed_koin", "owner_share", "creator_fee", "pots_outstanding", "fee_vhp", "games_rolled", "rolled_over"]);
  assert.ok(BigInt(e.vhp_balance ?? 0) + BigInt(e.koin_balance ?? 0) >= owed, "holdings cover everything still owed");
});

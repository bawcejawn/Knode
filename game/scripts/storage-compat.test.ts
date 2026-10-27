/**
 * Upgrade compatibility: the new contract must read everything the live contract stored, exactly as it was written,
 * and keep playing from there.
 *
 * The live code (commit 1c25791, release build sha256 917708a7…6433a = what runs on mainnet) is kept as its test build
 * in test-fixtures/kpred-live-test-build.wasm. The test and release builds compile the same game code and differ only
 * in Tokens.ts (a ledger inside the contract instead of the KOIN/VHP contracts), so the stored weeks, players, entries,
 * questions, stakes, seed and timelocks are written byte for byte as the release build writes them.
 *
 * 1. The live code plays a realistic history on a simulated chain: seed, stakes, a pending top-up, a finished and
 *    finalized week with one claim made and one still open, a running week, a partial withdrawal, a free player,
 *    an announced upgrade, an announced seed withdrawal and a pending ownership transfer.
 * 2. Every read-only view is saved, then the code is replaced by the new build (build/sim/contract.wasm) on the same
 *    storage, as an upgrade does.
 * 3. Every value the live code returned must come back unchanged; new fields must read as their defaults.
 * 4. The new code keeps playing: open claims, the running week, the seed withdrawal, withdrawals, and the books balance.
 *
 * Run (after `npm run build:sim` in game/): node --import tsx --test game/scripts/storage-compat.test.ts   (from the repo root)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import { Signer } from "koilib";
import { SimChain } from "../../bot/chain.ts";

const OLD = "game/test-fixtures/kpred-live-test-build.wasm";
const NEW = "game/build/sim/contract.wasm";
const VHP = 100_000_000n;
const HOUR = 3_600_000, DAY = 24 * HOUR, WEEK = 7 * DAY;
const GENESIS = 1_800_000_000_000 - (1_800_000_000_000 % DAY);   // a day boundary
const T0 = GENESIS - DAY, H0 = 50_000_000;

const key = (s: string) => Signer.fromSeed(`storage-compat ${s}`);
const [contract, owner, operator, seedOwner, A, B, C, D, E, NEXT] =
  ["contract", "owner", "operator", "seed", "A", "B", "C", "D", "E", "next owner"].map(key);
const addr = (s: Signer) => s.getAddress();

/** New fields of v4: absent in old reads, their defaults in new ones. */
const NEW_FIELDS = new Set(["min_stake_next", "min_stake_next_week", "pending_owner_height", "min_sponsor_rc", "scorer_rule_week_plus_one",
  "last_resolved_time", "fin_started", "fin_points", "fin_index", "fin_rank", "fin_gw", "done",
  // v5
  "pending_seed_owner", "pending_seed_owner_height", "reward_rule_week_plus_one", "aw_hi", "aw_lo", "reward_rule", "capped",
  "pot_free", "free_best", "free_best_n", "free_second", "free_second_n",
  // v5, after the 2026-10-26 audit: an entry's highest stake this week, and whether it settled as a free player
  "peak_stake", "free_player",
  // v6: the KnodeGames vault
  "v6_rule_week_plus_one", "game_count", "fee_vhp", "games_rolled", "stake_other", "prize_v6", "prizes", "split"]);
const isDefault = (v: any) => v === undefined || v === null || v === false || v === 0 || v === "0" || v === "";

/** Every value in `before` must be in `after` unchanged; anything only in `after` must be a new field at its default
 *  (or a v4 field the new code legitimately filled in, listed in `allowed`). */
function sameAsBefore(before: any, after: any, where: string, allowed: Set<string> = new Set()) {
  if (before === null || typeof before !== "object") { assert.deepEqual(after, before, where); return; }
  assert.equal(typeof after, "object", `${where}: missing`);
  for (const k of Object.keys(before)) sameAsBefore(before[k], after?.[k], `${where}.${k}`, allowed);
  for (const k of Object.keys(after)) {
    if (k in before) continue;
    assert.ok(NEW_FIELDS.has(k), `${where}.${k}: a field the live code never returned (${JSON.stringify(after[k])})`);
    if (!allowed.has(k)) assert.ok(isDefault(after[k]), `${where}.${k} should read as its default, got ${JSON.stringify(after[k])}`);
  }
}

test("the new contract reads the live contract's stored data unchanged and keeps playing", { skip: !fs.existsSync(NEW) && `${NEW} missing: run npm run build:sim in game/` }, async () => {
  const sim = new SimChain(addr(contract), OLD);
  await sim.init();
  const at = (t: number) => sim.setHeight(H0 + Math.floor((t - T0) / 3000), t);
  const ok = async (calls: any[], who: Signer[]) => {
    const r = await sim.sendAs(calls.map(([method, args]) => ({ method, args })), who.map(addr));
    assert.ok(r.ok, `${calls.map((c) => c[0]).join(", ")}: ${r.error}`);
  };
  const fund = async (s: Signer, vhp: bigint) => { await sim.ledgerSet(2, addr(s), vhp * VHP); await sim.ledgerSet(3, addr(s), 1000n * VHP); };
  for (const p of [A, B, C, D, E]) await fund(p, 1000n);
  await sim.ledgerSet(2, addr(seedOwner), 5000n * VHP);
  await sim.ledgerSet(1, addr(seedOwner), 500n * VHP);
  await sim.ledgerSet(3, addr(seedOwner), 500n * VHP);

  // ───── 1. history written by the live code ─────
  at(T0);
  await ok([["init", { owner: addr(owner), operator: addr(operator), seed_owner: addr(seedOwner), genesis_time: String(GENESIS), week_length: String(WEEK),
    close_delay: String(12 * HOUR), settle_length: String(DAY), timelock_length: String(2 * DAY), min_stake: String(VHP), max_sponsor_rc: String(2n * VHP) }]], [contract]);
  await ok([["seed_deposit_vhp", { amount: String(1000n * VHP) }], ["seed_deposit_koin", { amount: String(100n * VHP) }]], [seedOwner]);
  await ok([["deposit_vhp", { from: addr(A), amount: String(100n * VHP) }]], [A]);
  await ok([["deposit_vhp", { from: addr(B), amount: String(50n * VHP) }]], [B]);
  await ok([["deposit_vhp", { from: addr(C), amount: String(10n * VHP) }]], [C]);
  at(GENESIS + HOUR);
  await ok([["deposit_vhp", { from: addr(D), amount: String(20n * VHP) }]], [D]);           // pending until week 1

  const height = () => sim.height;
  const post = async (lock: number, len = 1000) => {
    const ws = height() + Math.ceil((lock - sim.time) / 2800) + 20;
    await ok([["post_question", { k: 2, lock_time: String(lock), window_start: String(ws), window_end: String(ws + len), params_hash: "0x" + "ab".repeat(32) }]], [operator]);
    return { ws, we: ws + len };
  };
  const ans = (p: Signer, id: number, option: number) => ok([["answer", { player: addr(p), question_id: id, option }]], [p]);
  const resolve = (id: number, outcome: number) => ok([["resolve_question", { id, outcome, data_hash: "0x" + "cd".repeat(32) }]], [operator]);

  // week 0: three questions; A 3 right, B 2, C answers once (not eligible), E plays free (no stake)
  at(GENESIS + 12 * HOUR);
  const w0 = [await post(GENESIS + DAY), await post(GENESIS + DAY), await post(GENESIS + DAY)];
  at(GENESIS + 13 * HOUR);
  for (const [p, opts] of [[A, [1, 1, 1]], [B, [1, 1, 0]], [E, [1, 0, 1]]] as const) for (let i = 0; i < 3; i++) await ans(p, i, opts[i]);
  await ans(C, 0, 1);
  at(GENESIS + 2 * DAY);
  for (let i = 0; i < 3; i++) await resolve(i, 1);
  await sim.ledgerAdd(1, addr(contract), 60n * VHP);                                         // block rewards (KOIN)
  await sim.ledgerAdd(3, addr(contract), 60n * VHP);
  at(GENESIS + WEEK + 12 * HOUR);
  await ok([["close_week", { week: "0" }]], []);
  for (const p of [A, B, C, E]) await ok([["settle", { player: addr(p), week: "0" }]], []);
  at(GENESIS + WEEK + 37 * HOUR);
  await ok([["finalize_week", { week: "0" }]], []);
  await ok([["claim", { player: addr(A), week: "0" }]], [A]);                               // B's claim stays open, if B won

  // week 1 (running): two questions, one resolved; A withdraws part; announcements are pending
  at(GENESIS + WEEK + 40 * HOUR);
  await post(GENESIS + WEEK + 48 * HOUR, 1500); await post(GENESIS + WEEK + 48 * HOUR, 1500);
  at(GENESIS + WEEK + 41 * HOUR);
  for (const p of [A, B, D]) { await ans(p, 3, 1); await ans(p, 4, 0); }
  at(GENESIS + WEEK + 72 * HOUR);
  await resolve(3, 1);
  await ok([["withdraw", { to: addr(A), amount: String(30n * VHP) }]], [A]);
  await ok([["schedule_upgrade", { hash: "0x" + "ee".repeat(32) }]], [owner]);
  await ok([["request_seed_withdrawal", { vhp: String(100n * VHP), koin: String(10n * VHP) }]], [seedOwner]);
  await ok([["propose_owner", { new_owner: addr(NEXT) }]], [owner]);

  const views = async () => ({
    state: await sim.read("get_state", {}),
    weeks: [await sim.read("get_week", { week: "0" }), await sim.read("get_week", { week: "1" })],
    questions: await Promise.all([0, 1, 2, 3, 4].map((id) => sim.read("get_question", { id }))),
    players: await Promise.all([A, B, C, D, E].flatMap((p) => ["0", "1"].map((week) => sim.read("get_player", { player: addr(p), week })))),
    list: await sim.read("list_players", { limit: 50, week: "1" }),
  });
  const before = await views();
  assert.equal(before.state.totals.weeks_closed, "1");
  assert.equal(before.weeks[0].week.finalized, true);
  assert.ok(Object.keys(before.state.config.pending_owner ?? {}).length > 0);

  // ───── 2. the upgrade: new code, same storage ─────
  await sim.setCode(NEW);

  // ───── 3. everything reads back unchanged ─────
  const after = await views();
  sameAsBefore(before, after, "view");

  // ───── 4. the new code keeps playing ─────
  const t1 = sim.time + HOUR;
  at(t1);
  const fw = before.weeks[0].week;
  if (Number(fw.cutoff ?? 0) <= 2) await ok([["claim", { player: addr(B), week: "0" }]], [B]);   // B's open claim (if B won)
  // The ownership transfer proposed under the old code has no recorded height: it must be proposed again.
  assert.equal((await sim.sendAs([{ method: "accept_owner", args: {} }], [addr(NEXT)])).ok, false);
  // The rest of week 1: resolve, close (close_delay after the latest resolution), settle, finalize (paged), claim.
  await resolve(4, 0);
  // The first write under the new code starts the new winners' rule with the week after the running one (week 1 + 1).
  assert.equal((await sim.read("get_state", {})).config.scorer_rule_week_plus_one, "3");
  assert.equal((await sim.read("get_state", {})).config.reward_rule_week_plus_one, "3");   // v5 split from week 2
  at(GENESIS + 2 * WEEK + 12 * HOUR);
  await ok([["close_week", { week: "1" }]], []);
  for (const p of [A, B, D]) await ok([["settle", { player: addr(p), week: "1" }]], []);
  at(GENESIS + 2 * WEEK + 37 * HOUR);
  await ok([["finalize_week", { week: "1" }]], []);
  const w1 = (await sim.read("get_week", { week: "1" })).week;
  assert.equal(w1.finalized, true);
  for (const p of [A, B, D]) {
    const e = (await sim.read("get_player", { player: addr(p), week: "1" })).entry;
    // Entries the live code wrote have no peak stake and never count as free players (week 1 keeps the old rules).
    assert.ok(!e?.free_player, `week 1 entry of ${addr(p)} must not be a free player`);
    if (e?.eligible && Number(e.points ?? 0) >= Number(w1.cutoff ?? 0)) await ok([["claim", { player: addr(p), week: "1" }]], [p]);
  }
  // The seed withdrawal announced under the old code (eta + 48 h) still works within its 7 days.
  await ok([["execute_seed_withdrawal", {}]], [seedOwner]);
  // Everyone can take their stake out.
  for (const p of [A, B, C, D]) {
    const pl = (await sim.read("get_player", { player: addr(p), week: "2" })).player ?? {};
    const all = BigInt(pl.stake ?? 0) + BigInt(pl.pending ?? 0);
    if (all > 0n) await ok([["withdraw", { to: addr(p), amount: String(all) }]], [p]);
  }
  // Books balance: holdings cover everything still owed.
  const s = await sim.read("get_state", {});
  const owed = ["total_stake", "seed_vhp", "seed_koin", "owner_share", "creator_fee", "pots_outstanding"].reduce((n, k) => n + BigInt(s.totals[k] ?? 0), 0n);
  assert.ok(BigInt(s.vhp_balance ?? 0) + BigInt(s.koin_balance ?? 0) >= owed, "holdings cover what is owed");
  assert.equal(s.totals.total_stake ?? "0", "0");
});

// ───────────────────── audit U1-01: swap at the risky moments, through the real upload check ─────────────────────
// Week 0 is played by the live code; the upgrade lands at one of these points, then the new code finishes the week:
// every winner is paid (including claims left open across the upgrade), everyone withdraws, the books balance.
const NEW_HASH = () => "0x" + crypto.createHash("sha256").update(fs.readFileSync(NEW)).digest("hex");
const POINTS = ["week ended, not closed", "closed, mid-settlement", "settled, not finalized", "finalized, claims open"] as const;

for (const point of POINTS) {
  test(`upgrade at "${point}": authorized upload, then the week finishes and every winner is paid`, { skip: !fs.existsSync(NEW) && `${NEW} missing: run npm run build:sim in game/` }, async () => {
    const sim = new SimChain(addr(contract), OLD);
    await sim.init();
    const at = (t: number) => sim.setHeight(H0 + Math.floor((t - T0) / 3000), t);
    const ok = async (calls: any[], who: Signer[]) => {
      const r = await sim.sendAs(calls.map(([method, args]) => ({ method, args })), who.map(addr));
      assert.ok(r.ok, `${calls.map((c) => c[0]).join(", ")}: ${r.error}`);
    };
    const players = [A, B, C, D, E];
    for (const p of players) { await sim.ledgerSet(2, addr(p), 1000n * VHP); await sim.ledgerSet(3, addr(p), 1000n * VHP); }
    at(T0);
    await ok([["init", { owner: addr(owner), operator: addr(operator), seed_owner: addr(seedOwner), genesis_time: String(GENESIS), week_length: String(WEEK),
      close_delay: String(12 * HOUR), settle_length: String(DAY), timelock_length: String(2 * DAY), min_stake: String(VHP), max_sponsor_rc: String(2n * VHP) }]], [contract]);
    for (const [p, n] of [[A, 100n], [B, 80n], [C, 60n], [D, 40n], [E, 20n]] as const) await ok([["deposit_vhp", { from: addr(p), amount: String(n * VHP) }]], [p]);
    at(GENESIS + HOUR);
    await ok([["schedule_upgrade", { hash: NEW_HASH() }]], [owner]);                         // eta = now + 48 h

    // week 0: four questions; A 4 right, B 3, C 2, D 1, E 0 (all eligible)
    at(GENESIS + 12 * HOUR);
    for (let i = 0; i < 4; i++) {
      const ws = sim.height + Math.ceil((GENESIS + DAY - sim.time) / 2800) + 20;
      await ok([["post_question", { k: 2, lock_time: String(GENESIS + DAY), window_start: String(ws), window_end: String(ws + 1000), params_hash: "0x" + "ab".repeat(32) }]], [operator]);
    }
    at(GENESIS + 13 * HOUR);
    for (const [j, p] of players.entries()) for (let i = 0; i < 4; i++) await ok([["answer", { player: addr(p), question_id: i, option: i < 4 - j ? 1 : 0 }]], [p]);
    at(GENESIS + 2 * DAY);
    for (let i = 0; i < 4; i++) await ok([["resolve_question", { id: i, outcome: 1, data_hash: "0x" + "cd".repeat(32) }]], [operator]);
    await sim.ledgerAdd(1, addr(contract), 60n * VHP);                                       // block rewards
    await sim.ledgerAdd(3, addr(contract), 60n * VHP);

    // the live code takes the week as far as `point`
    const close = async () => { at(GENESIS + WEEK + 12 * HOUR); await ok([["close_week", { week: "0" }]], []); };
    const settle = async (ps: Signer[]) => { for (const p of ps) await ok([["settle", { player: addr(p), week: "0" }]], []); };
    const finalize = async () => { at(GENESIS + WEEK + 37 * HOUR); await ok([["finalize_week", { week: "0" }]], []); };
    at(GENESIS + WEEK + HOUR);
    if (point !== "week ended, not closed") await close();
    if (point === "closed, mid-settlement") await settle([A, B]);
    if (point === "settled, not finalized" || point === "finalized, claims open") await settle(players);
    if (point === "finalized, claims open") await finalize();
    const before = { state: await sim.read("get_state", {}), week: await sim.read("get_week", { week: "0" }) };

    // the upgrade, through the live code's own authorize(contract_upload): refused without the owner, or with a switch
    // off; accepted with the owner's authority and all three switches on
    assert.equal(await sim.uploadAuthorized(NEW, [addr(operator)]), false, "operator alone may not upload");
    assert.equal(await sim.uploadAuthorized(NEW, [addr(owner)], { call: true, tx: true, upload: false }), false, "a switch off is refused");
    assert.equal(await sim.uploadAuthorized(NEW, [addr(owner)]), true, "owner-authorized upload of the announced code");
    sameAsBefore(before, { state: await sim.read("get_state", {}), week: await sim.read("get_week", { week: "0" }) }, "view", new Set(["scorer_rule_week_plus_one", "reward_rule_week_plus_one"]));

    // the new code finishes the week
    if (point === "week ended, not closed") { await close(); await settle(players); }
    if (point === "closed, mid-settlement") await settle([C, D, E]);
    if (point !== "finalized, claims open") await finalize();
    const w0 = (await sim.read("get_week", { week: "0" })).week;
    assert.equal(w0.finalized, true);
    let paid = 0;
    for (const p of players) {
      const e = (await sim.read("get_player", { player: addr(p), week: "0" })).entry;
      if (e?.eligible && Number(e.points ?? 0) >= Number(w0.cutoff ?? 0)) { await ok([["claim", { player: addr(p), week: "0" }]], [p]); paid++; }
    }
    assert.ok(paid >= 1, "at least one winner was paid after the upgrade");
    at(sim.time + HOUR);
    for (const p of players) {
      const pl = (await sim.read("get_player", { player: addr(p), week: "1" })).player ?? {};
      const all = BigInt(pl.stake ?? 0) + BigInt(pl.pending ?? 0);
      if (all > 0n) await ok([["withdraw", { to: addr(p), amount: String(all) }]], [p]);
    }
    const s = await sim.read("get_state", {});
    const owed = ["total_stake", "seed_vhp", "seed_koin", "owner_share", "creator_fee", "pots_outstanding"].reduce((n, k) => n + BigInt(s.totals[k] ?? 0), 0n);
    assert.ok(BigInt(s.vhp_balance ?? 0) + BigInt(s.koin_balance ?? 0) >= owed, "holdings cover what is owed");
    assert.equal(s.totals.total_stake ?? "0", "0");
  });
}

// audit U1-02: a rollback to the live code is itself an upgrade through the new code's checks; the documented losses
// (runbook "If something goes wrong") really happen, and nothing players own is lost.
test("rollback to the live code: authorized by the new code, data intact, documented losses as described", { skip: !fs.existsSync(NEW) && `${NEW} missing: run npm run build:sim in game/` }, async () => {
  const sim = new SimChain(addr(contract), NEW);
  await sim.init();
  const at = (t: number) => sim.setHeight(H0 + Math.floor((t - T0) / 3000), t);
  const ok = async (calls: any[], who: Signer[]) => {
    const r = await sim.sendAs(calls.map(([method, args]) => ({ method, args })), who.map(addr));
    assert.ok(r.ok, `${calls.map((c) => c[0]).join(", ")}: ${r.error}`);
  };
  await sim.ledgerSet(2, addr(A), 1000n * VHP); await sim.ledgerSet(3, addr(A), 1000n * VHP);
  at(T0);
  await ok([["init", { owner: addr(owner), operator: addr(operator), seed_owner: addr(seedOwner), genesis_time: String(GENESIS), week_length: String(WEEK),
    close_delay: String(12 * HOUR), settle_length: String(DAY), timelock_length: String(2 * DAY), min_stake: String(VHP), max_sponsor_rc: String(2n * VHP) }]], [contract]);
  await ok([["deposit_vhp", { from: addr(A), amount: String(100n * VHP) }]], [A]);
  at(GENESIS + HOUR);
  const oldHash = "0x" + crypto.createHash("sha256").update(fs.readFileSync(OLD)).digest("hex");
  await ok([["schedule_upgrade", { hash: oldHash }]], [owner]);
  await ok([["propose_owner", { new_owner: addr(NEXT) }]], [owner]);
  assert.equal((await sim.sendAs([{ method: "accept_owner", args: {} }], [addr(NEXT)])).ok, false, "v4: a transfer must wait");
  at(GENESIS + HOUR + 2 * DAY);
  assert.equal(await sim.uploadAuthorized(OLD, [addr(owner)]), true, "the new code authorizes the announced rollback");
  const st = await sim.read("get_player", { player: addr(A), week: "0" });
  assert.equal(String(BigInt(st.player?.stake ?? 0) + BigInt(st.player?.pending ?? 0)), String(100n * VHP), "the stake survives the rollback");
  // documented loss: the old code has no waiting time, so the pending transfer is acceptable at once
  assert.equal((await sim.sendAs([{ method: "accept_owner", args: {} }], [addr(NEXT)])).ok, true, "old code: pending transfer accepted at once (runbook: cancel it first)");
  // and the 7-day limit: an announcement left past eta + 7 days is refused by the new code
  const sim2 = new SimChain(addr(contract), NEW); await sim2.init();
  sim2.setHeight(H0, T0);
  assert.ok((await sim2.sendAs([{ method: "init", args: { owner: addr(owner), operator: addr(operator), seed_owner: addr(seedOwner), genesis_time: String(GENESIS), week_length: String(WEEK),
    close_delay: String(12 * HOUR), settle_length: String(DAY), timelock_length: String(2 * DAY), min_stake: String(VHP), max_sponsor_rc: String(2n * VHP) } }], [addr(contract)])).ok);
  assert.ok((await sim2.sendAs([{ method: "schedule_upgrade", args: { hash: oldHash } }], [addr(owner)])).ok);
  sim2.setHeight(H0 + 100_000, T0 + 2 * DAY + 3 * DAY);
  assert.equal(await sim2.uploadAuthorized(NEW, [addr(owner)]), false, "only the announced code (a different hash is refused)");
  sim2.setHeight(H0 + 300_000, T0 + 2 * DAY + 8 * DAY);
  assert.equal(await sim2.uploadAuthorized(OLD, [addr(owner)]), false, "past eta + 7 days: announce it again");
});

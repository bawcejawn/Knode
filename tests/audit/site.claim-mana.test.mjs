// The contract agrees to pay for a claim when the VHP it is short can be burned back from spare KOIN within its Mana
// left after the transaction's own limit, but the claim itself may burn up to all of its Mana. In that state the site
// makes the player pay the claim's Mana: it names the player as payer, signs first, and never sends a transaction
// whose payer the wallet switched to anyone else.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const KOIN = 100_000_000n;
const app = fs.readFileSync("site/app.js", "utf8");
const wallet = fs.readFileSync("site/wallet.js", "utf8");

const a = app.indexOf("// claim-mana:start"), b = app.indexOf("// claim-mana:end");
assert.ok(a > 0 && b > a, "claim-mana markers in site/app.js");
const appCtx = vm.createContext({ BigInt, S: {} });
vm.runInContext(`const big = (x) => { try { return BigInt(x ?? 0); } catch { return 0n; } };\n${app.slice(a, b)}\nthis.f = claimNeedsOwnMana;`, appCtx);
const needsOwn = (c, st) => appCtx.f(c, st);

/** get_state as the site reads it. Amounts in KOIN. */
const state = ({ vhp, koin, mana, seedKoin = 0, fee = 0, cap = 1 }) => ({
  vhp_balance: String(BigInt(Math.round(vhp * 1e8))), koin_balance: String(BigInt(Math.round(koin * 1e8))), mana: String(BigInt(Math.round(mana * 1e8))),
  totals: { seed_koin: String(BigInt(Math.round(seedKoin * 1e8))), creator_fee: String(BigInt(Math.round(fee * 1e8))) },
  config: { max_sponsor_rc: String(BigInt(Math.round(cap * 1e8))) },
});

test("short of VHP with more spare KOIN than Mana minus the limit: the player pays (the contract would approve, then the claim could burn the Mana its own transaction needs)", () => {
  // The audit's case: 90 KOIN spare, 89.5 Mana left after a 1 KOIN rc_limit.
  assert.equal(needsOwn({ week: 0, reward: 100n * KOIN }, state({ vhp: 10, koin: 90, mana: 90.5 })), true);
  // Seed KOIN and the creator fee are not spare.
  assert.equal(needsOwn({ week: 0, reward: 100n * KOIN }, state({ vhp: 10, koin: 120, mana: 90.5, seedKoin: 20, fee: 10 })), true);
});

test("legitimate free claims stay free", () => {
  assert.equal(needsOwn({ week: 0, reward: 5n * KOIN }, state({ vhp: 10, koin: 90, mana: 50 })), false, "VHP on hand covers the reward");
  assert.equal(needsOwn({ week: 0, reward: 100n * KOIN }, state({ vhp: 10, koin: 90, mana: 200 })), false, "plenty of Mana");
  assert.equal(needsOwn({ week: 0, reward: 100n * KOIN }, state({ vhp: 10, koin: 20, mana: 5, seedKoin: 20 })), false, "no spare KOIN to burn: nothing can eat the Mana");
});

test("an unknown reward or no state yet counts as short (the player pays)", () => {
  assert.equal(needsOwn({ week: 0, reward: 0n }, state({ vhp: 1000, koin: 90, mana: 90.5 })), true);
  assert.equal(needsOwn(undefined, state({ vhp: 1000, koin: 90, mana: 90.5 })), true);
  assert.equal(needsOwn({ week: 0, reward: 1n }, null), true);
});

test("the claim button passes that decision to the wallet", () => {
  // v5: a free player's prize is always claimed with their own Mana; a staker's when claimNeedsOwnMana says so.
  assert.match(app, /\{ ownMana: \(S\.claims\.find\(\(c\) => c\.week === week\) \|\| \{\}\)\.free \|\| claimNeedsOwnMana\(S\.claims\.find\(\(c\) => c\.week === week\)\) \}/);
  assert.match(app, /window\.KWallet\.send\(label, ops, opts\)/);
});

// ── wallet.js: sendKondor with stub Kondor and koilib ──
const s0 = wallet.indexOf("  async function sendKondor"), s1 = wallet.indexOf("  async function sendVault");
assert.ok(s0 > 0 && s1 > s0, "sendKondor in site/wallet.js");
function kondorWorld(signPayer) {
  const log = { options: undefined, signed: 0, sent: 0 };
  class Transaction {
    constructor(c) { log.options = c.options; this.transaction = { header: { payer: c.options?.payer ?? "1Player" } }; }
    async pushOperation() {}
    async sign() { log.signed++; return { ...this.transaction, header: { payer: signPayer }, signatures: ["x"] }; }
    async send() { log.sent++; return {}; }
  }
  const ctx = vm.createContext({
    W: { address: "1Player", provider: { wait: async () => {} } }, lib: { Transaction },
    window: { kondor: { getSigner: () => ({}) } }, JSON,
  });
  vm.runInContext(wallet.slice(s0, s1) + "\nthis.sendKondor = sendKondor;", ctx);
  return { log, send: (opts) => ctx.sendKondor("collect week 1 reward", [{}], opts) };
}

test("own Mana: the player is the payer, the transaction is signed and checked before it is sent", async () => {
  const w = kondorWorld("1Player");
  await w.send({ ownMana: true });
  assert.equal(w.log.options?.payer, "1Player");
  assert.equal(w.log.signed, 1);
  assert.equal(w.log.sent, 1);
});

test("own Mana: a transaction the wallet re-pointed to the contract (free Mana option) is never sent", async () => {
  const w = kondorWorld("1MpmfKpredContract");
  await assert.rejects(w.send({ ownMana: true }), /own Mana/);
  assert.equal(w.log.sent, 0);
});

test("every other transaction is sent as before (the wallet decides who pays)", async () => {
  const w = kondorWorld("1MpmfKpredContract");
  await w.send({});
  assert.equal(w.log.options, undefined);
  assert.equal(w.log.signed, 0);
  assert.equal(w.log.sent, 1);
});

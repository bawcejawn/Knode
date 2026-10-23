// Red-team (WEB ATTACKER, fix check d198283). Target: the own-Mana claim path. site/wallet.js send (:196-199),
// sendKondor's payer check after sign (:203-221), sendVault (:223-257), and claimNeedsOwnMana in site/app.js
// (between claim-mana:start/end). The Transaction stub below copies koilib 9.4.1 lib/Transaction.js sign (:292-298,
// returns the wallet's transaction, does not keep it) and send (:302-327: a transaction WITHOUT signatures goes to
// the wallet's sendTransaction, which signs and broadcasts it itself and may still switch the payer).
// Each case asserts the SAFE behaviour, so a failing case is a proven problem. Offline, nothing is fetched.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const APP = process.env.APP || ".";
const wallet = fs.readFileSync(`${APP}/site/wallet.js`, "utf8");
const app = fs.readFileSync(`${APP}/site/app.js`, "utf8");
const PLAYER = "1PlayerXXXXXXXXXXXXXXXXXXXXXXXXXXX", CONTRACT = "1Mpmf2ERhjYpX7CCiM11WERuM4j17uT1sr";

const s0 = wallet.indexOf("  async function send(label"), s1 = wallet.indexOf("  function init(");
assert.ok(s0 > 0 && s1 > s0, "send/sendKondor/sendVault in site/wallet.js");

/** wallet.js send+sendKondor+sendVault in a vm. kondor.sign(tx) is what Kondor's signTransaction resolves to;
 *  kondor's sendTransaction applies the free-Mana option (payer = the contract) when it signs. */
function world({ kind = "kondor", sign } = {}) {
  const log = { sentVia: null, sentTx: null, vaultBodies: [] };
  class Transaction {
    constructor(c) {
      this.signer = c.signer; this.provider = c.provider; this.options = { ...(c.options || {}) };
      this.transaction = { header: { ...(c.options?.payer ? { payer: c.options.payer } : {}) }, operations: [] };
    }
    async pushOperation(op) { this.transaction.operations.push(op); }
    async prepare() { this.transaction.id = "0x1220" + "ab".repeat(32); this.transaction.header.payer ??= PLAYER; this.transaction.header.rc_limit = "100000000"; }
    async sign() { if (!this.transaction.id) await this.prepare(); return this.signer.signTransaction(this.transaction); }
    async send(o) {
      if (!this.transaction.id) await this.prepare();
      if (!this.transaction.signatures || !this.transaction.signatures.length) {
        const { transaction, receipt } = await this.signer.sendTransaction(this.transaction, o);
        this.transaction = transaction; log.sentVia = "wallet"; log.sentTx = transaction; return receipt;
      }
      log.sentVia = "provider"; log.sentTx = this.transaction; return {};
    }
  }
  const signer = {
    signTransaction: async (tx) => sign(structuredClone(tx)),
    sendTransaction: async (tx) => ({ transaction: { ...tx, header: { ...tx.header, payer: CONTRACT }, signatures: ["kondor"] }, receipt: {} }),
  };
  const ctx = {
    W: { kind, address: PLAYER, provider: { wait: async () => {} }, session: { sessionId: "s", secret: "x", expiresAt: Date.now() + 1e6 } },
    lib: { Transaction }, window: { kondor: { getSigner: () => signer } }, JSON, Date, Number,
    creds: () => ({ sessionId: "s", secret: "x" }), dropVault: () => {}, h: () => ({}), open: () => ({}), close: () => {}, sleep: async () => {},
    vaultApi: async (path, { body } = {}) => { if (path === "request") { log.vaultBodies.push(body); throw Object.assign(new Error("stop here"), { status: 500 }); } return {}; },
  };
  vm.createContext(ctx);
  vm.runInContext(wallet.slice(s0, s1) + "\nthis.send = send;", ctx);
  return { log, send: (opts) => ctx.send("collect week 1 reward", [{ call_contract: { contract_id: CONTRACT, entry_point: 1, args: "" } }], opts) };
}
/** True when the transaction that went out names the player as payer, or nothing went out. */
const payerKept = (log) => log.sentTx === null || log.sentTx.header.payer === PLAYER;

test("WEB3-20 control: a signed claim whose payer is the player is broadcast as signed", async () => {
  const w = world({ sign: (tx) => ({ ...tx, signatures: ["sig"] }) });
  await w.send({ ownMana: true });
  assert.equal(w.log.sentVia, "provider");
  assert.equal(w.log.sentTx.header.payer, PLAYER);
});

test("WEB3-21 own Mana: a wallet whose sign step returns nothing must not get the claim to sign and send itself", async () => {
  const w = world({ sign: () => undefined });
  await w.send({ ownMana: true }).catch(() => {});
  assert.ok(payerKept(w.log), `the payer check read the page's own unsigned header, then the wallet's sendTransaction sent it with payer ${w.log.sentTx?.header.payer}`);
});

test("WEB3-22 own Mana: a signed transaction without signatures must not be handed to the wallet's sendTransaction", async () => {
  const w = world({ sign: (tx) => ({ ...tx, signatures: [] }) });
  await w.send({ ownMana: true }).catch(() => {});
  assert.ok(payerKept(w.log), `sent via ${w.log.sentVia} with payer ${w.log.sentTx?.header.payer}`);
});

// Open: KOIN Vault documents no way to ask for the player's own Mana, so the page keeps "auto" and shows the player a
// notice instead (owner's decision); this stays open until KOIN Vault offers such an option.
test("WEB3-23 own Mana with KOIN Vault: the request must not leave the payer choice to KOIN Vault ('auto')", { todo: "KOIN Vault has no documented own-Mana option; the page shows a notice" }, async () => {
  const w = world({ kind: "vault" });
  await w.send({ ownMana: true }).catch(() => {});
  assert.equal(w.log.vaultBodies.length, 1);
  assert.notEqual(w.log.vaultBodies[0].mana, "auto", "send() drops opts for KOIN Vault (wallet.js:198) and sendVault always asks for mana: \"auto\" (wallet.js:227)");
});

// ── claimNeedsOwnMana with odd inputs ──
const a = app.indexOf("// claim-mana:start"), b = app.indexOf("// claim-mana:end");
assert.ok(a > 0 && b > a, "claim-mana markers in site/app.js");
const bi = app.match(/const big = \(x\) => \{[^\n]*\};/);
assert.ok(bi, "big() in site/app.js");
const actx = vm.createContext({ BigInt, S: {} });
vm.runInContext(`${bi[0]}\n${app.slice(a, b)}\nthis.f = claimNeedsOwnMana;`, actx);
const needsOwn = (c, st) => actx.f(c, st);
const K = 100_000_000n;
const short = { vhp_balance: String(10n * K), koin_balance: String(90n * K), mana: String(90n * K + K / 2n), totals: {}, config: { max_sponsor_rc: String(K) } };

test("WEB3-24 control: get_state as strings, missing totals or a missing Mana field still make the player pay when short", () => {
  assert.equal(needsOwn({ week: 0, reward: 100n * K }, short), true);
  assert.equal(needsOwn({ week: 0, reward: 100n * K }, { ...short, totals: undefined }), true);
  assert.equal(needsOwn({ week: 0, reward: 100n * K }, { ...short, mana: undefined }), true);
  assert.equal(needsOwn({ week: 0, reward: 100n * K }, { ...short, mana: "garbage" }), true);
  assert.equal(needsOwn({ week: 0, reward: String(100n * K) }, short), true, "reward as a string");
});

test("WEB3-25 an unknown reward given as the string '0' counts as short, as the doc comment says", () => {
  const plenty = { ...short, vhp_balance: String(1000n * K) };  // VHP on hand looks fine, but the reward is unknown
  assert.equal(needsOwn({ week: 0, reward: "0" }, plenty), true, "reward \"0\" is truthy: treated as known and covered (not reachable today: rewards are BigInt, app.js:245)");
});

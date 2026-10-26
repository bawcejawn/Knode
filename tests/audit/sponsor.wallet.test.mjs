// The Mana sponsor in site/wallet.js: when the page names the sponsor as payer, and when it must not.
// The wallet code runs in a vm with a Transaction stub (as in web3.own-mana.test.mjs); nothing is fetched.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { utils } from "koilib";

const APP = process.env.APP || ".";
const wallet = fs.readFileSync(`${APP}/site/wallet.js`, "utf8");
const PLAYER = "1JEG83vHFKLwt3dnDqjuX9s5Zc56U4bQet", GAME = "1Mpmf2ERhjYpX7CCiM11WERuM4j17uT1sr", DESK = "1FKTpXBhhHEbu5vVchM8UsVbAvPArJsRmR";
const VHP = "12Y5vW6gk8GceH53YfRkRre2Rrcsgw7Naq", KOIN = "19GYjDBVXU7keLbYvMLazsGQn3GTWHjHkK", POB = "159myq5YUhhoVWu3wsHKHiJYKPKGUrGiyv";
const SPONSOR = "1AZsVFFrvKFhhxLq2jKHUUesdm2zbCcbXW";
const APPROVE = 0x74e21680;

const s0 = wallet.indexOf("  async function sendKondor("), s1 = wallet.indexOf("  async function sendVault(");
assert.ok(s0 > 0 && s1 > s0, "sponsor helpers and sendKondor in site/wallet.js");

function world({ payer = "sponsor", sponsor = { address: SPONSOR, covers: [GAME, DESK, VHP, KOIN], tokens: [VHP, KOIN], rcLimit: "100000000" }, yes = true, refuseOnSend = false } = {}) {
  const log = { built: [], sent: [], asked: [] };
  class Transaction {
    constructor(c) { this.signer = c.signer; this.options = { ...(c.options || {}) }; this.transaction = { header: { ...(c.options?.payer ? { payer: c.options.payer } : {}), ...(c.options?.payee ? { payee: c.options.payee } : {}) }, operations: [] }; log.built.push(this.options); }
    async pushOperation(op) { this.transaction.operations.push(op); }
    async prepare() { this.transaction.id = "0x1220" + "ab".repeat(32); this.transaction.header.payer ??= PLAYER; }
    async sign() { if (!this.transaction.id) await this.prepare(); return { ...this.transaction, signatures: ["sig"] }; }
    async send() {
      if (!this.transaction.id) await this.prepare();
      log.sent.push(this.transaction.header.payer);
      if (refuseOnSend && this.transaction.header.payer === SPONSOR) throw new Error('{"error":"SPONSOR: today\'s sponsored mana is used up"}');
      return {};
    }
  }
  const signer = {};
  const provider = {
    wait: async () => {},
    readContract: async (q) => { log.asked.push(q); return { result: yes ? utils.encodeBase64url(new Uint8Array([0x08, 0x01, 0x18, 0x05])) : utils.encodeBase64url(new Uint8Array([0x12, 0x02, 0x6e, 0x6f])) }; },
  };
  const ctx = {
    W: { kind: "kondor", address: PLAYER, provider, payer, sponsor },
    lib: { Transaction, utils }, window: { kondor: { getSigner: () => signer } }, JSON, Number, BigInt, Uint8Array, Promise, setTimeout,
    withTimeout: (p) => p,
  };
  vm.createContext(ctx);
  vm.runInContext(wallet.slice(s0, s1) + "\nthis.sendKondor = sendKondor;", ctx);
  const op = (contract, entry = 1) => ({ call_contract: { contract_id: contract, entry_point: entry, args: "" } });
  return { log, op, send: (ops, opts = {}) => ctx.sendKondor("test", ops, opts) };
}

test("the sponsor pays a game action when it is on and would_pay says yes", async () => {
  const w = world();
  await w.send([w.op(VHP, APPROVE), w.op(GAME)]);
  assert.equal(w.log.asked.length, 1);
  assert.equal(w.log.asked[0].contract_id, SPONSOR);
  assert.equal(w.log.asked[0].entry_point, 0xda1fd8f5);
  assert.deepEqual(w.log.built[0], { payer: SPONSOR, payee: PLAYER, rcLimit: "100000000" });
  assert.deepEqual(w.log.sent, [SPONSOR]);
});

test("would_pay is asked about this player and the transaction's Mana limit", async () => {
  const w = world();
  await w.send([w.op(DESK)]);
  const args = utils.decodeBase64url(w.log.asked[0].args);
  assert.deepEqual([...args.slice(0, 2)], [0x0a, 25]);
  assert.equal(utils.encodeBase58(args.slice(2, 27)), PLAYER);
  assert.equal(args[27], 0x10);
});

test("a no from would_pay: the player's own Mana, the sponsor is not named", async () => {
  const w = world({ yes: false });
  await w.send([w.op(GAME)]);
  assert.equal(w.log.built.length, 1);
  assert.equal(w.log.built[0].payer, undefined);
  assert.deepEqual(w.log.sent, [PLAYER]);
});

test("a call to any other contract (burning KOIN on Proof-of-Burn): never the sponsor", async () => {
  const w = world();
  await w.send([w.op(POB)]);
  assert.equal(w.log.asked.length, 0);
  assert.deepEqual(w.log.sent, [PLAYER]);
});

test("a token call other than approve: never the sponsor", async () => {
  const w = world();
  await w.send([w.op(VHP, 0x27f576ca), w.op(GAME)]);
  assert.equal(w.log.asked.length, 0);
  assert.deepEqual(w.log.sent, [PLAYER]);
});

test("a staked player's answer stays with the game (gamePays)", async () => {
  const w = world();
  await w.send([w.op(GAME)], { gamePays: true });
  assert.equal(w.log.asked.length, 0);
  assert.deepEqual(w.log.sent, [PLAYER]);
});

test("payer \"self\" in deployment.json: the sponsor is never asked", async () => {
  const w = world({ payer: "self" });
  await w.send([w.op(GAME)]);
  assert.equal(w.log.asked.length, 0);
  assert.deepEqual(w.log.sent, [PLAYER]);
});

test("no sponsor configured: the player's own Mana", async () => {
  const w = world({ sponsor: null });
  await w.send([w.op(GAME)]);
  assert.deepEqual(w.log.sent, [PLAYER]);
});

test("the sponsor refuses when it is sent: the page falls back to the player's own Mana", async () => {
  const w = world({ refuseOnSend: true });
  await w.send([w.op(GAME)]);
  assert.deepEqual(w.log.sent, [SPONSOR, PLAYER]);
});

test("more than 10 operations: never the sponsor", async () => {
  const w = world();
  await w.send(Array.from({ length: 11 }, () => w.op(GAME)));
  assert.equal(w.log.asked.length, 0);
});

test("an own-Mana claim may be paid by the sponsor (never by the game contract)", async () => {
  const w = world();
  await w.send([w.op(GAME)], { ownMana: true });
  assert.deepEqual(w.log.sent, [SPONSOR]);
});

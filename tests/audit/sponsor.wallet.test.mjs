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
  const state = { repoint: null };
  class Transaction {
    constructor(c) { this.signer = c.signer; this.options = { ...(c.options || {}) }; this.transaction = { header: { ...(c.options?.payer ? { payer: c.options.payer } : {}), ...(c.options?.payee ? { payee: c.options.payee } : {}) }, operations: [] }; log.built.push(this.options); }
    async pushOperation(op) { this.transaction.operations.push(op); }
    async prepare() { this.transaction.id = "0x1220" + "ab".repeat(32); this.transaction.header.payer ??= PLAYER; }
    async sign() { if (!this.transaction.id) await this.prepare(); const t = { ...this.transaction, signatures: ["sig"] }; if (state.repoint) t.header = { ...t.header, payer: state.repoint }; return t; }
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
  return { log, op, send: (ops, opts = {}) => ctx.sendKondor("test", ops, opts), set repoint(v) { state.repoint = v; } };
}

test("the sponsor pays a game action when it is on and would_pay says yes", async () => {
  const w = world();
  await w.send([w.op(VHP, APPROVE), w.op(GAME)]);
  assert.equal(w.log.asked.length, 1);
  assert.equal(w.log.asked[0].contract_id, SPONSOR);
  assert.equal(w.log.asked[0].entry_point, 0xda1fd8f5);
  assert.deepEqual(w.log.built[0], { payer: SPONSOR, payee: PLAYER, rcLimit: "300000000" });
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

test("a no from would_pay: the player's own Mana, named as payer (never the sponsor, never the game)", async () => {
  const w = world({ yes: false });
  await w.send([w.op(GAME)]);
  assert.equal(w.log.built.length, 1);
  assert.equal(w.log.built[0].payer, PLAYER);
  assert.deepEqual(w.log.sent, [PLAYER]);
});

test("not sponsored and the wallet re-points the payer to the game contract (free Mana option): not sent", async () => {
  const w = world({ yes: false });
  // Stand-in for Kondor's free Mana option: the signed transaction names the game contract as payer.
  w.repoint = GAME;
  await assert.rejects(w.send([w.op(GAME)]), /own Mana/);
  assert.deepEqual(w.log.sent, []);
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

// ── sponsor v3: each action's own Mana limit (rcLimits, from the sponsor's mana-report) ──
const PICKS = "1MbsVfNw6yzQqA8499d8KQj8qdLyRs8CzW", PICK = 0x8ce33c6c, ANSWER = 0x0db52f40;
const withLimits = (rcLimits) => ({ address: SPONSOR, covers: [GAME, DESK, VHP, KOIN, PICKS], tokens: [VHP, KOIN], picks: PICKS, rcLimit: "100000000", rcLimitOther: "300000000", rcLimits });
test("v3: a pick asks for its own limit; several ask for the sum; never more than the old limit", async () => {
  const w = world({ sponsor: withLimits({ [`${PICKS}:8ce33c6c`]: "8000000" }) });
  await w.send([w.op(PICKS, PICK)]);
  assert.equal(w.log.built[0].rcLimit, "8000000", "0.08 Mana for one pick");
  await w.send([w.op(PICKS, PICK), w.op(PICKS, PICK), w.op(PICKS, PICK)]);
  assert.equal(w.log.built[1].rcLimit, "24000000", "0.24 for three");
  const many = Array.from({ length: 10 }, () => w.op(PICKS, PICK));
  const w2 = world({ sponsor: withLimits({ [`${PICKS}:8ce33c6c`]: "20000000" }) });
  await w2.send(many);
  assert.equal(w2.log.built[0].rcLimit, "100000000", "10 × 0.2 = 2, capped at the old 1 Mana");
});
test("v3: an action without its own limit keeps the old limit; a malformed entry is ignored", async () => {
  const w = world({ sponsor: withLimits({ [`${PICKS}:8ce33c6c`]: "8000000" }) });
  await w.send([w.op(GAME, ANSWER), w.op(PICKS, PICK)]);
  assert.equal(w.log.built[0].rcLimit, "100000000", "the answer has no row: the old answers limit");
  const w2 = world({ sponsor: withLimits({ [`${PICKS}:8ce33c6c`]: "-5" }) });
  await w2.send([w2.op(PICKS, PICK)]);
  assert.equal(w2.log.built[0].rcLimit, "100000000");
  const w3 = world({ sponsor: withLimits({ [`${PICKS}:8ce33c6c`]: "1e9" }) });
  await w3.send([w3.op(PICKS, PICK)]);
  assert.equal(w3.log.built[0].rcLimit, "100000000");
});

// ── audit BXW-2: the Kondor path names the chain and re-checks what Kondor signed ──
function kondorTamper(tamper, chainId = "EiBZK_GGVP0H_fXVAM3j6EAuz3-B-l3ejxRSewi7qIBfSA==") {
  const built = [];
  class Transaction {
    constructor(c) { this.options = { ...(c.options || {}) }; built.push(this.options); this.transaction = { header: { payer: c.options?.payer, chain_id: c.options?.chainId, rc_limit: c.options?.rcLimit }, operations: [] }; }
    async pushOperation(op) { this.transaction.operations.push(op); }
    async sign() { return tamper({ ...this.transaction, header: { ...this.transaction.header }, operations: [...this.transaction.operations], signatures: ["s"] }); }
    async send() { return {}; }
  }
  const ctx = { W: { kind: "kondor", address: PLAYER, provider: { wait: async () => {} }, payer: "self", chainId }, lib: { Transaction, utils }, window: { kondor: { getSigner: () => ({}) } },
    JSON, Number, BigInt, Uint8Array, Promise, setTimeout, String, withTimeout: (p) => p };
  vm.createContext(ctx);
  vm.runInContext(wallet.slice(s0, s1) + "\nthis.sendKondorWith = sendKondorWith;", ctx);
  const op = { call_contract: { contract_id: GAME, entry_point: 1, args: "AA" } };
  return { built, send: (opts) => ctx.sendKondorWith("t", [op], opts) };
}
test("BXW-2: the chain id is named in the transaction; another chain, a raised Mana limit or changed operations are not sent", async () => {
  const ok = kondorTamper((t) => t);
  await ok.send({ ownMana: true });
  assert.equal(ok.built[0].chainId, "EiBZK_GGVP0H_fXVAM3j6EAuz3-B-l3ejxRSewi7qIBfSA==");
  await assert.rejects(kondorTamper((t) => ({ ...t, header: { ...t.header, chain_id: "other" } })).send({ ownMana: true }), /another chain/);
  await assert.rejects(kondorTamper((t) => ({ ...t, header: { ...t.header, rc_limit: "999999999" } })).send({ sponsor: SPONSOR, rcLimit: "100000000" }), /raised the Mana limit/);
  await assert.rejects(kondorTamper((t) => ({ ...t, operations: [{ call_contract: { contract_id: DESK, entry_point: 1, args: "AA" } }] })).send({ ownMana: true }), /changed what is signed/);
  await assert.rejects(kondorTamper((t) => ({ ...t, operations: [] })).send({ ownMana: true }), /changed what is signed/);
});

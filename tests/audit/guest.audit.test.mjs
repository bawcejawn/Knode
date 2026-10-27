// Audit attack tests for the Knode guest wallet (branch guest @ 332246b). Each test asserts the SAFE behaviour:
// a failing test is a proven finding, a passing one means the attack was blocked. Run from the repo root:
//   APP=. node --test tests/audit/guest.audit.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { createRequire } from "node:module";

const APP = path.resolve(process.env.APP || path.join(path.dirname(new URL(import.meta.url).pathname), "..", ".."));
const koilib = createRequire(APP + "/")("koilib");
const guestSrc = fs.readFileSync(`${APP}/site/guest.js`, "utf8");
const walletSrc = fs.readFileSync(`${APP}/site/wallet.js`, "utf8");
const appSrc = fs.readFileSync(`${APP}/site/app.js`, "utf8");
const MAINNET = "EiBZK_GGVP0H_fXVAM3j6EAuz3-B-l3ejxRSewi7qIBfSA==";
const GAME = "1Mpmf2ERhjYpX7CCiM11WERuM4j17uT1sr", DESK = "1FKTpXBhhHEbu5vVchM8UsVbAvPArJsRmR";
const VHP = "12Y5vW6gk8GceH53YfRkRre2Rrcsgw7Naq", KOIN = "19GYjDBVXU7keLbYvMLazsGQn3GTWHjHkK";
const SPONSOR = "1ByDDSBUzy5zkRceELc54Jh8i41yNRoKt8";
const ANSWER = 0x0db52f40, CLAIM = 0xdd1b3c31;

function fakeDom() {
  const all = [];
  const mk = (tag) => {
    const e = { tag, attrs: {}, kids: [], listeners: {}, style: {}, hidden: false, textContent: "", value: "", isConnected: true,
      setAttribute(k, v) { this.attrs[k] = v; if (k === "hidden") this.hidden = true; },
      addEventListener(t, f) { (this.listeners[t] ||= []).push(f); },
      append(...k) { for (const c of k) this.kids.push(c); },
      remove() { this.isConnected = false; },
      get text() { return [this.textContent, ...this.kids.map((c) => (typeof c === "string" ? c : c.text))].join(" "); },
      click() { return Promise.all((this.listeners.click || []).map((f) => f({ target: this }))); },
    };
    all.push(e);
    return e;
  };
  return { document: { createElement: mk, getElementById: () => null, head: mk("head"), body: mk("body"), documentElement: { style: {} } }, all };
}
function memStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}
/** One browser tab. Tabs made with the same `storage` share it, like two tabs (or two pages) of one origin. */
function world({ storage = memStorage(), sponsor = SPONSOR, covers = [GAME, DESK, VHP, KOIN], sendFails = null } = {}) {
  const { document, all } = fakeDom();
  const net = [];
  const provider = {
    getChainId: async () => MAINNET,
    getNextNonce: async () => "KAE",
    getAccountRc: async () => "0",
    readContract: async (q) => { net.push(["readContract", q]); return { result: koilib.utils.encodeBase64url(new Uint8Array([0x08, 0x01])) }; },
    sendTransaction: async (tx) => { net.push(["sendTransaction", JSON.parse(JSON.stringify(tx))]); if (sendFails) throw new Error(sendFails); return { transaction: { ...tx, wait: async () => ({}) }, receipt: {} }; },
    wait: async () => ({}),
  };
  const confirms = [];
  const win = { koilib, crypto: webcrypto, localStorage: storage, confirm: (m) => { confirms.push(m); return true; }, navigator: {} };
  win.top = win; win.self = win;
  const ctx = { window: win, document, localStorage: storage, sessionStorage: memStorage(), navigator: { userAgent: "test", maxTouchPoints: 0, platform: "x" },
    crypto: webcrypto, console, setTimeout, clearTimeout, Promise, URL, URLSearchParams, JSON, BigInt, Uint8Array, Array, Number, String, Object, Map, Set, Error, Math, Date };
  vm.createContext(ctx);
  vm.runInContext(guestSrc, ctx);
  vm.runInContext(walletSrc, ctx);
  win.KWallet.init({ provider, chainId: MAINNET, payer: "sponsor", toast: () => {}, status: () => {},
    sponsor: { address: sponsor, covers, tokens: [VHP, KOIN], rcLimit: "100000000", guest: true }, onChange: () => {} });
  const op = (c, e) => ({ call_contract: { contract_id: c, entry_point: e, args: "" } });
  const find = (re, tag = "button") => all.filter((e) => e.tag === tag && re.test(e.text));
  return { win, KG: win.KGuest, KW: win.KWallet, net, all, find, op, confirms, storage };
}
async function connectAsGuest(w) { const p = w.KW.connect(); w.find(/Play as a guest/)[0].click(); return p; }
const sentTx = (w) => w.net.filter(([m]) => m === "sendTransaction").map(([, t]) => t);

// ── AB-01 (Medium): any other page of the same origin can read the guest key ──
test("AB-01 another page of the same origin cannot read the guest key", { todo: "needs the custom domain (owner action, like S2): on the shared bawcejawn.github.io origin any page there can read this origin's storage; guest play stays off until then" }, async () => {
  const shared = memStorage();
  const knode = world({ storage: shared });
  const { address } = await knode.KG.create();
  // Another page on https://<user>.github.io (another repo's Pages site, or any page there with an XSS) runs this:
  const stolen = shared.getItem("kn-guest-v1");   // or indexedDB.open("knode-guest") → store "keys" → get("guest")
  assert.ok(!(stolen && koilib.Signer.fromWif(stolen).getAddress() === address),
    "a different page of the same origin read the guest's private key from storage");
});

// ── AB-02 (Medium): the key can be evicted by the browser with no warning ──
test("AB-02 guest.js asks the browser to keep the key (persistent storage) and warns that it can be cleared", () => {
  assert.match(guestSrc, /navigator\.storage\.persist\s*\(/, "no navigator.storage.persist(): the key's storage is best-effort and can be evicted");
  const welcome = walletSrc.slice(walletSrc.indexOf("function guestWelcome"), walletSrc.indexOf("async function backupGuest"));
  assert.match(welcome, /delete|by itself|automatically|7 days|unused/i, "the welcome screen doesn't say the browser itself may delete the key");
});

// ── AB-03 (Low): restore accepts any pasted key with no warning when no guest exists ──
test("AB-03 restoring a key warns that a key someone else gave you is theirs, not yours", async () => {
  const w = world();
  const p = w.KW.connect();
  w.find(/Restore a guest key/)[0].click();
  await new Promise((r) => setTimeout(r, 0));
  const attackerWif = koilib.Signer.fromSeed("attacker-known seed").getPrivateKey("wif", true);
  w.all.filter((e) => e.tag === "input").at(-1).value = attackerWif;
  await w.find(/^\s*Restore\s*$/)[0].click();
  await p;
  assert.equal(await w.KG.backupWif(), attackerWif, "setup: the pasted key was installed");
  const warned = w.confirms.length > 0 || w.all.some((e) => /someone (else )?(gave|sent)|only (paste|restore) a key you backed up yourself/i.test(e.text));
  assert.ok(warned, "a key from someone else was installed with no confirmation and no warning");
});

// ── AB-04 (Low): the prize instructions lead to a claim nobody pays for ──
test("AB-04 the 'Collect your prize' steps say that collecting needs a little Mana (KOIN) on that account", async () => {
  const w = world();
  await connectAsGuest(w);
  await assert.rejects(w.KW.send("collect", [w.op(GAME, CLAIM)]));
  assert.ok(w.all.some((e) => e.tag === "h3" && /Collect your prize/.test(e.text)));
  const steps = w.all.filter((e) => e.tag === "p" && /Import account/.test(e.text)).map((e) => e.text).join(" ");
  assert.match(steps, /Mana|KOIN/, "the steps end at 'tap Collect' in Kondor, but a free player's claim must use its own Mana and the guest has none");
});

// ── AB-05 (Low): a sponsor refusal at send time tells a guest to use Kondor's free Mana or hold KOIN ──
const REFUSAL = "insufficient rc: payer cannot pay (SPONSOR: today's free-player answers are used up)";
test("AB-05 control: a sponsor refusal at send time is never retried with the guest's own Mana", async () => {
  const w = world({ sendFails: REFUSAL });
  await connectAsGuest(w);
  await assert.rejects(w.KW.send("answer A", [w.op(GAME, ANSWER)]));
  const sent = sentTx(w);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].header.payer, SPONSOR);
});
test("AB-05 a sponsor refusal at send time gives a guest a guest message, not Kondor/KOIN advice", async () => {
  const w = world({ sendFails: REFUSAL });
  await connectAsGuest(w);
  const err = await w.KW.send("answer A", [w.op(GAME, ANSWER)]).catch((e) => e);
  const s = appSrc.indexOf("  function friendlyError("), e = appSrc.indexOf("\n  }\n", s) + 4;
  const ctx = {}; vm.createContext(ctx); vm.runInContext(appSrc.slice(s, e) + "\nthis.f = friendlyError;", ctx);
  const shown = ctx.f(String(err.message || err));
  assert.doesNotMatch(shown, /Kondor|KOIN Vault|hold a little KOIN/, `a guest is shown: "${shown}"`);
});

// ── AB-06 (Low): two tabs, one stored key ──
test("AB-06 two tabs starting a guest at the same moment end with one key, not one orphaned address", async () => {
  const shared = memStorage();
  const a = world({ storage: shared }), b = world({ storage: shared });
  const r = await Promise.allSettled([a.KG.create(), b.KG.create()]);
  const made = r.filter((x) => x.status === "fulfilled").map((x) => x.value.address);
  assert.ok(made.length === 1 || new Set(made).size === 1, `both tabs report a new guest (${made.join(", ")}) but storage keeps only one key`);
});
test("AB-06 the backup screen refuses to show a key that isn't the connected guest", async () => {
  const shared = memStorage();
  const a = world({ storage: shared });
  const addrA = await connectAsGuest(a);
  const b = world({ storage: shared });   // another tab restores a different key (it asks; the player says yes)
  await b.KG.restore(koilib.Signer.fromSeed("other").getPrivateKey("wif", true));
  a.KW.manageGuest();
  await a.find(/Back up guest key/).at(-1).click();
  const shownKey = a.all.filter((e) => e.attrs.class === "kw-key").at(-1);
  if (!shownKey) return;   // refused: safe
  assert.equal(koilib.Signer.fromWif(shownKey.text.trim()).getAddress(), addrA, "the backup shown under guest A is guest B's key");
});

// ── AB-07 (Low): sponsor and game ids are not pinned in the page ──
test("AB-07 a deployment.json sponsor address other than the live sponsor is refused for guests", async () => {
  const other = koilib.Signer.fromSeed("not the sponsor").getAddress();
  const w = world({ sponsor: other });
  await connectAsGuest(w);
  await w.KW.send("answer A", [w.op(GAME, ANSWER)]).catch(() => {});
  assert.ok(!sentTx(w).some((t) => t.header.payer === other), "the guest signed a transaction naming a payer that is not the live sponsor");
});
test("AB-07 the guest's game contract is the deployment's contract, not whatever is first in sponsor.covers", async () => {
  const w = world({ covers: [DESK, GAME, VHP, KOIN] });
  await connectAsGuest(w);
  await w.KW.send("answer on desk", [w.op(DESK, ANSWER)]).catch(() => {});
  assert.equal(sentTx(w).length, 0, "with covers reordered the guest signed entry point 0x0db52f40 on the Desk contract");
});

// ── controls: these must pass ──
test("control: mixed operations, other contracts, >10 ops and no ops are never signed by a guest", async () => {
  const w = world();
  await connectAsGuest(w);
  for (const ops of [[w.op(GAME, ANSWER), w.op(VHP, 0x74e21680)], [w.op(KOIN, ANSWER)], [w.op(GAME, ANSWER), w.op(GAME, 0x12345678)], Array(11).fill(w.op(GAME, ANSWER)), []])
    await assert.rejects(w.KW.send("x", ops));
  assert.equal(sentTx(w).length, 0);
});
test("control: the broadcast transaction is signed by the guest over the checked header", async () => {
  const w = world();
  const addr = await connectAsGuest(w);
  await w.KW.send("answer A", [w.op(GAME, ANSWER)]);
  const [tx] = sentTx(w);
  assert.equal(tx.header.payer, SPONSOR); assert.equal(tx.header.payee, addr); assert.equal(tx.header.chain_id, MAINNET);
  assert.ok(BigInt(tx.header.rc_limit) <= 100000000n);
  assert.deepEqual(await koilib.Signer.recoverAddresses(tx), [addr]);
});
test("control: the generated backup is a compressed WIF (K/L) whose address matches", async () => {
  const w = world();
  const { address } = await w.KG.create();
  const wif = await w.KG.backupWif();
  assert.match(wif, /^[KL][1-9A-HJ-NP-Za-km-z]{51}$/);
  assert.equal(koilib.Signer.fromWif(wif).getAddress(), address);
});

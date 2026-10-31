// The guest wallet (site/guest.js + the guest parts of site/wallet.js): a play-only key kept in the browser that signs
// only game answers, paid by the Mana sponsor. Runs the real files in a vm with a tiny fake DOM, real koilib keys and a
// fake node; nothing is fetched.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import * as koilib from "koilib";

const APP = process.env.APP || ".";
const guestSrc = fs.readFileSync(`${APP}/guest.js`, "utf8");
const walletSrc = fs.readFileSync(`${APP}/wallet.js`, "utf8");
const indexHtml = fs.readFileSync(`${APP}/index.html`, "utf8");
const MAINNET = "EiBZK_GGVP0H_fXVAM3j6EAuz3-B-l3ejxRSewi7qIBfSA==";
const GAME = "1Mpmf2ERhjYpX7CCiM11WERuM4j17uT1sr", DESK = "1FKTpXBhhHEbu5vVchM8UsVbAvPArJsRmR";
const VHP = "12Y5vW6gk8GceH53YfRkRre2Rrcsgw7Naq", KOIN = "19GYjDBVXU7keLbYvMLazsGQn3GTWHjHkK";
const SPONSOR = "1ByDDSBUzy5zkRceELc54Jh8i41yNRoKt8";
const ANSWER = 0x0db52f40, CLAIM = 0xdd1b3c31, DEPOSIT = 0x12345678;

/** A minimal DOM: enough for wallet.js's modal helpers. Every element is kept so a test can find and click it. */
function fakeDom() {
  const all = [];
  const mk = (tag) => {
    const e = { tag, attrs: {}, kids: [], listeners: {}, style: {}, hidden: false, textContent: "", value: "", isConnected: true,
      setAttribute(k, v) { this.attrs[k] = v; if (k === "hidden") this.hidden = true; },
      addEventListener(t, f) { (this.listeners[t] ||= []).push(f); },
      append(...k) { for (const c of k) this.kids.push(c); },
      remove() { this.isConnected = false; },
      get text() { return [this.textContent, ...this.kids.map((c) => (typeof c === "string" ? c : c.text))].join(" "); },
      click() { for (const f of this.listeners.click || []) f({ target: this }); },
    };
    all.push(e);
    return e;
  };
  const document = { createElement: mk, getElementById: () => null, head: mk("head"), body: mk("body"), documentElement: { style: {} } };
  return { document, all };
}

function memStorage(broken = false) {
  const m = new Map();
  return {
    getItem: (k) => { if (broken) throw new Error("blocked"); return m.has(k) ? m.get(k) : null; },
    setItem: (k, v) => { if (broken) throw new Error("blocked"); m.set(k, String(v)); },
    removeItem: (k) => { if (broken) throw new Error("blocked"); m.delete(k); },
    dump: () => [...m.values()].join("\n"),
  };
}

/** Loads guest.js and wallet.js in a fresh vm. The fake node records everything it is sent. */
function world({ reason = "no", payer = "sponsor", brokenStorage = false, yes = true, nodeChain = MAINNET, guest = true, host = "knodegames.com", protocol = "https:" } = {}) {
  const { document, all } = fakeDom();
  const net = [];   // every call that leaves the page: [method, payload]
  const provider = {
    getChainId: async () => { net.push(["getChainId", null]); return nodeChain; },
    getNextNonce: async (a) => { net.push(["getNextNonce", a]); return "KAE"; },
    getAccountRc: async (a) => { net.push(["getAccountRc", a]); return "100000000"; },
    readContract: async (q) => { net.push(["readContract", q]); return { result: koilib.utils.encodeBase64url(new Uint8Array(yes ? [0x08, 0x01] : [0x12, reason.length, ...new TextEncoder().encode(reason)])) }; },
    sendTransaction: async (tx) => { net.push(["sendTransaction", JSON.parse(JSON.stringify(tx))]); return { transaction: { ...tx, wait: async () => ({}) }, receipt: {} }; },
    wait: async () => ({}),
  };
  const toasts = [];
  const win = { location: { protocol, hostname: host }, koilib, crypto: webcrypto, localStorage: memStorage(brokenStorage), confirm: () => true, navigator: {} };
  win.top = win; win.self = win;
  const ctx = {
    window: win, document, localStorage: win.localStorage, sessionStorage: memStorage(), navigator: { userAgent: "test", maxTouchPoints: 0, platform: "x" },
    crypto: webcrypto, console, setTimeout, clearTimeout, Promise, URL, URLSearchParams, JSON, BigInt, Uint8Array, Array, Number, String, Object, Map, Set, Error, Math, Date,
  };
  vm.createContext(ctx);
  vm.runInContext(guestSrc, ctx);
  vm.runInContext(walletSrc, ctx);
  const changes = [];
  win.KWallet.init({ provider, chainId: MAINNET, payer, toast: (m) => toasts.push(m), status: () => {},
    sponsor: { address: SPONSOR, covers: [GAME, DESK, VHP, KOIN], tokens: [VHP, KOIN], rcLimit: "100000000", guest }, onChange: (a) => changes.push(a) });
  const op = (contract, entry, args = "") => ({ call_contract: { contract_id: contract, entry_point: entry, args } });
  const find = (re) => all.filter((e) => e.tag === "button" && re.test(e.text));
  return { win, KG: win.KGuest, KW: win.KWallet, net, toasts, all, find, op, changes, storage: win.localStorage };
}

async function connectAsGuest(w) {
  const p = w.KW.connect();
  const btn = w.find(/Play as a guest/)[0];
  assert.ok(btn, "the connect dialog offers Play as a guest");
  btn.click();
  return p;
}

test("index.html loads guest.js before wallet.js, from this site only", () => {
  const g = indexHtml.indexOf('<script src="guest.js"></script>'), wlt = indexHtml.indexOf('<script src="wallet.js"></script>');
  assert.ok(g > 0 && wlt > g);
});

test("guest.js makes no network calls and never touches the URL", () => {
  for (const bad of [/\bfetch\s*\(/, /XMLHttpRequest/, /sendBeacon/, /\blocation\b/, /WebSocket/, /postMessage/, /history\./]) assert.doesNotMatch(guestSrc, bad);
});

test("a guest key round-trips: create, load, back up, restore on another device, forget", async () => {
  const a = world();
  const g = await a.KG.create();
  assert.match(g.address, /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/);
  assert.equal((await a.KG.load()).address, g.address);
  const wif = await a.KG.backupWif();
  assert.ok(a.KG.isWif(wif));
  assert.equal(koilib.Signer.fromWif(wif).getAddress(), g.address);
  await assert.rejects(a.KG.create(), /already has a guest/);
  const b = world();
  assert.equal((await b.KG.restore(wif)).address, g.address);
  assert.equal((await b.KG.load()).address, g.address);
  await b.KG.forget();
  assert.equal(await b.KG.load(), null);
  await assert.rejects(b.KG.restore("not-a-key"), /valid private key/);
});

test("two new guests get different keys (the browser's secure random)", async () => {
  const a = world(), b = world();
  assert.notEqual((await a.KG.create()).address, (await b.KG.create()).address);
});

test("blocked storage: no guest, a clear message, nothing thrown at load", async () => {
  const w = world({ brokenStorage: true });
  assert.equal(await w.KG.load(), null);
  await assert.rejects(w.KG.create(), /won't store a guest key/);
});

test("while the sponsor is off (payer \"self\") the guest option is shown disabled with a note", async () => {
  const w = world({ payer: "self" });
  w.KW.connect();
  const btn = w.find(/Play as a guest/)[0];
  assert.ok(btn);
  assert.ok("disabled" in btn.attrs);
  assert.match(btn.text, /Guest play turns on when the Mana sponsor is live/);
});

test("a guest's answer: the sponsor pays, the guest is payee, mainnet, signed locally; the key never leaves", async () => {
  const w = world();
  const addr = await connectAsGuest(w);
  assert.equal(w.KW.kind, "guest");
  assert.equal(w.KW.address, addr);
  const wif = await w.KG.backupWif();
  await w.KW.send("answer A", [w.op(GAME, ANSWER, koilib.utils.encodeBase64url(new Uint8Array([0x10, 0x01, 0x18, 0x00])))]);
  const sent = w.net.filter(([m]) => m === "sendTransaction").map(([, t]) => t);
  assert.equal(sent.length, 1);
  const tx = sent[0];
  assert.equal(tx.header.payer, SPONSOR);
  assert.equal(tx.header.payee, addr);
  assert.equal(tx.header.chain_id, MAINNET);
  assert.equal(String(tx.header.rc_limit), "100000000");
  assert.equal(tx.signatures.length, 1);
  assert.equal(tx.operations.length, 1);
  // would_pay was asked for this guest and this Mana limit, marked free play (answer_only, kept for a v2 rollback:
  // audit SP-40); an answer names no game
  const ask = w.net.find(([m, q]) => m === "readContract" && q.contract_id === SPONSOR)[1];
  const bytes = koilib.utils.decodeBase64url(ask.args);
  assert.equal(bytes[0], 0x0a);
  assert.equal(bytes[27], 0x10, "field 2: the Mana limit");
  assert.deepEqual([...bytes.slice(-2)], [0x18, 0x01], "answer_only = true");
  assert.equal(bytes.length, 34, "no game for an answer");
  // the key is nowhere in what left the page
  const out = JSON.stringify(w.net);
  assert.ok(!out.includes(wif));
  const hex = koilib.Signer.fromWif(wif).getPrivateKey("hex");
  assert.ok(!out.includes(hex));
});

test("a guest never signs anything but answers: deposit and claim are refused with an explanation, nothing sent", async () => {
  const w = world();
  await connectAsGuest(w);
  await assert.rejects(w.KW.send("stake", [w.op(VHP, 0x74e21680), w.op(GAME, DEPOSIT)]), /only answer questions/);
  await assert.rejects(w.KW.send("collect", [w.op(GAME, CLAIM)]), /collect/);
  await assert.rejects(w.KW.send("mixed", [w.op(GAME, ANSWER), w.op(GAME, CLAIM)]), /collect|answer/);
  await assert.rejects(w.KW.send("other contract", [w.op(DESK, ANSWER)]), /only answer questions/);
  assert.equal(w.net.filter(([m]) => m === "sendTransaction").length, 0);
  assert.ok(w.all.some((e) => /Import account/.test(e.text)), "the claim explanation tells the player how to collect from Kondor");
});

test("would_pay says no: a friendly message, never the guest's own Mana", async () => {
  const w = world({ yes: false });
  await connectAsGuest(w);
  await assert.rejects(w.KW.send("answer A", [w.op(GAME, ANSWER)]), /Free answers are used up for today/);
  assert.equal(w.net.filter(([m]) => m === "sendTransaction").length, 0);
});

test("a node on another chain: nothing is signed", async () => {
  const w = world({ nodeChain: "OTHER" });
  await connectAsGuest(w);
  await assert.rejects(w.KW.send("answer A", [w.op(GAME, ANSWER)]), /different chain/);
  assert.equal(w.net.filter(([m]) => m === "sendTransaction").length, 0);
});

test("the header check refuses a wrong payer, payee, chain, Mana limit or operation", () => {
  const start = walletSrc.indexOf("  function checkGuestTx("), end = walletSrc.indexOf("\n  }\n", start) + 4;
  assert.ok(start > 0);
  const ctx = { BigInt, Number, Error, ANSWER };
  vm.createContext(ctx);
  vm.runInContext(walletSrc.slice(start, end) + "\nthis.check = checkGuestTx;", ctx);
  const want = { sponsor: SPONSOR, payee: "1Guest", chainId: MAINNET, game: GAME, rcLimit: "100000000" };
  const good = { header: { payer: SPONSOR, payee: "1Guest", chain_id: MAINNET, rc_limit: "100000000" }, operations: [{ call_contract: { contract_id: GAME, entry_point: ANSWER } }] };
  ctx.check(good, want);
  const bad = (f) => { const t = JSON.parse(JSON.stringify(good)); f(t); return t; };
  assert.throws(() => ctx.check(bad((t) => (t.header.payer = "1Guest")), want), /sponsor as payer/);
  assert.throws(() => ctx.check(bad((t) => (t.header.payee = "1Other")), want), /payee/);
  assert.throws(() => ctx.check(bad((t) => (t.header.chain_id = "X")), want), /another chain/);
  assert.throws(() => ctx.check(bad((t) => (t.header.rc_limit = "500000000")), want), /more Mana/);
  assert.throws(() => ctx.check(bad((t) => (t.operations[0].call_contract.entry_point = CLAIM)), want), /only game answers/);
  assert.throws(() => ctx.check(bad((t) => (t.operations = [])), want), /only game answers/);
  // Race picks (0x8ce33c6c): only on the pinned race contract, and only when one is pinned.
  const RACE = "15CM9Qr4GKREDgqnyXJ8tckPj2biERTM1T", PICK = 0x8ce33c6c;
  const pick = bad((t) => (t.operations = [{ call_contract: { contract_id: RACE, entry_point: PICK } }]));
  assert.throws(() => ctx.check(pick, want), /only game answers/, "no race pinned: no picks");
  ctx.check(pick, { ...want, race: RACE });
  assert.throws(() => ctx.check(bad((t) => (t.operations = [{ call_contract: { contract_id: GAME, entry_point: PICK } }])), { ...want, race: RACE }), /only game answers/);
  assert.throws(() => ctx.check(bad((t) => (t.operations = [{ call_contract: { contract_id: RACE, entry_point: ANSWER } }])), { ...want, race: RACE }), /only game answers/);
});

test("guest play is off unless deployment.json's sponsor has guest: true (no option, no auto-reconnect, no sending)", async () => {
  const w = world({ guest: false });
  w.KW.connect();
  assert.equal(w.find(/Play as a guest/).length, 0, "no guest option in the wallet picker");
  assert.equal(w.find(/Restore a guest key/).length, 0);
  // The live setting is the owner's choice: guest play was switched on 2026-10-26 before the custom domain, accepting
  // the shared-origin risk (guest audit M-1, tracked as a TODO in guest.audit.test.mjs).
});

test("guests pick only on the pinned Knode race contract (mainnet)", () => {
  assert.match(walletSrc, /const PINNED_RACE = "1EN7xU8R9tQXjHvrX79qZvvvGkkKWVnB5K";/);
  assert.match(walletSrc, /const guestRace = \(\) => \(W\.chainId === MAINNET_CHAIN_ID \? \(PINNED_RACE \|\| null\)/);
});

test("race.html offers guest play too: it loads guest.js before wallet.js, from this site only", () => {
  const h = fs.readFileSync(`${APP}/race.html`, "utf8");
  const g = h.indexOf('<script src="guest.js"></script>'), wlt = h.indexOf('<script src="wallet.js"></script>');
  assert.ok(g > 0 && wlt > g);
});

test("every page with the wallet button offers guest play: guest.js before wallet.js, koilib allowed and loaded", () => {
  for (const p of fs.readdirSync(`${APP}`).filter((f) => f.endsWith(".html"))) {
    const h = fs.readFileSync(`${APP}/${p}`, "utf8");
    if (!/<script src="header-wallet\.js"><\/script>/.test(h)) continue;
    const g = h.indexOf('<script src="guest.js"></script>'), wlt = h.indexOf('<script src="wallet.js"></script>');
    assert.ok(g > 0 && g < wlt, `${p}: guest.js before wallet.js`);
    assert.match(h, /<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/koilib@9\.4\.1\/dist\/koinos\.min\.js" integrity=/, `${p}: koilib with SRI`);
    const csp = h.match(/script-src ([^;]*)/)[1];
    assert.ok(csp.includes("'self'") && !csp.includes("'none'"), `${p}: the page may run its own scripts`);
  }
});

// Pages that set the wallet up without the sponsor (swap, burn, info pages): the header passes deployment.json's
// switch with setGuestConfig. The guest option appears, but the page's own payer never changes, and anything a guest
// may not sign is refused with "connect a real wallet" before any sponsor or network step.
test("a page without the sponsor offers guest play through the header's switch, and refuses a guest's swap clearly", async () => {
  const w = world({ payer: "self", guest: false });
  assert.equal(w.find(/Play as a guest/).length, 0);
  w.KW.connect();
  assert.ok(!w.find(/Play as a guest/).length || "disabled" in w.find(/Play as a guest/)[0].attrs, "off until the header passes the switch");
  w.win.KWallet.setGuestConfig({ payer: "sponsor", sponsor: { address: SPONSOR, guest: true } });
  const addr = await connectAsGuest(w);
  assert.equal(w.KW.kind, "guest"); assert.equal(w.KW.address, addr);
  const before = w.net.filter(([m]) => m === "sendTransaction").length;
  await assert.rejects(w.KW.send("swap", [w.op(DESK, 0x12345678, "")]), /Guests can only answer|connect a real wallet|Connect KOIN Vault or Kondor|A guest/i);
  assert.equal(w.net.filter(([m]) => m === "sendTransaction").length, before, "nothing sent");
});

test("the header's guest switch stays off while deployment.json says the player pays (payer self)", () => {
  const w = world({ payer: "self", guest: false });
  w.win.KWallet.setGuestConfig({ payer: "self", sponsor: { address: SPONSOR, guest: true } });
  w.KW.connect();
  const btn = w.find(/Play as a guest/)[0];
  assert.ok(btn && "disabled" in btn.attrs);
});

test("guests make KnodeGames picks only on the pinned Picks contract (empty until it is on mainnet)", () => {
  assert.match(walletSrc, /const PINNED_PICKS = "";/, "not pinned before the Picks contract is live");
  assert.match(walletSrc, /const guestPicks = \(\) => \(W\.chainId === MAINNET_CHAIN_ID \? \(PINNED_PICKS \|\| null\)/);
  const start = walletSrc.indexOf("  function checkGuestTx("), end = walletSrc.indexOf("\n  }\n", start) + 4;
  const ctx = { BigInt, Number, Error, ANSWER };
  vm.createContext(ctx);
  vm.runInContext(walletSrc.slice(start, end) + "\nthis.check = checkGuestTx;", ctx);
  const PICKS = "1MbsVfNw6yzQqA8499d8KQj8qdLyRs8CzW", PICK = 0x8ce33c6c;
  const want = { sponsor: SPONSOR, payee: "1Guest", chainId: MAINNET, game: GAME, rcLimit: "100000000" };
  const tx = (contract, entry) => ({ header: { payer: SPONSOR, payee: "1Guest", chain_id: MAINNET, rc_limit: "100000000" }, operations: [{ call_contract: { contract_id: contract, entry_point: entry } }] });
  assert.throws(() => ctx.check(tx(PICKS, PICK), want), /only game answers/, "no Picks contract pinned: no picks");
  ctx.check(tx(PICKS, PICK), { ...want, picks: PICKS });
  assert.throws(() => ctx.check(tx(PICKS, 0x94871b42), { ...want, picks: PICKS }), /only game answers/, "only pick, never apply_game");
});

test("audit BX-40 / BX-51: off knodegames.com (and this computer) every guest path is closed: no option, no reconnect, no backup, no signing", async () => {
  for (const [host, protocol] of [["bawcejawn.github.io", "https:"], ["bawcejawn.github.io.", "https:"], ["evil.example", "https:"], ["", "file:"], ["knodegames.com.evil.example", "https:"]]) {
    const w = world({ host, protocol });
    await w.KG.create();                                                   // a key already stored in this browser
    w.storage.setItem("kw-kind", "guest");
    const p = w.KW.connect();
    assert.equal(w.find(/Play as a guest/).length, 0, `${host || protocol}: no guest option`);
    assert.equal(w.KW.address || null, null, `${host || protocol}: no reconnect to the stored guest`);
    w.find(/Cancel|Close|×/).forEach((b) => b.click()); p.catch(() => {});
    await assert.rejects(w.KW.send("x", [w.op(GAME, 1)]), /./, `${host || protocol}: nothing signed`);
  }
  const ok = world();
  assert.ok((await connectAsGuest(ok)) !== undefined, "knodegames.com: guest play works");
});

test("audit SP-34: the sponsor's own reason reaches the guest (the free pool reopens on the hour, not at 00:00 UTC)", async () => {
  const w = world({ yes: false, reason: "today's free-player Mana is used up (more is released on the hour)" });
  await connectAsGuest(w);
  await assert.rejects(w.KW.send("answer A", [w.op(GAME, ANSWER)]), /more opens on the hour/);
  assert.equal(w.net.filter(([m]) => m === "sendTransaction").length, 0);
});

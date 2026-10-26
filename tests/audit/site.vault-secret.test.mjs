// Red team (web attacker) for Knode @ 6b37c46: KOIN Vault session secret handling in site/wallet.js.
// Findings exercised:
//  (1) wallet.js:143 stores { sessionId, secret } in sessionStorage (readable by ANY script on the
//      origin bawcejawn.github.io: every GitHub Pages site of that user shares it, plus the
//      un-SRI'd CDN scripts koilib / kondor-js / qrcode-generator).
//  (2) wallet.js:93,139,225 send the secret as a URL query parameter on GET requests
//      (/api/dapp/status?sessionId=..&secret=..), so it lands in koinvault.app / proxy / CDN access logs.
// With sessionId+secret an attacker can POST /api/dapp/request with ANY operations; the user sees a
// request "from Knode" in KOIN Vault and still has to approve it (phishing aid, not a direct theft).
// Asserts the SAFE behaviour: FAILS today = proof. Offline: fetch, DOM and storage are stubs.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const APP = process.env.APP || ".";
const SECRET = "s3cr3t-session-secret-value";
const src = fs.readFileSync(`${APP}/site/wallet.js`, "utf8");

function storage(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m };
}
function load(sessionInit) {
  const fetched = [];
  const ses = storage(sessionInit), loc = storage();
  const els = [];
  const node = () => { const e = { attrs: {}, on: {}, append() {}, remove() {}, addEventListener(t, f) { e.on[t] = f; }, setAttribute(k, v) { e.attrs[k] = v; }, isConnected: true, style: {} }; els.push(e); return e; };
  const win = {
    navigator: { userAgent: "Desktop", maxTouchPoints: 0, platform: "Win32" },
    document: { createElement: node, getElementById: () => null, head: node(), body: node(), hidden: false },
    sessionStorage: ses, localStorage: loc, URL, URLSearchParams, console, Date, JSON, Promise,
    // only the 2 s polling sleeps run (instantly); the 5-30 s session watchdog never fires in the test
    setTimeout: (f, ms) => (ms === 2000 ? setImmediate(f) : 0), clearTimeout() {},
    fetch: async (url, opt) => {
      fetched.push({ url: String(url), opt });
      const body = String(url).includes("/create")
        ? { ok: true, uri: "https://koinvault.app/?connect=sid-1", sessionId: "sid-1", secret: SECRET, expiresAt: Date.now() + 600000 }
        : { ok: true, connected: true, address: "1Victim" };
      return { ok: true, status: 200, json: async () => body };
    },
  };
  win.window = win;
  vm.createContext(win);
  vm.runInContext(src, win);
  return { W: win.KWallet, fetched, ses, els };
}

const saved = JSON.stringify({ sessionId: "sid-1", secret: SECRET, expiresAt: Date.now() + 600000, address: "1Victim" });

// (repo) The audit's first case asserted the secret never appears in any URL. KOIN Vault's API only accepts it as a
// query parameter for its two GET status calls, so the owner decided (2026-10): the query string for exactly those
// two calls, POST bodies for everything else, and the secret in page memory only. These cases check that policy.
const STATUS = /^https:\/\/koinvault\.app\/api\/dapp\/(status|request-status)\?/;

test("KOIN Vault secret travels in a URL only for the two status calls, as GET", async () => {
  const { W, fetched } = load({ "kw-vault": saved });
  W.init({ provider: {}, onChange() {} });
  await new Promise((r) => setImmediate(r));
  // A session saved by the old page is no longer restored (AB-027): it is deleted without being used.
  assert.equal(fetched.length, 0, "an old saved session is not used");
  for (const f of fetched.filter((x) => x.url.includes(SECRET))) {
    assert.match(f.url, STATUS, `secret sent in a URL other than a status call: ${f.url}`);
    assert.equal(f.opt?.method ?? "GET", "GET");
  }
});

const MAINNET_ID = "EiBZK_GGVP0H_fXVAM3j6EAuz3-B-l3ejxRSewi7qIBfSA==";   // the default pin in wallet.js (audit L-3)

test("a whole session (connect, send, disconnect): bodies everywhere else, and the secret never reaches storage", async () => {
  const fetched = [], ses = new Map(), loc = new Map();
  const st = (m) => ({ getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) });
  const els = [];
  const node = () => { const e = { attrs: {}, on: {}, append() {}, remove() {}, addEventListener(t, f) { e.on[t] = f; }, setAttribute(k, v) { e.attrs[k] = v; }, isConnected: true, style: {} }; els.push(e); return e; };
  const win = {
    navigator: { userAgent: "Desktop", maxTouchPoints: 0, platform: "Win32" },
    document: { createElement: node, getElementById: () => null, head: node(), body: node(), hidden: false },
    sessionStorage: st(ses), localStorage: st(loc), URL, URLSearchParams, console, Date, JSON, Promise,
    setTimeout: (f, ms) => (ms === 2000 ? setImmediate(f) : 0), clearTimeout() {},
    fetch: async (url, opt) => {
      fetched.push({ url: String(url), opt });
      const u = String(url);
      const body = u.includes("/create") ? { ok: true, uri: "https://koinvault.app/?connect=sid-1", sessionId: "sid-1", secret: SECRET, expiresAt: Date.now() + 600000 }
        : u.includes("/request-status") ? { ok: true, status: "approved", txid: "0xabc" }
        : u.includes("/request") ? { ok: true, requestId: "req-1", expiresAt: Date.now() + 600000 }
        : { ok: true, connected: true, address: "1Victim" };
      return { ok: true, status: 200, json: async () => body };
    },
  };
  win.window = win;
  vm.createContext(win);
  vm.runInContext(src, win);
  const W = win.KWallet;
  W.init({ provider: { getChainId: async () => MAINNET_ID }, onChange() {} });
  const p = W.connect();
  els.filter((e) => e.attrs.class === "kw-opt")[1].on.click();
  assert.equal(await p, "1Victim");
  await W.send("test", [{ call_contract: { contract_id: "1X", entry_point: 1, args: "" } }]);
  W.disconnect();
  await new Promise((r) => setImmediate(r));
  const paths = fetched.map((f) => new URL(f.url).pathname.replace("/api/dapp/", ""));
  for (const want of ["create", "status", "request", "request-status", "disconnect"]) assert.ok(paths.includes(want), `called ${want}`);
  for (const f of fetched) {
    const path = new URL(f.url).pathname.replace("/api/dapp/", "");
    if (path === "status" || path === "request-status") {
      assert.equal(f.opt?.method, "GET");
      assert.ok(f.url.includes(SECRET), `${path} carries the secret in its query`);
    } else {
      assert.ok(!f.url.includes("secret="), `${path} must not put credentials in its URL: ${f.url}`);
      assert.equal(f.opt?.method, "POST");
      if (path !== "create") assert.ok(String(f.opt.body).includes(SECRET), `${path} posts the secret in its body`);
    }
  }
  for (const [k, v] of [...ses, ...loc]) assert.ok(!String(v).includes(SECRET), `secret found in storage under ${k}`);
});

test("KOIN Vault secret should not sit in origin-wide sessionStorage in clear after connecting", async () => {
  const { W, ses, els } = load({});
  W.init({ provider: {}, onChange() {} });
  const p = W.connect();
  const vaultBtn = els.filter((e) => e.attrs.class === "kw-opt")[1]; // [Kondor, KOIN Vault] on a desktop
  assert.ok(vaultBtn && vaultBtn.on.click, "found the KOIN Vault option");
  vaultBtn.on.click();
  assert.equal(await p, "1Victim");
  // wallet.js:143. Any script on bawcejawn.github.io in this tab (other Pages sites of the same user, the CDN scripts) can read it.
  const raw = ses.getItem("kw-vault") || "";
  assert.ok(!raw.includes(SECRET), `secret readable from sessionStorage by any same-origin script: ${raw}`);
});

test("(blocked) a session saved in sessionStorage (old page, or planted by another page of the origin) is deleted and never adopted", async () => {
  const { W, fetched, ses } = load({ "kw-vault": JSON.stringify({ sessionId: "sid-1", secret: "x", expiresAt: Date.now() + 600000, address: "1Attacker" }) });
  W.init({ provider: {}, onChange() {} });
  await new Promise((r) => setImmediate(r));
  assert.equal(fetched.length, 0);
  assert.equal(W.address, null);
  assert.equal(ses.getItem("kw-vault"), null);
});

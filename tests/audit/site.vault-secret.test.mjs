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

test("KOIN Vault secret must not travel in a URL query string", async () => {
  const { W, fetched } = load({ "kw-vault": saved });
  W.init({ provider: {}, onChange() {} });
  await new Promise((r) => setImmediate(r));
  assert.ok(fetched.length > 0, "status was checked");
  const leaky = fetched.filter((f) => f.url.includes(SECRET));
  assert.equal(leaky.length, 0, `secret sent in URL: ${leaky.map((f) => f.url).join(" | ")}`);
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

test("(blocked) the restored session is re-checked before use and dropped when the wallet reports another address", async () => {
  const { W, fetched } = load({ "kw-vault": JSON.stringify({ sessionId: "sid-1", secret: "x", expiresAt: Date.now() + 600000, address: "1Attacker" }) });
  let addr = "unset";
  W.init({ provider: {}, onChange(a) { addr = a; } });
  await new Promise((r) => setImmediate(r));
  assert.ok(fetched.length > 0);
  assert.notEqual(W.address, "1Attacker"); // status says 1Victim -> dropped, attacker-planted address not adopted
});

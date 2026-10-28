// Red-team (IMPERSONATOR, second fix check) attack test, Knode commit 1dbc129. Targets: wallet.js frame-buster
// (site/wallet.js:11-17), the "never restore a KOIN Vault session" change (wallet.js:250-255) and the connect flow
// (wallet.js:124-166). Attacks: frame a wallet page (plain, sandboxed), plant a session/kind for the page to adopt,
// and dismiss the KOIN Vault dialog while an approval is in flight (the page must not connect after the user said no).
// Legitimate use: a top-level page and a popup window keep working. Asserts the SAFE behaviour: a failing case is a
// proven problem. Offline: fetch, DOM, storage and window.top are stubs; wallet.js is run in a vm context.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const APP = process.env.APP || ".";
const src = fs.readFileSync(`${APP}/site/wallet.js`, "utf8");
const SECRET = "S3CR3T-vault-session-secret-0123456789abcdef";
const PAGE = "https://knode.example/index.html?x=1";

// Harness adapted from tests/audit/site.vault-restore.test.mjs (same storage/fetch/timer/DOM stubs); additions:
// opts.top(win, log) supplies window.top, window.location and document.documentElement exist.
function storage(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m };
}

function harness(opts = {}) {
  const clock = { t: 1_800_000_000_000 };
  const log = { fetches: [], toasts: [], statuses: [], console: [], dom: [], changes: [], topNav: [] };
  const ses = storage(opts.session || {}), loc = storage(opts.local || {});
  const timers = new Map(); let tid = 0;
  const server = { ttl: 30 * 60000, address: "1Victim", connected: true, hold: {} };
  const defaults = (path) => ({
    create: () => ({ ok: true, uri: "https://koinvault.app/?connect=sid-1", sessionId: "sid-1", secret: SECRET, expiresAt: clock.t + server.ttl }),
    status: () => ({ ok: true, connected: server.connected, address: server.address }),
    disconnect: () => ({ ok: true }),
  })[path]?.() || { ok: false, error: "unknown" };
  const els = [];
  const mk = (tag) => {
    let tc = "", ih = "", href = "";
    const e = {
      tag, attrs: {}, on: {}, kids: [], isConnected: true, hidden: false, style: {},
      setAttribute(k, v) { this.attrs[k] = String(v); if (k === "href") href = String(v); },
      getAttribute(k) { return this.attrs[k] ?? null; },
      addEventListener(t, f) { this.on[t] = f; },
      append(...c) { for (const x of c) this.kids.push(x); },
      remove() { this.isConnected = false; },
    };
    Object.defineProperty(e, "textContent", { get: () => tc, set: (v) => { tc = String(v); log.dom.push(tc); } });
    Object.defineProperty(e, "innerHTML", { get: () => ih, set: (v) => { ih = String(v); } });
    Object.defineProperty(e, "href", { get: () => href, set: (v) => { href = String(v); } });
    els.push(e);
    return e;
  };
  const qrStub = () => ({ addData() {}, make() {}, createSvgTag: () => "<svg></svg>" });
  class FDate extends Date { constructor(...a) { if (a.length) super(...a); else super(clock.t); } static now() { return clock.t; } }
  const win = {
    navigator: { userAgent: "Mozilla/5.0 (Windows NT 10.0)", maxTouchPoints: 0, platform: "Win32" },
    document: { createElement: mk, getElementById: () => null, head: mk("head"), body: mk("body"), hidden: false, documentElement: { style: {} } },
    location: { href: PAGE },
    sessionStorage: ses, localStorage: loc, URL, URLSearchParams, console: { log() {}, warn() {}, error() {}, info() {}, debug() {} }, Date: FDate, JSON,
    setTimeout: (f, ms = 0) => { const id = ++tid; timers.set(id, { f, at: clock.t + ms }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    fetch: async (url, opt = {}) => {
      const u = new URL(String(url));
      const path = u.pathname.replace("/api/dapp/", "");
      log.fetches.push({ url: String(url), path, opt, at: clock.t });
      if (server.hold[path]) await server.hold[path];
      const body = defaults(path);
      return { ok: true, status: 200, json: async () => body };
    },
    koilib: {}, qrcode: qrStub,
  };
  win.window = win; win.self = win; win.top = win;
  if (opts.top) win.top = opts.top(win, log);
  if (opts.opener) win.opener = opts.opener;
  vm.createContext(win);
  vm.runInContext(src, win);
  const flush = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };
  const advance = async (ms) => {
    const end = clock.t + ms;
    for (;;) {
      await flush();
      let next = null;
      for (const [id, t] of timers) if (t.at <= end && (!next || t.at < next[1].at)) next = [id, t];
      if (!next) break;
      timers.delete(next[0]); clock.t = Math.max(clock.t, next[1].at); next[1].f();
    }
    clock.t = end; await flush();
  };
  const W = win.KWallet;
  const init = () => W.init({ provider: { wait: async () => ({}) }, onChange: (a, k) => log.changes.push([a, k]), toast: (m) => log.toasts.push(String(m)), status: (m) => log.statuses.push(String(m)) });
  const option = (which) => { const o = els.filter((e) => e.attrs.class === "kw-opt").slice(-2); return o[which === "vault" ? 1 : 0]; };
  const closeModal = () => { const x = els.filter((e) => e.attrs.class === "kw-x").pop(); x.on.click(); };
  return { W, win, log, ses, loc, server, advance, flush, init, option, closeModal };
}

const crossOriginParent = (win, log) => ({ location: { replace: (u) => log.topNav.push(String(u)) } });
const sandboxedParent = () => ({ get location() { return { replace: () => { throw new Error("SecurityError: sandboxed frame may not navigate top"); } }; } });

// frame-buster vs a cross-origin parent that may be navigated: page hidden, top sent to the page itself, no wallet API.
test("IMP2-FRAME-1 (holds) a wallet page framed by another site hides itself, breaks out, and exposes no wallet", async () => {
  const h = harness({ top: crossOriginParent });
  assert.equal(h.win.document.documentElement.style.display, "none", "IMP2-FRAME-1: framed wallet page stayed visible (clickjacking)");
  assert.deepEqual(h.log.topNav, [PAGE], "IMP2-FRAME-1: framed page did not send the top window to itself");
  assert.equal(h.W, undefined, "IMP2-FRAME-1: KWallet is available inside a frame");
  await h.flush();
  assert.equal(h.log.fetches.length, 0);
});

// frame-buster vs a sandboxed frame (no allow-top-navigation): breaking out throws, the page must stay hidden and inert.
test("IMP2-FRAME-2 (holds) a sandboxed frame that may not navigate the top still gets a hidden, wallet-less page", async () => {
  const h = harness({ top: sandboxedParent });
  assert.equal(h.win.document.documentElement.style.display, "none", "IMP2-FRAME-2: sandboxed frame shows the wallet page");
  assert.equal(h.W, undefined, "IMP2-FRAME-2: KWallet is available inside a sandboxed frame");
});

// legitimate use: a normal tab and a popup opened by another page (opener set, but top === self) keep working.
test("IMP2-FRAME-3 (legitimate use) a top-level tab and a popup window are not treated as framed", async () => {
  for (const opts of [{}, { opener: { location: {} } }]) {
    const h = harness(opts);
    assert.notEqual(h.win.document.documentElement.style.display, "none", "IMP2-FRAME-3: a top-level page hid itself");
    assert.equal(typeof h.W?.connect, "function", "IMP2-FRAME-3: KWallet missing on a top-level page");
    h.init();
    const p = h.W.connect();
    h.option("vault").on.click();
    await h.advance(2500);
    assert.equal(await p, "1Victim", "IMP2-FRAME-3: KOIN Vault connect broke on a top-level page");
  }
});

// session adoption: a kind in localStorage and a session in sessionStorage (written by any page of the origin) are
// never used: no KOIN Vault call, no address, both stay unused.
test("IMP2-SESSION-1 (holds) a planted kw-kind / kw-vault pair is not adopted by any page", async () => {
  const planted = JSON.stringify({ sessionId: "sid-planted", secret: SECRET, expiresAt: 1_800_000_000_000 + 20 * 60000, address: "1Attacker" });
  const h = harness({ session: { "kw-vault": planted }, local: { "kw-kind": "vault" } });
  h.server.address = "1Attacker";
  h.init();
  await h.advance(60000);
  assert.equal(h.W.address, null, "IMP2-SESSION-1: page connected itself to a planted session");
  assert.equal(h.W.kind, null, "IMP2-SESSION-1: page took the wallet kind from localStorage");
  assert.equal(h.log.fetches.length, 0, "IMP2-SESSION-1: page contacted KOIN Vault with a session it did not create");
});

// the user dismisses the KOIN Vault dialog while a status check is in flight; the answer then says "connected":
// the page must not connect anyway (wallet.js:149-157 checks `cancelled` only before the request, not after).
test("IMP2-SESSION-2 closing the KOIN Vault dialog during a status check must leave the page disconnected", async () => {
  let release;
  const h = harness();
  h.server.hold.status = new Promise((r) => { release = r; });
  h.init();
  const p = h.W.connect();
  h.option("vault").on.click();
  await h.advance(2100);                              // session created, first status request now in flight
  assert.ok(h.log.fetches.some((f) => f.path === "status"), "(context) a status request is pending");
  h.closeModal();                                     // the user says no
  release(); await h.flush();
  assert.equal(h.W.address, null, "IMP2-SESSION-2: the page connected a KOIN Vault account after the user closed the dialog");
  assert.equal(await p, null, "IMP2-SESSION-2: connect() resolved to an address after the user cancelled");
});

// static: every page that loads wallet.js forbids frames itself (frame-src 'none'), loads wallet.js before its page
// script, and no page reaches a wallet (KWallet / window.kondor) without loading wallet.js (so the frame-buster covers
// every page that can sign).
test("IMP2-FRAME-4 (holds) every signing page is behind the frame-buster", () => {
  const pages = fs.readdirSync(`${APP}/site`).filter((f) => f.endsWith(".html"));
  for (const p of pages) {
    const html = fs.readFileSync(`${APP}/site/${p}`, "utf8");
    const csp = (html.match(/http-equiv="Content-Security-Policy" content="([^"]*)"/) || [])[1] || "";
    assert.match(csp, /frame-src 'none'/, `IMP2-FRAME-4: ${p} allows frames`);
    const own = [...html.matchAll(/<script src="([^"/:]+\.js)"/g)].map((m) => m[1]);
    const usesWallet = own.some((f) => f !== "wallet.js" && /KWallet|window\.kondor/.test(fs.readFileSync(`${APP}/site/${f}`, "utf8")));
    if (usesWallet) {
      // The one exception: the testnet page signs with testnet-wallet.js, which has its own frame-buster and never loads
      // the mainnet wallet (site.blockx.test.mjs checks that page's isolation).
      const testnetPage = /<meta name="kg-network" content="testnet">/.test(html);
      const buster = testnetPage ? "testnet-wallet.js" : "wallet.js";
      assert.ok(own.includes(buster), `IMP2-FRAME-4: ${p} signs without loading ${buster} (no frame-buster)`);
      if (testnetPage) assert.match(fs.readFileSync(`${APP}/site/testnet-wallet.js`, "utf8"), /if \(window\.top !== window\.self\)/, "testnet-wallet.js has the frame-buster");
      const wi = own.indexOf(buster);
      for (const f of own.slice(0, wi)) assert.ok(!/KWallet|window\.kondor/.test(fs.readFileSync(`${APP}/site/${f}`, "utf8")), `IMP2-FRAME-4: ${p} runs ${f} before the frame-buster`);
    }
  }
});

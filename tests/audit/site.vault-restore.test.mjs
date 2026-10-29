// Proof test (audit fix check, AB-027): a KOIN Vault session found in sessionStorage (saved by the old page, or
// written by another page of the shared origin) is never restored: it can't switch a user who picked Kondor, and it
// is not adopted without a click. Offline: fetch, DOM and storage are stubs.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const APP = process.env.APP || ".";
const src = fs.readFileSync(`${APP}/wallet.js`, "utf8");
const SECRET = "S3CR3T-vault-session-secret-0123456789abcdef";
const VAULT = "https://koinvault.app";
const OP = [{ call_contract: { contract_id: "1Mpmf2ERhjYpX7CCiM11WERuM4j17uT1sr", entry_point: 0x12345678, args: "CgA=" } }];

// Harness copied unchanged from site.vault-flows.web.test.mjs (same folder).
function storage(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m };
}

function harness(opts = {}) {
  const clock = { t: 1_800_000_000_000 };
  const log = { fetches: [], toasts: [], statuses: [], console: [], dom: [], scripts: [], errors: [], changes: [] };
  const ses = storage(opts.session || {}), loc = storage(opts.local || {});
  const timers = new Map(); let tid = 0;
  const server = { ttl: 30 * 60000, lastExpiry: null, address: "1Victim", connected: true, override: null, hold: {} };
  const defaults = (path) => ({
    create: () => ({ ok: true, uri: "https://koinvault.app/?connect=sid-1", sessionId: "sid-1", secret: SECRET, expiresAt: (server.lastExpiry = clock.t + server.ttl) }),
    status: () => ({ ok: true, connected: server.connected, address: server.address }),
    request: () => ({ ok: true, requestId: "req-1", expiresAt: clock.t + 600000, funding: { payer: "sponsor" } }),
    "request-status": () => ({ ok: true, status: "approved", txid: "0xabc" }),
    disconnect: () => ({ ok: true }),
  })[path]?.() || { ok: false, error: "unknown" };

  const els = [];
  const mk = (tag) => {
    let tc = "", ih = "", href = "";
    const e = {
      tag, attrs: {}, on: {}, kids: [], isConnected: true, hidden: false, style: {},
      setAttribute(k, v) { this.attrs[k] = String(v); log.dom.push(String(v)); if (k === "href") href = String(v); },
      getAttribute(k) { return this.attrs[k] ?? null; },
      addEventListener(t, f) { this.on[t] = f; },
      append(...c) {
        for (const x of c) {
          this.kids.push(x);
          if (typeof x === "string") log.dom.push(x);
          if (x && x.tag === "script") { log.scripts.push({ src: x.src, integrity: x.integrity, crossOrigin: x.crossOrigin }); setImmediate(() => (opts.qrScript === "load" ? (win.qrcode = qrStub, x.onload && x.onload()) : x.onerror && x.onerror())); }
        }
      },
      remove() { this.isConnected = false; },
    };
    Object.defineProperty(e, "textContent", { get: () => tc, set: (v) => { tc = String(v); log.dom.push(tc); } });
    Object.defineProperty(e, "innerHTML", { get: () => ih, set: (v) => { ih = String(v); log.dom.push(ih); } });
    Object.defineProperty(e, "href", { get: () => href, set: (v) => { href = String(v); log.dom.push(href); } });
    els.push(e);
    return e;
  };
  const qrStub = () => { let d = ""; return { addData: (x) => { d = x; }, make() {}, createSvgTag: () => `<svg data-len="${d.length}"></svg>` }; };
  class FDate extends Date { constructor(...a) { if (a.length) super(...a); else super(clock.t); } static now() { return clock.t; } }
  const cons = {}; for (const k of ["log", "info", "warn", "error", "debug", "trace"]) cons[k] = (...a) => log.console.push(a.map(String).join(" "));
  const win = {
    navigator: { userAgent: opts.phone ? "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Mobile" : "Mozilla/5.0 (Windows NT 10.0)", maxTouchPoints: 0, platform: "Win32" },
    document: { createElement: mk, getElementById: () => null, head: mk("head"), body: mk("body"), hidden: false },
    sessionStorage: ses, localStorage: loc, URL, URLSearchParams, console: cons, Date: FDate, JSON,
    setTimeout: (f, ms = 0) => { const id = ++tid; timers.set(id, { f, at: clock.t + ms }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    fetch: async (url, opt = {}) => {
      const u = new URL(String(url));
      const path = u.pathname.replace("/api/dapp/", "");
      log.fetches.push({ url: String(url), path, opt, at: clock.t });
      if (server.hold[path]) await server.hold[path];
      const o = server.override && server.override(path, u, opt);
      if (o instanceof Error) throw o;
      const { status = 200, raw } = o || {};
      const body = o && "body" in o ? o.body : defaults(path);
      return { ok: status >= 200 && status < 300, status, json: async () => { if (raw) throw new SyntaxError("Unexpected token '<'"); return body; } };
    },
    koilib: {},
  };
  if (opts.qrScript === undefined) win.qrcode = qrStub;     // library already present: QR renders from the stub
  if (opts.kondor) win.kondor = opts.kondor;
  win.window = win; win.self = win; win.top = win;
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
  const init = () => W.init({
    provider: { wait: async () => ({}) },
    onChange: (a, k) => log.changes.push([a, k]),
    toast: (m) => log.toasts.push(String(m)),
    status: (m) => log.statuses.push(String(m)),
  });
  const option = (which) => { const o = els.filter((e) => e.attrs.class === "kw-opt").slice(-2); return o[which === "vault" ? 1 : 0]; };
  const closeModal = () => { const x = els.filter((e) => e.attrs.class === "kw-x").pop(); x.on.click(); };
  return { W, win, log, ses, loc, clock, server, advance, flush, init, option, closeModal, els };
}


const T0 = 1_800_000_000_000;
const planted = (address) => JSON.stringify({ sessionId: "sid-planted", secret: SECRET, expiresAt: T0 + 20 * 60000, address });

test("(1) connecting Kondor while the old-session check is in flight is not silently switched back to KOIN Vault", async () => {
  let release; 
  const h = harness({ session: { "kw-vault": planted("1Victim") }, kondor: { getAccounts: async () => [{ address: "1Kondor" }], getSigner: () => ({}) } });
  h.server.hold.status = new Promise((r) => { release = r; });
  h.init();
  const p = h.W.connect();
  h.option("kondor").on.click();
  assert.equal(await p, "1Kondor");
  assert.equal(h.W.kind, "kondor");
  release(); await h.flush();
  assert.equal(h.W.kind, "kondor", "the wallet the user just picked must stay in charge");
  assert.equal(h.W.address, "1Kondor", "the page switched to the restored KOIN Vault account behind the user's back");
});

test("(2) a KOIN Vault session planted in sessionStorage by another page of the origin is not adopted without a click", async () => {
  const h = harness({ session: { "kw-vault": planted("1Attacker") } });
  h.server.address = "1Attacker";                 // the attacker's own, really connected session
  h.init();
  await h.flush();
  assert.equal(h.W.address, null, "Knode connected itself to the attacker's KOIN Vault account (session fixation)");
  assert.equal(h.ses.getItem("kw-vault"), null);
});

test("(guard) the planted secret is wiped from storage and only ever sent in a status GET", async () => {
  const h = harness({ session: { "kw-vault": planted("1Attacker") } });
  h.server.address = "1Attacker";
  h.init();
  assert.equal(h.ses.getItem("kw-vault"), null);
  await h.advance(60000);
  for (const f of h.log.fetches) if (f.url.includes(SECRET)) { assert.equal(f.path, "status"); assert.equal(f.opt.method ?? "GET", "GET"); }
  for (const [k, v] of [...h.ses._m, ...h.loc._m]) assert.ok(!String(v).includes(SECRET), `secret in storage ${k}`);
});

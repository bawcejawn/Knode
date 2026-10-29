// Wallet accounts kept across pages (site/wallet.js): only public data is stored (kind + address, which one is active);
// several accounts can be connected and switched; "Disconnect" forgets everything; a remembered account still needs its
// own wallet to sign (KOIN Vault asks again and must name the same account). Offline: fetch, DOM and storage are stubs.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const APP = process.env.APP || ".";
const src = fs.readFileSync(`${APP}/wallet.js`, "utf8");
const SECRET = "S3CR3T-vault-session-secret-0123456789abcdef";
const VAULT = "https://koinvault.app";
const OP = [{ call_contract: { contract_id: "1Mpmf2ERhjYpX7CCiM11WERuM4j17uT1sr", entry_point: 0x12345678, args: "CgA=" } }];
const MAINNET = "EiBZK_GGVP0H_fXVAM3j6EAuz3-B-l3ejxRSewi7qIBfSA==";
const K1 = "1HsM33pF8DbXPr8Vsd4vD7hQgvZ1SHY3Vv", K2 = "1635QUrBNDp7WqmFkRvrkGwjJXTtFvH717", V1 = "1ByDDSBUzy5zkRceELc54Jh8i41yNRoKt8";

// Harness copied unchanged from site.vault-restore.test.mjs (same folder).
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



const chainInit = (h) => h.W.init({ provider: { wait: async () => ({}), getChainId: async () => MAINNET }, onChange: (a, k) => h.log.changes.push([a, k]), toast: (m) => h.log.toasts.push(String(m)) });
const stored = (h) => [...h.loc._m.entries(), ...h.ses._m.entries()].map(([k, v]) => `${k}=${v}`).join("\n");

test("Kondor: every shared account is remembered (addresses only) and one tap switches between them", async () => {
  const h = harness({ kondor: { getAccounts: async () => [{ address: K1, name: "Main" }, { address: K2, name: "Second" }], getSigner: () => ({}) } });
  chainInit(h);
  const p = h.W.connect(); h.option("kondor").on.click();
  assert.equal(await p, K1);
  assert.deepEqual(JSON.parse(h.loc.getItem("kw-accounts")), [{ kind: "kondor", address: K1 }, { kind: "kondor", address: K2 }]);
  assert.equal(h.loc.getItem("kw-active"), K1);
  assert.equal(h.W.switchTo(K2), true);
  assert.equal(h.W.address, K2); assert.equal(h.loc.getItem("kw-active"), K2);
  assert.equal(h.W.switchTo("1NotRememberedAccountxxxxxxxxxxxx"), false);
  assert.doesNotMatch(stored(h), /Main|Second|private|wif|secret|signature/i, "nothing but kinds and addresses");
});

test("another page (or a reload) comes back connected to the active account, without asking the wallet", async () => {
  let asked = 0;
  const h = harness({ local: { "kw-accounts": JSON.stringify([{ kind: "kondor", address: K1 }, { kind: "kondor", address: K2 }]), "kw-active": K2 },
    kondor: { getAccounts: async () => { asked++; return []; }, getSigner: () => ({}) } });
  chainInit(h); await h.advance(10);
  assert.equal(h.W.address, K2); assert.equal(h.W.kind, "kondor");
  assert.deepEqual(h.log.changes.at(-1), [K2, "kondor"], "the page heard about it");
  assert.equal(asked, 0, "no Kondor pop-up on page load");
  assert.equal(h.log.fetches.length, 0);
});

test("a page that sets up after the header still hears about the active account, once", async () => {
  const h = harness({ local: { "kw-accounts": JSON.stringify([{ kind: "kondor", address: K1 }]), "kw-active": K1 } });
  h.W.init({ provider: null });                                   // the header
  const heard = [];
  h.W.init({ provider: { wait: async () => ({}) }, onChange: (a) => heard.push(a) });   // the page
  await h.advance(10);
  assert.deepEqual([...heard], [K1]);
});

test("broken or odd stored entries are ignored", async () => {
  const h = harness({ local: { "kw-accounts": JSON.stringify([{ kind: "evil", address: K1 }, { kind: "kondor", address: "<img src=x onerror=1>" }, "x", null, { kind: "kondor", address: K2, wif: "L1..." }]), "kw-active": K2 } });
  chainInit(h); await h.advance(10);
  assert.deepEqual(JSON.parse(JSON.stringify(h.W.accounts())), [{ kind: "kondor", address: K2 }]);
  assert.equal(h.W.address, K2);
  const h2 = harness({ local: { "kw-accounts": "{not json", "kw-active": K1 } });
  chainInit(h2); await h2.advance(10);
  assert.equal(h2.W.address, null);
});

test("Disconnect forgets every account and the active one; Forget drops just one", async () => {
  const h = harness({ local: { "kw-accounts": JSON.stringify([{ kind: "kondor", address: K1 }, { kind: "kondor", address: K2 }]), "kw-active": K1 } });
  chainInit(h); await h.advance(10);
  h.W.forget(K1);
  assert.equal(h.W.address, K2, "the next remembered account takes over");
  assert.deepEqual(JSON.parse(h.loc.getItem("kw-accounts")), [{ kind: "kondor", address: K2 }]);
  h.W.disconnect();
  assert.equal(h.W.address, null);
  for (const k of ["kw-accounts", "kw-active", "kw-kind", "kw-vault"]) assert.equal(h.loc.getItem(k) ?? h.ses.getItem(k), null, k);
});

test("KOIN Vault: the session secret is never stored; only the address is remembered", async () => {
  const h = harness();
  h.server.address = V1;
  chainInit(h);
  const p = h.W.connect(); h.option("vault").on.click(); await h.advance(2500);
  assert.equal(await p, V1);
  assert.doesNotMatch(stored(h), new RegExp(SECRET));
  assert.deepEqual(JSON.parse(h.loc.getItem("kw-accounts")), [{ kind: "vault", address: V1 }]);
});

test("KOIN Vault, remembered on another page: sending asks KOIN Vault again and refuses a different account", async () => {
  const h = harness({ local: { "kw-accounts": JSON.stringify([{ kind: "vault", address: V1 }]), "kw-active": V1 } });
  h.server.address = "1Attacker9999999999999999999999999";   // KOIN Vault approves some other account
  chainInit(h); await h.advance(10);
  assert.equal(h.W.address, V1);
  const s = h.W.send("answer A", OP); s.catch(() => {});
  await h.advance(2600);   // KOIN Vault opens straight away (no wallet picker) and is approved
  await assert.rejects(s, /different account|Not connected/);
  assert.ok(!h.log.fetches.some((f) => f.path === "request"), "nothing was sent to KOIN Vault for signing");
});

test("KOIN Vault, remembered: the same account approved again → the action goes ahead", async () => {
  const h = harness({ local: { "kw-accounts": JSON.stringify([{ kind: "vault", address: V1 }]), "kw-active": V1 } });
  h.server.address = V1;
  chainInit(h); await h.advance(10);
  const s = h.W.send("answer A", OP); s.catch(() => {});
  await h.advance(2600);   // KOIN Vault opens straight away (no wallet picker) and is approved
  await h.advance(5000);
  assert.ok(h.log.fetches.some((f) => f.path === "request"), "the request went to KOIN Vault for the user's approval");
});

// Menus (owner, 2026-10-28): Games ▾ · Leaderboards · Results · Tools ▾ · Rules · New to Koinos? · Info ▾ at the top; the
// footer keeps only Trust · Terms & risks · Install app · Source code.
test("every page with a header loads the shared wallet button after wallet.js, and has the same top menu and footer", () => {
  for (const p of fs.readdirSync(`${APP}`).filter((f) => f.endsWith(".html"))) {
    const h = fs.readFileSync(`${APP}/${p}`, "utf8");
    if (!/top-row/.test(h)) continue;
    assert.match(h, /<script src="wallet\.js"><\/script>\s*<script src="header-wallet\.js"><\/script>/, `${p}: header wallet`);
    const nav = h.match(/<nav class="tabs"[\s\S]*?<\/nav>/)[0];
    const top = [...nav.matchAll(/^        (?:<a [^>]*>([^<]+)<\/a>|<details[^>]*>)$|^          <summary>([^<]+)<\/summary>$/gm)].map((m) => m[1] || m[2]).filter(Boolean);
    assert.deepEqual(top, ["Games", "Leaderboards", "Results", "Tools", "Rules", "New to Koinos?", "Info"], `${p}: top menu`);
    for (const f of ["games.html", "race.html", "swap.html", "burn.html", "mana.html", "node.html", "pulse.html", "get.html", "start.html", "trust.html", "terms.html", "install.html"])
      assert.ok(nav.includes(`href="${f}"`), `${p}: top menu reaches ${f}`);
    const foot = h.match(/<span class="foot-links">[^\n]*<\/span>/)[0];
    assert.deepEqual([...foot.matchAll(/>([^<]+)<\/a>/g)].map((m) => m[1]), ["Trust", "Terms &amp; risks", "Install app", "Source code"], `${p}: footer links`);
  }
});

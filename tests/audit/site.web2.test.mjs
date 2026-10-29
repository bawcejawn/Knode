// Red-team (web attacker, fix check 2) against the site: frame-buster in wallet.js, per-page CSP, and how the site
// trusts the published question files. Offline: static reads of site/*, README.md, LAUNCH.md and a vm stub window.
// Every case asserts the SAFE behaviour; a failing case is a proven problem. "(guard)" cases are attacks that are blocked.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const APP = process.env.APP || ".";
const read = (p) => fs.readFileSync(`${APP}/${p}`, "utf8");
const exists = (p) => fs.existsSync(`${APP}/${p}`);
const pages = fs.readdirSync(`${APP}`).filter((f) => f.endsWith(".html"));
const cspOf = (html) => { const m = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]*)"/i); const d = {}; if (m) for (const part of m[1].split(";")) { const [n, ...v] = part.trim().split(/\s+/); if (n) d[n] = v; } return d; };

/** wallet.js in a stub window that is framed by another site. */
function framed({ topNavigable }) {
  const log = { fetch: 0, storage: 0, replaced: null };
  const store = { getItem: () => { log.storage++; return null; }, setItem: () => { log.storage++; }, removeItem: () => { log.storage++; } };
  const docEl = { style: {} };
  const top = { location: { replace: (u) => { if (!topNavigable) throw new Error("SecurityError: cross-origin top navigation blocked"); log.replaced = u; } } };
  const win = {
    document: { documentElement: docEl, createElement: () => ({ style: {}, setAttribute() {}, append() {} }), head: { append() {} }, body: { append() {} } },
    location: { href: "https://bawcejawn.github.io/Knode/site/index.html" }, navigator: { userAgent: "x", maxTouchPoints: 0, platform: "Win32" },
    sessionStorage: store, localStorage: store, fetch: async () => { log.fetch++; return { ok: true, json: async () => ({}) }; },
    setTimeout, clearTimeout, URL, URLSearchParams, console,
  };
  win.window = win; win.self = win; win.top = top;
  vm.createContext(win);
  vm.runInContext(read("wallet.js"), win);
  return { win, docEl, log };
}

// S1: README says hashRule 2 makes relabelling impossible, but the page shows the file's wording/options and answers q.chainId without checking params_hash.
test("S1 the game page checks a question file against the on-chain params_hash before offering its answer buttons", () => {
  const app = read("app.js");
  assert.match(read("README.md"), /hashRule: 2[\s\S]{0,200}cannot be relabelled/, "precondition: README makes the wording claim");
  const checks = /params_hash/.test(app) && /crypto\.subtle\.digest|sha256/i.test(app);
  assert.ok(checks, "S1: site/app.js renders title/text/options from game-data/questions/*.json and sends answer(chainId, option) without comparing the file to get_question().params_hash: a tampered or swapped file (option labels reversed, chainId of another question) is shown to players as genuine");
});

// S2: GitHub Pages without a custom domain = origin shared with every other bawcejawn.github.io site (scripts, storage, Kondor's per-origin grant).
// Closed 2026-10-28: the site is served from its own domain, knodegames.com (CNAME at the repository root).
test("S2 the wallet pages are served from an origin of their own (CNAME), not the shared <user>.github.io origin", () => {
  const cname = exists("CNAME") || exists("site/CNAME");
  assert.ok(cname, "S2: no CNAME: any other Pages site of bawcejawn (same origin) can window.open a Knode page, read/patch its JS (fetch hook -> KOIN Vault secret, swapped ops) and reuse the Kondor site permission; the frame-buster does not stop same-origin windows");
});

// S3: the new frame-src 'none' silently breaks the network (iframe) ads that ads.json and LAUNCH.md tell the owner to use.
test("S3 an ad type documented to the owner (iframe network ads) is allowed by index.html's CSP or the docs say what to change", () => {
  const documented = /"type\\?":\s*\\?"iframe/.test(read("ads.json")) || /Ad network/.test(read("LAUNCH.md"));
  if (!documented) return;
  const fsrc = cspOf(read("index.html"))["frame-src"] || [];
  const allowed = fsrc.some((s) => s === "https:" || /^https:\/\/[^']/.test(s));
  const told = /frame-src/.test(read("LAUNCH.md")) || /frame-src/.test(read("ads.json"));
  assert.ok(allowed || told, "S3: index.html has frame-src 'none'; an owner following LAUNCH.md/ads.json for a network ad gets an empty slot (only a code comment in app.js mentions frame-src)");
});

// (guard) framed by a site that may not navigate top: page hidden, no KWallet, no storage or network.
test("(guard) wallet.js inside a cross-origin frame hides the page and defines nothing", () => {
  const { win, docEl, log } = framed({ topNavigable: false });
  assert.equal(docEl.style.display, "none");
  assert.equal(win.KWallet, undefined);
  assert.equal(log.fetch, 0); assert.equal(log.storage, 0);
});

// (guard) framed by a site that lets top be navigated: the top window is sent to the real page.
test("(guard) wallet.js inside a frame navigates the top window to itself", () => {
  const { log, win } = framed({ topNavigable: true });
  assert.equal(log.replaced, "https://bawcejawn.github.io/Knode/site/index.html");
  assert.equal(win.KWallet, undefined);
});

// (guard) every page that can sign loads wallet.js before its own page script, so the buster runs before any wallet button is wired.
test("(guard) wallet pages load wallet.js before their page script", () => {
  const bad = [];
  for (const p of pages) {
    const html = read(`${p}`);
    const own = [...html.matchAll(/<script\b[^>]*\bsrc="([^":]+\.js)"/g)].map((m) => m[1]);
    const signs = own.some((f) => /KWallet|kondor/.test(read(`${f}`)) && f !== "wallet.js");
    if (!signs) continue;
    // The testnet page signs with testnet-wallet.js (its own frame-buster, never the mainnet wallet).
    const wi = /<meta name="kg-network" content="testnet">/.test(html) ? own.indexOf("testnet-wallet.js") : own.indexOf("wallet.js");
    if (wi < 0) { bad.push(`${p}: signs without wallet.js`); continue; }
    for (const f of own.slice(0, wi)) if (/addEventListener|onclick|KWallet|kondor|fetch\(/.test(read(`${f}`))) bad.push(`${p}: ${f} runs before the frame-buster`);
  }
  assert.deepEqual(bad, []);
});

// (guard) exact-file script-src: every CDN entry is a full, versioned file path and each one is really loaded with SRI.
test("(guard) script-src CDN entries are exact versioned files, each loaded with SRI by the page or wallet.js", () => {
  const bad = [];
  const wallet = read("wallet.js");
  for (const p of pages) {
    const html = read(`${p}`), s = cspOf(html)["script-src"] || [];
    for (const v of s.filter((x) => /^https:/.test(x))) {
      if (v.endsWith("/") || !/@\d+\.\d+\.\d+\/|\/\d+\.\d+\.\d+\//.test(v) || /%|\.\.|\?|#/.test(v)) bad.push(`${p}: ${v}`);
      const inPage = new RegExp(`<script\\b[^>]*src="${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*integrity=`).test(html);
      const inWallet = /wallet\.js/.test(html) && wallet.includes(`"${v}"`) && /s\.integrity\s*=/.test(wallet);
      if (!inPage && !inWallet) bad.push(`${p}: ${v} allowed but not loaded with SRI`);
    }
  }
  assert.deepEqual(bad, []);
});

// (guard) a crafted subject in a question file only ever reaches node.html as ?a=…, which node-page.js validates.
test("(guard) node.html ignores a non-address ?a= coming from a question file's subjects", () => {
  const np = read("node-page.js");
  assert.match(np, /const isAddr = \(a\) => \/\^1\[1-9A-HJ-NP-Za-km-z\]\{25,34\}\$\/\.test\(a\)/);
  assert.match(np, /if \(!isAddr\(a\)\) return say\(/);
  assert.doesNotMatch(read("app.js"), /innerHTML|insertAdjacentHTML|outerHTML/);
});

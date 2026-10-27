// Proof test (audit fix check, AB-028): each page's CSP lists only what that page loads: the exact CDN files (not
// whole hosts), 'unsafe-eval' only with koilib, no frames; wallet pages refuse to run inside a frame. The "(guard)"
// cases held before the fix. Offline: reads the files only.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const APP = process.env.APP || ".";
const dir = `${APP}/site`;
const pages = fs.readdirSync(dir).filter((f) => f.endsWith(".html"));
const scripts = fs.readdirSync(dir).filter((f) => f.endsWith(".js"));
const read = (f) => fs.readFileSync(`${dir}/${f}`, "utf8");
const json = (p) => { try { return JSON.parse(fs.readFileSync(`${APP}/${p}`, "utf8")); } catch { return null; } };

function cspOf(html) {
  const m = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/i);
  if (!m) return null;
  const d = {};
  for (const part of m[1].split(";")) { const [name, ...vals] = part.trim().split(/\s+/); if (name) d[name.toLowerCase()] = vals; }
  return { raw: m[1], d, index: m.index };
}
const srcList = (c, name) => c.d[name] ?? c.d["default-src"] ?? [];
/** Does a CSP source list allow this absolute URL? (host / host+path / scheme / 'self' with the Pages origin) */
function allows(list, url, self = "https://bawcejawn.github.io") {
  const u = new URL(url);
  return list.some((s) => {
    if (s === "*") return true;
    if (s === "'self'") return u.origin === self;
    if (/^[a-z]+:$/.test(s)) return u.protocol === s;
    if (!/^https?:\/\//.test(s)) return false;
    const x = new URL(s);
    if (x.origin !== u.origin) return false;
    if (x.pathname === "/" && !s.endsWith("/") ) return true;               // host-only source
    return x.pathname.endsWith("/") ? u.pathname.startsWith(x.pathname) : u.pathname === x.pathname;
  });
}

test("(guard) every page has a CSP meta, inside <head>, before any script, stylesheet, style, img or iframe", () => {
  for (const p of pages) {
    const html = read(p), c = cspOf(html);
    assert.ok(c, `${p}: no CSP`);
    const head = html.indexOf("<head"), first = html.search(/<(script|link\b[^>]*rel="?stylesheet|style|img|iframe|base)\b/i);
    assert.ok(c.index > head && (first < 0 || c.index < first), `${p}: CSP meta comes after something that loads`);
    assert.equal((html.match(/http-equiv="Content-Security-Policy"/gi) || []).length, 1, `${p}: one policy`);
  }
});

test("(guard) script-src refuses inline scripts and handlers, data:/blob: scripts and arbitrary origins", () => {
  for (const p of pages) {
    const c = cspOf(read(p)), s = srcList(c, "script-src");
    for (const bad of ["'unsafe-inline'", "'unsafe-hashes'", "data:", "blob:", "*", "https:", "http:", "'strict-dynamic'"]) assert.ok(!s.includes(bad), `${p}: script-src contains ${bad}`);
    assert.ok(!c.d["script-src-attr"] && !c.d["script-src-elem"], `${p}: no looser per-element/attr script policy`);
    assert.deepEqual(c.d["object-src"], ["'none'"], `${p}: object-src`);
    assert.ok(c.d["base-uri"] && !c.d["base-uri"].includes("*"), `${p}: base-uri`);
    assert.ok(c.d["form-action"], `${p}: form-action`);
    assert.ok(!c.d["default-src"].includes("*") && !c.d["default-src"].includes("https:"), `${p}: default-src too wide`);
    for (const ignored of ["frame-ancestors", "report-uri", "report-to", "sandbox"]) assert.ok(!c.d[ignored], `${p}: ${ignored} is ignored in a meta CSP (false sense of safety)`);
    assert.ok(!/Content-Security-Policy-Report-Only/i.test(read(p)), `${p}: report-only meta does nothing`);
  }
});

test("(guard) nothing on the pages needs what the CSP blocks (inline script, on*= handlers, javascript: URLs, string timers)", () => {
  const bad = [];
  for (const p of pages) {
    const html = read(p);
    for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      // A JSON-LD block (search-engine data) is never run, so the CSP doesn't apply; it must still be valid JSON.
      if (/\btype="application\/ld\+json"/.test(m[1]) && !/\bsrc=/.test(m[1])) { try { JSON.parse(m[2]); } catch { bad.push(`${p}: JSON-LD block is not valid JSON`); } continue; }
      if (!/\bsrc=/.test(m[1]) || m[2].trim()) bad.push(`${p}: inline <script>`);
    }
    for (const m of html.matchAll(/<[a-z][^>]*\s(on[a-z]+)\s*=/gi)) bad.push(`${p}: inline handler ${m[1]}`);
    if (/(href|src|action)\s*=\s*"\s*javascript:/i.test(html)) bad.push(`${p}: javascript: URL`);
  }
  for (const f of scripts) {
    const js = read(f);
    if (/set(Timeout|Interval)\(\s*["'`]/.test(js)) bad.push(`${f}: string timer`);
    if (/setAttribute\(\s*["']on[a-z]+["']/.test(js)) bad.push(`${f}: setAttribute("on...")`);
    if (/\.src\s*=\s*["'`](data|javascript):/.test(js) || /["'`]\s*javascript:/i.test(js)) bad.push(`${f}: data:/javascript: script or URL`);
  }
  // node-page.js's el() sets every attr with setAttribute, so it must never be handed an on* key.
  const np = read("node-page.js");
  for (const m of np.matchAll(/\bel\(\s*"[a-z]+"\s*,\s*\{([^}]*)\}/g)) if (/\bon[a-z]+\s*:/.test(m[1])) bad.push(`node-page.js: el(..., { on... }) becomes an inline handler`);
  assert.deepEqual(bad, []);
});

test("(guard) every origin the pages fetch or load from is allowed (connect-src incl. each deployment rpc, scripts, fonts)", () => {
  const rpcs = new Set(["https://api.koinos.io"]);
  for (const p of ["game-data/deployment.json", "game-data/game.json", "desk-data/deployment.json"]) { const j = json(p); if (j && j.rpc) rpcs.add(j.rpc); }
  const missing = [];
  for (const p of pages) {
    const html = read(p), c = cspOf(html);
    const conn = srcList(c, "connect-src");
    const usesChain = /koilib@/.test(html), usesWallet = /wallet\.js/.test(html);
    if (usesChain) for (const r of rpcs) if (!allows(conn, r)) missing.push(`${p}: connect-src lacks rpc ${r}`);
    if (usesWallet && !allows(conn, "https://koinvault.app/api/dapp/status")) missing.push(`${p}: connect-src lacks KOIN Vault`);
    if (!allows(conn, "https://bawcejawn.github.io/Knode/game-data/deployment.json")) missing.push(`${p}: connect-src lacks 'self'`);
    for (const m of html.matchAll(/<script\b[^>]*\bsrc="(https:[^"]+)"/g)) if (!allows(srcList(c, "script-src"), m[1])) missing.push(`${p}: script-src blocks ${m[1]}`);
    if (usesWallet && !allows(srcList(c, "script-src"), "https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js")) missing.push(`${p}: script-src blocks the QR library`);
    for (const m of html.matchAll(/<link\b[^>]*href="(https:\/\/fonts\.googleapis\.com[^"]+)"[^>]*rel="stylesheet"/g)) if (!allows(srcList(c, "style-src"), m[1])) missing.push(`${p}: style-src blocks fonts css`);
    if (/fonts\.googleapis/.test(html) && !allows(srcList(c, "font-src"), "https://fonts.gstatic.com/s/x.woff2")) missing.push(`${p}: font-src blocks gstatic`);
    if (usesChain && !srcList(c, "script-src").includes("'unsafe-eval'")) missing.push(`${p}: koilib needs 'unsafe-eval'`);
  }
  assert.deepEqual(missing, []);
});

test("(A) script-src pins the exact CDN files, not the whole jsDelivr / cdnjs hosts (CSP-bypass gadgets)", () => {
  const wide = [];
  for (const p of pages) {
    const s = srcList(cspOf(read(p)), "script-src");
    for (const v of s) if (/^https:\/\/(cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com)\/?$/.test(v)) wide.push(`${p}: ${v}`);
    // the attacker's file must not be loadable
    for (const evil of ["https://cdn.jsdelivr.net/gh/attacker/payload@1.0.0/x.js", "https://cdnjs.cloudflare.com/ajax/libs/angular.js/1.8.3/angular.min.js"])
      if (allows(s, evil)) wide.push(`${p}: allows ${evil}`);
  }
  assert.deepEqual(wide, [], "host-wide CDN sources make the CSP bypassable after any HTML injection");
});

test("(B) wallet pages refuse to run inside a frame (frame-ancestors can't be set from a meta CSP)", () => {
  const framable = [];
  const buster = /\b(window\.)?top\s*!==?\s*(window\.)?self\b|\bself\s*!==?\s*(window\.)?top\b|window\.top\s*!==?\s*window\b|window\s*!==?\s*window\.top\b|frameElement/;
  for (const p of pages) {
    const html = read(p);
    if (!/wallet\.js/.test(html)) continue;
    const own = [...html.matchAll(/<script\b[^>]*\bsrc="([^":]+\.js)"/g)].map((m) => m[1]).filter((f) => fs.existsSync(`${dir}/${f}`));
    if (!own.some((f) => buster.test(read(f)))) framable.push(p);
  }
  assert.deepEqual(framable, [], "clickjackable wallet pages (no X-Frame-Options / frame-ancestors on GitHub Pages)");
});

test("(C) least privilege per page: no 'unsafe-eval' / CDN without koilib, no frames without ads", () => {
  const extra = [];
  for (const p of pages) {
    const html = read(p), c = cspOf(html), s = srcList(c, "script-src");
    const usesKoilib = /koilib@/.test(html), usesCdn = /<script\b[^>]*src="https:/.test(html) || /wallet\.js/.test(html);
    if (!usesKoilib && s.includes("'unsafe-eval'")) extra.push(`${p}: 'unsafe-eval' without koilib`);
    if (!usesCdn && s.some((v) => /^https:/.test(v))) extra.push(`${p}: CDN script hosts without any CDN script`);
    const usesFrames = /data-ad-slot/.test(html);
    const fs_ = c.d["frame-src"] ?? c.d["child-src"] ?? c.d["default-src"];
    if (!usesFrames && !(fs_.length === 1 && fs_[0] === "'none'") && !(fs_.length === 1 && fs_[0] === "'self'")) extra.push(`${p}: frame-src ${fs_.join(" ")} without ad frames`);
  }
  assert.deepEqual(extra, []);
});

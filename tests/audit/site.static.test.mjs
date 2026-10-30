// Red team (web attacker) for Knode @ 6b37c46: static checks over site/*.html and site/*.js.
// "(blocked)" tests pass today and guard the defence; the others assert the SAFE state and FAIL today = proof.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const APP = process.env.APP || ".";
const dir = `${APP}`;
const files = fs.readdirSync(dir).filter((f) => /\.(html|js)$/.test(f));
const read = (f) => fs.readFileSync(`${dir}/${f}`, "utf8");

test("every external <script> on the wallet pages carries Subresource Integrity", () => {
  // koilib / kondor-js from jsDelivr build and sign every transaction; a CDN compromise = every visitor's wallet ops.
  const missing = [];
  for (const f of files.filter((x) => x.endsWith(".html"))) {
    for (const m of read(f).matchAll(/<script\b[^>]*\bsrc="(https?:[^"]+)"[^>]*>/g)) if (!/\bintegrity=/.test(m[0])) missing.push(`${f}: ${m[1]}`);
  }
  // wallet.js:110 also injects cdnjs qrcode-generator at runtime without integrity.
  if (/s\.src = "https:\/\/cdnjs[^"]+"/.test(read("wallet.js")) && !/s\.integrity\s*=/.test(read("wallet.js"))) missing.push("wallet.js: runtime qrcode-generator");
  assert.deepEqual(missing, [], `no SRI on:\n${missing.join("\n")}`);
});

test("pages declare a Content-Security-Policy (GitHub Pages sends none)", () => {
  const without = files.filter((f) => f.endsWith(".html") && !/http-equiv="Content-Security-Policy"/i.test(read(f)));
  assert.deepEqual(without, [], `no CSP meta on: ${without.join(", ")}`);
});

test("(blocked) no HTML-string sinks: chain/question data is only ever set as text or attributes", () => {
  const hits = [];
  for (const f of files) read(f).split("\n").forEach((l, i) => {
    // The one exception: wallet.js QR code = SVG built by the QR library from a URI already checked to be https://koinvault.app/.
    if (f === "wallet.js" && /qr\.innerHTML = c\.createSvgTag\(/.test(l)) return;
    if (/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/.test(l)) hits.push(`${f}:${i + 1}`);
  });
  assert.deepEqual(hits, [], hits.join(", "));
});

test("(blocked) no postMessage / message listeners an attacker frame or opener could talk to", () => {
  const hits = files.filter((f) => /postMessage|addEventListener\(\s*["']message["']|onmessage/.test(read(f)));
  assert.deepEqual(hits, []);
});

test("(blocked) external links opened in a new tab use rel=noopener (no reverse tabnabbing)", () => {
  const bad = [];
  for (const f of files.filter((x) => x.endsWith(".html"))) {
    for (const m of read(f).matchAll(/<a\b[^>]*target="_blank"[^>]*>/g)) if (!/rel="[^"]*noopener/.test(m[0])) bad.push(`${f}: ${m[0]}`);
  }
  assert.deepEqual(bad, []);
});

test("(blocked) ad and ecosystem links are restricted to https (app.js httpsUrl, start.html check)", () => {
  const app = read("app.js");
  const httpsUrl = eval(app.match(/const httpsUrl = (\(u\) => \{.*?\});/)[1].replace("location.href", '"https://bawcejawn.github.io/Knode/site/"'));
  assert.equal(httpsUrl("javascript:alert(1)"), null);
  assert.equal(httpsUrl("data:text/html,<script>alert(1)</script>"), null);
  assert.equal(httpsUrl("http://evil.example/"), null);
  assert.equal(httpsUrl("https://koindx.com/"), "https://koindx.com/");
  assert.match(read("start.js"), /u\.protocol !== "https:"/);   // (repo) start.html's script moved to start.js for the CSP
});

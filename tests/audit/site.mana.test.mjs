// Mana levels page (site/mana.html + mana.js): the recharge math, and that the page only reads (never signs or sends).
// Offline: runs mana.js's math in a sandbox with no page, and reads the files.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const APP = process.env.APP || ".";
const js = fs.readFileSync(`${APP}/mana.js`, "utf8");
const html = fs.readFileSync(`${APP}/mana.html`, "utf8");
const box = { window: {} };
vm.runInNewContext(js, box);
const { gauge, answersFor, UNIT } = box.window.KManaMath;
const K = (n) => BigInt(Math.round(n * 1e8));
const H = 3600000, D = 86400000;

test("a full tank: Mana = KOIN, full now, refills a fifth of the KOIN per day", () => {
  const g = gauge({ koin: K(100), mana: K(100), t0: 0 });
  assert.equal(g.full, true); assert.equal(g.msToFull, 0); assert.equal(g.pct, 100);
  assert.equal(g.perDay, K(20)); assert.equal(g.perHour, K(100) / 120n);
});

test("an empty tank is full again after exactly 5 days, half full after 2.5", () => {
  const g = gauge({ koin: K(50), mana: 0n, t0: 0 });
  assert.equal(g.msToFull, 5 * D); assert.equal(g.pct, 0);
  assert.equal(gauge({ koin: K(50), mana: 0n, t0: 0, at: 2.5 * D }).now, K(25));
  assert.equal(gauge({ koin: K(50), mana: 0n, t0: 0, at: 5 * D }).full, true);
  assert.equal(gauge({ koin: K(50), mana: 0n, t0: 0, at: 9 * D }).now, K(50), "never above the KOIN balance");
});

test("time to full shrinks as the gauge ticks, and counts from the projected level", () => {
  const r = { koin: K(10), mana: K(4), t0: 1000 };
  const a = gauge(r), b = gauge({ ...r, at: 1000 + H });
  assert.equal(a.msToFull, 3 * D);                       // 6 of 10 missing = 3 of 5 days
  assert.ok(Math.abs(a.msToFull - b.msToFull - H) <= 1, "an hour later it's an hour sooner (to the millisecond; units round down)");
  assert.equal(b.now, K(4) + K(10) / 120n);
});

test("no KOIN means no Mana and no recharge (no division by zero)", () => {
  const g = gauge({ koin: 0n, mana: 0n, t0: 0, at: D });
  assert.equal(g.empty, true); assert.equal(g.now, 0n); assert.equal(g.perDay, 0n); assert.equal(g.msToFull, 0); assert.equal(g.pct, 0);
});

test("a reading above the balance (KOIN just moved out) is shown as the balance", () => {
  const g = gauge({ koin: K(3), mana: K(8), t0: 0 });
  assert.equal(g.now, K(3)); assert.equal(g.full, true);
});

test("about N answers uses ≈0.35 Mana each", () => {
  assert.equal(answersFor(K(3.5)), 10n); assert.equal(answersFor(0n), 0n); assert.equal(UNIT, 100000000n);
});

test("the page only reads: no signing, sending or contract writes", () => {
  assert.doesNotMatch(js, /\.send\(|signTransaction|sendTransaction|onlyOperation|transfer\(|approve\(/);
  assert.match(html, /<script src="mana\.js"><\/script>/);
});

test("the address from a link is checked (base58 + checksum) before any chain read", () => {
  assert.match(js, /if \(!isAddr\(addr\)\) return say/);
  assert.match(js, /isChecksumAddress/);
});

test("every page's header links to Mana levels", () => {
  const pages = fs.readdirSync(`${APP}`).filter((f) => f.endsWith(".html"));
  const missing = pages.filter((p) => /class="tabs"/.test(fs.readFileSync(`${APP}/${p}`, "utf8")) && !/<a href="mana\.html"/.test(fs.readFileSync(`${APP}/${p}`, "utf8")));
  assert.deepEqual(missing, []);
});

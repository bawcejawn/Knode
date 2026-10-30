// Reminders and the share picture run only in the visitor's browser: the calendar file follows RFC 5545 and repeats
// Monday to Saturday at 12:00 UTC, the share picture leaves the wallet address out unless the player asks, nothing
// in extras.js talks to the network, and the game page's Content-Security-Policy stays exactly as it was.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const APP = process.env.APP || ".";
const src = fs.readFileSync(`${APP}/extras.js`, "utf8");
const ctx = { window: {}, globalThis: {}, Date, String, Promise, Math };
ctx.globalThis = ctx;
vm.runInNewContext(src, ctx);
const X = ctx.window.KnodeExtras;

test("extras: the calendar reminder repeats Monday to Saturday at 12:00 UTC (RFC 5545)", () => {
  const now = new Date("2026-10-31T13:00:00Z");           // a Saturday after the release: next is Monday
  const ics = X.buildIcs("https://example.test/Knode/site/#play", now);
  assert.ok(ics.startsWith("BEGIN:VCALENDAR\r\n") && ics.endsWith("END:VCALENDAR\r\n"));
  assert.ok(!/[^\r]\n/.test(ics), "every line ends with CRLF");
  for (const line of ics.split("\r\n")) assert.ok(line.length <= 75, `line too long: ${line}`);
  const unfolded = ics.replace(/\r\n /g, "");
  assert.match(unfolded, /\r\nRRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA\r\n/);
  assert.match(unfolded, /\r\nDTSTART:20261102T120000Z\r\n/);
  assert.match(unfolded, /\r\nUID:knode-daily-questions@knode\r\n/);
  assert.match(unfolded, /\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:PT0M\r\n/);
  assert.match(unfolded, /DESCRIPTION:[^\r]*Answers close at 00:00 UTC/);
  assert.match(unfolded, /https:\/\/example\.test\/Knode\/site\/#play/);
  // the next release is never on a Sunday, and is today's 12:00 UTC when it hasn't happened yet
  assert.equal(X.nextRelease(new Date("2026-11-01T09:00:00Z")).toISOString(), "2026-11-02T12:00:00.000Z");
  assert.equal(X.nextRelease(new Date("2026-10-27T09:00:00Z")).toISOString(), "2026-10-27T12:00:00.000Z");
});

test("extras: the share picture shows no wallet address unless the player ticks it", () => {
  const st = { week: 2, pts: 6, place: 4, of: 18, right: 6, decided: 9, free: false, address: "1Mpmf2ERhjYpX7CCiM11WERuM4j17uT1sr" };
  const off = X.shareLines(st).map((l) => l.text).join(" | ");
  assert.ok(!off.includes(st.address), off);
  assert.match(off, /6 points/); assert.match(off, /#4 of 18/); assert.match(off, /6 of 9 right/);
  const on = X.shareLines(st, { showAddress: true }).map((l) => l.text).join(" | ");
  assert.ok(on.includes(st.address));
  assert.match(X.shareLines({ ...st, free: true, place: 0 }).map((l) => l.text).join(" "), /Free play/);
});

test("extras: nothing in extras.js reaches the network", () => {
  for (const bad of [/\bfetch\s*\(/, /XMLHttpRequest/, /sendBeacon/, /new\s+Image\b/, /WebSocket/, /importScripts/]) assert.ok(!bad.test(src), String(bad));
});

// Changed once on purpose (2026-10-28): the Leaderboards page reads the race recorder's board.json (read-only JSON).
test("extras: the game page's Content-Security-Policy is unchanged", () => {
  const html = fs.readFileSync(`${APP}/index.html`, "utf8");
  const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
  assert.equal(csp, "default-src 'self'; script-src 'self' 'unsafe-eval' https://cdn.jsdelivr.net/npm/koilib@9.4.1/dist/koinos.min.js https://cdn.jsdelivr.net/npm/kondor-js@1.3.0/dist/kondor.min.js https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self' https://koinos.armana.io https://api.koinos.io https://koinvault.app https://raw.githubusercontent.com/bawcejawn/Knode/race-data/ https://raw.githubusercontent.com/bawcejawn/Knode/names-data/; manifest-src 'self'; worker-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'self'");
  assert.match(html, /<script src="extras\.js"><\/script>/);
});

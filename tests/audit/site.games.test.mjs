// The Knode Games hub (site/games.html, games.js, games.json) and the welcome page's games list: plain data, no HTML
// from data, the same strict page rules as every other page, and every game listed on the welcome page.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const APP = process.env.APP || ".";
const read = (p) => fs.readFileSync(`${APP}/${p}`, "utf8");
const games = JSON.parse(read("games.json")).games;

test("games.json: known kinds and statuses, plain text, live games link to this site's own pages", () => {
  assert.ok(games.length >= 6);
  const ids = new Set();
  for (const g of games) {
    assert.match(g.id, /^[a-z0-9-]{1,24}$/); assert.ok(!ids.has(g.id), `${g.id} listed once`); ids.add(g.id);
    assert.ok(g.kinds.length && g.kinds.every((k) => k === "free" || k === "staked"), g.id);
    assert.ok(g.status === "live" || g.status === "soon", g.id);
    assert.ok(g.status === "soon" ? g.href === "" : /^[a-z0-9-]+\.html(#[a-z/]+)?$/.test(g.href), `${g.id}: link`);
    assert.doesNotMatch(g.name + g.line, /[<>]/, `${g.id}: plain text`);
    if (g.status === "live" && g.href.includes(".html")) assert.ok(fs.existsSync(`${APP}/${g.href.split("#")[0]}`), `${g.id}: page exists`);
  }
  assert.deepEqual(games.filter((g) => g.status === "live").map((g) => g.id).sort(), ["questions", "race"]);
});

test("games.js only reads and draws: no sending, no storage, no HTML from data; it checks games.json itself", () => {
  const js = read("games.js");
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function|localStorage|sessionStorage|indexedDB|\.send\(|signTransaction/);
  assert.match(js, /function clean\(list\)/);
  assert.match(js, /\^\[a-z0-9-\]\+\\\.html/, "links limited to this site's pages");
});

test("games.html: no inline script or handler, pinned CDN scripts, and it reads only the race-data branch besides the chain", () => {
  const h = read("games.html");
  assert.doesNotMatch(h, /<script(?![^>]*\bsrc=)[^>]*>/, "no inline script");
  assert.doesNotMatch(h, /\son[a-z]+\s*=/i, "no inline handlers");
  for (const m of h.matchAll(/<script src="https:[^"]+"([^>]*)>/g)) assert.match(m[1], /integrity="sha384-/);
  const csp = h.match(/Content-Security-Policy" content="([^"]+)"/)[1];
  assert.match(csp, /connect-src 'self' https:\/\/koinos\.armana\.io https:\/\/api\.koinos\.io https:\/\/raw\.githubusercontent\.com\/bawcejawn\/Knode\/race-data\/ https:\/\/koinvault\.app;/);
  assert.match(csp, /frame-src 'none'; object-src 'none'; base-uri 'self'/);
});

test("the welcome page lists every game in games.json and links to the hub", () => {
  const h = read("index.html");
  const box = h.match(/<div class="welcome-also" id="welcome-games">([\s\S]*?)<\/div>\s*<div class="welcome-actions">/);
  assert.ok(box, "welcome games list");
  for (const g of games) assert.ok(box[1].includes(`<b>${g.name}</b>`), `welcome lists ${g.name}`);
  assert.match(box[1], /href="games\.html"/);
});

test("the service worker keeps the hub page and script but no game or race data", () => {
  const sw = read("sw.js");
  assert.match(sw, /"games\.html", "games\.js"/);
  assert.doesNotMatch(sw.match(/const SHELL = \[[^\]]*\]/)[0], /game-data|race-data|board\.json/);
});

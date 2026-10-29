// Block Golf page (site/golf.html, golf.js, golf.css): the same strict page rules as every game page, nothing built
// from HTML, read-only (no transaction, no storage), and every element the script draws into exists. Offline.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const APP = process.env.APP || ".";
const read = (f) => fs.readFileSync(`${APP}/site/${f}`, "utf8");
const html = read("golf.html"), js = read("golf.js");
const csp = (h) => (/http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(h) || [])[1];

test("the same Content-Security-Policy as the other game pages; no inline scripts or handlers", () => {
  assert.equal(csp(html), csp(read("blockx.html")));
  assert.doesNotMatch(html, /<script>(?!\s*<\/script>)|<script(?![^>]*\bsrc=)[^>]*>/i, "no inline script");
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, "no inline handlers");
  for (const m of html.matchAll(/<script src="https:[^"]+"[^>]*>/g)) assert.match(m[0], /integrity="sha384-[^"]+" crossorigin="anonymous"/, "CDN scripts pinned");
});

test("scripts load in order: wallet first, then the shared rules, the board, the page", () => {
  const srcs = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]).filter((s) => !s.startsWith("https:"));
  assert.deepEqual(srcs, ["guest.js", "wallet.js", "header-wallet.js", "nav.js", "golf-math.js", "board.js", "golf.js"]);
  assert.match(html, /<link rel="stylesheet" href="board\.css">\s*<link rel="stylesheet" href="golf\.css">/);
});

test("golf.js builds nothing from HTML, sends nothing and stores nothing", () => {
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.doesNotMatch(js, /localStorage|sessionStorage|indexedDB|document\.cookie/);
  assert.doesNotMatch(js, /\.send\(|signTransaction|method:\s*"POST"/);
  assert.match(js, /const DATA = "https:\/\/raw\.githubusercontent\.com\/bawcejawn\/Knode\/games-data\/golf\/"/);
  assert.ok(csp(html).includes("https://raw.githubusercontent.com/bawcejawn/Knode/games-data/"), "the page may read games-data");
});

test("every element the script uses exists once in the page", () => {
  const ids = new Set([...js.matchAll(/\$\("([a-z0-9-]+)"\)/g)].map((m) => m[1]));
  assert.ok(ids.size > 10);
  for (const id of ids) assert.equal((html.match(new RegExp(`id="${id}"`, "g")) || []).length, 1, id);
});

test("game links come only from games.json pages on this site", () => {
  assert.match(js, /\/\^\[a-z0-9-\]\+\\\.html\(#\[a-z0-9\/-\]\*\)\?\$\/\.test\(g\.href\)/);
});

test("the page's stroke key matches the shared rules", () => {
  const box = { window: {} };
  vm.runInNewContext(read("golf-math.js"), box);
  const G = box.window.KGolf;
  assert.equal(JSON.stringify(G.BANDS.map((b) => b[0])), "[5,25,65,90,100]");
  for (const pct of [5, 25, 65, 90]) assert.ok(html.includes(`Top ${pct}%`) || js.includes(`Top ${pct}%`), `${pct}% in the key`);
  assert.match(html, /fewer than 5 such players/);
  assert.equal(G.MIN_FIELD, 5);
});

test("games.json: Block Golf has a leaderboard on games-data, and stays 'soon' until the owner turns it on", () => {
  const g = JSON.parse(read("games.json")).games.find((x) => x.id === "golf");
  assert.equal(g.status, "soon");
  assert.equal(g.board.data, "games-data/golf/board.json");
  assert.deepEqual(g.board.columns.map((c) => c.key), ["pts", "topar", "holes", "lost"]);
});

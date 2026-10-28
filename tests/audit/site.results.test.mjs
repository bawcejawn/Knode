// Results (index.html#results, site/results.js): a tab per game. Daily Questions keeps app.js's results; the Producer
// Race shows every recorded week from the race recorder. Read-only, plain text, this repo's race-data only. Offline.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const APP = process.env.APP || ".";
const read = (p) => fs.readFileSync(`${APP}/site/${p}`, "utf8");

test("results.js only reads and draws: no sending, storage, eval or HTML from data", () => {
  const js = read("results.js");
  assert.doesNotMatch(js, /innerHTML|insertAdjacentHTML|document\.write|eval\(|new Function|localStorage|sessionStorage|indexedDB|sendTransaction|\.send\(|signTransaction/);
  assert.match(js, /RAW \+ "race-data\/index\.json"/);
  assert.match(js, /race-data\/W\$\{String\(w\)\.padStart\(3, "0"\)\}\.json/, "week files by number only");
  assert.match(js, /const ADAPTERS = \{ race \};/, "a game needs a drawing here before it gets a tab");
});

test("the results view has a game switcher and keeps the question results whole", () => {
  const h = read("index.html");
  assert.match(h, /id="res-games"/);
  assert.match(h, /<div id="res-q">[\s\S]*id="results-list"[\s\S]*<\/div>\s*<div id="res-g" hidden><\/div>\s*<\/section>/);
  assert.match(h, /<script src="race-math\.js"><\/script>\s*<script src="results\.js"><\/script>/);
  assert.ok(h.includes("https://raw.githubusercontent.com/bawcejawn/Knode/race-data/"), "index.html may read race-data");
});

test("games.json: the Producer Race has results; the hub links every game's results", () => {
  const race = JSON.parse(read("games.json")).games.find((g) => g.id === "race");
  assert.equal(race.results, true);
  assert.match(read("games.html"), /id="g-results"/);
  assert.match(read("games.js"), /index\.html#results\/\$\{g\.id\}/);
});

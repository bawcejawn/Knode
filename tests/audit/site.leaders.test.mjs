// Leaderboards (index.html#leaderboard, site/leaders.js): one tab per game, each with its own players and points.
// Plain data only, no storage, and only recorder files on this repo's data branches. Offline.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const APP = process.env.APP || ".";
const read = (p) => fs.readFileSync(`${APP}/site/${p}`, "utf8");

test("leaders.js only reads and draws: no sending, storage, eval or HTML from data", () => {
  const js = read("leaders.js");
  assert.doesNotMatch(js, /innerHTML|insertAdjacentHTML|document\.write|eval\(|new Function|localStorage|sessionStorage|indexedDB|sendTransaction|\.send\(|signTransaction/);
  assert.match(js, /\^\(race-data\|games-data\)/, "board files must be on this repo's data branches");
});

test("every live game in games.json with a leaderboard points at a recorder board.json with plain columns", () => {
  const games = JSON.parse(read("games.json")).games;
  const race = games.find((g) => g.id === "race");
  assert.ok(race && race.board, "the Producer Race has its own leaderboard");
  for (const g of games.filter((x) => x.board)) {
    assert.match(g.board.data, /^(race-data|games-data)\/([a-z0-9-]{1,24}\/)?board\.json$/, `${g.id}: data file`);
    assert.ok(Array.isArray(g.board.columns) && g.board.columns.length >= 1 && g.board.columns.length <= 6, `${g.id}: columns`);
    for (const c of g.board.columns) { assert.match(c.key, /^[a-z]{1,12}$/); assert.ok(c.label.length <= 20); }
    const branch = g.board.data.split("/")[0];
    assert.ok(read("index.html").includes(`https://raw.githubusercontent.com/bawcejawn/Knode/${branch}/`), `${g.id}: index.html may read ${branch}`);
  }
});

test("the leaderboard view has a game switcher, keeps the question table, and loads the shared board", () => {
  const h = read("index.html");
  assert.match(h, /id="lb-games"/);
  assert.match(h, /<div id="lb-q">[\s\S]*id="board"[\s\S]*<\/div>\s*<div class="lb-game" id="lb-game" hidden><\/div>/);
  assert.match(h, /<script src="app\.js"><\/script>\s*<script src="board\.js"><\/script>\s*<script src="leaders\.js"><\/script>/);
  assert.match(h, /<link rel="stylesheet" href="board\.css">/);
});

test("the More sheet calls it Leaderboards (every game), not the question leaderboard", () => {
  assert.match(read("race.html"), />Leaderboards</);
  assert.doesNotMatch(read("race.html"), /Question leaderboard/);
});

// Free play (owner, 2026-10-28): wallets without VHP or a stake have their own board in every game. Only the top 6
// are listed; everyone else stays private, and a free player still sees their own place.
test("free play boards: the shared board lists only the top N unranked rows and keeps the rest private", async () => {
  const src = read("board.js");
  assert.match(src, /function renderFree\(/);
  assert.match(src, /free\.slice\(0, F\.show\)/, "only the top N free rows are drawn");
  assert.match(src, /!r\.ranked/, "free play = rows that aren't ranked");
  const games = JSON.parse(read("games.json")).games;
  const race = games.find((g) => g.id === "race");
  assert.equal(race.board.free.show, 6);
  assert.match(read("race.js"), /free: \{ show: 6,/);
  assert.match(read("leaders.js"), /b\.free\.show >= 3 && b\.free\.show <= 10/, "games.json can't ask for a long free list");
});

test("free play boards: the question leaderboard splits Staked / Free play and lists only the top 6 free players", () => {
  const app = read("app.js");
  assert.match(app, /const FREE_SHOW = 6;/);
  assert.match(app, /freeAll\.slice\(0, FREE_SHOW\)/);
  assert.match(app, /everyone\.filter\(\(s\) => s\.stake >= UNIT\)/, "the staked board holds staked players only");
  assert.match(read("index.html"), /id="lb-kind"[\s\S]*id="lb-me"/);
});

test("Staked / Free play: the same two board names in every game, fixed in board.js", () => {
  assert.match(read("board.js"), /const LABELS = Object\.freeze\(\{ staked: "Staked", free: "Free play" \}\)/);
  assert.match(read("board.js"), /main: LABELS\.staked, label: LABELS\.free/, "a game can't rename the boards");
  assert.match(read("app.js"), /\[\["main", L\.staked\], \["free", L\.free\]\]/, "the question table uses the same names");
  for (const f of ["race.js", "leaders.js", "games.json"]) assert.doesNotMatch(read(f), /main: "|"main":|VHP players/, `${f}: no per-game board names`);
});

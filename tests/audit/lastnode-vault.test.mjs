// Last Node Standing → Vault v6 (hand-off 2026-10-28): the weekly vault file. Only wallets staked in game 13 for that
// week with at least 1 point, scores keeping the board's order and ties on 1–255, no prize places (a staked game),
// written once the week is final and within the Vault's 3-day window, never on the testnet, never before v6.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const APP = process.env.APP || ".";
const { run, vaultScores } = await import(path.resolve(APP, "bot/games/lastnode.ts"));
const L = globalThis.KLastNode;
const A = (c) => "1" + c.repeat(33);
const row = (a, pts, rides = 0, jumps = 0) => ({ a, pts, rides, jumps });

test("scores: the real points when they already give the board's order", () => {
  const r = vaultScores([row(A("A"), 20, 2), row(A("B"), 14, 1), row(A("C"), 14, 1), row(A("D"), 3), row(A("E"), 0)]);
  assert.deepEqual(r.map((x) => x.points), [20, 14, 14, 3], "ties kept; 0 points left out");
});

test("scores: tie-breaks (rides, then fewer jumps) become separate places, ties on everything share", () => {
  const r = vaultScores([row(A("A"), 14, 2, 0), row(A("B"), 14, 1, 0), row(A("C"), 14, 1, 1), row(A("D"), 14, 1, 1), row(A("E"), 9)]);
  assert.deepEqual(r.map((x) => x.points), [4, 3, 2, 2, 1]);
  // More than 10 tied on everything share one score.
  const many = Array.from({ length: 14 }, (_, i) => row("1" + String.fromCharCode(65 + i).repeat(33), 7, 1, 0));
  assert.ok(vaultScores(many).every((x) => x.points === 7));
  assert.deepEqual(vaultScores([]), [], "nobody qualifies: no rows");
});

test("scores: more than 255 different places fall back to points, still in order", () => {
  const rows = Array.from({ length: 300 }, (_, i) => row("1" + i.toString(36).padStart(33, "x"), 200 - Math.floor(i / 2), i % 2, 0));
  const r = vaultScores(rows);
  assert.ok(r.every((x) => x.points >= 1 && x.points <= 255));
  assert.ok(r.every((x, i) => i === 0 || r[i - 1].points >= x.points));
});

// A whole week of events from the recorder's own files, then the run after the week ends.
function weekFiles(w, players) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lns-v-"));
  const days = [];
  for (let t = L.weekStart(w); t < L.weekStart(w + 1); t += L.DAY) {
    const ev = L.eventOf(t);
    days.push(ev.day);
    fs.writeFileSync(path.join(dir, `D${ev.day}.json`), JSON.stringify({ v: 1, day: ev.day, start: ev.start, week: w, field: null, void: "test", hours: [], picks: {}, cuts: [], standing: [], winner: null, done: false, players: [] }));
  }
  // One finished event with the players' results.
  const ev = L.eventOf(L.weekStart(w) + L.DAY), N = [A("N"), A("M")];
  const field = { at: 0, c: 0, fairness: null, nodes: [{ a: N[0], vhp: 2, kh: 100, h: 1 }, { a: N[1], vhp: 1, kh: 50, h: 2 }] };
  const picks = { 0: players.map(([p, n]) => [p, N[n], ev.start - 3600000]) };
  fs.writeFileSync(path.join(dir, `D${ev.day}.json`), JSON.stringify({ v: 1, day: ev.day, start: ev.start, week: w, field, hours: [{ i: 0, from: 1, to: 2, blocks: { [N[0]]: 100, [N[1]]: 10 }, checked: 2 }], picks, cuts: [], standing: [], winner: null, done: false, players: [] }));
  fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify({ v: 1, days, contract: null, game: 13 }));
  return dir;
}
const P1 = A("P"), P2 = A("Q"), P3 = A("R");
const go = (prev, now, stakedOf) => run({ p: "m", check: null, prev, out: prev, raceDir: "", picksContract: null, windowOf: async () => { throw new Error("no blocks needed"); },
  picksOf: async () => [], rankedOf: async (w) => new Set(w), stakedOf, trials: 200, now: { time: now, libTime: now } });

test("the vault file: written once the week is final, staked players only, no prize places", async () => {
  const w = 3, dir = weekFiles(w, [[P1, 0], [P2, 0], [P3, 1]]);
  const asked = [];
  const stakedOf = async (week, who) => { asked.push([week, [...who]]); return new Set([P1, P3]); };
  // Before the 12-hour correction window ends: not final, no file.
  const early = await go(dir, L.weekStart(w + 1) + 6 * 3600000, stakedOf);
  assert.equal(early.vault, null); assert.ok(!fs.existsSync(path.join(dir, "vault", `W${w}.json`)));
  const r = await go(dir, L.weekStart(w + 1) + 13 * 3600000, stakedOf);
  assert.deepEqual(asked.at(-1), [w, [P1, P2]], "only players with points are checked (P3's node was cut)");
  const f = JSON.parse(fs.readFileSync(path.join(dir, "vault", `W${w}.json`), "utf8"));
  assert.deepEqual(f, { game: 13, week: w, final: true, rows: [{ player: P1, points: 6 }], first: [], second: [] }, "P2 isn't staked in this game; P3 has 0 points");
  assert.equal(r.vault.week, w);
  // After the Vault's 3-day window: no file is written any more.
  const late = await go(weekFiles(w, [[P1, 0]]), L.weekStart(w + 1) + 3 * L.DAY + 60000, stakedOf);
  assert.equal(late.vault, null);
});

test("no vault file while stakes can't be read (before v6), and never in testnet practice", async () => {
  const w = 3, dir = weekFiles(w, [[P1, 0]]);
  const r = await go(dir, L.weekStart(w + 1) + 13 * 3600000, async () => null);
  assert.equal(r.vault, null); assert.ok(!fs.existsSync(path.join(dir, "vault")));
  const r2 = await run({ p: "m", check: null, prev: dir, out: dir, raceDir: "", picksContract: null, practice: true, windowOf: async () => ({ from: 0, to: 0, counts: {} }), picksOf: async () => [],
    rankedOf: async (x) => new Set(x), stakedOf: async () => new Set([P1]), trials: 200, now: { time: L.weekStart(w + 1) + 13 * 3600000, libTime: L.weekStart(w + 1) + 13 * 3600000 } });
  assert.equal(r2.vault, null);
});

// The publish job's shape check accepts the recorder's vault file and refuses a bad one.
const yml = fs.readFileSync(path.resolve(APP, ".github/workflows/lastnode.yml"), "utf8");
const checkPy = yml.match(/<<'PY'\n([\s\S]*?)\n\s*PY\n/)[1].split("\n").map((l) => l.replace(/^ {10}/, "")).join("\n");
const shapeOk = (dir) => { try { execFileSync("python3", ["-c", checkPy, dir], { stdio: "pipe" }); return true; } catch { return false; } };

test("the publish check: vault files of game 13 only, with points rows and no prize places", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lns-vp-"));
  fs.mkdirSync(path.join(dir, "vault"));
  const good = { game: 13, week: 3, final: true, rows: [{ player: P1, points: 9 }, { player: P2, points: 9 }, { player: P3, points: 2 }], first: [], second: [] };
  const put = (j, name = "W3.json") => fs.writeFileSync(path.join(dir, "vault", name), JSON.stringify(j));
  put(good); assert.ok(shapeOk(dir));
  for (const [k, bad] of [["game", { ...good, game: 2 }], ["final", { ...good, final: false }], ["prize", { ...good, first: [P1] }],
    ["points 0", { ...good, rows: [{ player: P1, points: 0 }] }], ["points 256", { ...good, rows: [{ player: P1, points: 256 }] }],
    ["order", { ...good, rows: [{ player: P1, points: 2 }, { player: P2, points: 9 }] }], ["twice", { ...good, rows: [{ player: P1, points: 2 }, { player: P1, points: 2 }] }],
    ["extra", { ...good, note: "x" }], ["address", { ...good, rows: [{ player: "<b>", points: 2 }] }]]) {
    put(bad); assert.equal(shapeOk(dir), false, k);
  }
  put(good); put(good, "W4.json"); assert.equal(shapeOk(dir), false, "a file name that isn't its week");
});

test("the publish step: vault files are added, never replaced once published", () => {
  assert.match(yml, /! -path "\$IN\/lastnode\/vault"/);
  assert.match(yml, /! -regex "\$IN\/lastnode\/vault\/W\[0-9\]\[0-9\]\*\\.json"/);
  assert.match(yml, /is already published; keeping it unchanged/);
  assert.match(yml, /if \[ -n "\$parent" \] && old=\$\(git rev-parse -q --verify "\$parent:\$name" 2>\/dev\/null\); then/);
});

// Producer Bracket recorder (bot/games/bracket.ts): seeding once from the Saturday 12:00 card (never changed later,
// void without a card, none under 8 producers), picks only after the lock and only when both nodes agree, hours only
// once irreversible and matching on both nodes, missing card shares filled in later, results equal to the shared math
// run on the same blocks, final after the correction window and frozen afterwards, and the leaderboards. Offline.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const APP = process.env.APP || ".";
const { run, scoreWeek } = await import(path.resolve(APP, "bot/games/bracket.ts"));
const M = globalThis.KRaceMath, B = globalThis.KBracketMath;
const plain = (x) => JSON.parse(JSON.stringify(x));
const H = 3600000, DAY = 24 * H;
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const addr = (i) => "1" + Array.from({ length: 33 }, (_, k) => B58[(i * 7 + k * (i + 3)) % 58]).join("");
const W = 3;                                   // week 3: Mon 2 Nov 2026
const T0 = B.weekStart(W) - 4 * DAY;           // the fake chain starts the Thursday before
const H0 = 40_000_000;
const T = (h) => T0 + (h - H0) * 3000;
const hAt = (t) => H0 + Math.ceil((t - T0) / 3000);

// A field of n producers with VHP n, n−1, …; the signer of block h is drawn by VHP (deterministic per height).
function fieldOf(n) { return Array.from({ length: n }, (_, i) => ({ a: addr(i), vhp: 1000 * (n - i) })); }
function signerFn(field, offline = new Set()) {
  const live = field.filter((r) => !offline.has(r.a)), tot = live.reduce((s, r) => s + r.vhp, 0);
  return (h) => { let x = ((Math.imul(h, 2654435761) >>> 0) / 4294967296) * tot; for (const r of live) { x -= r.vhp; if (x < 0) return r.a; } return live[live.length - 1].a; };
}
function nodeOf(signer, tamper = null) {
  return (name) => ({
    async head() { throw new Error("head is given"); },
    async blockTime(h) { return T(h); },
    async blocks(from, to) {
      const ts = [], who = [];
      for (let h = from; h <= to; h++) { ts.push(T(h)); who.push(name === "check" && tamper && tamper(h) ? addr(99) : signer(h)); }
      const signers = [...new Set(who)];
      return { ts, sig: who.map((a) => signers.indexOf(a)), signers };
    },
  });
}
const headAt = (t) => ({ height: hAt(t) + 20, time: t + 60000, lib: hAt(t), libTime: T(hAt(t)) });
function raceDir(field, { skip = () => false } = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "race-"));
  const card = (at) => ({ at, c: 0, blocksPerRace: 7200, fairness: null, field: field.map((r) => ({ ...r, k: 7200 * r.vhp / field.reduce((s, x) => s + x.vhp, 0), h: 1 })), paddock: [] });
  for (const w of [W - 1, W, W + 1]) {
    const races = [];
    for (let t = M.weekStart(w); t < M.weekStart(w + 1); t += M.RACE) { const i = M.raceIndex(t); races.push({ id: M.raceId(i), start: t, end: t + M.RACE, cards: Array.from({ length: 6 }, (_, l) => (skip(t + l * H) ? null : card(t + l * H))), result: null }); }
    fs.writeFileSync(path.join(d, `W${String(w).padStart(3, "0")}.json`), JSON.stringify({ v: 1, week: w, start: M.weekStart(w), end: M.weekStart(w + 1), races }));
  }
  return d;
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "bracket-"));
const quiet = async (f) => { const log = console.log; console.log = () => {}; try { return await f(); } finally { console.log = log; } };
const readW = (dir, w = W) => JSON.parse(fs.readFileSync(path.join(dir, `W${String(w).padStart(3, "0")}.json`), "utf8"));
const P = (i) => addr(50 + i);
function picksOf(rows, tamper = false) { return async (node) => rows.map((r, i) => ({ ...r, number: node === "check" && tamper && i === 0 ? r.number + 1 : r.number })); }

/** Run the recorder repeatedly at time t (carrying files forward) until nothing more gets recorded. */
async function runUntil(t, o, dir, times = 12) {
  let last;
  for (let i = 0; i < times; i++) last = await quiet(() => run({ p: "main", check: "check", prev: dir, out: dir, head: headAt(t), ...o }));
  return last;
}

test("seeding: from the Saturday 12:00 card, recorded once with a hash, never changed by later cards", async () => {
  const field = fieldOf(17), dir = tmp(), race = raceDir(field);
  const o = { raceDir: race, picksContract: "1P", nodeOf: nodeOf(signerFn(field)), picksOf: picksOf([]) };
  await quiet(() => run({ p: "main", check: "check", prev: dir, out: dir, head: headAt(B.seedTime(W) - H), ...o }));
  assert.ok(!fs.existsSync(path.join(dir, "W003.json")), "nothing before the seeding time");
  await quiet(() => run({ p: "main", check: "check", prev: dir, out: dir, head: headAt(B.seedTime(W) + 40 * 60000), ...o }));
  const wf = readW(dir);
  assert.equal(wf.status, "open"); assert.equal(wf.seeding.size, 16); assert.equal(wf.seeding.seeds.length, 16);
  assert.deepEqual(wf.seeding.seeds, field.slice(0, 16).map((r) => r.a)); assert.deepEqual(wf.seeding.out, [field[16].a]);
  assert.match(wf.seeding.hash, /^[0-9a-f]{64}$/); assert.equal(wf.days.length, 4);
  // a later run with a different field keeps the published seeding
  const other = raceDir(fieldOf(40));
  await quiet(() => run({ p: "main", check: "check", prev: dir, out: dir, head: headAt(B.seedTime(W) + 3 * H), ...o, raceDir: other }));
  assert.deepEqual(readW(dir).seeding, wf.seeding);
  // a tampered seeding in the last run's files is not trusted (its hash no longer matches)
  const bad = readW(dir); bad.seeding.seeds[0] = addr(77); fs.writeFileSync(path.join(dir, "W003.json"), JSON.stringify(bad));
  await quiet(() => run({ p: "main", check: "check", prev: dir, out: dir, head: headAt(B.seedTime(W) + 4 * H), ...o, raceDir: other }));
  assert.equal(readW(dir).seeding.size, 32, "re-seeded from the card, not the tampered file");
});

test("seeding: no card waits and turns void after 6 hours; under 8 producers is no bracket; 40 is a 32-bracket", async () => {
  const field = fieldOf(17), dir = tmp(), race = raceDir(field, { skip: (t) => t >= B.seedTime(W) - 6 * H && t < B.seedTime(W) + 12 * H });
  const o = { raceDir: race, picksContract: "1P", nodeOf: nodeOf(signerFn(field)), picksOf: picksOf([]) };
  const r1 = await quiet(() => run({ p: "main", check: "check", prev: dir, out: dir, head: headAt(B.seedTime(W) + H), ...o }));
  assert.ok(r1.problems.some((p) => p.includes("no race card yet")));
  await quiet(() => run({ p: "main", check: "check", prev: dir, out: dir, head: headAt(B.seedTime(W) + 7 * H), ...o }));
  assert.equal(readW(dir).status, "void");
  const d7 = tmp(); await quiet(() => run({ p: "main", check: "check", prev: d7, out: d7, head: headAt(B.seedTime(W) + H), ...o, raceDir: raceDir(fieldOf(7)) }));
  assert.equal(readW(d7).status, "none"); assert.match(readW(d7).void, /8 needed/);
  const d40 = tmp(); await quiet(() => run({ p: "main", check: "check", prev: d40, out: d40, head: headAt(B.seedTime(W) + H), ...o, raceDir: raceDir(fieldOf(40)) }));
  const w40 = readW(d40); assert.equal(w40.seeding.size, 32); assert.equal(w40.days.length, 5, "Monday to Friday");
  const d13 = tmp(); await quiet(() => run({ p: "main", check: "check", prev: d13, out: d13, head: headAt(B.seedTime(W) + H), ...o, raceDir: raceDir(fieldOf(13)) }));
  assert.equal(readW(d13).seeding.size, 16); assert.equal(readW(d13).seeding.seeds.length, 13);
});

test("picks: only after the lock is irreversible, only when both nodes agree; bad numbers kept but marked invalid", async () => {
  const field = fieldOf(17), race = raceDir(field);
  const rows = [{ player: P(1), number: 0, time: 1 }, { player: P(2), number: 2 ** 15 - 1, time: 2 }, { player: P(3), number: 2 ** 20, time: 3 }];
  const base = { raceDir: race, picksContract: "1P", nodeOf: nodeOf(signerFn(field)) };
  const dir = tmp();
  await quiet(() => run({ p: "main", check: "check", prev: dir, out: dir, head: headAt(B.seedTime(W) + H), ...base, picksOf: picksOf(rows) }));
  // the head is past the lock but the irreversible block isn't yet
  const h = { ...headAt(B.lockTime(W) - 60000), time: B.lockTime(W) + 120000 };
  await quiet(() => run({ p: "main", check: "check", prev: dir, out: dir, head: h, ...base, picksOf: picksOf(rows) }));
  assert.equal(readW(dir).picks, null);
  const r = await quiet(() => run({ p: "main", check: "check", prev: dir, out: dir, head: headAt(B.lockTime(W) + 60000), ...base, picksOf: picksOf(rows, true) }));
  assert.ok(r.problems.some((p) => p.includes("disagree about the picks"))); assert.equal(readW(dir).picks, null);
  await quiet(() => run({ p: "main", check: "check", prev: dir, out: dir, head: headAt(B.lockTime(W) + 60000), ...base, picksOf: picksOf(rows) }));
  const wf = readW(dir);
  assert.equal(wf.status, "locked"); assert.equal(wf.picks.checked, 2);
  assert.deepEqual(wf.picks.rows.map((x) => [x[0], x[3]]), [[P(1), 1], [P(2), 1], [P(3), 0]]);
});

test("a whole week: hours irreversible only, results equal the shared math on the same blocks, final after 12 hours, then frozen", async () => {
  const field = fieldOf(17), offline = new Set([field[0].a]);   // seed 1 is offline all week: it loses round 1
  const signer = signerFn(field, offline), race = raceDir(field), dir = tmp();
  // perfect bracket computed straight from the blocks with bracket-math
  const seeds = field.slice(0, 16).map((r) => r.a);
  const days = [0, 1, 2, 3].map((r) => {
    const d = B.roundDay(W, r), from = hAt(d), to = hAt(d + DAY) - 1, ts = [], who = [];
    for (let h = from; h <= to; h++) { ts.push(T(h)); who.push(signer(h)); }
    const signers = [...new Set(who)], card = { field };
    return B.dayIndex({ ts, sig: who.map((a) => signers.indexOf(a)), signers }, d, Array(24).fill(card));
  });
  const truth = B.results(seeds, 16, days);
  const perfect = B.encode(truth.rounds, 16, 16);
  const rows = [{ player: P(1), number: perfect, time: 1 }, { player: P(2), number: 0, time: 2 }];
  const o = { raceDir: race, picksContract: "1P", nodeOf: nodeOf(signer), picksOf: picksOf(rows) };
  await quiet(() => run({ p: "main", check: "check", prev: dir, out: dir, head: headAt(B.seedTime(W) + H), ...o }));
  await quiet(() => run({ p: "main", check: "check", prev: dir, out: dir, head: headAt(B.lockTime(W) + 60000), ...o }));
  // Tuesday 10:30: Monday done, Tuesday hours up to 10:00 recorded, nothing later
  await runUntil(B.roundDay(W, 1) + 10.5 * H, o, dir);
  let wf = readW(dir);
  assert.ok(wf.days[0].every(Boolean)); assert.equal(wf.days[1].filter(Boolean).length, 10); assert.ok(wf.days[2].every((x) => x === null));
  assert.ok(wf.days[0].every((x) => x.checked === 2 && x.share));
  assert.equal(wf.results.rounds.length, 1); assert.deepEqual(wf.results.rounds[0], truth.rounds[0]);
  assert.ok(!wf.results.rounds[0].includes(1), "offline seed 1 is out");
  assert.equal(wf.points.find((p) => p[0] === P(1))[1], 8, "8 right in round 1 so far");
  // heights recorded per hour are contiguous
  for (let h = 1; h < 24; h++) assert.equal(wf.days[0][h].from, wf.days[0][h - 1].to + 1);
  // Friday 06:00: all rounds in, not final yet (correction window until Friday 12:00)
  await runUntil(B.roundDay(W, 4) + 6 * H, o, dir);
  wf = readW(dir);
  assert.equal(wf.status, "locked"); assert.equal(wf.results.done, true); assert.deepEqual(wf.results.rounds, plain(truth.rounds));
  assert.deepEqual(wf.points.find((p) => p[0] === P(1)), [P(1), 34, 1, 15], "perfect bracket: 34 points, champion, 15 right");
  assert.equal(wf.points.find((p) => p[0] === P(2))[2], 0, "chalk picked seed 1 as champion");
  await quiet(() => run({ p: "main", check: "check", prev: dir, out: dir, head: headAt(B.roundDay(W, 4) + 12.5 * H), ...o }));
  wf = readW(dir); assert.equal(wf.status, "final");
  // after final, a different chain changes nothing
  const before = JSON.stringify(wf);
  await quiet(() => run({ p: "main", check: "check", prev: dir, out: dir, head: headAt(B.roundDay(W, 5) + H), ...o, nodeOf: nodeOf(signerFn(field)) }));
  assert.equal(JSON.stringify(readW(dir)), before);
  // scoreWeek on the file gives the same points (the page can check it)
  assert.deepEqual(plain(scoreWeek(wf).points), wf.points);
  // board: last week shows the final week; all time counts final weeks only
  const r = await quiet(() => run({ p: "main", check: "check", prev: dir, out: dir, head: headAt(B.weekStart(W + 1) + 2 * H), ...o }));
  assert.equal(r.board.lastWeek.week, W); assert.equal(r.board.lastWeek.final, true);
  assert.equal(r.board.lastWeek.rows[0].a, P(1)); assert.equal(r.board.lastWeek.rows[0].place, 1);
  assert.equal(r.board.allTime.rows[0].pts, 34);
});

test("hours: the two nodes must agree; a missing card share is filled in once the card arrives", async () => {
  const field = fieldOf(17), signer = signerFn(field), dir = tmp();
  const noCardMonday = (t) => t >= B.roundDay(W, 0) && t < B.roundDay(W, 0) + 6 * H;   // the whole first race
  const o = { raceDir: raceDir(field, { skip: noCardMonday }), picksContract: "1P", nodeOf: nodeOf(signer), picksOf: picksOf([]) };
  await quiet(() => run({ p: "main", check: "check", prev: dir, out: dir, head: headAt(B.seedTime(W) + H), ...o }));
  await quiet(() => run({ p: "main", check: "check", prev: dir, out: dir, head: headAt(B.lockTime(W) + 60000), ...o }));
  const badH = hAt(B.roundDay(W, 0) + 5 * H + 1000);
  const r = await quiet(() => run({ p: "main", check: "check", prev: dir, out: dir, head: headAt(B.roundDay(W, 0) + 8 * H), ...o, nodeOf: nodeOf(signer, (h) => h === badH) }));
  assert.ok(r.problems.some((p) => p.includes("hour 5") && p.includes("disagree")));
  let wf = readW(dir);
  assert.equal(wf.days[0][5], null); assert.ok(wf.days[0][4]);
  assert.equal(wf.days[0][0].share, null, "no card yet for 00:00");
  // the card for those hours turns up later
  await quiet(() => run({ p: "main", check: "check", prev: dir, out: dir, head: headAt(B.roundDay(W, 0) + 9 * H), ...o, raceDir: raceDir(field) }));
  wf = readW(dir);
  assert.ok(wf.days[0][0].share && wf.days[0][5], "filled in, and hour 5 recorded once the nodes agree");
});

test("files: only the expected names, sizes and fields", async () => {
  const field = fieldOf(17), dir = tmp();
  await quiet(() => run({ p: "main", check: null, prev: dir, out: dir, head: headAt(B.seedTime(W) + H), raceDir: raceDir(field), picksContract: null, nodeOf: nodeOf(signerFn(field)) }));
  const names = fs.readdirSync(dir).sort();
  assert.ok(names.includes("W003.json") && names.includes("board.json") && names.includes("index.json"));
  assert.ok(names.every((f) => /^(index|board|W\d{3})\.json$/.test(f)), names.join());
  const idx = JSON.parse(fs.readFileSync(path.join(dir, "index.json"), "utf8"));
  assert.deepEqual(Object.keys(idx).sort(), ["contract", "game", "updated", "v", "weeks"]); assert.equal(idx.game, B.GAME_ID);
  const wf = readW(dir);
  assert.deepEqual(Object.keys(wf).sort(), ["days", "end", "picks", "points", "results", "seeding", "start", "status", "v", "week"]);
  assert.ok(fs.statSync(path.join(dir, "W003.json")).size < 200000);
});

// ── the publish job's shape check (.github/workflows/games.yml) accepts the recorder's files and refuses bad ones ──
import { execFileSync } from "node:child_process";
const yml = fs.readFileSync(path.resolve(APP, ".github/workflows/games.yml"), "utf8");
const pys = [...yml.matchAll(/<<'PY'\n([\s\S]*?)\n\s*PY\n/g)].map((m) => m[1].split("\n").map((l) => l.replace(/^ {10}/, "")).join("\n"));
const bracketPy = pys.find((p) => p.includes("bracket files ok"));
const shapeOk = (dir) => { try { execFileSync("python3", ["-c", bracketPy, dir], { stdio: "pipe" }); return true; } catch { return false; } };

test("workflow: records the bracket with the same prev/out/race folders and publishes only its own files", () => {
  assert.ok(bracketPy, "a bracket shape check in the publish job");
  assert.match(yml, /run: npm run bracket\n\s+env:\n\s+RPC: .*\n\s+RPC_CHECK: .*\n\s+BRACKET_PREV: \$\{\{ runner\.temp \}\}\/prev\/bracket\n\s+BRACKET_OUT: \$\{\{ runner\.temp \}\}\/games-data\/bracket\n\s+RACE_DATA: \$\{\{ runner\.temp \}\}\/race/);
  assert.match(yml, /for g in blockx bracket; do/);
  assert.doesNotMatch(yml.split("publish:")[1], /npm |npx |tsx /, "the publish job runs no repository code");
});

test("workflow shape check: accepts a whole recorded week, refuses tampered files", async () => {
  const field = fieldOf(17), signer = signerFn(field), race = raceDir(field), dir = tmp();
  const o = { raceDir: race, picksContract: addr(60), nodeOf: nodeOf(signer), picksOf: picksOf([{ player: P(1), number: 5, time: 1 }, { player: P(2), number: 2 ** 20, time: 2 }]) };
  await quiet(() => run({ p: "main", check: "check", prev: dir, out: dir, head: headAt(B.seedTime(W) + H), ...o }));
  await quiet(() => run({ p: "main", check: "check", prev: dir, out: dir, head: headAt(B.lockTime(W) + 60000), ...o }));
  await runUntil(B.roundDay(W, 4) + 13 * H, o, dir);
  assert.equal(readW(dir).status, "final");
  assert.ok(shapeOk(dir), "the recorder's own files pass");
  const bad = (f, mut) => { const d = tmp(); for (const x of fs.readdirSync(dir)) fs.copyFileSync(path.join(dir, x), path.join(d, x)); const j = JSON.parse(fs.readFileSync(path.join(d, f), "utf8")); mut(j); fs.writeFileSync(path.join(d, f), JSON.stringify(j)); return shapeOk(d); };
  assert.equal(bad("W003.json", (j) => { j.points[0][1] = 999; }), false, "points over the maximum");
  assert.equal(bad("W003.json", (j) => { j.seeding.seeds.push("<script>"); }), false, "a non-address");
  assert.equal(bad("W003.json", (j) => { j.extra = 1; }), false, "an unknown field");
  assert.equal(bad("W003.json", (j) => { j.days[0][0].by["1x"] = 1; }), false);
  assert.equal(bad("board.json", (j) => { j.week.rows.push({ a: P(1), place: 1, pts: 1, champion: "yes", correct: 1, ranked: true }); }), false);
  assert.equal(bad("index.json", (j) => { j.game = 2; }), false, "the bracket's own game id");
});

// Block Golf recorder (bot/games/golf.ts): the course from games.json, each hole from that game's own published
// results, the question game (answers and who is ranked) read on two nodes, kept standings when a game's files move
// on, final holes that stay final, the 12-hour wait, the 60-hour deadline, frozen final weeks, a broken history that
// stops the run, practice weeks and the leaderboards. Offline: fake result files and a fake question game.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const APP = process.env.APP || ".";
const { run, sourcesFromGames } = await import(path.resolve(APP, "bot/games/golf.ts"));
const M = globalThis.KRaceMath;
const H = 3600000, DAY = 24 * H;

const P = Array.from({ length: 12 }, (_, i) => "1" + "ABCDEFGHJKLMNPQRSTUVWXYZ"[i].repeat(33));
const FREE = "1" + "a".repeat(33);
const W = 3, START = M.weekStart(W), END = M.weekStart(W + 1);
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const write = (dir, name, j) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, name), JSON.stringify(j)); };
const SOURCES = [
  { id: "questions", name: "Daily Questions", reader: "questions", live: true },
  { id: "race", name: "Producer Race", reader: "race", live: true },
  { id: "blockx", name: "Who Signs Block X", reader: "blockx", live: true },
];

/** Race files for week W: board with this week's rows (P0 best … P9) and races final or not. */
function raceDir({ week = W, final = true, rows = null } = {}) {
  const d = tmp("race-");
  const r = rows ?? P.slice(0, 10).map((a, i) => ({ a, pts: 30 - 3 * i, correct: 10 - i, shows: 0, picks: 20, answers: 0, points: 0, ranked: true }));
  r.push({ a: FREE, pts: 100, correct: 30, shows: 0, picks: 30, answers: 0, points: 0, ranked: false });
  write(d, "board.json", { v: 1, updated: "", today: { rows: [] }, week: { week, start: M.weekStart(week), rows: r }, lastWeek: null, allTime: { rows: [] } });
  const races = [];
  for (let t = M.weekStart(week); t < M.weekStart(week + 1); t += M.RACE) races.push({ id: "x", start: t, end: t + M.RACE, cards: [], result: { final } });
  write(d, `W00${week}.json`, { v: 1, week, start: M.weekStart(week), end: M.weekStart(week + 1), races });
  return d;
}
/** games-data: Block X board for week W as its "lastWeek" (final or not) or "week". */
function gamesDir({ last = false, final = false, rows = null } = {}) {
  const d = tmp("games-");
  const r = rows ?? P.slice(0, 8).map((a, i) => ({ a, place: i + 1, pts: 800 - 100 * i, correct: 8 - i, picks: 10, days: 3, lastCorrect: 0, ranked: true }));
  const view = { week: W, start: START, rows: r, ...(last ? { final, prizes: [] } : {}) };
  write(path.join(d, "blockx"), "board.json", { v: 1, updated: "", today: { rows: [] }, week: last ? { week: W + 1, start: END, rows: [] } : view, lastWeek: last ? view : null, allTime: { rows: [] } });
  return d;
}
const qWeek = ({ closed = true, resolved = 30 } = {}) => ({ closed, questions: 30, resolved, rows: P.slice(2, 9).map((a, i) => ({ a, pts: 20 - 2 * i, answered: 25 })).sort((x, y) => (x.a < y.a ? -1 : 1)) });
const ranked = async (_node, who) => new Set(who.filter((a) => a !== FREE));
/** A previous run's index, so the course already holds the three games from week W (as after a first run in W). */
function seeded() { const d = tmp("golf-prev-"); write(d, "index.json", { v: 1, updated: "", weeks: [], course: { questions: W, race: W, blockx: W }, stakedFromWeek: 0 }); return d; }
// Staked rules (ranked field, 5 per hole) unless a test says otherwise; practice weeks have their own test.
const stakers = async (_node, who) => new Set(who.filter((a) => a !== FREE));   // everyone but FREE staked in Block Golf
const base = (o) => ({ sources: SOURCES, questionsOf: async () => qWeek(), rankedOf: ranked, golfStakersOf: stakers, p: "main", check: "check", stakedFromWeek: 0, ...(o.prev === undefined && !o.fresh ? { prev: seeded() } : {}), ...o });
const readOut = (dir, name) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
const holeOf = (dir, id, w = 3) => readOut(dir, `W00${w}.json`).holes.find((h) => h.id === id);
const FINAL_GAMES = () => gamesDir({ last: true, final: true });

test("mid-week, first run: every live game joins at once; live holes and scorecards", async () => {
  const out = tmp("golf-");
  const r = await run(base({ fresh: true, now: START + 3 * DAY, out, raceDir: raceDir(), gamesDir: gamesDir() }));
  const wf = readOut(out, "W003.json");
  assert.deepEqual(wf.holes.map((h) => [h.id, h.status]), [["questions", "live"], ["race", "live"], ["blockx", "live"]]);
  assert.equal(wf.final, false);
  assert.equal(wf.practice, false);
  const p0 = wf.cards.find((c) => c.a === P[0]);
  assert.equal(p0.holes.find((x) => x[0] === "questions")[1], 7, "didn't play the question game: lost ball");
  assert.notEqual(p0.mulligan, "questions", "a lost ball is never the mulligan");
  // The free race wallet (100 pts, unranked) beats the ranked field: hole in one, but it isn't in the field
  const free = wf.cards.find((c) => c.a === FREE);
  assert.equal(free.holes.find((x) => x[0] === "race")[1], 1);
  assert.equal(free.ranked, false);
  assert.deepEqual(readOut(out, "index.json").course, { questions: W, race: W, blockx: W });
  const board = readOut(out, "board.json");
  assert.equal(board.week.week, W);
  assert.equal(board.week.rows.length, wf.cards.length);
  assert.deepEqual(board.allTime.rows, [], "all time counts final weeks only");
  assert.deepEqual(Object.keys(board.week.rows[0]).sort(), ["a", "holes", "lost", "place", "pts", "ranked", "strokes", "topar"]);
  assert.equal(r.problems.length, 0);
});

test("a game that goes live later joins from the next Monday; one that leaves keeps its joining week", async () => {
  const prev = tmp("golf-");
  await run(base({ fresh: true, now: START + DAY, out: prev, raceDir: raceDir(), gamesDir: gamesDir(), sources: SOURCES.map((s) => ({ ...s, live: s.id !== "blockx" })) }));
  const out = tmp("golf-");
  await run(base({ now: START + 2 * DAY, prev, out, raceDir: raceDir(), gamesDir: gamesDir() }));
  assert.deepEqual(readOut(out, "index.json").course, { questions: W, race: W, blockx: W + 1 });
  assert.deepEqual(readOut(out, "W003.json").holes.map((h) => h.id), ["questions", "race"]);
  // The race leaves games.json for a run (audit M2): it stays on this week's card and keeps its joining week
  const out2 = tmp("golf-");
  await run(base({ now: START + 3 * DAY, prev: out, out: out2, raceDir: raceDir(), gamesDir: gamesDir(), sources: SOURCES.map((s) => ({ ...s, live: s.id !== "race" })) }));
  assert.deepEqual(readOut(out2, "W003.json").holes.map((h) => h.id), ["questions", "race"]);
  assert.equal(readOut(out2, "index.json").course.race, W);
});

test("final 12 hours after the week ends when every hole is final; then frozen", async () => {
  const prev = tmp("golf-");
  await run(base({ now: START + 2 * DAY, out: prev, raceDir: raceDir(), gamesDir: gamesDir() }));
  const out = tmp("golf-");
  await run(base({ now: END + 11 * H, prev, out, raceDir: raceDir(), gamesDir: FINAL_GAMES() }));
  assert.equal(readOut(out, "W003.json").final, false, "still inside the correction window");
  const out2 = tmp("golf-");
  await run(base({ now: END + 13 * H, prev: out, out: out2, raceDir: raceDir(), gamesDir: FINAL_GAMES() }));
  const wf = readOut(out2, "W003.json");
  assert.equal(wf.final, true);
  assert.ok(wf.holes.every((h) => h.status === "final"));
  const board = readOut(out2, "board.json");
  assert.equal(board.lastWeek.final, true);
  assert.ok(board.allTime.rows.length > 0);
  const out3 = tmp("golf-");
  await run(base({ now: END + 30 * H, prev: out2, out: out3, raceDir: raceDir({ rows: [] }), gamesDir: gamesDir({ last: true, final: true, rows: [] }), questionsOf: async () => ({ ...qWeek(), rows: [] }) }));
  assert.deepEqual(readOut(out3, "W003.json"), wf, "a final week never changes");
});

test("a hole that was final stays final, even if a later run can't read it (audit H2)", async () => {
  const prev = tmp("golf-");
  // 13 h after: Block X and questions final, the race still waiting on a race
  await run(base({ now: END + 13 * H, out: prev, raceDir: raceDir({ final: false }), gamesDir: FINAL_GAMES() }));
  assert.equal(holeOf(prev, "blockx").status, "final");
  assert.equal(readOut(prev, "W003.json").final, false);
  // 61 h after: the games-data files couldn't be read this run and the question game fails
  const out = tmp("golf-");
  const r = await run(base({ now: END + 61 * H, prev, out, raceDir: raceDir({ final: false }), gamesDir: tmp("empty-"), questionsOf: async () => { throw new Error("node down"); } }));
  assert.equal(holeOf(out, "blockx").status, "final", "kept");
  assert.equal(holeOf(out, "questions").status, "final", "kept");
  assert.equal(holeOf(out, "race").status, "final", "the race board's standings are used at the deadline (audit H3)");
  // Every hole is final (two kept, the race by the deadline rule) and nothing needed the failing reads: final, and full
  assert.equal(readOut(out, "W003.json").final, true);
  assert.ok(r.problems.every((p) => !/week 3/.test(p)), "the kept holes weren't read again (only this week's question read failed)");
  assert.ok(readOut(out, "W003.json").cards.every((c) => c.holes.length === 3));
});

test("the question game: nodes that disagree on answers or on who is ranked, an unfinished week, the scoring", async () => {
  const out = tmp("golf-");
  await run(base({ now: END + 20 * H, out, raceDir: raceDir(), gamesDir: FINAL_GAMES(),
    questionsOf: async (node) => (node === "check" ? { ...qWeek(), rows: qWeek().rows.slice(1) } : qWeek()) }));
  assert.match(holeOf(out, "questions").why, /don't agree/);
  assert.equal(readOut(out, "W003.json").final, false);
  const out1 = tmp("golf-");
  await run(base({ stakedFromWeek: null, now: END + 20 * H, out: out1, raceDir: raceDir(), gamesDir: FINAL_GAMES(),
    rankedOf: async (node, who) => new Set(node === "check" ? who.slice(1) : who) }));   // ranked is read in practice weeks
  assert.match(holeOf(out1, "questions").why, /who is ranked/, "audit M1");
  const out2 = tmp("golf-");
  await run(base({ now: END + 20 * H, out: out2, raceDir: raceDir(), gamesDir: FINAL_GAMES(), questionsOf: async () => qWeek({ resolved: 29 }) }));
  assert.equal(holeOf(out2, "questions").status, "live", "a question still unresolved");
  const out3 = tmp("golf-");
  await run(base({ now: END + 20 * H, out: out3, raceDir: raceDir(), gamesDir: FINAL_GAMES() }));
  assert.equal(holeOf(out3, "questions").status, "final");
  assert.equal(holeOf(out3, "questions").field, 7);
  assert.equal(readOut(out3, "W003.json").cards.find((x) => x.a === P[2]).holes.find((x) => x[0] === "questions")[1], 1);
});

test("a ranked read that fails keeps the hole waiting instead of dropping players", async () => {
  const out = tmp("golf-");
  const r = await run(base({ stakedFromWeek: null, now: END + 20 * H, out, raceDir: raceDir(), gamesDir: FINAL_GAMES(), rankedOf: async () => { throw new Error("rpc"); } }));
  assert.equal(holeOf(out, "questions").status, "live");
  assert.match(r.problems.join(" "), /rpc/);
});

test("a question game that can't be read is skipped at the 60-hour deadline, never guessed", async () => {
  const failing = async () => { throw new Error("node down"); };
  const out = tmp("golf-");
  await run(base({ now: END + 59 * H, out, raceDir: raceDir(), gamesDir: FINAL_GAMES(), questionsOf: failing }));
  assert.equal(holeOf(out, "questions").status, "live");
  const out2 = tmp("golf-");
  await run(base({ now: END + 61 * H, prev: out, out: out2, raceDir: raceDir(), gamesDir: FINAL_GAMES(), questionsOf: failing }));
  assert.equal(holeOf(out2, "questions").status, "skipped");
  assert.match(holeOf(out2, "questions").why, /weren't final in time/);
  assert.equal(readOut(out2, "W003.json").final, false, "not final in a run that had a read problem");
  const out3 = tmp("golf-");
  await run(base({ now: END + 62 * H, prev: out2, out: out3, raceDir: raceDir(), gamesDir: FINAL_GAMES(), questionsOf: failing }));
  const wf = readOut(out3, "W003.json");
  assert.equal(wf.final, false, "still a read problem");
  // A later run that can read it again (the week isn't final yet) scores the hole after all
  const out4 = tmp("golf-");
  await run(base({ now: END + 63 * H, prev: out3, out: out4, raceDir: raceDir(), gamesDir: FINAL_GAMES() }));
  assert.equal(holeOf(out4, "questions").status, "final");
  assert.equal(readOut(out4, "W003.json").final, true);
});

test("a game's board that moved on: the standings kept from the last run are used", async () => {
  const prev = tmp("golf-");
  await run(base({ now: END - H, out: prev, raceDir: raceDir(), gamesDir: gamesDir() }));
  const rd = raceDir();
  const b = JSON.parse(fs.readFileSync(path.join(rd, "board.json"), "utf8"));
  b.week.week = W + 1;
  fs.writeFileSync(path.join(rd, "board.json"), JSON.stringify(b));
  const out = tmp("golf-");
  await run(base({ now: END + 13 * H, prev, out, raceDir: rd, gamesDir: FINAL_GAMES() }));
  assert.equal(holeOf(out, "race").status, "final");
  assert.equal(holeOf(out, "race").rows.length, 11);
  // never read before it moved on: skipped, not guessed
  const out2 = tmp("golf-");
  await run(base({ now: END + 13 * H, out: out2, raceDir: rd, gamesDir: FINAL_GAMES() }));
  assert.equal(holeOf(out2, "race").status, "skipped");
});

test("a hole needs 5 ranked players who scored; a player who scored nothing gets a double bogey", async () => {
  const out = tmp("golf-");
  const four = P.slice(0, 4).map((a, i) => ({ a, place: i + 1, pts: 10 - i, correct: 1, picks: 1, days: 1, lastCorrect: 0, ranked: true }));
  const zeros = P.slice(4, 12).map((a) => ({ a, place: 5, pts: 0, correct: 0, picks: 3, days: 1, lastCorrect: 0, ranked: true }));
  await run(base({ now: END + 13 * H, out, raceDir: raceDir(), gamesDir: gamesDir({ last: true, final: true, rows: [...four, ...zeros] }) }));
  const bx = holeOf(out, "blockx");
  assert.equal(bx.status, "skipped", "8 idle wallets don't make up the field (audit H5)");
  assert.match(bx.why, /fewer than 5 ranked players scored/);
  const out2 = tmp("golf-");
  const five = P.slice(0, 5).map((a, i) => ({ a, place: i + 1, pts: 10 - i, correct: 1, picks: 1, days: 1, lastCorrect: 0, ranked: true }));
  await run(base({ now: END + 13 * H, out: out2, raceDir: raceDir(), gamesDir: gamesDir({ last: true, final: true, rows: [...five, ...zeros.slice(1)] }) }));
  const wf = readOut(out2, "W003.json");
  assert.equal(holeOf(out2, "blockx").field, 5);
  assert.equal(wf.cards.find((c) => c.a === P[6]).holes.find((x) => x[0] === "blockx")[1], 6);
  assert.equal(wf.cards.find((c) => c.a === P[4]).holes.find((x) => x[0] === "blockx")[1], 6, "5th of 5");
});

test("practice weeks (before the first staked week): every player who scored counts and 3 make a hole", async () => {
  const few = [P[0], P[1], FREE].map((a, i) => ({ a, place: i + 1, pts: 30 - 10 * i, correct: 1, picks: 1, days: 1, lastCorrect: 0, ranked: a !== FREE }));
  const out = tmp("golf-");
  await run(base({ stakedFromWeek: null, now: END + 13 * H, out, raceDir: raceDir(), gamesDir: gamesDir({ last: true, final: true, rows: few }) }));
  const wf = readOut(out, "W003.json");
  assert.equal(wf.practice, true);
  assert.equal(holeOf(out, "blockx").status, "final");
  assert.equal(holeOf(out, "blockx").field, 3, "the free wallet is in the practice field");
  assert.equal(readOut(out, "index.json").stakedFromWeek, null);
  const r = wf.cards.find((c) => c.a === P[0]).holes.find((x) => x[0] === "race");
  assert.deepEqual([r[2], r[3]], [2, 11], "the free race wallet counts in practice");
  const out2 = tmp("golf-");
  await run(base({ stakedFromWeek: W, now: END + 13 * H, out: out2, raceDir: raceDir(), gamesDir: gamesDir({ last: true, final: true, rows: few }) }));
  assert.equal(readOut(out2, "W003.json").practice, false);
  assert.equal(holeOf(out2, "blockx").status, "skipped");
  const out3 = tmp("golf-");
  await run(base({ stakedFromWeek: null, now: END + 13 * H, out: out3, raceDir: raceDir(), gamesDir: gamesDir({ last: true, final: true, rows: few.slice(0, 2) }) }));
  assert.match(holeOf(out3, "blockx").why, /fewer than 3 players scored/);
});

test("a history that exists but can't be read stops the run instead of starting over (audit H1)", async () => {
  const prev = tmp("golf-");
  await run(base({ now: END + 13 * H, out: prev, raceDir: raceDir(), gamesDir: FINAL_GAMES() }));
  fs.writeFileSync(path.join(prev, "index.json"), "{not json");
  await assert.rejects(run(base({ now: END + 14 * H, prev, out: tmp("golf-"), raceDir: raceDir(), gamesDir: FINAL_GAMES() })), /can't be read/);
  const prev2 = tmp("golf-");
  await run(base({ now: END + 13 * H, out: prev2, raceDir: raceDir(), gamesDir: FINAL_GAMES() }));
  fs.rmSync(path.join(prev2, "W003.json"));
  await assert.rejects(run(base({ now: END + 14 * H, prev: prev2, out: tmp("golf-"), raceDir: raceDir(), gamesDir: FINAL_GAMES() })), /can't be read/);
});

test("files that are links are ignored", async () => {
  const gd = gamesDir();
  const evil = tmp("evil-");
  write(evil, "board.json", { v: 1, week: { week: W, rows: [{ a: P[0], pts: 999, ranked: true }] } });
  fs.rmSync(path.join(gd, "blockx", "board.json"));
  fs.symlinkSync(path.join(evil, "board.json"), path.join(gd, "blockx", "board.json"));
  const out = tmp("golf-");
  await run(base({ now: START + DAY, out, raceDir: raceDir(), gamesDir: gd }));
  assert.equal(holeOf(out, "blockx").rows.length, 0);
});

test("games.json: games with a reader become sources, with their live flag; Block Golf itself never does", () => {
  const d = tmp("gj-");
  const f = path.join(d, "games.json");
  fs.writeFileSync(f, JSON.stringify({ v: 1, games: [
    { id: "race", name: "Producer Race", status: "live" }, { id: "questions", name: "Daily Questions", status: "live" },
    { id: "blockx", name: "Who Signs Block X", status: "soon" }, { id: "golf", name: "Block Golf", status: "live" },
    { id: "mystery", name: "?", status: "live" } ] }));
  assert.deepEqual(sourcesFromGames(f).map((s) => [s.id, s.live]), [["race", true], ["questions", true], ["blockx", false]]);
  assert.ok(sourcesFromGames(path.join(APP, "site/games.json")).every((s) => s.id !== "golf"));
});

test("a whole week: points add up and places are consistent", async () => {
  const out = tmp("golf-");
  await run(base({ now: END + 13 * H, out, raceDir: raceDir(), gamesDir: FINAL_GAMES() }));
  const wf = readOut(out, "W003.json");
  for (const c of wf.cards) {
    assert.equal(c.holes.length, 3);
    const counted = c.holes.filter((x) => x[0] !== c.mulligan);
    assert.equal(c.strokes, counted.reduce((s, x) => s + x[1], 0));
    assert.equal(c.par, 8);
    assert.equal(c.pts, 14 - c.strokes);
  }
  for (let i = 1; i < wf.cards.length; i++) assert.ok(wf.cards[i].pts <= wf.cards[i - 1].pts);
});

/** The publish job's two checks, taken from the workflow file (shape, then history). */
function checks() {
  const y = fs.readFileSync(path.join(APP, ".github/workflows/golf.yml"), "utf8");
  return [...y.matchAll(/<<'PY'\n([\s\S]*?)\n\s*PY\n/g)].map((m) => {
    const f = path.join(tmp("chk-"), "check.py");
    fs.writeFileSync(f, m[1].split("\n").map((l) => l.replace(/^ {10}/, "")).join("\n"));
    return f;
  });
}
const copyDir = (from) => { const d = tmp("copy-"); fs.cpSync(from, d, { recursive: true }); return d; };

test("the publish job's shape check accepts the recorder's files and refuses tampered ones", async (t) => {
  try { execFileSync("python3", ["--version"]); } catch { t.skip("no python3 here"); return; }
  const [shape] = checks();
  const out = tmp("golf-");
  await run(base({ now: END + 13 * H, out, raceDir: raceDir(), gamesDir: FINAL_GAMES() }));
  await run(base({ now: END + 2 * DAY, prev: out, out, raceDir: raceDir({ week: W + 1 }), gamesDir: gamesDir() }));
  assert.match(execFileSync("python3", [shape, out], { encoding: "utf8" }), /golf files ok/);
  const bad = copyDir(out);
  const wf = readOut(bad, "W003.json"); wf.cards[0].holes[0][1] = 8; write(bad, "W003.json", wf);
  assert.throws(() => execFileSync("python3", [shape, bad], { stdio: "pipe" }), "8 strokes");
  const bad2 = copyDir(out);
  const b = readOut(bad2, "board.json"); b.week.rows.push({ a: P[0], place: 1, pts: 1, topar: 0, strokes: 1, holes: 1, lost: 0, ranked: true, html: "<b>" }); write(bad2, "board.json", b);
  assert.throws(() => execFileSync("python3", [shape, bad2], { stdio: "pipe" }), "stray key");
  const bad3 = copyDir(out);
  const w3 = readOut(bad3, "W003.json"); w3.start += 1; write(bad3, "W003.json", w3);
  assert.throws(() => execFileSync("python3", [shape, bad3], { stdio: "pipe" }), "start not the week's");
});

test("the publish job's history check: final weeks can't change, weeks only grow, joining weeks stay", async (t) => {
  try { execFileSync("python3", ["--version"]); } catch { t.skip("no python3 here"); return; }
  const [, history] = checks();
  assert.ok(history, "the workflow has the history check");
  const old = tmp("golf-");
  await run(base({ now: END + 13 * H, out: old, raceDir: raceDir(), gamesDir: FINAL_GAMES() }));
  const next = tmp("golf-");
  await run(base({ now: END + 2 * DAY, prev: old, out: next, raceDir: raceDir({ week: W + 1 }), gamesDir: gamesDir() }));
  assert.match(execFileSync("python3", [history, next, old], { encoding: "utf8" }), /golf history ok/);
  const b1 = copyDir(next); const w = readOut(b1, "W003.json"); w.cards[0].pts += 1; write(b1, "W003.json", w);
  assert.throws(() => execFileSync("python3", [history, b1, old], { stdio: "pipe" }), "final week changed");
  const b2 = copyDir(next); const i = readOut(b2, "index.json"); i.weeks = []; write(b2, "index.json", i);
  assert.throws(() => execFileSync("python3", [history, b2, old], { stdio: "pipe" }), "weeks shrank");
  const b3 = copyDir(next); const i3 = readOut(b3, "index.json"); i3.course.race = 9; write(b3, "index.json", i3);
  assert.throws(() => execFileSync("python3", [history, b3, old], { stdio: "pipe" }), "joining week changed");
  assert.match(execFileSync("python3", [history, next, tmp("none-")], { encoding: "utf8" }), /golf history ok/, "first publish");
});

test("a read problem that never clears stops holding the week back 66 hours after it ends (fix-check N1)", async () => {
  const failing = async () => { throw new Error("node down"); };
  let prev = tmp("golf-");
  await run(base({ now: END + 13 * H, out: prev, raceDir: raceDir(), gamesDir: FINAL_GAMES(), questionsOf: failing }));
  for (const h of [61, 65]) {
    const out = tmp("golf-");
    await run(base({ now: END + h * H, prev, out, raceDir: raceDir(), gamesDir: FINAL_GAMES(), questionsOf: failing }));
    assert.equal(readOut(out, "W003.json").final, false, `${h} h`);
    prev = out;
  }
  const out = tmp("golf-");
  const r = await run(base({ now: END + 67 * H, prev, out, raceDir: raceDir(), gamesDir: FINAL_GAMES(), questionsOf: failing }));
  const wf = readOut(out, "W003.json");
  assert.equal(wf.final, true);
  assert.equal(holeOf(out, "questions").status, "skipped");
  assert.match(r.problems.join(" "), /made final despite read problems/);
});

test("practice or staked is fixed when a week is first recorded (fix-check N2)", async () => {
  const prev = tmp("golf-");
  await run(base({ stakedFromWeek: null, now: START + DAY, out: prev, raceDir: raceDir(), gamesDir: gamesDir() }));
  assert.equal(readOut(prev, "W003.json").practice, true);
  const out = tmp("golf-");
  await run(base({ stakedFromWeek: W, now: START + 2 * DAY, prev, out, raceDir: raceDir(), gamesDir: gamesDir() }));
  assert.equal(readOut(out, "W003.json").practice, true, "set mid-week: this week stays practice");
  assert.equal(readOut(out, "index.json").stakedFromWeek, W);
});

test("the publish job's history check: the first staked week can't change once set", async (t) => {
  try { execFileSync("python3", ["--version"]); } catch { t.skip("no python3 here"); return; }
  const [, history] = checks();
  const old = tmp("golf-");
  await run(base({ stakedFromWeek: 5, now: START + DAY, out: old, raceDir: raceDir(), gamesDir: gamesDir() }));
  const next = copyDir(old);
  const i = readOut(next, "index.json"); i.stakedFromWeek = 4; write(next, "index.json", i);
  assert.throws(() => execFileSync("python3", [history, next, old], { stdio: "pipe" }));
  const same = copyDir(old);
  assert.match(execFileSync("python3", [history, same, old], { encoding: "utf8" }), /golf history ok/);
});

test("staked weeks: a hole's field is the players staked in Block Golf who scored (owner, 2026-10-28)", async () => {
  // Only P0–P4 are staked in Block Golf; everyone on the race board is ranked there, but that no longer matters
  const golfers = new Set(P.slice(0, 5));
  const only = async (_n, who) => new Set(who.filter((a) => golfers.has(a)));
  const out = tmp("golf-");
  await run(base({ now: END + 13 * H, out, raceDir: raceDir(), gamesDir: FINAL_GAMES(), golfStakersOf: only }));
  const wf = readOut(out, "W003.json");
  assert.equal(holeOf(out, "race").field, 5, "the 5 golfers, not the 10 ranked race players");
  assert.equal(holeOf(out, "questions").status, "skipped", "only P2–P4 staked among the question players: 3 < 5");
  const p4 = wf.cards.find((c) => c.a === P[4]).holes.find((x) => x[0] === "race");
  assert.deepEqual([p4[1], p4[2], p4[3]], [6, 5, 5], "last of the 5 golfers");
  const p6 = wf.cards.find((c) => c.a === P[6]);
  assert.equal(p6.ranked, false, "not staked in Block Golf: free-play board");
  assert.equal(p6.holes.find((x) => x[0] === "race")[3], 6, "placed as one more player");
  assert.equal(wf.cards.find((c) => c.a === P[0]).ranked, true);
  // Practice weeks don't read stakes at all
  const out2 = tmp("golf-");
  await run(base({ stakedFromWeek: null, now: END + 13 * H, out: out2, raceDir: raceDir(), gamesDir: FINAL_GAMES(), golfStakersOf: async () => { throw new Error("must not be read"); } }));
  assert.equal(readOut(out2, "W003.json").final, true);
});

test("staked weeks: stakes that can't be read, or that the nodes disagree on, keep the last flags and hold the week", async () => {
  const prev = tmp("golf-");
  await run(base({ now: END - H, out: prev, raceDir: raceDir(), gamesDir: gamesDir() }));
  const out = tmp("golf-");
  const r = await run(base({ now: END + 13 * H, prev, out, raceDir: raceDir(), gamesDir: FINAL_GAMES(), golfStakersOf: async () => { throw new Error("rpc down"); } }));
  assert.equal(readOut(out, "W003.json").final, false);
  assert.match(r.problems.join(" "), /Block Golf stakes: rpc down/);
  assert.equal(holeOf(out, "race").field, 10, "last run's flags stand");
  const out2 = tmp("golf-");
  const r2 = await run(base({ now: END + 13 * H, prev, out: out2, raceDir: raceDir(), gamesDir: FINAL_GAMES(), golfStakersOf: async (n, who) => new Set(n === "check" ? who.slice(1) : who) }));
  assert.equal(readOut(out2, "W003.json").final, false);
  assert.match(r2.problems.join(" "), /don't agree on who is staked/);
});

test("staked weeks refuse to start until the vault (v6) can be read (fix-check S2)", async () => {
  const o = base({ now: START + DAY, out: tmp("golf-"), raceDir: raceDir(), gamesDir: gamesDir() });
  delete o.golfStakersOf;
  await assert.rejects(run(o), /vault \(v6\) isn't live/);
  await run({ ...o, stakedFromWeek: null });   // practice weeks don't need it
});

test("staked weeks: a hole is final only with stakes read after the week ended (fix-check S1)", async () => {
  const all = async (_n, who) => new Set(who.filter((a) => a !== FREE));
  const five = async (_n, who) => new Set(who.filter((a) => P.slice(0, 5).includes(a)));
  const prev = tmp("golf-");
  await run(base({ now: END - H, out: prev, raceDir: raceDir(), gamesDir: gamesDir(), golfStakersOf: all }));
  const out = tmp("golf-");
  await run(base({ now: END + 13 * H, prev, out, raceDir: raceDir(), gamesDir: FINAL_GAMES(), golfStakersOf: async () => { throw new Error("rpc down"); } }));
  assert.equal(holeOf(out, "race").status, "live", "no final hole on flags read during the week");
  assert.match(holeOf(out, "race").why, /Block Golf stakes/);
  const out2 = tmp("golf-");
  await run(base({ now: END + 14 * H, prev: out, out: out2, raceDir: raceDir(), gamesDir: FINAL_GAMES(), golfStakersOf: five }));
  assert.equal(readOut(out2, "W003.json").final, true);
  assert.equal(holeOf(out2, "race").field, 5, "the stakes after the week ended");
  // Stakes never readable: skipped at 66 h, not scored on old flags
  let p = prev;
  for (const h of [13, 61, 67]) {
    const o2 = tmp("golf-");
    await run(base({ now: END + h * H, prev: p, out: o2, raceDir: raceDir(), gamesDir: FINAL_GAMES(), golfStakersOf: async () => { throw new Error("rpc down"); } }));
    p = o2;
  }
  const wf = readOut(p, "W003.json");
  assert.equal(wf.final, true);
  assert.ok(wf.holes.every((h) => h.status === "skipped"));
  assert.match(wf.holes[0].why, /couldn't be read in time/);
});

test("staked weeks don't read the question game's ranked list (fix-check S3)", async () => {
  const out = tmp("golf-");
  await run(base({ now: END + 13 * H, out, raceDir: raceDir(), gamesDir: FINAL_GAMES(), rankedOf: async () => { throw new Error("must not be read"); } }));
  assert.equal(readOut(out, "W003.json").final, true);
});

test("the Vault's file: a final staked week gets vault/W<week>.json with the Block Golf stakers' points (hand-off 2026-10-28)", async (t) => {
  const golfers = async (_n, who) => new Set(who.filter((a) => P.slice(0, 6).includes(a)));
  const out = tmp("golf-");
  await run(base({ now: END - H, out, raceDir: raceDir(), gamesDir: gamesDir(), golfStakersOf: golfers }));
  assert.ok(!fs.existsSync(path.join(out, "vault")), "nothing before the week is final");
  await run(base({ now: END + 13 * H, prev: out, out, raceDir: raceDir(), gamesDir: FINAL_GAMES(), golfStakersOf: golfers }));
  const v = readOut(path.join(out, "vault"), "W3.json");
  const wf = readOut(out, "W003.json");
  assert.equal(v.game, 6); assert.equal(v.week, 3); assert.equal(v.final, true);
  assert.deepEqual(v.first, []); assert.deepEqual(v.second, []);
  const want = wf.cards.filter((c) => P.slice(0, 6).includes(c.a) && c.pts >= 1).map((c) => c.a).sort();
  assert.deepEqual(v.rows.map((r) => r.player).sort(), want, "only Block Golf stakers with 1+ points");
  for (const r of v.rows) assert.equal(r.points, wf.cards.find((c) => c.a === r.player).pts);
  for (let i = 1; i < v.rows.length; i++) assert.ok(v.rows[i].points <= v.rows[i - 1].points);
  // Practice weeks: no vault file
  const out2 = tmp("golf-");
  await run(base({ stakedFromWeek: null, now: END + 13 * H, out: out2, raceDir: raceDir(), gamesDir: FINAL_GAMES() }));
  assert.equal(readOut(out2, "W003.json").final, true);
  assert.ok(!fs.existsSync(path.join(out2, "vault")));
  // The publish checks accept it, and refuse a changed vault file once sent
  try { execFileSync("python3", ["--version"]); } catch { t.skip("no python3 here"); return; }
  const [shape, history] = checks();
  assert.match(execFileSync("python3", [shape, out], { encoding: "utf8" }), /golf files ok/);
  const bad = copyDir(out); const bv = readOut(path.join(bad, "vault"), "W3.json"); bv.rows[0].points = 256; write(path.join(bad, "vault"), "W3.json", bv);
  assert.throws(() => execFileSync("python3", [shape, bad], { stdio: "pipe" }), "points over 255");
  const next = copyDir(out); const nv = readOut(path.join(next, "vault"), "W3.json"); nv.rows.pop(); write(path.join(next, "vault"), "W3.json", nv);
  assert.throws(() => execFileSync("python3", [history, next, out], { stdio: "pipe" }), "a sent week can't change");
  assert.match(execFileSync("python3", [history, copyDir(out), out], { encoding: "utf8" }), /golf history ok/);
});

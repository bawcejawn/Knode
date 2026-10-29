// Block Golf recorder (bot/games/golf.ts): the course from games.json, each hole from that game's own published
// results, the question game read on two nodes, kept standings when a game's files move on, the 12-hour wait, the
// 60-hour deadline, frozen final weeks and the leaderboards. Offline: fake result files and a fake question game.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const APP = process.env.APP || ".";
const { run, sourcesFromGames, testnetSources } = await import(path.resolve(APP, "bot/games/golf.ts"));
const M = globalThis.KRaceMath, G = globalThis.KGolf;
const H = 3600000, DAY = 24 * H;

const P = Array.from({ length: 12 }, (_, i) => "1" + "ABCDEFGHJKLMNPQRSTUVWXYZ"[i].repeat(33));
const FREE = "1" + "a".repeat(33);
const W = 3, START = M.weekStart(W), END = M.weekStart(W + 1);
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const write = (dir, name, j) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, name), JSON.stringify(j)); };
const SOURCES = [
  { id: "questions", name: "Daily Questions", reader: "questions" },
  { id: "race", name: "Producer Race", reader: "race" },
  { id: "blockx", name: "Who Signs Block X", reader: "blockx" },
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
const ranked = async (who) => new Set(who.filter((a) => a !== FREE));
const base = (o) => ({ sources: SOURCES, questionsOf: async () => qWeek(), rankedOf: ranked, p: "main", check: "check", ...(o.prev === undefined && !o.fresh ? { prev: seeded({ survivor: W, bracket: W }) } : {}), ...o });
/** A previous run's index, so the course already holds the three games from week W (as after a first run in W). */
function seeded(extra = {}) { const d = tmp("golf-prev-"); write(d, "index.json", { v: 1, updated: "", weeks: [], course: { questions: W, race: W, blockx: W, ...extra } }); return d; }
const readOut = (dir, name) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));

test("mid-week, first run: every live game joins at once; live holes and scorecards", async () => {
  const out = tmp("golf-");
  const r = await run(base({ fresh: true, now: START + 3 * DAY, out, raceDir: raceDir(), gamesDir: gamesDir() }));
  const wf = readOut(out, "W003.json");
  assert.deepEqual(wf.holes.map((h) => [h.id, h.status]), [["questions", "live"], ["race", "live"], ["blockx", "live"]]);
  assert.equal(wf.final, false);
  const best = wf.cards[0];
  assert.ok(best.place === 1);
  // P2 plays all three holes; P0 plays race and blockx only (lost ball on questions)
  const p0 = wf.cards.find((c) => c.a === P[0]);
  assert.equal(p0.holes.find((x) => x[0] === "questions")[1], 7);
  assert.equal(p0.mulligan === "questions", false, "a lost ball is never the mulligan");
  // The free race wallet (100 pts, unranked) beats the ranked field: hole in one on the race, still placed
  const free = wf.cards.find((c) => c.a === FREE);
  assert.equal(free.holes.find((x) => x[0] === "race")[1], 1);
  assert.equal(free.ranked, false);
  const idx = readOut(out, "index.json");
  assert.deepEqual(idx.course, { questions: W, race: W, blockx: W });
  const board = readOut(out, "board.json");
  assert.equal(board.week.week, W);
  assert.equal(board.week.rows.length, wf.cards.length);
  assert.deepEqual(board.allTime.rows, [], "all time counts final weeks only");
  assert.deepEqual(Object.keys(board.week.rows[0]).sort(), ["a", "holes", "lost", "place", "pts", "ranked", "strokes", "toPar"]);
  assert.equal(r.problems.length, 0);
});

test("a game that goes live later joins from the next Monday", async () => {
  const prev = tmp("golf-");
  await run(base({ fresh: true, now: START + DAY, out: prev, raceDir: raceDir(), gamesDir: gamesDir(), sources: SOURCES.slice(0, 2) }));
  const out = tmp("golf-");
  await run(base({ now: START + 2 * DAY, prev, out, raceDir: raceDir(), gamesDir: gamesDir() }));
  assert.deepEqual(readOut(out, "index.json").course, { questions: W, race: W, blockx: W + 1 });
  assert.deepEqual(readOut(out, "W003.json").holes.map((h) => h.id), ["questions", "race"]);
});

test("final 12 hours after the week ends when every hole is final; then frozen", async () => {
  const prev = tmp("golf-");
  await run(base({ now: START + 2 * DAY, out: prev, raceDir: raceDir(), gamesDir: gamesDir() }));
  const out = tmp("golf-");
  // 11 hours after: everything final but still inside the correction window
  await run(base({ now: END + 11 * H, prev, out, raceDir: raceDir(), gamesDir: gamesDir({ last: true, final: true }) }));
  assert.equal(readOut(out, "W003.json").final, false);
  const out2 = tmp("golf-");
  await run(base({ now: END + 13 * H, prev: out, out: out2, raceDir: raceDir(), gamesDir: gamesDir({ last: true, final: true }) }));
  const wf = readOut(out2, "W003.json");
  assert.equal(wf.final, true);
  assert.ok(wf.holes.every((h) => h.status === "final"));
  const board = readOut(out2, "board.json");
  assert.equal(board.lastWeek.final, true);
  assert.ok(board.allTime.rows.length > 0);
  // A later run with different source files changes nothing about the final week
  const out3 = tmp("golf-");
  await run(base({ now: END + 30 * H, prev: out2, out: out3, raceDir: raceDir({ rows: [] }), gamesDir: gamesDir({ last: true, final: true, rows: [] }), questionsOf: async () => ({ ...qWeek(), rows: [] }) }));
  assert.deepEqual(readOut(out3, "W003.json"), wf);
});

test("the question game: nodes that disagree, an unfinished week, and the scoring", async () => {
  const out = tmp("golf-");
  const r = await run(base({ now: END + 20 * H, out, raceDir: raceDir(), gamesDir: gamesDir({ last: true, final: true }),
    questionsOf: async (node) => (node === "check" ? { ...qWeek(), rows: qWeek().rows.slice(1) } : qWeek()) }));
  const q = readOut(out, "W003.json").holes.find((h) => h.id === "questions");
  assert.equal(q.status, "live");
  assert.match(q.why, /don't agree/);
  assert.equal(readOut(out, "W003.json").final, false);
  const out2 = tmp("golf-");
  await run(base({ now: END + 20 * H, out: out2, raceDir: raceDir(), gamesDir: gamesDir({ last: true, final: true }), questionsOf: async () => qWeek({ resolved: 29 }) }));
  assert.equal(readOut(out2, "W003.json").holes.find((h) => h.id === "questions").status, "live", "a question still unresolved");
  const out3 = tmp("golf-");
  await run(base({ now: END + 20 * H, out: out3, raceDir: raceDir(), gamesDir: gamesDir({ last: true, final: true }) }));
  const q3 = readOut(out3, "W003.json").holes.find((h) => h.id === "questions");
  assert.equal(q3.status, "final");
  assert.equal(q3.field, 7);
  const c = readOut(out3, "W003.json").cards.find((x) => x.a === P[2]);
  assert.equal(c.holes.find((x) => x[0] === "questions")[1], 1, "the best question player holes in one");
  assert.equal(r.problems.length, 0);
});

test("a question game that can't be read waits, and is skipped at the 60-hour deadline", async () => {
  const failing = async () => { throw new Error("node down"); };
  const out = tmp("golf-");
  const r = await run(base({ now: END + 59 * H, out, raceDir: raceDir(), gamesDir: gamesDir({ last: true, final: true }), questionsOf: failing }));
  assert.equal(readOut(out, "W003.json").holes[0].status, "live");
  assert.match(r.problems.join(" "), /node down/);
  const out2 = tmp("golf-");
  await run(base({ now: END + 61 * H, prev: out, out: out2, raceDir: raceDir(), gamesDir: gamesDir({ last: true, final: true }), questionsOf: failing }));
  const wf = readOut(out2, "W003.json");
  assert.deepEqual(wf.holes.map((h) => h.status), ["skipped", "final", "final"]);
  assert.match(wf.holes[0].why, /weren't final in time/);
  assert.equal(wf.final, true);
  assert.ok(wf.cards.every((c) => c.holes.length === 2), "a skipped hole is off the card");
});

test("a game's board that moved on: the standings kept from the last run are used", async () => {
  const prev = tmp("golf-");
  await run(base({ now: END - H, out: prev, raceDir: raceDir(), gamesDir: gamesDir() }));
  const out = tmp("golf-");
  // The race board now only shows week 4 (and no lastWeek), but its week-3 races are final
  const rd = raceDir();
  const b = JSON.parse(fs.readFileSync(path.join(rd, "board.json"), "utf8"));
  b.week.week = W + 1;
  fs.writeFileSync(path.join(rd, "board.json"), JSON.stringify(b));
  await run(base({ now: END + 13 * H, prev, out, raceDir: rd, gamesDir: gamesDir({ last: true, final: true }) }));
  const race = readOut(out, "W003.json").holes.find((h) => h.id === "race");
  assert.equal(race.status, "final");
  assert.equal(race.rows.length, 11);
});

test("a race week is final once its races are, or after the race recorder's 3-day window", async () => {
  const out = tmp("golf-");
  await run(base({ now: END + 20 * H, out, raceDir: raceDir({ final: false }), gamesDir: gamesDir({ last: true, final: true }) }));
  assert.equal(readOut(out, "W003.json").holes.find((h) => h.id === "race").status, "live");
  const out2 = tmp("golf-");
  await run(base({ now: END + 3 * DAY + 3 * H, out: out2, raceDir: raceDir({ final: false }), gamesDir: gamesDir({ last: true, final: true }) }));
  // past 60 h the hole would be skipped, but the race's own window has closed, so it's final
  assert.equal(readOut(out2, "W003.json").holes.find((h) => h.id === "race").status, "final");
});

test("a hole with fewer than 5 ranked players is skipped for everyone", async () => {
  const out = tmp("golf-");
  const few = P.slice(0, 4).map((a, i) => ({ a, place: i + 1, pts: 10 - i, correct: 1, picks: 1, days: 1, lastCorrect: 0, ranked: true }));
  await run(base({ now: END + 13 * H, out, raceDir: raceDir(), gamesDir: gamesDir({ last: true, final: true, rows: few }) }));
  const bx = readOut(out, "W003.json").holes.find((h) => h.id === "blockx");
  assert.equal(bx.status, "skipped");
  assert.match(bx.why, /fewer than 5/);
  assert.equal(bx.field, 4);
});

test("Survivor: standings at the week's last season day; kept when the season moves on; no season, no hole", async () => {
  const gd = gamesDir({ last: true, final: true });
  const sv = path.join(gd, "survivor");
  const startDay = Math.floor(START / DAY);   // the season starts this Monday; day 7 is Sunday
  const players = (endN) => P.slice(0, 6).map((a, i) => ({ a, lives: i < 3 ? 2 : 0, outN: i < 3 ? null : 3, total: 100 - i, used: [], log: "s", eligible: true, place: i + 1 }));
  const season = (endN, over = false) => write(sv, "S001.json", { v: 1, season: 1, startDay, days: [], result: { over, endN, final: false, players: players(endN), prizes: [] } });
  write(sv, "index.json", { v: 1, updated: "", firstDay: startDay, contract: null, seasons: [1] });
  const src = [...SOURCES, { id: "survivor", name: "Survivor", reader: "survivor" }];
  season(6);
  const out = tmp("golf-");
  await run(base({ sources: src, now: END + 2 * H, out, raceDir: raceDir(), gamesDir: gd }));
  assert.equal(readOut(out, "W003.json").holes.find((h) => h.id === "survivor").status, "live", "day 7 not recorded yet");
  season(7);
  const out2 = tmp("golf-");
  await run(base({ sources: src, now: END + 6 * H, prev: out, out: out2, raceDir: raceDir(), gamesDir: gd }));
  const s2 = readOut(out2, "W003.json").holes.find((h) => h.id === "survivor");
  assert.equal(s2.status, "final");
  assert.equal(readOut(out2, "W003.json").cards.find((c) => c.a === P[0]).holes.find((x) => x[0] === "survivor")[1], 1);
  season(9);
  const out3 = tmp("golf-");
  await run(base({ sources: src, now: END + 50 * H, prev: out2, out: out3, raceDir: raceDir(), gamesDir: gd }));
  const s3 = readOut(out3, "W003.json").holes.find((h) => h.id === "survivor");
  assert.equal(s3.status, "final");
  assert.equal(s3.rows.length, 6, "the kept day-7 standings");
  const out4 = tmp("golf-");
  await run(base({ sources: src, now: END + 50 * H, out: out4, raceDir: raceDir(), gamesDir: gd }));
  assert.equal(readOut(out4, "W003.json").holes.find((h) => h.id === "survivor").status, "skipped", "moved on and never read: skipped, not guessed");
  // A week with no season: no hole (skipped at once)
  const out5 = tmp("golf-");
  await run(base({ sources: src, now: M.weekStart(W + 5) + DAY, out: out5, raceDir: raceDir({ week: W + 5 }), gamesDir: gd }));
  const s5 = readOut(out5, "W008.json").holes.find((h) => h.id === "survivor");
  assert.equal(s5.status, "skipped");
  assert.match(s5.why, /no Survivor season/);
});

test("Bracket: its own views; a week with no bracket is no hole", async () => {
  const gd = gamesDir({ last: true, final: true });
  const rows = P.slice(0, 6).map((a, i) => ({ a, place: i + 1, pts: 34 - 4 * i, champion: i === 0, correct: 10 - i, ranked: true }));
  const view = (status, final) => ({ week: W, start: START, status, final, rows });
  write(path.join(gd, "bracket"), "board.json", { v: 1, updated: "", next: null, week: { week: W + 1, start: END, status: "open", final: false, rows: [] }, lastWeek: view("final", true), allTime: { rows: [] } });
  const src = [...SOURCES, { id: "bracket", name: "Producer Bracket", reader: "bracket" }];
  const out = tmp("golf-");
  await run(base({ sources: src, now: END + 13 * H, out, raceDir: raceDir(), gamesDir: gd }));
  assert.equal(readOut(out, "W003.json").holes.find((h) => h.id === "bracket").status, "final");
  write(path.join(gd, "bracket"), "board.json", { v: 1, updated: "", next: null, week: null, lastWeek: view("none", false), allTime: { rows: [] } });
  const out2 = tmp("golf-");
  await run(base({ sources: src, now: END + 13 * H, out: out2, raceDir: raceDir(), gamesDir: gd }));
  assert.match(readOut(out2, "W003.json").holes.find((h) => h.id === "bracket").why, /no bracket/);
});

test("files that are links or too big are ignored", async () => {
  const gd = gamesDir();
  const evil = tmp("evil-");
  write(evil, "board.json", { v: 1, week: { week: W, rows: [{ a: P[0], pts: 999, ranked: true }] } });
  fs.rmSync(path.join(gd, "blockx", "board.json"));
  fs.symlinkSync(path.join(evil, "board.json"), path.join(gd, "blockx", "board.json"));
  const out = tmp("golf-");
  await run(base({ now: START + DAY, out, raceDir: raceDir(), gamesDir: gd }));
  const bx = readOut(out, "W003.json").holes.find((h) => h.id === "blockx");
  assert.equal(bx.rows.length, 0);
});

test("games.json: live games with a reader become sources; Block Golf itself never does", () => {
  const d = tmp("gj-");
  const f = path.join(d, "games.json");
  fs.writeFileSync(f, JSON.stringify({ v: 1, games: [
    { id: "race", name: "Producer Race", status: "live" }, { id: "questions", name: "Daily Questions", status: "live" },
    { id: "blockx", name: "Who Signs Block X", status: "soon" }, { id: "golf", name: "Block Golf", status: "live" },
    { id: "mystery", name: "?", status: "live" } ] }));
  assert.deepEqual(sourcesFromGames(f).map((s) => s.id), ["race", "questions"]);
  assert.ok(sourcesFromGames(path.join(APP, "site/games.json")).every((s) => s.id !== "golf"));
});

test("the testnet course reads only the testnet Block X games", () => {
  const t = testnetSources(path.join(APP, "testnet/golf.json"));
  assert.deepEqual(t.sources.map((s) => [s.id, s.reader, s.dir]), [["blockx-2", "blockx", "blockx-2"], ["blockx-92", "blockx", "blockx-92"]]);
  assert.equal(t.minField, 1);
});

test("a whole week with every player on every hole: points add up and places are consistent", async () => {
  const out = tmp("golf-");
  await run(base({ now: END + 13 * H, out, raceDir: raceDir(), gamesDir: gamesDir({ last: true, final: true }) }));
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

test("the publish jobs' shape check accepts the recorder's files and refuses tampered ones", async (t) => {
  const { execFileSync } = await import("node:child_process");
  try { execFileSync("python3", ["--version"]); } catch { t.skip("no python3 here"); return; }
  const out = tmp("golf-");
  await run(base({ now: END + 13 * H, out, raceDir: raceDir(), gamesDir: gamesDir({ last: true, final: true }) }));
  await run(base({ now: END + 2 * DAY, prev: out, out, raceDir: raceDir({ week: W + 1 }), gamesDir: gamesDir() }));
  for (const wfName of ["golf.yml", "golf-testnet.yml"]) {
    const y = fs.readFileSync(path.join(APP, ".github/workflows", wfName), "utf8");
    const m = /<<'PY'\n([\s\S]*?)\n\s*PY\n/.exec(y);
    assert.ok(m, wfName);
    const py = m[1].split("\n").map((l) => l.replace(/^ {10}/, "")).join("\n");
    const check = path.join(tmp("chk-"), "check.py");
    fs.writeFileSync(check, py);
    assert.match(execFileSync("python3", [check, out], { encoding: "utf8" }), /golf files ok/, wfName);
    // A card claiming 8 strokes on a hole, or a stray key, is refused
    const bad = tmp("bad-");
    for (const f of fs.readdirSync(out)) fs.copyFileSync(path.join(out, f), path.join(bad, f));
    const wf = JSON.parse(fs.readFileSync(path.join(bad, "W003.json"), "utf8"));
    wf.cards[0].holes[0][1] = 8;
    fs.writeFileSync(path.join(bad, "W003.json"), JSON.stringify(wf));
    assert.throws(() => execFileSync("python3", [check, bad], { stdio: "pipe" }), wfName);
    const bad2 = tmp("bad-");
    for (const f of fs.readdirSync(out)) fs.copyFileSync(path.join(out, f), path.join(bad2, f));
    const b = JSON.parse(fs.readFileSync(path.join(bad2, "board.json"), "utf8"));
    b.week.rows.push({ a: P[0], place: 1, pts: 1, toPar: 0, strokes: 1, holes: 1, lost: 0, ranked: true, html: "<b>" });
    fs.writeFileSync(path.join(bad2, "board.json"), JSON.stringify(b));
    assert.throws(() => execFileSync("python3", [check, bad2], { stdio: "pipe" }), wfName);
  }
});

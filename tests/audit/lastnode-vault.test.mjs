// Last Node Standing → Vault v6 (hand-off 2026-10-28): the weekly vault file. Only wallets staked in game 13 for that
// week with at least 1 point, scores keeping the board's order and ties on 1–255, no prize places (a staked game),
// written once the week is final and within the Vault's 3-day window, never on the testnet, never before v6.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

import { PY, withPython } from "./lib/platform.mjs";
const APP = process.env.APP || ".";
const { run, vaultScores } = await import(pathToFileURL(path.resolve(APP, "bot/games/lastnode.ts")).href);
const L = globalThis.KLastNode;
const A = (c) => "1" + c.repeat(33);
import { yml, AT, P1, P2, P3, P4, linux, publishScript, publisher, idx, NODES, CUT_ORDER, WINNER, dayFile, boardOf, PICKS, dayW3, brd, vgood, history, REST_W3, raceFiles, gamed, dayG, S10, grown } from "./lastnode-vault.helpers.mjs";
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

test("scores: more than 255 different places: the top 254 keep their tie-breaks, only the tail shares 1 (audit LN-13)", () => {
  const rows = Array.from({ length: 300 }, (_, i) => row("1" + i.toString(36).padStart(33, "x"), 200 - Math.floor(i / 2), i % 2 ? 0 : 1, 0));
  const r = vaultScores(rows);
  assert.ok(r.every((x) => x.points >= 1 && x.points <= 255));
  assert.ok(r.every((x, i) => i === 0 || r[i - 1].points >= x.points));
  // Each pair ties on points; the rides tie-break must still separate them at the top.
  assert.deepEqual(r.slice(0, 4).map((x) => x.points), [255, 254, 253, 252]);
  assert.equal(new Set(r.slice(0, 254).map((x) => x.points)).size, 254, "254 different places at the top");
  assert.ok(r.slice(254).every((x) => x.points === 1), "the tail shares 1");
});

test("audit LN-12: the minimum stake is the vault's for that week", async () => {
  const { minStakeOf } = await import(pathToFileURL(path.resolve(APP, "bot/games/lastnode.ts")).href);
  assert.equal(minStakeOf({ min_stake: "100000000" }, 5), 100000000n);
  assert.equal(minStakeOf({ min_stake: "100000000", min_stake_next: "50000000", min_stake_next_week: "6" }, 5), 100000000n);
  assert.equal(minStakeOf({ min_stake: "100000000", min_stake_next: "50000000", min_stake_next_week: "6" }, 6), 50000000n);
  assert.equal(minStakeOf({}, 1), 0n, "no answer: 0, which the reader refuses");
  const src = fs.readFileSync(path.resolve(APP, "bot/games/lastnode.ts"), "utf8");
  assert.match(src, /if \(min <= 0n\) throw/);
  assert.match(src, /week_stake \|\| "0"\) >= min\)/);
});

test("audit LN-2: who is staked must agree on both nodes, or no file this run", async () => {
  const { stakedOnBoth } = await import(pathToFileURL(path.resolve(APP, "bot/games/lastnode.ts")).href);
  const same = await stakedOnBoth(async (n) => new Set(n === "p" ? [P1, P2] : [P2, P1]), "p", "c");
  assert.deepEqual([...same].sort(), [P1, P2].sort());
  await assert.rejects(stakedOnBoth(async (n) => new Set(n === "p" ? [] : [P1]), "p", "c"), /disagree on who is staked/, "an empty answer on one node");
  await assert.rejects(stakedOnBoth(async () => new Set([P1]), "p", null), /no second node/);
  await assert.rejects(stakedOnBoth(async (n) => (n === "p" ? null : new Set()), "p", "c"), /one node only/);
  assert.equal(await stakedOnBoth(async () => null, "p", "c"), null, "before v6 on both: no file, no error");
  const src = fs.readFileSync(path.resolve(APP, "bot/games/lastnode.ts"), "utf8");
  assert.match(src, /stakedOnBoth\(\(n\) => readStakedV6\(n, lw, players\), o\.p, o\.check\)/, "the run uses both nodes");
});

// A whole week of events from the recorder's own files, then the run after the week ends.
function weekFiles(w, players, { events = [1], blocks = { N: 100, M: 10 } } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lns-v-"));
  const days = [];
  for (let t = L.weekStart(w); t < L.weekStart(w + 1); t += L.DAY) {
    const ev = L.eventOf(t);
    days.push(ev.day);
    fs.writeFileSync(path.join(dir, `D${ev.day}.json`), JSON.stringify({ v: 1, day: ev.day, start: ev.start, week: w, field: null, void: "test", hours: [], picks: {}, cuts: [], standing: [], winner: null, done: false, players: [] }));
  }
  // Finished events with the players' results (by default one, on the week's second day).
  const N = [A("N"), A("M")];
  for (const k of events) {
    const ev = L.eventOf(L.weekStart(w) + k * L.DAY);
    const field = { at: 0, c: 0, fairness: null, nodes: [{ a: N[0], vhp: 2, kh: 100, h: 1 }, { a: N[1], vhp: 1, kh: 50, h: 2 }] };
    const picks = { 0: players.map(([p, n]) => [p, N[n], ev.start - 3600000]) };
    fs.writeFileSync(path.join(dir, `D${ev.day}.json`), JSON.stringify({ v: 1, day: ev.day, start: ev.start, week: w, field, hours: [{ i: 0, from: 1, to: 2, blocks: { [N[0]]: blocks.N, [N[1]]: blocks.M }, checked: 2 }], picks, cuts: [], standing: [], winner: null, done: false, players: [] }));
  }
  fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify({ v: 1, days, contract: null, game: 13 }));
  return dir;
}
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

test("watch-and-hold: a node far above its multiplier that won 2+ races holds the week's vault file until released", async () => {
  // M (50 expected an hour) signs 80 in each of 3 races and wins them all: 1.6 × its multiplier's expectation.
  const w = 3, now = L.weekStart(w + 1) + 13 * 3600000, stakedOf = async () => new Set([P1]);
  const dir = weekFiles(w, [[P1, 1]], { events: [1, 2, 3], blocks: { N: 100, M: 80 } });
  const r = await go(dir, now, stakedOf);
  assert.equal(r.vault, null); assert.ok(!fs.existsSync(path.join(dir, "vault", `W${w}.json`)));
  const h = JSON.parse(fs.readFileSync(path.join(dir, "vault", `HOLD-W${w}.json`), "utf8"));
  assert.equal(h.week, w); assert.deepEqual(h.nodes.map((x) => [x.a, x.wins]), [[A("M"), 3]]); assert.ok(h.nodes[0].q >= 1.5);
  assert.ok(r.problems.some((p) => /HELD for review/.test(p) && /gh variable set LASTNODE_RELEASE_WEEKS --body "3"/.test(p)));
  // Released by the owner: the file is written.
  const r2 = await run({ p: "m", check: null, prev: dir, out: dir, raceDir: "", picksContract: null, windowOf: async () => { throw new Error("no blocks needed"); },
    picksOf: async () => [], rankedOf: async (x) => new Set(x), stakedOf, releaseWeeks: [w], trials: 200, now: { time: now, libTime: now } });
  assert.ok(r2.vault); assert.ok(fs.existsSync(path.join(dir, "vault", `W${w}.json`)));
  // On par: nothing held.
  const ok = await go(weekFiles(w, [[P1, 0]], { events: [1, 2, 3] }), now, stakedOf);
  assert.ok(ok.vault); assert.equal(ok.hold, null);
});

test("no vault file while stakes can't be read (before v6), and never in testnet practice", async () => {
  const w = 3, dir = weekFiles(w, [[P1, 0]]);
  const r = await go(dir, L.weekStart(w + 1) + 13 * 3600000, async () => null);
  assert.equal(r.vault, null); assert.ok(!fs.existsSync(path.join(dir, "vault")));
  const r2 = await run({ p: "m", check: null, prev: dir, out: dir, raceDir: "", picksContract: null, practice: true, windowOf: async () => ({ from: 0, to: 0, counts: {} }), picksOf: async () => [],
    rankedOf: async (x) => new Set(x), stakedOf: async () => new Set([P1]), trials: 200, now: { time: L.weekStart(w + 1) + 13 * 3600000, libTime: L.weekStart(w + 1) + 13 * 3600000 } });
  assert.equal(r2.vault, null);
});

// The publish job's shape check accepts the recorder's vault file and refuses a bad one. Run for real (python3), with
// the clock set to 13 hours after week 3 ended (KG_TEST_NOW).
const checkPy = yml.match(/<<'PY'\n([\s\S]*?)\n\s*PY\n/)[1].split("\n").map((l) => l.replace(/^ {10}/, "")).join("\n");
const shapeRun = (dir, now = AT(4, 13)) => { const t = fs.mkdtempSync(path.join(os.tmpdir(), "lns-rt-"));
  try { execFileSync(PY, ["-I", "-c", checkPy, dir], { stdio: "pipe", env: { ...process.env, KG_TEST_NOW: now, RUNNER_TEMP: t } }); return { ok: true, skip: fs.readFileSync(path.join(t, "vault-skip.txt"), "utf8") }; }
  catch (e) { return { ok: false, err: String(e.stderr) }; } };
const shapeOk = (dir, now) => shapeRun(dir, now).ok;
const brow = (a, place, pts) => ({ a, place, pts, rides: 0, jumps: 0, events: 1, ranked: true });
const board = (week, rows, final = true) => ({ v: 1, updated: "x", today: { rows: [] }, week: { rows: [] }, lastWeek: { week, final, rows }, allTime: { rows: [] } });
function vaultDir(j, name = "W3.json", b = board(3, [brow(P1, 1, 9), brow(P2, 1, 9), brow(P4, 3, 4), brow(P3, 4, 2)])) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lns-vp-"));
  fs.mkdirSync(path.join(dir, "vault"));
  fs.writeFileSync(path.join(dir, "board.json"), JSON.stringify(b));
  if (j) fs.writeFileSync(path.join(dir, "vault", name), JSON.stringify(j));
  return dir;
}
const good = { game: 13, week: 3, final: true, rows: [{ player: P1, points: 9 }, { player: P2, points: 9 }, { player: P3, points: 2 }], first: [], second: [] };

withPython("the publish check: vault files of game 13 only, with points rows and no prize places", () => {
  assert.ok(shapeOk(vaultDir(good)));
  for (const [k, bad] of [["game", { ...good, game: 2 }], ["final", { ...good, final: false }], ["prize", { ...good, first: [P1] }],
    ["points 0", { ...good, rows: [{ player: P1, points: 0 }] }], ["points 256", { ...good, rows: [{ player: P1, points: 256 }] }],
    ["order", { ...good, rows: [{ player: P1, points: 2 }, { player: P2, points: 9 }] }], ["twice", { ...good, rows: [{ player: P1, points: 2 }, { player: P1, points: 2 }] }],
    ["extra", { ...good, note: "x" }], ["address", { ...good, rows: [{ player: "<b>", points: 2 }] }]]) {
    assert.equal(shapeOk(vaultDir(bad)), false, k);
  }
  assert.equal(shapeOk(vaultDir(good, "W4.json")), false, "a file name that isn't its week");
});

withPython("audit LN-19: the game must be the whole number 13 (a JSON 13.0 is refused)", () => {
  const dir = vaultDir(null);
  fs.writeFileSync(path.join(dir, "vault", "W3.json"), JSON.stringify(good).replace('"game":13', '"game":13.0'));
  assert.equal(shapeOk(dir), false);
});

withPython("audit LN-1: only last week's file, only inside its window (the rows themselves: the push step's tests below)", () => {
  for (const w of [0, 1, 2, 4, 5, 9999]) assert.equal(shapeOk(vaultDir({ ...good, week: w }, `W${w}.json`)), false, `week ${w} while week 3 is last week`);
  assert.equal(shapeOk(vaultDir(good), AT(4, 11.9)), false, "before the week is final (12 h)");
  assert.equal(shapeOk(vaultDir(good), AT(4, 12)), true, "from 12 h");
  assert.equal(shapeOk(vaultDir(good), AT(4, 72.5)), true, "a little leeway past 3 days for the runner's clock");
  const late = shapeRun(vaultDir(good), AT(4, 73.5));
  assert.equal(late.ok, true, "after the Vault's 3 days: the rest of the run still publishes"); assert.equal(late.skip, "W3.json\n", "but not the vault file");
  assert.equal(shapeOk(vaultDir(good), AT(5, 13)), false, "a week later, the file is two weeks old");
});

withPython("the test history follows the rules: 15, 15, 4 and 2 points", () => {
  assert.deepEqual(brd.lastWeek.rows.map((r) => [r.a, r.pts]), [[P1, 15], [P2, 15], [P4, 4], [P3, 2]]);
  assert.deepEqual(vaultScores(brd.lastWeek.rows.filter((r) => r.a !== P4)), vgood.rows);
  assert.ok(shapeOk((() => { const dir = vaultDir(vgood, "W3.json", brd); fs.writeFileSync(path.join(dir, "D2026-11-10.json"), JSON.stringify(dayW3)); return dir; })()), "and passes the shape check");
});

linux("audit LN-1: the publish step refuses a planted week, keeps a published file, and fails loudly on a different copy", () => {
  const pub = publisher();
  const planted = pub.publish({ "index.json": idx, "board.json": brd, "vault/W9.json": { ...vgood, week: 9 } });
  assert.notEqual(planted.status, 0); assert.match(planted.out, /W9.json: only last week's file/); assert.equal(pub.show("vault/W9.json"), null, "nothing published from a run with a planted week");
  assert.equal(pub.show("index.json"), null);
  pub.seed(history());
  const first = pub.publish(history(brd));
  assert.equal(first.status, 0, first.out);
  const withVault = pub.publish({ ...history(), "vault/W3.json": vgood });
  assert.equal(withVault.status, 0, withVault.out); assert.deepEqual(JSON.parse(pub.show("vault/W3.json")), vgood);
  const same = pub.publish({ ...history(), "vault/W3.json": vgood });
  assert.equal(same.status, 0, same.out);
  const other = { ...vgood, rows: [{ player: P1, points: 15 }] };
  const diff = pub.publish({ ...history(), "index.json": { ...idx, days: ["2026-11-10", ...REST_W3], updated: "y" }, "vault/W3.json": other });
  assert.notEqual(diff.status, 0, "a different copy fails the run"); assert.match(diff.out, /::error::Already published, and this run's copy is DIFFERENT/);
  assert.deepEqual(JSON.parse(pub.show("vault/W3.json")), vgood, "the published file is kept");
  assert.equal(JSON.parse(pub.show("index.json")).updated, "y", "the rest of the run is still published");
});

linux("fix-check LNF-1: a vault file must have exactly the points last week's day files give, not only their order", () => {
  const pub = publisher();
  pub.seed(history());
  for (const [why, rows] of [["inflated points, same order", [{ player: P1, points: 255 }, { player: P2, points: 1 }, { player: P3, points: 1 }]],
    ["a stranger", [{ player: A("X"), points: 255 }]], ["out of order", [{ player: P3, points: 15 }, { player: P1, points: 2 }]]]) {
    const r = pub.publish({ ...history(), "vault/W3.json": { ...vgood, rows } });
    assert.notEqual(r.status, 0, why); assert.match(r.out, /its rows aren't what last week's day files give/, why);
    assert.equal(pub.show("vault/W3.json"), null, why);
  }
  // A staked subset (P4 not staked) with the board's own points is what the recorder writes: accepted.
  const ok = pub.publish({ ...history(), "vault/W3.json": vgood });
  assert.equal(ok.status, 0, ok.out); assert.deepEqual(JSON.parse(pub.show("vault/W3.json")), vgood);
});

linux("fix-check LNF-5: a vault file that doesn't match is left out, the rest is published, and the run fails", () => {
  const pub = publisher();
  pub.seed(history());
  const r = pub.publish({ ...history(), "index.json": { ...idx, days: ["2026-11-10", ...REST_W3], updated: "z" }, "vault/W3.json": { ...vgood, rows: [{ player: P1, points: 255 }] } });
  assert.notEqual(r.status, 0); assert.equal(JSON.parse(pub.show("index.json")).updated, "z", "the rest is published"); assert.equal(pub.show("vault/W3.json"), null);
});

linux("fix-check LNF-2: published history can't be rewritten (days, fields, picks, a final week)", () => {
  const pub = publisher();
  pub.seed(history());
  const X = A("X");
  // A bad run adds a stranger to a finished day, with a board that adds up: refused, nothing published.
  const planted = dayFile("2026-11-10", [...PICKS, [X, WINNER]]);
  const r1 = pub.publish(history(boardOf([planted]), planted));
  assert.notEqual(r1.status, 0); assert.match(r1.out, /picks changed after they were published|finished event's results changed/);
  assert.deepEqual(JSON.parse(pub.show("D2026-11-10.json")), dayW3, "the published day is kept");
  // A changed field (other handicaps) after picks open.
  const f2 = { ...dayW3, field: { ...dayW3.field, nodes: dayW3.field.nodes.map((n, i) => (i === 3 ? { ...n, h: 1.5 } : n)) } };
  const r2 = pub.publish(history(brd, f2));
  assert.notEqual(r2.status, 0); assert.match(r2.out, /field changed after it was published/);
  // Players that don't follow from the picks (LNF-23), even on a first publish.
  const pub2 = publisher();
  const fake = { ...dayW3, players: dayW3.players.map((p) => (p.a === P3 ? { ...p, points: 70 } : p)) };
  const r3 = pub2.publish(history(boardOf([fake]), fake));
  assert.notEqual(r3.status, 0); assert.match(r3.out, /players don't follow from its picks and cuts/);
  // A board whose final last week doesn't add up from the day files.
  const r4 = pub.publish(history({ ...brd, lastWeek: { ...brd.lastWeek, rows: brd.lastWeek.rows.map((r) => (r.a === P3 ? { ...r, pts: 50 } : r)) } }));
  assert.notEqual(r4.status, 0); assert.match(r4.out, /last week's rows don't add up from the day files/);
});

linux("fix-check LNF-2: a running day may only add hours; LNF-10: a day's week must be its start's", () => {
  const pub = publisher();
  const part = dayFile("2026-11-10", PICKS, { hours: 4 });
  pub.seed({ "D2026-11-10.json": part, "index.json": { ...idx, days: ["2026-11-10"] } });
  const more = pub.publish(history());
  assert.equal(more.status, 0, more.out);
  const pub2 = publisher();
  const wrongWeek = { ...dayW3, week: 2 };
  const r = pub2.publish({ "D2026-11-10.json": wrongWeek, "index.json": { ...idx, days: ["2026-11-10"] } });
  assert.notEqual(r.status, 0);
});

linux("audit LN-1/LN-2: a file with no rows while the week has scoring players is not published", () => {
  const pub = publisher();
  pub.seed(history());
  const r = pub.publish({ ...history(), "vault/W3.json": { ...vgood, rows: [] } });
  assert.equal(r.status, 0, r.out); assert.match(r.out, /has no rows while last week has scoring players; not published/);
  assert.equal(pub.show("vault/W3.json"), null); assert.ok(pub.show("board.json"));
  const later = pub.publish({ ...history(), "vault/W3.json": vgood });
  assert.equal(later.status, 0, later.out); assert.deepEqual(JSON.parse(pub.show("vault/W3.json")), vgood, "the real file still gets in later");
});

linux("fix-check LNF-12: the Vault's 3 days end with no file while the week had scoring players: the run fails so you're told", () => {
  const pub = publisher();
  pub.seed(history());
  const env = { KG_TEST_NOW: AT(4, 72.5) };
  const r = pub.publish(history(), env);
  assert.notEqual(r.status, 0); assert.match(r.out, /no vault file was published/);
});

linux("fix-check LNF-3: a window's lowered multipliers must be what its race card gives", () => {
  const dir = raceFiles([grown]);
  const okDay = dayFile("2026-11-10", PICKS, { raceCard: grown });
  assert.ok(okDay.hours[0].hh && okDay.hours[0].hh[NODES[5]] < 10000, "the node that doubled its VHP is lowered");
  const pub = publisher();
  const r = pub.publish(history(boardOf([okDay]), okDay), { FAKE_RACE: dir });
  assert.equal(r.status, 0, r.out);
  // A bad run drops the lowering (or names no card while one exists): refused.
  const pub2 = publisher();
  const noCut = { ...okDay, hours: okDay.hours.map(({ hh, ...h }) => h) };
  const rc = L.cutsFrom(noCut.field, noCut.hours);
  const r2 = pub2.publish(history(boardOf([{ ...noCut, ...{ cuts: rc.cuts } }]), { ...noCut, cuts: rc.cuts, standing: rc.standing, winner: rc.winner }), { FAKE_RACE: dir });
  assert.notEqual(r2.status, 0); assert.match(r2.out, /lowered multipliers aren't what its race card gives/);
  const noCard = dayFile("2026-11-10", PICKS, { raceCard: null });
  const r3 = publisher().publish(history(boardOf([noCard]), noCard), { FAKE_RACE: dir });
  assert.notEqual(r3.status, 0); assert.match(r3.out, /skipped the race card check/);
});

linux("watch-and-hold: a held week is published as HOLD-W<week>.json and the run fails so you're told", async () => {
  const { watchWeek } = await import(pathToFileURL(path.resolve(APP, "bot/games/lastnode.ts")).href);
  const pub = publisher(); pub.chain(gamed.chain());
  pub.seed(gamed.history());
  const nodes = watchWeek([dayG], L.CUT);
  assert.deepEqual(nodes.map((x) => x.a), [WINNER], "the rule flags the winner");
  const hold = { game: 13, week: 3, nodes, why: "held for the owner's review" };
  const r = pub.publish({ ...gamed.history(), "vault/HOLD-W3.json": hold });
  assert.notEqual(r.status, 0); assert.match(r.out, /HELD for your review/);
  assert.deepEqual(JSON.parse(pub.show("vault/HOLD-W3.json")), hold); assert.equal(pub.show("vault/W3.json"), null);
  // Fix-check L-8: a hold file the day files don't give (a node the rule doesn't flag) is refused.
  const pub2 = publisher(); pub2.seed(history());
  const r2 = pub2.publish({ ...history(), "vault/HOLD-W3.json": { ...hold, nodes: [{ a: NODES[3], q: 1.6, wins: 3, events: 3 }] } });
  assert.notEqual(r2.status, 0); assert.match(r2.out, /isn't what watch-and-hold gives/); assert.equal(pub2.show("vault/HOLD-W3.json"), null);
});

// ── Fix-check round 2, N-9 (M-W-n2, M-H-n6): the publish job enforces the hold itself ──
const holdOf = async (days) => { const { watchWeek } = await import(pathToFileURL(path.resolve(APP, "bot/games/lastnode.ts")).href); return { game: 13, week: 3, nodes: watchWeek(days, L.CUT), why: "held" }; };
const vgoodG = { ...vgood };
linux("M-W-n2: a week held on games-data can't be filed by a later run unless the owner released it", async () => {
  const pub = publisher(); pub.chain(gamed.chain());
  pub.seed({ ...gamed.history(), "vault/HOLD-W3.json": await holdOf([dayG]) });
  const r = pub.publish({ ...gamed.history(), "vault/W3.json": vgoodG });                 // a bad record run: W3, no HOLD
  assert.notEqual(r.status, 0, r.out); assert.equal(pub.show("vault/W3.json"), null, "the held week stays unfiled");
  const ok = pub.publish({ ...gamed.history(), "vault/W3.json": vgoodG }, { LASTNODE_RELEASE_WEEKS: "3" });   // released: filed
  assert.equal(ok.status, 0, ok.out); assert.ok(pub.show("vault/W3.json"));
});
linux("M-W-n2: one run can't publish both HOLD-W<week> and W<week>", async () => {
  const pub = publisher(); pub.chain(gamed.chain()); pub.seed(gamed.history());
  const r = pub.publish({ ...gamed.history(), "vault/W3.json": vgoodG, "vault/HOLD-W3.json": await holdOf([dayG]) });
  assert.notEqual(r.status, 0); assert.equal(pub.show("vault/W3.json"), null);
});
linux("M-W-n2: the publish job recomputes the hold from the day files (a flagged week needs the owner's release)", () => {
  // Last week's day files flag the winner (160 blocks an hour against 100); W3 with no HOLD file and no release.
  const pub = publisher(); pub.chain(gamed.chain()); pub.seed(gamed.history());
  const r = pub.publish({ ...gamed.history(), "vault/W3.json": vgoodG });
  assert.notEqual(r.status, 0); assert.match(r.out, /watch-and-hold flags last week/); assert.equal(pub.show("vault/W3.json"), null);
  // A week the rule doesn't flag is filed as before.
  const pub2 = publisher(); pub2.seed(history());
  assert.equal(pub2.publish({ ...history(), "vault/W3.json": vgood }).status, 0); assert.ok(pub2.show("vault/W3.json"));
  const rel = pub.publish({ ...gamed.history(), "vault/W3.json": vgoodG }, { LASTNODE_RELEASE_WEEKS: "3" });
  assert.equal(rel.status, 0, rel.out); assert.ok(pub.show("vault/W3.json"));
});
linux("fix-check I-7: LASTNODE_RELEASE_WEEKS is read strictly (\"3,,7\" or \"0x3\" releases nothing)", () => {
  for (const bad of ["3,,7", "0x3", "3;4", "three"]) {
    const pub = publisher(); pub.chain(gamed.chain()); pub.seed(gamed.history());
    const r = pub.publish({ ...gamed.history(), "vault/W3.json": vgoodG }, { LASTNODE_RELEASE_WEEKS: bad });
    assert.notEqual(r.status, 0, bad); assert.equal(pub.show("vault/W3.json"), null, bad); assert.match(r.out, /isn't a list of week numbers/, bad);
  }
});

// ── Fix-check round 2 (FIXCHECK-LASTNODE-2.md), pasted in from the reviewer's paste-in file ──
linux("M-R-2: a race card that reaches race-data after a window was published never blocks later publishes", () => {
  const okDay = dayFile("2026-11-10", PICKS, { raceCard: grown });
  const pub = publisher();
  const r1 = pub.publish(history(boardOf([okDay]), okDay), { FAKE_RACE: raceFiles([grown]) });
  assert.equal(r1.status, 0, r1.out);
  // The race recorder pushes a card late (queued publish job / re-run): taken 40 minutes before window 0's end, same VHP.
  const late = { ...grown, at: okDay.start + 20 * 60000 };
  const r2 = pub.publish(history(boardOf([okDay]), okDay), { FAKE_RACE: raceFiles([grown, late]) });
  assert.equal(r2.status, 0, `the same published day file is refused after a late card: ${r2.out}`);
});

// Last Node Standing → Vault v6 (hand-off 2026-10-28): the weekly vault file. Only wallets staked in game 13 for that
// week with at least 1 point, scores keeping the board's order and ties on 1–255, no prize places (a staked game),
// written once the week is final and within the Vault's 3-day window, never on the testnet, never before v6.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

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
  const { minStakeOf } = await import(path.resolve(APP, "bot/games/lastnode.ts"));
  assert.equal(minStakeOf({ min_stake: "100000000" }, 5), 100000000n);
  assert.equal(minStakeOf({ min_stake: "100000000", min_stake_next: "50000000", min_stake_next_week: "6" }, 5), 100000000n);
  assert.equal(minStakeOf({ min_stake: "100000000", min_stake_next: "50000000", min_stake_next_week: "6" }, 6), 50000000n);
  assert.equal(minStakeOf({}, 1), 0n, "no answer: 0, which the reader refuses");
  const src = fs.readFileSync(path.resolve(APP, "bot/games/lastnode.ts"), "utf8");
  assert.match(src, /if \(min <= 0n\) throw/);
  assert.match(src, /week_stake \|\| "0"\) >= min\)/);
});

test("audit LN-2: who is staked must agree on both nodes, or no file this run", async () => {
  const { stakedOnBoth } = await import(path.resolve(APP, "bot/games/lastnode.ts"));
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

// The publish job's shape check accepts the recorder's vault file and refuses a bad one. Run for real (python3), with
// the clock set to 13 hours after week 3 ended (KG_TEST_NOW).
const yml = fs.readFileSync(path.resolve(APP, ".github/workflows/lastnode.yml"), "utf8");
const checkPy = yml.match(/<<'PY'\n([\s\S]*?)\n\s*PY\n/)[1].split("\n").map((l) => l.replace(/^ {10}/, "")).join("\n");
const AT = (w, h) => String(L.weekStart(w) + h * 3600000);
const shapeRun = (dir, now = AT(4, 13)) => { const t = fs.mkdtempSync(path.join(os.tmpdir(), "lns-rt-"));
  try { execFileSync("python3", ["-I", "-c", checkPy, dir], { stdio: "pipe", env: { ...process.env, KG_TEST_NOW: now, RUNNER_TEMP: t } }); return { ok: true, skip: fs.readFileSync(path.join(t, "vault-skip.txt"), "utf8") }; }
  catch (e) { return { ok: false, err: String(e.stderr) }; } };
const shapeOk = (dir, now) => shapeRun(dir, now).ok;
const brow = (a, place, pts) => ({ a, place, pts, rides: 0, jumps: 0, events: 1, ranked: true });
const board = (week, rows, final = true) => ({ v: 1, updated: "x", today: { rows: [] }, week: { rows: [] }, lastWeek: { week, final, rows }, allTime: { rows: [] } });
const P4 = A("S");
function vaultDir(j, name = "W3.json", b = board(3, [brow(P1, 1, 9), brow(P2, 1, 9), brow(P4, 3, 4), brow(P3, 4, 2)])) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lns-vp-"));
  fs.mkdirSync(path.join(dir, "vault"));
  fs.writeFileSync(path.join(dir, "board.json"), JSON.stringify(b));
  if (j) fs.writeFileSync(path.join(dir, "vault", name), JSON.stringify(j));
  return dir;
}
const good = { game: 13, week: 3, final: true, rows: [{ player: P1, points: 9 }, { player: P2, points: 9 }, { player: P3, points: 2 }], first: [], second: [] };

test("the publish check: vault files of game 13 only, with points rows and no prize places", () => {
  assert.ok(shapeOk(vaultDir(good)));
  for (const [k, bad] of [["game", { ...good, game: 2 }], ["final", { ...good, final: false }], ["prize", { ...good, first: [P1] }],
    ["points 0", { ...good, rows: [{ player: P1, points: 0 }] }], ["points 256", { ...good, rows: [{ player: P1, points: 256 }] }],
    ["order", { ...good, rows: [{ player: P1, points: 2 }, { player: P2, points: 9 }] }], ["twice", { ...good, rows: [{ player: P1, points: 2 }, { player: P1, points: 2 }] }],
    ["extra", { ...good, note: "x" }], ["address", { ...good, rows: [{ player: "<b>", points: 2 }] }]]) {
    assert.equal(shapeOk(vaultDir(bad)), false, k);
  }
  assert.equal(shapeOk(vaultDir(good, "W4.json")), false, "a file name that isn't its week");
});

test("audit LN-19: the game must be the whole number 13 (a JSON 13.0 is refused)", () => {
  const dir = vaultDir(null);
  fs.writeFileSync(path.join(dir, "vault", "W3.json"), JSON.stringify(good).replace('"game":13', '"game":13.0'));
  assert.equal(shapeOk(dir), false);
});

test("audit LN-1: only last week's file, only inside its window (the rows themselves: the push step's tests below)", () => {
  for (const w of [0, 1, 2, 4, 5, 9999]) assert.equal(shapeOk(vaultDir({ ...good, week: w }, `W${w}.json`)), false, `week ${w} while week 3 is last week`);
  assert.equal(shapeOk(vaultDir(good), AT(4, 11.9)), false, "before the week is final (12 h)");
  assert.equal(shapeOk(vaultDir(good), AT(4, 12)), true, "from 12 h");
  assert.equal(shapeOk(vaultDir(good), AT(4, 72.5)), true, "a little leeway past 3 days for the runner's clock");
  const late = shapeRun(vaultDir(good), AT(4, 73.5));
  assert.equal(late.ok, true, "after the Vault's 3 days: the rest of the run still publishes"); assert.equal(late.skip, "W3.json\n", "but not the vault file");
  assert.equal(shapeOk(vaultDir(good), AT(5, 13)), false, "a week later, the file is two weeks old");
});

// The publish step's real shell against a throwaway bare repository (bash, git): skipped on Windows.
const linux = process.platform === "win32" ? (name, fn) => test.skip(name, fn) : test;
function publishScript() {
  const lines = yml.split("\n");
  const i = lines.findIndex((l) => /name:\s*Push games-data\/lastnode/.test(l));
  const r = lines.findIndex((l, j) => j > i && /^\s+run:\s*\|\s*$/.test(l));
  const indent = lines[r + 1].match(/^\s*/)[0].length;
  const out = [];
  for (let j = r + 1; j < lines.length; j++) { const l = lines[j]; if (l.trim() && l.match(/^\s*/)[0].length < indent) break; out.push(l.slice(indent)); }
  const s = out.join("\n");
  assert.match(s, /^remote=.*$/m);
  return s.replace(/^remote=.*$/m, 'remote="$FAKE_REMOTE"').replace(/sleep \$\(\(try \* 5\)\)/g, "sleep 0");
}
function publisher() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lns-pub-"));
  const remote = path.join(root, "remote.git");
  const env = { ...process.env, HOME: root, GIT_CONFIG_NOSYSTEM: "1", FAKE_REMOTE: remote, GH_TOKEN: "x", KG_TEST_NOW: AT(4, 13) };
  execFileSync("git", ["init", "-q", "--bare", remote], { env });
  let n = 0;
  return {
    remote, env,
    publish(files, extraEnv = {}) {
      const t = path.join(root, `run${++n}`), IN = path.join(t, "incoming");
      fs.mkdirSync(path.join(IN, "lastnode", "vault"), { recursive: true });
      for (const [k, v] of Object.entries(files)) fs.writeFileSync(path.join(IN, "lastnode", k), typeof v === "string" ? v : JSON.stringify(v));
      const r = spawnSync("bash", ["-c", publishScript()], { cwd: t, env: { ...env, IN, RUNNER_TEMP: t, ...extraEnv }, encoding: "utf8" });
      return { status: r.status, out: r.stdout + r.stderr };
    },
    /** Put files on games-data directly, as earlier runs would have published them. */
    seed(files) {
      const w = path.join(root, `seed${++n}`);
      execFileSync("git", ["init", "-q", w], { env });
      const g = (...a) => execFileSync("git", a, { cwd: w, env, encoding: "utf8" });
      try { g("fetch", "-q", remote, "games-data"); g("checkout", "-q", "FETCH_HEAD"); } catch { /* first */ }
      for (const [k, v] of Object.entries(files)) { const f = path.join(w, "lastnode", k); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v)); }
      g("add", "-A"); g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "seed"); g("push", "-q", remote, "HEAD:refs/heads/games-data");
    },
    show: (name) => { try { return execFileSync("git", ["--git-dir", remote, "show", `games-data:lastnode/${name}`], { env, encoding: "utf8" }); } catch { return null; } },
  };
}
const idx = { v: 1, updated: "x", days: [], contract: null, game: 13 };

// Last week's history (week 3 starts Monday 2026-11-09), made by the real rules: one event, an 11-node field, one cut
// an hour. P1 and P2 ride the winner (10 + 5 = 15), P4's node goes at cut 5 (4), P3's at cut 3 (2).
const NODES = Array.from({ length: 11 }, (_, i) => A("ABCDEFGHJKL"[i]));
const CUT_ORDER = NODES.slice(1), WINNER = NODES[0];
function dayFile(day, pickRows, { hours = 10, extra = {} } = {}) {
  const start = Date.parse(`${day}T14:00:00Z`);
  const field = { at: start - 26 * 3600000, c: 0, fairness: null, nodes: NODES.map((a, i) => ({ a, vhp: 2000 - i * 10, kh: 100, h: 1 })) };
  const hs = Array.from({ length: hours }, (_, i) => ({ i, from: 1000 + i * 1200, to: 2199 + i * 1200, checked: 2,
    blocks: Object.fromEntries(NODES.filter((a) => !CUT_ORDER.slice(0, i).includes(a)).map((a) => [a, a === CUT_ORDER[i] ? 0 : 100])) }));
  const res = L.cutsFrom(field, hs);
  const picks = { 0: pickRows.map(([w, s0, b]) => (b ? [w, s0, start - 3600000, b] : [w, s0, start - 3600000])) };
  const players = pickRows.map(([w, s0, b]) => ({ a: w, r: L.playerResult(field, res, { start: s0, backup: b || null }) })).filter((x) => x.r.entered)
    .map(({ a, r }) => ({ a, start: r.start, jumpTo: r.jumpTo, out: r.out, survived: r.survived, rode: r.rode, jumped: r.jumped, points: r.points, ranked: true }))
    .sort((x, y) => y.points - x.points || (x.a < y.a ? -1 : 1));
  return { v: 1, day, start, week: L.weekOf(start), field, hours: hs, picks, cuts: res.cuts, standing: res.standing, winner: res.winner, done: res.done, players, ...extra };
}
const boardOf = (days, final = true, week = 3) => {
  const rows = days.flatMap((d) => d.players.map((p) => ({ player: p.a, points: p.points, rode: p.rode, jumped: p.jumped, ranked: p.ranked })));
  const rk = new Set(rows.filter((x) => x.ranked).map((x) => x.player));
  const view = L.places(L.board(rows)).map((x) => ({ a: x.player, place: x.place, pts: x.pts, rides: x.rides, jumps: x.jumps, events: x.events, ranked: rk.has(x.player) }));
  return { v: 1, updated: "x", today: { rows: [] }, week: { rows: [] }, lastWeek: { week, start: L.weekStart(week), final, rows: view }, allTime: { rows: [] } };
};
const PICKS = [[P1, WINNER], [P2, WINNER], [P4, CUT_ORDER[4]], [P3, CUT_ORDER[2]]];
const dayW3 = dayFile("2026-11-10", PICKS);
const brd = boardOf([dayW3]);
const vgood = { game: 13, week: 3, final: true, rows: [{ player: P1, points: 15 }, { player: P2, points: 15 }, { player: P3, points: 2 }], first: [], second: [] };
const history = (b = brd, day = dayW3) => ({ "board.json": b, "D2026-11-10.json": day, "index.json": { ...idx, days: ["2026-11-10"] } });

test("the test history follows the rules: 15, 15, 4 and 2 points", () => {
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
  const diff = pub.publish({ ...history(), "index.json": { ...idx, days: ["2026-11-10"], updated: "y" }, "vault/W3.json": other });
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
  const r = pub.publish({ ...history(), "index.json": { ...idx, days: ["2026-11-10"], updated: "z" }, "vault/W3.json": { ...vgood, rows: [{ player: P1, points: 255 }] } });
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
  const more = pub.publish({ "D2026-11-10.json": dayW3, "board.json": brd, "index.json": { ...idx, days: ["2026-11-10"] } });
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

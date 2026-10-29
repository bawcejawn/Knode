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

test("audit LN-1: only last week's file, only inside its window, only the final board's players in the board's order", () => {
  for (const w of [0, 1, 2, 4, 5, 9999]) assert.equal(shapeOk(vaultDir({ ...good, week: w }, `W${w}.json`)), false, `week ${w} while week 3 is last week`);
  assert.equal(shapeOk(vaultDir(good), AT(4, 11)), false, "before the week is final (12 h)");
  assert.equal(shapeOk(vaultDir(good), AT(4, 12)), true, "from 12 h");
  assert.equal(shapeOk(vaultDir(good), AT(4, 72.5)), true, "a little leeway past 3 days for the runner's clock");
  assert.equal(shapeOk(vaultDir(good), AT(4, 73.5)), false, "after the Vault's 3 days");
  assert.equal(shapeOk(vaultDir(good), AT(5, 13)), false, "a week later, the file is two weeks old");
  assert.equal(shapeOk(vaultDir({ ...good, rows: [...good.rows, { player: A("Z"), points: 1 }] })), false, "a wallet not on the board");
  assert.equal(shapeOk(vaultDir({ ...good, rows: [{ player: P3, points: 9 }, { player: P1, points: 2 }] })), false, "rows out of the board's order");
  assert.equal(shapeOk(vaultDir(good, "W3.json", board(3, [brow(P1, 1, 9), brow(P2, 1, 9), brow(P3, 3, 2)], false))), false, "board's last week not final");
  assert.equal(shapeOk(vaultDir(good, "W3.json", board(2, [brow(P1, 1, 9), brow(P2, 1, 9), brow(P3, 3, 2)]))), false, "board's last week is another week");
  // A staked subset that skips some board players is fine.
  assert.equal(shapeOk(vaultDir({ ...good, rows: [{ player: P2, points: 9 }, { player: P4, points: 4 }] })), true);
  // No rows while the board has scoring players: checked, but listed to skip (not published).
  const e = shapeRun(vaultDir({ ...good, rows: [] }));
  assert.equal(e.ok, true); assert.equal(e.skip, "W3.json\n");
  const e2 = shapeRun(vaultDir({ ...good, rows: [] }, "W3.json", board(3, [])));
  assert.equal(e2.ok, true); assert.equal(e2.skip, "", "nobody scored: an empty file is right");
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
    publish(files) {
      const t = path.join(root, `run${++n}`), IN = path.join(t, "incoming");
      fs.mkdirSync(path.join(IN, "lastnode", "vault"), { recursive: true });
      for (const [k, v] of Object.entries(files)) fs.writeFileSync(path.join(IN, "lastnode", k), typeof v === "string" ? v : JSON.stringify(v));
      const r = spawnSync("bash", ["-c", publishScript()], { cwd: t, env: { ...env, IN, RUNNER_TEMP: t }, encoding: "utf8" });
      return { status: r.status, out: r.stdout + r.stderr };
    },
    show: (name) => { try { return execFileSync("git", ["--git-dir", remote, "show", `games-data:lastnode/${name}`], { env, encoding: "utf8" }); } catch { return null; } },
  };
}
const idx = { v: 1, updated: "x", days: [], contract: null, game: 13 };
const brd = board(3, [brow(P1, 1, 9), brow(P2, 1, 9), brow(P4, 3, 4), brow(P3, 4, 2)]);

linux("audit LN-1: the publish step refuses a planted week, keeps a published file, and fails loudly on a different copy", () => {
  const pub = publisher();
  const planted = pub.publish({ "index.json": idx, "board.json": brd, "vault/W9.json": { ...good, week: 9 } });
  assert.notEqual(planted.status, 0); assert.match(planted.out, /W9.json: only last week's file/); assert.equal(pub.show("vault/W9.json"), null, "nothing published from a run with a planted week");
  assert.equal(pub.show("index.json"), null);
  const first = pub.publish({ "index.json": idx, "board.json": brd, "vault/W3.json": good });
  assert.equal(first.status, 0, first.out); assert.deepEqual(JSON.parse(pub.show("vault/W3.json")), good);
  const same = pub.publish({ "index.json": idx, "board.json": brd, "vault/W3.json": good });
  assert.equal(same.status, 0, same.out);
  const other = { ...good, rows: [{ player: P1, points: 9 }] };
  const diff = pub.publish({ "index.json": { ...idx, updated: "y" }, "board.json": brd, "vault/W3.json": other });
  assert.notEqual(diff.status, 0, "a different copy fails the run"); assert.match(diff.out, /::error::Already published, and this run's copy is DIFFERENT/);
  assert.deepEqual(JSON.parse(pub.show("vault/W3.json")), good, "the published file is kept");
  assert.equal(JSON.parse(pub.show("index.json")).updated, "y", "the rest of the run is still published");
});

linux("audit LN-1/LN-2: a file with no rows while the board has scoring players is not published", () => {
  const pub = publisher();
  const r = pub.publish({ "index.json": idx, "board.json": brd, "vault/W3.json": { ...good, rows: [] } });
  assert.equal(r.status, 0, r.out); assert.match(r.out, /has no rows while last week's board has scoring players; not published/);
  assert.equal(pub.show("vault/W3.json"), null); assert.ok(pub.show("board.json"));
  const later = pub.publish({ "index.json": idx, "board.json": brd, "vault/W3.json": good });
  assert.equal(later.status, 0, later.out); assert.deepEqual(JSON.parse(pub.show("vault/W3.json")), good, "the real file still gets in later");
});

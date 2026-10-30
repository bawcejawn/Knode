// Repo Lense round 7, reviewer H-K: failing tests (node:test). NOT RUN HERE (static review).
// Place in tests/audit/repolens-r6-publish/ next to repolens-r6-publish.test.mjs and run like it (tsx loader, APP=.).
// H-K-1 drives the REAL recorder (bot/games/blockx.ts run) and the REAL publish step cut from games.yml.
// H-K-2 drives the REAL race publish check cut from race.yml.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { spawnSync } from "node:child_process";

const APP = process.env.APP || process.cwd();
const { run } = await import(path.resolve(APP, "bot/games/blockx.ts"));
const M = globalThis.KRaceMath, X = globalThis.KBlockX;
const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const BIG = "1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", MID = "1BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", SMALL = "1CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const ALICE = "1DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD";
const W3 = M.weekStart(3), H0 = 48_000_000;
const T = (h) => W3 + 3600000 + (h - H0) * 3000;
const blockOf = async (_n, h) => ({ signer: (h / X.ROUND) % 3 === 0 ? MID : BIG, time: T(h) });
const picksOf = async (_n, r) => [{ player: ALICE, producer: MID, time: T(r * X.ROUND) - 3600000 }];
const rankedOf = async (who) => new Set(who);
const CARD = { at: 0, c: 1, blocksPerRace: 7200, fairness: null, field: [{ a: BIG, vhp: 2000, k: 600, h: 1 }, { a: MID, vhp: 1000, k: 300, h: 2 }], paddock: [{ a: SMALL, vhp: 10, k: 3 }] };
function raceDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "hk-race-"));
  for (const w of [2, 3, 4]) {
    const races = [];
    for (let t = M.weekStart(w); t < M.weekStart(w + 1); t += M.RACE) races.push({ id: M.raceId(M.raceIndex(t)), start: t, end: t + M.RACE, cards: Array.from({ length: 6 }, (_, l) => ({ ...CARD, samples: 36, at: t + l * 3600000 + 37 * 60000 })), result: null });
    fs.writeFileSync(path.join(d, `W${String(w).padStart(3, "0")}.json`), JSON.stringify({ v: 1, week: w, start: M.weekStart(w), end: M.weekStart(w + 1), races }));
  }
  return d;
}
const quiet = async (f) => { const l = console.log; console.log = () => {}; try { return await f(); } finally { console.log = l; } };
function publishScript() {
  const y = fs.readFileSync(path.join(APP, ".github/workflows/games.yml"), "utf8").split("\n");
  const s = y.findIndex((l) => l.includes("Push games-data (and nothing else)"));
  const a = y.findIndex((l, i) => i > s && l.trim() === "set -euo pipefail"), e = y.findIndex((l, i) => i > a && l.includes('echo "Games files published."'));
  return y.slice(a, e + 1).map((l) => l.slice(10)).join("\n")
    .replace(/^remote=.*$/m, 'remote="$REMOTE"').replace(/^git init -q work && cd work$/m, 'cd "$(mktemp -d)" && git init -q work && cd work')
    .replace("/usr/bin/python3 - ", "python3 -I - ");
}
function world() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "hk-")), remote = path.join(d, "r.git");
  spawnSync("git", ["init", "-q", "--bare", remote]);
  const sh = path.join(d, "publish.sh"); fs.writeFileSync(sh, publishScript());
  const race = raceDir(); let n = 0;
  const show = (f) => spawnSync("git", ["--git-dir", remote, "show", `games-data:blockx/${f}`], { encoding: "utf8" });
  const prev = () => {
    const p = fs.mkdtempSync(path.join(d, "prev-"));
    const ls = spawnSync("git", ["--git-dir", remote, "ls-tree", "--name-only", "games-data:blockx"], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);
    for (const f of ls) if (/^(index|board|W\d{3}|P\d{3})\.json$/.test(f)) fs.writeFileSync(path.join(p, f), show(f).stdout);
    return p;
  };
  const record = async (lib) => {
    const inn = path.join(d, `in${n++}`), out = path.join(inn, "blockx");
    const head = { height: lib + 60, time: T(lib + 60), lib };
    await quiet(() => run({ p: "main", check: "check", out, prev: prev(), raceDir: race, picksContract: "1PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP", blockOf, picksOf, rankedOf, head }));
    return { inn, out, now: head.time };
  };
  const publish = (inn, now) => spawnSync("bash", [sh], { env: { ...ENV, IN: inn, REMOTE: remote, CHECK_NOW_MS: String(now) }, encoding: "utf8" });
  return { record, publish, show };
}

// H-K-1: an address field holding a JSON NUMBER whose digits look like an address (1 then 25-34 base58 digits) passes
// `addr.fullmatch(str(x))`; the recorder reads it as a double and writes 1.111...e+27 back, so every later honest run
// "changes a published target" (and fails the shape check) until the week leaves the recorder's view.
for (const where of ["signer", "pick player", "pick producer"]) {
  test(`H-K-1: a numeric ${where} on a new round can't stall the honest runs after it`, async () => {
    const w = world();
    let r = await w.record(H0 + 6 * X.ROUND + 50);
    assert.equal(w.publish(r.inn, r.now).status, 0);
    const before = JSON.parse(w.show("W003.json").stdout).targets.map((t) => t.round);
    r = await w.record(H0 + 7 * X.ROUND + 50);
    const f = path.join(r.out, "W003.json"), j = JSON.parse(fs.readFileSync(f, "utf8"));
    const t = j.targets.find((x) => !before.includes(x.round) && !x.void && x.picks.length);
    assert.ok(t, "setup: the run has a new scored round");
    const MARK = "@@NUM@@";
    if (where === "signer") t.signer = MARK; else if (where === "pick player") t.picks[0][0] = MARK; else t.picks[0][1] = MARK;
    fs.writeFileSync(f, JSON.stringify(j).replace(`"${MARK}"`, "1111111111111111111111111111"));
    w.publish(r.inn, r.now);                                   // the bad run (published today)
    r = await w.record(H0 + 8 * X.ROUND + 50);
    const p = w.publish(r.inn, r.now);
    assert.equal(p.status, 0, "an honest run after the bad one must publish: " + p.stdout + p.stderr);
  });
}

// H-K-2: the race publish check (race.yml) still takes integers up to 1e16 in card numbers. A NEW card (its leg was
// null on the branch) with c = 2^53 + 1 passes; the race recorder keeps published cards and writes 2^53 back, so every
// later honest race run fails "a published card would change" until the week leaves its view (no cards: Block X
// targets wait, then void).
function raceCheck() {
  const y = fs.readFileSync(path.join(APP, ".github/workflows/race.yml"), "utf8").split("\n");
  const a = y.findIndex((l) => l.includes("/usr/bin/python3 - \"$IN\" \"$RUNNER_TEMP/published\" <<'PY'"));
  const e = y.findIndex((l, i) => i > a && l.trim() === "PY");
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hk-rc-")), "check.py");
  fs.writeFileSync(f, y.slice(a + 1, e).map((l) => l.slice(10)).join("\n"));
  return f;
}
test("H-K-2: the race publish check refuses card numbers the recorder can't round-trip (above 2^53 - 1)", () => {
  const chk = raceCheck(), pub = fs.mkdtempSync(path.join(os.tmpdir(), "hk-rp-")), inn = fs.mkdtempSync(path.join(os.tmpdir(), "hk-ri-"));
  const w = 3, races = [];
  for (let t = M.weekStart(w); t < M.weekStart(w + 1); t += M.RACE) races.push({ id: M.raceId(M.raceIndex(t)), start: t, end: t + M.RACE, cards: Array(6).fill(null), result: null });
  const file = { v: 1, week: w, start: M.weekStart(w), end: M.weekStart(w + 1), races };
  fs.writeFileSync(path.join(pub, "W003.json"), JSON.stringify(file));
  races[0].cards[0] = { ...CARD, samples: 36, at: races[0].start + 60000, c: "@@C@@" };
  fs.writeFileSync(path.join(inn, "W003.json"), JSON.stringify(file).replace('"@@C@@"', "9007199254740993"));
  const p = spawnSync("python3", ["-I", chk, inn, pub], { encoding: "utf8" });
  assert.notEqual(p.status, 0, "a card number above 2^53 - 1 must be refused before it is published: " + p.stdout + p.stderr);
});

// Owner's round-7 blind review: Python's == says True == 1 and 3.0 == 3; the recorders use ===. So a bad run's file
// header (v, week, game) or a published card typed differently, or races out of order, could make the recorder see
// "no file" and every honest run after it a rewrite. Each is refused before it is published.
for (const [what, edit] of [["v: true", (j) => { j.v = true; }], ["week: 3.5", (j) => { j.week = 3.5; }], ["game: true", (j) => { j.game = true; }]]) {
  test(`review: a Block X week file with ${what} is refused, and the honest run after it publishes`, async () => {
    const w = world();
    let r = await w.record(H0 + 6 * X.ROUND + 50);
    assert.equal(w.publish(r.inn, r.now).status, 0);
    r = await w.record(H0 + 7 * X.ROUND + 50);
    const f = path.join(r.out, "W003.json"), j = JSON.parse(fs.readFileSync(f, "utf8")); edit(j); fs.writeFileSync(f, JSON.stringify(j));
    assert.notEqual(w.publish(r.inn, r.now).status, 0, "refused");
    r = await w.record(H0 + 8 * X.ROUND + 50);
    const p = w.publish(r.inn, r.now);
    assert.equal(p.status, 0, p.stdout + p.stderr);
  });
}
test("review: the race check refuses v: true, a fractional week, swapped or repeated race ids, and a card re-typed (1 -> true)", () => {
  const chk = raceCheck();
  const w = 3, mk = () => { const races = []; for (let t = M.weekStart(w); t < M.weekStart(w + 1); t += M.RACE) races.push({ id: M.raceId(M.raceIndex(t)), start: t, end: t + M.RACE, cards: Array(6).fill(null), result: null }); return { v: 1, week: w, start: M.weekStart(w), end: M.weekStart(w + 1), races }; };
  const check = (inFile, pubFile) => { const pub = fs.mkdtempSync(path.join(os.tmpdir(), "rv-p-")), inn = fs.mkdtempSync(path.join(os.tmpdir(), "rv-i-"));
    if (pubFile) fs.writeFileSync(path.join(pub, "W003.json"), JSON.stringify(pubFile));
    fs.writeFileSync(path.join(inn, "W003.json"), JSON.stringify(inFile));
    return spawnSync("python3", ["-I", chk, inn, pub], { encoding: "utf8" }).status; };
  assert.equal(check(mk(), mk()), 0, "setup: an honest file passes");
  let f = mk(); f.v = true; assert.notEqual(check(f), 0, "v: true");
  f = mk(); f.week = 3.0000001; assert.notEqual(check(f), 0, "fractional week");
  f = mk(); [f.races[0].id, f.races[1].id] = [f.races[1].id, f.races[0].id]; assert.notEqual(check(f), 0, "swapped ids");
  f = mk(); f.races[1].id = f.races[0].id; assert.notEqual(check(f), 0, "repeated id");
  const pub = mk(); pub.races[0].cards[0] = { ...CARD, samples: 36, at: pub.races[0].start + 60000 };
  f = mk(); f.races[0].cards[0] = { ...CARD, samples: 36, at: pub.races[0].start + 60000, c: true };
  assert.notEqual(check(f, pub), 0, "a published card re-typed");
});

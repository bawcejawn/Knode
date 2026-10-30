// Audit BX-88 (Repo Lens round 5, "the W-file route"): the behaviour test the round-5 README asks for, against the REAL
// recorder (bot/games/blockx.ts run) and the REAL publish step of .github/workflows/games.yml (cut from the YAML).
//   1. the recorder records week 3; the publish step publishes it (W003 with honest targets);
//   2. a later honest run (PREV taken from the branch) publishes again: honest runs never change a published target;
//   3. a bad run rewrites W003 (same rounds, Alice's correct picks scored 0, wallet Z given the points): the publish step
//      refuses the whole run with an alert, and the branch keeps the honest W003 and board;
//   4. the recorder, with PREV taken from the branch after week 3 ends, scores Alice.
// Needs bash, git and python3 (Linux, WSL or GitHub Actions). Run: APP=. node --import tsx --test this file
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { spawnSync } from "node:child_process";

const APP = process.env.APP || process.cwd();
const { run } = await import(path.resolve(APP, "bot/games/blockx.ts"));
const M = globalThis.KRaceMath, X = globalThis.KBlockX;
const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

const BIG = "1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", MID = "1BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", SMALL = "1CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const ALICE = "1DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD", BOB = "1EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE", Z = "1ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ";
const W3 = M.weekStart(3), H0 = 48_000_000;
const T = (h) => W3 + 3600000 + (h - H0) * 3000;
const signerOf = (h) => ((h / X.ROUND) % 3 === 0 ? MID : BIG);
const blockOf = async (_node, h) => ({ signer: signerOf(h), time: T(h) });
const picksOf = async (_node, r) => {
  const t = T(r * X.ROUND) - 3600000;
  return [{ player: ALICE, producer: MID, time: t }, { player: BOB, producer: BIG, time: t }];
};
const rankedOf = async (who) => new Set(who);
const CARD = { at: 0, c: 1, blocksPerRace: 7200, fairness: null, field: [{ a: BIG, vhp: 2000, k: 600, h: 1 }, { a: MID, vhp: 1000, k: 300, h: 2 }], paddock: [{ a: SMALL, vhp: 10, k: 3 }] };
function raceDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "bx88-race-"));
  for (const w of [2, 3, 4]) {
    const races = [];
    for (let t = M.weekStart(w); t < M.weekStart(w + 1); t += M.RACE) races.push({ id: M.raceId(M.raceIndex(t)), start: t, end: t + M.RACE, cards: Array.from({ length: 6 }, (_, l) => ({ ...CARD, samples: 36, at: t + l * 3600000 + 37 * 60000 })), result: null });
    fs.writeFileSync(path.join(d, `W${String(w).padStart(3, "0")}.json`), JSON.stringify({ v: 1, week: w, start: M.weekStart(w), end: M.weekStart(w + 1), races }));
  }
  return d;
}
const quiet = async (f) => { const log = console.log; console.log = () => {}; try { return await f(); } finally { console.log = log; } };

function publishScript() {
  const y = fs.readFileSync(path.join(APP, ".github/workflows/games.yml"), "utf8").split("\n");
  const s = y.findIndex((l) => l.includes("Push games-data (and nothing else)"));
  const a = y.findIndex((l, i) => i > s && l.trim() === "set -euo pipefail"), e = y.findIndex((l, i) => i > a && l.includes('echo "Games files published."'));
  return y.slice(a, e + 1).map((l) => l.slice(10)).join("\n")
    .replace(/^remote=.*$/m, 'remote="$REMOTE"').replace(/^git init -q work && cd work$/m, 'cd "$(mktemp -d)" && git init -q work && cd work')
    .replace("/usr/bin/python3 - ", "python3 -I - ");
}

test("BX-88: a rewritten published week file is refused whole, and the recorder then scores the honest targets", async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "bx88-")), remote = path.join(d, "r.git");
  spawnSync("git", ["init", "-q", "--bare", remote]);
  const sh = path.join(d, "publish.sh"); fs.writeFileSync(sh, publishScript());
  const race = raceDir();
  let n = 0;
  const record = async (lib, prev) => {
    const inn = path.join(d, `in${n++}`), out = path.join(inn, "blockx");
    const head = { height: lib + 60, time: T(lib + 60), lib };
    await quiet(() => run({ p: "main", check: "check", out, prev, raceDir: race, picksContract: "1PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP", blockOf, picksOf, rankedOf, head }));
    return { inn, out, now: head.time };
  };
  const publish = (inn, now) => spawnSync("bash", [sh], { env: { ...ENV, IN: inn, REMOTE: remote, CHECK_NOW_MS: String(now) }, encoding: "utf8" });
  const show = (f) => spawnSync("git", ["--git-dir", remote, "show", `games-data:blockx/${f}`], { encoding: "utf8" });
  const branchPrev = () => {
    const p = fs.mkdtempSync(path.join(d, "prev-"));
    const ls = spawnSync("git", ["--git-dir", remote, "ls-tree", "--name-only", "games-data:blockx"], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);
    for (const f of ls) if (/^(index|board|W\d{3}|P\d{3})\.json$/.test(f)) fs.writeFileSync(path.join(p, f), show(f).stdout);
    return p;
  };

  // 1. honest week 3, published
  const r1 = await record(H0 + 6 * X.ROUND + 50);
  let p = publish(r1.inn, r1.now);
  assert.equal(p.status, 0, p.stdout + p.stderr);
  const honest = JSON.parse(show("W003.json").stdout);
  assert.ok(honest.targets.length >= 6 && honest.targets.some((t) => t.signer === MID));

  // 2. a later honest run, PREV from the branch: published targets kept exactly, the run is published
  const r2 = await record(H0 + 9 * X.ROUND + 50, branchPrev());
  p = publish(r2.inn, r2.now);
  assert.equal(p.status, 0, "an honest run must pass the append-only check: " + p.stdout + p.stderr);
  const after2 = JSON.parse(show("W003.json").stdout);
  for (const t of honest.targets) assert.deepEqual(after2.targets.find((x) => x.round === t.round), t);

  // 3. a bad run: same rounds, Alice's correct picks scored 0 and Z given the points
  const r3 = await record(H0 + 10 * X.ROUND + 50, branchPrev());
  const wf = JSON.parse(fs.readFileSync(path.join(r3.out, "W003.json"), "utf8"));
  for (const t of wf.targets) t.picks = t.picks.map((x) => (x[0] === ALICE && x[3] > 0 ? [ALICE, x[1], x[2], 0, x[4]] : x)).concat(t.signer === MID ? [[Z, MID, t.time - 3600000, 200, 1]] : []);
  fs.writeFileSync(path.join(r3.out, "W003.json"), JSON.stringify(wf));
  const boardBefore = show("board.json").stdout;
  p = publish(r3.inn, r3.now);
  assert.notEqual(p.status, 0, "the job must fail (alert) on a run that changes a published target");
  assert.match(p.stdout, /BX-88/);
  assert.deepEqual(JSON.parse(show("W003.json").stdout).targets, after2.targets, "the published W003 is not replaced");
  assert.equal(show("board.json").stdout, boardBefore, "nothing built from the rewritten week file is published");

  // 4. after week 3 ends (and its 12-hour correction window), the recorder with PREV from the branch scores Alice
  const end = M.weekStart(4) + 13 * 3600000;
  const libEnd = H0 + Math.floor((end - T(H0)) / 3000) - 60;
  const r4 = await record(libEnd, branchPrev());
  const board = JSON.parse(fs.readFileSync(path.join(r4.out, "board.json"), "utf8"));
  assert.equal(board.lastWeek.week, 3);
  const alice = board.lastWeek.rows.find((x) => x.a === ALICE);
  assert.ok(alice && alice.pts > 0, "Alice's correct picks are scored");
  assert.ok(!board.lastWeek.rows.some((x) => x.a === Z), "Z is not on the board");
});

// Blind review of round 5 (#1, #2): new rounds must be real past target blocks of the file's week, so a bad run can't
// pre-publish a round the honest recorder would then keep (#1), nor one it would drop on load and so hold every later
// honest run (#2); and no week file for a future week.
test("BX-88 (review): a bad run can't pre-publish a future round, a round at a wrong height, or next week's file", async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "bx88r-")), remote = path.join(d, "r.git");
  spawnSync("git", ["init", "-q", "--bare", remote]);
  const sh = path.join(d, "publish.sh"); fs.writeFileSync(sh, publishScript());
  const race = raceDir();
  const lib = H0 + 6 * X.ROUND + 50, now = T(lib + 60);
  const fresh = async () => {
    const inn = fs.mkdtempSync(path.join(d, "in-")), out = path.join(inn, "blockx");
    await quiet(() => run({ p: "main", check: "check", out, raceDir: race, picksContract: "1PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP", blockOf, picksOf, rankedOf, head: { height: lib + 60, time: now, lib } }));
    return { inn, out };
  };
  const publish = (inn) => spawnSync("bash", [sh], { env: { ...ENV, IN: inn, REMOTE: remote, CHECK_NOW_MS: String(now) }, encoding: "utf8" });
  const show = (f) => spawnSync("git", ["--git-dir", remote, "show", `games-data:blockx/${f}`], { encoding: "utf8" });
  const edit = (out, f, fn) => { const p = path.join(out, f), j = JSON.parse(fs.readFileSync(p, "utf8")); fn(j); fs.writeFileSync(p, JSON.stringify(j)); };
  const last = (j) => j.targets[j.targets.length - 1];

  // a round three rounds ahead of the head (its block doesn't exist yet), Z given 300
  let r = await fresh();
  edit(r.out, "W003.json", (j) => { const t = last(j); j.targets.push({ ...t, round: t.round + 3, height: (t.round + 3) * X.ROUND, time: t.time + 3 * X.ROUND * 3000, picks: [[Z, MID, t.time, 300, 1]] }); });
  let p = publish(r.inn);
  assert.notEqual(p.status, 0); assert.match(p.stdout, /aren't past target blocks/);
  assert.notEqual(show("W003.json").status, 0, "nothing from that run is published");

  // a past round at a height that isn't its target height (the recorder would drop it on load)
  r = await fresh();
  edit(r.out, "W003.json", (j) => { const t = j.targets[0]; j.targets.unshift({ ...t, round: t.round - 1, height: (t.round - 1) * X.ROUND + 7, time: t.time - X.ROUND * 3000 }); });
  p = publish(r.inn);
  assert.notEqual(p.status, 0); assert.match(p.stdout, /aren't past target blocks/);

  // next week's file
  r = await fresh();
  const w3 = JSON.parse(fs.readFileSync(path.join(r.out, "W003.json"), "utf8"));
  fs.writeFileSync(path.join(r.out, "W004.json"), JSON.stringify({ ...w3, week: 4, start: w3.start + 7 * 86400000, end: w3.end + 7 * 86400000 }));
  p = publish(r.inn);
  assert.notEqual(p.status, 0); assert.match(p.stdout, /isn't this one or an earlier one/);

  // the honest run still publishes
  r = await fresh();
  p = publish(r.inn);
  assert.equal(p.status, 0, p.stdout + p.stderr);
  assert.equal(show("W003.json").status, 0);
});

// Blind review of round 5 (#3): a non-canonical VHP transfer into the signer voids that target in the SAME run (with
// its reason), instead of holding it for 3 days (which could push a week past the vault's window).
test("BX-72 (review): a non-canonical transfer into the signer voids the target at once, with its reason", async () => {
  const lib = H0 + 4 * X.ROUND + 50;
  const { NonCanonicalTransfer } = await import(path.resolve(APP, "bot/games/blockx.ts"));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "bx72v-"));
  const r = await quiet(() => run({ p: "main", check: "check", out, raceDir: raceDir(), picksContract: "1PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP", blockOf, picksOf, rankedOf,
    vhpMovesOf: async () => { throw new NonCanonicalTransfer("a VHP transfer to X isn't in the standard encoding (unexpected fields)"); },
    head: { height: lib + 60, time: T(lib + 60), lib } }));
  const ts = r.weeks.get(3).targets;
  assert.ok(ts.length >= 4);
  for (const t of ts) {
    assert.match(t.void || "", /standard encoding.*no points/);
    assert.ok(t.picks.every((x) => x[3] === 0));
  }
});

test("the mainnet publish check is given Block X's own round size and offset (blockx-math.js MAINNET_GAME)", () => {
  const y = fs.readFileSync(path.join(APP, ".github/workflows/games.yml"), "utf8");
  const G = globalThis.KBlockX.forGame ? globalThis.KBlockX.forGame() : null;
  const m = /python3 - "\$IN\/blockx" 2 "\$PUB\/blockx" "\$HELD" blockx (\d+) (\d+) <<'PY'/.exec(y);
  assert.ok(m, "the round size and offset are passed");
  assert.equal(Number(m[1]), G ? G.ROUND : X.ROUND); assert.equal(Number(m[2]), G ? G.OFFSET : 0);
});

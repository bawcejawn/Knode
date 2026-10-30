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

// G-K failing tests (node:test). NOT RUN HERE (static review). Needs bash, git, python3, node 22 + tsx.
// Run from a repo checkout: APP=. node --import tsx --test g-k-publish.test.mjs
// Each test drives the REAL recorder (bot/games/blockx.ts run) and/or the REAL publish step cut from games.yml.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { spawnSync } from "node:child_process";

const APP = process.env.APP || process.cwd();
const { run } = await import(path.resolve(APP, "bot/games/blockx.ts"));
const M = globalThis.KRaceMath, X = globalThis.KBlockX;
const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const BIG = "1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", MID = "1BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", SMALL = "1CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const ALICE = "1DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD", Z = "1ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ";
const W3 = M.weekStart(3), H0 = 48_000_000;
const T = (h) => W3 + 3600000 + (h - H0) * 3000;
const blockOf = async (_n, h) => ({ signer: (h / X.ROUND) % 3 === 0 ? MID : BIG, time: T(h) });
const picksOf = async (_n, r) => [{ player: ALICE, producer: MID, time: T(r * X.ROUND) - 3600000 }];
const rankedOf = async (who) => new Set(who);
const CARD = { at: 0, c: 1, blocksPerRace: 7200, fairness: null, field: [{ a: BIG, vhp: 2000, k: 600, h: 1 }, { a: MID, vhp: 1000, k: 300, h: 2 }], paddock: [{ a: SMALL, vhp: 10, k: 3 }] };
function raceDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "gk-race-"));
  for (const w of [2, 3, 4]) {
    const races = [];
    for (let t = M.weekStart(w); t < M.weekStart(w + 1); t += M.RACE) races.push({ id: M.raceId(M.raceIndex(t)), start: t, end: t + M.RACE, cards: Array.from({ length: 6 }, (_, l) => ({ ...CARD, samples: 36, at: t + l * 3600000 + 37 * 60000 })), result: null });
    fs.writeFileSync(path.join(d, `W${String(w).padStart(3, "0")}.json`), JSON.stringify({ v: 1, week: w, start: M.weekStart(w), end: M.weekStart(w + 1), races }) + "\n");
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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "gk-")), remote = path.join(d, "r.git");
  spawnSync("git", ["init", "-q", "--bare", remote]);
  const sh = path.join(d, "publish.sh"); fs.writeFileSync(sh, publishScript());
  const race = raceDir(); let n = 0;
  const show = (f) => spawnSync("git", ["--git-dir", remote, "show", `games-data:blockx/${f}`], { encoding: "utf8" });
  const prev = () => {   // the record job's PREV step, by its name rules
    const p = fs.mkdtempSync(path.join(d, "prev-"));
    const ls = spawnSync("git", ["--git-dir", remote, "ls-tree", "--name-only", "games-data:blockx"], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);
    for (const f of ls) if (/^(index|board|W\d{3}|P\d{3})\.json$/.test(f)) fs.writeFileSync(path.join(p, f), show(f).stdout);
    return p;
  };
  const record = async (lib, withPrev = true) => {
    const inn = path.join(d, `in${n++}`), out = path.join(inn, "blockx");
    const head = { height: lib + 60, time: T(lib + 60), lib };
    await quiet(() => run({ p: "main", check: "check", out, prev: withPrev ? prev() : undefined, raceDir: race, picksContract: "1PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP", blockOf, picksOf, rankedOf, head }));
    return { inn, out, now: head.time };
  };
  const publish = (inn, now) => spawnSync("bash", [sh], { env: { ...ENV, IN: inn, REMOTE: remote, CHECK_NOW_MS: String(now) }, encoding: "utf8" });
  const edit = (out, f, fn) => { const p = path.join(out, f), j = JSON.parse(fs.readFileSync(p, "utf8")); fn(j); fs.writeFileSync(p, JSON.stringify(j) + "\n"); };
  return { record, publish, show, edit };
}

// G-K-1: the publish job doesn't tie a new round's height to its block time, so a FUTURE round with a past time passes,
// and the honest recorder then never records the real one.
// (Owner's copy: BX-97 is "before prizes" in the auditor's classes. A neighbour-time rule in the publish job let one bad
// run, or an honest void row, hold every later honest run (round-6 blind review), so the fix is the week-end re-read of
// every target on both nodes, before Vault v6 prizes. Kept here as a todo until then.)
test("G-K-1: a bad run can't pre-publish a future round by giving it a past block time", { todo: "before prizes: the week-end re-read (BX-97)" }, async () => {
  const w = world();
  const r1 = await w.record(H0 + 6 * X.ROUND + 50);
  assert.equal(w.publish(r1.inn, r1.now).status, 0);
  const r2 = await w.record(H0 + 7 * X.ROUND + 50);
  w.edit(r2.out, "W003.json", (j) => { const t = j.targets[j.targets.length - 1];
    j.targets.push({ ...t, round: t.round + 20, height: (t.round + 20) * X.ROUND, time: t.time - 60000, picks: [[Z, t.signer, t.time - 3600000, 300, 1]] }); });
  const p = w.publish(r2.inn, r2.now);
  assert.notEqual(p.status, 0, "a round 20 rounds (~40 h) ahead of the newest published one can't have a block time before it: " + p.stdout);
  assert.ok(!JSON.parse(w.show("W003.json").stdout).targets.some((t) => t.picks.some((x) => x[0] === Z)));
});

// G-K-2: one bad run publishes a new round with an integer above 2^53 (lockTime): Python keeps it exactly, the recorder
// (JavaScript) reads 2^53 and writes that back, so every later HONEST run is held whole, every hour, until the week
// leaves the recorder's two-week view (nothing published: targets past 3 days are lost; P and vault miss their windows).
test("G-K-2: after a bad run, honest runs still publish (no number the recorder can't round-trip gets onto the branch)", async () => {
  const w = world();
  const r1 = await w.record(H0 + 6 * X.ROUND + 50);
  assert.equal(w.publish(r1.inn, r1.now).status, 0);
  const r2 = await w.record(H0 + 7 * X.ROUND + 50);
  w.edit(r2.out, "W003.json", (j) => { const t = j.targets[0]; j.targets.unshift({ ...t, round: t.round - 1, height: (t.round - 1) * X.ROUND, time: t.time - X.ROUND * 3000, lockTime: 9007199254740993 }); });
  // (JSON.stringify can't write 2^53+1; put the exact digits in)
  const f = path.join(r2.out, "W003.json"); fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace("9007199254740992", "9007199254740993"));
  w.publish(r2.inn, r2.now);
  const r3 = await w.record(H0 + 8 * X.ROUND + 50);
  const p = w.publish(r3.inn, r3.now);
  assert.equal(p.status, 0, "an honest run after the bad one must publish: " + p.stdout);
});

// G-K-3: after a week is final and its P file published, a bad run may still add a NEW round to that week; the vault
// file (written after P) then counts it. Fixed when the publish job takes no new round for a week whose P is published.
test("G-K-3: no new round for a week whose prize file is published", async () => {
  const w = world();
  let r = await w.record(H0 + 6 * X.ROUND + 50);
  assert.equal(w.publish(r.inn, r.now).status, 0);
  // week 3 ends; let the recorder make it final and publish board then P (as the honest path does)
  const lib = (t) => H0 + Math.floor((t - T(H0)) / 3000) - 60;
  // (Owner's copy: the whole week must be recorded before it can be final, so the honest recorder runs through it,
  // 12 rounds a run, as blockx-recorder.test.mjs does; the auditor's two runs never made week 3 final.)
  const startH = H0 - 1200, endH = startH + 7 * 28800;
  for (let h = startH + 12 * X.ROUND; h <= endH + 4 * X.ROUND; h += 12 * X.ROUND) { r = await w.record(h); assert.equal(w.publish(r.inn, r.now).status, 0, "honest run"); }
  for (const h of [13, 14]) { r = await w.record(lib(M.weekStart(4) + h * 3600000)); w.publish(r.inn, r.now); }
  assert.equal(w.show("P003.json").status, 0, "setup: P003 is published");
  r = await w.record(lib(M.weekStart(4) + 15 * 3600000));
  fs.rmSync(path.join(r.out, "vault"), { recursive: true, force: true });
  w.edit(r.out, "W003.json", (j) => { const t = j.targets[0]; j.targets.push({ ...t, round: 990000, height: 990000 * X.ROUND, picks: [[Z, t.signer, t.time - 3600000, 300, 1]] }); });
  const p = w.publish(r.inn, r.now);
  assert.notEqual(p.status, 0, "a new round in a week whose P file is published must be held: " + p.stdout);
});

// G-K-4: index.json isn't append-only: one bad run that drops weeks from it drops them from every later board.
test("G-K-4: a run can't drop a published week from index.json", async () => {
  const w = world();
  let r = await w.record(H0 + 6 * X.ROUND + 50);
  assert.equal(w.publish(r.inn, r.now).status, 0);
  r = await w.record(H0 + 7 * X.ROUND + 50);
  w.edit(r.out, "index.json", (j) => { j.weeks = []; });
  w.publish(r.inn, r.now);
  assert.ok(JSON.parse(w.show("index.json").stdout).weeks.includes(3), "the published week list never loses a week");
});

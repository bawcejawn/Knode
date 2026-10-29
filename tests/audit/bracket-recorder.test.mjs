// Producer Bracket recorder (bot/games/bracket.ts): seeding once from the Saturday 12:00 card (never changed later,
// void without a card, none under 8 producers), picks only after the lock and only when both nodes agree, hours only
// once irreversible and identical on both nodes, expected blocks from exact VHP rebuilt from the chain's VHP events
// (balances read at the head and walked back), results equal to the shared math run on the same blocks, final after the
// correction window and frozen afterwards, and the leaderboards. Offline: fake nodes with a made-up VHP history.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const APP = process.env.APP || ".";
const rec = await import(path.resolve(APP, "bot/games/bracket.ts"));
const { scoreWeek, vaultRows, freeWinners } = rec;
// The Vault's stakes: unless a test says otherwise, every player is staked in the Bracket
const run = (o) => rec.run({ stakedOf: async (_n, players) => players, ...o });
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
function signerFn(field, offline = new Set(), offFrom = 0) {
  const pick = (set) => { const tot = set.reduce((s, r) => s + r.vhp, 0); return (h) => { let x = ((Math.imul(h, 2654435761) >>> 0) / 4294967296) * tot; for (const r of set) { x -= r.vhp; if (x < 0) return r.a; } return set[set.length - 1].a; }; };
  const all = pick(field), live = pick(field.filter((r) => !offline.has(r.a)));
  const f = (h) => (h >= offFrom ? live(h) : all(h));   // the offline producers stop at height offFrom
  f.field = field;
  return f;
}
// The fake chain's VHP: each producer starts with 1,000 × its card VHP (so 4 VHP burned a block stays small), every
// block burns 4 VHP of its signer's, and moves [{ h, a, d (VHP) }] add or take VHP in block h.
const BURN = 4e8, START = (r) => r.vhp * 1000 * 1e8;
let TOP = H0;                                   // the fake head (set by headAt)
function nodeOf(signer, tamper = null, { moves = [], forkAt = null, effOff = 0 } = {}) {
  const start = new Map(signer.field.map((r) => [r.a, START(r)]));
  const signed = new Map(); let upTo = H0 - 1;   // blocks signed by each producer from H0 (cached)
  const count = (a, top) => { for (let h = upTo + 1; h <= top; h++) { const s = signer(h); signed.set(s, (signed.get(s) || [])); signed.get(s).push(h); } upTo = Math.max(upTo, top); const l = signed.get(a) || []; let lo = 0, hi = l.length; while (lo < hi) { const m = (lo + hi) >> 1; if (l[m] <= top) lo = m + 1; else hi = m; } return lo; };
  return (name) => {
    const who = (h) => (name === "check" && tamper && tamper(h) ? addr(99) : signer(h));
    const id = (h) => (forkAt !== null && name === forkAt.node && h >= forkAt.h ? "fork" : "id") + h;
    return {
      async head() { throw new Error("head is given"); },
      async blockTime(h) { return T(h); },
      async blockId(h) { return id(h); },
      async chain(from, to) {
        // the fake chain's history starts 40,000 blocks (~33 hours) before H0: last week's bracket can't be seeded
        if (from < H0 - 40_000) throw new Error(`no block ${from} on this node`);
        const out = { hs: [], ts: [], sig: [], signers: [], ids: [], deltas: [] }, ix = new Map();
        for (let h = from; h <= to; h++) {
          const a = who(h); let i = ix.get(a); if (i === undefined) { i = out.signers.length; out.signers.push(a); ix.set(a, i); }
          out.hs.push(h); out.ts.push(T(h)); out.sig.push(i); out.ids.push(id(h));
          for (const mv of moves) if (mv.h === h) out.deltas.push({ h, a: mv.a, d: mv.d * 1e8 });
          if (h >= H0) out.deltas.push({ h, a, d: -BURN });
        }
        return out;
      },
      async balance(a) {
        const v = (start.get(a) || 0) - BURN * count(a, TOP) + moves.filter((m) => m.a === a && m.h <= TOP).reduce((t, m) => t + m.d * 1e8, 0);
        // the contract's effective balance for the next block: minus what arrived in the last 19 blocks
        const eff = Math.max(0, v - moves.filter((m) => m.a === a && m.d > 0 && m.h > TOP - 19 && m.h <= TOP).reduce((t, m) => t + m.d * 1e8, 0)) + effOff;
        return { v, eff, h: TOP, id: "id" + TOP };
      },
    };
  };
}
const headAt = (t) => { const h = { height: hAt(t) + 20, time: t + 60000, lib: hAt(t), libTime: T(hAt(t)) }; TOP = h.height; return h; };
function raceDir(field, { skip = () => false, results = null } = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "race-"));
  const card = (at) => ({ at, c: 0, blocksPerRace: 7200, fairness: null, field: field.map((r) => ({ ...r, k: 7200 * r.vhp / field.reduce((s, x) => s + x.vhp, 0), h: 1 })), paddock: [] });
  for (const w of [W - 1, W, W + 1]) {
    const races = [];
    for (let t = M.weekStart(w); t < M.weekStart(w + 1); t += M.RACE) { const i = M.raceIndex(t); races.push({ id: M.raceId(i), start: t, end: t + M.RACE, cards: Array.from({ length: 6 }, (_, l) => (skip(t + l * H) ? null : card(t + l * H))), result: results ? results(t) : null }); }
    fs.writeFileSync(path.join(d, `W${String(w).padStart(3, "0")}.json`), JSON.stringify({ v: 1, week: w, start: M.weekStart(w), end: M.weekStart(w + 1), races }));
  }
  return d;
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "bracket-"));
const quiet = async (f) => { const log = console.log; console.log = () => {}; try { return await f(); } finally { console.log = log; } };
const readW = (dir, w = W) => JSON.parse(fs.readFileSync(path.join(dir, `W${String(w).padStart(3, "0")}.json`), "utf8"));
const P = (i) => addr(50 + i);
// picks for week W only (other weeks: none)
function picksOf(rows, tamper = false) { return async (node, round) => (round !== B.picksRound(W) ? [] : rows.map((r, i) => ({ ...r, number: node === "check" && tamper && i === 0 ? r.number + 1 : r.number }))); }

/** Run the recorder repeatedly at time t (carrying files forward) until nothing more gets recorded. */
async function runUntil(t, o, dir, times = 40) {   // at most 6 hours a run (audit A-2)
  let last;
  for (let i = 0; i < times; i++) last = await quiet(() => run({ p: "main", check: "check", prev: dir, out: dir, head: headAt(t), ...o }));
  return last;
}

test("seeding: exact VHP averaged over the day before Saturday 12:00, on two nodes; recorded once with a hash, never changed", async () => {
  const field = fieldOf(17), dir = tmp();
  const o = { picksContract: "1P", nodeOf: nodeOf(signerFn(field)), picksOf: picksOf([]) };
  await quiet(() => run({ p: "main", check: "check", prev: dir, out: dir, head: headAt(B.seedTime(W) - H), ...o }));
  assert.ok(!fs.existsSync(path.join(dir, "W003.json")), "nothing before the seeding time");
  await quiet(() => run({ p: "main", check: "check", prev: dir, out: dir, head: headAt(B.seedTime(W) + 40 * 60000), ...o }));
  const wf = readW(dir);
  assert.equal(wf.status, "open"); assert.equal(wf.seeding.size, 16); assert.equal(wf.seeding.seeds.length, 16);
  assert.deepEqual(wf.seeding.seeds, field.slice(0, 16).map((r) => r.a)); assert.deepEqual(wf.seeding.out, [field[16].a]);
  assert.match(wf.seeding.hash, /^[0-9a-f]{64}$/); assert.equal(wf.days.length, 4);
  assert.equal(wf.seeding.cardAt, hAt(B.seedTime(W)), "the block at Saturday 12:00");
  // the average is over the day before: seed 1's average is its starting VHP less about half a day's burns
  assert.ok(wf.seeding.vhp[0] < field[0].vhp * 1000 && wf.seeding.vhp[0] > field[0].vhp * 1000 * 0.99);
  // a later run on another chain keeps the published seeding
  await quiet(() => run({ p: "main", check: "check", prev: dir, out: dir, head: headAt(B.seedTime(W) + 3 * H), ...o, nodeOf: nodeOf(signerFn(fieldOf(40))) }));
  assert.deepEqual(readW(dir).seeding, wf.seeding);
  // a tampered seeding in the last run's files is not trusted (its hash no longer matches): seeded again from the chain
  const bad = readW(dir); bad.seeding.seeds[0] = addr(77); fs.writeFileSync(path.join(dir, "W003.json"), JSON.stringify(bad));
  await quiet(() => run({ p: "main", check: "check", prev: dir, out: dir, head: headAt(B.seedTime(W) + 4 * H), ...o, nodeOf: nodeOf(signerFn(fieldOf(40))) }));
  assert.equal(readW(dir).seeding.size, 32, "re-seeded from the chain, not the tampered file");
});

test("seeding: waits while the nodes disagree and turns void after 24 hours; under 8 is no bracket; 13 has byes; 40 is a 32-bracket", async () => {
  const field = fieldOf(17), dir = tmp();
  const skew = (name) => { const n = nodeOf(signerFn(field))(name); return name === "check" ? { ...n, balance: async (a) => { const b = await n.balance(a); return { ...b, v: b.v + 1e8, eff: b.eff + 1e8 }; } } : n; };
  const o = { picksContract: "1P", nodeOf: skew, picksOf: picksOf([]) };
  const r1 = await quiet(() => run({ p: "main", check: "check", prev: dir, out: dir, head: headAt(B.seedTime(W) + H), ...o }));
  assert.ok(r1.problems.some((p) => p.includes("disagree about the seeding")));
  await quiet(() => run({ p: "main", check: "check", prev: dir, out: dir, head: headAt(B.seedTime(W) + 23 * H), ...o }));
  assert.ok(!fs.existsSync(path.join(dir, "W003.json")) || readW(dir).status !== "void", "still waiting at 23 hours");
  await quiet(() => run({ p: "main", check: "check", prev: dir, out: dir, head: headAt(B.seedTime(W) + 25 * H), ...o }));
  assert.equal(readW(dir).status, "void");
  const one = tmp(); const r0 = await quiet(() => run({ p: "main", check: null, prev: one, out: one, head: headAt(B.seedTime(W) + H), picksContract: "1P", nodeOf: nodeOf(signerFn(field)) }));
  assert.ok(r0.problems.some((p) => p.includes("second node")), "one node can't seed");
  const seedWith = async (f) => { const d = tmp(); await quiet(() => run({ p: "main", check: "check", prev: d, out: d, head: headAt(B.seedTime(W) + H), picksContract: "1P", nodeOf: nodeOf(signerFn(f)) })); return readW(d); };
  const w7 = await seedWith(fieldOf(7)); assert.equal(w7.status, "none"); assert.match(w7.void, /8 needed/);
  const w40 = await seedWith(fieldOf(40)); assert.equal(w40.seeding.size, 32); assert.equal(w40.days.length, 5, "Monday to Friday");
  const w13 = await seedWith(fieldOf(13)); assert.equal(w13.seeding.size, 16); assert.equal(w13.seeding.seeds.length, 13);
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
  const field = fieldOf(17), offline = new Set([field[0].a]);   // seed 1 goes offline from Monday: it loses round 1
  const signer = signerFn(field, offline, hAt(B.weekStart(W))), race = raceDir(field), dir = tmp();
  // perfect bracket computed straight from the fake chain with bracket-math (balances read at the end, walked back)
  const seeds = field.slice(0, 16).map((r) => r.a), fake = nodeOf(signer)("main");
  headAt(B.roundDay(W, 4) + H);
  const ch = await fake.chain(hAt(B.roundDay(W, 0)) - B.ACTIVE_BLOCKS, TOP);
  const anchors = {}; for (const r of field) anchors[r.a] = await fake.balance(r.a);
  const book = B.vhpBook(anchors, ch.deltas);
  const days = [0, 1, 2, 3].map((r) => B.dayIndex(ch, B.roundDay(W, r), seeds, book));
  const truth = B.results(seeds, 16, days);
  const perfect = B.encode(truth.rounds, 16, 16);
  const rows = [{ player: P(1), number: perfect, time: 1 }, { player: P(2), number: 0, time: 2 }];
  const o = { raceDir: race, picksContract: "1P", nodeOf: nodeOf(signer), picksOf: picksOf(rows) };
  await quiet(() => run({ p: "main", check: "check", prev: dir, out: dir, head: headAt(B.seedTime(W) + H), ...o }));
  await quiet(() => run({ p: "main", check: "check", prev: dir, out: dir, head: headAt(B.lockTime(W) + 60000), ...o }));
  // Tuesday 10:30: Monday done, Tuesday hours up to 10:00 recorded, nothing later
  const last = await runUntil(B.roundDay(W, 1) + 10.5 * H, o, dir);
  assert.deepEqual(last.problems, []);
  let wf = readW(dir);
  assert.ok(wf.days[0].every(Boolean)); assert.equal(wf.days[1].filter(Boolean).length, 10); assert.ok(wf.days[2].every((x) => x === null));
  assert.ok(wf.days[0].every((x) => x.checked === 2 && x.q > 0 && Object.keys(x.cr).length === 16 && Object.keys(x.w).length === 16));
  assert.ok(wf.days[0].every((x) => JSON.stringify(x.w) === JSON.stringify(wf.days[0][0].w)), "one baseline per seed for the whole day");
  assert.equal(B.indexFromHours(wf.days[0]).get(field[0].a).blocks, 0, "seed 1 signed nothing");
  assert.ok(B.indexFromHours(wf.days[0]).get(field[0].a).expected > 100, "…but was expected to, by its VHP");
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

test("hours: the two nodes must agree; a fork while reading is caught; VHP moved mid-day is followed exactly", async () => {
  const field = fieldOf(17), signer = signerFn(field), dir = tmp();
  const mover = field[5].a, h5 = hAt(B.roundDay(W, 0) + 5 * H);
  // the mover parks almost all its VHP elsewhere from 05:00 to 05:10 on Monday, then takes it back
  const moves = [{ h: h5, a: mover, d: -0.99 * field[5].vhp * 1000 }, { h: h5 + 200, a: mover, d: 0.99 * field[5].vhp * 1000 }];
  const o = { raceDir: raceDir(field), picksContract: "1P", nodeOf: nodeOf(signer, null, { moves }), picksOf: picksOf([]) };
  await quiet(() => run({ p: "main", check: "check", prev: dir, out: dir, head: headAt(B.seedTime(W) + H), ...o }));
  await quiet(() => run({ p: "main", check: "check", prev: dir, out: dir, head: headAt(B.lockTime(W) + 60000), ...o }));
  const badH = hAt(B.roundDay(W, 0) + 5 * H + 1000);
  const r = await quiet(() => run({ p: "main", check: "check", prev: dir, out: dir, head: headAt(B.roundDay(W, 0) + 8 * H), ...o, nodeOf: nodeOf(signer, (h) => h === badH, { moves }) }));
  assert.ok(r.problems.some((p) => p.includes("disagree")));
  assert.ok(readW(dir).days[0].every((x) => x === null), "nothing recorded while the nodes disagree");
  // a fork between the hour and the head while reading (the block a balance was read at changed): nothing recorded
  const r2 = await quiet(() => run({ p: "main", check: "check", prev: dir, out: dir, head: headAt(B.roundDay(W, 0) + 8 * H), ...o, nodeOf: nodeOf(signer, null, { moves, forkAt: { node: "main", h: hAt(B.roundDay(W, 0) + 8 * H) + 1 } }) }));
  assert.ok(r2.problems.some((p) => p.includes("fork")), JSON.stringify(r2.problems));
  // agreeing nodes: recorded (at most 6 hours a run); parking VHP for 10 minutes doesn't lower the mover's baseline
  const r3 = await quiet(() => run({ p: "main", check: "check", prev: dir, out: dir, head: headAt(B.roundDay(W, 0) + 8 * H), ...o }));
  assert.equal(readW(dir).days[0].filter(Boolean).length, 6, "6 hours a run (audit A-2) " + JSON.stringify(r3.problems));
  await quiet(() => run({ p: "main", check: "check", prev: dir, out: dir, head: headAt(B.roundDay(W, 0) + 8 * H), ...o }));
  const wf = readW(dir);
  assert.equal(wf.days[0].filter(Boolean).length, 8, "00:00–07:59 are irreversible by 08:00");
  assert.equal(wf.days[0][5].w[mover], wf.days[0][0].w[mover], "the baseline is the day's start, whatever happens later");
  assert.ok(wf.days[0][6].w[mover] === wf.days[0][0].w[mover], "…also in the next run's hours (taken from hour 0)");
  assert.ok(Math.abs(wf.days[0][5].q / wf.days[0][4].q - 1) < 0.05, "q is about the same every hour");
});

test("files: only the expected names, sizes and fields", async () => {
  const field = fieldOf(17), dir = tmp();
  await quiet(() => run({ p: "main", check: "check", prev: dir, out: dir, head: headAt(B.seedTime(W) + H), picksContract: null, nodeOf: nodeOf(signerFn(field)) }));
  const names = fs.readdirSync(dir).sort();
  assert.ok(names.includes("W003.json") && names.includes("board.json") && names.includes("index.json"));
  assert.ok(names.every((f) => /^(index|board|W\d{3})\.json$/.test(f)), names.join());
  const idx = JSON.parse(fs.readFileSync(path.join(dir, "index.json"), "utf8"));
  assert.deepEqual(Object.keys(idx).sort(), ["contract", "game", "updated", "v", "weeks"]); assert.equal(idx.game, B.GAME_ID);
  const wf = readW(dir);
  assert.deepEqual(Object.keys(wf).sort(), ["days", "end", "picks", "points", "results", "seeding", "staked", "start", "status", "v", "week"]);
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
  assert.match(yml, /run: npm run bracket\n\s+env:\n\s+RPC: .*\n\s+RPC_CHECK: .*\n\s+BRACKET_PREV: \$\{\{ runner\.temp \}\}\/prev\/bracket\n\s+BRACKET_OUT: \$\{\{ runner\.temp \}\}\/games-data\/bracket\n/);
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
  const bad = (f, mut) => { const d = tmp(); fs.cpSync(dir, d, { recursive: true }); const j = JSON.parse(fs.readFileSync(path.join(d, f), "utf8")); mut(j); fs.writeFileSync(path.join(d, f), JSON.stringify(j)); return shapeOk(d); };
  assert.equal(bad("W003.json", (j) => { j.points[0][1] = 999; }), false, "points over the maximum");
  assert.equal(bad("W003.json", (j) => { j.seeding.seeds.push("<script>"); }), false, "a non-address");
  assert.equal(bad("W003.json", (j) => { j.extra = 1; }), false, "an unknown field");
  assert.equal(bad("W003.json", (j) => { j.days[0][0].by["1x"] = 1; }), false);
  assert.equal(bad("board.json", (j) => { j.week.rows.push({ a: P(1), place: 1, pts: 1, champion: "yes", correct: 1, ranked: true }); }), false);
  assert.equal(bad("index.json", (j) => { j.game = 2; }), false, "the bracket's own game id");
});

// ── audit 2026-10-27 F-3 … F-7 ──
const { gameProblem } = await import(path.resolve(APP, "bot/games/bracket.ts"));
async function lockedWeek(o) {
  const dir = tmp();
  await quiet(() => run({ p: "main", check: "check", prev: dir, out: dir, head: headAt(B.seedTime(W) + H), ...o }));
  return dir;
}
test("F-3: a last-run file that went missing stops the run instead of wiping history", async () => {
  const field = fieldOf(17), o = { raceDir: raceDir(field), picksContract: addr(60), nodeOf: nodeOf(signerFn(field)), picksOf: picksOf([]) };
  const dir = await lockedWeek(o);
  fs.rmSync(path.join(dir, "W003.json"));
  await assert.rejects(quiet(() => run({ p: "main", check: "check", prev: dir, out: tmp(), head: headAt(B.seedTime(W) + 2 * H), ...o })), /missing; refusing to write/);
  const d2 = await lockedWeek(o); fs.rmSync(path.join(d2, "index.json"));
  await assert.rejects(quiet(() => run({ p: "main", check: "check", prev: d2, out: tmp(), head: headAt(B.seedTime(W) + 2 * H), ...o })), /index\.json is missing/);
  const wfy = fs.readFileSync(path.resolve(APP, ".github/workflows/games.yml"), "utf8");
  assert.match(wfy, /git ls-remote --exit-code --heads "\$url" "\$1"/);
  assert.match(wfy, /if \[ "\$rc" -eq 2 \]; then return 1; fi\n\s+echo "::error::Couldn't read the \$1 branch/);
  assert.doesNotMatch(wfy, /git fetch -q --depth 1 [^\n]*2>\/dev\/null; then/, "a failed fetch is never read as 'no branch'");
});
test("F-4: decisions use the irreversible block's time; a node far ahead can't void a week; the nodes must agree on it", async () => {
  const field = fieldOf(17), race = raceDir(field, { skip: (t) => t >= B.seedTime(W) - 6 * H && t < B.seedTime(W) + 12 * H });
  const o = { raceDir: race, picksContract: addr(60), nodeOf: nodeOf(signerFn(field)), picksOf: picksOf([]) };
  const dir = tmp();
  const h = headAt(B.seedTime(W) + H); h.time += 10 * H;   // the head claims to be 10 hours ahead
  await quiet(() => run({ p: "main", check: "check", prev: dir, out: dir, head: h, ...o }));
  assert.notEqual(fs.existsSync(path.join(dir, "W003.json")) && readW(dir).status, "void");
  // the second node reports another time for the irreversible block: nothing is written
  const skew = (name) => { const n = nodeOf(signerFn(field))(name); return name === "check" ? { ...n, blockTime: async (x) => T(x) + 3000 } : n; };
  const d2 = tmp();
  const r = await quiet(() => run({ p: "main", check: "check", prev: d2, out: d2, head: headAt(B.seedTime(W) + H), ...o, raceDir: raceDir(field), nodeOf: skew }));
  assert.ok(r.problems.some((p) => p.includes("disagree about block")));
  assert.equal(fs.readdirSync(d2).length, 0);
});
test("F-5: the Picks game must have the bracket's shape; picks timed at or after the lock never count", async () => {
  const good = { kind: 3, lock_mode: 2, round_size: String(B.WEEK), round_offset: String(B.ROUND_OFFSET), lead: String(B.LOCK_BEFORE), ahead: String(B.SEED_BEFORE), number_min: "0", number_max: String(B.NUMBER_MAX) };
  assert.equal(gameProblem(good), null);
  for (const [k, v] of [["kind", 2], ["round_offset", "0"], ["round_size", String(B.DAY)], ["lead", "299999"], ["ahead", String(B.SEED_BEFORE + 1)], ["ahead", "0"], ["number_max", "32767"]]) assert.match(gameProblem({ ...good, [k]: v }), new RegExp(k));
  // R-4: the owner's tighten_game (earlier lock, later opening) is still a valid bracket game
  assert.equal(gameProblem({ ...good, lead: String(B.LOCK_BEFORE * 3), ahead: String(B.SEED_BEFORE / 2) }), null);
  assert.match(gameProblem(null), /no bracket game/);
  const field = fieldOf(17), race = raceDir(field);
  const rows = [{ player: P(1), number: 0, time: B.lockTime(W) - 1 }, { player: P(2), number: 1, time: B.lockTime(W) }, { player: P(3), number: 2, time: B.lockTime(W) + 9e5 }];
  const base = { raceDir: race, picksContract: addr(60), nodeOf: nodeOf(signerFn(field)), picksOf: picksOf(rows) };
  const dir = await lockedWeek(base);
  const r = await quiet(() => run({ p: "main", check: "check", prev: dir, out: dir, head: headAt(B.lockTime(W) + 60000), ...base, gameOf: async () => good }));
  assert.deepEqual(readW(dir).picks.rows.map((x) => x[0]), [P(1)]);
  assert.ok(r.problems.some((p) => p.includes("2 pick(s) timed at or after the lock")));
  const d2 = await lockedWeek(base);
  const r2 = await quiet(() => run({ p: "main", check: "check", prev: d2, out: d2, head: headAt(B.lockTime(W) + 60000), ...base, gameOf: async () => ({ ...good, round_offset: "0" }) }));
  assert.equal(readW(d2).picks, null); assert.ok(r2.problems.some((p) => p.includes("round_offset")));
});
test("F-6 / F-7: each recorder step can fail alone; leaderboards are capped at 1,000 rows", async () => {
  const wfy = fs.readFileSync(path.resolve(APP, ".github/workflows/games.yml"), "utf8");
  assert.match(wfy, /- name: Record Who Signs Block X\n\s+continue-on-error: true/);
  assert.match(wfy, /- name: Record the Producer Bracket\n\s+continue-on-error: true/);
  assert.match(wfy, /if not os\.path\.isdir\(d\): print\("no blockx files"\); sys\.exit\(0\)/);
  assert.match(wfy, /for g in blockx bracket; do\n\s+\[ -d "\$IN\/\$g" \] \|\| continue/);
  const field = fieldOf(17), race = raceDir(field);
  const many = Array.from({ length: 1500 }, (_, i) => ({ player: ("1Many" + [0, 1, 2].map((k) => B58[Math.floor(i / 58 ** k) % 58]).join("")).padEnd(34, "x"), number: i % 3, time: 5 }));
  const o = { raceDir: race, picksContract: addr(60), nodeOf: nodeOf(signerFn(field)), picksOf: picksOf(many) };
  const dir = await lockedWeek(o);
  await quiet(() => run({ p: "main", check: "check", prev: dir, out: dir, head: headAt(B.lockTime(W) + 60000), ...o }));
  const r = await runUntil(B.roundDay(W, 0) + 25 * H, o, dir, 2);
  assert.equal(r.board.week.rows.length, 1000); assert.equal(readW(dir).points.length, 1500, "every score stays in the week file");
  assert.ok(shapeOk(dir));
});

test("R-4: the two nodes must agree about the Picks game", async () => {
  const field = fieldOf(17), base = { raceDir: raceDir(field), picksContract: addr(60), nodeOf: nodeOf(signerFn(field)), picksOf: picksOf([{ player: P(1), number: 0, time: 1 }]) };
  const good = { kind: 3, lock_mode: 2, round_size: String(B.WEEK), round_offset: String(B.ROUND_OFFSET), lead: String(B.LOCK_BEFORE), ahead: String(B.SEED_BEFORE), number_min: "0", number_max: String(B.NUMBER_MAX) };
  const dir = await lockedWeek(base);
  const r = await quiet(() => run({ p: "main", check: "check", prev: dir, out: dir, head: headAt(B.lockTime(W) + 60000), ...base, gameOf: async (n) => (n === "check" ? { ...good, enabled: false } : good) }));
  assert.equal(readW(dir).picks, null); assert.ok(r.problems.some((p) => p.includes("disagree about the Picks game")));
});

test("the rebuilt effective VHP must equal the VHP contract's own effective balance at the read block", async () => {
  const field = fieldOf(17), dir = tmp();
  const o = { picksContract: "1P", nodeOf: nodeOf(signerFn(field), null, { effOff: 1 }), picksOf: picksOf([]) };
  const r = await quiet(() => run({ p: "main", check: "check", prev: dir, out: dir, head: headAt(B.seedTime(W) + H), ...o }));
  assert.ok(r.problems.some((p) => p.includes("doesn't match the contract's effective balance")), JSON.stringify(r.problems));
  assert.ok(!fs.existsSync(path.join(dir, "W003.json")) || !readW(dir).seeding, "not seeded on a mismatch");
});

test("audit S-3: when a node can't give the effective balance as a read-only call, seeding goes ahead on the exact rebuild", async () => {
  const field = fieldOf(17), dir = tmp();
  const noEff = (name) => { const n = nodeOf(signerFn(field))(name); return { ...n, balance: async (a) => { const { eff, ...b } = await n.balance(a); return b; } }; };
  const r = await quiet(() => run({ p: "main", check: "check", prev: dir, out: dir, head: headAt(B.seedTime(W) + H), picksContract: "1P", nodeOf: noEff, picksOf: picksOf([]) }));
  assert.deepEqual(r.problems, []);
  assert.equal(readW(dir).seeding.seeds.length, 16);
});

// ── the Vault file (Vault v6 hand-off, 2026-10-28) ──
test("vault rows: staked players with ≥ 1 point, the bracket's order (points, champion, right winners) and ties kept on 1–255", () => {
  const pts = [[P(1), 20, 1, 9], [P(2), 20, 0, 9], [P(3), 20, 0, 9], [P(4), 31, 0, 12], [P(5), 0, 0, 0], [P(6), 5, 0, 4], [P(7), 40, 1, 14]];
  const staked = new Set([P(1), P(2), P(3), P(4), P(5), P(7)]);   // P(6) is a free player
  const rows = plain(vaultRows(pts, staked));
  assert.deepEqual(rows.map((r) => r.player), [P(7), P(4), P(1), P(2), P(3)], "best first; P(5) has no point; P(6) isn't staked");
  const v = Object.fromEntries(rows.map((r) => [r.player, r.points]));
  assert.ok(v[P(7)] > v[P(4)] && v[P(4)] > v[P(1)] && v[P(1)] > v[P(2)], "order kept, including the champion tie-break");
  assert.equal(v[P(2)], v[P(3)], "a full tie stays a tie");
  assert.ok(rows.every((r) => Number.isInteger(r.points) && r.points >= 1 && r.points <= 255));
  assert.deepEqual(plain(vaultRows(pts, new Set())), [], "nobody qualifies: no rows");
  // more than 255 different scores: falls back to the plain points (order kept, ties merged), still 1–255
  const many = Array.from({ length: 300 }, (_, i) => [("1Many" + String(i).padStart(4, "1")).padEnd(34, "x"), 1 + (i % 80), i % 2, i % 15]);
  const big = plain(vaultRows(many, new Set(many.map((r) => r[0]))));
  assert.equal(big.length, 300); assert.ok(big.every((r) => r.points >= 1 && r.points <= 255));
  for (let i = 1; i < big.length; i++) assert.ok(big[i - 1].points >= big[i].points);
});

test("vault file: written once the week is final, with only staked players; none when the stakes can't be read in 3 days", async () => {
  const field = fieldOf(17), signer = signerFn(field);
  const rows = [{ player: P(1), number: 0, time: 1 }, { player: P(2), number: 5, time: 2 }, { player: P(3), number: 9, time: 3 }];
  const base = { picksContract: addr(60), nodeOf: nodeOf(signer), picksOf: picksOf(rows) };
  const play = async (o, until) => { const d = tmp(); await quiet(() => rec.run({ p: "main", check: "check", prev: d, out: d, head: headAt(B.seedTime(W) + H), ...base, ...o })); await quiet(() => rec.run({ p: "main", check: "check", prev: d, out: d, head: headAt(B.lockTime(W) + 60000), ...base, ...o })); for (let i = 0; i < 40; i++) await quiet(() => rec.run({ p: "main", check: "check", prev: d, out: d, head: headAt(until), ...base, ...o })); return d; };
  // P(1) and P(3) are staked; P(2) plays free
  const d = await play({ stakedOf: async (_n, ps) => ps.filter((p) => p !== P(2)) }, B.roundDay(W, 4) + 13 * H);
  const wf = readW(d); assert.equal(wf.status, "final"); assert.deepEqual(wf.staked.list, [P(1), P(3)].sort());
  const vf = JSON.parse(fs.readFileSync(path.join(d, "vault", `W${W}.json`), "utf8"));
  assert.deepEqual(Object.keys(vf).sort(), ["final", "first", "game", "rows", "second", "week"]);
  assert.equal(vf.game, 9); assert.equal(vf.week, W); assert.equal(vf.final, true);
  const p2 = readW(d).points.find((r) => r[0] === P(2));
  assert.deepEqual(vf.first, p2 && p2[1] >= 1 ? [P(2)] : [], "the only free player with a point is 1st on the Free play board");
  assert.deepEqual(vf.second, []);
  assert.deepEqual(readW(d).staked.held, [P(1), P(3)].sort(), "read again as the week closes");
  assert.ok(vf.rows.every((r) => r.player !== P(2)), "free players never in the rows");
  assert.equal(vf.week, B.weekOf(B.weekStart(W) + 1), "the Vault's week number = the KnodeGames week");
  // the board marks staked rows as ranked (Staked tab) and the rest as free play
  const board = JSON.parse(fs.readFileSync(path.join(d, "board.json"), "utf8"));
  const lw = board.week.rows; assert.ok(lw.find((r) => r.a === P(2)).ranked === false && lw.find((r) => r.a === P(1)).ranked === true);
  // the nodes disagree about the stakes: results in, not final
  const d2 = await play({ stakedOf: async (n, ps) => (n === "check" ? [] : ps) }, B.roundDay(W, 4) + 13 * H);
  assert.equal(readW(d2).status, "locked"); assert.ok(!fs.existsSync(path.join(d2, "vault")));
  // still unreadable 3 days after the week ends: final without a file (the Vault rolls the week over)
  await quiet(() => rec.run({ p: "main", check: "check", prev: d2, out: d2, head: headAt(B.weekStart(W + 1) + 3 * DAY + H), ...base, stakedOf: async () => { throw new Error("no Vault v6 yet"); } }));
  assert.equal(readW(d2).status, "final"); assert.equal(readW(d2).vault, "missed"); assert.ok(!fs.existsSync(path.join(d2, "vault")));
  // the publish check refuses a bad vault file
  const badV = (mut) => { const x = tmp(); fs.cpSync(d, x, { recursive: true }); const f = path.join(x, "vault", `W${W}.json`); const j = JSON.parse(fs.readFileSync(f, "utf8")); mut(j); fs.writeFileSync(f, JSON.stringify(j)); return shapeOk(x); };
  assert.ok(shapeOk(d));
  assert.equal(badV((j) => { j.rows[0].points = 0; }), false, "points 0");
  assert.equal(badV((j) => { j.rows[0].points = 256; }), false, "points over 255");
  assert.equal(badV((j) => { j.rows.push({ ...j.rows[0] }); }), false, "a player twice");
  assert.equal(badV((j) => { j.game = 2; }), false, "another game");
  assert.equal(badV((j) => { j.first = [j.rows[0].player]; j.second = []; }), false, "a staked row can't also win the free prize");
  assert.equal(badV((j) => { j.first = Array.from({ length: 11 }, (_, i) => P(20 + i)); j.second = []; }), false, "at most 10 a place");
  assert.equal(badV((j) => { j.first = [P(20), P(21)]; j.second = [P(22)]; }), false, "a tie for 1st shares all 3 VHP: no 2nd");
  assert.ok(badV((j) => { j.first = [P(20)]; j.second = [P(21), P(22)]; }), "1st and a tie for 2nd is fine");
  assert.equal(badV((j) => { j.final = false; }), false);
});

test("free prize winners: ties share, more than 10 tied leaves the place empty, staked or held players never win, nobody qualifying", () => {
  const W_ = (pts, held = []) => plain(freeWinners(pts, new Set(held)));
  // [player, points, champion, right winners]
  assert.deepEqual(W_([[P(1), 9, 0, 5], [P(2), 7, 0, 4], [P(3), 7, 0, 4], [P(4), 3, 0, 2]]), { first: [P(1)], second: [P(2), P(3)].sort() }, "one 1st, two share 2nd");
  assert.deepEqual(W_([[P(1), 9, 0, 5], [P(2), 9, 0, 5], [P(3), 7, 0, 4]]), { first: [P(1), P(2)].sort(), second: [] }, "tied for 1st: they share all 3 VHP");
  assert.deepEqual(W_([[P(1), 9, 1, 5], [P(2), 9, 0, 5]]), { first: [P(1)], second: [P(2)] }, "the right champion breaks the tie");
  const ten = Array.from({ length: 10 }, (_, i) => [P(10 + i), 5, 0, 3]), eleven = Array.from({ length: 11 }, (_, i) => [P(10 + i), 5, 0, 3]);
  assert.equal(W_(ten).first.length, 10, "10 tied all win");
  assert.deepEqual(W_([...eleven, [P(40), 2, 0, 1]]), { first: [], second: [] }, "11 tied for 1st: the place goes back to the pool, and nobody below is moved up");
  assert.deepEqual(W_([[P(1), 9, 0, 5], ...eleven]), { first: [P(1)], second: [] }, "11 tied for 2nd: 2nd goes back to the pool");
  assert.deepEqual(W_([[P(1), 9, 0, 5], [P(2), 4, 0, 3]], [P(1)]), { first: [P(2)], second: [] }, "a held (staked) player can't win; the next free player is 1st");
  assert.deepEqual(W_([[P(1), 0, 0, 0], [P(2), 0, 0, 0]]), { first: [], second: [] }, "nobody with a point: nobody qualifies");
  assert.deepEqual(W_([]), { first: [], second: [] });
});

test("audit S-5 forfeit: a seed starting its day under half its seeding VHP loses that matchup", () => {
  const day = (wa, ca, wb, cb) => new Map([["1Fav", { baseline: wa, credited: ca, expected: wa * 1e-8 }], ["1Dog", { baseline: wb, credited: cb, expected: wb * 1e-8 }]]);
  const sv = new Map([["1Fav", 100], ["1Dog", 50]]);
  // the underdog holds 10 VHP of its 50 and has a lucky day: it would win on index, but it forfeits
  assert.equal(B.otherWins(day(100e8, 1, 10e8, 5), "1Fav", "1Dog"), true, "without the rule: a lottery win");
  assert.equal(B.otherWins(day(100e8, 1, 10e8, 5), "1Fav", "1Dog", sv), false, "with the rule: forfeit");
  assert.equal(B.otherWins(day(100e8, 1, 25e8, 5), "1Fav", "1Dog", sv), true, "exactly half: no forfeit");
  assert.equal(B.otherWins(day(40e8, 9, 50e8, 1), "1Fav", "1Dog", sv), true, "the favourite forfeits: the underdog wins");
  assert.equal(B.otherWins(day(40e8, 9, 10e8, 1), "1Fav", "1Dog", sv), false, "both forfeit: the index decides");
  // results() takes the seeding VHP in seed order
  const seeds = Array.from({ length: 8 }, (_, i) => "1S" + i), vhp = seeds.map(() => 100);
  const d0 = new Map(seeds.map((a, i) => [a, { baseline: i === 7 ? 10e8 : 100e8, credited: i === 7 ? 999 : 1, expected: 1 }]));
  assert.equal(B.results(seeds, 8, [d0], vhp).rounds[0][0], 1, "seed 8 forfeits round 1 to seed 1");
  assert.equal(B.results(seeds, 8, [d0]).rounds[0][0], 8, "(without seeding VHP: no forfeits)");
});

test("fix-check F-5: a player who withdrew mid-week stays on the Staked board and is never a free-prize winner", async () => {
  const field = fieldOf(17), signer = signerFn(field);
  const rows = [{ player: P(1), number: 0, time: 1 }, { player: P(2), number: 5, time: 2 }, { player: P(3), number: 9, time: 3 }];
  const base = { picksContract: addr(60), nodeOf: nodeOf(signer), picksOf: picksOf(rows) };
  // P(1) staked; P(2) staked at the start then withdrew (the close read: not staked, but held); P(3) free
  let closing = false;
  const stakedOf = async () => (closing ? { staked: [P(1)], held: [P(1), P(2)] } : { staked: [P(1), P(2)], held: [P(1), P(2)] });
  const d = tmp(), go = (t) => quiet(() => rec.run({ p: "main", check: "check", prev: d, out: d, head: headAt(t), ...base, stakedOf }));
  await go(B.seedTime(W) + H); await go(B.lockTime(W) + 60000); await go(B.weekStart(W) + H);
  closing = true; for (let i = 0; i < 40; i++) await go(B.roundDay(W, 4) + 13 * H);
  assert.equal(readW(d).status, "final");
  const lw = JSON.parse(fs.readFileSync(path.join(d, "board.json"), "utf8")).week.rows;
  assert.equal(lw.find((r) => r.a === P(2)).ranked, true, "on the Staked board");
  const vf = JSON.parse(fs.readFileSync(path.join(d, "vault", `W${W}.json`), "utf8"));
  assert.ok(!vf.first.includes(P(2)) && !vf.second.includes(P(2)) && !vf.rows.some((r) => r.player === P(2)));
});

test("owner 2026-10-29: ties go to who submitted first (a copied bracket can't tie the original); same block still shares", () => {
  const pts = [[P(1), 9, 0, 5], [P(2), 9, 0, 5], [P(3), 9, 0, 5], [P(4), 4, 0, 2]];
  const tm = new Map([[P(1), 3000], [P(2), 1000], [P(3), 1000], [P(4), 500]]);
  assert.deepEqual(plain(freeWinners(pts, new Set(), tm)), { first: [P(2), P(3)].sort(), second: [] }, "P(2) and P(3) picked in the same block: they share 1st");
  const tm2 = new Map([[P(1), 3000], [P(2), 1000], [P(3), 2000], [P(4), 500]]);
  assert.deepEqual(plain(freeWinners(pts, new Set(), tm2)), { first: [P(2)], second: [P(3)] }, "the earliest is 1st, the next earliest 2nd");
  // 11 copies of the leader's bracket, all made after it: the leader stays alone in 1st
  const copies = Array.from({ length: 11 }, (_, i) => [P(20 + i), 9, 0, 5]);
  const tm3 = new Map([[P(1), 100], ...copies.map((r, i) => [r[0], 200 + i])]);
  assert.deepEqual(plain(freeWinners([[P(1), 9, 0, 5], ...copies], new Set(), tm3)).first, [P(1)]);
  // the champion and right winners still come before the time
  assert.deepEqual(plain(freeWinners([[P(1), 9, 0, 5], [P(2), 9, 1, 5]], new Set(), new Map([[P(1), 1], [P(2), 9]]))).first, [P(2)]);
  // the Vault rows keep the same order
  const v = plain(vaultRows(pts, new Set(pts.map((r) => r[0])), tm2));
  const at = Object.fromEntries(v.map((r) => [r.player, r.points]));
  assert.ok(at[P(2)] > at[P(3)] && at[P(3)] > at[P(1)] && at[P(1)] > at[P(4)]);
  // the boards rank the same way
  const ranked = B.rank([{ player: P(1), points: 9, champion: false, correct: 5, time: 3000 }, { player: P(2), points: 9, champion: false, correct: 5, time: 1000 }]);
  assert.deepEqual(ranked.map((r) => [r.player, r.place]), [[P(2), 1], [P(1), 2]]);
  assert.equal(B.rank([{ player: P(1), points: 9, champion: false, correct: 5 }, { player: P(2), points: 9, champion: false, correct: 5 }])[1].place, 1, "no time (all-time board): shared");
});

test("fix-check F-1: the Vault (a pooled producer: players' withdrawable stakes) never forfeits; it stays in the field", async () => {
  const day = new Map([["1Vault", { baseline: 10e8, credited: 5, expected: 0.1 }], ["1Dog", { baseline: 100e8, credited: 1, expected: 1 }]]);
  const sv = new Map([["1Vault", 100], ["1Dog", 100]]);
  assert.equal(B.otherWins(day, "1Vault", "1Dog", sv), true, "an ordinary producer this far under would forfeit");
  assert.equal(B.otherWins(day, "1Vault", "1Dog", sv, new Set(["1Vault"])), false, "the Vault doesn't: its index decides");
  // the recorder records the Vault as pooled when it is seeded
  const field = fieldOf(17), dir = tmp();
  await quiet(() => run({ p: "main", check: "check", prev: dir, out: dir, head: headAt(B.seedTime(W) + H), picksContract: addr(60), nodeOf: nodeOf(signerFn(field)), picksOf: picksOf([]), vault: addr(2) }));
  const s = readW(dir).seeding;
  assert.ok(s.seeds.includes(addr(2)), "the Vault is seeded like any producer");
  assert.deepEqual(s.pooled, [addr(2)]);
  assert.ok(shapeOk(dir));
});

// The Producer Race recorder (bot/race.ts) and its workflow (.github/workflows/race.yml): handicap cards every 2 hours
// (taken by the last hourly run before each leg, never retaken), results final only when irreversible and both nodes
// agree, and the publish job's checks. Offline: two fake nodes serve a made-up chain.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const APP = process.env.APP || ".";
const { run } = await import(path.resolve(APP, "bot/race.ts"));
const M = globalThis.KRaceMath;
const U = (s) => Date.parse(s), H = 3600000;

// A made-up chain: one block every 3 s from Sunday 00:00 UTC, signers drawn by VHP. The races tested are in week 2.
const P = ["1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "1BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", "1CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC", "1DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD", "1EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE"];
const VHP = [400, 250, 200, 140, 1];
const T0 = U("2026-11-01T00:00:00Z"), N = 50 * 1200;            // 50 hours of blocks
const chain = (() => {
  const R = M.rng(7), tot = VHP.reduce((a, b) => a + b), ts = [], who = [];
  for (let i = 0; i < N; i++) { ts.push(T0 + i * 3000); let x = R.next() * tot, j = 0; while (x >= VHP[j]) { x -= VHP[j]; j++; } who.push(P[j]); }
  return { ts, who };
})();
function node(nowT, { tamper = null } = {}) {
  let top = 0; while (top + 1 < N && chain.ts[top + 1] <= nowT) top++;
  const H0 = 1000;                                              // height of the first block
  return {
    async getHeadInfo() { return { head_topology: { height: String(H0 + top), id: "0xhead" }, head_block_time: String(chain.ts[top]), last_irreversible_block: String(H0 + top - 60) }; },
    async call(m, a) {
      assert.equal(m, "block_store.get_blocks_by_height");
      const s = Number(a.ancestor_start_height), items = [];
      for (let h = s; h < s + a.num_blocks && h <= H0 + top; h++) {
        const i = h - H0; if (i < 0) continue;
        items.push({ block_height: String(h), block: { header: { signer: tamper === h ? P[(P.indexOf(chain.who[i]) + 1) % P.length] : chain.who[i], timestamp: String(chain.ts[i]) } } });
      }
      return { block_items: items };
    },
  };
}
const vhpOf = async (who) => Object.fromEntries(who.map((a) => [a, String(VHP[P.indexOf(a)] * 1e8)]));
const dirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "race-")); dirs.push(d); return d; };
async function hourly(at, prev, opts = {}) {
  const out = tmp();
  const log = console.log; console.log = () => {};
  let r;
  try { r = await run({ p: node(at), check: opts.check === null ? null : node(at, opts.check || {}), prev, out, vhpOf, raceContract: null }); } finally { console.log = log; }
  if (process.env.SHOW_PROBLEMS) console.log(at, r && r.problems);
  return out;
}
const week = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "W002.json"), "utf8"));
const race = (dir, id) => week(dir).races.find((r) => r.id === id);

test("cards (hourly): the run just before a leg takes its card; a run during a leg with no card takes it; nothing is retaken", async () => {
  const a = await hourly(U("2026-11-02T05:37Z"), "");
  assert.equal(race(a, "2026-11-02T00").cards.length, 6, "6 one-hour legs");
  assert.ok(race(a, "2026-11-02T00").cards[5], "05:37: the 05:00 leg had no card yet: taken now");
  assert.ok(race(a, "2026-11-02T06").cards[0], "05:37: the 06:00 leg starts in 23 minutes: taken now");
  assert.equal(race(a, "2026-11-02T06").cards[1], null, "the 07:00 leg is not due yet");
  const b = await hourly(U("2026-11-02T06:37Z"), a);
  assert.equal(race(b, "2026-11-02T06").cards[0].at, race(a, "2026-11-02T06").cards[0].at, "never retaken");
  assert.ok(race(b, "2026-11-02T06").cards[1] && race(b, "2026-11-02T06").cards[1].at < U("2026-11-02T07:00Z"), "06:37: the 07:00 leg's card, 23 minutes ahead");
  const c = await hourly(U("2026-11-02T07:37Z"), b);
  assert.ok(race(c, "2026-11-02T06").cards[2] && race(c, "2026-11-02T06").cards[2].at < U("2026-11-02T08:00Z"));
  // Each card is the shared math's card for the producers' VHP.
  const card = race(c, "2026-11-02T06").cards[1];
  assert.equal(card.field[0].a, P[0]); assert.equal(card.field[0].h, 1);
  assert.ok(card.paddock.some((x) => x.a === P[4]), "the smallest producer (k under 10) waits in the paddock");
});

test("a race recorded with 3 two-hour cards keeps them (no change mid-race); races not started yet become hourly", async () => {
  const a = await hourly(U("2026-11-02T05:37Z"), "");
  // Turn the published file into the old format: the running 06:00 race with 3 cards, later races with 3 empty slots.
  const wf = week(a), r6 = wf.races.find((r) => r.id === "2026-11-02T06");
  r6.cards = [r6.cards[0], null, null];
  for (const r of wf.races) if (r.start > r6.start) r.cards = [null, null, null];
  const prev = tmp(); fs.writeFileSync(path.join(prev, "W002.json"), JSON.stringify(wf));
  const b = await hourly(U("2026-11-02T07:37Z"), prev);
  assert.equal(race(b, "2026-11-02T06").cards.length, 3, "the race that had started keeps 2-hour legs");
  assert.ok(race(b, "2026-11-02T06").cards[1] && race(b, "2026-11-02T06").cards[1].at < U("2026-11-02T08:00Z"), "its 08:00 leg (2-hour) gets its card at 07:37");
  assert.equal(race(b, "2026-11-02T12").cards.length, 6, "a race that hasn't started is hourly");
});

test("results: final only after the race is irreversible, with every block checked on both nodes; the same standings as the page", async () => {
  const a = await hourly(U("2026-11-02T05:37Z"), "");
  assert.equal(race(a, "2026-11-02T00").result, null, "still running");
  const b = await hourly(U("2026-11-02T06:37Z"), a);
  const r = race(b, "2026-11-02T00").result;
  assert.equal(r.final, true); assert.equal(r.checked, 2);
  assert.equal(r.blocks, 7200, "exactly the race's blocks: 00:00 to 05:59:59");
  // Re-score from the chain with the shared math: identical.
  const B = { ts: chain.ts, sig: chain.who.map((a) => P.indexOf(a)), signers: P };
  const mine = M.standings(B, { start: U("2026-11-02T00:00Z"), end: U("2026-11-02T06:00Z") }, race(b, "2026-11-02T00").cards);
  assert.deepEqual(r.standings.map((x) => [x.a, x.steps]), mine.map((x) => [x.a, x.steps]));
  assert.equal(r.winner, mine[0].a);
  assert.equal(race(b, "2026-11-02T06").result, null, "the running race is not final");
  // A final result is never recomputed.
  const c = await hourly(U("2026-11-02T07:37Z"), b);
  assert.deepEqual(race(c, "2026-11-02T00").result, r);
});

test("results: when the two nodes disagree on any block, the race stays unfinished until they agree", async () => {
  const a = await hourly(U("2026-11-02T05:37Z"), "");
  const bad = await hourly(U("2026-11-02T06:37Z"), a, { check: { tamper: 1000 + 24 * 1200 + 3000 } });
  assert.equal(race(bad, "2026-11-02T00").result, null);
  const good = await hourly(U("2026-11-02T07:37Z"), bad);
  assert.equal(race(good, "2026-11-02T00").result.final, true);
});

test("results: races before the recorder's first card are not listed; a later race with no card at all is 'missed'", async () => {
  const a = await hourly(U("2026-11-02T13:37Z"), "");
  assert.equal(race(a, "2026-11-02T00").result, null, "before the recorder started: nothing");
  // Skip 12 hours of runs: the 18:00 race gets no card at all.
  const b = await hourly(U("2026-11-03T01:37Z"), a);
  const r = race(b, "2026-11-02T18").result;
  assert.equal(r.final, true); assert.equal(r.missed, true);
  assert.equal(race(b, "2026-11-02T12").result.final, true, "the 12:00 race had a card: recorded");
});

// ── picks and leaderboards ──
const W1 = "1HsM33pF8DbXPr8Vsd4vD7hQgvZ1SHY3Vv", W2 = "16ixK5DgvcojcZLvxyYWhHFcRXfhfrHbpL", W3 = "1ByDDSBUzy5zkRceELc54Jh8i41yNRoKt8", GUEST = "1635QUrBNDp7WqmFkRvrkGwjJXTtFvH717";
const RACE00 = M.raceIndex(U("2026-11-02T00:00Z"));
/** Picks for race 00:00 on Nov 2: W1 and GUEST pick the real winner, W2 and W3 another horse. */
async function picksRun(at, prev, { winnerFor = null, theirs = null, custom = null } = {}) {
  const out = tmp();
  const picks = (winner) => custom || [[W1, winner, 1], [W2, P[3], 2], [W3, P[3], 3], [GUEST, winner, 4]];
  const picksOf = async (node, r) => (r !== RACE00 ? [] : node === checkNode && theirs ? theirs : picks(winnerFor));
  const pNode = node(at), checkNode = node(at);
  const vhp = async (who) => Object.fromEntries(who.map((a) => [a, a === GUEST ? "0" : a === W3 ? "50000000" : String(5e8)]));   // W3: 0.5 VHP
  const playerOf = async (n, who, week) => ({ stake: who === W3 ? 10n : 0n, answers: { [W1]: 3, [W2]: 9, [W3]: 1, [GUEST]: 5 }[who] ?? 0, points: { [W1]: 2, [W2]: 7, [W3]: 1, [GUEST]: 4 }[who] ?? 0 });
  const log = console.log; console.log = () => {};
  try { await run({ p: pNode, check: checkNode, prev, out, vhpOf: async (w) => ({ ...(await vhpOf(w)), ...(await vhp(w)) }), raceContract: "x", picksOf, playerOf }); } finally { console.log = log; }
  return out;
}

test("picks: a final race records every pick, who picked the winner, and who may be ranked (1 VHP or a stake)", async () => {
  const a = await hourly(U("2026-11-02T05:37Z"), "");
  // Find the winner the recorder will name, then run with picks that name it.
  const B = { ts: chain.ts, sig: chain.who.map((x) => P.indexOf(x)), signers: P };
  const card = race(a, "2026-11-02T00").cards;
  const winner = M.standings(B, { start: U("2026-11-02T00:00Z"), end: U("2026-11-02T06:00Z") }, card)[0].a;
  const b = await picksRun(U("2026-11-02T06:37Z"), a, { winnerFor: winner });
  const r = race(b, "2026-11-02T00").result;
  assert.equal(r.winner, winner);
  const by = Object.fromEntries(r.picks.map((x) => [x[0], x]));
  assert.deepEqual([by[W1][3], by[W2][3], by[W3][3], by[GUEST][3]], [1, 0, 0, 1], "right picks");
  assert.deepEqual([by[W1][4], by[W2][4], by[W3][4], by[GUEST][4]], [1, 1, 1, 0], "W3 has a stake; the guest has nothing");
  // Leaderboard: correct first, then picks placed, then Knode answers, then Knode score. The guest is listed but not ranked.
  const board = JSON.parse(fs.readFileSync(path.join(b, "board.json"), "utf8"));
  const wk = board.week.rows;
  assert.deepEqual(wk.slice(0, 2).map((x) => x.a).sort(), [W1, GUEST].sort(), "the two right pickers lead");
  assert.equal(wk[0].a, GUEST, "tied on correct and picks: more Knode answers (5 vs 3) wins");
  assert.equal(wk[2].a, W2, "W2 and W3 tied on correct and picks: W2 answered more");
  assert.equal(wk.find((x) => x.a === GUEST).ranked, false);
  assert.equal(wk.find((x) => x.a === W1).ranked, true);
  assert.equal(board.today.rows.length, 4); assert.equal(board.allTime.rows.length, 4);
  assert.ok(shapeOk(b), "board.json and the picks pass the publish check");
});

test("picks: when the two nodes disagree about the picks, the race stays unfinished", async () => {
  const a = await hourly(U("2026-11-02T05:37Z"), "");
  const b = await picksRun(U("2026-11-02T06:37Z"), a, { winnerFor: P[0], theirs: [[W1, P[1], 1]] });
  assert.equal(race(b, "2026-11-02T00").result, null);
});

test("leaderboard order: points, then more wins, then more picks placed, then more Knode answers, then a higher Knode score", async () => {
  const { rank } = await import(path.resolve(APP, "bot/race.ts"));
  const r = (a, correct, shows, picks, answers, points) => ({ a, pts: 3 * correct + shows, correct, shows, picks, answers, points, ranked: true });
  const out = rank([r("1d", 2, 0, 5, 9, 9), r("1a", 3, 0, 3, 0, 0), r("1c", 2, 0, 6, 0, 0), r("1b", 2, 0, 5, 9, 10), r("1e", 2, 0, 5, 10, 0),
    r("1f", 1, 6, 9, 0, 0), r("1g", 0, 10, 12, 0, 0)]);
  // 1g: 10 shows = 10 pts beats 1a's 3 wins = 9 pts. 1f: 1 win + 6 shows = 9 pts ties 1a, and 1a has more wins.
  assert.deepEqual(out.map((x) => x.a), ["1g", "1a", "1f", "1c", "1e", "1b", "1d"]);
});

// ── Show (the horse finishes 2nd or 3rd) ──
test("show: 2nd and 3rd with at least one step; none without a winner; a win is never also a show", () => {
  const st = (...steps) => steps.map((s, i) => ({ a: P[i], steps: s, blocks: s ? 1 : 0 }));
  assert.deepEqual(M.shows(st(9, 7, 5, 3)), [P[1], P[2]]);
  assert.deepEqual(M.shows(st(9, 7, 0, 0)), [P[1]], "a horse with no steps does not show");
  assert.deepEqual(M.shows(st(0, 0, 0)), [], "no winner, no show");
  assert.deepEqual(M.shows(st(9)), []);
  assert.ok(!M.shows(st(9, 7, 5)).includes(P[0]));
  assert.deepEqual({ ...M.POINTS }, { win: 3, show: 1 });
});

test("show: picks on the 2nd and 3rd horse score a show (1 point); the winner scores a win (3); the rest score 0", async () => {
  const a = await hourly(U("2026-11-02T05:37Z"), "");
  const B = { ts: chain.ts, sig: chain.who.map((x) => P.indexOf(x)), signers: P };
  const st = M.standings(B, { start: U("2026-11-02T00:00Z"), end: U("2026-11-02T06:00Z") }, race(a, "2026-11-02T00").cards);
  assert.ok(st[2].steps > 0, "the made-up race has a 3rd horse with steps");
  const [first, second, third, fourth] = st.map((x) => x.a);
  const b = await picksRun(U("2026-11-02T06:37Z"), a, { custom: [[W1, first, 1], [W2, second, 2], [W3, third, 3], [GUEST, fourth, 4]] });
  const r = race(b, "2026-11-02T00").result;
  const by = Object.fromEntries(r.picks.map((x) => [x[0], x]));
  assert.ok(r.picks.every((x) => x.length === 6));
  assert.deepEqual([W1, W2, W3, GUEST].map((w) => [by[w][3], by[w][5]]), [[1, 0], [0, 1], [0, 1], [0, 0]]);
  const board = JSON.parse(fs.readFileSync(path.join(b, "board.json"), "utf8"));
  const row = (w) => board.week.rows.find((x) => x.a === w);
  assert.deepEqual([row(W1).pts, row(W2).pts, row(W3).pts, row(GUEST).pts], [3, 1, 1, 0]);
  assert.deepEqual([row(W2).correct, row(W2).shows, row(W2).picks], [0, 1, 1]);
  assert.equal(board.week.rows[0].a, W1);
  assert.equal(board.week.rows[1].a, W2, "W2 and W3 tie on points, wins and picks; W2 answered more Knode questions (9 vs 1)");
  assert.ok(shapeOk(b));
});

test("show: races recorded before Show (5-field picks) get their shows from their stored standings", async () => {
  const a = await hourly(U("2026-11-02T05:37Z"), "");
  const B = { ts: chain.ts, sig: chain.who.map((x) => P.indexOf(x)), signers: P };
  const st = M.standings(B, { start: U("2026-11-02T00:00Z"), end: U("2026-11-02T06:00Z") }, race(a, "2026-11-02T00").cards);
  const b = await picksRun(U("2026-11-02T06:37Z"), a, { custom: [[W1, st[0].a, 1], [W2, st[1].a, 2], [W3, st[3].a, 3]] });
  // Turn the stored picks back into the old 5-field form, as a race from before this change.
  const w = week(b); const old = w.races.find((x) => x.id === "2026-11-02T00");
  old.result.picks = old.result.picks.map((x) => x.slice(0, 5));
  fs.writeFileSync(path.join(b, "W002.json"), JSON.stringify(w));
  const c = await hourly(U("2026-11-02T07:37Z"), b);
  const picks = race(c, "2026-11-02T00").result.picks;
  const by = Object.fromEntries(picks.map((x) => [x[0], x]));
  assert.deepEqual([W1, W2, W3].map((x) => by[x][5]), [0, 1, 0]);
  assert.ok(shapeOk(c));
});

// The publish job's shape check, run as it is in the workflow, on the recorder's real output.
const yml = fs.readFileSync(path.resolve(APP, ".github/workflows/race.yml"), "utf8");
const checkPy = yml.match(/<<'PY'\n([\s\S]*?)\n\s*PY\n/)[1].split("\n").map((l) => l.replace(/^ {10}/, "")).join("\n");
const shapeOk = (dir) => { try { execFileSync("python3", ["-c", checkPy, dir], { stdio: "pipe" }); return true; } catch { return false; } };

test("publish: the recorder's files pass the publish job's shape check; anything else is refused", async () => {
  const a = await hourly(U("2026-11-02T06:37Z"), await hourly(U("2026-11-02T05:37Z"), ""));
  assert.ok(shapeOk(a));
  const w = week(a);
  const bad1 = tmp(); fs.writeFileSync(path.join(bad1, "W002.json"), JSON.stringify({ ...w, races: w.races.slice(1) }));
  const bad2 = tmp(); const w2 = JSON.parse(JSON.stringify(w)); w2.races[0].cards[0] = { ...w2.races[1].cards[0], field: [{ a: "<img onerror=x>", vhp: 1, k: 1, h: 1 }] };
  fs.writeFileSync(path.join(bad2, "W002.json"), JSON.stringify(w2));
  const bad3 = tmp(); fs.writeFileSync(path.join(bad3, "W003.json"), JSON.stringify(w));
  for (const d of [bad1, bad2, bad3]) assert.equal(shapeOk(d), false);
});

test("publish: a pick marked both win and show, or a board row with more wins and shows than picks, is refused", async () => {
  const a = await hourly(U("2026-11-02T05:37Z"), "");
  const B = { ts: chain.ts, sig: chain.who.map((x) => P.indexOf(x)), signers: P };
  const st = M.standings(B, { start: U("2026-11-02T00:00Z"), end: U("2026-11-02T06:00Z") }, race(a, "2026-11-02T00").cards);
  const good = await picksRun(U("2026-11-02T06:37Z"), a, { custom: [[W1, st[0].a, 1], [W2, st[1].a, 2]] });
  assert.ok(shapeOk(good));
  const w = week(good), board = JSON.parse(fs.readFileSync(path.join(good, "board.json"), "utf8"));
  const bad1 = tmp(); const w1 = JSON.parse(JSON.stringify(w)); const r1 = w1.races.find((x) => x.result?.picks?.length);
  r1.result.picks[0] = [...r1.result.picks[0].slice(0, 3), 1, 1, 1];
  fs.writeFileSync(path.join(bad1, "W002.json"), JSON.stringify(w1));
  const bad2 = tmp(); const b2 = JSON.parse(JSON.stringify(board)); b2.week.rows[0].shows = 5;
  fs.writeFileSync(path.join(bad2, "board.json"), JSON.stringify(b2));
  const bad3 = tmp(); const b3 = JSON.parse(JSON.stringify(board)); delete b3.week.rows[0].pts;
  fs.writeFileSync(path.join(bad3, "board.json"), JSON.stringify(b3));
  // Points that don't follow from wins and shows; flags that don't follow from the race's own result; true for 1.
  const bad4 = tmp(); const b4 = JSON.parse(JSON.stringify(board)); b4.week.rows[0].pts = 999;
  fs.writeFileSync(path.join(bad4, "board.json"), JSON.stringify(b4));
  const flip = (fn) => { const d = tmp(), w2 = JSON.parse(JSON.stringify(w)), r2 = w2.races.find((x) => x.result?.picks?.length); fn(r2.result.picks); fs.writeFileSync(path.join(d, "W002.json"), JSON.stringify(w2)); return d; };
  const bad5 = flip((pk) => { pk[0][3] = 0; });                       // W1 picked the winner but is marked as not won
  const bad6 = flip((pk) => { pk[1][5] = 0; });                       // W2 picked the 2nd horse but has no show
  const bad7 = flip((pk) => { pk[1][4] = true; });                    // a boolean where a 0/1 belongs
  const bad8 = flip((pk) => { pk[1].splice(1, 1, st[3].a); });        // a show on a horse that finished 4th
  // A winner that isn't first in the standings (flags made to match), or standings out of order or with a repeat.
  const race0 = (fn) => { const d = tmp(), w2 = JSON.parse(JSON.stringify(w)), r2 = w2.races.find((x) => x.result?.picks?.length); fn(r2.result); fs.writeFileSync(path.join(d, "W002.json"), JSON.stringify(w2)); return d; };
  const bad9 = race0((r) => { r.winner = st[3].a; r.picks = r.picks.map((x) => [...x.slice(0, 3), x[1] === st[3].a ? 1 : 0, x[4], 0]); });
  const bad10 = race0((r) => { r.winner = null; r.picks = r.picks.map((x) => [...x.slice(0, 3), 0, x[4], 0]); });
  const bad11 = race0((r) => { r.standings.reverse(); });
  const bad12 = race0((r) => { r.standings.push({ ...r.standings[r.standings.length - 1] }); });
  const bad13 = race0((r) => { r.checked = true; });
  const digits = Number("1".repeat(30));                              // a number that reads as an address once turned into text
  const bad14 = race0((r) => { r.picks[0][0] = digits; });
  const bad15 = tmp(); const b15 = JSON.parse(JSON.stringify(board)); b15.week.rows[0].a = digits;
  fs.writeFileSync(path.join(bad15, "board.json"), JSON.stringify(b15));
  for (const d of [bad1, bad2, bad3, bad4, bad5, bad6, bad7, bad8, bad9, bad10, bad11, bad12, bad13, bad14, bad15]) assert.equal(shapeOk(d), false, d);
});

test("workflow: the recorder holds no secret and no write token; only the publish job pushes, only to race-data, running no repository code", () => {
  const job = (name) => yml.split(/\n  (?=[a-z-]+:\n)/).find((j) => j.startsWith(`${name}:`)) || "";
  const rec = job("record"), pub = job("publish");
  assert.doesNotMatch(yml, /secrets\./);
  assert.doesNotMatch(yml, /\n\s*(pull_request|push):/);
  assert.match(rec, /permissions:\s*\n\s*contents:\s*read/); assert.match(rec, /persist-credentials:\s*false/); assert.match(rec, /npm ci\b[^\n]*--ignore-scripts/);
  assert.match(pub, /permissions:\s*\n\s*contents:\s*write/);
  // (Round 8: the publish job runs one inline `node -e` check, the recorders' own JSON form; never a repository file.)
  assert.doesNotMatch(pub, /actions\/checkout|\bnpm\b|\bnpx\b|\btsx\b|node\s+(--import|--require|-r\s|[\w./-]+\.(m?js|cjs|ts)\b)/, "publish runs no repository code");
  const pushes = pub.split("\n").filter((l) => /git push/.test(l));
  assert.equal(pushes.length, 1); assert.match(pushes[0], /"\$commit:refs\/heads\/race-data"$/); assert.doesNotMatch(pub, /--force/);
  assert.match(pub, /-type l/, "symlinks refused");
});

test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

test("audit BX-4 / BX-37 / BX-55 (round 3): VHP is combined producer by producer: one that differs counts at the LOWER read and is flagged on the card; the card is still made", async () => {
  const at = U("2026-11-02T05:37Z"), log = console.log;
  const off = (f, who = P[1]) => async (w) => Object.fromEntries(w.map((a) => [a, String(Math.round((VHP[P.indexOf(a)] || 0) * 1e8 * (a === who ? f : 1)))]));
  const go = async (f, who) => {
    const out = tmp(); let r; console.log = () => {};
    try { r = await run({ p: node(at), check: node(at), prev: "", out, vhpOf, vhpCheckOf: off(f, who), raceContract: null }); } finally { console.log = log; }
    return { r, out };
  };
  const one = await go(1.5);
  const card = race(one.out, "2026-11-02T06").cards[0], all = [...card.field, ...card.paddock];
  assert.ok(card, "one producer's disagreement no longer holds the card for everyone");
  assert.ok(all.find((x) => x.a === P[1]).vhp < 375, "P[1] is not lifted to the other node's higher read");
  assert.deepEqual(card.flagged, [P[1]], "and it is flagged on the card");
  assert.ok(one.r.problems.some((x) => /disagree on .*VHP/.test(x)));
  const top = await go(10, P[0]);                         // one node says the top producer has 10x: the lower read counts
  const c2 = race(top.out, "2026-11-02T06").cards[0], all2 = [...c2.field, ...c2.paddock];
  assert.ok(all2.find((x) => x.a === P[0]).vhp <= 400, "never the inflated read");
  assert.deepEqual(c2.flagged, [P[0]]);
  const same = await go(1);
  assert.equal(race(same.out, "2026-11-02T06").cards[0].flagged, undefined, "no flag when the nodes agree");
});

test("audit BX-36: the 6 hours of blocks behind the card must match on both nodes; a node that drops a signer gets no card made", async () => {
  const at = U("2026-11-02T05:37Z"), log = console.log, out = tmp();
  const liar = node(at); const call = liar.call.bind(liar);
  liar.call = async (m, a) => { const r = await call(m, a); for (const it of r.block_items) if (it.block.header.signer === P[2]) it.block.header.signer = P[0]; return r; };
  let r; console.log = () => {};
  try { r = await run({ p: liar, check: node(at), prev: "", out, vhpOf, raceContract: null }); } finally { console.log = log; }
  assert.ok(r.problems.some((x) => /disagree about the last 6 hours of blocks/.test(x)));
  assert.ok(!fs.existsSync(path.join(out, "W002.json")) || !race(out, "2026-11-02T06").cards[0], "no card");
});

test("audit BX-3 b: the card uses each producer's highest sampled VHP of the last 6 hours (moving VHP away before a card doesn't pay)", async () => {
  const at = U("2026-11-02T05:37Z"), prev = tmp();
  // P[3] (140 VHP) looked like 400 VHP at a sample 2 hours ago, and now reads 140 (it moved VHP away).
  fs.writeFileSync(path.join(prev, "vhp-samples.json"), JSON.stringify({ v: 1, updated: "2026-11-02T03:37:00.000Z",
    samples: [{ at: at - 2 * H, height: 5000, vhp: { [P[3]]: String(400 * 1e8) } }, { at: at - 7 * H, height: 4000, vhp: { [P[2]]: String(900 * 1e8) } }] }));
  const out = await hourly(at, prev);
  const card = race(out, "2026-11-02T06").cards[0], all = [...card.field, ...card.paddock];
  assert.equal(card.samples, 1, "the card says how many samples it used (fewer than 12: Block X won't score with it)");
  assert.equal(all.find((x) => x.a === P[3]).vhp, 400, "the 6-hour high, not the low read now");
  // P[2]: its 900 sample is older than 6 hours and ignored. (It may rise a little above 200: with P[3] counted at 400,
  // P[2]'s real share of blocks is above its card share, and rule 3 lifts it to what its production supports.)
  const v2 = all.find((x) => x.a === P[2]).vhp;
  assert.ok(v2 >= 200 && v2 < 600, `a sample older than 6 hours is ignored, not its 900 (${v2})`);
});

test("audit BX-44: race cards have exact shapes, and a published card can never change", async () => {
  const a = await hourly(U("2026-11-02T05:37Z"), "");
  const run2 = (dir, pub) => { try { execFileSync("python3", ["-c", checkPy, dir, pub], { stdio: "pipe" }); return true; } catch { return false; } };
  assert.ok(run2(a, a), "the same files again: fine");
  const w = week(a), changed = tmp(), w2 = JSON.parse(JSON.stringify(w));
  const r = w2.races.find((x) => x.cards.some(Boolean)); const i = r.cards.findIndex(Boolean);
  r.cards[i] = { ...r.cards[i], c: r.cards[i].c + 1 };
  fs.writeFileSync(path.join(changed, "W002.json"), JSON.stringify(w2));
  assert.equal(run2(changed, a), false, "a published card would change");
  const extra = tmp(), w3 = JSON.parse(JSON.stringify(w)); const r3 = w3.races.find((x) => x.cards.some(Boolean));
  r3.cards[r3.cards.findIndex(Boolean)].field[0].evil = 1;
  fs.writeFileSync(path.join(extra, "W002.json"), JSON.stringify(w3));
  assert.equal(shapeOk(extra), false, "an extra key in a card row");
});

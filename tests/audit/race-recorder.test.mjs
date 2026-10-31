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
const T0 = U("2026-11-01T00:00:00Z"), N = 9 * 24 * 1200;        // 9 days of blocks (a whole race week and the next day)
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
async function picksRun(at, prev, { winnerFor = null, theirs = null, custom = null, failFor = null, staked = [], stakeFail = null, checkStaked = null } = {}) {
  const out = tmp();
  const picks = (winner) => custom || [[W1, winner, 1], [W2, P[3], 2], [W3, P[3], 3], [GUEST, winner, 4]];
  const picksOf = async (node, r) => (r !== RACE00 ? [] : node === checkNode && theirs ? theirs : picks(winnerFor));
  const pNode = node(at), checkNode = node(at);
  const vhp = async (who) => Object.fromEntries(who.map((a) => [a, a === GUEST ? "0" : a === W3 ? "50000000" : String(5e8)]));   // W3: 0.5 VHP
  const playerOf = async (n, who, week) => { if (who === failFor) throw new Error("node timeout"); return ({ stake: who === W3 ? 10n : 0n, answers: { [W1]: 3, [W2]: 9, [W3]: 1, [GUEST]: 5 }[who] ?? 0, points: { [W1]: 2, [W2]: 7, [W3]: 1, [GUEST]: 4 }[who] ?? 0 }); };
  const log = console.log; console.log = () => {};
  try { await run({ p: pNode, check: checkNode, prev, out, vhpOf: async (w) => ({ ...(await vhpOf(w)), ...(await vhp(w)) }), raceContract: "x", picksOf, playerOf,
    // Staked in the Race (the vault's test), by wallet; the check node may say otherwise, or a read may fail.
    stakedOf: async (n, who) => { if (who === stakeFail) throw new Error("node timeout"); return (n === checkNode && checkStaked ? checkStaked : staked).includes(who); } }); } finally { console.log = log; }
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
  assert.deepEqual([by[W1][4], by[W2][4], by[W3][4], by[GUEST][4]], [0, 0, 0, 0], "the old \"may be ranked\" field is no longer read (always 0)");
  // Leaderboard: correct first, then picks placed, then Knode answers, then Knode score. The guest is listed but not ranked.
  const board = JSON.parse(fs.readFileSync(path.join(b, "board.json"), "utf8"));
  const wk = board.week.rows;
  assert.deepEqual(wk.slice(0, 2).map((x) => x.a).sort(), [W1, GUEST].sort(), "the two right pickers lead");
  assert.deepEqual([wk[0].pts, wk[1].pts], [3, 3], "GUEST and W1 tie on every measure (they share a place; the address only orders them)");
  assert.ok(!("answers" in wk[0]) && !("points" in wk[0]), "no question-game fields (owner, 2026-10-28)");
  // ranked = on the Staked board: staked in the Race in the vault (owner, 2026-10-28). Nobody is here.
  assert.ok(wk.every((x) => x.ranked === false));
  assert.ok(!("real" in wk[0]), "the internal real-player flag is not published");
  assert.equal(board.today.rows.length, 4); assert.equal(board.allTime.rows.length, 4);
  assert.ok(shapeOk(b), "board.json and the picks pass the publish check");
});

test("picks: when the two nodes disagree about the picks, the race stays unfinished", async () => {
  const a = await hourly(U("2026-11-02T05:37Z"), "");
  const b = await picksRun(U("2026-11-02T06:37Z"), a, { winnerFor: P[0], theirs: [[W1, P[1], 1]] });
  assert.equal(race(b, "2026-11-02T00").result, null);
});

test("leaderboard order: points, then more wins, then more picks placed (the question game no longer breaks ties)", async () => {
  const { rank } = await import(path.resolve(APP, "bot/race.ts"));
  const r = (a, correct, shows, picks) => ({ a, pts: 3 * correct + shows, correct, shows, picks, ranked: false });
  const out = rank([r("1d", 2, 0, 5), r("1a", 3, 0, 3), r("1c", 2, 0, 6), r("1b", 2, 0, 5), r("1f", 1, 6, 9), r("1g", 0, 10, 12)]);
  // 1g: 10 shows = 10 pts. 1a: 3 wins = 9 pts beats 1f's 1 win + 6 shows (9 pts) on wins. 1b and 1d tie: the address orders them.
  assert.deepEqual(out.map((x) => x.a), ["1g", "1a", "1f", "1c", "1b", "1d"]);
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
// The check's clock: after the made-up weeks (they are in November 2026); the workflow itself always uses the real one.
const CHECK_NOW = String(Date.parse("2026-11-20T00:00Z") / 1000);
const shapeOk = (dir, now = CHECK_NOW) => { try { execFileSync("python3", ["-c", checkPy, dir], { stdio: "pipe", env: { ...process.env, RACE_CHECK_NOW: now } }); return true; } catch { return false; } };

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

// ── the KnodeGames Vault's results file (race-data/vault/W<week>.json, game 7) ──
const VW = "2026-11-02T00";                                   // the race with picks, in week 2
/** Week 2 with picks on its first race (W1 the winner, W2 2nd, W3 3rd, GUEST the winner but not rankable), and every
 *  other race already recorded as missed, as the hourly runs would have done. Returns that folder. */
async function weekTwoDone({ open = null } = {}) {
  const a = await hourly(U("2026-11-02T05:37Z"), "");
  const B = { ts: chain.ts, sig: chain.who.map((x) => P.indexOf(x)), signers: P };
  const st = M.standings(B, { start: U("2026-11-02T00:00Z"), end: U("2026-11-02T06:00Z") }, race(a, VW).cards);
  const b = await picksRun(U("2026-11-02T06:37Z"), a, { custom: [[W1, st[0].a, 1], [W2, st[1].a, 2], [W3, st[2].a, 3], [GUEST, st[0].a, 4]] });
  const w = week(b);
  for (const r of w.races) if (!r.result && r.id !== open) r.result = { final: true, missed: true, note: "no handicap card was recorded for this race" };
  fs.writeFileSync(path.join(b, "W002.json"), JSON.stringify(w));
  return { dir: b, st };
}
const vaultOf = (dir, w = 2) => { const f = path.join(dir, "vault", `W${w}.json`); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null; };

test("vault: free-prize places from the free players' rows; ties on every measure share a place; at most 10 wallets a place", async () => {
  const { prizePlaces, MAX_PRIZE_WINNERS, VAULT_GAME } = await import(path.resolve(APP, "bot/race.ts"));
  assert.equal(VAULT_GAME, 7); assert.equal(MAX_PRIZE_WINNERS, 10);
  // ranked: false = a free player (not staked in the Race that week).
  const r = (a, pts, extra = {}) => ({ a, pts, correct: Math.floor(pts / 3), shows: pts % 3, picks: 5, ranked: false, ...extra });
  const A = Array.from({ length: 13 }, (_, i) => "1" + String.fromCharCode(65 + i).repeat(33));
  assert.deepEqual(prizePlaces([r(A[0], 9), r(A[1], 7), r(A[2], 7, { picks: 4 })]), { first: [A[0]], second: [A[1]], notes: [] }, "untied (fewer picks ranks lower)");
  assert.deepEqual(prizePlaces([r(A[0], 9), r(A[1], 9), r(A[2], 7)]), { first: [A[0], A[1]], second: [], notes: [] }, "tied for 1st: they share both prizes");
  assert.deepEqual(prizePlaces([r(A[0], 9), r(A[1], 7), r(A[2], 7), r(A[3], 4)]), { first: [A[0]], second: [A[1], A[2]], notes: [] }, "tied for 2nd");
  assert.deepEqual(prizePlaces([r(A[0], 9, { ranked: true }), r(A[1], 7), r(A[2], 0), r(A[3], 0)]), { first: [A[1]], second: [], notes: [] }, "staked and 0-point wallets never place");

  assert.deepEqual(prizePlaces([r(A[0], 0)]), { first: [], second: [], notes: [] }, "nobody qualifies");
  assert.deepEqual(prizePlaces([]), { first: [], second: [], notes: [] });
  // More than 10 tied (owner, 2026-10-28): the 10 with the earliest first pick take the place; the rest get nothing.
  const eleven = A.slice(0, 11).map((a) => r(a, 6));
  const when = new Map(A.map((a, i) => [a, 1000 - i]));               // A[10] picked first, A[0] last
  const x = prizePlaces([...eleven, r(A[12], 3)], when);
  assert.deepEqual([x.first, x.second], [A.slice(1, 11).reverse(), []], "11 tied for 1st: the 10 earliest share 1st; nobody is 2nd");
  assert.match(x.notes[0], /11 wallets are tied for 1st/);
  const y = prizePlaces([r(A[12], 9), ...eleven], when);
  assert.deepEqual([y.first, y.second], [[A[12]], A.slice(1, 11).reverse()], "11 tied for 2nd: the 10 earliest share 2nd"); assert.match(y.notes[0], /tied for 2nd/);
  const same = prizePlaces(A.slice(0, 11).map((a) => r(a, 6)));       // no times: the address decides, so it's repeatable
  assert.deepEqual(same.first, A.slice(0, 10));
  const ten = prizePlaces(A.slice(0, 10).map((a) => r(a, 6)));
  assert.deepEqual([ten.first.length, ten.second.length], [10, 0], "exactly 10 tied share 1st; 2nd stays empty");
});

test("vault: last week's file is final once every race is final, with the free prize's 1st and 2nd; it passes the publish check", async () => {
  const { dir } = await weekTwoDone();
  const out = await picksRun(U("2026-11-09T05:37Z"), dir);
  const v = vaultOf(out);
  assert.deepEqual(v, { game: 7, week: 2, final: true, rows: [], first: [W1, GUEST], second: [], skipped: [] },
    "nobody is staked, so everyone is a free player: W1 and GUEST both won (3 pts, 1 win, 1 pick): they share 1st");
  assert.ok(shapeOk(out));
});

test("vault: not final while a race is still being checked; a race still open 12 hours after the week is skipped", async () => {
  const { dir } = await weekTwoDone({ open: "2026-11-08T18" });
  const out = await picksRun(U("2026-11-09T05:37Z"), dir);
  // The open race ended 5.5 hours ago with blocks on both nodes, so this run finalizes it: only then is the week final.
  assert.equal(race(out, "2026-11-08T18").result.final, true);
  assert.equal(vaultOf(out).final, true);
  const { dir: d2 } = await weekTwoDone({ open: "2026-11-05T12" });   // too old for this run to look at again: stays open
  const o2 = await picksRun(U("2026-11-09T05:37Z"), d2);
  assert.deepEqual(vaultOf(o2), { game: 7, week: 2, final: false, rows: [], first: [], second: [], skipped: [] });
  assert.ok(shapeOk(o2));
  // 12 hours after the week ends, a race that still isn't final is skipped (owner, 2026-10-28) and the week is final.
  const o2b = await picksRun(U("2026-11-09T12:37Z"), o2);
  assert.deepEqual(vaultOf(o2b), { game: 7, week: 2, final: true, rows: [], first: [W1, GUEST], second: [], skipped: ["2026-11-05T12"] });
  assert.ok(shapeOk(o2b));
  const o2a = await picksRun(U("2026-11-09T11:37Z"), o2);
  assert.equal(vaultOf(o2a).final, false, "11 h 37 m after the week: still waiting");
});

test("vault: a file published as final is never rewritten, even if the week's data later reads differently", async () => {
  const { dir } = await weekTwoDone();
  const out = await picksRun(U("2026-11-09T05:37Z"), dir);
  const before = fs.readFileSync(path.join(out, "vault", "W2.json"), "utf8");
  const w = week(out); const r0 = w.races.find((x) => x.id === VW);
  r0.result.picks = r0.result.picks.map((x) => (x[0] === W3 ? [x[0], r0.result.winner, x[2], 1, 1, 0] : x));   // W3 now "won" too
  fs.writeFileSync(path.join(out, "W002.json"), JSON.stringify(w));
  const later = await picksRun(U("2026-11-09T06:37Z"), out);
  assert.equal(fs.readFileSync(path.join(later, "vault", "W2.json"), "utf8"), before);
});

// Blind review V1 (round 10): a wrong vault file is held on its own (the check drops vault/ and passes the rest), so it
// never stops the race cards. held(d): the check passed and took vault/ out; kept(d): it passed and left vault/ in.
const held = (d, now) => shapeOk(d, now) && !fs.existsSync(path.join(d, "vault"));
const kept = (d, now) => shapeOk(d, now) && fs.existsSync(path.join(d, "vault"));
test("publish check: holds vault files that are wrong in any way, and a final file for a week that hasn't ended; the race files still publish", async () => {
  const { dir } = await weekTwoDone();
  const out = await picksRun(U("2026-11-09T05:37Z"), dir);
  const good = vaultOf(out);
  assert.ok(shapeOk(out));
  const A = Array.from({ length: 11 }, (_, i) => "1" + String.fromCharCode(65 + i).repeat(33));
  const row = (player, points) => ({ player, points });
  const okRows = { ...good, first: [], second: [], rows: [row(W1, 255), row(W2, 254), row(W3, 254)] };
  assert.ok((() => { const d = tmp(); fs.mkdirSync(path.join(d, "vault")); fs.writeFileSync(path.join(d, "vault", "W2.json"), JSON.stringify(okRows)); return kept(d); })(), "staked rows are fine");
  const cases = [
    { ...good, game: 2 }, { ...good, first: A }, { ...good, second: [GUEST] }, { ...good, final: false },
    { ...good, first: [W1, W2], second: [W3] }, { ...good, first: ["<img src=x>"] }, { ...good, extra: 1 }, { ...good, final: 1 },
    { ...good, week: "2" }, { ...good, skipped: ["<b>"] }, { ...good, final: false, first: [], second: [], skipped: ["2026-11-05T12"] },
    (({ skipped, ...rest }) => rest)(good),
    { ...okRows, rows: [row(W1, 0)] }, { ...okRows, rows: [row(W1, 256)] }, { ...okRows, rows: [row(W1, 1.5)] },
    { ...okRows, rows: [row(W1, 3), row(W2, 9)] }, { ...okRows, rows: [row(W1, 9), row(W1, 3)] }, { ...okRows, first: [W1] },
    { ...okRows, rows: [{ player: W1, points: 9, stake: 1 }] }, { ...okRows, final: false }, { ...good, first: A.slice(0, 10), second: [W3] },
  ];
  for (const c of cases) {
    const d = tmp(); fs.mkdirSync(path.join(d, "vault")); fs.writeFileSync(path.join(d, "vault", "W2.json"), JSON.stringify(c));
    assert.ok(held(d), JSON.stringify(c));
  }
  const named = tmp(); fs.mkdirSync(path.join(named, "vault")); fs.writeFileSync(path.join(named, "vault", "W3.json"), JSON.stringify(good));
  assert.ok(held(named), "the file name must match its week");
  // Week 2 ends Mon 9 Nov 00:00 UTC: by the runner's clock just before then, a final file is refused; a waiting one is fine.
  const early = tmp(); fs.cpSync(out, early, { recursive: true });
  assert.ok(held(early, String(Date.parse("2026-11-08T23:59Z") / 1000)));
  assert.ok(fs.readdirSync(early).some((f) => /^W[0-9]{3}\.json$/.test(f)), "the week files stay and publish");
  const waiting = tmp(); fs.mkdirSync(path.join(waiting, "vault")); fs.writeFileSync(path.join(waiting, "vault", "W2.json"), JSON.stringify({ ...good, final: false, first: [], second: [] }));
  assert.ok(kept(waiting, String(Date.parse("2026-11-08T23:59Z") / 1000)));
  assert.doesNotMatch(yml.replace(/RACE_CHECK_NOW"\) or time\.time\(\)/, ""), /RACE_CHECK_NOW/, "the workflow never sets the check's clock");
});

// The publish job's shell, run for real against a local copy of the race-data branch (its remote URL redirected).
const publishSh = (() => {
  const step = yml.split("- name: Push race-data (and nothing else)")[1];
  return step.split("\n        run: |\n")[1].split("\n").filter((l) => l.startsWith("          ") || l === "").map((l) => l.slice(10)).join("\n");
})();
function publish(incoming, bare) {
  const env = { ...process.env, IN: incoming, GH_TOKEN: "t", GITHUB_REPOSITORY: "o/r", RUNNER_TEMP: tmp(), RACE_CHECK_NOW: CHECK_NOW,
    GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.${bare}.insteadOf`, GIT_CONFIG_VALUE_0: "https://x-access-token:t@github.com/o/r.git" };
  try { return { ok: true, out: execFileSync("bash", ["-c", publishSh], { cwd: tmp(), env, stdio: "pipe" }).toString() }; }
  catch (e) { return { ok: false, out: String(e.stdout) + String(e.stderr) }; }
}

test("publish job: pushes vault/W<week>.json to race-data and refuses to change a file already published as final", async () => {
  const bare = tmp(); execFileSync("git", ["init", "-q", "--bare", bare]);
  const { dir } = await weekTwoDone();
  const out = await picksRun(U("2026-11-09T05:37Z"), dir);
  const first = publish(out, bare);
  assert.ok(first.ok, first.out);
  const show = (f) => execFileSync("git", ["--git-dir", bare, "show", `race-data:${f}`]).toString();
  assert.deepEqual(JSON.parse(show("vault/W2.json")), vaultOf(out));
  assert.ok(show("W002.json") && show("board.json"));
  // A later run with the same final file: fine. A changed final file: refused, and the branch is unchanged.
  assert.ok(publish(out, bare).ok);
  const head = execFileSync("git", ["--git-dir", bare, "rev-parse", "race-data"]).toString();
  fs.writeFileSync(path.join(out, "vault", "W2.json"), JSON.stringify({ ...vaultOf(out), first: [W3], second: [] }) + "\n");
  const again = publish(out, bare);
  assert.equal(again.ok, false); assert.match(again.out, /Refusing to change vault\/W2\.json/);
  assert.equal(execFileSync("git", ["--git-dir", bare, "rev-parse", "race-data"]).toString(), head);
  // Anything else in vault/ is refused.
  const odd = tmp(); fs.mkdirSync(path.join(odd, "vault")); fs.writeFileSync(path.join(odd, "vault", "notes.json"), "{}");
  assert.equal(publish(odd, bare).ok, false);
});

test("vault: more than 10 tied for 1st, end to end: the 10 that picked first share 1st, the rest get nothing", async () => {
  const a = await hourly(U("2026-11-02T05:37Z"), "");
  const B = { ts: chain.ts, sig: chain.who.map((x) => P.indexOf(x)), signers: P };
  const win = M.standings(B, { start: U("2026-11-02T00:00Z"), end: U("2026-11-02T06:00Z") }, race(a, VW).cards)[0].a;
  // 12 wallets pick the winner (all rankable, the same question-game record), at times 12, 11, ... 1: the last listed picked first.
  const T = Array.from({ length: 12 }, (_, i) => "1" + "C".repeat(31) + "123456789ABC"[i]);
  const b = await picksRun(U("2026-11-02T06:37Z"), a, { custom: T.map((t, i) => [t, win, 12 - i]) });
  const w = week(b);
  for (const r of w.races) if (!r.result) r.result = { final: true, missed: true, note: "no handicap card was recorded for this race" };
  fs.writeFileSync(path.join(b, "W002.json"), JSON.stringify(w));
  const v = vaultOf(await picksRun(U("2026-11-09T05:37Z"), b));
  assert.deepEqual(v.first, T.slice(2).reverse(), "the 10 earliest picks");
  assert.deepEqual(v.second, [], "the 2 latest get nothing (a shared 1st takes both prizes)");
});

// ── staked and free players (owner, 2026-10-28: every game takes stakes) ──
test("stake test: the vault's own rule (peak stake in the Race that week at least the week's minimum)", async () => {
  const { stakedFrom } = await import(path.resolve(APP, "bot/race.ts"));
  const V = 100000000, cfg = { v6_rule_week_plus_one: 3, min_stake: String(V) };
  assert.equal(stakedFrom({ min_stake: String(V) }, { active_stake: String(5 * V) }, 2), false, "before v6 is live nobody is staked");
  assert.equal(stakedFrom(cfg, { entry: { stake: String(2 * V), peak_stake: String(2 * V) } }, 2), true);
  assert.equal(stakedFrom(cfg, { entry: { stake: "0", peak_stake: String(5 * V) } }, 2), true, "withdrew mid-week: still staked that week");
  assert.equal(stakedFrom(cfg, { active_stake: String(V) }, 2), true, "no entry that week: the active stake counts");
  assert.equal(stakedFrom(cfg, { active_stake: String(V / 2) }, 2), false, "under the minimum: a free player");
  assert.equal(stakedFrom(cfg, {}, 2), false, "never staked in the Race (maybe in another game): a free player");
  const raised = { ...cfg, min_stake_next: String(3 * V), min_stake_next_week: 4 };
  assert.deepEqual([3, 4].map((w) => stakedFrom(raised, { active_stake: String(2 * V) }, w)), [true, false], "a new minimum counts from its week");
  const src = fs.readFileSync(path.resolve(APP, "bot/race.ts"), "utf8");
  assert.match(src, /get_game_player\(\{ player: who, game: VAULT_GAME, week: String\(week\) \}\)/, "it asks about the Race (game 7) only");
});

test("vault: a week with staked and free players: staked in rows (255, 254, ...), free players' top 2 in first and second", async () => {
  const { dir } = await weekTwoDone();
  const out = await picksRun(U("2026-11-09T05:37Z"), dir, { staked: [W1, W2] });
  assert.deepEqual(vaultOf(out), { game: 7, week: 2, final: true, skipped: [],
    rows: [{ player: W1, points: 255 }, { player: W2, points: 254 }],     // W1 won (3), W2 showed (1)
    first: [GUEST], second: [W3] });                                     // the free players: GUEST won, W3 showed
  const board = JSON.parse(fs.readFileSync(path.join(out, "board.json"), "utf8"));
  const by = Object.fromEntries(board.lastWeek.rows.map((x) => [x.a, x.ranked]));
  assert.deepEqual(by, { [W1]: true, [W2]: true, [W3]: false, [GUEST]: false }, "the Staked and Free play boards");
  assert.ok(shapeOk(out));
  // Staked players tied on every measure share a points value.
  const { stakedRows } = await import(path.resolve(APP, "bot/race.ts"));
  const r = (a, pts) => ({ a, pts, correct: Math.floor(pts / 3), shows: pts % 3, picks: 4, ranked: true });
  assert.deepEqual(stakedRows([r(W1, 6), r(W2, 6), r(W3, 4), r(GUEST, 0)]).rows,
    [{ player: W1, points: 255 }, { player: W2, points: 255 }, { player: W3, points: 254 }], "ties share; 0 points: not listed");
  const many = Array.from({ length: 300 }, (_, i) => r("1" + "D".repeat(30) + String(1000 + i).replace(/0/g, "z"), 3 * (300 - i)));
  const big = stakedRows(many);
  assert.deepEqual([big.rows[0].points, big.rows[253].points, big.rows[254].points, big.rows[299].points], [255, 2, 1, 1]);
  assert.match(big.notes[0], /300 different scores/);
});

test("vault: nobody staked: rows empty; a failed or disputed stake read keeps the week from being final", async () => {
  const { dir } = await weekTwoDone();
  assert.deepEqual(vaultOf(await picksRun(U("2026-11-09T05:37Z"), dir)).rows, []);
  const { dir: d2 } = await weekTwoDone();
  assert.equal(vaultOf(await picksRun(U("2026-11-09T05:37Z"), d2, { staked: [W1], stakeFail: W3 })).final, false, "W3's stake couldn't be read");
  const { dir: d3 } = await weekTwoDone();
  assert.equal(vaultOf(await picksRun(U("2026-11-09T05:37Z"), d3, { staked: [W1], checkStaked: [W1, W2] })).final, false, "the nodes disagree about W2");
  const { dir: d4 } = await weekTwoDone();
  assert.equal(vaultOf(await picksRun(U("2026-11-09T05:37Z"), d4, { staked: [W1, W2], checkStaked: [W1, W2] })).final, true, "they agree: final");
});

test("vault: when the last run's files are missing, no file is written for last week (never an empty final)", async () => {
  const out = await picksRun(U("2026-11-09T05:37Z"), tmp());
  assert.equal(vaultOf(out), null);
});

test("picks: a race's result needs no wallet reads: a failing question-game node doesn't hold it up", async () => {
  const a = await hourly(U("2026-11-02T05:37Z"), "");
  const b = await picksRun(U("2026-11-02T06:37Z"), a, { winnerFor: P[0], failFor: GUEST });
  assert.equal(race(b, "2026-11-02T00").result.final, true);
});

test("publish job: a final file stays locked even when it was stored pretty-printed", async () => {
  const bare = tmp(); execFileSync("git", ["init", "-q", "--bare", bare]);
  const { dir } = await weekTwoDone();
  const out = await picksRun(U("2026-11-09T05:37Z"), dir);
  const v = vaultOf(out);
  // Round 8 (BX-122): the publish job itself never writes a pretty-printed file: it isn't the recorder's own form.
  fs.writeFileSync(path.join(out, "vault", "W2.json"), JSON.stringify(v, null, 2));
  const pretty = publish(out, bare);
  assert.equal(pretty.ok, false); assert.match(pretty.out, /recorders own JSON form/);
  // But one already on the branch (put there some other way) still locks: "final": true, with a space.
  fs.writeFileSync(path.join(out, "vault", "W2.json"), JSON.stringify(v) + "\n");
  assert.ok(publish(out, bare).ok);
  const wt = tmp(); execFileSync("git", ["clone", "-q", "-b", "race-data", bare, wt]);
  fs.writeFileSync(path.join(wt, "vault", "W2.json"), JSON.stringify(v, null, 2));
  const g = (...a) => execFileSync("git", ["-C", wt, "-c", "user.name=t", "-c", "user.email=t@t", ...a]);
  g("commit", "-qam", "pretty"); g("push", "-q", "origin", "race-data");
  fs.writeFileSync(path.join(out, "vault", "W2.json"), JSON.stringify({ ...v, first: [W3], second: [] }) + "\n");
  const r = publish(out, bare);
  assert.equal(r.ok, false); assert.match(r.out, /Refusing to change vault\/W2\.json/);
});

test("record job: last run's files are read; a missing branch starts fresh; any other failure stops the run", async () => {
  const stepSh = yml.split("- name: Take the last run's race files\n        run: |\n")[1].split("\n      - ")[0]
    .split("\n").map((l) => l.slice(10)).join("\n");
  const runStep = (bare) => {
    const rt = tmp(), cwd = tmp(); execFileSync("git", ["init", "-q", cwd]);
    const env = { ...process.env, RUNNER_TEMP: rt, GITHUB_REPOSITORY: "o/r",
      GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.${bare}.insteadOf`, GIT_CONFIG_VALUE_0: "https://github.com/o/r.git" };
    try { execFileSync("bash", ["-c", stepSh], { cwd, env, stdio: "pipe" }); return { ok: true, prev: path.join(rt, "prev") }; }
    catch (e) { return { ok: false, out: String(e.stdout) + String(e.stderr) }; }
  };
  const empty = tmp(); execFileSync("git", ["init", "-q", "--bare", empty]);
  const fresh = runStep(empty);
  assert.ok(fresh.ok, "no race-data branch yet: fine"); assert.deepEqual(fs.readdirSync(fresh.prev), []);
  const broken = runStep(path.join(tmp(), "no-such-repo"));
  assert.equal(broken.ok, false, "can't reach the branch: the run stops"); assert.match(broken.out, /Couldn't read the race-data branch/);
  // A real branch: the published files, the vault folder included, come back.
  const { dir } = await weekTwoDone();
  const out = await picksRun(U("2026-11-09T05:37Z"), dir);
  assert.ok(publish(out, empty).ok);
  const got = runStep(empty);
  assert.ok(got.ok);
  assert.equal(fs.readFileSync(path.join(got.prev, "vault", "W2.json"), "utf8"), fs.readFileSync(path.join(out, "vault", "W2.json"), "utf8"));
  assert.ok(fs.existsSync(path.join(got.prev, "W002.json")) && fs.existsSync(path.join(got.prev, "board.json")));
});

test("vault: with this repository's v5 contract ABI the stakes can't be read: the file is never final (fails closed)", async () => {
  const abi = JSON.parse(fs.readFileSync(path.resolve(APP, "game/abi/kpred.koilib.json"), "utf8"));
  const { NO_V6_ABI } = await import(path.resolve(APP, "bot/race.ts"));
  const { dir } = await weekTwoDone();
  const out = tmp();
  const log = console.log; const lines = []; console.log = (x) => lines.push(String(x));
  try {
    // The recorder's own stake reader (no stakedOf), against the made-up chain.
    await run({ p: node(U("2026-11-09T05:37Z")), check: node(U("2026-11-09T05:37Z")), prev: dir, out, vhpOf, raceContract: "x",
      picksOf: async () => [] });
  } finally { console.log = log; }
  if (abi.methods.get_game_player) return;                          // the v6 ABI has landed: covered by the other tests
  assert.equal(vaultOf(out).final, false);
  assert.equal(lines.filter((l) => l.includes(NO_V6_ABI)).length, 1, "one warning a run, not one per wallet");
  const board = JSON.parse(fs.readFileSync(path.join(out, "board.json"), "utf8"));
  assert.ok(board.lastWeek.rows.every((r) => r.ranked === false), "the boards show everyone on Free play meanwhile");
});

test("boards: each row's place on its own board (Staked or Free play), tied wallets sharing it", async () => {
  const { withPlaces } = await import(path.resolve(APP, "bot/race.ts"));
  const r = (a, pts, ranked, picks = 3) => ({ a, pts, correct: Math.floor(pts / 3), shows: pts % 3, picks, ranked });
  const out = withPlaces([r("s1", 9, true), r("f1", 7, false), r("f2", 7, false), r("s2", 6, true), r("s3", 6, true), r("f3", 4, false), r("f4", 4, false, 4)]);
  assert.deepEqual(out.map((x) => [x.a, x.boardPlace]), [["s1", 1], ["f1", 1], ["f2", 1], ["s2", 2], ["s3", 2], ["f3", 3], ["f4", 4]]);
  // In the recorder's output too, and the publish check insists on it.
  const { dir } = await weekTwoDone();
  const o = await picksRun(U("2026-11-09T05:37Z"), dir, { staked: [W1] });
  const board = JSON.parse(fs.readFileSync(path.join(o, "board.json"), "utf8"));
  const places = Object.fromEntries(board.lastWeek.rows.map((x) => [x.a, [x.ranked, x.boardPlace]]));
  assert.deepEqual(places, { [W1]: [true, 1], [GUEST]: [false, 1], [W2]: [false, 2], [W3]: [false, 2] },
    "W1 alone on Staked; on Free play GUEST is 1st and W2 and W3 tie for 2nd (1 show each)");
  assert.ok(shapeOk(o));
  const bad = tmp(); const b2 = JSON.parse(JSON.stringify(board)); delete b2.lastWeek.rows[0].boardPlace;
  fs.writeFileSync(path.join(bad, "board.json"), JSON.stringify(b2)); assert.equal(shapeOk(bad), false);
});

test("vault: a failure of the whole stake read (not one wallet's) is reported once a run, and the file stays not final", async () => {
  const { dir } = await weekTwoDone();
  const out = tmp(), lines = [], log = console.log; console.log = (x) => lines.push(String(x));
  try {
    await run({ p: node(U("2026-11-09T05:37Z")), check: node(U("2026-11-09T05:37Z")), prev: dir, out, vhpOf, raceContract: "x", picksOf: async () => [],
      stakedOf: async () => { throw Object.assign(new Error("the vault's get_state came back empty: Race stakes can't be read"), { once: true }); } });
  } finally { console.log = log; }
  assert.equal(vaultOf(out).final, false);
  assert.equal(lines.filter((l) => l.includes("get_state came back empty")).length, 1);
});

// ── who earns: only they get a medal (owner, 2026-10-29) ──
test("earns: the staked bucket's winners by the vault's rule (top 30% by headcount, rounded up, a tied group taken whole)", async () => {
  const { stakedWinners, withEarns } = await import(path.resolve(APP, "bot/race.ts"));
  const r = (a, pts, extra = {}) => ({ a, pts, correct: Math.floor(pts / 3), shows: pts % 3, picks: 5, ranked: true, earning: true, ...extra });
  const ten = Array.from({ length: 10 }, (_, i) => r("s" + i, 30 - i));
  assert.deepEqual([...stakedWinners(ten)], ["s0", "s1", "s2"], "10 players: 3 win");
  const tie = [r("a", 9), r("b", 9), r("c", 7), r("d", 7), r("e", 7), r("f", 4), r("g", 3), r("h", 2), r("i", 1), r("j", 1)];
  assert.deepEqual([...stakedWinners(tie)], ["a", "b", "c", "d", "e"], "need 3: the 7-point group at the line is taken whole");
  assert.deepEqual([...stakedWinners([r("x", 5), r("y", 4, { earning: false }), r("z", 0)])], ["x"], "withdrew below the minimum, or 0 points: not counted");
  assert.deepEqual([...stakedWinners([r("x", 5, { ranked: false })])], [], "free players aren't in the bucket");
  // Both boards together, and nothing earned outside the weekly boards.
  const mixed = [r("s1", 9), r("f1", 7, { ranked: false }), r("s2", 6), r("f2", 6, { ranked: false }), r("f3", 6, { ranked: false }), r("s3", 3)];
  const out = Object.fromEntries(withEarns(mixed, new Map()).map((x) => [x.a, x.earns]));
  assert.deepEqual(out, { s1: 3, f1: 1, s2: 0, f2: 2, f3: 2, s3: 0 }, "staked: 1 of 3 wins; free: f1 1st, f2 and f3 tie for 2nd");
  assert.ok(withEarns(mixed, null).every((x) => x.earns === 0), "Today and All time: no medals");
});

test("earns: in the recorder's board, weekly boards only; >10 free tied: the 10 earliest; the publish check holds it", async () => {
  const a = await hourly(U("2026-11-02T05:37Z"), "");
  const B = { ts: chain.ts, sig: chain.who.map((x) => P.indexOf(x)), signers: P };
  const win = M.standings(B, { start: U("2026-11-02T00:00Z"), end: U("2026-11-02T06:00Z") }, race(a, VW).cards)[0].a;
  const Tw = Array.from({ length: 12 }, (_, i) => "1" + "C".repeat(31) + "123456789ABC"[i]);
  const b = await picksRun(U("2026-11-02T06:37Z"), a, { custom: Tw.map((t, i) => [t, win, 12 - i]) });
  const board = JSON.parse(fs.readFileSync(path.join(b, "board.json"), "utf8"));
  const earns = Object.fromEntries(board.week.rows.map((x) => [x.a, x.earns]));
  assert.deepEqual(Tw.filter((t) => earns[t] === 1), Tw.slice(2), "the 10 earliest pickers get the 1st-place medal");
  assert.deepEqual([earns[Tw[0]], earns[Tw[1]]], [0, 0], "the 2 latest get none (a shared 1st leaves no 2nd)");
  assert.ok(board.today.rows.every((x) => x.earns === 0) && board.allTime.rows.every((x) => x.earns === 0));
  assert.ok(!("earning" in board.week.rows[0]), "the internal flag isn't published");
  assert.ok(shapeOk(b));
  for (const bad of [{ earns: 3 }, { earns: 4 }, { earns: "1" }]) {
    const d = tmp(), j = JSON.parse(JSON.stringify(board)); Object.assign(j.week.rows[0], bad);
    fs.writeFileSync(path.join(d, "board.json"), JSON.stringify(j)); assert.equal(shapeOk(d), false, JSON.stringify(bad));
  }
});

test("blind review V1 (round 10): the publish job holds a bad vault file and still pushes the race files; a final one never changes", async () => {
  const bare = tmp(); execFileSync("git", ["init", "-q", "--bare", bare]);
  const { dir } = await weekTwoDone();
  const out = await picksRun(U("2026-11-09T05:37Z"), dir);
  const v = vaultOf(out);
  fs.writeFileSync(path.join(out, "vault", "W2.json"), JSON.stringify({ ...v, first: [W1], second: [W1] }) + "\n");   // a wallet twice
  const r = publish(out, bare);
  assert.ok(r.ok, r.out); assert.match(r.out, /vault results held, not published this run: vault\/W2\.json/);
  const files = execFileSync("git", ["--git-dir", bare, "ls-tree", "-r", "--name-only", "race-data"]).toString().split("\n");
  assert.ok(files.includes("W002.json") && files.includes("board.json"), "the race files are published");
  assert.ok(!files.some((f) => f.startsWith("vault/")), "the bad vault file isn't");
  // A good final file publishes; a later changed one is still refused outright (the lock holds).
  const again = await picksRun(U("2026-11-09T05:37Z"), dir);
  assert.ok(publish(again, bare).ok);
  fs.writeFileSync(path.join(again, "vault", "W2.json"), JSON.stringify({ ...vaultOf(again), first: [W3], second: [] }) + "\n");
  const ch = publish(again, bare);
  assert.equal(ch.ok, false); assert.match(ch.out, /Refusing to change vault\/W2\.json/);
});

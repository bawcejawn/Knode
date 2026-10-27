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
  try { await run({ p: node(at), check: opts.check === null ? null : node(at, opts.check || {}), prev, out, vhpOf }); } finally { console.log = log; }
  return out;
}
const week = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "W002.json"), "utf8"));
const race = (dir, id) => week(dir).races.find((r) => r.id === id);

test("cards: the run just before a leg takes its card; a run during a leg with no card takes it; nothing is retaken", async () => {
  const a = await hourly(U("2026-11-02T05:37Z"), "");
  assert.ok(race(a, "2026-11-02T00").cards[2], "05:37: the 04:00 leg had no card yet: taken now");
  assert.ok(race(a, "2026-11-02T06").cards[0], "05:37: the 06:00 leg starts in 23 minutes: taken now");
  assert.equal(race(a, "2026-11-02T06").cards[1], null, "the 08:00 leg is not due yet");
  const b = await hourly(U("2026-11-02T06:37Z"), a);
  assert.equal(race(b, "2026-11-02T06").cards[0].at, race(a, "2026-11-02T06").cards[0].at, "never retaken");
  assert.equal(race(b, "2026-11-02T06").cards[1], null, "08:00 is 83 minutes away: the 07:37 run takes it");
  const c = await hourly(U("2026-11-02T07:37Z"), b);
  assert.ok(race(c, "2026-11-02T06").cards[1] && race(c, "2026-11-02T06").cards[1].at < U("2026-11-02T08:00Z"));
  // Each card is the shared math's card for the producers' VHP.
  const card = race(c, "2026-11-02T06").cards[1];
  assert.equal(card.field[0].a, P[0]); assert.equal(card.field[0].h, 1);
  assert.ok(card.paddock.some((x) => x.a === P[4]), "the smallest producer (k under 10) waits in the paddock");
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

test("workflow: the recorder holds no secret and no write token; only the publish job pushes, only to race-data, running no repository code", () => {
  const job = (name) => yml.split(/\n  (?=[a-z-]+:\n)/).find((j) => j.startsWith(`${name}:`)) || "";
  const rec = job("record"), pub = job("publish");
  assert.doesNotMatch(yml, /secrets\./);
  assert.doesNotMatch(yml, /\n\s*(pull_request|push):/);
  assert.match(rec, /permissions:\s*\n\s*contents:\s*read/); assert.match(rec, /persist-credentials:\s*false/); assert.match(rec, /npm ci\b[^\n]*--ignore-scripts/);
  assert.match(pub, /permissions:\s*\n\s*contents:\s*write/);
  assert.doesNotMatch(pub, /actions\/checkout|\bnpm\b|\bnpx\b|\btsx\b|node\s/, "publish runs no repository code");
  const pushes = pub.split("\n").filter((l) => /git push/.test(l));
  assert.equal(pushes.length, 1); assert.match(pushes[0], /"\$commit:refs\/heads\/race-data"$/); assert.doesNotMatch(pub, /--force/);
  assert.match(pub, /-type l/, "symlinks refused");
});

test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

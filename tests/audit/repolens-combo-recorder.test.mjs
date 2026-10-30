// Reviewer C-R failing tests (node:test). NOT RUN HERE (static review). Drop into tests/audit/ and run with APP=. like
// tests/audit/combo-recorder.test.mjs: they import the REAL bot/games/combo.ts and read the REAL .github/workflows/combo.yml.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { execFileSync } from "node:child_process";
const APP = process.env.APP || ".";
const { run } = await import(path.resolve(APP, "bot/games/combo.ts"));
const M = globalThis.KRaceMath, X = globalThis.KBlockX, C = globalThis.KCombo;
const H1 = "1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", H2 = "1BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", H3 = "1CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC", H4 = "1DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD";
const ALICE = "1EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE";
const W3 = M.weekStart(3), H0 = 48_000_000, D3 = C.utcDay(W3);
const heightAt = (t) => H0 + Math.floor((t - W3) / 3000), timeAt = (h) => W3 + (h - H0) * 3000;
// (Combo fix round: cards carry 12 VHP samples, as the race recorder writes them; RL-8.)
const CARD = (at, extra = {}) => ({ at, c: 0, blocksPerRace: 7200, fairness: null, samples: 12, ...extra,
  field: [{ a: H1, vhp: 4000, k: 600, h: 1 }, { a: H2, vhp: 2000, k: 300, h: 2 }, { a: H3, vhp: 1300, k: 200, h: 3 }, { a: H4, vhp: 700, k: 100, h: 6 }], paddock: [] });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cr-"));
const W = (w) => `W${String(w).padStart(3, "0")}.json`;
function raceDir({ noResult = new Set(), from = 2, to = 5, cardsUntil = Infinity, resultsUntil = Infinity, card = CARD } = {}) {
  const d = tmp();
  for (let w = from; w <= to; w++) {
    const races = [];
    for (let t = M.weekStart(w); t < M.weekStart(w + 1); t += M.RACE) {
      const i = M.raceIndex(t);
      const result = noResult.has(i) || t + M.RACE > resultsUntil ? null : { final: true, checked: 2, standings: [H1, H2, H3, H4].map((a, k) => ({ a, steps: 100 - k * 10, blocks: 10 })) };
      races.push({ id: M.raceId(i), start: t, end: t + M.RACE, cards: [t + 60000 < cardsUntil ? card(t + 60000) : null, null, null, null, null, null], result });
    }
    fs.writeFileSync(path.join(d, W(w)), JSON.stringify({ v: 1, week: w, start: M.weekStart(w), end: M.weekStart(w + 1), races }));
  }
  return d;
}
function blockxDir({ from = 2, to = 5, voids = new Map() } = {}) {
  const d = tmp();
  for (let w = from; w <= to; w++) {
    const targets = [];
    for (let r = Math.ceil(heightAt(M.weekStart(w)) / X.ROUND); X.target(r) < heightAt(M.weekStart(w + 1)); r++) {
      const t = { round: r, height: X.target(r), final: true, checked: 2, signer: r % 2 === 0 ? H1 : H2, time: timeAt(X.target(r)), lockTime: 0, card: null, picks: [] };
      if (voids.has(r)) t.void = voids.get(r);
      targets.push(t);
    }
    fs.writeFileSync(path.join(d, W(w)), JSON.stringify({ v: 1, week: w, start: M.weekStart(w), end: M.weekStart(w + 1), targets }));
  }
  return d;
}
const headAt = (t) => ({ height: heightAt(t), time: t, lib: heightAt(t) - 60, libTime: t - 180000 });
/** A koilib-like node for headOf(): its own head time (possibly a lie), the true irreversible block. */
function node(trueT, claimed = trueT) {
  const h = headAt(trueT);
  return { async getHeadInfo() { return { last_irreversible_block: String(h.lib), head_block_time: String(claimed), head_topology: { id: "0x00", height: String(h.height) } }; },
    async call(_m, a) { return { block_items: [{ block_height: a.ancestor_start_height, block: { header: { timestamp: String(h.libTime) } } }] }; } };
}
const quiet = async (f) => { const l = console.log; console.log = () => {}; try { return await f(); } finally { console.log = l; } };
const read = (d, f) => JSON.parse(fs.readFileSync(path.join(d, f), "utf8"));
const staked = async (_w, who) => new Map(who.map((a) => [a, true]));
// (Combo fix round: one file per UTC day, RL-6.)
const slot0 = (out, day = D3) => read(out, `D${String(day).padStart(5, "0")}.json`).slots.find((s) => s.round === C.slotRound(day, 0)).cards;

test("C-R-1: one node's head time can't trigger the deadline (a lying primary must not void a pending leg)", async () => {
  const mon18 = D3 * 4 + 3, tue00 = D3 * 4 + 4, sent = D3 * M.DAY + 3600000;
  const legs = [{ code: C.WIN, round: mon18, producer: H1 }, { code: C.SHOW, round: mon18, producer: H2 }, { code: C.WIN, round: tue00, producer: H4 }];
  const cardsOf = async (_n, r) => (r === C.slotRound(D3, 0) ? [{ player: ALICE, legs, time: sent, height: heightAt(sent), changes: 0 }] : []);
  const now = (D3 + 1) * M.DAY + 3 * 3600000, lie = M.weekStart(4) + 2 * M.DAY + 60000, out = tmp();
  // NOTE: no `head:` option, so run() reads both nodes through headOf() (the real path the owner's tests never take).
  // (Fix-check FC-25: this machine's clock is set past the lie, so only the two-node rule can protect the leg.)
  await quiet(() => run({ p: node(now, lie), check: node(now), out, raceDir: raceDir({ noResult: new Set([tue00]) }), blockxDir: blockxDir(), picksContract: "1P", cardsOf, stakedOf: staked, now: lie + 3600000 }));
  const c = slot0(out)[0];
  assert.equal(c.legs[2][4], "pending", "the Tue 00:00 race isn't over: its leg must not be voided because one node claims a later time");
  assert.equal(c.state, "pending");
});

test("C-R-2: a Block X target with a known signer, voided only for Block X's own scoring, still decides a Combo leg", async () => {
  const mon18 = D3 * 4 + 3, sent = D3 * M.DAY + 3600000, r0 = Math.floor(heightAt(D3 * M.DAY + 20 * 3600000) / X.ROUND), odd = r0 % 2 ? r0 : r0 + 1;
  const legs = [{ code: C.WIN, round: mon18, producer: H1 }, { code: C.SHOW, round: mon18, producer: H2 }, { code: C.BLOCK, round: odd, producer: H1 }];
  const cardsOf = async (_n, r) => (r === C.slotRound(D3, 0) ? [{ player: ALICE, legs, time: sent, height: heightAt(sent), changes: 0 }] : []);
  const now = (D3 + 2) * M.DAY + 12 * 3600000, out = tmp();
  const bx = blockxDir({ voids: new Map([[odd, "the two nodes disagreed about the signer's VHP on the lock's handicap card; no points"]]) });
  await quiet(() => run({ p: "p", check: "c", head: headAt(now), out, raceDir: raceDir(), blockxDir: bx, picksContract: "1P", cardsOf, stakedOf: staked }));
  const c = slot0(out)[0];
  assert.equal(c.legs[2][4], "miss", "H2 signed (checked on 2 nodes): H1's leg missed");
  assert.equal(c.outcome, "miss");
});

test("C-R-3: race cards the race recorder flags (thin samples, nodes disagreeing on VHP, top in doubt) don't price Block X legs", () => {
  const leg = { code: C.BLOCK, round: 20001, producer: H4 };
  // (Combo fix round: on the review's honest card H4 holds 700 of 8,000 VHP, already a ×3 long shot, so "< 300" could
  // never hold; here H4 is big on the honest card, as the attack needs: a lying node then makes it look tiny.)
  const big = CARD(0).field.map((r) => (r.a === H4 ? { ...r, vhp: 6000 } : r));
  const honest = { ...CARD(1000), field: big }, flagged = { ...CARD(2000, { flagged: [H4], samples: 1 }), field: CARD(0).field.map((r) => (r.a === H4 ? { ...r, vhp: 1 } : r)) };
  // The card in force at sending is the flagged one (a lying VHP node made H4 look tiny): it must not set the price.
  const picked = C.priceCard([{ cards: [honest, flagged] }], 3000, H4);
  assert.notEqual(picked, flagged, "a flagged / thin-sample card must not be the price card");
  assert.equal(picked, honest);
  assert.ok(C.priceLeg(picked, leg).f100 < 300);
  // (Fix-check FC-8: flags are per producer, as Block X's flags(card, signer).)
  for (const bad of [{ ...honest, flagged: [H4] }, { ...honest, topInDoubt: true }]) assert.equal(C.priceCard([{ cards: [bad] }], 3000, H4), null, "flagged for H4, or the top in doubt: not H4's price card");
  for (const bad of [{ ...honest, samples: 11 }, { ...honest, samples: undefined }]) assert.equal(C.priceCard([{ cards: [bad] }], 3000), null, "under 12 samples: not usable");
});

test("C-R-4: a busy week (200 wallets x 3 six-leg cards a day) still publishes, and the Vault file is never blocked by another file", async () => {
  const addr = (p, i) => "1" + p + String(i).padStart(33 - p.length, "1").replace(/0/g, "z");
  const players = Array.from({ length: 200 }, (_, i) => addr("W", i)), P5 = addr("Pa", 5), P6 = addr("Pb", 6);
  const cardsOf = async (_n, round) => {
    const day = C.dayOfRound(round), t = day * M.DAY + 3600000 * (1 + (round % 3)), rr = day * 4 + 3, b = Math.floor(heightAt(day * M.DAY + 20 * 3600000) / X.ROUND);
    const legs = [{ code: 1, round: rr, producer: H1 }, { code: 2, round: rr, producer: H2 }, { code: 3, round: rr, producer: H3 }, { code: 1, round: rr + 1, producer: P5 }, { code: 2, round: rr + 1, producer: P6 }, { code: 4, round: b, producer: H4 }];
    return players.map((p) => ({ player: p, legs, time: t, height: heightAt(t), changes: 3 }));
  };
  const out = tmp(), now = M.weekStart(4) + 13 * 3600000;
  await quiet(() => run({ p: "p", check: "c", head: headAt(now), out, raceDir: raceDir(), blockxDir: blockxDir(), picksContract: "1P", cardsOf, stakedOf: staked }));
  for (const f of fs.readdirSync(out)) if (f.endsWith(".json")) assert.ok(fs.statSync(path.join(out, f)).size <= 2048 * 1024, `${f} is over the publish job's 2 MB limit`);
});

/** combo.yml's publish step, verbatim except the remote (a local bare repo). Returns { ok, out }. */
function publish(IN, remote) {
  const y = fs.readFileSync(path.resolve(APP, ".github/workflows/combo.yml"), "utf8").split("\n");
  const i = y.findIndex((l) => l.includes("Push games-data/combo (and nothing else)")), j = y.findIndex((l, k) => k > i && l.trim() === "run: |");
  const body = y.slice(j + 1).map((l) => (l.startsWith("          ") ? l.slice(10) : l)).join("\n").replace(/remote="https:[^\n]*"/, 'remote="$REMOTE"');
  const sh = path.join(tmp(), "p.sh"); fs.writeFileSync(sh, "set -euo pipefail\n" + body);
  try { return { ok: true, out: execFileSync("bash", [sh], { env: { ...process.env, IN, REMOTE: remote, RUNNER_TEMP: tmp() }, cwd: tmp(), stdio: "pipe" }).toString() }; }
  catch (e) { return { ok: false, out: String(e.stdout) + String(e.stderr) }; }
}
test("C-R-5: the publish job never replaces a published Vault file, and takes one only for the week that just ended (job clock)", () => {
  const T = tmp(), remote = path.join(T, "r.git"); execFileSync("git", ["init", "-q", "--bare", remote]);
  const seed = path.join(T, "s"); fs.mkdirSync(path.join(seed, "combo/vault"), { recursive: true });
  const v = (week, who) => JSON.stringify({ game: 8, week, final: true, rows: [{ player: who, points: 255 }], first: [], second: [] });
  fs.writeFileSync(path.join(seed, "combo/vault/W2.json"), v(2, ALICE));
  const g = (...a) => execFileSync("git", ["-C", seed, "-c", "user.name=t", "-c", "user.email=t@t", ...a]);
  g("init", "-q"); g("add", "-A"); g("commit", "-qm", "s"); g("push", "-q", remote, "HEAD:refs/heads/games-data");
  const IN = tmp(); fs.mkdirSync(path.join(IN, "combo/vault"), { recursive: true });
  fs.writeFileSync(path.join(IN, "combo/vault/W2.json"), v(2, H1));      // a different file for an already-published week
  fs.writeFileSync(path.join(IN, "combo/vault/W999.json"), v(999, H1));  // a week far in the future
  publish(IN, remote);
  const show = (p) => { try { return execFileSync("git", ["--git-dir", remote, "show", `games-data:${p}`]).toString().trim(); } catch { return null; } };
  assert.equal(show("combo/vault/W2.json"), v(2, ALICE), "a published Vault file is write-once");
  assert.equal(show("combo/vault/W999.json"), null, "a Vault file for a week that hasn't ended is held");
});

test("C-R-5b: a fixed slot in the previous files is checked against the chain before its cards reach the Vault file", async () => {
  const MAL = "1MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM", round = C.slotRound(D3, 0), prev = tmp();
  const fake = { player: MAL, round, time: D3 * M.DAY + 3600000, changes: 0, priceAt: D3 * M.DAY, settled: D3 * M.DAY,
    legs: Array.from({ length: 10 }, (_, i) => [1, 99000 + i, H1, 300, "hit"]), state: "final", outcome: "hit", pts: 0 };
  // (Fix-check FC-25: the earlier file in the format the recorder reads now, a day file, so the test can fail.)
  fake.pts = 2 * 0 + C.pointsFor(fake.legs.map((l) => l[3]));
  fs.writeFileSync(path.join(prev, `D${String(D3).padStart(5, "0")}.json`), JSON.stringify({ v: 2, day: D3, start: D3 * M.DAY, slots: [{ round, fixed: true, cards: [fake] }] }));
  fs.writeFileSync(path.join(prev, "index.json"), JSON.stringify({ v: 2, updated: "2026-11-09T00:00:00.000Z", days: [D3], contract: null }));
  const out = tmp();
  await quiet(() => run({ p: "p", check: "c", head: headAt(M.weekStart(4) + 13 * 3600000), prev, out, raceDir: raceDir(), blockxDir: blockxDir(), picksContract: "1P", cardsOf: async () => [], stakedOf: staked }));
  const vf = path.join(out, "vault", "W3.json");
  assert.ok(!fs.existsSync(vf) || !read(out, "vault/W3.json").rows.some((r) => r.player === MAL), "a card the chain never had must not reach the Vault");
});

test("C-R-6: a race recorder that stops mid-week (its file exists) is an outage at the deadline: an ::error::, not a silent void", async () => {
  const D = D3 + 5, sat06 = D * 4 + 1, sat18 = D * 4 + 3, sat12 = D * M.DAY + 12 * 3600000, sent = D * M.DAY + 3600000;
  const legs = [{ code: C.WIN, round: sat06, producer: H1 }, { code: C.SHOW, round: sat06, producer: H2 }, { code: C.WIN, round: sat18, producer: H4 }];
  const cardsOf = async (_n, r) => (r === C.slotRound(D, 0) ? [{ player: ALICE, legs, time: sent, height: heightAt(sent), changes: 0 }] : []);
  const out = tmp();
  const r = await quiet(() => run({ p: "p", check: "c", head: headAt(M.weekStart(4) + 2 * M.DAY + 3600000), out, raceDir: raceDir({ from: 2, to: 3, cardsUntil: sat12, resultsUntil: sat12 }), blockxDir: blockxDir(), picksContract: "1P", cardsOf, stakedOf: staked }));
  const c = slot0(out, D)[0];
  assert.notEqual(c.outcome, "hit", "the Sat 18:00 leg (a real miss) must not be dropped while its race is unrecorded");
  assert.ok(r.errors.length > 0, "an ::error:: is raised");
});

test("C-R-7: after merging with the picks branch the recorder still loads its shared math", async () => {
  // Run on the merged checkout (APP=<merge>): picks moved site/*.js to the repo root.
  for (const f of ["site/race-math.js", "site/blockx-math.js", "site/combo-math.js"]) {
    const s = fs.readFileSync(path.resolve(APP, "bot/games/combo.ts"), "utf8");
    if (s.includes(`../../${f}`)) assert.ok(fs.existsSync(path.resolve(APP, f)), `bot/games/combo.ts imports ${f}, which isn't in this tree`);
  }
  assert.ok(!(fs.existsSync(path.resolve(APP, "blockx-math.js")) && fs.existsSync(path.resolve(APP, "site/blockx-math.js"))), "one copy of the Block X math, not two");
});

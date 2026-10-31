// Reviewer D-C failing tests (node:test). NOT RUN HERE (static review). Drop into tests/audit/ and run with APP=. like
// tests/audit/repolens-combo-recorder.test.mjs: they import the REAL bot/games/combo.ts and run the REAL combo.yml publish step.
// Helpers below are copied verbatim from tests/audit/repolens-combo-recorder.test.mjs:3-57 and :110-118 (publish()).
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

/** combo.yml's publish step, verbatim except the remote (a local bare repo). Returns { ok, out }. */
function publish(IN, remote) {
  const y = fs.readFileSync(path.resolve(APP, ".github/workflows/combo.yml"), "utf8").split("\n");
  const i = y.findIndex((l) => l.includes("Push games-data/combo (and nothing else)")), j = y.findIndex((l, k) => k > i && l.trim() === "run: |");
  const body = y.slice(j + 1).map((l) => (l.startsWith("          ") ? l.slice(10) : l)).join("\n").replace(/remote="https:[^\n]*"/, 'remote="$REMOTE"');
  const sh = path.join(tmp(), "p.sh"); fs.writeFileSync(sh, "set -euo pipefail\n" + body);
  try { return { ok: true, out: execFileSync("bash", [sh], { env: { ...process.env, IN, REMOTE: remote, RUNNER_TEMP: tmp() }, cwd: tmp(), stdio: "pipe" }).toString() }; }
  catch (e) { return { ok: false, out: String(e.stdout) + String(e.stderr) }; }
}

// ── D-C additions ──
const { NonCanonicalTransfer } = await import(path.resolve(APP, "bot/games/blockx.ts"));
/** A bare remote whose games-data holds the files of `dir` (combo/...). */
function remoteWith(dir) {
  const T = tmp(), remote = path.join(T, "r.git"); execFileSync("git", ["init", "-q", "--bare", remote]);
  const s = path.join(T, "s"); fs.cpSync(dir, path.join(s, "combo"), { recursive: true });
  const g = (...a) => execFileSync("git", ["-C", s, "-c", "user.name=t", "-c", "user.email=t@t", ...a]);
  g("init", "-q"); g("add", "-A"); g("commit", "-qm", "s"); g("push", "-q", remote, "HEAD:refs/heads/games-data");
  return remote;
}
const show = (remote, p) => { try { return execFileSync("git", ["--git-dir", remote, "show", `games-data:${p}`]).toString(); } catch { return null; } };
/** publish() with the job's clock pinned (CHECK_NOW_MS, the hook the workflow's own tests use). */
function publishAt(IN, remote, now) { const o = process.env.CHECK_NOW_MS; process.env.CHECK_NOW_MS = String(now); try { return publish(IN, remote); } finally { if (o === undefined) delete process.env.CHECK_NOW_MS; else process.env.CHECK_NOW_MS = o; } }
const asIncoming = (out) => { const IN = tmp(); fs.cpSync(out, path.join(IN, "combo"), { recursive: true }); return IN; };
const oneCard = (legs, sent = D3 * M.DAY + 3600000) => async (_n, r) => (r === C.slotRound(D3, 0) ? [{ player: ALICE, legs, time: sent, height: heightAt(sent), changes: 0 }] : []);
const mon18 = D3 * 4 + 3;

test("D-C-1: a Vault file is judged against a published board whose lastWeek agrees with the PUBLISHED final cards", async () => {
  // Honest week 3 published (Alice's final card); then one bad run publishes a board whose final lastWeek ranks MAL first.
  const now = M.weekStart(4) + 14 * 3600000, out = tmp();
  await quiet(() => run({ p: "p", check: "c", head: headAt(now), out, raceDir: raceDir(), blockxDir: blockxDir(), picksContract: "1P", cardsOf: oneCard([{ code: C.WIN, round: mon18, producer: H1 }, { code: C.SHOW, round: mon18, producer: H2 }]), stakedOf: staked }));
  fs.rmSync(path.join(out, "vault"), { recursive: true, force: true });
  const MAL = "1MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM", b = read(out, "board.json");
  assert.equal(b.lastWeek.final, true);
  b.lastWeek.rows = [{ a: MAL, place: 1, pts: 99999, hits: 1, cards: 1, best: 99999, days: 1, lastHit: 0, staked: true, ranked: true }];
  fs.writeFileSync(path.join(out, "board.json"), JSON.stringify(b));
  const remote = remoteWith(out);                                    // the bad run's board is published (no Vault file in it)
  const IN = asIncoming(out); fs.mkdirSync(path.join(IN, "combo/vault"), { recursive: true });
  fs.writeFileSync(path.join(IN, "combo/vault/W3.json"), JSON.stringify(C.vaultFile(3, true, [{ player: MAL, pts: 99999, staked: true }])));
  publishAt(IN, remote, now + 3600000);
  assert.equal(show(remote, "combo/vault/W3.json"), null, "MAL has no card in the published day files: the Vault file must be held");
});

test("D-C-3: an honest run whose read of ONE fixed slot fails doesn't hold the whole run (board, other days, Vault file)", async () => {
  const now = M.weekStart(4) + 14 * 3600000, legs = [{ code: C.WIN, round: mon18, producer: H1 }, { code: C.SHOW, round: mon18, producer: H2 }];
  const o1 = tmp();
  await quiet(() => run({ p: "p", check: "c", head: headAt(now), out: o1, raceDir: raceDir(), blockxDir: blockxDir(), picksContract: "1P", cardsOf: oneCard(legs), stakedOf: staked }));
  assert.equal(slot0(o1)[0].state, "final");
  fs.rmSync(path.join(o1, "vault"), { recursive: true, force: true });
  const remote = remoteWith(o1);
  const o2 = tmp(), flaky = async (n, r) => { if (r === C.slotRound(D3, 0) && n === "c") throw new Error("timeout"); return oneCard(legs)(n, r); };
  await quiet(() => run({ p: "p", check: "c", head: headAt(now + 3600000), prev: o1, out: o2, raceDir: raceDir(), blockxDir: blockxDir(), picksContract: "1P", cardsOf: flaky, stakedOf: staked }));
  const before = show(remote, "combo/board.json");
  publishAt(asIncoming(o2), remote, now + 3600000 + 60000);
  assert.notEqual(show(remote, "combo/board.json"), before, "one failed read of an already-published fixed slot must not hold the whole run");
});

test("D-C-4: one bad run that plants a fixed slot doesn't stop every honest run after it (per-file hold, not whole-run)", async () => {
  const now = (D3 + 1) * M.DAY + 14 * 3600000, legs = [{ code: C.WIN, round: mon18, producer: H1 }, { code: C.SHOW, round: mon18, producer: H2 }];
  const honest = tmp();
  await quiet(() => run({ p: "p", check: "c", head: headAt(now), out: honest, raceDir: raceDir(), blockxDir: blockxDir(), picksContract: "1P", cardsOf: oneCard(legs), stakedOf: staked }));
  const bad = tmp(); fs.cpSync(honest, bad, { recursive: true });
  const f = `D${String(D3).padStart(5, "0")}.json`, d = read(bad, f), s0 = d.slots.find((s) => s.round === C.slotRound(D3, 0));
  s0.cards.push({ ...s0.cards[0], player: "1MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM" });   // a card the chain never had
  fs.writeFileSync(path.join(bad, f), JSON.stringify(d));
  const remote = remoteWith(bad);                                                       // the bad run got through (exit 0)
  const later = tmp();
  await quiet(() => run({ p: "p", check: "c", head: headAt(now + 3600000), prev: bad, out: later, raceDir: raceDir(), blockxDir: blockxDir(), picksContract: "1P", cardsOf: oneCard(legs), stakedOf: staked }));
  const before = show(remote, "combo/board.json");
  publishAt(asIncoming(later), remote, now + 3600000 + 60000);
  assert.notEqual(show(remote, "combo/board.json"), before, "the honest run's board (and Vault file) must still be published; only the disputed day file is held");
});

test("D-C-5: one node's 'non-canonical transfer' alone doesn't void a Combo Block X leg that hit (picks BX-100)", async () => {
  const sent = D3 * M.DAY + 3600000, r0 = Math.floor(heightAt(D3 * M.DAY + 20 * 3600000) / X.ROUND), even = r0 % 2 ? r0 + 1 : r0;   // H1 signs even rounds
  const legs = [{ code: C.WIN, round: mon18, producer: H1 }, { code: C.BLOCK, round: even, producer: H1 }];
  const dense = (at) => CARD(at);                                    // cards every hour so the lock and after cards exist
  const rd = raceDir({ card: dense });
  for (const f of fs.readdirSync(rd)) { const j = read(rd, f); for (const r of j.races) r.cards = [0, 1, 2, 3, 4, 5].map((k) => CARD(r.start + 60000 + k * 3600000)); fs.writeFileSync(path.join(rd, f), JSON.stringify(j)); }
  const vhpMovesOf = async (n) => { if (n === "c") throw new NonCanonicalTransfer("a VHP transfer to H1: non-standard bytes"); return 0n; };
  const out = tmp();
  await quiet(() => run({ p: "p", check: "c", head: headAt((D3 + 2) * M.DAY + 12 * 3600000), out, raceDir: rd, blockxDir: blockxDir(), picksContract: "1P", cardsOf: oneCard(legs, sent), stakedOf: staked, vhpMovesOf }));
  assert.notEqual(slot0(out)[0].legs[1][4], "void", "only one node reports it: held (as blockx.ts BX-100), not voided and fixed for good");
});

test("D-C-6: board.json stays publishable (≤ 2 MB) when many wallets have played over time, so the Vault file isn't stranded", async () => {
  // 20,000 wallets with one final card each on older days (before last week), as earlier runs published them.
  const prev = tmp(), days = [];
  for (let k = 0; k < 10; k++) {
    const day = C.utcDay(M.weekStart(1)) + k, round = C.slotRound(day, 0), cards = [];
    for (let i = 0; i < 2000; i++) cards.push({ player: "1" + String(k * 2000 + i).padStart(33, "1").replace(/0/g, "z"), round, time: day * M.DAY + 3600000, changes: 0, priceAt: day * M.DAY, legs: [[1, 1, H1, 100, "miss"], [2, 1, H2, 100, "miss"]], state: "final", outcome: "miss", pts: 0, settled: day * M.DAY + 3600000 });
    fs.writeFileSync(path.join(prev, `D${String(day).padStart(5, "0")}.json`), JSON.stringify({ v: 2, day, start: day * M.DAY, parts: 1, slots: [{ round, fixed: true, cards }] }));   // (fix-check 3: part 0 names its parts)
    days.push(day);
  }
  fs.writeFileSync(path.join(prev, "index.json"), JSON.stringify({ v: 2, updated: "2026-11-09T00:00:00.000Z", days, contract: null }));
  const out = tmp();
  await quiet(() => run({ p: "p", check: "c", head: headAt(M.weekStart(4) + 14 * 3600000), prev, out, raceDir: raceDir(), blockxDir: blockxDir(), picksContract: "1P", cardsOf: async () => [], stakedOf: staked }));
  assert.ok(fs.statSync(path.join(out, "board.json")).size <= 2048 * 1024, "board.json over the publish job's 2 MB limit: held every run, and the Vault file is judged against the stale published board");
});

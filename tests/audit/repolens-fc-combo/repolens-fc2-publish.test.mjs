// Reviewer E-C failing tests (node:test). NOT RUN HERE (static review). Place in tests/audit/repolens-fc-combo/ and run
// like the other files there. They import the REAL bot/games/combo.ts and run the REAL combo.yml publish step.
// Lines below up to "E-C additions" are tests/audit/repolens-fc-combo/D-C.publish.test.mjs:4-84 verbatim, except APP is
// resolved from this file with fileURLToPath (repo root = three levels up) when APP is not set.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const APP = process.env.APP || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
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

// ── E-C additions ──
const forge = (dir, day, round) => {   // a bad run: a PENDING card on a fixed slot turned final "hit", worths 300 (who, legs, time, changes kept)
  const f = `D${String(day).padStart(5, "0")}.json`, d = read(dir, f), s = d.slots.find((x) => x.round === round), c = s.cards[0];
  assert.equal(s.fixed, true); assert.equal(c.state, "pending");
  for (const l of c.legs) { l[3] = 300; l[4] = "hit"; }
  Object.assign(c, { state: "final", outcome: "hit", pts: C.pointsFor(c.legs.map((l) => l[3])), settled: c.time + 7 * 3600000 });
  fs.writeFileSync(path.join(dir, f), JSON.stringify(d) + "\n");
  return c;
};

test("E-C-1a: the publish job refuses a final card whose leg results race-data doesn't show (one bad record run)", async () => {
  const now = (D3 + 1) * M.DAY + 14 * 3600000, legs = [{ code: C.WIN, round: mon18, producer: H3 }, { code: C.SHOW, round: mon18 + 1, producer: H4 }];
  const rd = raceDir({ noResult: new Set([mon18, mon18 + 1]) });          // the races aren't decided: the card is pending
  const o1 = tmp();
  await quiet(() => run({ p: "p", check: "c", head: headAt(now), out: o1, raceDir: rd, blockxDir: blockxDir(), picksContract: "1P", cardsOf: oneCard(legs), stakedOf: staked }));
  fs.rmSync(path.join(o1, "vault"), { recursive: true, force: true });
  const remote = remoteWith(o1);
  const bad = tmp(); fs.cpSync(o1, bad, { recursive: true }); forge(bad, D3, C.slotRound(D3, 0));
  publishAt(asIncoming(bad), remote, now + 60000);
  const pub = JSON.parse(show(remote, `combo/D${String(D3).padStart(5, "0")}.json`));
  assert.notEqual(pub.slots.find((s) => s.round === C.slotRound(D3, 0)).cards[0].state, "final",
    "a final 'hit' whose races have no result in race-data (and a worth of 3.00 per leg) must be held, not published");
});

test("E-C-1b: an honest run doesn't silently keep a published final card the sources don't support", async () => {
  const now = (D3 + 1) * M.DAY + 14 * 3600000, legs = [{ code: C.WIN, round: mon18, producer: H3 }, { code: C.SHOW, round: mon18 + 1, producer: H4 }];
  const rd = raceDir({ noResult: new Set([mon18, mon18 + 1]) });
  const bad = tmp();
  await quiet(() => run({ p: "p", check: "c", head: headAt(now), out: bad, raceDir: rd, blockxDir: blockxDir(), picksContract: "1P", cardsOf: oneCard(legs), stakedOf: staked }));
  forge(bad, D3, C.slotRound(D3, 0));                                       // as published by the bad run (E-C-1a shows it passes)
  const o2 = tmp();
  const r = await quiet(() => run({ p: "p", check: "c", head: headAt(now + 3600000), prev: bad, out: o2, raceDir: rd, blockxDir: blockxDir(), picksContract: "1P", cardsOf: oneCard(legs), stakedOf: staked }));
  const c = slot0(o2)[0];
  assert.ok(!(c.state === "final" && c.outcome === "hit") || r.errors.length > 0,
    "the chain holds the card (chainKey) but race-data has no result for its legs: keeping the forged 'hit' with no error lets one bad run choose the Vault's winners");
});

test("E-C-2: a busy day (1,100 wallets x 3 ten-leg cards) stays publishable, so its week's Vault file isn't lost", async () => {
  const now = (D3 + 1) * M.DAY + 14 * 3600000;
  const who = (i) => "1" + String(i).padStart(33, "1").replace(/0/g, "z");
  const prod = (j) => "1" + String(900 + j).padStart(33, "2").replace(/0/g, "z");
  const many = async (_n, r) => (C.dayOfRound(r) !== D3 ? [] : Array.from({ length: 1100 }, (_, i) => ({ player: who(i), time: D3 * M.DAY + 3600000 + i, height: 1, changes: 0,
    legs: Array.from({ length: 10 }, (_, j) => ({ code: C.WIN, round: mon18 + 1 + j, producer: prod(j) })) })));
  const out = tmp();
  await quiet(() => run({ p: "p", check: "c", head: headAt(now), out, raceDir: raceDir(), blockxDir: blockxDir(), picksContract: "1P", cardsOf: many, stakedOf: staked }));
  for (const f of fs.readdirSync(out).filter((x) => x.endsWith(".json")))
    assert.ok(fs.statSync(path.join(out, f)).size <= 2048 * 1024, `${f} is over the publish job's 2 MB limit: held every run, so its week's Vault file can't match the published days`);
});

test("FC-23 (E-C-3): index.json's published days stay (the append-only check reads the PUBLISHED index)", async () => {
  const now = M.weekStart(4) + 14 * 3600000, out = tmp();
  await quiet(() => run({ p: "p", check: "c", head: headAt(now), out, raceDir: raceDir(), blockxDir: blockxDir(), picksContract: "1P", cardsOf: oneCard([{ code: C.WIN, round: mon18, producer: H1 }, { code: C.SHOW, round: mon18, producer: H2 }]), stakedOf: staked }));
  fs.rmSync(path.join(out, "vault"), { recursive: true, force: true });
  const remote = remoteWith(out), before = JSON.parse(show(remote, "combo/index.json")).days;
  assert.ok(before.length > 1);
  const IN = asIncoming(out), p = path.join(IN, "combo/index.json"), j = JSON.parse(fs.readFileSync(p, "utf8"));
  j.days = j.days.slice(1); fs.writeFileSync(p, JSON.stringify(j) + "\n");
  publishAt(IN, remote, now + 60000);
  assert.deepEqual(JSON.parse(show(remote, "combo/index.json")).days, before, "a run that drops a published day from index.json must have that file held");
});

// Correction of the owner's D-C-1 (passes today; it is here because the adapted D-C-1 passes even WITHOUT the FC-6 check:
// since FC-17, C.vaultFile drops rows without `place`, so its Vault file has rows [] and is held by the rows compare).
test("D-C-1 (corrected): the Vault file that matches a made-up published board is held by the FC-6 check itself", async () => {
  const now = M.weekStart(4) + 14 * 3600000, out = tmp();
  await quiet(() => run({ p: "p", check: "c", head: headAt(now), out, raceDir: raceDir(), blockxDir: blockxDir(), picksContract: "1P", cardsOf: oneCard([{ code: C.WIN, round: mon18, producer: H1 }, { code: C.SHOW, round: mon18, producer: H2 }]), stakedOf: staked }));
  fs.rmSync(path.join(out, "vault"), { recursive: true, force: true });
  const MAL = "1MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM", b = read(out, "board.json");
  b.lastWeek.rows = [{ a: MAL, place: 1, pts: 99999, hits: 1, cards: 1, best: 99999, days: 1, lastHit: 0, staked: true, ranked: true }];
  fs.writeFileSync(path.join(out, "board.json"), JSON.stringify(b) + "\n");
  const remote = remoteWith(out);
  const IN = asIncoming(out); fs.mkdirSync(path.join(IN, "combo/vault"), { recursive: true });
  const vf = C.vaultFile(3, true, [{ player: MAL, pts: 99999, place: 1, staked: true }]);
  assert.equal(vf.rows.length, 1, "the Vault file must name MAL, or the test proves nothing about FC-6");
  fs.writeFileSync(path.join(IN, "combo/vault/W3.json"), JSON.stringify(vf) + "\n");
  const p = publishAt(IN, remote, now + 3600000);
  assert.equal(show(remote, "combo/vault/W3.json"), null);
  assert.match(p.out, /doesn't match the published final cards/, "held by the FC-6 recount, not by another check");
});

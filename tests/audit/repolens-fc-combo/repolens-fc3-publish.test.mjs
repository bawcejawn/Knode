// Reviewer G-C failing tests (node:test), fix-check 3. NOT RUN HERE (static review). Place in tests/audit/repolens-fc-combo/
// and run like the other files there. They import the REAL bot/games/combo.ts and run the REAL combo.yml publish step.
// Lines below up to "G-C additions" are tests/audit/repolens-fc-combo/repolens-fc2-publish.test.mjs:5-86 verbatim (APP is
// resolved from this file with fileURLToPath: repo root = three levels up).
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

// ── G-C additions ──
// (forge: repolens-fc2-publish.test.mjs E-C additions, verbatim)
const forge = (dir, day, round) => {   // a bad run: a PENDING card on a fixed slot turned final "hit", worths 300 (who, legs, time, changes kept)
  const f = `D${String(day).padStart(5, "0")}.json`, d = read(dir, f), s = d.slots.find((x) => x.round === round), c = s.cards[0];
  assert.equal(s.fixed, true); assert.equal(c.state, "pending");
  for (const l of c.legs) { l[3] = 300; l[4] = "hit"; }
  Object.assign(c, { state: "final", outcome: "hit", pts: C.pointsFor(c.legs.map((l) => l[3])), settled: c.time + 7 * 3600000 });
  fs.writeFileSync(path.join(dir, f), JSON.stringify(d) + "\n");
  return c;
};
const pad = (d) => String(d).padStart(5, "0");
/** A bare remote with games-data (combo/ + blockx/) AND race-data, as the live repository has: the publish job reads both. */
function remoteFull(comboDir, rd, bx) {
  const T = tmp(), remote = path.join(T, "r.git"); execFileSync("git", ["init", "-q", "--bare", remote]);
  const push = (src, branch) => { const g = (...a) => execFileSync("git", ["-C", src, "-c", "user.name=t", "-c", "user.email=t@t", ...a]); g("init", "-q"); g("add", "-A"); g("commit", "-qm", "s"); g("push", "-q", remote, `HEAD:refs/heads/${branch}`); };
  const s = path.join(T, "g"); fs.cpSync(comboDir, path.join(s, "combo"), { recursive: true }); fs.cpSync(bx, path.join(s, "blockx"), { recursive: true }); push(s, "games-data");
  const r = path.join(T, "r"); fs.cpSync(rd, r, { recursive: true }); push(r, "race-data");
  return remote;
}
/** D-C-5's set-up: race cards every hour (so lock and after cards exist), a card with a WIN leg on H1 (H1 wins mon18) and a
 *  Block X leg on H2 for an odd round (H2 signs odd rounds; a producer once per card, as the publish job requires). */
function bxSetup() {
  const sent = D3 * M.DAY + 3600000, r0 = Math.floor(heightAt(D3 * M.DAY + 20 * 3600000) / X.ROUND), odd = r0 % 2 ? r0 : r0 + 1;
  const legs = [{ code: C.WIN, round: mon18, producer: H1 }, { code: C.BLOCK, round: odd, producer: H2 }];
  const rd = raceDir();
  for (const f of fs.readdirSync(rd)) { const j = read(rd, f); for (const r of j.races) r.cards = [0, 1, 2, 3, 4, 5].map((k) => CARD(r.start + 60000 + k * 3600000)); fs.writeFileSync(path.join(rd, f), JSON.stringify(j)); }
  return { sent, legs, rd, bx: blockxDir(), now: (D3 + 2) * M.DAY + 12 * 3600000 };
}

test("G-C-1: a kept final card whose Block X worth was lowered (a rival's, by one bad run) is an error, not kept silently", async () => {
  const { sent, legs, rd, bx, now } = bxSetup(), vhpMovesOf = async () => 0n, o1 = tmp();
  await quiet(() => run({ p: "p", check: "c", head: headAt(now), out: o1, raceDir: rd, blockxDir: bx, picksContract: "1P", cardsOf: oneCard(legs, sent), stakedOf: staked, vhpMovesOf }));
  const f = `D${pad(D3)}.json`, d = read(o1, f), c = d.slots.find((s) => s.round === C.slotRound(D3, 0)).cards[0];
  assert.equal(c.state, "final"); assert.equal(c.outcome, "hit"); assert.ok(c.legs[1][3] > 25, "the honest Block X worth must be above the floor for this test");
  c.legs[1][3] = 25; c.pts = C.pointsFor(c.legs.map((l) => l[3]));            // as one bad record run publishes it
  fs.writeFileSync(path.join(o1, f), JSON.stringify(d) + "\n");
  const r = await quiet(() => run({ p: "p", check: "c", head: headAt(now + 3600000), prev: o1, out: tmp(), raceDir: rd, blockxDir: bx, picksContract: "1P", cardsOf: oneCard(legs, sent), stakedOf: staked, vhpMovesOf }));
  assert.ok(r.errors.some((e) => /doesn't match the race-data and Block X files/.test(e)),
    "no VHP moved, yet the published Block X worth is below the recorder's own: 'l[3] <= f[3]' keeps it, the card ranks lower and the Vault pays others");
});

test("G-C-1b: the publish job holds a new final card with a hit leg worth below 0.25 (f100Of never gives less than 25)", async () => {
  const { sent, legs, rd, bx, now } = bxSetup(), vhpMovesOf = async () => 0n, o1 = tmp();
  await quiet(() => run({ p: "p", check: "c", head: headAt(now), out: o1, raceDir: raceDir({ noResult: new Set([mon18]) }), blockxDir: bx, picksContract: "1P", cardsOf: oneCard(legs, sent), stakedOf: staked, vhpMovesOf }));
  fs.rmSync(path.join(o1, "vault"), { recursive: true, force: true });
  const f = `D${pad(D3)}.json`, d0 = read(o1, f); assert.equal(d0.slots.find((s) => s.round === C.slotRound(D3, 0)).cards[0].state, "pending");
  const remote = remoteFull(o1, rd, bx), bad = tmp(); fs.cpSync(o1, bad, { recursive: true });
  const d = read(bad, f), c = d.slots.find((s) => s.round === C.slotRound(D3, 0)).cards[0];
  c.legs[0][3] = 100; c.legs[0][4] = "hit"; c.legs[1][3] = 1; c.legs[1][4] = "hit";
  Object.assign(c, { state: "final", outcome: "hit", pts: C.pointsFor(c.legs.map((l) => l[3])), settled: c.time + 7 * 3600000 });
  fs.writeFileSync(path.join(bad, f), JSON.stringify(d) + "\n");
  publishAt(asIncoming(bad), remote, now + 60000);
  assert.notEqual(JSON.parse(show(remote, `combo/${f}`)).slots.find((s) => s.round === C.slotRound(D3, 0)).cards[0].state, "final", "a hit worth 0.01 is never the recorder's");
});

test("G-C-2: the publish job holds a made-up final card in a slot that isn't fixed (legs picked after their results)", async () => {
  const { sent, legs, rd, bx, now } = bxSetup(), o1 = tmp();
  await quiet(() => run({ p: "p", check: "c", head: headAt(now), out: o1, raceDir: rd, blockxDir: bx, picksContract: "1P", cardsOf: oneCard(legs, sent), stakedOf: staked, vhpMovesOf: async () => 0n }));
  fs.rmSync(path.join(o1, "vault"), { recursive: true, force: true });
  const remote = remoteFull(o1, rd, bx), today = D3 + 2, MAL = "1MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM";
  const pub = read(o1, `D${pad(D3)}.json`).slots.find((s) => s.round === C.slotRound(D3, 0)).cards[0];
  const fake = { ...JSON.parse(JSON.stringify(pub)), player: MAL, round: C.slotRound(today, 0), time: today * M.DAY + 3600000, priceAt: today * M.DAY + 60000 };
  fake.legs.forEach((l) => { l[3] = 300; }); fake.pts = C.pointsFor(fake.legs.map((l) => l[3])); fake.settled = fake.time;
  assert.equal(fake.outcome, "hit");
  const IN = asIncoming(o1);
  fs.writeFileSync(path.join(IN, `combo/D${pad(today)}.json`), JSON.stringify({ v: 2, day: today, start: today * M.DAY, parts: 1, slots: [{ round: C.slotRound(today, 0), fixed: false, cards: [fake] }] }) + "\n");
  // (Combo fix round 4: the hand-written day names its parts (FC3-5), so the hold below is for the card itself.)
  const p = publishAt(IN, remote, now + 60000);
  assert.match(p.out, /D\d{5}\.json: not the recorder's shape/, "held by the card check (a final card on a slot that isn't fixed)");
  assert.equal(show(remote, `combo/D${pad(today)}.json`), null,
    "the recorder makes a card final only on a fixed slot; a final hit on an open slot is a bad run's (published, it is immutable: the week's Vault is lost or misled)");
});

test("G-C-3: an honest kept card with a Block X leg the recorder made 'unresolved' (both nodes: non-standard transfer) is not 'forged'", async () => {
  const { sent, legs, rd, bx, now } = bxSetup(), o1 = tmp();
  const vhpMovesOf = async () => { throw new NonCanonicalTransfer("a VHP transfer to H2: non-standard bytes"); };   // both nodes
  await quiet(() => run({ p: "p", check: "c", head: headAt(now), out: o1, raceDir: rd, blockxDir: bx, picksContract: "1P", cardsOf: oneCard(legs, sent), stakedOf: staked, vhpMovesOf }));
  const c = read(o1, `D${pad(D3)}.json`).slots.find((s) => s.round === C.slotRound(D3, 0)).cards[0];
  assert.equal(c.legs[1][4], "unresolved"); assert.equal(c.state, "final"); assert.equal(c.outcome, "void");
  const r = await quiet(() => run({ p: "p", check: "c", head: headAt(now + 3600000), prev: o1, out: tmp(), raceDir: rd, blockxDir: bx, picksContract: "1P", cardsOf: oneCard(legs, sent), stakedOf: staked, vhpMovesOf }));
  assert.ok(!r.errors.some((e) => /doesn't match the race-data and Block X files/.test(e)),
    "the verify re-score counts moved VHP as 0, so it can't reproduce this 'unresolved': the honest card is called forged and its week gets no Vault file");
});

test("E-C-1a (corrected): the result compare itself holds a forged hit (race-data IS published, so 'can't be read' doesn't fire)", async () => {
  const now = (D3 + 1) * M.DAY + 14 * 3600000, legs = [{ code: C.WIN, round: mon18, producer: H3 }, { code: C.SHOW, round: mon18 + 1, producer: H4 }];
  const rd = raceDir({ noResult: new Set([mon18, mon18 + 1]) }), bx = blockxDir(), o1 = tmp();
  await quiet(() => run({ p: "p", check: "c", head: headAt(now), out: o1, raceDir: rd, blockxDir: bx, picksContract: "1P", cardsOf: oneCard(legs), stakedOf: staked }));
  fs.rmSync(path.join(o1, "vault"), { recursive: true, force: true });
  const remote = remoteFull(o1, rd, bx), bad = tmp(); fs.cpSync(o1, bad, { recursive: true }); forge(bad, D3, C.slotRound(D3, 0));
  const p = publishAt(asIncoming(bad), remote, now + 60000);
  assert.notEqual(JSON.parse(show(remote, `combo/D${pad(D3)}.json`)).slots.find((s) => s.round === C.slotRound(D3, 0)).cards[0].state, "final");
  assert.match(p.out, /but its source shows pending/, "held by the leg-result compare, not by the missing race-data branch");
});

test("G-C-4: a day part the recorder no longer writes doesn't stay on games-data (one bad run can't leave a part behind)", async () => {
  const today = D3 + 2, now = today * M.DAY + 12 * 3600000, sent = today * M.DAY + 3600000, r18 = today * 4 + 3;
  const legs = [{ code: C.WIN, round: r18, producer: H1 }, { code: C.SHOW, round: r18, producer: H2 }];
  const cardsOf = async (_n, r) => (r === C.slotRound(today, 0) ? [{ player: ALICE, legs, time: sent, height: heightAt(sent), changes: 0 }] : []);
  const rd = raceDir({ resultsUntil: now }), bx = blockxDir(), o1 = tmp();
  await quiet(() => run({ p: "p", check: "c", head: headAt(now), out: o1, raceDir: rd, blockxDir: bx, picksContract: "1P", cardsOf, stakedOf: staked }));
  fs.rmSync(path.join(o1, "vault"), { recursive: true, force: true });
  const f0 = `D${pad(today)}.json`, d0 = read(o1, f0), s0 = d0.slots.find((s) => s.round === C.slotRound(today, 0));
  assert.equal(s0.fixed, false); assert.equal(s0.cards[0].state, "pending");
  const remote = remoteFull(o1, rd, bx), MAL = "1MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM";
  const bad = asIncoming(o1);                                                 // a bad run: the honest files plus a part 1
  fs.writeFileSync(path.join(bad, `combo/D${pad(today)}-1.json`), JSON.stringify({ v: 2, day: today, start: today * M.DAY, part: 1, slots: [{ round: s0.round, fixed: false, cards: [{ ...s0.cards[0], player: MAL }] }] }) + "\n");
  publishAt(bad, remote, now + 60000);
  publishAt(asIncoming(o1), remote, now + 3600000 + 60000);                   // the honest run after it writes part 0 only
  assert.equal(show(remote, `combo/D${pad(today)}-1.json`), null,
    "a stale part is merged into the day for good: its slot never reads as fixed again, and once MAL really plays the day can't be read (held for good, no Vault file)");
});

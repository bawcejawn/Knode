// Producer Race (site/race.js), Network pulse (site/pulse.js) and the Mana planner (site/mana.js): the math, and that
// the pages only read. Offline: runs the scripts' math in a sandbox with no page, and reads the files.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const APP = process.env.APP || ".";
const read = (f) => fs.readFileSync(`${APP}/site/${f}`, "utf8");
const load = (f) => { const box = { window: {} }; vm.runInNewContext(read(f), box); return box.window; };
const R = load("race.js").KRaceMath, P = load("pulse.js").KPulseMath, M = load("mana.js").KManaMath;
const DAY = 86400000;

// A field shaped like Koinos's producers on 2026-10-26 (shares of producing VHP, %).
const SHARES = [19.88, 14.99, 12.44, 10.82, 10.11, 7.59, 5.66, 5.36, 4.31, 3.7, 1.36, 1.02, 0.9, 0.81, 0.56, 0.21, 0.15, 0.09, 0.03, 0.005];
const vhpMap = () => new Map(SHARES.map((s, i) => [`1Producer${i}`, s * 1000]));

test("the biggest producer moves exactly 1 step per block; smaller ones more, in VHP order", () => {
  const F = R.field(vhpMap(), 28800);
  assert.equal(F.entrants[0].h, 1);
  for (let i = 1; i < F.entrants.length; i++) assert.ok(F.entrants[i].h > F.entrants[i - 1].h, `handicap grows as VHP shrinks (${i})`);
});

test("fair: every horse's chance of leading a fresh 24 hours is close to 1 in N (independent check, other seed)", () => {
  const F = R.field(vhpMap(), 28800), n = F.entrants.length;
  const w = R.winChances(F.entrants.map((e) => e.k), F.entrants.map((e) => e.h), 20000, 4242);
  const fair = 1 / n;
  for (const [i, x] of w.entries()) assert.ok(x > fair * 0.75 && x < fair * 1.3, `horse ${i}: ${(x * 100).toFixed(1)}% vs fair ${(fair * 100).toFixed(1)}%`);
  // Without the luck term (equal speed only) the smallest horses would win far more often: the trim matters.
  const eq = R.winChances(F.entrants.map((e) => e.k), F.entrants.map((e) => F.entrants[0].k / e.k), 20000, 4242);
  assert.ok(eq[n - 1] > fair * 2 && eq[0] < fair * 0.5);
});

test("the calibration is the same for every visitor (seeded) and lands near 1.2 for this field", () => {
  const a = R.field(vhpMap(), 28800), b = R.field(vhpMap(), 28800);
  assert.equal(a.c, b.c);
  assert.ok(a.c >= 0.8 && a.c <= 1.6, `c = ${a.c}`);
});

test("producers expected to sign fewer than 24 blocks a day wait in the paddock; zero-VHP producers are left out", () => {
  const v = vhpMap(); v.set("1Zero", 0);
  const F = R.field(v, 28800);
  assert.ok(F.paddock.every((p) => p.k < 24) && F.entrants.every((e) => e.k >= 24));
  assert.ok(F.paddock.length >= 2);
  assert.ok(![...F.entrants, ...F.paddock].some((r) => r.addr === "1Zero"));
});

test("positions count only the last 24 hours, times each signer's handicap", () => {
  const B = { ts: [0, DAY / 2, DAY, DAY + 10, 2 * DAY], sig: [0, 1, 0, 1, 0], signers: ["1a", "1b"] };
  const hOf = new Map([[0, 1], [1, 2.5]]);
  const { pos, complete } = R.positions(B, hOf, DAY + 10);
  assert.equal(pos.get(0), 1); assert.equal(pos.get(1), 5); assert.equal(complete, true);
  assert.equal(R.positions(B, hOf, DAY / 2).complete, false, "the data does not reach back a full 24 hours before T");
});

test("odds: a big lead with an hour to go is nearly certain; 24 hours out it's back to a fresh race", () => {
  const F = R.field(new Map([["1a", 600], ["1b", 400]]), 28800);
  const ts = [], sig = [];
  for (let i = 0; i < 28800; i++) { ts.push(i * 3000); sig.push(i % 100 < 70 ? 0 : 1); }   // 1a well ahead after its handicap
  const B = { ts, sig, signers: ["1a", "1b"], ntx: ts.map(() => 0) }, idx = new Map([["1a", 0], ["1b", 1]]), now = ts.at(-1);
  const hour = R.oddsAt(B, F.entrants, idx, now, now + 3600000);
  assert.ok(hour[0] > 0.99);
  const day = R.oddsAt(B, F.entrants, idx, now, now + DAY);
  assert.ok(Math.abs(day[0] - 0.5) < 0.1, `24 h out: ${day[0]}`);
  assert.ok(Math.abs(hour.reduce((a, b) => a + b, 0) - 1) < 1e-9);
});

test("a correct guess pays the fair odds, between 1.1× and 50×", () => {
  assert.equal(R.paysFor(0.5), 2); assert.equal(R.paysFor(0.25), 4); assert.equal(R.paysFor(0.999), 1.1); assert.equal(R.paysFor(0.0001), 50);
});

test("pulse: blocks, transactions, gaps, hours and 'producers to sign half' over the last 24 hours", () => {
  const ts = [], sig = [], ntx = [];
  for (let i = 0; i < 1000; i++) { ts.push(DAY + i * 3000); sig.push(i % 10 < 6 ? 0 : i % 10 < 9 ? 1 : 2); ntx.push(i % 4 === 0 ? 2 : 0); }
  ts.push(DAY + 1000 * 3000 + 60000); sig.push(2); ntx.push(1);       // one 63 s gap
  ts.unshift(0); sig.unshift(1); ntx.unshift(9);                      // older than 24 h: left out
  const S = P.stats({ ts, sig, ntx, signers: ["1a", "1b", "1c"] }, ts.at(-1));
  assert.equal(S.blocks, 1001); assert.equal(S.tx, 501); assert.equal(S.withTx, 251);
  assert.equal(S.gapMax, 63000); assert.equal(S.slowGaps, 1);
  assert.equal(S.n50, 1); assert.equal(S.n33, 1);
  assert.equal(S.hours.reduce((s, h) => s + h.blocks, 0), 1001);
  assert.equal(S.producers[0].addr, "1a");
});

test("Mana planner: 5 × the daily Mana in KOIN", () => {
  const p = M.plan({ answer: 5, transfer: 2, swap: 1 });
  assert.equal(p.perDay, 5n * 35000000n + 2n * 30000000n + 140000000n);
  assert.equal(p.koin, p.perDay * 5n);
  assert.equal(M.plan({ answer: -3, swap: "x" }).perDay, 0n);
});

test("race, pulse and the shared block loader only read: no wallet, no signing, no sending", () => {
  for (const f of ["race.js", "pulse.js", "chain-blocks.js"]) assert.doesNotMatch(read(f), /KWallet|\.send\(|signTransaction|sendTransaction|onlyOperation/, f);
  for (const f of ["race.html", "pulse.html"]) { assert.doesNotMatch(read(f), /wallet\.js|kondor/, f); assert.match(read(f), /<script src="chain-blocks\.js"><\/script>/); }
});

test("the block snapshot is used only after a spot check against the chain", () => {
  const js = read("chain-blocks.js");
  assert.match(js, /Spot-check 8 random blocks/);
  assert.match(js, /if \(!ok\.every\(Boolean\)\) return null;/);
});

test("every page's header links to the Race, Pulse and Mana pages", () => {
  for (const p of fs.readdirSync(`${APP}/site`).filter((f) => f.endsWith(".html"))) {
    const h = read(p);
    if (!/class="tabs"/.test(h)) continue;
    for (const target of ["race.html", "pulse.html", "mana.html"]) assert.match(h, new RegExp(`<a href="${target.replace(".", "\\.")}"`), `${p} → ${target}`);
  }
});

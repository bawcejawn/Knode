// The KnodeGames VHP standard (site/vhp-standard.js): exact effective VHP rebuilt from VHP events, checked against a
// line-by-line copy of the Koinos VHP contract's own snapshot code (koinos-contracts-as contracts/vhp Vhp.ts:
// _increase_balance_by, _decrease_balance_by, _trim_balances, effective_balance_of), and the standard measures.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const APP = process.env.APP || ".";
const box = { window: {} };
vm.runInNewContext(fs.readFileSync(`${APP}/site/race-math.js`, "utf8") + "\n" + fs.readFileSync(`${APP}/site/vhp-standard.js`, "utf8"), box);
const V = box.window.KVhp, R = box.window.KRaceMath;

// ── the contract, as written (only the arithmetic; u64 subtraction never goes below 0 here) ──
class ContractBalance {
  constructor(cur) { this.cur = cur; this.past = []; }
  trim(h) { if (this.past.length <= 1) return; const limit = h < 20 ? 0 : h - 20; while (this.past.length > 1 && this.past[1].h <= limit) this.past.shift(); }
  increase(h, v) {
    this.trim(h);
    if (this.past.length === 0) this.past.push({ h: h - 1, b: this.cur });
    this.cur += v;
    const last = this.past[this.past.length - 1];
    if (last.h !== h) this.past.push({ h, b: this.cur }); else last.b = this.cur;
  }
  decrease(h, v) { this.trim(h); this.cur -= v; for (const p of this.past) p.b = p.b < v ? 0 : p.b - v; }
  effective(h) { if (this.past.length === 0) return this.cur; const copy = new ContractBalance(this.cur); copy.past = this.past.map((p) => ({ ...p })); copy.trim(h); return copy.past[0].b; }
}

test("effective VHP matches the Koinos VHP contract's own snapshot code on 3,000 random histories", () => {
  const rnd = R.rng(20261028);
  for (let trial = 0; trial < 3000; trial++) {
    const start = 1000 + Math.floor(rnd.next() * 1e6), h0 = 1000, n = 30 + Math.floor(rnd.next() * 120);
    const c = new ContractBalance(start), deltas = [], effByBlock = [];
    let bal = start;
    for (let h = h0; h < h0 + n; h++) {
      effByBlock.push([h, c.effective(h)]);              // block production reads it at the start of block h
      const k = rnd.next() < 0.25 ? 1 + Math.floor(rnd.next() * 3) : 0;
      for (let e = 0; e < k; e++) {
        if (rnd.next() < 0.5) { const v = 1 + Math.floor(rnd.next() * 5e5); c.increase(h, v); bal += v; deltas.push({ h, a: "1A", d: v }); }
        else if (bal > 0) { const v = 1 + Math.floor(rnd.next() * bal); c.decrease(h, v); bal -= v; deltas.push({ h, a: "1A", d: -v }); }
      }
    }
    const book = V.vhpBook({ "1A": { h: h0 + n - 1, v: bal } }, deltas);
    for (const [h, want] of effByBlock) assert.equal(book.effective("1A", h), want, `trial ${trial}, block ${h}`);
    // the max and the average agree with a block-by-block scan
    const a = h0 + 3, b = h0 + n - 2;
    const scan = effByBlock.filter(([h]) => h >= a && h < b).map(([, v]) => v);
    assert.equal(book.maxEffective("1A", a, b), Math.max(...scan));
    assert.ok(Math.abs(book.avgEffective("1A", a, b) - scan.reduce((s, v) => s + v, 0) / scan.length) < 1e-6);
  }
});

test("VHP received counts after 20 blocks; VHP sent away stops counting at once", () => {
  const book = V.vhpBook({ "1A": { h: 200, v: 150 } }, [{ h: 100, a: "1A", d: 100 }, { h: 150, a: "1A", d: -50 }]);
  assert.equal(book.effective("1A", 100), 100, "before the receipt: 100");
  assert.equal(book.before("1A", 101), 200);
  assert.equal(book.effective("1A", 101), 100, "received in block 100: not yet");
  assert.equal(book.effective("1A", 119), 100);
  assert.equal(book.effective("1A", 120), 200, "20 blocks later it counts");
  assert.equal(book.effective("1A", 150), 200);
  assert.equal(book.effective("1A", 151), 150, "sent away: at once");
});

test("the standard measures: card = most over the 7,200 blocks before; seeding = average over the day before; window stats", () => {
  // two producers alternate blocks; 1Mover parks 99% of its VHP elsewhere for blocks 9,000–9,099
  const n = 12000, hs = [], ts = [], sig = [], deltas = [];
  for (let i = 0; i < n; i++) { hs.push(1e6 + i); ts.push(i * 3000); sig.push(i % 2); }
  deltas.push({ h: 1e6 + 9000, a: "1Mover", d: -99e8 }, { h: 1e6 + 9100, a: "1Mover", d: 99e8 });
  const B = { hs, ts, sig, signers: ["1Mover", "1Other"] };
  const book = V.vhpBook({ "1Mover": { h: 1e6 + n - 1, v: 100e8 }, "1Other": { h: 1e6 + n - 1, v: 100e8 } }, deltas);
  const card = V.cardAt(B, 9050, book);
  assert.deepEqual(JSON.parse(JSON.stringify(card.field.map((r) => [r.a, r.vhp]))), [["1Mover", 100], ["1Other", 100]], "parking VHP at card time doesn't make it look small");
  const seeded = V.averageCard(B, 9050 - 2000, 9050 + 1000, book);   // 100 parked blocks of 3,000
  // out from block 9,001 (sent in 9,000) until 9,119 (taken back in 9,100, counts 20 blocks later): 119 blocks
  assert.ok(Math.abs(seeded.field.find((r) => r.a === "1Mover").vhp - (100 - 99 * 119 / 3000)) < 0.02, "the average counts the parked blocks as they were");
  const w = V.windowStats(B, 8000, 10000, ["1Mover", "1Other"], book);
  assert.equal(w.w["1Mover"], 100e8, "baseline: the effective VHP at the window's start");
  assert.equal(w.by["1Mover"], 1000);
  // expected = 100 VHP × Σ 1 ÷ active VHP: half of 1,881 blocks, plus 100/101 of the 119 blocks the mover's VHP was out
  const want = 1881 * 0.5 + 119 * (100 / 101);
  assert.ok(Math.abs(V.expectedBlocks(w.w["1Other"], w.q) - want) < 0.01, `expected ${V.expectedBlocks(w.w["1Other"], w.q)} vs ${want}`);
  assert.equal(w.cr["1Mover"], 1000, "never above its baseline: every block counts 1");
  assert.equal(V.fieldOf(new Map([["1Big", 1e14], ["1Tiny", 1e10]])).paddock[0].a, "1Tiny", "under 10 blocks a race: paddock");
});

test("the standard is pure (no network, storage or wallet)", () => {
  const src = fs.readFileSync(`${APP}/site/vhp-standard.js`, "utf8");
  assert.doesNotMatch(src, /fetch\(|XMLHttpRequest|localStorage|\.send\(|signTransaction/);
});

test("credit above the baseline: a block signed while holding twice the baseline counts half (gifts and top-ups are neutral)", () => {
  const n = 3000, hs = [], ts = [], sig = [];
  for (let i = 0; i < n; i++) { hs.push(5e6 + i); ts.push(i * 3000); sig.push(i % 2); }
  // 1Seed receives a gift equal to its VHP in block 1,000: it counts from block 1,020
  const deltas = [{ h: 5e6 + 1000, a: "1Seed", d: 100e8 }];
  const B = { hs, ts, sig, signers: ["1Seed", "1Other"] };
  const book = V.vhpBook({ "1Seed": { h: 5e6 + n - 1, v: 200e8 }, "1Other": { h: 5e6 + n - 1, v: 100e8 } }, deltas);
  const w = V.windowStats(B, 0, n, ["1Seed", "1Other"], book);
  assert.equal(w.w["1Seed"], 100e8);
  assert.equal(w.by["1Seed"], 1500);
  assert.equal(w.cr["1Seed"], 510 + 990 * 0.5, "510 blocks at the baseline count 1; 990 at twice it count ½");
  // baselines carried from an earlier part of the window are used as given
  const later = V.windowStats(B, 2000, n, ["1Seed"], book, { "1Seed": 100e8 });
  assert.equal(later.cr["1Seed"], 500 * 0.5);
});

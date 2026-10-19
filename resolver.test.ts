/**
 * The resolver is the check that says which option was right. These tests pin it down:
 * same blocks always give the same answer, only the published window counts, and a missing
 * block is not turned into a void.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { TEMPLATES } from "./generator.ts";
import { chainOutcome, CHAIN_VOID, dataHashOf, scoreQuestion, storedOutcome, type QuestionInput } from "./resolver.ts";
import type { Blk } from "./common.ts";

const ALICE = "alice";
const BOB = "bob";
const CARA = "cara";
const DAN = "dan";
const OTHER = "other";

function series(from: number, to: number, signer: (h: number) => string, tweak: (b: Blk) => void = () => {}): Blk[] {
  const out: Blk[] = [];
  for (let h = from; h <= to; h++) {
    const b: Blk = { h, ts: h * 3000, signer: signer(h), ntx: 1, compute: 0 };
    tweak(b);
    out.push(b);
  }
  return out;
}

function question(over: Partial<QuestionInput> = {}): QuestionInput {
  return {
    id: "Q", template: "E1s", subjects: [ALICE], unit: "count",
    windowStart: 10, windowEnd: 14, thresholds: [2],
    model: { rates: { [ALICE]: 0.5, [BOB]: 0.5, [CARA]: 0.5, [DAN]: 0.5 }, voidAlpha: 0.5, minVoidBlocks: 0 },
    ...over,
  };
}

test("the same history scores the same answer twice, including the block-time stamp and the data hash", () => {
  const blocks = series(9, 16, (h) => (h === 10 || h === 12 || h === 14 ? ALICE : OTHER));
  const a = scoreQuestion(question(), blocks);
  const b = scoreQuestion(question(), [...blocks].reverse());
  assert.deepEqual(a, b);
  assert.equal(a.ok, true);
  if (!a.ok) return;
  assert.equal(a.result.void, false);
  assert.equal(a.result.option, 1); // 3 alice blocks, threshold 2 → "more than 2"
  assert.equal(a.result.value, "3");
  assert.equal(a.result.resolvedAt, new Date(14 * 3000).toISOString());
  const lines = [10, 11, 12, 13, 14].map((h) => `${h},${h === 10 || h === 12 || h === 14 ? ALICE : OTHER},${h * 3000},1`);
  assert.equal(a.result.dataHash, createHash("sha256").update(lines.join("\n")).digest("hex"));
  assert.equal(a.result.dataHash, dataHashOf(blocks.filter((x) => x.h >= 10 && x.h <= 14)));
});

test("the closing block and the block after the window do not count, and both ends of the window do", () => {
  // A high void floor so this test is about which blocks are counted, not about an outage.
  const q = question({ thresholds: [0], model: { rates: { [ALICE]: 0.5 }, voidAlpha: 0.5, minVoidBlocks: 100 } });
  const onlyClosing = series(9, 15, (h) => (h === 9 ? ALICE : OTHER));
  const onlyStart = series(9, 15, (h) => (h === 10 ? ALICE : OTHER));
  const onlyEnd = series(9, 15, (h) => (h === 14 ? ALICE : OTHER));
  const onlyAfter = series(9, 15, (h) => (h === 15 ? ALICE : OTHER));
  for (const [name, blocks, expectOption] of [
    ["closing block", onlyClosing, 0],
    ["first watched block", onlyStart, 1],
    ["last watched block", onlyEnd, 1],
    ["block after the window", onlyAfter, 0],
  ] as const) {
    const scored = scoreQuestion(q, blocks);
    assert.equal(scored.ok, true, name);
    if (!scored.ok) continue;
    assert.equal(scored.result.void, false, name);
    assert.equal(scored.result.option, expectOption, name);
  }
  const withNoise = scoreQuestion(q, onlyEnd);
  const stripped = scoreQuestion(q, onlyEnd.filter((b) => b.h >= 10 && b.h <= 14));
  assert.deepEqual(withNoise, stripped);
});

test("a tie on the line stays in the lower option: equal to the threshold is not 'more than'", () => {
  const blocks = series(10, 12, (h) => (h === 10 || h === 11 ? ALICE : OTHER)); // 2
  const onLine = scoreQuestion(question({ windowStart: 10, windowEnd: 12, thresholds: [2] }), blocks);
  const over = scoreQuestion(question({ windowStart: 10, windowEnd: 12, thresholds: [1] }), blocks);
  assert.equal(onLine.ok && onLine.result.option, 0);
  assert.equal(over.ok && over.result.option, 1);
});

test("head-to-head and combined lines use the same boundary, and only the window", () => {
  // Window 10–12. Alice signs 10 and 11, Bob signs 12, Cara signs 10, Dan signs nothing inside.
  // Closing block 9 is Dan, and block 13 is Dan: neither may move a line.
  const win = series(9, 13, (h) => {
    if (h === 9 || h === 13) return DAN;
    if (h === 10 || h === 11) return ALICE;
    if (h === 12) return BOB;
    return CARA;
  });
  // Alice 2, Bob 1, diff 1. Cara 0, Dan 0 inside the window (Dan's blocks are outside).
  const h2hOn = scoreQuestion(question({ template: "E2s", subjects: [ALICE, BOB], windowStart: 10, windowEnd: 12, thresholds: [1] }), win);
  const h2hOver = scoreQuestion(question({ template: "E2s", subjects: [ALICE, BOB], windowStart: 10, windowEnd: 12, thresholds: [0] }), win);
  assert.equal(h2hOn.ok && h2hOn.result.option, 0);
  assert.equal(h2hOver.ok && h2hOver.result.option, 1);

  const base = {
    template: "H2s", subjects: [ALICE, BOB, CARA, DAN], windowStart: 10, windowEnd: 12, thresholds: [1, 0],
    model: { rates: { [ALICE]: 0.5, [BOB]: 0.5, [CARA]: 0.5, [DAN]: 0.5 }, voidAlpha: 0.5, minVoidBlocks: 100 },
  };
  // d1 = 2-1 = 1, not more than 1. d2 = 0-0 = 0, not more than 0. → neither
  const neither = scoreQuestion(question(base), win);
  assert.equal(neither.ok && neither.result.option, 0);
  assert.equal(neither.ok && neither.result.value, "line 1 = 1, line 2 = 0");
  // d2 more than -1 → line 2 only
  const line2 = scoreQuestion(question({ ...base, thresholds: [1, -1] }), win);
  assert.equal(line2.ok && line2.result.option, 1);
  // d1 more than 0, d2 not more than 0 → line 1 only
  const line1 = scoreQuestion(question({ ...base, thresholds: [0, 0] }), win);
  assert.equal(line1.ok && line1.result.option, 2);
  // both more
  const both = scoreQuestion(question({ ...base, thresholds: [0, -1] }), win);
  assert.equal(both.ok && both.result.option, 3);
});

test("interval, empty-block and transaction questions ignore blocks outside the window", () => {
  const blocks = series(8, 16, () => OTHER, (b) => {
    b.ts = b.h * 1000;
    b.ntx = b.h % 2 === 0 ? 0 : 3;
  });
  // A huge gap is manufactured outside the window and must not win.
  blocks.find((b) => b.h === 8)!.ts = -1_000_000;
  blocks.find((b) => b.h === 16)!.ts = 9_000_000;
  const q = { windowStart: 10, windowEnd: 14, subjects: [] as string[], model: { rates: {} } };
  // inside timestamps: 10000,11000,12000,13000,14000. max gap 1000. avg 1000. empty blocks are the even heights 10,12,14 → 3/5.
  const gap = scoreQuestion(question({ ...q, template: "M4", unit: "ms", thresholds: [500] }), blocks);
  assert.equal(gap.ok && gap.result.option, 1);
  assert.equal(gap.ok && gap.result.value, "1.000 s");
  const avg = scoreQuestion(question({ ...q, template: "M5", unit: "ms", thresholds: [1000] }), blocks);
  assert.equal(avg.ok && avg.result.option, 0); // 1000 is not more than 1000
  assert.equal(avg.ok && avg.result.value, "1.000 s");
  const empty = scoreQuestion(question({ ...q, template: "M6", unit: "permille", thresholds: [599] }), blocks);
  assert.equal(empty.ok && empty.result.value, "60.0%"); // 600 permille
  assert.equal(empty.ok && empty.result.option, 1);
  const txs = scoreQuestion(question({ ...q, template: "M7", unit: "count", thresholds: [6] }), blocks);
  // odd heights 11 and 13 have 3 each → 6. Not more than 6.
  assert.equal(txs.ok && txs.result.option, 0);
  assert.equal(txs.ok && txs.result.value, "6");
});

test("a group's blocks are summed, and a group member going quiet does not void the question", () => {
  const blocks = series(10, 14, (h) => (h === 10 ? ALICE : h === 11 ? BOB : OTHER));
  const scored = scoreQuestion(question({
    template: "M10", subjects: [], group: [ALICE, BOB], thresholds: [1],
    model: { rates: {}, voidAlpha: 0.5, minVoidBlocks: 0 },
  }), blocks);
  assert.equal(scored.ok && scored.result.void, false);
  assert.equal(scored.ok && scored.result.option, 1); // 2 > 1
  assert.equal(scored.ok && scored.result.value, "2");
});

test("void uses the rule saved on the question, and a gap equal to the limit is not yet a void", () => {
  // width 5, rate 0.5, voidAlpha 0.5 → limit log(0.1)/log(0.5) ≈ 3.32 when minVoidBlocks is 0.
  const present = series(10, 14, (h) => (h === 10 || h === 14 ? ALICE : OTHER)); // max gap 3
  const absent = series(10, 14, (h) => (h === 10 ? ALICE : OTHER)); // trailing gap 4
  const rule = { rates: { [ALICE]: 0.5 }, voidAlpha: 0.5, minVoidBlocks: 0 };
  const kept = scoreQuestion(question({ model: rule }), present);
  const voided = scoreQuestion(question({ model: rule }), absent);
  assert.equal(kept.ok && kept.result.void, false);
  assert.equal(voided.ok && voided.result.void, true);
  if (voided.ok) assert.match(voided.result.reason ?? "", /alice went offline/);

  // Same absence, but a stricter alpha saved on the question keeps it live. A looser one voids.
  const strict = scoreQuestion(question({ model: { ...rule, voidAlpha: 0.0001 } }), absent);
  assert.equal(strict.ok && strict.result.void, false);
  // minVoidBlocks saved on the question can be what binds, above the formula.
  const floored = scoreQuestion(question({ model: { ...rule, minVoidBlocks: 4 } }), absent); // gap 4 is not greater
  assert.equal(floored.ok && floored.result.void, false);
});

test("a producer who is quiet only before the window is not voided for that", () => {
  const blocks = series(0, 14, (h) => (h >= 10 ? ALICE : OTHER));
  const scored = scoreQuestion(question({ model: { rates: { [ALICE]: 0.5 }, voidAlpha: 0.5, minVoidBlocks: 0 } }), blocks);
  assert.equal(scored.ok && scored.result.void, false);
  assert.equal(scored.ok && scored.result.option, 1);
});

test("missing history is not scored as a void", () => {
  const q = question();
  const notYet = scoreQuestion(q, series(10, 13, () => ALICE));
  assert.deepEqual(notYet, { ok: false, pending: true, reason: "the window has not closed in the stored history" });
  const hole = series(9, 15, () => ALICE).filter((b) => b.h !== 12);
  const missing = scoreQuestion(q, hole);
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.equal(missing.pending, false);
    assert.match(missing.reason, /missing 1 block/);
  }
  const dup = series(10, 14, () => ALICE).concat([{ h: 12, ts: 1, signer: BOB, ntx: 0, compute: 0 }]);
  const doubled = scoreQuestion(q, dup);
  assert.equal(doubled.ok, false);
  if (!doubled.ok) assert.match(doubled.reason, /duplicate/);
  const noRate = scoreQuestion(question({ model: { rates: {}, voidAlpha: 0.5, minVoidBlocks: 0 } }), series(10, 14, () => ALICE));
  assert.equal(noRate.ok, false);
  if (!noRate.ok) assert.match(noRate.reason, /no release-time rate/);
});

test("every template the generator can post is one this scorer knows", () => {
  const blocks = series(10, 13, (h) => [ALICE, BOB, CARA, DAN][h - 10]);
  for (const id of Object.keys(TEMPLATES)) {
    const scored = scoreQuestion(question({
      template: id,
      subjects: [ALICE, BOB, CARA, DAN],
      group: [ALICE, BOB],
      thresholds: [0, 0],
      unit: id === "M4" || id === "M5" ? "ms" : id === "M6" ? "permille" : "count",
      windowStart: 10,
      windowEnd: 13,
    }), blocks);
    assert.equal(scored.ok, true, id);
  }
});

test("the number posted on chain is the option index, and the contract stores that plus one", () => {
  assert.equal(chainOutcome({ void: false, option: 0 }), 0);
  assert.equal(chainOutcome({ void: false, option: 7 }), 7);
  assert.equal(chainOutcome({ void: true }), CHAIN_VOID);
  assert.equal(storedOutcome({ void: false, option: 0 }), 1);
  assert.equal(storedOutcome({ void: false, option: 7 }), 8);
  assert.equal(storedOutcome({ void: true }), CHAIN_VOID);
  const contract = fs.readFileSync("game/assembly/Kpred.ts", "utf8");
  assert.match(contract, /const VOID: u32 = 1000/);
  assert.match(contract, /outcome == VOID \? VOID : outcome \+ 1/);
});

// "Statistically decided": a VHP reading counts only up to the block from which the remaining blocks change the
// question's option with a chance below model.decidedChance (default 1e-9), from each producer's own blocks so far in
// the window (resolver.ts decidedHeight).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { scoreQuestion, decidedHeight, DECIDED_CHANCE } from "../../resolver.ts";

const day = JSON.parse(fs.readFileSync("tests/audit/fixtures/W000-D3.at-6b37c46.json", "utf8"));
const RELEASE = 100_000_000_000_000n;
const T0 = 1_792_627_200_000;
const FILLER = "1Filler";

function m9(rate: number) {
  const q = structuredClone(day.questions.find((x: any) => x.template === "M9"));
  q.model.rates = { ...q.model.rates, [q.subjects[0]]: rate };
  q.model.vhp = { [q.subjects[0]]: RELEASE.toString() };
  q.model.vhpHeight = q.releaseHeight;
  q.model.voidVhpSwing = 0.1;
  return q;
}
/** Evenly spread blocks for each producer at its rate. */
function spread(q: any, rates: Record<string, number>) {
  const width = q.windowEnd - q.windowStart + 1, acc: Record<string, number> = {};
  return Array.from({ length: width }, (_, i) => {
    let s = FILLER;
    for (const [w, r] of Object.entries(rates)) { acc[w] = (acc[w] ?? 0) + r; if (s === FILLER && acc[w] >= 1) { s = w; acc[w] -= 1; } }
    return { h: q.windowStart + i, ts: T0 + i * 3000, signer: s, ntx: 0, compute: 0 };
  });
}
const swingAt = (q: any, h: number, who = q.subjects[0]) => ({ height: h, values: { [who]: ((RELEASE * 111n) / 100n).toString() } });

test("the report's example: needing 40 more blocks in the last 600 is decided early, and a later swing does not void", () => {
  const q = m9(0.0075);
  const win = spread(q, { [q.subjects[0]]: 0.0075 });
  const d = decidedHeight(q, win);
  assert.ok(d < q.windowEnd - 600, `decided at ${d}, window end ${q.windowEnd}`);
  const r = scoreQuestion(q, win, { vhpReadings: [swingAt(q, q.windowEnd - 590)] });
  assert.ok(r.ok && !r.result.void && r.result.vhpCheck?.decidedHeight === d);
});

test("a genuinely open question is not decided early: a count heading for the middle of an option range", () => {
  const q = m9(0.0075);
  // 192 blocks over 20,000 (between 184 and 200): the count could still pass 200 until close to the end.
  const win = spread(q, { [q.subjects[0]]: 192 / 20_000 });
  const d = decidedHeight(q, win);
  assert.ok(d > q.windowEnd - 2_000, `decided at ${d}: ${q.windowEnd - d} blocks before the end`);
  // A swing well before that still voids.
  const r = scoreQuestion(q, win, { vhpReadings: [swingAt(q, q.windowStart + 10_000)] });
  assert.ok(r.ok && r.result.void);
});

test("head-to-head: a close race stays open until the end", () => {
  const q = m9(0.0075);
  const A = q.subjects[0], B = "1OtherProducer";
  Object.assign(q, { template: "E2s", subjects: [A, B], thresholds: [0] });
  q.model.rates = { [A]: 0.05, [B]: 0.05 };
  q.model.vhp = { [A]: RELEASE.toString(), [B]: RELEASE.toString() };
  // Alternate A, B, A, B, ... : the difference sits at 0 or 1, on the line.
  const win = Array.from({ length: q.windowEnd - q.windowStart + 1 }, (_, i) => ({ h: q.windowStart + i, ts: T0 + i * 3000, signer: i % 20 === 0 ? A : i % 20 === 10 ? B : FILLER, ntx: 0, compute: 0 }));
  assert.equal(decidedHeight(q, win), q.windowEnd);
  // A clear lead decides early.
  const lead = win.map((b, i) => ({ ...b, signer: i % 20 === 0 ? A : i % 100 === 10 ? B : FILLER }));
  assert.ok(decidedHeight(q, lead) < q.windowEnd - 5_000);
});

test("the threshold setting is respected (a larger chance decides earlier; 0 means certain only)", () => {
  const q = m9(0.0075);
  const win = spread(q, { [q.subjects[0]]: 0.0075 });
  assert.equal(decidedHeight(q, win), decidedHeight({ ...q, model: { ...q.model, decidedChance: DECIDED_CHANCE } }, win));
  const strict = decidedHeight(q, win);
  const loose = decidedHeight({ ...q, model: { ...q.model, decidedChance: 1e-3 } }, win);
  const certain = decidedHeight({ ...q, model: { ...q.model, decidedChance: 0 } }, win);
  assert.ok(loose < strict && strict < certain, `1e-3: ${loose}, 1e-9: ${strict}, certain: ${certain}`);
  // Certain: count + every remaining block cannot reach 185.
  const n = win.findIndex((b) => b.h === certain);
  const count = win.slice(0, n + 1).filter((b) => b.signer === q.subjects[0]).length;
  assert.ok(count + (win.length - 1 - n) <= 184 && count + (win.length - n) > 184);
});

test("old questions keep their old rule: no VHP snapshot, no cut-off (the offline rule sees the whole window)", () => {
  const q = m9(0.0075);
  delete q.model.vhp; delete q.model.vhpHeight; delete q.model.voidVhpSwing;
  const S = q.subjects[0];
  // 220 blocks early (past the top threshold), then silent for the rest of the window: offline.
  const win = Array.from({ length: q.windowEnd - q.windowStart + 1 }, (_, i) => ({ h: q.windowStart + i, ts: T0 + i * 3000, signer: i < 220 * 20 && i % 20 === 0 ? S : FILLER, ntx: 0, compute: 0 }));
  const r = scoreQuestion(q, win);
  assert.ok(r.ok && r.result.void && /went offline/.test(r.result.reason ?? ""));
  assert.equal(r.ok && r.result.vhpCheck, undefined);
  // The same blocks with the VHP rule: decided once the top threshold is passed, so the later silence does not void.
  const v = m9(0.0075);
  const rv = scoreQuestion(v, win, { vhpReadings: [{ height: v.windowStart + 100, values: { [S]: RELEASE.toString() } }] });
  assert.ok(rv.ok && !rv.result.void && rv.result.option === 3);
});

test("statistically decided answers do not change: 4,000 random windows at a 1e-6 chance never see a change", () => {
  let seed = 7;
  const R = () => { seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31; return seed / 2 ** 31; };
  let early = 0;
  for (let k = 0; k < 4_000; k++) {
    const width = 400 + Math.floor(R() * 1_600), pa = 0.01 + R() * 0.2, pb = 0.01 + R() * 0.2;
    const kind = k % 2 ? "M9" : "E2s";
    const win = Array.from({ length: width }, (_, i) => { const u = R(); return { h: 1_000 + i, ts: T0 + i * 3000, signer: u < pa ? "1A" : u < pa + pb ? "1B" : FILLER, ntx: 0, compute: 0 }; });
    const ca = win.filter((b) => b.signer === "1A").length, cb = win.filter((b) => b.signer === "1B").length;
    const q: any = { template: kind, subjects: kind === "M9" ? ["1A"] : ["1A", "1B"], unit: "count", windowStart: 1_000, windowEnd: 1_000 + width - 1,
      thresholds: kind === "M9" ? [Math.round(ca * (0.8 + R() * 0.4))] : [Math.round((ca - cb) * (R() * 1.2))], model: { decidedChance: 1e-6 } };
    const d = decidedHeight(q, win);
    if (d === q.windowEnd) continue;
    early++;
    // The option at the decided block, if the rest of the window were like its start, must be the final one.
    const final = scoreQuestion({ ...q, model: { rates: { "1A": 0.5, "1B": 0.5 }, minVoidBlocks: 1e9 } }, win);
    const upto = win.filter((b) => b.h <= d);
    const v = kind === "M9" ? upto.filter((b) => b.signer === "1A").length : upto.filter((b) => b.signer === "1A").length - upto.filter((b) => b.signer === "1B").length;
    const now = q.thresholds.filter((t: number) => v > t).length;
    assert.ok(final.ok);
    assert.equal(now, final.result.option, `window ${k}: decided at ${d} with option ${now}, final ${final.result.option}`);
  }
  assert.ok(early > 500, `enough early decisions (${early})`);
});

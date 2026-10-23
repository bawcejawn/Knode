// Red-team SABOTEUR (fix check d198283): decidedHeight() (resolver.ts:147) and the VHP-swing rule's cut-off.
// The README says readings stop counting at "the first block from which the window's blocks already fix the option",
// so a loser cannot buy a void once the outcome is public. For over/under counts (single, tail) decidedHeight only
// looks UP (the count passed the top threshold). When the count can no longer reach the next threshold (count +
// every remaining block <= that threshold) the option is just as fixed, but decidedHeight returns windowEnd, so a VHP
// gift made after that block still voids the question.
// Each test asserts the SAFE behaviour: a failing test proves a problem. Tests marked "(control)" are expected to pass.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { scoreQuestion, decidedHeight } from "../../resolver.ts";

const day = JSON.parse(fs.readFileSync("tests/audit/fixtures/W000-D3.at-6b37c46.json", "utf8"));
const byT = (t: string) => structuredClone(day.questions.find((q: any) => q.template === t));
const RELEASE = 100_000_000_000_000n; // 1,000,000 VHP
const T0 = 1_792_627_200_000;
const FILLER = "1FillerCoreProducerXXXXXXXXXXXXXXX";
const optionOf = (v: number, t: number[]) => t.filter((x) => v > x).length;
const pct = (n: bigint, p: bigint) => ((n * p) / 100n).toString();

function blocks(q: any, signers: string[]) {
  return signers.map((s, i) => ({ h: q.windowStart + i, ts: T0 + i * 3000, signer: s, ntx: 0, compute: 0 }));
}
/** First window index from which the count can no longer change the option (count only grows, by at most 1 per block). */
function countCertainIdx(signers: string[], counts: (s: string) => number, t: number[]) {
  let c = 0;
  for (let i = 0; i < signers.length; i++) {
    c += counts(signers[i]);
    const r = signers.length - 1 - i;
    if (optionOf(c, t) === optionOf(c + r, t)) return i;
  }
  return signers.length - 1;
}

// SAB3-1: single-producer count (M9) heading for the LOWEST option. Once count + remaining blocks <= 184 nobody can
// change the answer, yet a +20% VHP reading after that block voids the question.
test("SAB3-1: M9 count that can no longer reach the next threshold is decided; a later VHP swing must not void", () => {
  const q = byT("M9");
  const S = q.subjects[0];
  const width = q.windowEnd - q.windowStart + 1;
  const sig: string[] = new Array(width).fill(FILLER);
  for (let j = 0; j < 100; j++) sig[Math.floor(((j + 0.5) * width) / 100)] = S; // 100 blocks, gaps <= 200 (no offline void)
  q.model.vhp = { [S]: RELEASE.toString() };
  q.model.vhpHeight = q.releaseHeight;
  q.model.voidVhpSwing = 0.1;
  const certain = q.windowStart + countCertainIdx(sig, (s) => (s === S ? 1 : 0), q.thresholds);
  const late = certain + 1;
  assert.ok(late < q.windowEnd, "setup: the option is fixed before the window's last block");
  const readings = [
    { height: q.windowStart + 140, values: { [S]: RELEASE.toString() } },
    { height: late, values: { [S]: pct(RELEASE, 120n) } },
  ];
  const r = scoreQuestion(q, blocks(q, sig), { vhpReadings: readings });
  assert.ok(r.ok, r.ok ? "" : r.reason);
  assert.ok(!r.result.void,
    `SAB3-1: option ${optionOf(100, q.thresholds)} was certain from block ${certain} (${q.windowEnd - certain} blocks before the end), ` +
    `decidedHeight=${decidedHeight(q, blocks(q, sig))}; a +20% gift seen at block ${late} still voided it (${r.result.reason})`);
});

// SAB3-2: same for a group question (M10). M10 windows are 20,000 blocks (~17 h at ~3.06 s), so they end within
// minutes of the bot's hourly run at minute 7: the last reading regularly lands in the stretch where the group's total
// is already fixed but decidedHeight still says "open".
test("SAB3-2: M10 group total that can no longer reach the next threshold is decided; a later combined swing must not void", () => {
  const q = byT("M10");
  const members: string[] = q.group;
  const width = q.windowEnd - q.windowStart + 1;
  const sig: string[] = new Array(width).fill(FILLER);
  const total = 410; // option 1 (406..452)
  for (let j = 0; j < total; j++) sig[Math.floor(((j + 0.5) * width) / total)] = members[j % members.length];
  q.model.vhp = Object.fromEntries(members.map((m) => [m, RELEASE.toString()]));
  q.model.vhpHeight = q.releaseHeight;
  q.model.voidVhpSwing = 0.1;
  const g = new Set(members);
  const certain = q.windowStart + countCertainIdx(sig, (s) => (g.has(s) ? 1 : 0), q.thresholds);
  const late = certain + 1;
  assert.ok(late < q.windowEnd, "setup: the option is fixed before the window's last block");
  const readings = [
    { height: q.windowStart + 140, values: Object.fromEntries(members.map((m) => [m, RELEASE.toString()])) },
    { height: late, values: Object.fromEntries(members.map((m) => [m, pct(RELEASE, 120n)])) },
  ];
  const r = scoreQuestion(q, blocks(q, sig), { vhpReadings: readings });
  assert.ok(r.ok, r.ok ? "" : r.reason);
  assert.ok(!r.result.void,
    `SAB3-2: the group's option was certain from block ${certain} (${q.windowEnd - certain} blocks before the end), ` +
    `decidedHeight=${decidedHeight(q, blocks(q, sig))}; a +20% combined swing seen at block ${late} still voided it (${r.result.reason})`);
});

// SAB3-3 (control): head-to-head IS cut off by the "remaining blocks cannot change it" test. Shows the rule already
// knows how to do this; single/tail counts just do not use it. Also checks the boundary: a reading AT decidedHeight
// counts, one block later does not.
test("SAB3-3 (control): h2h is decided once the lead exceeds the remaining blocks; reading at decidedHeight counts, +1 does not", () => {
  const q = byT("M9");
  const A = q.subjects[0], B = "1OtherProducerYYYYYYYYYYYYYYYYYYYY";
  Object.assign(q, { template: "E2s", subjects: [A, B], thresholds: [10], windowEnd: q.windowStart + 299 });
  q.model.decidedChance = 0; // this control checks the "certain" boundary; the statistical cut-off is tested elsewhere
  q.model.rates = { [A]: 0.1, [B]: 0.1 };
  q.model.vhp = { [A]: RELEASE.toString(), [B]: RELEASE.toString() };
  q.model.voidVhpSwing = 0.1;
  const sig = Array.from({ length: 300 }, (_, i) => (i < 150 ? A : FILLER));
  const win = blocks(q, sig);
  // d = 150 from index 149; d - r > 10 first at index 160.
  assert.equal(decidedHeight(q, win), q.windowStart + 160);
  const at = (h: number) => scoreQuestion(q, win, { vhpReadings: [{ height: h, values: { [A]: pct(RELEASE, 150n), [B]: RELEASE.toString() } }] });
  const on = at(q.windowStart + 160), after = at(q.windowStart + 161);
  assert.ok(on.ok && on.result.void, "a reading at decidedHeight counts");
  assert.ok(after.ok && !after.result.void, "a reading one block after decidedHeight does not");
});

// SAB3-6: a group listing the same producer twice. scoreQuestion counts each listed member (resolver.ts:291), so the
// total grows by 2 per block of the duplicate, but decidedHeight counts the group as a Set (resolver.ts:157) and so
// thinks the top threshold was passed much later (here: never), keeping the void open after the outcome is public.
test("SAB3-6: duplicate group member: decidedHeight must match the total scoreQuestion actually computes", () => {
  const q = byT("M10");
  const A = q.group[0], B = q.group[1];
  Object.assign(q, { group: [A, A, B], thresholds: [10, 20, 30], windowEnd: q.windowStart + 299 });
  q.model.vhp = { [A]: RELEASE.toString(), [B]: RELEASE.toString() };
  q.model.voidVhpSwing = 0.1;
  const sig = Array.from({ length: 300 }, (_, i) => (i < 16 ? A : FILLER)); // total = 2 x 16 = 32 > 30 at index 15
  const win = blocks(q, sig);
  const r = scoreQuestion(q, win, { vhpReadings: [{ height: q.windowStart + 100, values: { [A]: pct(RELEASE, 150n), [B]: RELEASE.toString() } }] });
  assert.ok(r.ok, r.ok ? "" : r.reason);
  assert.equal(r.result.option, 3, "setup: the doubled total passes the top threshold");
  assert.ok(decidedHeight(q, win) <= q.windowStart + 15 && !r.result.void,
    `SAB3-6: the total passed the top threshold at block ${q.windowStart + 15}, decidedHeight=${decidedHeight(q, win)}; a swing seen at ${q.windowStart + 100} voided it (${r.result.reason})`);
});

// SAB3-7 (control): single count passing the top threshold: boundary exactly at decidedHeight.
test("SAB3-7 (control): single count over the top threshold: reading at decidedHeight voids, one block later does not", () => {
  const q = byT("M9");
  const S = q.subjects[0];
  Object.assign(q, { thresholds: [5, 10, 15], windowEnd: q.windowStart + 299 });
  q.model.vhp = { [S]: RELEASE.toString() };
  q.model.voidVhpSwing = 0.1;
  const win = blocks(q, Array.from({ length: 300 }, (_, i) => (i < 16 ? S : FILLER)));
  assert.equal(decidedHeight(q, win), q.windowStart + 15);
  const at = (h: number) => scoreQuestion(q, win, { vhpReadings: [{ height: h, values: { [S]: pct(RELEASE, 150n) } }] });
  const on = at(q.windowStart + 15), after = at(q.windowStart + 16);
  assert.ok(on.ok && on.result.void, "a reading at decidedHeight counts");
  assert.ok(after.ok && !after.result.void, "a reading one block after decidedHeight does not");
});

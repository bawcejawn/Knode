// Red-team SABOTEUR (fix check d198283): the new decidedHeight cut-off vs the offline-void rule, and the published
// group VHP detail.
// Each test asserts the SAFE behaviour: a failing test proves a problem.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { scoreQuestion, decidedHeight, GROUP_VHP } from "../../resolver.ts";

const day = JSON.parse(fs.readFileSync("tests/audit/fixtures/W000-D3.at-6b37c46.json", "utf8"));
const byT = (t: string) => structuredClone(day.questions.find((q: any) => q.template === t));
const RELEASE = 100_000_000_000_000n;
const T0 = 1_792_627_200_000;
const FILLER = "1FillerCoreProducerXXXXXXXXXXXXXXX";
const blocks = (q: any, sig: string[]) => sig.map((s, i) => ({ h: q.windowStart + i, ts: T0 + i * 3000, signer: s, ntx: 0, compute: 0 }));

// SAB3-4: the commit's rationale is "once the blocks decide the answer, a loser must not be able to buy a void". The
// offline rule (resolver.ts:264-276) still looks at every block of the window (docstring resolver.ts:146), so the
// void stays for sale by a different route: the subject (an M9 "smaller producer", or anyone able to keep it out of
// the schedule) simply stops producing once its count has passed the top threshold. Cost: ~45 blocks of rewards at
// its ~1% share. The answer is public from 80% of the window, yet the question is voided.
test("SAB3-4: a subject going silent AFTER its count already decided the answer must not void the question", () => {
  const q = byT("M9");
  const S = q.subjects[0];
  const width = q.windowEnd - q.windowStart + 1;
  const sig: string[] = new Array(width).fill(FILLER);
  for (let i = 0; i < width && i < 220 * 72; i += 72) sig[i] = S; // 220 blocks (> 219 = top) by index 15,768
  q.model.vhp = { [S]: RELEASE.toString() };
  q.model.vhpHeight = q.releaseHeight;
  q.model.voidVhpSwing = 0.1;
  const win = blocks(q, sig);
  const decided = decidedHeight(q, win);
  assert.equal(decided, q.windowStart + 219 * 72, "setup: the count passes the top threshold at its 220th block");
  const r = scoreQuestion(q, win, { vhpReadings: [{ height: q.windowStart + 140, values: { [S]: RELEASE.toString() } }] });
  assert.ok(r.ok, r.ok ? "" : r.reason);
  assert.equal(r.result.vhpCheck?.decidedHeight, decided);
  assert.ok(!r.result.void,
    `SAB3-4: option D was certain at block ${decided} (${(100 * (decided - q.windowStart + 1) / width).toFixed(0)}% of the window), ` +
    `then ${S} stopped producing for ${q.windowEnd - decided} blocks and the question was voided (${r.result.reason})`);
});

// SAB3-5: the published vhpCheck for a group question. vhpSwingCheck writes `release: start[who]` (resolver.ts:132)
// for every checked key that had a reading; for the combined key "group" model.vhp has no such entry, so the
// published release value is undefined (dropped from the JSON). The README promises "anyone can check it".
test("SAB3-5: vhpCheck.values.group.release must be the members' combined release VHP", () => {
  const q = byT("M10");
  const members: string[] = q.group;
  const rel = members.map((_, i) => RELEASE * BigInt(i + 1));
  q.model.vhp = Object.fromEntries(members.map((m, i) => [m, rel[i].toString()]));
  q.model.vhpHeight = q.releaseHeight;
  q.model.voidVhpSwing = 0.1;
  const width = q.windowEnd - q.windowStart + 1;
  const win = blocks(q, new Array(width).fill(FILLER));
  const r = scoreQuestion(q, win, { vhpReadings: [{ height: q.windowStart + 140, values: Object.fromEntries(members.map((m, i) => [m, rel[i].toString()])) }] });
  assert.ok(r.ok, r.ok ? "" : r.reason);
  const g = r.result.vhpCheck?.values?.[GROUP_VHP];
  assert.ok(g, "setup: the group key is reported");
  const sum = rel.reduce((s, x) => s + x, 0n).toString();
  assert.equal(g!.release, sum, `SAB3-5: the published group release is ${JSON.stringify(g!.release)}, not the combined ${sum}`);
  // Round-trip through the question file: the field must survive JSON.
  assert.equal(JSON.parse(JSON.stringify(r.result)).vhpCheck.values[GROUP_VHP].release, sum);
});

// Independent verify (AB-035): realistic variant. The second-to-last hourly reading (minute 7) is ~2,300 blocks before
// windowEnd; the attacker gifts >10% right after it, and the LAST hourly reading (~1,100 blocks before windowEnd) catches
// it. The subject is far below the first threshold, so option A is practically public. Asserts SAFE behaviour
// (not void); a failure upholds AB-035.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { scoreQuestion, decidedHeight } from "../../resolver.ts";

const day = JSON.parse(fs.readFileSync("tests/audit/fixtures/W000-D3.at-6b37c46.json", "utf8"));
const RELEASE = 100_000_000_000_000n;

test("VERIFY-035: last hourly reading (1,100 blocks before end) with a lower option practically certain must not void", () => {
  const q = structuredClone(day.questions.find((x: any) => x.template === "M9"));
  delete q.chainId;
  const who = q.subjects[0];
  const width = q.windowEnd - q.windowStart + 1;
  const rate = (q.thresholds[0] * 0.75) / width;           // ends ~25% below the first threshold
  q.model.rates = { ...q.model.rates, [who]: rate };
  q.model.vhp = { [who]: RELEASE.toString() };
  q.model.vhpHeight = q.releaseHeight;
  q.model.voidVhpSwing = 0.1;
  let acc = 0;
  const blocks = Array.from({ length: width }, (_, i) => {
    acc += rate; let s = "1Filler"; if (acc >= 1) { s = who; acc -= 1; }
    return { h: q.windowStart + i, ts: 1_792_627_200_000 + i * 3000, signer: s, ntx: 0, compute: 0 };
  });
  const at = q.windowEnd - 1_100;
  const count = blocks.filter((b) => b.h <= at && b.signer === who).length;
  const need = q.thresholds[0] + 1 - count;
  assert.ok(need > 1_100 * rate * 4, `setup: needs ${need} more in 1,100 blocks at expected ${1_100 * rate}`);
  // The owner's rule is now "statistically decided": the premise is that the answer is practically, not mathematically,
  // certain (the remaining blocks could still reach the first threshold).
  assert.ok(count + 1_100 > q.thresholds[0], "setup: not mathematically certain");
  assert.ok(decidedHeight(q, blocks) < at, "the rule must call it decided before the reading");
  const readings = [
    { height: at - 1_200, values: { [who]: RELEASE.toString() } },
    { height: at, values: { [who]: ((RELEASE * 111n) / 100n).toString() } },
  ];
  const r = scoreQuestion(q, blocks, { vhpReadings: readings });
  assert.ok(r.ok, r.ok ? "" : (r as any).reason);
  assert.ok(!r.result.void, `VERIFY-035: count ${count}, needs ${need} more in 1,100 blocks; +11% at the last hourly reading voided: ${r.result.reason}`);
});

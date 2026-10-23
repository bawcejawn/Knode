// Audit fix check 3 (AB-036 proof): group questions are checked on the members' combined VHP. Same cases as
// FC3-GRP-1/2 in vhp-decided.fc3.test.ts, alone so the fix has a proof file of its own.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { scoreQuestion } from "../../resolver.ts";

const day = JSON.parse(fs.readFileSync("tests/audit/fixtures/W000-D3.at-6b37c46.json", "utf8"));
const RELEASE = 100_000_000_000_000n;
const HOUR = 1_200;
function m10() {
  const q = structuredClone(day.questions.find((x: any) => x.template === "M10"));
  delete q.chainId;
  q.model.vhp = Object.fromEntries(q.group.map((w: string, i: number) => [w, String(BigInt(i + 1) * 1_000_000_000_000n)]));
  q.model.vhpHeight = q.releaseHeight;
  q.model.voidVhpSwing = 0.1;
  return q;
}
function groupBlocks(q: any) {
  const width = q.windowEnd - q.windowStart + 1;
  return Array.from({ length: width }, (_, i) => ({ h: q.windowStart + i, ts: 1_792_627_200_000 + i * 3000, signer: i % 50 === 0 ? q.group[i % q.group.length] : "1Core", ntx: 0, compute: 0 }));
}

test("FC3-GRP-1: a gift of 10% of the smallest member's VHP no longer voids a group question (AB-036)", () => {
  const q = m10();
  const v = { ...q.model.vhp };
  v[q.group[0]] = ((BigInt(v[q.group[0]]) * 150n) / 100n).toString();   // smallest member +50%
  const r = scoreQuestion(q, groupBlocks(q), { vhpReadings: [{ height: q.windowStart + 100, values: v }] });
  assert.ok(r.ok, r.ok ? "" : r.reason);
  assert.ok(!r.result.void, `FC3-GRP-1: voided by one small member: ${r.result.reason}`);
});

test("FC3-GRP-2: the group's combined VHP moving more than 10% still voids (and exactly 10% does not)", () => {
  const q = m10();
  const total = Object.values(q.model.vhp as Record<string, string>).reduce((s, x) => s + BigInt(x), 0n);
  const exact = { ...q.model.vhp }, over = { ...q.model.vhp };
  const big = q.group[q.group.length - 1];
  exact[big] = (BigInt(exact[big]) + total / 10n).toString();
  over[big] = (BigInt(over[big]) + total / 10n + 1n).toString();
  const a = scoreQuestion(q, groupBlocks(q), { vhpReadings: [{ height: q.windowStart + 100, values: exact }] });
  const b = scoreQuestion(q, groupBlocks(q), { vhpReadings: [{ height: q.windowStart + 100, values: over }] });
  assert.ok(a.ok && b.ok);
  assert.ok(!a.result.void, `FC3-GRP-2: exactly +10% of the group voided: ${a.result.reason}`);
  assert.ok(b.result.void, "FC3-GRP-2: +10% + 1 unit of the group's combined VHP did not void");
  // Moving VHP between members (total unchanged) does not void.
  const moved = { ...q.model.vhp };
  moved[q.group[0]] = "0"; moved[big] = (BigInt(moved[big]) + BigInt(q.model.vhp[q.group[0]])).toString();
  const c = scoreQuestion(q, groupBlocks(q), { vhpReadings: [{ height: q.windowStart + 100, values: moved }] });
  assert.ok(c.ok && !c.result.void, "FC3-GRP-2: a transfer between members (same total) voided");
});

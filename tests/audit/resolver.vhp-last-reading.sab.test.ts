// Red-team SABOTEUR (fix check 1dbc129): the revised VHP-swing void rule (in-window hourly readings).
// Attack: wait until (almost) every block of the window is public, see the answer is going the "wrong" way, then push a
// subject's VHP over the 10% limit (the subject itself for free, or ANYONE by sending/burning VHP to it or swapping
// into the Knode Swap desk) so that the bot's last in-window reading voids the question.
// Each test asserts the SAFE behaviour: it FAILS on the current code (proof) and passes once fixed.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { scoreQuestion, vhpSubjects } from "../../resolver.ts";

const day = JSON.parse(fs.readFileSync("tests/audit/fixtures/W000-D3.at-6b37c46.json", "utf8"));
const byT = (t: string) => structuredClone(day.questions.find((q: any) => q.template === t));
const FILLER = "1FillerCoreProducerXXXXXXXXXXXXXXX";

/** Copied unchanged from tests/audit/resolver.vhp-swing-edges.test.ts: blocks where each producer signs at its rate. */
function history(q: any) {
  const width = q.windowEnd - q.windowStart + 1;
  const sig: string[] = new Array(width).fill(FILLER);
  for (const [who, r] of Object.entries((q.model.rates ?? {}) as Record<string, number>)) {
    const n = Math.round(width * r);
    for (let j = 0; j < n; j++) {
      let i = Math.floor(((j + 0.5) * width) / n);
      while (i < width && sig[i] !== FILLER) i++;
      if (i < width) sig[i] = who;
    }
  }
  return sig.map((s, i) => ({ h: q.windowStart + i, ts: 1_792_627_200_000 + i * 3000, signer: s, ntx: 0, compute: 0 }));
}

const RELEASE = 100_000_000_000_000n; // 1,000,000 VHP
function m9() {
  const q = byT("M9");                 // 20,000-block window (~17 h), one subject
  q.model.vhp = { [q.subjects[0]]: RELEASE.toString() };
  q.model.vhpHeight = q.releaseHeight;
  q.model.voidVhpSwing = 0.1;
  return q;
}

// Attack: reading at height == windowEnd. At that height every block of the window already exists (the README's own
// reason for ignoring later readings: "by then the outcome is public"). Safe: such a reading cannot void.
test("SAB2-VHP-1: a +20% VHP reading taken at height windowEnd (all window blocks already produced) must not void", () => {
  const q = m9();
  const r = scoreQuestion(q, history(q), { vhpReadings: [{ height: q.windowEnd, values: { [q.subjects[0]]: ((RELEASE * 120n) / 100n).toString() } }] });
  assert.ok(r.ok, r.ok ? "" : r.reason);
  assert.ok(!r.result.void,
    `SAB2-VHP-1: a reading taken when 100% of the window's ${q.windowEnd - q.windowStart + 1} blocks were public voided the question (${r.result.reason})`);
});

// Attack: the bot's last hourly run inside a 20,000-block window lands ~1 hour (1,200 blocks) before windowEnd: 94% of
// the window is public. A subject/sybil gifts +11% just before it. Safe: a swing first seen this late does not void.
test("SAB2-VHP-2: a swing first seen in the last hourly reading (94% of a 20,000-block window public) must not void", () => {
  const q = m9();
  // Adapted to the owner's rule (decision 2026-10, AB-035): readings count up to the block where the window's blocks
  // decide the answer. In the fixture that block is 45 blocks before windowEnd, so a reading 1,200 blocks earlier is
  // still taken while the answer is open and is meant to void. The subject here produces faster (as in MINE-VHP-1), so
  // its count passes the top threshold before that last hourly reading: the attack the test describes (VHP moved once
  // the answer is public).
  q.model.rates = { ...q.model.rates, [q.subjects[0]]: 0.013 };
  const width = q.windowEnd - q.windowStart + 1;
  const h = q.windowEnd - 1_200;
  const readings = [
    { height: q.windowStart + 100, values: { [q.subjects[0]]: RELEASE.toString() } },
    { height: q.windowStart + 10_000, values: { [q.subjects[0]]: RELEASE.toString() } },
    { height: h, values: { [q.subjects[0]]: ((RELEASE * 111n) / 100n).toString() } },
  ];
  const r = scoreQuestion(q, history(q), { vhpReadings: readings });
  assert.ok(r.ok, r.ok ? "" : r.reason);
  assert.ok(!r.result.void,
    `SAB2-VHP-2: a VHP move made after ${(100 * (h - q.windowStart + 1) / width).toFixed(1)}% of the window was public voided the question (${r.result.reason})`);
});

// Attack: group question (M10, 7 producers summed). The attacker gifts VHP to the SMALLEST member (rate 1.7e-5 →
// ~1.7 millionths of network VHP), +50% of ITS VHP, which moves the group's total by about 0.04%. Safe: the swing that
// matters for a question about a group total is the group's total, so this cannot void.
test("SAB2-VHP-3: +50% on the tiniest member of a 7-producer group (group total +0.04%) must not void the group question", () => {
  const q = byT("M10");
  const members = vhpSubjects(q);
  const rates = q.model.rates as Record<string, number>;
  const maxRate = Math.max(...members.map((m) => rates[m]));
  // Release VHP proportional to each member's block rate (PoB: blocks ∝ VHP); the biggest member holds 1,000,000 VHP.
  const rel: Record<string, bigint> = Object.fromEntries(members.map((m) => [m, BigInt(Math.max(1, Math.round((rates[m] / maxRate) * 1e6))) * 100_000_000n]));
  const tiny = members.reduce((a, b) => (rel[a] < rel[b] ? a : b));
  q.model.vhp = Object.fromEntries(members.map((m) => [m, rel[m].toString()]));
  q.model.vhpHeight = q.releaseHeight;
  q.model.voidVhpSwing = 0.1;
  const values = Object.fromEntries(members.map((m) => [m, (m === tiny ? (rel[m] * 150n) / 100n : rel[m]).toString()]));
  const total = members.reduce((s, m) => s + rel[m], 0n);
  const groupChangePpm = Number(((rel[tiny] / 2n) * 1_000_000n) / total);
  const r = scoreQuestion(q, history(q), { vhpReadings: [{ height: q.windowEnd - 1_200, values }] });
  assert.ok(r.ok, r.ok ? "" : r.reason);
  assert.ok(!r.result.void,
    `SAB2-VHP-3: a gift of ${(Number(rel[tiny] / 2n) / 1e8).toFixed(0)} VHP to ${tiny} (group total +${(groupChangePpm / 10_000).toFixed(4)}%) voided the group question (${r.result.reason})`);
});

// Control (expected to PASS = blocked): a reading one block after windowEnd never counts, and the largest change (not
// the latest reading) decides, so moving VHP back before a later reading cannot "un-void" (no escape that way).
test("SAB2-VHP-4 (blocked): post-window readings are ignored; a reverted swing seen mid-window still voids", () => {
  const q = m9();
  const late = scoreQuestion(q, history(q), { vhpReadings: [{ height: q.windowEnd + 1, values: { [q.subjects[0]]: ((RELEASE * 200n) / 100n).toString() } }] });
  assert.ok(late.ok && !late.result.void, "a reading after windowEnd must not void");
  const mid = scoreQuestion(q, history(q), { vhpReadings: [
    { height: q.windowStart + 5_000, values: { [q.subjects[0]]: ((RELEASE * 70n) / 100n).toString() } },
    { height: q.windowStart + 9_000, values: { [q.subjects[0]]: RELEASE.toString() } },
  ] });
  assert.ok(mid.ok && mid.result.void, "a −30% reading mid-window still voids after the VHP is moved back");
});

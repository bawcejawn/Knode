// Red-team THIEF (fix check 2, Knode audit-fixes-1 @ 1dbc129): the revised VHP-swing void rule (resolver.ts
// vhpSwingCheck), attacked by a player who wants to void a question they are losing, or keep one alive.
// Asserts the SAFE behaviour: a failing case is a proven problem.
import { test } from "node:test";
import assert from "node:assert/strict";
import { vhpSwingCheck, type QuestionInput } from "../../resolver.ts";

const DESK = "1FKTpXBhhHEbu5vVchM8UsVbAvPArJsRmR";
const q = (): QuestionInput => ({ template: "E1s", subjects: [DESK], unit: "blocks", windowStart: 1_000, windowEnd: 6_000,
  thresholds: [10], model: { vhp: { [DESK]: "1000000000000" }, vhpHeight: 900, voidVhpSwing: 0.1 } });
const r = (height: number, v: string) => ({ height, values: { [DESK]: v } });

test("THIEF2-SWING-1 (blocked) a swing shown only after the window's last block never voids", () => {
  // Attack: wait until the outcome is public, then move the subject's VHP and hope a late reading counts. Safe: not void.
  const v = vhpSwingCheck(q(), [r(3_000, "1000000000000"), r(6_001, "2000000000000")]);
  assert.ok(v.ok && v.swung.length === 0, "THIEF2-SWING-1: a reading after windowEnd voided the question");
});

test("THIEF2-SWING-2 (blocked) a swing before the window that is undone before it starts never voids", () => {
  // Attack: move VHP between release and windowStart (readings then are dropped). Safe: only in-window readings count.
  const v = vhpSwingCheck(q(), [r(999, "2000000000000"), r(1_500, "1000000000000")]);
  assert.ok(v.ok && v.swung.length === 0, "THIEF2-SWING-2: a pre-window reading voided the question");
});

test("THIEF2-SWING-3 (boundary) exactly +10% does not void, one unit more does (strict >, exact integers)", () => {
  // Attack: push exactly to the limit to void cheaply. Safe: the limit is strict and computed in integers.
  const at = vhpSwingCheck(q(), [r(2_000, "1100000000000")]);
  assert.ok(at.ok && at.swung.length === 0, "THIEF2-SWING-3: exactly 10% voided");
  const over = vhpSwingCheck(q(), [r(2_000, "1100000000001")]);
  assert.ok(over.ok && over.swung.length === 1, "THIEF2-SWING-3: 10% + 1 unit did not void");
  const down = vhpSwingCheck(q(), [r(2_000, "899999999999")]);
  assert.ok(down.ok && down.swung.length === 1, "THIEF2-SWING-3: -10% - 1 unit did not void");
});

test("THIEF2-SWING-4 (blocked) a later calm reading cannot hide an earlier in-window swing", () => {
  // Attack (by someone who wants the question kept): bring VHP back so the last reading is calm. Safe: largest change decides.
  const v = vhpSwingCheck(q(), [r(2_000, "1200000000000"), r(5_000, "1000000000000")]);
  assert.ok(v.ok && v.swung.length === 1, "THIEF2-SWING-4: the swing was hidden by a later calm reading");
});

// Proof test (audit fix check, AB-031): params_hash covers the options players choose from.
// Adapted: the question is marked as released under the new hash rule (hashRule 2), because questions posted before
// it keep the hash rule they were posted with. PF-1..PF-3 of the original file need owner data (the registered
// producer keys, a separate seed-owner key) and are tracked as owner actions instead.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { paramsHashOf } from "../../resolver.ts";

test("PF-4 params_hash covers the options players choose from", () => {
  const day = JSON.parse(fs.readFileSync("tests/audit/fixtures/W000-D3.at-6b37c46.json", "utf8"));
  const q = structuredClone(day.questions.find((x: any) => Array.isArray(x.options) && x.options.length >= 2));
  assert.ok(q, "fixture question with options");
  q.hashRule = 2;                                                         // released under the new hash rule
  const h0 = paramsHashOf(q);
  const swapped = structuredClone(q);
  const [a, b] = [swapped.options[0].label, swapped.options[1].label];
  swapped.options[0].label = b; swapped.options[1].label = a;            // relabel: players pick the wrong range
  assert.notEqual(paramsHashOf(swapped), h0, "PF-4: swapping two option labels leaves params_hash unchanged");
  const moved = structuredClone(q);
  moved.options[0].max = (moved.options[0].max ?? 0) + 1000;             // change a displayed range bound
  assert.notEqual(paramsHashOf(moved), h0, "PF-4: changing an option's displayed range leaves params_hash unchanged");
});

test("questions posted before the new rule keep their hash; bookkeeping never changes it", () => {
  const day = JSON.parse(fs.readFileSync("tests/audit/fixtures/W000-D3.at-6b37c46.json", "utf8"));
  for (const q of day.questions) assert.equal(paramsHashOf(q), q.paramsHash, q.id);
  const q = structuredClone(day.questions[0]);
  q.hashRule = 2;
  const h = paramsHashOf(q);
  for (const [k, v] of Object.entries({ chainId: 3, chainOutcome: 2, result: {}, vhpReadings: [], corrections: [], chainDataHash: "0x" })) (q as any)[k] = v;
  assert.equal(paramsHashOf(q), h);
});

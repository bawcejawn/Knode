// tests/audit/names.fold-i-one.C1-3.test.mjs   (node --test)   Repo Lens #C-1, finding C1-3 (PN-6 residual)
// A capital I or a digit 1 in place of the l of "cl" must not get round the reserved-name rule. Written, not run here.
import { test } from "node:test"; import assert from "node:assert/strict"; import { fileURLToPath } from "node:url";
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
await import(new URL("names.js", `file://${ROOT}`).href);
const R = globalThis.KNames.rules;
for (const n of ["Knocle Games", "KnocIe Games", "Knoc1e Games", "Knoc1e Swap", "KnocIe"]) test(`C1-3: "${n}" is reserved`, () => {
  assert.notEqual(R.checkName(n), null, `"${n}" (fold ${R.fold(n)}) was accepted`);
});
test("C1-3: ordinary names stay allowed", () => {
  for (const n of ["Blocknode", "Armana", "Clover"]) assert.equal(R.checkName(n), null, n);
});

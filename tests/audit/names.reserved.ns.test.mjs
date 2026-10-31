// tests/audit/names.reserved.ns.test.mjs — not run here (static review)
import { test } from "node:test"; import assert from "node:assert/strict";
import path from "node:path"; import { fileURLToPath } from "node:url";
await import(path.join(fileURLToPath(new URL("../..", import.meta.url)), "names.js"));
const R = globalThis.KNames.rules;
test("N-S-2: Knode/Koinos lookalikes are reserved", () => {
  for (const n of ["K.node Swap", "K-node pool", "Kno de Swap", "Knocle Games", "Koinos Group", "Koinos Support"]) assert.notEqual(R.checkName(n), null, n);
  for (const n of ["k-node-pool", "koinos-group"]) assert.equal(R.okNick(n), false, n);
});

// ---- continued ----
test("N-S-3: address-like names are refused", () => {
  for (const n of ["1Mpmf2...uT1sr", "1Mpmf2ERhjYpX7CCiM11WERu", "1FKTpX...RmR"]) assert.notEqual(R.checkName(n), null, n);
});

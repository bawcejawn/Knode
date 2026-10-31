import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
await import(path.join(ROOT, "names.js"));
const R = globalThis.KNames.rules;
test("N-W-2: names and nicknames that look like a Koinos address are refused", () => {
  for (const n of ["1Mpmf2...T1sr", "1Mpmf2 T1sr", "Pool 1Mpmf2...T1sr", "1Mpmf2ERhjYpX7CCiM11WE"]) assert.notEqual(R.checkName(n), null, n);
  assert.equal(R.okNick("1mpmf2...t1sr"), false);
  assert.equal(R.checkName("1st Place"), null, "ordinary names still pass");
});

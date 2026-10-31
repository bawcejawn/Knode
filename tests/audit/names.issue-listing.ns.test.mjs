// tests/audit/names.issue-listing.ns.test.mjs — not run here (static review)
import { test } from "node:test"; import assert from "node:assert/strict";
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
test("N-S-7: claim issues are found beyond the first 100 open issues", () => {
  const y = fs.readFileSync(path.join(ROOT, ".github/workflows/names.yml"), "utf8");
  assert.match(y, /--paginate|labels=knode-name|search\/issues/);
});


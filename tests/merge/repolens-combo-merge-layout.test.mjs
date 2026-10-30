// C-W-1 failing test - NOT RUN HERE (static review). Run in a checkout of the merged branch (combo merged into picks):
//   APP=<merged checkout> node --experimental-strip-types --test cw1-merge-layout.test.mjs
// It exercises the real files: every script the Combo page loads must exist next to the page, and the recorder module
// must import (its top-level awaits load race-math, blockx-math and combo-math).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const APP = path.resolve(process.env.APP || ".");
const page = ["combo.html", "site/combo.html"].map((p) => path.join(APP, p)).find((p) => fs.existsSync(p));
test("C-W-1: every local <script src> of the Combo page exists beside it", () => {
  assert.ok(page, "combo.html not found");
  const html = fs.readFileSync(page, "utf8");
  const local = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]).filter((s) => !/^https?:/.test(s));
  const missing = local.filter((s) => !fs.existsSync(path.join(path.dirname(page), s)));
  assert.deepEqual(missing, [], `the page at ${path.relative(APP, page)} loads missing scripts`);
});
test("C-W-1: the Combo recorder module loads (its race-math / blockx-math / combo-math imports resolve)", async () => {
  await assert.doesNotReject(import(pathToFileURL(path.join(APP, "bot/games/combo.ts")).href));
});
test("C-W-1: one copy of each shared math file (no stale site/ duplicate of a root file)", () => {
  for (const f of ["blockx-math.js", "race-math.js", "blockx.html", "blockx.js"])
    assert.ok(!(fs.existsSync(path.join(APP, f)) && fs.existsSync(path.join(APP, "site", f))), `${f} exists both at the root and in site/`);
});

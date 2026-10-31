import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (f) => fs.readFileSync(ROOT + f, "utf8");
const READS = new Set(["balance_of", "get_player", "verify_valid_name", "get_main_token"]);

// The audit's first test here ("names-page.js makes no contract write") was removed on purpose, as its README says:
// the page mints a Koinos @name by design (owner, 2026-10-30). tests/audit/names.test.mjs pins exactly that one mint.
test("N-W-1: no 'no transaction' claim for names.html while the page can mint", () => {
  const mints = /\.functions\.mint\(/.test(read("names-page.js"));
  const seo = read("tools/site-seo.mjs").match(/file: "names\.html"[^}]*/)[0];
  if (mints) {
    assert.doesNotMatch(seo, /no transaction/i, "SEO description of names.html");
    assert.doesNotMatch(read(".github/ISSUE_TEMPLATE/producer-name.yml"), /no transaction/i);
    assert.match(read("docs/NAMES.md"), /mint/i, "NAMES.md documents the @name mint");
  }
});


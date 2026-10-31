// F6-S2 failing tests @ d4c32de. NOT RUN HERE (static review).
// Place in tests/audit/ and run from the repo root with node --test --import tsx (as tests/audit/sponsor.tool.test.ts).
// Each test should FAIL on d4c32de and pass once fixed.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// F6-S2-1 (Medium): enable must keep the caps exactly as on chain, including a free pool the owner set to 0.
// koilib deserializes with defaults: true, so an on-chain max_mana_free_day of 0 reads "0"; capsOf turns it into the
// 2,000 default, and enable then signs 2,000 Mana a day of free play the owner had switched off.
test("F6-S2-1a: capsOf keeps a free pool of 0 (and never loosens an on-chain cap)", async () => {
  const { capsOf } = await import("../../bot/sponsor.ts");
  const c = capsOf({ max_mana_per_tx: "100000000", max_mana_per_account_day: "500000000", max_mana_per_account_week: "2000000000",
    max_mana_per_day: "100000000000", max_mana_free_day: "0", min_vhp: "100000000" });
  assert.equal(c.freePerDay, "0", "a free pool switched off (0) must stay 0 on enable");
});

// F6-S2-1 (Medium), second route: the disable fallback (second node down, lagging or lying) writes DEFAULT_CAPS, and
// enable keeps "the caps on chain", so caps the owner lowered after a drain come back at 25/150/5,000/2,000.
// The fallback should keep the tighter of each cap (primary node's value vs the owner's default): a lying node can then
// only make caps tighter, never looser.
test("F6-S2-1b: the disable fallback does not raise lowered caps back to DEFAULT_CAPS", () => {
  const src = fs.readFileSync("bot/sponsor.ts", "utf8");
  const body = src.slice(src.indexOf("async function setSwitch("), src.indexOf("/** Copies the per-action limits") > 0 ? src.indexOf("/** Copies the per-action limits") : undefined);
  assert.ok(!/buildConfig\(game, desk, DEFAULT_CAPS, false/.test(body), "the fallback signs the default caps, not the tighter of chain and default");
});

// F6-S2-2 (Low): the emergency stop must not depend on the per-action rows fitting the DEFAULT per-tx cap (or on
// anything else that can throw): while switched off nothing is paid, and enable rebuilds the rows from the files.
test("F6-S2-2: the disable fallback leaves out the per-action rows (no checkRows against DEFAULT_CAPS.perTx)", () => {
  const src = fs.readFileSync("bot/sponsor.ts", "utf8");
  const body = src.slice(src.indexOf("async function setSwitch("));
  const fb = body.slice(0, body.indexOf("const fromSat"));
  assert.ok(!/readLimits\(\)\.rows/.test(fb), "the fallback passes the file's rows into buildConfig, which throws if a row is above 1 Mana");
});

// SP-13 (partly, Low): the documented v2 rollback runs a plain `config --send`; v2 (fa4659e6, d825d06:Sponsor.ts:268)
// refuses a daily cap above 1,000 Mana, and the default is 5,000, so the rollback's config step always reverts.
test("SP-13: the rollback step names caps v2 accepts (per day <= 1,000)", () => {
  const doc = fs.readFileSync("docs/blockx/MAINNET-LAUNCH.md", "utf8");
  const rb = doc.slice(doc.indexOf("**Rollback (audit SP-13)"), doc.indexOf("## 5."));
  assert.match(rb, /--per-day\s+(1000|[1-9]\d{0,2})\b/, "the rollback config must pass --per-day 1000 (or less) and a free pool within it");
});

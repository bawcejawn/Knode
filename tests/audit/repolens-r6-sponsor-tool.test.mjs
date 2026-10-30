// G-S round-6 failing tests @ b0abc79. NOT RUN HERE (static review). Place in tests/audit/, run with node --import tsx --test.
// All findings here are class (d); these tests pin the cheap fixes.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// G-S-1: in the v2 rollback window (v2 code, v3-era stored config with 5,000/day), both disable paths send a daily cap
// v2 refuses (CAP_LIMIT 1,000), so the stop reverts. Runbook fix: switch off while v3 is still on chain, then upload v2.
test("G-S-1a: the rollback switches the sponsor off before uploading v2", () => {
  const doc = fs.readFileSync("docs/blockx/MAINNET-LAUNCH.md", "utf8");
  const rb = doc.slice(doc.indexOf("**Rollback (audit SP-13)"), doc.indexOf("**Emergency stop (audit SP-44)"));
  const off = rb.indexOf("disable --send"), up = rb.indexOf("upload --send");
  assert.ok(off >= 0 && off < up, "disable --send must come before upload --send in the rollback");
});
// Tool fix (proposed signature): tighterCaps takes the code on chain and clamps to v2's limits when it is v2.
test("G-S-1b: the disable fallback fits v2's limits when the code on chain is v2", async () => {
  const { tighterCaps, SPONSOR_SHA256 } = await import("../../bot/sponsor.ts");
  const v3era = { max_mana_per_tx: "100000000", max_mana_per_account_day: "2500000000", max_mana_per_account_week: "15000000000",
    max_mana_per_day: "500000000000", max_mana_free_day: "200000000000", min_vhp: "100000000" };
  const { caps } = tighterCaps(v3era, null, SPONSOR_SHA256);
  assert.ok(Number(caps.perDay) <= 1000, `v2 refuses a daily cap above 1,000 (got ${caps.perDay})`);
});

// G-S-2: the 1.25x check of mana-limit --limit is fed an unsponsored number (0.0916), but a sponsored pick costs about
// 0.053-0.068 Mana more (TESTNET-RESULTS: 0.0477 unsponsored vs 0.101-0.116 sponsored). The runbook's measured figure
// should be a SPONSORED 10-leg card.
test("G-S-2: launch step 6 feeds mana-limit a sponsored measurement (>= the sponsored single pick 0.101)", () => {
  const doc = fs.readFileSync("docs/blockx/MAINNET-LAUNCH.md", "utf8");
  const m = /mana-limit picks:pick (\d+(?:\.\d+)?)/.exec(doc);
  assert.ok(m && Number(m[1]) >= 0.101, `the measured figure ${m && m[1]} is below what a sponsored single pick uses`);
});

// G-S-3: --limit is checked against the typed number, not the row's merged observed maximum.
test("G-S-3: mana-limit --limit is checked against the row's observed maximum (source)", () => {
  const s = fs.readFileSync("bot/sponsor.ts", "utf8");
  const body = s.slice(s.indexOf("async function manaLimit("), s.indexOf("/** The per-transaction cap the sponsor has on chain now"));
  assert.match(body, /r\.observed!?\.max/, "the --limit check must use r.observed.max (or run checkRows after the override)");
  assert.ok(/checkRows\(rows, perTx\)/.test(body.slice(body.indexOf("if (exact)"))), "checkRows must run after the --limit override");
});

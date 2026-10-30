// Round 5 behaviour tests for the sponsor tool (bot/sponsor.ts), written with the fixes (owner's record, "Round 5").
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { capsOf, tighterCaps, siteProblems, DEFAULT_CAPS, buildConfig } from "../../bot/sponsor.ts";

const sat = (m: number | string) => String(BigInt(Math.round(Number(m) * 1e8)));
const chain = (c: Partial<Record<string, number>>) => ({
  max_mana_per_tx: sat(c.tx ?? 1), max_mana_per_account_day: sat(c.day ?? 25), max_mana_per_account_week: sat(c.week ?? 150),
  max_mana_per_day: sat(c.all ?? 5000), max_mana_free_day: sat(c.free ?? 2000), min_vhp: sat(c.min ?? 1),
});

test("SP-44: capsOf keeps every on-chain cap exactly, 0 included; only a missing field takes the default", () => {
  assert.deepEqual(capsOf(chain({ tx: 0.5, day: 10, week: 40, all: 800, free: 0, min: 3 })), { perTx: "0.5", perPlayerDay: "10", perPlayerWeek: "40", perDay: "800", minVhp: "3", freePerDay: "0" });
  assert.equal(capsOf({}).freePerDay, DEFAULT_CAPS.freePerDay);
});

test("SP-44: the disable fallback never loosens a cap (lower of chain and default; higher minimum stake)", () => {
  const { caps, unreadable } = tighterCaps(chain({ tx: 0.5, day: 10, week: 40, all: 800, free: 0, min: 3 }));
  assert.equal(unreadable, false);
  assert.deepEqual(caps, { perTx: "0.5", perPlayerDay: "10", perPlayerWeek: "40", perDay: "800", minVhp: "3", freePerDay: "0" });
  // Caps above the defaults (or a node lying high) come down to the defaults; a minimum below the default goes up.
  assert.deepEqual(tighterCaps(chain({ tx: 3, day: 100, week: 700, all: 5000, free: 5000, min: 0.5 })).caps, DEFAULT_CAPS);
  // Out of order (a lying node): only lowered further, so buildConfig still accepts it, switched off.
  const odd = tighterCaps(chain({ tx: 1, day: 25, week: 5, all: 3, free: 2000 })).caps;
  assert.deepEqual(odd, { perTx: "1", perPlayerDay: "3", perPlayerWeek: "5", perDay: "3", minVhp: "1", freePerDay: "3" });
  buildConfig({ contract: "1A", koin: "1K", vhp: "1V" }, { contract: "1D" }, odd, false);
  // Unreadable: every cap 0 (nothing is paid while off; config with your caps before enable).
  const bad = tighterCaps({ max_mana_per_tx: "abc" });
  assert.equal(bad.unreadable, true);
  assert.equal(bad.caps.perDay, "0");
  buildConfig({ contract: "1A", koin: "1K", vhp: "1V" }, { contract: "1D" }, bad.caps, false);
});

test("SP-44: disable sends the rebuilt settings only with --rebuilt (the path previewed is the path signed)", () => {
  const s = fs.readFileSync("bot/sponsor.ts", "utf8");
  const body = s.slice(s.indexOf("async function setSwitch("), s.indexOf("/** Copies the per-action limits"));
  assert.match(body, /if \(!agreed && !rebuiltOk\) throw new Error\("Not sent/);
  assert.ok(body.indexOf("if (!agreed && !rebuiltOk)") < body.indexOf("chain.send("), "the refusal comes before the send");
  assert.match(s, /setSwitch\(rpc, provider, s, A, cur, false, send, mainnet, a\.includes\("--rebuilt"\)\)/);
  const admin = fs.readFileSync("admin/actions.ts", "utf8");
  assert.match(admin, /args: \["disable", "--rebuilt"\]/, "the admin page has the rebuilt stop as its own card");
  assert.ok(!/only the switch changes\)\.",/.test(admin), "enable no longer says only the switch changes");
});

test("SP-50: the swap-page check applies only once v3 is the code on chain", () => {
  const site = { game: {}, desk: { payer: "sponsor" } };
  assert.ok(siteProblems(site, [], 100000000n, true).some((x) => /Knode Swap still asks/.test(x)));
  assert.ok(!siteProblems(site, [], 100000000n, false).some((x) => /Knode Swap still asks/.test(x)));
});

test("SP-48 / SP-49: the code is read on both nodes for config; status warns when v6 is live but the switch is off", () => {
  const s = fs.readFileSync("bot/sponsor.ts", "utf8");
  const sc = s.slice(s.indexOf("async function setConfig("), s.indexOf("/** The caps as they are on chain"));
  assert.match(sc, /await codeOn\(rpc, provider, A, mainnet\)/);
  assert.match(s.slice(s.indexOf("async function codeOn("), s.indexOf("/** Audit SP-37: is the game")), /secondNode\(\)/);
  assert.match(s.slice(s.indexOf("async function status()"), s.indexOf("export function usageAlerts")), /the game is Vault v6 now, but the sponsor still treats it as v5/);
});

// tests/audit/names.eligibility.ns.test.mjs — not run here (static review)
import { test } from "node:test"; import assert from "node:assert/strict";
import path from "node:path"; import { fileURLToPath } from "node:url";
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
await import(path.join(ROOT, "names.js"));
const N = await import(path.join(ROOT, "bot/names.ts"));
test("N-S-4: one lying node cannot make a wallet eligible", async () => {
  const mk = (v) => ({ vhp: async () => v, stake: async () => 0n, players: async () => [], nickname: async () => null });
  assert.equal(await N.eligibility(new Set(), [mk(100000000n), mk(0n)])("1" + "A".repeat(33)), false);
});

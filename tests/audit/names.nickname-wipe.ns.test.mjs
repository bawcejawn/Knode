// tests/audit/names.nickname-wipe.ns.test.mjs — not run here (static review)
import { test } from "node:test"; import assert from "node:assert/strict";
import path from "node:path"; import { fileURLToPath } from "node:url";
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
await import(path.join(ROOT, "names.js"));
const N = await import(path.join(ROOT, "bot/names.ts"));
test("N-S-1: a failing node keeps the previous nickname", async () => {
  const P = "1" + "P".repeat(33);
  const prev = { v: 1, updated: "", names: {}, hidden: {}, nicknames: { [P]: "armana" } };
  const good = { vhp: async () => 0n, stake: async () => 0n, players: async () => [], nickname: async () => "armana" };
  const down = { ...good, nickname: async () => { throw new Error("down"); } };
  const next = N.withNicknames(prev, await N.nicknames(new Set([P]), [good, down]), Date.now());
  assert.equal((next ?? prev).nicknames[P], "armana");
});

test("N-S-8: a nickname that folds to another wallet's name is not shown", () => {
  const X = "1" + "X".repeat(33), Y = "1" + "Y".repeat(33);
  const db = { v: 1, updated: "", hidden: {}, nicknames: {}, names: { [X]: { name: "Armana", date: "2026-10-30", signature: "H" + "a".repeat(86) + "=" } } };
  const next = N.withNicknames(db, { [Y]: "arrnana" }, Date.now());
  assert.ok(!next || !next.nicknames[Y]);
});

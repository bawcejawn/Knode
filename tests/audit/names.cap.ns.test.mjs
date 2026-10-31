// tests/audit/names.cap.ns.test.mjs — not run here (static review)
import { test } from "node:test"; import assert from "node:assert/strict";
import path from "node:path"; import { fileURLToPath } from "node:url";
import { Signer, utils } from "koilib";
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
await import(path.join(ROOT, "names.js"));
const R = globalThis.KNames.rules, N = await import(path.join(ROOT, "bot/names.ts"));
test("N-S-5: the checker never produces a names.json the publish job refuses", async () => {
  const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const names = {};
  for (let i = 0; i < 4900; i++) names["1" + B58[(i / 3364 | 0) % 58] + B58[(i / 58 | 0) % 58] + B58[i % 58] + "x".repeat(30)] = { name: ("N" + i).padEnd(24, "x"), date: "2026-10-30", signature: "H" + "a".repeat(86) + "=" };
  const prev = { v: 1, updated: "", names, hidden: {}, nicknames: {} };
  const s = Signer.fromSeed("ns cap"), now = Date.parse("2026-10-30T12:00:00Z"), d = "2026-10-30";
  const text = R.claimText("Cap Test", s.getAddress(), d, utils.encodeBase64url(await s.signMessage(R.message("Cap Test", s.getAddress(), d))));
  const r = await N.verifyIssues(prev, [{ number: 1, body: text }], now, () => true);
  assert.ok(!r.db || Buffer.byteLength(N.serialize(r.db)) <= 1048576);
});

// ---- continued ----
test("N-S-6: 3,000 nickname lookups finish well inside the job budget", async () => {
  const slow = { vhp: async () => 0n, stake: async () => 0n, players: async () => [], nickname: () => new Promise((r) => setTimeout(() => r(null), 5)) };
  const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const set = new Set(Array.from({ length: 3000 }, (_, i) => "1" + B58[(i / 3364 | 0) % 58] + B58[(i / 58 | 0) % 58] + B58[i % 58] + "x".repeat(30)));
  const t = Date.now(); await N.nicknames(set, [slow, slow]);
  assert.ok(Date.now() - t < 5000, "sequential: ~30 s at 5 ms/call");   // fails today
});

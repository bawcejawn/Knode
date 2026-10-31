// tests/audit/names.refresh-time.N-C-5.test.mjs   (node --import tsx --test)
import { test } from "node:test"; import assert from "node:assert/strict"; import { fileURLToPath } from "node:url";
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const N = await import(new URL("bot/names.ts", `file://${ROOT}`).href);
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const addr = (i) => "1" + Array.from({ length: 30 }, (_, k) => B58[(i * 7 + k * 13) % 58]).join("") + B58[i % 58] + B58[Math.floor(i / 58) % 58];
test("N-C-5: 300 wallets × 2 nodes at 50 ms per call finish in under 5 s (not serial 30 s)", { timeout: 60000 }, async () => {
  const slow = { vhp: async () => 0n, stake: async () => 0n, players: async () => [], nickname: () => new Promise((r) => setTimeout(() => r("abc"), 50)) };
  const set = new Set(Array.from({ length: 300 }, (_, i) => addr(i)));
  const t0 = Date.now(); await N.nicknames(set, [slow, slow]);
  assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms: serial lookups can't fit 3,000 wallets in the 10-min job`);
});

// tests/audit/names.rpc-hang.N-C-4.test.mjs   (node --import tsx --test)
import { test } from "node:test"; import assert from "node:assert/strict"; import net from "node:net"; import { fileURLToPath } from "node:url";
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const N = await import(new URL("bot/names.ts", `file://${ROOT}`).href);
test("N-C-4: a node that never answers falls back to the next one within 30 s", { timeout: 40000 }, async () => {
  const srv = net.createServer(() => { /* accept, never reply */ }).listen(0);
  const port = srv.address().port;
  const ok = { vhp: async () => 10n ** 8n, stake: async () => 0n, players: async () => [], nickname: async () => null };
  try {
    const t0 = Date.now();
    const r = await N.eligibility(new Set(), [N.chainAt(`http://127.0.0.1:${port}`), ok])("1AbcdefghijkmnopqrstuvwxyzABC");
    assert.equal(r, true); assert.ok(Date.now() - t0 < 30000);
  } finally { srv.close(); }
});

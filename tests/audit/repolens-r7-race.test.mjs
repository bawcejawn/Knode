// H-A round 7 (Low, H-A-1). NOT RUN HERE (static review). Place in tests/audit/, run like repolens-r5-behaviour.test.mjs.
// Drives the REAL R.sample: both nodes honest and in sync, but the 1,200-block read takes ~20 s of chain time; the
// BX-101 check compares the check node's head (read AFTER readBlocks) with the primary's head read BEFORE it.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
const APP = process.env.APP || ".";
const R = await import(path.resolve(APP, "bot/race.ts"));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "rl-r7ha-"));
test("H-A-1: an in-sync check node is not 'ahead' just because the block read was slow", async () => {
  const T0 = Date.now() - 60000; let t = T0;   // chain time advances 4 s per block_store call (6 calls => ~24 s)
  const node = () => ({ getHeadInfo: async () => { const h = 1_000_000 + Math.floor((t - T0) / 3000); return { head_topology: { height: String(h), id: "h" }, head_block_time: String(T0 + (h - 1_000_000) * 3000), last_irreversible_block: String(h - 60) }; },
    call: async (_m, q) => { t += 4000; return { block_items: Array.from({ length: q.num_blocks }, (_, i) => ({ block_height: String(Number(q.ancestor_start_height) + i), block: { header: { signer: "1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", timestamp: String(T0) } } })) }; } });
  const r = await R.sample({ p: node(), check: node(), prev: tmp(), out: tmp(), spreadMs: 0, wait: async () => {}, clock: () => Date.now(), vhpOf: async (w) => Object.fromEntries(w.map((x) => [x, "100000000000"])) });
  assert.ok(!r.problems.some((x) => /no sample this time/.test(x)), r.problems.join("; "));
});

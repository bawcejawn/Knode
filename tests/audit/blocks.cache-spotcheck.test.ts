// Proof test (audit fix check, AB-032): the cached block history must not keep edited rows the spot check skips, and
// must not be returned with holes. Offline: the chain is a fake provider.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncBlocks } from "../../common.ts";

const LIB = 1_000_000, DAYS = 1, FROM = LIB - 28_800 * DAYS + 1;
const sig = (h: number) => `1Producer${h % 7}`;
const chainRow = (h: number) => ({ h, ts: h * 3000, signer: sig(h), ntx: h % 3, compute: 0 });

function fakeProvider() {
  return {
    async getHeadInfo() { return { last_irreversible_block: String(LIB), head_topology: { id: "0xhead", height: String(LIB + 20) } }; },
    async call(method: string, args: any) {
      assert.equal(method, "block_store.get_blocks_by_height");
      const start = Number(args.ancestor_start_height), n = Number(args.num_blocks);
      const items = [];
      for (let h = start; h < start + n && h <= LIB; h++) {
        const r = chainRow(h);
        items.push({ block_height: String(h), block: { header: { height: String(h), timestamp: String(r.ts), signer: r.signer }, transactions: new Array(r.ntx).fill({}) }, receipt: { compute_bandwidth_used: "0" } });
      }
      return { block_items: items };
    },
  } as any;
}
function writeCache(file: string, rows: Array<ReturnType<typeof chainRow>>) {
  fs.writeFileSync(file, rows.map((b) => `${b.h},${b.ts},${b.signer},${b.ntx},${b.compute}`).join("\n"));
}
async function withRandom<T>(v: number, fn: () => Promise<T>): Promise<T> {
  const orig = Math.random;
  Math.random = () => v;
  try { return await fn(); } finally { Math.random = orig; }
}

test("SAB-CACHE-1: tampered cached rows between the spot-check runs are not returned as chain data", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sab-cache-"));
  const file = path.join(dir, "blocks.csv");
  const rows = Array.from({ length: LIB - FROM + 1 }, (_, i) => chainRow(FROM + i));
  for (const i of [600, 601, 602, 5000, 20000]) rows[i] = { ...rows[i], signer: "1AttackerChoseThisSigner" };
  writeCache(file, rows);
  const { blocks } = await withRandom(0, () => syncBlocks(fakeProvider(), file, DAYS));
  const bad = blocks.filter((b) => b.signer !== sig(b.h));
  assert.equal(bad.length, 0, `SAB-CACHE-1: ${bad.length} tampered row(s) passed the cache spot check (e.g. height ${bad[0]?.h} signer ${bad[0]?.signer})`);
});

test("SAB-CACHE-2: a hole in the cached rows is filled (or the cache dropped), never returned with a gap", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sab-cache-"));
  const file = path.join(dir, "blocks.csv");
  const rows = Array.from({ length: LIB - FROM + 1 }, (_, i) => chainRow(FROM + i));
  rows.splice(600, 1);                                   // height FROM+600 missing
  writeCache(file, rows);
  const { blocks } = await withRandom(0, () => syncBlocks(fakeProvider(), file, DAYS));
  const gaps: number[] = [];
  for (let i = 1; i < blocks.length; i++) if (blocks[i].h !== blocks[i - 1].h + 1) gaps.push(blocks[i - 1].h + 1);
  assert.deepEqual(gaps, [], `SAB-CACHE-2: syncBlocks returned history with missing height(s) ${gaps.join(", ")}`);
  assert.equal(blocks.length, LIB - FROM + 1, "SAB-CACHE-2: every height from..lib is present");
});

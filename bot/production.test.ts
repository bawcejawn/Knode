import assert from "node:assert/strict";
import { test } from "node:test";
import { formatProduction, loadSigners, productionOf, scanRange, signerFromBlockItem, type SignedBlock } from "./production.ts";

const GAME = "game-address";
const DESK = "desk-address";

function block(h: number, signer: string, ts = h * 3000): SignedBlock {
  return { h, ts, signer };
}

test("the window is the last N irreversible blocks and never starts below 1", () => {
  assert.deepEqual(scanRange(10_000, 100), { from: 9901, to: 10_000 });
  assert.deepEqual(scanRange(50, 100), { from: 1, to: 50 });
  assert.throws(() => scanRange(0, 10));
});

test("the latest signer is the highest height, counted separately for the game and the desk", () => {
  const blocks = [
    block(10, "someone"),
    block(11, GAME),
    block(12, DESK),
    block(13, GAME),
    block(14, "someone"),
    block(20, DESK),
  ];
  assert.deepEqual(productionOf(blocks, GAME), { last: block(13, GAME), count: 2 });
  assert.deepEqual(productionOf(blocks, DESK), { last: block(20, DESK), count: 2 });
  assert.deepEqual(productionOf(blocks, "missing"), { last: null, count: 0 });
});

test("a saved height is not an input: age comes from the block timestamp", () => {
  const blocks = [block(100, "other", 1_000_000), block(500, GAME, 1_700_000_000_000)];
  const now = 1_700_000_000_000 + 30 * 60_000;
  const line = formatProduction("Pool production (live)", GAME, blocks, 100, 500, now);
  assert.match(line, /last block 500/);
  assert.match(line, /30 min ago/);
  assert.match(line, /1 of the last 401 blocks/);
  assert.doesNotMatch(line, /bot-state|lastProduced|40278691/);
  const quiet = formatProduction("Desk production (live)", DESK, blocks, 100, 500, now);
  assert.match(quiet, /no block signed by desk-address/);
  assert.match(quiet, /heights 100–500/);
});

test("a block item is reduced to height, time and signer", () => {
  assert.deepEqual(signerFromBlockItem({
    block_height: "40327063",
    block: { header: { height: "40327063", timestamp: "1792368000000", signer: GAME } },
  }), { h: 40327063, ts: 1792368000000, signer: GAME });
});

test("the loader asks for every height in the window exactly once", async () => {
  const seen: Array<[number, number]> = [];
  const { blocks, from, to } = await loadSigners(async (a, b) => {
    seen.push([a, b]);
    const out: SignedBlock[] = [];
    for (let h = a; h <= b; h++) out.push(block(h, h === 80 ? GAME : h === 90 ? DESK : "other", h * 1000));
    return out;
  }, 100, 40, 15);
  assert.equal(from, 61);
  assert.equal(to, 100);
  const heights = blocks.map((b) => b.h).sort((a, b) => a - b);
  assert.deepEqual(heights, Array.from({ length: 40 }, (_, i) => 61 + i));
  const covered = new Set<number>();
  for (const [a, b] of seen) for (let h = a; h <= b; h++) {
    assert.equal(covered.has(h), false);
    covered.add(h);
  }
  assert.equal(covered.size, 40);
  assert.equal(productionOf(blocks, GAME).last?.h, 80);
  assert.equal(productionOf(blocks, DESK).last?.h, 90);
});

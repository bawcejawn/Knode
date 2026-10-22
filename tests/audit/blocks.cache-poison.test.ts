// Red team (web attacker / CI) for Knode @ 6b37c46.
// Attack: poison the GitHub Actions cache that bot.yml restores with `restore-keys: blocks-`
// (.github/workflows/bot.yml:37-41). The bot then calls syncBlocks (common.ts:94) which only
// downloads heights that are MISSING from game-data/blocks.csv; rows already in the file are
// trusted as-is. resolve (bot/bot.ts:325-367) scores questions from that file and posts the
// outcome on chain with the OPERATOR key.
// Precondition (strong): the attacker must be able to write a cache entry in main's scope, e.g.
// code running in a workflow on main (a compromised npm dependency in test.yml / desk-test.yml /
// bot.yml, cache token pulled from the runner). Fork PR caches are scoped to the PR ref and
// cannot be restored by the scheduled bot (that path is blocked by GitHub).
// Asserts the SAFE behaviour (cached rows inside a question window are re-checked against the
// chain, or the forged history is not what gets scored): FAILS today = proof.
// Offline: the provider is an in-memory fake.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncBlocks, writeCsv, type Blk } from "../../common.ts";
import { scoreQuestion } from "../../resolver.ts";

const A = "14f34kUNZugf2DK4hPJGy4AkmBM7Y4pvVu";
const B = "1G2QjRtNwEfqGwX7SMD8LNjWgJdWA7XtSU";
const OTHER = "1OtherProducerXXXXXXXXXXXXXXXXXXX";
const WS = 1_000_000, WE = WS + 9_999, LIB = WE + 100;

// The honest chain: A and B sign about equally -> difference small -> "No" (option 0) at line 298.
const honestSigner = (h: number) => (h % 10 === 0 ? A : h % 10 === 1 ? B : OTHER);
const honest = (h: number): Blk => ({ h, ts: 1_700_000_000_000 + h * 3000, signer: honestSigner(h), ntx: 1, compute: 0 });

function fakeProvider() {
  const asked: number[] = [];
  return {
    asked,
    async getHeadInfo() { return { last_irreversible_block: String(LIB), head_topology: { id: "0xhead", height: String(LIB + 60) } }; },
    async call(_m: string, p: any) {
      const s = Number(p.ancestor_start_height), n = Number(p.num_blocks);
      const block_items = [];
      for (let h = s; h < s + n && h <= LIB; h++) {
        asked.push(h);
        const b = honest(h);
        block_items.push({ block_height: String(h), block: { header: { signer: b.signer, timestamp: String(b.ts) }, transactions: [{}] }, receipt: {} });
      }
      return { block_items };
    },
  };
}

const q = {
  id: "W000-D1-1", template: "E2s", subjects: [A, B], unit: "count", windowStart: WS, windowEnd: WE, thresholds: [298],
  options: [{ index: 0 }, { index: 1 }], model: { rates: { [A]: 0.1, [B]: 0.1 } },
};

test("(context) the honest chain resolves the head-to-head as option 0 (No)", () => {
  const blocks: Blk[] = []; for (let h = WS; h <= WE; h++) blocks.push(honest(h));
  const r = scoreQuestion(q as any, blocks);
  assert.ok(r.ok); assert.equal((r as any).result.option, 0);
});

test("cache poisoning: forged blocks.csv rows in a question window must not survive syncBlocks", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rt-web-cache-"));
  const file = path.join(dir, "blocks.csv");
  // What a poisoned cache entry contains: the last day up to LIB, with A signing far more than B in the window.
  const forged: Blk[] = [];
  for (let h = LIB - 28_800 + 1; h <= LIB; h++) {
    const b = honest(h);
    if (h >= WS && h <= WE) b.signer = h % 10 < 2 ? A : h % 10 === 2 ? B : OTHER; // A ~2000, B ~1000 -> diff ~1000
    forged.push(b);
  }
  writeCsv(file, forged);
  const prov = fakeProvider();
  const { blocks } = await syncBlocks(prov as any, file, 1);
  const r = scoreQuestion(q as any, blocks);
  assert.ok(r.ok, "scored");
  const reCheckedWindow = prov.asked.some((h) => h >= WS && h <= WE);
  // SAFE: either the window was re-read from the chain, or the answer is the honest one.
  assert.ok(reCheckedWindow || (r as any).result.option === 0,
    `forged cache decided the outcome: option ${(r as any).result.option} (value ${(r as any).result.value}); chain was asked for ${prov.asked.length} heights, none in the window`);
});

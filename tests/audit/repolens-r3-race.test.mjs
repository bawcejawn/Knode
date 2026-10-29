// Repo Lense round 3 (F4-A) failing tests for bot/race.ts and bot/games/blockx.ts @ 1c66ddc.
// NOT RUN HERE (static review). Place in tests/audit/ and run with the repo's node:test setup (tsx loader, like
// tests/audit/race-recorder.test.mjs). Each test should FAIL on 1c66ddc and pass once the finding is fixed.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const R = await import("../../bot/race.ts");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "rl-r3-"));
const A = "1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".slice(0, 34), B = "1BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB".slice(0, 34), T = "1TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT".slice(0, 34);
const sat = (v) => String(BigInt(v) * 100000000n);

// A fake node: head/lib/time chosen per test; blocks signed round-robin by T, A, B with 3 s spacing.
function node({ head, lib, time }) {
  return {
    getHeadInfo: async () => ({ head_topology: { height: String(head), id: "h" }, head_block_time: String(time), last_irreversible_block: String(lib) }),
    call: async (_m, q) => {
      const s = Number(q.ancestor_start_height), n = q.num_blocks;
      return { block_items: Array.from({ length: n }, (_, i) => ({ block_height: String(s + i), block: { header: { signer: [T, A, B][(s + i) % 3], timestamp: String(time - (head - s - i) * 3000) } } })) };
    },
  };
}

test("BX-54: a node whose irreversible block is far behind its head (or the other node's) gets no card", async () => {
  const now = Date.UTC(2026, 10, 2, 5, 40);
  const p = node({ head: 1_000_000, lib: 999_940, time: now });
  const check = node({ head: 1_000_000, lib: 960_000, time: now });   // claims lib ~33 h back
  const out = tmp();
  const r = await R.run({ p, check, prev: tmp(), out, vhpOf: async (w) => Object.fromEntries(w.map((x) => [x, x === "network" ? sat(1e8) : sat(1000)])), raceContract: null });
  const w = fs.readdirSync(out).filter((f) => /^W\d{3}\.json$/.test(f)).map((f) => JSON.parse(fs.readFileSync(path.join(out, f), "utf8")));
  const cards = w.flatMap((x) => x.races.flatMap((rc) => rc.cards)).filter(Boolean);
  assert.equal(cards.length, 0, "a card was made from a 6-hour window ending ~33 h ago");
  assert.ok(r.problems.some((x) => /irreversible|behind/.test(x)));
});

test("BX-35 (forward-dated card): the card time is bounded by this computer's clock, not the later of the two heads", async () => {
  const now = Date.now();
  const p = node({ head: 1_000_000, lib: 999_940, time: now });
  const check = node({ head: 1_000_000, lib: 999_940, time: now + 50 * 60000 });   // check node 50 min ahead
  const out = tmp();
  await R.run({ p, check, prev: tmp(), out, vhpOf: async (w) => Object.fromEntries(w.map((x) => [x, x === "network" ? sat(1e8) : sat(1000)])), raceContract: null });
  const cards = fs.readdirSync(out).filter((f) => /^W\d{3}\.json$/.test(f)).flatMap((f) => JSON.parse(fs.readFileSync(path.join(out, f), "utf8")).races.flatMap((rc) => rc.cards)).filter(Boolean);
  for (const c of cards) assert.ok(c.at <= now + 60000, `card dated ${Math.round((c.at - now) / 60000)} min in the future`);
});

test("BX-55: one node's inflated read of a producer is flagged on the card, not silently counted at the top", () => {
  const honest = { [T]: sat(3_000_000), [A]: sat(1_000_000), [B]: sat(900_000) };
  const liar = { ...honest, [A]: sat(9_000_000) };
  const { values, differ } = R.combineReads(honest, liar, [T, A, B]);
  assert.deepEqual(differ, [A]);
  // Wanted: a differing producer is not given the agreed top (which turns ×3 into ×1 for picks on it).
  assert.notEqual(values[A], honest[T], "one node moved A from x3 to x1");
});

test("BX-56: a check node a little behind (2 minutes) does not stop sampling", async () => {
  const now = Date.now();
  const p = node({ head: 1_000_000, lib: 999_940, time: now });
  const check = node({ head: 999_960, lib: 999_900, time: now - 120000 });
  const out = tmp();
  const r = await R.sample({ p, check, prev: tmp(), out, spreadMs: 0, clock: () => now, vhpOf: async (w) => Object.fromEntries(w.map((x) => [x, sat(1000)])) });
  const f = JSON.parse(fs.readFileSync(path.join(out, "vhp-samples.json"), "utf8"));
  assert.equal(f.samples.length, 1, "no sample: " + r.problems.join("; "));
});

test("BX-57: the VHP supply cap on samples is not lowered by one node", () => {
  const now = { [A]: sat(1_000_000) }, samples = [{ at: 1000, height: 1, vhp: { [A]: sat(3_000_000) } }];
  // race.ts:318 takes the LOWER supply of the two nodes; one node saying "1" would make every sample count as 1 unit.
  assert.equal(R.windowHigh(now, samples, 2000, 1n)[A], BigInt(sat(3_000_000)), "a supply of 1 from one node switches the samples off");
});

// BX-53 (flash VHP at block X) needs a new input: the VHP moves between the lock card and block X. Spec test:
test("BX-53: a VHP transfer into the picked producer between the lock card and block X never scores x3", async () => {
  const BX = await import("../../bot/games/blockx.ts");
  assert.equal(typeof BX.scoringVhpMoves, "function", "no check of VHP moved into a producer between its cards and block X (receipts of blocks lock-20..X)");
});

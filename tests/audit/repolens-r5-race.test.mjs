// Repo Lense round 5 (F6-A) failing tests for bot/games/blockx.ts and bot/race.ts @ d4c32de.
// NOT RUN HERE (static review). Place in tests/audit/ and run like tests/audit/repolens-r4-race.test.mjs (tsx loader).
// Each test should FAIL on d4c32de and pass once fixed. Byte strings are decoder test vectors, not transactions.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { utils, Signer } from "koilib";

const APP = process.env.APP || ".";
const BX = await import(path.resolve(APP, "bot/games/blockx.ts"));
const R = await import(path.resolve(APP, "bot/race.ts"));
const addr = (seed) => Signer.fromSeed(seed).getAddress();
const VHP = addr("r5-vhp"), A = addr("r5-a"), B = addr("r5-b");
const vint = (n) => { n = BigInt(n); const o = []; do { let b = Number(n & 0x7fn); n >>= 7n; if (n) b |= 0x80; o.push(b); } while (n); return o; };
const bytesF = (f, b) => [(f << 3) | 2, ...vint(b.length), ...b], numF = (f, v) => [(f << 3), ...vint(v)];
const raw = (a) => [...utils.decodeBase58(a)];
const receipt = (data, to, from) => ({ events: [], transaction_receipts: [{ events: [{ source: VHP, name: "token.transfer_event",
  data: Buffer.from(Uint8Array.from(data)).toString("base64"), impacted: [to, from] }] }] });
const BIG = 1_500_000n * 100_000_000n;
// What kcs4.transfer_arguments.decode (as-proto 1.0.1 FixedReader) moves for each vector is in the comment.
// Acceptable fixes: count exactly that value, OR refuse to guess (throw, so the target is held), never a different number.
const countsOrHolds = (d, to, from, who, moved) => {
  let got; try { got = BX.vhpInflows(receipt(d, to, from), VHP, who); } catch { return; }   // held: fine
  assert.equal(got, moved);
};
test("F6-A-1: `value` sent with wire type 2 (the contract reads the 'length' varint as the value: BIG moves)", () => {
  countsOrHolds([...bytesF(1, raw(B)), ...bytesF(2, raw(A)), (3 << 3) | 2, ...vint(BIG)], A, B, A, BIG);
});
test("F6-A-1: `value` sent with wire type 5 or 7 (the contract switches on the field number only: BIG moves)", () => {
  countsOrHolds([...bytesF(1, raw(B)), ...bytesF(2, raw(A)), (3 << 3) | 5, ...vint(BIG)], A, B, A, BIG);
  countsOrHolds([...bytesF(1, raw(B)), ...bytesF(2, raw(A)), (3 << 3) | 7, ...vint(BIG)], A, B, A, BIG);
});
test("F6-A-1: a tag or length varint with bits above 32 (as-proto varint32 drops them: BIG moves)", () => {
  countsOrHolds([...bytesF(1, raw(B)), ...bytesF(2, raw(A)), 0x98, 0x80, 0x80, 0x80, 0x10, ...vint(BIG)], A, B, A, BIG);
  countsOrHolds([...bytesF(1, raw(B)), (2 << 3) | 2, 0x99, 0x80, 0x80, 0x80, 0x10, ...raw(A), ...numF(3, BIG)], A, B, A, BIG);
});
test("F6-A-1: an unknown group field, or an unknown 11-byte varint, before the args (as-proto skips both: BIG moves)", () => {
  countsOrHolds([(15 << 3) | 3, (15 << 3) | 4, ...bytesF(1, raw(B)), ...bytesF(2, raw(A)), ...numF(3, BIG)], A, B, A, BIG);
  countsOrHolds([(15 << 3), ...Array(10).fill(0x80), 0x00, ...bytesF(1, raw(B)), ...bytesF(2, raw(A)), ...numF(3, BIG)], A, B, A, BIG);
});
test("F6-A-1: any wallet: `memo` sent with wire type 0 hides a second `value` (the contract moves 1e-8; must not count BIG)", () => {
  const inner = numF(3, BIG);
  countsOrHolds([...bytesF(1, raw(B)), ...bytesF(2, raw(A)), ...numF(3, 1), (4 << 3) | 0, ...vint(inner.length), ...inner], A, B, A, 1n);
});

test("F6-A-2: a sample never takes one node's higher read (a fake 'different block' must not lift a producer unflagged)", async () => {
  const sat = (v) => String(BigInt(v) * 100000000n);
  const P = addr("r5-p");
  // Fake nodes: the check node always reports a head one block off (as a lagging or lying node does).
  const mk = (head) => ({
    getHeadInfo: async () => ({ head_topology: { height: String(head), id: "h" }, head_block_time: String(Date.now()), last_irreversible_block: String(head - 60) }),
    call: async (_m, q) => { const s = Number(q.ancestor_start_height), n = q.num_blocks;
      return { block_items: Array.from({ length: n }, (_, i) => ({ block_height: String(s + i), block: { header: { signer: P, timestamp: String(Date.now() - (head - s - i) * 3000) } } })) }; },
  });
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "rl-r5-"));
  await R.sample({ p: mk(1_000_000), check: mk(1_000_001), prev: fs.mkdtempSync(path.join(os.tmpdir(), "rl-r5p-")), out, spreadMs: 0, wait: async () => {},
    vhpOf: async (w) => Object.fromEntries(w.map((x) => [x, sat(1_000_000)])), vhpCheckOf: async (w) => Object.fromEntries(w.map((x) => [x, sat(2_990_000)])) });
  const f = JSON.parse(fs.readFileSync(path.join(out, "vhp-samples.json"), "utf8"));
  const s = f.samples[f.samples.length - 1];
  assert.ok(!s || BigInt(s.vhp[P] ?? "0") <= BigInt(sat(1_000_000)) || Array.isArray(s.flagged),
    `sampled ${s && BigInt(s.vhp[P]) / 100000000n} VHP for P with no flag; the next card counts it (windowHigh) and Block X scores P's targets with it`);
});

test("F6-A-3: a sample where the nodes disagree (same block) records the dispute instead of silently keeping the lower read", async () => {
  const sat = (v) => String(BigInt(v) * 100000000n);
  const T = addr("r5-t");
  const mk = (head) => ({
    getHeadInfo: async () => ({ head_topology: { height: String(head), id: "h" }, head_block_time: String(Date.now()), last_irreversible_block: String(head - 60) }),
    call: async (_m, q) => { const s = Number(q.ancestor_start_height), n = q.num_blocks;
      return { block_items: Array.from({ length: n }, (_, i) => ({ block_height: String(s + i), block: { header: { signer: T, timestamp: String(Date.now() - (head - s - i) * 3000) } } })) }; },
  });
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "rl-r5-"));
  await R.sample({ p: mk(1_000_000), check: mk(1_000_000), prev: fs.mkdtempSync(path.join(os.tmpdir(), "rl-r5p-")), out, spreadMs: 0, wait: async () => {},
    vhpOf: async (w) => Object.fromEntries(w.map((x) => [x, sat(3_000_000)])), vhpCheckOf: async (w) => Object.fromEntries(w.map((x) => [x, "1"])) });
  const f = JSON.parse(fs.readFileSync(path.join(out, "vhp-samples.json"), "utf8"));
  const s = f.samples[f.samples.length - 1];
  // Wanted (any one): the sample lists T as disputed (the card then flags T and, if T's high would be the top, sets
  // topInDoubt), or the disputed producer is left out of that sample. Today T is stored at 1e-8 VHP with no trace, so a
  // lying node erases T's window high (rule 2) for a top that really moved VHP out, moving every multiplier unheld.
  assert.ok(!s || Array.isArray(s.flagged) && s.flagged.includes(T) || s.vhp[T] === undefined, "T sampled at " + (s && s.vhp[T]) + " with no flag");
});

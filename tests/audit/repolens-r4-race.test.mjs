// Repo Lense round 4 (F5-A) failing tests for bot/games/blockx.ts and bot/race.ts @ cc524eb.
// NOT RUN HERE (static review). Place in tests/audit/ and run with the repo's node:test setup (tsx loader, like
// tests/audit/repolens-r3-blockx-behaviour.test.mjs). Each test should FAIL on cc524eb and pass once fixed.
// The byte strings are decoder test vectors (what the VHP contract puts in an event's data), not transactions.
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
const VHP = addr("r4-vhp"), A = addr("r4-a"), B = addr("r4-b"), RIVAL = addr("r4-rival"), OWN2 = addr("r4-own2");
const vint = (n) => { n = BigInt(n); const o = []; do { let b = Number(n & 0x7fn); n >>= 7n; if (n) b |= 0x80; o.push(b); } while (n); return o; };
const bytesF = (f, b) => [(f << 3) | 2, b.length, ...b], numF = (f, v) => [(f << 3), ...vint(v)];
const raw = (a) => [...utils.decodeBase58(a)];
// The VHP contract (koinos-contracts-as contracts/vhp, Vhp.ts:253-257) emits System.getArguments().args as the
// event data, and decodes those args with as-proto (kcs4.transfer_arguments.decode: the LAST occurrence of a field
// wins; unknown fields are skipped). impacted = [decoded to, decoded from].
const receipt = (data, impactedTo, impactedFrom) => ({ events: [], transaction_receipts: [{ events: [{ source: VHP, name: "token.transfer_event",
  data: Buffer.from(Uint8Array.from(data)).toString("base64"), impacted: [impactedTo, impactedFrom] }] }] });
const BIG = 1_500_000n * 100_000_000n;

test("BX-72: a transfer to the signer is counted when its args repeat `to` (the contract uses the last one)", () => {
  const d = [...bytesF(1, raw(B)), ...bytesF(2, raw(B)), ...bytesF(2, raw(A)), ...numF(3, BIG)];
  assert.equal(BX.vhpInflows(receipt(d, A, B), VHP, A), BIG, "the VHP contract moved BIG to A; Block X saw nothing");
});
test("BX-72: a transfer to the signer is counted when its args start with an unknown fixed32 field", () => {
  const d = [(15 << 3) | 5, 0, 0, 0, 0, ...bytesF(1, raw(B)), ...bytesF(2, raw(A)), ...numF(3, BIG)];
  assert.equal(BX.vhpInflows(receipt(d, A, B), VHP, A), BIG);
});
test("BX-72: the counted value is the one the contract moved (last `value`), both ways", () => {
  const up = [...bytesF(1, raw(B)), ...bytesF(2, raw(A)), ...numF(3, 1), ...numF(3, BIG)];
  assert.equal(BX.vhpInflows(receipt(up, A, B), VHP, A), BIG, "BIG moved, 1e-8 counted");
  const down = [...bytesF(1, raw(B)), ...bytesF(2, raw(RIVAL)), ...numF(3, BIG), ...numF(3, 1)];
  assert.equal(BX.vhpInflows(receipt(down, RIVAL, B), VHP, RIVAL), 1n, "1e-8 moved, BIG counted: any wallet makes RIVAL x1");
});
test("BX-72: an inflow is never credited to an address the contract did not pay (impacted[0] is the real `to`)", () => {
  const d = [...bytesF(1, raw(B)), ...bytesF(2, raw(RIVAL)), ...bytesF(2, raw(OWN2)), ...numF(3, 1)];
  assert.equal(BX.vhpInflows(receipt(d, OWN2, B), VHP, RIVAL), 0n, "the VHP went to the sender's own address");
});

test("BX-73: a lying node that lowers the TOP producer's read must not lower everyone else's multiplier unseen", () => {
  const sat = (v) => String(BigInt(v) * 100000000n);
  const T = addr("r4-top"), Q = addr("r4-q");
  const honest = { [T]: sat(3_000_000), [Q]: sat(1_500_000) }, liar = { ...honest, [T]: sat(1) };
  const { values, differ } = R.combineReads(honest, liar, [T, Q]);
  assert.deepEqual(differ, [T]);
  // Wanted (any one): the card records that the top itself is in doubt (so Block X holds every target on the card),
  // or the combined top never falls below the top both nodes vouch for. Today Q's multiplier rises from x2 toward the
  // floor's value with no hold for Q's targets.
  const top = Object.values(values).reduce((m, v) => (BigInt(v) > m ? BigInt(v) : m), 0n);
  assert.ok(top >= BigInt(honest[T]) || values.__topInDoubt === true, `top counted ${top / 100000000n} VHP; Q's targets are scored with it`);
});

test("BX-76: a card taken in the last minute of a leg (check node up to 60 s ahead) still passes the publish check", () => {
  // race.ts run(): cardTime = max(now, check head time) <= now + HEAD_GAP_MS; race.yml:160-165 needs at < leg end.
  const legEnd = 0, now = legEnd - 30000, cardTime = now + R.HEAD_GAP_MS;
  assert.ok(cardTime < legEnd, "the whole race publish fails this run (and the leg keeps no card)");
});

// A fake node as in tests/audit/repolens-r3-race.test.mjs: blocks 3 s apart, signed round-robin.
function node({ head, lib, time }) {
  const S = [A, B, RIVAL];
  return {
    getHeadInfo: async () => ({ head_topology: { height: String(head), id: "h" }, head_block_time: String(time), last_irreversible_block: String(lib) }),
    call: async (_m, q) => { const s = Number(q.ancestor_start_height), n = q.num_blocks;
      return { block_items: Array.from({ length: n }, (_, i) => ({ block_height: String(s + i), block: { header: { signer: S[(s + i) % 3], timestamp: String(time - (head - s - i) * 3000) } } })) }; },
  };
}
test("BX-75: an honest check node 2 minutes behind does not stop handicap cards", async () => {
  const now = Date.now(), sat = (v) => String(BigInt(v) * 100000000n);
  const p = node({ head: 1_000_000, lib: 999_940, time: now });
  const check = node({ head: 999_960, lib: 999_900, time: now - 120000 });       // 40 blocks / 120 s behind
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "rl-r4-"));
  const out = tmp();
  const r = await R.run({ p, check, prev: tmp(), out, vhpOf: async (w) => Object.fromEntries(w.map((x) => [x, x === "network" ? sat(1e8) : sat(1000)])), raceContract: null });
  const cards = fs.readdirSync(out).filter((f) => /^W\d{3}\.json$/.test(f)).flatMap((f) => JSON.parse(fs.readFileSync(path.join(out, f), "utf8")).races.flatMap((rc) => rc.cards)).filter(Boolean);
  assert.ok(cards.length > 0, "no card: " + r.problems.join("; "));
});

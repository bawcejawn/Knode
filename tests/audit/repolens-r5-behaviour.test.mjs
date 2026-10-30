// Round 5 behaviour tests written with the fixes (owner's record: docs/history/AUDIT-2026-10-28-repolens-blockx.md,
// "Round 5"). Each pins the fix from the honest side as well: honest bytes and honest nodes still work.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { utils, Signer, Contract } from "koilib";

const APP = process.env.APP || ".";
const BX = await import(path.resolve(APP, "bot/games/blockx.ts"));
const R = await import(path.resolve(APP, "bot/race.ts"));
const addr = (seed) => Signer.fromSeed(seed).getAddress();
const VHP = addr("r5b-vhp"), A = addr("r5b-a"), B = addr("r5b-b"), C = addr("r5b-c");
const sat = (v) => String(BigInt(v) * 100000000n);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "rl-r5b-"));
const receipt = (b64, to, from) => ({ events: [], transaction_receipts: [{ events: [{ source: VHP, name: "token.transfer_event", data: b64, impacted: [to, from] }] }] });
const koilibArgs = async (args) => (await new Contract({ id: VHP, abi: utils.tokenAbi }).encodeOperation({ name: "transfer", args })).call_contract.args;

// ── BX-72: honest transfers (as koilib / Kondor encode them) are still counted exactly ──
test("BX-72: a transfer encoded by koilib (with and without a memo, base64url) is counted at its value", async () => {
  for (const memo of [undefined, "for the race"]) {
    const data = await koilibArgs({ from: B, to: A, value: "150000000", ...(memo ? { memo } : {}) });
    assert.equal(BX.vhpInflows(receipt(data, A, B), VHP, A), 150000000n);
    const std = Buffer.from(data, "base64").toString("base64");     // the same bytes in standard base64
    assert.equal(BX.vhpInflows(receipt(std, A, B), VHP, A), 150000000n);
  }
});
test("BX-72: a transfer whose `to` bytes aren't the event's receiver, or with a padded varint, is held (throws)", async () => {
  const data = await koilibArgs({ from: B, to: C, value: "5" });
  assert.throws(() => BX.vhpInflows(receipt(data, A, B), VHP, A), /standard encoding/);
  const b = [...Buffer.from(await koilibArgs({ from: B, to: A, value: "5" }), "base64")];
  b.splice(b.length - 1, 1, 0x85, 0x00);                                                 // value 5 as a 2-byte varint
  assert.throws(() => BX.vhpInflows(receipt(Buffer.from(b).toString("base64"), A, B), VHP, A), /standard encoding/);
  // Transfers to someone else, and other contracts' events, are never read at all.
  assert.equal(BX.vhpInflows(receipt("!!not base64", C, B), VHP, A), 0n);
});

// ── BX-90: a node that returns short pages of receipts is read on, not voided ──
test("BX-90: receipts served in short pages are read on; a missing block still throws", async () => {
  const from = 1000, to = 1449;
  const node = (gap) => ({ call: async (_m, q) => { const s = Number(q.ancestor_start_height), n = Math.min(q.num_blocks, 37);
    return { block_items: Array.from({ length: n }, (_, i) => ({ block_height: String(gap && s + i === 1200 ? 1201 : s + i), receipt: { events: [] } })) }; } });
  assert.equal(await BX.scoringVhpMoves(node(false), "h", VHP, A, from, to), 0n);
  await assert.rejects(() => BX.scoringVhpMoves(node(true), "h", VHP, A, from, to), /out of order/);
});

// ── BX-86: a dispute in a sample reaches the card ──
function chain({ head, lib, time }) {
  const S = [A, B, C];
  return {
    getHeadInfo: async () => ({ head_topology: { height: String(head), id: "h" }, head_block_time: String(time), last_irreversible_block: String(lib) }),
    call: async (_m, q) => { const s = Number(q.ancestor_start_height), n = q.num_blocks;
      return { block_items: Array.from({ length: n }, (_, i) => ({ block_height: String(s + i), block: { header: { signer: S[(s + i) % 3], timestamp: String(time - (head - s - i) * 3000) } } })) }; },
  };
}
const cardsOf = (out) => fs.readdirSync(out).filter((f) => /^W\d{3}\.json$/.test(f)).flatMap((f) => JSON.parse(fs.readFileSync(path.join(out, f), "utf8")).races.flatMap((rc) => rc.cards)).filter(Boolean);
const vhpNow = async (w) => Object.fromEntries(w.map((x) => [x, x === "network" ? sat(1e8) : x === A ? sat(3000) : sat(1000)]));
async function cardWith(samples) {
  const now = Date.now(), prev = tmp(), out = tmp();
  fs.writeFileSync(path.join(prev, "vhp-samples.json"), JSON.stringify({ v: 1, updated: new Date(now).toISOString(), samples: samples(now) }));
  const r = await R.run({ p: chain({ head: 1_000_000, lib: 999_940, time: now }), check: chain({ head: 1_000_000, lib: 999_940, time: now }), prev, out, vhpOf: vhpNow, raceContract: null, clock: () => now });
  const c = cardsOf(out);
  assert.ok(c.length, "no card: " + r.problems.join("; "));
  return { card: c[c.length - 1], problems: r.problems };
}
test("BX-86: a producer flagged in a sample of the last 6 hours is flagged on the card; the top in doubt when its higher read would reach the top", async () => {
  // B was sampled at its lower read (1,000) with a higher read of 5,000 (above A's 3,000, the card's top).
  const { card } = await cardWith((now) => [{ at: now - 3600000, height: 999_000, vhp: { [A]: sat(3000), [B]: sat(1000), [C]: sat(1000) }, flagged: [B], high: { [B]: sat(5000) } }]);
  assert.deepEqual(card.flagged, [B]);
  assert.equal(card.topInDoubt, true);
  // A flagged producer whose higher read stays below the top: flagged, but the card's top is not in doubt.
  const { card: c2 } = await cardWith((now) => [{ at: now - 3600000, height: 999_000, vhp: { [A]: sat(3000), [B]: sat(1000), [C]: sat(1000) }, flagged: [C], high: { [C]: sat(1500) } }]);
  assert.deepEqual(c2.flagged, [C]);
  assert.ok(!c2.topInDoubt);
  // Honest samples: nothing flagged.
  const { card: c3 } = await cardWith((now) => [{ at: now - 3600000, height: 999_000, vhp: { [A]: sat(3000), [B]: sat(1000), [C]: sat(1000) } }]);
  assert.ok(!c3.flagged && !c3.topInDoubt);
});
test("BX-86: a malformed dispute (higher read below the stored one, or a producer not in the sample) drops that sample", () => {
  assert.equal(R.disputesOk({ vhp: { [A]: "5" }, flagged: [A], high: { [A]: "4" } }), false);
  assert.equal(R.disputesOk({ vhp: { [A]: "5" }, flagged: [B], high: { [B]: "9" } }), false);
  assert.equal(R.disputesOk({ vhp: { [A]: "5" }, flagged: [A] }), false);
  assert.equal(R.disputesOk({ vhp: { [A]: "5" }, flagged: [A], high: { [A]: "9" } }), true);
  assert.equal(R.disputesOk({ vhp: { [A]: "5" } }), true);
});
test("BX-86: a sample re-reads only the disputed producers; one the nodes then agree on is sampled normally", async () => {
  const P = addr("r5b-p"), out = tmp();
  const node = { getHeadInfo: async () => ({ head_topology: { height: "1000000", id: "h" }, head_block_time: String(Date.now()), last_irreversible_block: "999940" }),
    call: async (_m, q) => ({ block_items: Array.from({ length: q.num_blocks }, (_, i) => ({ block_height: String(Number(q.ancestor_start_height) + i), block: { header: { signer: P, timestamp: String(Date.now()) } } })) }) };
  let calls = 0; const asked = [];
  await R.sample({ p: node, check: node, prev: tmp(), out, spreadMs: 0, wait: async () => {},
    vhpOf: async (w) => Object.fromEntries(w.map((x) => [x, sat(1000)])),
    vhpCheckOf: async (w) => { asked.push(w.length); return Object.fromEntries(w.map((x) => [x, calls++ === 0 ? sat(9000) : sat(1000)])); } });
  const s = JSON.parse(fs.readFileSync(path.join(out, "vhp-samples.json"), "utf8")).samples.at(-1);
  assert.equal(s.vhp[P], sat(1000));
  assert.equal(s.flagged, undefined, "agreed on the re-read: not flagged");
});

// ── BX-89: a card is never dated after this computer's clock (plus a minute) ──
test("BX-89: a primary node whose head is 5 minutes ahead of this computer's clock makes no card", async () => {
  const now = Date.now(), out = tmp();
  const r = await R.run({ p: chain({ head: 1_000_000, lib: 999_940, time: now + 300000 }), check: chain({ head: 1_000_000, lib: 999_940, time: now + 300000 }), prev: tmp(), out, vhpOf: vhpNow, raceContract: null, clock: () => now });
  assert.equal(cardsOf(out).length, 0);
  assert.ok(r.problems.some((x) => /ahead of this computer's clock/.test(x)));
});

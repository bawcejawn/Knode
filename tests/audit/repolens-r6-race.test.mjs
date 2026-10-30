// Repo Lense round 6, reviewer G-A: failing tests for bot/race.ts and bot/games/blockx.ts @ b0abc79.
// NOT RUN HERE (static review). Place in tests/audit/ and run like tests/audit/repolens-r5-behaviour.test.mjs (tsx loader).
// Each test drives the REAL code (R.run / BX.run) with fake nodes and should FAIL on b0abc79.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { Signer } from "koilib";

const APP = process.env.APP || ".";
const R = await import(path.resolve(APP, "bot/race.ts"));
const addr = (seed) => Signer.fromSeed(seed).getAddress();
const A = addr("r6ga-a"), B = addr("r6ga-b"), C = addr("r6ga-c"), D = addr("r6ga-d");
const sat = (v) => String(BigInt(Math.round(v)) * 100000000n);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "rl-r6ga-"));
// Blocks signed in proportion to VHP: in every 12 blocks A 6, B 3, C 2, D 1.
const CYCLE = [A, A, A, A, A, A, B, B, B, C, C, D];
// (Owner's copy: `says` is the head a lying node REPORTS; its blocks are the real chain's, so the two nodes' block
// windows still match and a card is made. The auditor's version moved the blocks too, so no card was ever made.)
function chain({ head, lib, time, says = head }) {
  return {
    getHeadInfo: async () => ({ head_topology: { height: String(says), id: "h" }, head_block_time: String(time), last_irreversible_block: String(lib) }),
    call: async (_m, q) => { const s = Number(q.ancestor_start_height), n = q.num_blocks;
      return { block_items: Array.from({ length: n }, (_, i) => ({ block_height: String(s + i), block: { header: { signer: CYCLE[(s + i) % 12], timestamp: String(time - (head - s - i) * 3000) } } })) }; },
  };
}
const VHP = { [A]: 3000, [B]: 1500, [C]: 1000, [D]: 500 };
const honestOf = async (w) => Object.fromEntries(w.map((x) => [x, x === "network" ? sat(1e8) : sat(VHP[x] ?? 0)]));
const cardsOf = (out) => fs.readdirSync(out).filter((f) => /^W\d{3}\.json$/.test(f)).flatMap((f) => JSON.parse(fs.readFileSync(path.join(out, f), "utf8")).races.flatMap((rc) => rc.cards)).filter(Boolean);
const vhpOn = (card, a) => [...card.field, ...card.paddock].find((r) => r.a === a)?.vhp;
async function card(checkHeadOffset, vhpCheckOf) {
  const now = Date.now(), prev = tmp(), out = tmp();
  const samples = Array.from({ length: 36 }, (_, k) => ({ at: now - 6 * 3600000 + (k + 1) * 590000, height: 990_000 + k, vhp: Object.fromEntries(Object.entries(VHP).map(([a, v]) => [a, sat(v)])) }));
  fs.writeFileSync(path.join(prev, "vhp-samples.json"), JSON.stringify({ v: 1, updated: new Date(now).toISOString(), samples }));
  const r = await R.run({ p: chain({ head: 1_000_000, lib: 999_940, time: now }), check: chain({ head: 1_000_000, says: 1_000_000 + checkHeadOffset, lib: 999_940, time: now }),
    prev, out, vhpOf: honestOf, vhpCheckOf, raceContract: null, clock: () => now });
  const c = cardsOf(out);
  assert.ok(c.length, "no card: " + r.problems.join("; "));
  return c[c.length - 1];
}

test("G-A-1: one node lifting a flagged producer in the card read (claiming another head) must not move an unflagged producer's multiplier unheld", async () => {
  const honest = await card(0, honestOf);
  const lied = await card(1, async (w) => ({ ...(await honestOf(w)), [D]: sat(2990) }));   // D lifted 500 -> 2,990 VHP
  assert.ok(lied.flagged?.includes(D), "D is flagged (its own targets are held)");
  const ratio = (c) => vhpOn(c, A) / vhpOn(c, B);   // B's multiplier = top / B (A is the top)
  // Wanted: either the card is held whole (topInDoubt), or B's multiplier is what the honest card gives.
  assert.ok(lied.topInDoubt === true || Math.abs(ratio(lied) - ratio(honest)) < 1e-9,
    `B (not flagged) moved from x${ratio(honest).toFixed(3)} to x${ratio(lied).toFixed(3)} with no topInDoubt; Block X scores B's targets with it`);
});

// Block X: a NonCanonicalTransfer reported by ONE node voids the target at once (blockx.ts run:612-620, 636). Add to
// tests/audit/repolens-r5-publish/bx88-week-files.test.mjs (it uses that file's fixtures: run, raceDir, blockOf, picksOf,
// rankedOf, quiet, H0, X):
//
// test("G-A-2: a non-canonical transfer seen on one node only holds the target (a disagreement), never voids it", async () => {
//   const lib = H0 + 4 * X.ROUND + 50;
//   const { NonCanonicalTransfer } = await import(path.resolve(APP, "bot/games/blockx.ts"));
//   const out = fs.mkdtempSync(path.join(os.tmpdir(), "ga2-"));
//   const r = await quiet(() => run({ p: "main", check: "check", out, raceDir: raceDir(), picksContract: "1PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP", blockOf, picksOf, rankedOf,
//     vhpMovesOf: async (node) => { if (node === "main") throw new NonCanonicalTransfer("a VHP transfer to X isn't in the standard encoding (unexpected fields)"); return 0n; },
//     head: { height: lib + 60, time: T(lib + 60), lib } }));
//   const ts = r.weeks.get(3)?.targets ?? [];
//   assert.ok(ts.every((t) => !/standard encoding/.test(t.void || "")), "one node's word voided a target for good");
// });

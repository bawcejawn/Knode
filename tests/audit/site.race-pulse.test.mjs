// Network pulse (site/pulse.js), the Mana planner (site/mana.js) and the shared block loader: the math, and that
// they only read. The Producer Race has its own tests (site.race.test.mjs). Offline: runs the scripts' math in a sandbox with no page, and reads the files.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const APP = process.env.APP || ".";
const read = (f) => fs.readFileSync(`${APP}/${f}`, "utf8");
const load = (f) => { const box = { window: {} }; vm.runInNewContext(read(f), box); return box.window; };
const P = load("pulse.js").KPulseMath, M = load("mana.js").KManaMath;
const DAY = 86400000;


test("pulse: blocks, transactions, gaps, hours and 'producers to sign half' over the last 24 hours", () => {
  const ts = [], sig = [], ntx = [];
  for (let i = 0; i < 1000; i++) { ts.push(DAY + i * 3000); sig.push(i % 10 < 6 ? 0 : i % 10 < 9 ? 1 : 2); ntx.push(i % 4 === 0 ? 2 : 0); }
  ts.push(DAY + 1000 * 3000 + 60000); sig.push(2); ntx.push(1);       // one 63 s gap
  ts.unshift(0); sig.unshift(1); ntx.unshift(9);                      // older than 24 h: left out
  const S = P.stats({ ts, sig, ntx, signers: ["1a", "1b", "1c"] }, ts.at(-1));
  assert.equal(S.blocks, 1001); assert.equal(S.tx, 501); assert.equal(S.withTx, 251);
  assert.equal(S.gapMax, 63000); assert.equal(S.slowGaps, 1);
  assert.equal(S.n50, 1); assert.equal(S.n33, 1);
  assert.equal(S.hours.reduce((s, h) => s + h.blocks, 0), 1001);
  assert.equal(S.producers[0].addr, "1a");
});

test("Mana planner: 5 × the daily Mana in KOIN", () => {
  const p = M.plan({ answer: 5, transfer: 2, swap: 1 });
  assert.equal(p.perDay, 5n * 35000000n + 2n * 30000000n + 140000000n);
  assert.equal(p.koin, p.perDay * 5n);
  assert.equal(M.plan({ answer: -3, swap: "x" }).perDay, 0n);
});

test("the block snapshot is used only after a spot check against the chain", () => {
  const js = read("chain-blocks.js");
  assert.match(js, /Spot-check 8 random blocks/);
  assert.match(js, /if \(!ok\.every\(Boolean\)\) return null;/);
});

test("pulse and the shared block loader only read: no signing, no sending", () => {
  for (const f of ["pulse.js", "chain-blocks.js"]) assert.doesNotMatch(read(f), /KWallet|\.send\(|signTransaction|sendTransaction|onlyOperation/, f);
});

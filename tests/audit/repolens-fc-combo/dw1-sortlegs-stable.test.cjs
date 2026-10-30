// D-W-1 (RL-13 partly fixed) failing test - NOT RUN HERE (static review).
// Drives the REAL race-math.js, blockx-math.js and combo-math.js of the checkout (APP=<repo>) in a vm, as the page loads them.
// The same two legs (a race Win and a Block X leg whose estimated lock is near the race's lock) must be sent in the same
// order whatever the head is, or re-sending the same card spends a change and a daily pick (contract sameLegs is ordered).
const test = require("node:test"), assert = require("node:assert/strict");
const vm = require("node:vm"), fs = require("node:fs"), path = require("node:path");
const APP = path.resolve(process.env.APP || ".");
function load() {
  const ctx = { console, Math, Date, BigInt, Number, Map, Set, Array, Object, JSON, Float64Array, Uint32Array, Error };
  ctx.window = ctx; ctx.globalThis = ctx; vm.createContext(ctx);
  for (const f of ["race-math.js", "blockx-math.js", "combo-math.js"]) vm.runInContext(fs.readFileSync(path.join(APP, f), "utf8"), ctx, { filename: f });
  return ctx;
}
test("D-W-1: sortLegs gives one order for the same legs at any head (RL-13)", () => {
  const { KCombo: C, KRaceMath: M, KBlockX: X } = load();
  const R = 83010, raceLock = M.raceStart(R) - C.RACE_LEAD_MS, H = 47980000;
  const r = Math.ceil((H + 600) / X.ROUND) + 3, bxLockH = X.target(r) - C.BLOCK_LEAD;
  const T1 = raceLock - 60000 - (bxLockH - H) * 3000;            // Block X lock estimated 60 s before the race lock
  const legs = [{ code: C.WIN, round: R, producer: "15NZhQoewzsbVUcSVsZ8BEBEKgaBNPLLgZ" }, { code: C.BLOCK, round: r, producer: "1MbsVfNw6yzQqA8499d8KQj8qdLyRs8CzW" }];
  const id = (l) => `${l.code}:${l.round}:${l.producer}`;
  const a = C.sortLegs(legs, { height: H, time: T1 }).map(id);
  const b = C.sortLegs(legs, { height: H + 2400, time: T1 + 2400 * 3050 }).map(id);   // 2 h later, blocks at 3.05 s
  assert.deepEqual(b, a, "the same card is sent in another order two hours later");
});

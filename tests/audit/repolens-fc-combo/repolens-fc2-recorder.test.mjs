// Reviewer E-R failing tests (node:test). NOT RUN HERE against the repository (static review): they ran only on a
// verbatim scratch copy. Place in tests/audit/repolens-fc-combo/ next to D-R.fixtures.mjs. They import the REAL
// bot/games/combo.ts (repo root from this file's URL, or $APP) through the owner's fixtures and koilib provider fake.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import path from "node:path"; import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
process.env.APP ||= fileURLToPath(new URL("../../../", import.meta.url));
const APP = process.env.APP;
const { run, M, X, C, BXM, H1, H2, H3, ALICE, BOB, W3, heightAt, raceDir, blockxDir, node, quiet, read, tmp, VAULT, PICKS } = await import("./D-R.fixtures.mjs");
const D3 = C.utcDay(W3), S0 = C.slotRound(D3, 0), dn = (d) => `D${String(d).padStart(5, "0")}.json`;
function publishCheck() {
  const y = fs.readFileSync(path.join(APP, ".github/workflows/combo.yml"), "utf8");
  const py = y.split("<<'PY'\n")[1].split("\n          PY\n")[0].split("\n").map((l) => (l.startsWith("          ") ? l.slice(10) : l)).join("\n");
  const f = path.join(tmp(), "check.py"); fs.writeFileSync(f, py); return f;
}
const heldBy = (inDir, pubDir, now) => {
  const held = path.join(tmp(), "held");
  try { execFileSync("python3", ["-I", publishCheck(), inDir, pubDir, held], { env: { ...process.env, CHECK_NOW_MS: String(now) }, stdio: "pipe" }); } catch {}
  return fs.readFileSync(held, "utf8").split("\n").filter((x) => x && x !== "!alert");
};
const twoCards = (round) => { const sent = D3 * M.DAY + 2 * 3600000, r6 = D3 * 4 + 1;
  const c = (p, l2) => ({ player: p, legs: [{ code: C.WIN, round: r6, producer: H1 }, l2], time: sent, height: heightAt(sent), changes: 0 });
  return round === S0 ? [c(ALICE, { code: C.SHOW, round: r6, producer: H2 }), c(BOB, { code: C.SHOW, round: r6, producer: H3 })] : []; };

test("E-R-1 (D-R-4c): a check node whose head lags by days must not silently rewind the recorder (error, nothing rewritten)", async () => {
  const end = M.weekStart(4), T = end + 2 * M.DAY, out = tmp();
  let r = null, thrown = null;
  try { r = await quiet(() => run({ p: node({ t: T, cards: twoCards }), check: node({ t: T, headTime: T - 72 * 3600000, cards: twoCards }), out, raceDir: raceDir(), blockxDir: blockxDir(), picksContract: PICKS, knodeGame: VAULT, now: T })); }
  catch (e) { thrown = e; }
  if (thrown) { assert.match(String(thrown.message), /behind|lag|head/i); assert.ok(!fs.existsSync(path.join(out, "board.json")), "nothing written"); return; }
  assert.ok(r.errors.some((e) => /behind|lag|head/i.test(e)), "a 72-hour head gap between the nodes (or a head far behind this machine's clock) must be an error");
  assert.notEqual(r.board.week.week, 3, "the board must not be rebuilt for a week that is already over (it would replace the published one)");
});

test("E-R-T4 (D-R-4, recorder half): a failed read or a down check node keeps the published FIXED slot (its day file is not held)", async () => {
  const tA = M.weekStart(4) + 12 * 3600000 + 52 * 60000, tB = tA + 3600000, A = tmp(), race = raceDir(), bx = blockxDir();
  await quiet(() => run({ p: node({ t: tA, cards: twoCards }), check: node({ t: tA, cards: twoCards }), out: A, raceDir: race, blockxDir: bx, picksContract: PICKS, knodeGame: VAULT, now: tA }));
  for (const check of [{ fail: { slot: (r) => r === S0 } }, { fail: { head: true } }]) {
    const out = tmp();
    await quiet(() => run({ p: node({ t: tB, cards: twoCards }), check: node({ t: tB, cards: twoCards, ...check }), prev: A, out, raceDir: race, blockxDir: bx, picksContract: PICKS, knodeGame: VAULT, now: tB }));
    const what = JSON.stringify(Object.keys(check.fail));
    assert.equal(read(out, dn(D3)).slots.find((s) => s.round === S0).fixed, true, `${what}: the recorder un-fixed a published fixed slot`);
    assert.ok(!heldBy(out, A, tB + 60000).includes("combo/" + dn(D3)), `${what}: the publish job holds the day file`);
  }
});

test("E-R-T3 (D-R-3, BX-100): one node alone reporting a non-standard transfer HOLDS the leg inside Block X's 3 days", async () => {
  const sent = D3 * M.DAY + 13 * 3600000, rf = D3 * 4 + 3, blockT = D3 * M.DAY + 20 * 3600000, R = Math.ceil(heightAt(blockT) / X.ROUND), signer = R % 2 === 0 ? H1 : H2;
  const race = signer === H1 ? { code: C.SHOW, round: rf, producer: H2 } : { code: C.WIN, round: rf, producer: H1 };
  const cards = (r) => (r === S0 ? [{ player: ALICE, legs: [race, { code: C.SHOW, round: rf, producer: H3 }, { code: C.BLOCK, round: R, producer: signer }], time: sent, height: heightAt(sent), changes: 0 }] : []);
  const t = D3 * M.DAY + 2 * M.DAY, p = node({ t, cards }), q = node({ t, cards }), out = tmp();   // ~1 day after the block
  await quiet(() => run({ p, check: q, out, raceDir: raceDir(), blockxDir: blockxDir(), picksContract: PICKS, knodeGame: VAULT, now: t,
    vhpMovesOf: async (n) => { if (n === q) throw new BXM.NonCanonicalTransfer("a VHP transfer isn't in the standard encoding"); return 0n; } }));
  const c = read(out, dn(D3)).slots.find((s) => s.round === S0).cards[0];
  assert.notEqual(c.legs[2][4], "unresolved", "one node's word decided the leg before Block X's 3-day edge");
  assert.equal(c.state, "pending", "the card must wait while the nodes disagree");
});

// C-W-3 failing test - NOT RUN HERE (static review). Loads the REAL wallet.js of the merged branch (refs/x/picks
// version, which the merge keeps) in a vm with a recording koilib/Kondor stub, and sends one Combo card operation
// (pick with field 6 legs) through KWallet.send with the sponsor block the launch tools write (rcLimits row for
// picks:8ce33c6c set from Block X single picks). Expectation: a 6-leg card is not sent with the single-pick row as its
// Mana limit (it must use a card row, or the per-transaction cap). Fails today: rcFor() keys on contract:entry only.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
const APP = process.env.APP || ".";
const PICKS = "1EN7xU8R9tQXjHvrX79qZvvvGkkKWVnB5K", SP = "1ByDDSBUzy5zkRceELc54Jh8i41yNRoKt8", ME = "1HsM33pF8DbXPr8Vsd4vD7hQgvZ1SHY3Vv";
// Combo fix round (RL-11): cards and single picks share the Picks pick row (the chain's sponsor keys rows on contract +
// entry point too). The owner set that row to 0.2 Mana at launch (admin action "sponsor-picks-limit", 2026-10-30) from
// the testnet card measurements: 10 legs used 0.0916 Mana (claude/combo/TESTNET-RESULTS.md). The test now checks that
// a 6-leg card goes out with a limit at least 2x the measured 10-leg card, and that the launch row is that row.
const ROW = "20000000";                      // 0.2 Mana: the launch row
const MEASURED_10_LEGS = 9160000n;            // 0.0916 Mana
test("C-W-3: a sponsored 6-leg card goes out with at least 2x the measured 10-leg card's Mana (the launch's 0.2 row)", async () => {
  const seen = [];
  const koilib = await import("koilib");     // the real koilib for encoding; Transaction is wrapped to record options
  class T extends koilib.Transaction { constructor(o) { super(o); seen.push(o.options); } async send() { return { reverted: false }; } }
  const ctx = { window: {}, document: { getElementById: () => null, createElement: () => ({ style: {}, append() {}, setAttribute() {}, addEventListener() {} }), head: { append() {} }, body: { append() {} }, documentElement: { style: {} } },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { userAgent: "node", maxTouchPoints: 0, platform: "Linux" }, setTimeout, clearTimeout, URL, URLSearchParams, BigInt, Uint8Array, Promise, console };
  ctx.window = Object.assign(ctx, { koilib: { ...koilib, Transaction: T }, top: null, self: null, location: { hostname: "knodegames.com", protocol: "https:" } });
  ctx.window.top = ctx.window.self = ctx.window;
  ctx.window.kondor = { getSigner: () => ({ getAddress: () => ME, signTransaction: async (tx) => tx, sendTransaction: async () => ({}) }) };
  vm.runInNewContext(fs.readFileSync(`${APP}/wallet.js`, "utf8"), ctx);
  const provider = { getChainId: async () => "EiBZK_GGVP0H_fXVAM3j6EAuz3-B-l3ejxRSewi7qIBfSA==", readContract: async () => ({ result: "CAE" }), getAccountRc: async () => "1000000000", wait: async () => ({}) };
  // (Combo fix round: the connected wallet is set before init, which reads it; after init the wallet had no address.)
  ctx.localStorage.getItem = (k) => (k === "kw-active" ? ME : k === "kw-kind" ? "kondor" : k === "kw-accounts" ? JSON.stringify([{ kind: "kondor", address: ME }]) : null);
  ctx.window.KWallet.init({ provider, payer: "sponsor", sponsor: { address: SP, covers: ["1Mpmf2ERhjYpX7CCiM11WERuM4j17uT1sr", PICKS], picks: PICKS, rcLimit: "100000000", rcLimits: { [`${PICKS}:8ce33c6c`]: ROW } } });
  // a 6-leg card: pick_arguments with field 6 (legs) repeated six times
  const legs = Array.from({ length: 6 }, (_, i) => [0x32, 0x1f, 0x08, 1 + (i % 4), 0x10, 0x90, 0x4e, 0x1a, 0x19, ...new Array(25).fill(i + 1)]).flat();
  const args = koilib.utils.encodeBase64url(new Uint8Array([0x0a, 0x19, ...new Array(25).fill(9), 0x10, 0x08, 0x18, 0x99, 0x01, ...legs]));
  try { await ctx.window.KWallet.send("card", [{ call_contract: { contract_id: PICKS, entry_point: 0x8ce33c6c, args } }]); } catch { /* the stub signer may refuse; options are recorded first */ }
  const used = seen.find((o) => o && o.payer === SP);
  assert.ok(used, "the card was offered to the sponsor");
  assert.ok(BigInt(used.rcLimit) >= 2n * MEASURED_10_LEGS, `a card asked for ${used.rcLimit}: less than 2x a measured 10-leg card`);
  const admin = fs.readFileSync(`${APP}/admin/actions.ts`, "utf8");
  assert.match(admin, /"mana-limit", "picks:pick", "0\.0916",[^\n]*"--limit", "0\.2"/, "the launch sets the Picks pick row to 0.2 Mana");
});

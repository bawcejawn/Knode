// F5-S2 failing tests @ cc524eb. NOT RUN HERE (static review).
// Place in tests/audit/ and run from the repo root with node --test (tsx loader for the .ts import).
// Each test should FAIL on cc524eb and pass once fixed.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const wallet = fs.readFileSync("wallet.js", "utf8");
// Pull gameOfOps + varintField out of wallet.js (as tests/audit/repolens-r3-site.test.mjs does for guestOrigin).
function siteGameOfOps() {
  const body = wallet.slice(wallet.indexOf("function gameOfOps("), wallet.indexOf("/** would_pay(account, rc_limit, game)"));
  const lib = { utils: { decodeBase64url: (s) => new Uint8Array(Buffer.from(s, "base64url")) } };
  return new Function("lib", "PICK", body + "\nreturn gameOfOps;")(lib, 0x8ce33c6c);
}
const vint = (v) => { const o = []; do { let x = v & 0x7f; v = Math.floor(v / 128); if (v > 0) x |= 0x80; o.push(x); } while (v > 0); return o; };
const ADDR = Array.from({ length: 25 }, (_, i) => i + 1);
const args = (...f) => Buffer.from(Uint8Array.from(f.flat())).toString("base64url");
const GAME = "1Game";
const sp = { race: "1Race", picks: "1Picks", covers: [GAME, "1Vhp", "1Koin", "1Race", "1Picks"] };
const vaultOp = (entry, game) => ({ call_contract: { contract_id: GAME, entry_point: entry, args: args([0x0a, 25, ...ADDR], [0x10, ...vint(game)], [0x18, 1]) } });

// F5-S2-2 (Low): the site must name the vault game for deposit_to / withdraw_from / move_stake / claim_game, as
// Sponsor.ts:gameOfCall:393 does (field 2 of the vault call), so would_pay agrees with authorize for a wallet
// staked only in that game. Today gameOfOps returns 0 for every vault call.
test("F5-S2-2: would_pay gets the vault call's game (field 2) like authorize", () => {
  const gameOfOps = siteGameOfOps();
  const s = { ...sp, game: GAME };   // a fix may need the game contract on sp (covers[0])
  for (const e of [0x7bb5c436, 0x5b0aaef8, 0x7c268e69, 0x4107e3ab]) assert.equal(gameOfOps(s, [vaultOp(e, 2)]), 2, `entry ${e.toString(16)}`);
});

// F5-S2-3 (Low): keep sending answer_only = true (field 3) for free-play transactions. Sponsor v3 ignores it; the v2
// rollback build (fa4659e6…) refuses every non-player without it, so a rollback locks all guests out.
test("F5-S2-3: would_pay still marks free play (answer_only) for the v2 rollback", () => {
  const body = wallet.slice(wallet.indexOf("async function sponsorAnswer("), wallet.indexOf("async function sendVault("));
  assert.match(body, /0x18,\s*0x01/, "answer_only (field 3) is no longer sent");
});

// F5-S2-1 (High): enable must not re-enable a config that a single node fed to an earlier disable. It should check the
// non-cap fields on chain (game, desk, race, vhp, tokens, allowed, mana_caps) against what the tool would build from
// the deployment files, and print every cap, before sending enabled = true.
test("F5-S2-1: enable checks the on-chain addresses/rows against the expected config and shows every cap", () => {
  const src = fs.readFileSync("bot/sponsor.ts", "utf8");
  const body = src.slice(src.indexOf("async function setSwitch("), src.indexOf("/** Copies the per-action limits"));
  assert.match(body, /buildConfig|expected|cur\.game\s*!==|cur\.allowed/, "enable re-signs whatever is on chain without comparing it to the expected config");
  assert.match(body, /max_mana_per_account_day|max_mana_free_day/, "the enable dry run should print the caps it re-enables");
});

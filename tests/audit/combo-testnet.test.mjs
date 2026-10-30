// Combo Card testnet tools (picks/scripts/build-testnet-v2.cjs, tools/combo-testnet.mjs): the testnet build changes
// exactly three lines of the audited v2 source and refuses the mainnet owner; the tool refuses mainnet settings and
// keys, and the two test routes (fresh contract, upgrade) can't be mixed. Offline: no chain is contacted.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

const APP = process.env.APP || ".";
const require = createRequire(import.meta.url);
const B = require(path.resolve(APP, "picks/scripts/build-testnet-v2.cjs"));
const { Signer } = require("koilib");
const MAINNET_CHAIN = "EiBZK_GGVP0H_fXVAM3j6EAuz3-B-l3ejxRSewi7qIBfSA==";
const TEST_OWNER = "1HsM33pF8DbXPr8Vsd4vD7hQgvZ1SHY3Vv";

test("testnet v2 build: exactly the three settings change, and the audited v2 hash is the one checked", () => {
  assert.equal(B.AUDITED_V2, "92d555d0680157854452e35162c1b1c5c100904996194b8c1c848df50e5e1c3d");
  const src = fs.readFileSync(path.resolve(APP, "picks/assembly/Picks.ts"), "utf8");
  const r = B.patchSource(src, TEST_OWNER, 10, 24);
  assert.equal(r.lines.length, 3);
  assert.deepEqual(r.changed.map((c) => c.name), ["INITIAL_OWNER", "TIMELOCK_MS", "EXPIRY_MS"]);
  assert.match(r.out, new RegExp(`Base58\\.decode\\("${TEST_OWNER}"\\)`));
  assert.throws(() => B.patchSource(src, "1635QUrBNDp7WqmFkRvrkGwjJXTtFvH717", 10, 24), /mainnet owner/);
  assert.throws(() => B.patchSource(src, "1HsM33pF8DbXPr8Vsd4vD7hQgvZ1SHY3Vw", 10, 24), /checksum/);
  assert.throws(() => B.patchSource(src, TEST_OWNER, 0, 24), /timelock/);
});

function home(cfg, env) {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "ct-"));
  fs.mkdirSync(path.join(h, "testnet"));
  fs.writeFileSync(path.join(h, "testnet", "blockx.json"), JSON.stringify(cfg));
  fs.writeFileSync(path.join(h, ".env.testnet"), env);
  return h;
}
const tool = (args) => { try { execFileSync(process.execPath, [path.resolve(APP, "tools/combo-testnet.mjs"), ...args], { stdio: "pipe" }); return ""; } catch (e) { return String(e.stderr); } };
const wif = (seed) => Signer.fromSeed(seed).getPrivateKey("wif");

test("combo-testnet refuses mainnet settings and the mainnet owner's key, and needs --home", () => {
  assert.match(tool(["status"]), /Add --home/);
  let h = home({ network: "koinos-foundation-testnet", rpc: "http://127.0.0.1:9", chainId: MAINNET_CHAIN, picks: TEST_OWNER }, `OWNER_WIF=${wif("x")}\n`);
  assert.match(tool(["status", "--home", h]), /MAINNET chain id/);
  h = home({ network: "mainnet", rpc: "http://127.0.0.1:9" }, `OWNER_WIF=${wif("x")}\n`);
  assert.match(tool(["status", "--home", h]), /not a testnet config/);
});

test("combo-testnet: the two routes can't be mixed; keys only for --fresh; it never prints a key", () => {
  const h = home({ network: "koinos-foundation-testnet", rpc: "http://127.0.0.1:9", chainId: "x", picks: TEST_OWNER }, `OWNER_WIF=${wif("y")}\n`);
  assert.match(tool(["schedule", "--home", h, "--fresh"]), /upgrade route/);
  assert.match(tool(["keys", "--home", h]), /--fresh only/);
  const out = execFileSync(process.execPath, [path.resolve(APP, "tools/combo-testnet.mjs"), "keys", "--home", h, "--fresh"]).toString();
  const added = /COMBO_PICKS_WIF=(\S+)/.exec(fs.readFileSync(path.join(h, ".env.testnet"), "utf8"))[1];
  assert.ok(!out.includes(added) && !out.includes(wif("y")), "no key in the output");
  assert.match(out, /new contract wallet: 1/);
});

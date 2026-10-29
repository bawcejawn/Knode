// Audit L-3 (2026-10-26): the wallet code pins Koinos mainnet's chain id by default, so every page that signs (game,
// swap, burn, producer lookup) refuses a node that reports another chain, even without a chainId in deployment.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const MAINNET = "EiBZK_GGVP0H_fXVAM3j6EAuz3-B-l3ejxRSewi7qIBfSA==";

test("wallet.js pins mainnet's chain id unless a page passes another one", () => {
  const w = fs.readFileSync("wallet.js", "utf8");
  assert.ok(w.includes(`const MAINNET_CHAIN_ID = "${MAINNET}"`));
  assert.match(w, /W\.chainId = chainId \|\| MAINNET_CHAIN_ID/);
  assert.match(w, /if \(W\.chainId\) \{\s*const id = await W\.provider\.getChainId\(\)\.catch\(\(\) => null\);\s*if \(id !== W\.chainId\) throw/);
});

test("both deployment files pin the same chain id", () => {
  for (const f of ["game-data/deployment.json", "desk-data/deployment.json"]) assert.equal(JSON.parse(fs.readFileSync(f, "utf8")).chainId, MAINNET, f);
});

// The testnet staking page (stake-testnet.html): it signs only the vault's four player calls on the testnet copy, with
// its own wallet, and no mainnet page ever loads that wallet.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const APP = process.env.APP || ".";
const cfg = JSON.parse(fs.readFileSync(`${APP}/testnet/vault.json`, "utf8"));
const MAINNET_CHAIN_ID = "EiBZK_GGVP0H_fXVAM3j6EAuz3-B-l3ejxRSewi7qIBfSA==";

function load() {
  const win = { localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, crypto: globalThis.crypto };
  win.top = win; win.self = win; win.window = win;
  vm.runInNewContext(fs.readFileSync(`${APP}/stake-testnet-wallet.js`, "utf8"), { window: win, document: {}, console });
  return win.KTestStakeWallet;
}
const call = (contract_id, entry_point) => ({ call_contract: { contract_id, entry_point, args: "" } });

test("testnet/vault.json names the testnet, never mainnet", () => {
  assert.notEqual(cfg.chainId, MAINNET_CHAIN_ID);
  assert.match(cfg.rpc, /^https:\/\/testnet\./);
  for (const k of ["contract", "vhp", "koin"]) assert.match(cfg[k], /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/, k);
});

test("the testnet wallet signs only the vault's player calls (and an approve right before deposit_to)", () => {
  const T = load(), ok = (ops) => T._test.allowed(ops, cfg);
  for (const ep of [0x7bb5c436, 0x5b0aaef8, 0x7c268e69, 0x4107e3ab]) assert.ok(ok([call(cfg.contract, ep)]), ep.toString(16));
  assert.ok(ok([call(cfg.vhp, 0x74e21680), call(cfg.contract, 0x7bb5c436)]), "approve VHP + deposit_to");
  assert.ok(ok([call(cfg.koin, 0x74e21680), call(cfg.contract, 0x7bb5c436)]), "approve KOIN + deposit_to");
  assert.ok(!ok([call(cfg.vhp, 0x74e21680)]), "approve alone");
  assert.ok(!ok([call(cfg.vhp, 0x74e21680), call(cfg.contract, 0x5b0aaef8)]), "approve before a withdrawal");
  assert.ok(!ok([call(cfg.contract, 0x7bb5c436), call(cfg.vhp, 0x74e21680)]), "approve after");
  assert.ok(!ok([call(cfg.vhp, 0x27f576ca)]), "a token transfer");
  assert.ok(!ok([call(cfg.contract, 0x12345678)]), "an owner call");
  assert.ok(!ok([call("1Mpmf2ERhjYpX7CCiM11WERuM4j17uT1sr", 0x7bb5c436)]), "the mainnet vault");
  assert.ok(!ok([call(cfg.contract, 0x7bb5c436), call(cfg.contract, 0x7bb5c436)]), "two deposits");
  assert.ok(!ok([]), "nothing");
  assert.throws(() => load().init({ provider: {}, chainId: MAINNET_CHAIN_ID, contract: cfg.contract, vhp: cfg.vhp, koin: cfg.koin }), /testnet chain id/);
});

test("only the testnet page uses the testnet wallet and settings; it loads no mainnet wallet", () => {
  for (const f of fs.readdirSync(APP).filter((x) => x.endsWith(".html"))) {
    const html = fs.readFileSync(`${APP}/${f}`, "utf8");
    const testnet = /<meta name="kg-network" content="testnet">/.test(html);
    if (/stake-testnet-wallet\.js/.test(html)) assert.ok(testnet, `${f} loads the testnet wallet without being a testnet page`);
    if (f === "stake-testnet.html") {
      assert.ok(testnet);
      assert.ok(!/src="(guest|wallet|header-wallet)\.js"/.test(html), "no mainnet wallet script");
      assert.match(html, /<meta name="robots" content="noindex">/);
    }
  }
  const panel = fs.readFileSync(`${APP}/stake-panel.js`, "utf8");
  assert.match(panel, /TESTNET \? "\.\/testnet\/vault\.json" : "\.\/game-data\/deployment\.json"/);
  assert.match(panel, /TESTNET \? window\.KTestStakeWallet : window\.KWallet/);
});

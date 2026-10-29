// F4-K-1 failing test. NOT RUN HERE (static review). Run from the repo root: node --test <this file>
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
const APP = process.env.APP || process.cwd();
test("F4-K-1: the vault (v6) ABI the recorder and the page load exists and decodes get_game_player with peak_stake", () => {
  const f = path.join(APP, "game/abi/kpred-v6.koilib.json");
  assert.ok(fs.existsSync(f), "bot/games/blockx.ts:156 and blockx.js:486 load this file; without it readVault throws on every target");
  const abi = JSON.parse(fs.readFileSync(f, "utf8"));
  const n = abi.koilib_types?.nested?.kpred?.nested ?? abi.types?.nested?.kpred?.nested;
  assert.equal(abi.methods.get_game_player.entry_point, 0x0feb472b);
  assert.equal(n.gentry_object.fields.peak_stake.id, 7, "vaultView's peak needs gentry_object.peak_stake (field 7)");
  assert.equal(n.get_game_player_result.fields.week_stake.id, 4);
  assert.equal(n.config_object.fields.v6_rule_week_plus_one.id, 21);
});
test("F4-K-1: VAULT_ABI() (used by readVault for every target on mainnet) loads", async () => {
  const { VAULT_ABI } = await import(path.join(APP, "bot/games/blockx.ts"));
  assert.doesNotThrow(() => VAULT_ABI(), "ENOENT here = every mainnet target throws at rankedRead and is voided after 3 days");
});

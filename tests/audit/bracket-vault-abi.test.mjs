// The Bracket recorder's stake read against the REAL Vault v6 interface (game/abi/kpred.koilib.json from vault-v6-next):
// a fake node answers get_state and get_game_player with results encoded by that interface, so a renamed or missing
// field would break this test, not a live week.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Serializer, Signer, utils } from "koilib";

const APP = process.env.APP || ".";
const abi = JSON.parse(fs.readFileSync(path.resolve(APP, "game/abi/kpred.koilib.json"), "utf8"));
const dep = JSON.parse(fs.readFileSync(path.resolve(APP, "game-data/deployment.json"), "utf8"));
const rec = await import(path.resolve(APP, "bot/games/bracket.ts"));
const ser = new Serializer(abi.koilib_types);
const P = (i) => Signer.fromSeed("bracket-vault-abi-test-" + i).getAddress();   // throwaway test addresses (no real keys)

function fakeNode(minStake, minNext, nextWeek, players) {
  return {
    async readContract(op) {
      if (op.contract_id !== dep.contract) throw new Error("wrong contract " + op.contract_id);
      const m = Object.entries(abi.methods).find(([, x]) => x.entry_point === op.entry_point);
      if (!m) throw new Error("unknown entry point");
      const [name, meth] = m;
      if (name === "get_state") {
        const r = await ser.serialize({ config: { min_stake: String(minStake), min_stake_next: String(minNext), min_stake_next_week: String(nextWeek) } }, meth.return);
        return { result: utils.encodeBase64url(r) };
      }
      if (name === "get_game_player") {
        const a = await ser.deserialize(op.args, meth.argument, { bytesConversion: true });
        assert.equal(a.game, 9, "asks about game 9");
        const x = players[a.player] || {};
        const r = await ser.serialize(x, meth.return);
        return { result: utils.encodeBase64url(r) };
      }
      throw new Error("unexpected call " + name);
    },
  };
}

test("the Vault v6 interface has the reads the recorder uses, and deployment.json lists the Bracket's results source", () => {
  for (const m of ["get_game_player", "get_state"]) { assert.ok(abi.methods[m], m); assert.equal(abi.methods[m].read_only, true); }
  assert.equal(dep.vaultGames["9"].results, "games-data:bracket/vault");
});

test("stakes read through the real interface: staked (entry or week stake), held (the Vault's peak-stake rule), the Vault's minimum", async () => {
  const V = 100000000n;
  const players = {
    [P(1)]: { entry: { stake: String(2n * V), peak_stake: String(2n * V) }, week_stake: String(2n * V) },   // staked
    [P(2)]: { entry: { stake: "0", peak_stake: String(3n * V) }, week_stake: "0" },                          // withdrew: held
    [P(3)]: { active_stake: "0" },                                                                            // free
  };
  const ps = [P(1), P(2), P(3)];
  const s = await rec.readStaked(fakeNode(V, 0n, 0, players), ps, 5);
  assert.deepEqual(JSON.parse(JSON.stringify(s)), { staked: [P(1)], held: [P(1), P(2)] });
  // the minimum rises to 3 VHP from week 5: 2 VHP no longer counts as staked, and P(2)'s 3 VHP peak still holds
  const s2 = await rec.readStaked(fakeNode(V, 3n * V, 5, players), ps, 5);
  assert.deepEqual(JSON.parse(JSON.stringify(s2)), { staked: [], held: [P(2)] });
  // …but not for an earlier week
  const s3 = await rec.readStaked(fakeNode(V, 3n * V, 6, players), ps, 5);
  assert.deepEqual(JSON.parse(JSON.stringify(s3)).staked, [P(1)]);
});

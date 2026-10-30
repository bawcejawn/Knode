// RepoLens round 3, BX-61 (High): the vault v6 ABI that the Block X recorder and page load
// (game/abi/kpred-v6.koilib.json) was not in git, and the recorder loaded it before its "is v6 live?" check, so on
// mainnet every target failed and was voided. The other tests inject fake stake readers, so nothing caught it.
//
// These tests use the REAL file on disk and the recorder's own vault reader (no stakeOf / rankedOf injected): a fake
// node answers get_state and get_game_player with protobuf bytes written by hand from the vault's proto.
// Before the fix: the file is missing (ENOENT), git doesn't track it, and readVault throws even when v6 isn't live.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { utils, Signer } from "koilib";
const addr = (seed) => Signer.fromSeed(seed).getAddress();

const APP = process.env.APP || ".";
const BX = await import(path.resolve(APP, "bot/games/blockx.ts"));
const M = globalThis.KRaceMath, X = globalThis.KBlockX;

// ── protobuf by hand (field numbers from vault-v6-next game/assembly/proto/kpred.proto) ──
const varint = (n) => { n = BigInt(n); const out = []; do { let b = Number(n & 0x7fn); n >>= 7n; if (n) b |= 0x80; out.push(b); } while (n); return out; };
const fU64 = (id, v) => [...varint((id << 3) | 0), ...varint(v)];
const fMsg = (id, bytes) => [...varint((id << 3) | 2), ...varint(bytes.length), ...bytes];
const b64 = (bytes) => utils.encodeBase64url(new Uint8Array(bytes));
function fieldsOf(buf) {               // { field: bytes | bigint } of a flat message
  const out = {}; let i = 0;
  const rd = () => { let r = 0n, s = 0n; for (;;) { const b = buf[i++]; r |= BigInt(b & 0x7f) << s; if (!(b & 0x80)) return r; s += 7n; } };
  while (i < buf.length) { const tag = Number(rd()), f = tag >> 3, w = tag & 7; if (w === 0) out[f] = rd(); else if (w === 2) { const n = Number(rd()); out[f] = buf.slice(i, i + n); i += n; } else throw new Error("wire " + w); }
  return out;
}
const V = 100000000n;
const VAULT = addr("r3-vault");
/** A fake node: the vault is live (v6_rule_week_plus_one = 4, min_stake 1 VHP) or not; each player's answer. */
function fakeNode({ live = true, players = {} } = {}) {
  const asked = [];
  return {
    asked,
    async readContract(op) {
      asked.push(op.entry_point);
      if (op.contract_id !== VAULT) throw new Error("unexpected contract " + op.contract_id);
      if (op.entry_point === 1023583049) {                         // get_state → config (field 1)
        const cfg = [...fMsg(1, [...utils.decodeBase58(VAULT)]), ...fU64(9, V), ...(live ? fU64(21, 4) : []), ...fU64(22, 3)];   // owner (field 1): audit BX-82   // field 22 (game_count): not in STATE_ABI, skipped
        return { result: b64(fMsg(1, cfg)) };
      }
      if (op.entry_point === 267077419) {                          // get_game_player(player 1, game 2, week 3)
        const a = fieldsOf(utils.decodeBase64url(op.args));
        const who = utils.encodeBase58(a[1]);
        assert.equal(Number(a[2]), 2, "asks about game 2");
        const p = players[who] || {};
        const entry = p.entry ? fMsg(2, [...fU64(1, p.entry.stake || 0n), ...fU64(7, p.entry.peak || 0n)]) : [];
        return { result: b64([...fMsg(1, fU64(1, p.active || 0n)), ...entry, ...fU64(3, p.active || 0n), ...fU64(4, p.week || 0n)]) };
      }
      throw new Error("unexpected entry point " + op.entry_point);
    },
    async getHeadInfo() { throw new Error("not used"); },
  };
}

test("BX-61: the v6 ABI file is in git and has get_game_player (active_stake 3, week_stake 4) and the entry's peak_stake (7)", () => {
  const f = path.resolve(APP, "game/abi/kpred-v6.koilib.json");
  assert.ok(fs.existsSync(f), "game/abi/kpred-v6.koilib.json exists");
  execFileSync("git", ["ls-files", "--error-unmatch", "game/abi/kpred-v6.koilib.json"], { cwd: APP, stdio: "pipe" });   // throws if untracked
  const abi = JSON.parse(fs.readFileSync(f, "utf8"));
  const t = abi.koilib_types.nested.kpred.nested;
  assert.equal(abi.methods.get_game_player.entry_point, 267077419);
  assert.equal(abi.methods.get_state.entry_point, 1023583049);
  assert.deepEqual([t.get_game_player_result.fields.active_stake.id, t.get_game_player_result.fields.week_stake.id], [3, 4]);
  assert.equal(t.get_game_player_result.fields.entry.type, "gentry_object");
  assert.equal(t.gentry_object.fields.peak_stake.id, 7);
  assert.equal(t.config_object.fields.v6_rule_week_plus_one.id, 21);
});

test("BX-61: readVault on the mainnet path decodes a real get_game_player answer, peak_stake included", async () => {
  const A = addr("r3-a"), B = addr("r3-b"), C = addr("r3-c");
  const node = fakeNode({ players: {
    [A]: { active: 0n, week: 0n, entry: { stake: 0n, peak: 4n * V } },     // withdrew everything mid-week: peak 4 VHP, so Staked
    [B]: { active: 0n, week: 0n, entry: { stake: 0n, peak: V / 2n } },     // never reached the minimum: Free play
    [C]: { active: 2n * V, week: 2n * V },                                  // no entry yet: the active stake counts
  } });
  const v = await BX.readVault(node, VAULT, 2, [A, B, C], 1);
  assert.equal(v.live, true);
  assert.equal(v.min, V);
  assert.equal(v.players.get(A).peak, 4n * V, "peak_stake (field 7) decoded from the real ABI");
  assert.equal(v.players.get(C).week, 2n * V, "week_stake (field 4) decoded");
  assert.deepEqual([...BX.stakedSet(v)].sort(), [A, C].sort());
});

test("BX-61: before v6 is live, nothing but get_state is read and the v6 ABI file is never needed", async () => {
  const node = fakeNode({ live: false });
  const v = await BX.readVault(node, VAULT, 2, [addr("r3-a")], 1, () => { throw new Error("ENOENT: no such file kpred-v6.koilib.json"); });
  assert.equal(v.live, false);
  assert.deepEqual(node.asked, [1023583049], "only the state was read");
});

// A full recorder run on the mainnet code path (no injected stake reader): the pick of a wallet staked in Block X
// (by peak_stake) is recorded as Staked, the target isn't voided, and there is no "no such file" problem.
const BIG = addr("r3-big"), MID = addr("r3-mid"), ALICE = addr("r3-alice"), BOB = addr("r3-bob");
const W3 = M.weekStart(3), H0 = 48_000_000;
const T = (h) => W3 + 3600000 + (h - H0) * 3000;
test("BX-61: a recorder run with the real vault reader records Staked picks and voids nothing", async () => {
  const rd = fs.mkdtempSync(path.join(os.tmpdir(), "r3-race-"));
  const CARD = { at: 0, c: 1, blocksPerRace: 7200, fairness: null, field: [{ a: BIG, vhp: 2000, k: 600, h: 1 }, { a: MID, vhp: 1000, k: 300, h: 2 }], paddock: [] };
  for (const w of [2, 3, 4]) {
    const races = [];
    for (let t = M.weekStart(w); t < M.weekStart(w + 1); t += M.RACE) { const i = M.raceIndex(t); races.push({ id: M.raceId(i), start: t, end: t + M.RACE, cards: Array.from({ length: 6 }, (_, l) => ({ ...CARD, samples: 36, at: t + l * 3600000 + 37 * 60000 })), result: null }); }
    fs.writeFileSync(path.join(rd, `W${String(w).padStart(3, "0")}.json`), JSON.stringify({ v: 1, week: w, start: M.weekStart(w), end: M.weekStart(w + 1), races }));
  }
  const node = fakeNode({ players: { [ALICE]: { active: 0n, week: 0n, entry: { stake: 0n, peak: 3n * V } } } });
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "r3-bx-")), lib = H0 + 3 * X.ROUND + 50;
  const log = console.log; console.log = () => {};
  let r;
  try {
    r = await BX.run({ p: node, check: null, out, raceDir: rd, picksContract: addr("r3-picks"), knodeGame: VAULT,
      blockOf: async (_n, h) => ({ signer: BIG, time: T(h) }),
      picksOf: async (_n, rr) => [{ player: ALICE, producer: BIG, time: T(rr * X.ROUND) - 3600000 }, { player: BOB, producer: MID, time: T(rr * X.ROUND) - 3600000 }],
      vhpMovesOf: async () => 0n,
      head: { height: lib + 60, time: T(lib + 60), lib } });
  } finally { console.log = log; }
  assert.ok(!r.problems.some((p) => /no such file|ENOENT/i.test(p)), r.problems.join("\n"));
  const ts = [...r.weeks.values()].flatMap((w) => w.targets);
  assert.ok(ts.length > 0 && ts.every((t) => !t.void), "targets recorded, none voided");
  for (const t of ts) {
    const a = t.picks.find((p) => p[0] === ALICE), b = t.picks.find((p) => p[0] === BOB);
    assert.equal(a[4], 1, "Alice (peak 3 VHP staked in Block X) is Staked");
    assert.equal(b[4], 0, "Bob is Free play");
  }
});

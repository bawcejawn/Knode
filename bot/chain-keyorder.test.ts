/**
 * The simulator orders storage keys as the chain does, bytewise (RepoLens fix-check 2, V2-1 / V2-5): exact reads keep
 * keys with high bytes apart, get_next / get_prev step in byte order, and the bot's player paging lists 120 players
 * (many with high-byte addresses, over three pages) exactly once each, in order.
 *
 * Run (after `npm run build:sim` in game/): node --import tsx --test bot/chain-keyorder.test.ts   (from the repo root)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { Signer, utils } from "koilib";
import { SimChain, pagePlayers } from "./chain.ts";

const NEW = "game/build/sim/contract.wasm";
const VHP = 100_000_000n;
const DAY = 86_400_000, WEEK = 7 * DAY;
const GENESIS = 1_800_000_000_000 - (1_800_000_000_000 % DAY);
const key = (s: string) => Signer.fromSeed(`keyorder ${s}`);

test("raw storage: high-byte keys stay apart; next and previous follow byte order", () => {
  const sim = new SimChain(key("c").getAddress(), NEW);
  const db = (sim as any).vm.db, sp = { id: 7, zone: new Uint8Array([1, 2]) };
  const ks = [[0x00, 0x87], [0x00, 0x89], [0x00, 0xe8], [0x00, 0x9a], [0x01, 0x00], [0x00, 0x05]].map((a) => new Uint8Array(a));
  for (const k of ks) db.putObject(sp, k, new Uint8Array([k[0], k[1]]));
  for (const k of ks) assert.deepEqual([...db.getObject(sp, k).value], [k[0], k[1]]);
  const seen: string[] = [];
  let k: Uint8Array = new Uint8Array(0);
  for (;;) { const o = db.getNextObject(sp, k); if (!o) break; seen.push(Buffer.from(o.key).toString("hex")); k = o.key; }
  assert.deepEqual(seen, ["0005", "0087", "0089", "009a", "00e8", "0100"]);
  assert.equal(Buffer.from(db.getPrevObject(sp, new Uint8Array([0x00, 0xe8])).key).toString("hex"), "009a");
  db.commitTransaction(); db.putObject(sp, new Uint8Array([9]), new Uint8Array([1])); db.rollbackTransaction();
  assert.equal(db.getObject(sp, new Uint8Array([9])), null, "rollback keeps byte order and drops the new key");
  assert.deepEqual([...db.getObject(sp, ks[2]).value], [0x00, 0xe8]);
});

test("list_players pages 120 players exactly once each, in byte order", { skip: !fs.existsSync(NEW) && `${NEW} missing: run npm run build:sim in game/` }, async () => {
  const contract = key("contract"), owner = key("owner"), operator = key("operator"), seed = key("seed");
  const sim = new SimChain(contract.getAddress(), NEW);
  await sim.init();
  sim.setHeight(1000, GENESIS - DAY);
  const ok = async (method: string, args: any, who: string) => { const r = await sim.sendAs([{ method, args }], [who]); assert.ok(r.ok, `${method}: ${r.error}`); };
  await ok("init", { owner: owner.getAddress(), operator: operator.getAddress(), seed_owner: seed.getAddress(), genesis_time: String(GENESIS),
    week_length: String(WEEK), close_delay: String(DAY / 2), settle_length: String(DAY), timelock_length: String(2 * DAY), min_stake: String(VHP), max_sponsor_rc: "0" }, contract.getAddress());
  const players = Array.from({ length: 120 }, (_, i) => key(`p${i}`).getAddress());
  const high = players.filter((a) => [...utils.decodeBase58(a)].slice(1, 6).some((b) => b >= 0x80)).length;
  assert.ok(high > 50, `most test addresses have high bytes (${high})`);
  for (const p of players) {
    await sim.ledgerSet(2, p, 10n * VHP);
    await sim.ledgerSet(3, p, 10n * VHP);
    await ok("deposit_vhp", { from: p, amount: String(VHP) }, p);
  }
  const rows = await pagePlayers(sim, 0);
  assert.equal(rows.length, 120);
  assert.deepEqual(new Set(rows.map((r) => r.address)), new Set(players));
  const hex = rows.map((r) => Buffer.from(utils.decodeBase58(r.address)).toString("hex"));
  assert.deepEqual(hex, [...hex].sort(), "in byte order");
});

test("fix-check 3: the patch loads from a path with a space (V3-1) and stays fast at 20,000 objects (V3-2)", async () => {
  const { createRequire } = await import("node:module");
  const { fileURLToPath, pathToFileURL } = await import("node:url");
  const req = createRequire(import.meta.url);
  const { patchDatabase } = req("../tools/mockvm-bytewise.cjs");
  const { MockVM } = req("@koinos/mock-vm");
  // A file URL with a space: fileURLToPath gives a real path ("sp ace"), unlike URL.pathname ("sp%20ace").
  const url = pathToFileURL("/tmp/sp ace/x.js");
  assert.equal(fileURLToPath(url), "/tmp/sp ace/x.js");
  const db = patchDatabase(new MockVM().db, fileURLToPath(url));   // resolves mock-vm from this repo all the same
  const sp = { id: 3 };
  const t0 = Date.now();
  for (let i = 0; i < 20_000; i++) { const k = new Uint8Array(4); new DataView(k.buffer).setUint32(0, i); db.putObject(sp, k, new Uint8Array([1])); }
  db.commitTransaction();
  db.rollbackTransaction();
  assert.ok(Date.now() - t0 < 20_000, "20,000 objects in key order, a commit and a rollback: no stack overflow, not slow");
  assert.ok(db.getObject(sp, new Uint8Array([0, 0, 0x4e, 0x1f])), "the last key is still there");
});

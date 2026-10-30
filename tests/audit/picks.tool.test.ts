// The Picks admin tool (bot/picks.ts): what it will upload (only the audited build on mainnet; on testnet only a build
// made from the audited source), the game settings it sends, the network checks, and the nonce it writes. Offline.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { buildGameConfig, uploadBuild, encodeNonce, network, mainnetGuard, uploadTx, assertAuditedContract, PICKS_SHA256, PICKS_ABI_SHA256, PICKS_V2_SHA256, PICKS_V2_ABI_SHA256, MAINNET_CHAIN_ID } from "../../bot/picks.ts";

const require = createRequire(import.meta.url);
const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "picks-tool-"));

test("the tool pins the same audited build as the Picks README and the testnet build script", () => {
  const readme = fs.readFileSync("picks/README.md", "utf8");
  assert.ok(readme.includes(PICKS_SHA256), "README Build line");
  const { AUDITED } = require("../../picks/scripts/build-testnet.cjs");
  assert.equal(AUDITED, PICKS_SHA256);
});

test("mainnet upload: only the audited build", () => {
  const d = tmp(), f = path.join(d, "c.wasm");
  fs.writeFileSync(f, Buffer.from("not the audited build"));
  assert.throws(() => uploadBuild(false, { mainnet: f, testnet: "", manifest: "" }), /not the audited Picks build/);
  assert.throws(() => uploadBuild(false, { mainnet: path.join(d, "missing.wasm"), testnet: "", manifest: "" }), /not found/);
  // (The Combo branch builds Picks v2, also audited: Repo Lens final audit 2026-10-30.)
  if (fs.existsSync("picks/build/release/contract.wasm")) assert.ok([PICKS_SHA256, PICKS_V2_SHA256].includes(uploadBuild(false).sha256));
});

test("testnet upload: only a build whose manifest says it came from the audited source, and never the mainnet build", () => {
  const d = tmp(), w = path.join(d, "t.wasm"), m = path.join(d, "manifest.json");
  const wasm = Buffer.from("a testnet build"); fs.writeFileSync(w, wasm);
  const good = { sha256: sha(wasm), auditedSha256: PICKS_SHA256, owner: "1HsM33pF8DbXPr8Vsd4vD7hQgvZ1SHY3Vv", timelockMs: 600000 };
  fs.writeFileSync(m, JSON.stringify(good));
  assert.equal(uploadBuild(true, { mainnet: "", testnet: w, manifest: m }).sha256, sha(wasm));
  fs.writeFileSync(m, JSON.stringify({ ...good, auditedSha256: "00".repeat(32) }));
  assert.throws(() => uploadBuild(true, { mainnet: "", testnet: w, manifest: m }), /not the audited/);
  fs.writeFileSync(m, JSON.stringify({ ...good, sha256: "11".repeat(32) }));
  assert.throws(() => uploadBuild(true, { mainnet: "", testnet: w, manifest: m }), /doesn't match its manifest/);
  assert.throws(() => uploadBuild(true, { mainnet: "", testnet: w, manifest: path.join(d, "none.json") }), /No testnet build/);
});

test("the testnet build changes exactly three lines of the audited source, and refuses the mainnet owner", () => {
  const { patchSource } = require("../../picks/scripts/build-testnet.cjs");
  const src = fs.readFileSync("picks/assembly/Picks.ts", "utf8");
  const r = patchSource(src, "1HsM33pF8DbXPr8Vsd4vD7hQgvZ1SHY3Vv", 10, 24);
  assert.equal(r.lines.length, 3);
  assert.deepEqual(r.changed.map((c: any) => c.name), ["INITIAL_OWNER", "TIMELOCK_MS", "EXPIRY_MS"]);
  const a = src.split("\n"), b = r.out.split("\n");
  assert.equal(a.filter((l, i) => l !== b[i]).length, 3, "nothing else differs");
  assert.match(r.out, /TIMELOCK_MS: u64 = 600000;/);
  assert.match(r.out, /EXPIRY_MS: u64 = 86400000;/);
  assert.throws(() => patchSource(src, "1635QUrBNDp7WqmFkRvrkGwjJXTtFvH717", 10, 24), /mainnet owner/);
  assert.throws(() => patchSource(src, "not-an-address", 10, 24), /Koinos address/);
  assert.throws(() => patchSource(src.replace("// 48 hours", "// two days"), "1HsM33pF8DbXPr8Vsd4vD7hQgvZ1SHY3Vv", 10, 24), /TIMELOCK_MS: expected exactly one line/);
});

test("the Block X game config: game 2 on mainnet is exactly the plan's settings; limits are checked before sending", () => {
  const c = buildGameConfig({ id: 2, name: "Who Signs Block X", round: 2400, offset: 0, lead: 100, ahead: 28900, picksPerDay: 30, maxChanges: 5 });
  assert.deepEqual(c, { id: 2, name: "Who Signs Block X", kind: 1, list_size: 1, number_min: "0", number_max: "0", lock_mode: 1, round_size: "2400", round_offset: "0",
    lead: "100", ahead: "28900", max_picks_per_day: 30, max_changes: 5, enabled: true });
  const base = { id: 92, name: "fast", round: 300, offset: 0, lead: 100, ahead: 3700, picksPerDay: 50, maxChanges: 5 };
  assert.throws(() => buildGameConfig({ ...base, lead: 99 }), /limits/);
  assert.throws(() => buildGameConfig({ ...base, ahead: 100 }), /limits/);
  assert.throws(() => buildGameConfig({ ...base, picksPerDay: 51 }), /1 to 50/);
  assert.throws(() => buildGameConfig({ ...base, id: 128 }), /1 to 127/);
  assert.throws(() => buildGameConfig({ ...base, name: "x".repeat(41) }), /1 to 40 bytes/);
  const mainnet = network(false);
  assert.equal(mainnet.games.length, 1, "on mainnet the tool registers only Who Signs Block X");
  assert.deepEqual(buildGameConfig(mainnet.games[0]), c);
  assert.equal(mainnet.owner, "1635QUrBNDp7WqmFkRvrkGwjJXTtFvH717");
});

test("testnet settings: the Foundation testnet, never the mainnet chain id", () => {
  const t = network(true);
  assert.equal(t.testnet, true);
  assert.equal(t.rpc[0], process.env.TESTNET_RPC || "https://testnet.koinosfoundation.org");
  assert.notEqual(t.chainId, MAINNET_CHAIN_ID);
  assert.ok(t.games.some((g: any) => g.id === 2), "game 2 with the real settings is on the testnet too");
});

test("nonces are written exactly as koilib writes them", async () => {
  // koilib's own getNextNonce, fed a fake node that reports nonce n − 1.
  const { Provider } = await import("koilib");
  for (const n of [1, 2, 127, 128, 300, 16384, 123456789]) {
    const p: any = new Provider(["http://127.0.0.1:1"]);
    p.call = async () => ({ nonce: encodeNonce(n - 1 || 0) });
    if (n === 1) p.call = async () => ({ nonce: "KAA" });   // value_type { uint64_value: 0 }
    assert.equal(encodeNonce(n), await p.getNextNonce("1HsM33pF8DbXPr8Vsd4vD7hQgvZ1SHY3Vv"), String(n));
  }
});

test("a mainnet send needs --mainnet on the command line every time, not only CONFIRM_MAINNET in .env (review #2)", () => {
  const was = process.env.CONFIRM_MAINNET;
  process.env.CONFIRM_MAINNET = "yes";
  try {
    assert.throws(() => mainnetGuard({ testnet: false }, true, ["node", "picks.ts", "announce", "2", "--send"]), /Did you mean --testnet/);
    assert.doesNotThrow(() => mainnetGuard({ testnet: false }, true, ["node", "picks.ts", "announce", "2", "--send", "--mainnet"]));
    assert.doesNotThrow(() => mainnetGuard({ testnet: false }, false, ["node", "picks.ts", "announce", "2"]), "a dry run needs nothing");
    assert.doesNotThrow(() => mainnetGuard({ testnet: true }, true, ["node", "picks.ts", "announce", "2", "--send", "--testnet"]));
    delete process.env.CONFIRM_MAINNET;
    assert.throws(() => mainnetGuard({ testnet: false }, true, ["node", "picks.ts", "announce", "2", "--send", "--mainnet"]), /CONFIRM_MAINNET/);
  } finally { if (was === undefined) delete process.env.CONFIRM_MAINNET; else process.env.CONFIRM_MAINNET = was; }
});

test("upload: another wallet pays the Mana, so the Picks wallet never needs KOIN (it could never move it out)", async () => {
  const { Signer, Provider } = await import("koilib");
  const picksW = Signer.fromSeed("picks wallet for the test"), payerW = Signer.fromSeed("payer wallet for the test");
  const p: any = new Provider(["http://127.0.0.1:1"]);
  const abi = JSON.parse(fs.readFileSync("picks/abi/picks.koilib.json", "utf8"));
  const tx: any = await uploadTx(p, picksW, payerW, new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]), abi, "EiAIKVvm6-V2qmsmUvPJy09vCCLbtn9lHFpwrJbcTIEWRQ==", 1000000000n, encodeNonce(1));
  const t = tx.transaction;
  assert.equal(t.header.payer, payerW.getAddress(), "the payer pays the Mana");
  assert.equal(t.header.rc_limit, "1000000000");
  const up = t.operations[0].upload_contract;
  assert.equal(up.contract_id, picksW.getAddress());
  assert.ok(up.authorizes_call_contract && up.authorizes_transaction_application && up.authorizes_upload_contract, "all three overrides on");
  const who = await Signer.recoverAddresses(t);
  assert.deepEqual(who.sort(), [picksW.getAddress(), payerW.getAddress()].sort(), "both signed");
  const src = fs.readFileSync("bot/picks.ts", "utf8");
  assert.ok(!/you can move it out afterwards/.test(src), "never tells the owner to fund the Picks wallet");
});

test("BX-21: the Picks ABI used for owner calls is pinned to the audited one", () => {
  // v1's ABI, or v2's (a superset: the Combo branch builds v2; Block X's calls encode the same bytes with either).
  assert.ok([PICKS_ABI_SHA256, PICKS_V2_ABI_SHA256].includes(sha(fs.readFileSync("picks/abi/picks.koilib.json"))));
  assert.match(fs.readFileSync("bot/picks.ts", "utf8"), /!\[PICKS_ABI_SHA256, PICKS_V2_ABI_SHA256\]\.includes\(sha256hex\(raw\)\)/);
});
test("BX-9/BX-20: the contract must check out on BOTH mainnet nodes before the owner signs", async () => {
  const good = { exists: true, hash: "0x1220" + PICKS_SHA256, call: true, tx: true, upload: true };
  const bad = { ...good, hash: "0x1220" + "11".repeat(32) };
  const A: any = { id: "a" }, B: any = { id: "b" };
  const meta = (byNode: Record<string, any>) => async (node: any) => byNode[node.id];
  assert.equal(await assertAuditedContract({ testnet: false, picks: "1P" }, A, meta({ a: good, b: good }) as any, undefined, [B]), 2);
  await assert.rejects(assertAuditedContract({ testnet: false, picks: "1P" }, A, meta({ a: good, b: bad }) as any, undefined, [B]), /node 2 of 2/);
  const src = fs.readFileSync("bot/picks.ts", "utf8");
  assert.match(src, /Do not announce games/);
  assert.match(src, /holds \$\{showKoin\(held\)\} KOIN/, "BX-22: a Picks wallet holding KOIN is refused");
});

test("audit BX-47: the check node must be a different node from the primary", async () => {
  const { sameNode } = await import("../../bot/picks.ts");
  assert.equal(sameNode("https://api.koinosblocks.com/", "https://API.koinosblocks.com"), true);
  assert.equal(sameNode("https://koinos.armana.io", "https://api.koinosblocks.com"), false);
  const src = fs.readFileSync("bot/picks.ts", "utf8");
  assert.match(src, /is the same node as RPC: the check needs a second, independent node/);
  assert.match(src, /rpc: \[E\.RPC \|\| MAINNET_RPCS\[0\]\]/, "one primary node (no quiet fallback to the check node)");
});

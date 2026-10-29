// Survivor testnet tool (bot/survivor-test.ts) and the test clock (KSurvivor.withConfig): the mainnet game is unchanged,
// the testnet Picks build differs from the audited source in exactly two constants, game 3's testnet settings fit the
// contract's rules and the recorder's check, the test page swaps only the wallet and adds the banner, and the local
// test server serves this PC only, never a key file, and signs nothing but a Survivor pick for the chosen test player.
// The whole flow against a fake testnet is tools/survivor-testnet/rehearse.mjs (slower; run by hand).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const APP = process.env.APP || ".";
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "survivor-testnet-"));
process.env.SURVIVOR_TEST_DIR = DIR;
const T = await import(path.resolve(APP, "bot/survivor-test.ts"));
const R = await import(path.resolve(APP, "bot/games/survivor.ts"));
const { startFakeTestnet, randomAddress } = await import(path.resolve(APP, "tools/survivor-testnet/fake-testnet.mjs"));
const { Signer } = await import("koilib");
const S = globalThis.KSurvivor;
const plain = (x) => JSON.parse(JSON.stringify(x));

test("the mainnet game is unchanged by the test clock", () => {
  assert.equal(S.DAY, 86400000); assert.equal(S.FIRST_DAY, null); assert.equal(S.MIN_FORM, 280); assert.equal(S.AHEAD_MS, 7 * 86400000);
  assert.equal(S.CORRECTION_MS, 12 * 3600000); assert.equal(S.OUT_FLOOR, 0); assert.equal(S.MAINNET, true); assert.equal(S.LEAD_MS, 300000);
  assert.deepEqual(Array.from({ length: 14 }, (_, i) => S.outSize(17, i + 1)), [4, 4, 4, 5, 5, 5, 6, 6, 6, 7, 7, 7, 8, 8]);
  assert.equal(S.outSize(3, 1), 0, "no floor on mainnet");
  assert.ok(Object.isFrozen(S));
  assert.equal(S.isSeasonStart(S.dayIndex(Date.parse("2026-11-16T00:00:00Z"))), true);
  assert.equal(S.isSeasonStart(S.dayIndex(Date.parse("2026-11-17T00:00:00Z"))), false, "mainnet seasons start on a Monday");
});

test("the test clock: one round = 1 hour; everything that depends on the day scales, the 5-minute lock doesn't", () => {
  const Q = S.withConfig({ day: 3600000, firstDay: 500000, outFloor: 1 });
  assert.equal(Q.MAINNET, false); assert.equal(Q.LEAD_MS, 300000); assert.equal(Q.AHEAD_MS, 7 * 3600000); assert.equal(Q.CORRECTION_MS, 1800000);
  assert.equal(Q.MIN_FORM, 12); assert.equal(Q.FIRST_DAY, 500000);
  assert.equal(Q.outSize(3, 1), 1, "the floor keeps one producer out in a small field");
  assert.equal(Q.outSize(1, 1), 0, "never the whole field");
  assert.equal(Q.lockTime(500000), 500000 * 3600000 - 300000);
  assert.equal(Q.isSeasonStart(500001), true, "a test season can start on any round");
  for (const bad of [{ day: 60000 }, { day: 3600001 }, { day: 2 * 86400000 }, { outFloor: 4 }, { firstDay: 1.5 }]) assert.throws(() => S.withConfig(bad), /Survivor/);
});

test("the testnet Picks build: the audited source with exactly two constants changed", () => {
  const src = fs.readFileSync(path.join(APP, "picks/assembly/Picks.ts"), "utf8");
  const owner = randomAddress(), out = T.patchPicksSource(src, owner);
  const a = src.split("\n"), b = out.split("\n");
  assert.equal(a.length, b.length);
  const diff = a.map((l, i) => [l, b[i]]).filter(([x, y]) => x !== y);
  assert.equal(diff.length, 2);
  const changed = diff.map((d) => d[1]).join("\n");
  assert.match(changed, new RegExp(`INITIAL_OWNER: Uint8Array = Base58\\.decode\\("${owner}"\\)`));
  assert.match(changed, /TIMELOCK_MS: u64 = 600000;   \/\/ TESTNET BUILD: 10 minutes, not 48 hours$/m);
  assert.throws(() => T.patchPicksSource(src.replace("1635QUrBNDp7WqmFkRvrkGwjJXTtFvH717", "1x"), owner), /changed/);
  assert.throws(() => T.patchPicksSource(src, "not-an-address"), /address/);
});

test("game 3's testnet settings fit the Picks contract's rules and pass the recorder's check", () => {
  const g = T.testGame(3600000);
  assert.equal(g.kind, 1); assert.equal(g.list_size, 1, "a one-producer game has list_size 1"); assert.equal(g.lock_mode, 2);
  assert.ok(Number(g.lead) >= 300000 && Number(g.ahead) > Number(g.lead) && Number(g.ahead) <= 35 * 86400000);
  assert.ok(g.max_picks_per_day >= 24 && g.max_picks_per_day <= 50, "an hourly round needs 24+ picks a day; the contract allows 50");
});

test("the recorder accepts the testnet game 3 with the test clock, and refuses it with the mainnet one", async () => {
  // gameProblem reads the clock of the last run: a run with the test math sets it.
  const Q = S.withConfig({ day: 3600000, firstDay: null, outFloor: 1 });
  await R.run({ p: "p", check: null, out: fs.mkdtempSync(path.join(os.tmpdir(), "sv-")), firstDay: null, picksContract: null, math: Q,
    blocksOf: async () => ({ ts: [], signers: [] }), timeOf: async () => 0, head: { height: 100, time: 1000, lib: 50, libTime: 500 } }).catch(() => {});
  assert.equal(R.gameProblem(plain(T.testGame(3600000))), "");
  await R.run({ p: "p", check: null, out: fs.mkdtempSync(path.join(os.tmpdir(), "sv-")), firstDay: null, picksContract: null,
    blocksOf: async () => ({ ts: [], signers: [] }), timeOf: async () => 0, head: { height: 100, time: 1000, lib: 50, libTime: 500 } }).catch(() => {});
  assert.match(R.gameProblem(plain(T.testGame(3600000))), /round_size/, "the mainnet recorder refuses a 1-hour round");
});

test("robot players and the first round a season can start on", () => {
  const f = ["A", "B", "C", "D"].map((c, i) => ({ a: "1" + c.repeat(33), k: 100 - i }));
  assert.equal(T.botChoice("p2", f, new Set(), 10), f[0].a);
  assert.equal(T.botChoice("p2", f, new Set([f[0].a]), 10), f[1].a, "never a used producer");
  assert.equal(T.botChoice("p5", f, new Set(), 10), f[3].a);
  assert.equal(T.botChoice("p6", f, new Set(), 9), null, "p6 skips every third day of the season");
  assert.notEqual(T.botChoice("p6", f, new Set(), 1), null, "p6 always joins on day 1");
  assert.equal(T.botChoice("p1", f, new Set(), 10), null, "p1 is yours");
  assert.equal(T.botChoice("p2", f, new Set(f.map((x) => x.a)), 10), null);
  const Q = S.withConfig({ day: 3600000 });
  const now = 500000 * 3600000 + 50 * 60000;                       // 50 minutes into a round: the next one locks in 5
  assert.equal(T.nextStart(Q, now), 500002, "too close to the next lock: the one after");
  assert.equal(T.nextStart(Q, 500000 * 3600000 + 10 * 60000), 500001);
});

test("the test page: survivor.html with the banner, the test settings and the test wallet; same CSP", () => {
  const html = fs.readFileSync(path.join(APP, "site/survivor.html"), "utf8"), out = T.testPage(html);
  const csp = (h) => /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(h)[1];
  assert.equal(csp(out), csp(html));
  assert.match(out, /<title>TESTNET · /);
  assert.match(out, /class="tn-bar"/);
  for (const real of ["guest.js", "wallet.js", "header-wallet.js"]) assert.ok(!out.includes(`<script src="${real}"></script>`), real);
  assert.ok(out.indexOf("/testnet/survivor-net.js") < out.indexOf("/testnet/test-wallet.js") && out.indexOf("/testnet/test-wallet.js") < out.indexOf('src="survivor.js"'));
  assert.ok(!/\son[a-z]+=/i.test(out.replace(html, "")), "no inline handlers added");
  // The real page never loads the test files.
  assert.ok(!html.includes("/testnet/"));
  assert.ok(!fs.readFileSync(path.join(APP, "site/survivor.js"), "utf8").includes("KSurvivorNet =") );
});

// ── the local test server ──
const keyLines = () => ["OWNER", "PICKS", "P1", "P2", "P3", "P4", "P5", "P6"].map((w) => `${w}_WIF=${new Signer({ privateKey: crypto.randomBytes(32).toString("hex") }).getPrivateKey("wif")}`).join("\n") + "\n";
async function withServer(fn) {
  const fake = await startFakeTestnet({ abiFile: path.join(APP, "picks/abi/picks.koilib.json"), producers: [[randomAddress(), 1]] });
  fs.writeFileSync(path.join(DIR, "keys.env"), keyLines());
  fs.writeFileSync(path.join(DIR, "config.json"), JSON.stringify({ v: 1, rpc: fake.url, chainId: "EiAIKVvm6-V2qmsmUvPJy09vCCLbtn9lHFpwrJbcTIEWRQ==", koin: fake.koin, vhp: fake.vhp, holdToken: fake.vhp,
    clock: { day: 3600000, firstDay: null, outFloor: 1 }, picks: { contract: randomAddress(), sha256: "x" }, game: null }));
  fs.mkdirSync(path.join(DIR, "data"), { recursive: true });
  fs.writeFileSync(path.join(DIR, "data", "fields.json"), "{}");
  const port = 19000 + Math.floor(Math.random() * 900);
  const server = await T.startSite({ port });
  await new Promise((ok) => server.on("listening", ok));
  const base = `http://127.0.0.1:${port}`;
  try { await fn(base, port, fake); } finally { server.close(); await fake.close(); }
}
const quiet = async (f) => { const l = console.log; console.log = () => {}; try { return await f(); } finally { console.log = l; } };

test("the test server: this PC only, the site's files and the recorder's data, never a key file", async () => quiet(() => withServer(async (base, port) => {
  const get = (p, headers = {}) => fetch(base + p, { headers, redirect: "manual" });
  assert.equal((await get("/site/survivor-testnet.html")).status, 200);
  const page = await get("/site/survivor-testnet.html");
  assert.equal(page.headers.get("x-frame-options"), "DENY", "no framing (review TN-3)");
  assert.match(page.headers.get("content-security-policy") || "", /frame-ancestors 'none'/);
  for (const p of ["/site/index.html", "/site/race.html", "/site/blockx.html"]) assert.equal((await get(p)).status, 404, `${p}: only the TESTNET page is served (review TN-7)`);
  assert.equal((await get("/testnet-data/survivor/fields.json")).status, 200);
  for (const p of ["/testnet-data/survivor/keys.env", "/testnet-data/survivor/config.json", "/testnet-data/survivor/../keys.env", "/.env", "/site/../.env", "/site/..%2f.env",
    "/site/.env", "/bot/survivor-test.ts", "/testnet-data/survivor/data/../keys.env", "/site/%2e%2e/testnet-data/survivor/keys.env"]) {
    const r = await get(p);
    assert.notEqual(r.status, 200, p);
    assert.ok(!(await r.text()).includes("_WIF="), `${p} leaks a key`);
  }
  // Another host name (DNS rebinding) is refused.
  const http = await import("node:http");
  const status = await new Promise((ok) => http.get({ host: "127.0.0.1", port, path: "/site/survivor-testnet.html", headers: { host: "evil.example" } }, (r) => ok(r.statusCode)));
  assert.equal(status, 403);
  // The settings script names addresses, never keys.
  const net = await (await get("/testnet/survivor-net.js")).text();
  assert.ok(!/WIF|privateKey|[5KL][1-9A-HJ-NP-Za-km-z]{50,51}/.test(net), "no keys in the page's settings");
  assert.match(net, /window\.KSurvivorNet = Object\.freeze/);
})));

test("the test server: no other website can use it, and it signs nothing but a Survivor pick", async () => quiet(() => withServer(async (base) => {
  const post = (p, body, headers = { origin: base }) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  assert.equal((await post("/rpc", { method: "chain.get_head_info" })).status, 200);
  assert.equal((await post("/rpc", { method: "chain.get_head_info" }, { origin: "https://evil.example" })).status, 403, "cross-site");
  assert.equal((await post("/rpc", { method: "chain.get_head_info" }, { origin: base, "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await post("/rpc", { method: "chain.submit_transaction", params: {} })).status, 403, "the page can't send transactions through /rpc");
  assert.equal((await post("/test/send", { token: "nope", as: "p1", ops: [] })).status, 403, "needs the session token");
  const token = (await (await fetch(base + "/testnet/session", { headers: { "sec-fetch-site": "same-origin" } })).json()).token;
  assert.equal((await fetch(base + "/testnet/session", { headers: { "sec-fetch-site": "cross-site" } })).status, 403);
  const cfg = JSON.parse(fs.readFileSync(path.join(DIR, "config.json"), "utf8"));
  const bad = [
    [{ token, as: "owner", ops: [{ call_contract: { contract_id: cfg.picks.contract, entry_point: 0x8ce33c6c, args: "" } }] }, /unknown test player/],
    [{ token, as: "p1", ops: [{ call_contract: { contract_id: cfg.koin, entry_point: 0x27f576ca, args: "" } }] }, /only Survivor picks/],
    [{ token, as: "p1", ops: [{ call_contract: { contract_id: cfg.picks.contract, entry_point: 0xf7d9b6c9, args: "" } }] }, /only Survivor picks/],
    [{ token, as: "p1", ops: [] }, /exactly one/],
  ];
  for (const [body, why] of bad) { const r = await post("/test/send", body); assert.equal(r.status, r.status >= 400 ? r.status : 400); assert.match(await r.text(), why); }
  // A pick for another player (or another game) is refused after decoding.
  const { Contract, Provider } = await import("koilib");
  const abi = JSON.parse(fs.readFileSync(path.join(APP, "picks/abi/picks.koilib.json"), "utf8"));
  const pc = new Contract({ id: cfg.picks.contract, abi, provider: new Provider(["http://127.0.0.1:1"]) });
  for (const args of [{ player: randomAddress(), game: 3, round: "5", producers: [randomAddress()], number: "0" }]) {
    const { operation } = await pc.functions.pick(args, { onlyOperation: true });
    const r = await post("/test/send", { token, as: "p1", ops: [operation] });
    assert.equal(r.status, 400); assert.match(await r.text(), /isn't a Survivor pick for this test player/);
  }
})));

test("the tool refuses mainnet: by node name and by chain id", async () => {
  for (const rpc of ["https://api.koinos.io", "https://koinos.armana.io", "https://api.koinosblocks.com"]) await assert.rejects(T.testnetProvider({ rpc }), /mainnet/i);
  const http = await import("node:http");
  const srv = http.createServer((req, res) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => { res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { chain_id: T.MAINNET_CHAIN_ID } })); }); });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  await assert.rejects(T.testnetProvider({ rpc: `http://127.0.0.1:${srv.address().port}` }), /MAINNET/);
  await assert.rejects(T.testnetProvider({ rpc: `http://127.0.0.1:${srv.address().port}`, chainId: "other" }), /MAINNET/);
  srv.close();
});

test("review TN-1: the test server won't start against a node that reports the mainnet chain id", async () => {
  const http = await import("node:http");
  const srv = http.createServer((req, res) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => { res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { chain_id: T.MAINNET_CHAIN_ID } })); }); });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  fs.writeFileSync(path.join(DIR, "keys.env"), keyLines());
  fs.writeFileSync(path.join(DIR, "config.json"), JSON.stringify({ v: 1, rpc: `http://127.0.0.1:${srv.address().port}`, chainId: "EiAIKVvm6-V2qmsmUvPJy09vCCLbtn9lHFpwrJbcTIEWRQ==", koin: "1FaSvLjQJsCJKq5ybmGsMMQs8RQYyVv8ju", vhp: null, holdToken: null,
    clock: { day: 3600000, firstDay: null, outFloor: 1 }, picks: null, game: null }));
  await assert.rejects(T.startSite({ port: 19950 }), /MAINNET/);
  srv.close();
});

test("the test page takes the next free port when its port is busy (8090 is the owner's Koinos node)", async () => {
  const net = await import("node:net");
  const busy = net.createServer();
  const port = await new Promise((ok) => busy.listen(0, "127.0.0.1", () => ok(busy.address().port)));
  const got = await T.freePort(port);
  assert.ok(got > port && got < port + 20, `${got}`);
  busy.close();
  assert.equal(fs.readFileSync(path.join(APP, "bot/survivor-test.ts"), "utf8").match(/process\.env\.SURVIVOR_TEST_PORT \|\| (\d+)\)/)[1], "8370");
});

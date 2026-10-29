// The Fantasy testnet practice kit (bot/fantasy-test.ts): the practice page it serves, the robots, the game settings,
// and the local server's signing rules, against a fake testnet (no internet). The whole flow is rehearsed by
// tools/fantasy-testnet/rehearse.mjs (about 5 minutes; not part of this suite).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const APP = process.env.APP || ".";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fantasy-kit-"));
const { startFakeChain, makeClock, randomAddress, TESTNET_CHAIN_ID } = await import(path.resolve(APP, "tools/fantasy-testnet/fake-chains.mjs"));
const clock = makeClock();
const test1 = await startFakeChain({ name: "t", clock, chainId: TESTNET_CHAIN_ID, producers: [[randomAddress(), 1, 0]], blockMs: 3000, historyMs: 600000, picksAbiFile: path.resolve(APP, "picks/abi/picks.koilib.json") });
process.env.FANTASY_TEST_DIR = dir;
process.env.FANTASY_TEST_RPC = test1.url;
const kit = await import(path.resolve(APP, "bot/fantasy-test.ts"));
kit.quiet(() => {});
const R = globalThis.KRaceMath, FR = globalThis.KFantasyMath;
const html = fs.readFileSync(path.resolve(APP, "site/fantasy.html"), "utf8");

test("practice page: the TESTNET bar, the test settings and test wallet instead of the real wallet", () => {
  const p = kit.testPage(html);
  assert.match(p, /<title>TESTNET · /);
  assert.match(p, /class="tn-bar"/);
  assert.match(p, /\/testnet\/fantasy-net\.js[\s\S]*\/testnet\/test-wallet\.js[\s\S]*race-math\.js[\s\S]*fantasy-math\.js[\s\S]*fantasy\.js/);
  for (const real of ['src="guest.js"', 'src="wallet.js"', 'src="header-wallet.js"']) assert.ok(!p.includes(real), `no ${real}`);
});

test("game settings: the contract's rules, the same shape whenever the test week starts", () => {
  const c = { clock: { day: 3600000, genesis: null, sheetBefore: 1800000 }, games: { team: 4, rival: 5 } };
  const g = kit.testGames(c);
  assert.equal(g.team.kind, 2); assert.equal(g.team.list_size, 5); assert.equal(g.team.lock_mode, 2);
  assert.equal(g.team.round_size, "3600000"); assert.equal(g.team.lead, "300000"); assert.equal(g.team.ahead, String(7 * 3600000));
  assert.equal(g.rival.kind, 1); assert.equal(g.rival.round_size, "3600000"); assert.equal(g.rival.round_offset, "0");
  assert.ok(g.team.max_picks_per_day <= 50 && g.rival.max_picks_per_day <= 50);
});

test("robots: every team they make is valid, and after Monday they change at most one thing a day", () => {
  const pool = Array.from({ length: 14 }, (_, i) => ({ a: "1" + String.fromCharCode(65 + i).repeat(33), form: 80 + i * 3, price: [40, 35, 33, 30, 28, 24, 21, 20, 18, 14, 11, 9, 8, 8][i] }));
  const sheet = { week: 0, at: 0, budget: 100, median: 98, pool };
  const F = FR.withClock({ day: 3600000, genesis: 0, sheetBefore: 1800000 });
  const info = { yesterday: (a) => pool.find((p) => p.a === a).form, size: (a) => pool.findIndex((p) => p.a === a) };
  const best = kit.bestTeam(pool, 100, (a) => pool.find((p) => p.a === a).form);
  assert.ok(F.checkTeam(sheet, best).ok);
  let rnd = 1; const rand = () => (rnd = (rnd * 16807) % 2147483647) / 2147483647;
  for (const who of Object.keys(kit.ROBOTS)) {
    let prev = null, played = false;
    for (let day = 0; day < 14; day++) {
      const t = kit.robotTeam(who, F, sheet, prev, info, day % 7, rand, played);
      if (!t) { assert.ok(who === "p6" && !played && day < 2, `${who} skips only as the late joiner`); continue; }
      assert.ok(F.checkTeam(sheet, t).ok, `${who} day ${day}: ${F.checkTeam(sheet, t).why}`);
      if (prev && day % 7 !== 0) assert.ok(F.changes(prev, t) <= 1, `${who} day ${day}: one change a day`);
      prev = t; played = true;
    }
  }
});

let server, origin, keys, cfg;
test("local server: serves the page and data only, never the keys; refuses other sites", async () => {
  await kit.setup();
  keys = kit.readKeys();
  cfg = kit.readConfig();
  test1.picks.owner = kit.addressOf(keys, "owner");
  test1.faucet(kit.addressOf(keys, "p1"), 10); test1.faucet(kit.addressOf(keys, "owner"), 10);
  cfg.picks = { contract: kit.addressOf(keys, "picks"), sha256: "x" };
  cfg.clock.genesis = Math.ceil(clock.now() / 3600000) * 3600000 + 3600000;
  kit.writeConfig(cfg);
  // The fake testnet: the Picks contract "uploaded" at the Picks wallet, both games in force.
  test1.markUploaded(cfg.picks.contract);
  test1.picks.games.set(4, kit.testGames(cfg).team); test1.picks.games.set(5, kit.testGames(cfg).rival);
  server = await kit.startSite({ port: 0 });
  origin = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${origin}/site/fantasy-testnet.html`)).status, 200);
  const net = await (await fetch(`${origin}/testnet/fantasy-net.js`)).text();
  assert.match(net, /window\.KFantasyNet/);
  assert.ok(!/WIF|privateKey|5[HJK][1-9A-Za-z]{49}/.test(net), "no keys in the page's settings");
  for (const bad of ["/keys.env", "/testnet-data/fantasy/keys.env", "/testnet-data/fantasy/config.json", "/.env.testnet", "/site/../package.json", "/bot/fantasy-test.ts"]) assert.equal((await fetch(origin + bad)).status, 404, bad);
  assert.equal((await fetch(`${origin}/rpc`, { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: JSON.stringify({ method: "chain.get_head_info" }) })).status, 403);
  assert.equal((await fetch(`${origin}/rpc`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ method: "chain.submit_transaction" }) })).status, 403, "the RPC proxy reads only");
  const http = await import("node:http");
  const viaHost = (host) => new Promise((ok, bad) => { const r = http.request({ host: "127.0.0.1", port: server.address().port, path: "/site/fantasy-testnet.html", headers: { host } }, (res) => { res.resume(); ok(res.statusCode); }); r.on("error", bad); r.end(); });
  assert.equal(await viaHost("evil.example"), 403, "another host name (DNS rebinding)");
  assert.equal(await viaHost(`localhost:${server.address().port}`), 403, "only 127.0.0.1, exactly");
});

test("local server: signs only a Fantasy team or rival pick for the chosen test player", async () => {
  const { token } = await (await fetch(`${origin}/testnet/session`)).json();
  const { Contract, Provider } = await import("koilib");
  const abi = JSON.parse(fs.readFileSync(path.resolve(APP, "picks/abi/picks.koilib.json"), "utf8"));
  const pc = new Contract({ id: cfg.picks.contract, abi, provider: new Provider([test1.url]) });
  const p1 = kit.addressOf(keys, "p1"), p2 = kit.addressOf(keys, "p2");
  const op = async (args) => (await pc.functions.pick({ number: "0", ...args }, { onlyOperation: true })).operation;
  const post = (body) => fetch(`${origin}/test/send`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });
  const prods = Array.from({ length: 5 }, () => randomAddress());
  const F = kit.mathOf(cfg), d0 = F.weekDays(0)[0];
  assert.equal((await post({ token: "wrong", as: "p1", ops: [await op({ player: p1, game: 4, round: String(d0), producers: prods })] })).status, 403, "the page's token");
  assert.equal((await post({ token, as: "p9", ops: [await op({ player: p1, game: 4, round: String(d0), producers: prods })] })).status, 400, "a known test player");
  assert.equal((await post({ token, as: "p1", ops: [await op({ player: p2, game: 4, round: String(d0), producers: prods })] })).status, 400, "only for the player who signs");
  assert.equal((await post({ token, as: "p1", ops: [await op({ player: p1, game: 3, round: String(d0), producers: [prods[0]] })] })).status, 400, "only Fantasy's games");
  assert.equal((await post({ token, as: "p1", ops: [await op({ player: p1, game: 4, round: String(d0), producers: prods.slice(0, 4) })] })).status, 400, "a team is 5");
  assert.equal((await post({ token, as: "p1", ops: [await op({ player: p1, game: 5, round: String(F.rivalRound(0)), producers: [p1] })] })).status, 400, "no rival challenge to yourself");
  const other = { call_contract: { ...(await op({ player: p1, game: 4, round: String(d0), producers: prods })).call_contract, contract_id: randomAddress() } };
  assert.equal((await post({ token, as: "p1", ops: [other] })).status, 400, "only the testnet Picks contract");
  const two = await op({ player: p1, game: 4, round: String(d0), producers: prods });
  assert.equal((await post({ token, as: "p1", ops: [two, two] })).status, 400, "exactly one operation");
  const ok = await post({ token, as: "p1", ops: [await op({ player: p1, game: 4, round: String(d0), producers: prods })] });
  assert.equal(ok.status, 200, JSON.stringify(await ok.clone().json()));
  assert.deepEqual(test1.picks.picks.get(`4|${d0}|${p1}`).producers, prods, "the team is on the (fake) testnet");
  const rv = await post({ token, as: "p1", ops: [await op({ player: p1, game: 5, round: String(F.rivalRound(0)), producers: [p2] })] });
  assert.equal(rv.status, 200);
});

test("guards: never a mainnet node for picks; the scoring node must be mainnet", async () => {
  await assert.rejects(kit.testnetProvider({ rpc: "https://koinos.armana.io" }), /mainnet node/);
  await assert.rejects(kit.mainnetReader(test1.url), /not Koinos mainnet/);
});

test.after(async () => { if (server) server.close(); await test1.close(); fs.rmSync(dir, { recursive: true, force: true }); void crypto; void R; });

// Last Node Standing on the testnet: the fast test game (93) recorded with picks from the TESTNET node only and the
// race from two MAINNET nodes; the testnet settings file; and the local test server's allowlist for its files.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const APP = process.env.APP || ".";
const { run, readNetConfig, MAINNET_CHAIN_ID } = await import(path.resolve(APP, "bot/games/lastnode.ts"));
const M = globalThis.KRaceMath, L0 = globalThis.KLastNode;
const F = L0.forGame(L0.FAST_GAME);

const A = (c) => "1" + c.repeat(33);
const [N1, N2, N3, N4] = ["A", "B", "C", "D"].map(A);
const [ALICE, BOB] = ["P", "Q"].map(A);
const EV = F.eventOf("2026-11-03T08"), CUT = F.CUT;

function raceDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "race-"));
  const card = { at: EV.cardTime + 60000, field: [{ a: N1, vhp: 4000, k: 1200 }, { a: N2, vhp: 2000, k: 600 }, { a: N3, vhp: 1000, k: 300 }, { a: N4, vhp: 1000, k: 300 }] };
  for (const w of [2, 3, 4]) {
    const races = [];
    for (let t = M.weekStart(w); t < M.weekStart(w + 1); t += M.RACE) {
      const cards = new Array(6).fill(null);
      if (t === M.raceStart(M.raceIndex(EV.cardTime))) cards[M.legOf(t, EV.cardTime, 6)] = card;
      races.push({ id: M.raceId(M.raceIndex(t)), start: t, end: t + M.RACE, cards, result: null });
    }
    fs.writeFileSync(path.join(d, `W${String(w).padStart(3, "0")}.json`), JSON.stringify({ v: 1, week: w, races }));
  }
  return d;
}
const GONE = [N3, N1, N2];
const windowOf = async (node, t0, t1) => {
  assert.ok(node === "main" || node === "check", "blocks come only from the two mainnet nodes");
  const i = (t0 - EV.start) / CUT;
  assert.ok(Number.isInteger(i) && t1 === t0 + CUT, "20-minute windows from the start");
  const c = { [N1]: 67, [N2]: 33, [N3]: 17, [N4]: 17 };
  for (let k = 0; k <= i && k < 3; k++) delete c[GONE[k]];
  return { from: i * 400, to: i * 400 + 399, counts: c };
};
const PICKS = { 0: [[ALICE, N4], [BOB, N3]], 2: [[BOB, N4]] };
const picksOf = async (node, round) => {
  assert.equal(node, "testnet", "picks come only from the testnet node");
  return (PICKS[round - EV.round] || []).map(([w, a]) => [w, a, EV.start - 3600000]);
};

test("the fast game: field, 20-minute cuts, jump, points; picks from the testnet, blocks from mainnet", async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "lns-tn-"));
  const r = await run({ p: "main", check: "check", pp: "testnet", pcheck: null, game: L0.FAST_GAME, picksContract: "1PicksPicksPicksPicksPicksPicks",
    raceDir: raceDir(), out, windowOf, picksOf, rankedOf: async (w) => new Set(w), trials: 300, now: { time: EV.start + 70 * 60000, libTime: EV.start + 61 * 60000 } });
  assert.deepEqual(r.problems, []);
  const d = JSON.parse(fs.readFileSync(path.join(out, "D2026-11-03T08.json"), "utf8"));
  assert.equal(d.hours.length, 3); assert.equal(d.winner, N4);
  assert.deepEqual(d.cuts.map((c) => c.a), [N3, N1, N2]);
  const p = Object.fromEntries(d.players.map((x) => [x.a, x]));
  assert.equal(p[ALICE].points, 3 + 5); assert.equal(p[BOB].jumpTo, N4); assert.equal(p[BOB].points, 2 + 3);
  const idx = JSON.parse(fs.readFileSync(path.join(out, "index.json"), "utf8"));
  assert.equal(idx.game, 93); assert.ok(idx.days.includes("2026-11-03T08"));
});

test("testnet/lastnode.json: the testnet, never mainnet; both games pass the contract's rules", () => {
  const c = readNetConfig(path.resolve(APP, "testnet/lastnode.json"));
  assert.notEqual(c.chainId, MAINNET_CHAIN_ID);
  assert.deepEqual(c.games.map((g) => g.id).sort(), [13, 93]);
  const real = c.games.find((g) => g.id === 13), want = L0.PICKS_GAME;
  assert.equal(real.cut, want.round_size); assert.equal(real.offset, want.round_offset); assert.equal(real.lead, want.lead); assert.equal(real.ahead, want.ahead);
  assert.equal(c.picksFrom, "testnet/blockx.json");
  const bad = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cfg-")), "x.json");
  fs.writeFileSync(bad, JSON.stringify({ ...c, chainId: MAINNET_CHAIN_ID }));
  assert.throws(() => readNetConfig(bad), /MAINNET/);
});

test("practice mode starts with the event running at the first run and never reads earlier ones", async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "lns-pr-"));
  const seen = [];
  const win = async (node, t0, t1) => { seen.push(t0); return windowOf(node, t0, t1); };
  const now = EV.start + 30 * 60000;
  await run({ p: "main", check: "check", pp: "testnet", pcheck: null, game: L0.FAST_GAME, practice: true, picksContract: "1PicksPicksPicksPicksPicksPicks",
    raceDir: raceDir(), out, windowOf: win, picksOf, rankedOf: async (w) => new Set(w), trials: 300, now: { time: now, libTime: now - 60000 } });
  assert.ok(seen.every((t) => t >= EV.start), "no window before the current event");
  const idx = JSON.parse(fs.readFileSync(path.join(out, "index.json"), "utf8"));
  assert.equal(idx.since, EV.start);
  assert.ok(idx.days.every((d) => F.eventOf(d).start >= EV.start), `days: ${idx.days}`);
  // A later run keeps the same start.
  const later = EV.start + 5 * 3600000;
  await run({ p: "main", check: "check", pp: "testnet", pcheck: null, game: L0.FAST_GAME, practice: true, picksContract: "1PicksPicksPicksPicksPicksPicks",
    raceDir: raceDir(), prev: out, out, windowOf: win, picksOf, rankedOf: async (w) => new Set(w), trials: 300, now: { time: later, libTime: later - 60000 } });
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, "index.json"), "utf8")).since, EV.start);
});

test("the local test server serves the Last Node Standing page, settings and recorder files, and nothing else", async () => {
  const { allowed } = await import(path.resolve(APP, "tools/testnet-site.mjs"));
  for (const ok of ["/lastnode-testnet.html", "/lastnode.js", "/testnet/lastnode.json", "/testnet-data/lastnode-93/board.json",
    "/testnet-data/lastnode-93/D2026-10-29T04.json", "/testnet-data/lastnode-13/D2026-10-29.json", "/testnet-data/lastnode-13/index.json"]) assert.ok(allowed(ok), ok);
  for (const bad of ["/testnet-data/lastnode-93/../../.env.testnet", "/testnet-data/lastnode-93/keys.json", "/testnet-data/race-cards/W001.json",
    "/testnet-data/lastnode-93/D2026-10-29T04.json.bak", "/testnet/lastnode.json/x", "/.env.testnet"]) assert.equal(allowed(bad), null, bad);
});

test("lastnode-testnet.html: testnet only for signing, mainnet only read; no mainnet wallet scripts", () => {
  const h = fs.readFileSync(path.resolve(APP, "lastnode-testnet.html"), "utf8");
  assert.match(h, /<meta name="kg-network" content="testnet">/); assert.match(h, /<meta name="robots" content="noindex, nofollow">/);
  for (const s of ["wallet.js", "guest.js", "header-wallet.js"]) assert.ok(!h.includes(`<script src="${s}">`), `no ${s}`);
  const order = ["testnet-wallet.js", "chain-blocks.js", "race-math.js", "lastnode-math.js", "board.js", "lastnode.js"].map((f) => h.indexOf(`<script src="${f}"></script>`));
  assert.ok(order.every((x, i) => x > 0 && (i === 0 || x > order[i - 1])), "script order");
  const csp = h.match(/http-equiv="Content-Security-Policy" content="([^"]*)"/)[1];
  assert.match(csp, /connect-src 'self' https:\/\/testnet\.koinosfoundation\.org https:\/\/koinos\.armana\.io https:\/\/api\.koinos\.io https:\/\/raw\.githubusercontent\.com\/bawcejawn\/Knode\/blocks-data\/ https:\/\/raw\.githubusercontent\.com\/bawcejawn\/Knode\/race-data\/ https:\/\/raw\.githubusercontent\.com\/bawcejawn\/Knode\/testnet-data\/;/);
  assert.doesNotMatch(h, /<script>(?!<\/script>)|\son[a-z]+="/);
  // The page script signs only through the wallet chosen for the page; on the test page that is the testnet wallet,
  // which refuses mainnet and anything but the testnet Picks contract.
  const js = fs.readFileSync(path.resolve(APP, "lastnode.js"), "utf8");
  assert.match(js, /const W = TESTNET \? window\.KTestWallet : window\.KWallet;/);
  assert.match(js, /if \(id === MAINNET_CHAIN_ID \|\| id !== cfg\.chainId\) throw/);
  assert.match(js, /picksContract = new lib\.Contract\(\{ id: bx\.picks, abi, provider: picksProvider \}\)/);
});

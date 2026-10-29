// Who Signs Block X (site/blockx-math.js, shared by the page and the recorder bot/games/blockx.ts): the lock and the
// 12 open targets (the Picks contract's rule), the capped score, the leaderboard order and the weekly prizes. Offline.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";

const APP = process.env.APP || ".";
const read = (f) => fs.readFileSync(`${APP}/site/${f}`, "utf8");
const box = { window: {} };
vm.runInNewContext(read("race-math.js") + "\n" + read("blockx-math.js"), box);
const X = box.window.KBlockX, RM = box.window.KRaceMath;
const plain = (x) => JSON.parse(JSON.stringify(x));

test("the same week and clock as the race and the game", () => {
  assert.equal(X.GENESIS, RM.GENESIS);
  assert.equal(X.WEEK, RM.WEEK);
  for (const t of [RM.GENESIS - 1, RM.GENESIS + 1, Date.parse("2026-11-02T00:00:00Z"), Date.parse("2026-11-08T23:59:59Z")]) assert.equal(X.weekOf(t), RM.weekOf(t));
});

test("the lock: a pick can land in block X − 101 at the latest", () => {
  const r = 20000, x = r * 2400;
  assert.equal(X.target(r), x);
  assert.equal(X.lockHeight(r), x - 100);
  assert.equal(X.isOpen(r, x - 101), true);
  assert.equal(X.isOpen(r, x - 100), false);
  assert.equal(X.isOpen(r, x), false);
  assert.equal(X.isOpen(r, x - 28900), true);
  assert.equal(X.isOpen(r, x - 28901), false);
  assert.equal(X.isOpen(0, 0), false);
});

test("exactly 12 targets are open at every height", () => {
  for (let h = 47_990_000; h < 48_010_000; h += 37) {
    const o = X.openRounds(h);
    assert.equal(o.length, 12, `height ${h}`);
    for (const r of o) assert.ok(X.isOpen(r, h));
    assert.ok(!X.isOpen(o[0] - 1, h) && !X.isOpen(o[11] + 1, h), `only those, at ${h}`);
    for (let i = 1; i < 12; i++) assert.equal(o[i], o[i - 1] + 1);
  }
});

test("the page offers a target only while its lock is more than 20 blocks away", () => {
  const x = 48_000_000;
  assert.ok(X.offerRounds(x - 121).includes(20000));
  assert.ok(!X.offerRounds(x - 120).includes(20000));
  assert.ok(X.openRounds(x - 120).includes(20000), "still open on chain");
});

const CARD = {
  field: [{ a: "1Big", vhp: 3_000_000, k: 600 }, { a: "1Mid", vhp: 1_500_000, k: 300 }, { a: "1Third", vhp: 1_000_000, k: 200 }],
  paddock: [{ a: "1Small", vhp: 100_000, k: 20 }],
};

test("score: min(3, top VHP ÷ picked VHP) for a correct pick, 0 for a wrong one; missing from the card scores ×1 (audit BX-3)", () => {
  assert.equal(X.multiplier(CARD, "1Big"), 1);
  assert.equal(X.multiplier(CARD, "1Mid"), 2);
  assert.equal(X.multiplier(CARD, "1Third"), 3);
  assert.equal(X.multiplier(CARD, "1Small"), 3, "capped (30× uncapped)");
  assert.equal(X.multiplier(CARD, "1New"), 1, "a fresh producer is never worth the cap");
  assert.equal(X.pointsOf(CARD, "1Mid", "1Mid"), 200);
  assert.equal(X.pointsOf(CARD, "1Mid", "1Big"), 0);
  assert.equal(X.pointsOf(CARD, null, "1Big"), 0);
  assert.equal(X.multiplier({ field: [{ a: "1A", vhp: 7 }, { a: "1B", vhp: 3 }] }, "1B"), 2.33, "2 decimals");
});

test("expected score is min(3 × share, top share): every producer with a third of the top's VHP is equally good", () => {
  const { m, top } = X.vhpOf(CARD);
  const total = [...m.values()].reduce((s, v) => s + v, 0);
  const ev = (a) => (m.get(a) / total) * X.multiplier(CARD, a);
  const best = top / total;
  for (const a of ["1Big", "1Mid", "1Third"]) assert.ok(Math.abs(ev(a) - best) < 1e-9, a);
  assert.ok(ev("1Small") < best / 3);
});

test("leaderboard: points, then more correct picks, then the earlier last correct pick", () => {
  const T = Date.parse("2026-11-03T10:00:00Z");
  const rows = [
    { player: "1A", height: 100, correct: true, pts: 300, pickTime: T },
    { player: "1B", height: 200, correct: true, pts: 150, pickTime: T },
    { player: "1B", height: 300, correct: true, pts: 150, pickTime: T },
    { player: "1C", height: 50, correct: true, pts: 300, pickTime: T },
    { player: "1D", height: 60, correct: false, pts: 0, pickTime: T },
  ];
  const b = plain(X.board(rows));
  assert.deepEqual(b.map((r) => r.player), ["1B", "1C", "1A", "1D"]);
  assert.equal(b[0].correct, 2);
  const p = plain(X.places(X.board(rows)));
  assert.deepEqual(p.map((r) => r.place), [1, 2, 3, 4]);
});

test("prizes: 2 VHP and 1 VHP to eligible players (picks on 3+ days, ≥1 point); ties split the places they cover", () => {
  const d = (n) => Date.parse(`2026-11-0${n}T12:00:00Z`);
  const days3 = (player, pts) => [3, 4, 5].map((n, i) => ({ player, height: 1000 + i, correct: i === 0 && pts > 0, pts: i === 0 ? pts : 0, pickTime: d(n) }));
  // A has the most points but picked on only 2 days: not eligible.
  const rows = [
    { player: "1A", height: 1, correct: true, pts: 900, pickTime: d(3) }, { player: "1A", height: 2, correct: false, pts: 0, pickTime: d(4) },
    ...days3("1B", 500), ...days3("1C", 400), ...days3("1D", 300), ...days3("1E", 0),
  ];
  assert.deepEqual(plain(X.prizes(rows)), [{ player: "1B", place: 1, vhp: 2 }, { player: "1C", place: 2, vhp: 1 }]);
  // two tied for 1st split 2 + 1
  const tie = [...days3("1B", 500), ...days3("1C", 500), ...days3("1D", 300)];
  for (const r of tie) if (r.player === "1C") r.height = r.height;   // same heights: a full tie
  assert.deepEqual(plain(X.prizes(tie)), [{ player: "1B", place: 1, vhp: 1.5 }, { player: "1C", place: 1, vhp: 1.5 }]);
  // a tie for 2nd splits the 1 VHP
  const tie2 = [...days3("1B", 500), ...days3("1C", 400), ...days3("1D", 400)];
  assert.deepEqual(plain(X.prizes(tie2)), [{ player: "1B", place: 1, vhp: 2 }, { player: "1C", place: 2, vhp: 0.5 }, { player: "1D", place: 2, vhp: 0.5 }]);
  // nobody eligible: no prizes
  assert.deepEqual(plain(X.prizes([...days3("1E", 0)])), []);
});

test("the cap keeps skill ahead of luck (seeded simulation on a 17-producer field)", () => {
  // 17 producers with a long tail, 84 targets a week; 20 thoughtful players pick among producers with ≥ a third of the
  // top's VHP; 20 long-shot players always pick from the 5 smallest. Thoughtful players should win most weeks.
  const vhp = [30, 22, 18, 14, 11, 9, 7, 6, 5, 4, 3, 2.5, 2, 1.5, 1, 0.7, 0.5].map((v) => v * 1e5);
  const card = { field: vhp.map((v, i) => ({ a: "1P" + i, vhp: v })) };
  const total = vhp.reduce((s, v) => s + v, 0);
  const R = RM.rng(20261027);
  const draw = () => { let x = R.next() * total; for (let i = 0; i < vhp.length; i++) { x -= vhp[i]; if (x < 0) return "1P" + i; } return "1P0"; };
  const good = vhp.map((v, i) => [v, i]).filter(([v]) => v >= vhp[0] / 3).map(([, i]) => "1P" + i);
  const long = ["1P12", "1P13", "1P14", "1P15", "1P16"];
  let thoughtfulWins = 0;
  const WEEKS = 200;
  for (let w = 0; w < WEEKS; w++) {
    const pts = new Map();
    for (let t = 0; t < 84; t++) {
      const signer = draw();
      for (let p = 0; p < 40; p++) {
        const pick = p < 20 ? good[Math.floor(R.next() * good.length)] : long[Math.floor(R.next() * long.length)];
        pts.set(p, (pts.get(p) || 0) + X.pointsOf(card, pick, signer));
      }
    }
    let best = -1, who = -1;
    for (const [p, v] of pts) if (v > best) { best = v; who = p; }
    if (who < 20) thoughtfulWins++;
  }
  assert.ok(thoughtfulWins / WEEKS > 0.8, `thoughtful players won ${thoughtfulWins} of ${WEEKS} weeks`);
});

test("blockx.html: strict CSP with the games-data and race-data branches, scripts from the site, no HTML sinks", () => {
  const h = read("blockx.html"), js = read("blockx.js");
  const csp = h.match(/http-equiv="Content-Security-Policy" content="([^"]*)"/)[1];
  assert.match(csp, /connect-src [^;]*https:\/\/raw\.githubusercontent\.com\/bawcejawn\/Knode\/games-data\//);
  assert.match(csp, /connect-src [^;]*https:\/\/raw\.githubusercontent\.com\/bawcejawn\/Knode\/race-data\//);
  assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/);
  assert.doesNotMatch(h, /<script>(?!<\/script>)|\son[a-z]+="/, "no inline scripts or handlers");
  const order = ["guest.js", "wallet.js", "header-wallet.js", "nav.js", "race-math.js", "blockx-math.js", "blockx.js"].map((f) => h.indexOf(`<script src="${f}"></script>`));
  assert.ok(order.every((x, i) => x > 0 && (i === 0 || x > order[i - 1])), "script order");
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
  // The pick it builds: game 2, one producer, number 0, for the wallet that is connected.
  assert.match(js, /functions\.pick\(\{ player: who, game: G\.GAME_ID, round: String\(r\), producers: \[producer\], number: "0" \}, \{ onlyOperation: true \}\)/);
  // It never offers a target within 20 blocks of its lock, and checks again right before sending.
  assert.match(js, /G\.offerRounds\(head\.height\)/);
  assert.match(js, /if \(!\(G\.lockHeight\(r\) - head\.height > 20\)\)/);
  // The live page uses the shared Knode Games board (Staked / Free play) and says prizes wait for the vault.
  assert.match(h, /<script src="board\.js"><\/script>/);
  assert.match(js, /free: \{ show: 6/);
  assert.match(js, /paid once the Knode Games vault is live/);
});

// ── the testnet page: its own page, its own wallet, nothing of mainnet ──
test("blockx-testnet.html: testnet only — its node and data branch, no mainnet wallet scripts, not indexed, clearly marked", () => {
  const h = read("blockx-testnet.html");
  const csp = h.match(/http-equiv="Content-Security-Policy" content="([^"]*)"/)[1];
  const conn = csp.match(/connect-src ([^;]*)/)[1].trim().split(/\s+/);
  assert.deepEqual(conn, ["'self'", "https://testnet.koinosfoundation.org", "https://raw.githubusercontent.com/bawcejawn/Knode/testnet-data/"]);
  assert.match(h, /<meta name="kg-network" content="testnet">/);
  assert.match(h, /<meta name="robots" content="noindex, nofollow">/);
  assert.match(h, /TESTNET · test KOIN only/);
  for (const f of ["wallet.js", "guest.js", "header-wallet.js", "nav.js"]) assert.ok(!h.includes(`<script src="${f}">`), `never loads ${f}`);
  const order = ["testnet-wallet.js", "race-math.js", "blockx-math.js", "board.js", "blockx.js"].map((f) => h.indexOf(`<script src="${f}"></script>`));
  assert.ok(order.every((x, i) => x > 0 && (i === 0 || x > order[i - 1])), "testnet-wallet.js (with its frame-buster) first");
  assert.doesNotMatch(h, /<script>(?!<\/script>)|\son[a-z]+="/, "no inline scripts or handlers");
  // Not linked from any mainnet page's menus, and not in the sitemap.
  for (const f of fs.readdirSync(`${APP}/site`).filter((x) => x.endsWith(".html") && x !== "blockx-testnet.html" && x !== "blockx.html"))
    assert.ok(!read(f).includes("blockx-testnet.html"), `${f} doesn't link the testnet page`);
  assert.ok(!fs.readFileSync(`${APP}/sitemap.xml`, "utf8").includes("blockx-testnet"));
});

test("testnet-wallet.js: own storage, refuses mainnet, signs only testnet Picks calls for the testnet chain", async () => {
  const js = read("testnet-wallet.js");
  assert.doesNotMatch(js, /kn-guest|knode-guest|kw-kind|kw-acc|innerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/, "no mainnet wallet storage, no HTML sinks");
  const store = new Map();
  const calls = [];
  const fakeProvider = (chain) => ({ getChainId: async () => chain, getAccountRc: async () => "1000000000", wait: async () => ({}) });
  const MAIN = "EiBZK_GGVP0H_fXVAM3j6EAuz3-B-l3ejxRSewi7qIBfSA==", TEST = "EiAIKVvm6-V2qmsmUvPJy09vCCLbtn9lHFpwrJbcTIEWRQ==";
  class Signer { constructor({ privateKey }) { this.k = privateKey; } getAddress() { return "1Test" + this.k.slice(0, 4); } }
  let tamper = null;   // a wallet that changes what it signs
  class Transaction { constructor(o) { this.o = o; this.ops = []; } async pushOperation(op) { this.ops.push(op); }
    async sign() { calls.push(this.o.options); const t = { header: { chain_id: this.o.options.chainId, payer: this.o.options.payer, rc_limit: this.o.options.rcLimit }, operations: this.ops, id: "0xabc" }; return tamper ? tamper(t) : t; } async send() { return {}; } }
  const win = { localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    crypto: { getRandomValues: (b) => { for (let i = 0; i < b.length; i++) b[i] = i + 1; return b; } }, koilib: { Signer, Transaction } };
  win.top = win; win.self = win; win.window = win;
  const box = { window: win, document: { createElement: () => ({ setAttribute() {}, addEventListener() {}, append() {}, replaceChildren() {}, querySelector: () => null }), body: { append() {} }, documentElement: { style: {} } } };
  vm.runInNewContext(js, box);
  const T = win.KTestWallet;
  assert.ok(T, "loaded");
  assert.throws(() => T.init({ provider: fakeProvider(MAIN), chainId: MAIN, picks: "1Picks" }), /testnet chain id/, "refuses the mainnet chain id");
  T.init({ provider: fakeProvider(TEST), chainId: TEST, picks: "1PicksContractAAAAAAAAAAAAAAAAAAA" });
  assert.deepEqual([...T.STORAGE], ["kg-testnet-wallet-v1", "kg-testnet-kind-v1"]);
  // Not connected: nothing is signed.
  await assert.rejects(T.send("x", [{ call_contract: { contract_id: "1PicksContractAAAAAAAAAAAAAAAAAAA", entry_point: 1 } }]), /Connect a testnet wallet/);
  // A test key kept from last time comes back by itself (only under the testnet storage names).
  store.set("kg-testnet-wallet-v1", "ab".repeat(32)); store.set("kg-testnet-kind-v1", "test");
  T.init({ provider: fakeProvider(TEST), chainId: TEST, picks: "1PicksContractAAAAAAAAAAAAAAAAAAA" });
  assert.equal(T.kind, "test");
  const pick = { call_contract: { contract_id: "1PicksContractAAAAAAAAAAAAAAAAAAA", entry_point: 0x8ce33c6c } };
  await assert.rejects(T.send("x", [{ call_contract: { contract_id: "1Mpmf2ERhjYpX7CCiM11WERuM4j17uT1sr", entry_point: 1 } }]), /only picks on the testnet Picks contract/);
  assert.equal(await T.send("pick", [pick]), "0xabc");
  assert.equal(calls.at(-1).chainId, TEST, "signed for the testnet chain");
  assert.equal(calls.at(-1).payer, T.address, "the player pays its own test Mana");
  assert.ok(BigInt(calls.at(-1).rcLimit) <= 300000000n, "at most 3 test Mana");
  // A wallet that raises the Mana limit or swaps the operation: refused before sending (review #7).
  tamper = (t) => ({ ...t, header: { ...t.header, rc_limit: "100000000000" } });
  await assert.rejects(T.send("pick", [pick]), /raised the Mana limit/);
  tamper = (t) => ({ ...t, operations: [{ call_contract: { contract_id: "1Mpmf2ERhjYpX7CCiM11WERuM4j17uT1sr", entry_point: 1 } }] });
  await assert.rejects(T.send("pick", [pick]), /changed what is signed/);
  tamper = null;
  // If the node turns out to be on mainnet, nothing is signed.
  T.init({ provider: fakeProvider(MAIN), chainId: TEST, picks: "1PicksContractAAAAAAAAAAAAAAAAAAA" });
  const n = calls.length;
  await assert.rejects(T.send("pick", [pick]), /MAINNET/);
  assert.equal(calls.length, n, "nothing signed");
});

// ── the local testnet server (tools/testnet-site.mjs): only the page, its settings and the recorder's files ──
test("local testnet server: serves only the allowlist (never .env.testnet or other project files), on 127.0.0.1", async () => {
  const { allowed, serve } = await import(path.resolve(APP, "tools/testnet-site.mjs"));
  for (const ok of ["/site/blockx-testnet.html", "/site/blockx.js", "/testnet/blockx.json", "/testnet-data/blockx-92/board.json", "/testnet-data/blockx-2/W003.json", "/picks/abi/picks.koilib.json"]) assert.ok(allowed(ok), ok);
  for (const bad of ["/.env.testnet", "/.env", "/site/../.env.testnet", "/site/%2e%2e/.env.testnet", "/%2e%2e/%2e%2e/etc/passwd", "/bot/picks.ts", "/package.json", "/testnet-data/lock-test-92-1.json",
    "/testnet-data/blockx-92/../../.env.testnet", "/site/.hidden.js", "/picks/build/testnet/manifest.json", "/picks/abi/other.json", "/picks/assembly/Picks.ts", "/site\\..\\.env", "/site/x.ts", "/testnet/other.json"]) assert.equal(allowed(bad), null, bad);
  const src = fs.readFileSync(path.resolve(APP, "tools/testnet-site.mjs"), "utf8");
  assert.match(src, /listen\(port, "127\.0\.0\.1"\)/, "listens on this computer only");
  const s = serve(0);
  await new Promise((r) => s.once("listening", r));
  const port = s.address().port, get = (u, m = "GET") => fetch(`http://127.0.0.1:${port}${u}`, { method: m, redirect: "manual" });
  try {
    assert.equal((await get("/site/blockx-testnet.html")).status, 200);
    assert.equal((await get("/.env.testnet")).status, 404);
    assert.equal((await get("/package.json")).status, 404);
    assert.equal((await get("/site/blockx-testnet.html", "POST")).status, 405);
  } finally { s.close(); }
});

test("testnet page on localhost reads the recorder's local files; elsewhere the testnet-data branch", () => {
  const js = fs.readFileSync(path.resolve(APP, "site/blockx.js"), "utf8");
  assert.match(js, /location\.hostname === "localhost" \|\| location\.hostname === "127\.0\.0\.1"/);
  assert.match(js, /new URL\(`testnet-data\/blockx-\$\{game\.id\}\/`, ROOT\)/);
  const i = js.indexOf("if (!TESTNET) {"), j = js.indexOf("const cfg = await fetchJson");
  assert.ok(!/testnet-data/.test(js.slice(i, j)), "the mainnet branch of setupNet never names testnet data");
});

test("local testnet server: Play free funding only answers this computer's own test page", async () => {
  const { fundAllowed, serve } = await import(path.resolve(APP, "tools/testnet-site.mjs"));
  const req = (h, method = "POST") => ({ method, headers: { host: "127.0.0.1:8350", origin: "http://127.0.0.1:8350", "x-kg-testnet": "fund", ...h } });
  assert.equal(fundAllowed(req({}), 8350), true);
  assert.equal(fundAllowed(req({ "x-kg-testnet": undefined }), 8350), false, "no custom header (a plain form from another site)");
  assert.equal(fundAllowed(req({ origin: "https://evil.example" }), 8350), false, "another site");
  assert.equal(fundAllowed(req({ origin: undefined }), 8350), false, "no Origin");
  assert.equal(fundAllowed(req({ host: "evil.example:8350" }), 8350), false, "DNS rebinding: wrong Host");
  assert.equal(fundAllowed(req({}, "GET"), 8350), false);
  const src = fs.readFileSync(path.resolve(APP, "tools/testnet-site.mjs"), "utf8");
  assert.match(src, /chainId === MAINNET_CHAIN_ID/, "refuses a mainnet node");
  assert.match(src, /FUND_SAT = 500000000n/, "5 test KOIN, no more");
  assert.ok(!/console\.log\([^)]*key/i.test(src), "never prints the key");
  const s = serve(0); await new Promise((r) => s.once("listening", r));
  const port = s.address().port;
  try {
    const bad = await fetch(`http://127.0.0.1:${port}/api/fund`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://evil.example" }, body: "{}" });
    assert.equal(bad.status, 403);
  } finally { s.close(); }
});

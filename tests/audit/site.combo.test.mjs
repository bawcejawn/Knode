// Combo Card (combo-math.js, shared by the page and the recorder bot/games/combo.ts): the card rules (2 to 6 legs,
// one leg per race or block, every leg open, the contract's locks), the price of each leg type from a real race card,
// exact points with the 150 cap, every leg-type result edge, void legs, and the best-10 leaderboard. Offline.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const APP = process.env.APP || ".";
const read = (f) => fs.readFileSync(`${APP}/${f}`, "utf8");
const box = { window: {} };
vm.runInNewContext(read("race-math.js") + "\n" + read("blockx-math.js") + "\n" + read("combo-math.js"), box);
const C = box.window.KCombo, M = box.window.KRaceMath, X = box.window.KBlockX;
const plain = (x) => JSON.parse(JSON.stringify(x));
const CARD = JSON.parse(fs.readFileSync(`${APP}/tests/fixtures/combo-card-2026-10-27.json`, "utf8"));   // real, 17 horses
const TOP = CARD.field[0].a, LAST = CARD.field[CARD.field.length - 1].a, PADDOCK = CARD.paddock[0].a;
const STRANGER = "1ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ";

// A head: 2026-11-03 10:00 UTC at height 48,000,000 (heights and times only need to be consistent).
const NOW = Date.parse("2026-11-03T10:00:00Z"), H = 48_000_000;
const head = { height: H, time: NOW };
const R = M.raceIndex(NOW) + 1;                 // the next race (12:00), opens 2 h from now
const B = Math.floor(H / X.ROUND) + 2;          // a Block X target ~4,800 blocks ahead
const leg = (code, round, producer = TOP) => ({ code, round, producer });

test("card shape: 2 to 6 legs, known codes, valid producers", () => {
  assert.match(C.cardProblem([leg(C.SHOW, R)], head), /at least 2/);
  assert.match(C.cardProblem([], head), /at least 2/);
  const seven = Array.from({ length: 7 }, (_, i) => leg(C.BLOCK, B + i, CARD.field[i].a));
  assert.match(C.cardProblem(seven, head), /at most 6/);
  assert.equal(C.cardProblem(seven.slice(0, 6), head), null);
  assert.match(C.cardProblem([leg(5, R), leg(C.BLOCK, B)], head), /Unknown/);
  assert.match(C.cardProblem([leg(C.WIN, R, "nope"), leg(C.BLOCK, B)], head), /invalid producer/);
  assert.match(C.cardProblem([leg(C.WIN, 0), leg(C.BLOCK, B)], head), /Unknown/);
});

test("per race: up to 3 legs, one of each type, on different horses; same type twice refused; one leg per block", () => {
  const H3 = CARD.field[3].a, H5 = CARD.field[5].a;
  assert.equal(C.cardProblem([leg(C.WIN, R, TOP), leg(C.SHOW, R, LAST), leg(C.HALF, R, H5)], head), null, "Win + Show + Top half on one race");
  for (const a of [C.WIN, C.SHOW, C.HALF]) assert.match(C.cardProblem([leg(a, R, TOP), leg(a, R, LAST)], head), new RegExp(`Only one ${C.NAMES[a]} leg per race`), `${a} twice`);
  assert.match(C.cardProblem([leg(C.WIN, R, TOP), leg(C.SHOW, R, LAST), leg(C.HALF, R, H5), leg(C.HALF, R, H3)], head), /Only one Top half leg per race/);
  assert.match(C.cardProblem([leg(C.BLOCK, B, TOP), leg(C.BLOCK, B, LAST)], head), /one leg per block/);
  assert.equal(C.cardProblem([leg(C.WIN, R, TOP), leg(C.SHOW, R + 1, LAST), leg(C.HALF, R + 2, H5), leg(C.BLOCK, B, H3)], head), null);
  // A race index and a block round with the same number are different things.
  assert.equal(C.cardProblem([leg(C.SHOW, 12345), leg(C.BLOCK, 12345, LAST)], { height: 12345 * X.ROUND - 5000, time: M.raceStart(12345) - 3 * M.HOUR }), null);
  assert.notEqual(C.slotKey(leg(C.WIN, 7)), C.slotKey(leg(C.SHOW, 7)));
  assert.notEqual(C.slotKey(leg(C.SHOW, 7)), C.slotKey(leg(C.BLOCK, 7)));
});

test("race legs lock 25 minutes before the start and open 24 h ahead (time); Block X legs by height", () => {
  const start = M.raceStart(R);
  const at = (time, height = H) => ({ time, height });
  assert.ok(C.legOpen(leg(C.SHOW, R), at(start - 25 * 60000 - 1)));
  assert.ok(!C.legOpen(leg(C.SHOW, R), at(start - 25 * 60000)), "locked at exactly start − 25 min");
  assert.ok(!C.legOpen(leg(C.SHOW, R), at(start + 1)), "started");
  assert.ok(C.legOpen(leg(C.WIN, R), at(start - 24 * M.HOUR)));
  assert.ok(!C.legOpen(leg(C.WIN, R), at(start - 24 * M.HOUR - 1)), "more than 24 h ahead");
  const t = X.target(B);
  assert.ok(C.legOpen(leg(C.BLOCK, B), at(NOW, t - 501)));
  assert.ok(!C.legOpen(leg(C.BLOCK, B), at(NOW, t - 500)), "locked at target − 500 (earlier than Block X's own 100)");
  assert.ok(!C.legOpen(leg(C.BLOCK, B), at(NOW, t - 101)), "still locked where a Block X pick would be open");
  assert.ok(C.legOpen(leg(C.BLOCK, B), at(NOW, t - 28800)));
  assert.ok(!C.legOpen(leg(C.BLOCK, B), at(NOW, t - 28801)), "more than 28,800 blocks ahead");
  // The card is refused if any one leg is locked, and its lock is the earliest leg's.
  const legs = [leg(C.SHOW, R), leg(C.BLOCK, B)];
  assert.match(C.cardProblem(legs, at(start - 60000)), /Show leg is locked/);
  assert.equal(C.cardLockTime(legs, head), Math.min(start - 25 * 60000, X.aboutTime(X.target(B) - 500, H, NOW)));
});

test("one leg per producer on the whole card: any two leg types, same race or not, Block X included", () => {
  const all = [[C.WIN, R], [C.SHOW, R], [C.HALF, R], [C.WIN, R + 1], [C.SHOW, R + 1], [C.HALF, R + 1], [C.BLOCK, B], [C.BLOCK, B + 1]];
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
    const pair = [leg(all[i][0], all[i][1], TOP), leg(all[j][0], all[j][1], TOP)];
    const p = C.cardProblem(pair, head);
    assert.ok(p && /only one leg per card|Only one/.test(p), `${all[i]} + ${all[j]}: ${p}`);
  }
  assert.match(C.cardProblem([leg(C.SHOW, R, TOP), leg(C.BLOCK, B, LAST), leg(C.BLOCK, B + 1, TOP)], head), /only one leg per card/);
  assert.equal(C.cardProblem([leg(C.SHOW, R, TOP), leg(C.BLOCK, B, LAST), leg(C.BLOCK, B + 1, CARD.field[2].a)], head), null);
});

test("slots: 3 per UTC day", () => {
  const d = C.utcDay(NOW);
  assert.deepEqual([0, 1, 2].map((s) => C.dayOfRound(C.slotRound(d, s))), [d, d, d]);
  assert.equal(C.dayOfRound(C.slotRound(d, 2) + 1), d + 1);
});

test("price card: the latest USABLE card taken at or before the time, at most 3 hours before it (Repo Lens RL-8)", () => {
  const H = 3600000, ok = (at, x = {}) => ({ ...CARD, at, samples: 12, ...x });
  const a = ok(1000), b = ok(2000), empty = ok(1500, { field: [] });
  const races = [{ cards: [a, null, empty] }, { cards: [b] }];
  assert.equal(C.priceCard(races, 999), null);
  assert.equal(C.priceCard(races, 1000).at, 1000);
  assert.equal(C.priceCard(races, 1999).at, 1000, "a card with no field is skipped");
  assert.equal(C.priceCard(races, 5000).at, 2000);
  assert.equal(C.priceCard(races, 2000 + 3 * H).at, 2000, "3 hours old: still in force");
  assert.equal(C.priceCard(races, 2001 + 3 * H), null, "older than 3 hours: no price card");
  for (const bad of [ok(3000, { samples: 11 }), ok(3000, { samples: undefined }), ok(3000, { flagged: [TOP] }), ok(3000, { topInDoubt: true })])
    assert.equal(C.priceCard([{ cards: [a, bad] }], 3500).at, 1000, "thin, flagged or in-doubt cards never price");
  assert.equal(C.cardAfter(races, 1000).at, 2000, "the first usable card after a time");
  assert.equal(C.cardAfter(races, 2000), null);
});

test("race chances from the real card: win near-equal, show and top-half spread; seeded and repeatable", () => {
  const ch = C.raceChances(CARD), again = C.raceChances(plain(CARD));
  assert.deepEqual(plain([...ch]), plain([...again]));
  let w = 0, s = 0, h = 0;
  for (const v of ch.values()) { w += v.win; s += v.show; h += v.half; assert.ok(v.win <= v.show && v.show <= v.half); }
  assert.ok(Math.abs(w - 1) < 0.01 && Math.abs(s - 3) < 0.01 && Math.abs(h - Math.floor(CARD.field.length / 2)) < 0.01);
  const wins = [...ch.values()].map((v) => v.win), shows = [...ch.values()].map((v) => v.show);
  assert.ok(Math.max(...wins) < 0.09 && Math.min(...wins) > 0.03, "the handicap evens out wins");
  assert.ok(Math.max(...shows) / Math.min(...shows) > 2, "but not top 3");
});

test("leg prices: factor = clamp(0.5 / chance, 0.25, 3); Block X by VHP share; unknown horse can't be priced", () => {
  // Rounded DOWN to the hundredth (Repo Lens RL-17).
  assert.equal(C.factorOf(0.5), 1); assert.equal(C.factorOf(0.9), 0.55); assert.equal(C.factorOf(0.99), 0.5); assert.equal(C.factorOf(0.3), 1.66);
  assert.equal(C.factorOf(2.5), 0.25); assert.equal(C.factorOf(0.01), 3); assert.equal(C.factorOf(0), 3);
  const win = C.priceLeg(CARD, leg(C.WIN, R, TOP));
  assert.equal(win.factor, 3, "a ~5% win is capped at ×3");
  const half = C.priceLeg(CARD, leg(C.HALF, R, TOP));
  assert.ok(half.chance > 0.5 && half.factor < 1, "an easy top-half leg is worth less than ×1");
  const bx = C.priceLeg(CARD, leg(C.BLOCK, B, TOP));
  const total = [...CARD.field, ...CARD.paddock].reduce((s, r) => s + r.vhp, 0);
  assert.equal(bx.chance, Math.round(CARD.field[0].vhp / total * 1e4) / 1e4);
  assert.equal(bx.factor, Math.floor(Math.min(3, 0.5 / bx.chance) * 100 + 1e-9) / 100);
  assert.equal(C.priceLeg(CARD, leg(C.BLOCK, B, PADDOCK)).factor, 3, "small paddock producer: ×3");
  assert.equal(C.priceLeg(CARD, leg(C.BLOCK, B, STRANGER)).factor, 1, "producer missing from the card: ×1, as Block X BX-3 (Repo Lens RL-1)");
  assert.equal(C.priceLeg(CARD, leg(C.SHOW, R, PADDOCK)), null, "a paddock horse isn't in the race field");
  assert.equal(C.priceLeg(null, leg(C.SHOW, R, TOP)), null);
  assert.equal(C.potential(CARD, [leg(C.SHOW, R, PADDOCK), leg(C.BLOCK, B)]).unpriced, true);
});

test("points: base by legs × factors, exact hundredths, no cap; up to the contract's 10 legs", () => {
  assert.deepEqual([2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => C.pointsFor(new Array(n).fill(100))), [300, 700, 1500, 3000, 6000, 12000, 24000, 48000, 96000]);
  assert.equal(C.pointsFor([300, 300]), 2700);
  assert.equal(C.pointsFor([300, 300, 300]), 18900, "7 × 27 = 189: no cap");
  assert.equal(C.pointsFor(new Array(6).fill(300)), 4374000, "60 × 3^6 = 43,740 points");
  assert.equal(C.pointsFor(new Array(10).fill(300)), 5668704000, "960 × 3^10 = 56,687,040 points, still an exact integer");
  assert.ok(Number.isSafeInteger(C.pointsFor(new Array(10).fill(300)) * 10), "a week of 10 such cards stays exact");
  assert.equal(C.pointsFor(new Array(6).fill(25)), 1, "60 × 0.25^6 = 0.0146 points = 1.46 hundredths, rounded down");
  assert.equal(C.pointsFor([33, 33, 33]), Math.floor(700 * 33 * 33 * 33 / 1e6));
  assert.equal(C.pointsFor([100]), 0); assert.equal(C.pointsFor(new Array(11).fill(100)), 0);
  assert.equal(C.CAP, null); assert.equal(C.MAX_LEGS, 6); assert.equal(C.HARD_MAX_LEGS, 10);
});

test("results for every leg type: hit / miss / void / pending", () => {
  const st = (n) => Array.from({ length: n }, (_, i) => ({ a: i === 0 ? TOP : "1" + String(i).padStart(33, "Q"), steps: n - i, blocks: 1 }));
  const race = (s, extra = {}) => ({ result: { final: true, standings: s, ...extra } });
  const at = (i, n = 10) => st(n)[i].a;
  // Win
  assert.equal(C.legResult(leg(C.WIN, R, at(0)), race(st(10))), "hit");
  assert.equal(C.legResult(leg(C.WIN, R, at(1)), race(st(10))), "miss");
  // Show: places 1–3
  assert.equal(C.legResult(leg(C.SHOW, R, at(2)), race(st(10))), "hit");
  assert.equal(C.legResult(leg(C.SHOW, R, at(3)), race(st(10))), "miss");
  // Top half: places 1..floor(N/2); odd field 17 → top 8
  assert.equal(C.legResult(leg(C.HALF, R, at(4)), race(st(10))), "hit");
  assert.equal(C.legResult(leg(C.HALF, R, at(5)), race(st(10))), "miss");
  assert.equal(C.legResult(leg(C.HALF, R, at(7, 17)), race(st(17))), "hit");
  assert.equal(C.legResult(leg(C.HALF, R, at(8, 17)), race(st(17))), "miss");
  // A horse with no steps never hits, even at the top of a tiny field.
  const zero = [{ a: TOP, steps: 0, blocks: 0 }, { a: LAST, steps: 0, blocks: 0 }];
  assert.equal(C.legResult(leg(C.WIN, R, TOP), race(zero)), "miss");
  // Not in the race at all → void; race missed or not final → void / pending
  assert.equal(C.legResult(leg(C.SHOW, R, STRANGER), race(st(10))), "void");
  assert.equal(C.legResult(leg(C.SHOW, R, TOP), { result: { final: true, missed: true } }), "void");
  assert.equal(C.legResult(leg(C.SHOW, R, TOP), { result: { final: false } }), "pending");
  assert.equal(C.legResult(leg(C.SHOW, R, TOP), { result: null }), "pending");
  assert.equal(C.legResult(leg(C.SHOW, R, TOP), null), "pending");
  // Block X
  assert.equal(C.legResult(leg(C.BLOCK, B, TOP), null, { final: true, checked: 2, signer: TOP }), "hit");
  assert.equal(C.legResult(leg(C.BLOCK, B, TOP), null, { final: true, checked: 2, signer: LAST }), "miss");
  assert.equal(C.legResult(leg(C.BLOCK, B, TOP), null, { final: true, checked: 0, signer: null, void: "no card" }), "void");
  // Repo Lens RL-3: Block X voiding a target for its own scoring doesn't hide who signed it.
  assert.equal(C.legResult(leg(C.BLOCK, B, TOP), null, { final: true, checked: 2, signer: LAST, void: "the two nodes disagreed about the signer's VHP on the lock's handicap card; no points" }), "miss");
  assert.equal(C.legResult(leg(C.BLOCK, B, TOP), null, { final: true, checked: 1, signer: TOP }), "void", "a signer checked on one node only decides nothing");
  assert.equal(C.legResult(leg(C.BLOCK, B, TOP), null, null), "pending");
});

test("leg order: the same legs always go in one order (lock time, code, round, producer; Repo Lens RL-13)", () => {
  const head = { height: 30000000, time: NOW };
  const a = leg(C.WIN, R, TOP), b = leg(C.SHOW, R, LAST), c = leg(C.HALF, R, PADDOCK);
  const one = C.sortLegs([c, b, a], head), two = C.sortLegs([b, a, c], head);
  assert.deepEqual(plain(one), plain(two));
  assert.deepEqual(plain(one.map((l) => l.code)), [C.WIN, C.SHOW, C.HALF], "one race: by code");
});

test("leaderboard: best 10 cards, ties by hits then the earlier last hit", () => {
  const d = C.utcDay(NOW);
  const rows = [];
  for (let i = 0; i < 12; i++) rows.push({ player: "A", round: C.slotRound(d + Math.floor(i / 3), i % 3), pts: (i + 1) * 100, hit: true, lastLegTime: 1000 + i });
  rows.push({ player: "B", round: C.slotRound(d, 0), pts: 7000, hit: true, lastLegTime: 5 });
  rows.push({ player: "C", round: C.slotRound(d, 0), pts: 7000, hit: true, lastLegTime: 9 });
  rows.push({ player: "D", round: C.slotRound(d, 0), pts: 0, hit: false, lastLegTime: 0 });
  const b = C.places(C.board(rows));
  assert.equal(b[0].player, "A"); assert.equal(b[0].pts, 7500, "best 10 of 12: 3 + 4 + … + 12 = 75 points");
  assert.equal(b[0].cards, 12); assert.equal(b[0].days, 4);
  assert.deepEqual(plain(b.slice(1, 3).map((x) => x.player)), ["B", "C"], "same points and hits: earlier last hit first");
  assert.equal(b[3].player, "D"); assert.equal(b[3].pts, 0);
});

test("vault file: players with at least 1 full point who aren't known to be unstaked (the Vault checks stakes), mapped onto 1..255 keeping order and ties; no free prizes", () => {
  const W = C.vaultWeek(Date.parse("2026-11-03T10:00:00Z"));
  assert.equal(W, 2); assert.equal(C.vaultWeek(Date.parse("2026-10-19T00:00:00Z")), 0); assert.equal(C.vaultWeek(Date.parse("2026-10-25T23:59:59Z")), 0);
  const P = (i) => "1" + String(i).padStart(33, "A").replace(/0/g, "B");
  const rows = [
    { player: P(1), pts: 4374000, staked: true }, { player: P(2), pts: 2700, staked: true }, { player: P(3), pts: 2700, staked: true },
    { player: P(4), pts: 100, staked: null }, { player: P(5), pts: 9999999, staked: false }, { player: P(6), pts: 0, staked: true },
    { player: P(7), pts: 99, staked: true }, { player: "not an address", pts: 500, staked: true },
  ];
  const f = plain(C.vaultFile(W, true, rows));
  assert.deepEqual(f, { game: 8, week: 2, final: true, first: [], second: [],
    rows: [{ player: P(1), points: 255 }, { player: P(2), points: 254 }, { player: P(3), points: 254 }, { player: P(4), points: 253 }] });
  // nobody qualifies: an empty file is still written for the week
  assert.deepEqual(plain(C.vaultFile(W, true, [{ player: P(1), pts: 0, staked: true }])).rows, []);
  assert.equal(C.vaultFile(W, "yes", []).final, false, "final only when exactly true");
  assert.equal(C.MIN_WEEK_PTS, 100, "at least 1 full point for the week (owner, 2026-10-28); 0.99 is out");
  // more than 255 distinct scores: the top 254 keep their order, the rest share 1
  const many = Array.from({ length: 300 }, (_, i) => 1000 + i);
  const m = C.toVaultPoints(many);
  assert.equal(m[299], 255); assert.equal(m[298], 254); assert.equal(m[299 - 253], 2);
  for (let i = 0; i <= 299 - 254; i++) assert.equal(m[i], 1);
  for (let i = 1; i < 300; i++) assert.ok(m[i] >= m[i - 1], "order kept");
  assert.ok(m.every((v) => Number.isInteger(v) && v >= 1 && v <= 255));
});

test("share text", () => {
  assert.equal(C.shareText([1, 2, 3, 4], ["hit", "hit", "pending", "miss"], 0), "KnodeGames Combo · 4 legs · ✅✅⏳❌ · 0 pts");
  assert.equal(C.shareText([1, 2], ["hit", "hit"], 2735), "KnodeGames Combo · 2 legs · ✅✅ · 27.35 pts");
});

// ── the page (site/combo.html + combo.js) ──
const page = read("combo.html"), js = read("combo.js");
test("combo page: scripts in order (math before the page), shared board, nav and header like every page", () => {
  const order = ["board.js", "race-math.js", "blockx-math.js", "combo-math.js", "combo.js"].map((f) => page.indexOf(`<script src="${f}"></script>`));
  assert.ok(order.every((i) => i > 0) && order.every((i, k) => k === 0 || i > order[k - 1]), "board, race-math, blockx-math, combo-math, combo");
  assert.ok(page.indexOf('<script src="wallet.js"></script>') < page.indexOf('<script src="combo.js"></script>'));
  assert.match(page, /<link rel="stylesheet" href="board\.css">/);
  assert.match(page, /<nav class="tabbar"/);
});
test("combo page: sends only a Combo card through the Picks contract's pick, only once game 8 is a live card game", () => {
  // The only transaction: picks.pick for game 8, with no producers and no number, sent through the shared wallet.
  assert.equal((js.match(/functions\.pick\(/g) || []).length, 1);
  assert.match(js, /picksC\.functions\.pick\(\{ player: who, game: C\.GAME_ID, round: String\(round\), producers: \[\], number: "0",/);
  assert.equal((js.match(/W\.send\(/g) || []).length, 1);
  assert.doesNotMatch(js, /sendTransaction|signTransaction|transfer|approve|burn/);
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  // Live only when picks-data/deployment.json names the contract and game 8 on chain is an enabled kind-4 game.
  assert.match(js, /Number\(game\.kind\) !== 4 \|\| !game\.enabled\) return;/);
  assert.match(js, /pdep\.cards !== true/, "the page goes live only with \"cards\": true, the same switch as the sponsor");
  assert.match(js, /b\.disabled = !cardsLive \|\| sending \|\| !!why \|\| !okCard;/);
  // Stake-only: guests and wallets the Vault says aren't staked are refused before anything is signed.
  assert.match(js, /W\.kind === "guest"\) why = "The Combo Card is a staked game/);
  assert.match(js, /stake === false\) why = "Stake at least 1 VHP in the Combo Card to play\. A stake made this week counts from next week\."/);
  assert.match(js, /return w > 0n && w >= minStakeFor\(cfg, week\);/, "the stake that counts this week only (CC-C5), at least the vault's minimum");
  assert.match(js, /new URL\("game\/abi\/kpred-v6\.koilib\.json", ROOT\)/, "read with the Vault v6 ABI (Repo Lens RL-4)");
  assert.match(js, /stake === null\) why = "Reading your stake/, "an unknown stake blocks Send");
  assert.match(js, /if \(stake !== true\) \{ toast = /, "sendCard itself refuses an unstaked or unknown stake (RL-22)");
  assert.match(js, /if \(sending\) return;\n    sending = true;/, "a double-click can't send twice (RL-21)");
  // CC-C1: the slots are replaced only after every read succeeded; unknown slots or a new UTC day block sending;
  // the target slot is re-read on chain right before signing and must be empty or exactly the card being changed.
  assert.match(js, /slotsDay = null;\s+\/\/ unknown: Send stays off until a read succeeds/);
  assert.match(js, /const targetSlot = \(\) => \(slotsDay === null \? null :/);
  assert.match(js, /const sameDay = \(\) => day !== null && slotsDay === day && C\.utcDay\(head\.time\) === day && C\.utcDay\(Date\.now\(\)\) === day && !nearMidnight\(\);/);
  assert.match(js, /if \(!same\(onChain, expected\)\) \{ toast = "Your cards changed on the chain/);
  assert.match(js, /const round = C\.slotRound\(day, slot\)/);
  // Browser storage holds only the draft, and every access is wrapped (it can throw in private windows).
  for (const m of js.matchAll(/localStorage\.[a-zA-Z]+\(/g)) {
    const before = js.slice(Math.max(0, m.index - 80), m.index);
    assert.match(before, /try \{[^}]*$/, "storage access inside try");
  }
  // Network reads: the RPC, race-data, games-data/combo, and this site's own deployment and ABI files.
  const urls = [...js.matchAll(/"https:\/\/[^"]+"/g)].map((m) => m[0]);
  for (const u of urls) assert.match(u, /koinos\.armana\.io|raw\.githubusercontent\.com\/bawcejawn\/Knode\/(race-data|games-data\/combo)\/|koinosscan\.com|knodegames\.com\/combo\.html/, u);
  for (const f of js.matchAll(/new URL\("([^"]+)", ROOT\)/g)) assert.match(f[1], /^(picks-data\/deployment|game-data\/deployment|picks\/abi\/picks\.koilib|game\/abi\/kpred-v6\.koilib)\.json$/, f[1]);
});

test("combo page: its rules text matches the math (locks, per-race and per-producer rules); base and cap come from the math", () => {
  assert.match(page, /Races lock 25 minutes before the start, Block X 500 blocks/);
  assert.equal(C.RACE_LEAD_MS, 25 * 60000); assert.equal(C.BLOCK_LEAD, 500);
  assert.match(page, /Up to 3 legs a race \(one Win, one Show, one Top half\) and one per block\. Each producer can be on your card once\./);
  assert.match(js, /\$\("base-table"\)\.replaceChildren/, "the base table is drawn from C.BASE, never typed in");
  assert.match(js, /C\.MAX_LEGS/);
});

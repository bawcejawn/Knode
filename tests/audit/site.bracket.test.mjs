// Producer Bracket (site/bracket-math.js, shared by bracket.js and the recorder bot/games/bracket.ts): the week's
// timing, bracket size from the field (8 / 16 with byes / 32), the one-number pick (encode/decode, byes, invalid
// numbers), the day index from hourly race cards, tie → underdog, results, scoring and ranking, and fairness of the
// plain handicap end to end. Offline.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const APP = process.env.APP || ".";
const read = (f) => fs.readFileSync(`${APP}/site/${f}`, "utf8");
const box = { window: {} };
vm.runInNewContext(read("race-math.js"), box);
vm.runInNewContext(read("bracket-math.js"), box);
const R = box.window.KRaceMath, M = box.window.KBracketMath;
const plain = (x) => JSON.parse(JSON.stringify(x));
const U = (s) => Date.parse(s), H = 3600000;
const dep = JSON.parse(fs.readFileSync(`${APP}/game-data/deployment.json`, "utf8"));
const addr = (i) => `1Producer${String(i).padStart(3, "0")}xxxxxxxxxxxxxxxx`;
const cardOf = (vhps, paddock = []) => ({ field: vhps.map((v, i) => ({ a: addr(i + 1), vhp: v })), paddock: paddock.map((v, i) => ({ a: addr(900 + i), vhp: v })) });

// ── timing ──
test("week, seeding and lock times: Saturday 12:00 and Sunday 23:55 UTC before a Monday week", () => {
  assert.equal(M.GENESIS, dep.genesisTime); assert.equal(M.WEEK, dep.weekLength); assert.equal(M.GENESIS, R.GENESIS);
  for (const w of [1, 2, 3, 52]) assert.equal(M.weekStart(w), R.weekStart(w));
  assert.equal(new Date(M.seedTime(2)).toISOString(), "2026-10-31T12:00:00.000Z");
  assert.equal(new Date(M.lockTime(2)).toISOString(), "2026-11-01T23:55:00.000Z");
  assert.equal(new Date(M.seedTime(2)).getUTCDay(), 6, "a Saturday");
  assert.ok(M.weekStart(2) - M.lockTime(2) >= 100 * 3000, "locks at least 100 blocks (~5 min) before Monday");
  assert.equal(M.lockTime(2) - M.seedTime(2), 36 * H - 5 * 60000, "about 36 hours to pick");
  assert.deepEqual([0, 1, 2, 3, 4].map((r) => new Date(M.roundDay(2, r)).getUTCDay()), [1, 2, 3, 4, 5], "rounds Monday → Friday");
});

test("the Picks round for a week targets that week's Monday 00:00 UTC", () => {
  assert.ok(M.ROUND_OFFSET >= 0 && M.ROUND_OFFSET < M.WEEK, "the Picks contract needs round_offset < round_size");
  for (const w of [0, 1, 2, 10, 500]) {
    const r = M.picksRound(w);
    assert.equal(r * M.WEEK + M.ROUND_OFFSET, M.weekStart(w));
    assert.equal(M.weekOfPicksRound(r), w);
    // the contract locks at target − lead: lead 5 min = M.LOCK_BEFORE, opens at target − ahead (36 h = SEED_BEFORE)
    assert.equal(r * M.WEEK + M.ROUND_OFFSET - M.LOCK_BEFORE, M.lockTime(w));
    assert.equal(r * M.WEEK + M.ROUND_OFFSET - M.SEED_BEFORE, M.seedTime(w));
  }
  assert.ok(M.SEED_BEFORE <= 35 * 24 * H, "within the contract's 35-day `ahead` limit");
  assert.ok(M.LOCK_BEFORE >= 300000, "the contract's minimum time lead is 5 minutes");
});

// ── shape ──
test("bracket size follows the field: <8 none, 8–11 → 8, 12–31 → 16, 32+ → 32 (also at 50)", () => {
  const want = (n) => (n < 8 ? 0 : n < 12 ? 8 : n < 32 ? 16 : 32);
  for (let n = 0; n <= 60; n++) assert.equal(M.sizeFor(n), want(n), `field ${n}`);
  assert.deepEqual([8, 16, 32].map(M.roundsOf), [3, 4, 5]);
  assert.deepEqual([0, 8, 16, 32].map(M.maxPoints), [0, 14, 34, 82]);
  assert.ok(M.maxPoints(32) <= 255, "fits the vault's 1–255 points");
  assert.equal(M.NUMBER_MAX, 2 ** 31 - 1, "the Picks number range covers a 32-bracket from launch");
});

test("line order: a standard bracket where seeds 1 and 2 can only meet in the final", () => {
  for (const size of [8, 16, 32]) {
    const o = M.lineOrder(size);
    assert.deepEqual([...o].sort((a, b) => a - b), Array.from({ length: size }, (_, i) => i + 1), "every seed once");
    for (let i = 0; i < size; i += 2) assert.equal(o[i] + o[i + 1], size + 1, "round 1 pairs s v size+1−s");
    assert.ok(o.slice(0, size / 2).includes(1) && o.slice(size / 2).includes(2), "1 and 2 in opposite halves");
    const q = size / 4;   // top 4 seeds in different quarters
    assert.deepEqual([0, 1, 2, 3].map((k) => o.slice(k * q, (k + 1) * q).filter((s) => s <= 4).length), [1, 1, 1, 1]);
    // with every better seed winning, the semifinal four are seeds 1–4
    const chalk = M.play(size, size, () => false).rounds;
    assert.deepEqual([...chalk[M.roundsOf(size) - 3]].sort((a, b) => a - b), [1, 2, 3, 4]);
  }
});

test("seeding from a race card: by VHP, ties by address, paddock and bad rows left out", () => {
  // today's shape: 17 in the field → the top 16, the 17th sits out
  const s17 = M.seeding(cardOf(Array.from({ length: 17 }, (_, i) => 1000 - i), [5, 3]));
  assert.equal(s17.size, 16); assert.equal(s17.seeds.length, 16); assert.deepEqual(plain(s17.out), [addr(17)]);
  assert.equal(s17.seeds[0], addr(1));
  const tie = M.seeding({ field: [{ a: "1B", vhp: 5 }, { a: "1A", vhp: 5 }, ...Array.from({ length: 8 }, (_, i) => ({ a: addr(i), vhp: 1 }))] });
  assert.deepEqual(plain(tie.seeds.slice(0, 2)), ["1A", "1B"]);
  const bad = M.seeding({ field: [{ a: addr(1), vhp: 9 }, { a: addr(1), vhp: 9 }, { a: 7, vhp: 9 }, { a: addr(2), vhp: -1 }, { a: addr(3), vhp: NaN }, null] });
  assert.equal(bad.size, 0); assert.equal(bad.seeds.length, 0, "a field of 1 is no bracket");
  assert.equal(M.seeding(null).size, 0);
  // 13 → 16 slots, 13 seeds; seeds 1–3 get byes
  const s13 = M.seeding(cardOf(Array.from({ length: 13 }, (_, i) => 100 - i)));
  assert.equal(s13.size, 16); assert.equal(s13.seeds.length, 13);
  const fr = plain(M.firstRound(16, 13)), byes = fr.filter(([, b]) => b === 0).map(([a]) => a).sort((a, b) => a - b);
  assert.deepEqual(byes, [1, 2, 3]);
  // 50 → 32 producers, 18 out
  const s50 = M.seeding(cardOf(Array.from({ length: 50 }, (_, i) => 5000 - i)));
  assert.equal(s50.size, 32); assert.equal(s50.seeds.length, 32); assert.equal(s50.out.length, 18);
  // 7 → no bracket
  assert.equal(M.seeding(cardOf([7, 6, 5, 4, 3, 2, 1])).size, 0);
});

// ── the one-number pick ──
function consistent(rounds, size, n) {
  const fr = M.firstRound(size, n);
  for (let m = 0; m < fr.length; m++) assert.ok(fr[m].includes(rounds[0][m]) && rounds[0][m] !== 0);
  for (let r = 1; r < rounds.length; r++) for (let m = 0; m < rounds[r].length; m++) assert.ok([rounds[r - 1][2 * m], rounds[r - 1][2 * m + 1]].includes(rounds[r][m]));
}
test("every number in range is one whole, consistent bracket and encodes back to itself (8 and 16: all of them)", () => {
  for (const size of [8, 16]) {
    const seen = new Set();
    for (let x = 0; x < 2 ** (size - 1); x++) {
      const d = M.decode(x, size, size); assert.ok(d, `${size}: ${x}`);
      const rounds = plain(d.rounds); consistent(rounds, size, size);
      assert.equal(M.encode(rounds, size, size), x);
      seen.add(JSON.stringify(rounds));
    }
    assert.equal(seen.size, 2 ** (size - 1), "different numbers are different brackets");
  }
  const rnd = R.rng(9);
  for (let i = 0; i < 3000; i++) {
    const x = i === 0 ? M.NUMBER_MAX : i === 1 ? 0 : Math.floor(rnd.next() * 2 ** 31);
    const d = M.decode(x, 32, 32); assert.ok(d); const rounds = plain(d.rounds); consistent(rounds, 32, 32);
    assert.equal(M.encode(rounds, 32, 32), x);
  }
});

test("invalid numbers score nothing: too big for the bracket, bits on a bye, not a whole number", () => {
  assert.equal(M.decode(2 ** 15, 16, 16), null); assert.ok(M.decode(2 ** 15 - 1, 16, 16));
  assert.equal(M.decode(2 ** 7, 8, 8), null);
  assert.equal(M.decode(2 ** 31, 32, 32), null);
  for (const x of [-1, 1.5, NaN, Infinity, "5", null, undefined, 2 ** 60]) assert.equal(M.decode(x, 16, 16), null, String(x));
  assert.equal(M.decode(0, 0, 0), null, "no bracket this week");
  // 13 seeds: byes on matchups 0, 4 and 7; their bits must be 0
  const byes = plain(M.byesOf(16, 13)); assert.deepEqual(byes, [0, 4, 7]);
  for (const b of byes) assert.equal(M.decode(2 ** b, 16, 13), null);
  let valid = 0; for (let x = 0; x < 2 ** 15; x++) if (M.decode(x, 16, 13)) valid++;
  assert.equal(valid, 2 ** 12, "one valid number per bracket");
  // a bye seed always advances in round 1
  for (let x = 0; x < 2 ** 15; x += 97) { const d = M.decode(x, 16, 13); if (d) for (const s of [1, 2, 3]) assert.ok(d.rounds[0].includes(s)); }
  assert.throws(() => M.encode([[1]], 16, 16), /winner must be/);
});

// ── the day index ──
const DAY0 = U("2026-11-02T00:00:00Z");
function blocksOf(list) { // list: [[hour, address, count], ...] spread evenly inside each hour
  const ts = [], who = [];
  for (const [h, a, n] of list) for (let i = 0; i < n; i++) { ts.push(DAY0 + h * H + Math.floor((i + 0.5) * H / n)); who.push(a); }
  const order = ts.map((_, i) => i).sort((x, y) => ts[x] - ts[y]), signers = [...new Set(who)];
  return { ts: order.map((i) => ts[i]), sig: order.map((i) => signers.indexOf(who[i])), signers };
}
test("day index = blocks ÷ expected from each hour's card (plain handicap); VHP added mid-day doesn't help", () => {
  const A = "1A", Bp = "1B";
  // A has 75% of VHP, B 25%. 100 blocks an hour, signed in exactly those shares → both index 1.
  const card = { field: [{ a: A, vhp: 3 }, { a: Bp, vhp: 1 }] };
  const blocks = []; for (let h = 0; h < 24; h++) blocks.push([h, A, 75], [h, Bp, 25]);
  let idx = M.dayIndex(blocksOf(blocks), DAY0, Array(24).fill(card));
  assert.ok(Math.abs(idx.get(A).index - 1) < 1e-9 && Math.abs(idx.get(Bp).index - 1) < 1e-9);
  assert.equal(idx.get(A).blocks, 1800); assert.equal(idx.get(Bp).expected, 600);
  // From hour 12 B burns KOIN and reaches 50% of VHP, so it signs more. With hourly cards its expected rises too.
  const card2 = { field: [{ a: A, vhp: 3 }, { a: Bp, vhp: 3 }] };
  const b2 = []; for (let h = 0; h < 24; h++) b2.push(h < 12 ? [h, A, 75] : [h, A, 50], h < 12 ? [h, Bp, 25] : [h, Bp, 50]);
  const cards = Array.from({ length: 24 }, (_, h) => (h < 12 ? card : card2));
  idx = M.dayIndex(blocksOf(b2), DAY0, cards);
  assert.ok(Math.abs(idx.get(Bp).index - 1) < 1e-9, "B gains nothing from its extra VHP");
  // with one fixed card for the whole day, B would have won by burning: the reason for hourly cards
  const fixed = M.dayIndex(blocksOf(b2), DAY0, Array(24).fill(card));
  assert.ok(fixed.get(Bp).index > 1.4 && fixed.get(A).index < 0.9);
  // missing hours use the nearest earlier card of the day, else the nearest later one; no card at all → null
  const gaps = Array(24).fill(null); gaps[5] = card;
  idx = M.dayIndex(blocksOf(blocks), DAY0, gaps); assert.ok(Math.abs(idx.get(Bp).index - 1) < 1e-9);
  assert.equal(M.dayIndex(blocksOf(blocks), DAY0, Array(24).fill(null)), null);
  assert.equal(M.dayIndex(blocksOf(blocks), DAY0, Array(23).fill(card)), null);
  // blocks outside the day don't count
  idx = M.dayIndex(blocksOf([[-1, A, 50], [24, A, 50], [3, Bp, 4]]), DAY0, Array(24).fill(card));
  assert.equal(idx.get(A).blocks, 0); assert.equal(idx.get(Bp).blocks, 4);
  // paddock VHP counts in the share total; a producer off a card has share 0 for that hour
  idx = M.dayIndex(blocksOf([[0, A, 10]]), DAY0, Array(24).fill({ field: [{ a: A, vhp: 1 }], paddock: [{ a: "1P", vhp: 1 }] }));
  assert.equal(idx.get(A).expected, 5); assert.equal(idx.get("1P").expected, 5);
});

test("a matchup: higher index advances, an exact tie goes to the lower seed", () => {
  const idx = new Map([["1A", { blocks: 50, expected: 100 }], ["1B", { blocks: 5, expected: 10 }], ["1C", { blocks: 6, expected: 10 }], ["1Z", { blocks: 0, expected: 0 }]]);
  assert.equal(M.otherWins(idx, "1A", "1B"), true, "0.5 v 0.5: underdog");
  assert.equal(M.otherWins(idx, "1A", "1C"), true);
  assert.equal(M.otherWins(idx, "1C", "1A"), false);
  assert.equal(M.otherWins(idx, "1A", "1Z"), false, "an underdog with nothing expected can't win");
  assert.equal(M.otherWins(idx, "1Z", "1A"), true);
  assert.equal(M.otherWins(idx, "1Q", "1Z"), true, "both nothing: underdog");
  assert.equal(M.otherWins(idx, "1A", "1Q"), false, "a producer missing from the day counts as 0 blocks");
  const zero = new Map([["1A", { blocks: 0, expected: 100 }], ["1B", { blocks: 0, expected: 5 }]]);
  assert.equal(M.otherWins(zero, "1A", "1B"), true, "both offline all day: underdog");
});

// ── results, scoring, ranking ──
function weekDays(seeds, rule) { // rule(day, address) → index; builds a Map per round day
  return Array.from({ length: 5 }, (_, d) => new Map(seeds.map((a, i) => [a, { blocks: rule(d, i + 1) * 1000, expected: 1000 }])));
}
test("results, a perfect bracket scores the maximum, champion bonus only once the final is known", () => {
  for (const [size, n] of [[8, 9], [16, 16], [16, 13], [32, 40]]) {
    const s = M.seeding(cardOf(Array.from({ length: n }, (_, i) => 10000 - i)));
    assert.equal(s.size, size);
    const days = weekDays(s.seeds, (d, seed) => ((seed * 7 + d * 3) % 11) + 1);
    const res = M.results(s.seeds, s.size, days.slice(0, M.roundsOf(size)));
    assert.equal(res.done, true); assert.equal(res.rounds.length, M.roundsOf(size));
    const perfect = { rounds: plain(res.rounds) };
    const byes = M.byesOf(size, s.seeds.length).length;
    const sc = M.score(perfect, res, size, s.seeds.length);
    assert.equal(sc.points, M.maxPoints(size) - byes, `${size}/${n}: byes score nothing`);
    assert.equal(sc.champion, true);
    // the same pick as a number round-trips
    const x = M.encode(perfect.rounds, size, s.seeds.length);
    assert.deepEqual(plain(M.decode(x, size, s.seeds.length)), perfect);
    // partway through the week: no champion bonus yet
    const part = M.results(s.seeds, s.size, [days[0], days[1], null]);
    assert.equal(part.done, false); assert.equal(part.rounds.length, 2);
    const ps = M.score(perfect, part, size, s.seeds.length);
    assert.equal(ps.champion, false); assert.equal(ps.points, size / 2 - byes + size / 2);
  }
  // an invalid pick scores 0
  assert.deepEqual(plain(M.score(null, { rounds: [[1]], done: true }, 16, 16)), { points: 0, correct: 0, champion: false });
});

test("a later-round pick on a producer already knocked out scores 0 for that round", () => {
  const s = M.seeding(cardOf(Array.from({ length: 16 }, (_, i) => 100 - i)));
  const days = weekDays(s.seeds, (d, seed) => (seed === 1 ? 0.1 : 1)); // seed 1 is offline all week: loses round 1
  const res = M.results(s.seeds, 16, days.slice(0, 4));
  assert.ok(!res.rounds[0].includes(1));
  const chalk = M.decode(0, 16, 16);   // picks seed 1 all the way
  const sc = M.score(chalk, res, 16, 16);
  assert.equal(sc.champion, false);
  for (let r = 0; r < 4; r++) assert.notEqual(res.rounds[r][0], 1);
});

test("ranking: points, then a correct champion, then more correct winners; ties share a place", () => {
  const rows = [
    { player: "1d", points: 20, champion: false, correct: 9 },
    { player: "1a", points: 20, champion: true, correct: 7 },
    { player: "1c", points: 20, champion: false, correct: 9 },
    { player: "1b", points: 25, champion: false, correct: 6 },
    { player: "1e", points: 3, champion: false, correct: 3 },
  ];
  const r = plain(M.rank(rows));
  assert.deepEqual(r.map((x) => [x.player, x.place]), [["1b", 1], ["1a", 2], ["1c", 3], ["1d", 3], ["1e", 5]]);
  assert.equal(rows[0].place, undefined, "doesn't change its input");
});

// ── fairness end to end ──
test("plain handicap through dayIndex: 1 v 16 on today's card stays near 50/50 (Poisson days)", () => {
  // today's card shape (2026-10-27): seed 1 ~5,126 blocks a day, seed 16 ~51
  const vhp = { "1S1": 2182618, "1S16": 21609, "1REST": 4880000 * 2 };
  const card = { field: Object.entries(vhp).map(([a, v]) => ({ a, vhp: v })) };
  const tot = Object.values(vhp).reduce((a, b) => a + b, 0), perHour = 1200, rnd = R.rng(20261027);
  let underdog = 0; const N = 1500;
  for (let t = 0; t < N; t++) {
    const k1 = rnd.poisson(perHour * 24 * vhp["1S1"] / tot), k16 = rnd.poisson(perHour * 24 * vhp["1S16"] / tot);
    const idx = new Map([["1S1", { blocks: k1, expected: perHour * 24 * vhp["1S1"] / tot }], ["1S16", { blocks: k16, expected: perHour * 24 * vhp["1S16"] / tot }]]);
    if (M.otherWins(idx, "1S1", "1S16")) underdog++;
  }
  const p = underdog / N;
  assert.ok(p > 0.44 && p < 0.56, `seed 16 wins ${(100 * p).toFixed(1)}%`);
});

// ── page rules ──
test("the shared math is read only and has no betting words", () => {
  const src = read("bracket-math.js");
  assert.doesNotMatch(src, /\.send\(|signTransaction|sendTransaction|fetch\(|XMLHttpRequest|localStorage/);
  assert.doesNotMatch(src, /\bodds\b|\bwager|\bbet\b|\bpays\s+\d/i);
});

// ── the page (site/bracket.html, bracket.js) ──
const page = read("bracket.html"), js = read("bracket.js");
test("the page: scripts in order, the shared board, reads only the bracket files, the block snapshot and the site", () => {
  assert.match(page, /<script src="bracket-math\.js"><\/script>\s*<script src="board\.js"><\/script>\s*<script src="bracket\.js"><\/script>/);
  assert.match(page, /<link rel="stylesheet" href="board\.css">/);
  const csp = page.match(/Content-Security-Policy" content="([^"]+)"/)[1];
  assert.match(csp, /connect-src [^;]*https:\/\/raw\.githubusercontent\.com\/bawcejawn\/Knode\/games-data\//);
  assert.match(csp, /connect-src [^;]*https:\/\/raw\.githubusercontent\.com\/bawcejawn\/Knode\/blocks-data\//);
  assert.doesNotMatch(page, /<script>(?!\s*<\/script>)|\son[a-z]+="/i, "no inline scripts or handlers");
  const urls = [...js.matchAll(/"(https:\/\/[^"]+)"/g)].map((m) => m[1]);
  for (const u of urls) assert.ok(/^https:\/\/(raw\.githubusercontent\.com\/bawcejawn\/Knode\/(games-data\/bracket\/|blocks-data\/recent-blocks\.json)|api\.koinos\.io|koinosscan\.com\/address\/)/.test(u), u);
  assert.match(js, /new URL\("picks-data\/deployment\.json", ROOT\)/);
});
test("the page builds everything with textContent and sends one thing: a pick of game 9 as one number", () => {
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function|localStorage|sessionStorage|indexedDB/);
  const sends = [...js.matchAll(/W\.send\(/g)]; assert.equal(sends.length, 1, "one send");
  assert.match(js, /picksContract\.functions\.pick\(\{ player: who, game: BM\.GAME_ID, round: String\(BM\.picksRound\(view\)\), producers: \[\], number: String\(n\) \}, \{ onlyOperation: true \}\)/);
  const calls = new Set([...js.matchAll(/picksContract\.functions\.([a-z_]+)/g)].map((m) => m[1]));
  assert.deepEqual([...calls].sort(), ["get_pick", "pick"]);
  // the number sent is the one shown in the check pop-up, and it is encoded by the shared math
  assert.match(js, /const draftNumber = \(\) => \{ const s = seeding\(\); try \{ return filled\(\) \? BM\.encode\(draft, s\.size, s\.seeds\.length\) : null;/);
  assert.match(js, /btn\("Confirm in wallet", \(\) => send\(n\)\)/);
  assert.match(js, /BM\.lockTime\(view\) - Date\.now\(\) < 120000/, "refuses to send within 2 minutes of the lock");
});
test("the page says what the contract and recorder do (sizes, lock, scoring, ties, own nodes)", () => {
  for (const s of ["Saturday at 12:00 UTC", "Sunday 23:55 UTC", "with 12 to 15 the top seeds get a bye", "from 32 it is a 32-producer bracket", "under 8 there is no bracket", "an exact tie goes to the lower seed", "1 point in the first round, then 2, 4, 8 (and 16 in a 32-bracket), plus 2 for the right champion", "ties go to a right champion, then more right picks"]) assert.ok(page.includes(s), s);
  assert.match(page, /Disclosure: a KnodeGames node is in this bracket/);
  assert.match(read("terms.html"), /The Producer Bracket seeds whichever producers are in the race field/);
  assert.doesNotMatch(page + js, /\bodds\b|\bwager|\bbet\b|\bpays\s+\d/i);
});

// Survivor (site/survivor-math.js, shared by the page and the recorder bot/games/survivor.ts): the lock (the Picks
// contract's time rule), the 7-day handicap, the growing out-zone with ties safe, lives, the 1-use limit, the safety
// net, the season end, the ranking and the season prizes. Offline. Plus the page's static rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const APP = process.env.APP || ".";
const read = (f) => fs.readFileSync(`${APP}/site/${f}`, "utf8");
const box = { window: {} };
vm.runInNewContext(read("survivor-math.js"), box);
const S = box.window.KSurvivor;
const plain = (x) => JSON.parse(JSON.stringify(x));
const A = (c) => "1" + c.repeat(33);
const [P1, P2, P3, P4, P5, P6, P7, P8] = ["A", "B", "C", "D", "E", "F", "G", "H"].map(A);
const [U1, U2, U3, U4, U5] = ["J", "K", "L", "M", "N"].map(A);

test("the lock: a day's pick closes at 23:55 UTC the night before and opens 7 days ahead (the contract's rule)", () => {
  const d = S.dayIndex(Date.parse("2026-11-09T00:00:00Z"));
  assert.equal(S.lockTime(d), Date.parse("2026-11-08T23:55:00Z"));
  assert.equal(S.isOpen(d, Date.parse("2026-11-08T23:54:59.999Z")), true);
  assert.equal(S.isOpen(d, Date.parse("2026-11-08T23:55:00Z")), false, "pos < target − lead");
  assert.equal(S.isOpen(d, Date.parse("2026-11-09T00:00:00Z")), false);
  assert.equal(S.isOpen(d, Date.parse("2026-11-02T00:00:00Z")), true, "exactly 7 days ahead: target − pos ≤ ahead");
  assert.equal(S.isOpen(d, Date.parse("2026-11-01T23:59:59.999Z")), false);
  assert.ok(S.LEAD_MS >= 5 * 60000, "the contract's minimum lead");
  const t = Date.parse("2026-11-04T12:00:00Z"), open = S.openDays(t);
  assert.deepEqual(plain(open), Array.from({ length: 7 }, (_, i) => S.dayIndex(t) + 1 + i), "tomorrow and the 6 days after");
  assert.deepEqual(S.openDays(Date.parse("2026-11-04T23:56:00Z"))[0], S.dayIndex(Date.parse("2026-11-06T00:00:00Z")), "tomorrow is locked after 23:55");
});

test("seasons are 14 days from a Monday; before FIRST_DAY there is no season", () => {
  const first = S.dayIndex(Date.parse("2026-11-16T00:00:00Z"));
  assert.equal(S.isMonday(first), true);
  assert.equal(S.seasonOf(first - 1, first), null);
  assert.deepEqual(plain(S.seasonOf(first, first)), { season: 1, n: 1, start: first });
  assert.deepEqual(plain(S.seasonOf(first + 13, first)), { season: 1, n: 14, start: first });
  assert.deepEqual(plain(S.seasonOf(first + 14, first)), { season: 2, n: 1, start: first + 14 });
  assert.equal(S.seasonStartDay(3, first), first + 28);
  assert.equal(S.FIRST_DAY, null, "not launched: the owner sets it (a Monday) when the Picks contract is live");
  assert.equal(S.seasonOf(first), null, "with no launch set, no season");
});

test("the out-zone grows from a quarter of the field to half: 17 producers give 4,4,4,5,5,5,6,6,6,7,7,7,8,8", () => {
  assert.deepEqual(Array.from({ length: 14 }, (_, i) => S.outSize(17, i + 1)), [4, 4, 4, 5, 5, 5, 6, 6, 6, 7, 7, 7, 8, 8]);
  for (let m = 1; m <= 60; m++) for (let n = 1; n <= 14; n++) {
    const o = S.outSize(m, n);
    assert.ok(o >= Math.floor(m / 4) && o <= Math.floor(m / 2), `${m} producers, day ${n}`);
  }
  assert.equal(S.outSize(3, 1), 0, "a tiny field has no out-zone");
});

// A day's counts helper: [[producer, blocks], ...]
const day = (o) => Object.entries(o).map(([k, v]) => [A(k), v]);

test("the handicap is each producer's blocks over days d−8 … d−2; under 280 blocks is not in the field", () => {
  const d = 20400, days = new Map();
  assert.deepEqual(plain(S.formDays(d)), [d - 8, d - 7, d - 6, d - 5, d - 4, d - 3, d - 2]);
  for (const x of S.formDays(d)) days.set(x, { counts: day({ A: 400, B: 200, C: 100, D: 39 }) });
  days.set(d - 1, { counts: day({ A: 1, B: 99999 }) });      // yesterday is not used
  const f = S.fieldFor(d, days);
  assert.deepEqual(plain(f), [{ a: P1, k: 2800, h: 1 }, { a: P2, k: 1400, h: 2 }, { a: P3, k: 700, h: 4 }]);
  days.delete(d - 5);
  assert.equal(S.fieldFor(d, days), null, "a missing day: no field yet");
});

test("a day's score is blocks × handicap; the out-zone is below the line, ties at the line are safe", () => {
  const field = [P1, P2, P3, P4, P5, P6, P7, P8].map((a) => ({ a, k: 1000, h: 1 }));
  // 8 producers, day 1: out = floor(8 × 13 / 52) = 2.
  let r = S.scoreDay(field, day({ A: 10, B: 9, C: 8, D: 7, E: 6, F: 5, G: 4, H: 3 }), 1);
  assert.deepEqual(plain(r.out).sort(), [P7, P8]);
  assert.equal(r.line, 5);
  // Three tied at the bottom: the line is that score, so nobody below it: nobody out.
  r = S.scoreDay(field, day({ A: 10, B: 9, C: 8, D: 7, E: 6, F: 3, G: 3, H: 3 }), 1);
  assert.deepEqual(plain(r.out), []);
  // Two tied for 2nd-lowest, line between: only the lowest is out (ties at the line are safe).
  r = S.scoreDay(field, day({ A: 10, B: 9, C: 8, D: 7, E: 6, F: 4, G: 4, H: 3 }), 1);
  assert.deepEqual(plain(r.out), [P8]);
  // A producer that signs nothing scores 0.
  r = S.scoreDay(field, day({ A: 10, B: 9, C: 8, D: 7, E: 6, F: 5, G: 4 }), 1);
  assert.ok(r.out.includes(P8) && r.rows.find((x) => x.a === P8).score === 0);
  // The handicap counts.
  r = S.scoreDay([{ a: P1, k: 2000, h: 1 }, { a: P2, k: 500, h: 4 }, { a: P3, k: 1000, h: 2 }, { a: P4, k: 1000, h: 2 }], day({ A: 100, B: 30, C: 40, D: 60 }), 1);
  assert.deepEqual(plain(r.rows.map((x) => [x.a, x.score])), [[P2, 120], [P4, 120], [P1, 100], [P3, 80]]);
  assert.deepEqual(plain(r.out), [P3]);
});

// A small season harness: 8 producers, equal handicaps; each day says which producers land in the out-zone.
const FIELD = [P1, P2, P3, P4, P5, P6, P7, P8].map((a) => ({ a, k: 1000, h: 1 }));
function seasonDay(n, outs, picks, held = null) {
  // outs: producers to put at the bottom (they sign 1 block, the rest 100: tied, so safe).
  const counts = FIELD.map((f) => [f.a, outs.includes(f.a) ? 1 : 100]);
  const pk = Object.entries(picks).map(([p, a]) => [p, a]);
  return { n, field: FIELD, counts, picks: pk, noVhp: held ? Object.keys(picks).filter((p) => !held.includes(p)) : [] };
}

test("lives: the out-zone, no pick, a producer not in the field and a reused producer each cost a life", () => {
  // Day 1, 8 producers: out-zone is 2. P7, P8 out.
  const days = [
    seasonDay(1, [P7, P8], { [U1]: P1, [U2]: P7, [U3]: A("Z"), [U4]: P2, [U5]: P3 }),
    seasonDay(2, [P7, P8], { [U1]: P1, [U2]: P2, [U4]: P5, [U5]: P4 }),       // U1 reuses P1; U3 no pick
  ];
  const r = S.playSeason(days);
  const by = Object.fromEntries(r.players.map((x) => [x.a, x]));
  assert.equal(by[U1].lives, 1); assert.equal(by[U1].log, "su");
  assert.equal(by[U2].lives, 1); assert.equal(by[U2].log, "os");
  assert.equal(by[U3].lives, 0); assert.equal(by[U3].outN, 2); assert.equal(by[U3].log, "fn");
  assert.equal(by[U4].lives, 2); assert.equal(by[U5].lives, 2);
  assert.deepEqual(plain(by[U1].used), [P1], "an invalid pick isn't a use");
});

test("audit SV-1: the safety net never saves a missing, out-of-field or reused pick", () => {
  // One idle wallet: picks day 1, then nothing. It used to be saved every day (everyone would lose) and win 4 VHP.
  const idle = S.playSeason([seasonDay(1, [], { [U1]: P1 }), ...Array.from({ length: 13 }, (_, i) => seasonDay(i + 2, [], {}))]);
  assert.equal(idle.players[0].outN, 3); assert.equal(idle.players[0].log, "snn");
  assert.deepEqual(plain(S.prizes(idle.players)), []);
  // Three idle wallets: all out on day 3, nobody wins.
  const three = S.playSeason([seasonDay(1, [], { [U1]: P1, [U2]: P2, [U3]: P3 }), seasonDay(2, [], {}), seasonDay(3, [], {})]);
  assert.ok(three.players.every((x) => x.outN === 3));
  // Everyone would lose: the out-zone pick is saved, the missing one and the reused one are not.
  const mix = S.playSeason([seasonDay(1, [P8], { [U1]: P1, [U2]: P2, [U3]: P3 }), seasonDay(2, [P4], { [U1]: P4, [U3]: P3 })]);
  const by = Object.fromEntries(mix.players.map((x) => [x.a, x]));
  assert.equal(by[U1].log, "sv"); assert.equal(by[U1].lives, 2);
  assert.equal(by[U2].log, "sn"); assert.equal(by[U2].lives, 1);
  assert.equal(by[U3].log, "su"); assert.equal(by[U3].lives, 1);
});

test("a log letter for every outcome", () => {
  assert.deepEqual(plain(S.CODE), { safe: "s", out: "o", none: "n", field: "f", used: "u", saved: "v" });
});

test("only day 1's pickers are in the season", () => {
  const r = S.playSeason([seasonDay(1, [P8], { [U1]: P1, [U2]: P2, [U3]: P3 }), seasonDay(2, [P8], { [U1]: P2, [U2]: P3, [U3]: P4, [U4]: P5 })]);
  assert.deepEqual(plain(r.players.map((x) => x.a).sort()), [U1, U2, U3]);
});

test("safety net: if everyone still in would land in the out-zone the same day, nobody loses a life for it", () => {
  const r = S.playSeason([
    seasonDay(1, [P1, P2], { [U1]: P1, [U2]: P2, [U3]: P3 }),            // U3 safe: U1, U2 lose
    seasonDay(2, [P4, P5], { [U1]: P4, [U2]: P5, [U3]: P5 }),            // all three in the out-zone: saved
  ]);
  const by = Object.fromEntries(r.players.map((x) => [x.a, x]));
  assert.equal(by[U1].lives, 1); assert.equal(by[U2].lives, 1); assert.equal(by[U3].lives, 2);
  assert.equal(by[U3].log, "sv");
  assert.deepEqual(plain(by[U3].used), [P3, P5], "a saved pick still uses the producer");
});

test("the season ends after the day 2 or fewer are left, or after day 14", () => {
  const picks1 = { [U1]: P1, [U2]: P2, [U3]: P3, [U4]: P4 };
  // Day 1: U3 and U4 land in the out-zone; day 2: again → both out, 2 left: the season is over after day 2.
  const days = [seasonDay(1, [P3, P4], picks1), seasonDay(2, [P5, P6], { [U1]: P2, [U2]: P3, [U3]: P5, [U4]: P6 }), seasonDay(3, [], { [U1]: P7, [U2]: P8 })];
  const r = S.playSeason(days);
  assert.equal(r.over, true); assert.equal(r.endN, 2, "day 3 isn't played");
  const pl = Object.fromEntries(r.players.map((x) => [x.a, x]));
  assert.ok(pl[U1].outN === null && pl[U2].outN === null && pl[U3].outN === 2 && pl[U4].outN === 2);
  assert.deepEqual(plain(r.players.slice(0, 2).map((x) => x.a).sort()), [U1, U2], "the two still in rank first");
  // Started with 2: plays on.
  const two = S.playSeason([seasonDay(1, [], { [U1]: P1, [U2]: P2 }), seasonDay(2, [], { [U1]: P2, [U2]: P3 })]);
  assert.equal(two.over, false); assert.equal(two.endN, 2);
  // 14 days with nobody out (16 producers, all tied: safe), a new producer each day: over after day 14.
  const prods = "ABCDEFGHPQRSTWXY".split("").map(A), f16 = prods.map((a) => ({ a, k: 1000, h: 1 }));
  const many = [];
  for (let n = 1; n <= 14; n++) many.push({ n, field: f16, counts: prods.map((a) => [a, 100]), picks: [[U1, prods[n - 1]], [U2, prods[n]], [U3, prods[n + 1]]], noVhp: [] });
  const full = S.playSeason(many);
  assert.ok(full.players.every((x) => x.lives === 2 && x.log === "s".repeat(14)));
  assert.equal(full.over, true); assert.equal(full.endN, 14);
});

test("ranking: in longest, then lives, then total score; equal on all three share a place", () => {
  const ps = [
    { a: U1, lives: 1, outN: null, total: 50 }, { a: U2, lives: 2, outN: null, total: 10 }, { a: U3, lives: 0, outN: 9, total: 99 },
    { a: U4, lives: 0, outN: 4, total: 99 }, { a: U5, lives: 1, outN: null, total: 50 },
  ];
  assert.deepEqual(plain(S.rank(ps).map((x) => [x.a, x.place])), [[U2, 1], [U1, 2], [U5, 2], [U3, 4], [U4, 5]]);
});

test("prizes: 4 VHP and 2 VHP among wallets that held 1 VHP at every check; ties split the places they cover", () => {
  const P = (a, lives, total, eligible = true) => ({ a, lives, outN: null, total, eligible });
  assert.deepEqual(plain(S.prizes([P(U1, 2, 10), P(U2, 1, 10), P(U3, 1, 5)])), [{ player: U1, place: 1, vhp: 4 }, { player: U2, place: 2, vhp: 2 }]);
  assert.deepEqual(plain(S.prizes([P(U1, 2, 10), P(U2, 2, 10), P(U3, 1, 5)])), [{ player: U1, place: 1, vhp: 3 }, { player: U2, place: 1, vhp: 3 }]);
  assert.deepEqual(plain(S.prizes([P(U1, 2, 10), P(U2, 1, 9), P(U3, 1, 9)])), [{ player: U1, place: 1, vhp: 4 }, { player: U2, place: 2, vhp: 1 }, { player: U3, place: 2, vhp: 1 }]);
  // The winner held no VHP: the places move to the eligible.
  assert.deepEqual(plain(S.prizes([P(U1, 2, 10, false), P(U2, 1, 9), P(U3, 1, 5)])), [{ player: U2, place: 1, vhp: 4 }, { player: U3, place: 2, vhp: 2 }]);
  const three = S.prizes([P(U1, 2, 1), P(U2, 2, 1), P(U3, 2, 1)]);
  assert.ok(three.every((x) => x.vhp === 2) && three.reduce((s, x) => s + x.vhp, 0) <= 6, "three tied: 2 each");
  assert.deepEqual(plain(S.prizes([])), []);
  assert.deepEqual(plain(S.prizes([P(U1, 2, 10), P(U2, 1, 9)])), [], "fewer than 3 players joined: no prizes (default)");
  assert.equal(S.MIN_PRIZE_PLAYERS, 3);
  assert.deepEqual(plain(S.PRIZES), [4, 2]);
});

test("eligibility: missing from one daily check (no 1 VHP) loses the prize for the season", () => {
  const r = S.playSeason([seasonDay(1, [], { [U1]: P1, [U2]: P2 }), seasonDay(2, [], { [U1]: P2, [U2]: P3 }, [U1])]);
  const by = Object.fromEntries(r.players.map((x) => [x.a, x]));
  assert.equal(by[U1].eligible, true); assert.equal(by[U2].eligible, false);
});

test("the simulated design: 14 days, 2 lives, each producer once, 4 VHP + 2 VHP", () => {
  assert.equal(S.SEASON_DAYS, 14); assert.equal(S.LIVES, 2); assert.equal(S.USES, 1);
  assert.equal(S.GAME_ID, 3, "Block X is game 2 on the Picks contract");
});

// ── the page ──
const html = read("survivor.html");
test("the page: same CSP and integrity-pinned scripts as the other game pages, no inline scripts or handlers", () => {
  const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)[1];
  assert.equal(csp, /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(read("blockx.html"))[1]);
  assert.ok(csp.includes("https://raw.githubusercontent.com/bawcejawn/Knode/games-data/") && csp.includes("https://raw.githubusercontent.com/bawcejawn/Knode/blocks-data/"));
  assert.ok(!/<script>(?!\s*<\/script>)|<script(?![^>]*\bsrc=)[^>]*>/.test(html), "no inline scripts");
  assert.ok(!/\son[a-z]+=/i.test(html), "no inline handlers");
  for (const m of html.matchAll(/<script src="(https:[^"]+)"([^>]*)>/g)) assert.match(m[2], /integrity="sha384-[A-Za-z0-9+/=]+" crossorigin="anonymous"/, m[1]);
  for (const f of ["chain-blocks.js", "survivor-math.js", "survivor.js", "wallet.js", "nav.js"]) assert.ok(html.includes(`<script src="${f}"></script>`), f);
  assert.ok(html.indexOf("survivor-math.js") < html.indexOf('src="survivor.js"'), "the math loads first");
});
test("the page sends only Picks contract picks for game 3, and shows chain text as text", () => {
  const js = read("survivor.js");
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(js), "no HTML from data");
  const sends = [...js.matchAll(/W\.send\(/g)];
  assert.equal(sends.length, 1);
  assert.match(js, /picksContract\.functions\.pick\(\{ player: who, game: S\.GAME_ID, round: String\(d\), producers: \[producer\], number: "0" \}, \{ onlyOperation: true \}\)/);
  assert.ok(js.includes('"https://raw.githubusercontent.com/bawcejawn/Knode/games-data/survivor/"'));
  assert.ok(/Knode's own producers/.test(html) && /1 VHP/.test(html), "disclosures: own producers and the 1 VHP rule");
});
test("the page is listed for search and in the sitemap", () => {
  assert.ok(fs.readFileSync(`${APP}/sitemap.xml`, "utf8").includes("/site/survivor.html"));
  assert.ok(html.includes('<link rel="canonical" href="https://bawcejawn.github.io/Knode/site/survivor.html">'));
});

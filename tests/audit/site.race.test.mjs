// Producer Race (site/race-math.js, shared by race.js and the recorder bot/race.ts): race timing (UTC windows, the game
// week), resets, the 2-hourly handicap cards, the finish line, the 6-hour handicap's fairness, and the page rules
// (no odds, nobody past the line, the live order always shown, read only). Offline.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const APP = process.env.APP || ".";
const read = (f) => fs.readFileSync(`${APP}/${f}`, "utf8");
const box = { window: {} };
vm.runInNewContext(read("race-math.js"), box);
const M = box.window.KRaceMath;
const plain = (x) => JSON.parse(JSON.stringify(x));   // values made inside the sandbox, compared as plain data
const H = 3600000, U = (s) => Date.parse(s);
const dep = JSON.parse(fs.readFileSync(`${APP}/game-data/deployment.json`, "utf8"));

// ── timing ──
test("4 races a day on UTC boundaries 00/06/12/18, each 6 hours, numbered 1–4", () => {
  assert.equal(M.raceAt(U("2026-10-27T05:59:59.999Z")).id, "2026-10-27T00");
  assert.equal(M.raceAt(U("2026-10-27T06:00:00.000Z")).id, "2026-10-27T06");
  const r = M.raceAt(U("2026-10-27T13:21:00Z"));
  assert.equal(r.id, "2026-10-27T12"); assert.equal(r.start, U("2026-10-27T12:00Z")); assert.equal(r.end, U("2026-10-27T18:00Z")); assert.equal(r.number, 3);
  assert.deepEqual(["00", "06", "12", "18"].map((h) => M.raceAt(U(`2026-10-28T${h}:30Z`)).number), [1, 2, 3, 4]);
  assert.equal(M.parseRaceId("2026-10-27T12"), r.index); assert.equal(M.parseRaceId("2026-10-27T13"), null);
  // The next race starts the moment the last one ends: no gap, no overlap.
  assert.equal(M.raceAt(r.end).start, r.end);
});

test("races follow the Knode game's week exactly: Monday 00:00 UTC, 28 races a week", () => {
  assert.equal(M.GENESIS, dep.genesisTime, "same start as the game contract");
  assert.equal(M.WEEK, dep.weekLength, "same week length as the game contract");
  assert.equal(new Date(M.weekStart(1)).toISOString(), "2026-10-26T00:00:00.000Z");
  assert.equal(new Date(M.weekStart(1)).getUTCDay(), 1, "a Monday");
  // the contract's week_of: t <= genesis → 0, else (t - genesis) / week_length
  for (const t of [M.GENESIS - 1, M.GENESIS, M.GENESIS + 1, U("2026-10-25T23:59:59Z"), U("2026-10-26T00:00:00Z"), U("2026-11-02T00:00:00Z")]) {
    assert.equal(M.weekOf(t), t <= dep.genesisTime ? 0 : Math.floor((t - dep.genesisTime) / dep.weekLength));
  }
  const w0 = M.weekStart(3), ids = new Set();
  for (let t = w0; t < w0 + M.WEEK; t += M.RACE) { assert.equal(M.weekOf(t + 1), 3); ids.add(M.raceAt(t).id); }
  assert.equal(ids.size, 28);
  assert.equal(M.weekOf(M.raceAt(w0 - 1).start + 1), 2, "the last race of a week belongs to that week");
});

test("each race has 6 one-hour legs (a card at the start and every hour); races recorded with 3 keep 2-hour legs", () => {
  const s = U("2026-10-27T06:00Z");
  assert.deepEqual([0, 0.99, 1, 2.5, 4, 5.99, 6, 9].map((h) => M.legOf(s, s + h * H)), [0, 0, 1, 2, 4, 5, 5, 5]);
  assert.deepEqual([0, 1.99, 2, 3.5, 4, 5.99].map((h) => M.legOf(s, s + h * H, 3)), [0, 0, 1, 1, 2, 2]);
  assert.equal(M.LEG * M.LEGS, M.RACE); assert.equal(M.LEGS, 6);
  assert.equal(M.legsOf([null, null, null]), 3); assert.equal(M.legsOf(new Array(6).fill(null)), 6); assert.equal(M.legsOf(null), 6);
});

test("hourly cards: each block uses the card of its hour", () => {
  const B = chain([[R0.start + 10, Bb], [R0.start + H + 10, Bb], [R0.start + 5 * H + 10, Bb]]);
  const cards = [card(1, 2), card(1, 3), null, null, null, card(1, 7)];
  assert.equal(M.standings(B, R0, cards).find((x) => x.a === Bb).steps, 2 + 3 + 7);
  assert.equal(M.finishLine(cards), 100);
});

// ── a small field to race with ──
const A = "1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", Bb = "1BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", C = "1CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const card = (hA, hB, at = 0) => ({ at, c: 0, blocksPerRace: 7200, fairness: null, field: [{ a: A, vhp: 100, k: 100, h: hA }, { a: Bb, vhp: 50, k: 50, h: hB }], paddock: [{ a: C, vhp: 1, k: 1 }] });
function chain(blocks) { const signers = [A, Bb, C], ts = [], sig = []; for (const [t, who] of blocks) { ts.push(t); sig.push(signers.indexOf(who)); } return { ts, sig, signers }; }
const R0 = M.raceAt(U("2026-10-27T06:00Z"));

test("every horse starts each race from 0: blocks before the start or at/after the end never count", () => {
  const B = chain([[R0.start - 1, A], [R0.start, A], [R0.start + H, Bb], [R0.end - 1, A], [R0.end, A], [R0.end + H, Bb]]);
  const st = M.standings(B, R0, [card(1, 2), card(1, 2), card(1, 2)]);
  assert.deepEqual(plain(st.map((x) => [x.a, x.steps, x.blocks])), [[Bb, 2, 1], [A, 2, 2]], "2 steps each; B got there first (+1 h), so it is ahead");
  const next = M.raceAt(R0.end), st2 = M.standings(B, next, [card(1, 2), null, null]);
  assert.deepEqual(plain(st2.map((x) => [x.a, x.steps])), [[Bb, 2], [A, 1]], "the next race only sees its own blocks");
});

test("each block moves its horse by the handicap of the card for its leg; the paddock never moves", () => {
  const B = chain([[R0.start + 10, Bb], [R0.start + 2 * H + 10, Bb], [R0.start + 4 * H + 10, Bb], [R0.start + 4 * H + 20, C]]);
  const st = M.standings(B, R0, [card(1, 2), card(1, 3), card(1, 5)]);
  assert.equal(st.find((x) => x.a === Bb).steps, 2 + 3 + 5);
  assert.ok(!st.some((x) => x.a === C), "a paddock producer is not a horse");
});

test("a leg the recorder missed keeps the card before it; a first card that came late counts from the start", () => {
  assert.equal(M.cardForLeg([card(1, 2, 1), null, card(1, 4, 3)], 1).at, 1);
  assert.equal(M.cardForLeg([null, card(1, 3, 2), null], 0).at, 2);
  assert.equal(M.cardForLeg([null, null, null], 1), null);
});

test("standings during the race stop at the given time; a tie goes to whoever reached the total first", () => {
  const B = chain([[R0.start + 10, A], [R0.start + 20, A], [R0.start + 30, Bb], [R0.start + 3 * H, A]]);
  assert.equal(M.standings(B, R0, [card(1, 2)], R0.start + 25).find((x) => x.a === A).steps, 2);
  const st = M.standings(B, R0, [card(1, 2)], R0.start + 2 * H);
  assert.equal(st[0].steps, st[1].steps);
  assert.equal(st[0].a, A, "A reached 2 steps at +20 s, B only at +30 s: A is ahead");
});

test("finish line = the biggest horse's expected steps over the race (a third per leg)", () => {
  const c1 = card(1, 2), c2 = { ...card(1, 2), field: [{ a: A, vhp: 1, k: 130, h: 1 }] };
  assert.equal(M.finishLine([c1, c1, c1]), 100);
  assert.equal(M.finishLine([c1, c2, null]), Math.round(((100 + 130 + 130) / 3) * 100) / 100);
});

test("the live track shows the real order to the end: nobody waits at the line, nobody reaches it before the finish", () => {
  const st = [{ a: A, steps: 130, blocks: 1 }, { a: Bb, steps: 110, blocks: 1 }, { a: C, steps: 90, blocks: 1 }];
  const live = M.track(st, 100, false);
  assert.ok(live.every((r) => r.x < 1), "no horse at the line while the race runs, even ahead of pace");
  assert.ok(live[0].x > live[1].x && live[1].x > live[2].x, "the drawn order is the real order");
  assert.ok(Math.abs(live[0].x - M.LIVE_MAX) < 1e-9, "a leader ahead of pace is drawn just short of the line");
  assert.deepEqual(plain(live.map((r) => r.behind)), [0, 20, 40], "real gaps to the leader, with the handicap");
  const slow = M.track([{ a: A, steps: 50, blocks: 1 }, { a: Bb, steps: 25, blocks: 1 }], 100, false);
  assert.deepEqual(plain(slow.map((r) => r.x)), [0.5, 0.25], "behind pace: drawn against the finish line itself");
  const done = M.track(st, 100, true);
  assert.deepEqual(plain(done.map((r) => r.behind)), [0, 20, 40], "after the race: the real gaps");
  assert.equal(done[0].x, 1, "the winner sits on the line at the end");
  assert.ok(done.every((r) => r.x <= 1));
  assert.deepEqual(plain(M.track([], 100, false)), []);
  assert.deepEqual(plain(M.track([{ a: A, steps: 0, blocks: 0 }], 0, false).map((r) => r.x)), [0], "no steps, no cards: nobody moves");
  assert.deepEqual([...M.winners(st)], [A]);
  assert.deepEqual([...M.winners([{ a: A, steps: 0 }])], [], "no blocks, no winner");
});

// ── the handicap, re-tuned for 6 hours ──
// A field shaped like Koinos's producers on 2026-10-27 (share of producing VHP, %).
const SHARES = [19.88, 14.99, 12.44, 10.82, 10.11, 7.59, 5.66, 5.36, 4.31, 3.7, 1.36, 1.02, 0.9, 0.81, 0.56, 0.21, 0.15, 0.09, 0.03, 0.005];
const vhp = () => SHARES.map((s, i) => [`1Producer${String(i).padStart(2, "0")}`, s * 1000]);

test("6-hour card: the biggest moves 1 step per block, smaller ones more; under 10 expected blocks waits in the paddock", () => {
  const c = M.makeCard(vhp(), 7200);
  assert.equal(c.field[0].h, 1);
  for (let i = 1; i < c.field.length; i++) assert.ok(c.field[i].h > c.field[i - 1].h);
  assert.equal(M.MIN_K, 10);
  assert.ok(c.field.every((r) => r.k >= 10) && c.paddock.every((r) => r.k < 10) && c.paddock.length >= 3);
  assert.ok(c.c >= 0.8 && c.c <= 1.4, `c = ${c.c}`);
  assert.equal(JSON.stringify(M.makeCard(vhp(), 7200)), JSON.stringify(c), "the same card for everyone who computes it");
});

test("6-hour fairness: every horse's chance of winning is near 1 in N, and the old 24-hour tuning or no luck trim are not", () => {
  const c = M.makeCard(vhp(), 7200), ks = c.field.map((r) => r.k), n = ks.length, fair = 1 / n;
  const w = M.winChances(ks, c.field.map((r) => r.h), 20000, 4242);   // a different seed from the tuning
  for (const [i, x] of w.entries()) assert.ok(x > fair * 0.7 && x < fair * 1.3, `horse ${i}: ${(x * 100).toFixed(1)}% vs ${(fair * 100).toFixed(1)}%`);
  const old = M.winChances(ks, ks.map((k) => M.handicapOf(k, ks[0], 1.2)), 20000, 4242);
  const none = M.winChances(ks, ks.map((k) => ks[0] / k), 20000, 4242);
  const spread = (a) => Math.max(...a) - Math.min(...a);
  assert.ok(spread(w) < spread(old), "re-tuned is fairer than the 24-hour setting");
  assert.ok(none[n - 1] > fair * 3 && none[0] < fair * 0.2, "without the trim the smallest horse runs away with it");
});

test("no single producer runs away with it: over many simulated days the wins spread across the field", () => {
  const c = M.makeCard(vhp(), 7200), ks = c.field.map((r) => r.k), hs = c.field.map((r) => r.h);
  const R = M.rng(99), wins = new Map();
  for (let race = 0; race < 28 * 8; race++) {                       // 8 weeks of races
    let best = -1, who = -1;
    ks.forEach((k, i) => { const s = R.poisson(k) * hs[i]; if (s > best) { best = s; who = i; } });
    wins.set(who, (wins.get(who) || 0) + 1);
  }
  assert.ok(wins.size >= ks.length - 2, `${wins.size} different winners`);
  assert.ok(Math.max(...wins.values()) < 28 * 8 * 0.15, "nobody wins more than 15% of races");
});

// ── the page ──
test("the race page shows no odds, no wagers, no payouts", () => {
  for (const f of ["race.js", "race.html", "race-math.js"]) assert.doesNotMatch(read(f), /\bodds\b|\bpays\s+\d|\bpaysFor\b|\bwager|\bbet\b/i, f);
});

test("the race page sends only one thing itself: the wallet's own pick on the race contract, through the wallet", () => {
  for (const f of ["race-math.js", "chain-blocks.js"]) assert.doesNotMatch(read(f), /\.send\(|signTransaction|sendTransaction|onlyOperation/, f);
  const js = read("race.js");
  const sends = [...js.matchAll(/\.send\(/g)];
  assert.equal(sends.length, 1, "one send");
  assert.match(js, /raceContract\.functions\.pick\(\{ player: who, race: String\(index\), horse \}, \{ onlyOperation: true \}\)/);
  assert.match(js, /await W\.send\(`pick [^`]*`, \[operation\]\)/);
  assert.doesNotMatch(js, /signTransaction|sendTransaction|privateKey|wif/i);
  assert.match(js, /if \(Date\.now\(\) >= M\.raceStart\(index\)\)/, "the page also refuses a started race (the chain enforces it)");
  assert.match(read("race.js"), /localStorage\.removeItem\("pr-guesses-v1"\)/);
  assert.match(read("race.html"), /<script src="race-math\.js"><\/script>\s*<script src="board\.js"><\/script>\s*<script src="stake-panel\.js"><\/script>\s*<script src="race\.js"><\/script>/);
});

// The shared stake panel (stake-panel.js): the only other thing that sends from a game page.
test("stake panel: sends only the vault's own stake calls (and the approve for a stake), for the connected wallet, through the wallet", () => {
  const js = read("stake-panel.js");
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function|localStorage|sessionStorage|indexedDB|signTransaction|sendTransaction|privateKey|wif/i);
  assert.equal([...js.matchAll(/\.send\(/g)].length, 1, "one place sends: W.send");
  assert.match(js, /await W\.send\(label, ops, \{\}\)/);
  assert.match(js, /if \(!W \|\| W\.address !== who\) \{ say\("Your wallet changed: nothing was sent/, "it never signs for a wallet other than the one shown");
  const ops = [...js.matchAll(/op\((\w+), "(\w+)", \{([^}]*)\}\)/g)].map((m) => [m[1], m[2], m[3].trim()]);
  assert.deepEqual(ops, [
    ["vault", "claim_game", "player: who, game: o.game, week: String(w)"],
    ["t", "approve", "owner: who, spender: dep.contract, value: units.toString()"],
    ["vault", "deposit_to", "from: who, game: o.game, amount: units.toString(), koin"],
    ["vault", "withdraw_from", "to: who, game: o.game, amount: units.toString()"],
    ["vault", "move_stake", "player: who, from_game: o.game, to_game: to, amount: units.toString()"],
  ], "the player is always the connected wallet; the approve is only for the vault, for the staked amount");
  assert.match(js, /const who = me\.who/);
  assert.match(js, /v6_rule_week_plus_one \|\| 0\) > 0\)\) return;/, "hidden until the vault is live");
  assert.match(js, /const canStake = \(\) => !!\(game && game\.active && game\.staked && !cfg\.paused\)/, "only Stake waits for an active, unpaused game");
  assert.match(js, /disabled: me\.total === 0n \}, "Withdraw"\)/, "Withdraw is there whenever there's a stake, active game or not");
  assert.match(js, /if \(!abi\.methods \|\| !abi\.methods\.deposit_to/, "hidden while the site's ABI is still v5");
  assert.match(js, /if \(kind === "guest"\) \{/, "a guest wallet gets no stake buttons");
});

test("stake panel: amounts, the minimum and claims follow the vault's rules", async () => {
  globalThis.window = globalThis; globalThis.location = { href: "https://knodegames.com/race.html" };
  await import(`${process.cwd()}/${APP}/stake-panel.js`);
  const K = globalThis.KStake;
  assert.deepEqual([K.toUnits("1"), K.toUnits("2.5"), K.toUnits("0.00000001")], [100000000n, 250000000n, 1n]);
  assert.deepEqual([K.toUnits("1.000000001"), K.toUnits("-1"), K.toUnits("1e3"), K.toUnits(""), K.toUnits(" 3 ")], [null, null, null, null, 300000000n]);
  assert.equal(K.vhp(250000000n), "2.5"); assert.equal(K.vhp(1234500000000n), "12,345");
  const cfg = { min_stake: "100000000", min_stake_next: "300000000", min_stake_next_week: 5 };
  assert.deepEqual([K.minStake(cfg, 4), K.minStake(cfg, 5)], [100000000n, 300000000n]);
  const gw = { finalized: true, prize_first: "200000000", prize_second: "0", cutoff: 4, rolled_over: false };
  assert.equal(K.claimable(gw, [], { prize_place: 1 }), 200000000n);
  assert.equal(K.claimable(gw, [], { prize_place: 2 }), 0n, "2nd gets nothing when 1st is shared");
  assert.equal(K.claimable(gw, [], { points: 3 }), 0n, "under the cutoff");
  assert.equal(K.claimable({ ...gw, finalized: false }, [], { prize_place: 1 }), 0n, "not final yet");
  assert.equal(K.claimable(gw, [], { prize_place: 1, claimed: true }), 0n, "already claimed");
  assert.equal(K.claimable({ ...gw, rolled_over: true }, [], { points: 9 }), 0n, "a rolled-over bucket");
  // A staked winner: the vault's rewardOfG, exactly. Two winners in the 5-point bucket (weight 30), stakes 4 and 20 VHP.
  const V = 100000000n;
  const week = { ...gw, pot_a: String(40n * V), pot_b: String(60n * V), aw_lo: String(60n * 14n * V), aw_hi: "0", bw_lo: String(60n * 24n * V), bw_hi: "0" };
  const buckets = []; buckets[5] = { players: 2, sum_w: "60" };
  const a = K.claimable(week, buckets, { points: 5, stake: String(4n * V) }), b = K.claimable(week, buckets, { points: 5, stake: String(20n * V) });
  // Basket A counts stakes up to 10: 4 and 10 of 14; basket B 4 and 20 of 24.
  assert.equal(a, (40n * V * (60n * 4n * V / 2n)) / (60n * 14n * V) + (60n * V * (60n * 4n * V / 2n)) / (60n * 24n * V));
  assert.equal(a + b <= 100n * V, true, "never more than the bucket");
  assert.equal(K.claimable({ ...week, pot_a: "0", pot_b: "0" }, buckets, { points: 5, stake: String(4n * V) }), 0n, "an empty bucket: no claim offered");
  assert.equal(K.rewardOf(week, [], { points: 5, stake: "1" }), 0n, "no bucket: nothing (never divides by zero)");
  // Where a wallet stands this week, by the vault's rules.
  const min = V;
  assert.equal(K.standing({ active_stake: String(2n * V), week_stake: String(2n * V) }, min), "staked");
  assert.equal(K.standing({ entry: { peak_stake: String(5n * V) }, week_stake: String(V / 2n) }, min), "neither", "withdrew below the minimum mid-week");
  assert.equal(K.standing({ active_stake: String(V / 2n), week_stake: "0" }, min), "free");
});

test("the shared leaderboard (board.js) only draws: no network, no storage, no wallet, no HTML from data", () => {
  const js = read("board.js");
  assert.doesNotMatch(js, /fetch\(|XMLHttpRequest|localStorage|sessionStorage|indexedDB|\.send\(|innerHTML|outerHTML|insertAdjacentHTML|eval\(|new Function/);
  assert.match(js, /textContent = v/);
});

test("the recorder's files are read only from the race-data branch", () => {
  assert.match(read("race.js"), /const DATA = "https:\/\/raw\.githubusercontent\.com\/bawcejawn\/Knode\/race-data\/"/);
  assert.match(read("race.html"), /connect-src [^"]*https:\/\/raw\.githubusercontent\.com\/bawcejawn\/Knode\/race-data\//);
});

test("the pick lists for upcoming races are never empty once any card exists: a race's own card, else the latest one", () => {
  const js = read("race.js");
  assert.match(js, /const fieldOf = \(r\) => \(r\.cards && !r\.provisional && M\.cardForLeg\(r\.cards, 0\)\) \|\| latest\(\);/);
  assert.match(js, /const latest = \(\) => \{ const lr = raceObj\(cur\); return \(lr\.cards && M\.cardForLeg\(lr\.cards, M\.legOf\(lr\.start, Date\.now\(\), M\.legsOf\(lr\.cards\)\)\)\) \|\| prov; \};/);
});

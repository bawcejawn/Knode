// Survivor recorder (bot/games/survivor.ts): days recorded only once irreversible and matching on two nodes, a few a
// run; today's and tomorrow's handicaps once the 7 days behind them are in; seasons played from picks that agree on
// both nodes (late picks ignored), the daily 1 VHP check, the end, and the prizes after the 12-hour correction window.
// The files must pass the publish job's own shape check (.github/workflows/games.yml). Offline: fake nodes.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const APP = process.env.APP || ".";
const { run, encodeSeason, readRanked, vaultFiles, vaultWeekOf } = await import(path.resolve(APP, "bot/games/survivor.ts"));
const S = globalThis.KSurvivor;
const A = (c) => "1" + c.repeat(33);
const PRODS = ["A", "B", "C", "D", "E"].map(A);
const [ALICE, BOB, CAROL, DAVE, EVE] = ["J", "K", "L", "M", "N"].map(A);

// Season 1 starts Monday 16 Nov 2026. The fake chain starts 10 days before; one block every 3 s, 28,800 a day.
const FIRST = S.dayIndex(Date.parse("2026-11-16T00:00:00Z"));
const T0 = S.dayStart(FIRST - 10);
const T = (h) => T0 + h * 3000;
const H = (t) => Math.ceil((t - T0) / 3000);
// On UTC day d, producer z(d) = PRODS[d % 5] signs nothing (it lands in the out-zone); the other four share the day.
const z = (d) => PRODS[d % 5];
const signerAt = (h) => { const d = S.dayIndex(T(h)), others = PRODS.filter((p) => p !== z(d)); return others[h % 4]; };
function blocksOf(tamperDay = null) {
  return async (node, a, b) => {
    const ts = [], signers = [];
    for (let h = a; h <= b; h++) { ts.push(T(h)); signers.push(node === "check" && tamperDay !== null && S.dayIndex(T(h)) === tamperDay && h % 1000 === 0 ? z(tamperDay) : signerAt(h)); }
    return { ts, signers };
  };
}
const timeOf = async (node, h) => T(h);
const P = (d, k) => PRODS[(d + k) % 5];
// Alice and Eve always pick safe, a new producer each day; Bob picks the out-zone on days 1 and 2; Carol on days 1
// and 3; Dave's only day-1 pick comes after the lock (the chain refuses those; the recorder ignores it too).
function picksOf(tamperDay = null) {
  return async (node, d) => {
    const n = d - FIRST + 1, before = S.lockTime(d) - 3600000;
    const rows = [
      { player: ALICE, producer: P(d, 1), time: before },
      { player: EVE, producer: P(FIRST, n + 1), time: before },
    ];
    if (n <= 2) rows.push({ player: BOB, producer: z(d), time: before });
    rows.push({ player: CAROL, producer: n === 2 ? P(FIRST, 4) : z(d), time: before });
    if (n === 1) rows.push({ player: DAVE, producer: P(d, 1), time: S.lockTime(d) });
    if (node === "check" && d === tamperDay) rows[0].producer = z(d);
    return rows;
  };
}
const rankedOf = async (node, who) => new Set(who.filter((a) => a !== EVE));
const GAME3 = { id: 3, kind: 1, list_size: 1, lock_mode: 2, round_size: String(S.DAY), round_offset: "0", lead: String(S.LEAD_MS), ahead: String(S.AHEAD_MS), max_picks_per_day: 20, max_changes: 5, enabled: true };
const gameOf = async () => GAME3;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "survivor-"));
const quiet = async (f) => { const log = console.log; console.log = () => {}; try { return await f(); } finally { console.log = log; } };
/** A head at time t: irreversible about 1 minute behind. */
const headAt = (t) => { const height = H(t), lib = height - 20; return { height, time: T(height), lib, libTime: T(lib) }; };
async function runs(times, opts = {}, prev = "") {
  let out, r;
  for (const t of times) {
    out = tmp();
    r = await quiet(() => run({ p: "main", check: "check", prev, out, firstDay: FIRST, picksContract: A("P"), blocksOf: blocksOf(), timeOf, picksOf: picksOf(), rankedOf, gameOf, head: headAt(t), ...opts }));
    prev = out;
  }
  return { out, r, read: (f) => JSON.parse(fs.readFileSync(path.join(out, f), "utf8")) };
}

test("days: recorded only once the next day has an irreversible block, 3 a run, then today's and tomorrow's handicaps", async () => {
  const t = S.dayStart(FIRST - 1) + 3600000;                   // Sunday 01:00 UTC, the day before Season 1
  const one = await runs([t]);
  assert.equal(one.read("days.json").days.length, 3);
  assert.deepEqual(one.read("fields.json").fields, []);
  const all = await runs([t, t + 60000, t + 120000, t + 180000]);
  const days = all.read("days.json").days.map((x) => x.day);
  assert.deepEqual(days, Array.from({ length: 8 }, (_, i) => FIRST - 9 + i), "d−9 … d−2 for today d (= FIRST − 1): today's d−8 … d−2 and tomorrow's d−7 … d−1");
  assert.ok(!days.includes(FIRST - 1), "today isn't over");
  for (const x of all.read("days.json").days) {
    assert.equal(x.blocks, 28800); assert.equal(x.checked, 2);
    assert.equal(x.counts.find((c) => c[0] === z(x.day)), undefined, "the producer that signed nothing that day");
  }
  const f = all.read("fields.json").fields;
  assert.deepEqual(f.map((x) => [x.day, x.season, x.n, x.out, x.field.length]), [[FIRST - 1, null, null, 1, 5], [FIRST, 1, 1, 1, 5]]);
  const top = Math.max(...f[1].field.map((x) => x.k));
  for (const x of f[1].field) assert.equal(x.h, Math.round((top / x.k) * 1e4) / 1e4);
  assert.deepEqual(all.read("index.json").seasons, [], "no season day is over yet");
});

test("a day the two nodes disagree on is not recorded; it is tried again next run", async () => {
  const t = S.dayStart(FIRST - 1) + 3600000, bad = FIRST - 9;
  const r = await runs([t], { blocksOf: blocksOf(bad) });
  assert.ok(!r.read("days.json").days.some((x) => x.day === bad));
  assert.ok(r.r.problems.some((p) => p.includes("disagree")));
  const again = await runs([t + 60000], {}, path.dirname(path.join(r.out, "x")));
  assert.ok(again.read("days.json").days.some((x) => x.day === bad));
});

test("a season: day-1 pickers only, late picks ignored, lives, the end with 2 left, the 1 VHP check, prizes once final", async () => {
  const start = S.dayStart(FIRST - 1) + 3600000;
  const times = [start, start + 60000, start + 120000, start + 180000];
  for (let n = 1; n <= 3; n++) times.push(S.dayStart(FIRST + n) + 3600000);   // the hour after each season day
  const r = await runs(times);
  assert.deepEqual(r.r.problems, []);
  const sf = r.read("S001.json");
  assert.equal(sf.startDay, FIRST);
  assert.deepEqual(sf.days.map((x) => x.n), [1, 2, 3]);
  assert.equal(sf.v, 2, "Repo Lense SV-A5: wallets and producers written once, the days refer to them by position");
  const W = (i) => sf.who[i];
  assert.ok(!sf.days[0].picks.some((p) => W(p[0]) === DAVE), "a pick at the lock time doesn't count");
  const by = Object.fromEntries(sf.result.players.map((x) => [x.a, x]));
  assert.deepEqual(Object.keys(by).sort(), [ALICE, BOB, CAROL, EVE].sort());
  assert.equal(by[BOB].outN, 2); assert.equal(by[CAROL].outN, 3);
  assert.equal(by[ALICE].outN, null); assert.equal(by[ALICE].lives, 2); assert.equal(by[EVE].lives, 2);
  assert.equal(by[EVE].eligible, false, "held no VHP at the checks");
  assert.ok(sf.days.slice(1).every((x) => x.picks.every((p) => p.length === 2)), "picks are [player, producer]");
  assert.ok(!sf.days[2].picks.some((p) => W(p[0]) === BOB), "audit SV-2: a player who is out keeps no picks in the file");
  assert.deepEqual(sf.days.map((x) => x.noVhp.map(W)), [[EVE], [], []], "Repo Lense SV-A5: a missed check is listed once");
  assert.equal(sf.result.over, true); assert.equal(sf.result.endN, 3);
  assert.equal(sf.result.final, false, "inside the 12-hour correction window");
  assert.deepEqual(sf.result.prizes, []);
  // 12 hours after the last day: final, and the prizes go to the eligible.
  const fin = await runs([S.dayStart(FIRST + 3) + 12 * 3600000 + 60000], {}, r.out);
  const sf2 = fin.read("S001.json");
  assert.equal(sf2.result.final, true);
  assert.deepEqual(sf2.result.prizes.map((p) => [p.player, p.vhp]), [[ALICE, 4], [CAROL, 2]], "Eve can't win: no 1 VHP; Carol lasted longer than Bob");
  assert.deepEqual(fin.read("index.json").seasons, [1]);
  // A final season is never played again.
  const later = await runs([S.dayStart(FIRST + 5) + 3600000], { picksOf: async () => { throw new Error("must not read picks for a final season"); } }, fin.out);
  assert.deepEqual(later.read("S001.json").result, sf2.result);
});

test("season picks the two nodes disagree on stop the season there until they agree", async () => {
  const start = S.dayStart(FIRST - 1) + 3600000;
  const times = [start, start + 60000, start + 120000, start + 180000, S.dayStart(FIRST + 1) + 3600000];
  const r = await runs(times, { picksOf: picksOf(FIRST) });
  assert.ok(r.r.problems.some((p) => p.includes("disagree about the picks")));
  assert.deepEqual(r.read("S001.json").days, [], "nothing recorded for the season yet (the file keeps it on the list)");
});

test("no season before the Picks contract is live or FIRST_DAY is set; FIRST_DAY must be a Monday", async () => {
  const t = S.dayStart(FIRST + 2) + 3600000;
  for (const o of [{ picksContract: null }, { firstDay: null }]) {
    const r = await runs([t - 3 * 60000, t - 2 * 60000, t - 60000, t], { ...o, picksOf: o.picksContract === null ? undefined : picksOf() });
    assert.deepEqual(r.read("index.json").seasons, []);
    assert.ok(r.read("fields.json").fields.length === 2, "the handicaps are still published");
  }
  await assert.rejects(() => run({ p: "main", check: null, out: tmp(), firstDay: FIRST + 1, picksContract: null, blocksOf: blocksOf(), timeOf, head: headAt(t) }), /Monday/);
});

test("the files pass the publish job's shape check", async (t) => {
  const yml = fs.readFileSync(path.join(APP, ".github/workflows/games.yml"), "utf8");
  const m = /if \[ -d "\$IN\/survivor" \]; then \/usr\/bin\/python3 -I - "\$IN\/survivor" <<'PY' \|\| rc=\$\?\n([\s\S]*?)\n\s*PY\n/.exec(yml);
  assert.ok(m, "the survivor check is in the workflow");
  const indent = /^(\s*)/.exec(m[1])[1].length;
  const py = m[1].split("\n").map((l) => l.slice(indent)).join("\n");
  try { execFileSync("python3", ["--version"]); } catch { t.skip("python3 not installed"); return; }
  const start = S.dayStart(FIRST - 1) + 3600000;
  const times = [start, start + 60000, start + 120000, start + 180000];
  for (let n = 1; n <= 3; n++) times.push(S.dayStart(FIRST + n) + 3600000);
  times.push(S.dayStart(FIRST + 3) + 12 * 3600000 + 60000);
  const r = await runs(times);
  const outp = execFileSync("python3", ["-", r.out], { input: py }).toString();
  assert.match(outp, /survivor files ok/);
  // And a tampered file is refused.
  const bad = tmp();
  fs.cpSync(r.out, bad, { recursive: true });
  const s = JSON.parse(fs.readFileSync(path.join(bad, "S001.json"), "utf8"));
  s.result.prizes[0].vhp = 50;
  fs.writeFileSync(path.join(bad, "S001.json"), JSON.stringify(s));
  assert.throws(() => execFileSync("python3", ["-", bad], { input: py, stdio: "pipe" }));
});

test("audit SV-7: the 1 VHP check needs both nodes to agree", async () => {
  const start = S.dayStart(FIRST - 1) + 3600000;
  const times = [start, start + 60000, start + 120000, start + 180000, S.dayStart(FIRST + 1) + 3600000];
  const r = await runs(times, { rankedOf: async (node, who) => new Set(who.filter((a) => a !== EVE && !(node === "check" && a === ALICE))) });
  const by = Object.fromEntries(r.read("S001.json").result.players.map((x) => [x.a, x]));
  assert.equal(by[ALICE].eligible, false, "the second node says Alice holds no VHP");
  assert.equal(by[CAROL].eligible, true);
});

test("audit SV-9: game 3's settings on the chain must match the math, or no season is recorded", async () => {
  const start = S.dayStart(FIRST - 1) + 3600000;
  const times = [start, start + 60000, start + 120000, start + 180000, S.dayStart(FIRST + 1) + 3600000];
  for (const bad of [{ ...GAME3, lead: "600000" }, { ...GAME3, round_offset: "3600000" }, { ...GAME3, lock_mode: 1 }, null]) {
    const r = await runs(times, { gameOf: async () => bad });
    assert.ok(!fs.existsSync(path.join(r.out, "S001.json")));
    assert.ok(r.r.problems.some((p) => /game 3/.test(p)), JSON.stringify(r.r.problems));
  }
});

test("audit SV-4: after an outage longer than a week, the season still gets the days it needs", async () => {
  const start = S.dayStart(FIRST - 1) + 3600000;
  const before = [start, start + 60000, start + 120000, start + 180000, S.dayStart(FIRST + 1) + 3600000];
  const r = await runs(before);
  assert.equal(r.read("S001.json").days.length, 1);
  // 10 days with no runs, then hourly runs until it catches up.
  const back = S.dayStart(FIRST + 11) + 3600000, after = Array.from({ length: 10 }, (_, i) => back + i * 3600000);
  const r2 = await runs(after, {}, r.out);
  const sf = r2.read("S001.json");
  assert.deepEqual(sf.days.map((x) => x.n), [1, 2, 3], "days 2 and 3 recorded after the outage; it ended on day 3");
  assert.equal(sf.result.over, true); assert.equal(sf.result.final, true);
  assert.deepEqual(sf.result.prizes.map((p) => p[0] ?? p.player), [ALICE, CAROL]);
});

test("audit SV-6 / FC-1: a wrong day boundary in the last run's days.json is caught and searched again", async () => {
  const t = S.dayStart(FIRST - 1) + 3600000;
  const r = await runs([t]);
  const j = r.read("days.json");
  j.days[j.days.length - 1].heights[1] += 500;                 // the last recorded day "ends" 500 blocks too late
  j.days[j.days.length - 1].blocks += 500;
  j.days[j.days.length - 1].counts[0][1] += 500;
  fs.writeFileSync(path.join(r.out, "days.json"), JSON.stringify(j));
  const r2 = await runs([t + 60000], {}, r.out);
  const next = j.days[j.days.length - 1].day + 1;
  const rec = r2.read("days.json").days.find((x) => x.day === next);
  assert.ok(rec && rec.blocks === 28800, "the next day is recorded in full in the same run");
  assert.ok(r2.r.problems.some((p) => p.includes("searched again")));
});

test("fix-check FC-2: a season that can't progress never stops new days and handicaps", async () => {
  const start = S.dayStart(FIRST - 1) + 3600000;
  // Day 1's picks always disagree between the nodes: season 1 can never record a day.
  const stuck = picksOf(FIRST);
  const times = [start, start + 60000, start + 120000, start + 180000];
  for (let k = 1; k <= 70; k++) times.push(S.dayStart(FIRST + k) + 3600000);
  const r = await runs(times, { picksOf: stuck });
  const today = FIRST + 70, days = r.read("days.json").days.map((x) => x.day);
  assert.ok(days.includes(today - 1), "yesterday is recorded");
  assert.deepEqual(r.read("fields.json").fields.map((x) => x.day), [today, today + 1], "today's and tomorrow's handicaps are out");
  assert.ok(r.r.problems.some((p) => /season 1 is stuck/.test(p)), "the stuck season is reported for the owner");
});

test("audit SV-2 and SV-3: a 1,000-player season fits under 2 MB, and a 1,000-way tie for the prize passes the check (never over 6 VHP)", async (t) => {
  const yml = fs.readFileSync(path.join(APP, ".github/workflows/games.yml"), "utf8");
  const m = /if \[ -d "\$IN\/survivor" \]; then \/usr\/bin\/python3 -I - "\$IN\/survivor" <<'PY' \|\| rc=\$\?\n([\s\S]*?)\n\s*PY\n/.exec(yml);
  const indent = /^(\s*)/.exec(m[1])[1].length;
  const py = m[1].split("\n").map((l) => l.slice(indent)).join("\n");
  try { execFileSync("python3", ["--version"]); } catch { t.skip("python3 not installed"); return; }
  // Worst case for size: nobody ever goes out (every producer ties), 1,000 players, 14 days, real-length addresses.
  const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const addr = (i) => { let x = "", k = i; do { x = B58[k % 58] + x; k = Math.floor(k / 58); } while (k); return "1" + ("Q".repeat(33) + x).slice(-33); };
  const prods = Array.from({ length: 17 }, (_, i) => addr(900000 + i)), players = Array.from({ length: 1000 }, (_, i) => addr(i));
  const field = prods.map((a) => ({ a, k: 40000, h: 1 })), days = [];
  for (let n = 1; n <= 14; n++) days.push({ n, day: FIRST + n - 1, field, counts: prods.map((a) => [a, 1694]), picks: players.map((p, i) => [p, prods[(i + n) % 17]]), noVhp: [] });
  const played = S.playSeason(days);
  const sf = { v: 1, season: 1, startDay: FIRST, days, result: { over: played.over, endN: played.endN, final: true, players: played.players, prizes: S.prizes(played.players) } };
  assert.equal(new Set(players).size, 1000);
  assert.equal(sf.result.prizes.length, 1000, "a 1,000-way tie for 1st");
  assert.ok(sf.result.prizes.reduce((s, p) => s + Math.round(p.vhp * 1e8), 0) <= 6e8, "at most 6 VHP, counted in 1e-8 units");
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "S001.json"), JSON.stringify(encodeSeason(sf)) + "\n");
  const size = fs.statSync(path.join(dir, "S001.json")).size;
  assert.ok(size < 2 * 1024 * 1024, `S001.json is ${(size / 1048576).toFixed(2)} MB`);
  assert.match(execFileSync("python3", ["-", dir], { input: py }).toString(), /survivor files ok/);
});

// ── Repo Lense fixes ──
const seasonTimes = () => {
  const start = S.dayStart(FIRST - 1) + 3600000;
  const t = [start, start + 60000, start + 120000, start + 180000];
  for (let n = 1; n <= 3; n++) t.push(S.dayStart(FIRST + n) + 3600000);
  t.push(S.dayStart(FIRST + 3) + 12 * 3600000 + 60000);
  return t;
};
function publishCheck() {
  const yml = fs.readFileSync(path.join(APP, ".github/workflows/games.yml"), "utf8");
  const m = /if \[ -d "\$IN\/survivor" \]; then \/usr\/bin\/python3 -I - "\$IN\/survivor" <<'PY' \|\| rc=\$\?\n([\s\S]*?)\n\s*PY\n/.exec(yml);
  const indent = /^(\s*)/.exec(m[1])[1].length;
  const py = m[1].split("\n").map((l) => l.slice(indent)).join("\n");
  return (dir) => { try { execFileSync("python3", ["-I", "-", dir], { input: py, stdio: "pipe" }); return true; } catch { return false; } };
}
function copyOut(from, edit) {
  const dir = tmp();
  fs.cpSync(from, dir, { recursive: true });
  const j = JSON.parse(fs.readFileSync(path.join(dir, "S001.json"), "utf8"));
  edit(j);
  fs.writeFileSync(path.join(dir, "S001.json"), JSON.stringify(j));
  return dir;
}

test("Repo Lense SV-A4 / SV-A13: the publish check tests meaning, not only shape", async (t) => {
  try { execFileSync("python3", ["--version"]); } catch { t.skip("python3 not installed"); return; }
  const ok = publishCheck();
  const r = await runs(seasonTimes());
  assert.equal(ok(r.out), true, "the recorder's own files pass");
  const OUTSIDER = A("Z");
  const bad = {
    "prize to a wallet not in the season": (j) => { j.result.prizes[0].player = OUTSIDER; },
    "prize to an ineligible player": (j) => { j.result.prizes[0].player = EVE; },
    "both prizes to one wallet": (j) => { j.result.prizes[1].player = j.result.prizes[0].player; },
    "prizes before the season is final": (j) => { j.result.final = false; },
    "place 3": (j) => { j.result.prizes[1].place = 3; },
    "a player not on day 1": (j) => { j.result.players[0].a = OUTSIDER; },
    "lives that don't match the log": (j) => { j.result.players.find((p) => p.outN !== null).lives = 2; },
    "out with lives left": (j) => { const p = j.result.players.find((x) => x.outN === null); p.outN = 1; },
    "places out of order": (j) => { j.result.players.reverse(); },
    "a negative score": (j) => { j.result.players[0].total = -1; },
    "true where a number is meant": (j) => { j.result.players[0].place = true; },
    "1.0 where an integer is meant": (j) => { j.days[0].n = 1.5; },
    "an integer above 2^53": (j) => { j.days[0].counts[0][1] = 2 ** 60; },
    "a pick index out of range": (j) => { j.days[0].picks[0][0] = j.who.length; },
    "the same wallet twice in who": (j) => { j.who.push(j.who[0]); },
    "a forged v1 file": (j) => { j.v = 1; },
    // Fix-check: the check plays the season again from its days, so the result can't be rewritten on its own.
    "last place rewritten as the winner": (j) => { const ps = j.result.players; [ps[0].a, ps[ps.length - 1].a] = [ps[ps.length - 1].a, ps[0].a]; },
    "listed as missing a VHP check but eligible": (j) => { const w = j.who.indexOf(ALICE); j.days[1].noVhp.push(w); },
    "2nd place given 4 VHP": (j) => { j.result.prizes[1].vhp = 4; j.result.prizes[0].vhp = 2; },
    "a lost life erased": (j) => { const p = j.result.players.find((x) => x.log.includes("o")); p.log = p.log.replace("o", "s"); },
  };
  for (const [why, edit] of Object.entries(bad)) assert.equal(ok(copyOut(r.out, edit)), false, why);
  // A bad `updated`, and NaN, are refused too.
  const d2 = tmp();
  fs.cpSync(r.out, d2, { recursive: true });
  fs.writeFileSync(path.join(d2, "days.json"), fs.readFileSync(path.join(r.out, "days.json"), "utf8").replace(/"updated":"[^"]*"/, `"updated":"${"x".repeat(1000)}"`));
  assert.equal(ok(d2), false, "updated must be an ISO time");
  const d3 = tmp();
  fs.cpSync(r.out, d3, { recursive: true });
  fs.writeFileSync(path.join(d3, "fields.json"), fs.readFileSync(path.join(r.out, "fields.json"), "utf8").replace(/"h":[0-9.]+/, `"h":NaN`));
  assert.equal(ok(d3), false, "NaN is refused");
});

test("Repo Lense SV-A4: a forged result in the last run's files is replaced by the season played again", async () => {
  const r = await runs(seasonTimes());
  const real = r.read("S001.json").result;
  const forged = copyOut(r.out, (j) => { j.result.prizes = [{ player: EVE, place: 1, vhp: 4 }, { player: BOB, place: 2, vhp: 2 }]; });
  const again = await runs([S.dayStart(FIRST + 4) + 3600000], {}, forged);
  assert.deepEqual(again.read("S001.json").result.prizes, real.prizes);
});

test("Repo Lense SV-A3 / SV-A7: a stake counts only from 1 VHP, and a failed stake read is tried again, not dropped", async () => {
  const vhp = async () => ({ [ALICE]: "100000000", [BOB]: "99999999" });
  const stakes = { [BOB]: { stake: "0" }, [CAROL]: { stake: "1" }, [DAVE]: { stake: "60000000", pending: "40000000" } };
  const held = await readRanked("n", [ALICE, BOB, CAROL, DAVE], "1tok", A("G"), { vhp, player: async (n, g, a) => stakes[a] });
  assert.deepEqual([...held].sort(), [ALICE, DAVE].sort(), "a 1e-8 VHP stake doesn't count; 0.6 staked + 0.4 pending does");
  await assert.rejects(readRanked("n", [CAROL], "1tok", A("G"), { vhp, player: async () => { throw new Error("rate limited"); } }), /rate limited/);
  // In a run, a failed check leaves the day for the next run instead of marking the player.
  const start = S.dayStart(FIRST - 1) + 3600000;
  const times = [start, start + 60000, start + 120000, start + 180000, S.dayStart(FIRST + 1) + 3600000];
  const r = await runs(times, { rankedOf: async () => { throw new Error("rate limited"); } });
  assert.equal(r.read("S001.json").days.length, 0);
  assert.ok(r.r.problems.some((p) => /VHP check: rate limited/.test(p)));
  // No Knode contract on mainnet: no season is recorded, and it says so.
  const r2 = await runs(times, { rankedOf: undefined, gameContract: "" });
  assert.ok(!fs.existsSync(path.join(r2.out, "S001.json")) || r2.read("S001.json").days.length === 0);
  assert.ok(r2.r.problems.some((p) => /names no Knode contract/.test(p)));
});

test("Repo Lense SV-A8: a bad saved day end is checked before any download, and searched again in the same run", async () => {
  const t = S.dayStart(FIRST - 1) + 3600000;
  for (const [why, end] of [["beyond the irreversible block", 10 ** 12], ["far too early", 5]]) {
    const r = await runs([t]);
    const j = r.read("days.json"), last = j.days[j.days.length - 1];
    last.heights = [Math.min(end, 1), end]; last.blocks = end - last.heights[0] + 1; last.counts = [[PRODS[0], last.blocks]];
    fs.writeFileSync(path.join(r.out, "days.json"), JSON.stringify(j));
    let asked = 0;
    const counting = (node, a, b) => { asked += b - a + 1; return blocksOf()(node, a, b); };
    const r2 = await runs([t + 60000], { blocksOf: counting }, r.out);
    const rec = r2.read("days.json").days.find((x) => x.day === last.day + 1);
    assert.ok(rec && rec.blocks === 28800, `${why}: the next day is recorded in full`);
    assert.ok(asked < 3 * 30000 * 2, `${why}: ${asked} blocks downloaded`);
    assert.ok(r2.r.problems.some((p) => p.includes("searched again")), why);
  }
});

test("Repo Lense SV-A12 / SV-A14: game 3 is read on both nodes, enabled and picks per day are checked, a pending change is reported", async () => {
  const start = S.dayStart(FIRST - 1) + 3600000;
  const times = [start, start + 60000, start + 120000, start + 180000, S.dayStart(FIRST + 1) + 3600000];
  for (const [why, gameOf] of [
    ["closed", async () => ({ ...GAME3, enabled: false })],
    ["picks per day", async () => ({ ...GAME3, max_picks_per_day: 50 })],
    ["nodes disagree", async (node) => (node === "check" ? { ...GAME3, max_changes: 4 } : GAME3)],
  ]) {
    const r = await runs(times, { gameOf });
    assert.ok(!fs.existsSync(path.join(r.out, "S001.json")) || r.read("S001.json").days.length === 0, why);
    assert.ok(r.r.problems.some((p) => /game 3/.test(p)), why);
  }
  const pending = { game: GAME3, pending: { game: { ...GAME3, lead: "600000" }, eta: String(Date.now()) } };
  const r = await runs(times, { gameOf: async () => pending });
  assert.equal(r.read("S001.json").days.length, 1, "a pending change doesn't stop the season");
  assert.ok(r.r.problems.some((p) => /change to game 3 is announced.*lead/.test(p)), JSON.stringify(r.r.problems));
});

test("Repo Lense SV-A16: one node only is reported, and its days are checked again once a second node is back", async () => {
  const t = S.dayStart(FIRST - 1) + 3600000;
  const r = await runs([t], { check: null });
  assert.ok(r.r.problems.some((p) => /only one node/.test(p)));
  assert.ok(r.read("days.json").days.every((x) => x.checked === 1));
  const r2 = await runs([t + 60000, t + 120000, t + 180000, t + 240000], {}, r.out);
  assert.ok(r2.read("days.json").days.every((x) => x.checked === 2), "checked again on the second node");
  // A day the second node disagrees with is reported, not changed.
  const r3 = await runs([t], { check: null });
  const j = r3.read("days.json"), d = j.days[0].day;
  const r4 = await runs([t + 60000, t + 120000, t + 180000], { blocksOf: blocksOf(d) }, r3.out);
  assert.ok(r4.r.problems.some((p) => /second node disagrees/.test(p)), JSON.stringify(r4.r.problems));
});

// ── Vault v6 hand-off (28 Oct): one results file per vault week ──
test("vault files: the season's first week carries no winners, its last week the season's 1st and 2nd", async (t) => {
  assert.equal(vaultWeekOf(S.dayIndex(Date.parse("2026-10-19T00:00:00Z"))), 0, "week 0 began Monday 19 Oct 2026");
  assert.equal(vaultWeekOf(FIRST), 4); assert.equal(vaultWeekOf(FIRST + 13), 5, "a season is two vault weeks");
  const r = await runs(seasonTimes());
  const v = (w) => JSON.parse(fs.readFileSync(path.join(r.out, "vault", `W${w}.json`), "utf8"));
  assert.ok(!fs.existsSync(path.join(r.out, "vault", "W4.json")), "the first week isn't over yet");
  assert.deepEqual(v(5), { game: 3, week: 5, final: true, rows: [], first: [ALICE], second: [CAROL] }, "the season ended early and is final: its winners go in its last week");
  const later = await runs([S.dayStart(FIRST + 7) + 3600000], {}, r.out);
  const v2 = (w) => JSON.parse(fs.readFileSync(path.join(later.out, "vault", `W${w}.json`), "utf8"));
  assert.deepEqual(v2(4), { game: 3, week: 4, final: true, rows: [], first: [], second: [] });
  assert.deepEqual(v2(5).first, [ALICE]);
  // Not final yet: no last-week file.
  const early = await runs(seasonTimes().slice(0, -1));
  assert.ok(!fs.existsSync(path.join(early.out, "vault", "W5.json")));
  // The publish check passes the recorder's own vault files, and refuses changed ones.
  try { execFileSync("python3", ["--version"]); } catch { t.skip("python3 not installed"); return; }
  const ok = publishCheck();
  assert.equal(ok(later.out), true);
  const vaultEdit = (from, w, edit) => {
    const dir = tmp();
    fs.cpSync(from, dir, { recursive: true });
    const f = path.join(dir, "vault", `W${w}.json`), j = JSON.parse(fs.readFileSync(f, "utf8"));
    edit(j); fs.writeFileSync(f, JSON.stringify(j));
    return dir;
  };
  for (const [why, w, edit] of [
    ["a different winner", 5, (j) => { j.first = [EVE]; }],
    ["winners in the season's first week", 4, (j) => { j.first = [ALICE]; }],
    ["another game", 5, (j) => { j.game = 2; }],
    ["not final", 5, (j) => { j.final = false; }],
    ["rows in a free game", 5, (j) => { j.rows = [{ player: ALICE, points: 1 }]; }],
    ["1st and 2nd swapped", 5, (j) => { [j.first, j.second] = [j.second, j.first]; }],
  ]) assert.equal(ok(vaultEdit(later.out, w, edit)), false, why);
  // A vault file with no season file next to it is removed and the run fails (exit 3), the rest still publishes.
  const orphan = tmp();
  fs.cpSync(later.out, orphan, { recursive: true });
  fs.writeFileSync(path.join(orphan, "vault", "W9.json"), JSON.stringify({ game: 3, week: 9, final: true, rows: [], first: [EVE], second: [] }));
  const yml = fs.readFileSync(path.join(APP, ".github/workflows/games.yml"), "utf8");
  const m = /if \[ -d "\$IN\/survivor" \]; then \/usr\/bin\/python3 -I - "\$IN\/survivor" <<'PY' \|\| rc=\$\?\n([\s\S]*?)\n\s*PY\n/.exec(yml);
  const indent = /^(\s*)/.exec(m[1])[1].length, py = m[1].split("\n").map((l) => l.slice(indent)).join("\n");
  let code = 0;
  try { execFileSync("python3", ["-I", "-", orphan], { input: py, stdio: "pipe" }); } catch (e) { code = e.status; }
  assert.equal(code, 3);
  assert.ok(!fs.existsSync(path.join(orphan, "vault", "W9.json")) && fs.existsSync(path.join(orphan, "vault", "W5.json")));
});

test("vault files: ties, more than 10 tied, nobody qualifying", () => {
  const M = S, w = vaultWeekOf(FIRST);
  const W = (k) => A(String.fromCharCode(65 + k)).slice(0, 34);
  const sf = (prizes) => ({ startDay: FIRST, result: { final: true, prizes } });
  const now = S.dayStart(FIRST + 15);
  const f = (prizes, problems = []) => vaultFiles(sf(prizes), now, M, problems)[w + 1];
  assert.deepEqual([f([{ player: W(1), place: 1, vhp: 3 }, { player: W(0), place: 1, vhp: 3 }]).first, f([]).second], [[W(0), W(1)], []], "tied for 1st: both listed, sorted");
  assert.deepEqual(f([]), { game: 3, week: w + 1, final: true, rows: [], first: [], second: [] }, "nobody qualifies: empty places");
  const eleven = Array.from({ length: 11 }, (_, k) => ({ player: W(k), place: 1, vhp: 0.54545454 }));
  const pr = [];
  assert.deepEqual([f(eleven, pr).first, f(eleven).second], [[], []], "11 tied for 1st: the vault takes at most 10, so nothing is posted");
  assert.ok(pr.some((p) => /11 wallets tied for 1st/.test(p)));
  const two = [{ player: W(20), place: 1, vhp: 4 }, ...Array.from({ length: 11 }, (_, k) => ({ player: W(k), place: 2, vhp: 0.18181818 }))];
  assert.deepEqual([f(two).first, f(two).second], [[W(20)], []], "11 tied for 2nd: 1st is posted, 2nd's prize returns to the pool");
  const ten = Array.from({ length: 10 }, (_, k) => ({ player: W(k), place: 1, vhp: 0.6 }));
  assert.equal(f(ten).first.length, 10, "10 tied is fine");
  assert.equal(vaultFiles({ startDay: FIRST, result: { final: false, prizes: [] } }, now, M)[w + 1], undefined, "not final: no last-week file");
});

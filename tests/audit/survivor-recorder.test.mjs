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
// The publish check judges files by the job's clock (Repo Lense S3-1): the fixtures' seasons are in Nov-Dec 2026.
process.env.CHECK_NOW_MS ??= String(Date.parse("2027-06-01T00:00:00Z"));
const { run, encodeSeason, readRanked, readStaked, vaultMismatch, pool, vaultFiles, vaultWeekOf } = await import(path.resolve(APP, "bot/games/survivor.ts"));
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
    r = await quiet(() => run({ p: "main", check: "check", prev, out, firstDay: FIRST, picksContract: A("P"), blocksOf: blocksOf(), timeOf, picksOf: picksOf(), rankedOf, gameOf, stakedOf: async () => null, vaultOf: async () => null, head: headAt(t), ...opts }));
    // As on GitHub: the vault files already published stay on games-data (and come back as PREV/vault next run).
    if (prev && fs.existsSync(path.join(prev, "vault"))) for (const f of fs.readdirSync(path.join(prev, "vault"))) {
      fs.mkdirSync(path.join(out, "vault"), { recursive: true });
      if (!fs.existsSync(path.join(out, "vault", f))) fs.copyFileSync(path.join(prev, "vault", f), path.join(out, "vault", f));
    }
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
  // Final once the correction window and both vault weeks are over (the free prize needs both weeks' stake readings).
  const fin = await runs([S.dayStart(FIRST + 14) + 3600000], {}, r.out);
  const sf2 = fin.read("S001.json");
  assert.equal(sf2.result.final, true);
  assert.deepEqual(sf2.result.prizes.map((p) => [p.player, p.vhp]), [[ALICE, 4], [CAROL, 2]], "Eve can't win: no 1 VHP; Carol lasted longer than Bob");
  assert.deepEqual(fin.read("index.json").seasons, [1]);
  // A final season is never played again.
  const later = await runs([S.dayStart(FIRST + 16) + 3600000], { picksOf: async () => { throw new Error("must not read picks for a final season"); } }, fin.out);
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
  const m = /if \[ -d "\$IN\/survivor" \]; then \/usr\/bin\/python3 -I - "\$IN\/survivor" "\$PUB\/survivor" <<'PY' \|\| rc=\$\?\n([\s\S]*?)\n\s*PY\n/.exec(yml);
  assert.ok(m, "the survivor check is in the workflow");
  const indent = /^(\s*)/.exec(m[1])[1].length;
  const py = m[1].split("\n").map((l) => l.slice(indent)).join("\n");
  try { execFileSync("python3", ["--version"]); } catch { t.skip("python3 not installed"); return; }
  const start = S.dayStart(FIRST - 1) + 3600000;
  const times = [start, start + 60000, start + 120000, start + 180000];
  for (let n = 1; n <= 3; n++) times.push(S.dayStart(FIRST + n) + 3600000);
  times.push(S.dayStart(FIRST + 14) + 3600000);
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
  const back = S.dayStart(FIRST + 15) + 3600000, after = Array.from({ length: 10 }, (_, i) => back + i * 3600000);
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
  const m = /if \[ -d "\$IN\/survivor" \]; then \/usr\/bin\/python3 -I - "\$IN\/survivor" "\$PUB\/survivor" <<'PY' \|\| rc=\$\?\n([\s\S]*?)\n\s*PY\n/.exec(yml);
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
  const players1 = played.players.map((x) => ({ ...x, staked: false }));
  const stakes = [0, 1].map((k) => ({ week: vaultWeekOf(FIRST) + k, final: true, day: FIRST + 7 * (k + 1), staked: [] }));
  const sf = { v: 1, season: 1, startDay: FIRST, days, stakes, result: { over: played.over, endN: played.endN, final: true, players: players1, prizes: S.prizes(players1) } };
  assert.equal(new Set(players).size, 1000);
  assert.equal(sf.result.prizes.length, 1000, "a 1,000-way tie for 1st");
  assert.ok(sf.result.prizes.reduce((s, p) => s + Math.round(p.vhp * 1e8), 0) <= 6e8, "at most 6 VHP, counted in 1e-8 units");
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "S001.json"), JSON.stringify(encodeSeason(sf)) + "\n");
  fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify({ v: 1, updated: "2026-12-01T00:00:00.000Z", firstDay: FIRST, contract: null, seasons: [1] }) + "\n");
  const size = fs.statSync(path.join(dir, "S001.json")).size;
  assert.ok(size < 2 * 1024 * 1024, `S001.json is ${(size / 1048576).toFixed(2)} MB`);
  assert.match(execFileSync("python3", ["-", dir], { input: py }).toString(), /survivor files ok/);
});

// ── Repo Lense fixes ──
const seasonTimes = () => {
  const start = S.dayStart(FIRST - 1) + 3600000;
  const t = [start, start + 60000, start + 120000, start + 180000];
  for (let n = 1; n <= 3; n++) t.push(S.dayStart(FIRST + n) + 3600000);
  t.push(S.dayStart(FIRST + 14) + 3600000);
  return t;
};
function publishCheck() {
  const yml = fs.readFileSync(path.join(APP, ".github/workflows/games.yml"), "utf8");
  const m = /if \[ -d "\$IN\/survivor" \]; then \/usr\/bin\/python3 -I - "\$IN\/survivor" "\$PUB\/survivor" <<'PY' \|\| rc=\$\?\n([\s\S]*?)\n\s*PY\n/.exec(yml);
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
  const withH = fs.readFileSync(path.join(r.out, "S001.json"), "utf8");
  assert.match(withH, /"h":[0-9.]+/);
  fs.writeFileSync(path.join(d3, "S001.json"), withH.replace(/"h":[0-9.]+/, `"h":NaN`));
  assert.equal(ok(d3), false, "NaN is refused");
});

test("Repo Lense SV-A4: a forged result in the last run's files is replaced by the season played again", async () => {
  const r = await runs(seasonTimes());
  const real = r.read("S001.json").result;
  const forged = copyOut(r.out, (j) => { j.result.prizes = [{ player: EVE, place: 1, vhp: 4 }, { player: BOB, place: 2, vhp: 2 }]; });
  const again = await runs([S.dayStart(FIRST + 16) + 3600000], {}, forged);
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

// ── Vault v6 hand-offs (28 Oct): one results file per vault week; Survivor takes stakes too ──
const W1 = () => vaultWeekOf(FIRST);
const vfile = (out, w) => { const f = path.join(out, "vault", `W${w}.json`); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null; };

test("vault files, nobody staked (vault not v6 yet): no rows; the season's winners only in its last week, once both weeks are over", async (t) => {
  assert.equal(vaultWeekOf(S.dayIndex(Date.parse("2026-10-19T00:00:00Z"))), 0, "week 0 began Monday 19 Oct 2026");
  assert.equal(W1(), 4); assert.equal(vaultWeekOf(FIRST + 13), 5, "a season is two vault weeks");
  const r = await runs(seasonTimes().slice(0, -1));
  assert.equal(vfile(r.out, 4), null, "week 1 isn't over yet");
  const mid = await runs([S.dayStart(FIRST + 7) + 3600000], {}, r.out);
  assert.deepEqual(vfile(mid.out, 4), { game: 3, week: 4, final: true, rows: [], first: [], second: [] });
  assert.equal(vfile(mid.out, 5), null, "the season ended on day 3 but week 2's stakes aren't known yet");
  assert.equal(mid.read("S001.json").result.final, false);
  const end = await runs([S.dayStart(FIRST + 14) + 3600000], {}, mid.out);
  assert.deepEqual(vfile(end.out, 5), { game: 3, week: 5, final: true, rows: [], first: [ALICE], second: [CAROL] });
  try { execFileSync("python3", ["--version"]); } catch { t.skip("python3 not installed"); return; }
  assert.equal(publishCheck()(end.out), true);
});

test("two boards: a staked player plays for the stake bucket (rows each week) and can't win the free prize", async (t) => {
  // Carol is staked in Survivor in week 1 only; nobody else is staked.
  const stakedOf = async (node, who, w) => new Set(w === W1() ? who.filter((a) => a === CAROL) : []);
  const end = await runs([...seasonTimes().slice(0, -1), S.dayStart(FIRST + 7) + 3600000, S.dayStart(FIRST + 14) + 3600000], { stakedOf });
  const sf = end.read("S001.json"), by = Object.fromEntries(sf.result.players.map((x) => [x.a, x]));
  assert.equal(by[CAROL].staked, true, "staked in either week = staked this season");
  assert.equal(by[ALICE].staked, false);
  assert.deepEqual(vfile(end.out, 4).rows, [{ player: CAROL, points: 255 }], "week 1's rows: the staked players, best first");
  assert.deepEqual(vfile(end.out, 5).rows, [], "week 2: the season was already over, nobody still in");
  // Free players who can win: Alice and Bob (Eve held no VHP, Carol is staked): fewer than 3, so no free prize.
  assert.deepEqual(sf.result.prizes, []);
  assert.deepEqual([vfile(end.out, 5).first, vfile(end.out, 5).second], [[], []]);
  try { execFileSync("python3", ["--version"]); } catch { t.skip("python3 not installed"); return; }
  const ok = publishCheck();
  assert.equal(ok(end.out), true);
  const dir = tmp();
  fs.cpSync(end.out, dir, { recursive: true });
  const f = path.join(dir, "vault", "W4.json"), j = JSON.parse(fs.readFileSync(f, "utf8"));
  j.rows.push({ player: ALICE, points: 200 });
  fs.writeFileSync(f, JSON.stringify(j));
  assert.equal(ok(dir), false, "a row for a wallet that wasn't staked is refused");
  const d2 = copyOut(end.out, (j) => { j.stakes[0].staked = []; });
  assert.equal(ok(d2), false, "the staked flags must match the stake readings");
});

test("stake readings: once a day while the week runs, final after it ends, both nodes must agree", async () => {
  let reads = 0;
  const stakedOf = async (node, who, w) => { reads++; return new Set(); };
  const r = await runs([S.dayStart(FIRST) + 3600000, S.dayStart(FIRST) + 7200000], { stakedOf });
  assert.equal(reads, 0, "no players yet on day 1 (day 1 isn't recorded until it's over)");
  const r2 = await runs([S.dayStart(FIRST + 1) + 3600000, S.dayStart(FIRST + 1) + 7200000], { stakedOf }, r.out);
  assert.equal(reads, 2, "one reading on each node, once that day");
  assert.deepEqual(r2.read("S001.json").stakes.map((x) => [x.week, x.final]), [[W1(), false]]);
  const bad = await runs([S.dayStart(FIRST + 7) + 3600000], { stakedOf: async (node, who) => new Set(node === "check" ? [ALICE] : []) }, r2.out);
  assert.ok(bad.r.problems.some((p) => /disagree about who is staked/.test(p)));
  assert.equal(bad.read("S001.json").stakes.find((x) => x.week === W1()).final, false, "not final while the nodes disagree");
  const fail = await runs([S.dayStart(FIRST + 7) + 3600000], { stakedOf: async () => { throw new Error("rate limited"); } }, r2.out);
  assert.ok(fail.r.problems.some((p) => /stakes in vault week 4: rate limited/.test(p)));
});

test("readStaked: staked in THIS game at the vault's minimum; a mid-week withdrawal stays staked; another game's stake doesn't count", async () => {
  const VHP = 100000000n;
  const state = async () => ({ config: { v6_rule_week_plus_one: "3", min_stake: String(VHP), min_stake_next: String(2n * VHP), min_stake_next_week: "9" } });
  const table = {
    [ALICE]: { 3: { active_stake: String(VHP) } },                                                      // staked here
    [BOB]: { 4: { active_stake: String(5n * VHP) } },                                                    // staked in another game only
    [CAROL]: { 3: { active_stake: "0", entry: { stake: "0", voided: true, peak_stake: String(VHP) } } }, // withdrew mid-week
    [DAVE]: { 3: { active_stake: String(VHP - 1n) } },                                                   // under the minimum
  };
  const gamePlayer = async (node, a, g) => (table[a] && table[a][g]) || { active_stake: "0" };
  const games = async () => [{ id: 1 }, { id: 3 }, { id: 4 }];
  const all = [ALICE, BOB, CAROL, DAVE, EVE];
  assert.deepEqual([...(await readStaked("n", all, 5, A("G"), { state, gamePlayer, games }))].sort(), [ALICE, CAROL].sort());
  assert.deepEqual([...(await readStaked("n", all, 9, A("G"), { state, gamePlayer, games }))], [], "from week 9 the minimum is 2 VHP");
  assert.equal(await readStaked("n", all, 5, A("G"), { state: async () => ({ config: { v6_rule_week_plus_one: "0", min_stake: String(VHP) } }), gamePlayer, games }), null, "vault not v6: nobody is staked");
  await assert.rejects(readStaked("n", all, 5, A("G"), { state, games, gamePlayer: async () => { throw new Error("node down"); } }), /node down/);
});

test("vaultFiles and weekRows: ties keep their points, more than 10 tied for a prize, week 2 lists only who was still in", () => {
  const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const Wd = (i) => { let x = "", k = i; do { x = B58[k % 58] + x; k = Math.floor(k / 58); } while (k); return "1" + ("R".repeat(33) + x).slice(-33); };
  const prods = Array.from({ length: 17 }, (_, i) => Wd(100 + i));
  const field = prods.map((a) => ({ a, k: 40000, h: 1 }));
  // 14 days, everybody safe every day (all producers tie), 12 players: everybody ties all season.
  const players = Array.from({ length: 12 }, (_, i) => Wd(i));
  const days = Array.from({ length: 14 }, (_, i) => ({ n: i + 1, day: FIRST + i, field, counts: prods.map((a) => [a, 100]), picks: players.map((p, k) => [p, prods[(k + i) % 17]]), noVhp: [] }));
  const rows = S.weekRows(days, 0, new Set(players.slice(0, 5)));
  assert.deepEqual(rows.map((x) => x.points), [255, 255, 255, 255, 255], "a tie keeps the same points");
  assert.equal(S.weekRows(days.slice(0, 6), 0, new Set(players)), null, "week 1's days aren't all recorded yet");
  const played = S.playSeason(days);
  const result = (staked) => { const ps = played.players.map((x) => ({ ...x, staked: staked.has(x.a) })); return { final: true, prizes: S.prizes(ps), players: ps }; };
  const stakes = (s1, s2) => [{ week: W1(), final: true, day: FIRST + 7, staked: [...s1] }, { week: W1() + 1, final: true, day: FIRST + 14, staked: [...s2] }];
  const pr = [];
  const f12 = vaultFiles({ startDay: FIRST, days, result: result(new Set()), stakes: stakes([], []) }, S, pr);
  assert.deepEqual([f12[W1() + 1].first, f12[W1() + 1].second, f12[W1() + 1].rows], [[], [], []], "12 tied for 1st: the vault takes at most 10, nothing posted, nobody staked");
  assert.ok(pr.some((p) => /12 wallets tied for 1st/.test(p)));
  const st = new Set(players.slice(0, 3));
  const f9 = vaultFiles({ startDay: FIRST, days, result: result(st), stakes: stakes(st, st) }, S);
  assert.equal(f9[W1() + 1].first.length, 9, "9 free players tied for 1st: all listed");
  assert.ok(f9[W1() + 1].first.every((a) => !st.has(a)), "no staked player in the free prize");
  assert.deepEqual(f9[W1()].rows.map((x) => x.player).sort(), [...st].sort());
  // Player 0 picks a producer outside the field on days 1 and 2: out on day 2, so not in week 2's rows.
  const outEarly = days.map((d) => (d.n <= 2 ? { ...d, picks: d.picks.map(([p, q]) => [p, p === players[0] ? Wd(999) : q]) } : d));
  const w2 = S.weekRows(outEarly, 1, new Set(players));
  assert.equal(w2.length, 11);
  assert.ok(!w2.some((x) => x.player === players[0]), "week 2 lists only players still in when it began");
  assert.ok(S.weekRows(outEarly, 0, new Set(players)).some((x) => x.player === players[0] && x.points < 255), "week 1 lists them, ranked lower");
  // Points never go below 1, and order is kept down to 255 places.
  const many = Array.from({ length: 300 }, (_, i) => ({ a: Wd(1000 + i), lives: 2, outN: null, total: 300 - i, used: [], log: "", eligible: true }));
  const ranked = S.rank(many).map((x) => Math.max(1, 256 - x.place));
  assert.equal(ranked[0], 255); assert.equal(ranked[254], 1); assert.equal(ranked[299], 1);
});

test("Repo Lense S2-2: the 1 VHP rule counts all VHP in the vault (stake_other), including a deposit or move made this week", async () => {
  const VHP = 100000000n;
  const players = { [ALICE]: { stake: "0", pending: "0", stake_other: String(VHP) },        // deposited into Block X mid-week
    [BOB]: { stake: "0", pending: "0", stake_other: "1" },                                      // dust
    [CAROL]: { stake: "0", pending: String(VHP / 2n), stake_other: String(VHP / 2n) },          // half and half
    [DAVE]: {} };
  const held = await readRanked("n", [ALICE, BOB, CAROL, DAVE], "1tok", A("G"), { vhp: async () => ({}), player: async (n, g, a) => players[a] });
  assert.deepEqual([...held].sort(), [ALICE, CAROL].sort());
});

// ── Repo Lense re-audit (29 Oct): S2-1 … S2-25 ──
test("S2-1: no stake reading is taken (let alone saved final) before season day 1 is recorded", async () => {
  // Day 1's picks disagree between the nodes until day 10, so day 1 isn't recorded when week 1 ends.
  let reads = 0;
  const stakedOf = async (node, who) => { reads++; return new Set(who.filter((a) => a === CAROL)); };
  const stuck = picksOf(FIRST);
  const times = [S.dayStart(FIRST - 1) + 3600000];
  for (let k = 1; k <= 10; k++) times.push(S.dayStart(FIRST + k) + 3600000);
  const r = await runs(times, { stakedOf, picksOf: stuck });
  assert.equal(reads, 0);
  assert.deepEqual(r.read("S001.json").stakes, []);
  // Day 1 finally agrees: the week-1 reading is taken now, after the week ended, with the real players.
  const r2 = await runs([S.dayStart(FIRST + 10) + 7200000, S.dayStart(FIRST + 10) + 7260000], { stakedOf }, r.out);
  const st = r2.read("S001.json").stakes.find((x) => x.week === W1());
  assert.ok(st && st.final, "final, taken after the week");
  assert.equal(r2.read("S001.json").who[st.staked[0]], CAROL);
});

test("S2-10, S2-11: on mainnet a season moves only with two nodes, and only on days both confirmed", async () => {
  const t = S.dayStart(FIRST + 1) + 3600000, start = S.dayStart(FIRST - 1) + 3600000;
  const one = await runs([start, start + 60000, start + 120000, start + 180000, t], { check: null });
  assert.ok(one.r.problems.some((p) => /seasons wait for a second node/.test(p)));
  assert.ok(!fs.existsSync(path.join(one.out, "S001.json")) || one.read("S001.json").days.length === 0);
  // A day the second node disputes holds the season at that day.
  const two = await runs([start, start + 60000, start + 120000, start + 180000, t], { blocksOf: blocksOf(FIRST) });
  assert.equal(two.read("S001.json").days.length, 0);
  assert.ok(!two.read("days.json").days.some((x) => x.day === FIRST), "the disputed day isn't saved either");
});

test("S2-3: reads run 8 at a time; season work stops at the time budget and carries on next run", async () => {
  let at = 0, most = 0;
  const out = await pool(Array.from({ length: 50 }, (_, i) => i), 8, async (i) => { at++; most = Math.max(most, at); await new Promise((r) => setTimeout(r, 2)); at--; return i * 2; });
  assert.equal(most, 8); assert.equal(out[49], 98);
  await assert.rejects(pool([1, 2, 3], 2, async (i) => { if (i === 2) throw new Error("boom"); return i; }), /boom/);
  const start = S.dayStart(FIRST - 1) + 3600000;
  const r = await runs([start, start + 60000, start + 120000, start + 180000, S.dayStart(FIRST + 3) + 3600000], { budgetMs: -1 });
  assert.ok(r.r.problems.some((p) => /out of time for season work/.test(p)));
  assert.equal(r.read("S001.json").days.length, 0, "no season day this run");
  const r2 = await runs([S.dayStart(FIRST + 3) + 3660000], {}, r.out);
  assert.ok(r2.read("S001.json").days.length > 0, "the next run carries on");
});

test("S2-7, S2-21: no vault file while the vault counts weeks or Survivor's seasons differently", async () => {
  const WEEK = 7 * 86400000, G = 20745 * 86400000;
  const g3 = (from, extra = {}) => ({ genesis: G, weekLen: WEEK, game3: { id: 3, season_weeks: 2, from_week: String(from), staked: true, free_prize: true, ...extra } });
  assert.equal(vaultMismatch(null, FIRST), "", "vault not v6 yet");
  assert.equal(vaultMismatch({ genesis: G, weekLen: WEEK, game3: null }, FIRST), "", "game 3 not added yet");
  assert.equal(vaultMismatch(g3(4), FIRST), "");
  assert.equal(vaultMismatch(g3(6), FIRST), "", "added later, in step");
  assert.match(vaultMismatch(g3(3), FIRST), /out of step/);
  assert.match(vaultMismatch(g3(5), FIRST), /out of step/);
  assert.match(vaultMismatch(g3(4, { season_weeks: 1 }), FIRST), /1-week seasons/);
  assert.match(vaultMismatch(g3(4, { staked: false }), FIRST), /staked and free-prize/);
  assert.match(vaultMismatch({ ...g3(4), genesis: G + 86400000 }, FIRST), /weeks/);
  const r = await runs([...seasonTimes()], { vaultOf: async () => g3(5) });
  assert.ok(!fs.existsSync(path.join(r.out, "vault")), "no vault files");
  assert.ok(r.r.problems.some((p) => /out of step/.test(p)));
});

test("S2-4, S2-13, S2-18: a bad season file is left out on its own; seasons sit on the calendar; no early final reading", async (t) => {
  try { execFileSync("python3", ["--version"]); } catch { t.skip("python3 not installed"); return; }
  const yml = fs.readFileSync(path.join(APP, ".github/workflows/games.yml"), "utf8");
  const m = /if \[ -d "\$IN\/survivor" \]; then \/usr\/bin\/python3 -I - "\$IN\/survivor" "\$PUB\/survivor" <<'PY' \|\| rc=\$\?\n([\s\S]*?)\n\s*PY\n/.exec(yml);
  const indent = /^(\s*)/.exec(m[1])[1].length, py = m[1].split("\n").map((l) => l.slice(indent)).join("\n");
  const code = (dir) => { try { execFileSync("python3", ["-I", "-", dir], { input: py, stdio: "pipe" }); return 0; } catch (e) { return e.status; } };
  const r = await runs(seasonTimes());
  assert.equal(code(r.out), 0);
  // 600 distinct producers named in picks (junk addresses) are a legitimate file now.
  const many = copyOut(r.out, (j) => { const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"; for (let i = 0; i < 600; i++) j.prods.push("1" + ("T".repeat(33) + B58[i % 58] + B58[Math.floor(i / 58) % 58]).slice(-33)); });
  assert.equal(code(many), 0, "more than 500 producers is fine");
  const moved = copyOut(r.out, (j) => { j.startDay += 7; });
  assert.equal(code(moved), 3, "a season off the calendar is left out on its own (exit 3)");
  assert.ok(!fs.existsSync(path.join(moved, "S001.json")) && fs.existsSync(path.join(moved, "days.json")), "only that file goes");
  assert.ok(!fs.existsSync(path.join(moved, "vault", "W5.json")), "and its vault files with it");
  const early = copyOut(r.out, (j) => { j.stakes[1].day = j.startDay + 10; });
  assert.equal(code(early), 3, "a final stake reading dated before its week ended");
});

test("S2-19, SV-A26: no vault file before week 0; the write keeps last run's files it didn't rewrite and swaps the folder", async () => {
  const early = S.dayIndex(Date.parse("2026-10-05T00:00:00Z"));      // a Monday two weeks before the vault's week 0
  assert.ok(vaultWeekOf(early) < 0);
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "S099.json"), "{}");
  const r = await quiet(() => run({ p: "main", check: "check", prev: dir, out: dir, firstDay: FIRST, picksContract: A("P"), blocksOf: blocksOf(), timeOf, picksOf: picksOf(), rankedOf, gameOf, stakedOf: async () => null, vaultOf: async () => null, head: headAt(S.dayStart(FIRST - 1) + 3600000) }));
  assert.ok(r);
  assert.ok(fs.existsSync(path.join(dir, "S099.json")) && fs.existsSync(path.join(dir, "days.json")), "kept and written");
  const side = path.dirname(path.dirname(dir));
  assert.ok(!fs.readdirSync(side).some((f) => f.startsWith(".survivor-stage-")), "no side folder left behind");
});

test("fix-check: the 7 days behind a season day's handicap must be confirmed on both nodes too", async () => {
  const start = S.dayStart(FIRST - 1) + 3600000;
  const r = await runs([start, start + 60000, start + 120000, start + 180000]);
  const j = r.read("days.json");
  j.days.find((x) => x.day === FIRST - 3).checked = 1;            // saved from one node only
  fs.writeFileSync(path.join(r.out, "days.json"), JSON.stringify(j));
  const r2 = await runs([S.dayStart(FIRST + 1) + 3600000], { blocksOf: blocksOf(FIRST - 3) }, r.out);   // and node C disputes it
  assert.equal(r2.read("S001.json").days.length, 0);
  assert.ok(r2.r.problems.some((p) => /days behind its handicap are confirmed on one node only/.test(p)), JSON.stringify(r2.r.problems));
});

test("fix-check: a run that died between the two renames is put right by the next one", async () => {
  const { recoverOut } = await import(path.resolve(APP, "bot/games/survivor.ts"));
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "sv-swap-")), out = path.join(parent, "data", "survivor");
  fs.mkdirSync(out, { recursive: true });
  const r = await quiet(() => run({ p: "main", check: "check", prev: out, out, firstDay: FIRST, picksContract: A("P"), blocksOf: blocksOf(), timeOf, picksOf: picksOf(), rankedOf, gameOf, stakedOf: async () => null, vaultOf: async () => null, head: headAt(S.dayStart(FIRST - 1) + 3600000) }));
  assert.ok(r && fs.existsSync(path.join(out, "days.json")));
  assert.deepEqual(fs.readdirSync(parent).filter((f) => f.startsWith(".survivor-")), [], "no side folder left");
  // Simulate the crash: the folder parked under its fixed name, OUT missing.
  const old = fs.readdirSync(parent);
  void old;
  const crypto = await import("node:crypto");
  const parked = path.join(parent, `.survivor-old-${crypto.createHash("sha256").update(out).digest("hex").slice(0, 12)}`);
  fs.renameSync(out, parked);
  recoverOut(out);
  assert.ok(fs.existsSync(path.join(out, "days.json")) && !fs.existsSync(parked));
});

test("fix-check N3: reads stop at the hard stop, so a day too big for one run is dropped and the files are still written", async () => {
  const { setHardStop } = await import(path.resolve(APP, "bot/games/survivor.ts"));
  setHardStop(Date.now() - 1);
  await assert.rejects(pool([1, 2, 3], 2, async (i) => i), /out of time/);
  setHardStop(Infinity);
  assert.deepEqual(await pool([1, 2], 2, async (i) => i * 2), [2, 4]);
});

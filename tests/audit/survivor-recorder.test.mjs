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
const { run } = await import(path.resolve(APP, "bot/games/survivor.ts"));
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
const rankedOf = async (who) => new Set(who.filter((a) => a !== EVE));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "survivor-"));
const quiet = async (f) => { const log = console.log; console.log = () => {}; try { return await f(); } finally { console.log = log; } };
/** A head at time t: irreversible about 1 minute behind. */
const headAt = (t) => { const height = H(t), lib = height - 20; return { height, time: T(height), lib, libTime: T(lib) }; };
async function runs(times, opts = {}, prev = "") {
  let out, r;
  for (const t of times) {
    out = tmp();
    r = await quiet(() => run({ p: "main", check: "check", prev, out, firstDay: FIRST, picksContract: A("P"), blocksOf: blocksOf(), timeOf, picksOf: picksOf(), rankedOf, head: headAt(t), ...opts }));
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
  assert.ok(!sf.days[0].picks.some((p) => p[0] === DAVE), "a pick at the lock time doesn't count");
  const by = Object.fromEntries(sf.result.players.map((x) => [x.a, x]));
  assert.deepEqual(Object.keys(by).sort(), [ALICE, BOB, CAROL, EVE].sort());
  assert.equal(by[BOB].outN, 2); assert.equal(by[CAROL].outN, 3);
  assert.equal(by[ALICE].outN, null); assert.equal(by[ALICE].lives, 2); assert.equal(by[EVE].lives, 2);
  assert.equal(by[EVE].eligible, false, "held no VHP at the checks");
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
  assert.ok(!fs.existsSync(path.join(r.out, "S001.json")), "nothing recorded for the season yet");
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
  const m = /if \[ -d "\$IN\/survivor" \]; then \/usr\/bin\/python3 - "\$IN\/survivor" <<'PY'\n([\s\S]*?)\n\s*PY\n/.exec(yml);
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
  for (const f of fs.readdirSync(r.out)) fs.copyFileSync(path.join(r.out, f), path.join(bad, f));
  const s = JSON.parse(fs.readFileSync(path.join(bad, "S001.json"), "utf8"));
  s.result.prizes[0].vhp = 50;
  fs.writeFileSync(path.join(bad, "S001.json"), JSON.stringify(s));
  assert.throws(() => execFileSync("python3", ["-", bad], { input: py, stdio: "pipe" }));
});

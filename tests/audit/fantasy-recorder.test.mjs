// The Fantasy recorder (bot/games/fantasy.ts): day indexes only when irreversible and both nodes agree, the price sheet
// on Sunday 12:00 with its sha256 (never changed after), teams scored by the shared math, the week final only after the
// 12-hour correction window, and Weekly Rival records counted once. Offline: two fake nodes serve a made-up chain.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const APP = process.env.APP || ".";
const { run } = await import(path.resolve(APP, "bot/games/fantasy.ts"));
const M = globalThis.KRaceMath, F = globalThis.KFantasyMath;
const U = (s) => Date.parse(s);

// Six producers: VHP shares and how reliably each signs (missed slots go to the others).
const P = "ABCDEFGHJKM".split("").map((c) => "1" + c.repeat(33));
const VHP = [300, 250, 200, 150, 120, 100, 90, 80, 70, 9, 1];   // the last two are in the paddock at 720 blocks a race
const REL = [1.05, 1.0, 0.75, 1.05, 0.8, 1.02, 0.9, 1.0, 0.78, 1, 1];
const PLAYERS = ["1Pa1111111111111111111111111111111", "1Pb2222222222222222222222222222222", "1Pc3333333333333333333333333333333", "1Pd4444444444444444444444444444444"];
const STEP = 30000, T0 = U("2026-10-24T00:00:00Z"), N = Math.floor((U("2026-11-10T00:00:00Z") - T0) / STEP);
const chain = (() => {
  const R = M.rng(11), w = VHP.map((v, i) => v * REL[i]), tot = w.reduce((a, b) => a + b), ts = [], who = [];
  for (let i = 0; i < N; i++) { ts.push(T0 + i * STEP); let x = R.next() * tot, j = 0; while (x >= w[j]) { x -= w[j]; j++; } who.push(P[j]); }
  return { ts, who };
})();
const H0 = 1000;
function node(nowT, { tamper = null } = {}) {
  let top = 0; while (top + 1 < N && chain.ts[top + 1] <= nowT) top++;
  return {
    async getHeadInfo() { return { head_topology: { height: String(H0 + top), id: "0xhead" }, head_block_time: String(chain.ts[top]), last_irreversible_block: String(H0 + top - 60) }; },
    async call(m, a) {
      assert.equal(m, "block_store.get_blocks_by_height");
      const s = Number(a.ancestor_start_height), items = [];
      for (let h = s; h < s + a.num_blocks && h <= H0 + top; h++) {
        const i = h - H0; if (i < 0) continue;
        items.push({ block_height: String(h), block: { header: { signer: tamper === h ? P[(P.indexOf(chain.who[i]) + 1) % P.length] : chain.who[i], timestamp: String(chain.ts[i]) } } });
      }
      return { block_items: items };
    },
  };
}
const dirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "fantasy-")); dirs.push(d); return d; };
// Race cards for weeks 0..3: one card (VHP as above, 720 blocks a race) on every leg.
const raceData = (() => {
  const d = tmp(), card = M.makeCard(P.map((a, i) => [a, VHP[i]]), 720, T0);
  for (let w = 0; w <= 3; w++) {
    const start = M.weekStart(w), races = [];
    for (let t = start; t < start + M.WEEK; t += M.RACE) races.push({ id: M.raceId(M.raceIndex(t)), start: t, end: t + M.RACE, cards: new Array(6).fill(card), result: null });
    fs.writeFileSync(path.join(d, `W${String(w).padStart(3, "0")}.json`), JSON.stringify({ v: 1, week: w, start, end: start + M.WEEK, races }));
  }
  return d;
})();
let picks = { team: {}, rival: {} };                // team: { [dayNo]: [[player, list, at]] }, rival: { [week]: [...] }
const picksOf = async (_n, game, round) => (game === 4 ? picks.team[round] || [] : game === 5 ? picks.rival[round] || [] : []);
async function hourly(at, prev, opts = {}) {
  const out = tmp();
  const log = console.log; console.log = () => {};
  let r;
  try { r = await run({ p: node(at), check: opts.check === null ? null : node(at, opts.check || {}), prev, out, raceData, picksContract: "1PicksPicksPicksPicksPicksPicks11", picksOf }); } finally { console.log = log; }
  return { out, problems: r.problems };
}
const read = (dir, f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));

test("Sunday 12:00: the next week's price sheet from the field and last week's form, with its sha256; never remade", async () => {
  const before = await hourly(U("2026-11-01T11:30Z"), "");
  assert.equal(read(before.out, "index.json").weeks.includes(2), false, "no sheet before Sunday 12:00");
  const a = await hourly(U("2026-11-01T12:30Z"), before.out);
  const w = read(a.out, "W002.json");
  assert.ok(w.sheet, "sheet made");
  assert.deepEqual(w.sheet.pool.map((x) => x.a), P.slice(0, 9).sort(), "pool = the field; paddock producers can't be drafted");
  assert.equal(w.sheet.budget, 100);
  assert.equal(w.sha256, crypto.createHash("sha256").update(F.sheetText(w.sheet)).digest("hex"));
  const c = w.sheet.pool.find((x) => x.a === P[2]), d = w.sheet.pool.find((x) => x.a === P[3]);
  assert.ok(c.form < 85 && c.price <= 10, `the unreliable producer is cheap (form ${c.form}, price ${c.price})`);
  assert.ok(d.form > c.form + 20 && d.price > 22, `a reliable one costs more (form ${d.form}, price ${d.price})`);
  assert.ok(!w.sheet.late);
  // The form days are recorded and final, checked on 2 nodes.
  const days = read(a.out, "days.json").days;
  for (const dn of F.formDays(2)) { const r = days.find((x) => x.day === dn); assert.ok(r && r.final && r.checked === 2, `form day ${dn}`); }
  const b = await hourly(U("2026-11-02T03:30Z"), a.out);
  assert.equal(read(b.out, "W002.json").sha256, w.sha256, "the sheet is never remade");
});

test("a day the two nodes disagree on is not final; it is recorded when they agree", async () => {
  const dn = F.dayNo(U("2026-10-30T00:00Z"));
  const tamperH = H0 + Math.floor((U("2026-10-30T10:00Z") - T0) / STEP);
  const a = await hourly(U("2026-11-01T12:30Z"), "", { check: { tamper: tamperH } });
  assert.equal(read(a.out, "days.json").days.find((x) => x.day === dn), undefined);
  assert.ok(a.problems.some((p) => /disagree/.test(p)));
  assert.equal(fs.existsSync(path.join(a.out, "W002.json")), false, "and the sheet waits for its form days");
  const b = await hourly(U("2026-11-01T13:30Z"), a.out);
  assert.ok(read(b.out, "days.json").days.find((x) => x.day === dn).final);
  assert.ok(read(b.out, "W002.json").sheet);
});

test("a week: teams scored day by day, final after the 12 h window, rivals counted once", async () => {
  const s = await hourly(U("2026-11-01T12:30Z"), "");
  const sheet = read(s.out, "W002.json").sheet, price = Object.fromEntries(sheet.pool.map((x) => [x.a, x.price]));
  // Teams that fit the budget: a chosen captain plus the cheapest others.
  const byPrice = [...sheet.pool].sort((x, y) => x.price - y.price || (x.a < y.a ? -1 : 1)).map((x) => x.a);
  const cost = (t) => t.reduce((a, x) => a + price[x], 0);
  const teamWith = (cap) => [cap, ...byPrice.filter((x) => x !== cap)].slice(0, 5);
  const five = byPrice.slice(0, 5), best = teamWith(P[3]), weak = teamWith(P[2]);
  for (const t of [five, best, weak]) assert.ok(cost(t) <= 100, `team costs ${cost(t)}`);
  const days = F.weekDays(2), [pa, pb, pc, pd] = PLAYERS;
  picks = {
    team: {
      [days[0]]: [[pa, best, 1], [pb, weak, 1], [pd, [P[2], P[2], P[3], P[4], P[0]], 1]],
      [days[1]]: [[pd, five, 2]],
      [days[3]]: [[pc, five, 3]],
    },
    rival: { [F.rivalRound(2)]: [[pa, [pb], 1], [pb, [pa], 1], [pc, [pa], 1], [pd, [pb], 1]] },
  };
  const mid = await hourly(U("2026-11-04T12:30Z"), s.out);
  const wm = read(mid.out, "W002.json");
  assert.equal(wm.final, false);
  assert.equal(wm.players.find((x) => x.a === pd).days[0].team, null, "an invalid pick (same producer twice) doesn't start a team");
  assert.match(wm.players.find((x) => x.a === pd).days[0].note, /twice/);
  assert.equal(wm.players.find((x) => x.a === pc), undefined, "Thursday's joiner has no row yet on Wednesday");
  // After Monday 9 Nov 00:00 but before 12:00: still checking.
  const late = await hourly(U("2026-11-09T06:30Z"), mid.out);
  assert.equal(read(late.out, "W002.json").final, false, "the correction window");
  const fin = await hourly(U("2026-11-09T12:30Z"), late.out);
  const w = read(fin.out, "W002.json");
  assert.equal(w.final, true);
  const row = (a) => w.players.find((x) => x.a === a);
  assert.equal(row(pa).full, true); assert.equal(row(pb).full, true);
  assert.equal(row(pc).full, false); assert.equal(row(pd).full, false);
  for (const d of row(pc).days.slice(0, 3)) assert.equal(d.score, 0, "days before joining score 0");
  // The scores are exactly the shared math on the recorded days.
  const dayRecs = read(fin.out, "days.json").days;
  const recs = days.map((d) => dayRecs.find((x) => x.day === d));
  assert.equal(row(pa).points, F.scoreWeek(sheet, recs, { [days[0]]: best }).points);
  assert.equal(row(pa).vault, F.vaultPoints(row(pa).points));
  assert.ok(row(pa).points > row(pb).points, "the reliable captain beats the unreliable one");
  assert.equal(w.players[0].a, pa);
  // Rivals: pa↔pb mutual = 1 match; pc and pd had no full week, so their challenges don't count.
  assert.deepEqual(w.matches, [{ a: pa, b: pb, mutual: true, result: "a" }]);
  const rv = read(fin.out, "rivals.json");
  assert.ok(rv.weeks.includes(2), "week 2 counted (week 1, the current week at the first run, had a late sheet and no players)");
  assert.deepEqual(rv.records[pa], { made: [1, 0, 0], received: [0, 0, 0] });
  assert.deepEqual(rv.records[pb], { made: [0, 1, 0], received: [0, 0, 0] });
  const again = await hourly(U("2026-11-09T13:30Z"), fin.out);
  assert.deepEqual(read(again.out, "rivals.json").records, rv.records, "a final week is counted once");
  assert.deepEqual(read(again.out, "W002.json"), w, "a final week never changes");
});

test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

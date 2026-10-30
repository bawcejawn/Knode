// V-P failing tests: NOT RUN HERE (static review). They drive the real survivor.js / survivor-math.js (APP=repo root)
// in a vm with a tiny DOM (harness.mjs), the way the page runs them. Expected to FAIL on 6e22c73 and pass after the fixes.
//   APP=/path/to/repo node --test v-p.test.mjs
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makePage, rowsText } from "./repolens-s3-page-harness.mjs";
// The harness reads survivor.js / survivor-math.js next to itself; point it at APP by copying them in first.
const HERE = path.dirname(fileURLToPath(import.meta.url));
void HERE; void fs; void path;

const DAY = 86400000, MIN = 60000;
const first = Math.floor(Date.parse("2026-11-16T00:00:00Z") / DAY);
const A = (c) => "1" + c.repeat(33);
const field = ["A", "B", "C", "D", "E", "F"].map((c) => ({ a: A(c), k: 1000, h: 1 }));
const fields = { v: 1, fields: [{ day: first + 4, field, out: 1 }, { day: first + 5, field, out: 1 }] };

test("V-P-1: a pick of a producer already used on a RECORDED day is flagged (it costs a life)", async () => {
  const ME = A("W"), X = A("C");
  const picks = { [first]: A("A"), [first + 1]: A("B"), [first + 2]: X, [first + 3]: A("D"), [first + 5]: X };
  const season = { v: 2, season: 1, startDay: first, who: [ME], prods: [], days: [1, 2, 3].map((n) => ({ n, day: first + n - 1 })), stakes: [],
    result: { over: false, endN: 3, final: false, players: [{ a: ME, lives: 2, outN: null, total: 3, used: [A("A"), A("B"), X], log: "sss", eligible: true, staked: false }], prizes: [] } };
  const pg = makePage({ firstDay: first, now: () => Date.parse("2026-11-20T12:00:00Z"), picks, season, fields, address: ME });
  await pg.flush();
  const warned = /Warning|cost a life|costs a life/.test(pg.ids["picks-who"].textContent) || /already used|costs a life|cost a life/.test(rowsText(pg.ids).find((t) => t.includes("day 6")));
  assert.ok(warned, "the day-6 pick of a producer used on recorded day 3 must carry a warning");
});

test("V-P-2: the page clock never moves back (device slow, node then lags)", async () => {
  let TRUE = Date.parse("2026-11-20T23:50:00Z"), lag = 0;
  const pg = makePage({ firstDay: first, now: () => TRUE - 5 * MIN, head: () => TRUE - lag, picks: { [first]: A("A") }, fields });
  await pg.flush();
  TRUE += 6 * MIN; lag = 4 * MIN; await pg.tick(60000);
  const offered = rowsText(pg.ids).some((t) => t.includes("day 6"));
  assert.equal(offered, pg.S.isOpen(first + 5, TRUE), "a day the chain has locked must not be offered");
});

// Fix-check round 2 (N-8, N-9): the publish job's Python ports must decide exactly as the recorder's JavaScript.
// The functions are taken from the workflow's histcheck.py heredoc itself (by name, with Python's ast module, nothing
// else in the script runs) and fed the same random weeks as the recorder's own watchWeek and hInt.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const APP = process.env.APP || fileURLToPath(new URL("../..", import.meta.url));
const { watchWeek } = await import(path.resolve(APP, "bot/games/lastnode.ts"));
const L = globalThis.KLastNode;
const yml = fs.readFileSync(path.resolve(APP, ".github/workflows/lastnode.yml"), "utf8");
const hist = yml.match(/<<'HIST'\n([\s\S]*?)\n\s*HIST\n/)[1].split("\n").map((l) => l.replace(/^ {10}/, "")).join("\n");
const py = (names, call, input) => execFileSync("python3", ["-I", "-c", `
import ast, json, math, sys
src = sys.argv[1]; names = set(json.loads(sys.argv[2]))
tree = ast.parse(src)
keep = [n for n in tree.body if (isinstance(n, ast.FunctionDef) and n.name in names) or (isinstance(n, ast.Assign) and any(e.id in names for t in n.targets for e in ([t] if isinstance(t, ast.Name) else getattr(t, 'elts', [])) if isinstance(e, ast.Name)))]
g = {"math": math, "json": json, "sys": sys, "H": 3600000, "DAY": 86400000, "errs": []}
exec(compile(ast.Module(body=keep, type_ignores=[]), "histcheck", "exec"), g)
print(json.dumps(eval(${JSON.stringify(call)}, g)))`, hist, JSON.stringify(names)], { input: JSON.stringify(input), encoding: "utf8", maxBuffer: 1 << 26 });

const A = (c) => "1" + c.repeat(33);
const NODES = ["A", "B", "C", "D", "E", "F", "G", "H", "J", "K"].map(A);
function week(R) {
  const kh = NODES.map(() => 20 + Math.floor(R.next() * 150));
  const field = { at: 0, c: 0, fairness: null, vt: 1, nodes: NODES.map((a, i) => ({ a, vhp: kh[i] * 10, kh: kh[i], h: Math.round((Math.max(...kh) / kh[i]) * 1e4) / 1e4 })) };
  const boost = NODES.map(() => (R.next() < 0.15 ? 1 + R.next() * 0.4 : 1));
  const evs = [];
  for (let d = 0; d < 7; d++) {
    const hours = Array.from({ length: 9 }, (_, i) => {
      const h = { i, from: 0, to: 0, checked: 2, blocks: Object.fromEntries(NODES.map((a, k) => [a, R.poisson(kh[k] * boost[k] * Math.exp(0.05 * R.normal()))])) };
      if (R.next() < 0.2) { const n = field.nodes[Math.floor(R.next() * NODES.length)]; h.hh = { [n.a]: Math.max(1, L.hInt(n) - 1 - Math.floor(R.next() * 3000)) }; }
      return h;
    });
    const res = L.cutsFrom(field, hours);
    evs.push({ v: 1, day: `d${d}`, start: d * 86400000, week: 0, field, hours, picks: {}, cuts: res.cuts, standing: res.standing, winner: res.winner, done: res.done, players: [], ...(R.next() < 0.05 ? { void: "x" } : {}) });
  }
  return evs;
}

test("N-9: the publish job's watch_week flags exactly what the recorder's watchWeek flags (500 random weeks)", () => {
  const R = L.rng(77), weeks = Array.from({ length: 500 }, () => week(R));
  const want = weeks.map((w) => watchWeek(w, 3600000));
  const got = JSON.parse(py(["js_round", "h_int", "watch_week", "WEEK_Z", "WEEK_WINS", "EVENT_Z"], "[watch_week(w) for w in json.load(sys.stdin)]", weeks));
  assert.deepEqual(got, want);
  assert.ok(want.filter((x) => x.length).length >= 20, "the sample has flagged weeks too");
});

test("N-8: js_round and h_int are JavaScript's Math.round, including 0.49999999999999994 and halves", () => {
  const xs = [0.49999999999999994, 0.5, 1.5, 2.5, -0.5, 1e4 * 4.9999999999999996e-5, 12345.5, 0.1 + 0.2, 4503599627370495.5];
  const got = JSON.parse(py(["js_round"], "[js_round(x) for x in json.load(sys.stdin)]", xs));
  assert.deepEqual(got, xs.map((x) => Math.round(x) + 0));   // + 0: JSON has no -0
});

test("N-1: the publish job's field check accepts every field makeField gives (random cards, with and without form)", () => {
  const R = L.rng(5), cases = [];
  for (let k = 0; k < 60; k++) {
    const day = `2026-11-${String(10 + (k % 18)).padStart(2, "0")}`, ev = L.eventOf(day);
    const n = 2 + Math.floor(R.next() * 24);
    const rows = Array.from({ length: n }, (_, i) => ({ a: "1" + (i.toString(36) + "x".repeat(40)).slice(0, 33).replace(/[0OIl]/g, "z"), vhp: Math.round((50000 + R.next() * 3e6) * 100) / 100, k: 60 + R.next() * 1500 }));
    const card = { at: ev.cardTime + Math.floor(R.next() * 50) * 60000, field: rows, paddock: [{ a: "1" + "p".repeat(33), vhp: 1234.56, k: 3 }] };
    const form = R.next() < 0.6 ? Object.fromEntries(rows.map((r) => [r.a, Math.round((0.8 + R.next() * 0.4) * 1000) / 1000])) : null;
    const f = L.makeField(card, 200, form, form ? { hours: 48, from: ev.cardTime - 48 * 3600000, to: ev.cardTime } : null);
    if (!f) continue;
    cases.push({ card, j: { start: ev.start, field: f } });
  }
  assert.ok(cases.length >= 40);
  const names = ["js_round", "r2", "card_total", "opens_of", "card_time_of", "round_of", "lock_of", "OFFSET", "check_field_card", "bad"];
  const got = JSON.parse(py(names, "[(globals().__setitem__('CARDS', [c['card']]), errs.clear(), check_field_card('D.json', c['j']), list(errs))[3] for c in json.load(sys.stdin)]", cases));
  assert.deepEqual(got.filter((e) => e.length), [], "every honest field passes");
  // And the check isn't blind: one node's handicap nudged by 0.0001 is refused in every case.
  const nudged = cases.map((c) => ({ ...c, j: { ...c.j, field: { ...c.j.field, nodes: c.j.field.nodes.map((x, i) => (i === c.j.field.nodes.length - 1 ? { ...x, h: Math.round((x.h + 0.0001) * 1e4) / 1e4 } : x)) } } }));
  const bad = JSON.parse(py(names, "[(globals().__setitem__('CARDS', [c['card']]), errs.clear(), check_field_card('D.json', c['j']), list(errs))[3] for c in json.load(sys.stdin)]", nudged));
  assert.ok(bad.every((e) => e.some((m) => /handicap isn't the formula's/.test(m))), JSON.stringify(bad.filter((e) => !e.length).length));
});

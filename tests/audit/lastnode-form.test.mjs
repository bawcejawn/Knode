// Last Node Standing: form (owner, 2026-10-29). A node's expected blocks = its VHP share × the blocks it actually signed
// in the 48 hours before the card ÷ the blocks that share gave it (hour by hour, from that hour's race card), kept
// within 0.80–1.20. Real blocks: nodes signed a steady 78%–108% of their VHP share, and with VHP alone the steady
// over-signers won most events (one won 35–40%) and two nodes never won.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const APP = process.env.APP || ".";
const { run, sharesByHour } = await import(path.resolve(APP, "bot/games/lastnode.ts"));
import { raceDir, hourOf, hoursOf, samplesDir, base } from "./lastnode-form.helpers.mjs";
const M = globalThis.KRaceMath, L0 = globalThis.KLastNode;
const F = L0.forGame(L0.FAST_GAME);
const A = (c) => "1" + c.repeat(33);
const [N1, N2, N3, N4, P5] = ["A", "B", "C", "D", "E"].map(A);
const EV = F.eventOf("2026-11-03T08"), H = 3600000;

test("formOf: blocks ÷ the VHP share's blocks, hour by hour, kept within 0.80–1.20; too few hours gives none", () => {
  const sh = { [N1]: 0.5, [N2]: 0.3, [N3]: 0.2 };
  const hour = { blocks: { [N1]: 600, [N2]: 300, [N3]: 300 }, shares: sh };      // 1200 blocks: N1 100%, N2 83%, N3 125%
  const f = L0.formOf(Array(30).fill(hour));
  assert.deepEqual(f, { [N1]: 1, [N2]: 0.833, [N3]: 1.2 }, "N3's 125% is kept at 1.20");
  assert.equal(L0.formOf(Array(23).fill(hour)), null, "under 24 usable hours: no form");
  assert.equal(L0.formOf([...Array(23).fill(hour), ...Array(25).fill({ blocks: hour.blocks, shares: null })]), null, "hours without a card don't count");
  const low = L0.formOf(Array(48).fill({ blocks: { [N1]: 900, [N2]: 100 }, shares: sh }));
  assert.equal(low[N2], 0.8, "a node signing far less is kept at 0.80"); assert.equal(low[N3], 0.8, "and one that signed nothing");
});

test("makeField with form: expected blocks × form, handicaps follow, who is in the field doesn't change", () => {
  const card = { at: 1, field: [{ a: N1, vhp: 4000, k: 1200 }, { a: N2, vhp: 2000, k: 600 }, { a: N3, vhp: 1000, k: 300 }, { a: N4, vhp: 1000, k: 300 }] };
  const plain = L0.makeField(card, 2000), withForm = L0.makeField(card, 2000, { [N1]: 1.05, [N3]: 0.8 }, { hours: 48, from: 0, to: 48 * H });
  assert.deepEqual(withForm.nodes.map((n) => n.a), plain.nodes.map((n) => n.a));
  const by = (f) => Object.fromEntries(f.nodes.map((n) => [n.a, n]));
  assert.equal(by(withForm)[N3].r, 0.8); assert.equal(by(withForm)[N4].r, 1, "no form for a node: 1");
  assert.equal(by(withForm)[N3].kh, 40, "300 a race leg = 50 an hour, × 0.8");
  assert.ok(by(withForm)[N3].h > by(withForm)[N4].h, "the node that signs less gets the bigger multiplier");
  assert.ok(!("r" in plain.nodes[0]) && !("form" in plain), "without form the field is exactly as before");
  assert.deepEqual(withForm.form, { hours: 48, from: 0, to: 48 * H });
});

test("the real cards fix the bias: the two steady under-signers win again, the steady over-signer stops winning most", () => {
  // A 10-node field like 29 Oct (VHP shares and the form measured then), many simulated events at each node's real rate.
  const nodes = [[2192632, 1.045], [1731840, 1.04], [1416018, 1.019], [1303828, 1.013], [1142005, 1.029], [854142, 1.045], [724507, 0.953], [666650, 0.8], [631576, 1.076], [605609, 0.8]];
  const card = { at: 1, field: nodes.map(([v], i) => ({ a: A("abcdefghij"[i]), vhp: v, k: (v / 1e4) * 6 })) };
  const form = Object.fromEntries(nodes.map(([, r], i) => [A("abcdefghij"[i]), r]));
  const R = L0.rng(99), T = 3000;
  const chances = (f) => {
    const w = new Map();
    for (let t = 0; t < T; t++) {
      const hours = [];
      for (let k = 0; k < 9; k++) hours.push({ blocks: Object.fromEntries(card.field.map((x) => [x.a, R.poisson((x.k / 6) * form[x.a])])) });   // an hour
      const r = L0.cutsFrom(f, hours); w.set(r.winner, (w.get(r.winner) || 0) + 1 / T);
    }
    return card.field.map((x) => w.get(x.a) || 0);
  };
  const before = chances(L0.makeField(card, 3000)), after = chances(L0.makeField(card, 3000, form));
  assert.ok(Math.max(...before) > 0.3 && Math.min(...before) < 0.01, `VHP only: ${before.map((x) => x.toFixed(2))}`);
  assert.ok(Math.max(...after) < 0.16 && Math.min(...after) > 0.05, `with form: ${after.map((x) => x.toFixed(2))}`);
});

// ── the recorder ──
test("the recorder sets the field with form from the 48 h before the card, on both nodes, and publishes it", async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "lns-f-")), t = EV.opens + 15 * 60000;
  const r = await run(base({ raceDir: raceDir(), out, hoursOf: hoursOf(false), now: { time: t, libTime: t } }));
  assert.ok(fs.existsSync(path.join(out, "D2026-11-03T08.json")), `problems: ${r.problems.join("; ")} files: ${fs.readdirSync(out)}`);
  const d = JSON.parse(fs.readFileSync(path.join(out, "D2026-11-03T08.json"), "utf8"));
  const by = Object.fromEntries(d.field.nodes.map((n) => [n.a, n]));
  assert.deepEqual([by[N1].r, by[N2].r, by[N3].r, by[N4].r], [1, 1, 1, 0.8]);
  assert.deepEqual(d.field.form, { hours: 48, from: EV.cardTime - 48 * H, to: EV.cardTime });
  assert.ok(by[N4].h > by[N3].h);
  void r;
  // The publish check takes it.
  const yml = fs.readFileSync(path.resolve(APP, ".github/workflows/lastnode.yml"), "utf8");
  const checkPy = yml.match(/<<'PY'\n([\s\S]*?)\n\s*PY\n/)[1].split("\n").map((l) => l.replace(/^ {10}/, "")).join("\n");
  // (a real-game day file carrying this field: the mainnet check is written for the daily game's files)
  const pub = fs.mkdtempSync(path.join(os.tmpdir(), "lns-fp-"));
  fs.writeFileSync(path.join(pub, "D2026-11-03.json"), JSON.stringify({ v: 1, day: "2026-11-03", start: Date.UTC(2026, 10, 3, 14), week: L0.weekOf(Date.UTC(2026, 10, 3, 14)), field: d.field, hours: [], picks: {}, cuts: [], standing: [], winner: null, done: false, players: [] }));
  execFileSync("python3", ["-I", "-c", checkPy, pub], { stdio: "pipe", env: { ...process.env, RUNNER_TEMP: fs.mkdtempSync(path.join(os.tmpdir(), "rt-")) } });
});

test("the two nodes disagree on the form's blocks: no field this run; 3 hours after picks open, the field is set without form", async () => {
  const dir = raceDir(), out = fs.mkdtempSync(path.join(os.tmpdir(), "lns-f2-"));
  const early = EV.opens + 15 * 60000;
  const r1 = await run(base({ raceDir: dir, out, hoursOf: hoursOf(true), now: { time: early, libTime: early } }));
  assert.ok(r1.problems.some((p) => /form: the two nodes disagree/.test(p)), r1.problems.join("; "));
  assert.ok(!fs.existsSync(path.join(out, "D2026-11-03T08.json")), "no field yet, so no file");
  const late = EV.opens + 3 * 3600000 + 60000;   // fix-check LNF-16: 3 hours after picks open
  const r2 = await run(base({ raceDir: dir, prev: out, out, hoursOf: hoursOf(true), now: { time: late, libTime: late } }));
  assert.ok(r2.problems.some((p) => /form not measured/.test(p)));
  const d = JSON.parse(fs.readFileSync(path.join(out, "D2026-11-03T08.json"), "utf8"));
  assert.ok(d.field && !("r" in d.field.nodes[0])); assert.match(d.field.form.note, /disagree/);
});

test("sharesByHour: each hour's card (never one older than 3 hours), every producer on it", () => {
  const c1 = { at: 0, field: [{ a: N1, vhp: 3 }], paddock: [{ a: N2, vhp: 1 }] };
  const s = sharesByHour([c1], 0, 5);
  assert.deepEqual(s[0], { [N1]: 0.75, [N2]: 0.25 });
  assert.ok(s[3]); assert.equal(s[4], null, "a card over 3 hours old isn't used");
});

test("fix-check LNF-6: a 48-hour read that never answers is cut off, and the run still finishes", async () => {
  const dir = raceDir(), out = fs.mkdtempSync(path.join(os.tmpdir(), "lns-f3-")), t = EV.opens + 15 * 60000;
  const started = Date.now();
  const r = await run(base({ raceDir: dir, out, hoursOf: () => new Promise(() => {}), formDeadlineMs: 300, now: { time: t, libTime: t } }));
  assert.ok(Date.now() - started < 30000, "finished");
  assert.ok(r.problems.some((p) => /took over/.test(p)), r.problems.join("; "));
});

test("fix-check LNF-4: VHP swapped between two addresses counts once (hourly average), so the form isn't dragged down", async () => {
  const { sharesFromSamples, samplesIn } = await import(path.resolve(APP, "bot/games/lastnode.ts"));
  // N4 (1000) moves its VHP to a second address B and back every 3 hours; on hourly cards (6-hour highs) both show 1000.
  const B = A("F");
  const dir = samplesDir((t) => (Math.floor((t - EV.cardTime) / (3 * H)) % 2 ? { [N1]: 4000, [N2]: 2000, [N3]: 1000, [B]: 1000 } : { [N1]: 4000, [N2]: 2000, [N3]: 1000, [N4]: 1000 }));
  const sh = sharesFromSamples(samplesIn(dir), EV.cardTime - 48 * H, 48);
  assert.ok(sh.every((x) => x), "every hour has its samples");
  // Blocks: each address signs its share while it holds the VHP.
  const hours = sh.map((s, k) => ({ shares: s, blocks: Math.floor(k / 3) % 2 ? { [N1]: 500, [N2]: 250, [N3]: 125, [B]: 125 } : { [N1]: 500, [N2]: 250, [N3]: 125, [N4]: 125 } }));
  const f = L0.formOf(hours);
  assert.ok(Math.abs(f[N4] - 1) < 0.02 && Math.abs(f[B] - 1) < 0.02, `form ${f[N4]} / ${f[B]} (the 6-hour high gave 0.80)`);
  assert.ok(Math.abs(f[N1] - 1) < 0.02, "the others aren't pushed up");
  // Hours with under 6 samples don't count.
  assert.equal(sharesFromSamples(samplesIn(dir).filter((x, i) => i % 3 === 0), EV.cardTime - 48 * H, 48)[0], null);
});

test("fix-check LNF-3: VHP added after the field's card lowers that node's multiplier (never raises anyone's)", () => {
  const card = { at: 1, field: [{ a: N1, vhp: 4000, k: 1200 }, { a: N2, vhp: 2000, k: 600 }, { a: N3, vhp: 1000, k: 300 }, { a: N4, vhp: 1000, k: 300 }], paddock: [] };
  const f = L0.makeField(card, 2000);
  assert.equal(f.vt, 8000);
  assert.deepEqual(L0.raceCut(f, card), {}, "nobody gained");
  const more = { ...card, at: 2, field: card.field.map((x) => (x.a === N3 ? { ...x, vhp: 2000 } : x)) };
  const cut = L0.raceCut(f, more), n3 = f.nodes.find((n) => n.a === N3);
  assert.deepEqual(Object.keys(cut), [N3], "only N3 changes, and nobody is raised");
  assert.equal(cut[N3], Math.floor(L0.hInt(n3) * 1000 / 2000 + 0.5), "halved: its VHP doubled");
  // In the race: total VHP 8,000 → 9,000, so N3 signs 2 × 8/9 of its card rate and everyone else 8/9.
  const R = L0.rng(3), T = 3000, ks = Object.fromEntries(f.nodes.map((n) => [n.a, n.kh]));
  const chance = (useCut) => { let w = 0; for (let t = 0; t < T; t++) { const hs = []; for (let k = 0; k < 3; k++) hs.push({ blocks: Object.fromEntries(f.nodes.map((n) => [n.a, R.poisson(ks[n.a] * (8 / 9) * (n.a === N3 ? 2 : 1))])), ...(useCut ? { hh: cut } : {}) }); if (L0.cutsFrom(f, hs).winner === N3) w++; } return w / T; };
  const before = chance(false), after = chance(true);
  assert.ok(before > 0.7, `without the check: ${before}`);
  assert.ok(after <= 1.5 / 4, `with the check: ${after} (fair 0.25)`);
});

test("fix-check LNF-3/N-4: the recorder checks each window against the first race card taken after it and records what it lowered", async () => {
  const later = { at: EV.start + 22 * 60000, field: [{ a: N1, vhp: 4000, k: 1200 }, { a: N2, vhp: 2000, k: 600 }, { a: N3, vhp: 1000, k: 300 }, { a: N4, vhp: 2000, k: 600 }], paddock: [] };
  const dir = raceDir([later]), out = fs.mkdtempSync(path.join(os.tmpdir(), "lns-f4-"));
  const t1 = EV.opens + 15 * 60000;
  await run(base({ raceDir: dir, out, hoursOf: hoursOf(false), now: { time: t1, libTime: t1 } }));
  // Only this event's windows (earlier events in the window would use up the run's hour budget).
  const win = async (node, a, b) => { if (a < EV.start) throw new Error("not this test's event"); return { from: 1, to: 2, counts: { [N1]: 70, [N2]: 35, [N3]: 15, [N4]: 30 } }; };
  const t2 = EV.start + 25 * 60000;
  const r = await run(base({ raceDir: dir, prev: out, out, hoursOf: hoursOf(false), windowOf: win, now: { time: t2, libTime: t2 } }));
  const d = JSON.parse(fs.readFileSync(path.join(out, "D2026-11-03T08.json"), "utf8"));
  assert.equal(d.hours.length, 1, `${r.problems.join("; ")} | ${JSON.stringify(d.field && d.field.at)} ${JSON.stringify(d.hours)}`);
  assert.equal(d.hours[0].card, later.at);
  const n4 = d.field.nodes.find((n) => n.a === N4);
  assert.deepEqual(d.hours[0].hh, { [N4]: Math.floor(L0.hInt(n4) * 1000 / 2000 + 0.5) }, "N4 doubled its VHP: its multiplier is halved for this window");
});

test("watch-and-hold: a node far above its multiplier that won 2+ races holds the week's vault file", async () => {
  const { watchWeek } = await import(path.resolve(APP, "bot/games/lastnode.ts"));
  const field = { at: 0, c: 0, fairness: null, vt: 8000, nodes: [{ a: N1, vhp: 4000, kh: 200, h: 1 }, { a: N2, vhp: 2000, kh: 100, h: 2 }, { a: N3, vhp: 1000, kh: 50, h: 4 }, { a: N4, vhp: 1000, kh: 50, h: 4 }] };
  const ev = (rate) => {
    const hours = Array.from({ length: 3 }, (_, i) => ({ i, from: 0, to: 0, checked: 2, blocks: { [N1]: 200 * (60 / 60), [N2]: 100, [N3]: 50 - 5 * i, [N4]: Math.round(50 * rate) } }));
    const res = L0.cutsFrom(field, hours);
    return { field, hours, cuts: res.cuts, winner: res.winner, done: res.done };
  };
  const honest = watchWeek([ev(1.0), ev(1.0), ev(1.0)], 3600000);
  assert.deepEqual(honest, [], "on par: nothing held");
  const hot = watchWeek([ev(1.15), ev(1.15), ev(1.15), ev(1.15)], 3600000);   // 15% over: above 3 standard deviations for 600 expected blocks
  assert.equal(hot.length, 1); assert.equal(hot[0].a, N4); assert.ok(hot[0].q >= 1.1 && hot[0].wins >= 2);
});

// ── Fix-check round 2 (FIXCHECK-LASTNODE-2.md), pasted in from the reviewer's paste-in file ──
test("M-R-1: a window is checked against a race card that covers the WHOLE window (taken at or after its end)", async () => {
  // Card A: taken 5 minutes into window 0, before N4 adds VHP. Card B: taken just after window 0 ends, N4 doubled.
  // VHP N4 added after card A produced for most of window 0; only a card taken after the window's end can see it.
  const row = (v4) => [{ a: N1, vhp: 4000, k: 1200 }, { a: N2, vhp: 2000, k: 600 }, { a: N3, vhp: 1000, k: 300 }, { a: N4, vhp: v4, k: v4 * 0.3 }];
  const A = { at: EV.start + 5 * 60000, field: row(1000), paddock: [] }, B = { at: EV.start + F.CUT + 5 * 60000, field: row(2000), paddock: [] };
  const dir = raceDir([A, B]), out = fs.mkdtempSync(path.join(os.tmpdir(), "mr1-"));
  const t1 = EV.opens + 15 * 60000;
  await run(base({ raceDir: dir, out, hoursOf: hoursOf(false), now: { time: t1, libTime: t1 } }));
  const win = async (node, a, b) => { if (a < EV.start) throw new Error("not this event"); return { from: 1, to: 2, counts: { [N1]: 70, [N2]: 35, [N3]: 15, [N4]: 30 } }; };
  const t2 = EV.start + F.CUT + 10 * 60000;
  await run(base({ raceDir: dir, prev: out, out, hoursOf: hoursOf(false), windowOf: win, now: { time: t2, libTime: t2 } }));
  const d = JSON.parse(fs.readFileSync(path.join(out, `D${EV.day}.json`), "utf8"));
  assert.equal(d.hours.length, 1);
  assert.ok(d.hours[0].card >= EV.start + F.CUT, `window 0 named a card taken ${(EV.start + F.CUT - d.hours[0].card) / 60000} min before its end`);
  assert.ok(d.hours[0].hh && d.hours[0].hh[N4] < L0.hInt(d.field.nodes.find((n) => n.a === N4)), "N4's VHP added during window 0 must lower its multiplier for window 0");
});

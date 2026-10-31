// M-F failing tests — NOT RUN HERE (static review). Place in tests/audit/ of bawcejawn/Knode at 7c301a8; they drive the
// real code paths (bot/games/lastnode.ts run/samplesIn/sharesFromSamples, lastnode-math.js formOf, the workflow shell).
import test from "node:test"; import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { withBash } from "./lib/platform.mjs";
const APP = fileURLToPath(new URL("../..", import.meta.url));
await import(pathToFileURL(path.resolve(APP, "race-math.js")).href); await import(pathToFileURL(path.resolve(APP, "lastnode-math.js")).href);
const L0 = globalThis.KLastNode;
const H = 3600000, A = (c) => "1" + c.repeat(33), N1 = A("A"), N2 = A("B"), N3 = A("C"), N4 = A("D");
const write = (d, name, samples) => fs.writeFileSync(path.join(d, name), JSON.stringify({ v: 1, updated: "x", samples }));
const smp = (t, vhp, extra = {}) => ({ at: t, height: 1, vhp: Object.fromEntries(Object.entries(vhp).map(([a, v]) => [a, String(v * 1e8)])), ...extra });

test("M-F-1: samples whose VHP the two nodes disputed (BX-86 flagged/high) can't move a node's form", async () => {
  const { samplesIn, sharesFromSamples } = await import(pathToFileURL(path.resolve(APP, "bot/games/lastnode.ts")).href);
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "mf1-")), t0 = 1_800_000_000_000 - (1_800_000_000_000 % H), real = { [N1]: 4000, [N2]: 2000, [N3]: 1000, [N4]: 1000 };
  const all = [];
  for (let t = t0; t < t0 + 48 * H; t += 5 * 60000) {
    const lie = t >= t0 + 10 * H && t < t0 + 12 * H;   // one node reads everyone but N4 as 0 for 2 hours: lower read kept, flagged
    all.push(lie ? smp(t, { [N1]: 0, [N2]: 0, [N3]: 0, [N4]: 1000 }, { flagged: [N1, N2, N3].sort(), high: { [N1]: String(4000e8), [N2]: String(2000e8), [N3]: String(1000e8) } }) : smp(t, real));
  }
  write(d, "S0.json", all);
  const sh = sharesFromSamples(samplesIn(d), t0, 48);
  const hours = sh.map((s) => ({ shares: s, blocks: { [N1]: 500, [N2]: 250, [N3]: 125, [N4]: 125 } }));
  const f = L0.formOf(hours);
  assert.ok(Math.abs(f[N4] - 1) < 0.02, `N4 signed exactly its share; form ${f[N4]} (0.8 = the lying node bought it the floor)`);
});

withBash("M-F-2: a failed read of race-samples is not 'no branch yet' (the record step fails, so no field is set without form)", () => {
  const yml = fs.readFileSync(path.resolve(APP, ".github/workflows/lastnode.yml"), "utf8");
  // The whole samples block (from its mkdir to the if's closing fi), so a cut-off block can't fail on syntax alone.
  const lines = yml.split("\n"), i0 = lines.findIndex((l) => l.includes('mkdir -p "$RUNNER_TEMP/samples"'));
  const i1 = lines.findIndex((l, k) => k > i0 + 1 && /^ {10}fi\s*$/.test(l));
  const step = lines.slice(i0, i1 + 1).map((l) => l.replace(/^ {10}/, "")).join("\n");
  assert.equal(spawnSync("bash", ["-n", "-c", step]).status, 0, "the block is whole");
  const rt = fs.mkdtempSync(path.join(os.tmpdir(), "mf2-")), work = fs.mkdtempSync(path.join(os.tmpdir(), "mf2w-"));
  execFileSync("git", ["init", "-q"], { cwd: work });
  const r = spawnSync("bash", ["-c", `set -euo pipefail\nRUNNER_TEMP=${rt}; repo=file://${rt}/unreachable\n${step}`], { cwd: work, encoding: "utf8" });
  assert.notEqual(r.status, 0, `a network error was taken for "no branch": ${r.stdout}`);
  assert.match(r.stdout, /Couldn't read the race-samples branch/);
  // A reachable repository without the branch (exit 2) is the honest "no samples yet": the step goes on.
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "mf2e-"));
  execFileSync("git", ["init", "-q", "--bare", empty]);
  const ok = spawnSync("bash", ["-c", `set -euo pipefail\nRUNNER_TEMP=${rt}; repo=file://${empty}\n${step}`], { cwd: work, encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr); assert.match(ok.stdout, /No race-samples branch yet/);
});

import { raceDir, hoursOf, samplesDir, base, EV, F } from "./lastnode-form.helpers.mjs";
const out = () => fs.mkdtempSync(path.join(os.tmpdir(), "mf-"));
const dayOf = (d) => { const f = path.join(d, `D${EV.day}.json`); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null; };

test("M-F-2b: mainnet, samples present on the branch but too few this run: the field waits (with a warning), not set at once without form", async () => {
  const { run } = await import(pathToFileURL(path.resolve(APP, "bot/games/lastnode.ts")).href);
  const t = EV.opens + 15 * 60000;
  // Only the last 10 of the 48 hours have samples (the history fetch fell short): even with the owner's no-form
  // override, the field waits (the samples may be late), and says why.
  const few = samplesDir(undefined, EV.cardTime - 10 * H, EV.cardTime), o1 = out();
  const r = await run(base({ raceDir: raceDir(), out: o1, samplesDir: few, hoursOf: hoursOf(false), now: { time: t, libTime: t } }));
  assert.ok(r.problems.some((p) => /samples/.test(p)), r.problems.join("; ")); assert.equal(dayOf(o1), null, "no field yet");
  // No samples at all and no override (the default on mainnet): waits too.
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "mf-empty-")), o2 = out();
  const r2 = await run(base({ raceDir: raceDir(), out: o2, samplesDir: empty, allowNoForm: false, hoursOf: hoursOf(false), now: { time: t, libTime: t } }));
  assert.ok(r2.problems.some((p) => /samples/.test(p)), r2.problems.join("; ")); assert.equal(dayOf(o2), null);
});

test("M-F-3: mainnet doesn't open a game-13 event without form unless the owner allows it (launch state holds every week)", async () => {
  // The launch gate (fix-check N-10): no race-samples yet. Without LASTNODE_ALLOW_NO_FORM the field never comes and the
  // event is void at its lock; with it, the field is set without form (and says so).
  const { run } = await import(pathToFileURL(path.resolve(APP, "bot/games/lastnode.ts")).href);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "mf-empty-")), o = out();
  const late = EV.opens + 3 * H + 60000;
  const r1 = await run(base({ raceDir: raceDir(), out: o, samplesDir: empty, allowNoForm: false, practice: false, hoursOf: hoursOf(false), now: { time: late, libTime: late } }));
  assert.equal(dayOf(o), null, "no field 3 hours after picks open"); assert.ok(r1.problems.some((p) => /LASTNODE_ALLOW_NO_FORM is off/.test(p)), r1.problems.join("; "));
  const locked = EV.lock + 60000;
  await run(base({ raceDir: raceDir(), prev: o, out: o, samplesDir: empty, allowNoForm: false, practice: false, hoursOf: hoursOf(false), now: { time: locked, libTime: locked } }));
  const v = dayOf(o);
  assert.ok(v && v.field === null && /form couldn't be measured/.test(v.void), JSON.stringify(v));
  // The env switch is what main() reads (no override passed).
  const src = fs.readFileSync(path.resolve(APP, "bot/games/lastnode.ts"), "utf8");
  assert.match(src, /E\.LASTNODE_ALLOW_NO_FORM === "true"/);
  // With the owner's override: the field, without form, as soon as picks open.
  const o2 = out(), t = EV.opens + 15 * 60000;
  await run(base({ raceDir: raceDir(), out: o2, samplesDir: empty, allowNoForm: true, practice: false, hoursOf: hoursOf(false), now: { time: t, libTime: t } }));
  const f = dayOf(o2);
  assert.ok(f && f.field && !("r" in f.field.nodes[0]) && /samples/.test(f.field.form.note), JSON.stringify(f && f.field));
});

test("M-F-4 (LNF-6): after the 4-minute deadline the losing 48 h read stops, and the recorder process exits", () => {
  const helpers = path.resolve(APP, "tests/audit/lastnode-form.helpers.mjs");
  const script = `
    const { run, finish } = await import(${JSON.stringify(pathToFileURL(path.resolve(APP, "bot/games/lastnode.ts")).href)});
    const { raceDir, base, EV } = await import(${JSON.stringify(pathToFileURL(helpers).href)});
    // a slow read that keeps the event loop alive (timers, as withRetry/sockets do): 20 x 1 s
    const slow = async (_n, _a, n) => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 1000)); return Array.from({ length: n }, () => ({})); };
    const t = EV.opens + 15 * 60000;
    finish(run(base({ raceDir: raceDir(), out: ${JSON.stringify(fs.mkdtempSync(path.join(os.tmpdir(), "mf4-")))}, hoursOf: slow, formDeadlineMs: 300, now: { time: t, libTime: t } })));`;
  const started = Date.now();
  const r = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: APP, encoding: "utf8", timeout: 60000 });
  const took = Date.now() - started;
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /took over 0 s|took over/);
  assert.ok(took < 5000 + 3000, `the recorder exited after ${took} ms (the slow read takes 20 s)`);   // + node/tsx start-up
});

test("N-5: one inserted sample per hour with a huge value (no flags) can't move a node's form either", async () => {
  const { samplesIn, sharesFromSamples } = await import(pathToFileURL(path.resolve(APP, "bot/games/lastnode.ts")).href);
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "mf5-")), t0 = 1_800_000_000_000 - (1_800_000_000_000 % H), real = { [N1]: 4000, [N2]: 2000, [N3]: 1000, [N4]: 1000 };
  const all = [];
  for (let t = t0; t < t0 + 48 * H; t += 5 * 60000) all.push(smp(t, real));
  for (const h of [10, 11]) all.push({ at: t0 + h * H + 61000, height: 1, vhp: { ...Object.fromEntries(Object.entries(real).map(([a, v]) => [a, String(v * 1e8)])), [N1]: "99999999999999999999" } });
  write(d, "S0.json", all);
  const sh = sharesFromSamples(samplesIn(d), t0, 48);
  const f = L0.formOf(sh.map((s) => ({ shares: s, blocks: { [N1]: 500, [N2]: 250, [N3]: 125, [N4]: 125 } })));
  for (const a of [N1, N2, N3, N4]) assert.ok(Math.abs(f[a] - 1) < 0.02, `${a}: form ${f[a]}`);
});

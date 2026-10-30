// Handicap VHP that is hard to game (audit BX-3 b; owner 2026-10-28; project doc claude/handicap-anti-gaming.md):
// effective VHP, random samples about every 10 minutes, the highest of the last 6 hours, and a floor from real block
// production. These only choose the VHP behind a card; each game keeps its own multiplier rule.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const APP = process.env.APP || ".";
const R = await import(path.resolve(APP, "bot/race.ts"));
const H = 3600000, T = Date.parse("2026-11-02T06:00:00Z");
const A = "1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", B = "1BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", C = "1CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const sat = (v) => String(BigInt(v) * 100000000n);
const dirs = []; const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "rvhp-")); dirs.push(d); return d; };

test("rule 2: a producer that looks small now gets the highest of its samples in the last 6 hours", () => {
  const samples = [
    { at: T - 7 * H, height: 1, vhp: { [A]: sat(900) } },          // older than 6 hours: ignored
    { at: T - 5 * H, height: 2, vhp: { [A]: sat(400), [B]: sat(300) } },
    { at: T - 1 * H, height: 3, vhp: { [A]: sat(410), [B]: sat(250) } },
    { at: T + 60000, height: 4, vhp: { [A]: sat(5000) } },                 // after the card: never counts
  ];
  const v = R.windowHigh({ [A]: sat(10), [B]: sat(300), [C]: sat(50) }, samples, T);
  assert.equal(v[A], BigInt(sat(410)), "moved its VHP away just before the card: the card still sees 410");
  assert.equal(v[B], BigInt(sat(300)));
  assert.equal(v[C], BigInt(sat(50)), "no samples: the read at card time");
});

test("rule 3: a producer signing far more blocks than its card share is raised; normal luck is left alone", () => {
  const vhp = { [A]: BigInt(sat(100)), [B]: BigInt(sat(100)), [C]: BigInt(sat(800)) };   // A: 10% of the VHP
  // 7,200 blocks: A signed 30% of them (far beyond luck for 10%), B 9% (normal), C the rest.
  const counts = new Map([[A, 2160], [B, 648], [C, 4392]]);
  const { vhp: out, raised } = R.productionFloor(vhp, counts, 7200);
  assert.deepEqual(raised, [A]);
  const share = Number(out[A]) / Number(out[A] + out[B] + out[C]);
  assert.ok(share >= 0.28 && share < 0.31, `A's card share now follows its production (${share})`);
  assert.equal(out[B], vhp[B]); assert.equal(out[C], vhp[C], "never lowers anyone");
  const lucky = R.productionFloor(vhp, new Map([[A, 760], [B, 700], [C, 5740]]), 7200);  // A at 10.6%: luck
  assert.deepEqual(lucky.raised, []);
});

// A tiny fake chain for the sampler: 1,500 blocks signed by A and B.
const fakeNode = () => ({
  async getHeadInfo() { return { head_topology: { height: "1500", id: "0xh" }, head_block_time: String(T), last_irreversible_block: "1440" }; },
  async call(m, a) {
    const s = Number(a.ancestor_start_height), items = [];
    for (let h = s; h < s + a.num_blocks && h <= 1500; h++) items.push({ block_height: String(h), block: { header: { signer: h % 3 ? A : B, timestamp: String(T - (1500 - h) * 3000) } } });
    return { block_items: items };
  },
});

test("sampler: waits a random moment, reads effective VHP on both nodes, keeps 8 hours; a disagreement is taken producer by producer", async () => {
  const out = tmp(), waits = [];
  const vhpOf = async (w) => Object.fromEntries(w.map((a) => [a, a === A ? sat(400) : sat(200)]));
  const log = console.log; console.log = () => {};
  let r;
  try { r = await R.sample({ p: fakeNode(), check: fakeNode(), prev: "", out, vhpOf, spreadMs: 480000, wait: async (ms) => { waits.push(ms); }, clock: () => T }); } finally { console.log = log; }
  assert.equal(waits.length, 1); assert.ok(waits[0] >= 0 && waits[0] < 480000, "a random wait under 8 minutes");
  const f = JSON.parse(fs.readFileSync(path.join(out, "vhp-samples.json"), "utf8"));
  assert.equal(f.samples.length, 1); assert.equal(f.samples[0].vhp[A], sat(400)); assert.equal(f.samples[0].height, 1500);
  // An old sample is dropped after 8 hours; the next one is appended.
  const prev = tmp();
  fs.writeFileSync(path.join(prev, "vhp-samples.json"), JSON.stringify({ v: 1, updated: "x", samples: [{ at: T - 9 * H, height: 1, vhp: { [A]: "1" } }, { at: T - H, height: 2, vhp: { [A]: "2" } }] }));
  const out2 = tmp(); console.log = () => {};
  try { await R.sample({ p: fakeNode(), check: fakeNode(), prev, out: out2, vhpOf, spreadMs: 0, clock: () => T }); } finally { console.log = log; }
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out2, "vhp-samples.json"), "utf8")).samples.map((x) => x.height), [2, 1500]);
  // The two nodes disagree: no new sample, the old ones kept.
  const out3 = tmp(); console.log = () => {};
  try { r = await R.sample({ p: fakeNode(), check: fakeNode(), prev, out: out3, vhpOf, vhpCheckOf: async (w) => Object.fromEntries(w.map((a) => [a, sat(1)])), spreadMs: 0, clock: () => T }); } finally { console.log = log; }
  assert.ok(r.problems.some((x) => /disagree/.test(x)));
  const s3 = JSON.parse(fs.readFileSync(path.join(out3, "vhp-samples.json"), "utf8")).samples;
  assert.deepEqual(s3.map((x) => x.height), [2, 1500], "still sampled (audit BX-37)");
  assert.equal(s3[1].vhp[A], sat(1), "capped at the top both nodes agree on (1)");
  // The publish job's shape check passes the sampler's file and refuses anything else.
  const yml = fs.readFileSync(path.resolve(APP, ".github/workflows/race-samples.yml"), "utf8");
  const py = yml.match(/<<'PY'\n([\s\S]*?)\n\s*PY\n/)[1].split("\n").map((l) => l.replace(/^ {10}/, "")).join("\n");
  const ok = (f) => { try { execFileSync("python3", ["-c", py, f], { stdio: "pipe" }); return true; } catch { return false; } };
  // (The check compares with the real clock, so shift the test's samples to now.)
  const real = JSON.parse(fs.readFileSync(path.join(out2, "vhp-samples.json"), "utf8")), shift = Date.now() - T;
  real.samples = real.samples.map((x) => ({ ...x, at: x.at + shift }));
  const realF = path.join(tmp(), "vhp-samples.json"); fs.writeFileSync(realF, JSON.stringify(real));
  assert.ok(ok(realF));
  const bad = path.join(tmp(), "vhp-samples.json");
  fs.writeFileSync(bad, JSON.stringify({ v: 1, updated: "2026-11-02T06:00:00.000Z", samples: [{ at: T, height: 1, vhp: { "<img>": "1" } }] }));
  assert.equal(ok(bad), false);
});

test("the race and Block X cards read effective VHP; the 'holds 1 VHP' ranking rule still reads the plain balance", () => {
  const race = fs.readFileSync(path.resolve(APP, "bot/race.ts"), "utf8"), bx = fs.readFileSync(path.resolve(APP, "bot/games/blockx.ts"), "utf8");
  assert.match(race, /readVhp\(p, MAINNET_VHP, who, \{ effective: true \}\)/);
  assert.match(race, /const vhp = await rawRead\(todo\)/);
  assert.match(bx, /readVhp\(o\.p, VHP, sg\.signers, \{ effective: true \}\)/);
  const abi = fs.readFileSync(path.resolve(APP, "bot/token-abi.ts"), "utf8");
  assert.match(abi, /effective_balance_of: \{ entry_point: 0x629f31e6/);
  const wf = fs.readFileSync(path.resolve(APP, ".github/workflows/race.yml"), "utf8");
  assert.match(wf, /race-samples/, "the hourly race takes the samples");
});

test("audit BX-37 / BX-55 (round 3): combineReads takes the lower read of a producer the nodes disagree on, and names it", () => {
  const a = { [A]: sat(400), [B]: sat(100), [C]: sat(50) }, b = { [A]: sat(400), [B]: sat(200), [C]: sat(5000) };
  const { values, differ } = R.combineReads(a, b, [A, B, C]);
  assert.deepEqual(differ.sort(), [B, C].sort());
  assert.equal(values[B], sat(100), "the lower read (the card flags B; Block X holds a target B signs)");
  assert.equal(values[C], sat(50), "one node can't lift C to the top");
  assert.equal(R.combineReads(a, { ...a, [A]: String(BigInt(sat(400)) + 1n) }, [A]).values[A], String(BigInt(sat(400)) + 1n), "within 0.5%: the higher");
  assert.equal(R.combineReads(a, null, [A]).values[A], sat(400));
});

test("audit BX-43: the production floor raises several producers together to a fair share", () => {
  // Four producers with equal VHP; A and B each really signed 40% (two others offline-ish at 10%).
  const vhp = { [A]: BigInt(sat(100)), [B]: BigInt(sat(100)), [C]: BigInt(sat(100)), ["1" + "D".repeat(33)]: BigInt(sat(100)) };
  const counts = new Map([[A, 2880], [B, 2880], [C, 720], ["1" + "D".repeat(33), 720]]);
  const { vhp: out, raised } = R.productionFloor(vhp, counts, 7200);
  assert.deepEqual(raised.sort(), [A, B].sort());
  const T = Object.values(out).reduce((x, y) => x + y, 0n);
  for (const a of [A, B]) { const sh = Number(out[a]) / Number(T); assert.ok(sh > 0.37 && sh < 0.41, `${a}: ${sh}`); }
  assert.equal(out[A], out[B], "raised together, equally");
});

test("audit BX-38 / BX-45: future samples are dropped and refused; only the last hour's producers are sampled; supply caps a sample", async () => {
  const prev = tmp();
  fs.writeFileSync(path.join(prev, "vhp-samples.json"), JSON.stringify({ v: 1, updated: "x", samples: [{ at: T - H, height: 2, vhp: { [A]: "2", [C]: "5" } }, { at: T + 99 * H, height: 9, vhp: { [A]: "9" } }] }));
  const out = tmp(), log = console.log; console.log = () => {};
  try { await R.sample({ p: fakeNode(), check: fakeNode(), prev, out, vhpOf: async (w) => Object.fromEntries(w.map((a) => [a, sat(1)])), spreadMs: 0, clock: () => T }); } finally { console.log = log; }
  const f = JSON.parse(fs.readFileSync(path.join(out, "vhp-samples.json"), "utf8"));
  assert.deepEqual(f.samples.map((x) => x.height), [2, 1500], "the far-future sample is gone; a new one is added after it");
  assert.deepEqual(Object.keys(f.samples[1].vhp).sort(), [A, B].sort(), "C produced nothing in the last hour: not sampled");
  // A primary node whose head is an hour in the future: no sample.
  const fut = fakeNode(); fut.getHeadInfo = async () => ({ head_topology: { height: "1500", id: "0xh" }, head_block_time: String(T + H), last_irreversible_block: "1440" });
  const out2 = tmp(); let r; console.log = () => {};
  try { r = await R.sample({ p: fut, check: fakeNode(), prev, out: out2, vhpOf: async (w) => Object.fromEntries(w.map((a) => [a, sat(1)])), spreadMs: 0, clock: () => T }); } finally { console.log = log; }
  assert.ok(r.problems.some((x) => /in the future/.test(x)));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out2, "vhp-samples.json"), "utf8")).samples.map((x) => x.height), [2]);
  // windowHigh never takes a sample above the total supply.
  assert.equal(R.windowHigh({ [A]: sat(10) }, [{ at: T - H, height: 1, vhp: { [A]: sat(10 ** 9) } }], T, BigInt(sat(1000)))[A], BigInt(sat(1000)));
  // The publish check refuses a file that drops a recent published sample, and one dated far in the future.
  const yml = fs.readFileSync(path.resolve(APP, ".github/workflows/race-samples.yml"), "utf8");
  const py = yml.match(/<<'PY'\n([\s\S]*?)\n\s*PY\n/)[1].split("\n").map((l) => l.replace(/^ {10}/, "")).join("\n");
  const now = Date.now(), d = tmp();
  const pub = path.join(d, "pub.json"), fresh = path.join(d, "vhp-samples.json");
  const smp = (at, h) => ({ at, height: h, vhp: { [A]: "1" } });
  fs.writeFileSync(pub, JSON.stringify({ v: 1, updated: "2026-11-02T06:00:00.000Z", samples: [smp(now - H, 1), smp(now - 600000, 2)] }));
  const ok = (samples) => { fs.writeFileSync(fresh, JSON.stringify({ v: 1, updated: "2026-11-02T06:00:00.000Z", samples })); try { execFileSync("python3", ["-c", py, fresh, pub], { stdio: "pipe" }); return true; } catch { return false; } };
  assert.ok(ok([smp(now - H, 1), smp(now - 600000, 2), smp(now - 1000, 3)]));
  assert.equal(ok([smp(now - 600000, 2), smp(now - 1000, 3)]), false, "drops a published sample of the last 8 hours");
  assert.equal(ok([smp(now - H, 1), smp(now - 600000, 2), smp(now + 99 * H, 3)]), false, "a sample from the future");
});

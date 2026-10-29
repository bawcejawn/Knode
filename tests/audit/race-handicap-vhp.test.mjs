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

test("sampler: waits a random moment, reads effective VHP on both nodes, keeps 8 hours; a disagreement skips it", async () => {
  const out = tmp(), waits = [];
  const vhpOf = async (w) => Object.fromEntries(w.map((a) => [a, a === A ? sat(400) : sat(200)]));
  const log = console.log; console.log = () => {};
  let r;
  try { r = await R.sample({ p: fakeNode(), check: fakeNode(), prev: "", out, vhpOf, spreadMs: 480000, wait: async (ms) => { waits.push(ms); } }); } finally { console.log = log; }
  assert.equal(waits.length, 1); assert.ok(waits[0] >= 0 && waits[0] < 480000, "a random wait under 8 minutes");
  const f = JSON.parse(fs.readFileSync(path.join(out, "vhp-samples.json"), "utf8"));
  assert.equal(f.samples.length, 1); assert.equal(f.samples[0].vhp[A], sat(400)); assert.equal(f.samples[0].height, 1500);
  // An old sample is dropped after 8 hours; the next one is appended.
  const prev = tmp();
  fs.writeFileSync(path.join(prev, "vhp-samples.json"), JSON.stringify({ v: 1, updated: "x", samples: [{ at: T - 9 * H, height: 1, vhp: { [A]: "1" } }, { at: T - H, height: 2, vhp: { [A]: "2" } }] }));
  const out2 = tmp(); console.log = () => {};
  try { await R.sample({ p: fakeNode(), check: fakeNode(), prev, out: out2, vhpOf, spreadMs: 0 }); } finally { console.log = log; }
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out2, "vhp-samples.json"), "utf8")).samples.map((x) => x.height), [2, 1500]);
  // The two nodes disagree: no new sample, the old ones kept.
  const out3 = tmp(); console.log = () => {};
  try { r = await R.sample({ p: fakeNode(), check: fakeNode(), prev, out: out3, vhpOf, vhpCheckOf: async (w) => Object.fromEntries(w.map((a) => [a, sat(1)])), spreadMs: 0 }); } finally { console.log = log; }
  assert.ok(r.problems.some((x) => /disagree/.test(x)));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out3, "vhp-samples.json"), "utf8")).samples.map((x) => x.height), [2]);
  // The publish job's shape check passes the sampler's file and refuses anything else.
  const yml = fs.readFileSync(path.resolve(APP, ".github/workflows/race-samples.yml"), "utf8");
  const py = yml.match(/<<'PY'\n([\s\S]*?)\n\s*PY\n/)[1].split("\n").map((l) => l.replace(/^ {10}/, "")).join("\n");
  const ok = (f) => { try { execFileSync("python3", ["-c", py, f], { stdio: "pipe" }); return true; } catch { return false; } };
  assert.ok(ok(path.join(out2, "vhp-samples.json")));
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

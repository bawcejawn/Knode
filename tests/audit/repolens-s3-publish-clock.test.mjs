// V-M-1 (not run here (static review)). Drives the REAL publish step of .github/workflows/games.yml (extracted as the
// owner's tests/audit/survivor-publish-shell.test.mjs does) on files made by the REAL recorder (bot/games/survivor.ts
// run, fake chain). The job's clock is pinned with CHECK_NOW_MS (the variable the Block X check already honours) to a
// time BEFORE the season's days and weeks happened. A season file with days dated after the job's clock, a stake
// reading marked final before its week ended by that clock, and vault files for weeks not yet over must not publish.
// Fails today: the Survivor Python has no clock at all, so everything is pushed (exit 0).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const APP = process.env.APP || ".";
const { run } = await import(path.resolve(APP, "bot/games/survivor.ts"));
const S = globalThis.KSurvivor;
const A = (c) => "1" + c.repeat(33);
const PRODS = ["A", "B", "C", "D", "E"].map(A);
const FIRST = S.dayIndex(Date.parse("2026-11-16T00:00:00Z"));
const T0 = S.dayStart(FIRST - 10), T = (h) => T0 + h * 3000, H = (t) => Math.ceil((t - T0) / 3000);
const z = (d) => PRODS[d % 5];
const blocksOf = async (node, a, b) => { const ts = [], signers = []; for (let h = a; h <= b; h++) { const d = S.dayIndex(T(h)), o = PRODS.filter((p) => p !== z(d)); ts.push(T(h)); signers.push(o[h % 4]); } return { ts, signers }; };
const picksOf = async (node, d) => [A("J"), A("K"), A("L")].map((p, i) => ({ player: p, producer: PRODS[(d + i + 1) % 5], time: S.lockTime(d) - 3600000 }));
const headAt = (t) => { const height = H(t), lib = height - 20; return { height, time: T(height), lib, libTime: T(lib) }; };
const GAME3 = { id: 3, kind: 1, list_size: 1, lock_mode: 2, round_size: String(S.DAY), round_offset: "0", lead: String(S.LEAD_MS), ahead: String(S.AHEAD_MS), max_picks_per_day: 20, max_changes: 5, enabled: true };

function script() {
  const yml = fs.readFileSync(path.join(APP, ".github/workflows/games.yml"), "utf8");
  const i = yml.indexOf("      - name: Push games-data (and nothing else)");
  const body = yml.slice(yml.indexOf("run: |", i) + 7).split("\n");
  const out = [];
  for (const l of body) { if (l.trim() && !l.startsWith("          ")) break; out.push(l.slice(10)); }
  return out.join("\n").replace(/\/usr\/bin\/python3/g, "python3").replace(/^remote=.*$/m, 'remote="$REMOTE"');
}
async function recorded() {
  let prev = "", out;
  const times = [S.dayStart(FIRST - 1) + 3600000];
  for (let n = 1; n <= 8; n++) times.push(S.dayStart(FIRST + n) + 3600000);
  for (const t of times) {
    out = fs.mkdtempSync(path.join(os.tmpdir(), "vm1-"));
    const log = console.log; console.log = () => {};
    try { await run({ p: "main", check: "check", prev, out, firstDay: FIRST, picksContract: A("P"), blocksOf, timeOf: async (n, h) => T(h), picksOf, rankedOf: async (n, who) => new Set(who), gameOf: async () => GAME3, stakedOf: async () => null, vaultOf: async () => null, head: headAt(t) }); }
    finally { console.log = log; }
    prev = out;
  }
  return out;
}

test("V-M-1: the Survivor publish check judges days, stake readings and vault files against the job's clock", async (t) => {
  try { execFileSync("python3", ["--version"]); } catch { t.skip("python3 missing"); return; }
  const out = await recorded();
  assert.ok(fs.existsSync(path.join(out, "vault", "W4.json")), "week 4's vault file (week of 16 Nov 2026)");
  const IN = fs.mkdtempSync(path.join(os.tmpdir(), "vm1in-"));
  fs.cpSync(out, path.join(IN, "survivor"), { recursive: true });
  const REMOTE = fs.mkdtempSync(path.join(os.tmpdir(), "vm1r-"));
  execFileSync("git", ["init", "-q", "--bare", REMOTE]);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "vm1job-"));
  // The job runs on 18 Nov 2026 12:00 UTC: week 4 (16-22 Nov) isn't over, days 4-8 of season 1 haven't happened.
  const now = Date.parse("2026-11-18T12:00:00Z");
  const r = spawnSync("bash", ["-c", script()], { cwd, env: { ...process.env, IN, REMOTE, GH_TOKEN: "x", GITHUB_REPOSITORY: "o/r", GIT_CONFIG_GLOBAL: "/dev/null", CHECK_NOW_MS: String(now) }, encoding: "utf8" });
  const pushed = spawnSync("git", ["--git-dir", REMOTE, "ls-tree", "-r", "--name-only", "games-data"], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);
  assert.ok(!pushed.includes("survivor/vault/W4.json"), "a vault file for a week that isn't over by the job's clock is not published: " + r.stdout + r.stderr);
  assert.ok(!pushed.includes("survivor/S001.json"), "a season file with days after the job's clock is not published");
  assert.notEqual(r.status, 0, "and the run alerts");
});

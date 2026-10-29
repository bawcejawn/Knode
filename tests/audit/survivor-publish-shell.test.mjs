// The publish job's shell around the Survivor check (.github/workflows/games.yml), run for real up to the push
// (Repo Lense S2-20): unexpected files stop the job; a Survivor file over 2 MB, a season file that fails, or a vault
// file that can't be checked is left out on its own and the run fails at the end (failed=1); good files stay.
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
  for (const l of body) { if (l.startsWith("          remote=")) break; out.push(l.startsWith("          ") ? l.slice(10) : l); }
  return out.join("\n").replace(/\/usr\/bin\/python3/g, "python3") + '\necho "FAILED=$failed"\n';
}
async function recorded() {
  let prev = "", out;
  const times = [S.dayStart(FIRST - 1) + 3600000, S.dayStart(FIRST - 1) + 3660000, S.dayStart(FIRST - 1) + 3720000];
  for (let n = 1; n <= 8; n++) times.push(S.dayStart(FIRST + n) + 3600000);
  for (const t of times) {
    out = fs.mkdtempSync(path.join(os.tmpdir(), "pub-"));
    const log = console.log; console.log = () => {};
    try { await run({ p: "main", check: "check", prev, out, firstDay: FIRST, picksContract: A("P"), blocksOf, timeOf: async (n, h) => T(h), picksOf, rankedOf: async (n, who) => new Set(who), gameOf: async () => GAME3, stakedOf: async () => null, vaultOf: async () => null, head: headAt(t) }); }
    finally { console.log = log; }
    prev = out;
  }
  return out;
}
function publish(survivorDir, edit = () => {}) {
  const IN = fs.mkdtempSync(path.join(os.tmpdir(), "in-"));
  fs.cpSync(survivorDir, path.join(IN, "survivor"), { recursive: true });
  edit(IN);
  const r = spawnSync("bash", ["-c", script()], { env: { ...process.env, IN }, encoding: "utf8" });
  const files = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { recursive: true }).map(String).sort() : []);
  return { code: r.status, out: r.stdout + r.stderr, failed: /FAILED=1/.test(r.stdout), files: files(path.join(IN, "survivor")) };
}

test("the publish shell: good files pass; bad ones are left out one by one, and the run fails", async (t) => {
  try { execFileSync("python3", ["--version"]); execFileSync("bash", ["--version"]); } catch { t.skip("python3 or bash missing"); return; }
  const out = await recorded();
  assert.ok(fs.existsSync(path.join(out, "vault", "W4.json")), "week 1's vault file");
  const ok = publish(out);
  assert.equal(ok.code, 0, ok.out); assert.equal(ok.failed, false, ok.out);
  assert.ok(ok.files.includes("S001.json") && ok.files.includes(path.join("vault", "W4.json")));
  // A Survivor file over 2 MB: only that file goes; its vault file can't be checked and goes too.
  const big = publish(out, (IN) => fs.appendFileSync(path.join(IN, "survivor", "S001.json"), " ".repeat(2.2 * 1024 * 1024)));
  assert.equal(big.code, 0, big.out); assert.equal(big.failed, true);
  assert.ok(!big.files.includes("S001.json") && !big.files.includes(path.join("vault", "W4.json")) && big.files.includes("days.json"));
  // A season file that fails its check: the same.
  const bad = publish(out, (IN) => { const f = path.join(IN, "survivor", "S001.json"), j = JSON.parse(fs.readFileSync(f, "utf8")); j.result.players[0].lives = 7; fs.writeFileSync(f, JSON.stringify(j)); });
  assert.equal(bad.code, 0, bad.out); assert.equal(bad.failed, true);
  assert.ok(!bad.files.includes("S001.json") && bad.files.includes("index.json"));
  // A broken days.json: the whole Survivor folder is left out, the run fails.
  const days = publish(out, (IN) => fs.writeFileSync(path.join(IN, "survivor", "days.json"), "{}"));
  assert.equal(days.code, 0); assert.equal(days.failed, true); assert.deepEqual(days.files, []);
  // An unexpected file anywhere stops the job.
  const odd = publish(out, (IN) => fs.writeFileSync(path.join(IN, "survivor", "notes.txt"), "x"));
  assert.notEqual(odd.code, 0); assert.match(odd.out, /Refusing to publish unexpected files/);
  const neg = publish(out, (IN) => fs.writeFileSync(path.join(IN, "survivor", "vault", "W-1.json"), "{}"));
  assert.notEqual(neg.code, 0, "a negative week's file is refused by name");
});

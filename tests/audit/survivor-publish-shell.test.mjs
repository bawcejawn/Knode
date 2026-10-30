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
// The publish check judges files by the job's clock (Repo Lense S3-1): the fixtures' seasons are in Nov-Dec 2026.
process.env.CHECK_NOW_MS ??= String(Date.parse("2027-06-01T00:00:00Z"));
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

/** The whole publish step, with the push going to a local bare repository instead of GitHub. */
function script() {
  const yml = fs.readFileSync(path.join(APP, ".github/workflows/games.yml"), "utf8");
  const i = yml.indexOf("      - name: Push games-data (and nothing else)");
  const body = yml.slice(yml.indexOf("run: |", i) + 7).split("\n");
  const out = [];
  for (const l of body) { if (l.trim() && !l.startsWith("          ")) break; out.push(l.slice(10)); }
  const sh = out.join("\n").replace(/\/usr\/bin\/python3/g, "python3").replace(/^remote=.*$/m, 'remote="$REMOTE"');
  assert.match(sh, /remote="\$REMOTE"/);
  // Report `failed` on the way out, whatever the exit path.
  return sh.replace(/^set -euo pipefail$/m, 'set -euo pipefail\ntrap \'echo "FAILED=${failed:-0}"\' EXIT');
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
    // As on GitHub: the vault files already published stay on games-data (and come back as PREV/vault next run).
    if (prev && fs.existsSync(path.join(prev, "vault"))) for (const f of fs.readdirSync(path.join(prev, "vault"))) {
      fs.mkdirSync(path.join(out, "vault"), { recursive: true });
      if (!fs.existsSync(path.join(out, "vault", f))) fs.copyFileSync(path.join(prev, "vault", f), path.join(out, "vault", f));
    }
    prev = out;
  }
  return out;
}
function publish(survivorDir, edit = () => {}, remote = null) {
  const IN = fs.mkdtempSync(path.join(os.tmpdir(), "in-"));
  fs.cpSync(survivorDir, path.join(IN, "survivor"), { recursive: true });
  edit(IN);
  const REMOTE = remote ?? fs.mkdtempSync(path.join(os.tmpdir(), "remote-"));
  if (!remote) execFileSync("git", ["init", "-q", "--bare", REMOTE]);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "job-"));
  const r = spawnSync("bash", ["-c", script()], { cwd, env: { ...process.env, IN, REMOTE, GH_TOKEN: "x", GITHUB_REPOSITORY: "o/r", GIT_CONFIG_GLOBAL: "/dev/null" }, encoding: "utf8" });
  const pushed = spawnSync("git", ["--git-dir", REMOTE, "ls-tree", "-r", "--name-only", "games-data"], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);
  const files = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { recursive: true }).map(String).sort() : []);
  return { code: r.status, out: r.stdout + r.stderr, failed: /FAILED=1/.test(r.stdout), files: files(path.join(IN, "survivor")), pushed, REMOTE };
}

test("the publish shell: good files pass; bad ones are left out one by one, and the run fails", async (t) => {
  try { execFileSync("python3", ["--version"]); execFileSync("bash", ["--version"]); } catch { t.skip("python3 or bash missing"); return; }
  const out = await recorded();
  assert.ok(fs.existsSync(path.join(out, "vault", "W4.json")), "week 1's vault file");
  const ok = publish(out);
  assert.equal(ok.code, 0, ok.out); assert.equal(ok.failed, false, ok.out);
  assert.ok(ok.pushed.includes("survivor/S001.json") && ok.pushed.includes("survivor/vault/W4.json"), "pushed: " + ok.pushed.join(", "));
  assert.ok(ok.files.includes("S001.json") && ok.files.includes(path.join("vault", "W4.json")));
  // A Survivor file over 2 MB: only that file goes; its vault file can't be checked and goes too.
  const big = publish(out, (IN) => fs.appendFileSync(path.join(IN, "survivor", "S001.json"), " ".repeat(2.2 * 1024 * 1024)));
  assert.equal(big.code, 1, big.out); assert.equal(big.failed, true);
  assert.ok(big.pushed.includes("survivor/days.json") && !big.pushed.includes("survivor/S001.json"), "the rest is still pushed");
  assert.ok(!big.files.includes("S001.json") && !big.files.includes(path.join("vault", "W4.json")) && big.files.includes("days.json"));
  // A season file that fails its check: the same.
  const bad = publish(out, (IN) => { const f = path.join(IN, "survivor", "S001.json"), j = JSON.parse(fs.readFileSync(f, "utf8")); j.result.players[0].lives = 7; fs.writeFileSync(f, JSON.stringify(j)); });
  assert.equal(bad.code, 1, bad.out); assert.equal(bad.failed, true);
  assert.ok(!bad.files.includes("S001.json") && bad.files.includes("index.json"));
  // A broken days.json: the whole Survivor folder is left out, the run fails.
  const days = publish(out, (IN) => fs.writeFileSync(path.join(IN, "survivor", "days.json"), "{}"));
  assert.equal(days.code, 1); assert.equal(days.failed, true); assert.deepEqual(days.files, []);
  // An unexpected file anywhere stops the job.
  const odd = publish(out, (IN) => fs.writeFileSync(path.join(IN, "survivor", "notes.txt"), "x"));
  assert.notEqual(odd.code, 0); assert.match(odd.out, /Refusing to publish unexpected files/);
  const neg = publish(out, (IN) => fs.writeFileSync(path.join(IN, "survivor", "vault", "W-1.json"), "{}"));
  assert.notEqual(neg.code, 0, "a negative week's file is refused by name");
});

test("the publish shell on an existing branch: a changed vault file is held, the season list only grows (Repo Lense S3-25, S3-8)", async (t) => {
  try { execFileSync("python3", ["--version"]); execFileSync("bash", ["--version"]); } catch { t.skip("python3 or bash missing"); return; }
  const out = await recorded();
  const first = publish(out);
  assert.equal(first.code, 0, first.out);
  // The same files again: nothing new, no alert.
  const again = publish(out, () => {}, first.REMOTE);
  assert.equal(again.code, 0, again.out); assert.match(again.out, /No changes/);
  // A different vault file for a published week: held, the run fails, the published one stays.
  const changed = publish(out, (IN) => { const f = path.join(IN, "survivor", "vault", "W4.json"), j = JSON.parse(fs.readFileSync(f, "utf8")); j.rows = []; fs.writeFileSync(f, JSON.stringify(j)); }, first.REMOTE);
  assert.notEqual(changed.code, 0); assert.match(changed.out, /differs from the published file/);
  // An index that drops a published season is held.
  const dropped = publish(out, (IN) => { const f = path.join(IN, "survivor", "index.json"), j = JSON.parse(fs.readFileSync(f, "utf8")); j.seasons = []; fs.writeFileSync(f, JSON.stringify(j)); }, first.REMOTE);
  assert.notEqual(dropped.code, 0); assert.match(dropped.out, /drops a published season/);
});

test("fix-check N1, N2, N5, N6: Survivor runs only after a good fetch; published vault files aren't checked again; the index's seasons are on the calendar; a launch can still move", async (t) => {
  const yml = fs.readFileSync(path.join(APP, ".github/workflows/games.yml"), "utf8");
  assert.match(yml, /- name: Take the last run's files and the race cards\n\s+id: prev/);
  assert.match(yml, /- name: Record Survivor\n\s+id: survivor\n(?:\s+#.*\n)*\s+if: \$\{\{ !cancelled\(\) && steps\.prev\.outcome == 'success' \}\}/);
  try { execFileSync("python3", ["--version"]); execFileSync("bash", ["--version"]); } catch { t.skip("python3 or bash missing"); return; }
  const out = await recorded();
  const first = publish(out);
  assert.equal(first.code, 0, first.out);
  // A vault file published by hand (e.g. after a late reading the owner checked): later runs re-send it as published
  // and it isn't checked again, so no endless failure.
  const hand = publish(out, (IN) => { const f = path.join(IN, "survivor", "vault", "W4.json"); fs.writeFileSync(f, fs.readFileSync(f)); }, first.REMOTE);
  assert.equal(hand.code, 0, hand.out);
  // A season in the index that hasn't started by the job's clock is refused.
  const future = publish(out, (IN) => { const f = path.join(IN, "survivor", "index.json"), j = JSON.parse(fs.readFileSync(f, "utf8")); j.seasons.push(9999); fs.writeFileSync(f, JSON.stringify(j)); });
  assert.notEqual(future.code, 0); assert.match(future.out, /a season that hasn't started/);
  // Before any season is listed, Season 1's start may still move (a postponed launch).
  const r0 = fs.mkdtempSync(path.join(os.tmpdir(), "remote0-")); execFileSync("git", ["init", "-q", "--bare", r0]);
  const noSeasons = (fd) => (IN) => { for (const f of fs.readdirSync(path.join(IN, "survivor"))) if (/^S\d+\.json$/.test(f)) fs.rmSync(path.join(IN, "survivor", f)); fs.rmSync(path.join(IN, "survivor", "vault"), { recursive: true, force: true });
    const i = path.join(IN, "survivor", "index.json"), j = JSON.parse(fs.readFileSync(i, "utf8")); j.seasons = []; j.firstDay = fd; fs.writeFileSync(i, JSON.stringify(j)); };
  assert.equal(publish(out, noSeasons(FIRST), r0).code, 0);
  const moved = publish(out, noSeasons(FIRST + 7), r0);
  assert.equal(moved.code, 0, moved.out);
});

// F5-K-1 / F5-K-2 / F5-K-3 failing tests (node:test). NOT RUN HERE (static review).
// Runs the publish step of .github/workflows/games.yml (lines from "set -euo pipefail" to "Games files published.")
// against a local bare repository, with record-run outputs made by gen.py (same folder; needs bash, git and python3: run on Linux, WSL or GitHub Actions). Run: APP=<repo> node --test this file
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { spawnSync } from "node:child_process";
const APP = process.env.APP || process.cwd();
const HERE = path.dirname(fileURLToPath(import.meta.url)), GEN = path.join(HERE, "gen.py");
const A = "1" + "A".repeat(33), B = "1" + "B".repeat(33), F = "1" + "F".repeat(33), Z = "1" + "Z".repeat(33);
function publishScript() {
  const y = fs.readFileSync(path.join(APP, ".github/workflows/games.yml"), "utf8").split("\n");
  const s = y.findIndex((l) => l.includes("Push games-data (and nothing else)"));
  const a = y.findIndex((l, i) => i > s && l.trim() === "set -euo pipefail"), e = y.findIndex((l, i) => i > a && l.includes('echo "Games files published."'));
  return y.slice(a, e + 1).map((l) => l.slice(10)).join("\n")
    .replace(/^remote=.*$/m, 'remote="$REMOTE"').replace(/^git init -q work && cd work$/m, 'cd "$(mktemp -d)" && git init -q work && cd work')
    .replace("/usr/bin/python3 - ", "python3 -I - ");
}
function world() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "f5k-")), remote = path.join(d, "r.git");
  spawnSync("git", ["init", "-q", "--bare", remote]);
  const sh = path.join(d, "publish.sh"); fs.writeFileSync(sh, publishScript());
  let n = 0;
  const run = (spec) => {
    const inn = path.join(d, `in${n++}`);
    assert.equal(spawnSync("python3", ["-I", GEN, inn, JSON.stringify(spec)]).status, 0);
    return spawnSync("bash", [sh], { env: { ...process.env, IN: inn, REMOTE: remote, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" }, encoding: "utf8" });
  };
  const show = (f) => spawnSync("git", ["--git-dir", remote, "show", `games-data:blockx/${f}`], { encoding: "utf8" });
  return { run, show };
}
const honest = { lw: 1, players: [[A, 30, 1], [B, 20, 1], [F, 25, 0]], prizes: [[F, 1]] };

test("F5-K-1: a run's own board can't vouch for a vault file that differs from the published board", () => {
  const w = world();
  assert.equal(w.run({ ...honest, vault: null, P: true }).status, 0);          // the honest board is published
  w.run({ lw: 1, players: [[Z, 99, 1], ...honest.players], prizes: [[F, 1]], vault: "honest" });
  const v = w.show("vault/W1.json");
  assert.ok(v.status !== 0 || !v.stdout.includes(Z), "vault/W1.json must be checked against the PUBLISHED board (and its points recomputed), not the run's own");
});
test("F5-K-1: a vault file for a week that isn't the calendar's last week is refused", () => {
  const w = world();   // genesis 1792368000000 (2026-10-19): week 5 is 2026-11-23..30; valid whenever now - 1 week != 5
  w.run({ lw: 5, players: [[Z, 99, 0]], prizes: [[Z, 1]], vault: { rows: [], first: [Z], second: [] } });
  assert.notEqual(w.show("vault/W5.json").status, 0, "the publish job must tie the week to its own clock (now - 1 week), not to board.updated");
});
test("F5-K-2: a P file can't be planted before its week is final", () => {
  const w = world();
  w.run({ lw: 1, upd_h: 2, final: false, players: honest.players, prizes: [[Z, 1]], vault: null, P: true });
  assert.notEqual(w.show("P001.json").status, 0, "P<w>.json only with a final lastWeek (12 h after the week by the publish job's clock) whose prizes equal it");
});
test("F5-K-3: a bad published vault file doesn't stop the honest run publishing everything else", () => {
  const w = world();
  w.run({ ...honest, vault: { rows: [[B, 255]], first: [F], second: [] }, P: true });   // a bad run got in first
  const r = w.run({ ...honest, upd_h: 30, vault: "honest" });
  const b = JSON.parse(w.show("board.json").stdout);
  assert.equal(b.updated.slice(0, 13), "2026-11-03T06", `the honest board must still be published (exit ${r.status}): hold only the vault file and alert`);
});

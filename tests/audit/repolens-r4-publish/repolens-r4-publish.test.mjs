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
    return spawnSync("bash", [sh], { env: { ...process.env, IN: inn, REMOTE: remote, CHECK_NOW_MS: String(NOW), GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" }, encoding: "utf8" });
  };
  const show = (f) => spawnSync("git", ["--git-dir", remote, "show", `games-data:blockx/${f}`], { encoding: "utf8" });
  return { run, show };
}
// Audit BX-94 (round 5): a fixed clock, 20 hours after week 1 ends (final, and inside the vault's 3 days), so each
// test passes for its own reason and not a wall-clock "not yet".
const NOW = 1792368000000 + 2 * 7 * 86400000 + 20 * 3600000;
const honest = { lw: 1, players: [[A, 30, 1], [B, 20, 1], [F, 25, 0]], prizes: [[F, 1]] };

test("F5-K-1: a run's own board can't vouch for a vault file that differs from the published board", () => {
  const w = world();
  assert.equal(w.run({ ...honest, vault: null, P: true }).status, 0);          // the honest board is published
  // (Audit BX-94, round 6: the honest P file too, so the vault file is judged on its rows, not held as "not yet".)
  w.run({ ...honest, upd_h: 14, vault: null, P: true });
  assert.equal(w.show("P001.json").status, 0);
  const bad = w.run({ lw: 1, upd_h: 21, players: [[Z, 99, 1], ...honest.players], prizes: [[F, 1]], vault: "honest" });
  assert.match(bad.stdout, /rows aren't the published Staked board's players/);
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
  w.run({ ...honest, vault: null, P: true });
  w.run({ ...honest, upd_h: 14, vault: null, P: true });                             // board and P published
  // (Audit BX-94, round 6: the bad vault file is now judged on its rows: held with an alert, not as "not yet".)
  const badRun = w.run({ ...honest, upd_h: 20, vault: { rows: [[B, 200]], first: [F], second: [] } });   // a bad run
  assert.notEqual(badRun.status, 0); assert.match(badRun.stdout, /rows aren't the published Staked board's players|points don't follow/);
  const r = w.run({ ...honest, upd_h: 30, vault: "honest" });
  const b = JSON.parse(w.show("board.json").stdout);
  assert.equal(b.updated.slice(0, 13), "2026-11-03T06", `the honest board must still be published (exit ${r.status}): hold only the vault file and alert`);
});

// Audit BX-94 (round 5): the honest path under the fixed clock: the final board first, then P, then the vault file, all published.
test("BX-94: the honest board + P, then the honest vault file, are all published", () => {
  const w = world();
  assert.equal(w.run({ ...honest, vault: null, P: true }).status, 0);            // the board (its P waits: "not yet")
  assert.equal(w.run({ ...honest, upd_h: 14, vault: null, P: true }).status, 0);
  assert.equal(w.show("P001.json").status, 0, "the honest P file is published once the published board is final");
  const r = w.run({ ...honest, upd_h: 21, vault: "honest" });   // (the recorder never writes P again)
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const v = JSON.parse(w.show("vault/W1.json").stdout);
  assert.deepEqual(v.rows.map((x) => x.player), [A, B]);
  assert.deepEqual(v.first, [F]);
});

// Audit BX-65 (round 5): a vault file that leaves out Staked-board players is published (the job can't re-read stakes)
// but names them in an error that fails the job, so you are emailed (once: the file is written once).
test("BX-65: Staked players left out of the vault rows are named in an alert; the file is still published", () => {
  const w = world();
  w.run({ ...honest, vault: null, P: true });
  w.run({ ...honest, upd_h: 14, vault: null, P: true });
  const r = w.run({ ...honest, upd_h: 21, vault: { rows: [[A, 255]], first: [F], second: [] } });
  assert.equal(r.status, 1, "the job fails so you are emailed");
  assert.match(r.stdout, new RegExp(`::error::\\(published unless held below; check it\\) blockx/vault/W1\\.json: 1 of 2 Staked-board players.*${B}`));
  assert.equal(w.show("vault/W1.json").status, 0, "still published");
});

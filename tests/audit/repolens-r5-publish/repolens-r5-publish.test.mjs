// F6-K failing tests (node:test). NOT RUN HERE (static review). Needs bash, git, python3, node 22.
// Run: APP=<repo checkout> node --test f6k-publish.test.mjs
// Each test runs the workflow's own shell, cut from the YAML by markers, against local bare repositories.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const APP = process.env.APP || process.cwd();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (args, cwd) => spawnSync("git", args, { cwd, env: ENV, encoding: "utf8" });
/** The run: block of the step whose name line contains `name`, de-indented, with github.com URLs -> $REMOTE. */
function step(file, name) {
  const y = fs.readFileSync(path.join(APP, ".github/workflows", file), "utf8").split("\n");
  const s = y.findIndex((l) => l.includes(name)), r = y.findIndex((l, i) => i > s && l.trim() === "run: |");
  const ind = y[r + 1].match(/^ */)[0].length, out = [];
  for (let i = r + 1; i < y.length && (y[i].trim() === "" || y[i].match(/^ */)[0].length >= ind); i++) out.push(y[i].slice(ind));
  return out.join("\n").replace(/"https:\/\/github\.com\/\$\{GITHUB_REPOSITORY\}\.git"/g, '"$REMOTE"').replace(/^remote=.*$/m, 'remote="$REMOTE"');
}
function branchWith(files, branch) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "f6k-")), remote = path.join(d, "r.git"), seed = path.join(d, "seed");
  git(["init", "-q", "--bare", remote]); git(["init", "-q", seed]); git(["checkout", "-q", "-b", branch], seed);
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(seed, f)), { recursive: true }); fs.writeFileSync(path.join(seed, f), c); }
  git(["add", "."], seed); git(["commit", "-qm", "s"], seed); git(["push", "-q", remote, branch], seed);
  return { d, remote };
}

test("F6-K-1: the record job's 'Take the last run's files' step works when games-data has blockx/ but no blockx/vault/ yet", () => {
  const { d, remote } = branchWith({ "blockx/board.json": "{}\n", "blockx/W001.json": "{}\n" }, "games-data");
  const ck = path.join(d, "ck"), rt = path.join(d, "rt"); fs.mkdirSync(rt); git(["init", "-q", ck]);
  const sh = path.join(d, "prev.sh"); fs.writeFileSync(sh, step("games.yml", "Take the last run's files and the race cards"));
  const r = spawnSync("bash", [sh], { cwd: ck, env: { ...ENV, REMOTE: remote, RUNNER_TEMP: rt }, encoding: "utf8" });
  assert.equal(r.status, 0, `the step must not fail before the first vault file exists (it exits ${r.status}: the record job then fails every hour and nothing is ever published again)`);
  assert.ok(fs.existsSync(path.join(rt, "prev/blockx/board.json")));
});
test("F6-K-1 (testnet): same for testnet-data blockx-<id>/ without vault/", () => {
  const { d, remote } = branchWith({ "blockx-1/board.json": "{}\n" }, "testnet-data");
  const ck = path.join(d, "ck"), rt = path.join(d, "rt"); fs.mkdirSync(rt); git(["init", "-q", ck]);
  const sh = path.join(d, "prev.sh"); fs.writeFileSync(sh, step("games-testnet.yml", "Take the last run's files"));
  const r = spawnSync("bash", [sh], { cwd: ck, env: { ...ENV, REMOTE: remote, RUNNER_TEMP: rt }, encoding: "utf8" });
  assert.equal(r.status, 0, `exit ${r.status}`);
});
test("F6-K-3: the testnet publish step publishes a game folder that is not on testnet-data yet", () => {
  const { d, remote } = branchWith({ "blockx-1/index.json": "{}\n" }, "testnet-data");
  const inn = path.join(d, "in"); fs.mkdirSync(path.join(inn, "blockx-3"), { recursive: true });
  fs.writeFileSync(path.join(inn, "blockx-3/index.json"), JSON.stringify({ v: 1, updated: "2026-11-02T13:00:00.000Z", weeks: [1], contract: null, game: 3, prizesFromWeek: null }));
  const sh = path.join(d, "pub.sh"); fs.writeFileSync(sh, step("games-testnet.yml", "Push testnet-data (and nothing else)"));
  const w = fs.mkdtempSync(path.join(d, "w"));
  const r = spawnSync("bash", [sh], { cwd: w, env: { ...ENV, REMOTE: remote, IN: inn }, encoding: "utf8" });
  assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr}`);
  assert.equal(git(["--git-dir", remote, "show", "testnet-data:blockx-3/index.json"]).status, 0, "the new game's folder is published");
});

// BX-88 (F6-K-2, the W route) has no test here: our proof used a copied slice of the recorder, which a fix to
// bot/games/blockx.ts would not change. See README-repolens-r5-tests.md for the behaviour test to write against the real recorder.

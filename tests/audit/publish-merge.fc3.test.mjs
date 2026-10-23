// Audit fix check 3: the publish job's merge with main (204941a, AB-038). Runs the job's real shell script against a
// throwaway git repo with a local bare "remote" (no network, no token). Needs bash, git and node: skipped on Windows.
// FC3-PUB-1 (inverse): the merge is not three-way: in a day file that also changed on main, EVERY field of main's copy
//   wins, including fields only this run changed (a recorded correction), so the run's update is silently reverted.
// FC3-PUB-2 (legitimate use): an owner edit to one question of a day file keeps this run's new records for the others.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const APP = process.env.APP || ".";
const YML = fs.readFileSync(`${APP}/.github/workflows/bot.yml`, "utf8");
const linux = process.platform === "win32" ? (name, fn) => test.skip(name, fn) : test;

function publishScript() {
  const lines = YML.split("\n");
  const i = lines.findIndex((l) => /name:\s*Push game-data\//.test(l));
  assert.ok(i >= 0, "publish step not found in bot.yml");
  const r = lines.findIndex((l, j) => j > i && /^\s+run:\s*\|\s*$/.test(l));
  const indent = lines[r + 1].match(/^\s*/)[0].length;
  const out = [];
  for (let j = r + 1; j < lines.length; j++) { const l = lines[j]; if (l.trim() && l.match(/^\s*/)[0].length < indent) break; out.push(l.slice(indent)); }
  let s = out.join("\n");
  assert.match(s, /^remote=.*$/m, "remote= line not found (workflow changed: update this test)");
  return s.replace(/^remote=.*$/m, 'remote="$FAKE_REMOTE"').replace(/sleep \$\(\(attempt \* 5\)\)/g, "sleep 0");
}
const SCRIPT = publishScript();
const sh = (cwd, cmd, args, env = {}) => spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: 600_000, env: { ...process.env, ...env } });

function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pub-web2-"));
  const remote = path.join(root, "remote.git"), work = path.join(root, "work"), IN = path.join(root, "incoming");
  const env = { HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "owner", GIT_AUTHOR_EMAIL: "o@o", GIT_COMMITTER_NAME: "owner", GIT_COMMITTER_EMAIL: "o@o" };
  const g = (cwd, ...a) => { const x = sh(cwd, "git", a, env); assert.equal(x.status, 0, `git ${a.join(" ")}: ${x.stderr}`); return x.stdout; };
  g(root, "init", "-q", "--bare", remote);
  g(root, "--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main");
  fs.mkdirSync(work); g(work, "init", "-q"); g(work, "checkout", "-q", "-b", "main");
  const files = {
    "game-data/deployment.json": '{"contract":"1Game","rpc":"https://api.koinos.io"}\n',
    "game-data/game.json": '{"model":{"voidVhpSwing":0.1}}\n',
    "game-data/bot-state.json": '{"checkedUpTo":40}\n',
    "game-data/state.json": "{}\n",
    "game-data/index.json": '{"days":["questions/W000-D1.json"]}\n',
    "game-data/questions/W000-D1.json": '{"questions":[{"id":"W000-D1-1","chainId":39}]}\n',
    "site/index.html": "<h1>Knode</h1>\n",
  };
  for (const [p, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(work, p)), { recursive: true }); fs.writeFileSync(path.join(work, p), c); }
  g(work, "add", "-A"); g(work, "commit", "-qm", "init"); g(work, "push", "-q", remote, "main");
  fs.mkdirSync(IN);
  const sha = g(work, "rev-parse", "HEAD").trim();
  return { root, remote, work, IN, env, sha, g };
}
const publish = (r) => sh(r.work, "bash", ["-c", SCRIPT], { ...r.env, IN: r.IN, GH_TOKEN: "t", GITHUB_REPOSITORY: "o/r", GITHUB_REF_NAME: "main", GITHUB_SHA: r.sha, FAKE_REMOTE: r.remote });
const put = (r, rel, c) => { const f = path.join(r.IN, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, c); };
const tree = (r) => sh(r.root, "git", ["--git-dir", r.remote, "ls-tree", "-r", "--name-only", "main"], r.env).stdout.trim().split("\n");
const show = (r, f) => sh(r.root, "git", ["--git-dir", r.remote, "show", `main:${f}`], r.env).stdout;
/** Another clone pushes a change to main while the bot runs (as the owner, or as the bot's previous run). */
function pushFromOther(r, edits, who = "owner") {
  const other = path.join(r.root, "other-" + Math.random().toString(36).slice(2));
  const env = who === "bot" ? { ...r.env, GIT_AUTHOR_NAME: "kpred-bot", GIT_AUTHOR_EMAIL: "kpred-bot@users.noreply.github.com", GIT_COMMITTER_NAME: "kpred-bot", GIT_COMMITTER_EMAIL: "kpred-bot@users.noreply.github.com" } : r.env;
  const g = (cwd, ...a) => { const x = sh(cwd, "git", a, env); assert.equal(x.status, 0, `git ${a.join(" ")}: ${x.stderr}`); };
  g(r.root, "clone", "-q", r.remote, other);
  for (const [p, c] of Object.entries(edits)) fs.writeFileSync(path.join(other, p), c);
  g(other, "commit", "-qam", who === "bot" ? "bot: tick" : "owner edit"); g(other, "push", "-q", "origin", "main");
}

const day = (qs) => JSON.stringify({ date: "2026-10-20", week: 0, day: 1, questions: qs }, null, 2) + "\n";
const Q1 = { id: "W000-D1-1", chainId: 39, chainOutcome: 3, result: { void: false, option: 2 } };
const Q2 = { id: "W000-D1-2", title: "Old title", chainId: 40 };

linux("FC3-PUB-1 a correction this run recorded is not reverted by an owner edit elsewhere in the same day file", () => {
  const r = repo();
  pushFromOther(r, { "game-data/questions/W000-D1.json": day([Q1, Q2]) });        // published state before the run
  r.sha = sh(r.root, "git", ["--git-dir", r.remote, "rev-parse", "main"], r.env).stdout.trim();
  // During the run the owner fixes question 2's title (e.g. restoring the published version, as the bot's email asks).
  pushFromOther(r, { "game-data/questions/W000-D1.json": day([Q1, { ...Q2, title: "Published title" }]) });
  // The run saw the owner correct question 1 on chain (3 → 2) and recorded it.
  const mine = { ...Q1, chainOutcome: 2, corrections: [{ from: 3, to: 2, at: "2026-10-22T10:07:00Z" }] };
  put(r, "questions/W000-D1.json", day([mine, Q2]));
  const x = publish(r);
  assert.equal(x.status, 0, x.stdout + x.stderr);
  const q1 = JSON.parse(show(r, "game-data/questions/W000-D1.json")).questions.find((q) => q.id === "W000-D1-1");
  assert.equal(q1.chainOutcome, 2,
    `FC3-PUB-1: main now says chainOutcome ${q1.chainOutcome} with corrections ${JSON.stringify(q1.corrections)}: ` +
    `main's unchanged copy of question 1 overrode the field only this run changed (the site shows the old result; the next run records the correction again)`);
  assert.equal(JSON.parse(show(r, "game-data/questions/W000-D1.json")).questions.find((q) => q.id === "W000-D1-2").title, "Published title", "the owner's edit was lost");
});

linux("FC3-PUB-2 an owner edit to one question keeps this run's new chain ids and results for the others", () => {
  const r = repo();
  const Q3 = { id: "W000-D1-3" };
  pushFromOther(r, { "game-data/questions/W000-D1.json": day([Q1, Q2, Q3]) });
  r.sha = sh(r.root, "git", ["--git-dir", r.remote, "rev-parse", "main"], r.env).stdout.trim();
  pushFromOther(r, { "game-data/questions/W000-D1.json": day([Q1, { ...Q2, title: "Published title" }, Q3]) });
  put(r, "questions/W000-D1.json", day([Q1, { ...Q2, result: { void: true } }, { ...Q3, chainId: 41 }]));
  const x = publish(r);
  assert.equal(x.status, 0, x.stdout + x.stderr);
  const qs = JSON.parse(show(r, "game-data/questions/W000-D1.json")).questions;
  assert.equal(qs.find((q) => q.id === "W000-D1-3").chainId, 41, "FC3-PUB-2: this run's chain id was dropped");
  assert.deepEqual(qs.find((q) => q.id === "W000-D1-2").result, { void: true }, "FC3-PUB-2: this run's result was dropped");
  assert.equal(qs.find((q) => q.id === "W000-D1-2").title, "Published title", "FC3-PUB-2: the owner's edit was lost");
});

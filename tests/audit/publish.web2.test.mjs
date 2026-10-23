// Red-team (web attacker, fix check 2) against the publish job of .github/workflows/bot.yml and the tick checkout.
// Runs the job's real shell script against a throwaway git repo with a local bare "remote" (no network, no token),
// like tests/audit/workflow.publish.test.ts. Needs bash, git, GNU find and node on PATH: skipped on Windows.
// Every case asserts the SAFE behaviour; a failing case is a proven problem.
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

// P1: owner edits game.json on main during a bot run; the bot's new question file must still be published.
linux("P1 an owner edit to game-data/game.json during the run does not block this run's question files", () => {
  const r = repo();
  pushFromOther(r, { "game-data/game.json": '{"model":{"voidVhpSwing":0.12}}\n' });
  put(r, "questions/W009-D1.json", '{"questions":[{"id":"W009-D1-1","chainId":41}]}');
  const x = publish(r);
  assert.equal(x.status, 0, `P1: publish refused after an owner edit to a non-bot game-data file:\n${x.stdout}\n${x.stderr}`);
  assert.ok(tree(r).includes("game-data/questions/W009-D1.json"), "P1: the posted question (chainId 41) never reached main");
  assert.match(show(r, "game-data/game.json"), /0\.12/, "P1: the owner's game.json edit was lost");
});

// P1b: same with deployment.json (edited on main at every upgrade: upgradedAt, wasmSha256).
linux("P1b an owner edit to game-data/deployment.json during the run does not block this run's question files", () => {
  const r = repo();
  pushFromOther(r, { "game-data/deployment.json": '{"contract":"1Game","rpc":"https://api.koinos.io","upgradedAt":"now"}\n' });
  put(r, "questions/W009-D1.json", '{"questions":[{"id":"W009-D1-1","chainId":41}]}');
  const x = publish(r);
  assert.equal(x.status, 0, `P1b: publish refused after the owner updated deployment.json:\n${x.stdout}\n${x.stderr}`);
  assert.ok(tree(r).includes("game-data/questions/W009-D1.json"), "P1b: the posted question never reached main");
});

// P2: run N+1 was triggered (GITHUB_SHA fixed) before run N published; run N+1's own records must not vanish silently.
linux("P2 a run started from a stale GITHUB_SHA does not silently drop its own on-chain records", () => {
  const r = repo();
  pushFromOther(r, { "game-data/bot-state.json": '{"checkedUpTo":41}\n', "game-data/questions/W000-D1.json": '{"questions":[{"id":"W000-D1-1","chainId":39},{"id":"W000-D1-2","chainId":40}]}\n' }, "bot");
  put(r, "bot-state.json", '{"checkedUpTo":42}');
  put(r, "questions/W000-D1.json", '{"questions":[{"id":"W000-D1-1","chainId":39},{"id":"W000-D1-3","chainId":41}]}');
  const x = publish(r);
  const kept = /"chainId":\s*41/.test(show(r, "game-data/questions/W000-D1.json"));
  assert.ok(x.status !== 0 || kept, `P2: publish exited 0 but threw away this run's record of on-chain question #41 (it becomes an orphan and is voided next run):\n${x.stdout}`);
});

// P3: the tick job must run on the latest main, not on the commit that was main when the (queued) run was triggered.
test("P3 the tick job starts from the latest main (not a stale github.sha queued behind a long run)", () => {
  const tick = YML.slice(YML.indexOf("\n  tick:"), YML.indexOf("\n  publish:"));
  const fresh = /\n\s+ref:\s*(refs\/heads\/)?main\b/.test(tick) || /ls-remote[^\n]*main[\s\S]*GITHUB_SHA|GITHUB_SHA[\s\S]*ls-remote[^\n]*main/.test(tick);
  assert.ok(fresh, "P3: tick checks out github.sha; with concurrency group kpred-bot a queued run starts from a commit without the previous run's published files");
});

// (guard) names allowed by the filter that look like options are copied as plain files and nothing else is staged.
linux("(guard) option-like question file names are published as plain files only", () => {
  const r = repo();
  for (const n of ["-n.json", "--all.json", "_.json"]) put(r, `questions/${n}`, "{}");
  const x = publish(r);
  assert.equal(x.status, 0, x.stderr);
  const t = tree(r);
  for (const n of ["-n.json", "--all.json", "_.json"]) assert.ok(t.includes(`game-data/questions/${n}`), n);
  assert.deepEqual(t.filter((p) => !p.startsWith("game-data/") && p !== "site/index.html"), []);
});

// (guard) a branch-dispatched run cannot hand the publish job an artifact from another run (download by name, this run only).
test("(guard) publish downloads only this run's artifact (no run-id / github-token inputs)", () => {
  const pub = YML.slice(YML.indexOf("\n  publish:"));
  assert.match(pub, /needs:\s*tick/);
  assert.doesNotMatch(pub, /run-id:|github-token:|repository:/);
});

// Red-team INSIDER (fix check 2, commit 1dbc129): the publish job's new "revert to main's copy" logic in
// .github/workflows/bot.yml. Runs the job's real shell script against a throwaway git repository with a local bare
// "remote" (harness copied from tests/audit/workflow.publish.test.ts; no network, no token). Asserts the SAFE
// behaviour (failing = proven problem). Needs bash, git, GNU find and node on PATH; skipped on Windows.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";


const YML = fs.readFileSync(".github/workflows/bot.yml", "utf8");
if (process.platform === "win32") test.skip("publish-job tests need a Linux shell (bash, GNU find)", () => {});
const linuxTest: typeof test = process.platform === "win32" ? ((() => {}) as any) : test;

/** The `run: |` block of the "Push game-data/" step, de-indented, with the remote URL pointed at a local repo. */
function publishScript(): string {
  const lines = YML.split("\n");
  const i = lines.findIndex((l) => /name:\s*Push game-data\//.test(l));
  assert.ok(i >= 0, "publish step not found in bot.yml");
  const r = lines.findIndex((l, j) => j > i && /^\s+run:\s*\|\s*$/.test(l));
  assert.ok(r > i, "publish run block not found");
  const indent = lines[r + 1].match(/^\s*/)![0].length;
  const out: string[] = [];
  for (let j = r + 1; j < lines.length; j++) {
    const l = lines[j];
    if (l.trim() && l.match(/^\s*/)![0].length < indent) break;
    out.push(l.slice(indent));
  }
  let s = out.join("\n");
  assert.match(s, /^remote=.*$/m, "remote= line not found (the workflow changed: update this test)");
  s = s.replace(/^remote=.*$/m, 'remote="$FAKE_REMOTE"').replace(/sleep \$\(\(attempt \* 5\)\)/g, "sleep 0");
  return s;
}
const SCRIPT = publishScript();

function sh(cwd: string, cmd: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: 600_000, env: { ...process.env, ...env } });
}

type Repo = { root: string; remote: string; work: string; IN: string; env: Record<string, string> };

function repo(): Repo {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pub-ins2-"));
  const remote = path.join(root, "remote.git"), work = path.join(root, "work"), IN = path.join(root, "incoming");
  const env = { HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  const g = (cwd: string, ...a: string[]) => { const x = sh(cwd, "git", a, env); assert.equal(x.status, 0, `git ${a.join(" ")}: ${x.stderr}`); return x.stdout; };
  g(root, "init", "-q", "--bare", remote);
  g(root, "--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main");
  fs.mkdirSync(work);
  g(work, "init", "-q");
  g(work, "checkout", "-q", "-b", "main");
  const files: Record<string, string> = {
    "game-data/deployment.json": '{"owner":"1Owner","operator":"1Op"}\n',
    "game-data/game.json": "{}\n",
    "game-data/bot-state.json": '{"notified":[]}\n',
    "game-data/state.json": '{}\n',
    "game-data/index.json": '{"days":[]}\n',
    "game-data/questions/W000-D1.json": '{"questions":[]}\n',
    "site/index.html": "<h1>Kpred</h1>\n",
    "desk-data/deployment.json": '{"owner":"1Owner"}\n',
    ".github/workflows/bot.yml": "name: Kpred bot\n",
    "bot/bot.ts": "// bot\n",
  };
  for (const [p, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(work, p)), { recursive: true }); fs.writeFileSync(path.join(work, p), c); }
  g(work, "add", "-A");
  g(work, "commit", "-qm", "init");
  g(work, "push", "-q", remote, "main");
  fs.mkdirSync(IN);
  return { root, remote, work, IN, env };
}
function publish(r: Repo) {
  return sh(r.work, "bash", ["-c", SCRIPT], { ...r.env, IN: r.IN, GH_TOKEN: "test-token", GITHUB_REPOSITORY: "owner/repo", GITHUB_REF_NAME: "main", FAKE_REMOTE: r.remote });
}
const head = (r: Repo) => sh(r.root, "git", ["--git-dir", r.remote, "rev-parse", "main"], r.env).stdout.trim();
const tree = (r: Repo) => sh(r.root, "git", ["--git-dir", r.remote, "ls-tree", "-r", "--name-only", "main"], r.env).stdout.trim().split("\n");
const put = (r: Repo, rel: string, content: string) => { const f = path.join(r.IN, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, content); };

/** The publish step as GitHub runs it: GITHUB_SHA is the commit the run was started for (the work clone's HEAD). */
function publishAt(r: Repo) {
  const sha = sh(r.work, "git", ["rev-parse", "HEAD"], r.env).stdout.trim();
  return sh(r.work, "bash", ["-c", SCRIPT], { ...r.env, IN: r.IN, GH_TOKEN: "test-token", GITHUB_REPOSITORY: "owner/repo", GITHUB_REF_NAME: "main", FAKE_REMOTE: r.remote, GITHUB_SHA: sha });
}
/** The owner, from another clone, changes main while the bot's run is in progress. */
function ownerCommit(r: Repo, change: (dir: string) => void) {
  const other = path.join(r.root, "owner-" + Math.random().toString(36).slice(2));
  const g = (cwd: string, ...a: string[]) => { const x = sh(cwd, "git", a, r.env); assert.equal(x.status, 0, `git ${a.join(" ")}: ${x.stderr}`); };
  g(r.root, "clone", "-q", r.remote, other);
  change(other);
  g(other, "add", "-A");
  g(other, "commit", "-qm", "owner edit");
  g(other, "push", "-q", "origin", "main");
}

linuxTest("INS2-W1 an owner commit to a non-bot game-data file during the run must not stop the bot's files being published", () => {
  const cases: Array<[string, (dir: string) => void]> = [
    // bot/README.md "Rotating the operator key" step 4, and the bot's own "add producerKey to deployment.json" email
    ["edit deployment.json", (d) => fs.writeFileSync(path.join(d, "game-data/deployment.json"), '{"owner":"1Owner","operator":"1NewOp","producerKey":"02ab"}\n')],
    ["delete game.json", (d) => fs.rmSync(path.join(d, "game-data/game.json"))],
  ];
  const bad: string[] = [];
  for (const [name, change] of cases) {
    const r = repo();
    ownerCommit(r, change);
    // This run posted today's questions: their file must reach main, or the next run voids them as orphans.
    put(r, "questions/W009-D1.json", '{"questions":[{"id":"W009-D1-1","chainId":42}]}');
    put(r, "bot-state.json", '{"notified":[],"checkedUpTo":43}');
    const x = publishAt(r);
    if (x.status !== 0 || !tree(r).includes("game-data/questions/W009-D1.json")) bad.push(`${name}: exit ${x.status} ${(x.stdout + x.stderr).trim().split("\n").slice(-2).join(" | ")}`);
  }
  assert.deepEqual(bad, [],
    "INS2-W1: the owner's commit to game-data/ (outside the bot's files) made the publish job fail, so this run's posted questions never reached main");
});

linuxTest("INS2-W2 the tick job must start from the branch head, not the commit the (possibly queued) run was created for", () => {
  const tickStart = YML.indexOf("\n  tick:"), pubStart = YML.indexOf("\n  publish:");
  const tick = YML.slice(tickStart, pubStart);
  const co = tick.slice(tick.indexOf("actions/checkout@"), tick.indexOf("actions/setup-node@"));
  // A run queued behind a running one (concurrency kpred-bot) or a manual "Run workflow" during a run keeps the old
  // GITHUB_SHA: it checks out game-data/ without the previous run's commit, does not see today's day file, generates
  // and posts the day's questions again, and its publish job then drops that file (changed on main) -> orphans.
  assert.match(co, /\bref:\s*\S+/,
    "INS2-W2: tick checks out GITHUB_SHA (actions/checkout default), so a queued run works from stale game-data/ and the publish job's 'changed on main' revert drops its new files");
});

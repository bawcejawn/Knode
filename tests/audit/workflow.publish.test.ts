// Proof test (audit fix check, AB-030) for the publish job of .github/workflows/bot.yml: it runs the job's real shell
// script against a throwaway git repository with a local bare "remote" (no network, no GitHub token). WF-6/WF-7: a huge
// file or a flood of files is refused; WF-9/WF-10: an owner's edit made on main during the run is kept, and a missing
// bot file does not stop the others. The other cases held before the fix.
// Needs bash, git, GNU find and node on PATH, so it is skipped on Windows (CI runs it on Linux).
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pub-ins-"));
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

linuxTest("WF-1 control: a normal artifact is published", () => {
  const r = repo();
  put(r, "questions/W009-D1.json", '{"questions":[]}');
  put(r, "bot-state.json", '{"notified":[]}');
  const before = head(r);
  const x = publish(r);
  assert.equal(x.status, 0, `publish failed: ${x.stdout}\n${x.stderr}`);
  assert.notEqual(head(r), before, "nothing was pushed");
  assert.ok(tree(r).includes("game-data/questions/W009-D1.json"));
});

linuxTest("WF-2 symlinks (file or directory) pointing at protected files are refused", () => {
  for (const kind of ["file", "dir"]) {
    const r = repo();
    if (kind === "file") {
      fs.mkdirSync(path.join(r.IN, "questions"));
      fs.symlinkSync(path.join(r.work, "game-data", "deployment.json"), path.join(r.IN, "questions", "W009-D1.json"));
    } else {
      fs.symlinkSync(path.join(r.work, "site"), path.join(r.IN, "questions"));
    }
    const before = head(r);
    const x = publish(r);
    assert.notEqual(x.status, 0, `WF-2 (${kind}): a symlinked artifact entry was not refused`);
    assert.equal(head(r), before, `WF-2 (${kind}): something was pushed`);
  }
});

linuxTest("WF-3 file names that try to escape game-data/ are refused and nothing is pushed", () => {
  const names = ["site/index.html", "desk-data/deployment.json", ".github/workflows/bot.yml", "game-data/deployment.json",
    "deployment.json", "game.json", "questions/sub/W009-D1.json", "questions/W009-D1.json.sh", "questions/W009 D1.json",
    "questions/..json", "bot/bot.ts", "index.html"];
  for (const n of names) {
    const r = repo();
    put(r, n, n.endsWith(".json") ? '{"owner":"1Thief"}' : "pwned\n");
    put(r, "questions/W009-D2.json", "{}");          // a legitimate file alongside must not carry the bad one through
    const before = head(r);
    publish(r);
    assert.equal(head(r), before, `WF-3: an artifact containing ${n} was (partly) published`);
  }
});

linuxTest("WF-4 a dot-named question file passes the name filter but is never copied", () => {
  const r = repo();
  put(r, "questions/.json", '{"x":1}');
  publish(r);
  assert.ok(!tree(r).some((p) => p.endsWith("/.json")), "WF-4: questions/.json was published");
});

linuxTest("WF-5 invalid JSON is refused", () => {
  const r = repo();
  put(r, "questions/W009-D1.json", "{ not json");
  const before = head(r);
  assert.notEqual(publish(r).status, 0);
  assert.equal(head(r), before);
});

linuxTest("WF-6 a huge file that parses as JSON must be refused", () => {
  const r = repo();
  put(r, "questions/W009-D1.json", '{"title":"' + "x".repeat(12 * 1024 * 1024) + '"}');   // real day files are ~9 KB
  const before = head(r);
  publish(r);
  assert.equal(head(r), before, "WF-6: a 12 MB JSON file from the tick job was pushed to main (no size cap in the publish job)");
});

linuxTest("WF-7 an artifact with 1,001 question files must be refused", { timeout: 600_000 }, () => {
  const r = repo();
  for (let i = 0; i < 1001; i++) put(r, `questions/X${String(i).padStart(4, "0")}.json`, "{}");
  const before = head(r);
  publish(r);
  assert.equal(head(r), before, "WF-7: 1,001 new files from the tick job were pushed in one run (no count cap)");
});

linuxTest("WF-8 job boundaries in bot.yml (text)", () => {
  const tickStart = YML.indexOf("\n  tick:"), pubStart = YML.indexOf("\n  publish:");
  assert.ok(tickStart > 0 && pubStart > tickStart, "jobs tick / publish not found");
  const tick = YML.slice(tickStart, pubStart), pub = YML.slice(pubStart);
  const on = YML.slice(YML.indexOf("\non:"), YML.indexOf("\nconcurrency:"));
  assert.doesNotMatch(on, /pull_request|workflow_run|issue_comment/, "the bot must not run on PR-controlled events");
  assert.match(tick, /contents:\s*read/);
  assert.doesNotMatch(tick, /:\s*write/, "the tick job must not hold any write permission");
  assert.match(tick, /persist-credentials:\s*false/);
  assert.match(tick, /npm ci[^\n]*--ignore-scripts/);
  const secrets = [...YML.matchAll(/secrets\.(\w+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(secrets)], ["OPERATOR_WIF"], "OPERATOR_WIF must be the only secret");
  assert.doesNotMatch(pub, /secrets\./, "the publish job must not see OPERATOR_WIF");
  assert.match(pub, /persist-credentials:\s*false/);
  assert.doesNotMatch(pub, /\b(npm|npx|yarn|pnpm|tsx)\b/, "the publish job must not run repository code");
  assert.doesNotMatch(pub, /uses:\s*\.\//, "the publish job must not use a local (repository) action");
  assert.doesNotMatch(pub, /actions\/cache/, "the publish job must not restore a cache the tick job can write");
  assert.equal((pub.match(/github\.token/g) ?? []).length, 1, "the write token must appear once (the push step)");
  assert.doesNotMatch(pub, /\b(source|bash|sh)\s+[^\n]*(game-data|\$IN)/, "the publish job must not execute artifact contents");
});

linuxTest("WF-9 a question file the owner changed on main during the run keeps the owner's version", () => {
  const r = repo();
  // While the bot ran, the owner fixed W000-D1.json on main (from another clone).
  const other = path.join(r.root, "other");
  const g = (cwd: string, ...a: string[]) => { const x = sh(cwd, "git", a, r.env); assert.equal(x.status, 0, `git ${a.join(" ")}: ${x.stderr}`); };
  g(r.root, "clone", "-q", r.remote, other);
  fs.writeFileSync(path.join(other, "game-data/questions/W000-D1.json"), '{"questions":[],"note":"owner"}\n');
  g(other, "commit", "-qam", "owner edit");
  g(other, "push", "-q", "origin", "main");
  put(r, "questions/W000-D1.json", '{"questions":[],"note":"bot"}');
  put(r, "questions/W000-D2.json", '{"questions":[]}');
  const x = publish(r);
  assert.equal(x.status, 0, `publish failed: ${x.stdout}\n${x.stderr}`);
  const show = (f: string) => sh(r.root, "git", ["--git-dir", r.remote, "show", `main:${f}`], r.env).stdout;
  assert.match(show("game-data/questions/W000-D1.json"), /"owner"/, "the owner's edit was overwritten");
  assert.ok(tree(r).includes("game-data/questions/W000-D2.json"), "the bot's other files are still published");
  assert.match(x.stdout, /changed on main during this run/);
});

linuxTest("WF-10 a missing bot file does not stop the others from being published", () => {
  const r = repo();
  // state.json is not in the repository (and not in the artifact): `git add` of a path that matches nothing fails.
  for (const a of [["rm", "-q", "game-data/state.json"], ["commit", "-qm", "no state.json"], ["push", "-q", r.remote, "main"]]) {
    const x = sh(r.work, "git", a, r.env); assert.equal(x.status, 0, `git ${a.join(" ")}: ${x.stderr}`);
  }
  put(r, "questions/W009-D1.json", '{"questions":[]}');
  const x = publish(r);
  assert.equal(x.status, 0, `publish failed: ${x.stdout}\n${x.stderr}`);
  assert.ok(tree(r).includes("game-data/questions/W009-D1.json"), "nothing was published because one path was missing");
});

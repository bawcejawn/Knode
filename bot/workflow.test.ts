/**
 * Locks the GitHub workflows: third-party actions stay pinned, the hourly bot keeps its job,
 * and pull requests run the contract tests without the operator key.
 */
import fs from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";

const WORKFLOWS = [
  ".github/workflows/bot.yml",
  ".github/workflows/test.yml",
  ".github/workflows/desk-test.yml",
  ".github/workflows/watch.yml",
  ".github/workflows/workflow-guard.yml",
  ".github/workflows/resolver-test.yml",
  ".github/workflows/status-test.yml",
];

/** The jobs of a workflow file, by name (the text of each job, from its name to the next job). */
function jobsOf(y: string): Record<string, string> {
  const body = y.slice(y.indexOf("\njobs:\n"));
  const out: Record<string, string> = {};
  const names = [...body.matchAll(/^  ([A-Za-z0-9_-]+):\s*$/gm)];
  names.forEach((m, i) => { out[m[1]] = body.slice(m.index!, i + 1 < names.length ? names[i + 1].index : undefined); });
  return out;
}

function useLines(file: string): string[] {
  return fs.readFileSync(file, "utf8").split("\n").map((l) => l.trim()).filter((l) => l.startsWith("- uses:") || l.startsWith("uses:"));
}

test("every third-party action is pinned to a full commit, with a version comment", () => {
  for (const file of WORKFLOWS) {
    // status-test.yml lands with the status pull request; it is not on main yet.
    if (file.endsWith("status-test.yml") && !fs.existsSync(file)) continue;
    assert.equal(fs.existsSync(file), true, file);
    const text = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(text, /actions:\s*write/, `${file} must not grant actions: write`);
    const lines = useLines(file);
    assert.ok(lines.length > 0, file);
    for (const line of lines) {
      assert.match(line, /@[0-9a-f]{40}/, `${file}: ${line}`);
      assert.match(line, /# v\d+\.\d+\.\d+/, `${file}: ${line}`);
      assert.doesNotMatch(line, /@v\d/, `${file}: ${line}`);
    }
  }
});

test("the hourly bot still resolves, posts, selects, checks and commits, and does not run on pull requests", () => {
  const y = fs.readFileSync(".github/workflows/bot.yml", "utf8");
  assert.match(y, /cron:\s*"7 \* \* \* \*"/);
  assert.match(y, /workflow_dispatch/);
  assert.doesNotMatch(y, /pull_request/);
  assert.match(y, /npm run bot -- tick/);
  assert.match(y, /OPERATOR_WIF:\s*\$\{\{\s*secrets\.OPERATOR_WIF\s*\}\}/);
  assert.match(y, /BOT_GIT_PUSH:\s*"1"/);
  assert.match(y, /GEN_DIR:\s*game-data/);
  assert.match(y, /contents:\s*write/);
  assert.doesNotMatch(y, /actions:\s*write/);
  assert.match(y, /path:\s*game-data\/blocks\.csv/);
  assert.match(y, /vars\.BOT_ENABLED == 'true'/);
  assert.match(y, /group:\s*kpred-bot/);
  assert.match(y, /cancel-in-progress:\s*false/);
  assert.match(y, /timeout-minutes:\s*180/);
  // The tick is what sorts, posts, selects, resolves and commits. That command must stay the job's run step.
  assert.equal(y.match(/npm run bot -- tick/g)?.length, 1);
});

test("contract tests and desk tests run on pull requests and cannot see secrets", () => {
  for (const file of [".github/workflows/test.yml", ".github/workflows/desk-test.yml"]) {
    const y = fs.readFileSync(file, "utf8");
    assert.match(y, /pull_request:/);
    assert.match(y, /contents:\s*read/);
    assert.doesNotMatch(y, /contents:\s*write/);
    assert.doesNotMatch(y, /secrets\./);
    assert.match(y, /npm test/);
    assert.match(y, /npm run check/);
  }
});

test("the bot job holds no write token, installs without scripts, and only a separate job pushes game-data/", () => {
  const y = fs.readFileSync(".github/workflows/bot.yml", "utf8");
  const tickJob = jobsOf(y).tick;
  const publishJob = y.slice(y.indexOf("\n  publish:"));
  // every checkout leaves no token behind in .git/config
  assert.equal(y.match(/uses: actions\/checkout@/g)?.length, y.match(/persist-credentials:\s*false/g)?.length);
  // the job that runs the bot (and its dependencies) can only read, and never sees a token
  assert.match(tickJob, /permissions:\s*\n\s*contents:\s*read/);
  assert.doesNotMatch(tickJob, /contents:\s*write|github\.token|GITHUB_TOKEN/);
  assert.match(tickJob, /npm ci --no-audit --no-fund --ignore-scripts/);
  assert.match(tickJob, /npm run bot -- tick/);
  // the publish job is the only one that can push; it runs no repository code and only takes game-data/ files
  assert.match(publishJob, /permissions:\s*\n\s*contents:\s*write/);
  assert.doesNotMatch(publishJob, /npm |npx |tsx|OPERATOR_WIF/);
  assert.match(publishJob, /Refusing to publish/);
  assert.match(publishJob, /\^game-data\/\(questions\/\[A-Za-z0-9_-\]\+\\.json\|bot-state\\.json\|state\\.json\|index\\.json\)\$/);
  assert.match(y, /^permissions:\s*\n\s*contents:\s*read/m);
});

test("no job that holds a secret restores a cache, and caches are only restored where no repository code runs after (audit H-1)", () => {
  for (const file of WORKFLOWS) {
    if (!fs.existsSync(file)) continue;
    for (const [name, job] of Object.entries(jobsOf(fs.readFileSync(file, "utf8")))) {
      const restores = /uses: actions\/cache(\/restore)?@/.test(job);
      if (/secrets\.|environment:/.test(job)) assert.equal(restores, false, `${file} job ${name} holds a secret and restores a cache`);
      if (restores) {
        // after the restore: no checkout, no npm/node/npx/tsx, no repository script
        const after = job.slice(job.search(/uses: actions\/cache(\/restore)?@/));
        assert.doesNotMatch(after, /actions\/checkout@|\bnpm |\bnpx |\btsx\b|\bnode (?!-e)|bash \.\/|\.\/[a-z]/, `${file} job ${name} runs code after restoring a cache`);
      }
    }
  }
});

test("the bot job gets the block history only through a checked artifact, and never asks about your own producers", () => {
  const jobs = jobsOf(fs.readFileSync(".github/workflows/bot.yml", "utf8"));
  assert.ok(jobs["blocks-in"] && jobs["blocks-out"], "blocks-in and blocks-out jobs");
  assert.match(jobs.tick, /needs:\s*blocks-in/);
  assert.match(jobs.tick, /download-artifact@[0-9a-f]{40}[^\n]*\n(?:.*\n){0,4}\s*name: blocks-in\n\s*path: \$\{\{ runner\.temp \}\}/);
  assert.match(jobs.tick, /block history ok/);
  assert.match(jobs.tick, /EXCLUDE_PRODUCERS:\s*\$\{\{\s*vars\.PERSONAL_PRODUCER\s*\}\}/);
  assert.doesNotMatch(jobs["blocks-in"] + jobs["blocks-out"], /secrets\.|environment:|contents:\s*write/);
});

test("every workflow installs packages with install scripts off (audit H-1, C-1)", () => {
  for (const file of WORKFLOWS) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf8").split("\n").filter((l) => /\bnpm (ci|install|i)\b/.test(l) && !l.trim().startsWith("#"))) {
      assert.match(line, /npm ci [^\n]*--ignore-scripts/, `${file}: ${line.trim()}`);
    }
  }
});

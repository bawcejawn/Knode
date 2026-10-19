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
];

function useLines(file: string): string[] {
  return fs.readFileSync(file, "utf8").split("\n").map((l) => l.trim()).filter((l) => l.startsWith("- uses:") || l.startsWith("uses:"));
}

test("every third-party action is pinned to a full commit, with a version comment", () => {
  for (const file of WORKFLOWS) {
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
  assert.match(y, /actions:\s*write/);
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

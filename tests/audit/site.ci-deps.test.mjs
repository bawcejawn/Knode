// Red team (web attacker), fix check of Knode @ 0e75ca8: CI (.github/workflows) and dependency pinning
// (package.json + package-lock.json in /, game/, desk/).
//
// Guards (expected PASS): every action pinned to a full commit SHA; no pull_request_target / workflow_run triggers;
// no attacker-controlled ${{ github.event.* }} / head_ref expanded in a run: script; secrets used only by bot.yml's tick
// job and never in a workflow that runs on pull requests; bot.yml tick is read-only, persist-credentials false,
// npm ci --ignore-scripts; publish runs no repository code (no npm, no node <file>, no checkout of a PR ref) and only
// git-adds game-data paths; every manifest dependency is an exact version, every lock entry comes from
// registry.npmjs.org with a sha512 integrity, and each lock's root matches its package.json (so `npm ci` can't drift).
//
// Gap (expected FAIL = proof):
//  (D) OPERATOR_WIF is handed to whatever branch "Run workflow" (workflow_dispatch) is started on. GitHub runs the
//      bot.yml and the bot code OF THAT BRANCH, so anyone who can push a branch (a collaborator, a leaked PAT with
//      contents:write, a compromised GitHub App) can start the job on a branch whose bot code prints/sends the key,
//      without touching protected main. Safe: put the tick job in a GitHub Environment restricted to main
//      (environment: + deployment branch rule) or guard it with if: github.ref == 'refs/heads/main'.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const APP = process.env.APP || ".";
const wfDir = `${APP}/.github/workflows`;
const workflows = fs.readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f)).map((f) => ({ f, y: fs.readFileSync(`${wfDir}/${f}`, "utf8") }));
const bot = workflows.find((w) => w.f === "bot.yml").y;
/** Text of one job (from "  name:" to the next job at the same indent). */
const job = (y, name) => { const m = y.match(new RegExp(`\\n  ${name}:\\n([\\s\\S]*?)(?=\\n  [A-Za-z_-]+:\\n|$)`)); return m ? m[1] : ""; };

test("(guard) every action is pinned to a full commit SHA", () => {
  const bad = [];
  for (const { f, y } of workflows) for (const m of y.matchAll(/uses:\s*([^\s#]+)/g)) if (!/^\.\/|@[0-9a-f]{40}$/.test(m[1])) bad.push(`${f}: ${m[1]}`);
  assert.deepEqual(bad, []);
});

/** The workflow's triggers: the on: value, inline (on: [issues], on: issues) or as a block, its key quoted or not,
 *  comments removed (audit PN-8: an equivalent spelling must not slip past the guard). */
const triggers = (y) => {
  const t = y.replace(/\r/g, "").split("\n").map((l) => l.replace(/\s+#.*$/, "")).join("\n") + "\nzz_end:\n";
  const m = t.match(/^["']?(?:on|true)["']?\s*:([^\n]*)\n([\s\S]*?)(?=^["']?[A-Za-z_-]+["']?\s*:)/m);
  return m ? `${m[1]}\n${m[2]}` : "";
};

test("(guard) no privileged triggers or script injection from event data", () => {
  for (const { f, y } of workflows) {
    assert.ok(!/pull_request_target|workflow_run|issue_comment/.test(y), `${f}: privileged trigger`);
    // No workflow starts from an issue (anyone can open one). names.yml reads issues on a schedule, as data.
    assert.ok(!/(^|[\s\[,{"'])(issues|discussion|discussion_comment|pull_request_review|pull_request_review_comment)(["']?\s*[:,\]}]|\s*$)/m.test(triggers(y)), `${f}: triggered by issues or comments`);
    assert.ok(!/^\s*["']?(?:on|true)["']?\s*:\s*["']?(issues|discussion)/m.test(y), `${f}: triggered by issues`);
    // A blanket write token, or every secret handed on at once, is never used (audit PN-8).
    // Any YAML spelling: plain, quoted, or a block scalar (>-, |) with write-all on the next line (Repo Lens C1-4).
    assert.ok(!/permissions:\s*(?:[>|][+-]?\s*)?["']?write-all/i.test(y), `${f}: permissions: write-all`);
    // GitHub's expression functions ignore case (toJSON, toJson, tojson); "inherit" may be quoted.
    assert.ok(!/secrets:\s*["']?inherit|tojson\(\s*secrets\s*\)|secrets\s*\[/i.test(y), `${f}: hands on all secrets`);
    assert.ok(!/\$\{\{\s*github\.(event\.(pull_request|issue|comment|review|head_commit|commits|pages|inputs)|head_ref)/.test(y), `${f}: event data expanded in the workflow`);
  }
  assert.match(triggers(bot), /schedule:/, "(the trigger parser finds bot.yml's schedule)");
});

test("(guard) issue permissions only in names.yml: read in its check job, write only in its reply job, which runs no repository code", () => {
  for (const { f, y } of workflows) {
    const lines = [...y.matchAll(/^\s*issues:\s*(\S+)/gm)];
    if (f !== "names.yml") { assert.deepEqual(lines.map((m) => m[0].trim()), [], `${f}: issue permissions`); continue; }
    const check = job(y, "check"), publish = job(y, "publish"), reply = job(y, "reply");
    assert.match(check, /permissions:\s*\n\s*contents:\s*read\s*\n\s*issues:\s*read\s*\n/, "names.yml check: contents and issues read-only");
    assert.doesNotMatch(check, /secrets\.|contents:\s*write|issues:\s*write/, "names.yml check: no secret, no write");
    assert.match(check, /persist-credentials:\s*false/);
    assert.match(publish, /permissions:\s*\n\s*contents:\s*write\s*#[^\n]*\n\s*steps:/, "names.yml publish: contents only");
    assert.match(reply, /permissions:\s*\n\s*issues:\s*write\s*#[^\n]*\n\s*steps:/, "names.yml reply: issues only");
    for (const [n, j] of [["publish", publish], ["reply", reply]]) {
      assert.doesNotMatch(j, /actions\/checkout|actions\/setup-node|\bnpm\b|\bnode\b|\bnpx\b|\btsx\b/, `names.yml ${n} runs no repository code`);
    }
    assert.equal(lines.filter((m) => /write/.test(m[1])).length, 1, "names.yml: one job writes to issues");
  }
});

test("(guard) secrets live only in bot.yml's tick job, never in a workflow that runs on pull requests", () => {
  for (const { f, y } of workflows) {
    const uses = [...y.matchAll(/secrets\.([A-Za-z_][A-Za-z0-9_-]*)/g)].map((m) => m[1]);   // any case (audit PN-8)
    if (f !== "bot.yml") assert.deepEqual(uses, [], `${f} uses secrets`);
    if (/\n\s*pull_request:/.test(y)) { assert.deepEqual(uses, [], `${f}: secrets on PRs`); assert.match(y, /contents:\s*read/, `${f}: PR token must be read-only`); }
  }
  assert.ok(!/\n\s*pull_request/.test(bot) && !/\n\s*push:/.test(bot), "bot.yml must not run on pushes/PRs");
  assert.ok(job(bot, "tick").includes("OPERATOR_WIF") && !job(bot, "publish").includes("secrets."), "the key is only in tick");
});

test("(guard) bot.yml: tick is read-only and installs without scripts; publish runs no repository code", () => {
  const tick = job(bot, "tick"), pub = job(bot, "publish");
  assert.match(tick, /permissions:\s*\n\s*contents:\s*read/);
  assert.match(tick, /persist-credentials:\s*false/);
  assert.match(tick, /npm ci\b[^\n]*--ignore-scripts/);
  assert.ok(!/npm (i|install)\b/.test(tick), "tick: npm install would ignore the lockfile");
  assert.match(pub, /permissions:\s*\n\s*contents:\s*write/);
  assert.match(pub, /persist-credentials:\s*false/);
  assert.ok(!/\bnpm\b|\bnpx\b|node\s+(?!-e\b)[\w./-]+\.(m?js|ts)|tsx\b|ref:\s*\$\{\{/.test(pub), "publish must not run repository code or check out another ref");
  assert.ok(!/actions\/cache/.test(pub), "publish must not restore a cache");
  // Only these four paths are staged (one by one, so a missing file doesn't stop the others; AB-030).
  assert.match(pub, /for p in game-data\/questions game-data\/bot-state\.json game-data\/state\.json game-data\/index\.json; do\s*\n\s*if \[ -e "\$p" \]; then git add -- "\$p"; fi/);
  assert.equal((pub.match(/git add\b/g) ?? []).length, 1, "no other git add in the publish job");
  assert.match(pub, /-type l/, "symlinks in the artifact are refused");
});

test("(D) the job that holds OPERATOR_WIF only runs for the default branch (environment rule or ref guard)", () => {
  const tick = job(bot, "tick");
  const guarded = /\n    environment:\s*\S+/.test(tick) || /github\.ref\s*==\s*'refs\/heads\/main'/.test(tick);
  assert.ok(guarded, "workflow_dispatch on any branch runs that branch's bot code with OPERATOR_WIF");
});

test("(guard) dependencies: exact versions, lock entries from npmjs with sha512, lock root matches package.json", () => {
  const bad = [];
  for (const d of ["", "game/", "desk/"]) {
    const pj = `${APP}/${d}package.json`, lj = `${APP}/${d}package-lock.json`;
    if (!fs.existsSync(pj)) continue;
    const p = JSON.parse(fs.readFileSync(pj, "utf8"));
    assert.ok(fs.existsSync(lj), `${d}package-lock.json missing`);
    const l = JSON.parse(fs.readFileSync(lj, "utf8"));
    for (const sec of ["dependencies", "devDependencies", "optionalDependencies"]) for (const [n, v] of Object.entries(p[sec] || {}))
      if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(v)) bad.push(`${d}package.json ${n}@${v} is not an exact version`);
    const root = l.packages && l.packages[""];
    assert.ok(root && l.lockfileVersion >= 2, `${d}: lockfile v2+`);
    for (const sec of ["dependencies", "devDependencies", "optionalDependencies"]) assert.deepEqual(root[sec] || {}, p[sec] || {}, `${d}package-lock.json root ${sec} differs from package.json (npm ci would refuse or drift)`);
    for (const [k, e] of Object.entries(l.packages)) {
      if (!k || e.link || e.inBundle) continue;
      if (!e.resolved || !e.resolved.startsWith("https://registry.npmjs.org/")) bad.push(`${d}${k}: resolved ${e.resolved}`);
      if (!e.integrity || !e.integrity.startsWith("sha512-")) bad.push(`${d}${k}: integrity ${e.integrity}`);
    }
  }
  assert.deepEqual(bad, []);
});

test("(guard) workflows install from the lockfile (no `npm install` fallback when a lockfile exists)", () => {
  const bad = [];
  for (const { f, y } of workflows) for (const m of y.matchAll(/run:\s*(.*npm (?:i|install)\b.*)/g)) {
    const wd = (y.match(/working-directory:\s*(\S+)/) || [, ""])[1];
    const lock = `${APP}/${wd ? wd + "/" : ""}package-lock.json`;
    if (!/if \[ -f package-lock\.json \]/.test(m[1]) || !fs.existsSync(lock)) bad.push(`${f}: ${m[1].trim()}`);
  }
  assert.deepEqual(bad, []);
});

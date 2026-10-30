// Repo Lens round 9 (BX-128). NOT RUN HERE (static review). These should FAIL at 6990323 and pass after the fix.
// The class round 8 closed: a value the publish step's Python accepts but the JavaScript recorder reads differently,
// so the next honest run "changes" published data and is refused. One member is still open, in race-samples.yml:
// Python's re `\d` matches every Unicode decimal digit ("٤٠٠", "４００"), and int() reads them, but bot/race.ts
// loadSamples uses JS /^\d{1,20}$/ (ASCII only) and drops the whole sample. The byte check passes such a file,
// because JSON.stringify writes non-ASCII characters as they are. So one bad run can publish a sample that the next
// honest sampler drops, and every honest run is then refused ("a published sample of the last 8 hours would be
// dropped") for about 7 h 50 min. Race cards run short of samples, and Block X can't score with them.
// Fix: [0-9] instead of \d in both sample regexes (or re.ASCII), in race-samples.yml.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const APP = fileURLToPath(new URL("../..", import.meta.url));

const A = "1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", B = "1BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const checkPy = () => {   // the publish step's own Python, cut from the workflow (as repolens-r8-canonical.test.mjs does)
  const y = fs.readFileSync(path.join(APP, ".github/workflows/race-samples.yml"), "utf8").split("\n");
  const a = y.findIndex((l) => l.includes("<<'PY'")), e = y.findIndex((l, i) => i > a && l.trim() === "PY");
  const py = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "r9-")), "check.py");
  fs.writeFileSync(py, y.slice(a + 1, e).map((l) => l.slice(10)).join("\n"));
  return py;
};
const PY = checkPy();
const pyAccepts = (samples) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "r9-in-")), f = path.join(d, "vhp-samples.json");
  fs.writeFileSync(f, JSON.stringify({ v: 1, updated: new Date().toISOString(), samples }) + "\n");
  return spawnSync("python3", ["-I", PY, f, path.join(d, "none.json")], { encoding: "utf8" }).status === 0;
};
const now = Date.now();
const plain = { at: now - 60000, height: 1000, vhp: { [A]: "400", [B]: "200" } };
const crafted = [
  ["Arabic-Indic digits in vhp", { at: now - 30000, height: 1001, vhp: { [A]: "٤٠٠", [B]: "200" } }],
  ["fullwidth digits in vhp", { at: now - 30000, height: 1001, vhp: { [A]: "４００", [B]: "200" } }],
  ["Devanagari digits in high", { at: now - 30000, height: 1001, vhp: { [A]: "400", [B]: "200" }, flagged: [B], high: { [B]: "३००" } }],
];

test("BX-128: the race-samples publish check refuses VHP strings that aren't ASCII digits", () => {
  assert.equal(pyAccepts([plain]), true, "an honest sample passes");
  for (const [what, s] of crafted) assert.equal(pyAccepts([plain, s]), false, what);
});

test("BX-128: every sample the publish check accepts, the recorder's own loadSamples keeps (no honest run can drop it)", async () => {
  const prev = fs.mkdtempSync(path.join(os.tmpdir(), "r9-prev-"));
  process.env.RACE_PREV = prev;   // bot/race.ts reads RACE_PREV when it loads
  const R = await import(path.join(APP, "bot/race.ts"));
  for (const [what, s] of crafted) {
    if (!pyAccepts([plain, s])) continue;   // refused at publish: fine
    fs.writeFileSync(path.join(prev, "vhp-samples.json"), JSON.stringify({ v: 1, updated: new Date().toISOString(), samples: [plain, s] }) + "\n");
    const kept = R.loadSamples(now).map((x) => x.height);
    assert.deepEqual(kept, [1000, 1001], `${what}: published, then dropped by loadSamples (every honest run refused ~8 h)`);
  }
});

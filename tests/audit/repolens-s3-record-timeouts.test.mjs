// V-M-2 (not run here (static review)). Reads the REAL .github/workflows/games.yml. Survivor's step was added to the
// record job without raising the job's 30-minute limit or bounding Block X's step; a job timeout cancels the job before
// the artifact upload, so Block X's finished files are lost with Survivor's. Either Block X's files are uploaded on
// their own before Survivor starts, or the job limit covers setup + Block X's step limit + Survivor's step limit.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const APP = process.env.APP || ".";
const yml = fs.readFileSync(path.join(APP, ".github/workflows/games.yml"), "utf8");
const record = yml.slice(yml.indexOf("\n  record:"), yml.indexOf("\n  publish:"));
const stepOf = (name) => { const i = record.indexOf(`- name: ${name}`); const j = record.indexOf("\n      - ", i + 1); return record.slice(i, j < 0 ? undefined : j); };
const mins = (s) => { const m = /timeout-minutes:\s*(\d+)/.exec(s); return m ? Number(m[1]) : null; };

test("V-M-2: a slow Survivor step can't lose Block X's finished files", () => {
  const job = mins(record.slice(0, record.indexOf("steps:")));
  const bx = mins(stepOf("Record Who Signs Block X")), sv = mins(stepOf("Record Survivor"));
  const bxUploadedFirst = /upload-artifact[\s\S]*?name:\s*games-data-blockx[\s\S]*- name: Record Survivor/.test(record);
  assert.ok(bxUploadedFirst || (bx !== null && sv !== null && job >= 5 + bx + sv),
    `job ${job} min, Block X step ${bx ?? "unbounded"}, Survivor step ${sv}: a job timeout drops every file of the run`);
});

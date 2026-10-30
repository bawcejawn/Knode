// Round 8 (BX-122 and the class behind BX-95 / BX-112 / BX-113): every publish step runs one inline node check, and an
// incoming JSON file must be byte for byte JSON.stringify(JSON.parse(text)) + "\n", the recorders' own form. This runs
// that exact line, cut from each workflow, against honest and crafted files.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { spawnSync } from "node:child_process";
const APP = process.env.APP || process.cwd();
const lineOf = (wf) => fs.readFileSync(path.join(APP, ".github/workflows", wf), "utf8").split("\n").find((l) => l.trim().startsWith("node -e '") && l.includes("recorders own JSON form")).trim();
for (const wf of ["games.yml", "games-testnet.yml", "race.yml", "race-samples.yml"]) {
  test(`${wf}: the recorders' own JSON form passes; 5.0, -0, 1e2, 2^53+1, spacing, CRLF, BOM, bad UTF-8 and a symlink are refused`, () => {
    const sh = lineOf(wf);
    const run = (files, link) => {
      const d = fs.mkdtempSync(path.join(os.tmpdir(), "canon-"));
      fs.mkdirSync(path.join(d, "blockx", "vault"), { recursive: true });
      for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(d, f), c);
      if (link) fs.symlinkSync(path.join(d, "blockx", "board.json"), path.join(d, "blockx", "evil.json"));
      return spawnSync("bash", ["-c", sh], { env: { ...process.env, IN: d }, encoding: "utf8" }).status;
    };
    const honest = JSON.stringify({ v: 1, week: 3, card: { at: 1793662200000, top: 5, c: 1.5, k: -0.25 }, s: "a\u2028b\"é" }) + "\n";
    assert.equal(run({ "blockx/W003.json": honest, "blockx/board.json": honest, "blockx/vault/W3.json": honest }), 0, "honest files pass");
    for (const bad of ['{"v":1,"top":5.0}\n', '{"v":1,"top":-0}\n', '{"v":1,"top":1e2}\n', '{"v":1,"n":9007199254740993}\n', '{"v": 1}\n', '{"v":1}', '{"v":1}\r\n', '\ufeff{"v":1}\n', '{"v":1,"a":1,"a":2}\n', '{"v":1,"s":"\\u0041"}\n'])
      assert.notEqual(run({ "blockx/W003.json": bad }), 0, JSON.stringify(bad));
    assert.notEqual(run({ "blockx/W003.json": Buffer.from([0x7b, 0x22, 0x73, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d, 0x0a]) }), 0, "invalid UTF-8");
    assert.notEqual(run({ "blockx/board.json": honest }, true), 0, "a symlink named .json");
  });
}

// Round-8 review: race-samples.yml takes a sample at most 60 s ahead, the same as bot/race.ts loadSamples, so the
// recorder never drops a published sample on load.
test("race-samples.yml: a sample 5 minutes in the future is refused; one 30 s ahead passes", () => {
  const y = fs.readFileSync(path.join(APP, ".github/workflows/race-samples.yml"), "utf8").split("\n");
  const a = y.findIndex((l) => l.includes("<<'PY'")), e = y.findIndex((l, i) => i > a && l.trim() === "PY");
  const py = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rs-")), "check.py");
  fs.writeFileSync(py, y.slice(a + 1, e).map((l) => l.slice(10)).join("\n"));
  const run = (dt) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "rs-in-")), now = Date.now();
    const f = path.join(d, "vhp-samples.json");
    fs.writeFileSync(f, JSON.stringify({ v: 1, updated: new Date(now).toISOString(), samples: [{ at: now + dt, height: 1000, vhp: { "1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA": "100" } }] }) + "\n");
    return spawnSync("python3", ["-I", py, f, path.join(d, "none.json")], { encoding: "utf8" }).status;
  };
  assert.equal(run(30000), 0);
  assert.notEqual(run(5 * 60000), 0);
});

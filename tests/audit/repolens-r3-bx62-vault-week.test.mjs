// F4-K-2 failing test. NOT RUN HERE (static review). Extracts the publish job's Python from .github/workflows/games.yml
// and feeds it a vault file for a week that is not the week that just ended (board.json lastWeek.week).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { spawnSync } from "node:child_process";
const APP = process.env.APP || process.cwd();
const A = "1" + "A".repeat(33);
function py(yml) { const y = fs.readFileSync(path.join(APP, yml), "utf8"); const s = y.indexOf("<<'PY'\n") + 7, e = y.indexOf("\n          PY\n", s); return y.slice(s, e).split("\n").map((l) => l.slice(10)).join("\n"); }
for (const yml of [".github/workflows/games.yml"]) test(`F4-K-2 (${yml}): a vault file for a future week is refused`, () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "vk-")), b = path.join(d, "blockx"); fs.mkdirSync(path.join(b, "vault"), { recursive: true });
  fs.writeFileSync(path.join(b, "vault", "W40.json"), JSON.stringify({ game: 2, week: 40, final: true, rows: [], first: [A], second: [] }));
  const f = path.join(d, "check.py"); fs.writeFileSync(f, py(yml));
  const r = spawnSync("python3", ["-I", f, b, "2"], { encoding: "utf8" });
  assert.notEqual(r.status, 0, "the publish check must tie vault/W<week>.json to the week that just ended (and its final board/P file)");
});

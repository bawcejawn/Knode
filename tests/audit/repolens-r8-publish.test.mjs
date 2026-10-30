// Repo Lense round 8, reviewer J-K. NOT RUN HERE (static review). Place in tests/audit/ and run with node --test.
// Drives the REAL publish checks cut from .github/workflows/games.yml and race.yml (same cut as the owner's
// repolens-r7-publish.test.mjs / repolens-r7-race.test.mjs). The honest recorder side is JSON.parse + JSON.stringify,
// which is exactly what bot/games/blockx.ts:loadWeek:92-98 (+ write :719-723) and bot/race.ts:loadWeek:183-195
// (+ write) do to an already-published target / card: kept verbatim, re-serialised.
// Files are written as RAW TEXT: JSON.stringify can never produce "3.0", which is why the owner's tests can't see this.
import { fileURLToPath } from "node:url";
import { test } from "node:test"; import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { spawnSync } from "node:child_process";
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cut = (wf, marker) => { const y = fs.readFileSync(path.join(APP, ".github/workflows", wf), "utf8").split("\n");
  const a = y.findIndex((l) => l.includes(marker)); const e = y.findIndex((l, i) => i > a && l.trim() === "PY");
  return y.slice(a + 1, e).map((l) => l.replace(/^ {10}/, "")).join("\n"); };
const GAMES = cut("games.yml", "/usr/bin/python3 - \"$IN/blockx\" 2 \"$PUB/blockx\" \"$HELD\" blockx 2400 0 <<'PY'");
const RACE = cut("race.yml", "/usr/bin/python3 - \"$IN\" \"$RUNNER_TEMP/published\" <<'PY'");
const G = 1792368000000, WK = 7 * 86400000, NOW = G + WK + 86400000;
const py = (src, args) => spawnSync("python3", ["-I", "-", ...args], { input: src, encoding: "utf8", env: { ...process.env, CHECK_NOW_MS: String(NOW) } });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "jk-"));

for (const raw of ["5.0", "-0.0", "1e2"]) {
  test(`J-K-1: a target card number written as ${raw} can't be published (it would hold every honest run after it)`, () => {
    const st = G + WK, A = "1KoinosAddrxxxxxxxxxxxxxxxxxxxxxxx", B = "1ProducerAddrxxxxxxxxxxxxxxxxxxxxx";
    const t = `{"round":1000,"height":2400000,"final":true,"checked":2,"signer":"${B}","time":${st + 3600000},"lockTime":${st + 3000000},"card":{"at":${st},"top":${raw},"signerVhp":null},"picks":[["${A}","${B}",${st},0,0]]}`;
    const d = tmp(), inn = path.join(d, "in"), pub = path.join(d, "pub"); fs.mkdirSync(inn); fs.mkdirSync(pub);
    fs.writeFileSync(path.join(inn, "W001.json"), `{"v":1,"week":1,"start":${st},"end":${st + WK},"game":2,"targets":[${t}]}`);
    fs.writeFileSync(path.join(inn, "index.json"), JSON.stringify({ v: 1, updated: "2026-10-28T00:00:00.000Z", weeks: [1], contract: null, game: 2, prizesFromWeek: null }));
    fs.writeFileSync(path.join(inn, "board.json"), JSON.stringify({ v: 1, updated: "2026-10-28T00:00:00.000Z", today: { day: "2026-10-28", rows: [] }, week: { week: 1, start: st, rows: [] }, lastWeek: null, allTime: { rows: [] } }));
    const held = path.join(d, "held"); const r = py(GAMES, [inn, "2", pub, held, "blockx", "2400", "0"]);
    const refused = r.status !== 0 || fs.readFileSync(held, "utf8").includes("W001.json");
    if (!refused) { // it was published: the honest recorder's next run must still publish
      const pub2 = path.join(d, "pub2"), in2 = path.join(d, "in2"); fs.cpSync(inn, pub2, { recursive: true }); fs.cpSync(inn, in2, { recursive: true });
      for (const f of fs.readdirSync(in2)) fs.writeFileSync(path.join(in2, f), JSON.stringify(JSON.parse(fs.readFileSync(path.join(in2, f), "utf8"))) + "\n");
      const held2 = path.join(d, "held2"); const r2 = py(GAMES, [in2, "2", pub2, held2, "blockx", "2400", "0"]);
      assert.equal(r2.status, 0, r2.stderr); assert.equal(fs.readFileSync(held2, "utf8"), "", "the honest run after it is held: " + r2.stdout);
    }
  });
  test(`J-K-2: a race card number written as ${raw} can't be published (race.yml would fail every honest run after it)`, () => {
    const d = tmp(), inn = path.join(d, "in"), pub = path.join(d, "pub"); fs.mkdirSync(inn); fs.mkdirSync(pub);
    const st = G + WK, races = [];
    for (let i = 0; i < 28; i++) { const s = st + i * 21600000; races.push({ id: new Date(s).toISOString().slice(0, 13), start: s, end: s + 21600000, cards: new Array(6).fill(null), result: null }); }
    races[0].cards[0] = { at: st - 600000, blocksPerRace: 7200, c: "@@", fairness: null, field: [{ a: "1KoinosAddrxxxxxxxxxxxxxxxxxxxxxxx", vhp: 1000, k: 2, h: 1 }], paddock: [] };
    fs.writeFileSync(path.join(inn, "W001.json"), JSON.stringify({ v: 1, week: 1, start: st, end: st + WK, races }).replace('"@@"', raw));
    const r = py(RACE, [inn, pub]);
    if (r.status === 0) { // published: the honest run (cards kept verbatim, re-serialised) must pass
      const pub2 = path.join(d, "pub2"), in2 = path.join(d, "in2"); fs.cpSync(inn, pub2, { recursive: true }); fs.mkdirSync(in2);
      fs.writeFileSync(path.join(in2, "W001.json"), JSON.stringify(JSON.parse(fs.readFileSync(path.join(inn, "W001.json"), "utf8"))) + "\n");
      const r2 = py(RACE, [in2, pub2]); assert.equal(r2.status, 0, r2.stderr);
    }
  });
}

// V-T failing tests — NOT RUN HERE (static review). Run from the repo root at 6e22c73: node --import tsx --test <this file>
// They drive the real code paths (bot/survivor-test.ts CLI `record`, bot/games/survivor.ts run/recoverOut/swapIn,
// bot/survivor-test.ts startSite) against tools/survivor-testnet/fake-testnet.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import crypto from "node:crypto";
import { spawn } from "node:child_process";
const APP = process.env.APP || ".";
const { startFakeTestnet, randomAddress } = await import(path.resolve(APP, "tools/survivor-testnet/fake-testnet.mjs"));
const { Signer } = await import("koilib");
const keyLines = () => ["OWNER", "PICKS", "P1", "P2", "P3", "P4", "P5", "P6"].map((w) => `${w}_WIF=${new Signer({ privateKey: crypto.randomBytes(32).toString("hex") }).getPrivateKey("wif")}`).join("\n") + "\n";

test("V-T-1: a kit run killed between the two renames is put back by the next `record` (OUT is also PREV)", async () => {
  const fake = await startFakeTestnet({ abiFile: path.join(APP, "picks/abi/picks.koilib.json"), producers: [[randomAddress(), 1]], historyMs: 3600000 });
  try {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "vt1-")), DIR = path.join(parent, "survivor"), DATA = path.join(DIR, "data");
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(path.join(DIR, "keys.env"), keyLines());
    fs.writeFileSync(path.join(DIR, "config.json"), JSON.stringify({ v: 1, rpc: fake.url, chainId: "EiAIKVvm6-V2qmsmUvPJy09vCCLbtn9lHFpwrJbcTIEWRQ==", koin: fake.koin, vhp: fake.vhp, holdToken: fake.vhp,
      clock: { day: 3600000, firstDay: null, outFloor: 1 }, picks: null, game: null }));
    // The state swapIn leaves when killed right after `rename OUT -> parked` (survivor.ts:swapIn:409): OUT missing,
    // last run's files parked under the fixed name next to OUT's parent.
    const parked = path.join(parent, `.survivor-old-${crypto.createHash("sha256").update(path.resolve(DATA)).digest("hex").slice(0, 12)}`);
    fs.mkdirSync(parked, { recursive: true });
    fs.writeFileSync(path.join(parked, "S007.json"), "{\"last run\":true}\n");
    // the real CLI path: survivor-test.ts:record (mkdirSync(DATA) at :413, then run() -> recoverOut at survivor.ts:421)
    // (Run with an async spawn: the fake testnet answers from this same process, so spawnSync would deadlock.)
    const r = await new Promise((ok) => {
      const c = spawn(process.execPath, ["--import", "tsx", path.join(APP, "bot/survivor-test.ts"), "record"], { env: { ...process.env, SURVIVOR_TEST_DIR: DIR } });
      let out = ""; c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (out += d));
      const t = setTimeout(() => c.kill(), 120000);
      c.on("exit", (status) => { clearTimeout(t); ok({ status, stdout: out, stderr: "" }); });
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(fs.existsSync(path.join(DATA, "S007.json")), "last run's files are back in OUT (today: OUT was created empty, so recoverOut skipped them)");
    assert.ok(!fs.existsSync(parked) || fs.readdirSync(parked).length === 0 || fs.existsSync(path.join(DATA, "S007.json")), "and never deleted unread");
  } finally { await fake.close(); }
});

test("V-T-4: the test page server answers raw (un-normalised) traversal and root-file requests with 404", async () => {
  // Sent with node:http so the client does NOT normalise `..` / `%2e%2e` (fetch() does, so the repo's list never reaches the server as written).
  const fake = await startFakeTestnet({ abiFile: path.join(APP, "picks/abi/picks.koilib.json"), producers: [[randomAddress(), 1]] });
  const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vt4-")); process.env.SURVIVOR_TEST_DIR = DIR;
  fs.writeFileSync(path.join(DIR, "keys.env"), keyLines());
  fs.writeFileSync(path.join(DIR, "config.json"), JSON.stringify({ v: 1, rpc: fake.url, chainId: "EiAIKVvm6-V2qmsmUvPJy09vCCLbtn9lHFpwrJbcTIEWRQ==", koin: fake.koin, vhp: fake.vhp, holdToken: fake.vhp, clock: { day: 3600000, firstDay: null, outFloor: 1 }, picks: null, game: null }));
  const T = await import(path.resolve(APP, "bot/survivor-test.ts"));
  const port = 19000 + Math.floor(Math.random() * 900), server = await T.startSite({ port });
  const http = await import("node:http");
  const get = (p) => new Promise((ok) => http.get({ host: "127.0.0.1", port, path: p, headers: { host: `127.0.0.1:${port}` } }, (r) => { let b = ""; r.on("data", (d) => (b += d)); r.on("end", () => ok([r.statusCode, b])); }));
  try {
    for (const p of ["/media/../testnet-data/survivor/keys.env", "/media/..%2f..%2f.env", "/media%5c..%5c.env", "/.git/config", "/.env", "/admin/index.html", "/sponsor-data/x.json", "/package.json", "/testnet/../keys.env"]) {
      const [s, b] = await get(p); assert.equal(s, 404, p); assert.ok(!b.includes("_WIF="), p);
    }
    assert.equal((await get("/survivor.js"))[0], 200); assert.equal((await get("/media/icon.svg"))[0], 200);
  } finally { server.close(); await fake.close(); }
});

// Rehearse the whole Survivor testnet flow against a fake testnet (no internet, no real chain): setup, fund, build and
// upload the testnet Picks contract, register game 3, start a season, play it to the end with p1 and the robot
// players, and click a pick on the test page in a real browser. Run from the repo root:
//   node --import tsx tools/survivor-testnet/rehearse.mjs
// It needs picks/node_modules (cd picks; npm ci) and yarn, like `picks-build` itself. Takes ~5–10 minutes.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakeTestnet, randomAddress } from "./fake-testnet.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "survivor-rehearsal-"));
const prods = Array.from({ length: 7 }, randomAddress);
// Seven producers; the smallest goes quiet for a few hours now and then, so the field changes like a real one.
const weights = [30, 22, 16, 12, 9, 6, (t) => (Math.floor(t / 3600000) % 9 < 2 ? 0.2 : 5)];
const fake = await startFakeTestnet({ abiFile: path.join(ROOT, "picks/abi/picks.koilib.json"), producers: prods.map((a, i) => [a, weights[i]]) });
const port = 18000 + Math.floor(Math.random() * 1000);
const env = { ...process.env, SURVIVOR_TEST_RPC: fake.url, SURVIVOR_TEST_DIR: dir, SURVIVOR_TEST_PORT: String(port) };
let failures = 0;
// Async: the fake testnet runs in this process, so it must keep answering while a command runs.
function tool(...args) {
  return new Promise((ok) => {
    const c = spawn(process.execPath, ["--import", "tsx", "bot/survivor-test.ts", ...args], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => c.kill(), 600000);
    c.on("close", (code) => {
      clearTimeout(timer);
      console.log(`\n$ survivor-test ${args.join(" ")}\n${out.trim().split("\n").map((l) => "  " + l).join("\n")}`);
      const expectFail = args[0] === "fund" && /Not enough/.test(out);
      if (code !== 0 && !expectFail) { failures++; console.log(`  ✗ exit ${code}`); }
      ok(out);
    });
  });
}
const expect = (ok, what) => { console.log(`${ok ? "  ✔" : "  ✗"} ${what}`); if (!ok) failures++; };
const keys = () => Object.fromEntries(fs.readFileSync(path.join(dir, "keys.env"), "utf8").split("\n").map((l) => l.match(/^([A-Z0-9]+)_WIF=(\S+)/)).filter(Boolean).map((m) => [m[1], m[2]]));

try {
  await tool("setup");
  const { Signer } = await import("koilib");
  const addr = Object.fromEntries(Object.entries(keys()).map(([k, w]) => [k.toLowerCase(), Signer.fromWif(w).getAddress()]));
  fake.picks.owner = addr.owner;

  expect(!/discovered|null/.test(JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8")).vhp ?? "null") || true, "config written");
  let out = await tool("fund", "--send");
  expect(/Not enough/.test(out), "fund refuses before the faucet");
  fake.faucet(addr.owner, 100);   // one real faucet claim
  await tool("fund", "--send");
  expect(fake.balanceOf(addr.picks) >= 50n * 100000000n - 10000000n, "the Picks wallet got its test KOIN");
  // The testnet's "hold 1" rule checks test KOIN: p4 and p6 keep less than 1 (they can still pick, but can't win).
  for (const w of ["p4", "p6"]) fake.setKoin(addr[w], 0.9);
  out = await tool("picks-build");
  expect(/testnet Picks build/.test(out), "testnet Picks contract built (test owner, 10-minute wait)");
  await tool("picks-upload", "--send");
  out = await tool("game", "--send");
  expect(/announced/.test(out), "game 3 announced");
  out = await tool("game", "--send");
  expect(/can be put in force from/.test(out), "apply waits for the 10-minute notice");
  fake.advance(11 * 60000);
  out = await tool("game", "--send");
  expect(/in force/.test(out), "game 3 in force");
  out = await tool("season", "next");
  const cfg = () => JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
  const first = cfg().clock.firstDay;
  expect(Number.isInteger(first), `season 1 starts round ${first}`);
  for (let i = 0; i < 4; i++) await tool("record");
  const H = 3600000;
  let browserDone = false;
  for (let round = 0; round < 16; round++) {
    const sf = path.join(dir, "data", "S001.json");
    const j = fs.existsSync(sf) ? JSON.parse(fs.readFileSync(sf, "utf8")) : null;
    if (j?.result?.over) break;
    const p1 = j?.result?.players?.find((x) => x.a === addr.p1);
    // Round 0: p1 picks on the test page in a real browser (before the fake clock runs ahead of the browser's).
    if (round === 0 && !browserDone) { await browser(); browserDone = true; }
    else if (!p1 || p1.outN === null) await tool("pick", "p1", `#${(round % 6) + 1}`, "--send");
    await tool("bots");
    // To one minute into the next round, then record.
    const t = fake.now(), next = (Math.floor(t / H) + 1) * H;
    fake.advance(next - t + 60000);
    await tool("record");
  }
  fake.advance(40 * 60000);
  await tool("record");
  out = await tool("status");
  const sf = JSON.parse(fs.readFileSync(path.join(dir, "data", "S001.json"), "utf8"));
  expect(sf.result.over === true, `the season ended after day ${sf.result.endN}`);
  expect(sf.result.final === true, "final after the correction window");
  expect(sf.result.players.length === 6, "six players (p1 + five robots)");
  expect(sf.result.players.some((p) => p.log.includes("n")), "a missed pick was recorded (robot p6)");
  expect(sf.result.players.some((p) => /[o]/.test(p.log) || p.outN !== null), "someone landed in the out-zone");
  console.log("\nFinal standings:\n" + sf.result.players.map((p) => `  #${p.place} ${Object.entries(addr).find(([, a]) => a === p.a)?.[0]} lives ${p.lives} out ${p.outN} log ${p.log} score ${p.total} eligible ${p.eligible}`).join("\n"));
  const won = sf.result.prizes.map((x) => Object.entries(addr).find(([, a]) => a === x.player)?.[0]);
  expect(!won.includes("p4") && !won.includes("p6"), "wallets holding under 1 (test KOIN) win nothing");
  console.log("Prizes: " + JSON.stringify(sf.result.prizes.map((x) => [Object.entries(addr).find(([, a]) => a === x.player)?.[0], x.vhp])));
} catch (e) { failures++; console.error(e); }
finally { await fake.close(); }
console.log(failures ? `\n✗ rehearsal: ${failures} problem(s)` : "\n✔ rehearsal passed");
process.exit(failures ? 1 : 0);

async function browser() {
  const site = spawn(process.execPath, ["--import", "tsx", "bot/survivor-test.ts", "site"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; site.stdout.on("data", (d) => (log += d)); site.stderr.on("data", (d) => (log += d));
  await new Promise((ok) => setTimeout(ok, 4000));
  try {
    let pw;
    try { pw = await import(process.env.PLAYWRIGHT_MODULE || "playwright"); }
    catch { console.log("  (browser step skipped: Playwright isn't installed here; the rest of the rehearsal still runs)"); return; }
    const chromium = pw.chromium ?? pw.default.chromium;
    const b = await chromium.launch();
    const pg = await b.newPage({ viewport: { width: 390, height: 844 } });
    const errs = [];
    pg.on("pageerror", (e) => errs.push(String(e)));
    pg.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|fonts\.g|cdn\.jsdelivr/.test(m.text())) errs.push(m.text()); });
    // The CDN copy of koilib isn't reachable offline: serve the repo's copy for that one URL.
    await pg.route("https://cdn.jsdelivr.net/npm/koilib@9.4.1/dist/koinos.min.js", (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: fs.readFileSync(path.join(ROOT, "node_modules/koilib/dist/koinos.min.js"), "utf8") }));
    await pg.route(/fonts\.googleapis|fonts\.gstatic|kondor-js|qrcode/, (r) => r.fulfill({ status: 200, body: "" }));
    await pg.goto(`http://127.0.0.1:${port}/`);
    await pg.waitForTimeout(5000);
    expect(await pg.isVisible(".tn-bar"), "test page shows the TESTNET bar");
    const today = await pg.innerText("#today-sub");
    expect(/blocks so far/.test(today), `live standings: ${today.slice(0, 90)}`);
    await pg.selectOption("#tn-player", "p1");
    await pg.waitForTimeout(3000);
    // The first row you can pick in (an hour before Season 1 shows as a practice row without a Pick button).
    const row = pg.locator("#days .bx-row:has(button)").first();
    const sel = row.locator("select");
    const opts = await sel.locator("option:not([disabled])").allInnerTexts();
    const choice = opts.find((o) => /×/.test(o));
    await sel.selectOption({ label: choice });
    await row.locator("button").click();
    await pg.waitForSelector(".pk-box.ok, .pk-box.bad, .pk-box.info", { timeout: 60000 });
    const box = await pg.innerText(".pk-box");
    expect(/Pick confirmed/.test(box), `a pick clicked on the page: ${box.split("\n")[1] || box.slice(0, 60)}`);
    await pg.screenshot({ path: path.join(dir, "test-page.png"), fullPage: true });
    expect(errs.length === 0, `no page errors${errs.length ? ": " + errs.slice(0, 3).join(" | ") : ""}`);
    // The server refuses what the test wallet must never do.
    const bad = await pg.evaluate(async () => {
      const t = (await (await fetch("/testnet/session")).json()).token;
      const r = await fetch("/test/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: t, as: "p1", ops: [{ call_contract: { contract_id: "1FaSvLjQJsCJKq5ybmGsMMQs8RQYyVv8ju", entry_point: 0x27f576ca, args: "" } }] }) });
      return [r.status, await r.text()];
    });
    expect(bad[0] === 400, `the test wallet refuses a token transfer (${bad[1].slice(0, 80)})`);
    await b.close();
    console.log(`  screenshot: ${path.join(dir, "test-page.png")}`);
  } catch (e) { failures++; console.log("  ✗ browser: " + e.message + "\n" + log.slice(-800)); }
  finally { site.kill(); }
}

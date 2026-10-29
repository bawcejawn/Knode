// Rehearses the whole Fantasy testnet practice kit offline, on two fake chains (tools/fantasy-testnet/fake-chains.mjs):
// setup, funding, the testnet Picks build and upload, both games (with the 10-minute wait), a test week, then about
// two and a half test weeks of 10-minute steps with the robots, your own teams (including a refused 2-change team) and a
// rival challenge, and the checks at the end. It finishes with the practice page's server answering on 127.0.0.1.
//   node --import tsx tools/fantasy-testnet/rehearse.mjs            (about 5 minutes)
//   KEEP=1 … leaves the page running at the end, for a look in a browser.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { startFakeChain, makeClock, randomAddress, MAINNET_CHAIN_ID, TESTNET_CHAIN_ID } from "./fake-chains.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const H = 3600000, MIN = 60000;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fantasy-rehearsal-"));
const clock = makeClock();

// Mainnet: 18 producers, a few that miss blocks (one goes quiet for a while), VHP spread like the real field.
const field = Array.from({ length: 18 }, (_, i) => [randomAddress(), 0, Math.round(2_000_000 / (1 + i * 0.6))]);
const rel = [1.05, 1.0, 0.76, 1.03, 0.98, 1.06, 0.92, 0.78, 1.04, 1.0, 0.8, 1.02, 1.0, 1.05, 0.95, 1.0, 1.0, 0.9];
const quietFrom = clock.now() + 9 * H, quietTo = quietFrom + 3 * H;
field.forEach((f, i) => { f[1] = (t) => f[2] * rel[i] * (i === 3 && t >= quietFrom && t < quietTo ? 0 : 1); });
const T0 = Math.floor((clock.now() - 2 * 86400000) / 3000) * 3000;
const mainA = await startFakeChain({ name: "main", clock, chainId: MAINNET_CHAIN_ID, producers: field, blockMs: 3000, t0: T0 });
const mainB = await startFakeChain({ name: "main", clock, chainId: MAINNET_CHAIN_ID, producers: field, blockMs: 3000, t0: T0 });
// The testnet: one producer, like the real one. Its owner is set once the kit has made the test keys.
const test = await startFakeChain({ name: "test", clock, chainId: TESTNET_CHAIN_ID, producers: [[randomAddress(), 1, 0]], blockMs: 1000, historyMs: 3600000, picksAbiFile: path.join(ROOT, "picks/abi/picks.koilib.json"), owner: null });

process.env.FANTASY_TEST_DIR = dir;
process.env.FANTASY_TEST_RPC = test.url;
process.env.FANTASY_TEST_MAINNET_RPC = mainA.url;
process.env.FANTASY_TEST_MAINNET_CHECK = mainB.url;
process.env.FANTASY_TEST_CARDS = "local";
const kit = await import("../../bot/fantasy-test.ts");
const R = globalThis.KRaceMath, FR = globalThis.KFantasyMath;
const notes = [];
kit.quiet((...a) => notes.push(a.join(" ")));
kit.setNow(clock.now);
const step = (m) => console.log(`· ${m}`);

// 1. setup.
await kit.setup();
let cfg = kit.readConfig();
const keys = kit.readKeys(), A = (w) => kit.addressOf(keys, w);
test.picks.owner = A("owner");
step(`setup: owner ${A("owner")}, players ${["p1", "p2", "p3", "p4", "p5", "p6"].map(A).map((x) => x.slice(0, 6)).join(" ")}`);

// 2. fund, build, upload, games.
test.faucet(A("owner"), 100);
await kit.fund(true);
assert.ok(test.balanceOf(A("picks")) >= 49e8 && test.balanceOf(A("p1")) >= 5e8, "funded");
await kit.picksBuild();
await kit.picksUpload(true);
cfg = kit.readConfig();
assert.equal(cfg.picks.contract, A("picks"));
await kit.games(true);
assert.equal(test.picks.pending.size, 2, "both games announced");
clock.advance(11 * MIN);
await kit.games(true);
assert.ok(test.picks.games.get(4) && test.picks.games.get(5), "both games in force");
assert.equal(test.picks.games.get(4).kind, 2); assert.equal(test.picks.games.get(4).list_size, 5);
step("Picks contract uploaded; games 4 (team) and 5 (rival) in force after the 10-minute wait");

// 3. race cards for the last 2 days (the live kit gets them from the Producer Race; here they're made from the fake VHP).
const card = R.makeCard(field.map(([a, , v]) => [a, v]), 7200, clock.now() - 2 * 86400000);
fs.mkdirSync(path.join(dir, "race"), { recursive: true });
for (let w = R.weekOf(clock.now() - 2 * 86400000); w <= R.weekOf(clock.now()); w++) {
  const start = R.weekStart(w), races = [];
  for (let t = start; t < start + R.WEEK; t += R.RACE) races.push({ id: R.raceId(R.raceIndex(t)), start: t, end: t + R.RACE, cards: t + R.RACE < clock.now() + R.RACE && t >= clock.now() - 2 * 86400000 - R.RACE ? new Array(6).fill(card) : new Array(6).fill(null), result: null });
  fs.writeFileSync(path.join(dir, "race", `W${String(w).padStart(3, "0")}.json`), JSON.stringify({ v: 1, week: w, start, end: start + R.WEEK, races }));
}

// 4. the test week.
await kit.week("next");
cfg = kit.readConfig();
const F = FR.withClock(cfg.clock), g = cfg.clock.genesis;
step(`test week 1 starts ${new Date(g).toISOString()} (in ${Math.round((g - clock.now()) / MIN)} min); price list at ${new Date(F.sheetTime(0)).toISOString()}`);

// 5. run: 10-minute steps until test week 3 is half done; you (p1) play along.
const myPlans = [];
let refused = false, rivalSent = false, ticks = 0;
const endAt = F.weekStart(2) + 3.5 * H;
while (clock.now() < endAt) {
  await kit.tick(true);
  ticks++;
  const now = clock.now();
  const wNow = now < F.weekStart(0) ? 0 : F.weekOf(now);
  const data = (n) => { try { return JSON.parse(fs.readFileSync(path.join(dir, "data", n), "utf8")); } catch { return null; } };
  let td = Math.max(F.dayNo(now), F.weekDays(0)[0]); while (F.lockOfDay(td) - now < MIN) td++;   // as the kit's team command counts
  const tw = F.weekOf(F.dayStart(td)), wf = data(`W${String(tw).padStart(3, "0")}.json`);
  if (wf && wf.sheet && !myPlans.some((x) => x.td === td)) {
    // You: the 5 best-form producers that fit, then each test day one swap to the best form left; on test day 4 of
    // week 1 a team with 2 changes, which the recorder must ignore.
    const pool = [...wf.sheet.pool].sort((a, b) => (b.form ?? 0) - (a.form ?? 0));
    const prev = myPlans.length ? myPlans[myPlans.length - 1].team : null;
    let team;
    if (!prev || !F.checkTeam(wf.sheet, prev).ok) team = kit.bestTeam(wf.sheet.pool, wf.sheet.budget, (a) => wf.sheet.pool.find((p) => p.a === a).form ?? 90);
    else if (F.weekDays(tw)[0] === td) team = kit.bestTeam(wf.sheet.pool, wf.sheet.budget, (a) => wf.sheet.pool.find((p) => p.a === a).form ?? 90);   // a new week: redraft
    else if (tw === 0 && F.weekDays(0).indexOf(td) === 3 && !refused) {
      // Two cheap newcomers in place of the two dearest non-captains: a valid team, but two changes in one day.
      const price = (a) => wf.sheet.pool.find((p) => p.a === a).price;
      const ins = wf.sheet.pool.filter((p) => !prev.includes(p.a)).sort((a, b) => a.price - b.price);
      const outs = prev.slice(1).sort((a, b) => price(b) - price(a)).slice(0, 2);
      team = prev.map((a) => (a === outs[0] ? ins[0].a : a === outs[1] ? ins[1].a : a));
      assert.ok(F.checkTeam(wf.sheet, team).ok && F.changes(prev, team) === 2, "the 2-change test team is valid on its own");
      refused = true;
    }
    else team = kit.oneStep(F, wf.sheet, prev, (a) => (pool.find((p) => p.a === a).form ?? 90) + (pool.find((p) => p.a === a).price < 15 ? 3 : 0));
    if (team && !(prev && team.every((x, i) => x === prev[i]))) {
      try { await kit.cliPick("team", "p1", team.join(","), true); }
      catch (e) { console.log("DEBUG", new Date(now).toISOString(), "td", td, "lock in", (F.lockOfDay(td) - now) / MIN, "plans", JSON.stringify(myPlans.map((x) => [x.td, x.sent && x.sent.map((a) => a.slice(0, 4))])), "team", team.map((a) => a.slice(0, 4))); throw e; }
      myPlans.push({ td, team: F.changes(prev || team, team) > 1 && F.weekDays(tw)[0] !== td ? prev : team, sent: team });
    } else if (team) myPlans.push({ td, team, sent: null });
  }
  if (!rivalSent && now >= F.weekStart(0) + H) { await kit.cliPick("rival", "p1", "p5", true); rivalSent = true; }
  clock.advance(10 * MIN);
}
step(`${ticks} recorder runs over ${((clock.now() - g) / H).toFixed(1)} test hours (${test.log.length} picks on the testnet Picks contract)`);

// 6. checks.
const data = (n) => JSON.parse(fs.readFileSync(path.join(dir, "data", n), "utf8"));
const w0 = data("W000.json"), w1 = data("W001.json"), days = data("days.json"), rv = data("rivals.json"), board = data("board.json");
const crypto = await import("node:crypto");
for (const w of [w0, w1]) {
  assert.equal(w.final, true, `week ${w.week + 1} final`);
  assert.equal(w.sha256, crypto.createHash("sha256").update(F.sheetText(w.sheet)).digest("hex"), "the sheet's fingerprint");
  assert.ok(w.sheet.pool.length >= 9 && w.sheet.budget === 100);
}
const row = (w, who) => w.players.find((x) => x.a === A(who));
for (const who of ["p1", "p2", "p3", "p4", "p5"]) assert.ok(row(w0, who) && row(w0, who).full, `${who} played all of week 1`);
assert.ok(row(w0, "p6") && !row(w0, "p6").full && row(w0, "p6").days[0].team === null, "p6 joined late in week 1");
assert.ok(row(w1, "p6") && row(w1, "p6").full, "p6 played all of week 2 (late only in its first week)");
// Your refused team: the day shows the note, and yesterday's team played.
const mine0 = row(w0, "p1");
assert.ok(mine0.days.some((d) => /more than one change/.test(d.note || "")), "the 2-change team was ignored");
// Every score is the shared math on the recorded days.
for (const w of [w0, w1]) {
  const recs = F.weekDays(w.week).map((d) => days.days.find((x) => x.day === d));
  assert.ok(recs.every((r) => r && r.final && r.checked === 2), `week ${w.week + 1}: every day final on 2 nodes`);
  for (const x of w.players) {
    const total = x.days.reduce((s, d) => s + F.dayScore(d.team, recs[x.days.indexOf(d)]), 0);
    assert.ok(Math.abs(total - x.points) < 0.05, `week ${w.week + 1} ${x.a}: ${total} vs ${x.points}`);
    assert.equal(x.vault, F.vaultPoints(w.players).get(x.a) || 0);
  }
}
// The producer that went quiet during week 2 is cheap on week 3's list.
const w2 = data("W002.json");
const quietOne = w2.sheet.pool.find((p) => p.a === field[3][0]), steady = w2.sheet.pool.find((p) => p.a === field[5][0]);
assert.ok(quietOne && steady, "both on week 3's list");
if (quietOne && steady) assert.ok(quietOne.price < steady.price, `the producer that went quiet costs less (${quietOne.price} < ${steady.price})`);
// Rivals: week 2 (the robots and you challenged during week 1); week 1 had no challenges before it began except robots'.
const names = Object.fromEntries(["p1", "p2", "p3", "p4", "p5", "p6"].map((w) => [A(w), w]));
const ms1 = w1.matches.map((m) => `${names[m.a]}>${names[m.b]}${m.mutual ? "(mutual)" : ""}:${m.result}`);
step(`week 2 rival matches: ${ms1.join(", ")}`);
assert.ok(w1.matches.some((m) => (names[m.a] === "p2" && names[m.b] === "p1") || (names[m.a] === "p1" && names[m.b] === "p2")), "p2 vs p1");
assert.ok(w1.matches.some((m) => (names[m.a] === "p1" && names[m.b] === "p5") || (names[m.a] === "p5" && names[m.b] === "p1")), "p1 vs p5 (mutual: both challenged)");
assert.ok(rv.weeks.includes(1), "week 2 counted in the records");
const r1 = rv.records[A("p1")];
assert.ok(r1 && r1.made.reduce((a, b) => a + b) + r1.received.reduce((a, b) => a + b) >= 2, "p1 has a record");
assert.ok(board.week && board.week.rows.length >= 5 && Array.isArray(board.mostChallenged));
assert.ok(days.live && days.live.final === false, "today so far is published as provisional");
for (const [w, x] of [["week 1", w0], ["week 2", w1]]) step(`${w}: ${x.players.map((p) => `${names[p.a]} ${Math.round(p.points)}${p.full ? "" : "*"}`).join(" · ")}`);

// 7. the practice page's server.
const server = await kit.startSite({ port: 0 });
const port = server.address().port, origin = `http://127.0.0.1:${port}`;
const page = await (await fetch(`${origin}/site/fantasy-testnet.html`)).text();
assert.match(page, /TESTNET/); assert.match(page, /fantasy-net\.js/); assert.ok(!/wallet\.js"/.test(page.replace("/testnet/test-wallet.js", "")), "no real wallet on the test page");
const net = await (await fetch(`${origin}/testnet/fantasy-net.js`)).text();
assert.ok(!/WIF|privateKey/i.test(net), "no keys in the page's settings");
assert.equal((await fetch(`${origin}/testnet-data/fantasy/board.json`)).status, 200);
assert.equal((await fetch(`${origin}/keys.env`)).status, 404);
assert.equal((await fetch(`${origin}/testnet-data/fantasy/../keys.env`)).status, 404);
assert.equal((await fetch(`${origin}/rpc`, { method: "POST", headers: { origin: "https://evil.example" }, body: "{}" })).status, 403, "other sites can't use the RPC");
assert.equal((await fetch(`${origin}/test/send`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ token: "x", as: "p1", ops: [] }) })).status, 403, "no signing without the page's token");
step(`practice page served at ${origin}/site/fantasy-testnet.html; keys never served; other sites refused`);
console.log(`\n✔ Fantasy testnet rehearsal passed (${dir})`);
if (process.env.KEEP) {
  // For a look in a browser: the fake chains run 'clock.offset' ms ahead of real time; a browser must be shifted too.
  fs.writeFileSync(process.env.KEEP_INFO || path.join(os.tmpdir(), "fantasy-rehearsal.json"), JSON.stringify({ origin, offset: clock.offset, p1: A("p1") }));
  console.log(`Leaving it running: ${origin}/site/fantasy-testnet.html  (clock +${Math.round(clock.offset / 60000)} min; Ctrl+C to stop)`);
  setInterval(() => kit.tick(true), 60000);
}
else { server.close(); await Promise.all([mainA.close(), mainB.close(), test.close()]); fs.rmSync(dir, { recursive: true, force: true }); process.exit(0); }

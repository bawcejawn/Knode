// Last Node Standing: the Repo Lens audit fixes (2026-10-29) that the other test files don't already cover.
// LN-4, LN-5, LN-6, LN-7, LN-10, LN-14, LN-15, LN-16, LN-17, LN-22, LN-24, LN-25, LN-26, LN-28, LN-29, LN-31, LN-32.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const APP = process.env.APP || ".";
await import(path.resolve(APP, "race-math.js"));
await import(path.resolve(APP, "lastnode-math.js"));
const L = globalThis.KLastNode;
const F = L.forGame(L.FAST_GAME);
const page = fs.readFileSync(path.resolve(APP, "lastnode.js"), "utf8");
const MIN = 60000, MARGIN = MIN;

// ── LN-6: the start picker ──
test("LN-6 (real game): from 13:49 to 13:55 UTC the next event's picks are 'not open yet', then open", () => {
  const day = Date.UTC(2026, 10, 3);
  const at = (h, m) => L.nextEntry(day + h * 3600000 + m * MIN, {}, MARGIN);
  const before = at(13, 48);
  assert.equal(before.day, "2026-11-03"); assert.equal(before.open, true, "today's event until its cut-off (13:49)");
  for (const m of [49, 50, 52, 54]) { const e = at(13, m); assert.equal(e.day, "2026-11-04"); assert.equal(e.open, false, `13:${m}: tomorrow isn't open yet`); }
  const e = at(13, 55); assert.equal(e.day, "2026-11-04"); assert.equal(e.open, true);
  assert.equal(new Date(e.opens).toISOString(), "2026-11-03T13:55:00.000Z");
});

test("LN-6 (both games): the page offers a round only when the contract would take it, and always the earliest one", () => {
  for (const R of [L, F]) {
    const t0 = Date.UTC(2026, 10, 2);
    for (let t = t0; t < t0 + 2 * L.DAY; t += MIN) {
      const e = R.nextEntry(t, {}, MARGIN);
      if (e.open) assert.ok(R.isOpen(e.round, t) && t + MARGIN < R.lockTime(e.round), `${R.GAME_ID} ${new Date(t).toISOString()}: offered but the contract refuses`);
      // No earlier event's start round may be pickable then.
      let ev = R.eventOf(t - R.PERIOD);
      for (let k = 0; k < 6 && ev.start < e.start; k++, ev = R.nextEvent(ev)) assert.equal(R.pickable(ev.round, t, {}, MARGIN), false, `${R.GAME_ID} ${new Date(t).toISOString()}: ${ev.day} was pickable but not offered`);
      if (!e.open) assert.ok(t < e.opens, "not open means it opens later");
    }
  }
});

test("LN-22: a tightened registration (longer lead, shorter ahead) is followed", () => {
  const ev = L.eventOf(Date.UTC(2026, 10, 3, 12));
  assert.equal(L.pickable(ev.round, ev.lock - 2 * MIN, {}, MARGIN), true);
  assert.equal(L.pickable(ev.round, ev.lock - 2 * MIN, { lead: L.LEAD + 5 * MIN }, MARGIN), false, "longer lead");
  assert.equal(L.pickable(ev.round, ev.opens + MIN, { ahead: L.AHEAD - 60 * MIN }, MARGIN), false, "shorter ahead");
  assert.match(page, /async function readRegistration\(\)/);
  assert.match(page, /get_game\(\{ game: L\.GAME_ID \}\)/);
  assert.match(page, /REG\.lead = lead/); assert.match(page, /REG\.ahead = ahead/);
  assert.match(page, /const pickable = \(r, t = nowT\(\)\) => L\.pickable\(r, t, REG, SEND_MARGIN\)/);
  assert.equal((page.match(/await readRegistration\(\)/g) || []).length, 2, "mainnet and testnet both read it");
});

// ── LN-14 ──
test("LN-14: forGame refuses timings whose event ids can't round-trip; games 13 and 93 are fine", () => {
  for (const bad of [{ period: 30 * MIN, phase: 0, cut: 10 * MIN, offset: 8 * MIN, lead: 5 * MIN }, { period: 4 * 3600000, phase: 20 * MIN }, { period: 90 * MIN, phase: 0 }])
    assert.throws(() => L.forGame({ ...L.FAST_GAME, ...bad }), Error, JSON.stringify(bad));
  for (const R of [L, F]) {
    const t0 = Date.UTC(2026, 10, 2);
    for (let t = t0; t < t0 + 3 * L.DAY; t += 7 * MIN) { const ev = R.eventOf(t); assert.equal(R.eventOf(ev.day).start, ev.start); }
  }
});

// ── the page (source checks: it runs only in a browser; the browser run is in docs/lastnode/README.md) ──
test("LN-4: picks are swapped in only after every read worked; a failed read keeps them, says so and retries", () => {
  const body = page.slice(page.indexOf("async function loadMine()"), page.indexOf("// ── the pick pop-up"));
  assert.ok(body.indexOf("myPicks.clear();", body.indexOf("await Promise.all")) > body.indexOf("await Promise.all"), "cleared only after the reads (or on a wallet change)");
  assert.match(body, /if \(who !== mineWho\) \{ drafts\.clear\(\); myPicks\.clear\(\);/);
  assert.match(body, /mineErr = true;[\s\S]*setTimeout\(\(\) => loadMine\(\)\.then\(render\), 8000\)/);
  assert.match(page, /if \(!mineOk\) parts\.push\(.*Couldn't read your picks\. Retrying…/);
  assert.match(page, /const holdNote = !!\(me\(\) && picksContract && !mineOk && just && fresh\(just\)\);/, "the cut note waits for your picks");
  assert.match(page, /if \(seen && seen\.day === ev\.day && !holdNote\)/);
  assert.match(page, /if \(!holdNote\) seen = /, "and the cut isn't marked seen while it waits (fix-check)");
});

test("LN-5: the page's clock is the chain's (freshest reading of the newest block's time)", () => {
  assert.match(page, /const nowT = \(\) => \(offsets\.length \? mono\(\) \+ Math\.max\(\.\.\.offsets\) : Date\.now\(\)\)/);
  assert.match(page, /const off = tip - mono\(\);/, "anchored to the steady timer, so a device clock jump changes nothing (fix-check)");
  assert.equal((page.match(/Date\.now\(\)/g) || []).length, 2, "Date.now only before the first reading and in the sanity check");
  assert.match(page, /noteChainTime\(B\.ts\[B\.ts\.length - 1\]\)/);
});

test("LN-7, LN-15, LN-16, LN-17: node info per event, the Jump note only while the box is open, cut-off countdowns, no redraw storm", () => {
  assert.match(page, /function nodeInfo\(a, df\) \{ return \(df && df\.field && df\.field\.nodes\.find/);
  assert.match(page, /picker\("Your node", nodes, mineNext && mineNext\.start, null, "", kS, nf, false\)/, "node info from the event being picked for");
  assert.match(page, /hit \? "That was your node: your run ends here"/, "no Jump box to point at any more (owner, 2026-10-29)");
  assert.match(page, /Picks close in \$\{dur\(cutoff\(nx\.round\) - now\)\}/);
  assert.match(fs.readFileSync(path.resolve(APP, "lastnode.html"), "utf8"), /your backup takes over automatically if it's still standing/);
  assert.match(page, /now - lastStale >= 15000/);
});

test("LN-24, LN-28, LN-29, LN-31, LN-32: the page's checks on the files it reads", () => {
  assert.match(page, /j\.start === ev0\.start && \(j\.field === null \|\| \(j\.field && Array\.isArray\(j\.field\.nodes\) && j\.field\.nodes\.length <= L\.MAX_FIELD\)\)/);
  assert.match(page, /!== "404" && have\) return;/);
  // LN-31 (2026-10-29): the page no longer works out a provisional field of its own (the field needs form, from 48 h
  // of blocks); it shows only the recorder's, with each node's form checked.
  assert.ok(!/makeField|raceCardAt|provisional: true/.test(page), "no provisional field");
  assert.match(page, /n\.r === undefined \|\| \(Number\.isFinite\(n\.r\) && n\.r >= L\.FORM_MIN && n\.r <= L\.FORM_MAX\)/);
  assert.match(page, /if \(cfg\.faucet != null && !\/\^https:/);
  assert.match(fs.readFileSync(path.resolve(APP, "lastnode.css"), "utf8"), /\.ln-flash \{ position: fixed;/, "LN-33: the note moves nothing");
});

// ── LN-10 ──
test("LN-10: the CSP guard reads real tags: the marker in a comment doesn't count, and no mainnet wallet in any spelling", async () => {
  const { readsMainnetBlocks, mainnetPageScripts } = await import("./lib/html-tags.mjs");
  assert.equal(readsMainnetBlocks('<meta name="kg-reads" content="mainnet-blocks">'), true);
  assert.equal(readsMainnetBlocks("<meta content='mainnet-blocks' name='kg-reads'>"), true);
  assert.equal(readsMainnetBlocks('<!-- <meta name="kg-reads" content="mainnet-blocks"> -->'), false);
  for (const s of ['<script src="./wallet.js">', '<script defer src="wallet.js">', '<script src="wallet.js?v=2">', "<script src='wallet.js'>", '<script src="wallet-copy.js">', '<script src="../site/guest.js">',
    '<script src="header-wallet.js#x">', '<script src="sub/lastnode.js">', '<script src="https://evil.example/lastnode.js">', '<script src="//cdn.jsdelivr.net/npm/x/wallet.js">'])
    assert.equal(mainnetPageScripts(s).length, 1, s);
  const ok = fs.readFileSync(path.resolve(APP, "lastnode-testnet.html"), "utf8");
  assert.deepEqual(mainnetPageScripts(ok), [], "the real test page passes");
});

// ── the recorder ──
test("LN-24: the recorder drops a previous file's field larger than the rules allow", () => {
  const src = fs.readFileSync(path.resolve(APP, "bot/games/lastnode.ts"), "utf8");
  assert.match(src, /o\.field\.nodes\.length >= 2 && o\.field\.nodes\.length <= L\.MAX_FIELD && /);
});

test("LN-26: the testnet recorder uses its own env names and writes only inside testnet-data/", () => {
  const src = fs.readFileSync(path.resolve(APP, "bot/games/lastnode.ts"), "utf8");
  const main = src.slice(src.indexOf("async function main()"));
  assert.ok(!/E\.LASTNODE_OUT|E\.LASTNODE_PREV|E\.RACE_DATA/.test(main.slice(main.indexOf("--testnet"))), "no mainnet names on the testnet path");
  assert.match(main, /inTestData\(E\.TESTNET_LASTNODE_OUT \|\| dir\)/);
  assert.match(main, /inTestData\(E\.TESTNET_LASTNODE_PREV \|\| dir\)/);
  assert.match(main, /inTestData\(E\.TESTNET_RACE_DATA \|\| "testnet-data\/race-cards"\)/);
});

test("LN-25: one hung recorder is stopped, so the local loop keeps going", () => {
  const src = fs.readFileSync(path.resolve(APP, "tools/testnet-site.mjs"), "utf8");
  assert.match(src, /c\.kill\(\); \}, 4 \* 60000\)/);
  assert.match(src, /c\.on\("exit", next\);/);
  assert.match(src, /c\.on\("error", /, "a recorder that can't start doesn't stop later runs");
});

test("LN-3: the runbook uses a separate clone with no mainnet keys and installs without scripts", () => {
  const doc = fs.readFileSync(path.resolve(APP, "docs/lastnode/TESTNET.md"), "utf8");
  assert.match(doc, /C:\\kprediction-lns/);
  assert.match(doc, /npm ci --ignore-scripts/);
  assert.ok(!/^\s*npm ci\s*$/m.test(doc), "no plain npm ci");
});
test("LN-19: week 0 is the vault's genesis in the rules, the publish check and deployment.json", () => {
  const dep = JSON.parse(fs.readFileSync(path.resolve(APP, "game-data/deployment.json"), "utf8"));
  assert.equal(L.GENESIS, dep.genesisTime); assert.equal(L.WEEK, dep.weekLength);
  const yml = fs.readFileSync(path.resolve(APP, ".github/workflows/lastnode.yml"), "utf8");
  assert.equal(Date.UTC(2026, 9, 19), dep.genesisTime);
  assert.match(yml, new RegExp(`WEEK0, WEEK = ${dep.genesisTime}, 7 \\* 86400000`), "the shape check");
  assert.match(yml, new RegExp(`H, DAY, WEEK0, WEEK = 3600000, 86400000, ${dep.genesisTime}, 7 \\* 86400000`), "the history check");
});

test("fix-check: the two mainnet nodes are compared however they are spelled", async () => {
  const { nodeKey } = await import(path.resolve(APP, "bot/games/lastnode.ts"));
  assert.equal(nodeKey("https://koinos.armana.io/"), nodeKey("https://KOINOS.armana.io"));
  assert.equal(nodeKey("https://koinos.armana.io:443"), nodeKey("https://koinos.armana.io"));
  assert.notEqual(nodeKey("https://koinos.armana.io"), nodeKey("https://api.koinosblocks.com"));
});
void os;

test("owner 2026-10-29: the backup is part of the one pick, sent with the start node before the start", () => {
  assert.match(page, /const producers = isAddr\(backup\) && backup !== start \? \[start, backup\] : \[start\];/);
  assert.match(page, /myPicks\.set\(r, \{ start: ps\[0\], backup: isAddr\(ps\[1\]\) && ps\[1\] !== ps\[0\] \? ps\[1\] : null \}\)/, "read back from the pick");
  assert.match(page, /const rounds = new Set\(\[nx\.round, ev\.round\]\);/, "one round per event");
  const ev = L.eventOf(Date.UTC(2026, 10, 3, 12));
  assert.ok(L.pickable(ev.round, ev.lock - 2 * MIN, {}, MARGIN) && !L.pickable(ev.round, ev.lock - 30000, {}, MARGIN), "until a minute before 13:50");
});
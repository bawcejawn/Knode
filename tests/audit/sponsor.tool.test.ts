// The Mana sponsor tool (bot/sponsor.ts): the config it builds and the website "payer" switch.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildConfig, setPayer, syncSiteLimits, DEFAULT_CAPS, SPONSOR_SHA256, SPONSOR_V3_CANDIDATE, allowedBuilds } from "../../bot/sponsor.ts";
import { summarize, suggest, merge, checkRows, siteMap, chainRows, key } from "../../bot/mana-limits.ts";

const GAME = { contract: "1Mpmf2ERhjYpX7CCiM11WERuM4j17uT1sr", vhp: "12Y5vW6gk8GceH53YfRkRre2Rrcsgw7Naq", koin: "19GYjDBVXU7keLbYvMLazsGQn3GTWHjHkK" };
const DESK = { contract: "1FKTpXBhhHEbu5vVchM8UsVbAvPArJsRmR", vhp: GAME.vhp, koin: GAME.koin };

test("the default caps are in order and convert to chain units", () => {
  const c = buildConfig(GAME, DESK, DEFAULT_CAPS, true);
  assert.equal(c.game, GAME.contract);
  assert.equal(c.desk, DESK.contract);
  assert.deepEqual(c.tokens, [GAME.vhp, GAME.koin]);
  assert.equal(c.max_mana_per_tx, "100000000");
  // Owner's decisions 2026-10-28: 50 a day and 300 a week per player; 5,000 for everyone a day, of which free players
  // share at most 2,000 (staked players always have 3,000 or more). 1 Mana per transaction stays the ceiling.
  assert.equal(c.max_mana_per_account_day, "5000000000");
  assert.equal(c.max_mana_per_account_week, "30000000000");
  assert.equal(c.max_mana_per_day, "500000000000");
  assert.equal(c.max_mana_free_day, "200000000000");
  // Only real players (audit M-1): VHP is the token checked, at least 1 VHP by default.
  assert.equal(c.vhp, GAME.vhp);
  assert.equal(c.min_vhp, "100000000");
});

test("the race picks contract is passed through when set, and must not be another Knode contract or a token", () => {
  const RACE = "15CM9Qr4GKREDgqnyXJ8tckPj2biERTM1T";
  assert.equal(buildConfig(GAME, DESK, DEFAULT_CAPS, true, RACE).race, RACE);
  assert.equal("race" in buildConfig(GAME, DESK, DEFAULT_CAPS, true), false);
  for (const bad of [GAME.contract, DESK.contract, GAME.vhp, GAME.koin]) assert.throws(() => buildConfig(GAME, DESK, DEFAULT_CAPS, true, bad), /race contract must differ/);
});

test("a VHP minimum of 0 is refused (empty wallets would be sponsored)", () => {
  assert.throws(() => buildConfig(GAME, DESK, { ...DEFAULT_CAPS, minVhp: "0" }, true), /VHP minimum/);
  assert.equal(buildConfig(GAME, DESK, { ...DEFAULT_CAPS, minVhp: "25" }, true).min_vhp, "2500000000");
});

test("upload only accepts the audited build, and that is the build in the repo's README", () => {
  assert.match(SPONSOR_SHA256, /^[0-9a-f]{64}$/);
  assert.ok(fs.readFileSync("sponsor/README.md", "utf8").includes(SPONSOR_SHA256), "README Build line = the pinned build");
  const src = fs.readFileSync("bot/sponsor.ts", "utf8");
  // Mainnet takes only the audited build; the v3 candidate may go only on the testnet until it is audited.
  assert.match(src, /allowedBuilds\(mainnet\)/);
  assert.deepEqual(allowedBuilds(true), [SPONSOR_SHA256]);
  assert.ok(allowedBuilds(false).includes(SPONSOR_V3_CANDIDATE));
  assert.notEqual(SPONSOR_V3_CANDIDATE, SPONSOR_SHA256);
  assert.match(src, /call override is ON/);
  assert.match(src, /upload override is ON/);
});

test("caps out of order, too large, or zero while on are refused before anything is signed", () => {
  assert.throws(() => buildConfig(GAME, DESK, { perTx: "6", perPlayerDay: "5", perPlayerWeek: "20", perDay: "50" }, true), /Caps must be/);
  assert.throws(() => buildConfig(GAME, DESK, { perTx: "1", perPlayerDay: "30", perPlayerWeek: "20", perDay: "50" }, true), /Caps must be/);
  assert.throws(() => buildConfig(GAME, DESK, { perTx: "1", perPlayerDay: "60", perPlayerWeek: "100", perDay: "50" }, true), /Caps must be/);
  assert.throws(() => buildConfig(GAME, DESK, { perTx: "1", perPlayerDay: "5", perPlayerWeek: "20", perDay: "5001" }, true), /5,000/);
  assert.throws(() => buildConfig(GAME, DESK, { perTx: "0", perPlayerDay: "5", perPlayerWeek: "20", perDay: "50" }, true), /refuse everything/);
  assert.doesNotThrow(() => buildConfig(GAME, DESK, { perTx: "0", perPlayerDay: "0", perPlayerWeek: "0", perDay: "0", minVhp: "1" }, false));
});

test("the free-answers cap: never above everyone's daily cap; defaults to 500 or the daily cap if lower; 0 = off", () => {
  assert.throws(() => buildConfig(GAME, DESK, { ...DEFAULT_CAPS, perDay: "100", freePerDay: "101" }, true), /free-player daily cap/);
  assert.equal(buildConfig(GAME, DESK, { perTx: "1", perPlayerDay: "5", perPlayerWeek: "30", perDay: "100" }, true).max_mana_free_day, "10000000000");
  assert.equal(buildConfig(GAME, DESK, { ...DEFAULT_CAPS, freePerDay: "0" }, true).max_mana_free_day, "0");
});

function files(withSponsor: boolean) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "sp-"));
  const f = { game: path.join(d, "g.json"), desk: path.join(d, "d.json"), state: path.join(d, "s.json") };
  fs.writeFileSync(f.game, JSON.stringify(GAME));
  fs.writeFileSync(f.desk, JSON.stringify(DESK));
  if (withSponsor) fs.writeFileSync(f.state, JSON.stringify({ address: "1AZsVFFrvKFhhxLq2jKHUUesdm2zbCcbXW" }));
  return f;
}
const read = (f: string) => JSON.parse(fs.readFileSync(f, "utf8"));

test("payer sponsor writes the same sponsor block into both deployment files", () => {
  const f = files(true);
  setPayer("sponsor", "0.5", f);
  for (const x of [read(f.game), read(f.desk)]) {
    assert.equal(x.payer, "sponsor");
    assert.equal(x.sponsor.address, "1AZsVFFrvKFhhxLq2jKHUUesdm2zbCcbXW");
    assert.deepEqual(x.sponsor.covers, [GAME.contract, DESK.contract, GAME.vhp, GAME.koin]);
    assert.deepEqual(x.sponsor.tokens, [GAME.vhp, GAME.koin]);
    assert.equal(x.sponsor.rcLimit, "50000000");
  }
});

test("payer self switches the website back to players' own Mana", () => {
  const f = files(true);
  setPayer("sponsor", "1", f);
  setPayer("self", "1", f);
  assert.equal(read(f.game).payer, "self");
  assert.equal(read(f.desk).payer, "self");
});

test("payer sponsor is refused before the sponsor is uploaded", () => {
  const f = files(false);
  assert.throws(() => setPayer("sponsor", "1", f), /no sponsor yet/);
  assert.equal(read(f.game).payer, undefined);
});

test("audit L-4: an unset free cap defaults to 300 but never above everyone's daily cap; an explicit 0 stays 0", () => {
  const c = buildConfig(GAME, DESK, { perTx: "1", perPlayerDay: "5", perPlayerWeek: "30", perDay: "200" }, true);
  assert.equal(c.max_mana_free_day, "20000000000");
  const z = buildConfig(GAME, DESK, { perTx: "1", perPlayerDay: "5", perPlayerWeek: "30", perDay: "1000", freePerDay: "0" }, false);
  assert.equal(z.max_mana_free_day, "0");
});

test("v3: the Picks contract is allowlisted as free play in the Picks argument shape, and must be a new contract", () => {
  const PICKS = "1MbsVfNw6yzQqA8499d8KQj8qdLyRs8CzW", RACE = "15CM9Qr4GKREDgqnyXJ8tckPj2biERTM1T";
  const c: any = buildConfig(GAME, DESK, DEFAULT_CAPS, true, RACE, PICKS);
  assert.deepEqual(c.allowed, [{ contract: PICKS, entry_point: 0x8ce33c6c, free_play: true, arg_types: "0x0301010301" }]);
  assert.equal("allowed" in buildConfig(GAME, DESK, DEFAULT_CAPS, true, RACE), false);
  for (const bad of [GAME.contract, DESK.contract, GAME.vhp, GAME.koin, RACE]) assert.throws(() => buildConfig(GAME, DESK, DEFAULT_CAPS, true, RACE, bad), /Picks contract must differ/);
});

// ── the Mana adjuster (bot/mana-limits.ts, owner 2026-10-28) ──
const PICKS_C = "1MbsVfNw6yzQqA8499d8KQj8qdLyRs8CzW", PICK_E = 0x8ce33c6c, ANSWER_E = 0x0db52f40;
const sat = (m: number) => BigInt(Math.round(m * 1e8));
test("adjuster: groups measured use by action; batches count per operation; reverted and mixed transactions are skipped", () => {
  const st = summarize([
    { contract: PICKS_C, entry: PICK_E, rcUsed: sat(0.0477), ops: 1, reverted: false },
    { contract: PICKS_C, entry: PICK_E, rcUsed: sat(0.2197), ops: 7, reverted: false },
    { contract: PICKS_C, entry: PICK_E, rcUsed: sat(0.9), ops: 1, reverted: true },
    { contract: GAME.contract, entry: ANSWER_E, rcUsed: sat(0.31), ops: 1, reverted: false },
  ], { [key(PICKS_C, PICK_E)]: "KnodeGames Picks pick" });
  const p = st.find((x) => x.entry === PICK_E)!;
  assert.equal(p.name, "KnodeGames Picks pick");
  assert.equal(p.count, 2);
  assert.equal(p.maxSat, sat(0.0477), "the most one pick used (the reverted one doesn't count)");
  assert.equal(st.find((x) => x.entry === ANSWER_E)!.maxSat, sat(0.31));
});
test("adjuster: limit = 1.5 × the most used, at least 0.02, rounded up to 0.01, at most the per-transaction cap", () => {
  assert.equal(suggest(sat(0.0477), sat(1)), sat(0.08));
  assert.equal(suggest(sat(0.001), sat(1)), sat(0.02), "floor");
  assert.equal(suggest(sat(0.9), sat(1)), sat(1), "never above the per-transaction cap");
});
test("adjuster: refuses a limit that could make transactions fail (below 1.25 × the most used), 0, too high, or twice", () => {
  const row = (max_mana: bigint, observedMax?: bigint) => ({ name: "pick", contract: PICKS_C, entry_point: PICK_E, max_mana: max_mana.toString(),
    ...(observedMax ? { observed: { count: 5, max: observedMax.toString(), typical: observedMax.toString(), source: "test", at: "" } } : {}) });
  assert.throws(() => checkRows([row(sat(0.059), sat(0.0477))], sat(1)), /too tight/);
  assert.doesNotThrow(() => checkRows([row(sat(0.06), sat(0.0477))], sat(1)));
  assert.throws(() => checkRows([row(0n)], sat(1)), /above 0/);
  assert.throws(() => checkRows([row(sat(2))], sat(1)), /per-transaction cap/);
  assert.throws(() => checkRows([row(sat(0.1)), row(sat(0.2))], sat(1)), /twice/);
});
test("adjuster: a new report never lowers a limit below what was seen before, and keeps actions it didn't see", () => {
  const first = merge([], [{ contract: PICKS_C, entry: PICK_E, name: "pick", count: 3, maxSat: sat(0.08), typicalSat: sat(0.05) }], sat(1), "a", "t1");
  assert.equal(first[0].max_mana, sat(0.12).toString());
  const second = merge(first, [{ contract: PICKS_C, entry: PICK_E, name: "pick", count: 3, maxSat: sat(0.03), typicalSat: sat(0.03) }], sat(1), "b", "t2");
  assert.equal(second[0].max_mana, sat(0.12).toString(), "the older maximum still counts");
  assert.equal(second[0].observed!.count, 6);
  const third = merge(second, [{ contract: GAME.contract, entry: ANSWER_E, name: "answer", count: 1, maxSat: sat(0.3), typicalSat: sat(0.3) }], sat(1), "c", "t3");
  assert.equal(third.length, 2, "the pick row stays");
});
test("adjuster: the limits go on chain (mana_caps) and into the website's sponsor block (rcLimits)", () => {
  const rows = merge([], [{ contract: PICKS_C, entry: PICK_E, name: "pick", count: 3, maxSat: sat(0.0477), typicalSat: sat(0.04) }], sat(1), "t", "t");
  const c: any = buildConfig(GAME, DESK, DEFAULT_CAPS, true, undefined, undefined, rows);
  assert.deepEqual(c.mana_caps, chainRows(rows));
  assert.deepEqual(chainRows(rows)[0], { contract: PICKS_C, entry_point: PICK_E, max_mana: sat(0.08).toString() });
  assert.deepEqual(siteMap(rows), { [`${PICKS_C}:8ce33c6c`]: sat(0.08).toString() });
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "sp-")), g = path.join(d, "g.json"), k = path.join(d, "k.json");
  fs.writeFileSync(g, JSON.stringify({ contract: "x", sponsor: { address: "s" } })); fs.writeFileSync(k, JSON.stringify({ contract: "y" }));
  assert.equal(syncSiteLimits(rows, { game: g, desk: k }), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(g, "utf8")).sponsor.rcLimits, siteMap(rows));
  assert.equal(JSON.parse(fs.readFileSync(k, "utf8")).sponsor, undefined, "a file without a sponsor block is left alone");
  assert.throws(() => buildConfig(GAME, DESK, { ...DEFAULT_CAPS, perTx: "0.05", perPlayerDay: "50" }, true, undefined, undefined, rows), /per-transaction cap/);
});

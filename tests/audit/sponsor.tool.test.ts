// The Mana sponsor tool (bot/sponsor.ts): the config it builds and the website "payer" switch.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildConfig, setPayer, syncSiteLimits, DEFAULT_CAPS, SPONSOR_SHA256, SPONSOR_V3_CANDIDATE, allowedBuilds } from "../../bot/sponsor.ts";
import { summarize, suggest, merge, checkRows, siteMap, chainRows, key, transitionRows, siteFits } from "../../bot/mana-limits.ts";

const GAME = { contract: "1Mpmf2ERhjYpX7CCiM11WERuM4j17uT1sr", vhp: "12Y5vW6gk8GceH53YfRkRre2Rrcsgw7Naq", koin: "19GYjDBVXU7keLbYvMLazsGQn3GTWHjHkK" };
const DESK = { contract: "1FKTpXBhhHEbu5vVchM8UsVbAvPArJsRmR", vhp: GAME.vhp, koin: GAME.koin };

test("the default caps are in order and convert to chain units", () => {
  const c = buildConfig(GAME, DESK, DEFAULT_CAPS, true);
  assert.equal(c.game, GAME.contract);
  assert.equal(c.desk, DESK.contract);
  assert.deepEqual(c.tokens, [GAME.vhp, GAME.koin]);
  assert.equal(c.max_mana_per_tx, "100000000");
  // Owner's decisions: 25 a day and 150 a week per wallet, free or staked (2026-10-29); 5,000 for everyone a day, of
  // which free wallets share at most 2,000 (2026-10-28). 1 Mana per transaction stays the ceiling.
  assert.equal(c.max_mana_per_account_day, "2500000000");
  assert.equal(c.max_mana_per_account_week, "15000000000");
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

test("payer sponsor: the game pages ask the sponsor; Knode Swap never does (owner 2026-10-29, audit SP-24)", () => {
  const f = files(true);
  setPayer("sponsor", "0.5", f);
  const x = read(f.game);
  assert.equal(x.payer, "sponsor");
  assert.equal(x.sponsor.address, "1AZsVFFrvKFhhxLq2jKHUUesdm2zbCcbXW");
  assert.deepEqual(x.sponsor.covers, [GAME.contract, GAME.vhp, GAME.koin]);
  assert.ok(!x.sponsor.covers.includes(DESK.contract), "the swap desk is not covered");
  assert.deepEqual(x.sponsor.tokens, [GAME.vhp, GAME.koin]);
  assert.equal(x.sponsor.rcLimit, "50000000");
  const d = read(f.desk);
  assert.equal(d.payer, "self");
  assert.equal(d.sponsor, undefined);
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
  assert.deepEqual(c.allowed, [{ contract: PICKS, entry_point: 0x8ce33c6c, free_play: true, arg_types: "0x0301011301", game_arg: 2 }]);
  assert.equal("allowed" in buildConfig(GAME, DESK, DEFAULT_CAPS, true, RACE), false);
  for (const bad of [GAME.contract, DESK.contract, GAME.vhp, GAME.koin, RACE]) assert.throws(() => buildConfig(GAME, DESK, DEFAULT_CAPS, true, RACE, bad), /Picks contract must differ/);
});

// ── the Mana adjuster (bot/mana-limits.ts, owner 2026-10-28; hardened after the review the same day) ──
const PICKS_C = "1MbsVfNw6yzQqA8499d8KQj8qdLyRs8CzW", PICK_E = 0x8ce33c6c, ANSWER_E = 0x0db52f40;
const sat = (m: number) => BigInt(Math.round(m * 1e8));
const stat = (o: any) => ({ contract: PICKS_C, entry: PICK_E, name: "pick", count: 20, typicalSat: o.maxSat, ...o });
test("adjuster: only single-action transactions are measured (a batch hides the fixed cost); reverted ones don't count", () => {
  const st = summarize([
    { contract: PICKS_C, entry: PICK_E, rcUsed: sat(0.0477), ops: 1, reverted: false },
    { contract: PICKS_C, entry: PICK_E, rcUsed: sat(0.2197), ops: 7, reverted: false },
    { contract: PICKS_C, entry: PICK_E, rcUsed: sat(0.9), ops: 1, reverted: true, rcLimit: sat(1) * 2n },
    { contract: GAME.contract, entry: ANSWER_E, rcUsed: sat(0.31), ops: 1, reverted: false },
  ], { [key(PICKS_C, PICK_E)]: "KnodeGames Picks pick" });
  const p = st.find((x) => x.entry === PICK_E)!;
  assert.equal(p.name, "KnodeGames Picks pick");
  assert.equal(p.count, 1, "the 7-pick batch is not a measurement");
  assert.equal(p.maxSat, sat(0.0477));
  assert.equal(p.ranOut, 0, "reverted with Mana to spare: not a run-out");
});
test("adjuster: a transaction that used all of its limit and reverted 'ran out', and raises that action's limit", () => {
  const st = summarize([{ contract: PICKS_C, entry: PICK_E, rcUsed: sat(0.06), rcLimit: sat(0.06), ops: 1, reverted: true },
    { contract: PICKS_C, entry: PICK_E, rcUsed: sat(0.03), ops: 1, reverted: false }]);
  assert.equal(st[0].ranOut, 1);
  const old = merge([], [stat({ maxSat: sat(0.03) })], sat(1), "a", "t");
  assert.equal(old[0].max_mana, sat(0.06).toString());
  const after = merge(old, st, sat(1), "b", "t");
  assert.equal(after[0].max_mana, sat(0.12).toString(), "at least twice the old limit");
  // Audit SP-7: a run-out with no row of its own ran out at the per-transaction cap: no row (never 0.05 or 2 x lighter ones).
  const skipped: string[] = [];
  assert.deepEqual(merge([], st, sat(1), "c", "t", skipped), []);
  assert.match(skipped[0], /ran out of Mana at the per-transaction cap/);
});
test("adjuster: limit = 2 × the most used (3 × typed in or from the testnet), at least 0.05, at most the per-transaction cap", () => {
  assert.equal(suggest(sat(0.0477), sat(1)), sat(0.1));
  assert.equal(suggest(sat(0.0477), sat(1), true), sat(0.15), "a testnet number gets 3 ×");
  assert.equal(suggest(sat(0.001), sat(1)), sat(0.05), "floor");
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
test("adjuster: a report never lowers a limit, keeps actions it didn't see, and a heavy action gets no row (review L4)", () => {
  const first = merge([], [stat({ maxSat: sat(0.08) })], sat(1), "a", "t1");
  assert.equal(first[0].max_mana, sat(0.16).toString());
  const second = merge(first, [stat({ maxSat: sat(0.03) })], sat(1), "b", "t2");
  assert.equal(second[0].max_mana, sat(0.16).toString(), "never lowered");
  assert.equal(second[0].observed!.count, 40);
  const skipped: string[] = [];
  const third = merge(second, [{ contract: GAME.contract, entry: ANSWER_E, name: "heavy", count: 20, maxSat: sat(0.9), typicalSat: sat(0.9) }], sat(1), "c", "t3", skipped);
  assert.equal(third.length, 1, "the pick row stays; the heavy action has no row (it keeps the 1 Mana cap)");
  assert.match(skipped[0], /heavy: too heavy/);
});
test("adjuster: the website goes first with limits that fit both the old and the new chain rows (review L1)", () => {
  const next = merge([], [stat({ maxSat: sat(0.05) })], sat(1), "a", "t");          // new row 0.1
  assert.deepEqual(siteMap(transitionRows([], next, sat(1))), { [key(PICKS_C, PICK_E)]: sat(0.1).toString() }, "no chain row yet: the new one (below 1)");
  const raised = transitionRows([{ contract: PICKS_C, entry_point: PICK_E, max_mana: sat(0.06).toString() }], next, sat(1));
  assert.equal(raised[0].max_mana, sat(0.06).toString(), "raising: the site keeps the lower old row until the chain has the new one");
  assert.deepEqual(siteFits({ [key(PICKS_C, PICK_E)]: sat(0.2).toString() }, chainRows(next), sat(1)), [key(PICKS_C, PICK_E)], "a site row above the chain's is caught");
  assert.deepEqual(siteFits({ [key(PICKS_C, PICK_E)]: sat(0.1).toString() }, chainRows(next), sat(1)), []);
});
test("adjuster: the limits go on chain (mana_caps) and into the website's sponsor block (rcLimits)", () => {
  const rows = merge([], [stat({ maxSat: sat(0.0477) })], sat(1), "t", "t");
  const c: any = buildConfig(GAME, DESK, DEFAULT_CAPS, true, undefined, undefined, rows);
  assert.deepEqual(c.mana_caps, chainRows(rows));
  assert.deepEqual(chainRows(rows)[0], { contract: PICKS_C, entry_point: PICK_E, max_mana: sat(0.1).toString() });
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "sp-")), g = path.join(d, "g.json"), k = path.join(d, "k.json");
  fs.writeFileSync(g, JSON.stringify({ contract: "x", sponsor: { address: "s" } })); fs.writeFileSync(k, JSON.stringify({ contract: "y" }));
  assert.equal(syncSiteLimits(rows, { game: g, desk: k }), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(g, "utf8")).sponsor.rcLimits, siteMap(rows));
  assert.equal(JSON.parse(fs.readFileSync(k, "utf8")).sponsor, undefined, "a file without a sponsor block is left alone");
  assert.throws(() => buildConfig(GAME, DESK, { ...DEFAULT_CAPS, perTx: "0.05", perPlayerDay: "50" }, true, undefined, undefined, rows), /per-transaction cap/);
});
test("mana-limit refuses an implausibly small number and needs a source (review L3)", () => {
  const src = fs.readFileSync("bot/sponsor.ts", "utf8");
  assert.match(src, /Number\(most\) < 0\.01 && !a\.includes\("--force"\)/);
  assert.match(src, /\|\| !source\)/);
});

test("audit SP-6 / SP-11 / SP-20: no sample from a missing receipt (0 used); too few measurements change nothing; an out-of-resources log is a run-out; exact Mana values", async () => {
  const { MIN_SAMPLES, toMana } = await import("../../bot/mana-limits.ts");
  const st = summarize([{ contract: PICKS_C, entry: PICK_E, rcUsed: 0n, ops: 1, reverted: false }, { contract: PICKS_C, entry: PICK_E, rcUsed: sat(0.02), rcLimit: sat(1), ops: 1, reverted: true, outOfRc: true }]);
  assert.equal(st[0].count, 0, "a transaction with no receipt (0 used) is not a measurement");
  assert.equal(st[0].ranOut, 1, "the receipt said it ran out of resources");
  const skipped: string[] = [];
  assert.deepEqual(merge([], [stat({ count: MIN_SAMPLES - 1, maxSat: sat(0.05) })], sat(1), "a", "t", skipped), []);
  assert.match(skipped[0], /only 19 measured/);
  assert.equal(toMana(4774581n), "0.04774581"); assert.equal(toMana(sat(5)), "5");
});
test("audit SP-8: the deployed site must ask for at most each chain row, its fallback included", async () => {
  const { siteMisfits } = await import("../../bot/mana-limits.ts");
  const rows = [{ contract: PICKS_C, entry_point: PICK_E, max_mana: sat(0.15).toString() }];
  assert.deepEqual(siteMisfits({}, rows, sat(1), sat(1)), [key(PICKS_C, PICK_E)], "the site has no entry: it asks its 1 Mana fallback, above the row");
  assert.deepEqual(siteMisfits({ [key(PICKS_C, PICK_E)]: sat(0.15).toString() }, rows, sat(1), sat(1)), []);
  assert.deepEqual(siteMisfits({ [key(PICKS_C, PICK_E)]: sat(0.2).toString() }, rows, sat(1), sat(1)), [key(PICKS_C, PICK_E)]);
});

test("audit SP-1 / SP-5 / SP-14 / SP-17: config uses the owner's caps, stops on a failed read, checks the code, and the site's other-actions limit fits the cap", async () => {
  const src = fs.readFileSync("bot/sponsor.ts", "utf8");
  const body = src.slice(src.indexOf("async function setConfig("), src.indexOf("/** Copies the per-action limits"));
  assert.match(body, /const base = enabledArg === true \? capsOf\(cur\) : DEFAULT_CAPS;/, "config: the owner's caps; enable: the caps on chain (round 4, SP-39)");
  assert.match(body, /flag\(a, "--per-day", base\.perDay\)/);
  assert.ok(!/fromSat\(cur\.max_mana_per_day, DEFAULT_CAPS/.test(body), "no fallback to what is on chain");
  assert.match(src, /Couldn't read the sponsor's settings from/, "a failed read stops (never 'nothing set': switched off)");
  assert.match(body, /show different sponsor settings/, "two nodes on mainnet");
  assert.match(body, /const stopping = enabledArg === false;/, "disable --send skips the website checks");
  assert.match(body, /V3_BUILDS\.includes\(code\)/);
  assert.match(body, /would drop them\. Nothing was sent/);
  const { siteProblems, usageAlerts } = await import("../../bot/sponsor.ts");
  const p = siteProblems({ game: { sponsor: { rcLimit: "100000000", rcLimitOther: "300000000", rcLimits: {} } }, desk: {} }, [], 100000000n);
  assert.ok(p.some((x: string) => /other actions ask 3 Mana/.test(x)));
  const a = usageAlerts({ used_day: String(4100n * 100000000n) }, { used_day: "0" }, { max_mana_per_day: String(5000n * 100000000n), max_mana_free_day: String(2000n * 100000000n) }, Date.UTC(2026, 10, 2, 12));
  assert.ok(a.some((x: string) => /82% used/.test(x)), "everyone's total over 80%");
  const f = usageAlerts({ used_day: "0" }, { used_day: String(900n * 100000000n) }, { max_mana_per_day: String(5000n * 100000000n), max_mana_free_day: String(2400n * 100000000n) }, Date.UTC(2026, 10, 2, 9, 30));
  assert.ok(f.some((x: string) => /free play has used 90%/.test(x)), "at 09:30, 1,000 of 2,400 is released; 900 used is 90%");
});

test("audit SP-29/SP-30: enable and disable change only the switch, keeping every cap on chain", async () => {
  const { switchedConfig } = await import("../../bot/sponsor.ts");
  const cur = { enabled: true, max_mana_per_tx: "100000000", max_mana_per_account_day: "700000000", max_mana_per_day: "90000000000", max_mana_free_day: "1000000000", min_vhp: "100000000", allowed: [{ contract: "x" }] };
  const off = switchedConfig(cur, false);
  assert.deepEqual({ ...off, enabled: true }, cur);
  assert.equal(off.enabled, false);
  assert.equal(switchedConfig(cur, true).max_mana_per_account_day, "700000000", "a lowered cap stays lowered");
  assert.throws(() => switchedConfig({}, true), /no settings yet/);
});

test("audit SP-31: the watch also warns when the sponsor wallet's own Mana is below what today's caps still allow", async () => {
  const { manaAlerts } = await import("../../bot/sponsor.ts");
  const cfg = { enabled: true, max_mana_per_day: "500000000000" };
  assert.equal(manaAlerts(10n ** 12n, cfg, { used_day: "0" }).length, 0);
  assert.match(manaAlerts(10n ** 10n, cfg, { used_day: "0" })[0], /less than/);
  assert.equal(manaAlerts(10n ** 10n, { ...cfg, enabled: false }, { used_day: "0" }).length, 0);
});

test("owner 2026-10-29: the deployed Knode Swap page asking the sponsor is a website problem (v3 refuses swaps)", async () => {
  const { siteProblems } = await import("../../bot/sponsor.ts");
  const p = siteProblems({ game: { payer: "sponsor", sponsor: {} }, desk: { payer: "sponsor" } }, [], 100000000n);
  assert.ok(p.some((x) => /Knode Swap still asks the sponsor/.test(x)));
  assert.ok(!siteProblems({ game: {}, desk: { payer: "self" } }, [], 100000000n).some((x) => /Knode Swap/.test(x)));
});

test("audit SP-39 (round 4): enable keeps the caps on chain but rebuilds everything else from the files", async () => {
  const { capsOf } = await import("../../bot/sponsor.ts");
  assert.deepEqual(capsOf({ max_mana_per_tx: "100000000", max_mana_per_account_day: "700000000", max_mana_per_account_week: "3000000000", max_mana_per_day: "90000000000", max_mana_free_day: "1000000000", min_vhp: "100000000" }),
    { perTx: "1", perPlayerDay: "7", perPlayerWeek: "30", perDay: "900", minVhp: "1", freePerDay: "10" });
  const src = fs.readFileSync("bot/sponsor.ts", "utf8");
  const body = src.slice(src.indexOf("async function setConfig("), src.indexOf("/** The caps as they are on chain"));
  assert.ok(!/return setSwitch\(rpc, provider, s, A, cur, enabledArg/.test(body), "enable no longer re-sends the chain's settings as they are");
  assert.match(body, /buildConfig\(game, desk, caps, enabled, race/);
});

test("audit SP-37 (round 4): the vault-live setting comes from the game's state, and both nodes must agree", async () => {
  const { vaultLiveOn } = await import("../../bot/sponsor.ts");
  assert.equal(await vaultLiveOn("a", "g", false, async () => false), false);
  assert.equal(await vaultLiveOn("a", "g", false, async () => true), true);
  process.env.RPC_CHECK = "https://b.example";
  let n = 0;
  await assert.rejects(vaultLiveOn("https://a.example", "g", true, async () => (n++ === 0)), /disagree/);
  assert.equal(await vaultLiveOn("https://a.example", "g", true, async () => false), false);
  delete process.env.RPC_CHECK;
});

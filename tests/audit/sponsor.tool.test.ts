// The Mana sponsor tool (bot/sponsor.ts): the config it builds and the website "payer" switch.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildConfig, setPayer, DEFAULT_CAPS, SPONSOR_SHA256 } from "../../bot/sponsor.ts";

const GAME = { contract: "1Mpmf2ERhjYpX7CCiM11WERuM4j17uT1sr", vhp: "12Y5vW6gk8GceH53YfRkRre2Rrcsgw7Naq", koin: "19GYjDBVXU7keLbYvMLazsGQn3GTWHjHkK" };
const DESK = { contract: "1FKTpXBhhHEbu5vVchM8UsVbAvPArJsRmR", vhp: GAME.vhp, koin: GAME.koin };

test("the default caps are in order and convert to chain units", () => {
  const c = buildConfig(GAME, DESK, DEFAULT_CAPS, true);
  assert.equal(c.game, GAME.contract);
  assert.equal(c.desk, DESK.contract);
  assert.deepEqual(c.tokens, [GAME.vhp, GAME.koin]);
  assert.equal(c.max_mana_per_tx, "100000000");
  // A day's 5 answers and 5 race picks; a week's 30 answers and 35 picks (each counts its 1 Mana limit).
  assert.equal(c.max_mana_per_account_day, "1000000000");
  assert.equal(c.max_mana_per_account_week, "6500000000");
  assert.equal(c.max_mana_per_day, "100000000000");
  // Answers for any wallet: those by wallets with no VHP and no stake share 300 of the 1,000 a day.
  assert.equal(c.max_mana_free_day, "30000000000");
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
  assert.match(src, /sha256hex\(wasm\) !== SPONSOR_SHA256/);
  assert.match(src, /call override is ON/);
  assert.match(src, /upload override is ON/);
});

test("caps out of order, too large, or zero while on are refused before anything is signed", () => {
  assert.throws(() => buildConfig(GAME, DESK, { perTx: "6", perPlayerDay: "5", perPlayerWeek: "20", perDay: "50" }, true), /Caps must be/);
  assert.throws(() => buildConfig(GAME, DESK, { perTx: "1", perPlayerDay: "30", perPlayerWeek: "20", perDay: "50" }, true), /Caps must be/);
  assert.throws(() => buildConfig(GAME, DESK, { perTx: "1", perPlayerDay: "60", perPlayerWeek: "100", perDay: "50" }, true), /Caps must be/);
  assert.throws(() => buildConfig(GAME, DESK, { perTx: "1", perPlayerDay: "5", perPlayerWeek: "20", perDay: "1001" }, true), /1,000/);
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

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
  assert.equal(c.max_mana_per_account_day, "500000000");
  assert.equal(c.max_mana_per_account_week, "2000000000");
  assert.equal(c.max_mana_per_day, "100000000000");
  // Only real players (audit M-1): VHP is the token checked, at least 1 VHP by default.
  assert.equal(c.vhp, GAME.vhp);
  assert.equal(c.min_vhp, "100000000");
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

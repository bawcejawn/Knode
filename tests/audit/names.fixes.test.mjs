// The fixes for the Repo Lens names audit (Knode producer-names @ a3423f9) that its own failing tests don't cover.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Signer, utils } from "koilib";
const APP = process.env.APP || ".";
await import(path.resolve(APP, "names.js"));
const R = globalThis.KNames.rules;
const N = await import(path.resolve(APP, "bot/names.ts"));
const now = Date.parse("2026-10-30T12:00:00Z");
const claim = async (s, name, date = "2026-10-30") => R.claimText(name, s.getAddress(), date, utils.encodeBase64url(await s.signMessage(R.message(name, s.getAddress(), date))));

test("PN-17: a claim already published exactly as claimed is answered as accepted, not refused", async () => {
  const s = Signer.fromSeed("pn17"), text = await claim(s, "Blue Harbor");
  const first = await N.verifyIssues(R.emptyDb(), [{ number: 1, body: text }], now, () => true);
  assert.equal(first.results[0].accepted, true);
  const again = await N.verifyIssues(first.db, [{ number: 1, body: text }], now + 900000, () => true);
  assert.deepEqual(again.results[0], { issue: 1, accepted: true, name: "Blue Harbor", address: s.getAddress() });
  assert.equal(again.db, null, "nothing to publish again");
});

test("PN-4: a name that is another wallet's live Koinos nickname is refused, even one never looked up", async () => {
  const s = Signer.fromSeed("pn4"), other = Signer.fromSeed("pn4-other").getAddress();
  const owner = async (n) => (n === "blue-harbor" ? other : null);
  const r = await N.verifyIssues(R.emptyDb(), [{ number: 2, body: await claim(s, "Blue Harbor") }], now, () => true, owner);
  assert.equal(r.results[0].accepted, false);
  assert.match(r.results[0].reason, /Koinos nickname/);
  const mine = await N.verifyIssues(R.emptyDb(), [{ number: 2, body: await claim(s, "Blue Harbor") }], now, () => true, async () => s.getAddress());
  assert.equal(mine.results[0].accepted, true, "your own nickname is fine");
});

test("PN-3: the signature is checked before any chain read", async () => {
  let reads = 0;
  const s = Signer.fromSeed("pn3"), text = (await claim(s, "Blue Harbor")).replace(/Signature: ./, "Signature: A");
  const r = await N.verifyIssues(R.emptyDb(), [{ number: 3, body: text }], now, () => { reads++; return true; });
  assert.equal(r.results[0].accepted, false);
  assert.equal(reads, 0);
});

test("PN-12: eligibility needs every answering node to agree; a node that fails is left out", async () => {
  const mk = (v) => ({ vhp: async () => v, stake: async () => 0n, players: async () => [], nickname: async () => null });
  const down = { ...mk(0n), vhp: async () => { throw new Error("down"); } };
  const a = "1" + "A".repeat(33);
  assert.equal(await N.eligibility(new Set(), [mk(10n ** 8n), mk(10n ** 8n)])(a), true);
  assert.equal(await N.eligibility(new Set(), [mk(10n ** 8n), down])(a), true);
  assert.equal(await N.eligibility(new Set(), [down, down])(a), false);
  assert.equal(await N.eligibility(new Set([a]), [down, down])(a), true, "producers need no read");
});

test("PN-4/PN-10: nicknames() leaves out failed or disagreeing reads; withNicknames keeps or drops by them", async () => {
  const A = "1" + "A".repeat(33), B = "1" + "B".repeat(33), C = "1" + "C".repeat(33);
  const n1 = { vhp: async () => 0n, stake: async () => 0n, players: async () => [], nickname: async (a) => (a === A ? "alpha" : a === B ? "beta" : null) };
  const n2 = { ...n1, nickname: async (a) => (a === A ? "alpha" : a === B ? "other" : null) };
  const got = await N.nicknames(new Set([A, B, C]), [n1, n2]);
  assert.deepEqual(got, { [A]: "alpha", [C]: "" });
  const prev = { v: 1, updated: "", names: {}, hidden: {}, nicknames: { [B]: "beta", [C]: "gone" } };
  const next = N.withNicknames(prev, got, now, new Set([A, B, C]));
  assert.deepEqual(next.nicknames, { [A]: "alpha", [B]: "beta" });
  assert.deepEqual(N.withNicknames(prev, {}, now, new Set([B])).nicknames, { [B]: "beta" }, "wallets no longer looked up are dropped");
});

test("PN-2: owner remove; PN-14: a date more than 14 hours ahead is refused", () => {
  const a = "1" + "A".repeat(33);
  const db = { v: 1, updated: "", hidden: {}, nicknames: {}, names: { [a]: { name: "Blue Harbor", date: "2026-10-29", signature: "H" + "a".repeat(86) + "=" } } };
  assert.deepEqual(R.remove(db, a, now).names, {});
  assert.throws(() => R.remove(R.emptyDb(), a, now), /no name/);
  const c = (date) => ({ name: "Blue Harbor", address: "1" + "B".repeat(33), date, signature: "x" });
  assert.equal(R.precheck(R.emptyDb(), c("2026-10-31"), Date.parse("2026-10-30T12:00:00Z")), null, "tomorrow's date is fine late in the UTC day");
  assert.match(R.precheck(R.emptyDb(), c("2026-10-31"), Date.parse("2026-10-30T02:00:00Z")), /future/);
});

test("PN-13: letter pairs fold (Arnnana, Clara-style lookalikes)", () => {
  assert.equal(R.fold("Arnnana"), R.fold("Armana"));
  assert.equal(R.fold("arrnana"), R.fold("Armana"));
  assert.equal(R.fold("Knocle"), R.fold("Knode"));
  assert.equal(R.checkName("Blocknode"), null);
});

test("PN-16/PN-15/PN-1: the workflow's shape check wants an integer v; the reply answers only listed issues", () => {
  const y = fs.readFileSync(`${APP}/.github/workflows/names.yml`, "utf8");
  assert.match(y, /type\(db\["v"\]\) is int and db\["v"\] == 1/);
  assert.match(y, /claims: \$\{\{ steps\.find\.outputs\.claims \}\}/);
  assert.match(y, /CLAIMS: \$\{\{ needs\.check\.outputs\.claims \}\}/);
  assert.match(y, /-f labels=knode-name/);
});

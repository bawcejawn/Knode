// Repo Lens audit 2026-10-28 (commit 611f63d): the auditor's tests, kept as written except where noted. Each failed
// before the fixes. Two wait for owner decisions (todo): BXW-1 guest play on the shared github.io origin, BXS-1 sybils.
// BXW failing tests (node:test). NOT RUN HERE (static review). Run from the repo root: APP=. node --test bxw.failing.test.mjs
// Each test is expected to FAIL at 611f63d and pass once the matching fix is in.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const APP = process.env.APP || ".";
const read = (f) => fs.readFileSync(`${APP}/${f}`, "utf8");

// BXW-1 (High): guest keys live in plaintext IndexedDB/localStorage on the shared bawcejawn.github.io origin while guest
// play is switched on. Either the site moves to its own origin (canonical no longer *.github.io / a CNAME exists), or
// guest play stays off there, or wallet.js itself refuses guest play on a shared *.github.io host.
test("BXW-1: no guest wallet on a shared *.github.io origin", () => {
  const dep = JSON.parse(read("game-data/deployment.json"));
  const canonical = (read("site/blockx.html").match(/<link rel="canonical" href="([^"]+)"/) || [])[1] || "";
  const shared = /^https:\/\/[^/]+\.github\.io\//.test(canonical) && !fs.existsSync(`${APP}/CNAME`);
  const wallet = read("site/wallet.js");
  const codeRefuses = /github\.io/.test(wallet) && /guestOn|guestReady/.test(wallet) && /hostname[^;]*github\.io/.test(wallet);
  assert.ok(!(shared && dep.sponsor && dep.sponsor.guest === true) || codeRefuses,
    "guest play is on while the site shares the bawcejawn.github.io origin with other projects");
});

// BXW-2 (Low, defence in depth): the mainnet Kondor path should pin the chain id in the transaction and re-check the
// signed header (chain id, Mana limit, operations) like testnet-wallet.js and checkGuestTx already do.
test("BXW-2: Kondor path pins chain id and re-checks the signed transaction", () => {
  const w = read("site/wallet.js");
  const body = w.slice(w.indexOf("async function sendKondorWith"), w.indexOf("// ── Mana sponsor"));
  assert.match(body, /chainId:\s*W\.chainId/, "options carry chainId: W.chainId (not re-read from the node by koilib)");
  assert.match(body, /chain_id\s*!==\s*W\.chainId/, "signed header chain_id is compared to W.chainId");
  assert.match(body, /rc_limit/, "signed header rc_limit is bounded");
  assert.match(body, /operations/, "signed operations are compared to what the page built");
});

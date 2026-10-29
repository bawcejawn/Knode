// Repo Lens audit 2026-10-28 (commit 611f63d): the auditor's tests, kept as written except where noted. Each failed
// before the fixes. Two wait for owner decisions (todo): BXW-1 guest play on the shared github.io origin, BXS-1 sybils.
// BXO-1 — NOT RUN HERE (static review). node:test, run from the repo root after `cd picks && npm ci --ignore-scripts`.
// Fails today: protobufjs's command line (loaded by @koinos/abi-proto-gen during `npm test`) runs util.setup(), which
// `npm install`s every cliDependency it cannot find, unpinned and with install scripts on. tools/pbjs-helpers pins only
// 5 of the 10, so glob, jsdoc, tmp, espree and escodegen are fetched from the registry on every fresh build — on the
// owner's PC, next to .env (OWNER_WIF, OPERATOR_WIF, PICKS_WIF). Also checks the runbooks never run npm ci with scripts on.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (f) => JSON.parse(fs.readFileSync(f, "utf8"));

test("every protobufjs cliDependency is pinned by tools/pbjs-helpers (so setup() never runs npm install)", () => {
  // (adapted: skipped where the contract folders aren't installed, as in CI's root-only jobs)
  if (!fs.existsSync("picks/node_modules/protobufjs/package.json")) return;
  const pb = read("picks/node_modules/protobufjs/package.json");
  const helpers = read("tools/pbjs-helpers/package.json").dependencies;
  const missing = pb.cliDependencies.filter((n) => !(n in helpers));
  assert.deepEqual(missing, [], `fetched unpinned at build time: ${missing.join(", ")}`);
});

test("the runbooks that run on the PC holding the mainnet keys never run npm ci with install scripts on", () => {
  for (const f of ["docs/blockx/MAINNET-LAUNCH.md", "docs/blockx/TESTNET.md"]) {
    const bad = fs.readFileSync(f, "utf8").split("\n").filter((l) => /\bnpm ci\b/.test(l) && !/--ignore-scripts/.test(l));
    assert.deepEqual(bad, [], `${f}: npm ci without --ignore-scripts (glob-promise's postinstall runs npm-install-peers, an unpinned install)`);
  }
});

test("protoc is pinned (config.protocVersion), not 'latest from GitHub' with no checksum", () => {
  const pj = read("picks/package.json");
  assert.ok(pj.config && pj.config.protocVersion, "picks/package.json has no config.protocVersion: @roamin/protoc downloads the latest release");
});

// Added with the fix: every contract folder pins protoc 21.12, and the pinned zips' sha256 are the ones in tools/protoc-pin.cjs.
test("every contract folder pins protoc 21.12 and its prebuild installs it checked", async () => {
  const { createRequire } = await import("node:module");
  const { VERSION, ZIP_SHA256 } = createRequire(import.meta.url)("../../tools/protoc-pin.cjs");
  assert.equal(VERSION, "21.12");
  assert.equal(Object.keys(ZIP_SHA256).length, 6);
  for (const d of ["picks", "sponsor", "game", "desk", "race"]) {
    assert.equal(read(`${d}/package.json`).config?.protocVersion, "21.12", d);
    assert.match(fs.readFileSync(`${d}/scripts/prebuild.cjs`, "utf8"), /protoc-pin\.cjs/, d);
  }
});

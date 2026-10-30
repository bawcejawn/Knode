// C-K-1 failing test — NOT RUN HERE (static review). Place in tests/audit/ and run with node --test.
// Exercises the real tools/pbjs-helpers/install.cjs (the code picks/scripts/prebuild.cjs requires) against a stand-in
// protobufjs cli folder that declares protobufjs 6.11.6's ten cliDependencies. At 32fae49 the script pins only 5 of
// them and returns normally, so `pbjs` (run by @koinos/abi-proto-gen during `npm run build`) would `npm install`
// escodegen, espree, glob, jsdoc and tmp unpinned, with install scripts. On the picks branch (de8bce1, audit BX-6)
// it throws "not pinned here". Expected after the fix: the script throws, or every helper is in pkg.dependencies.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const HELPERS = path.join(ROOT, "tools/pbjs-helpers");
const CLI_DEPS = ["semver", "chalk", "glob", "jsdoc", "minimist", "tmp", "uglify-js", "espree", "escodegen", "estraverse"];

test("every protobufjs cli helper is pinned (BX-6 parity with the picks branch)", () => {
  const pinned = Object.keys(JSON.parse(fs.readFileSync(path.join(HELPERS, "package.json"), "utf8")).dependencies);
  const lock = JSON.parse(fs.readFileSync(path.join(HELPERS, "package-lock.json"), "utf8"));
  const missing = CLI_DEPS.filter((n) => !pinned.includes(n) || !lock.packages[`node_modules/${n}`]);
  assert.deepEqual(missing, [], `unpinned helpers pbjs would npm-install at build time: ${missing.join(", ")}`);
});

test("install.cjs fails closed when protobufjs needs a helper that is not pinned", { skip: !fs.existsSync(path.join(HELPERS, "node_modules/semver")) && "run `npm ci --ignore-scripts` in tools/pbjs-helpers first" }, () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "pbjs-pin-"));
  const cli = path.join(work, "node_modules/protobufjs/cli");
  fs.mkdirSync(cli, { recursive: true });
  fs.writeFileSync(path.join(cli, "..", "package.json"), JSON.stringify({ name: "protobufjs", version: "6.11.6", cliDependencies: CLI_DEPS, devDependencies: {} }));
  let threw = false;
  try { execFileSync(process.execPath, [path.join(HELPERS, "install.cjs")], { cwd: work, stdio: "pipe" }); } catch { threw = true; }
  // At 32fae49 it copies the five it has and exits 0: the other five are left for pbjs to fetch.
  assert.equal(threw || CLI_DEPS.every((n) => fs.existsSync(path.join(cli, "node_modules", n, "package.json"))), true);
});

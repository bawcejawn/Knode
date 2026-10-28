// Builds the TESTNET version of the Picks contract: the audited source with exactly three settings changed, so a whole
// test (announce a game, wait, apply it, hand over ownership, upgrade) fits in an afternoon on the Koinos testnet.
//
//   node scripts/build-testnet.cjs --owner <test owner address> [--timelock-min 10] [--expiry-hours 24]
//   (npm run picks -- build-testnet --testnet runs this with the owner from .env.testnet)
//
// What it proves, in order (it stops at the first thing that isn't right):
//   1. build/release/contract.wasm is the audited mainnet build (its sha256 is AUDITED below).
//   2. Compiling an untouched copy of the source the same way gives that same audited sha256 again. So this script's
//      way of compiling is exactly the normal one.
//   3. The testnet copy differs from the audited source in these three lines only, and each is changed exactly once:
//        INITIAL_OWNER  the KnodeGames owner          → your test owner wallet
//        TIMELOCK_MS    48 hours                      → --timelock-min minutes (default 10)
//        EXPIRY_MS      7 days to carry it out        → --expiry-hours hours (default 24)
//   4. The testnet build is written to build/testnet/contract.wasm with build/testnet/manifest.json (its sha256, the
//      three changes, and the audited sha256 it came from). The admin tool uploads only a build whose manifest matches.
// Nothing here touches the mainnet build or any chain.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

/** The audited Picks build (picks/README.md "Build", docs/history/AUDIT-2026-10-27-picks*.md). */
const AUDITED = "700c296a1064b904299c156061d6caf8fcabd0b1765968903f29d89d2426c594";
const ROOT = path.join(__dirname, "..");
const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const arg = (name, d) => { const i = process.argv.indexOf(name); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const fail = (m) => { console.error(`✖ ${m}`); process.exit(1); };

/** The three replacements, each matching exactly one line of assembly/Picks.ts. Exported for the tests. */
function patches(owner, timelockMin, expiryHours) {
  return [
    { name: "INITIAL_OWNER", re: /^export const INITIAL_OWNER: Uint8Array = Base58\.decode\("1635QUrBNDp7WqmFkRvrkGwjJXTtFvH717"\);$/m,
      to: `export const INITIAL_OWNER: Uint8Array = Base58.decode("${owner}");   // TESTNET build: the test owner` },
    { name: "TIMELOCK_MS", re: /^export const TIMELOCK_MS: u64 = 2 \* DAY_MS;\s+\/\/ 48 hours$/m,
      to: `export const TIMELOCK_MS: u64 = ${timelockMin * 60000};   // TESTNET build: ${timelockMin} minutes (mainnet: 48 hours)` },
    { name: "EXPIRY_MS", re: /^export const EXPIRY_MS: u64 = 7 \* DAY_MS;\s+\/\/ an announcement can be carried out for 7 days$/m,
      to: `export const EXPIRY_MS: u64 = ${expiryHours * 3600000};   // TESTNET build: ${expiryHours} hours (mainnet: 7 days)` },
  ];
}
/** Apply the patches to the source text; throws unless each matches exactly once and nothing else changes. */
function patchSource(src, owner, timelockMin, expiryHours) {
  if (!/^1[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(owner)) throw new Error("--owner must be a Koinos address");
  if (owner === "1635QUrBNDp7WqmFkRvrkGwjJXTtFvH717") throw new Error("--owner is the mainnet owner: use a test wallet (.env.testnet OWNER_WIF)");
  if (!Number.isInteger(timelockMin) || timelockMin < 1 || timelockMin > 2880) throw new Error("--timelock-min must be 1 to 2880");
  if (!Number.isInteger(expiryHours) || expiryHours < 1 || expiryHours > 168) throw new Error("--expiry-hours must be 1 to 168");
  let out = src;
  const changed = [];
  for (const p of patches(owner, timelockMin, expiryHours)) {
    const hits = src.match(new RegExp(p.re.source, "gm")) || [];
    if (hits.length !== 1) throw new Error(`${p.name}: expected exactly one line to change, found ${hits.length}. The source changed: update this script.`);
    out = out.replace(p.re, p.to);
    changed.push({ name: p.name, from: hits[0], to: p.to });
  }
  const a = src.split("\n"), b = out.split("\n");
  if (a.length !== b.length) throw new Error("the line count changed");
  const diff = a.map((l, i) => (l === b[i] ? null : i + 1)).filter(Boolean);
  if (diff.length !== 3) throw new Error(`expected 3 changed lines, got ${diff.length}`);
  return { out, changed, lines: diff };
}

function compile(srcDir, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  execFileSync(process.execPath, [path.join(ROOT, "node_modules/assemblyscript/bin/asc"), path.join(srcDir, "index.ts"),
    "--target", "release", "--use", "abort=", "--use", "BUILD_FOR_TESTING=0", "--disable", "sign-extension", "--config", path.join(ROOT, "asconfig.json"),
    "--outFile", path.join(outDir, "contract.wasm"), "--textFile", path.join(outDir, "contract.wat")], { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"] });
  return sha(path.join(outDir, "contract.wasm"));
}
function copyAssembly(to) {
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(path.join(ROOT, "assembly"), to, { recursive: true, filter: (s) => !s.includes("__tests__") });
}

function main() {
  const owner = arg("--owner", ""), timelockMin = Number(arg("--timelock-min", "10")), expiryHours = Number(arg("--expiry-hours", "24"));
  const release = path.join(ROOT, "build/release/contract.wasm");
  if (!fs.existsSync(release) || !fs.existsSync(path.join(ROOT, "assembly/index.ts"))) fail("Build the contract first: npm test (in the picks folder)");
  // 1. The audited build.
  if (sha(release) !== AUDITED) fail(`build/release/contract.wasm is not the audited build (sha256 ${sha(release)}, expected ${AUDITED}). Rebuild: npm ci, npm test.`);
  const work = path.join(ROOT, "build/testnet-work");
  // 2. The same compile of an untouched copy reproduces the audited sha256.
  copyAssembly(path.join(work, "same"));
  const same = compile(path.join(work, "same"), path.join(work, "same-out"));
  if (same !== AUDITED) fail(`compiling an untouched copy gave ${same}, not the audited ${AUDITED}: the compile here differs from npm run build. Nothing was built.`);
  // 3. The three changes, and nothing else.
  let p;
  try { p = patchSource(fs.readFileSync(path.join(ROOT, "assembly/Picks.ts"), "utf8"), owner, timelockMin, expiryHours); } catch (e) { fail(e.message); }
  copyAssembly(path.join(work, "testnet"));
  fs.writeFileSync(path.join(work, "testnet/Picks.ts"), p.out);
  const out = path.join(ROOT, "build/testnet");
  const tsha = compile(path.join(work, "testnet"), out);
  if (tsha === AUDITED) fail("the testnet build came out identical to the mainnet build: the changes did not apply");
  // 4. The manifest.
  const manifest = { network: "koinos-foundation-testnet", sha256: tsha, bytes: fs.statSync(path.join(out, "contract.wasm")).size, auditedSha256: AUDITED,
    owner, timelockMs: timelockMin * 60000, expiryMs: expiryHours * 3600000, changedLines: p.lines, changes: p.changed, builtAt: new Date().toISOString() };
  fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  fs.rmSync(work, { recursive: true, force: true });
  console.log("✔ the compile reproduces the audited build exactly: " + AUDITED);
  console.log(`✔ testnet build: the audited source with ${p.lines.length} lines changed (lines ${p.lines.join(", ")} of assembly/Picks.ts):`);
  for (const c of p.changed) console.log(`    ${c.name}\n      - ${c.from.trim()}\n      + ${c.to.trim()}`);
  console.log(`  build/testnet/contract.wasm  sha256 ${tsha} (${manifest.bytes.toLocaleString("en-US")} bytes)`);
  console.log("  build/testnet/manifest.json  (the admin tool uploads only this build on testnet)");
}

module.exports = { AUDITED, patchSource };
if (require.main === module) main();

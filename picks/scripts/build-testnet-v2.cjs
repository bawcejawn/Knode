// Builds the TESTNET version of Picks v2 (CARD type, Combo Card): the audited v2 source with exactly three settings
// changed, the same three as scripts/build-testnet.cjs on the picks branch, so the upgrade from the testnet v1 contract
// and a whole Combo test fit in an afternoon on the Koinos testnet.
//
//   node scripts/build-testnet-v2.cjs --owner <test owner address> [--timelock-min 10] [--expiry-hours 24]
//   (node tools/combo-testnet.mjs build runs this with the owner from .env.testnet)
//
// What it proves, in order (it stops at the first thing that isn't right):
//   1. build/release/contract.wasm is the audited v2 build (AUDITED_V2 below; docs/history/AUDIT-2026-10-28-combo.md).
//   2. Compiling an untouched copy of the source the same way gives that same sha256 again.
//   3. The testnet copy differs from the audited source in these three lines only, each changed exactly once:
//        INITIAL_OWNER  the KnodeGames owner          → your test owner wallet
//        TIMELOCK_MS    48 hours                      → --timelock-min minutes (default 10)
//        EXPIRY_MS      7 days to carry it out        → --expiry-hours hours (default 24)
//   4. npm run check passes on the testnet source and its compiled code (no calls out, authorize unchanged).
//   5. The build is written to build/testnet-v2/contract.wasm with build/testnet-v2/manifest.json.
// Nothing here touches the mainnet build or any chain.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

/** The audited Picks v2 build (picks/README.md; formal audit + fix-check 2026-10-28). */
const AUDITED_V2 = "92d555d0680157854452e35162c1b1c5c100904996194b8c1c848df50e5e1c3d";
const MAINNET_OWNER = "1635QUrBNDp7WqmFkRvrkGwjJXTtFvH717";
const ROOT = path.join(__dirname, "..");
const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const arg = (name, d) => { const i = process.argv.indexOf(name); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const fail = (m) => { console.error(`✖ ${m}`); process.exit(1); };

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
/** A real Koinos address (base58, version 0, 20-byte hash, double-sha256 checksum). */
function isAddress(a) {
  const ABC = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  if (typeof a !== "string" || !/^1[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a)) return false;
  let n = 0n; for (const c of a) n = n * 58n + BigInt(ABC.indexOf(c));
  let hex = n.toString(16); if (hex.length % 2) hex = "0" + hex;
  let bytes = Buffer.from(hex, "hex"); for (const c of a) { if (c !== "1") break; bytes = Buffer.concat([Buffer.from([0]), bytes]); }
  if (bytes.length !== 25 || bytes[0] !== 0) return false;
  const d = (b) => crypto.createHash("sha256").update(b).digest();
  return d(d(bytes.subarray(0, 21))).subarray(0, 4).equals(bytes.subarray(21));
}
function patchSource(src, owner, timelockMin, expiryHours) {
  if (!isAddress(owner)) throw new Error("--owner must be a Koinos address (checksum included)");
  if (owner === MAINNET_OWNER) throw new Error("--owner is the mainnet owner: use a test wallet (.env.testnet OWNER_WIF)");
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
  if (sha(release) !== AUDITED_V2) fail(`build/release/contract.wasm is not the audited v2 build (sha256 ${sha(release)}, expected ${AUDITED_V2}). Rebuild: npm ci --ignore-scripts, npm test.`);
  const work = path.join(ROOT, "build/testnet-v2-work");
  copyAssembly(path.join(work, "snap"));
  const snap = path.join(work, "snap");
  fs.cpSync(snap, path.join(work, "same"), { recursive: true });
  const same = compile(path.join(work, "same"), path.join(work, "same-out"));
  if (same !== AUDITED_V2) fail(`compiling an untouched copy gave ${same}, not the audited ${AUDITED_V2}: the compile here differs from npm run build. Nothing was built.`);
  let p;
  try { p = patchSource(fs.readFileSync(path.join(snap, "Picks.ts"), "utf8"), owner, timelockMin, expiryHours); } catch (e) { fail(e.message); }
  fs.cpSync(snap, path.join(work, "testnet"), { recursive: true });
  fs.writeFileSync(path.join(work, "testnet/Picks.ts"), p.out);
  const out = path.join(ROOT, "build/testnet-v2");
  const tsha = compile(path.join(work, "testnet"), out);
  if (tsha === AUDITED_V2) fail("the testnet build came out identical to the mainnet build: the changes did not apply");
  // Repo Lens RL-23: check the compiled code itself, not only the source lines: the owner's address is a string literal,
  // which AssemblyScript stores as UTF-16. The test owner must be in it, the KnodeGames (mainnet) owner must not.
  const wasm = fs.readFileSync(path.join(out, "contract.wasm")), has = (a) => wasm.indexOf(Buffer.from(a, "utf16le")) >= 0;
  if (has(MAINNET_OWNER) || !has(owner)) fail(`the compiled testnet code ${has(MAINNET_OWNER) ? "still holds the mainnet owner" : "doesn't hold the test owner"}: the source was changed some other way. Nothing was built.`);
  try {
    execFileSync(process.execPath, [path.join(__dirname, "check.cjs")], { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"],
      env: { ...process.env, PICKS_SRC: path.join(work, "testnet/Picks.ts"), PICKS_WAT: path.join(out, "contract.wat") } });
  } catch { fail("npm run check fails on the testnet build. Nothing should be uploaded."); }
  const manifest = { network: "koinos-foundation-testnet", version: 2, sha256: tsha, bytes: fs.statSync(path.join(out, "contract.wasm")).size, auditedSha256: AUDITED_V2,
    owner, timelockMs: timelockMin * 60000, expiryMs: expiryHours * 3600000, changedLines: p.lines, changes: p.changed, builtAt: new Date().toISOString() };
  fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  fs.rmSync(work, { recursive: true, force: true });
  console.log("✔ the compile reproduces the audited v2 build exactly: " + AUDITED_V2);
  console.log(`✔ testnet v2 build: the audited source with ${p.lines.length} lines changed (lines ${p.lines.join(", ")} of assembly/Picks.ts):`);
  for (const c of p.changed) console.log(`    ${c.name}\n      - ${c.from.trim()}\n      + ${c.to.trim()}`);
  console.log(`  build/testnet-v2/contract.wasm  sha256 ${tsha} (${manifest.bytes.toLocaleString("en-US")} bytes)`);
}

module.exports = { AUDITED_V2, patchSource, isAddress };
if (require.main === module) main();

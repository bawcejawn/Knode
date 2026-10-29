// Builds the emergency, withdrawals-only Vault (docs/UPGRADE-V6.md, "Emergency: the withdrawals-only build"):
// the same code with SAFE_MODE = true, into build/safe/contract.wasm, and prints its fingerprint. Then it switches
// assembly/Mode.ts back and rebuilds the normal release build, so build/release is never the safe one by accident.
const fs = require("fs");
const crypto = require("crypto");
const { execSync } = require("child_process");
const MODE = "assembly/Mode.ts";
const normal = fs.readFileSync(MODE, "utf8");
// The live declaration itself, not a comment (fix-check 3, V3-10; fix-check 4, C4-1: one shared parser).
const { isNormal, isSafe, toSafe } = require("../../tools/mode-switch.cjs");
if (!isNormal(normal)) throw new Error(`${MODE} must say SAFE_MODE = false before building`);
// The contract builder sometimes stops with EAGAIN on a busy machine: try again a few times.
const build = () => {
  for (let i = 1; ; i++) {
    try { return execSync("npm run build", { stdio: ["ignore", "inherit", "inherit"] }); }
    catch (e) { if (i >= 6) throw e; console.log(`build failed (attempt ${i}); trying again`); }
  }
};
let hash = "";
try {
  fs.writeFileSync(MODE, toSafe(normal));   // only the live declaration (C4-1)
  if (!isSafe(fs.readFileSync(MODE, "utf8"))) throw new Error(`${MODE} did not switch to the safe build`);
  build();
  fs.mkdirSync("build/safe", { recursive: true });
  fs.copyFileSync("build/release/contract.wasm", "build/safe/contract.wasm");
  hash = crypto.createHash("sha256").update(fs.readFileSync("build/safe/contract.wasm")).digest("hex");
} finally {
  fs.writeFileSync(MODE, normal);
  // Never leave the safe build where the normal one belongs, whatever failed above (fix-check VN-10): if the rebuild
  // below fails too, there is no release build at all.
  fs.rmSync("build/release/contract.wasm", { force: true });
}
build();
// The two builds must differ: if they don't, the switch didn't take (C4-1). Nothing is pinned from a failed run.
const releaseHash = crypto.createHash("sha256").update(fs.readFileSync("build/release/contract.wasm")).digest("hex");
if (releaseHash === hash) {
  fs.rmSync("build/safe/contract.wasm", { force: true });
  throw new Error("build:safe produced the same code as the normal build: the switch didn't take. build/safe was removed.");
}
console.log(`\nbuild/safe/contract.wasm: the withdrawals-only build\nsha256 ${hash}\n(build/release is the normal build again)`);

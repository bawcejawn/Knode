// Builds the emergency, withdrawals-only Vault (docs/UPGRADE-V6.md, "Emergency: the withdrawals-only build"):
// the same code with SAFE_MODE = true, into build/safe/contract.wasm, and prints its fingerprint. Then it switches
// assembly/Mode.ts back and rebuilds the normal release build, so build/release is never the safe one by accident.
const fs = require("fs");
const crypto = require("crypto");
const { execSync } = require("child_process");
const MODE = "assembly/Mode.ts";
const normal = fs.readFileSync(MODE, "utf8");
if (!/SAFE_MODE: bool = false;/.test(normal)) throw new Error(`${MODE} must say SAFE_MODE = false before building`);
// The contract builder sometimes stops with EAGAIN on a busy machine: try again a few times.
const build = () => {
  for (let i = 1; ; i++) {
    try { return execSync("npm run build", { stdio: ["ignore", "inherit", "inherit"] }); }
    catch (e) { if (i >= 6) throw e; console.log(`build failed (attempt ${i}); trying again`); }
  }
};
let hash = "";
try {
  fs.writeFileSync(MODE, normal.replace("SAFE_MODE: bool = false;", "SAFE_MODE: bool = true;"));
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
console.log(`\nbuild/safe/contract.wasm: the withdrawals-only build\nsha256 ${hash}\n(build/release is the normal build again)`);

// The contract builds call protoc through @roamin/protoc. Without a pinned version, that package downloads the LATEST
// protoc release from GitHub at build time, with no checksum (audit BX-6), on the PC that holds the keys. This puts
// exactly protoc 21.12 (the version whose builds reproduce the audited fingerprints) in place first, checked against
// the sha256 below, so @roamin/protoc (told the version by config.protocVersion in each contract's package.json) finds
// it installed and downloads nothing. Run from a contract folder's prebuild step.
//
// Hashes: the release zips at github.com/protocolbuffers/protobuf/releases/tag/v21.12, taken 2026-10-28.
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const https = require("https");

const VERSION = "21.12";
const ZIP_SHA256 = {
  "win64": "71852a30cf62975358edfcbbff93086e8857a079c8e4d6904881aa968d65c7f9",
  "win32": "6de4ef4e65c7edb834a2a9fca6d85388adc5dd71fc8bff8b60569717d01dabea",
  "linux-x86_64": "3a4c1e5f2516c639d3079b1586e703fc7bcfa2136d58bda24d1d54f949c315e8",
  "linux-aarch_64": "2dd17f75d66a682640b136e31848da9fb2eefe68d55303baf8b32617374f6711",
  "osx-x86_64": "9448ff40278504a7ae5139bb70c962acc78c32d8fc54b4890a55c14c68b9d10a",
  "osx-aarch_64": "96839af0caed64352442fc8236f4bdf7c1cd6efcfaa98fa5db37307a73fc7c70",
};
module.exports = { VERSION, ZIP_SHA256 };

function build() {
  const p = os.platform(), a = os.arch();
  if (p === "win32") return a === "x64" || a === "arm64" ? "win64" : "win32";
  if (p === "darwin") return a === "arm64" ? "osx-aarch_64" : "osx-x86_64";
  if (p === "linux") return a === "arm64" ? "linux-aarch_64" : "linux-x86_64";
  throw new Error(`protoc-pin: no pinned protoc for ${p}-${a}`);
}
function get(url, hops = 0) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "knode-protoc-pin" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops < 5) { res.resume(); return resolve(get(new URL(res.headers.location, url).href, hops + 1)); }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} for ${url}`)); }
      const parts = []; res.on("data", (c) => parts.push(c)); res.on("end", () => resolve(Buffer.concat(parts))); res.on("error", reject);
    }).on("error", reject);
  });
}

async function main(cwd = process.cwd()) {
  const pkg = path.join(cwd, "node_modules", "@roamin", "protoc");
  if (!fs.existsSync(pkg)) return;                         // this folder doesn't build with @roamin/protoc
  const want = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8")).config?.protocVersion;
  if (want !== VERSION) throw new Error(`protoc-pin: ${path.join(cwd, "package.json")} must have "config": { "protocVersion": "${VERSION}" }`);
  const b = build(), name = `protoc-${VERSION}-${b}`;
  const dir = path.join(pkg, "installed", name), exe = path.join(dir, "bin", b.startsWith("win") ? "protoc.exe" : "protoc");
  const stamp = path.join(dir, ".zip-sha256");
  if (fs.existsSync(exe) && fs.existsSync(stamp) && fs.readFileSync(stamp, "utf8").trim() === ZIP_SHA256[b]) return;
  fs.rmSync(dir, { recursive: true, force: true });
  const url = `https://github.com/protocolbuffers/protobuf/releases/download/v${VERSION}/${name}.zip`;
  const zip = await get(url);
  const h = crypto.createHash("sha256").update(zip).digest("hex");
  if (h !== ZIP_SHA256[b]) throw new Error(`protoc-pin: ${name}.zip has sha256 ${h}, expected ${ZIP_SHA256[b]}. Not installed.`);
  const { unzip } = require(path.join(pkg, "util.js"));
  unzip(zip, (data, header) => {
    const f = path.join(dir, header.filename);
    if (!f.startsWith(dir + path.sep)) throw new Error(`protoc-pin: unexpected path in the zip: ${header.filename}`);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, data, { mode: header.filename.includes("bin/") ? 0o755 : 0o644 });
  });
  if (!fs.existsSync(exe)) throw new Error(`protoc-pin: ${exe} missing after unzip`);
  fs.writeFileSync(stamp, ZIP_SHA256[b] + "\n");
  console.log(`protoc ${VERSION} (${b}) installed and checked (sha256 ${ZIP_SHA256[b].slice(0, 12)}…)`);
}

if (require.main === module) main().catch((e) => { console.error(e.message || e); process.exit(1); });
else module.exports.main = main;

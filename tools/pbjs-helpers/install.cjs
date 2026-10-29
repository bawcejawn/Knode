// protobufjs's command line (used by the contract build to make the ABI) installs a few helper packages from the
// network the first time it runs, at whatever version is newest. This puts exact, lockfile-pinned copies in its own
// node_modules first, so the build fetches nothing unpinned. Run from a contract folder's prebuild step.
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const here = __dirname;
const helpers = path.join(here, "node_modules");
const cli = path.join(process.cwd(), "node_modules", "protobufjs", "cli");
if (!fs.existsSync(cli)) process.exit(0); // nothing to prepare
const pkg = JSON.parse(fs.readFileSync(path.join(here, "package.json"), "utf8"));
const ready = () => Object.keys(pkg.dependencies).every((n) => fs.existsSync(path.join(helpers, n, "package.json")));
if (!ready()) {
  // The npm that ships with Node (the contract folders also contain an old npm 6, which cannot read this lockfile).
  const dir = path.dirname(process.execPath);
  const cli = [path.join(dir, "node_modules", "npm", "bin", "npm-cli.js"), path.join(dir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")].find((f) => fs.existsSync(f));
  if (!cli) throw new Error("Could not find the npm that ships with Node; run `npm ci` in tools/pbjs-helpers by hand.");
  execFileSync(process.execPath, [cli, "ci", "--ignore-scripts", "--no-audit", "--no-fund", "--silent"], { cwd: here, stdio: "inherit" });
}
// Exactly where protobufjs would install them itself (its cli folder, searched first). A package already there at a
// version protobufjs does not accept is replaced, and the old copy is kept for the packages there that need it.
const semver = require(path.join(helpers, "semver"));
const ranges = JSON.parse(fs.readFileSync(path.join(cli, "..", "package.json"), "utf8"));
const want = (n) => (ranges.dependencies || {})[n] || (ranges.devDependencies || {})[n];
const ver = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version; } catch { return null; } };
fs.mkdirSync(path.join(cli, "node_modules"), { recursive: true });
for (const name of fs.readdirSync(helpers)) {
  if (name.startsWith(".")) continue;
  const from = path.join(helpers, name), to = path.join(cli, "node_modules", name), have = ver(to);
  if (have && (!want(name) || semver.satisfies(have, want(name)))) continue;
  if (have) {
    for (const dep of fs.readdirSync(path.join(cli, "node_modules"))) {
      let deps = {};
      try { deps = JSON.parse(fs.readFileSync(path.join(cli, "node_modules", dep, "package.json"), "utf8")).dependencies || {}; } catch { continue; }
      const keep = path.join(cli, "node_modules", dep, "node_modules", name);
      if (deps[name] && semver.satisfies(have, deps[name]) && !fs.existsSync(keep)) fs.cpSync(to, keep, { recursive: true });
    }
    fs.rmSync(to, { recursive: true, force: true });
  }
  fs.cpSync(from, to, { recursive: true });
}

// Audit BX-6: fail the build, rather than let protobufjs fetch anything itself, if any helper it needs is not pinned
// here or not in place.
const need = JSON.parse(fs.readFileSync(path.join(cli, "..", "package.json"), "utf8")).cliDependencies || [];
const unpinned = need.filter((n) => !(n in pkg.dependencies));
if (unpinned.length) throw new Error(`tools/pbjs-helpers: protobufjs needs ${unpinned.join(", ")}, which are not pinned here. Pin them (exact versions) and run npm install --package-lock-only.`);
const absent = need.filter((n) => !fs.existsSync(path.join(cli, "node_modules", n, "package.json")));
if (absent.length) throw new Error(`tools/pbjs-helpers: ${absent.join(", ")} not in place after install.`);

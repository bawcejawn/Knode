// Who Signs Block X on the Koinos TESTNET, on your own computer: serves the testnet page at
//   http://127.0.0.1:8090/site/blockx-testnet.html
// and (with --record) runs the Block X recorder for every testnet game every 5 minutes, so the page shows results
// without GitHub. Nothing is pushed or published; mainnet is never touched.
//
//   npm run testnet-site              the page only
//   npm run testnet-site -- --record  the page, and the recorder every 5 minutes (stop with Ctrl+C)
//
// Safety: it listens on 127.0.0.1 only (not your network), answers only GET/HEAD, and serves only an allowlist:
// site/ files, testnet/blockx.json and the recorder's testnet-data/blockx-<id>/*.json. Never .env.testnet, keys,
// or any other file of the project.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT || 8090);
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json", ".woff2": "font/woff2" };

/** The only files this server ever sends. Exported for the tests. */
export function allowed(urlPath) {
  let p;
  try { p = decodeURIComponent(urlPath.split("?")[0]); } catch { return null; }
  if (p.includes("\0") || p.includes("\\")) return null;
  const rel = path.posix.normalize(p).replace(/^\/+/, "");
  if (rel.split("/").some((s) => s === ".." || s.startsWith("."))) return null;
  const ok = (/^site\/[A-Za-z0-9._\/-]+$/.test(rel) && TYPES[path.extname(rel)]) || rel === "testnet/blockx.json" || /^testnet-data\/blockx-\d{1,3}\/(index|board|cards|W\d{3})\.json$/.test(rel);
  if (!ok) return null;
  const abs = path.join(ROOT, rel);
  if (!abs.startsWith(ROOT + path.sep)) return null;
  return abs;
}

export function serve(port = PORT) {
  const server = http.createServer((req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405).end(); return; }
    if ((req.url || "/") === "/") { res.writeHead(302, { Location: "/site/blockx-testnet.html" }).end(); return; }
    const f = allowed(req.url || "/");
    let st = null;
    try { st = f && fs.lstatSync(f); } catch { /* missing */ }
    if (!f || !st || !st.isFile()) { res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found"); return; }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(f)] || "application/octet-stream", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    if (req.method === "HEAD") { res.end(); return; }
    fs.createReadStream(f).pipe(res);
  });
  server.listen(port, "127.0.0.1");
  return server;
}

function recordAll() {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "testnet/blockx.json"), "utf8"));
  const ids = cfg.games.map((g) => g.id).filter((id) => Number.isInteger(id) && id > 0 && id < 128);
  const one = (i) => {
    if (i >= ids.length) return;
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const c = spawn(npm, ["run", "-s", "blockx", "--", "--testnet", "--game", String(ids[i])], { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32" });
    c.on("exit", () => one(i + 1));
  };
  console.log(`\n[${new Date().toISOString()}] recording games ${ids.join(", ")}`);
  one(0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  serve();
  console.log(`Block X testnet page: http://127.0.0.1:${PORT}/site/blockx-testnet.html   (fast game: #game-92)`);
  if (process.argv.includes("--record")) { recordAll(); setInterval(recordAll, 5 * 60000); }
  else console.log("Results: add --record to run the recorder every 5 minutes (or run: npm run blockx -- --testnet --game 92).");
}

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

/** Start on PORT (default 8090), or the next free port up to +20 if another program already uses it. */
function start(port, tries = 20) {
  return new Promise((resolve, reject) => {
    const s = serve(port);
    s.once("listening", () => resolve(s));
    s.once("error", (e) => {
      if (e.code === "EADDRINUSE" && tries > 0) { console.log(`Port ${port} is already used by another program; trying ${port + 1}.`); resolve(start(port + 1, tries - 1)); }
      else reject(e);
    });
  });
}

function recordAll() {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "testnet/blockx.json"), "utf8"));
  const ids = cfg.games.map((g) => g.id).filter((id) => Number.isInteger(id) && id > 0 && id < 128);
  const one = (i) => {
    if (i >= ids.length) return;
    // Node itself runs the recorder (no shell, so nothing is pieced together into a command line).
    const c = spawn(process.execPath, ["--import", "tsx", "bot/games/blockx.ts", "--testnet", "--game", String(ids[i])], { cwd: ROOT, stdio: "inherit" });
    c.on("exit", () => one(i + 1));
  };
  console.log(`\n[${new Date().toISOString()}] recording games ${ids.join(", ")}`);
  one(0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  start(PORT).then((s) => {
    const port = s.address().port;
    console.log(`\nBlock X testnet page:  http://127.0.0.1:${port}/site/blockx-testnet.html#game-92   (fast game)`);
    console.log(`                       http://127.0.0.1:${port}/site/blockx-testnet.html#game-2    (real settings)`);
    console.log("Leave this window open. Stop with Ctrl+C.");
    if (process.argv.includes("--record")) { recordAll(); setInterval(recordAll, 5 * 60000); }
    else console.log("Results: add --record to run the recorder every 5 minutes (or run: npm run blockx -- --testnet --game 92).");
  }, (e) => { console.error(`Couldn't start the page: ${e.message}`); process.exit(1); });
}

// Who Signs Block X and Last Node Standing on the Koinos TESTNET, on your own computer: serves the testnet pages at
//   http://127.0.0.1:8350/blockx-testnet.html
//   http://127.0.0.1:8350/lastnode-testnet.html
// and (with --record) runs the recorders for every testnet game every 5 minutes, so the pages show results without
// GitHub. Nothing is pushed or published; nothing is ever sent to mainnet (Last Node Standing READS mainnet blocks: the
// testnet has one producer, so the race is the real mainnet producers while the picks are on the testnet).
//
//   npm run testnet-site              the page only
//   npm run testnet-site -- --record  the page, and the recorder every 5 minutes (stop with Ctrl+C)
//
// "Play free": the page can ask this server to send a new Test wallet 5 test KOIN (POST /api/fund), from the testnet
// wallet named FAUCET_WIF in .env.testnet (default: the test owner, OWNER_WIF). Testnet only: it checks the node's chain
// id is not mainnet's, sends only to an address holding under 1 test KOIN, once per address, at most 50 a run, and
// only to the page on this computer (Origin and Host must be this server; a custom header blocks other sites).
//
// Safety: it listens on 127.0.0.1 only (not your network), answers GET/HEAD (and that one POST), and serves only an allowlist:
// the site's own page files at the repository root (html, js, css; media/ images), testnet/blockx.json, testnet/lastnode.json,
// the Picks ABI (picks/abi/picks.koilib.json) and the recorders' testnet-data/blockx-<id>/*.json and
// testnet-data/lastnode-<id>/*.json. Never .env.testnet, keys,
// or any other file of the project.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import koilib from "koilib";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT || 8350);
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json", ".woff2": "font/woff2" };

/** The only files this server ever sends. Exported for the tests. */
export function allowed(urlPath) {
  let p;
  try { p = decodeURIComponent(urlPath.split("?")[0]); } catch { return null; }
  if (p.includes("\0") || p.includes("\\")) return null;
  const rel = path.posix.normalize(p).replace(/^\/+/, "");
  if (rel.split("/").some((s) => s === ".." || s.startsWith("."))) return null;
  // The site lives at the repository root (knodegames.com, 2026-10-28): only its page files there (no .json, .ts,
  // dotfiles or folders), media/ images, and the few data files below.
  const ok = /^[A-Za-z0-9_-][A-Za-z0-9._-]*\.(html|js|css)$/.test(rel) || /^media\/[A-Za-z0-9_-][A-Za-z0-9._-]*\.(png|svg|ico)$/.test(rel) || rel === "manifest.webmanifest" || rel === "testnet/blockx.json" || rel === "testnet/lastnode.json" || rel === "picks/abi/picks.koilib.json" || /^testnet-data\/blockx-\d{1,3}\/(index|board|cards|W\d{3})\.json$/.test(rel)
    || /^testnet-data\/lastnode-\d{1,3}\/(index|board|D\d{4}-\d{2}-\d{2}(T\d{2})?)\.json$/.test(rel);
  if (!ok) return null;
  const abs = path.join(ROOT, rel);
  if (!abs.startsWith(ROOT + path.sep)) return null;
  return abs;
}

const MAINNET_CHAIN_ID = "EiBZK_GGVP0H_fXVAM3j6EAuz3-B-l3ejxRSewi7qIBfSA==";
const FUND_SAT = 500000000n, MAX_FUNDS = 50;
const funded = new Set();
/** The testnet key that pays for "Play free", read from .env.testnet (never printed, never sent to the page). */
function faucetKey(root = ROOT) {
  try {
    const t = fs.readFileSync(path.join(root, ".env.testnet"), "utf8");
    const get = (k) => (t.match(new RegExp(`^${k}=(.*)$`, "m")) || [])[1]?.trim();
    return get("FAUCET_WIF") || get("OWNER_WIF") || null;
  } catch { return null; }
}
/** Only the page served by this server may ask (exported for the tests). */
/** Audit BX-31: every request must name this server as its Host (blocks DNS-rebinding pages from reading it). */
export function hostAllowed(req, port) { return [`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host); }
export function fundAllowed(req, port) {
  const own = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
  return req.method === "POST" && req.headers["x-kg-testnet"] === "fund" && own.includes(req.headers.origin) && hostAllowed(req, port);
}
// Audit BX-11: an address is reserved before the first await, so two requests at once can't both send to it, and the
// 50-wallet limit counts the ones still sending.
const sending = new Set();
export async function fund(address, key, send = fundNow) {
  if (!/^1[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(address || "")) return [400, { error: "Not a Koinos address." }];
  if (!key) return [503, { error: "No faucet key: add FAUCET_WIF (or OWNER_WIF) to .env.testnet." }];
  if (funded.has(address) || sending.has(address)) return [409, { error: "This wallet already got its test KOIN." }];
  if (funded.size + sending.size >= MAX_FUNDS) return [429, { error: "This server has funded 50 wallets; restart it to fund more." }];
  sending.add(address);
  try { return await send(address, key); } finally { sending.delete(address); }
}
async function fundNow(address, key) {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "testnet/blockx.json"), "utf8"));
  const p = new koilib.Provider([cfg.rpc]);
  const chainId = await p.getChainId();
  if (chainId === MAINNET_CHAIN_ID || (cfg.chainId && chainId !== cfg.chainId)) return [500, { error: "The node isn't the testnet. Nothing was sent." }];
  const signer = koilib.Signer.fromWif(key); signer.provider = p;
  const koin = new koilib.Contract({ id: cfg.koin, abi: koilib.utils.tokenAbi, provider: p, signer });
  const bal = BigInt((await koin.functions.balanceOf({ owner: address })).result?.value || "0");
  if (bal >= 100000000n) { funded.add(address); return [200, { ok: true, already: true }]; }
  const have = BigInt((await koin.functions.balanceOf({ owner: signer.getAddress() })).result?.value || "0");
  if (have < FUND_SAT + 100000000n) return [503, { error: `The faucet wallet ${signer.getAddress()} is low on test KOIN. Claim more for it from the faucet bot.` }];
  const { operation } = await koin.functions.transfer({ from: signer.getAddress(), to: address, value: FUND_SAT.toString() }, { onlyOperation: true });
  const mana = BigInt(await p.getAccountRc(signer.getAddress()));
  const tx = new koilib.Transaction({ signer, provider: p, options: { payer: signer.getAddress(), chainId, rcLimit: (mana < 100000000n ? mana : 100000000n).toString() } });
  await tx.pushOperation(operation);
  const r = await tx.send();
  if (r && r.reverted) return [500, { error: "The transfer was refused by the chain." }];
  funded.add(address);
  await tx.wait("byBlock", 60000).catch(() => null);
  console.log(`Play free: sent 5 test KOIN to ${address}`);
  return [200, { ok: true, koin: 5 }];
}

export function serve(port = PORT) {
  const server = http.createServer((req, res) => {
    const listen = server.address() && server.address().port;
    if (!hostAllowed(req, listen)) { res.writeHead(421, { "Content-Type": "text/plain" }).end("Open this page at 127.0.0.1 or localhost."); return; }
    if (req.method === "POST" && (req.url || "") === "/api/fund") {
      if (!fundAllowed(req, listen)) { res.writeHead(403, { "Content-Type": "application/json" }).end('{"error":"Only this computer\'s test page may ask."}'); return; }
      let body = "";
      req.on("data", (c) => { body += c; if (body.length > 500) req.destroy(); });
      req.on("end", async () => {
        let a = null; try { a = JSON.parse(body).address; } catch { /* bad body */ }
        let out;
        try { out = await fund(a, faucetKey()); } catch (e) { out = [500, { error: String((e && e.message) || e).slice(0, 200) }]; }
        res.writeHead(out[0], { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(out[1]));
      });
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405).end(); return; }
    if ((req.url || "/") === "/") { res.writeHead(302, { Location: "/blockx-testnet.html" }).end(); return; }
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

/** Start on PORT (default 8350: 8090 is the personal node, 8080 the game node, 8100 the desk node), or the next free port up to +20 if another program already uses it. */
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

let recording = false;
function recordAll() {
  if (recording) { console.log("(the last recording run is still going; skipping this one)"); return; }
  const ok = (id) => Number.isInteger(id) && id > 0 && id < 128;
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "testnet/blockx.json"), "utf8"));
  let ln = { games: [] };
  try { ln = JSON.parse(fs.readFileSync(path.join(ROOT, "testnet/lastnode.json"), "utf8")); } catch { /* no Last Node Standing settings */ }
  const jobs = [...cfg.games.map((g) => g.id).filter(ok).map((id) => ["bot/games/blockx.ts", id]),
    ...(Array.isArray(ln.games) ? ln.games : []).map((g) => g.id).filter(ok).map((id) => ["bot/games/lastnode.ts", id])];
  const one = (i) => {
    if (i >= jobs.length) { recording = false; return; }
    // Node itself runs the recorder (no shell, so nothing is pieced together into a command line).
    const c = spawn(process.execPath, ["--import", "tsx", jobs[i][0], "--testnet", "--game", String(jobs[i][1])], { cwd: ROOT, stdio: "inherit" });
    c.on("exit", () => one(i + 1));
  };
  recording = true;
  console.log(`\n[${new Date().toISOString()}] recording ${jobs.map(([f, id]) => `${f.includes("lastnode") ? "Last Node" : "Block X"} ${id}`).join(", ")}`);
  one(0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  start(PORT).then((s) => {
    const port = s.address().port;
    console.log(`\nBlock X testnet page:  http://127.0.0.1:${port}/blockx-testnet.html#game-92   (fast game)`);
    console.log(`                       http://127.0.0.1:${port}/blockx-testnet.html#game-2    (real settings)`);
    console.log(`Last Node Standing:    http://127.0.0.1:${port}/lastnode-testnet.html#game-93 (fast test: a cut every 20 minutes)`);
    console.log(`                       http://127.0.0.1:${port}/lastnode-testnet.html#game-13 (real settings: daily 14:00 UTC)`);
    console.log("Leave this window open. Stop with Ctrl+C.");
    if (process.argv.includes("--record")) { recordAll(); setInterval(recordAll, 5 * 60000); }
    else console.log("Results: add --record to run the recorder every 5 minutes (or run: npm run blockx -- --testnet --game 92).");
  }, (e) => { console.error(`Couldn't start the page: ${e.message}`); process.exit(1); });
}

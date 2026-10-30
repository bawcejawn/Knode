/**
 * KNODE ADMIN — a control page that runs only on your PC.
 *
 *   npm run admin
 *
 * It opens http://127.0.0.1:8787/#<one-time key> in your browser. Nothing is published and no port is opened to
 * your network or the internet: the server listens on 127.0.0.1 (this computer only).
 *
 * Safety:
 *   - Every button runs an existing command (npm run bot / desk / sponsor / picks / racepicks) with checked values; keys stay in .env and
 *     never reach the page. Mainnet sends still need CONFIRM_MAINNET=yes in .env, as on the command line.
 *   - Anything that sends a transaction is previewed first (a dry run). "Send" is only accepted for the exact action
 *     and values just previewed, within 10 minutes.
 *   - Requests need the one-time key printed at start (a new one each time) and must come from this page: other
 *     websites open in your browser can't use it (host and origin are checked, and nothing is shared cross-site).
 *   - One command runs at a time.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, exec, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ACTIONS, AREAS, KINDS, commandFor } from "./actions.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.ADMIN_PORT ?? 8787);
const HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const KEY = crypto.randomBytes(24).toString("hex");
const PREVIEW_MS = 10 * 60_000;
const previews = new Map<string, number>();   // action + values → time of its dry run
let busy = false;

const page = fs.readFileSync(path.join(ROOT, "admin", "index.html"), "utf8");
// What the page shows: every area of the platform, the kinds of control, and each action with its plain-words fields
// and the command it runs (with {placeholders} for the values). The patterns stay on the server, which checks them.
// Which version of the page this is (shown at the top), so it's easy to tell an old copy from a new one.
const VERSION = (() => {
  const git = (...a: string[]) => { try { return execFileSync("git", a, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return ""; } };
  return { branch: git("rev-parse", "--abbrev-ref", "HEAD") || "unknown", commit: git("rev-parse", "--short", "HEAD") || "unknown", date: git("log", "-1", "--format=%cd", "--date=format:%d %b %Y %H:%M") };
})();
const catalog = JSON.stringify({
  version: VERSION, areas: AREAS, kinds: KINDS,
  actions: ACTIONS.map(({ id, area, kind, label, what, when, signer, effect, timing, step, tool, params, sends, args }) => ({
    id, area, kind, label, what, when, signer, effect, timing, step, sends,
    testnet: args.includes("--testnet"), command: `npm run ${tool} -- ${args.join(" ")}`,
    params: (params ?? []).map(({ name, label, hint, choices, value }) => ({ name, label, hint, choices, value })),
  })),
});

function run(tool: string, argv: string[]): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const script = tool === "desk" ? "bot/desk.ts" : tool === "sponsor" ? "bot/sponsor.ts" : tool === "picks" ? "bot/picks.ts" : tool === "racepicks" ? "bot/race-picks.ts" : tool === "names" ? "bot/names.ts" : "bot/bot.ts";
    // A control whose command is on a branch not merged here yet (names, vault v6) says so instead of failing oddly.
    if (!fs.existsSync(path.join(ROOT, script))) return resolve({ code: 1, output: `${script} is not on this copy yet. Run: git pull (it arrives when its pull request is merged).` });
    const child = spawn(process.execPath, ["--import", "tsx", script, ...argv], { cwd: ROOT, env: process.env });
    let out = "";
    const add = (b: Buffer) => { out += b.toString(); if (out.length > 400_000) out = out.slice(-400_000); };
    child.stdout.on("data", add); child.stderr.on("data", add);
    const timer = setTimeout(() => child.kill(), 15 * 60_000);
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? 1, output: out }); });
  });
}

const send = (res: http.ServerResponse, status: number, body: string, type = "application/json") => {
  res.writeHead(status, {
    "content-type": `${type}; charset=utf-8`, "cache-control": "no-store", "x-content-type-options": "nosniff",
    "x-frame-options": "DENY", "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  });
  res.end(body);
};

const server = http.createServer((req, res) => {
  // Only this computer, only this page: the Host header defeats DNS rebinding, the Origin check other websites.
  if (!HOSTS.has(String(req.headers.host ?? ""))) return send(res, 403, '{"error":"wrong host"}');
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  if (req.method === "GET" && url.pathname === "/") return send(res, 200, page, "text/html");
  if (!url.pathname.startsWith("/api/")) return send(res, 404, '{"error":"not found"}');
  const origin = req.headers.origin;
  if (origin !== undefined && !HOSTS.has(String(origin).replace(/^http:\/\//, ""))) return send(res, 403, '{"error":"wrong origin"}');
  // Compared as bytes (audit L-10): a header with non-ASCII characters has more bytes than characters.
  const given = Buffer.from(String(req.headers["x-admin-key"] ?? ""), "utf8"), want = Buffer.from(KEY, "utf8");
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return send(res, 401, '{"error":"wrong or missing key: open the link printed in the terminal"}');
  if (req.method === "GET" && url.pathname === "/api/actions") return send(res, 200, catalog);
  if (req.method !== "POST" || url.pathname !== "/api/run") return send(res, 404, '{"error":"not found"}');
  let body = "";
  req.on("data", (c) => { body += c; if (body.length > 10_000) req.destroy(); });
  req.on("end", async () => {
    let msg: any;
    try { msg = JSON.parse(body); } catch { return send(res, 400, '{"error":"bad request"}'); }
    const a = ACTIONS.find((x) => x.id === msg?.action);
    if (!a) return send(res, 400, '{"error":"unknown action"}');
    const cmd = commandFor(a, msg.values ?? {});
    if ("error" in cmd) return send(res, 400, JSON.stringify({ error: cmd.error }));
    const wantSend = msg.send === true;
    if (wantSend && !a.sends) return send(res, 400, '{"error":"this action never sends"}');
    const id = a.id + "\u0000" + cmd.argv.join("\u0000");
    if (wantSend) {
      const t = previews.get(id);
      if (!t || Date.now() - t > PREVIEW_MS) return send(res, 409, '{"error":"preview it first (the exact same values, within 10 minutes)"}');
    }
    if (busy) return send(res, 409, '{"error":"another command is still running"}');
    busy = true;
    try {
      const argv = wantSend ? [...cmd.argv, "--send"] : cmd.argv;
      const r = await run(a.tool, argv);
      if (!wantSend && a.sends && r.code === 0) previews.set(id, Date.now());
      if (wantSend) previews.delete(id);
      console.log(`${new Date().toISOString()}  ${wantSend ? "SENT   " : "preview"}  npm run ${a.tool} -- ${argv.join(" ")}  (exit ${r.code})`);
      send(res, 200, JSON.stringify({ command: `npm run ${a.tool} -- ${argv.join(" ")}`, code: r.code, output: r.output, previewed: !wantSend && a.sends && r.code === 0 }));
    } finally { busy = false; }
  });
});

server.on("error", (e: any) => {
  if (e?.code === "EADDRINUSE") console.error(`\nAn admin page is ALREADY running on this computer (port ${PORT}), probably an older one in another PowerShell window.\nClose that window (or press Ctrl+C in it), close the old browser tab, then run npm run admin again.\n`);
  else console.error(`\nThe admin page couldn't start: ${e?.message ?? e}\n`);
  process.exit(1);
});
server.listen(PORT, "127.0.0.1", () => {
  const link = `http://127.0.0.1:${PORT}/#${KEY}`;
  console.log(`\nKnode Games Admin is running on this computer only (branch ${VERSION.branch}, version ${VERSION.commit}${VERSION.date ? `, ${VERSION.date}` : ""}).\n\n  Open: ${link}\n\nKeep this window open while you use it; close it (Ctrl+C) when you're done. The key changes every start.\n`);
  if (process.env.ADMIN_NO_BROWSER !== "1") {
    const opener = process.platform === "win32" ? `start "" "${link}"` : process.platform === "darwin" ? `open "${link}"` : `xdg-open "${link}"`;
    exec(opener, () => {});
  }
});

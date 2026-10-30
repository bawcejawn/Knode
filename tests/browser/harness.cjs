// Combo Card page in a real browser (Chromium via Playwright): the site served from this repository, koilib from
// node_modules, a fake Koinos RPC answering with ABI-encoded results, the wallet stubbed. Not part of npm run
// test:audit (it needs Playwright's Chromium): run with  node --test tests/browser/*.test.cjs
// Runs combo.html (the site is at the repository root) in Chromium with a fake Koinos RPC (no network). Used by the CC-C
// and Repo Lens C-W tests. opts.vault: "staked" | "unstaked" | (default) no answer from the vault (v6 not live).
const fs = require("node:fs"), path = require("node:path");
const { chromium } = require(process.env.PW || "/opt/npm-tools/node_modules/playwright");
const ROOT = path.resolve(__dirname, "../..");   // the repository root (tests/browser/ → ../..)
const { Serializer, utils } = require(path.join(ROOT, "node_modules/koilib"));
const abi = require(path.join(ROOT, "picks/abi/picks.koilib.json"));
const ser = new Serializer(abi.koilib_types);
const byEntry = Object.fromEntries(Object.values(abi.methods).map((m) => [m.entry_point >>> 0, m]));
const v6 = require(path.join(ROOT, "game/abi/kpred-v6.koilib.json"));
const ser6 = new Serializer(v6.koilib_types);
const v6Entry = Object.fromEntries(Object.values(v6.methods).map((m) => [m.entry_point >>> 0, m]));
const SITE = "https://knodegames.com/";
const PICKS = "1EN7xU8R9tQXjHvrX79qZvvvGkkKWVnB5K";
const ME = "1HsM33pF8DbXPr8Vsd4vD7hQgvZ1SHY3Vv";
const PRODS = ["1FKTpXBhhHEbu5vVchM8UsVbAvPArJsRmR", "12Y5vW6gk8GceH53YfRkRre2Rrcsgw7Naq", "19GYjDBVXU7keLbYvMLazsGQn3GTWHjHkK", "1ByDDSBUzy5zkRceELc54Jh8i41yNRoKt8"];
const RACE = 6 * 3600000, DAY = 86400000;

/** opts.slots(round, day) → pick_object or null; opts.delay(method, entryName, callNo) → ms; opts.files: { relPath: string }. */
async function open(opts = {}) {
  const now = Date.now(), height = 30000000;
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const calls = { get_pick: 0 };
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.route("**/*", async (route) => {
    const u = new URL(route.request().url());
    if (u.href.startsWith("https://cdn.jsdelivr.net/npm/koilib@9.4.1/")) return route.fulfill({ body: fs.readFileSync(path.join(ROOT, "node_modules/koilib/dist/koinos.min.js")), contentType: "text/javascript", headers: { "access-control-allow-origin": "*" } });
    if (u.href.startsWith("https://cdn.jsdelivr.net/npm/kondor-js")) return route.fulfill({ body: "window.kondor={getAccounts:async()=>[],getSigner:()=>null};", contentType: "text/javascript", headers: { "access-control-allow-origin": "*" } });
    if (u.origin === "https://koinos.armana.io") {
      const req = JSON.parse(route.request().postData() || "{}");
      let result = {};
      if (req.method === "chain.get_head_info") result = { head_topology: { height: String(height), id: "0x00", previous: "0x00" }, head_block_time: String(now + (opts.clockSkew || 0)), last_irreversible_block: String(height - 60) };
      else if (req.method === "chain.get_chain_id") result = { chain_id: "EiBZK_GGVP0H_fXVAM3j6EAuz3-B-l3ejxRSewi7qIBfSA==" };
      else if (req.method === "chain.read_contract") {
        const m = byEntry[req.params.entry_point >>> 0];
        if (req.params.contract_id === PICKS && m) {
          const args = await ser.deserialize(req.params.args, m.argument);
          let out = null;
          if (m.argument.endsWith("get_game_arguments")) out = { game: { id: 8, kind: 4, enabled: true, max_legs: 6, list_size: 10, round_size: "3", lock_mode: 2 } };
          if (m.argument.endsWith("get_pick_arguments")) { calls.get_pick++; if (opts.failPick && opts.failPick()) return route.fulfill({ contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: -32603, message: "node busy" } }) }); const p = opts.slots ? opts.slots(Number(args.round), Math.floor(Number(args.round) / 3)) : null; out = p ? { pick: p } : {}; if (opts.delay) await new Promise((r) => setTimeout(r, opts.delay("get_pick", calls.get_pick))); }
          if (m.argument.endsWith("get_usage_arguments")) out = { day: String(Math.floor(now / DAY)), picks_today: 1, max_picks_per_day: 12 };
          if (out) result = { result: utils.encodeBase64url(await ser.serialize(out, m.return)) };
        } else if (req.params.contract_id !== PICKS && opts.vault && v6Entry[req.params.entry_point >>> 0]) {
          // The Vault v6: live, minimum 1 VHP; the wallet's stake this week is 5 VHP (staked) or 0 (unstaked).
          const v = v6Entry[req.params.entry_point >>> 0];
          let out = null;
          if (v.argument.endsWith("get_state_arguments")) out = { config: { owner: PICKS, min_stake: "100000000", v6_rule_week_plus_one: "1" } };
          if (v.argument.endsWith("get_game_player_arguments")) out = { active_stake: opts.vault === "staked" ? "500000000" : "0", week_stake: opts.vault === "staked" ? "500000000" : "0" };
          if (out) result = { result: utils.encodeBase64url(await ser6.serialize(out, v.return)) };
        }
      }
      return route.fulfill({ contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ jsonrpc: "2.0", id: req.id, result }) });
    }
    if (u.href.startsWith(SITE)) {
      const rel = decodeURIComponent(u.pathname.slice(1)) || "index.html";
      if (opts.files && rel in opts.files) return route.fulfill({ body: opts.files[rel], contentType: rel.endsWith(".json") ? "application/json" : "text/html" });
      // The live switch is on (Repo Lens RL-24: the tests reach live mode).
      if (rel === "picks-data/deployment.json") return route.fulfill({ contentType: "application/json", body: JSON.stringify({ contract: PICKS, cards: true }) });
      const f = path.join(ROOT, rel);
      if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return route.fulfill({ status: 404, body: "" });
      const ct = f.endsWith(".html") ? "text/html" : f.endsWith(".js") ? "text/javascript" : f.endsWith(".css") ? "text/css" : f.endsWith(".json") ? "application/json" : f.endsWith(".svg") ? "image/svg+xml" : "application/octet-stream";
      return route.fulfill({ body: fs.readFileSync(f), contentType: ct });
    }
    if (/raw\.githubusercontent\.com\/bawcejawn\/Knode\/race-data\/W\d+\.json$/.test(u.href)) {
      const field = (opts.field || PRODS.map((a, i) => ({ a, vhp: 1e6 * (4 - i), k: 600 * (4 - i), h: 1 + i * 0.3 })));
      return route.fulfill({ contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ v: 1, races: [{ cards: [{ at: now - 600000, samples: 12, field }] }] }) });
    }
    if (u.href.startsWith("https://raw.githubusercontent.com/")) return route.fulfill({ status: 404, body: "", headers: { "access-control-allow-origin": "*" } });
    return route.abort();
  });
  // capture intervals so a test can fire the 60 s refresh by hand
  await page.addInitScript(({ me, legs }) => {
    window.__intervals = [];
    const si = window.setInterval; window.setInterval = (f, ms, ...a) => { window.__intervals.push({ f, ms }); return si(f, 10 ** 9, ...a); };
    localStorage.setItem("kw-accounts", JSON.stringify([{ kind: "kondor", address: me }]));
    localStorage.setItem("kw-active", me); localStorage.setItem("kw-kind", "kondor");
    localStorage.setItem("kg.combo.draft.v1", JSON.stringify(legs));
  }, { me: ME, legs: opts.legs || [] });
  await page.goto(SITE + "combo.html");
  return { browser, page, calls, errors, now, ME, PRODS };
}
/** Two open legs on the race that starts 6–12 hours from now. */
const openLegs = (now = Date.now()) => { const r = Math.floor(now / RACE) + 2; return [{ code: 1, round: r, producer: PRODS[0] }, { code: 2, round: r, producer: PRODS[1] }]; };
module.exports = { open, openLegs, ser, PICKS, ME, PRODS, DAY };

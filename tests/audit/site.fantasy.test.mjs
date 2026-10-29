// The Fantasy Producers page (fantasy.html, fantasy.js, fantasy.css): what it may load, what it may send, and
// what it must say (the owner's nodes disclosed, the rules). The scoring is tested in fantasy-math.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const APP = process.env.APP || ".";
const read = (f) => fs.readFileSync(path.join(APP, f), "utf8");
const html = read("fantasy.html"), js = read("fantasy.js"), css = read("fantasy.css");

test("page: one strict policy, the shared scoring file before the page script, no wallet keys of its own", () => {
  assert.equal((html.match(/http-equiv="Content-Security-Policy"/g) || []).length, 1);
  const csp = html.match(/content="(default-src[^"]*)"/)[1];
  assert.match(csp, /frame-src 'none'/); assert.match(csp, /object-src 'none'/);
  assert.match(csp, /connect-src 'self' https:\/\/koinos\.armana\.io https:\/\/api\.koinos\.io [^;]*https:\/\/raw\.githubusercontent\.com\/bawcejawn\/Knode\/games-data\//);
  const order = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(order.indexOf("race-math.js") < order.indexOf("fantasy-math.js") && order.indexOf("fantasy-math.js") < order.indexOf("fantasy.js"));
  assert.ok(order.includes("wallet.js"), "the shared wallet (Kondor, KOIN Vault, guest)");
  assert.ok(!/<script>(?!\s*<\/script>)/.test(html), "no inline script");
  assert.match(html, /<meta name="robots" content="noindex">/, "kept out of search until launch");
});

test("page script: builds the page with textContent only; sends only Fantasy team and rival picks", () => {
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(js), "no HTML strings or eval");
  const sends = [...js.matchAll(/picks\.functions\.pick\(\{([^}]*)\}/g)].map((m) => m[1]);
  assert.equal(sends.length, 2, "two kinds of pick: the team and the rival");
  assert.match(sends[0], /game: G\.team, round: String\(td\), producers: list/);
  assert.match(sends[1], /game: G\.rival, round: String\(F\.rivalRound\(rw\)\), producers: \[target\]/);
  assert.equal((js.match(/W\.send\(/g) || []).length, 2, "the wallet is asked to sign only those two");
  assert.match(js, /if \(target === me\(\)\)/, "no challenging yourself");
  assert.match(js, /F\.checkTeam\(s, draft\)/, "the page checks the team with the shared rules before sending");
  assert.match(js, /F\.changes\(mine\.inForce, draft\)/, "and the one-change rule");
});

test("page script: the testnet page refuses mainnet and uses its own wallet; the live page reads the live contract", () => {
  assert.match(js, /if \(TNET\.chainId === MAINNET_CHAIN_ID\) throw/);
  assert.match(js, /id === MAINNET_CHAIN_ID \|\| \(NET\.chainId && id !== NET\.chainId\)/);
  assert.match(js, /picks-data\/deployment\.json/);
  assert.match(js, /raw\.githubusercontent\.com\/bawcejawn\/Knode\/games-data\/fantasy\//);
});

test("page: says what players need to know", () => {
  assert.match(html, /Knode's own nodes/, "the owner's two producers are disclosed (owner decision 2026-10-27)");
  for (const w of ["salary cap", "captain", "One change a", "fresh start every week", "5 minutes before", "top 30%", "Weekly Rival", "all 7", "sha256"])
    assert.ok(html.includes(w), `How it works mentions "${w}"`);
  assert.match(css, /prefers-reduced-motion/);
});

test("owner 2026-10-28: All time tab; rivals need a stake; Terms say Knode's nodes run the same and others can't be controlled", () => {
  assert.match(html, /data-week="all"[^>]*>All time</);
  assert.match(html, /hold a Knode Games stake/);
  const terms = read("terms.html");
  assert.match(terms, /never changes how its own nodes produce, or their VHP, because of Fantasy/);
  assert.match(terms, /can't control what other producers or stakers do/);
  assert.match(terms, /rival match counts only when both players hold a Knode Games stake/);
});

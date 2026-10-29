// Last Node Standing page (lastnode.html, lastnode.js; rules in lastnode-math.js, shared with the recorder):
// the strict page rules, the one transaction it builds, and that the browser's math agrees with Node's.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const APP = process.env.APP || ".";
const read = (f) => fs.readFileSync(path.resolve(APP, f), "utf8");
const box = {};
vm.runInNewContext(read("race-math.js") + "\n" + read("lastnode-math.js"), box);
const L = box.KLastNode;

test("lastnode-math.js runs in a plain browser-like context with no network, storage or page access", () => {
  const src = read("lastnode-math.js");
  assert.doesNotMatch(src, /fetch\(|XMLHttpRequest|localStorage|sessionStorage|indexedDB|document\.|navigator\./);
  assert.equal(typeof L.makeField, "function"); assert.equal(L.MIN_KH, 20); assert.equal(L.START_HOUR, 14);
  assert.equal(L.LEAD, 5 * 60000, "the Picks contract's lead for time games"); assert.equal(L.AHEAD, 24 * 3600000);
  assert.equal(L.OFFSET, 13 * 3600000 + 55 * 60000, "round_offset: one round a day, locking at 13:50 UTC (owner, 2026-10-29)");
  assert.ok(Number.isInteger(L.GAME_ID) && L.GAME_ID > 0 && L.GAME_ID < 128);
});

test("lastnode.html: strict CSP (games-data, race-data and blocks-data only), scripts from the site, no inline code", () => {
  const h = read("lastnode.html");
  const csp = h.match(/http-equiv="Content-Security-Policy" content="([^"]*)"/)[1];
  for (const b of ["games-data", "race-data", "blocks-data"]) assert.match(csp, new RegExp(`connect-src [^;]*https://raw\\.githubusercontent\\.com/bawcejawn/Knode/${b}/`));
  assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/);
  assert.match(csp, /frame-src 'none'/); assert.match(csp, /object-src 'none'/);
  // No origin beyond what the race page already allows (plus the games-data branch).
  const race = read("race.html").match(/http-equiv="Content-Security-Policy" content="([^"]*)"/)[1];
  assert.equal(csp.replace(" https://raw.githubusercontent.com/bawcejawn/Knode/games-data/", ""), race);
  assert.doesNotMatch(h, /<script>(?!<\/script>)|\son[a-z]+="/, "no inline scripts or handlers");
  const order = ["guest.js", "wallet.js", "header-wallet.js", "nav.js", "chain-blocks.js", "race-math.js", "lastnode-math.js", "board.js", "lastnode.js"].map((f) => h.indexOf(`<script src="${f}"></script>`));
  assert.ok(order.every((x, i) => x > 0 && (i === 0 || x > order[i - 1])), "script order");
  for (const s of h.matchAll(/<script src="(https:[^"]+)"([^>]*)>/g)) assert.match(s[2], /integrity="sha384-[^"]+" crossorigin="anonymous"/, `SRI on ${s[1]}`);
  assert.match(h, /<link rel="stylesheet" href="board\.css">/);
});

test("lastnode.js: text only (no HTML sinks), one kind of transaction, and never a round about to lock", () => {
  const js = read("lastnode.js");
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function|localStorage|sessionStorage/);
  // The only thing it sends: a pick in this game for the connected wallet, [start] or [start, backup], number 0.
  const sends = [...js.matchAll(/W\.send\(/g)].length;
  assert.equal(sends, 1, "one send path");
  assert.match(js, /functions\.pick\(\{ player: who, game: L\.GAME_ID, round: String\(round\), producers, number: "0" \}, \{ onlyOperation: true \}\)/);
  assert.match(js, /const producers = isAddr\(backup\) && backup !== start \? \[start, backup\] : \[start\];/);
  assert.match(js, /if \(!isAddr\(start\)\) return/);
  // The contract's own rule, a minute early, right before sending.
  assert.match(js, /if \(!pickable\(round\)\) return/);
  assert.match(js, /const pickable = \(r, t = nowT\(\)\) => L\.pickable\(r, t, REG, SEND_MARGIN\)/);
  assert.match(js, /SEND_MARGIN = 60000/);
  // Data from files only reaches the page as text: every element is built by el(), which sets textContent.
  assert.match(js, /if \(k === "text"\) e\.textContent = v/);
  // The only links it makes go to the explorer.
  for (const m of js.matchAll(/href: ([^,}]+)/g)) assert.match(m[1], /^(EXPLORER \+ |`#game-\$\{g\.id|\(NET && NET\.faucet\) \|\| "https:\/\/t\.me\/KoinosTestnetFaucetBot"|NET\.faucet)/, m[1]);
});

test("the page and the recorder agree: the same field, cuts and points from the same inputs", async () => {
  await import(path.resolve(APP, "lastnode-math.js"));
  const N = globalThis.KLastNode;
  const A = (c) => "1" + c.repeat(33);
  const card = { at: 1, field: [{ a: A("A"), vhp: 900, k: 1200 }, { a: A("B"), vhp: 500, k: 660 }, { a: A("C"), vhp: 300, k: 400 }, { a: A("D"), vhp: 200, k: 260 }] };
  const f1 = L.makeField(card, 2000), f2 = N.makeField(card, 2000);
  assert.deepEqual(JSON.parse(JSON.stringify(f1)), JSON.parse(JSON.stringify(f2)));
  const hours = [{ blocks: { [A("A")]: 200, [A("B")]: 108, [A("C")]: 60, [A("D")]: 45 } }, { blocks: { [A("A")]: 190, [A("B")]: 115, [A("D")]: 40 } }, { blocks: { [A("A")]: 205, [A("B")]: 100 } }];
  const r1 = L.cutsFrom(f1, hours), r2 = N.cutsFrom(f2, hours);
  assert.deepEqual(JSON.parse(JSON.stringify(r1)), JSON.parse(JSON.stringify(r2)));
  assert.equal(r1.done, true);
  const p = { 0: r1.cuts[0].a, 2: r1.winner };
  assert.deepEqual(JSON.parse(JSON.stringify(L.playerResult(f1, r1, p))), JSON.parse(JSON.stringify(N.playerResult(f2, r2, p))));
});

test("lastnode.html is in the SEO list and the sitemap, and has the shared tab bar", () => {
  assert.match(fs.readFileSync(path.resolve(APP, "tools/site-seo.mjs"), "utf8"), /file: "lastnode\.html"/);
  assert.match(fs.readFileSync(path.resolve(APP, "sitemap.xml"), "utf8"), /knodegames\.com\/lastnode\.html/);
  assert.match(read("lastnode.html"), /<nav class="tabbar" aria-label="Main">/);
});

test("owner 2026-10-29: nothing is picked during the race; the backup is set with the start pick; stale reads ignored", () => {
  const js = read("lastnode.js");
  assert.doesNotMatch(js, /ln-jump|canJump|roundForJump|jumpOpen/, "no Jump box and no mid-race picks");
  assert.match(js, /el\("h3", \{ class: "ln-pick-h", text: "Backup \(optional\)" \}\)/);
  assert.match(js, /sendPick\(nx\.round, start, backup, /, "start and backup go in one pick for the next event");
  assert.match(js, /if \(call !== mineCall \|\| me\(\) !== who\) return;/);
  assert.match(js, /if \(who !== mineWho\) \{ drafts\.clear\(\); myPicks\.clear\(\); mineWho = who; mineOk = false; mineErr = false; \}/);
});

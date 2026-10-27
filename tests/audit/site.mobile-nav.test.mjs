// Phone navigation: every page's bottom tab bar reaches Play, Race, Swap and Leaders in one tap, and everything else
// through the "More" sheet; site/nav.js is plain (no network, no storage) and loads after the wallet scripts.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const APP = process.env.APP || ".";
const pages = fs.readdirSync(`${APP}/site`).filter((f) => f.endsWith(".html"));
const read = (p) => fs.readFileSync(`${APP}/site/${p}`, "utf8");

test("every page with a tab bar has Play · Race · Swap · Leaders · More and a More sheet with the rest", () => {
  let n = 0;
  for (const p of pages) {
    const h = read(p);
    if (!/class="tabbar"/.test(h)) continue;
    n++;
    const bar = h.match(/<nav class="tabbar"[\s\S]*?<\/nav>/)[0];
    const labels = [...bar.matchAll(/<\/svg>([^<]+)<\/(?:a|button)>/g)].map((m) => m[1]);
    assert.deepEqual(labels, ["Play", "Race", "Swap", "Leaders", "More"], `${p}: tab bar`);
    assert.match(bar, /href="race\.html"/, `${p}: Race`);
    assert.match(bar, /href="swap\.html"/, `${p}: Swap`);
    assert.match(bar, /<button type="button" class="tb-more" aria-expanded="false" aria-controls="more-sheet">/, `${p}: More button`);
    const sheet = h.match(/<div class="more-sheet" id="more-sheet" hidden>[\s\S]*?<\/div>/);
    assert.ok(sheet, `${p}: More sheet starts hidden`);
    for (const target of ["results", "how", "get.html", "mana.html", "pulse.html", "node.html", "burn.html", "welcome", "install.html", "trust.html", "terms.html"])
      assert.ok(sheet[0].includes(target), `${p}: More sheet links ${target}`);
    assert.match(h, /<script src="header-wallet\.js"><\/script>\s*<script src="nav\.js"><\/script>|<script src="nav\.js"><\/script>\s*<\/body>/, `${p}: nav.js after the wallet scripts`);
  }
  assert.ok(n >= 12, "pages checked");
});

test("nav.js only touches the page: no network, storage, eval or HTML injection", () => {
  const js = read("nav.js");
  assert.doesNotMatch(js, /fetch\(|XMLHttpRequest|localStorage|sessionStorage|indexedDB|eval\(|new Function|innerHTML|insertAdjacentHTML|document\.write/);
});

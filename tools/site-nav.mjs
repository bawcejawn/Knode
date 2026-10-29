// Writes the site's navigation into every page, so all pages stay the same. Edit the lists here, then run:
//   node tools/site-nav.mjs
// - TOP: the menu at the top (computers and tablets): Games ▾ · Leaderboards · Results · Tools ▾ · Rules ·
//   New to Koinos? · Info ▾ (owner, 2026-10-28). Dropdowns are <details> menus (they work without JavaScript;
//   nav.js closes them on an outside tap or Escape).
// - TABS + MORE: the phone tab bar (Games · Leaders · Results · Swap · More, owner 2026-10-28) and the "More" sheet,
//   grouped like the top menu (Play, Tools, Learn, About).
// - FOOT: the footer's links: only the few that belong at the bottom of every site (the rest is in the menus).
// On index.html the question-game views are links to "#view" with data-view (app.js switches views in place);
// on every other page they link to "index.html#view".
import fs from "node:fs";

const ROOT = new URL("../", import.meta.url).pathname;

const I = {
  games: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"></rect><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"></rect><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"></rect><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"></rect>',
  play: '<path d="M12 3l2.6 5.6 6 .7-4.5 4.1 1.2 6L12 16.6 6.7 19.4l1.2-6L3.4 9.3l6-.7z"></path>',
  race: '<path d="M5 21V4"></path><path d="M5 4h12l-2.5 4L17 12H5"></path>',
  swap: '<path d="M7 4L3 8l4 4"></path><path d="M3 8h14"></path><path d="M17 20l4-4-4-4"></path><path d="M21 16H7"></path>',
  leaders: '<path d="M6 20V10M12 20V4M18 20v-7"></path>',
  more: '<circle cx="5" cy="12" r="1.6"></circle><circle cx="12" cy="12" r="1.6"></circle><circle cx="19" cy="12" r="1.6"></circle>',
  results: '<path d="M9 11l3 3 8-8"></path><path d="M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9"></path>',
  rules: '<path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z"></path><path d="M9 9h6M9 13h6"></path>',
  get: '<circle cx="12" cy="12" r="8.5"></circle><path d="M12 8v8M8 12h8"></path>',
  mana: '<path d="M13 3L5 14h6l-1 7 8-11h-6z"></path>',
  pulse: '<path d="M3 12h4l2-5 4 10 2-5h6"></path>',
  lookup: '<circle cx="11" cy="11" r="6.5"></circle><path d="M16 16l4.5 4.5"></path>',
  burn: '<path d="M12 21c-4 0-6.5-2.6-6.5-6 0-3.5 3-5.5 3.5-9 2 1.5 3 3 3 5 1-1 1.5-2 1.5-3.5 2.5 2 4.5 4.6 4.5 7.5 0 3.4-2.5 6-6 6z"></path>',
  welcome: '<circle cx="12" cy="12" r="9"></circle><path d="M9.5 9.3a2.6 2.6 0 0 1 5 .9c0 1.7-2.5 2.3-2.5 3.8"></path><path d="M12 17.2v.1"></path>',
  install: '<path d="M12 4v11"></path><path d="M7.5 10.5L12 15l4.5-4.5"></path><path d="M5 20h14"></path>',
  trust: '<path d="M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6z"></path>',
  terms: '<path d="M7 3h7l4 4v14H7z"></path><path d="M10 12h5M10 16h5"></path>',
};

// [label, link, icon]. A link starting with "#" is a question-game view on index.html.
export const TABS = [["Games", "games.html", "games"], ["Leaders", "#leaderboard", "leaders"], ["Results", "#results", "results"], ["Swap", "swap.html", "swap"]];
// The More sheet, in groups (each group a heading, then its links).
export const MORE_GROUPS = [
  ["Play", [["Daily Questions", "#play", "play"], ["Producer Race", "race.html", "race"], ["Rules", "#how", "rules"]]],
  ["Tools", [["Burn KOIN", "burn.html", "burn"], ["Mana levels", "mana.html", "mana"], ["Producer lookup", "node.html", "lookup"], ["Network pulse", "pulse.html", "pulse"]]],
  ["Learn", [["New to Koinos?", "start.html", "welcome"], ["New here? Quick tour", "#welcome", "welcome"], ["Get VHP", "get.html", "get"]]],
  ["About", [["Install app", "install.html", "install"], ["Trust", "trust.html", "trust"], ["Terms &amp; risks", "terms.html", "terms"]]],
];
export const MORE = MORE_GROUPS.flatMap(([, links]) => links);
// The top menu: a link, or a dropdown { label, items }. Add a new live game to the Games dropdown when it ships.
export const TOP = [
  { label: "Games", items: [["All games", "games.html"], ["Daily Questions", "#play"], ["Producer Race", "race.html"]] },
  { label: "Leaderboards", link: "#leaderboard" },
  { label: "Results", link: "#results" },
  { label: "Tools", items: [["Swap VHP → KOIN", "swap.html"], ["Burn KOIN", "burn.html"], ["Mana levels", "mana.html"], ["Producer lookup", "node.html"], ["Network pulse", "pulse.html"]] },
  { label: "Rules", link: "#how" },
  { label: "New to Koinos?", link: "start.html", cls: "tab-start" },
  { label: "Info", items: [["Get VHP", "get.html"], ["New here? Quick tour", "#welcome"], ["Install app", "install.html"], ["Trust", "trust.html"], ["Terms &amp; risks", "terms.html"]] },
];
// Rules opens on the page's own game where there is one.
const RULES_TAB = { "race.html": "race", "swap.html": "swap" };
export const FOOT = [["Trust", "trust.html"], ["Terms &amp; risks", "terms.html"], ["Install app", "install.html"], ["Source code", "https://github.com/bawcejawn/Knode"]];

const svg = (k) => `<svg aria-hidden="true" viewBox="0 0 24 24">${I[k]}</svg>`;
function href(file, link) {
  if (!link.startsWith("#")) return `href="${link}"`;
  return file === "index.html" ? `href="${link}" data-view="${link.slice(1)}"` : `href="index.html${link}"`;
}

/** The tab bar and More sheet for one page. */
export function navBlock(file) {
  const tabs = TABS.map(([l, h, i]) => `    <a ${href(file, h)}>${svg(i)}${l}</a>`);
  const more = MORE_GROUPS.flatMap(([g, links]) => [`      <p class="ms-h">${g}</p>`, ...links.map(([l, h, i]) => `      <a ${href(file, h)}>${svg(i)}<span>${l}</span></a>`)]);
  return [
    '<nav class="tabbar" aria-label="Main">',
    ...tabs,
    `    <button type="button" class="tb-more" aria-expanded="false" aria-controls="more-sheet">${svg("more")}More</button>`,
    "  </nav>",
    '  <div class="more-sheet" id="more-sheet" hidden>',
    '    <nav class="more-panel" aria-label="More pages">',
    ...more,
    "    </nav>",
    "  </div>",
  ].join("\n");
}

/** The page a link points at, for marking the current page: "race.html", or "index.html#play". */
const target = (link) => (link.startsWith("#") ? "index.html" + link.split("/")[0] : link);
const cur = (file, link) => (!link.startsWith("#") && !link.startsWith("http") && target(link) === file ? ' aria-current="page"' : "");

/** The top menu for one page. */
export function topBlock(file) {
  const a = (l, h, cls) => `<a ${href(file, h === "#how" && RULES_TAB[file] ? `#how/${RULES_TAB[file]}` : h)}${cls ? ` class="${cls}"` : ""}${cur(file, h)}>${l}</a>`;
  const rows = TOP.map((t) => {
    if (!t.items) return `        ${a(t.label, t.link, t.cls)}`;
    const on = t.items.some(([, h]) => cur(file, h));
    return [`        <details class="dd${on ? " on" : ""}">`, `          <summary>${t.label}</summary>`, '          <div class="dd-menu">',
      ...t.items.map(([l, h]) => `            ${a(l, h)}`), "          </div>", "        </details>"].join("\n");
  });
  return ['<nav class="tabs" aria-label="Sections">', ...rows, "      </nav>"].join("\n");
}

/** The footer's links. */
export function footBlock() {
  const links = FOOT.map(([l, h]) => (h.startsWith("http") ? `<a href="${h}" target="_blank" rel="noopener">${l}</a>` : `<a href="${h}">${l}</a>`));
  return `<span class="foot-links">${links.join(" · ")}</span>`;
}

/** Replace the existing blocks in a page's HTML: the top menu, the footer's links, and the tab bar + More sheet. */
export function withNav(file, html) {
  let out = html;
  const t = out.indexOf('<nav class="tabs"');
  if (t >= 0) {
    // The top menu ends at its own closing </nav> (dropdowns use <details>, never a nested <nav>).
    const end = out.indexOf("</nav>", t);
    out = out.slice(0, t) + topBlock(file) + out.slice(end + "</nav>".length);
  }
  out = out.replace(/<span class="foot-links">[^\n]*?<\/span>/, footBlock());
  const i = out.indexOf('<nav class="tabbar"');
  if (i < 0) return out;
  const sheet = out.indexOf('<div class="more-sheet"', i);
  const close = out.indexOf("</nav>\n  </div>", sheet);
  if (sheet < 0 || close < 0) throw new Error(`${file}: tab bar found but no More sheet after it`);
  return out.slice(0, i) + navBlock(file) + out.slice(close + "</nav>\n  </div>".length);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const f of fs.readdirSync(ROOT).filter((x) => x.endsWith(".html"))) {
    const p = ROOT + f, old = fs.readFileSync(p, "utf8"), now = withNav(f, old);
    if (now !== old) { fs.writeFileSync(p, now); console.log(`nav written: ${f}`); }
  }
}

// Writes the phone navigation (the bottom tab bar and the "More" sheet) into every page that has it, so all pages
// stay the same. Edit the lists here, then run:   node tools/site-nav.mjs
// Tab bar (owner's default 2026-10-27, option A): Games · Play · Race · Swap · More. The question game's
// leaderboard moved into the More sheet, since every game page now has its own leaderboard.
// On index.html the question-game views are links to "#view" with data-view (app.js switches views in place);
// on every other page they link to "index.html#view".
import fs from "node:fs";

const ROOT = new URL("../site/", import.meta.url).pathname;

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
export const TABS = [["Games", "games.html", "games"], ["Play", "#play", "play"], ["Race", "race.html", "race"], ["Swap", "swap.html", "swap"]];
export const MORE = [
  ["Question leaderboard", "#leaderboard", "leaders"], ["Results", "#results", "results"], ["Rules", "#how", "rules"],
  ["Get VHP", "get.html", "get"], ["Mana levels", "mana.html", "mana"], ["Network pulse", "pulse.html", "pulse"],
  ["Producer lookup", "node.html", "lookup"], ["Burn KOIN", "burn.html", "burn"], ["New here?", "#welcome", "welcome"],
  ["Install app", "install.html", "install"], ["Trust", "trust.html", "trust"], ["Terms &amp; risks", "terms.html", "terms"],
];

const svg = (k) => `<svg aria-hidden="true" viewBox="0 0 24 24">${I[k]}</svg>`;
function href(file, link) {
  if (!link.startsWith("#")) return `href="${link}"`;
  return file === "index.html" ? `href="${link}" data-view="${link.slice(1)}"` : `href="index.html${link}"`;
}

/** The tab bar and More sheet for one page. */
export function navBlock(file) {
  const tabs = TABS.map(([l, h, i]) => `    <a ${href(file, h)}>${svg(i)}${l}</a>`);
  const more = MORE.map(([l, h, i]) => `      <a ${href(file, h)}>${svg(i)}<span>${l}</span></a>`);
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

/** Replace the existing block in a page's HTML (from the tab bar to the end of the More sheet). */
export function withNav(file, html) {
  const i = html.indexOf('<nav class="tabbar"');
  if (i < 0) return html;
  const sheet = html.indexOf('<div class="more-sheet"', i);
  const close = html.indexOf("</nav>\n  </div>", sheet);
  if (sheet < 0 || close < 0) throw new Error(`${file}: tab bar found but no More sheet after it`);
  return html.slice(0, i) + navBlock(file) + html.slice(close + "</nav>\n  </div>".length);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const f of fs.readdirSync(ROOT).filter((x) => x.endsWith(".html"))) {
    const p = ROOT + f, old = fs.readFileSync(p, "utf8"), now = withNav(f, old);
    if (now !== old) { fs.writeFileSync(p, now); console.log(`nav written: ${f}`); }
  }
}

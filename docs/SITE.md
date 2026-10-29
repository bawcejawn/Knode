# Website notes

## "Built on Koinos" list and the sidebar card
Both come from `ads.json`, so no code changes are needed:
- **Add an app** to the "Built on Koinos" list (footer of the game page, and the New to Koinos page): add an entry to
  `ecosystem`: `{ "name": "SwarmTales", "tagline": "One short line.", "link": "https://…", "cta": "Open" }`.
  Links must be `https://`.
- **Remove an app**: delete its entry.
- `featured` is the fixed "Run your own node" card beside the game (KoinosKit). It is not repeated in the list.

## Ad slots
Three spots on the game page: `sidebar` (computers, under the pool), `in-feed` (phones, under the questions) and
`results-inline` (under the results). An unsold slot shows nothing and takes no space. To sell one, replace its `null`
in `ads.json` with an image ad (`{ "type": "sponsor", "image": "ads/file.png", "link": "https://…", "alt": "Name" }`,
image in `ads/`) or a network iframe (its origin must also be added to `frame-src` in `index.html`'s CSP).

## Search and share tags, sitemap, robots
Run `node tools/site-seo.mjs` after changing a page's title or description there. When the custom domain is live,
change `SITE` at the top of that file to the new address and run it once: every canonical link, share tag, the
sitemap and robots.txt follow.

## Installable app
`install.html` explains installing Knode on iPhone, Android and computers (and offers the browser's install
button where there is one). Share link: https://knodegames.com/install.html

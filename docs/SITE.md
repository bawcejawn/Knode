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

## Stake panel (Vault v6)

`stake-panel.js` is one shared "stake in this game" panel for every game page except the question game (which keeps
its own controls). A page loads it after `wallet.js` (`<script src="stake-panel.js"></script>`), adds an empty
`<section class="card" id="…-stake" hidden></section>`, and calls `KStake.mount(element, { game: <vault game id> })`
from its own script. The panel stays hidden until the vault answers `get_state` with `v6_rule_week_plus_one > 0` and
the game is registered with a stake bucket. It shows the wallet's stake in that game, the game's total and this week's
minimum, whether the wallet is a staked or a free player there this week, Stake (approve + `deposit_to`), Withdraw
(`withdraw_from`, always offered with a stake, also when deposits are paused or the game has stopped), Move
(`move_stake`, counts from next week) and Claim for finished weeks (`claim_game`). Game ids: 2 Block X, 3 Survivor,
4 Fantasy, 6 Block Golf, 7 Race, 8 Combo Card, 9 Bracket, 13 Last Node Standing. Tests: `tests/audit/site.stake-panel.test.mjs`
(run it with `STAKE_PANEL_ABI=<vault-v6 game/abi/kpred.koilib.json>` to check every field against the vault until v6 is merged).

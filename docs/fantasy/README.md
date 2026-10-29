# Fantasy Producers

Draft five Koinos block producers under a salary cap, pick a captain, and score each day on how reliably they sign
their share of blocks. A weekly league (staked: the Fantasy share of the vault's weekly reward) and a Weekly Rival.
Plan and owner decisions: `claude/builds/05-fantasy-plan.md` in the KnodeGames project.

## The rules (site/fantasy-math.js)
- **Team:** 5 different producers from the week's price list, cost at most 100. The first one is the captain (×2).
- **Points:** each day, a producer scores 100 × blocks signed ÷ blocks expected (its VHP share on the Producer Race's
  hourly card), at most 130. Week = the sum of 7 days.
- **Prices:** made Sunday 12:00 UTC from each producer's form over the 7 days before: 20 + 1.5 × (form − median form),
  8 to 40. Published with its sha256; never remade.
- **Changes:** Monday's team can be any valid team. After that, one change a day: one swap, or the captain's armband.
  No pick = yesterday's team. Last week's team carries into Monday only if it fits the new list.
- **Locks:** the Picks contract refuses a team 5 minutes before its day starts.
- **Vault points:** 255 for the best week, one less per lower distinct score, ties kept, at least 1. The vault uses
  only their order.
- **Weekly Rival:** challenge one player for the next week. A match counts only if both had a team all 7 days. The record
  keeps challenges made and received apart. No prize money.
- **Knode's own nodes** are in the pool like any producer, and marked on the page.

## The parts
| File | What |
|---|---|
| `site/fantasy-math.js` | the rules and scoring; the page and the recorder both run it |
| `bot/games/fantasy.ts` | the recorder: read only, two nodes must agree, publishes `games-data/fantasy/` |
| `site/fantasy.html`, `fantasy.js`, `fantasy.css` | the game page (noindex, not in the menus until launch) |
| `.github/workflows/games.yml` | runs the recorder hourly once `FANTASY_ENABLED` is `true`; checks the files' shape |
| `bot/fantasy-test.ts`, `tools/fantasy-testnet/` | the testnet practice kit (`docs/fantasy/TESTNET.md`) and its offline rehearsal |

## Picks contract games
| Id | What | Kind | Round | Lock | Opens |
|---|---|---|---|---|---|
| 4 | Fantasy team | list of 5 (captain first) | one per UTC day | 5 min before the day | 7 days ahead |
| 5 | Weekly Rival | one address (any wallet) | the week's Monday (rounds are days) | 5 min before the week | 7 days ahead |

## Tests
```
node --test tests/audit/fantasy-math.test.mjs
node --import tsx --test tests/audit/fantasy-recorder.test.mjs tests/audit/fantasy-testnet.test.mjs tests/audit/site.fantasy.test.mjs
node --import tsx tools/fantasy-testnet/rehearse.mjs        # about 5 minutes: 2.5 test weeks end to end, offline
```

## Before launch (needs the vault and the Picks contract live)
1. Independent audit and fix-check of this branch.
2. Register Picks games 4 and 5 on mainnet (48 h wait), with the settings `KFantasyMath.games()` prints.
3. Merge; set `FANTASY_ENABLED=true`; first price list the Sunday before the launch Monday.
4. Vault v6: register Fantasy as a staked game; the operator posts each final week's vault points.
5. Add the page to the menus, `tools/site-seo.mjs` and the sitemap; remove the noindex.

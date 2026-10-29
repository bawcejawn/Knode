# Fantasy Producers

Draft five Koinos block producers under a salary cap, pick a captain, and score each day on how reliably they sign
their share of blocks. A weekly league (staked: the Fantasy share of the vault's weekly reward) and a Weekly Rival.
Plan and owner decisions: `claude/builds/05-fantasy-plan.md` in the KnodeGames project.

## The rules (fantasy-math.js)
- **Team:** 5 different producers from the week's price list, cost at most 100. The first one is the captain (×2).
- **Points:** each day, a producer scores 100 × blocks signed ÷ blocks expected (its VHP share on the Producer Race's
  hourly card), at most 130. Week = the sum of 7 days.
- **Prices:** made Saturday 00:00 UTC (2 days before the week; owner 2026-10-29) from each producer's form over the 7
  days before: 20 + 1.5 × (form − median form), 8 to 40. Published with its sha256; never remade.
- **Plan ahead:** once the prices are out, a team (and a change for any later day) can be saved for any day up to 7
  days ahead. A planned day can be changed until its own lock. The page warns when changing an earlier day would make a
  planned day break the one-change rule, and reminds you when next week's prices are out and your team won't play.
- **No late-pick edge:** prices are fixed before anyone picks; a producer's expected blocks follow its VHP every hour,
  so VHP moves don't change scores; the only fresh information is node health (Yesterday/Today), shown to everyone.
- **Changes:** Monday's team can be any valid team. After that, one change a day: one swap, or the captain's armband.
  No pick = yesterday's team. Last week's team carries into Monday only if it fits the new list.
- **Locks:** the Picks contract refuses a team 5 minutes before its day starts.
- **Vault points:** 255 for the best week, one less per lower distinct score, ties kept, at least 1, ranked among the
  week's Fantasy stakers only (`stakedOf`, once the vault is live; until then `index.json` says `vaultBasis: "all"`).
  The vault uses only their order.
- **Weekly Rival:** challenge one player for the next week. A match counts only if both had a team all 7 days and both
  hold a Knode Games stake (owner, 2026-10-28; read on both nodes when the week is finished; the practice kit counts
  every test player). The record keeps challenges made and received apart. No prize money.
- **All time** (owner, 2026-10-28): each final week adds every player's points to `alltime.json` (total, weeks played,
  best week); the page's league has an "All time" tab. No prize.
- **Knode's own nodes** are in the pool like any producer, marked on the page, and run the same way whatever the game
  (Terms, section 3). Knode Games can't control how others stake or unstake on any node (also in Terms).

## The parts
| File | What |
|---|---|
| `fantasy-math.js` | the rules and scoring; the page and the recorder both run it |
| `bot/games/fantasy.ts` | the recorder: read only, two nodes must agree, publishes `games-data/fantasy/` |
| `fantasy.html`, `fantasy.js`, `fantasy.css` | the game page (noindex, not in the menus until launch) |
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

## Results into the vault (claude/handoff-vault-results.md)
- Source for `game-data/deployment.json` → `vaultGames`: **`games-data:fantasy`** (vault game 4).
- For each final week the recorder writes `fantasy/vault/W<week>.json`: `{ "game": 4, "week", "final": true, "rows":
  [{ "player", "points" }], "first": [], "second": [] }`. Fantasy is a staked game, so no free-prize winners.
- `rows`: the players with at least 1 VHP staked in Fantasy that week (`get_game_player` week_stake, or the stake frozen
  at the week's start) and at least 1 point, as 255 for the best week and one less per lower score (ties kept).
  Stakes are read on both nodes and must agree.
- Written only once the vault is live (the game ABI has `get_game_player`); until then `index.json` says
  `vaultBasis: "all"` and there is no vault file. A week is normally final 12 hours after it ends (vault deadline 3
  days; ALERT at 2). The publish job refuses to change a vault file once published.
- Weekly Rival with the vault live: a match counts only when both players are staked in Fantasy that week.

## Safety rails (audit 2026-10-28, FX-1 to FX-10)
- A week is final only when all 7 days' blocks (two nodes) and all 7 days' picks are read, the rivals are read, and
  12 hours have passed. A week still not final 2 days after it ends raises an `ALERT` warning (the vault deadline is 3 days); unfinished weeks are
  retried for 8 weeks.
- A day is final only when every hour with blocks has a race card.
- The workflow stops rather than record from empty files if the games-data branch can't be read, and the publish job
  refuses to change a published price list, a final week, counted rival weeks, a rival record or an all-time total.
- Final days must be checked on two nodes. Final weeks keep teams as positions on the price list (small files);
  Fantasy files may be up to 8 MB, and a Fantasy failure never blocks Block X's publishing.

## Before launch (needs the vault and the Picks contract live)
1. Independent audit and fix-check of this branch.
2. Register Picks games 4 and 5 on mainnet (48 h wait), with the settings `KFantasyMath.games()` prints.
3. Merge; set `FANTASY_ENABLED=true`; first price list the Saturday (00:00 UTC) before the launch Monday.
4. Vault v6: register Fantasy as staked game 4; add `games-data:fantasy` to `vaultGames`. Once the v6 ABI is in
   `game/abi`, the recorder reads Fantasy stakes and writes the vault files by itself; the vault bot posts them.
5. Add the page to the menus, `tools/site-seo.mjs` and the sitemap; remove the noindex.

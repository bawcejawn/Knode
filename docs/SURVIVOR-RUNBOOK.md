# Survivor runbook (owner)

Survivor runs itself: the hourly KnodeGames workflow (`.github/workflows/games.yml`) records each UTC day, publishes
the handicaps and plays the season with `survivor-math.js`. This page covers launch and the few things that need
you.

## Launch
1. The KnodeGames Picks contract is live (Build 3) and `picks-data/deployment.json` on `main` names it.
2. Register game 3 on the Picks contract with exactly these settings. The recorder checks every setting below except
   the name, on both nodes, and records no season day while any differs. It also warns while a change to game 3 is
   announced, and says whether the change would break Survivor:

   | Setting | Value |
   |---|---|
   | id | 3 |
   | name | Survivor |
   | kind | 1 (one producer) |
   | list_size | 1 |
   | lock_mode | 2 (time) |
   | round_size | 86400000 (one UTC day) |
   | round_offset | 0 |
   | lead | 300000 (5 minutes: picks lock at 23:55 UTC) |
   | ahead | 604800000 (7 days) |
   | max_picks_per_day | 20 |
   | max_changes | 5 |
   | enabled | true (a closed game would make every player miss a pick) |

3. Pick the launch Monday. In `survivor-math.js`, set `FIRST_DAY` to that Monday's UTC day number. In PowerShell:

   ```powershell
   [math]::Floor(([datetimeoffset]'2026-11-16T00:00:00Z').ToUnixTimeMilliseconds() / 86400000)
   ```

   Commit, open a PR, and merge it at least 7 days before that Monday, so players can pick day 1 ahead.
4. The vault (Build 1, v6) pays the season prizes: 4 VHP and 2 VHP per two-week season.
   - The recorder publishes one results file per vault week at `games-data:survivor/vault/W<week>.json` (vault week 0
     began Monday 19 Oct 2026). A season's first week has no winners; its last week lists the season's 1st and 2nd.
   - Each file also lists `rows`: Survivor's staked players with their points for that week (the vault pays its
     stake bucket from them). The recorder reads who is staked with the vault's `get_game_player` (game 3, peak stake
     at least the minimum) once a day while a week runs, and once more after it ends; both nodes must agree. A season
     is final only once both of its weeks are over, so an early-ending season's prizes wait for its second week.
   - In the vault, game 3 is a staked and free-prize game (`game-add 3 "Survivor" --staked --free`) with `season_weeks` 2, and its `from_week` must be Season 1's first
     week: `floor((FIRST_DAY − 20745) ÷ 7)`. For Monday 16 Nov 2026 that is week 4. If it is off by one week, the vault
     looks for winners in the wrong week.
   - `game-data/deployment.json` → `vaultGames`: `"3": { "name": "Survivor", "results": "games-data:survivor/vault" }`.
   - More than 10 wallets tied for a place: the vault takes at most 10, so that place gets no prize (it returns to the
     pool) and the recorder warns.

## When the workflow warns "season N is stuck"
The recorder couldn't record a season day for more than 50 days: for example, the two nodes kept disagreeing about
that day's picks, or the season's file was lost. New days and handicaps keep coming; only that season waits.

1. Open the latest **KnodeGames recorders** run on GitHub (Actions tab). Read the warnings just above the stuck one:
   they say why (nodes disagree, VHP check failed, more than 100,000 picks).
2. Decide:
   - **Void the season.** Announce it, then remove its number from `index.json` on the `games-data` branch. Ask Claude
     to make that change and show it to you first.
   - **Fix the data.** Only while the season's next day is less than 50 days old. If one node was wrong, set the
     repository variable `RPC_CHECK` to another public node and let the recorder catch up (3 days a run). The recorder
     keeps the block counts of the last 60 days only, so a season stuck longer than about 50 days can't catch up by
     itself any more: void it, or ask Claude for a one-off catch-up run (Repo Lense SV-A15).

## When the workflow warns "game 3's … on the chain is …"
Game 3's settings on the Picks contract don't match the table above. No season is recorded until they do. Announce the
right settings with the Picks contract's 48-hour notice, then apply them.

## Other warnings
- **"S001.json is … MB, near or over the 2 MB publish limit"**: a very big season. Over 2 MB, only that file is left
  out of publishing (the page keeps showing the last copy that went out); days, handicaps and Block X still publish. The
  run fails, which emails you. Ask Claude to look at it.
- **"only one node is read this run"** or **"RPC_CHECK is the same node as RPC"**: set the repository variable
  `RPC_CHECK` to a second, different node. Days saved meanwhile are checked again on it automatically; a day the second
  node disagrees with is reported ("saved from one node, and the second node disagrees") for you to look at.
- **"a change to game 3 is announced"**: someone with the Picks owner key announced new settings. If the warning says
  "once applied, …", cancel the change (`cancel_game_change`) unless you meant it.
- **"VHP check: …" for the same season day, run after run**: the stake read on the Knode contract keeps failing
  (for example after a contract change, or a node that refuses it). The day waits rather than wrongly marking stakers;
  try another node for `RPC_CHECK`, and ask Claude if it lasts more than a day.
- **"game-data/deployment.json names no Knode contract"**: the Knode contract's address is missing, so stakes can't be
  checked. No season day is recorded until it is back.
- **"the two nodes disagree"** about a day: it is tried again every hour. If it lasts more than a day, check both nodes.
- **"Not publishing survivor this run"**: Survivor's files failed the publish check, so the workflow published the
  other games and left Survivor's files out. The run fails, which emails you. Ask Claude to look at the run's log.

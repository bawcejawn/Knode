# Survivor runbook (owner)

Survivor runs itself: the hourly KnodeGames workflow (`.github/workflows/games.yml`) records each UTC day, publishes
the handicaps and plays the season with `site/survivor-math.js`. This page covers launch and the few things that need
you.

## Launch
1. The KnodeGames Picks contract is live (Build 3) and `picks-data/deployment.json` on `main` names it.
2. Register game 3 on the Picks contract with exactly these settings. The recorder refuses to record seasons if any
   differs:

   | Setting | Value |
   |---|---|
   | id | 3 |
   | name | Survivor |
   | kind | 1 (one producer) |
   | lock_mode | 2 (time) |
   | round_size | 86400000 (one UTC day) |
   | round_offset | 0 |
   | lead | 300000 (5 minutes: picks lock at 23:55 UTC) |
   | ahead | 604800000 (7 days) |
   | max_picks_per_day | 20 |
   | max_changes | 5 |

3. Pick the launch Monday. In `site/survivor-math.js`, set `FIRST_DAY` to that Monday's UTC day number. In PowerShell:

   ```powershell
   [math]::Floor(([datetimeoffset]'2026-11-16T00:00:00Z').ToUnixTimeMilliseconds() / 86400000)
   ```

   Commit, open a PR, and merge it at least 7 days before that Monday, so players can pick day 1 ahead.
4. The vault (Build 1) pays the season prizes: 4 VHP and 2 VHP per two-week season.

## When the workflow warns "season N is stuck"
The recorder couldn't record a season day for more than 50 days: for example, the two nodes kept disagreeing about
that day's picks, or the season's file was lost. New days and handicaps keep coming; only that season waits.

1. Open the latest **KnodeGames recorders** run on GitHub (Actions tab). Read the warnings just above the stuck one:
   they say why (nodes disagree, VHP check failed, more than 100,000 picks).
2. Decide:
   - **Void the season.** Announce it, then remove its number from `index.json` on the `games-data` branch. Ask Claude
     to make that change and show it to you first.
   - **Fix the data.** If one node was wrong, set the repository variable `RPC_CHECK` to another public node and let the
     recorder catch up (3 days a run).

## When the workflow warns "game 3's … on the chain is …"
Game 3's settings on the Picks contract don't match the table above. No season is recorded until they do. Announce the
right settings with the Picks contract's 48-hour notice, then apply them.

## Other warnings
- **"the two nodes disagree"** about a day: it is tried again every hour. If it lasts more than a day, check both nodes.
- **"Not publishing survivor this run"**: Survivor's files failed the publish check, so the workflow published the
  other games and left Survivor's files out. The run fails, which emails you. Ask Claude to look at the run's log.

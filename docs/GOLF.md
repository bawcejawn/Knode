# Block Golf: how it works and how to turn it on

Block Golf is a golf course made of every other Knode Games game. Each live game is a par-4 hole, and a player's place on
that game's weekly leaderboard sets their strokes. There is nothing to pick, so Block Golf has **no contract, no picks and
costs players no Mana**. It only reads the results the other games already publish.

Rules: `site/golf-math.js` (the page and the recorder both run it). Plan and owner decisions: `claude/builds/06-block-golf-plan.md`
in the KnodeGames project.

## The pieces

| Piece | File | What it does |
|---|---|---|
| Rules | `site/golf-math.js` | Place → strokes, the mulligan, points, places. |
| Recorder | `bot/games/golf.ts` | Every hour: builds every player's scorecard from each game's results and writes `games-data/golf/`. Reads only; holds no key. |
| Mainnet workflow | `.github/workflows/golf.yml` | Runs the recorder hourly at :57. **Off until `GOLF_ENABLED` = `true`.** |
| Page | `site/golf.html`, `golf.js`, `golf.css` | Your scorecard, holes you haven't played, the leaderboard. |

## How a game becomes a hole

1. The game is marked `"status": "live"` in `site/games.json`.
2. `bot/games/golf.ts` has a reader for it (today: `questions`, `race`, `blockx`). Survivor, Bracket and the other games
   add theirs when they launch, with a test (Survivor's should recompute the standings at the week's last season day
   with `site/survivor-math.js`, not keep a snapshot: audit H4).
3. It plays from the **Monday after** it went live, so nobody loses strokes on a game that didn't exist all week.

No contract, vault or sponsor change is needed to add a hole. A new game's own build adds its reader and a test.

## Turn on practice scorecards (with Who Signs Block X)

Do these after Block X is live and its recorder has published at least once.

1. Merge the `golf` branch (after its audit and fix-check).
2. In `site/games.json`, change Block Golf's line to `"status": "live", "href": "golf.html"`.
3. In `tools/site-nav.mjs`, add `["Block Golf", "golf.html"]` to the Games menu (and the Play group of the More sheet), then in `C:\kprediction`:

   ```powershell
   node tools/site-nav.mjs
   node --test tests/audit/site.*.test.mjs
   ```

4. GitHub → Settings → Secrets and variables → Actions → Variables → New variable: `GOLF_ENABLED` = `true`.
5. GitHub → Actions → "Block Golf recorder" → Run workflow. It should finish green. Then open
   `https://raw.githubusercontent.com/bawcejawn/Knode/games-data/golf/index.json`: it lists the course.

The first run puts every game that is already live on the course straight away.

## Staked Block Golf (after the Knode Games vault, v6)

- Add Block Golf (game id 6) to the vault registry (48-hour notice).
- For each final staked week the recorder writes the Vault's file `games-data:golf/vault/W<week>.json` (game 6; every
  player staked in Block Golf that week with 1+ points, 1–255; no free-prize winners). The hourly vault bot posts it.
  Its source for `game-data/deployment.json` → `vaultGames` is **`games-data:golf`**. A sent file can't be changed by
  the recorder (the publish job refuses it); corrections go through the owner's 24-hour correction window on the Vault.

## No testnet run (owner, 2026-10-28)

Block Golf has no contract, so there is nothing to upload to a testnet. It was tested on the real files' shapes and on
the Race's real week; its first mainnet weeks are practice weeks with no prizes, which is its live trial.

## Practice and staked weeks

- Until `GOLF_STAKED_FROM_WEEK` is set (a GitHub variable), every week is practice: every player who scored on a game
  counts, and 3 make a hole.
- When the vault is live, set `GOLF_STAKED_FROM_WEEK` to the first staked week (the number in the W file names, e.g.
  `6` for `W006.json`). From that week a hole's field is the players **staked in Block Golf** that week (at
  least 1 VHP, read from the vault on two nodes) who scored on that game, **counted by whole VHP staked, not by
  wallets** (owner, 2026-10-28): splitting a stake over many wallets changes nothing. A hole needs at least 5 VHP and
  10% of the week's Block Golf stake among its scorers. Players not staked in Block Golf still get a scorecard (Free
  play board) but never make up a field.
- The question game hole keeps Block Golf's simple rule (owner, 2026-10-28).
- Staked weeks need the vault (v6) live and merged: the recorder refuses to start if `GOLF_STAKED_FROM_WEEK` is set
  before it can read Block Golf stakes. Order: vault v6 live → v6 merged → Block Golf registered (id 6) → set the variable.
- A hole in a staked week becomes final only after the stakes are read once the week has ended; if they still can't be
  read 66 hours after the week, the hole is skipped rather than scored on older reads.
- The vault takes only scorecards with at least 1 point (a player who played a single hole has it dropped by the
  mulligan and scores 0).

## Running it on your PC (optional)

From `C:\kprediction`, with the race and games files copied into two folders:

```powershell
$env:RACE_DATA = "C:\temp\race-data"; $env:GAMES_DATA = "C:\temp\games-data"; $env:GOLF_OUT = "C:\temp\golf"
npm run golf
```

It prints each week's holes and how many scorecards it made. It only reads; it never sends a transaction.

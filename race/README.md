# Knode Producer Race: picks

A small contract that keeps the **free** Producer Race picks. No entry fee, no wager, no pot, no token. A wallet picks
one horse (a block producer) for a race; the race recorder (`bot/race.ts`) scores the picks after the race and the
website shows the leaderboard. This contract only keeps the picks and makes the **chain itself** enforce the rules:

- A race is a 6-hour UTC window: race number `r` runs from `r × 6 h` to `(r + 1) × 6 h` after 1970-01-01 00:00 UTC, so
  races start at 00:00, 06:00, 12:00 and 18:00 UTC (the same days and weeks as the Knode game).
- Picks are open for the **next 4 races** (the coming 24 hours) and **lock when the race starts**: a pick is refused
  once the head block's time has reached the race's start.
- **One pick per wallet per race.** It can be changed until the race starts.
- At most **5 picks per wallet per UTC day** (new picks and changes together; the owner can set 1 to 20).
- The pick must be **signed by the wallet it is for**. Nobody (not even the owner) can pick for someone else.
- The horse is any valid address: the race's handicap card is set off the chain, so a pick on a producer that is not
  in the race simply can't win.

It holds no funds and never pays Mana. **The Knode Mana sponsor pays for picks** (sponsor v2 treats a pick like a game
answer: free play for any wallet, within the sponsor's caps; wallets with no VHP and no stake also count against the
free daily total). It is uploaded with **no authority overrides**: upgrades need the race wallet's own key, settings
need the Knode owner's key (the very first setup needs the race wallet's key).

## Set it up (PowerShell, in `C:\kprediction`)

1. **Create the race wallet** in Kondor: a brand-new wallet (not the owner, bot, sponsor or any contract). Write its
   recovery words on paper. Put its private key in `.env` as `RACE_WIF=...`. Send it about **50 KOIN** for the upload's
   Mana (you can move it back out afterwards).
2. **Build and test**:
   ```
   cd race
   npm ci
   npm test
   cd ..
   certutil -hashfile race\build\release\contract.wasm SHA256
   ```
   The hash must match this README's "Build" line.
3. **Upload**: `npm run racepicks -- upload`, read it, then `npm run racepicks -- upload --send`. It refuses any build
   other than the audited one, and checks afterwards that the code is exactly that and no override is on.
4. **First setup** (owner = the Knode owner, picks on, 5 a day): `npm run racepicks -- setup`, then `--send`.
5. **Let the sponsor pay for picks**: upgrade the sponsor to v2 (sponsor/README.md), then
   `npm run sponsor -- config --per-player-day 10 --per-player-week 65 --send` (it adds the race contract from
   `race-data/deployment.json` and makes room for 5 picks a day next to the 5 answers), and
   `npm run sponsor -- payer sponsor --send` so the website lists the race contract.
6. **Pin it for guests**: put the race contract's address in `wallet.js` (`const PINNED_RACE = "1…";`). Guest
   wallets only ever sign picks on this pinned address (like the pinned game and sponsor); until it is set, guests can
   answer but not pick.
7. **Commit and push** `race-data/deployment.json`, `game-data/deployment.json`, `desk-data/deployment.json` and
   `wallet.js`: the Race page then shows the pick buttons, and the race recorder starts reading picks.
8. **Check**: `npm run racepicks -- status`.

To pause picks: `npm run racepicks -- disable --send` (owner's key, `OWNER_WIF`). Picks already made stay recorded.

## Build

Release build sha256 (audited 2026-10-27, docs/history/AUDIT-2026-10-27-race-picks.md): `61e8f21230e8b4bdb165bacfe7281517a5adf78f6c6b1b8a0d84ce41537afac5` (17,066 bytes).
Tests: 22 contract tests (`npm test`, in the Koinos mock VM), including the auditor's attack tests (`Race.audit.spec.ts`).

## Weekly results for the KnodeGames Vault (game 7)

The race recorder (`bot/race.ts`) writes `vault/W<week>.json` on the `race-data` branch for the week that just ended.
Its source for the vault is `race-data:vault` (for `game-data/deployment.json` → `vaultGames."7".results`).

```json
{ "game": 7, "week": 2, "final": true, "skipped": [],
  "rows":   [ { "player": "1Abc…", "points": 255 }, { "player": "1Ghi…", "points": 254 } ],
  "first":  [ "1Def…" ], "second": [ "1Jkl…" ] }
```

**Two boards (owner, 2026-10-28).** A wallet is a *staked* player in a week if its peak stake in the Race (game 7)
that week is at least the vault's minimum, by the vault's own test (`get_game_player` → `entry.peak_stake`, or
`active_stake` with no entry). A wallet staked at the start of a week stays staked that week even if it withdraws.
Everyone else is a *free* player, guests included. Before the vault (v6) is live, everyone is free.
- `rows`: staked players with at least 1 point, in board order, as 255, 254, … per tied group (only the order and the
  ties matter to the vault).
- `first` / `second`: the free players' 1st and 2nd. A tie for 1st takes both prizes (2nd stays empty). When more than
  10 wallets tie for a place, the 10 whose first pick that week came earliest (the time the chain recorded) share it
  and the rest get nothing.
- Ranking: points (win 3, show 1), then wins, then picks placed. Wallets still tied share the place. The question game
  no longer breaks Race ties (owner, 2026-10-28).

**When it's final:**
- once every race of the week is final, or a race still open 12 hours after the week ends is skipped (listed in
  `skipped`; its picks don't count);
- and every Race stake was read and reads the same on the second node.

Until then the file says `"final": false` with nothing in it.

**Safety:**
- A file published as final never changes: the recorder keeps it, and the publish job refuses any change.
- The publish job also refuses a final file for a week that hasn't ended by the runner's own clock.
- If the last run's files can't be read, the run stops instead of starting from nothing.

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
   npm ci --ignore-scripts
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
6. **Pin it for guests**: put the race contract's address in `site/wallet.js` (`const PINNED_RACE = "1…";`). Guest
   wallets only ever sign picks on this pinned address (like the pinned game and sponsor); until it is set, guests can
   answer but not pick.
7. **Commit and push** `race-data/deployment.json`, `game-data/deployment.json`, `desk-data/deployment.json` and
   `site/wallet.js`: the Race page then shows the pick buttons, and the race recorder starts reading picks.
8. **Check**: `npm run racepicks -- status`.

To pause picks: `npm run racepicks -- disable --send` (owner's key, `OWNER_WIF`). Picks already made stay recorded.

## Build

Release build sha256 (audited 2026-10-27, docs/history/AUDIT-2026-10-27-race-picks.md): `61e8f21230e8b4bdb165bacfe7281517a5adf78f6c6b1b8a0d84ce41537afac5` (17,066 bytes).
Tests: 22 contract tests (`npm test`, in the Koinos mock VM), including the auditor's attack tests (`Race.audit.spec.ts`).

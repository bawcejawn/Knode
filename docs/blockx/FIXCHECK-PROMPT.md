# Fix-check prompt, round 3: Block X (BX-35 to BX-52) + sponsor v3 (SP-1 to SP-21)

Copy everything below the line into Repo Lens. Give it the package `knode-fixcheck-3.zip` (the repository
`bawcejawn/Knode` at the commit in `00-COMMIT.txt`, branch `picks`, with this prompt as `00-FIXCHECK-PROMPT.md`).

---

You are an independent smart-contract and web security auditor. Your report "Block X Fix-Check + Sponsor v3 Audit
(Knode picks @ 148c00f)" (verdict *fix first* for both parts) has been worked through. The owner's record of every
fix, with the owner's decisions, is the "Round 2" section of `docs/history/AUDIT-2026-10-28-repolens-blockx.md`; your
report is `docs/history/AUDIT-2026-10-28-repolens-fixcheck.md`. Check the code, not the comments. Send no transaction
to mainnet. The repository's own tests can be run:

```
npm ci --ignore-scripts
npm run test:audit:serial
cd picks && npm ci --ignore-scripts && npm test && npm run check && cd ..
cd sponsor && npm ci --ignore-scripts && npm test && npm run check && cd ..
```

Fingerprints: Picks release `700c296a1064b904299c156061d6caf8fcabd0b1765968903f29d89d2426c594` (unchanged); Picks
testnet (`node picks/scripts/build-testnet.cjs --owner 1JZ5UoH4AU5roCgYEmtJ7G6mCvzE4jSTMC`)
`39cc5e003c234b0e0b054376bdb53245e97157202ae971a11bc5cc490f7aa7ab` (unchanged); **sponsor v3
`3cdab1a75f066f0c65b09597ad8f35cf1b6e02fc2a37327bbf479db9a03b71a3` (34,374 bytes, changed)**.

## What changed since 148c00f

1. **The site moved to its own domain.** `main` (knodegames.com, pages at the repository root, `CNAME`) is merged into
   `picks`; Block X's page files moved from `site/` to the root. `site/` now holds only redirects.
2. **Every Block X / race finding** BX-35 to BX-52: `bot/race.ts` (`combineReads`, `windowHigh`, `samplesIn`,
   `productionFloor`, `sample`, the card section), `.github/workflows/race.yml` and `race-samples.yml`,
   `bot/games/blockx.ts` (`firstCardAfter`, `MIN_CARD_SAMPLES`, BX-46 and BX-48), `wallet.js` (guest origin allowlist,
   `sameArgs`), `board.js`, `bot/picks.ts` (`sameNode`, one primary node).
3. **Old guest keys (BX-39)**: `tools/old-origin-guest/guest-move.html`, a no-network page for the old
   `bawcejawn.github.io` address that moves a guest key to knodegames.com and erases it there.
4. **Block X takes stakes** (owner, 2026-10-28): a wallet is on the Staked board only with at least the vault's minimum
   staked IN Block X (game 2) that week (`readVault`, `vaultView`, `stakedSet`; vault v6 `get_game_player`). Before v6
   is live nobody is staked. The weekly vault file (`blockx/vault/W<week>.json`) now carries `rows` (staked players the
   vault counts for the week, 1-255 in board order, `vaultPoints`) and the free board's `first`/`second`; a wallet
   staked here at any point that week can't win the free prize. The page shows the player's stake in Block X and mounts
   the site's shared stake panel when it exists (it signs nothing itself).
5. **Sponsor v3 contract** (`sponsor/assembly/Sponsor.ts`, `sponsor.proto`):
   - SP-2: `isPlayer` reads only stakes: ACTIVE stake in the question game (`get_player`), or this week's stake in the
     call's own game (`get_game_player`, for allowlist rows with `game_arg` and for race picks, game 7). No VHP
     balance, no pending stake.
   - SP-3: `freeReleased`: the free pool is released by the hour (1/24 at 00:00 UTC, all of it from 23:00).
   - SP-16: `arg_types` bytes carry 0x10 for a repeated field; only those may repeat.
   - `MAX_ARGS_BYTES` 640 (Combo Card up to 10 legs).
6. **Sponsor tool** (`bot/sponsor.ts`, `bot/mana-limits.ts`): every SP finding in the record, plus `usageAlerts` and
   `watch` (an 80% warning, run by `.github/workflows/bot.yml` every hour).

## Look hardest at

1. **SP-2 in the contract**: can a wallet still count as a real player without a stake that is active this week?
   Is reading the game id from `game_arg` (`argsVarint`) safe when `argsPlayer` already accepted the arguments, and can
   a caller choose a game it is staked in while the call is for another? Do race picks (game 7) and the Picks row
   (`game_arg` 2) read the right game? Can the extra cross-contract reads (at most 4 games) be abused for cost?
2. **SP-3**: `freeReleased` arithmetic at hour 0 and 23, day rollover, and `would_pay` agreeing with `authorize`.
3. **SP-16 / 640 bytes**: the repeated-field rule in `argsPlayer` and the `set_config` checks on `arg_types` and
   `game_arg`; that the sponsor and the Picks v1 decoder still read the same player.
4. **BX-35 / BX-36 / BX-37 / BX-38** as asked in your report's "What would prove or disprove" section.
5. **Block X stakes**: the Staked board, the bucket rows and the free prize follow the player rule exactly (staked in
   THIS game that week; a mid-week withdrawal stays on the Staked board at its lowest stake; staked elsewhere is free
   here); both nodes agree before a vault file is written; the publish check (`vault_ok` in both games workflows)
   keeps each wallet in one list.
6. **BX-39 / BX-40**: the guest origin allowlist and the move page (no network, no other script, erase only after
   the player confirms).

## Report

For every finding of your round-2 report (BX-35 to BX-52, SP-1 to SP-21): fixed / partly / not fixed, with file:line,
and anything new (BX-53…, SP-22…). Then a verdict per part: "ready for mainnet", "fix first" or "not ready", and what
must be fixed before mainnet. Add a failing test for each new High or Medium where you can.

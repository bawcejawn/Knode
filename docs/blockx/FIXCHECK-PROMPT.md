# Fix-check prompt, round 4: Block X (BX-53 to BX-71) + sponsor v3 (SP-22 to SP-36)

Copy everything below the line into Repo Lens. Give it the package `knode-fixcheck-5.zip` (the repository
`bawcejawn/Knode` at the commit in `00-COMMIT.txt`, branch `picks`, with this prompt as `00-FIXCHECK-PROMPT.md`).

---

You are an independent smart-contract and web security auditor. Your report "Block X + Sponsor v3: Round-3 Fix-Check
(Knode picks @ 1c66ddc)" (verdict *fix first* for both parts) has been worked through. The owner's record of every fix,
with the owner's decisions, is the "Round 3" section of `docs/history/AUDIT-2026-10-28-repolens-blockx.md`. Your failing
tests are in the repository (`tests/audit/repolens-r3-*.test.*`, the sponsor's SP-22 test in
`sponsor/assembly/__tests__/Sponsor.v3.spec.ts`), next to behaviour tests written with the fixes
(`tests/audit/repolens-r3-blockx-behaviour.test.mjs`). Check the code, not the comments. Send no transaction to mainnet.
The repository's own tests can be run:

```
npm ci --ignore-scripts
npm run test:audit:serial
cd picks && npm ci --ignore-scripts && npm test && npm run check && cd ..
cd sponsor && npm ci --ignore-scripts && npm test && npm run check && cd ..
```

Fingerprints: Picks release `700c296a1064b904299c156061d6caf8fcabd0b1765968903f29d89d2426c594` (unchanged); Picks
testnet (`node picks/scripts/build-testnet.cjs --owner 1JZ5UoH4AU5roCgYEmtJ7G6mCvzE4jSTMC`)
`39cc5e003c234b0e0b054376bdb53245e97157202ae971a11bc5cc490f7aa7ab` (unchanged); **sponsor v3
`b21251d42beb1c4dd104194c6833d64abe0887c43d9631406765c8c7027aef96` (34,652 bytes, changed)**.

## Owner decisions since your report (2026-10-29)

1. Every wallet, free or staked, gets at most 25 Mana a day and 150 a week (`DEFAULT_CAPS`).
2. Knode Swap is never sponsored: the contract refuses any call to the Desk and any approve naming the Desk; the tool
   writes the swap page as players' own Mana and refuses to upload v3 (or send config) while the deployed swap page
   still asks the sponsor (runbook step 4a, before the upgrade).
3. The old-address guest move page (`tools/old-origin-guest/`) is deleted: the guest wallets made at
   `bawcejawn.github.io` before 28 October were empty test wallets. BX-39, BX-66, BX-70 and BX-71 are closed by that.
4. SP-2 and SP-3 (lock-outs by many wallets) are accepted for launch, with the alert now emailing (SP-31). Your attack-model
   tests for them are not in the suite. The free-prize rule against many wallets is decided before prizes start.

## What changed since 1c66ddc

- **Sponsor contract** (`sponsor/assembly/Sponsor.ts`, `sponsor.proto`): SP-28 `isPlayer` asks `get_player` for the
  current vault week and reads `active_stake` (field 3; `scripts/check.ts` compares the field numbers with the game's
  ABI); SP-22 `would_pay_arguments.game` (field 4) passed to `isPlayer`; Desk calls refused (`SWAPS_NOT_SPONSORED`),
  approves only to the game; dead `isFreePlay` removed; proto header rewritten.
- **Sponsor tool / site** (`bot/sponsor.ts`, `wallet.js`, `testnet-wallet.js`, `.github/workflows/bot.yml`): SP-29 to
  SP-36 as in the record (`switchedConfig`/`setSwitch`, `secondNode`, `manaAlerts`, testnet paths first, failed reads
  abort, `sponsorAnswer`/`gameOfOps` in the site, `e.included` in the testnet wallet).
- **Race cards** (`bot/race.ts`, `race.yml`, `race-samples.yml`): BX-54 (`LIB_LAG_MAX`, `LIB_GAP_MAX`, `HEAD_GAP_MS`; a
  card's `at` must fit its leg in the publish check), BX-55 (`combineReads` lower read + `flagged` on the card), BX-56
  (sampler vs this computer's clock), BX-57 (higher supply; impossible supply ignored), BX-53 (the sampler also reads
  every producer on the latest published card; the job fetches the last two race week files), BX-59 (`ALLOW_ONE_NODE`).
- **Block X** (`bot/games/blockx.ts`, `blockx.js`, `games.yml`, `games-testnet.yml`): BX-61 (`game/abi/kpred-v6.koilib.json`
  committed, `STATE_ABI` first), BX-63 (`vaultReader`, `stakeCache`, `pool`), BX-53 (`scoringVhpMoves`, `vhpInflows`,
  `withMoved`, `MOVE_MARGIN`), BX-55 (`flags`, lock card held/voided, after-card skipped), BX-62/BX-65 (publish check
  ties the vault file to `board.json` `lastWeek`; a differing re-publish fails), BX-64, BX-67.

## Look hardest at

1. **SP-28 / SP-22**: is `active_stake` for the current week exactly what the game (v5 live now, and v6) means by a
   stake this week? Does the site send the right `game` for every sponsored call shape, and can a wallet claim a game
   it isn't staked in to get a yes it wouldn't get from `authorize`?
2. **Swaps out**: any remaining path where the sponsor pays for a Desk action (approve, swap, a bundled operation), and
   whether the site can still choose the sponsor for a swap.
3. **BX-53**: are the receipt events read correctly for Koinos mainnet's VHP contract (event names, `impacted`, data
   fields for transfer and mint), is the block range right (lock card time to X, plus `MOVE_MARGIN`), and can a producer
   still move VHP in so neither card nor this check sees it (e.g. a move inside a block the range misses, or effective
   VHP counted another way)?
4. **BX-54 / BX-55**: can one node still steer a card (window, time, a producer's VHP), or now cheaply void targets by
   disagreeing (the flag holds the target)? Is the leg bound in `race.yml` right for the 3-card (2-hour) races too?
5. **BX-62 / BX-65**: can the publish job still be made to keep a wrong vault file, or to reject the honest one?
6. **BX-61 / BX-63**: the real ABI on the mainnet path; the cache never turns a failed read into "not staked".

## Report

For every finding of your round-3 report (BX-53 to BX-71, SP-22 to SP-36, and the round-2 items still open): fixed /
partly / not fixed, with file:line, and anything new (BX-72…, SP-37…). Then a verdict per part: "ready for mainnet",
"fix first" or "not ready", and what must be fixed before mainnet. Add a failing test for each new High or Medium where
you can.

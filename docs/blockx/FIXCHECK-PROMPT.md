# Fix-check prompt, round 5: Block X (BX-72 to BX-85) + sponsor v3 (SP-37 to SP-43)

Copy everything below the line into Repo Lens. Give it the package `knode-fixcheck-6.zip` (the repository
`bawcejawn/Knode` at the commit in `00-COMMIT.txt`, branch `picks`, with this prompt as `00-FIXCHECK-PROMPT.md`).

---

You are an independent smart-contract and web security auditor. Your report "Block X + Sponsor v3: Round-4 Fix-Check
(Knode picks @ cc524eb)" (verdict *fix first* for both parts) has been worked through. The owner's record, with the
owner's decisions, is the "Round 4" section of `docs/history/AUDIT-2026-10-28-repolens-blockx.md`. Your round-4 failing
tests are in the repository (`tests/audit/repolens-r4-race.test.mjs`, `tests/audit/repolens-r4-publish/`,
`tests/audit/repolens-r4-sponsor-tool-site.test.mjs`, the SP-37/SP-28 specs at the end of
`sponsor/assembly/__tests__/Sponsor.v3.spec.ts`) and pass, next to behaviour tests written with the fixes
(`tests/audit/repolens-r3-blockx-behaviour.test.mjs`, `tests/audit/sponsor.tool.test.ts`). Check the code, not the
comments. Send no transaction to mainnet. The repository's own tests can be run:

```
npm ci --ignore-scripts
npm run test:audit:serial
cd picks && npm ci --ignore-scripts && npm test && npm run check && cd ..
cd sponsor && npm ci --ignore-scripts && npm test && npm run check && cd ..
```

Fingerprints: Picks release `700c296a1064b904299c156061d6caf8fcabd0b1765968903f29d89d2426c594` (unchanged); Picks
testnet (`node picks/scripts/build-testnet.cjs --owner 1JZ5UoH4AU5roCgYEmtJ7G6mCvzE4jSTMC`)
`39cc5e003c234b0e0b054376bdb53245e97157202ae971a11bc5cc490f7aa7ab` (unchanged); **sponsor v3
`b61ac238da27c4a71c01127f39a7b95f19fabf15e35df9f9715546d221e256e4` (35,052 bytes, changed)**.

## Owner decisions since your report (2026-10-30)

1. SP-37: a "vault live" switch in sponsor v3 (`config.game_has_vault`, field 15), off until Vault v6 is live; the
   tool reads it from the game's state (`get_state` config `v6_rule_week_plus_one`, owner required) on two nodes.
2. The old-address guest move page was deleted on purpose (2026-10-29): the pre-move guest wallets were empty test
   wallets. BX-39, BX-66, BX-70 and BX-71 are closed by that; the round-3 W-1 test now checks the page is gone.
3. SP-2 and SP-3 remain accepted for launch.

## What changed since cc524eb

- **Sponsor contract**: `game_has_vault` gates the `get_game_player` loop in `isPlayer` and the vault's own calls in
  `checkOperation` (`VAULT_NOT_LIVE`); `would_pay_arguments.games` (field 5, repeated) joins `game` (field 4).
  `scripts/check.ts` pins the vault calls and `get_game_player` against `game/abi/kpred-v6.koilib.json`.
- **Sponsor tool** (`bot/sponsor.ts`): `vaultLiveOn`, `capsOf`; enable now runs the config path (every setting from the
  files, caps from the chain when both nodes agree, website check, every line printed); disable (`setSwitch`) uses the
  node's settings only when a second node agrees, else the file-built settings switched off; status/README wording;
  watch failure reported as such.
- **Site** (`wallet.js`): `gamesOfOps` (vault calls: field 2; every game of a batch), `sponsorAnswer` sends
  `answer_only` for free play and `games`; "switched off" guest message. `desk-data/deployment.json` on the branch:
  players' own Mana (SP-42).
- **Race cards** (`bot/race.ts`, `race.yml`, `race-samples.yml`): `combineReads(…, sameBlock)` with the non-enumerable
  `__topInDoubt`; `readBoth` (both nodes between two head reads); card keys `topInDoubt` and `height`; `LIB_GAP_MAX`
  200, `HEAD_GAP_MS` 15 s ahead, `LAG_MS` 10 min behind; leg-end clamp; next week's card in the sampler.
- **Block X** (`bot/games/blockx.ts`): `vhpInflows` + `lastVarint` (BX-72); `flags` includes `topInDoubt`; receipt range
  from `card.height`; `scoringVhpMoves` checks every block and runs 4 calls at a time; `STATE_ABI` owner required.
- **Publish** (`games.yml`, `games-testnet.yml`): the published branch is read first; prize and vault files judged
  against it and the job's clock (`GENESIS`, `CHECK_NOW_MS` only for tests); held files (`$HELD`) are skipped, the rest
  published, the job fails at the end on an alert; PREV gets `vault/`.
- `common.ts withRetry`: 30 s per call.

## Look hardest at

1. **SP-37**: can a wallet still make the sponsor call `get_game_player` while `game_has_vault` is off, or get a vault
   call paid? Is reading v6-ness from `get_state` on two nodes safe, and is the "re-run config on v6 day" step enough?
2. **SP-39**: can one node still get settings signed through enable or disable?
3. **BX-72**: does `lastVarint` + `impacted[0]` now read every transfer and mint exactly as the VHP contract applies
   it (including malformed bytes the contract would reject)?
4. **BX-73 / BX-74 / BX-75**: the `topInDoubt` rule (is "higher read ≥ the combined top" the right test?), same-block
   reads (can a liar fake "different blocks" to get the higher read for a producer it wants big?), and what one node can
   still do with 10 minutes of allowed lag.
5. **BX-79 / BX-80 / BX-81**: the publish job's new order of steps, the hold list, the clock rule, the recomputed points
   and first/second; can a bad run still get a wrong prize or vault file published, or block the honest one? The W-file
   residual in the record.
6. Any new problem the round-4 fixes brought in (last round two Highs came from round-3 fixes).

## Report

For every finding of your round-4 report (BX-72 to BX-85, SP-37 to SP-43, and the earlier items still open): fixed /
partly / not fixed, with file:line, and anything new (BX-86…, SP-44…). Then a verdict per part: "ready for mainnet",
"fix first" or "not ready", and what must be fixed before mainnet. Add a failing test for each new High or Medium where
you can.

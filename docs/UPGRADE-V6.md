# Upgrade to game v6, the KnodeGames Vault: runbook

Nothing in this file has been run. Every command that changes something is a dry run until you add `--send`, and
mainnet also needs `CONFIRM_MAINNET=yes` in `.env`. Run everything in PowerShell in `C:\kprediction`.

| | |
|---|---|
| Contract | `1Mpmf2ERhjYpX7CCiM11WERuM4j17uT1sr` (the game; it becomes the vault, same address) |
| Live code | `c17066ae988d204fd43d43f662ad87fcdc38170419943c20b5164a5bd34dd784` (v5, uploaded 2026-10-28) |
| **New code** | **set after the audits' fixes** (after the second fix-check's fixes: `eed38f7ce130d9d2e0dfafa8ddd5c4a6f383e2c7ce12ab87b02c584f43920b3d`, 86,114 bytes; final once the audits are clean). Emergency withdrawals-only build: `e84fec492d47e08f583c352bb26e3d36dc0149926c0482d0820b0dbd97af9fe3`, 84,688 bytes (pinned in `game-data/deployment.json` as `safeWasmSha256`; the bot refuses any other) |
| Timelock | 48 h after `schedule`, then 7 days to upload |
| Upload paid by | the owner wallet: about **91 KOIN of Mana** (the tool checks it) |
| Design | `docs/V6-PLAN.md`; owner explainer: the Docs page "KnodeGames Vault: how it works" |

## Before you start (all must be true)

1. **Done:** the audits are clean (owner, 2026-10-29: the owner's own audit programs count; RepoLens fix-check 4 said "ready for the rehearsal"), and branch `vault-v6` holds the fixed code.
2. **Sponsor:** sponsor v3, with the Vault's calls added (`claude/handoff-sponsor-vault-calls.md`), is live. Without it, staking in other games, moving stake and claiming their prizes aren't sponsored.
3. **Seed:** it covers the free prizes, 3 VHP a week per game with a free prize. The question game, Block X, Survivor and the Race need 12 VHP a week, roughly **3,000 VHP** of seed at today's ~90 VHP of weekly rewards; with Producer Bracket, 15 VHP a week, roughly **3,750 VHP**. When the seed's share is short, every prize is cut that week:
   ```
   npm run bot -- seed-vhp <VHP>           then again with --send
   ```
4. **Build and tests on your PC:**
   ```
   git fetch
   git checkout vault-v6
   git pull
   npm ci --ignore-scripts
   cd game; npm ci --ignore-scripts; npm test; npm run build:safe; npm run build:sim; npm run check; cd ..
   node --import tsx --test game/scripts/storage-compat.test.ts game/scripts/storage-compat-v6.test.ts bot/*.test.ts
   certutil -hashfile game\build\release\contract.wasm SHA256
   certutil -hashfile game\build\safe\contract.wasm SHA256
   ```
   The first hash must be the **New code** above, the second the emergency build's. If either isn't, stop. (If a build step stops with `EAGAIN`, run it again.)
5. **The rehearsal on a copy of the real contract** (read-only, no key; about 2 minutes):
   ```
   npm run bot -- vault-snapshot --out v5-snapshot.json
   npm run bot -- rehearse-v6 --snapshot v5-snapshot.json --weeks 3
   ```
   It must end with `All vault rehearsal checks passed.` Send the snapshot file and the output to the Vault chat. The file holds only public data.
6. **Chain check:**
   ```
   npm run bot -- chain-check
   ```
   Every line ✔, and nothing else announced.
7. **Timing:** announce on a Saturday or Sunday. The upload then lands on Monday or Tuesday, and the games you add right after it start on the same Monday as the new rules.

## 1. Announce (starts the 48 hours)
```
npm run bot -- upgrade schedule            then again with --send
```
The bot emails you about it (expected). Players see it on the Trust page.

## 2. Wait 48 hours
Don't rebuild in between. `npm run bot -- upgrade status` should say "matches".

## 3. Upload
```
npm run bot -- status > before-v6.txt
npm run bot -- upgrade apply               then again with --send
```
It reads the new fingerprint back from the chain and writes it into `game-data/deployment.json`. Then:
```
git add game-data/deployment.json
git commit -m "Upgraded: game v6 (KnodeGames Vault)"
git push
npm run bot -- admin cancel_upgrade --as owner --send
```

## 4. Put the v6 bot live
Merge branch `vault-v6` into `main` on GitHub (pull request, then merge). **Do this the same day:** the Race, Block Golf and Producer Bracket recorders (and any other that reads the vault's ABI from `main`) refuses to write its results file until `game/abi/kpred.koilib.json` on `main` has the vault's methods, so a late merge would roll those weeks over. The hourly bot then knows the vault: other games' results, finalizing, alerts and status. The v5 bot keeps working on v6 until then, so there is no rush within the day.

## 5. Verify
```
npm run bot -- chain-check
npm run bot -- status
npm run bot -- games
```
- chain-check: all ✔, with the new fingerprint.
- status matches `before-v6.txt`: same stakes, seed and pots, apart from new block rewards.
- games lists game 1, Questions.
- Then GitHub → Actions → Kpred bot → Run workflow: it must finish green.

## 6. Add the games (right after the upload)
The first game announcement is also the first v6 transaction. It switches the rules on from the next Monday. Announce every game that should pay prizes from that Monday:
```
npm run bot -- game-add 2 "Who Signs Block X" --staked --free           then again with --send
npm run bot -- game-add 3 "Survivor" --staked --free --season 2         then again with --send
npm run bot -- game-add 7 "Producer Race" --staked --free               then again with --send
```
Staked games are added the same way when each one launches (for example `game-add 13 "Last Node Standing" --staked`). **Producer Bracket also pays a free prize** (its chat's request, 2026-10-29): `game-add 9 "Producer Bracket" --staked --free`.

**Survivor's timing:** a game earns from the week after you apply it, and Survivor's seasons start at its first week. Its Season 1 starts Monday 16 Nov 2026 (vault week 4), so **apply game 3 between Mon 9 Nov and Sun 15 Nov (UTC)**, which means announcing it between Sat 7 Nov and Fri 13 Nov. If the vault isn't live by then, tell the Survivor chat: its first season then starts with the week after you apply it (`npm run bot -- games` shows its "from week").

Each game's results source goes into `game-data/deployment.json` (its chat gives you the line), for example:
```json
"vaultGames": { "2": { "name": "Who Signs Block X", "results": "games-data:blockx/vault" } }
```

## 7. 48 hours later, by Sunday: apply them
```
npm run bot -- game-apply 2 --send
npm run bot -- game-apply 3 --send
npm run bot -- game-apply 7 --send
npm run bot -- games
```
Each game shows "from week N", the coming Monday.

## 8. The first vault weeks
- **Monday 00:00 UTC:** the vault rules start. The question game pays 2 + 1 VHP to its best free players.
- **Next Monday 12:00 UTC:** the first vault close.
  - `npm run bot -- status` shows the fee in VHP, the seed's share, the prizes and each game's bucket.
  - `npm run bot -- games` shows each game's week.
- **Tuesday to Thursday:** the bot posts each game's results once its recorder publishes them, then seals them.
  - You have 24 hours after the seal to correct anything: `game-correct`, `game-unprize` or `game-void`.
  - The bot finalizes each week 24 hours after the seal (12 hours after your last correction, if later). Once finalizing has started, nothing can be corrected. Winners then claim.
- **Fee:** `npm run bot -- claim-fee-vhp all --send` collects the 5% in VHP. The KOIN fee from v5 weeks is still `claim-fee`.

## If something goes wrong
- **A game misbehaves:**
  - `npm run bot -- game-stop <id> --send` stops it at once. Players keep full access to their stake.
  - `game-void <id> <week> --send` rolls a bad week over.
- **Bad results:** `game-correct <id> <week> <player> <points> --send` within 24 hours of the seal.
- **Deposits:** `npm run bot -- pause on --send` stops new deposits and moves. Withdrawals and claims never stop.
- **Stolen bot key:** `npm run bot -- admin set_operator operator=<new address> --as owner --send`. A stolen bot key can, at worst, misdirect one week's bucket or prize in one game, which you can correct. It can never touch stakes.
- **Never roll back to v5.** The vault refuses to schedule v5's (or v3's) fingerprint: that code can't see stakes in other games or what's owed in VHP.

## Emergency: the withdrawals-only build
If something is wrong and everything must stop, upgrade to the withdrawals-only build. It keeps the same address and
storage and lets money out: every stake (`withdraw`, `withdraw_from`), prizes of finished weeks, the seed (only what
isn't needed to cover players: the seed takes any shortfall first) and your fee. Deposits, moves, answers, new
questions, closes and finalizing are refused. **Recording results stays open** (settling, resolving and correcting
questions, posting, sealing, correcting and voiding other games' results), because their deadlines keep running: the
hourly bot keeps doing its part, and you can still fix or void bad results. New block rewards wait in the vault for
the fixed build.

1. Build it and note its fingerprint (keep it with this runbook):
   ```
   cd game; npm run build:safe; cd ..
   ```
   It prints `sha256 …` for `game\build\safe\contract.wasm`, and rebuilds the normal build afterwards.
2. Stop new money at once while the 48 hours run: `npm run bot -- pause on --send`, and `game-stop <id> --send` for any game that misbehaves. Keep the contract's own Mana for withdrawals: `npm run bot -- admin set_sponsor_limit max_sponsor_rc=0 min_sponsor_rc=0 --as owner --send` (the safe build never sponsors a call either).
3. Announce it: `npm run bot -- upgrade schedule --safe`, then again with `--send`.
4. Before applying, make sure the bot has settled the closed question weeks and posted and sealed every ended game week (its hourly run does this; `npm run bot -- status` shows what is open), and correct or void anything wrong.
5. 48 hours later: `npm run bot -- upgrade apply --safe`, then again with `--send`.
6. Tell players on the site: withdraw any time; claims for **finalized** weeks work. Weeks that are closed but not finalized wait for the normal build: their results are kept (they can still be recorded and corrected), and they finalize when it returns. A week whose results were not sealed by its deadline still rolls over, as it would in normal times.
7. Going back: fix the bug, build normally, and upgrade again the usual way (48 hours).

## Mana (before announcing, on testnet)
Measure what the heaviest calls cost with 13 games (audit V6-12): a close with 13 games, an answer that closes and
finalizes a week, a 50-row `post_results`, and a 500-place finalize page. Each must fit the sponsor's per-call limit.

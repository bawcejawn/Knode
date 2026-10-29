# Upgrade to game v6, the KnodeGames Vault: runbook

Nothing in this file has been run. Every command that changes something is a dry run until you add `--send`, and
mainnet also needs `CONFIRM_MAINNET=yes` in `.env`. Run everything in PowerShell in `C:\kprediction`.

| | |
|---|---|
| Contract | `1Mpmf2ERhjYpX7CCiM11WERuM4j17uT1sr` (the game; it becomes the vault, same address) |
| Live code | `c17066ae988d204fd43d43f662ad87fcdc38170419943c20b5164a5bd34dd784` (v5, uploaded 2026-10-28) |
| **New code** | **set after the audits' fixes** (today's build: `ea914c84…9364`, 81,910 bytes; it will change) |
| Timelock | 48 h after `schedule`, then 7 days to upload |
| Upload paid by | the owner wallet: about **91 KOIN of Mana** (the tool checks it) |
| Design | `docs/V6-PLAN.md`; owner explainer: the Docs page "KnodeGames Vault: how it works" |

## Before you start (all must be true)

1. **Done:** the RepoLens audit, its fix-check and the third-party audit are clean; branch `vault-v6` holds the fixed code.
2. **Sponsor:** sponsor v3, with the Vault's calls added (`claude/handoff-sponsor-vault-calls.md`), is live. Without it, staking in other games, moving stake and claiming their prizes aren't sponsored.
3. **Seed:** it covers the free prizes. Four free games need 12 VHP a week, roughly **3,000 VHP** of seed at today's ~90 VHP of weekly rewards:
   ```
   npm run bot -- seed-vhp <VHP>           then again with --send
   ```
4. **Build and tests on your PC:**
   ```
   git fetch
   git checkout vault-v6
   git pull
   npm ci --ignore-scripts
   cd game; npm ci --ignore-scripts; npm test; npm run check; npm run build:sim; cd ..
   node --import tsx --test game/scripts/storage-compat.test.ts game/scripts/storage-compat-v6.test.ts bot/vault.test.ts bot/rehearse-v6.test.ts
   certutil -hashfile game\build\release\contract.wasm SHA256
   ```
   The hash must be the **New code** above. If it isn't, stop. (If a build step stops with `EAGAIN`, run it again.)
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
Merge branch `vault-v6` into `main` on GitHub (pull request, then merge). The hourly bot then knows the vault: other games' results, finalizing, alerts and status. The v5 bot keeps working on v6 until then, so there is no rush within the day.

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
npm run bot -- game-add 2 "Who Signs Block X" --free           then again with --send
npm run bot -- game-add 3 "Survivor" --free --season 2         then again with --send
npm run bot -- game-add 7 "Producer Race" --free               then again with --send
```
Staked games are added the same way when each one launches (for example `game-add 13 "Last Node Standing" --staked`).

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
  - The bot finalizes each week 12 hours after the seal (or after your last correction). Winners then claim.
- **Fee:** `npm run bot -- claim-fee-vhp all --send` collects the 5% in VHP. The KOIN fee from v5 weeks is still `claim-fee`.

## If something goes wrong
- **A game misbehaves:**
  - `npm run bot -- game-stop <id> --send` stops it at once. Players keep full access to their stake.
  - `game-void <id> <week> --send` rolls a bad week over.
- **Bad results:** `game-correct <id> <week> <player> <points> --send` within 24 hours of the seal.
- **Deposits:** `npm run bot -- pause on --send` stops new deposits and moves. Withdrawals and claims never stop.
- **Stolen bot key:** `npm run bot -- admin set_operator operator=<new address> --as owner --send`. A stolen bot key can, at worst, misdirect one week's bucket or prize in one game, which you can correct. It can never touch stakes.
- **Rollback:** another upgrade, with the same 48-hour notice, scheduling the v5 fingerprint. **Only safe before other games take stakes**: v5 can't see stakes in other games. Once they do, stop those games first and have their players withdraw, or move their stake back to the question game, and claim.

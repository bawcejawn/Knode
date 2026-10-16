# Kprediction — security audit (before the first deploy)

Scope: the game contract (`game/assembly/Kpred.ts`, `Tokens.ts`), the bot (`bot/`), and the website (`site/`).
Focus: can anyone's tokens ever be lost, stuck or taken?

## 1. Where the money is, and who can move it

| Money | Held as | Who can take it out | Limits |
|---|---|---|---|
| Players' stakes | VHP | Only the player, to their own wallet | Any amount up to their stake, at any time. Never pausable. |
| Players' rewards | VHP | Only the winning player | Exactly pot × points × stake ÷ total, rounded down |
| Seed (soft launch and full) | VHP + KOIN | Only the seed owner | Only after a 48-hour public timelock, never more than the seed |
| Creator fee (5%) | KOIN | Only the owner | Never more than the fee earned |
| Owner share (2%) | VHP | Only the owner | Never more than the share earned |

After every reward, fee or share payout the contract re-checks that it still holds everything it owes ("solvency
check"). If a bug ever tried to pay out more than was earned, the whole transaction would be cancelled.

## 2. Keys and what each one can do

| Key | Where it lives | Can do | Cannot do |
|---|---|---|---|
| Contract key (`CONTRACT_WIF`) | `.env` on your PC | Sign the first setup (`init`) during deploy | Anything after deploy: the contract refuses it for token moves, code changes and fees |
| Admin / owner (`OWNER_WIF`) | `.env` on your PC, back up offline | Correct a result before the week closes, change the bot, pause **new** deposits, collect fee and share, schedule a code change | Touch players' stakes or rewards; change code without 48 hours' notice |
| Bot / operator (`OPERATOR_WIF`) | `.env` + GitHub secret | Post and resolve questions | Move any tokens |
| Player | The player's own wallet | Deposit, withdraw, answer, collect | Act for anyone else |

## 3. What this audit changed

1. **Withdrawals: any amount, to the last decimal.** Deposits stay whole numbers. A player can now always take out every
   unit (tested: 0.12345678 VHP, then the rest, back to the exact starting balance).
2. **Code upgrades can't switch off the contract's protections.** A code change already needed the owner's signature, the
   exact pre-announced code and a 48-hour wait. But Koinos also lets an upload switch off three "this contract decides"
   settings. With them off, whoever holds the contract key could have moved the pool's tokens directly. The contract now
   refuses any upload that switches them off.
3. **No arithmetic trick in question windows.** A huge, nonsensical block number in a question could have wrapped the
   maths around and passed the "the window ends in time" rule. The check is now written so this can't happen. (Only the
   bot can post questions, and the owner could always void one, so this was low risk.)
4. **Seed KOIN withdrawal can't get stuck.** If part of the seed KOIN was temporarily held as VHP, the withdrawal now
   pays what's on hand and the rest later, instead of failing.
5. **Fairer withdrawals mid-week.** Taking back only a top-up that hasn't started counting yet no longer cancels that
   week's answers. Touching the stake that counts this week still does.
6. **Website:** withdraw accepts decimals and has a "Withdraw all" button; the stake/KOIN choice is hidden when
   withdrawing; explorer links point to koinosscan.com.
7. **Bot:** `withdraw <amount>` accepts decimals, `withdraw all` takes everything; alert emails show dates instead of
   raw numbers for scheduled upgrades and seed withdrawals.

## 4. Checked and found safe

- Nobody can withdraw, claim or answer for another wallet (each action requires that wallet's signature).
- A stake can't be withdrawn twice; the contract subtracts before it sends.
- Rewards can't be claimed twice, and the total paid for a week can never exceed its pot.
- Free players (no stake) are never eligible and can never be paid.
- Fees, the owner share and the seed are tracked separately from players' money; compounding never burns the seed KOIN
  or the unpaid creator fee.
- Weeks close, settle and finalise in order, with the time windows enforced by block time.
- The pool pays Mana only for one valid answer, settle or claim by a staked player, with a 10 KOIN cap per transaction.
- The registered block-producer key can't redirect rewards: blocks are always credited to the contract's address.
- Numbers can't overflow: the reward maths uses 128-bit arithmetic.

## 5. Risks that remain (by design), and how they're covered

| Risk | Cover |
|---|---|
| The admin key is stolen | Code changes and seed withdrawals take 48 hours, and the bot emails you at once. Players' stakes stay withdrawable throughout. Keep the key offline. |
| The bot key is stolen | It can't move tokens. It could post wrong results; the owner can correct them before the week closes (12-hour window), and anyone can recheck results from the published block data. Replace it with `set_operator`. |
| The pool's node is down | No funds at risk, only lower rewards. The bot emails after 1 hour of silence. |
| Withdrawal needs VHP that is momentarily held as KOIN | The contract burns spare KOIN back into VHP first. In the rare case Mana is short, the message says to try again shortly. |

## 6. Test results

- Contract tests: **43 / 43 pass**, including the new ones for decimal withdrawals, upgrade protections, the window
  overflow and the seed KOIN shortfall.
- Offline checks: all pass.
- Two-week rehearsal on real Koinos block history, ending with a full exit (every player withdraws everything, the owner
  collects fee and share, the seed leaves after its timelock): see the latest run in the deploy notes.

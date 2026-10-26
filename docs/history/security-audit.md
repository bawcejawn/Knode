> Historical: written before commit 3fd563d and describes older code. Kept as a record. For the current game see the top-level README.md; for the latest upgrade and audit see docs/UPGRADE-V5.md.

# Kprediction — security audit (before the first deploy)

Scope: the game contract (`game/assembly/Kpred.ts`, `Tokens.ts`), the bot (`bot/`), and the website (`site/`).
Focus: can anyone's tokens ever be lost, stuck or taken?

## 1. Where the money is, and who can move it

| Money | Held as | Who can take it out | Limits |
|---|---|---|---|
| Players' stakes | VHP | Only the player, to their own wallet | Any amount up to their stake, at any time. Never pausable. |
| Players' rewards | VHP | Only the winning player | Basket A by rank + basket B by rank × stake, rounded down at every step, so a week's claims never exceed its pot |
| Seed (soft launch and full) | VHP + KOIN | Only the seed owner | Only after a 48-hour public timelock, never more than the seed |
| Producer fee (5%) | KOIN | Only the owner | Never more than the fee earned; charged once (a carried-over pot isn't charged again) |

After every reward or fee payout the contract re-checks that it still holds everything it owes ("solvency
check"). If a bug ever tried to pay out more than was earned, the whole transaction would be cancelled.

## 2. Keys and what each one can do

| Key | Where it lives | Can do | Cannot do |
|---|---|---|---|
| Contract key (`CONTRACT_WIF`) | `.env` on your PC | Sign the first setup (`init`) during deploy | Anything after deploy: the contract refuses it for token moves, code changes and fees |
| Admin / owner (`OWNER_WIF`) | `.env` on your PC, back up offline | Correct a result before the week closes, change the bot, pause **new** deposits, collect the producer fee, schedule a code change | Touch players' stakes or rewards; change code without 48 hours' notice |
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
   Also found by the rehearsal's new "everyone leaves" test: when the seed's VHP **and** KOIN were withdrawn together,
   the contract topped up its VHP by burning KOIN *before* sending the KOIN back, so the KOIN transfer then failed and
   the whole withdrawal was refused. Nothing was lost (a failed transaction changes nothing), but the seed could have
   been stuck. It now sends the KOIN first. A test reproduces the old failure and passes with the fix.
5. **Fairer withdrawals mid-week.** Taking back only a top-up that hasn't started counting yet no longer cancels that
   week's answers. Touching the stake that counts this week still does.
6. **Website:** withdraw accepts decimals and has a "Withdraw all" button; the stake/KOIN choice is hidden when
   withdrawing; explorer links point to koinosscan.com.
7. **Bot:** `withdraw <amount>` accepts decimals, `withdraw all` takes everything; alert emails show dates instead of
   raw numbers for scheduled upgrades and seed withdrawals.

8. **Library versions pinned.** The contract build tools and wallet library are fixed to exact versions, and the
   lockfiles are committed. A malicious "latest" release of a library can't slip onto the PC that holds the keys.
9. **Ads are walled off.** Network ads run in a sandboxed frame with no access to the page or the wallet; sponsor ads
   are a plain image and link; only https (or the site's own) links are accepted.
10. **Upgrade tool** (`npm run bot -- upgrade …`): it refuses to upload anything except the exact announced code, after
    the 48 hours, signed by the owner, with the contract's protections switched on, and it clears the notice afterwards.

## 4. Checked and found safe

- Nobody can withdraw, claim or answer for another wallet (each action requires that wallet's signature).
- A stake can't be withdrawn twice; the contract subtracts before it sends.
- Rewards can't be claimed twice, and the total paid for a week can never exceed its pot.
- Free players (no stake) are never eligible and can never be paid.
- The producer fee and the seed are tracked separately from players' money; compounding never burns the seed KOIN
  or the unpaid producer fee.
- Weeks close, settle and finalise in order, with the time windows enforced by block time.
- The website never asks the game to pay Mana: players pay their own. The contract itself can still pay the Mana for one answer, settle or claim by a staked player, because sponsorship is decided on chain, not by the website. It is switched on today: the cap set at deployment is 2 KOIN per transaction (the code allows at most 10), and the bot uses it for the weekly settles. From the v4 upgrade it pays only for a transaction that will succeed, with an rc_limit between a floor (half the cap unless the owner sets one) and the cap, with canonical arguments, and for each staked account (at least the minimum stake) at most one answer per question posted that week, plus one settle and one claim, so a 1-VHP player can answer every question for free. The owner can set the cap to 0 (`npm run bot -- sponsor-limit 0`) to switch it off.
- The registered block-producer key can't redirect rewards: blocks are always credited to the contract's address.
- Numbers can't overflow: the reward maths uses 128-bit arithmetic.
- The website never builds HTML from text it loads (no `innerHTML`), so question data can't inject code into the page.
- Withdrawing or settling or claiming in a different order or timing never changes how much any week earned (tested).

## 5. Risks that remain (by design), and how they're covered

| Risk | Cover |
|---|---|
| The admin key is stolen | Code changes and seed withdrawals take 48 hours, and the bot emails you at once. Players' stakes stay withdrawable throughout. Keep the key offline. |
| The bot key is stolen | It can't move tokens. It could post wrong results; the owner can correct them before the week closes (12-hour window), and anyone can recheck results from the published block data. Replace it with `set_operator`. |
| The pool's node is down | No funds at risk, only lower rewards. The bot emails after 1 hour of silence. |
| The bot is down for more than a day around Monday–Tuesday | Players who keep playing are settled automatically. Others who don't act during the 24-hour settle window miss that week's reward (the rest of the winners share it). The email alert fires after 1 hour. |
| A staked player spams answer attempts that fail | Sponsorship is capped on chain at 2 KOIN per transaction. A node refuses a transaction that fails against the current state, so only a block producer could include failing sponsored transactions; v4 also refuses any that cannot succeed (unfinalized claims, too-small rc_limit, padded arguments) and caps each account's sponsored answers per week. `sponsor-limit 0` switches sponsorship off. When the contract declines a settle, the bot pays for at most 10 per run itself. |
| Ownership transfer isn't timelocked | It needs both the current owner and the new owner to sign, and the bot emails you as soon as one is proposed. Even a new owner still faces the 48-hour wait for any code change. |
| Withdrawal needs VHP that is momentarily held as KOIN | The contract burns spare KOIN back into VHP first. In the rare case Mana is short, the message says to try again shortly. |

## 6. Test results

- Contract tests: **44 / 44 pass**, including the new ones for decimal withdrawals, upgrade protections, the window
  overflow, the seed KOIN shortfall and the seed VHP + KOIN withdrawal.
- Offline checks: all pass.
- Two-week rehearsal on real Koinos block history, ending with a full exit (every player withdraws everything, the owner
  collects the producer fee, the seed leaves after its timelock): see the latest run in the deploy notes.

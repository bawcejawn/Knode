# Game contract — security review (2026-10-17)

This file is for you and for outside auditors. It lists what could go wrong, what stops it, and which test proves it.
All tests run on GitHub on every push ("Contract tests"). The longer pre-deploy review, with the fixes it made, is in
[`docs/security-audit.md`](../docs/security-audit.md).

Contract: `game/assembly/Kpred.ts` (logic) and `Tokens.ts` (every token movement). Mainnet address
`1Mpmf2ERhjYpX7CCiM11WERuM4j17uT1sr`. Tests: `game/assembly/__tests__/Kpred.spec.ts` (47 tests).

## Whose money is at risk, and how it's protected

| # | Threat | What stops it | Proven by test |
|---|---|---|---|
| 1 | Someone deposits, withdraws, answers or claims for another wallet. | Every player action requires that wallet's own signature. | "nobody can deposit for someone else…", "cannot withdraw more than the stake or someone else's stake", "pays for valid settle and claim, never for someone else's answer" |
| 2 | A stake is withdrawn twice, or more than was staked. | The contract subtracts before it sends and refuses amounts above the stake. | "cannot withdraw more than the stake…", "withdraw returns VHP and takes pending first…" |
| 3 | A stake gets stuck because production turned part of the pool's VHP into KOIN. | Withdrawals burn spare KOIN back into VHP first. | "withdrawals still work when block production has turned some VHP into KOIN" |
| 4 | A prize is claimed twice, or a week pays more than its pot. | Claims are marked; payouts round down at every step; a solvency check after every payout cancels any transaction that would leave the pool short. | "measures the gain, splits it 5% fee / 95% pot…", "randomized 8-week simulations…" |
| 5 | The "gain" a week pays out is not what the pool really earned. | Gain = holdings − everything owed, measured at each close; the order or timing of claims and withdrawals never changes it. | "claiming or withdrawing early or late gives the same measured gain…", "unclaimed rewards keep producing…", "randomized 8-week simulations…" |
| 6 | Free players (no stake) get paid, or make the pool pay their Mana. | Reward = points × stake, so zero stake earns zero; sponsorship only for staked players. | "free players score points … are never eligible or paid…", "free play: anyone can answer, but only the stake that counts…" |
| 7 | A last-minute whale deposit grabs the week. | A deposit counts from the next week; production is time-weighted; winners are the top 30% by headcount, not by stake. | "deposits before the game starts count from week 0…", "a deposit just before the close barely moves the basket split", "winners are the top 30% of staked players by headcount…" |
| 8 | Answers after the deadline, invalid options, answering twice. | Lock time, option range and one answer per question are enforced on-chain. | "answers need an open question, a valid option, and only once", "option and timing boundaries are exact…" |
| 9 | The bot posts a question whose answer is already known, or whose window runs past the week. | Windows must start after answers close and end before the week can close (overflow-proof check). | "only the operator posts; rules on lock and window are enforced", "refuses a question whose window ends after the week is due to close" |
| 10 | A wrong result is posted. | Results only after the blocks are final; the owner can correct or void before the week closes; block hashes are published so anyone can recheck. | "resolutions: operator only, after the window is final…", "the owner can VOID an open question…" |
| 11 | The owner takes players' money. | The owner has no function that moves stakes or prizes; the fee is capped at what was earned. | "owner-only functions refuse everyone else…", "the owner cannot take more than the owner share" |
| 12 | The seed is pulled out suddenly. | Only the seed owner, only after a 48-hour public timelock, never more than the seed. | "only the seed owner adds or withdraws it, and only after the timelock", "a KOIN seed withdrawal pays what KOIN is on hand…" |
| 13 | Malicious new code is uploaded. | Needs the owner's signature, the exact announced code, and the 48-hour wait; the new code must keep the contract's protections switched on. | "code can be replaced only with the owner, the announced bytecode, after the timelock" |
| 14 | Someone (including the deploy key) moves the pool's tokens directly. | `authorize` refuses every outside token move. | "never lets anyone move the contract's tokens from outside" |
| 15 | Someone drains the pool's Mana with sponsored transactions. | Sponsorship only for one valid answer, settle or claim, with a capped rc_limit; the owner can lower it or switch it off. | "pays only for one valid answer / settle / claim with a small rc_limit", "the owner can lower, raise (max 10 KOIN) or switch off…" |
| 16 | Big numbers overflow. | Reward maths uses 128-bit arithmetic. | "a whale with 1 billion VHP and a minnow with 1 VHP are paid exactly…" |
| 17 | A week can never close (stuck pot). | Weeks close automatically as a side effect of play; all-voided or no-scorer weeks roll the pot forward. | "weeks close, settle and finalize as a side effect of normal play", "a week where every question is voided…", "with no scorers the pot rolls…" |

## Trust assumptions (not fixable in code)

- **The bot (operator)** chooses questions and posts results from block data. It can't move tokens; the owner can correct
  results before a week closes; every result carries a hash of the blocks used.
- **The owner (admin key)** can pause new deposits, correct results before the close, collect the 5% fee, and announce
  upgrades and seed withdrawals 48 hours ahead. Players can always withdraw during those 48 hours.
- **The pool's node** produces the rewards. If it's offline, rewards drop; no funds are at risk.

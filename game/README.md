# Kpred — the game contract

The weekly Koinos block-producer prediction game, as one smart contract. Staking, questions, answers,
scoring, the leaderboard cutoff and payouts all run **on-chain**. Nothing needs a server: the only
off-chain inputs are the operator's questions and resolutions, and those are published with hashes
anyone can re-check against the chain.

## How a week works

1. **Stake.** Deposit VHP, or KOIN (burned 1:1 into VHP). A deposit counts from the **next** week (or from
   week 0 if made before the game starts). Minimum stake to play: 1 VHP. No maximum.
2. **Answer.** The operator posts the day's questions (option count, answer deadline, observation window,
   and the hash of the full question). Players answer before the deadline and pay their own Mana.
   The contract still has optional code that can sponsor Mana for one valid answer, settle, or claim
   by a staked player, and refuses anything else before it can spend the pool's Mana. That option is
   capped on chain at 2 KOIN, and the owner can set the cap to 0. The project is not paying anyone's Mana right now.
3. **Resolve.** After a question's window has ended and its blocks are final, the operator posts the
   winning option (or "void") with the hash of the blocks used. Before the week closes, the owner can
   correct a resolution.
4. **Close.** After the week ends (plus a correction delay), anyone can close it. The contract measures the
   pool's gain (everything it holds minus everything it owes) and splits it:
   - 5% producer fee, in KOIN
   - 95% winners' pot (a pot with no winners carries into the next week without a second fee)
5. **Settle.** During the settlement window, anyone can settle any player. The sender pays the Mana. This counts their
   correct answers and adds their stake to a points table kept on-chain. A player is eligible if they
   answered more than one non-void question, kept at least the minimum stake, and didn't withdraw that week.
6. **Finalize.** After settlement, anyone can finalize. The contract walks down the points table from the
   top score until the winners hold **at least 30% of eligible stake**. Everyone tied at the cutoff wins.
7. **Claim.** Each winner claims `pot × (points × stake) ÷ (Σ points × stake over all winners)`, paid in VHP
   to their wallet. If nobody scored, the pot rolls into the next week.

Withdraw any amount any time. Withdrawing part of this week's stake keeps you in the week at the lower stake; withdrawing all of it takes you out of that week. Unclaimed rewards stay in the
pool and keep producing until claimed, but they are not stake until you claim and re-stake them.

## Weeks advance by themselves

A blockchain never runs code on its own, so "automatic" means: **every game transaction also does any
overdue bookkeeping first.** Any deposit, withdraw, answer, settle, claim, compound, or the operator's
daily question/resolution will close the previous week once it's due and finalize it once its settlement
window has ended. A player who plays again is settled for their last week automatically. Nobody has to
call `close_week` or `finalize_week` by hand (they still exist as a backup, and the bot uses them).

## Why claim/withdraw timing can't change anyone's rewards

- At every close the contract measures `gain = holdings − liabilities`. Liabilities are all stake, seed,
  producer fee not yet taken, and every pot not yet claimed. Right after a close, holdings equal
  liabilities exactly, so each unit of block reward is counted **once**, in the week it arrived.
- A claim or withdrawal lowers holdings and liabilities by the same amount, so it can never create or erase
  gain for any week.
- Unclaimed rewards are liabilities, but the VHP behind them keeps producing. That production is new gain
  for the pool, shared by everyone in later weeks.
- Rounding dust stays in the contract as a liability (it never over-pays).
- After every payout of a reward or the fee the contract checks it still holds at least what it
  owes, and refuses the transaction otherwise.

## Who can do what

| Role | Can | Cannot |
|---|---|---|
| Player | deposit, withdraw, answer, settle, claim (the player pays the Mana) | answer without stake; act for another wallet |
| Operator (bot key) | post and resolve questions | move any funds or change settings |
| Owner | correct resolutions before close, set operator, pause **new** deposits, register the node key, claim the 5% producer fee, schedule an upgrade | take players' stakes or rewards, or the seed; upload code without the timelock |
| Seed owner | add seed VHP/KOIN, withdraw it after an announced timelock | anything else |

The contract's own deploy key is powerless after setup: it can't move tokens or replace the code. Code
upgrades need the owner's signature **and** the exact bytecode announced with `schedule_upgrade`, and only
after the timelock has passed.

## The seed

- **Seed VHP** produces blocks for the pool and is counted as principal. It never plays and never wins.
- **Seed KOIN** is kept as KOIN. `compound` never burns it. Players pay their own Mana.
  Optional code can still sponsor Mana for staked players, capped on chain at 2 KOIN; the owner can set that cap to 0.

## Commands

From this `game` folder:

```
npm install
npm test          builds the contract and runs the 38 tests on a simulated chain (no network, no KOIN)
npm run build     production build → build/release/contract.wasm and abi/kpred.koilib.json
npm run check     offline safety check of the production build
npm run build:sim test build for the bot's rehearsal (build/sim — never deploy it)
```

Every test must say PASS and `npm run check` must end with "All offline checks passed" before anything
is deployed.

## Tested behaviour

- Staking timing: before genesis counts in week 0; mid-week deposits count the next week; KOIN is burned to VHP.
- Nobody can deposit, withdraw, answer or claim for another wallet; paused deposits are refused.
- Withdrawals take not-yet-active stake first, void the week, and still work after block production has
  turned some VHP into KOIN (spare KOIN is compounded first; the Mana reserve is untouched).
- Questions: operator only; answers must close before the week ends; the window starts after answers close;
  one answer per question; options checked; deadline enforced.
- Resolutions only after the window's blocks are final; operator can't overwrite; owner can correct before close.
- A full week: gain 100 → producer fee 5, pot 95. Top-30% cutoff with a tie at the top; a cutoff that
  descends to lower scores; points × stake payouts exact to the unit; no double claims; below-cutoff refused.
- No scorers → the pot rolls over. Weeks close in order. Zero-gain weeks still close.
- Seed withdrawal only by the seed owner and only after the timelock.
- Owner-only functions refuse everyone else; two-step ownership transfer; the owner can't take more than the
  producer fee earned; a pot with no winners rolls over without a second fee.
- Optional Mana sponsorship: when the on-chain cap is above zero, the contract can pay for one valid answer, settle, or claim by a staked player. It refuses a too-high rc_limit, two operations, invalid
  answers, no stake, someone else's answer or claim, already-settled entries, and every other entry point. The cap on chain is 2 KOIN; the owner can set it to 0.
- Automatic progression: weeks close and finalize as a side effect of ordinary play; returning players are
  auto-settled.
- Accounting lock: claiming/withdrawing early vs late gives identical weekly gains; a randomized 8-week
  simulation (5 seeds) shows every week's gain equals what was minted, holdings equal what is owed after
  each close, and everything minted is either paid out or waiting to be claimed.
- Safety valves: a question's window must end before its week is due to close; the owner can VOID a question
  that is still open (never set a real answer); the owner can cancel an announced upgrade and set the optional
  sponsor cap (at most 10 KOIN of Mana in the code; 2 KOIN on chain; 0 turns it off).
- Extreme cases: 64 questions in a week (65th refused) and a perfect 64; every question voided (pot rolls over and is
  counted once more); exact option/lock/resolve boundaries; withdraw-and-redeposit in the same week; a 1-billion-VHP
  whale beside a 1-VHP minnow paid exactly.
- Listing players page by page with their entry for a week (used by the bot and the website).
- Upgrades: refused before the timelock, for a non-owner, and for any bytecode other than the announced one.

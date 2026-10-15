# Kpred — the game contract

The weekly Koinos block-producer prediction game, as one smart contract. Staking, questions, answers,
scoring, the leaderboard cutoff and payouts all run **on-chain**. Nothing needs a server: the only
off-chain inputs are the operator's questions and resolutions, and those are published with hashes
anyone can re-check against the chain.

## How a week works

1. **Stake.** Deposit VHP, or KOIN (burned 1:1 into VHP). A deposit counts from the **next** week (or from
   week 0 if made before the game starts). Minimum stake to play: 1 VHP. No maximum.
2. **Answer.** The operator posts the day's questions (option count, answer deadline, observation window,
   and the hash of the full question). Players answer before the deadline. Answering is **free**: the
   contract pays the Mana, but only for a single, valid answer, settle or claim. Anything else is refused
   before it costs the pool anything.
3. **Resolve.** After a question's window has ended and its blocks are final, the operator posts the
   winning option (or "void") with the hash of the blocks used. Before the week closes, the owner can
   correct a resolution.
4. **Close.** After the week ends (plus a correction delay), anyone can close it. The contract measures the
   pool's gain (everything it holds minus everything it owes) and splits it:
   - 5% creator fee, in KOIN
   - 2% owner share, in VHP
   - 93% winners' pot
5. **Settle.** During the settlement window, anyone can settle any player (it's free). This counts their
   correct answers and adds their stake to a points table kept on-chain. A player is eligible if they
   answered more than one non-void question, kept at least the minimum stake, and didn't withdraw that week.
6. **Finalize.** After settlement, anyone can finalize. The contract walks down the points table from the
   top score until the winners hold **at least 30% of eligible stake**. Everyone tied at the cutoff wins.
7. **Claim.** Each winner claims `pot × (points × stake) ÷ (Σ points × stake over all winners)`, paid in VHP
   to their wallet. If nobody scored, the pot rolls into the next week.

Withdraw any time. Withdrawing during a week voids that week's answers. Unclaimed rewards stay in the
pool and keep producing until claimed, but they are not stake until you claim and re-stake them.

## Weeks advance by themselves

A blockchain never runs code on its own, so "automatic" means: **every game transaction also does any
overdue bookkeeping first.** Any deposit, withdraw, answer, settle, claim, compound, or the operator's
daily question/resolution will close the previous week once it's due and finalize it once its settlement
window has ended. A player who plays again is settled for their last week automatically. Nobody has to
call `close_week` or `finalize_week` by hand (they still exist as a backup, and the bot uses them).

## Why claim/withdraw timing can't change anyone's rewards

- At every close the contract measures `gain = holdings − liabilities`. Liabilities are all stake, seed,
  fee and owner share not yet taken, and every pot not yet claimed. Right after a close, holdings equal
  liabilities exactly, so each unit of block reward is counted **once**, in the week it arrived.
- A claim or withdrawal lowers holdings and liabilities by the same amount, so it can never create or erase
  gain for any week.
- Unclaimed rewards are liabilities, but the VHP behind them keeps producing. That production is new gain
  for the pool, shared by everyone in later weeks.
- Rounding dust stays in the contract as a liability (it never over-pays).
- After every payout of a reward, fee or owner share the contract checks it still holds at least what it
  owes, and refuses the transaction otherwise.

## Who can do what

| Role | Can | Cannot |
|---|---|---|
| Player | deposit, withdraw, answer (free), settle, claim (free) | answer without stake; act for another wallet |
| Operator (bot key) | post and resolve questions | move any funds or change settings |
| Owner | correct resolutions before close, set operator, pause **new** deposits, register the node key, claim the 5% fee and 2% share, schedule an upgrade | take players' stakes or rewards, or the seed; upload code without the timelock |
| Seed owner | add seed VHP/KOIN, withdraw it after an announced timelock | anything else |

The contract's own deploy key is powerless after setup: it can't move tokens or replace the code. Code
upgrades need the owner's signature **and** the exact bytecode announced with `schedule_upgrade`, and only
after the timelock has passed.

## The seed

- **Seed VHP** produces blocks for the pool and is counted as principal. It never plays and never wins.
- **Seed KOIN** is kept as KOIN. It is the Mana reserve that pays for players' free transactions.
  `compound` never burns it.

## Commands

From this `game` folder:

```
npm install
npm test          builds the contract and runs the 29 tests on a simulated chain (no network, no KOIN)
npm run build     production build → build/release/contract.wasm and abi/kpred.koilib.json
npm run check     offline safety check of the production build
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
- A full week: gain 100 → fee 5, owner share 2, pot 93. Top-30% cutoff with a tie at the top; a cutoff that
  descends to lower scores; points × stake payouts exact to the unit; no double claims; below-cutoff refused.
- No scorers → the pot rolls over. Weeks close in order. Zero-gain weeks still close.
- Seed withdrawal only by the seed owner and only after the timelock.
- Owner-only functions refuse everyone else; two-step ownership transfer; the owner can't take more than the
  2% share.
- Sponsorship: pays for a valid answer, settle or claim; refuses a too-high rc_limit, two operations, invalid
  answers, no stake, someone else's answer or claim, already-settled entries, and every other entry point.
- Automatic progression: weeks close and finalize as a side effect of ordinary play; returning players are
  auto-settled.
- Accounting lock: claiming/withdrawing early vs late gives identical weekly gains; a randomized 8-week
  simulation (5 seeds) shows every week's gain equals what was minted, holdings equal what is owed after
  each close, and everything minted is either paid out or waiting to be claimed.
- Upgrades: refused before the timelock, for a non-owner, and for any bytecode other than the announced one.

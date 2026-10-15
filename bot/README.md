# Kpred operator bot

The bot keeps the weekly game running. GitHub runs it every hour for free (`.github/workflows/bot.yml`),
or you can run it on your own PC. Every run looks at the chain and does whatever is due. Running it twice
does no harm.

| Every run, if it is due | How |
|---|---|
| Resolve finished questions | reads the irreversible blocks, works out the answer (or VOID), posts it with a hash of the blocks used |
| Post the day's questions | runs the question generator for the on-chain day (`W003-D2` = week 3, day 2), saves the questions to `game-data/questions/`, then posts them |
| Close / finalize the week | sends `close_week` / `finalize_week` if no player action has done it already |
| Settle players | settles everyone who answered last week but hasn't come back. The contract pays for this |
| Compound | once a day, burns the KOIN from block rewards into VHP so it produces too. It never touches the seed KOIN or the unpaid creator fee |

Questions are fitted to their on-chain week. Answers always close before the week ends, and every
observation window ends at least an hour before the week can close. This means a late question can never
hold up a week.

## Safety

- **The bot's key (operator) can't move any funds.** It can only post and resolve questions. A wrong
  resolution can be corrected by the owner before the week closes, and the owner can replace the operator.
- **No question is ever lost.** In the GitHub run, a day's questions are committed to the repo *before*
  they are posted. If the bot crashes after posting but before saving, the next run finds the questions on
  chain by their hash. If a question it doesn't recognise is on chain, it is resolved as VOID so its week can
  still close.
- **Keys:**
  - Only `OPERATOR_WIF` goes into GitHub.
  - `CONTRACT_WIF` is needed once, to deploy.
  - `OWNER_WIF` and `SEED_WIF` stay in `.env` on your PC, and only if you choose to use `admin` from the
    command line.

## Commands

From the repo's root folder (run `npm install` once):

```
npm run bot -- status                 the game right now (no key needed)
npm run bot -- tick --dry-run         what the bot would do, without sending anything
npm run bot -- tick                   do it
npm run bot -- rehearse --weeks 3     whole weeks on a simulated chain (no network, no keys, no KOIN)
npm run bot -- deploy                 deployment plan (dry run)
npm run bot -- deploy --send          deploy + initialise the contract
npm run bot -- admin <method> '<json>' --as owner|seed [--send]
```

`rehearse` needs the test build of the contract first. In the `game` folder, run `npm run build:sim`.

## The rehearsal

The rehearsal runs the **real contract code**, the **real bot** and the **real question generator**
together. It replays real mainnet block history hour by hour, so the questions are about real producers
and are resolved from real blocks. It adds:
- 10 simulated players with different habits (diligent, casual, one who vanishes, one who withdraws
  mid-week, a late depositor, one below the minimum, a whale depositing KOIN);
- the planned seed (170,000 VHP and 20,000 KOIN);
- block rewards every hour;
- trouble on purpose: a crash right after posting, a stray question the bot doesn't know about, and a
  20-hour outage of the bot.

Then it checks everything independently:
- every week closed on time;
- every outcome equals the generator's published result;
- every player's points, the cutoff, the winners and each reward match a recount done outside the contract;
- everything produced was counted exactly once;
- the seed was never touched;
- none of the bot's transactions failed.

## Launch checklist

1. `game`: run `npm test`, `npm run check` and `npm run build:sim`. Then at the root, run
   `npm run bot -- rehearse`. Everything must pass.
2. Make the keys: a new **contract** key (an empty address), an **operator** key (holds ~20–30 KOIN for
   its Mana), and the **owner** and **seed** addresses.
3. `npm run bot -- deploy` (dry run). Check the plan, then `npm run bot -- deploy --send`.
4. The owner registers the block producer key: `admin register_key '{"public_key":"…"}' --as owner`.
5. Add the seed: `admin seed_deposit_vhp '{"amount":"…"}' --as seed`, then `seed_deposit_koin`.
6. In GitHub, add the `OPERATOR_WIF` secret and set the variable `BOT_ENABLED=true`.

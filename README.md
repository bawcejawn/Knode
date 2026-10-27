# Knode

**Call the next blocks.** Knode is a weekly guessing game on the Koinos blockchain. Every day you answer a few
multiple-choice questions about what Koinos block producers will do next ("How many blocks will this producer sign in
the next 8 hours?"). Every right answer is a point. Each week the best players share what the game's block-producing
pool earned. It is free to play, and staking VHP lets you share the rewards.

Play: <https://bawcejawn.github.io/Knode/site/> (works in any browser; on a phone you can also "Add to Home Screen" to
install it like an app).

Everything that matters runs on chain: stakes, answers, scores, the leaderboard line and the payouts are all in the
game contract. The only things the bot does off chain are writing the questions and computing their results from
the blocks, and both are published with fingerprints anyone can check (see [How results are decided](#how-results-are-decided)).

> The rules below are the **v5** rules. The v5 code is announced on chain and can be uploaded from
> Wednesday 28 October 2026, 19:08 UTC. Its new reward rules (the 40/60 split and the free-player prize) start with
> the first full week after the upload (Week 3, from Monday 2 November 2026). Weeks before that keep the rules they
> started with.

## The week

All times are UTC. A week runs Monday 00:00 to Sunday 24:00.

| When | What happens |
|---|---|
| Monday to Saturday, 12:00 | 5 new questions (30 a week). They are numbered Q1–Q30 within the week. Monday and Tuesday are easy, Wednesday and Thursday medium, Friday and Saturday hard. |
| The next day, 00:00 | Answers close (12 hours after release), before the blocks the question is about are made. |
| After each question's blocks are final | The bot posts the result. Your points update right away. |
| Sunday | No new questions: results day. |
| Monday, 12:00 | The week closes (12 hours after it ends, so a wrong result can still be corrected). |
| Tuesday, 12:00 | Winners are final (24 hours to settle). Rewards can be collected from then on, with no deadline. |

## Playing

- **Wallet.** Kondor in Chrome on a computer, or KOIN Vault on a phone.
- **Free play.** Anyone can answer and climb the leaderboard without staking.
- **Staking.** Stake at least **1 VHP** (whole numbers) to share the weekly rewards. You can also stake KOIN: the game
  burns it into VHP for you. A stake counts from the next week. Your stake is never spent: you can withdraw any
  amount at any time, down to the last decimal. Withdraw part during a week and you keep playing with the lower
  stake; withdraw everything and you are out of that week's rewards.
- **Scoring.** One point per right answer. A voided question counts for nobody. At most 30 points a week.

## Rewards (v5)

Each week's pot is what the game's pool earned by producing blocks that week (players' stakes and the seed fund all
produce). Rewards are paid in VHP.

1. **5% producer fee** comes off first.
2. **Free-player prize: a flat 2 VHP.** The 2 best free players get 1 VHP each (ties share). A free player is one whose
   stake was never at or above the minimum that week, who answered at least 2 questions that counted and scored at
   least 1 point. If only one qualifies, the other 1 VHP goes to basket B; if nobody does, all 2 VHP go to basket B. If
   the pot is smaller than 2 VHP, the whole pot is the prize.
3. **Winners:** the top **30%** of staked players (by headcount) who scored at least 1 point. Ties at the line win too.
   Higher places weigh more: place *r* weighs 1/√*r*.
4. **The rest is split in two baskets:**
   - **Basket A, 40%:** shared by place weight × stake, counting at most **10 VHP** per wallet, so a small stake still
     earns a real share.
   - **Basket B, 60%:** shared by place weight × full stake, so staking more pays more.
5. **No staked winners?** The free-player prize is still paid; the rest carries into next week.
6. **Collect** from Tuesday 12:00 on the Play page. Unclaimed rewards wait for you and keep producing for the pool.

Before v5 (Weeks 1 and 2) the rules were: 65% of what the seed and unclaimed pots earned was shared by place alone,
the rest by place × stake; up to 64 questions a week; no free-player prize.

## Mana: what's free

Koinos has no transaction fees; it uses **Mana**, which comes from holding KOIN and refills on its own.

- The game contract pays the Mana for **staked players'** answers, week-end settles and reward claims (in Kondor, tick
  the free Mana option). KOIN Vault users pay their own Mana, which needs a little KOIN in the wallet.
- A separate **Mana sponsor** wallet (`sponsor/README.md`) can pay the rest, within per-transaction, per-player daily
  and weekly, and everyone-daily limits (a hard 1,000 Mana a day). **Answers are free for any wallet**, even one with
  no VHP; answers by wallets with no VHP and no stake share at most 300 of the 1,000 a day. Staking, withdrawing,
  settling, claiming and swapping are sponsored for wallets that hold at least 1 VHP or have a stake. The website uses
  it once `deployment.json` says `"payer": "sponsor"`; until then everyone pays their own Mana as before.

## Getting KOIN and VHP

There are no exchange listings for KOIN at the moment. The route (also on the site's **Get VHP** page):

1. Get a Koinos wallet (KOIN Vault or Kondor).
2. Buy **vKOIN** on Ethereum (Uniswap, token `0xa50ad3a559a10f384a5bb2e27516f63e0b937b1a`) or on Solana (Jupiter,
   token `8AUxdPqYU4FBy5rZDhMJxTniPs7gtEfdHjP3UKM71m6G`).
3. Bridge it to Koinos with the **Vortex bridge** (<https://vortexbridge.io/bridge>). It arrives as KOIN.
4. Burn KOIN into VHP 1:1 (keep a little KOIN for Mana), or stake KOIN directly and let the game burn it.
5. Stake in Knode.
6. To turn VHP back into KOIN: **Knode Swap** on the site (or KoinDX).

## Knode Swap

A separate contract (`1FKTpXBhhHEbu5vVchM8UsVbAvPArJsRmR`) that swaps VHP for KOIN at 1:1 minus a **3%** fee, paid
from the KOIN it holds, in one transaction. You always set the minimum KOIN you accept. From the October 2026 update it
also has a daily payout limit, and any change that loosens it (a lower fee, a higher limit, a new owner) waits 48 hours.
Details: [`desk/README.md`](desk/README.md).

## How results are decided

- Each question is built from the recent block history (see [`docs/QUESTIONS.md`](docs/QUESTIONS.md)). Its settings
  (template, producers, block range, thresholds) are hashed, and the hash (`paramsHash`) is posted on chain when the
  question is released, so the question can't be changed afterwards. Questions released with `hashRule: 2` (from October 2026) also cover their wording, so an option cannot be relabelled
  after release: the hash includes the title, the text and every option's label and range. The website checks every question file against the chain before offering it.
- After the window's blocks are final, the bot counts them and posts the result with `dataHash`, the SHA-256 of the
  exact blocks used (`height,signer,timestamp,txCount` per line). Anyone can recount.
- The bot reads blocks from `koinos.armana.io` and checks every window against a second, independent node
  (`api.koinosblocks.com`); if they disagree, nothing is posted and the owner is emailed. The website reads the chain
  from `api.koinos.io`.
- The owner can correct a result until the correction deadline (before the week is final). The site always shows the
  result recorded on chain.
- To recount recent results against your own node: `npm run bot -- verify-results`.

## Open network: anyone can influence the results

Koinos is an open network. Anyone can stake VHP, run a block producer or send transactions, and each of those changes
what the blocks show. So players, producers and anyone else can influence the results of the questions. That is
allowed: every way of influencing a result counts as part of the game.

The project takes part too. It runs the Knode Swap desk (`1FKTpXBhhHEbu5vVchM8UsVbAvPArJsRmR`, which produces blocks)
and a block-producer node of its own. Both can appear in questions like any other producer. Only the game's own pool
(the Kpred contract) is never a subject.

A question is **voided** (it counts for nobody) when:

1. a producer it names goes offline during its window (the longest silence is longer than chance allows; the rule and
   its numbers are saved with the question), or
2. **VHP swing:** a producer it is about (its subjects), the combined VHP of a group question's members, or the whole
   network's VHP for network-wide questions (M4–M7: block gaps, block interval, empty blocks, transactions), gained or
   lost **more than `voidVhpSwing`** compared with its release, in a reading taken during the question's window before
   its blocks decided the answer. `voidVhpSwing` is a setting in `game-data/game.json` (`model.voidVhpSwing`, 0.10 = 10%).

How the VHP-swing rule is applied, exactly:

- **At release** the generator reads the VHP balance of each producer the question is about (or the VHP token's total
  supply, saved under the key `network`) at the newest block, and saves it in the question as `model.vhp`, with that
  block height (`model.vhpHeight`) and the limit (`model.voidVhpSwing`). All three are part of the `paramsHash` posted
  on chain, so they cannot be changed afterwards.
- **During the window** the bot reads the same balances again on every run (it runs every hour, at minute 7) and adds
  each reading to the question file's `vhpReadings` (block height, time, values and the bot's seal). The height is read
  after the balances, so the balances are from that block or earlier. A reading whose height is after the window's
  last block is not kept. The readings are hourly samples: a swing that starts and is undone between two readings is
  not seen.
- **Only readings taken before the answer was decided count.** The answer is decided at the first block from which
  the chance that the window's remaining blocks change the option is below `decidedChance` (a setting in
  `game-data/game.json`, `model.decidedChance`, default 1e-9; saved with each question at release, so it is part of
  its `paramsHash`), or from which no remaining block could change it at all (`vhpCheck.decidedHeight` in the result).
  The chance is a conservative bound: each producer that could move the answer is assumed to produce each remaining
  block at an upper bound of its own rate so far in this window (k blocks out of n give at most
  (k + L + √(L² + 2kL)) / n, L = ln(8 / decidedChance), which is wrong with a chance of at most decidedChance / 8),
  the share of empty blocks likewise; the chance of reaching another option is the Chernoff bound of a binomial count
  (e^−μ (eμ / m)^m for m more blocks with mean μ), summed over every way the option could change and added to the
  chance that a rate bound is wrong. Over/under counts, head-to-head and combined differences and the empty-block
  share are decided this way. The network's transactions and the longest gap are decided only once they passed the
  top threshold, and the average block interval only at the window's last block. A reading taken after the decided
  block never voids, whatever it shows. Without this, the last hourly reading of a window would often come when the
  answer is already public, and a loser could buy a void. With `decidedChance` 0, only certainty counts.
- The question is void if, in any counted reading (`windowStart ≤ height ≤ decidedHeight`), for any of those producers
  (or the network, or the group's combined VHP), `|reading − release| > voidVhpSwing × release` (exact integer
  arithmetic).
  - A reading taken after the window's last block never voids, whatever it shows.
  - A group question (M10) is checked on its members' combined VHP, so a gift to its smallest member does not void it
    unless it moves the whole group by more than the limit.
  - If no reading was taken before the answer was decided, the rule is skipped and the question resolves on its
    blocks alone. The result's `vhpCheck.skipped` says why and the site shows it. The bot emails you when no reading
    was taken during the window at all (the bot was down, or every VHP read failed); when its readings all came after
    an early decision, it only logs it.
  - The offline rule (1. above) also stops at the decided block for these questions: a producer that goes silent once
    the answer is public no longer voids it.
  - A producer with no VHP at release is not checked (any amount would be an infinite change).
- The result's `vhpCheck` lists the heights of the readings used and, for each producer (or the group), the reading
  with the largest change, so anyone can check it.
- **Anyone can trigger a VHP-swing void, not only the producer.** A producer can move its own VHP (it costs only
  Mana). Anyone else can do it too, by sending or burning VHP to a producer the question is about, or by swapping VHP
  into the Knode Swap desk (a producer like any other). It costs the VHP they move: more than 10% of the producer's VHP
  (of the group's combined VHP for a group question). This is part of "anyone can influence the results", and the
  reason readings stop counting once the blocks have decided the answer.
- Questions released before this rule existed have no `model.vhp`; they keep the rules they were released with.

## Who controls what

| Role | Can | Can't |
|---|---|---|
| Players | stake, withdraw any time, answer, collect | anything else |
| Bot (operator) | post and resolve questions | move any funds |
| Owner | correct results before they are final, pause new deposits, settings, and upgrades announced 48 hours ahead | move players' stakes or rewards |
| Seed owner | add or withdraw the seed fund (withdrawals announced ahead) | touch players' stakes |

Every wallet, its key and what to do if one is lost: [`docs/WALLETS.md`](docs/WALLETS.md). Admin tasks run from a local
admin page on the owner's PC: `npm run admin` (127.0.0.1 only; every action shows a preview before anything is sent).

## Check the contracts yourself

Anyone can rebuild the contracts and compare their fingerprints with the code on chain:

```
npm ci
cd game && npm ci && npm test && npm run check && cd ..
cd desk && npm ci && npm test && npm run check && cd ..
sha256sum game/build/release/contract.wasm desk/build/release/contract.wasm
npm run bot -- chain-check
```

| Contract | Address | Live code (v3 / v1) | Announced upgrade (v5 / v2) |
|---|---|---|---|
| Game | `1Mpmf2ERhjYpX7CCiM11WERuM4j17uT1sr` | `917708a7…6433a` | `c17066ae988d204fd43d43f662ad87fcdc38170419943c20b5164a5bd34dd784` |
| Knode Swap | `1FKTpXBhhHEbu5vVchM8UsVbAvPArJsRmR` | `05039d74…761e4` | `309506ccfaadd3427e937aa88cd34c9ea2a9e6088e49e51f014d546489dd5f35` |

The upgrade runbook and the audit results: [`docs/UPGRADE-V5.md`](docs/UPGRADE-V5.md). The trust page on the site
shows the same numbers live.

## Repository layout

| Folder / file | What it is |
|---|---|
| `game/` | The game contract (AssemblyScript) and its tests ([`game/README.md`](game/README.md), [`game/SECURITY.md`](game/SECURITY.md)) |
| `desk/` | Knode Swap contract and tests ([`desk/README.md`](desk/README.md)) |
| `bot/` | The hourly operator bot, the Desk and upgrade tools, the rehearsal ([`bot/README.md`](bot/README.md)) |
| `admin/` | The local admin page (`npm run admin`) |
| `site/` | The website (GitHub Pages) |
| `generator.ts`, `resolver.ts`, `common.ts` | Build and score the questions ([`docs/QUESTIONS.md`](docs/QUESTIONS.md)) |
| `backtest.ts`, `export-blocks.ts`, `data/` | Tune the question templates on real history |
| `game-data/`, `desk-data/` | The live, public game files (questions, results, deployment details) |
| `node/` | PowerShell scripts for the owner's Koinos nodes |
| `tests/` | Security and regression tests from the audits |
| `docs/` | Runbooks and wallets; `docs/history/` keeps earlier audits and plans |
| `LAUNCH.md` | The first-launch guide (October 2026) |

## Running the tests

```
npm ci
cd game && npm ci && npm test && cd ..
cd desk && npm ci && npm test && cd ..
npm run test:resolver
node --import tsx --test bot/*.test.ts
node --import tsx --test --test-concurrency=1 tests/audit/*.test.ts tests/audit/*.test.mjs
npm run bot -- rehearse --weeks 2      (about an hour: two simulated weeks on real block history)
```

The contract builds need `protoc` on the PATH. On Windows, `.gitattributes` keeps every file with LF line endings.

## License

Copyright (c) 2026 Carl Padavano. All rights reserved. The source, including the `desk/` and `game/` contracts, is public so anyone can review it and check the deployed contracts. See [LICENSE](LICENSE).

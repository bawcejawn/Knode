# Knode
Predictions on Block Producers — Koinos. A weekly prediction game about the Koinos chain: players answer
multiple-choice questions about block producers and network data; top scorers share the staking rewards.

Folders: the analysis tools are in this folder; `probes/` holds the testnet contract probes.

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
- **Only readings taken before the answer was decided count.** The answer is decided at the first block from which the
  window's blocks already fix the option (`vhpCheck.decidedHeight` in the result):
  - over/under counts (a producer's blocks, a group's blocks, the network's transactions) and the longest block gap:
    the block where the value passed the top threshold;
  - head-to-head and combined differences, and the share of empty blocks: the block after which no remaining block
    could change the option;
  - otherwise (the average block interval, or a count that never passed its top threshold): the window's last block.
  A reading taken after that block never voids, whatever it shows. Without this, the last hourly reading of a window
  (up to an hour before its end, or at its very last block) would come when most or all of the window is already
  public, and a loser could buy a void.
- The question is void if, in any counted reading (`windowStart ≤ height ≤ decidedHeight`), for any of those producers
  (or the network, or the group's combined VHP), `|reading − release| > voidVhpSwing × release` (exact integer
  arithmetic).
  - A reading taken after the window's last block never voids, whatever it shows.
  - A group question (M10) is checked on its members' combined VHP, so a gift to its smallest member does not void it
    unless it moves the whole group by more than the limit.
  - If no reading was taken before the answer was decided (the bot was down, or every VHP read failed), the rule is
    skipped and the question resolves on its blocks alone. The result's `vhpCheck.skipped` says so, the site shows it
    on the result, and the bot emails you.
  - A producer with no VHP at release is not checked (any amount would be an infinite change).
- The result's `vhpCheck` lists the heights of the readings used and, for each producer (or the group), the reading
  with the largest change, so anyone can check it.
- **Anyone can trigger a VHP-swing void, not only the producer.** A producer can move its own VHP (it costs only
  Mana). Anyone else can do it too, by sending or burning VHP to a producer the question is about, or by swapping VHP
  into the Knode Swap desk (a producer like any other). It costs the VHP they move: more than 10% of the producer's VHP
  (of the group's combined VHP for a group question). This is part of "anyone can influence the results", and the
  reason readings stop counting once the blocks have decided the answer.
- Questions released before this rule existed have no `model.vhp`; they keep the rules they were released with.


## Step 0 — Koinos producer & reward analysis

Read-only. No wallet, no keys, no transactions. It downloads recent public blocks and prints
the numbers that decide the platform's pool economics, void thresholds, question calibration and accounting.

## Run it

1. Install Node.js 20 or newer from https://nodejs.org (the "LTS" button).
   On Windows, if PowerShell says *"npm.ps1 cannot be loaded because running scripts is disabled"*, run this
   once and answer **Y**: `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned`
   (or use the **Command Prompt** instead of PowerShell).
2. Put `step0.ts`, `package.json` and this README in one folder, open a terminal there, and run:

   ```
   npm install
   npm run step0
   ```

   A 7-day scan is about 200,000 blocks and takes roughly 10–30 minutes on the public node.
   For a quick first look: `npm run step0 -- --days 1`

3. Re-analyze without downloading again (e.g. with a treasury seed amount):

   ```
   npm run step0 -- --from-cache step0-output/cache.json --seed 1000000 --pools 10000,100000,1000000
   ```

## Flags

| Flag | Default | Meaning |
|---|---|---|
| `--days` | 7 | How far back to scan |
| `--rpc` | https://api.koinos.io | Public JSON-RPC endpoint |
| `--seed` | 0 | Koinos Federation seed in KOIN (95% burned into VHP, 5% kept as KOIN for Mana) |
| `--retain-bps` | 0 | Retired owner share (the game now takes only the 5% producer fee) |
| `--pools` | 10000,100000,1000000,2000000,5000000,10000000 | Total player VHP deposited (any split across wallets — every 1 VHP is one entry) |
| `--fee-bps` | 500 | Producer fee on the gain, paid in KOIN (500 = 5%) |
| `--koin`, `--vhp` | mainnet addresses | Verify at docs.koinos.io |
| `--concurrency` | 2 | Parallel requests; use 1 if the node rate-limits you |
| `--from-cache` | — | Reuse a previous download |

## What you get

Printed report, plus files in `step0-output/`:

- `report.json` — every headline number, including the suggested void thresholds
- `producers.csv` — blocks, share, VHP, rewards, VHP burned, biggest VHP jump per producer
- `daily.csv` — per-day distinct producers, longest streak, biggest gap, avg interval, % empty blocks, compute
- `producer_days.csv` — per producer per day: VHP at start, expected vs actual blocks, missed %, VHP change
- `cache.json` — the raw download, for re-runs

## How the numbers are computed

- **Contract addresses**: detected from the data. Per the PoB contract (`process_block_signature`),
  every block mints KOIN to the signer and burns VHP from the signer, so those contracts are KOIN and VHP.
  `--koin` / `--vhp` are only fallbacks.
- **True reward per VHP**: KOIN minted to signers is `block_reward + vhp_reduction`, i.e. the reward
  plus the burned VHP paid back as KOIN. The true yield is minted − burned, divided by the average VHP
  of producers that signed at least one block, scaled to 7 days. This is what can go into the pot.
- **Does producing change VHP?** Yes, if block-level VHP burns from the signer appear. compound() then
  re-burns the KOIN that replaces the burned VHP, at least daily.
- **Historical VHP**: balances are read now, then every VHP mint, burn and transfer is walked
  backwards, so no archive node is needed.
- **Expected blocks**: VHP snapshot at the start of each day × blocks that day, shared among active
  producers — the same rule the void check will use at question release.
- **Pool projection**: block rewards are fixed per block, so the pool earns its share of all producer
  rewards, and adding VHP dilutes everyone (the table accounts for it). For each deposit level it shows the
  weekly gain, the 5% producer fee (KOIN), the 95% winners' pot, what 1 VHP earns solo, and what an
  average winner earns per VHP (winners hold 30% of eligible stake, so ≈ 3.1× solo before any seed).
- **Concentration markers**: no cap, but the report shows the pool size at which our node would hold a third
  and half of producing VHP, the points where splitting across several nodes matters.

---

# Backtest — are the question templates really unpredictable?

Also read-only. It replays real chain history: at many past moments it builds each question template
exactly as the live generator would (lines and buckets from the trailing realized-rate model), then
checks what actually happened. A template **PASSES** when every option won within ±5 points of 1/k
and the void rule fired on under 5% of questions. Only passing templates go into the daily generator.

## Run it

```
npm run backtest
```

It tests the last 120 days, using the history already saved in `backtest-output/blocks.csv` (downloading
only the few new blocks), and takes a few minutes. A run with a shorter `--days` analyses fewer days but
never shrinks the saved history. Rebuilding the history from nothing downloads about 3.5 million blocks
(several hours), saving every 50,000 so an interrupted run picks up where it stopped.

## How the forecast works (v5, tuned on 120 days of real blocks)

- **Forecast rate:** core producers use their share of blocks over the **last 6 hours**; smaller producers
  over the **last day**. The 2-day rate used before lagged behind every time another producer dropped out
  or came back, so big producers beat their line 55% of the time. With the 6-hour rate it is 49/51.
- **Bucket widths learned from experience:** the last 7 days of the forecast's real errors set every line and
  bucket edge (only from windows where the subject stayed online, because those are the ones that count live).
- **Who can be a subject:** 2+ days of history, steady (not ramping up or down), no outage in the last 2 days,
  and a **reliability record**: at most 3% of its own question windows over the last 14 days would have been
  voided. A node that keeps dropping out waits until its record is clean, which keeps voids rare and rewards
  steady operators. Head-to-heads need 14 clean days from both producers.
- **Void = the subject went offline** longer than luck allows (chance below 0.1%) *and* for more than 600
  blocks (about 30 minutes). Short restarts are normal and stay inside the learned spread.
- **Group question:** "all non-core producers" means producers smaller than core by size.
- **Network questions:** bucket edges from the last 3 days, using overlapping windows.
- **Retired:** distinct producers, longest streak, compute, top share (could not be split fairly); E1/E2 on
  20,000 blocks (replaced by 10,000-block E1s/E2s, fewer voids); H2/H2s two head-to-heads (voids 10–15%).

### Results on the last 120 days (model v5)

| Template | Win rates | Voids | Verdict |
|---|---|---|---|
| E1s Core producer over/under (10,000 blocks) | 49 / 51 | 1.8% | PASS |
| E2s Head-to-head with spread (10,000) | 50 / 50 | 3.5% | PASS |
| E3 Smaller producer over/under | 49 / 51 | 6.1% | fair, voids above 5% |
| M1 Core producer quartiles (10,000) | 26 / 23 / 24 / 27 | 1.8% | PASS |
| M4 Largest gap (5,000) | 33 / 31 / 36 | 0% | PASS |
| M5 Average interval (5,000) | 24 / 25 / 26 / 26 | 0% | PASS |
| M6 Empty blocks (5,000) | 28 / 24 / 22 / 26 | 0% | PASS |
| M7 Transactions (5,000) | 29 / 21 / 21 / 29 | 0% | PASS |
| M9 Smaller producer quartiles | 28 / 21 / 23 / 27 | 6.1% | fair, voids above 5% |
| M10 All non-core combined (20,000) | 26 / 21 / 26 / 27 | 0% | PASS |
| H1 Core producer sextiles (5,000) | 17 / 16 / 16 / 16 / 16 / 18 | 1.3% | PASS |
| H3 Core producer eighths (10,000) | 14 / 12 / 11 / 12 / 12 / 12 / 12 / 15 | 1.8% | PASS |

## Flags

| Flag | Default | Meaning |
|---|---|---|
| `--days` | 120 | Days of history to test on |
| `--rate-days` | 2 | Days used for eligibility checks (size class, new, drifting, offline) |
| `--core-rate-days` | 0.25 | Forecast rate window for core producers (6 hours) |
| `--small-rate-days` | 1 | Forecast rate window for smaller producers |
| `--clean-days` | 2 | No outage allowed in this many days |
| `--reliability-days` | 14 | Look-back for each producer's void record |
| `--max-void-history` | 0.03 | Skip a producer whose own past windows voided more than this share |
| `--min-void-blocks` | 600 | An outage must be longer than this (≈ 30 min) to void a question |
| `--max-small-window` | 86400 | Longest window a smaller producer may get |
| `--calib-days` | 7 | Days of past forecast errors used to set bucket widths |
| `--agg-days` | 3 | Days used for network-wide question buckets |
| `--min-daily` | 1400 | Blocks/day to count as a core producer |
| `--min-small-daily` | 20 | Blocks/day to get an individual (smaller-producer) question |
| `--min-expected` | 60 | Blocks a smaller producer's window must be expected to hold |
| `--pair-clean-days` | 14 | Head-to-head subjects must have no offline stretch in this many days |
| `--max-drift` | 0.25 | Skip a producer whose last-12h rate moved more than this from its 2-day rate |
| `--void-alpha` | 0.001 | Void only if an offline stretch has less than this chance of being luck |
| `--step` | 1200 | Blocks between replayed release moments (1200 ≈ 1 hour) |
| `--lock-blocks` | 14400 | Answers stay open this long after release (≈ 12 h); the observation window starts after lock, so forecasts must reach that far ahead |
| `--tolerance` | 0.05 | Allowed distance from 1/k for every option |
| `--max-void` | 0.05 | Allowed void rate |

## Verdicts

- **PASS** — options landed near equal odds and voids were rare. Safe for the generator.
- **LIKELY OK\*** — missed by more than 5 pts, but by less than chance alone produces with this much data. Run with more `--days` to confirm.
- **FAIL** — some option wins too often. The template is predictable as built and needs a different window or bucket rule.
- **NEED MORE DATA** — fewer than 30 non-overlapping questions; run with more `--days`.
- **CAN'T BALANCE** — not enough history, or the result takes too few distinct values to make k equal options.

Files in `backtest-output/`: `report.json` (all numbers), `instances.csv` (every replayed question and its
winning option), `blocks.csv` (the lean block cache).

## Sharing the history for tuning

```
npm run export-blocks
```

Packs `backtest-output/blocks.csv` into `data/blocks-compact.csv.gz` (a few MB): signer, time since the
previous block and transaction count for every block. Attach it to the chat (or upload it to the repo's
`data/` folder) so the model can be tuned directly on the real chain. Public chain data only — no keys.

---

# Live question generator

Builds each day's questions the same way the backtester tests them, picks subjects by the rotation
rules, writes the wording with exact whole-number option bounds, and computes the parameter hash that
will be recorded on-chain. Later it resolves each question from irreversible blocks. Read-only on chain;
it only writes files in `generator-data/`.

## Commands

```
npm run generate -- release                     today's questions (UTC date)
npm run generate -- release --date 2026-11-02   a specific day
npm run generate -- resolve                     resolve every question whose window has closed
npm run generate -- show --date 2026-11-02      print a saved day again
```

The first run copies the last ~10 days of blocks from `backtest-output/blocks.csv`, so wait until a
backtest isn't running. After that it keeps its own copy in `generator-data/blocks.csv` up to date.

## How a day is built

1. The day of the week sets the tier (days 1–2 easy, 3–5 medium, 6–7 hard) and the count (3, or 2 on day 7).
2. Templates come from that tier's menu in `game.json`, shuffled with a seed made from the date and the
   newest block height, so anyone can reproduce the choice.
3. Subjects come from the rotation: never-featured producers first, then whoever was featured longest
   ago. Producers voided this week, and anyone already used today, are skipped.
4. Each candidate question is checked before release. Its options must come out within ±5 points of
   equal chance on the last 7 days of forecast errors. If not, the next candidate is tried.
5. Answers close `lockBlocks` after release (default 14,400 ≈ 12 hours). The observation window starts
   on the next block.

## Files

| File | What it holds |
|---|---|
| `game.json` | Settings you can edit: week-one start date, schedule, tier menus, enabled templates, model settings |
| `state.json` | Rotation memory: the day each producer was last featured, and producers voided each week |
| `questions/DATE.json` | That day's questions: text, options with exact bounds, heights, rates used, `paramsHash`, and later the `result` (option or void, actual value, `dataHash`) |

`paramsHash` covers everything that decides the answer (template, subjects, heights, thresholds, rates). Questions
released with `hashRule: 2` (from October 2026) also cover their wording: title, text and every option's label and
range, so an option cannot be relabelled after release. Earlier questions keep the rule they were posted with.
`dataHash` is the SHA-256 of the window's blocks (`height,signer,timestamp,txCount` per line), so anyone
can check a resolution against the chain.

## License

Copyright (c) 2026 Carl Padavano. All rights reserved. The source, including the `desk/` and `game/` contracts, is public so anyone can review it and check the deployed contracts. See [LICENSE](LICENSE).

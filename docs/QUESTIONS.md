# How the questions are made and tested

The question generator (`generator.ts`), the scorer (`resolver.ts`) and the backtester (`backtest.ts`). The bot runs
the generator and scorer for you; you only need this page to change or check the question templates.

Install Node.js 20 or newer, then `npm ci` in the repository folder.

## Backtest — are the question templates really unpredictable?

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

## Live question generator

Builds each day's questions the same way the backtester tests them, picks subjects by the rotation
rules, writes the wording with exact whole-number option bounds, and computes the parameter hash that
will be recorded on-chain. Later it resolves each question from irreversible blocks. Read-only on chain;
it only writes files in `generator-data/` (the bot sets `GEN_DIR=game-data`, the public folder the website reads).

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

1. The day of the week sets the tier and the count (`game.json`: `tierByDay` Easy, Easy, Medium, Medium, Hard, Hard from
   Monday, and `questionsPerDay` 5 a day Monday to Saturday, none on Sunday: 30 a week).
2. Templates come from that tier's menu in `game.json`, shuffled with a seed made from the date and the
   newest block height, so anyone can reproduce the choice.
3. Subjects come from the rotation: never-featured producers first, then whoever was featured longest
   ago. Producers voided this week, and anyone already used today, are skipped. No producer is used in more than
   `maxUsesPerWeek` questions a week (4).
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

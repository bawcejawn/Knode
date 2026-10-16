# Knode
Predictions on Block Producers — Koinos. A weekly prediction game about the Koinos chain: players answer
multiple-choice questions about block producers and network data; top scorers share the staking rewards.

Folders: the analysis tools are in this folder; `probes/` holds the testnet contract probes.

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

`paramsHash` covers everything that decides the answer (template, subjects, heights, thresholds, rates).
`dataHash` is the SHA-256 of the window's blocks (`height,signer,timestamp,txCount` per line), so anyone
can check a resolution against the chain.

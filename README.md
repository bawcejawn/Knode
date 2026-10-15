# Kprediction
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
| `--retain-bps` | 200 | Creator's owner share of each week's gain, kept producing as VHP (200 = 2%) |
| `--pools` | 10000,100000,1000000,2000000,5000000,10000000 | Total player VHP deposited (any split across wallets — every 1 VHP is one entry) |
| `--fee-bps` | 500 | Creator fee on the gain, paid in KOIN (500 = 5%) |
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
  weekly gain, the 5% creator fee (KOIN), the 2% owner share (VHP), the 93% winners' pot, what 1 VHP earns solo, and what an
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

## How the forecast works (v4)

- **Current rate:** each producer's share of blocks over the last 2 days. (A 4-week average proved far
  too slow on the real chain.)
- **Bucket widths learned from experience:** the last 7 days of the forecast's real errors set every
  line and bucket edge, plus a small per-producer correction if a producer's recent results lean one way.
- **Every producer gets a turn.** Core producers (1,400+ blocks/day) use fixed windows. Smaller producers
  (20+ blocks/day) get a longer window — 17 hours, 1.5 days or 3 days — so at least 60 blocks are expected
  and the question is fair. Producers too small for their own question are covered by a group question
  (all non-core producers combined).
- **Who can be a subject right now:** a producer must have 2+ days of history (new nodes qualify after
  2 days), be steady (not ramping up or winding down beyond noise), and not have gone offline in the
  last 2 days. Head-to-heads use core producers with a clean 7-day record.
- **Learning only from fair windows (new in v4):** the bucket widths are learned only from past windows
  where the subject did *not* go offline. Live questions with an offline subject are voided, so learning
  from those very low results set every line too low and made "over" win 53–59% on the 120-day run.
- **Group question (new in v4):** "all non-core producers" means producers that are smaller than core by
  size. A big producer that is briefly filtered (new, drifting, offline) no longer drops into the group.
- **Head-to-heads, shorter windows (new in v4):** two subjects double the chance one goes offline, so E2s
  (10,000 blocks) and H2s (5,000 blocks) are tested next to the original E2 and H2.
- **Void = the subject went offline** for longer than luck allows (chance below 0.1%).
- **Network questions:** bucket edges from the last 3 days, using overlapping windows.
- **Coverage report:** for every producer, how often it was eligible and why not.

## Flags

| Flag | Default | Meaning |
|---|---|---|
| `--days` | 120 | Days of history to test on |
| `--rate-days` | 2 | Days used for each producer's current rate |
| `--calib-days` | 7 | Days of past forecast errors used to set bucket widths |
| `--agg-days` | 3 | Days used for network-wide question buckets |
| `--min-daily` | 1400 | Blocks/day to count as a core producer |
| `--min-small-daily` | 20 | Blocks/day to get an individual (smaller-producer) question |
| `--min-expected` | 60 | Blocks a smaller producer's window must be expected to hold |
| `--pair-clean-days` | 7 | Head-to-head subjects must have no offline stretch in this many days |
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

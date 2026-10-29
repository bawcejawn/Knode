# Handicap cards that are hard to game (owner approved 2026-10-28: checks 1 to 3)

Applies project wide: every game that sets multipliers from producers' VHP (Producer Race, Who Signs Block X, and
any later game using the race card). **These rules only choose which VHP level feeds the card.** Each game keeps its
own multiplier rule (Block X: min(3, top ÷ yours); the race: its handicap steps).

## The problem (audit BX-3 b)

The card read each producer's VHP once an hour at a known time (the race recorder's cron, minute 37). A producer
that moves its VHP out just before that read and back just after looks small on the card, gets a bigger multiplier
for the next hour, and its own wallets pick it. Only *looking small* pays; looking bigger only lowers your multiplier.

## Fact checked in the Koinos source (koinos-contracts-as, contracts/vhp)

- `effective_balance_of` (entry point 0x629f31e6) is what block production uses (`Pob.ts`: the signer's effective
  balance). Verified working on the Koinos Foundation testnet VHP contract on 2026-10-28.
- VHP that is **added** counts only after **20 blocks (about 1 minute)**; VHP **removed** stops counting at once.
- A node can't read a past block's VHP, so the recorder takes samples over time.

## What is built

1. **Effective VHP** for every card (`readVhp(..., { effective: true })` in `common.ts`), on both nodes. The "holds
   1 VHP to be ranked" rule still reads the plain balance.
2. **Random samples.** `.github/workflows/race-samples.yml` runs every 5 minutes; inside the run `bot/race.ts --sample`
   waits a random 0 to 4 minutes (Node's crypto random, never published ahead), reads every producer's effective VHP
   on both nodes (producer by producer: one that differs counts at the higher read, capped at the top both agree on) and keeps the last 8 hours on the `race-samples` branch
   (`vhp-samples.json`, shape-checked before publishing). The hourly race recorder takes those samples; a producer's
   card VHP = the **highest** of its samples in the last 6 hours and the read at card time. Samples after the card's
   time never count.
3. **Production floor.** Each card counts the blocks each producer signed in the last ~6 hours (7,200 blocks). A
   producer whose count is more than 3 standard deviations above its card share is raised to the share its
   production supports. Only raises, never lowers. Side effect, intended: when some producers are offline, the
   online ones sign more than their VHP share and are raised, so the card follows who can actually sign.

Tests: `tests/audit/race-handicap-vhp.test.mjs` and the BX-3 b test in `tests/audit/race-recorder.test.mjs`.
Goes live when `picks` is merged into `main` (the race recorder runs from `main`; `RACE_ENABLED` turns on the sample
workflow too).

## Later (not built)

4. Alerts and holds: flag a producer whose VHP drops more than 20% and comes back within a day; hold its targets in a
   prize week for review.
5. Prize-side pattern watch: wallets that pick a producer exactly when its multiplier jumps.

## After the Repo Lens fix-check (2026-10-28)

- The 6-hour block window behind each card (who produces, how often) is read on both nodes ending at the lower
  irreversible block and must match; the card's time is the later of the two heads (BX-36).
- Samples from the future are refused and dropped; a published sample is never dropped early; each card says how many
  samples it used, and Block X doesn't score with a card made from fewer than 12 (BX-38).
- Block X scores each target with the LOWER multiplier of the card at the lock and the first card after the block, so
  moving VHP in right after a card doesn't pay either (BX-35).
- The production floor raises several producers together (BX-43); samples are capped at the VHP total supply and only
  the last hour's producers are sampled (BX-44, BX-45); published cards never change (BX-44).

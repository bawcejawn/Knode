# Producer Bracket (game 9) — how it works, for reviewers

A weekly knockout bracket of Koinos block producers. Players pick every winner of the whole bracket before Monday, as
**one number** on the Knode Games Picks contract (game 9). A keyless recorder turns the chain's blocks and picks into
results, points, boards and one weekly file for the Vault (v6), which pays the Bracket's stake bucket and its free-play
prize. Nothing in this game holds or moves tokens.

## The week (all times UTC)
| When | What |
|---|---|
| Saturday 12:00 | **Seeding**: every producer's exact effective VHP averaged over the 28,800 blocks before; the field = producers expected to sign ≥ 10 blocks in a 6-hour race; biggest = seed 1. Picks open. |
| Sunday 23:55 | Picks lock (Picks `lead` 5 min, `ahead` 36 h, TIME lock, `round_size` 7 days, round = week + 2,963). |
| Monday … Friday | One round per UTC day. 8–11 producers → 8 (Mon–Wed); 12–15 → 16 with byes; 16–31 → top 16 (Mon–Thu); 32+ → 32 (Mon–Fri); under 8 → no bracket. |
| last round + 12 h | Results final, once the Vault's stakes are read on both nodes (or 3 days after the week ends: closed, no file). |

## A matchup (bracket-math.js, on the VHP standard in vhp-standard.js and docs/VHP-STANDARD.md)
- **baseline** = the seed's effective VHP just before the day's first block (received VHP counts after 20 blocks).
- **expected** = baseline × Σ over the day's blocks of 1 ÷ (effective VHP of every producer active in the 7,200 blocks before).
- **credited** = Σ over the blocks it signed of min(1, baseline ÷ its effective VHP at that block).
- index = credited ÷ expected; higher wins; exact tie → the lower seed (underdog). The shared Σ cancels within a matchup,
  so gifts and top-ups are neutral and moving VHP away only lowers a producer's own chances.
- **Forfeit**: baseline < 0.5 × the seed's seeding VHP → it loses the matchup (both forfeit → the index decides). The
  **KnodeGames Vault never forfeits** (its VHP is players' withdrawable stakes); the recorder records it as `pooled` in
  the seeding.

## Scoring and ranking
- 1 / 2 / 4 / 8 / 16 points by round, +2 for the right champion; byes score nothing.
- The number: bit n = "the lower seed wins matchup n"; bye bits must be 0; any other number scores nothing.
- Order: points → a right champion → more right winners → **the earlier bracket** (its last change's time, from the
  Picks contract) → still tied (same block) shares the place. The all-time board shares ties.

## Players, boards and the Vault file
- **Staked player**: at least the Vault's minimum stake (1 VHP today, read from `get_state` per week) staked in game 9
  that week (`get_game_player`: `entry.stake` or `week_stake`). Read on both nodes once the week starts and again as it closes.
- **Free player**: anyone else, guests included. A player the Vault would refuse a free prize (its own rule: peak stake
  that week, or the stake now without an entry, ≥ the minimum) is "held" and is shown on the Staked board.
- `vault/W<week>.json` = `{game: 9, week, final: true, rows, first, second}`:
  - `rows`: staked players with ≥ 1 point, the order above mapped onto 1–255 (ties kept; past 255 places the best 254 exact).
  - `first` / `second`: free players with ≥ 1 point. One player in 1st → those tied next are 2nd. Several tied for 1st →
    they share all 3 VHP, no 2nd. More than 10 tied at a place → that place and below stay empty (back to the pool).
  - Written only when the week is final and no later than 3 days after the week ends.

## Data flow and trust model
1. `bot/games/bracket.ts` (GitHub Actions, `.github/workflows/games.yml`, no secrets) reads **irreversible** blocks with
   receipts on **two** nodes (`bot/vhp-chain.ts`); every decision uses the irreversible block's time agreed by both.
2. Exact VHP is rebuilt from the VHP contract's events (reverted transactions skipped), anchored by balance reads pinned
   to one block; fork check on block ids; cross-check against the contract's `effective_balance_of` (skipped with a
   warning if a node can't answer it as a read-only call — not yet seen live).
3. Both nodes must produce identical hours, seeding, picks and stakes, or nothing is written.
4. The publish job runs **no repo code**: a Python shape check of every file, then a push to `games-data:bracket/`.
5. The page (`bracket.html`, `bracket.js`) reads only those published files and the Picks contract; it signs only a
   `pick` for game 9's current round (wallet, or a sponsored guest wallet).
6. The Vault bot (branch `vault-v6-next`, `bot/vault.ts`) reads `games-data:bracket/vault/W<week>.json` and posts it.

## Review history
- Card-era audit and two fix-checks → replaced by exact VHP (option A).
- Option A audit (A-1 … A-5) and gift findings (G-1, G-2) → baseline + credit.
- VHP standard audit (S-1 … S-5) → card credit, average totals, skippable cross-check, page text, forfeit rule.
- Fix-check 2026-10-29 (F-1 … F-10) → Vault exempt from forfeit, own-vs-average card numbers, first-submitted tie-break,
  board fixes, page text, Vault minimum stake, 255 fallback. Open, low: F-2, F-7, F-10 (see the project docs).

## Evidence on real mainnet
- 8-day sample (`data/bracket-vhp-sample.json.gz`): the rebuild matched all 780 race-card VHP readings;
  `tools/sim/bracket/replay.mjs` runs the real recorder over it as one week.
- 100 days (branch `bracket-history`): 0 node disagreements; the better seed won 54.0% of 113 matchups.

# The KnodeGames VHP standard

Every game measures producers' VHP one way (owner decision 2026-10-28). Each game keeps its own multiplier or
handicap on top. The full rules are at the top of `site/vhp-standard.js`; the project copy is `claude/vhp-standard.md`.

- **Source:** exact VHP rebuilt block by block from the VHP contract's events (transfers, mints, the ~4 VHP each block
  burns from its signer; reverted transactions excluded), anchored by balance reads pinned to one block, on two nodes
  that must agree (`bot/vhp-chain.ts`). Never a reading at a set or guessable time on its own.
- **Effective VHP** (what block production uses): received VHP counts after 20 blocks, removed VHP stops at once.
  `effective(a, H) = max(0, balance before block H − VHP received in blocks H−19 … H−1)`. The recorder also reads the
  contract's `effective_balance_of` at the pinned block and stops if the rebuild disagrees.
- **Measures:**
  - `cardAt` / cardVhp: the highest effective VHP over the 7,200 blocks before — for multipliers fixed before picks.
  - `windowStats` / baseline + credit: baseline = effective VHP at a window's start; expected = baseline × Σ 1 ÷ active
    effective VHP; a block signed while holding more than the baseline counts baseline ÷ VHP — for scoring after the fact.
  - `averageCard` / averageVhp: the average over the 28,800 blocks before — for fields and seeding.
- **Tests:** `tests/audit/vhp-standard.test.mjs` (including a line-by-line copy of the VHP contract's snapshot code,
  matched on 3,000 random histories).

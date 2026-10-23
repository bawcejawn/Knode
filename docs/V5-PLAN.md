# Game contract v5: planned changes (after the audited v4 upgrade)

v4 (`565e7eef…`, audited in audit-2026-10) goes live first, unchanged. These contract changes need a new build, a
new review and the same 48-hour upgrade, so they are collected here for v5.

| Audit item | Change | Status |
|---|---|---|
| M-2 (G1-03) | Reward split. Today basket A (65% of the pot) is shared by rank only, so one stake split across many 1-VHP wallets wins a much larger share. Proposal: basket A 40%, weighted by rank × min(stake, 10 VHP); basket B 60%, by rank × full stake. Keep the 1 VHP minimum. | Waiting for the owner to confirm the numbers |
| M-1 (G1-02) | The operator alone decides every outcome. Done off-chain: the bot posts only sealed, published files (M-10), a second node must agree before a result is posted (M-9), and the owner has 21 hours to correct (v4). For larger pots: a second resolver signature. | To decide |
| M-3 (G1-04) | Padded sponsored settles: a daily sponsored-Mana budget, and refuse signatures a settle doesn't need. | To do |
| M-4 (G1-06) | `set_min_stake`: require 48 hours' notice (apply from the week after next if too late). | To do |
| G1-13 | `rolled_over` is not counted in the solvency check; add it. | To do |
| Info | `register_key` accepts any 33 bytes; require a valid compressed public key (prefix 0x02 or 0x03). | To do |
| Info | An unreachable overflow in a read-only helper; use checked arithmetic there too. | To do |
| G1-05 | Duplicate sponsored transactions can reserve the contract's Mana in mempools for a while; consider a per-player sponsored-action limit per block. | To decide |

## Knode Swap Desk, next upgrade

| Audit item | Change | Status |
|---|---|---|
| M-6 (D1-01) | Two-step owner change with a timelock, so a stolen owner key can be replaced. Meanwhile: treasury to a cold wallet (owner steps, in progress). | To do |
| M-7 (D1-03) | Timelock fee decreases and producer-key changes; a per-day swap cap. Meanwhile the bot alerts within the hour (D1-04). | To do |

Each change needs: tests next to the existing ones (including a split-stake test for M-2), the storage-compatibility
test (`game/scripts/storage-compat.test.ts`) passing from v4, and the runbook steps in `docs/UPGRADE-2026-10.md`.

## Known and accepted (website, display only)

- The site keeps a cache of blocks in the browser. It is shared with every other site on `bawcejawn.github.io`
  (GitHub Pages gives all of one account's sites the same origin), so another of those sites could change what the
  race and producer pages *show*. It can't change results, the chain or a transaction. A free fix is moving Knode
  to its own GitHub organization (for example `knode.github.io`), which gives it its own origin.
- Leaderboards of finished weeks are recomputed in the browser from the chain; the contract's own numbers decide
  every payout.

# Game contract v5: planned changes (after the audited v4 upgrade)

v4 (`565e7eef…`, audited in audit-2026-10) goes live first, unchanged. These contract changes need a new build, a
new review and the same 48-hour upgrade, so they are collected here for v5.

| Audit item | Change | Status |
|---|---|---|
| M-2 (G1-03) | Reward split. Today basket A (65% of the pot) is shared by rank only, so one stake split across many 1-VHP wallets wins a much larger share. Proposal: basket A 40%, weighted by rank × min(stake, 10 VHP); basket B 60%, by rank × full stake. Keep the 1 VHP minimum. | Waiting for the owner to confirm the numbers |
| G1-13 | `rolled_over` is not counted in the solvency check; add it. | To do |
| Info | `register_key` accepts any 33 bytes; require a valid compressed public key (prefix 0x02 or 0x03). | To do |
| Info | An unreachable overflow in a read-only helper; use checked arithmetic there too. | To do |
| G1-05 | Duplicate sponsored transactions can reserve the contract's Mana in mempools for a while; consider a per-player sponsored-action limit per block. | To decide |

Each change needs: tests next to the existing ones (including a split-stake test for M-2), the storage-compatibility
test (`game/scripts/storage-compat.test.ts`) passing from v4, and the runbook steps in `docs/UPGRADE-2026-10.md`.

## Known and accepted (website, display only)

- The site keeps a cache of blocks in the browser. It is shared with every other site on `bawcejawn.github.io`
  (GitHub Pages gives all of one account's sites the same origin), so another of those sites could change what the
  race and producer pages *show*. It can't change results, the chain or a transaction. A free fix is moving Knode
  to its own GitHub organization (for example `knode.github.io`), which gives it its own origin.
- Leaderboards of finished weeks are recomputed in the browser from the chain; the contract's own numbers decide
  every payout.

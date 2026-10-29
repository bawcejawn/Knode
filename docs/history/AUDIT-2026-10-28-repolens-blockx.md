# Repo Lens audit of Block X (2026-10-28, commit 611f63d): findings and fixes

Source: the auditor's failing tests and their README (`blockx-failing-tests.zip`). The written report (with BX-7 to
BX-18, severities and the verdict, and any Part B sponsor findings) was not in that package; this table covers the
findings that came with tests. The auditor's tests are kept in `tests/audit/repolens-*.test.*`.

| ID | Finding (from the tests) | Status |
|---|---|---|
| BX-1 / BXW-1 | Guest keys live in browser storage on the shared `bawcejawn.github.io` origin while guest play is on | **Owner decision** (todo test): a custom domain (tracker k01), or guest play off while on github.io. Already true for Daily Questions today. |
| BXW-2 | The mainnet Kondor path doesn't pin the chain id or re-check the signed transaction | **Fixed**: chain id named in the transaction; the signed chain, Mana limit and operations are checked before sending (`checkSigned`) |
| BX-2 / BXS-1 | With Mana sponsored, one person's many free wallets get extra chances at the Free play prize | **Owner decision** (todo test): guests may win (S3-4); options below |
| BX-3 / BXS-2 | A signer missing from the card scored the ×3 cap | **Fixed**: scores ×1 |
| BX-3 / BXS-2 | A card taken after the lock could score that lock (race cards are taken ~37 min into each hour) | **Fixed**: the latest card taken at or before the lock, at most 3 h old, mainnet and testnet |
| BX-4 / BXS-3 | Staked / Free play was read on one node only | **Fixed**: read on both nodes; a disagreement holds the target |
| BX-5 / BXS-4 | A week could be final (prizes listed) while its last target was unrecorded | **Fixed**: final only when the rounds are contiguous AND the next week's first target and the previous week's last are recorded |
| BX-6 / BXO-1 | The contract builds fetched 5 protobufjs helpers unpinned (with install scripts) and the newest protoc from GitHub with no checksum, on the PC holding the keys; runbooks ran `npm ci` with install scripts on | **Fixed**: all 10 helpers pinned by lockfile; protoc 21.12 pinned and checked by sha256 (`tools/protoc-pin.cjs`, every contract folder); every runbook uses `npm ci --ignore-scripts`. Proven: fresh installs with scripts off and the npm registry blocked rebuild Picks `700c296a…` (46/46) and the sponsor `21bec825…` (153/153) exactly |
| BX-19 / BXO-2 | announce/apply/pause signed with the owner key for whatever address the settings named | **Fixed**: `assertAuditedContract` checks the code hash and the three overrides on chain first |

No contract code changed: the Picks and sponsor fingerprints are the same.

## Options for BX-2 (sybil wallets and the Free play prize)

The prize is 3 VHP a week. Ideas, from lightest to strongest:
1. Accept and monitor (today's decision, S3-4): the free Mana total (2,000 a day) caps the cost; watch the winners.
2. Free play winners must hold a small amount of VHP when the prize is paid (e.g. 1 VHP, or any KOIN), so each extra
   wallet costs something.
3. Prize only to wallets at least N weeks old with picks on N days (raises the cost of fresh wallets).
4. Prize only on the Staked board (guests play for the board, not VHP).

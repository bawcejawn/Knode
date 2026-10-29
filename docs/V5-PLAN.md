# Game contract v5 and Desk v2: what was planned, and what was done

Decided 2026-10-23: skip v4 and upgrade straight to v5 (= v4 + the items below), with Desk v2 at the same time.
Built and tested; independently reviewed (no Critical/High; Medium/Low fixed). Runbook: `UPGRADE-V5.md`.
Pre-upgrade audit 2026-10-26 (commit 2ea29e8): 0 Critical, 0 High; fixed below. Game v5 `c17066ae…`, Desk v2 `309506cc…`.

| Audit item | Change | Status |
|---|---|---|
| M-2 (G1-03) | Reward split. Today basket A (65% of the pot) is shared by rank only, so one stake split across many 1-VHP wallets wins a much larger share. Proposal: basket A 40%, weighted by rank × min(stake, 10 VHP); basket B 60%, by rank × full stake. Keep the 1 VHP minimum. | Done (owner confirmed 40/60, 10 VHP cap). Note: the cap is per wallet, so a stake above 10 VHP split into wallets of up to 10 VHP counts more in basket A |
| M-1 (G1-02) | The operator alone decides every outcome. Done off-chain: the bot posts only sealed, published files (M-10), a second node must agree before a result is posted (M-9), the owner has 21 hours to correct (v4), and you can recount any result from your own node (`verify-results`). For larger pots: a second resolver signature. | To decide |
| v5 | At most 30 questions a week (so at most 30 points); two-step seed handover. | Done |
| M-3 (G1-04) | Padded sponsored settles: refuse sponsored transactions with more than one signature (each entry is already sponsored at most once per action). | Done |
| M-4 (G1-06) | `set_min_stake`: 48 hours' notice; a change promised within 48 h can't be overridden. | Done |
| G1-13 | `rolled_over` counted in the solvency check. | Done |
| Info (Desk) | `register_key` requires a compressed public key (02/03). | Done |
| Info (Desk) | `max_vhp_in` clamps instead of truncating. | Done |
| Info | An owner handover clears an announced upgrade (game and Desk). | Done |
| G1-05 | Duplicate sponsored transactions can reserve the contract's Mana in mempools for a while; consider a per-player sponsored-action limit per block. | To decide |

## Knode Swap Desk v2

| Audit item | Change | Status |
|---|---|---|
| M-6 (D1-01) | Two-step owner change with the timelock. Treasury to a cold wallet: owner steps in `WALLETS.md`. | Done |
| M-7 (D1-03) | Fee cuts, cap raises and node keys wait 48 h; a daily payout cap that frees up gradually. | Done (set the cap after the upgrade) |

Each change needs: tests next to the existing ones (including a split-stake test for M-2), the storage-compatibility
test (`game/scripts/storage-compat.test.ts`) passing from v4, and the runbook steps in `docs/history/UPGRADE-2026-10.md`.

## Pre-upgrade audit, 2026-10-26

| Finding | Change | Status |
|---|---|---|
| M-1 | The bot's free-settle budget counts only settled free entries at or above the projected line, and always settles the two best projected free scorers first. | Done (test) |
| M-2 | The free prize is paid even in a week with no staked winner; only the rest of the pot rolls over. | Done (owner rule: the 2 VHP never shrinks; test) |
| M-3 | The publish job pushes game-data to `main` with the workflow token, so `main` can't require pull requests. | Accepted for now (`WALLETS.md`) |
| M-4 | A second node (`RPC_CHECK`, default `api.koinosblocks.com`) must agree on results and on VHP readings. | Done |
| M-5 | Owner, seed and Desk commands use only the pinned contract and token addresses on mainnet. | Done (test) |
| L-1, L-2 | Site text and the live pot estimate show the v5 split and the free prize. | Done |
| L-3 | The wallet code pins mainnet's chain id on every page; both deployment files record it. | Done (test) |
| L-4 | A player who held the minimum stake during the week is never a free player (entry `peak_stake`, `free_player`). | Done (test) |
| L-5 | Desk announcements expire 7 days after their timelock. | Done (tests) |
| L-6 | Alerts run before the settle pass; the settle pass has a 40-minute budget per run. | Done |
| L-7 | Alerts for a pending seed handover and a seed owner other than deployment.json's. | Done |
| L-8 | `verify-results` checks the params hash and counts a result it can't recount as a failure. | Done |
| L-9 | The workflow guard checks every workflow file: no `pull_request_target` / `workflow_run`, top-level permissions, no `${{ }}` inside scripts. | Done (CODEOWNERS / required check: GitHub settings) |
| L-10 | The admin key is compared as bytes. | Done (test) |
| L-11 | Runbook lists the free prize a rollback strands; Desk compat test needs `build:sim`. | Done |
| I-5 | Stake inputs are capped at the wallet's balance and at 2^64 − 1. | Done |
| I-6 | `.gitattributes`: every text file LF. | Done |

## Known and accepted (website, display only)

- The site keeps a cache of blocks in the browser. It was shared with every other site on `bawcejawn.github.io` until the site moved to its own domain, knodegames.com (28 Oct)
  (GitHub Pages gives all of one account's sites the same origin), so another of those sites could change what the
  race and producer pages *show*. It can't change results, the chain or a transaction. A free fix is moving Knode
  to its own GitHub organization (for example `knode.github.io`), which gives it its own origin.
- Leaderboards of finished weeks are recomputed in the browser from the chain; the contract's own numbers decide
  every payout.

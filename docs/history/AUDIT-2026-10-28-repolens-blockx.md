# Repo Lens audit of Block X (2026-10-28, commit 611f63d): findings and fixes

Source: the full Repo Lens report ("Who Signs Block X — Audit", verdict **fix first**: 0 Critical, 4 High, 3 Medium,
17 Low, 10 Info) and its failing tests (`blockx-failing-tests.zip`, kept in `tests/audit/repolens-*.test.*`).
The report found the Picks contract sound (no Critical, High or Medium) and the release build reproducible. The
problems were around it. **No contract code changed in these fixes**: Picks `700c296a…` and sponsor v3 `21bec825…`
are the same, and the testnet build still reproduces `39cc5e00…`.

Sponsor v3 (Part B of the audit prompt) was **not** audited in this round; it goes into the fix-check.

## High and Medium

| ID | Finding | Status |
|---|---|---|
| BX-1 | Guest keys in browser storage on the shared `bawcejawn.github.io` origin while guest play is on | **Resolved** (owner, 2026-10-28): the site moved to its own domain, knodegames.com (PR #30/#31), so guest keys live on an origin no other site shares. Guest play with sponsored Mana stays on. The code guard also refuses any `*.github.io` page |
| BX-2 | Many free wallets (paid by the sponsor) get extra chances at the Free play prize | **Accepted** (owner, 2026-10-28): the free Mana total (2,000 a day) bounds the cost; winners are watched. Todo test kept as the record |
| BX-3 | (a) a signer missing from the card scored ×3; (c) a card taken after the lock could score it | **Fixed**: ×1; only the latest card taken at or before the lock, at most 3 h old |
| BX-3 (b) | Card VHP is raw VHP read once an hour, so a producer can briefly look small | **Owner decision**: read `effective_balance_of` instead (changes the live Producer Race too) |
| BX-4 | Card VHP and Staked status read on one node | **Fixed**: Staked status on both nodes (a disagreement holds the target); the race card's VHP on both nodes (more than 0.5% apart holds the card to the next run) |
| BX-5 | A week could be final while its last target was unrecorded; prize lists recomputed every run | **Fixed**: final only when the rounds are contiguous and the targets either side are recorded; a final week's prizes are written once to `P<week>.json` and never recomputed |
| BX-6 | Build tools fetched unpinned, with install scripts, beside the keys | **Fixed**: all 10 protobufjs helpers pinned; protoc 21.12 pinned by sha256; `npm ci --ignore-scripts` everywhere; MAINNET-LAUNCH builds in a clean copy with no `.env`. Proven: fresh installs with the registry blocked reproduce both hashes |
| BX-7 | Sponsor free allowance can be used up by throwaway wallets | **Watch** (sponsor side). Sponsor v3: per-action Mana limits (a pick asks about 0.15, not 1 Mana), free play 2,000 of 5,000 a day, 50 per wallet. Alerting on usage is a follow-up |

## Low

| ID | Finding | Status |
|---|---|---|
| BX-8 | README overstated "can never move tokens" across upgrades | **Fixed** (wording in both READMEs and WHATS-CHANGING; publish source and build before any `schedule_upgrade`) |
| BX-9 | Everything rests on the three overrides being on | **Fixed**: `assertAuditedContract` (code hash + 3 overrides, two nodes on mainnet) before announce, apply, pause, after upload and in status; the runbook records it and retires `PICKS_WIF` |
| BX-10 | Mainnet Kondor path: node chooses the chain id; own Mana limit = all of it | **Fixed**: chain id named; explicit limit (1 Mana for picks/answers, 10 otherwise, never above the account's); signed transaction re-checked |
| BX-11 | Testnet funding race | **Fixed**: address reserved before the first await |
| BX-12 | Page says the sponsor pays, but Picks wasn't covered | **Fixed**: wording per payment path; runbook step 6 (`payer sponsor`, `site-limits`, `config`) |
| BX-13 | Sibling pages share Knode's Kondor permission | **Resolved** by the domain move (knodegames.com has its own Kondor permission) |
| BX-14 | Page vs recorder: preview card, combined place, medals | **Fixed**: preview labelled "about ×N, by the current card"; rows carry `boardPlace`; Free-play medals follow the 3-day rule and ties, last week's from the frozen prize list |
| BX-15 | Stake read errors counted as Free; status on one node | **Fixed**: errors throw (the run holds), both nodes, first pick by height |
| BX-16 | A failing target fell out of the window with no void | **Fixed**: voided at the window edge with its reason |
| BX-17 | Irreversibility from one node | **Fixed**: the lower of the two nodes |
| BX-18 | Paging relied on the page size | **Fixed**: until an empty page |
| BX-19 | Owner-signed sends to whatever address the JSON named | **Fixed** (BX-9's check) |
| BX-20 | Post-upload check on one node | **Fixed** (two nodes) |
| BX-21 | ABI not pinned | **Fixed**: sha256 pinned and checked |
| BX-22 | Picks wallet could hold KOIN; runbook said to fund it | **Fixed**: upload refuses KOIN or a used nonce; runbooks fund the payer |
| BX-23 | Publish shape check left keys free-form | **Fixed**: exact key sets and types for every file |
| BX-24 | Producer chips from one node's recent blocks | **Fixed**: on mainnet only from the card (no card, no chips) |

## Info

| ID | Status |
|---|---|
| BX-25 lock vs head | Already handled: the page stops offering a round 20 blocks before its lock |
| BX-26 list_picks paging | Noted; the recorder reads each round after its lock at an irreversible height |
| BX-27 new games sponsored automatically | Documented (README "Sponsored games"); within the same caps |
| BX-28 smart-wallet wording | **Fixed** wording |
| BX-29 testnet build check gaps | **Fixed**: one snapshot of `assembly/`, owner checked with its checksum, `check.cjs` run on the testnet source and `.wat` |
| BX-30 CSP by meta tag | Partly: knodegames.com is now our own origin (`'self'` is only our site); GitHub Pages still can't send headers, so the meta tag and frame-buster stay |
| BX-31 testnet wallet entry point; Host only on /api/fund | **Fixed**: `pick` entry point only (before and after signing); Host checked on every request |
| BX-32 testnet config not committed | **Fixed**: `picks` and `picksSha256` committed |
| BX-33 game settings not read from chain | **Fixed**: `get_game` checked; picks outside the week don't count toward days |
| BX-34 upload nonce, error print, CI loops, persist-credentials | **Fixed**: nonce tip in the tool and runbook; error print sanitized; loops safe; `persist-credentials: false` |

## Options for BX-2 (sybil wallets and the Free play prize)

The prize is 3 VHP a week. From lightest to strongest:
1. **Chosen (owner, 2026-10-28):** accept and monitor: the free Mana total (2,000 a day) caps the cost; watch the winners.
2. Free play winners must hold a small balance when the prize is paid (for example 1 KOIN), so each extra wallet
   costs something.
3. Prize only to wallets at least N weeks old with picks on N days.
4. Prize only on the Staked board (Free play plays for the board, not VHP).

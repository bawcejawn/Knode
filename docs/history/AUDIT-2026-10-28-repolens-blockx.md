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
| BX-3 (b) | Card VHP is raw VHP read once an hour, so a producer can briefly look small | **Fixed** (owner approved 2026-10-28, checks 1 to 3): effective VHP (added VHP counts only after 20 blocks), random samples about every 10 minutes, the highest in a 6-hour window, and a floor from real block production. `docs/HANDICAP-VHP.md` |
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

# Round 2: Repo Lens fix-check of Block X + first audit of sponsor v3 (report @ 148c00f)

Report: `docs/history/AUDIT-2026-10-28-repolens-fixcheck.md` (verdict **fix first** for both parts; no Critical; Block X
2 High, 3 Medium, 9 Low, 4 Info; sponsor v3 8 Medium, 6 Low, 7 Info). Owner decisions the same night: guest keys on
the old address get a move-and-erase page; only a STAKE in the game makes a staked player (sponsor too); the free pool
is released by the hour with an 80% alert; Picks launches with no per-action Mana limit. Also folded in: Block X takes
stakes (Vault chat, 2026-10-28) and the Combo Card's sponsor needs (Build 8).

Picks is unchanged (`700c296a…`, testnet `39cc5e00…`). **Sponsor v3 changed: `8d515d15…` (34,558 bytes, 167 tests).**

## Block X (Part A), new findings

| ID | Finding | Status |
|---|---|---|
| BX-35 (High) | VHP moved in right after the card scores ×3 | **Fixed**: each target scores the LOWER multiplier of the lock's card and the first card taken after the block (it waits for it, 3 h at most, then void) |
| BX-36 (High) | One lying primary node shapes the card (producers, counts, blocks per race, time) | **Fixed**: the 6-hour block window is read on both nodes ending at the lower irreversible block, and must match exactly; the card's time is the later of the two heads (never back-dated) |
| BX-37 (Medium) | One producer's disagreement holds the whole card / sample | **Fixed**: producer by producer (`combineReads`): the higher read, capped at the top both nodes agree on; never all-or-nothing |
| BX-38 (Medium) | Samples fail open; a future time freezes the samples branch | **Fixed**: samples more than 60 s ahead of the check node or the clock are refused and dropped; the publish check refuses future samples and any file that drops a published sample of the last 8 h; cards carry `samples` and Block X never scores with a card from fewer than 12 |
| BX-39 (Medium) | Guest keys made on bawcejawn.github.io | **Owner action ready**: `tools/old-origin-guest/guest-move.html` (move to knodegames.com, then erase); the move is now in the branch (main merged: site at the root, CNAME) |
| BX-40 / BX-51 | Guard covered create/sign only; suffix denylist | **Fixed**: an allowlist (knodegames.com, www, localhost, 127.0.0.1) on every guest path; elsewhere the key is never read or written |
| BX-41 | Places by row on the Staked board and "You: #n" | **Fixed**: `boardPlace` everywhere, podium included |
| BX-42 | Sample window visible on the public repo | **Fixed**: every 5 minutes with a 0-4 minute secret wait |
| BX-43 | Floor raises one at a time | **Fixed**: raises solved jointly |
| BX-44 | Loose race card/sample shapes; cards not write-once; huge sample values | **Fixed**: exact keys; a published card can never change; samples capped at the VHP total supply |
| BX-45 | Sampled addresses grow forever | **Fixed**: only the last hour's producers |
| BX-46 | `get_game` check fails open | **Fixed**: both nodes, refuses on an error or a missing game, also with a given head |
| BX-47 | "Two nodes" can be one | **Fixed**: the same URL is refused, the check node's chain id must be mainnet; one primary node only (no silent fallback) |
| BX-48 | A target with no possible card waits 3 days | **Fixed**: void once 3 h past the lock |
| BX-49 (Info) | Source-text tests | **Partly**: new behaviour tests (guest paths on 5 origins, vault rows, after-card, flagged cards, sampler, publish checks, board places in data); the auditor's own tests are kept as written |
| BX-50 (Info) | Args compared as text | **Fixed**: compared as bytes |
| BX-52 (Info) | Global yarn; protoc without prebuild | **Documented** in MAINNET-LAUNCH (yarn 1.x once); prebuild always runs in `npm test` |
| BX-18 (race) | Race `readPicks` page size | **Fixed**: until an empty page |

## Sponsor v3 (Part B)

| ID | Finding | Status |
|---|---|---|
| SP-1 | `config` kept v2's caps | **Fixed**: the owner's caps by default, old → new shown; runbook has the full line |
| SP-2 | 1 VHP passed between wallets locks out staked players | **Fixed (contract)**: a real player has an ACTIVE stake (question game, or the call's own game via `game_arg` / race game 7); VHP balance and pending stakes don't count |
| SP-3 | 40 empty wallets empty the free pool | **Fixed (contract)**: released by the hour; 80% alert in status and the hourly bot |
| SP-4 | 0.15 pick limit unmeasured | **Owner decision**: no per-action row at launch; set from a day of mainnet receipts |
| SP-5 | Failed read switches the sponsor off; one node; disable can refuse | **Fixed** |
| SP-6 | Report: one node, receipts by position, 0 used | **Fixed**: receipts by id, missing dropped, second-node re-read, 20 samples minimum |
| SP-7 | Run-out with no row gets a tiny limit | **Fixed**: no row, reported |
| SP-8 | Site check used the local file | **Fixed**: the deployed knodegames.com files, fallbacks included; runbook goes through a PR to `main` |
| SP-9 | Mempool reservation at day start | Accepted (per-day cap well below the wallet's Mana: 5,000 of ~25,000) |
| SP-10 | Too-low row: run-outs | Covered by SP-4, SP-7, SP-11 |
| SP-11 | Run-out detection | **Fixed**: the receipt's out-of-resources log, or 99% used |
| SP-12 | Network by name | **Fixed**: by chain id; testnet files separate; payer/site-limits refused on testnet |
| SP-13 | Runbook order; no rollback | **Fixed**: per-action line removed; v2 stays an allowed rollback build |
| SP-14 | v3 fields to v2 code; Picks row dropped silently | **Fixed** |
| SP-15 | Rows aren't a ceiling | Documented (README) |
| SP-16 | Repeated non-player field | **Fixed (contract)**: only fields marked 0x10 may repeat |
| SP-17 | Other actions asked 3 Mana | **Fixed**: 1 Mana (the cap) in the site and both deployment files |
| SP-18 | Guest messages | **Fixed**: which limit (this hour, today, this week, page limit, network) |
| SP-19 | Payer wrote new rows only | **Fixed**: the lower of old and new |
| SP-20 | Rounded values | **Fixed**: exact |
| SP-21 | S3-2 tool-side only | Kept in `npm run check` and the runbook |

## Also in round 3 (owner, 2026-10-28; Vault chat hand-off)

- Sponsor v3 covers the vault (game v6) player calls (`deposit_to`, `withdraw_from`, `move_stake`, `claim_game`, for
  the payee's own wallet in the vault's exact argument shape) and `finalize_game_week`; the call's game id counts for
  the stake check; a payee's own `claim_game` is free play.
- Owner decision: a wallet that isn't a real player may spend the free pool on any covered call (no more
  `NOT_A_PLAYER` refusals), within its caps and the hourly release.
- Block X page mounts the shared stake panel (`stake-panel.js`, Hub chat) for game 2.
- Sponsor v3 trial on the testnet: `npm run sponsor -- <command> --testnet` (testnet/sponsor.json, .env.testnet), the
  testnet page asks the test sponsor first; the local admin page (`npm run admin`) has Mana sponsor, Block X and
  Testnet trial sections. Runbook: `docs/blockx/SPONSOR-TESTNET.md`.

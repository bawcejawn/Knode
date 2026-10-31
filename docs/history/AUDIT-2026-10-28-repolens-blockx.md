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

## Round 3 (Repo Lens fix-check @ 1c66ddc, 2026-10-29): verdict "fix first" for both parts

Report: the owner's Claude Docs page "Block X + Sponsor v3: Round-3 Fix-Check (Knode picks @ 1c66ddc)". The auditor's
failing tests (`knode-fixcheck-r3-failing-tests.zip`) are in `tests/audit/repolens-r3-*.test.*` and pass.

### Owner decisions (2026-10-29)

- Every wallet, free or staked, gets at most **25 Mana a day and 150 a week** from the sponsor (lower later if a pick
  measures close to its limit).
- **Knode Swap is never sponsored** (protects the swap desk from micro-swap abuse; audit SP-24).
- Many wallets from one person (SP-2 / SP-3 residual): no on-chain defence can tell wallets apart. Kept: per-wallet
  caps, the hourly free release, stakers' share that free wallets can't touch, Kondor's own free Mana as the fallback,
  and the hourly alert now emails. The free-prize rule against many wallets is decided before prizes start (vault).

### Part A, Block X

| ID | Finding | Status |
|---|---|---|
| BX-61 | Vault ABI missing: every mainnet target voided | **Fixed**: `game/abi/kpred-v6.koilib.json` committed (vault-v6-next f1ecf59); the v6 check reads only a minimal get_state first; real-file tests |
| BX-62 | Vault file for any week, frozen forever | **Fixed**: publish accepts only the board's last week, final, within 7 days of its end; a differing re-publish fails the run |
| BX-53 | Flash VHP around block X | **Fixed**: VHP moved into the signer (VHP transfer/mint events in the block receipts, both nodes, the higher) between its lock card and X counts on both cards; the sampler also samples every producer on the latest card |
| BX-54 | One node steers the window or the card time | **Fixed**: no card when either irreversible block is >200 behind its head, the two differ by >30 blocks, or the head times differ by >60 s; race publish refuses a card dated outside its leg |
| BX-55 | One node lifts a producer to the top | **Fixed**: a producer the nodes disagree on counts at the lower read and is listed in the card's `flagged`; Block X holds (then voids) a target whose signer is flagged on its lock card, and skips an after-card that flags it (supersedes the round-2 "higher read" rule) |
| BX-56 | A lagging check node stops samples | **Fixed**: a future head time is judged against this computer's clock only |
| BX-63 | Stake reads per target, sequential | **Fixed**: once per node, week and wallet per run, 8 at a time, cached (a failed read is retried, never cached) |
| BX-57 | One node's supply "1" switches samples off | **Fixed**: the higher supply; an impossible supply (below a producer's VHP) is ignored |
| BX-58 | Race scores from flagged cards | **Documented**: the race keeps its card (picks were made against it); the card shows its sample count; Block X never uses it |
| BX-59 | Silent one-node mode | **Fixed**: the recorders refuse without a second node unless `ALLOW_ONE_NODE=yes` (warns every run) |
| BX-64 | Page's staked line used week_stake ≥ 1 | **Fixed**: the recorder's rule (peak stake ≥ the vault's minimum) |
| BX-65 | Vault file not checked against the board | **Fixed**: rows must be Staked-board players in board order (points never rising); first/second the week's prize winners, never staked |
| BX-66 | Move page live on knodegames.com | **Fixed**: it does nothing unless at https://bawcejawn.github.io |
| BX-67 | Guest play on plain http://knodegames.com | **Fixed**: http only for localhost and 127.0.0.1 |
| BX-60 | Small items | **Fixed**: dead branch gone, `afterAt` typed, default RPC koinos.armana.io; deploy-hour note in the runbook (cards need ~6 hours of samples) |
| BX-68 | >255 places all get 1 point | Documented behaviour, unchanged |
| BX-69 | admin/index.html published | Accepted: a static page with no key; it does nothing without the local server |
| BX-70 | Move page wording | Unchanged (the erase stays the player's own choice) |
| BX-71 | Old github.io service worker | Can't be published from this repository (the old address now redirects); documented |

### Part B, sponsor v3 (new build `b21251d4…`, 34,652 bytes, 173 specs)

| ID | Finding | Status |
|---|---|---|
| SP-28 | isPlayer read the raw stake (week 0) | **Fixed**: get_player for the current vault week, `active_stake` (field 3); `npm run check` compares the field with the game's ABI |
| SP-22 | would_pay ignored the call's game | **Fixed**: would_pay takes `game` (field 4); the site sends it (race 7, the Picks game argument) |
| SP-29 | enable/disable reset the caps | **Fixed**: they change only the switch |
| SP-30 | disable needed the second node | **Fixed**: disable needs no second node; `RPC_CHECK=off` really means none (config/enable then refuse) |
| SP-31 | Alert emailed nobody; no wallet Mana check | **Fixed**: runs always, warns when the wallet's Mana is below what today's caps allow, and fails the run at the end so GitHub emails |
| SP-32 | --testnet could write mainnet files | **Fixed**: testnet paths chosen from `--testnet` first |
| SP-33 | site-limits treated a failed read as empty | **Fixed**: aborts |
| SP-24 | Swaps for free wallets | **Owner decision**: Knode Swap never sponsored (contract refuses swaps and approves to the Desk; the site's swap page uses players' own Mana; the upload and config refuse while the live swap page still asks the sponsor) |
| SP-23 | free_play flag dead | **Fixed**: dead code removed; proto and README describe v3 |
| SP-25 | Vault genesis hard-coded | Accepted: matches mainnet (`genesisTime` 1792368000000); a different deployment needs a rebuild |
| SP-34 | Guest message said 00:00 UTC for an hourly refusal | **Fixed**: the sponsor's own reason is passed through |
| SP-35 | Testnet retried after an included revert | **Fixed**: only refusals before inclusion fall back |
| SP-36 | Runbook `?key=` | **Fixed** (`#`) |
| SP-26, SP-27 | check.ts vs v6 ABI; Picks/vault id link | SP-26: the v6 ABI is now in the repo (BX-61); SP-27 documented in `docs/ADMIN.md` |
| SP-2, SP-3 | Lock-outs remain (Medium) | **Accepted for launch** (owner decisions above); the auditor's attack-model tests for these stay out of the suite |

### Owner decision, 2026-10-29: BX-39 / BX-66 / BX-70 / BX-71 closed

The guest wallets made on the old `bawcejawn.github.io` address before 28 October were the owner's and testers' test
wallets and hold nothing. The move page (`tools/old-origin-guest/`) is deleted and never published; those keys are
left to expire in the testers' browsers. BX-66, BX-70 and BX-71 (about that page and the old address) no longer apply.

## Round 4 (Repo Lens fix-check @ cc524eb, 2026-10-30): verdict "fix first" for both parts

Report: the owner's Claude Docs page "Block X + Sponsor v3: Round-4 Fix-Check (Knode picks @ cc524eb)". The auditor's
failing tests (`knode-fixcheck-r4-failing-tests.zip`) are in the repository and pass:
`tests/audit/repolens-r4-race.test.mjs`, `tests/audit/repolens-r4-publish/`, `tests/audit/repolens-r4-sponsor-tool-site.test.mjs`
and the sponsor specs appended to `Sponsor.v3.spec.ts`.

### Owner decisions (2026-10-30)

- SP-37: a **"vault live" switch** in sponsor v3 (`config.game_has_vault`), off until Vault v6 is live, rather than waiting
  for v6 or keeping v2. The tool reads it from the game's own state on two nodes.
- The old-address guest move page is deleted (2026-10-29): the pre-move guest wallets were empty test wallets. BX-39,
  BX-66, BX-70 and BX-71 are closed by that.

### Part A, Block X and race cards

| ID | Finding | Status |
|---|---|---|
| BX-72 | Receipt decoder differed from the VHP contract | **Fixed**: the receiver is the event's `impacted[0]`; the value is the LAST copy of its field, every other field skipped as as-proto does (`vhpInflows`, `lastVarint`) |
| BX-73 | One node lowers the top, every multiplier moves unheld | **Fixed**: when a flagged producer is, or at its higher read would be, the card's top, the card carries `topInDoubt`; Block X holds every target on it (and skips it as an after-card) |
| BX-74 | A producer can flag itself | **Fixed** while both nodes are at the same block: VHP is read on both nodes in parallel between two head reads (3 tries); only same-block disagreements count at the lower read. With a lagging node the higher read counts (flagged), so moving VHP out and back can't make a producer look small |
| BX-75 | A lagging check node stops cards | **Fixed**: the check node may be up to 10 minutes and 200 blocks behind; it may be at most 15 s ahead (it can't date a card later than that) |
| BX-76 | A card in a leg's last minute fails the publish | **Fixed**: a card's time is clamped below its leg's end |
| BX-77 | Receipt range by time; reads unchecked | **Fixed**: cards record `height` (their window's end); receipt reads must return every block, in order |
| BX-78 | Next week's first card; silent fetch failure | **Fixed** |
| BX-79 | The run's own board vouched for the vault file | **Fixed**: the publish job reads the PUBLISHED branch first; a vault file must be for the week that just ended by the job's own clock, within the vault's 3 days, with the week final and its prize file already published; rows are the published Staked board's players in order with points recomputed from its places; first/second are the published prize file's winners |
| BX-80 | A planted prize file made the week final | **Fixed** for prize files: a `P<w>.json` is published only when the published board shows that week final, 12 h after it ended by the job's clock, with the same prizes. Residual: week files (`W<w>.json`) are not write-once and are still trusted from the published branch; planting one needs a compromised record run (repository code), and before prizes they can only order the Staked points |
| BX-81 | One differing file stopped all publishing | **Fixed**: a failing or differing prize/vault file is held (not published) with an error, everything else is published, and the job fails at the end so you are emailed; the recorder gets the published vault files, so it doesn't write one again |
| BX-82 | Empty state read as "v6 not live" | **Fixed**: the answer must include the game's owner |
| BX-83 | No timeout on chain reads | **Fixed**: 30 s per call (`withRetry`) |
| BX-84 | Receipt reads could exceed the job time | **Fixed**: 4 calls at a time, 200 blocks each |
| BX-85 | Stake panel test skipped its v6 check | **Fixed**: it reads the committed v6 ABI |
| BX-65 | Points never recomputed | **Fixed** with BX-79 (a file leaving out some stakers still passes: the vault only accepts wallets staked that week, and you can correct within its 3 days) |
| BX-44, BX-47, BX-49, BX-58 | Earlier residuals | Unchanged (Low/Info, as recorded); BX-49: the publish tests now run the workflow's own script against a published branch |

### Part B, sponsor v3 (new build `b61ac238…`, 35,052 bytes, 178 specs)

| ID | Finding | Status |
|---|---|---|
| SP-37 | On the live v5 game, a `get_game_player` read aborts the sponsor | **Fixed** (owner decision above): `config.game_has_vault`; while off, no `get_game_player` call and the vault's own calls are refused; the tool sets it from the game's state on two nodes; runbook step on the day v6 goes live |
| SP-39 | disable signed one node's settings; enable re-signed them | **Fixed**: disable uses the node's settings only when a second node shows the same, else the settings rebuilt from this PC's files switched off; enable rebuilds every setting from the files like config, keeping only the on-chain caps both nodes agree on, and shows every line old → new (and the website check) |
| SP-38 | Site sent no game for vault calls, only the first of a batch | **Fixed**: `would_pay` takes `games` (field 5); the site sends every game (vault calls: field 2) |
| SP-40 | The site dropped `answer_only`; a v2 rollback refused guests | **Fixed**: still sent for free play (v3 ignores it); rollback steps in the runbook |
| SP-41 | enable didn't re-check the swap page | **Fixed** (enable runs the config path, website check included) |
| SP-42 | The branch's swap page still asked the sponsor | **Fixed** on `picks` (`desk-data/deployment.json` payer self); step 4a still runs on `main` first |
| SP-43 | Watch failure read as "80%"; "switched off" shown as "used up" | **Fixed** |
| SP-23 | Stale docs | **Fixed** (README, tool text) |
| SP-26 | check.ts didn't pin the vault calls | **Fixed**: pinned against the committed v6 ABI |
| SP-11, SP-13 | Batches not counted in run-outs; rollback steps | SP-13 **fixed** (runbook); SP-11 Low, unchanged |
| SP-2, SP-3 | Lock-outs by many wallets | Accepted for launch (owner) |

## Round 5 (Repo Lens fix-check @ d4c32de, 2026-10-30): sponsor contract ready; tool and Block X "fix first"

Report: "Block X + Sponsor v3: Round-5 Fix-Check (Knode picks @ d4c32de)". The sponsor contract (`b61ac238…`) is ready
and is **unchanged** by this round (182 specs, same hash). The auditor's failing tests (`knode-fixcheck-r5-failing-tests.zip`)
are in the repository and pass: `tests/audit/repolens-r5-race.test.mjs`, `tests/audit/repolens-r5-publish/`,
`tests/audit/repolens-r5-sponsor-tool.test.mjs`, and the vault-switch specs (SP-51) appended to `Sponsor.v3.spec.ts`.
Behaviour tests written with the fixes: `tests/audit/repolens-r5-behaviour.test.mjs`,
`tests/audit/repolens-r5-publish/bx88-week-files.test.mjs` (the README's BX-88 test, against the real recorder and the
real publish step), `tests/audit/repolens-r5-sponsor-behaviour.test.ts`, and two publish tests in the r4 file.

### Owner decisions (2026-10-30)

- **Split launch.** The two contracts go up now (sponsor v3 `b61ac238…`, Picks `700c296a…`) after a short final check of
  only this round's fixes. Who Signs Block X goes live **prize-free**. Scoring keeps hardening off-chain: any later
  scoring finding is fixed in the recorder before Vault v6 prizes start.
- **Blind review first.** An independent review of this round's diff, with the auditor's checklist (route closed,
  inverse closed, bypasses, honest use, new surface), before it goes back to Repo Lens.
- **Root causes, not patches.** Two rules replace case-by-case decoding and checking: (1) a VHP transfer is read only
  from its one canonical encoding, anything else is held; (2) published history is append-only: a published target
  (or race sample) never changes, and a run that tries publishes nothing.
- **Picks `pick` row 0.2 Mana** (testnet Combo Card measurements: single pick 0.0477, 10 legs 0.0916): on chain and in
  the site's `sponsor.rcLimits` (`mana-limit … --limit 0.2`, launch step 6).

### Part A, Block X and race cards

| ID | Finding | Status |
|---|---|---|
| BX-72 | The amount was still read differently from the VHP contract | **Fixed (root cause)**: `canonicalTransferValue` accepts a transfer only when its bytes are exactly the standard encoding of {from, to = the event's receiver, value, memo} (fields in order, once each, shortest varints and lengths; a field written with its default, as koilib writes value 0, is read as every decoder reads it); anything else is a `NonCanonicalTransfer` and the target is voided at once with its reason. Mints (written by PoB itself) keep the field-2 read. New surface, accepted for the prize-free launch: any wallet can void a round by sending the producers non-canonical transfers between its lock and its block (one transaction per round, visible in the warnings, no points move). **Before prizes:** read the VHP contract's own decoder (or its developers' answer) so only bytes it would reject or read differently void a target |
| BX-86 | Samples kept one node's higher read, unflagged | **Fixed**: a sample never keeps the higher read; disputed producers are re-read twice; a remaining dispute is stored (`flagged`, `high`) and checked in `race-samples.yml`; every card flags a producer disputed in any sample it uses, and `topInDoubt` is computed on the card's FINAL values (after the 6-hour highs and the floor). Published samples are now also unchangeable (the BX-88 rule) |
| BX-88 | One bad run rewriting only `W<w>.json` decided the week | **Fixed (root cause)**: the publish job reads the published week files; a run whose week file changes or drops a published target, has duplicate rounds, adds a round that isn't a past target block of its week (block time before the job's clock and inside the week, height = round × round size + offset, as the recorder's `loadWeek`), or adds a future week's file, is held whole, with an alert (honest runs never do any of these). **Before prizes:** the run that makes a week final re-reads that week's targets (signer, time, picks) on both nodes and holds on any difference from the published ones, so a NEW target from a bad run can't stand either |
| BX-87 / BX-91 | A missing `vault/` (or new testnet game) folder stopped recording / publishing | **Fixed**: every `git ls-tree … | while` is `{ … || true; } | while` |
| BX-89 | A lying primary could date a card 10 min late | **Fixed**: a card is never dated more than 60 s after this computer's clock (the command line passes the clock) |
| BX-90 | A short receipt page voided targets | **Fixed**: reads on from where the node stopped, still requiring every block in order |
| BX-92 | A vault file past its 3 days failed every run | **Fixed**: none is written past the window; one warning the hour it closes |
| BX-93 | Wrong void reason; stale wording | **Fixed** |
| BX-94 | r4 publish tests ran on the wall clock | **Fixed**: fixed `CHECK_NOW_MS`, plus the honest board → P → vault path |
| BX-65 | A vault file with only some stakers passed silently | **Fixed**: published, with an error naming the left-out Staked players that fails the job, so you are emailed once (the job can't re-read stakes; the recorder reads them on two nodes; you can correct within the vault's 3 days) |

### Part B, sponsor v3 (tool only; contract unchanged `b61ac238…`)

| ID | Finding | Status |
|---|---|---|
| SP-44 | Off/on could quietly loosen caps | **Fixed**: `capsOf` keeps every on-chain cap exactly (0 stays 0); the disable fallback takes each cap's lowest of this node, the second node (when it answered) and the default (minimum stake the highest), only ever lowered further to stay in order (unreadable: all 0); the fallback is sent only with `--rebuilt`, which its preview asks for (separate admin card); admin wording corrected |
| SP-47 | The emergency stop could throw on a row | **Fixed**: the fallback has no per-action rows |
| SP-48 | v3-ness read from one node | **Fixed** for config/enable (both nodes must show the same code); the off fallback uses one node (harmless while off) |
| SP-49 | v6-day step | **Fixed**: runbook (after v6's first transaction, `config` with your caps); `status` warns when v6 is live and the switch is off; hand-off note for the Vault v6 runbook |
| SP-50 | enable blocked on v2 by the swap page | **Fixed**: that check applies once v3 is on chain |
| SP-13 | v2 rollback's config always failed | **Fixed**: the runbook names caps v2 accepts (1,000/day) |
| SP-23 | README `claim` claim | **Fixed** (wording) |
| SP-51 | Test gaps | **Fixed**: the auditor's specs appended; `tighterCaps`, the `--rebuilt` refusal and the code check are tested |
| SP-52 | Stale wording; disable printed six caps | **Fixed**: disable prints every setting the send can change |
| SP-45 | `would_pay.games` read unpacked only | **Accepted for launch** (contract frozen): the site sends it unpacked; a misread changes only `would_pay`'s advisory answer, never what `authorize` pays |
| SP-46 | Nothing on chain ties the vault switch to v6 code | **Accepted for launch**: the tool reads it from two nodes; turning it on by hand against v5 needs a deliberate mistake |
| SP-11 | Batch run-outs not counted | Low, unchanged |
| SP-2, SP-3 | Lock-outs by many wallets | Accepted for launch (owner) |

### Blind review of the round-5 diff (2026-10-30, owner's decision: before Repo Lens)

An independent reviewer checked `41289a2..c4c9dc8` with the auditor's checklist and ran two scenarios against the real
recorder and publish step. Its findings and what was done:

| # | Finding | Done |
|---|---|---|
| 1 (High) | The append-only rule protected only published rounds: a bad run could pre-publish a FUTURE round (or next week's file), which the honest recorder would keep | **Fixed**: new rounds must be past target blocks of their week; no future week file (test: `bx88-week-files.test.mjs`) |
| 2 (Medium) | A round at a height the recorder drops on load would hold every later honest run for good | **Fixed**: the publish job applies the recorder's height rule to new rounds (round size and offset passed in; testnet reads `testnet/blockx.json`) |
| 3 (Medium) | A non-canonical transfer (even koilib's value 0) held a target for 3 days, which could push a week past the vault's window | **Fixed**: explicit defaults are read; anything else voids the target at once (tests in both r5 behaviour files) |
| 4 (Low) | Honest value-0 or empty-memo transfers did the same | **Fixed** with #3 |
| 5 (Low) | The disable fallback's caps came from the node the second one disagreed with | **Fixed**: the lowest of both nodes and the default |
| 6 (Low) | One lasting sample dispute flags a top producer's cards for 6 hours (all targets void) | Accepted: the safe direction (hold, never mis-score); each card says so in the run's warnings |
| 7 (Low) | BX-65 was only a warning (no email) | **Fixed**: an error that fails the job, file still published |
| 8 (Low, testnet) | Held rounds beyond 48 a run could stall a fast testnet week | **Fixed** with #3 |
| 9 (Info) | 0.2 Mana for picks is 2.2 × a testnet number | Runbook: re-measure (step 10) a day after the v6 switch-on too |
| 10 (Info) | `--rebuilt` adds a command when the second node is down | Accepted (separate admin card) |

## Round 6 (Repo Lens fix-check @ b0abc79, 2026-10-30): uploads GO; Block X prize-free after BX-95 / BX-96

Report: the owner's doc "Block X + Sponsor v3: Round-6 Fix-Check (Knode picks @ b0abc79)". Verdicts: **sponsor v3 +
Picks uploads: GO** (contracts unchanged, fingerprints match, SP-44 fixed); **Block X live prize-free: no-go until
BX-95 and BX-96**; Vault v6 prizes: not yet. All items below were fixed in one change (`c47b4ac`), before prizes ones
included. The auditor's failing tests are in the repository and pass (`tests/audit/repolens-r6-publish/`,
`repolens-r6-race.test.mjs`, `repolens-r6-sponsor-tool.test.mjs`); two had setups that could never reach the state
they test (G-K-3: the week was never final; G-A-1: the lying node's blocks differed too, so no card was made), and
the owner's copies say so in a comment. Launch step 2 is done: the tool allows v3 on mainnet, with v2 kept as the
rollback.

| ID | Finding | Status |
|---|---|---|
| BX-95 | A number above 2^53 − 1 could freeze publishing (~2 weeks) | **Fixed**: every integer in both publish checks is at most 2^53 − 1 (the recorder's JavaScript limit) |
| BX-96 | One run could drop weeks from index.json for good | **Fixed**: the published week list is append-only (held, with an alert) |
| BX-97 | A future round given a past time passed | **Fixed**: a new round's time must lie between its published neighbours' and, after the newest published target, no sooner than 2.25 s a block (3/4 of the usual 3 s). Full fix before prizes: the re-read at the week's end |
| BX-98 | New rounds could be added to a final week | **Fixed**: new rounds only for the current week or the one just ended, and never once its P file is published |
| BX-99 | One node moved unflagged multipliers through the production floor | **Fixed**: the card takes the lower read of every disagreement; it is rebuilt with every disputed producer at its higher read (now and in the samples), and `topInDoubt` is set when the top or any undisputed producer's value differs |
| BX-100 | One node's non-canonical report voided a target for good | **Fixed**: voided at once only when both nodes report it; otherwise held, and voided at the 3-day edge as a disagreement |
| BX-101 | Samples had no lag bound | **Fixed**: the card's bounds (10 min behind, 15 s ahead, 200 blocks): no sample this time |
| BX-102 | One lying sample's high held 6 h of cards | **Fixed**: a disputed producer's higher read is capped at the network supply |
| BX-103 | Old samples count for 6 h after a deploy | Runbook note |
| BX-104 | Test comment wording | **Fixed** |
| BX-105 | board.json is not write-once | **Before prizes** (freeze the week's board with its P file) |
| BX-106 | A crafted W file crashed the check | **Fixed**: validated before comparing |
| BX-107 | Reordered target list passes | Accepted (compared by round) |
| BX-108 | No honest correction path | Runbook: a manual, reviewed edit of `games-data` |
| BX-109 | Round size literals in the publish call | Guarded by a test against `blockx-math.js` |
| BX-110 | BX-65 wording | **Fixed** |
| BX-111 | race-data index week list | **Fixed**: append-only in `race.yml` |
| BX-94 | r4 tests passed on "not yet" | **Fixed**: F5-K-1 and F5-K-3 now publish board and P first and check the reason |
| SP-53 | Stop fails right after a v2 rollback upload | **Fixed**: runbook switches off before uploading v2; the fallback also fits v2's limits (1,000 a day, 7,000 a week) when v2 is on chain |
| SP-54 | 0.2 Mana checked against an unsponsored figure | **Fixed**: step 6 uses the sponsored testnet pick (0.116; 0.2 is 1.7 ×); measure a sponsored 10-leg card before Combo cards go live (0.25 if above 0.16) |
| SP-55 | `--limit` checked against the typed number | **Fixed**: against the row's observed maximum, then `checkRows` |
| SP-56 | enable could drop an on-chain row silently | **Fixed**: the preview names every row it would drop |
| SP-57 | Second node down: a lying primary's caps, clamped to the defaults | Accepted (bounded by the defaults; nothing is paid while off) |
| SP-58, SP-23, SP-13 | Wording; v2 in the mainnet build list | **Fixed** |

**Before prizes (the list now):**
- the week-end re-read of every target on both nodes, comparing whole targets (points, void, card), rounds added after P included (BX-88, BX-97, BX-98);
- the VHP contract's own decoder for which transfers void a round (BX-72 griefing: about 84 transactions void a week, and can be selective);
- freeze the week's board with its P file (BX-105).

## Round 7 (Repo Lens go/no-go @ 1022aed, 2026-10-30): Block X prize-free NO-GO, "two one-line fixes away"

Report: "Block X Prize-Free: Round-7 Go/No-Go (Knode picks @ 1022aed)". BX-95/96 and BX-98 to BX-101 fixed. Two more
places where the JavaScript recorder would round a value the Python check let through. Fixed at the root: **every
value of every incoming file must be one JavaScript reads back exactly** (`js_safe`, in `games.yml`,
`games-testnet.yml` and `race.yml`), and addresses must be JSON strings. The auditor's failing tests are in the
repository and pass (`tests/audit/repolens-r6-publish/repolens-r7-publish.test.mjs`, `tests/audit/repolens-r7-race.test.mjs`).

| ID | Finding | Status |
|---|---|---|
| BX-112 | A numeric "address" (26–35 ones) passed as a signer or pick player | **Fixed**: `isaddr` = a string matching the address pattern, on every address check (games and testnet); plus the `js_safe` walk |
| BX-113 | race.yml bounded card numbers at 1e16 | **Fixed**: 2^53 − 1, plus the `js_safe` walk over every race file (BX-121's result fields too) |
| BX-114 | Slow block read made an in-sync check node look ahead | **Fixed**: the check node's head is read right after the primary's |
| BX-119 | Bogus new race-data weeks stayed | **Fixed**: a new week only last, this or next week |
| BX-121 | Unbounded race result integers | **Fixed** by the `js_safe` walk |
| BX-115 | ~1% shift inside the 0.5% tolerance | Accepted; revisit with live data before prizes |
| BX-116 | Supply cap uses the higher total | Accepted: a liar can only hold cards (a lower cap would let it hide a dispute) |
| BX-117 | One node holds a target 3 days | Intended (hold, never void, on one node's word) |
| BX-118 | No clock rule for new race cards | **Before prizes** |
| BX-120 | A void row's estimated time in a week whose P is published | **Before prizes** (check with live block-rate data) |
| SP-59 | A failed code read skips the v2 clamp | Before prizes (rollback window only; loud, a re-run works) |

## Round 8 (Repo Lens go/no-go @ 572d86c, 2026-10-30): NO-GO, "one line, three files"

Report: "Block X Prize-Free: Round-8 Go/No-Go (Knode picks @ 572d86c)". BX-112, BX-113, BX-114, BX-119 and BX-121 are fixed,
and honest runs pass every new check. One new High, BX-122: whole numbers written as floats (`5.0`, `-0.0`, `1e2`)
passed `js_safe`. The recorder rewrites them as `5`, which the round-7 type-strict compare then treats as a rewrite,
so publishing stalls.

**Fixed at the class level, not one shape at a time.** Every publish step (`games.yml`, `games-testnet.yml`,
`race.yml`, `race-samples.yml`) first runs an inline `node -e` check. Each incoming JSON file must be **byte for byte**
`JSON.stringify(JSON.parse(text)) + "\n"`, exactly what the recorders write. A published file is then a fixed point of
the recorder's own reader and writer: the next honest run reads the same values and writes the same bytes. That rules
out `5.0`, `-0`, `1e2`, big integers, spacing, key quoting and escapes a recorder never writes, whatever Python makes of
them. `js_safe` also refuses integer-valued floats (belt and braces). The test fixtures now write the recorders' form.

| ID | Finding | Status |
|---|---|---|
| BX-122 | Integer-valued floats stalled publishing | **Fixed** (the canonical-form check, plus `js_safe`) |
| BX-123 | 0.2 Mana pick row from a testnet number | Runbook: before step 9, `mana-report` on mainnet sponsored transactions; raise the row for launch if mainnet is dearer (at most 1 Mana), then step 10 sets it from real picks |
| BX-124 | The re-typed card test stopped at the shape check | **Fixed**: the test now reaches the published-card compare |
| BX-125 | No test for BX-119 | **Added** |
| BX-126 | A primary node 2 weeks stale: one run refused | Accepted (clears on the next run) |
| BX-127 | Record job red until game 2 is registered | Runbook: publish (step 9) only after game 2 is applied |
| BX-128, BX-129, BX-130 | Info | Noted |
| BX-118 | No clock rule for new race cards (future races) | **Before prizes** |

**Blind review of the round-8 fix (2026-10-30).** "The node check closes the same-value-different-text class." Its
findings, all fixed:
- the samples job took a sample up to 10 min ahead, but `loadSamples` drops anything more than 60 s ahead, a
  self-healing stall of 1–2 runs. Both bounds are now 60 s;
- the node check runs after the symlink and file-type refusals, refuses any `.json` that isn't a regular file,
  compares raw bytes (so invalid UTF-8 is refused, not just crashed on), and takes its path after `--`.

Tested directly: `tests/audit/repolens-r8-canonical.test.mjs` runs the exact line from each of the four workflows
against honest and crafted files. Testnet only, accepted: a bad run could set testnet `cards.json` `startHeight` high
and quietly stop that testnet game recording (it doesn't stall publishing).

## Round 9 (Repo Lens go/no-go @ 6990323, 2026-10-30): NO-GO, "one fix in one file, then GO"

Report: "Block X Prize-Free: Round-9 Go/No-Go (Knode picks @ 6990323)". The round-8 byte check is confirmed for
everything it targets, in all four workflows. The blind verifier found no other place where a value Python accepts can
make an honest run be refused, except this one:

| ID | Finding | Status |
|---|---|---|
| BX-128 | Python's `\d` matches every Unicode digit (`٤٠٠`, `４００`); `loadSamples` (JavaScript `\d`, 0–9 only) drops such a sample, so one bad run stalls race-samples for ~7 h 50 min | **Fixed**: every `\d` in the four publish steps' Python is `[0-9]`; the auditor's test passes, and a guard test refuses any `\d` there again |
| BX-129 | The page says "change it once" before the announced config is applied | Runbook: publish only after step 8's `status` shows 1 change |
| BX-130 | The other `\d` regexes (iso, ymd, race id) | **Fixed** with BX-128 |
| BX-131 | Publish jobs used the runner's own Node | **Fixed**: `setup-node` 22 (pinned) in all four publish jobs |
| BX-132 | Old samples between +60 s and +10 min | One-time transition; none needed |
| BX-133 | Two commits after the package (announce record, testnet sponsor option) | In the next fix-check's scope |

## Round 10 (Repo Lens go/no-go @ a55390f, 2026-10-30): GO at a55390f, with one launch condition

Report: "Block X Prize-Free: Round-10 Go/No-Go (Knode picks @ a55390f)". BX-128 and BX-130 are fixed for the whole
family. The `\d` guard catches a planted regression, and BX-131 is fixed. Both BX-133 commits were checked: one is
docs only, the other is testnet only.

| ID | Finding | Status |
|---|---|---|
| BX-138 | Launch condition: `picks` has since merged `main` (c52a649, b301bfa), which changes `race.yml` and `bot/race.ts` (the Race Vault results file, the stricter race-data fetch). The round 8–9 fixes survive, but the new code wasn't reviewed | Blind review of `git diff a55390f HEAD -- .github/workflows bot/race.ts`, then a Repo Lens fix-check (round 11) of that diff before launch |
| BX-136 | The `\d` guard didn't look inside `python3 -c` one-liners | **Fixed**: the guard checks them too (`python3 -c` and `python3 -I -c`) |
| BX-137 | `CHECK_NOW_MS` / `RACE_CHECK_NOW` let tests set the publish clock | Accepted: the workflows never set them, and CI runs the tests inside GitHub Actions, so refusing them there would break CI |
| BX-129, BX-123 / BX-127 | Runbook steps | As recorded |

Not part of Block X, recorded here because it's in the same runbook: Repo Lens FC2-13 (Combo Card). The Picks v2
upgrade must write v2's `wasmSha256` into `picks-data/deployment.json`. It is step 5 of "Later: the Picks v2 upgrade"
in `docs/blockx/MAINNET-LAUNCH.md`.

**Blind review of the merge (BX-138, 2026-10-30).** Scope: `git diff a55390f b301bfa -- .github/workflows/race.yml
bot/race.ts`. Verdict: nothing must be fixed before prize-free Block X goes live. No check was weakened. The vault
files are written exactly as `JSON.stringify` + newline, and the fetch of `vault/` paths is anchored. Its findings:

| ID | Finding | Status |
|---|---|---|
| V1 | Low: one bad vault file (a recorder bug) failed the whole publish, cards included, for up to a week | **Fixed**: a vault file that fails its check is held on its own with a warning (no file means no prize). The race files still publish, and a final file still never changes. Tests: the shape check and an end-to-end publish |
| V2 | Info: the record job's `for f in $(git ls-tree …)` split names on spaces, and a failed `ls-tree` didn't fail the step | **Fixed**: `ls-tree -z` goes to a file first, then a `read -d ''` loop |
| V3 | Info: `ls-remote --heads … race-data` also matched `x/race-data` | **Fixed**: `refs/heads/race-data` exactly |
| V4 | Info: if the chain isn't Vault v6 yet, the stake read says "not staked" without an error, so a week could go final with everyone free | **Before prizes**: refuse (throw) unless the chain is v6. Today the repository ABI has no `get_game_player`, so the read throws and the file stays not final |

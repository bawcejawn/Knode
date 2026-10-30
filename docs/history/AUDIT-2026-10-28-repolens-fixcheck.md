# Repo Lens: Block X fix-check + sponsor v3 audit (report @ 148c00f, 2026-10-28)

Source: the Repo Lens report doc https://claude.ai/artifact/P55p92PD9PU2TMJv4YHZTA, as plain text (tables flattened).

```
 · 
Verdicts
Both parts: fix first. No Critical anywhere. The Picks contract is unchanged, and all three builds reproduce exactly. Most BX fixes hold: 23 of 34 are fixed. The original BX-3(b) attack is closed, but the new card can still be gamed after it is taken, and one producer or one bad node can switch its protections off. The sponsor v3 contract is sound as code; its problems are cheap player lock-outs and an owner tool and runbook that would not apply your settings.
Part
Verdict
Critical
High
Medium
Low
Info
A. Block X fix-check (new findings BX-35+)
Fix first
0
2
3
9
4
B. Sponsor v3 (SP-n)
Fix first
0
0
8
6
7
Must fix before mainnet (a launch without prizes):
BX-37: one producer whose two node reads differ holds the whole card for everyone. Judge each producer on its own.
BX-38: sampling fails open, and one future-dated head time freezes the samples branch. Reject future times; hold or flag a card with too few samples.
BX-39 and BX-40: decide what happens to guest keys made on bawcejawn.github.io since 26 Oct, put the origin check on every guest path, and put the knodegames.com move into the branch.
SP-1: the runbook's config --send keeps v2's caps (1 / 25 / 150 / 1,000 / 300). Your 5,000 / 2,000 / 50 / 300 are never applied.
SP-4: measure a sponsored pick before setting the 0.15 limit, or launch Picks with no per-action limit.
SP-5, SP-6, SP-7: the tool must refuse a failed config read, must not treat a missing receipt as 0 Mana, and must never lower a limit after a run-out.
SP-2 and SP-3: at least alerting and a wording fix. One person can lock all sponsored players out for a UTC day for about 1 VHP they keep.
Must fix before prizes (PRIZES_FROM_WEEK): BX-35 and BX-36 (both High), BX-2, plus the rest of the list above.
Repo tests were not run, by the standing rule. Every claim rests on static reading and our own re-implementation scripts; each Medium or High claim was re-checked by a blind verifier.
Scope, method and build fingerprints
All three contract builds reproduce the expected fingerprints at commit 148c00fcba57c973269c40234f413313f6624a1a (branch picks). The package knode-fixcheck-blockx-sponsor.zip matches that commit byte for byte, apart from 00-COMMIT.txt and 00-FIXCHECK-PROMPT.md.
Build
sha256
Bytes
Match
Picks release
700c296a1064b904299c156061d6caf8fcabd0b1765968903f29d89d2426c594
32,667
yes
Picks testnet (--owner 1JZ5UoH4AU5roCgYEmtJ7G6mCvzE4jSTMC)
39cc5e003c234b0e0b054376bdb53245e97157202ae971a11bc5cc490f7aa7ab
32,658
yes (lines 25, 26, 49 changed)
Sponsor v3 release
21bec82583e1a7decbb2c70376f4b08e026f617c32bca268ab700f50e9aef2df
33,210
yes
Build method: a clean copy, npm ci --ignore-scripts, then the repo's own npm run build (its prebuild ran the pinned helpers and protoc-pin, which printed "protoc 21.12 (linux-x86_64) installed and checked").
Scans: gitleaks over the 8 new commits found no leaks; a WIF key sweep of the diff found 0; zizmor on the four changed workflows found nothing beyond unnamed-job notes.
Not run: the repo's tests, bots, workflows and site. Your prompt asks for npm run test:audit:serial and the contract test suites; under the standing rule we review statically and prove claims with our own scripts on our own inputs. No transaction was sent and no key was handled.
Reviewers: four parallel reviewers (site and wallet; recorder, race card and admin; sponsor contract; sponsor tooling and upgrade), then two blind verifiers who saw only the claims, not the reports. All 13 Medium-or-higher claims came back valid or partly valid.
Out of scope: the game vault and the daily-questions contract.
Part A: status of BX-1 to BX-34
Of the 34 findings, 23 are fixed and 5 are partly fixed. Two are open by your choice, one is resolved only if the domain move is live, and 3 were notes that remain sound. Line numbers are at 148c00f.
ID
Finding
Status
Evidence
What the fix left or broke
BX-1
Guest keys on the shared github.io origin
Partly fixed
site/wallet.js:262-263 sharedOrigin()/guestOn() hides guest play and refuses sending (:488) whatever deployment.json says
guestReady() (:266) has no origin check, so auto-reconnect, backup and restore still read or write an existing key (BX-40). Keys made since 26 Oct are not migrated (BX-39). The branch has no CNAME and still points canonical links at github.io
BX-2
Sybil wallets and the Free play prize
Open (your choice)
No prize while PRIZES_FROM_WEEK is unset (bot/games/blockx.ts:364-367)
Agree for a no-prize launch; decide before prizes
BX-3
Producer card: (a) missing signer ×3, (c) late card, (b) looks small
Partly fixed
(a) site/blockx-math.js:86-92 ×1 off the card; (c) blockx.ts:latestCardAt:166-174; (b) effective VHP, bot/race.ts:windowHigh:66-74, productionFloor:77-89, sample:407-436
(a) and (c) fixed. (b) closes "small before the card" but not "VHP moved in after the card" (BX-35); sampling can be switched off (BX-37, BX-38)
BX-4
Card read on one node
Partly fixed
VHP on both nodes race.ts:262-268, Staked on both blockx.ts:304-308
Producer list, block counts, blocksPerRace and card time still come from the primary only (BX-36). One disagreement holds the whole card (BX-37). The 0.5% tolerance itself is sound
BX-5
Week final with a target missing; prizes recomputed
Fixed
blockx.ts:targetsCover:404-415; freeze :368-375; publish keeps a published P###.json (games.yml:157-170)
git cat-file -e runs in a fresh repo, so refs/replace can't interfere
BX-6
Build tools fetched unpinned
Fixed
10 helpers pinned with integrity (tools/pbjs-helpers), install.cjs:39-45 refuses unpinned; protoc 21.12 by sha256 (tools/protoc-pin.cjs)
If prebuild is skipped (a global ignore-scripts=true), protoc is fetched unchecked; the build needs an unpinned global yarn (BX-52)
BX-7
Sponsor allowance used by throwaway wallets
Open (watch)
Sponsor caps (Part B)
See Part B SP-2/SP-3: lock-out is cheap, so add an alert before launch
BX-8
README overstated "can never move tokens"
Fixed
picks/README.md:35-45, docs/blockx/WHATS-CHANGING.md:16
—
BX-9
Overrides assumed
Fixed
bot/picks.ts:assertAuditedContract:311-326, called before announce, apply, pause, after upload, in status
The "two nodes" can be the same node (BX-47)
BX-10
Kondor own-Mana path
Fixed
Chain id named (wallet.js:530-531); explicit limit (:519-521); checkSigned (:564-574)
Args compared as text (BX-50, fails safe)
BX-11
Testnet funding race
Fixed
tools/testnet-site.mjs:fund:64-71 reserves before the first await
Re-implemented: 10 parallel requests for one address → 1 send
BX-12
Page said the sponsor pays for Picks
Fixed (wording)
site/blockx.js:368-372; runbook step 6
—
BX-13
Sibling pages share Kondor permission
Resolved if the move is live
Origin-level, no code
Old grants to github.io stay until users revoke them
BX-14
Page vs recorder places and medals
Fixed
blockx.ts:view:349-353 boardPlace; page blockx.js:freeWinners:416-424
20,000 random tied weeks: 0 medal mismatches. Staked board and "You: #n" still number by row (BX-41)
BX-15
Stake read errors counted as Free
Fixed
blockx.ts:readRanked:153-158, both nodes :305-308
Status read at first record, not at the lock (by design)
BX-16
Failing target not voided
Fixed
blockx.ts:285,294,307,324
—
BX-17
LIB from one node
Fixed
blockx.ts:210 (lower of two)
—
BX-18
Paging relied on page size
Fixed
blockx.ts:138
race.ts:readPicks:194 still stops at < 100 (race only)
BX-19
Owner signs for any address
Fixed
As BX-9, plus ABI pin picks.ts:64-69
—
BX-20
Post-upload check on one node
Fixed
picks.ts:235, 316
BX-47
BX-21
ABI not pinned
Fixed
picks.ts:53, 64-69; sha256 of picks/abi/picks.koilib.json matches our build
—
BX-22
Picks wallet could hold KOIN
Fixed
picks.ts:207-212; runbook
Nonce read fails open on error (Info)
BX-23
Publish shape free-form
Fixed (games-data, testnet)
games.yml:104-154 exact keys incl. boardPlace
Race cards and samples, which Block X now scores from, are checked loosely and not write-once (BX-44)
BX-24
Producer chips from one node
Fixed
blockx.js:producers:133-136
—
BX-25
Lock vs head
Sound
blockx.js:362; contract enforces the lock
—
BX-26
list_picks paging
Sound
blockx.ts:126-142
—
BX-27
New games sponsored automatically
Documented
docs/blockx/README.md:72
—
BX-28
Smart-wallet wording
Fixed
picks/README.md:21
—
BX-29
Testnet build check gaps
Fixed
picks/scripts/build-testnet.cjs:42-51, 91-111
Our run reproduced 39cc5e00
BX-30
CSP by meta tag
Partly (agree)
site/blockx.html:7, frame-buster wallet.js:13-19
Acceptable for a no-prize launch
BX-31
Testnet wallet entry point; Host
Fixed
site/testnet-wallet.js:105-128; testnet-site.mjs:98 Host on every request
—
BX-32
Testnet config not committed
Fixed
testnet/blockx.json picksSha256 39cc5e00
—
BX-33
Game settings not read from chain
Partly fixed
blockx.ts:214-221
The check fails open on a read error or missing game, uses one node, and is skipped when head is set (BX-46)
BX-34
Nonce, error print, loops, credentials
Fixed
persist-credentials: false on all 14 checkouts; safe loops; sanitized prints
—
Part A: new findings (BX-35 onward)
The fixes added 2 High, 3 Medium, 9 Low and 4 Info. The two Highs need a block producer or a lying node, which by the severity floor is High. They matter for scoring now, and for money only once prizes are on.
ID
Severity
Confirmation
Finding
Location
Fix
BX-35
High (Medium–High while no prizes)
Confirmed by re-implementation + Koinos VHP source
A producer can stay small for 6 h so the samples, the card and the floor all honestly show it small (×3). Right after the card it moves VHP in from its own second producer address; added VHP counts after 20 blocks, well before block X. Expected points about 3× an honest pick, at no production cost
bot/games/blockx.ts:297, bot/race.ts:70
Score with the higher VHP of the lock card and the first card after X (so the multiplier is the lower one)
BX-36
High (Medium–High while no prizes)
Confirmed by source check
One lying primary node still decides the producer list, the 7,200 blocks behind the floor (no signature check), blocksPerRace and the card time. It can drop a producer (×1), drop the top producer (every multiplier changes), inflate counts so the floor raises the top, or back-date the card so a post-lock read counts (reopens BX-3c)
race.ts:232, 254-258, 272-278
Read the block window and head time on both nodes and hold on any difference in signer set or counts
BX-37
Medium
Confirmed by re-implementation (read timing needs a live check)
Any one producer whose two reads differ by > 0.5% holds the whole card and drops the whole sample. Moving VHP out and back every block makes that happen on almost every run (263–277 of ~300 read pairs in our model). Block X targets then void after 3 days; samples stop, which triggers BX-38, and the old predictable read returns
race.ts:262-269, 424-428
Judge each producer separately: take the higher of the two reads for that producer, and never let it raise the card's top. Never hold the whole card for one address
BX-38
Medium
Confirmed by re-implementation
Sampling fails open: with no samples the card silently uses the single :37 read. One future-dated head time from the primary passes the publish check (at < 10**14), wipes the real samples, and freezes the branch: 999 of 999 later publishes refused in our model
race.ts:415-429, .github/workflows/race-samples.yml:95
Reject at more than a minute ahead of the check node's head; hold or flag a card with fewer than N samples in the window
BX-39
Medium
Likely; needs a count of pre-move guests
Guest keys made on bawcejawn.github.io since 26 Oct stay in that shared origin's storage, readable by any page there (answers, picks, a claimable daily-game prize). Their owners silently get a new guest on knodegames.com
site/wallet.js guest storage; no migration path
Decide and document: export/notice on the old origin, then erase; add CNAME and canonical links to the branch
BX-40
Low
Confirmed by re-implementation
The BX-1 guard covers create and sign only; reconnect, backup (shows the key), restore and switch still work on *.github.io
wallet.js:266, 316, 345, 463, 673-674, 697-698
Put sharedOrigin() into guestReady() and every guest path
BX-41
Low
Confirmed by re-implementation
Staked board and "You: #n" still number by row, so a tied player sees two places (4,132 rows in our sample)
site/board.js:88-99, 121
Use boardPlace everywhere
BX-42
Low
Likely
The random wait hides the sample only within a window anyone can watch on the public repo; a producer small only during sample runs gets ×2.2 instead of ×1 at ~60% production loss
race-samples.yml:14, 47-48
Matters after BX-35; consider more, shorter samples
BX-43
Low
Confirmed by re-implementation
productionFloor raises each producer against the original total, so it under-raises several at once and can lift others' multipliers (2.19 vs a fair 2.00)
race.ts:77-89
Solve the raises jointly
BX-44
Low
Confirmed by source check
Race cards and samples, now scoring inputs, have loose shape checks and are not write-once; a sample value up to 1e12 sets top huge (everyone ×3)
race.yml card_ok, race-samples.yml:94, race.ts:62, 71
Exact keys; write-once cards; bound samples by VHP supply
BX-45
Low
Confirmed by source check
Every address ever sampled is sampled forever; past 500 the publish check refuses every file
race.ts:417-418, race-samples.yml:94
Drop addresses with no blocks in 8 h
BX-46
Low
Confirmed by source check
BX-33's get_game check fails open (errors, missing game), one node, skipped when head is set
blockx.ts:214-221
Require the game on both nodes or hold
BX-47
Low
Confirmed by source check
assertAuditedContract's two nodes can be the same URL; node 2's chain id unchecked
picks.ts:51, 84, 316
Refuse equal URLs; check chain id on both
BX-48
Low
Confirmed by source check
A target with no card waits 3 days though none can ever appear, delaying week finality
blockx.ts:297-301, 315
Void once head > lock + 3 h with no qualifying card
BX-49
Info
Source check
Several new tests only match source text or return early: BX-1 regex, BX-31 count, BXS-4 returns at exactly 3.0 h, BXS-3 passes on argument count; nothing tests medals or the BX-10 limit
tests/audit/repolens-*.test.*
Replace with tests that run the code
BX-50
Info
Unconfirmed
checkSigned compares args as text; a wallet that re-encodes would make sends fail (safe)
wallet.js:570-572
Compare decoded bytes
BX-51
Info
Confirmed by re-implementation
Origin guard is a suffix denylist; bawcejawn.github.io. and file: pass
wallet.js:262
Allowlist knodegames.com plus named dev origins
BX-52
Info
Source check
Build needs a global unpinned yarn; with prebuild skipped, protoc 21.12 downloads without its checksum
@koinos/sdk-as-cli, picks/package.json:9-10
Note yarn 1.x in the runbook; check the protoc stamp in the build script
What would prove or disprove the High and Medium items
BX-35: on testnet with two producer addresses, hold A at a third of the top for 6 h, move VHP in right after a card; the next target's pick on A records ×3 while the next card shows A full size.
BX-36: run the recorder against a proxy that drops one signer from the primary's blocks only; a card is made without that producer and no disagreement is logged.
BX-37: on testnet, have one producer move a 1% slice out and back each block; every run logs a VHP disagreement and no card is made.
BX-38: delete the race-samples branch and see "No VHP samples yet" with a card still made; the poisoning half is fully shown by our model.
BX-39: count guest addresses that sent sponsored answers from github.io between 26 Oct and the move, and whether any hold points or a prize.
A fix is verified when the matching failing test in the package passes.
Part A: answers to your questions
Short answers to the ten "look hardest at" items, then the open items.
BX-1: New guest keys and signing are refused on every *.github.io page whatever deployment.json says. An existing key there can still be read (reconnect, backup) and overwritten (restore): BX-40. Pre-move guests are not handled: BX-39.
BX-3/4/17: A missing signer now scores ×1 and a late card can't count. One lying node can still change a board through the producer list, block counts and card time (BX-36). The 0.5% tolerance is safe: block-reward drift is about 0.006% per block for a 10,000-VHP producer, far below it. The problem is that one disagreement holds the whole card (BX-37).
BX-5: A week can't be final with a target missing (contiguous rounds and recorded neighbours). A published P###.json can't be replaced: the workflow checks in a fresh repo with no replace refs, and the shape check is exact.
BX-6: Nothing unpinned is fetched in a normal build. Edge case: skipping prebuild fetches protoc 21.12 without its checksum, and a global yarn is assumed (BX-52).
BX-9/19/20/21/22: Fixed. The "two nodes" can be one (BX-47).
BX-10: Fixed: chain id named, explicit 1 or 10 Mana limit, signed transaction re-checked.
BX-14: Medals and Free-board places match the recorder on 20,000 random tied weeks. Two display spots still number by row (BX-41).
BX-31/11: Fixed: Host checked on every request, funding reserved before the first await, pick only before and after signing.
BX-23: Exact shape for games-data including boardPlace. Race cards and samples, which now feed scores, are not held to the same standard (BX-44).
BX-3(b):
Timing: looking small before the card no longer pays; moving VHP in after the card does (BX-35). The random wait is visible on the public repo while it runs (BX-42).
One lying node: it can still shape the card (BX-36) and can freeze the samples with a future time (BX-38).
Samples file: a crafted value (compromised job or push to race-samples) can make everyone ×3 (BX-44).
Floor pushed the wrong way: it never lowers anyone, but a lying node can inflate the top producer's counts, raising everyone else's multiplier (BX-36), and its maths under-raises several producers at once (BX-43).
Open items for a launch without prizes
BX-2 (accepted): agree, since no prize is computed while PRIZES_FROM_WEEK is unset. Pick one of your options 2–4 before prizes; the free Mana total bounds cost, not fairness.
BX-7 (watch): partly disagree. Part B shows one person can lock out all sponsored players for a day for about 1 VHP they keep (SP-2, SP-3). Add an alert on daily totals and the free pool running out before launch, not after.
BX-1 and BX-13 (resolved by the move): not yet, in this branch. The move is not in the code, and keys made on the old origin are still there. Keep them Partly fixed until BX-39 and BX-40 are done.
BX-30: agree it is acceptable. GitHub Pages can't send headers; if you need frame-ancestors or a header CSP later, put a CDN in front of knodegames.com.
Part B: sponsor v3 findings
The sponsor v3 contract has no Critical or High finding: 8 Medium, 6 Low, 7 Info. Two Mediums are in the contract's economics (lock-outs); the other six are in the owner tool and runbook, which would mis-set mainnet.
ID
Severity
Confirmation
Finding and scenario
Location
Fix
SP-1
Medium
Confirmed by source check
The runbook runs config / config --send with no cap flags. With no flag the tool keeps the value already on chain, so whatever v2 was configured with stays (about 1,000 a day for everyone and 300 free; the exact live values need a read-only `status`). Your 5,000 / 2,000 / 50 / 300 are never applied, free play runs out early in the day, and SP-2/SP-3 get cheaper. The dry run does print the caps
docs/blockx/MAINNET-LAUNCH.md:80-88, 136; bot/sponsor.ts:182, 224-236
Put the full flag line in the runbook (`--per-tx 1 --per-player-day 50 --per-player-week 300 --per-day 5000 --free-per-day 2000`, plus your `--min-vhp`), or default to your settings rather than the chain read
SP-2
Medium
Confirmed by re-implementation
Player status is live VHP ≥ 1. About 60 wallets passing one 1-VHP between them (59 transfers) use the 3,000 left after free play; staked players are refused for the rest of the UTC day. Cost: one VHP the attacker keeps, plus a few Mana, repeatable daily. bot/sponsor.ts and the README say staked players "always have 3,000 or more"; that is false
sponsor/assembly/Sponsor.ts:isPlayer:330-337, authorize:160-171; bot/sponsor.ts:54-56; sponsor/README.md:19, 91-92
Reserve part of the pool for wallets with a stake in a game, or read effective VHP and a higher minimum; correct the wording; alert on the pool running out
SP-3
Medium
Confirmed by re-implementation
About 40 fresh empty wallets use up the 2,000 free pool early in the UTC day (caps count rc_limit, 50 × 1 Mana each). Guests and free players are refused until the next day. Attacker cost nothing; sponsor real spend about 640 Mana. The README accepts the cost (:107-110) but not the lock-out
Sponsor.ts:authorize:149-159, 172-180
Split the free pool into hourly buckets; lower the per-wallet free cap; alert
SP-4
Medium
Likely; needs a measurement
The planned 0.15-Mana pick limit is 3× a self-paid testnet pick. It leaves out the sponsor's own authorize (charged to the same transaction: its run, a signature recovery, two cross-contract reads, up to three writes), and Mana prices scale with each network's KOIN supply. If 0.15 is too little, every sponsored pick runs out: the sponsor is charged, the pick is lost, guests have no fallback
bot/picks.ts:292-295; koinos-chain system_calls.cpp ~419-476, resources.cpp:82-92
Measure one sponsored v3 pick from a fresh non-player on testnet and compare get_resource_limits on both networks (read-only), or launch Picks with no per-action row and set it from the first day's mainnet receipts
SP-5
Medium
Confirmed by source check
config, enable and disable rebuild the whole config from one get_config read. A failed read becomes {}, so config --send sends enabled: false with defaults: the sponsor is switched off. A lying node's values get re-signed by your key. disable --send runs the same checks, so the emergency stop can refuse
bot/sponsor.ts:setConfig:223-239
Abort on a failed read; read two nodes and show old → new before sending; let disable skip the limit checks
SP-6
Medium
Confirmed by re-implementation
mana-report reads one node, does not match receipts to transactions, and treats a missing rc_used as 0. That makes 0.05 limits for every action without one, and later sends of those actions run out
bot/sponsor.ts:manaReport:331-351
Drop samples with no receipt, a mismatched id or 0 used; read two nodes; require a minimum sample count
SP-7
Medium
Confirmed by re-implementation
An action with no limit that ran out at the 1-Mana per-transaction cap gets a new limit of 0.05 (or 2× its lighter successes), lower than what it just failed at
bot/mana-limits.ts:merge:97-108, summarize:57-61
When a run-out has no previous row, treat the old limit as the per-transaction cap: no row, and report it
SP-8
Medium (Low until live actions get limits)
Confirmed by re-implementation
"Site first, then chain" is only in the docs. config --send checks the local game-data/deployment.json, not the deployed site and not desk-data. The check passes when the site has no limits, and ignores the site's 1-Mana fallback. The runbook pushes to picks while Pages serves main. If the chain gets a row the site lacks, guests see "free play used up" and Kondor users pay their own Mana
bot/sponsor.ts:setConfig:251-257, siteLimits:317-324; mana-limits.ts:siteFits:124-127; MAINNET-LAUNCH.md:52-54, 125-138
Fetch the deployed files (no cache) and refuse unless every chain row has a site entry ≤ it and the fallback fits; fix the branch in the runbook
SP-9
Low
Likely
Caps count a transaction only once it is in a block, while the mempool reserves each pending limit against the sponsor's Mana. At the start of a day pending transactions can reserve all of it for about 2 minutes
koinos controller.cpp:901-918, mempool :434-447
Accept; or keep the per-day cap well below the wallet's Mana
SP-10
Low
Confirmed by source check
A too-low row makes every such transaction run out: the sponsor is charged about the full limit, the player's allowance is used, the action is lost
Sponsor.ts:141-143, 385-395
Covered by SP-4, SP-7, SP-11
SP-11
Low
Confirmed by source check
Run-out detection (≥ 99% used) misses run-outs stopped at a disk write and all batch run-outs; nothing alerts
mana-limits.ts:50-53
Classify by the receipt's "insufficient rc" log; hourly alert
SP-12
Low
Confirmed by source check
The "v3 testnet-only" gate is decided by NETWORK or a "harbinger" URL, not the chain id. Testnet mode writes the mainnet state, limit and site files
bot/sponsor.ts:66, 140-149; bot/bot.ts:63
Decide mainnet by chain id; separate testnet paths
SP-13
Low
Confirmed by source check
Runbook step 4's mana-limit picks:pick fails before picks-data exists (step 5). Once v3 replaces v2 in the allow-list, the tool can't roll back to v2
MAINNET-LAUNCH.md:84, 119-120; bot/sponsor.ts:62-63, 290-292
Move the line to step 6; keep v2 as a documented rollback target
SP-14
Low
Confirmed by source check
config --send doesn't check the on-chain code is v3 before sending v3 fields, and silently drops the Picks row if picks-data is missing
bot/sponsor.ts setConfig
Check the code hash; refuse when the Picks row can't be built
SP-15
Info
Source check
Per-action rows are not a spending ceiling; an action with no row adds the full per-transaction cap
Sponsor.ts:manaCapOf:394
Note in README
SP-16
Info
Re-implementation
A non-player field may appear twice in a pick; Picks keeps the last copy. Harmless today
Sponsor.ts:argsPlayer:434
Refuse repeated fields
SP-17
Info
Source check
The site asks 3 Mana for non-free actions (rcLimitOther) while the per-transaction cap is 1, so those are never sponsored and players pay
game-data/deployment.json; wallet.js:597-609
Align or document
SP-18
Info
Source check
Budget refusals reach guests as "free play used up"; a run-out shows raw logs
wallet.js:399-412
Clearer messages
SP-19
Info
Source check
payer sponsor --send writes the new rows into the site, not transition rows
bot/sponsor.ts:setPayer
Write the lower of old and new
SP-20
Info
Re-implementation
toMana rounds (0.04774581 → 0.0477) and the runbook types the shown value back
bot/sponsor.ts
Use exact values
SP-21
Info
Source check
S3-2 (nested-message rows) is still guarded only in check.ts, not by the contract
sponsor/scripts/check.ts:62-64
Keep the check in the runbook
What would prove or disprove the Medium items
SP-1: npm run sponsor -- status after runbook step 6 shows the cap line.
SP-2, SP-3: the failing as-pect spec in the package: a real staked player and a real guest are still paid after the sybil pattern.
SP-4: one sponsored v3 pick on testnet from a fresh non-player wallet, plus get_resource_limits on both networks and the rc_used of existing mainnet v2-sponsored race picks (all read-only).
SP-5: a config dry run against an unreachable RPC prints "set_config: off" today.
SP-6, SP-7, SP-8: the matching tests in repolens-sp-tooling.test.ts.
Part B: answers to your questions and what is sound
The contract keeps the sponsor's spending inside its caps, and v2 storage carries into v3 safely.
CAP_LIMIT 5,000 and the 7× weekly ceiling: no u64 or ordering issue. We re-implemented the cap arithmetic with exact u64 wrap and ran 32,407 approvals over boundary values, day and week rollovers and mid-day config changes: no violation. The compiled contract uses only unsigned 64-bit compares.
config.mana_caps: rows can only lower the budget, every operation is still checked first, and the sponsor never pays more than it counted (it counts rc_limit, the chain charges at most that). No bypass or overflow found with duplicate rows, zero rows, 16 rows or mixed operations. A too-low row makes every such transaction run out; the sponsor is charged about the full limit and the player's allowance is used, and the action is lost (SP-10).
The adjuster: its arithmetic is right (bigint rounding, units, sums). We modelled the Koinos resource market: a 2× price swing needs weeks at about half the block budget, or hours of full blocks (about 4 h for disk, 12 h for compute). So 2× a mainnet maximum is enough for load; the problems are the inputs and the order (SP-4, SP-6, SP-7, SP-8). The site copy can disagree with the chain and hurt guests, and the two-step order is not enforced (SP-8).
The Picks pick row: the sponsor's argsPlayer and the Picks contract read the same player. We re-implemented both decoders and ran 22 crafted cases plus 600,000 random ones (repeated fields, unknown fields, wrong wire types, trailing bytes, field order): no mismatch, and no input the sponsor accepts makes Picks fail.
Spam: at the measured 0.048 Mana a pick, the sponsor's real spend is small (about 640 Mana a day at most from the free pool). Because caps count the limit, not use, about 40 free wallets lock out free play (SP-3) and about 60 wallets sharing 1 VHP lock out everyone else (SP-2) for a UTC day. Koinos also limits pending transactions per payee (10), not per payer.
Upgrade path: v2 → v3 keeps storage; new fields read as empty, and empty limits behave exactly like v2. allowedBuilds keeps v3 testnet-only, but by an environment name rather than the chain id (SP-12). The runbook's steps 4 and 6 fail or misconfigure as written (SP-1, SP-13), and there is no rollback path once v3 replaces v2 (SP-13).
Earlier sponsor findings (S3-1 to S3-8)
ID
Status at 148c00f
Evidence
S3-1 1 KB transaction buffer
Fixed, still in place
Sponsor.ts:112 sets 16 KB before reading the transaction
S3-2 nested-message rows
Tool-side only, as before
sponsor/scripts/check.ts:62-64 (SP-21)
S3-3 free claims charged when reverted
Unchanged (Info)
Sponsor.ts:isFreePlay:363-368
S3-4 sybil use of the free pool
Unchanged and larger
Free pool 300 → 2,000 and per wallet 25 → 50, still about 40 wallets (SP-3)
S3-5 Mana per pick
Now a row
0.048 measured self-paid; 0.15 row not yet valid for sponsored picks (SP-4)
S3-6
Unchanged
—
S3-7 Picks ABI required in check.ts
Fixed, still in place
check.ts:53-55
S3-8 signature recovery past 4
Fixed
Sponsor.ts:signatureAddresses:548; a 5th signature reads as someone else and is refused (:131)
Also sound: only the payee may sign; would_pay cannot see the operations (your accepted L2); your review's M1, M2, L3 and L4 are fixed, while M3 and L1 are only partly fixed (SP-7, SP-11, SP-8).
Failing tests, fix prompt and process notes
The package knode-fixcheck-failing-tests.zip holds a failing test for every High and Medium except BX-39 (needs a decision) and SP-4 (needs a measurement). They were written, not run here. Each should fail on 148c00f and pass once fixed.
File (repo path)
Covers
tests/audit/repolens-bx35-vhp-after-card.test.mjs
BX-35
tests/audit/repolens-bx36-card-one-node.test.mjs
BX-36
tests/audit/repolens-bx37-churn-holds-card.test.mjs
BX-37
tests/audit/repolens-bx38-samples-fail-open.test.mjs
BX-38
tests/audit/repolens-bx39-40-guest-origin.test.mjs
BX-39 plan check, BX-40
tests/audit/repolens-bx41-board-places.test.mjs
BX-41 (Low)
tests/audit/repolens-sp-tooling.test.ts
SP-1, SP-5, SP-6, SP-7, SP-8, SP-11
sponsor/assembly/__tests__/Sponsor.repolens-sp2-3.spec.ts
SP-2, SP-3
Internal reviewer IDs inside the files are mapped in the package README.
Paste-ready prompt for Claude Code (on your PC)
PowerShell, to unzip the tests (adjust the download path)
Process notes
All three builds reproduced first time with the new protoc pin; earlier rounds needed a retry.
Your new repolens-* tests mostly run real code, but several only match source text or return early (BX-49); those would have passed with BX-40 present.
The domain move (PR #30/#31) is not on picks, so "resolved by the move" could only be judged from the record. Include the Pages/CNAME change, or a note that it lives only in repo settings, in the next package.
A Koinos fact worth keeping: the mempool reserves each pending transaction's limit against the payer, and the payer's authorize is charged to the same transaction.
```

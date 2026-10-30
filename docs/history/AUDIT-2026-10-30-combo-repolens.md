# Repo Lens final audit: Combo Card + Picks v2, 2026-10-30, and the fixes

Audit of branch `combo` at 32fae49 (report: the owner's Repo Lens doc "Combo Card + Picks v2: Final Audit"; failing
tests: `knode-combo-audit-failing-tests.zip`). Verdict: **Picks v2 contract ready for mainnet** (release `92d555d0…`
reproduced; ~600,000 fuzzed cards, 180,000 owner sequences, 20,000 v1 records: no problem). **Combo game (scoring,
recorder, page, CI): fix first**: 7 High, 5 Medium, 12 Low, 9 Info, none in the contract. Root cause: Combo branched
from `picks` before the Block X fix rounds 2 to 4 and still handled Block X legs, stakes and publishing the old way.

**The fix round rebuilds Combo on the current `picks` branch** (RL-10): the Combo files on top of it, the page at the
site root, the root math files, `picks`' own Block X recorder, workflows and build pinning unchanged. The contract source
is unchanged: the release is still `92d555d0…` (37,689 bytes), now built with `picks`' full protoc and protobufjs pinning.

Owner decisions 2026-10-30: keep the 10% rule (RL-16); keep void legs for a horse missing from the standings (RL-15);
score bands for the Vault file (RL-18), see the note there.

## High and Medium

| ID | Sev | Finding | Done |
|---|---|---|---|
| RL-1 | High | A Block X leg on a producer missing from the race card was worth ×3. | ×1, as Block X's BX-3 (`combo-math.js` `MISSING_F100`). Test C-S-1. |
| RL-2 | High | VHP moved into a producer after the lock card was never priced. | A Block X leg that hits is checked against the lock card AND the first card after the block, both with the VHP moved into the producer between its lock card and the block (read from receipts on both nodes, the higher; Block X's `scoringVhpMoves`), lowest worth under the 10% rule. Tests C-S-2, "RL-2" in `combo-recorder.test.mjs`. |
| RL-3 | High | A Block X miss was dodged when Block X voided the target for its own reasons. | A Block X leg is decided by the signer whenever the target is final and checked on two nodes, whatever `void` says. Test C-R-2. |
| RL-4 | High | The stake-only rule never ran (old Vault ABI). | Page and recorder read the Vault v6 through `kpred-v6.koilib.json` after its `get_state` check (Block X's pattern). Recorder: both nodes, the lower stake wins; unknown → no Vault file that run (error). Page: Send off for unstaked or unknown, re-checked in `sendCard`. Tests C-W-2, "RL-4" browser test, recorder tests. |
| RL-5 | High | The deadline used one node's head time; errors didn't fail the run. | Time = the slower of both nodes, checked against the runner's clock (no fixing or voiding if ahead); nothing voided on one node; the recorder exits 1 after writing its files when it raised an error (the job turns red, its files are still published). Test C-R-1. |
| RL-6 | High | One busy week passed 2 MB and stopped all publishing. | One file per UTC day (`D<day>.json`); an oversized file is held alone with an alert, the rest (Vault file included) is published. Test C-R-4. |
| RL-7 | High | The publish job checked shapes only; the recorder trusted previous files. | The recorder reads EVERY slot of last week and this week from the chain each run (earlier files only for older days, and for display when a read fails). The publish job: a published fixed slot keeps its cards and a published final card never changes (else the whole run is held, with an alert); Vault files are write-once, only for the week that just ended within 3 days by the job's clock, and must equal the PUBLISHED final board's staked players with 1+ point in order. Tests C-R-5, C-R-5b, the publish-check test. |
| RL-8 | Medium | Stale or flagged race cards priced cards. | Block X's rule: at most 3 hours old, at least 12 VHP samples, nothing flagged, top not in doubt (`usableCard`, `priceCard`, `cardAfter`). No usable card at sending: the card is void; the page won't send without a fresh card. Tests C-S-3, C-R-3. |
| RL-9 | Medium | A race recorder that stopped mid-week voided legs silently. | A pending leg is voided at the deadline only when its source has published past it (a later race with a result, a later Block X target); otherwise `::error::` and wait. Test C-R-6. |
| RL-10 | Medium | Merging into `picks` broke Combo and invited a rollback. | Rebuilt on `picks` (above). Tests C-W-1, C-R-7. |
| RL-11 | Medium | Cards share Block X's Mana row. | Owner, 2026-10-30: one Picks `pick` row of 0.2 Mana at launch (admin action `sponsor-picks-limit`), from the testnet measurement (10 legs 0.0916 Mana; `claude/combo/TESTNET-RESULTS.md`). Test C-W-3 (adapted: the limit sent is at least 2× a 10-leg card, and the launch sets 0.2). |
| RL-12 | Medium | Only half of the build pinning. | Built from `picks`' pinning (all 10 protobufjs helpers, fails closed); README says `npm ci --ignore-scripts`. Test C-K-1. |

## Low and Info

| ID | Done |
|---|---|
| RL-13 | Legs are sent sorted by (lock time, code, round, producer) (`sortLegs`). |
| RL-14 | Contract tests added: CR-2 completed, v1 records read by v2, an announced loosening changes nothing for 48 h, P-2 on a card game. 71 contract tests. |
| RL-15 | Kept (owner): a horse missing from the final standings makes its leg void. |
| RL-16 | Kept (owner): 10%. |
| RL-17 | 16,000 simulated races (was 4,000) and factors rounded down to the hundredth. |
| RL-18 | **Kept the rank mapping.** The owner chose score bands, but the Vault ranks by points and only the order counts (top 30% win, weights 1/√rank: `claude/handoff-vault-results.md`), so bands would turn close scores at the top into ties and change who wins. The rank mapping keeps the exact order of the top 254 distinct scores, which covers every prize place up to 846 staked players. To be confirmed with the owner. |
| RL-19 | `ls-remote` exit 2 = no branch; anything else stops the run. |
| RL-20 | Exact key sets and ranges, safe integers, unique legs and producers per card, slot rounds of the file's day, no fixed slot before its day ends, outcomes and points recounted. |
| RL-21 | `sending` set before the first await; the day re-checked after every wait. |
| RL-22 | Guest, stake and fresh-card refusals repeated in `sendCard`. |
| RL-23 | The testnet build and the tool check the owner in the compiled code (UTF-16 string literal), not only in the source lines or the manifest. |
| RL-24 | The browser harness serves `"cards": true` and a live Vault; 7 browser tests. |
| RL-25 | The recorder records nothing unless game 8's leg types on both nodes lock exactly as `combo-math.js` (and the page) price them. |
| RL-26 | The page won't send in the last 2 minutes of a UTC day. |
| RL-27 | C-R-1 runs the recorder's two-node head path. |
| RL-28 | `scoreCard` removed (the recorder's `recount` is the one rule). |
| RL-29 | Noted: the Top-half cut uses the field at pricing and the standings at the result (not seen to differ in live data). |
| RL-30 | Accepted: the page signs only `pick` on game 8; the contract id comes from this site's own deployment file. |
| RL-31 | Share text, canonical and share URLs: `knodegames.com/combo.html`. |
| RL-32 | Race-data producers are checked as addresses before they reach the board or a card. |
| RL-33 | `keys --fresh` writes `.env.testnet` with mode 600 where the system has modes. |

**Block X admin tool (BX-19 / BX-21):** on this branch `bot/picks.ts` accepts the audited v2 code on chain and the v2
ABI for owner calls, besides v1 (Block X's calls encode the same bytes with either). Agree with the Block X chat before
merging.

**Tests:** contract 71 (as-pect); site and audit suite 625 passing (Combo: recorder 25, Repo Lens 13, page and math 17,
testnet 3, merge 4); browser 7.

## Fix-check (Repo Lens, 2026-10-30, at e0330a1) and the fixes

Verdict "fix first": contract still ready (92d555d0… reproduces, source byte-identical); RL-10 and RL-12 fixed; 6 High and
5 Medium new, none in the contract. Most came from Combo's own copies of Block X logic that `picks` had since fixed, and
from "hold the whole run" in the publish job. First `picks` was merged again (rounds 6-7, the mainnet Picks upload).

| ID | Sev | Finding | Done |
|---|---|---|---|
| FC-1 | High | A race leg kept its send worth when no usable card was in force at its lock. | No usable lock card (for that producer) makes the leg "unresolved", as for Block X: the card is void unless another leg missed. Test D-S-1. |
| FC-2 | High | A leg its source never resolved was dropped, so a losing card could score. | New leg result "unresolved" (a Block X target without an agreed signer, or a leg undecided at the deadline): a miss elsewhere still decides; otherwise the whole card is void, with an error. `recount` in the recorder and the publish check. Tests D-S-6, D-R-2. |
| FC-3 | High | One node's "0 staked" or a huge minimum dropped players from the write-once Vault file. | Any disagreement (live, minimum, any wallet's stake) is unknown: no Vault file and an error, as Block X. Test D-R-1. |
| FC-4 | High | One node's non-canonical-transfer report voided a winning Block X leg (BX-100 not ported). | Each node read on its own: both report it → unresolved; only one, or a failed read → held, unresolved after Block X's 3-day edge (with an error). Tests D-S-2, D-R-3, D-C-5. |
| FC-5 | High | One wrong final card made every honest run be held whole. | The publish job holds only the file that differs (alert); the recorder keeps a published fixed slot and its final cards as published while the chain still holds exactly those cards, so honest runs never look like rewrites. Test D-C-4. |
| FC-6 | High | The published board was never checked against the published final cards. | Before a Vault file is accepted, last week's ranking (points, hits, last hit, places) is recomputed from the PUBLISHED day files' final cards and must match the published board. Test D-C-1. |
| FC-7 | Med–High | A moved-VHP read that kept failing left a card pending, the Vault file lost silently. | Held, then unresolved at the 3-day edge with an error; an error whenever last week still has pending cards a day after it ended. Test D-S-3. |
| FC-8 | Medium | Any flag on a card made it unusable. | Block X's rule: a card is unusable for a producer's leg only if it flags that producer or the top is in doubt (`flagsFor`; `priceCard`/`cardAfter` take the producer). Test D-S-4. |
| FC-9 | Medium | Degraded honest runs un-fixed published slots and were held whole. | As FC-5: published fixed slots and final cards are kept when a read fails, a node is down or a clock is ahead. Tests D-R-4, D-C-3. |
| FC-10 | Medium | board.json had no size bound. | All time: top 1,000; Today and This week: top 2,000; Last week: everyone with 1+ point plus the top of the rest to 2,000. Test D-C-6. |
| FC-11 | Medium | Re-reading everything every run may not fit 30 minutes. | Cards final on published fixed slots are never re-priced (no receipt reads for them). Live timing still to measure. Test D-R-5. |
| FC-12 | Low | Live race-data has no samples: every card would be void. | The recorder raises an error while the newest race card has no samples. Launch gate. |
| FC-13 | Low | The 0.2 row was checked against a player-paid card. | Open: a sponsored testnet pick used 0.116 Mana (admin action text), so a sponsored 10-leg card must be measured before cards go live. |
| FC-14 | Low | `sortLegs` used an estimated Block X time. | By code, round, producer only. Test D-W-1. |
| FC-15 | Low | The loosening test was refused for the wrong reason. | The reviewer's corrected test (stored-leg path). 71 contract tests. |
| FC-16 | Low | After a wallet switch, Send could use the old wallet's stake. | Stake, slots and usage cleared when the wallet changes. |
| FC-17 | Low | The Vault file tied equal points the board separates. | Mapped by board place (as Block X). Repo Lens agreed the rank mapping is right for an order-only Vault (RL-18). |
| FC-18 | Low | `readCards` stopped silently after 1,000 pages. | Throws. |
| FC-20 | Info | The workflow guard didn't run Combo's tests. | It does. |
| FC-21 | Info | An empty Vault file could be written before v6 is live. | No Vault file until v6 is live. |
| FC-22 | Info | The page didn't check the leg types' clocks. | It does (same values as the recorder). |
| FC-23 | Low | index.json wasn't append-only. | Published days must stay; new days only last week or this week (else that file is held). |
| FC-24 | Low | Type-loose compares. | `same()` (types included) for published content and headers. |
| FC-25 | Info | Tests passing for the wrong reason. | C-R-1 now sets the runner's clock past the lie; C-R-5b writes a day file; the stake browser test runs with a live Vault; C-W-3 uses the site's real sponsor block. |
| FC-26 | Info | The recorder didn't filter race-card producers. | Filtered as on the page. |
| FC-27 | Info | `bot/picks.ts` would accept v1 after v2 is live. | Once picks-data/deployment.json records the v2 code, only v2 is accepted. |
| FC-19 | Info | Clock-edge holds for one run. | Accepted. |

The reviewer's fixtures were adapted, each change commented: real addresses (koilib's encoder checks them), a fake node
that also speaks koilib's provider interface, and the publish Python cut from combo.yml instead of a copy.

**Tests:** contract 71; site and audit suite 664 passing (5 todo, 5 skipped); browser 7; workflow guard 8.

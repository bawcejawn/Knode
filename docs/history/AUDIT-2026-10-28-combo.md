# Formal audit: Combo Card + Picks v2 (CARD type), 2026-10-28

Three independent auditors, each given only the code and the brief (`claude/audit-combo-prompt.md` in the project), not
the author's reasoning. Branch `combo` at 7c26e99. Fixes in the commit after it; this file records every finding and
what was done.

| Part | Auditor's verdict | After fixes |
|---|---|---|
| A. Picks v2 contract | **Ready for mainnet** (no Critical/High/Medium) | Docs corrected; release sha256 unchanged |
| B. Scoring and recorder | Fix first (2 High, 3 Medium) | All fixed, each with the auditor's failing test now passing |
| C. Page, Mana sponsor fit, CI | Fix first (2 Medium) | Page fixed (auditor's browser tests pass); sponsor items handed to the sponsor chat |

**Picks v2 release candidate:** `92d555d0680157854452e35162c1b1c5c100904996194b8c1c848df50e5e1c3d` (37,689 bytes), the
same bytes before and after the fixes (only comments changed in the contract folder). 67 contract tests;
`npm run check` passes. v1 records (raw v1 wire bytes) decode and behave exactly as before (auditor A's test).

## A. Picks v2 contract

| ID | Sev | Finding | Done |
|---|---|---|---|
| CC-A1 | Low | Proto and README said announce "may only ADD leg types"; the code (by design) also lets the 48-hour announcement loosen an existing leg type and add an alias code with an existing clock. | Docs corrected (proto, README). The owner must not announce alias codes; the bot's alert on every announcement covers game 8. The page offers only known codes; the recorder leaves out unknown codes. |
| CC-A2 | Info | README named the v1 sha256 and test count. | README: v1 and v2 hashes, 67 tests, upgrade steps. |
| CC-A3 | Info | After the upload the announced hash stays set; the same bytes could be uploaded again within 7 days (harmless). | Upgrade steps now end with `schedule_upgrade` with an empty hash. |
| CC-A4 | Info | A card can be changed only on its own UTC day, even if its legs lock later. | Stricter, never looser. The page says so. |
| CC-A5 | Info | The same legs in another order count as a change (CR-4). | Accepted: the page sends legs in lock order. |

## B. Scoring and recorder

| ID | Sev | Finding | Done |
|---|---|---|---|
| CC-B1 | **High** | Only the last 3 days' slots were read; after an outage or a mid-week start some slots were never read and the week never turned final (no Vault file). | Every unfixed slot of last week and this week is read each run. Test: a 4-day outage mid-week still gives the Vault file. |
| CC-B2 | **High** | The price was frozen when the slot was fixed; a race card published later left the card pending forever (or priced with an older card). | A card is priced only once race-data holds a card taken after it was sent (so the card in force is known for sure), and is priced again each run until final. Test: late race card → card final, priced with the card in force when sent. |
| CC-B3 | Medium | Missing race-data at the fixing run voided the day's cards for good. | Missing race-data makes cards wait; only the deadline voids them. Test. |
| CC-B4 | Medium | One missing result held a week open until about Friday, past the Vault's 3 days. | Deadline: two days after the card's week ends, unknown leg results are void and unpriced cards are void. Test: Vault file by Wednesday 23:00. |
| CC-B5 | Medium | A leg priced when sent could keep a long-shot worth after its producer's VHP grew (VHP can be moved), up to 24 h before the lock. | Each leg is worth the lower of its worth when sent and on the race card in force when it locks (`finalWorth`). The page says worths can drop, never rise. Test. |
| CC-B6 | Low | The stake cache was per week only; Today (empty) poisoned This week. | Cached per week and wallet. Test. |
| CC-B7 | Low | A crafted previous file could duplicate a slot or a player and carry made-up points. | One entry per slot, one card per player; a final card's outcome and points are recounted from its legs. Test. |
| CC-B8 | Low | Race files parsed many times per card (slow with spam). | Each input file is read once per run. |
| CC-B9 | Info | Today's board was always empty. | Today lists cards decided today. |
| CC-B10 | Info | Board tie-break used the recorder's run time; the Vault file only has points (ties share there). | Tie-break by when the card's last leg was decided (deterministic). The Vault ranks by points only; equal points share, as the Vault's rules say. |
| CC-B11 | Info | Only the primary node's irreversible block decided when a slot was fixed. | A slot is fixed only when both nodes are irreversibly past its day. |

Checked clean by auditor B: result edge cases (ties, zero steps, horse missing, missed race, void target), score
mixes, no-cap arithmetic (max 5.67e9 hundredths), deterministic simulation order, same-race legs (Win + Show on two
horses is slightly positively correlated, but the ×3 cap keeps the best such card's expected value at 0.60–0.70,
below the 0.75–0.875 of an ordinary card: not exploitable).

## C. Page, Mana sponsor fit, CI

| ID | Sev | Finding | Done |
|---|---|---|---|
| CC-C1 | **Medium** | During the page's refresh, or after a failed read, Send could go to slot 1 and replace the player's own card; after midnight it could go to the new day's slot. | Slots are replaced only after every read succeeds; unknown slots or a new UTC day block Send; right before signing the target slot is re-read on chain and must be empty (new card) or exactly the card being changed. Auditor C's two browser tests now pass; static tests added. |
| CC-C2 | **Medium** | The sponsor would refuse every card (Picks row arg types have 5 fields); its `check.ts` asserts that shape; the page's sponsor settings don't cover Picks. | Sponsor side, handed to the Block X / sponsor chat: `PICKS_ARG_TYPES = 0x030101030103`, update `check.ts` (expect field 6, re-decide S3-2: safe because `argsPlayer` reads only top-level fields), add Picks to `covers` with a `picks` key and its `rcLimits` in game-data/deployment.json. |
| CC-C3 | Low | Cards share the Picks `pick` Mana row with single picks; a row set from single picks may be too low for a 6-leg card. | Sponsor chat: measure a 6-leg (and 10-leg) card on testnet and set the row from the larger. |
| CC-C4 | Low | The sponsor row can't tell game 8 apart: unstaked wallets' (and, once pinned, guests') cards count as free play; only the page refuses them. Cost bounded by the existing caps. | Accepted (scores ignore unstaked players; the Vault checks stakes). Sponsor chat may keep `PINNED_PICKS` empty until a free Picks game launches. |
| CC-C5 | Low | The page treated `active_stake` as staked; the recorder ranks on `week_stake`. | The page uses `week_stake` and says a stake made this week counts from next week. Test. |
| CC-C6 | Low | The publish check accepted duplicate Vault rows and duplicate slots. | Refused now. Test runs the workflow's own check on real recorder output and on tampered copies. |
| CC-C7 | Info | One pending run per concurrency group: a third queued run drops the pending one. | Accepted; the next hour catches up. |

Checked clean by auditor C: no HTML from data (textContent only), CSP (no violations, share image works), framing,
draft validation, signing scope (only `pick` on the Picks contract named by this site's own deployment file),
argument sizes (realistic cards up to 10 legs fit 400 bytes: 2 legs 105, 6 legs 244, 10 legs 383), CI token
separation, file-name checks, push loop. actionlint clean.

## Test counts after the fixes
Contract 67 (as-pect); recorder 19; page and math 17 (site.combo); full site/audit suite 426 passing.

## Fix-check (independent, 2026-10-28)

A fourth auditor checked the fixes (diff 7c26e99..7edb604): every original finding fixed except CC-A2 and CC-B7
(partly), plus one new Medium. Verdict "fix first"; all fixed in the next commit:

| ID | Sev | Finding | Done |
|---|---|---|---|
| FC-1 | **Medium** | A race-data download failure in the run where the deadline passed voided already-priced cards; the void left `priceAt` and leg results set, so the next run's recount turned them back into hits (the Vault file changed after it was final). | A missing race-data or Block X file is an outage: cards wait and an `::error::` is raised, never void. A card voided at the deadline is recorded with `priceAt` null and void legs, so a recount agrees. The workflow stops if a branch exists but can't be fetched. Tests: the auditor's reproduction, plus "voided stays void". |
| FC-2 | Low | The hourly race cards' small drift lowered about 1 in 6 legs' worths with no real VHP change (cards paid ~3% less than shown). | A leg takes the lock card's worth only if it is more than 10% below the worth when sent. Page text updated. Test. |
| FC-3 | Low | A crafted previous file could mark a slot of a day that isn't over as fixed (never read again). | A slot from a previous file counts as fixed only if its day is irreversibly over on both nodes; otherwise it is read again. Test. Leg results in a previous file are still trusted (as CC-B7: anyone who can push games-data can write the Vault file directly). |
| FC-4 | Info | If a slot can never be fixed (second node down, nodes disagreeing), the only signal was a warning. | `::error::` when last week's slots aren't all fixed a day after the week ended. |
| FC-5 | Info | README said 46 contract tests. | 67. |

The auditors' browser tests (CC-C1 and the fix-check's three) are in `tests/browser/` (`npm run test:browser`, needs
Playwright's Chromium): 5 passing.

**Test counts after the fix-check:** contract 67; recorder 23; page and math 17; full site/audit suite 430; browser 5.

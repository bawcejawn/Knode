# Last Node Standing: Fix-Check Round 2

**Repository:** `bawcejawn/Knode`, branch `lastnode` at `7c301a82` (the branch tip on 2026-10-30).
**Diff reviewed:** `git diff 0f9e98e 7c301a8` (commits `7982e82` and `7c301a8`; 10 files).
**Date:** 2026-10-30.
**Method:** static review only.
- Four reviewers worked in parallel: the history check, the race-time check, form from samples (plus the recorder items), and watch-and-hold (plus the page items).
- Two blind verifiers then re-checked every finding rated Medium or higher without seeing the reviewers' reports. All 11 held; two held only in part.
- Proofs come from our own runs: byte copies of `lastnode-math.js`, verbatim slices of `bot/games/lastnode.ts` with stubbed imports, and the workflow's publish step (including `histcheck.py`) in scratch git repositories.
- We ran none of the repository's tests, its recorder or its workflows.
- Failing tests are in `lastnode-fixcheck2-failing-tests.zip`. They were written, not run.

## 1. Verdict: fix first

**What works:**
- The round-1 swap attack is gone. The swapping node's form is now 1.001, and its win chance 9.4% against 9.7% honest (it was 99.8%).
- Points in a vault file are recomputed and must match the day files.
- Published history (fields, picks, hours so far, finished events, a final week) can't be rewritten.
- The Python ports of `cutsFrom`, `playerResult`, the board's `view` and `vaultScores` match the JavaScript on about 22,000 random and real-shaped cases. The one exception is a single rounding value (N-8).
- The page fixes hold, and the page still signs one Picks `pick` for game 13.

**Must fix before launch:**

| ID | Severity | One line |
| --- | --- | --- |
| N-1 | **Critical** (needs one bad record run) | The publish check trusts anything not yet published. Invented hours, hour-0 picks or a first field reach the vault file: one player went from 21 to 27 points and another from 46 to 40, with no alarm |
| N-2 | **High** (no attacker) | The recorder drops the field's `vt` when it reloads a day. The second honest run after any field is published is refused, and so is every run after that: nothing is ever recorded |
| N-3 | **High** (needs one bad record run) | "Last week final" and a vault file are accepted while Sunday's event is unfinished. Every honest run is then refused until next Monday |
| N-4 | **High** | Each hour is judged by a race card taken 6–47 minutes into it. VHP moved in after the card is never cut. On mainnet today (no samples), 10% unseen extra blocks give an 81% win chance against 11% fair |
| N-5 | **High** (needs one faulty RPC node) | Form ignores the samples' dispute flags and has no cap on sample values. One lying node, or one oversized sample per hour for 2 hours, gives form 0.80 and a 99.6% win chance |
| N-6 | **High** | Watch-and-hold misses cheap gaming. Skipping 3% of blocks wins 2.3–2.75× the fair share and is held in only 10–14% of weeks |
| N-7 | Medium | A race card that reaches race-data late makes a published hour "not the card to use", and every later publish is refused for good |
| N-8 | Medium (needs a planted field) | One rounding value and ties above 2^53 differ between Python and JavaScript. A planted field causes a permanent refusal |
| N-9 | Medium (needs one bad record run) | The publish job never checks watch-and-hold, so a bad run publishes a held week's vault file |
| N-10 | Medium | Honest weeks are held often: 28% with a 5% daily spread. With the mainnet launch state (no samples, so no form) every week is held, which makes the hold useless as a signal |
| N-11 | Medium | A network error reading race-samples looks like "no branch yet", and missing samples set the field at once without form, with no warning |
| N-12 | Medium | The 4-minute form deadline frees `run()`, but the slow read keeps the process alive. The job can still hit its 15-minute timeout and upload nothing |

**The fix pattern:**
1. **Make republishing idempotent.** Carry the published field through unchanged (N-2), and add a recorder → publish → recorder → publish test.
2. **Never re-judge published parts against data that can change** (N-7).
3. **Check completeness and the hold in the publish job** (N-3, N-9).
4. **Give new content a source the record job doesn't control** (N-1). This can be the publish job re-reading new hours' signer counts from two nodes, or, as a minimum, documenting that the record job is fully trusted for new data.
5. **Judge each hour by VHP covering the whole hour** (N-4): the highest 5-minute sample in the hour, or the first card after the hour ends. Use the samples' dispute flags, and cap sample values (N-5).
6. **Don't launch on mainnet until race-samples has run for at least 48 hours** (N-10, N-4). Then re-tune the hold against a real daily spread and add a check on blocks against VHP share (N-6).

**Fingerprints and scans:**
- `picks/assembly/Picks.ts` sha256 starts with `444209c1`, the audited v1 source. It is unchanged in this diff, so I didn't rebuild it.
- gitleaks on `0f9e98e..7c301a8`: no leaks. The WIF key sweep of the added lines found nothing, and zizmor found nothing.
- There are no agent-config files.
- **Merge base:** `lastnode` still sits on an old `picks` (merge base `81acd5f`). Its race-samples writer is the old copy, which keeps the higher read and writes no flags.
- **No race-samples yet:** the live repository has no `race-samples` branch, so mainnet fields are set without form today.

## 2. Round-1 findings

| ID | Status | Evidence (7c301a8) |
| --- | --- | --- |
| LNF-1 vault points unchecked | **Fixed** (points); the subset part is accepted | `lastnode.yml:histcheck:443-450` replays `vault_scores` for the listed wallets. A file listing only some wallets still passes, and is handed to the Vault bot as your design. Combined with N-1, a bad run can leave out rivals or list an unstaked scorer; the next honest run alerts, but the file is kept |
| LNF-2 published history rewritable | **Partly fixed** | `histcheck:413-420` and the add-only push loop (`482-485`) block rewrites. New content is trusted: N-1 |
| LNF-3 VHP after the field card | **Partly fixed** | `lastnode-math.js:raceCut:217-229`, `lastnode.ts:547-549`, `check_hours:321-335`. VHP added and *kept* is cut. VHP added after each window's card isn't: N-4 |
| LNF-4 swap vs the 6 h-high baseline | **Fixed for the swap**; new routes reach 0.80 | `lastnode.ts:sharesFromSamples:194-206`. Round 1's simulation now gives form 1.001. Disputed or oversized samples: N-5 |
| LNF-5 one bad board stalls honest runs | **Partly fixed** | A bad vault file is left out on its own (`509, 520`). Any other `histcheck` error still refuses the whole run, and N-2, N-3, N-7 and N-8 are new ways in |
| LNF-6 form read unbounded | **Partly fixed** | `formFor:452-458` has a 4-minute race, but the read isn't aborted: N-12 |
| LNF-7 2 MB cap | **Partly fixed** | Board lists are capped at 2,000 rows (`lastnode.ts:47, 598-601`), and oversized files are left out alone (`lastnode.yml:129-131`). `lastWeek` is uncapped, so `board.json` passes 2 MB at about 12,900 players in one week (L-4) |
| LNF-8 cheap edge from the form floor | **Partly fixed** (detected sometimes) | `watchWeek:354-376`: N-6, N-10 |
| LNF-9 public hot hand | **Accepted** | `README:28`. `lastnode-math.js:15` and `lastnode.html` still say "luck on the day" (L-12) |
| LNF-10 a day's week | Fixed | `shape:day_ok:160`, `histcheck:403` |
| LNF-11 page clock | Fixed | `lastnode.js:532, 590`; small leftovers (I-5) |
| LNF-12 no vault file alert | Fixed | `histcheck:451-454`, `lastnode.yml:521`; one false alarm (L-6) |
| LNF-13 `nodeKey` | Fixed | `lastnode.ts:45`; aliases normalised |
| LNF-14 handicap shape | Fixed | `shape:field_ok:151-154` |
| LNF-15 bad node in the page | Fixed | `lastnode.js:loadDay:117-118` |
| LNF-16 field without form | Fixed as you chose | `formFor:263`: only 3 h after picks open. N-11 makes it immediate on a read hiccup |
| LNF-17 short block replies | Fixed | `blocksAt:213-222`, `windowReader:241-247`, `hourlyReader:268-276` |
| LNF-18 race card shape | Fixed in the recorder | `cardsIn:153-156`. The publish side lacks the same row filter (L-10) |
| LNF-19 page wording | Mostly fixed | The form note now says \"against the VHP share each hour's race card gave it\", but form now uses the 5-minute samples (L-12) |
| LNF-20, LNF-21 | Not in this fix round | Unchanged (Low) |
| LNF-22 registration check | Fixed, small gap | `checkRegistration:283-292` skips `lead` and `ahead` (L-5) |
| LNF-23 player results | Fixed | `histcheck:411` replays `playerResult` |
| LNF-24 testnet picks on one node | Not in this fix round | Unchanged (Low, testnet only) |
| LNF-25 locked pick, day in label | Fixed | `lastnode.js:352-353, 261, 364-365, 376`; two labels still lack the day (I-5) |
| LNF-26 late vault file warning | Fixed | `lastnode.yml:214, 497` |
| LNF-27, LNF-28 | Not re-checked | Low wording and page settings items |
| LNF-29 wallet change in `sendPick` | Partly fixed | `lastnode.js:534`. The guard almost never trips, because `mineWho` is set synchronously on a wallet change (I-6) |
| LNF-30 backup cut scores 0 | Fixed (README) | \"The cut where your backup takes over doesn't count as a cut survived\" |
| LNF-31 | Not in this fix round | Unchanged (Info) |

## 3. New findings (most severe first)

### N-1 — Critical (needs one bad record run): new hours, hour-0 picks and a first field are trusted, and reach the vault file
- **Where:** `.github/workflows/lastnode.yml:histcheck:401-421`. Only already-published parts are compared with the published branch. New hours are checked for shape, timing and the race card, but not for their block counts. Picks are write-once only after they are first published, and a field only after its first write.
- **Scenario:**
  1. Sunday's event is published up to hour 0.
  2. Shortly before the end, a bad record run (a compromised dependency or repository code) appends invented hours that cut nodes in a chosen order, then marks the week final and writes the vault file.
  3. Everything passes, and the file is final.
- **The same path also lets one run:**
  - write the hour-0 picks (fake wallets on every node);
  - plant a field before the honest recorder publishes it, or during the up-to-3-hour form wait;
  - list only chosen wallets in the vault file. That last case does alert on the next honest run, but the published file is kept.
- **Fix:**
  - Have the publish job (Python, no repository code) re-read each newly added hour's signer counts from two RPC nodes and compare them with `blocks`.
  - Re-derive a new field from its race card, or at least require `vt` and an existing card.
  - Re-read `week_stake` for the vault file's wallets and require that the list equals the scoring wallets that are staked.
  - Until then, say plainly in the README that the record job is fully trusted for new data.
- **Confirmation:** confirmed by re-implementation. Whether the Vault contract pays an unstaked listed wallet needs developer confirmation, because the vault bot isn't in this repo.
- **What would prove or disprove it:** the publish job comparing new hours with the chain. Nothing in the job reads the chain today.
- **Proof** (blind verifier VA, verbatim publish step and byte copy of the recorder):
```
=== HONEST branch
D2026-11-01 winner 1GGxRhLN7Ek54xycG5XaZBE4bCgwV2xtvk players [('1P444', '1GGxRh', 14), ('1P888', '14MHW6', 8), ...]
published vault W1: [('1P444', 46), ('1P111', 38), ('1P222', 28), ('1P333', 23), ('1P999', 22), ('1P888', 21), ...]
=== ONE BAD RUN at 2026-11-01T23:03Z, then honest
tampered: winner 14MHW6TF8gw8EuMRLCJc2PQHLzZLKuwGqb done True hours 9
bad run Last Node Standing files published. publish exit: 0
2026-11-01T23:08Z honest publish exit: 0
2026-11-02T12:05Z honest publish exit: 0
```
In this run, 1P888 went from 21 to 27 vault points and 1P444 from 46 to 40. Every later honest run exits 0, so there is no alarm.

The easier path, a vault file listing only chosen wallets:
```
bad vault rows [('1P888', 21), ('1P555', 16)]
Last Node Standing files published.
publish exit: 0
honest next run:
::error::Already published, and this run's copy is DIFFERENT (kept the published one; check it before the Vault seals): lastnode/vault/W1.json
publish exit: 1
```
- **Failing test:** `M-H-history.test.mjs` "M-H-n2".

### N-2 — High (no attacker): every honest run after the first field is published is refused, for good
- **Where:**
  - `bot/games/lastnode.ts:loadDay:111` rebuilds the field without `vt`, and `:117` drops `card: null`.
  - `run:448-452` rewrites every known day file on every run.
  - `lastnode.yml:histcheck:415` refuses with \"the field changed after it was published\".
- **Scenario:** run 1 publishes tomorrow's field, which `makeField` writes with `vt`. Five minutes later run 2 reloads it without `vt`, writes it back, and is refused. Every later run is refused the same way, so no hour is ever recorded until someone hand-edits games-data. Your tests never run recorder → publish → recorder → publish, so they don't see it.
- **Fix:** keep `vt` (and `card: null`) in `loadDay`. Better, carry the published field object through as it is. Add a test that publishes, then republishes unchanged.
- **Confirmation:** confirmed by re-implementation. The patched copy passes all three runs.
- **Proof** (verifier VA):
```
== run 1 at 2026-10-29T14:02Z
...
lastnode files ok
Last Node Standing files published.
publish exit: 0
published D2026-10-30 field keys: ['at', 'c', 'fairness', 'form', 'nodes', 'vt'] vt= 11986669.58
== run 2 at +5 min (honest, nothing changed)
incoming D2026-10-30 field keys: ['at', 'c', 'fairness', 'form', 'nodes']
lastnode files ok
::error::D2026-10-30.json: the field changed after it was published
::error::D2026-10-28.json: the field changed after it was published
::error::D2026-10-29.json: the field changed after it was published
::error::Refusing to publish this run: its files break the rules or change published history.
publish exit: 1
== run at +3 h
::error::D2026-10-30.json: the field changed after it was published
... publish exit: 1
```
- **Failing test:** "M-H-n1".

### N-3 — High (needs one bad record run): a "final" week before Sunday's event ends stalls publishing for about 6.5 days
- **Where:** `histcheck:434-435`. `final` is whatever the board says; completeness (the recorder's `coversWeek`) is never checked on the publish side.
- **Scenario:**
  1. While Sunday's event is still running, a bad run publishes `lastWeek.final = true` and a vault file from the partial week.
  2. The honest recorder then records Sunday's last hours. The rows now differ from the \"final\" board, so every run is refused until the next Monday.
  3. Events in between go void. The published vault file keeps points from an event that later went void.
- **Fix:** accept `final: true` or a vault file only when every day of last week, from its first published day on, is present and either done or void (port `coversWeek`).
- **Confirmation:** confirmed by re-implementation.
- **Proof** (verifier VA):
```
recorder said final: False
D2026-11-01 done: False
Last Node Standing files published.
publish exit: 0
2026-11-02T12:10Z honest: ::error::board.json: last week was final and has changed ... publish exit: 1
2026-11-03T12:10Z honest: ... publish exit: 1
2026-11-05T15:02Z honest: ... publish exit: 1
2026-11-08T23:57Z honest: ::error::board.json: last week was final and has changed ... publish exit: 1
```
- **Failing test:** "M-H-n3".

### N-4 — High: VHP moved in after each window's race card is never cut
- **Where:** `bot/games/lastnode.ts:run:547`, `lastnode-math.js:raceCut:217-229`, `lastnode.yml:check_hours:321-335`.
- **How the cards line up:** each hour is judged by the latest card taken by its end. On live race-data those cards are taken 6–47 minutes into the hour (median 22), and in 8 of 80 windows the card was more than 60 minutes old.
- **Mainnet today:** with no race-samples, cards are point-in-time balance reads. A producer that moves VHP in after each card and out before the next is never cut. Race runs are public, so it can leave only while a card is being taken.
- **The win rates:**
  - With 10–20% unseen extra blocks, win chance goes from about 11% to 81–99%. Watch-and-hold holds those weeks, so the vault file doesn't pay without your release, but the board and points are wrong.
  - With 6-hour-high cards, tripling the win chance needs about 12% more VHP every hour. A 3% tranche gives only about 1.3×.
- **Fix:** judge each window by VHP covering the whole window: the highest 5-minute sample inside it, or the first card taken after it ends. Don't launch on mainnet before race-samples runs.
- **Confirmation:** confirmed by re-implementation (live card timing, a simulation with `raceCut`).
- **Proof** (verifier VB):
```
cards 73 min-of-hour min/p25/median/p75/max [6.3, 17.4, 21.9, 27.2, 46.9]
windows 80 card age at window end p0/p50/p90/max [19.8, 39.6, 53.7, 94.8] over 60min: 8
```
```
e0:{winRate:0.109,heldWeeks:0.005}  e0.05:{0.457,0.48}  e0.1:{0.811,1}  e0.15:{0.964,1}  e0.2:{0.994,1}
```
- **Failing test:** `mr.test.mjs` "M-R-1".

### N-5 — High (needs one faulty RPC node): disputed or oversized samples set form to 0.80
- **Where:** `bot/games/lastnode.ts:samplesIn:184-188` reads only `at` and `vhp`; `sharesFromSamples:199-204`.
- **How a sample goes bad:** the `picks` branch's sampler keeps the lower read and writes `flagged` and `high`, but lastnode ignores both. Its own branch's older sampler keeps the higher read and writes no flags. There is also no cap at network supply.
- **Scenario:** one lying node reads every other producer as 0 for 2 of the 48 hours, or one sample per hour for 2 hours carries a huge value. The node's form becomes 0.80, a 99.6% win chance.
- **Fix:** skip flagged samples or producers, and cap each value at the network supply. Merge `picks`' sampler.
- **Confirmation:** confirmed by re-implementation. Inserting samples between real ones needs a tampered sampler run.
- **Proof** (verifier VB):
```
honest {"formX":1.006}
liar   {"formX":0.8}    (others read 0 in every sample of hours 10–11)
insert {"formX":0.8}    (ONE sample per hour in hours 10–11 with X = 99999999999999999999)
```
- **Failing test:** `m-f.test.mjs` "M-F-1".

### N-6 — High: watch-and-hold misses cheap gaming
- **Where:** `bot/games/lastnode.ts:watchWeek:354-376`. A node is flagged only when it signs at least max(5%, 3σ) above its multiplier-expected blocks, with 2 or more wins.
- **What gets through:**
  - Skipping 3% of blocks in the 48-hour form window wins 2.3–2.75× the fair share and is held in 10–14% of weeks.
  - Gaming one event a week wins about 90% of that event and is held in 16–20% of weeks.
  - Splitting the gain over two nodes stays under the flag (reviewer; not re-tested by the verifier).
- **Fix:** also compare blocks with the VHP share (expected blocks without `r`), and flag on a single event's z-score rather than only the week's mean.
- **Confirmation:** confirmed by re-implementation.
- **Proof** (verifier VB):
```
r0.97:      winRate 0.300 / 0.256   heldWeeks 0.14 / 0.10
oneEvent08: winRate 0.226 / 0.224   heldWeeks 0.197 / 0.163   (about 0.92 per gamed event)
```
- **Failing test:** `M-W` tests "M-W-n3".

### N-7 — Medium: a late race card blocks every publish for good
- **Where:** `lastnode.yml:check_hours:328-334` and `394-406`; `lastnode.ts:run:492, 633-636`.
- **Scenario:** published hours are re-checked against race-data as it is now, on every run, and they can't change. If a card reaches race-data after the record job read it, and is dated 30 minutes or more before an hour's end, that published hour becomes \"not the card to use\". Every later run is then refused, even after the day is void.
- **Correction from the verifier:** a failed race-data read on the publish side refuses only that one run.
- **Fix:** check an hour's card only when the hour is first published.
- **Confirmation:** confirmed by re-implementation. How often cards land late needs live push timings.
- **Proof** (verifier VA):
```
::error::D2026-11-01.json: hour 4's race card isn't the one to use
publish exit: 1
2026-11-01T20:05Z honest: ::error::D2026-11-01.json: hour 4's race card isn't the one to use ... publish exit: 1
2026-11-02T12:05Z honest: ... publish exit: 1
2026-11-04T12:05Z honest: ... publish exit: 1
```

### N-8 — Medium (needs a planted field): Python and JavaScript disagree on one rounding value and on large ties
- **Where:** `histcheck` replay vs `lastnode-math.js`. When `h × 10000 = 0.49999999999999994`, `Math.round` gives 0 but `floor(x + 0.5)` gives 1. With `vhp ≥ 2^53`, ties break differently.
- **Scenario:** a planted field with either value refuses every honest run. JavaScript sees that event as finished, so it is never voided. Other planted numbers that don't survive a JavaScript round trip stall publishing the same way.
- **Fix:** use the same rounding as JavaScript, and refuse values above 2^53−1 and integer-valued floats (the Block X `js_safe` rule).
- **Confirmation:** confirmed by re-implementation.
- **Proof** (verifier VA):
```
h = 0.000049999999999999996  h*1e4 = 0.49999999999999994  JS hInt (Math.round) = 0
h-case  JS cut: 1A        h-case  Py cut: 1B  Py h_int: 1
vhp-case JS cut: 1B       vhp-case Py cut: 1A
```

### N-9 — Medium (needs one bad record run): the hold isn't enforced by the publish job
- **Where:** `lastnode.yml` publish `439, 488-511`; `lastnode.ts:run:619-627`.
- **Scenario:** the publish job never re-checks the hold, and ignores a hold file already on the branch. A run that drops `HOLD-W<w>.json` and uploads `W<w>.json` publishes a held week with exit 0. Because the job never deletes files, a hold file can stay next to the released vault file for good. Whether the vault bot honours hold files isn't in this repo.
- **Fix:** refuse a vault file while `HOLD-W<w>.json` is on the published branch, unless the week is in `LASTNODE_RELEASE_WEEKS`. Port `watchWeek` into the publish job.
- **Confirmation:** confirmed by re-implementation.

### N-10 — Medium: honest weeks are held often, and every week at launch
- **Where:** `watchWeek:371-373`, `formFor:466-473`, `run:615-628`.
- **How often an honest week is held:**
  - 28% with a 5% daily spread (0.7% with pure noise);
  - every week, 300 of 300 simulated, with the mainnet launch state of no samples and so no form. The steady over-signer then wins 84% of events.

  The reviewer's replay of real blocks held 12 of 16 weeks; the verifier didn't replay that.
- **What it costs:** each hold needs your manual release within the vault's 3-day window, and every run fails while it waits. Release becomes routine, which hides real gaming (N-4, N-6).
- **Fix:** don't launch until race-samples has run for at least 48 hours, or fall back to hourly-card shares on mainnet as testnet does. Then measure the real daily spread and set the threshold from it.
- **Confirmation:** confirmed by re-implementation, for the assumed spread. The live spread needs measuring.
- **Proof** (verifier VB):
```
sd0: heldWeeks 0.007   sd0.03: 0.047   sd0.05: 0.28
noForm: heldWeeks 1 (300/300, two seeds)   allOne_noForm: 0.007
15NZhQ@1.08 winRate 0.842 heldByA 1 ; 1GGxRh@1.04 0.135 ; all ≤0.97 nodes ≈0
```

### N-11 — Medium: a read hiccup sets a field without form at once
- **Where:** `lastnode.yml:78-88`; `lastnode.ts:formFor:466-473`, `run:509-512`.
- **Scenario:** a network error in `git ls-remote` looks the same as \"no race-samples branch yet\". A failed history fetch falls back to 8 hours of samples. Either way the field is set without form immediately, for good, and with no warning. That skips the LNF-16 wait.
- **Fix:** treat \"can't read\" as an error, and wait. Only use \"no branch\" when `ls-remote` exits 2.
- **Confirmation:** confirmed by re-implementation (reviewer).

### N-12 — Medium: the 4-minute form deadline doesn't stop the slow read
- **Where:** `lastnode.ts:formFor:452-458`, `hourlyReader:261-278`, `main:736`; `lastnode.yml:32`.
- **Scenario:** `Promise.race` frees `run()`, but the losing reads keep running and keep the process alive. A slow node can still run the job into its 15-minute timeout, and nothing is uploaded.
- **Fix:** abort the reads (pass a signal), and call `process.exit` after writing.
- **Confirmation:** confirmed by source and language semantics check (reviewer).

### Low

| ID | Finding | Where | Fix |
| --- | --- | --- | --- |
| L-1 | A field without `vt` turns the race-card check off for all its hours (`vt` is optional in `field_ok`) | `lastnode.yml:141, 324` | Require `vt` |
| L-2 | The card rule lets a bad run choose between allowed cards (any card from the newest one at end − 30 min up to the end), so it can pick the one that lowers a rival more | `lastnode.yml:328-334` vs `lastnode.ts:547` | Require the latest card by the window's end |
| L-3 | The page's live windows use the current leg's card, not the recorder's per-window card; they differed in 22 of 27 live windows | `lastnode.js:liveHours:89`, `raceCardNow:134-139` | Use the recorder's rule |
| L-4 | `lastWeek` is uncapped; `board.json` passes 2 MB at about 12,900 players in one week | `lastnode.ts:592` | Cap it, or put it in its own file |
| L-5 | The registration check skips `lead` and `ahead`, and the recorder counts picks at any pick time | `lastnode.ts:checkRegistration:287-289`, `readPicks:304-305` | Check both |
| L-6 | The \"unfiled\" error fires in the same run that publishes the vault file, if it arrives in the last hour | `histcheck:453`; `lastnode.yml:521` | Read the incoming state |
| L-7 | Any `histcheck` error refuses the whole run, and the first `exit 1` hides the others | `lastnode.yml:481, 520-524` | Hold one file; print every error |
| L-8 | The hold file can be rewritten by any run and is never compared with the day files; every run fails for about 60 h while a week is held | `lastnode.yml:488-493, 523` | Check it against `watchWeek` |
| L-9 | The hourly average is time-weighted only if sample times are uniform; swaps tuned to the sampler's phase could skew form (unconfirmed) | `sharesFromSamples:199` | Weight by time between samples |
| L-10 | The publish side's card list lacks the LNF-18 row filter, and JavaScript accepts `at` types Python doesn't | `lastnode.yml:311-320` | The same filter, typed |
| L-11 | `lastnode` sits on an old `picks`: the race-samples writer it carries keeps the higher read and writes no flags | branch base `81acd5f` | Merge `picks` |
| L-12 | Wording: \"luck on the day\" (`lastnode-math.js:15`, `lastnode.html`) contradicts the accepted hot hand; the form note describes hourly race cards, not the 5-minute samples | as listed | Reword |

### Info

| ID | Finding | Where |
| --- | --- | --- |
| I-1 | Samples with the same `at` across snapshot files: the first file read wins | `samplesIn:186` |
| I-2 | A producer missing from a sample counts as 0, which slightly raises an honest node's form after an outage | `sharesFromSamples:201` |
| I-3 | Python `==` hides type differences (`"at": true` passes); harmless today, since the recorder recomputes cuts | `shape:178`, `histcheck:410` |
| I-4 | A vault file over 2 MB (about 40,000 rows) is left out silently | `lastnode.yml:129-131` |
| I-5 | Page leftovers: a read started before sleep can be reused; a device clock more than 1 h off shows \"Checking the time…\" forever; two labels have no day | `lastnode.js:39-44, 143, 590` |
| I-6 | The LNF-29 guard almost never trips | `lastnode.js:486, 534` |
| I-7 | `LASTNODE_RELEASE_WEEKS` parses loosely: unset or `\"3,,7\"` releases week 0, and `\"0x3\"` releases week 3 | `lastnode.ts:run:622` |
| I-8 | Honest drift: 33% of node-windows are lowered by up to 2.92% by `raceCut`, never raised. A node that over-signs during the race is cut too | `raceCut:217-229` |
| I-9 | A `FAKE_RACE` test hook sits in the production publish step | `lastnode.yml:462` |

## 4. Checked and sound

- **The Python ports** of `cutsFrom` (with `hh`), `playerResult`, the board's `view` and `vaultScores` match the JavaScript on 18,738 random and 3,360 real-shaped cases. The only mismatches come from N-8.
- **Rewriting published history is blocked:** fields, picks, hours so far, void and finished results, and a final week. The push loop only adds files.
- **The swap attack (LNF-4) is closed.** The 6-hour snapshots against 8-hour sample files leave no gaps (643 of 643 samples read across an outage), and the testnet fallback to hourly cards can't reach mainnet.
- **The race-time check never raises a multiplier.** Lowering VHP before the field card and then restoring it gains nothing (8.3% against 11.5% honest). The card rule handles recorder outages, an hour with no new card, a card exactly at the boundary, and cron delays of about 20 minutes (apart from N-7).
- **Recorder:** block reads advance by what came back; `nodeKey` normalises aliases; race cards are shape-checked; board lists are capped at 2,000 rows.
- **The page:** a bad node refuses the whole file; the clock is re-read after sleep, and there is no sending before the first reading; the locked pick shows before the start; signing is one Picks `pick` for game 13; there are no XSS sinks.
- **Shell:** under `set -euo pipefail`, the `vault-status.txt` states, the HOLD loop and the final errors behave as written (apart from L-6 and L-7).

## 5. Not checked

- The vault bot that posts vault files (whether it honours hold files, and whether the Vault contract pays an unstaked listed wallet).
- Live race-data push lag (N-7) and live node day-to-day spread (N-10).
- Which race recorder version writes the live race-data.
- Splitting gaming over two nodes (N-6; reviewer only).
- LNF-20, LNF-21, LNF-24, LNF-27, LNF-28 and LNF-31, which weren't in this fix round or are wording only.
- The repository's own tests; none were run.

---

## Appendix: next steps for the owner

**PowerShell** (adds this report and the failing tests to the repo):
```
cd C:\kprediction
git checkout lastnode
git pull
Copy-Item "$HOME\Downloads\FIXCHECK-LASTNODE-2.md" .
Expand-Archive "$HOME\Downloads\lastnode-fixcheck2-failing-tests.zip" -DestinationPath "$env:TEMP\ln2" -Force
Copy-Item "$env:TEMP\ln2\tests\audit\*" tests\audit\
git status
```

**Prompt to paste into Claude Code:**
> Read `FIXCHECK-LASTNODE-2.md` and the failing tests in `tests/audit/repolens-lastnode2-*.test.mjs`. The temp folder's `paste-in/` holds blocks that go into `lastnode-form.test.mjs` and `lastnode-vault.test.mjs`.
>
> On branch `lastnode`, fix N-1 to N-12 in severity order, starting with N-2 (keep `vt` and `card: null` in `loadDay`, and add a publish-twice test) and N-3 (port `coversWeek` into `histcheck`). Use the fixes the report gives.
>
> Rules:
> - Make each failing test pass without weakening it.
> - Finish the five skeleton tests listed in the zip's README.
> - Keep all existing tests passing (`npm run test:audit`).
> - Don't touch `picks/assembly/Picks.ts`.
> - Send nothing to any chain and use no keys.
> - Ask me before any push.
# Last Node Standing: fix-check round 2, what was fixed

Branch `lastnode`. The round-2 report (`FIXCHECK-LASTNODE-2.md`, at `7c301a8`) gave a "fix first" verdict: 1 Critical, 5 High, 6 Medium, 12 Low and 9 Info. Its failing tests are in `tests/audit/repolens-lastnode2-*.test.mjs`. The paste-in blocks went into `lastnode-form.test.mjs` (M-R-1) and `lastnode-vault.test.mjs` (M-R-2).

**Tests:** `npm run test:audit` gives 718 tests: 708 pass, 0 fail, 5 skipped and 5 TODOs (all other games' owner decisions; none are Last Node's). The Last Node tests alone: 109 pass, 0 fail.

## First: the current `picks` merged in (L-11)
- `origin/picks` (`d3203f1`) is merged into `lastnode`. That brings in BX-86 sample disputes, `js_safe` and the Picks mainnet upload.
- There was one conflict, in `games.yml`. I took the `picks` version: its publish step now checks against the published tip. Last Node's own push loop is unchanged.

## Findings

| ID | Status | What changed |
|---|---|---|
| **N-1** Critical | Fixed (with documented limits) | The publish job now checks what a run **adds** itself, with a stdlib-Python client on `RPC` and `RPC_CHECK`. **New hours:** the boundary blocks and every field node's count must agree on both nodes. **New hour-0 picks:** must equal Picks `list_picks` for the round on both nodes. **New field:** must come from the event's race card (VHP, expected blocks, node set, every `h` from the formula at its `c`). **Vault file:** published only in a run *after* the final board is on games-data, and only if that run doesn't change last week's files. Anything it can't read refuses the run. **Still trusted to the record job:** `c`'s calibration, each node's form `r`, and the staked-wallet list (the v6 ABI isn't in this repo). The README "Trust model" says so. |
| **N-2** High | Fixed | `loadDay` carries the published field through exactly (`vt`, `form` and all) and keeps `card: null`. New end-to-end test: real recorder → real publish job, six times, through field, picks and 10 hours, all checked on the fake chain. |
| **N-3** High | Fixed | `coversWeek` is ported. `final: true`, or a vault file, is refused unless every event of last week from the game's first day is done or void, and it is 12 hours after the week ended. |
| **N-4** High | Fixed | Each window is judged by the **first race card taken at or after its end**. The hour waits for it; after 2 hours with no such card, the latest card by the end is used. The recorder, publish job and page use the same rule. Hours are now recorded about half an hour after they end. Mainnet launch waits for race-samples (N-10 gate). |
| **N-5** High | Fixed | Disputed samples (`flagged` / `high`) are left out. So are samples whose total VHP is more than 2% off the hour's median (catches a node reading others as 0, or an inserted huge value). An hour needs 6 good samples. |
| **N-6** High | Partly fixed (owner decision) | New rule: blocks in **every** window, also after a cut. The old count (only while standing) favoured long survivors, so honest winners looked like gamers. Noise is measured from the other nodes that week. A node is flagged at weekly z ≥ 3.4 with at least 2 wins, or z ≥ 5 in one event it won. Results on the reviewer's simulator are in the table below. |
| **N-7** Medium | Fixed | An hour's card is checked only when the hour is first published. |
| **N-8** Medium | Fixed | `js_round` is Math.round exactly. Numbers must be JS-safe (≤ 2^53 − 1, no whole-number floats). Every node needs `hInt` ≥ 1. A parity fuzz checks `js_round`, `watch_week` (500 weeks) and the field check (60 random cards) against the JavaScript. |
| **N-9** Medium | Fixed | The publish job runs `watch_week` itself. A flagged week, or one already held on games-data, isn't filed unless released. A hold file must list exactly the flagged nodes. One run can't publish both a hold file and a vault file. |
| **N-10** Medium | Fixed (launch gate) | On mainnet a field is never set without form unless `LASTNODE_ALLOW_NO_FORM=true`. Otherwise the event is void at its lock. The new hold rule holds honest no-form weeks 1.0% of the time (was 100%). |
| **N-11** Medium | Fixed | A race-samples read that fails stops the record step (only `ls-remote` exit 2 means "no branch"). Too few samples now means the field waits. |
| **N-12** Medium | Fixed | Form reads take an `AbortSignal` and stop at the deadline. The entry point exits once the files are written (`finish`). |
| L-1 | Fixed | `vt` is required (shape check, and the new-field check). |
| L-2 | Fixed | The card is exact (first one after the window), so a run has no choice. |
| L-3 | Fixed | The page's live windows use the recorder's card rule. |
| L-4 | Fixed | `lastWeek` is capped at 2,000 rows. The vault file uses the whole list; the publish job compares the top 2,000. |
| L-5 | Fixed | The registration check also covers `lead` and `ahead`. Picks at or after the lock are dropped, in both the recorder and the publish job. |
| L-6 | Fixed | "Unfiled" isn't raised when this run files the vault file. |
| L-7 | Partly fixed | All failures are printed and the run fails once, at the end. A `histcheck` error still refuses the whole run (that's what keeps history safe). |
| L-8 | Fixed | A hold file is checked against `watch_week`. The run fails once, when the hold is first published; after that it only warns. |
| L-9 | Not changed | Samples are on a steady 5-minute timer; time-weighting is left for later. |
| L-10 | Fixed | The publish side's card list uses the recorder's row filter and integer times. |
| L-11 | Fixed | `picks` merged (above). |
| L-12 | Fixed | The wording now says form comes from 5-minute readings, and a node can run hot or cold for a few days. |
| I-1, I-2 | Partly fixed | Snapshot files are read in sorted order. A sample missing a big producer fails the total check. |
| I-7 | Fixed | `LASTNODE_RELEASE_WEEKS` must be digits and commas, or nothing is released (with a warning). |
| I-9 | Fixed | `FAKE_RACE` works only with `KG_TEST_NOW`. |
| I-3 to I-6, I-8 | Not changed | Info only. |

### The hold rule on the reviewer's simulator

| Case | Old rule | New rule | Reviewer's target |
|---|---|---|---|
| Honest week, 5% daily spread | 28% held | 1.5% held | ≤ 2% |
| Honest week, no form | 100% held | 1.0% held | ≤ 2% |
| One gamed event (form 0.8) | 16–20% caught | 98% caught | — |
| Node 3% under its form, all week | 10–14% caught | 13% caught | ≥ 50% (not met) |

**Why the last row can't be met:** over one week, a steady 3% edge averages only z ≈ 2.4. Holding at most 2% of honest weeks across 10 nodes needs a cut-off near z ≈ 3. The two targets conflict, so the owner chose between the targets (below).

**Options:**
- (a) Accept it as is.
- (b) Add a 4-week rolling check (z ≈ 4.8 over 4 weeks catches it, but only from the gamer's 3rd or 4th week).
- (c) Shorten the form window or weigh recent hours more.

**Owner's decision (30 Oct):** (a), keep the rule as it is. The reviewer's 50% test now pins the accepted behaviour instead (the skimmer caught in 8–25% of weeks, about 13%), and a new test checks that a single gamed event is caught in at least 9 weeks out of 10.

## Finished skeleton tests

| Test | Finding | What it checks |
|---|---|---|
| `M-H-n6` | N-9 | Publish-side hold. |
| `M-F-2b` | N-11 | Too few samples: the field waits. |
| `M-F-3` | N-10 | Launch gate: void at the lock, or field at once with the override. |
| `M-F-4` | N-12 | Process exit after the deadline. |
| `M-W-n2` | N-9 | Three publish tests: held on games-data, both files in one run, and the rule recomputed. |

**Tests I adjusted, with the reason:**
- **`M-H-n1`:** passes `allowNoForm` (it has no samples).
- **`M-H-n4`:** uses the N-4 card rule (a card after the hour, then a later-arriving one).
- **`M-F-2`:** runs the whole samples block, plus the honest "no branch" case. The 13-line cut-off passed on a bash syntax error.

## For the owner before mainnet
- **Launch gate:** race-samples must have run for at least 48 hours (form needs 24 of the 48 hours), or you set `LASTNODE_ALLOW_NO_FORM=true`.
- **New variables:** `LASTNODE_PICKS` (defaults to the mainnet Picks contract `1LmgqBGctL9F2YkyjTXgieTXwnYHh8Y6Pm`) and `LASTNODE_ALLOW_NO_FORM`. The publish job also reads `RPC`, `RPC_CHECK` and `LASTNODE_RELEASE_WEEKS`.
- **The VHP sampler isn't running yet.** `race-samples.yml` is on the `picks` branch, and GitHub runs scheduled jobs only from `main`. It starts by itself (with `RACE_ENABLED=true`, which the race already uses) once `picks` is merged into `main`. Last Node can launch with form 48 hours after that.
- **Where the tests run:** the suite is built for Linux (GitHub Actions and the reviewer). The Last Node tests also run on Windows: they import files by URL, find Python as `python3`, `python` or `py`, and skip the publish job's bash steps with a reason. Other games' tests still need Linux. GitHub's "Resolver tests" workflow runs the whole suite on every push to `lastnode`.
- **Not tested against the real chain:** the publish job's chain client (the sandbox has no mainnet access). The JSON-RPC calls are the ones the recorder makes through koilib. A first real run should be watched.

# Fix-check prompt, round 7 (very short): Block X prize-free go / no-go

Copy everything below the line into Repo Lens. Give it the package `knode-fixcheck-8.zip` (the repository
`bawcejawn/Knode` at the commit in `00-COMMIT.txt`, branch `picks`, with this prompt as `00-FIXCHECK-PROMPT.md`).

---

You are an independent security auditor. Your report "Block X + Sponsor v3: Round-6 Fix-Check (Knode picks @
b0abc79)" said:
- **GO** for the sponsor v3 and Picks uploads;
- **NO-GO for Block X live prize-free** until BX-95 and BX-96 are fixed.

They are fixed. The owner's record is the "Round 6" section of `docs/history/AUDIT-2026-10-28-repolens-blockx.md`.
Your round-6 failing tests are in the repository and pass, except G-K-1 (see 3 below). An independent blind review
of the fixes ran before this package, and its findings are fixed (same section).

**Scope: `git diff b0abc79 HEAD` only.** The question is one verdict: **Block X live prize-free: go / no-go.** Report
must-fix items for that verdict only. Put everything else in one Low/Info table, marked "before prizes" where it
belongs there. Check the code, not the comments. Send no transaction to mainnet.

```
npm ci --ignore-scripts
npm run test:audit:serial
```

The contracts are unchanged: sponsor v3 `b61ac238…6e4`, Picks `700c296a…c594`.

## What changed since b0abc79

1. **BX-95.** Every integer in both publish checks is at most 2^53 − 1, the recorder's JavaScript limit.
2. **BX-96 / BX-111.**
   - The Block X and race-data week lists are append-only.
   - A new week may be only the current one or the one just ended.
3. **BX-97 moved to "before prizes" (your class (c)).** The blind review found two problems with the first fix, which
   tied a new round's time to its published neighbours:
   - one bad run could push the newest real round's time up to the job's clock, and every honest run after it was
     then held for about 3 days;
   - an honest void row's estimated time could also be held.

   So that rule is gone. The publish job still refuses new rounds that:
   - aren't at their target height;
   - fall outside their week;
   - lie after the job's clock;
   - belong to any week other than the current one or the one just ended;
   - belong to a week whose P file is published (BX-98).

   A future round given a past time is left to the week-end re-read before prizes. G-K-1 is kept as a `todo`.
4. **BX-98.** No new rounds for a week whose P file is published, or for an older week.
5. **BX-99.**
   - The card takes the lower read of every disagreement.
   - It is rebuilt with each disputed producer at its higher read. `topInDoubt` is set when the top, or any
     undisputed producer's value, differs by more than 0.5%. That tolerance came from the blind review: an exact
     compare held whole cards over tiny honest disputes.
6. **BX-100.** A non-canonical transfer voids the target at once only when both nodes report it. Otherwise the target
   is held, and voided at the 3-day edge.
7. **BX-101, BX-102, BX-106, BX-94.** Also fixed, plus `type is int` for `checked` and the picks' `ranked` field.
8. **Sponsor tool.**
   - SP-53: the emergency stop fits v2's caps on v2 code, on both paths.
   - SP-55, SP-56 are fixed; SP-54 is fixed in the runbook (0.2 Mana checked against a sponsored testnet pick, 0.116).
   - The mainnet build list is now [v3, v2] (launch step 2).

## Look hardest at

1. Can one bad record run still **stall honest publishing**, or **lose published history**? These are your class (b).
2. Can an **honest** run, or an honest lagging node, now be held, or have whole cards voided, too easily?
3. Any new problem from this round's fixes.

## Report

- Each round-6 ID: fixed / partly / not fixed, with file:line.
- Anything new.
- **The verdict: Block X live prize-free: go / no-go**, and what (if anything) must be fixed first.
- The "before prizes" list as it stands.

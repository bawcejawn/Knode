# Fix-check prompt, round 10 (very short): Block X prize-free go / no-go

Copy everything below the line into Repo Lens. Give it the package `knode-fixcheck-11.zip` (the repository
`bawcejawn/Knode` at the commit in `00-COMMIT.txt`, branch `picks`, with this prompt as `00-FIXCHECK-PROMPT.md`).

---

You are an independent security auditor. Your report "Block X Prize-Free: Round-9 Go/No-Go (Knode picks @ 6990323)"
said **NO-GO, one fix in one file, then GO**. It named BX-128: Python's `\d` accepted non-ASCII digits that
`loadSamples` drops.

**Fixed, for every regex in the family:**
- Every `\d` in the Python of the four publish steps (`games.yml`, `games-testnet.yml`, `race.yml`,
  `race-samples.yml`) is now `[0-9]`. That covers the two sample regexes (BX-128) and the iso, ymd and race-id ones
  (BX-130).
- A guard test fails if `\d` ever comes back there.
- The four publish jobs pin Node 22 with `setup-node` (BX-131).
- BX-129 is a runbook step: the page is published only after step 8's `status` shows 1 change per pick.

Your round-9 test (`tests/audit/repolens-r9-sample-digits.test.mjs`) is in the repository and passes. The owner's
record is the "Round 9" section of `docs/history/AUDIT-2026-10-28-repolens-blockx.md`.

**Scope: `git diff 6990323 HEAD` only.** That includes the two commits you flagged in BX-133: the game 2 announcement
record, and the testnet-only `TESTNET_PICKS` / `TESTNET_PICKS_CARDS` option in `bot/sponsor.ts`. Send no transaction
to mainnet.

```
npm ci --ignore-scripts
npm run test:audit:serial
```

## The one question

**Block X live prize-free: go / no-go.** If no-go, name only what must be fixed for that verdict. Put everything else
in one Low/Info table, marked "before prizes" where it belongs.

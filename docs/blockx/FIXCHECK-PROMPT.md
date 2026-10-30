# Fix-check prompt, round 9 (very short): Block X prize-free go / no-go

Copy everything below the line into Repo Lens. Give it the package `knode-fixcheck-10.zip` (the repository
`bawcejawn/Knode` at the commit in `00-COMMIT.txt`, branch `picks`, with this prompt as `00-FIXCHECK-PROMPT.md`).

---

You are an independent security auditor. Your report "Block X Prize-Free: Round-8 Go/No-Go (Knode picks @ 572d86c)"
said **NO-GO, one line, three files, then GO**: BX-122, integer-valued floats (`5.0`, `-0.0`, `1e2`) passing `js_safe`.

**It is fixed for the whole class, not only that shape.** Every publish step (`games.yml`, `games-testnet.yml`,
`race.yml`, `race-samples.yml`) now runs one inline `node -e` check, after the symlink and file-type refusals. Each
incoming `.json` file must be a regular file whose **raw bytes equal `JSON.stringify(JSON.parse(text)) + "\n"`**,
exactly what the recorders write. A published file is then a fixed point of the recorder's own reader and writer.
`js_safe` also refuses integer-valued floats, as you suggested. The owner's record is the "Round 8" section of
`docs/history/AUDIT-2026-10-28-repolens-blockx.md`.

An independent blind review checked the fix and found one more case of the same family, now closed: samples up to
10 min ahead were accepted, but `loadSamples` drops anything more than 60 s ahead. Both bounds are now 60 s.

Your round-8 failing test is in the repository and passes. `tests/audit/repolens-r8-canonical.test.mjs` runs the exact
node line from each workflow against honest and crafted files. Your BX-123 / BX-127 notes are runbook steps. Scope:
**`git diff 572d86c HEAD` only.** Send no transaction to mainnet.

```
npm ci --ignore-scripts
npm run test:audit:serial
```

## The one question

**Block X live prize-free: go / no-go.** If no-go, name only what must be fixed for that verdict. Put everything else
in one Low/Info table, marked "before prizes" where it belongs.

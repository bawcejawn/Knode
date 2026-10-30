# Fix-check prompt, round 8 (very short): Block X prize-free go / no-go

Copy everything below the line into Repo Lens. Give it the package `knode-fixcheck-9.zip` (the repository
`bawcejawn/Knode` at the commit in `00-COMMIT.txt`, branch `picks`, with this prompt as `00-FIXCHECK-PROMPT.md`).

---

You are an independent security auditor. Your report "Block X Prize-Free: Round-7 Go/No-Go (Knode picks @ 1022aed)"
said **NO-GO, two one-line fixes away**: BX-112 (an address given as a JSON number) and BX-113 (race-card numbers
above 2^53). Both are fixed. The owner's record is the "Round 7" section of
`docs/history/AUDIT-2026-10-28-repolens-blockx.md`. Your round-7 failing tests are in the repository and pass.

**Scope: `git diff 1022aed HEAD` only. The one question: Block X live prize-free: go / no-go.** List must-fix items for
that verdict only. Put everything else in one Low/Info table, marked "before prizes" where it belongs. Check the code,
not the comments. Send no transaction to mainnet.

```
npm ci --ignore-scripts
npm run test:audit:serial
```

**Since your report (2026-10-30):** sponsor v3 `b61ac238…` and Picks `700c296a…` (at `1LmgqBGctL9F2YkyjTXgieTXwnYHh8Y6Pm`)
are uploaded and checked on mainnet. The sponsor's settings are sent (caps 1 / 25 / 150 / 5,000, free 2,000, the Picks
row at 0.2 Mana, vault switch off). Game 2 is not registered yet, and no Block X page is published.

## What changed since 1022aed

1. **The root cause of BX-95, BX-112 and BX-113, closed as a class.** The recorders are JavaScript (`===`, doubles);
   the checks were Python (`==`, big integers). Now, in `games.yml`, `games-testnet.yml` and `race.yml`:
   - **`js_safe`**: every value of every incoming file must be one JavaScript reads back exactly. That means integers
     and numbers within ±(2^53 − 1), finite, at most 64 levels deep, and string keys.
   - **`isaddr`**: every address is a JSON string matching the pattern.
   - **Type-strict file headers**: `v` must be the integer 1, and `week` and `game` are integers. The owner's blind
     review found that `"v": true` or `"week": 3.5` passed Python but made `loadWeek` treat the published week file as
     missing, so every honest run after it was held.
   - **`same()`**: published content is compared type-strictly (P against the published board, published targets,
     race cards, samples).
   - **Race order pinned**: race i of a week file must be the week's race i (id, start, end), each id once (race.ts
     finds races by id).
2. **BX-114.** The check node's head is read right after the primary's.
3. **BX-119.** A new race-data week may only be last, this or next week.
4. **BX-121.** Covered by `js_safe`.
5. **Picks tool.** On mainnet the upload uses the mainnet Mana estimate. The first try's testnet-sized limit (17) was
   refused "insufficient rc", and nothing was charged.
6. **Website file.** `game-data/deployment.json` now covers Picks, with `rcLimits` of 0.2 for a pick; it is merged to
   `main`.

## Look hardest at

1. Is the "one bad run publishes a value Python accepts and JavaScript reads differently" class closed? That includes
   field types the recorders compare with `===`.
2. Can an **honest** run now be refused by the new checks (week boundaries, next week's race card, testnet)?
3. Any new problem from this round's changes.

## Report

- Each round-7 ID: fixed / partly / not fixed, with file:line.
- Anything new.
- **The verdict: Block X live prize-free: go / no-go**, and what (if anything) must be fixed first.
- The "before prizes" list as it stands.

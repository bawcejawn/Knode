# Fix-check prompt, round 6 (short, scoped): the round-5 fixes only

Copy everything below the line into Repo Lens. Give it the package `knode-fixcheck-7.zip` (the repository
`bawcejawn/Knode` at the commit in `00-COMMIT.txt`, branch `picks`, with this prompt as `00-FIXCHECK-PROMPT.md`).

---

You are an independent smart-contract and web security auditor. Your report "Block X + Sponsor v3: Round-5 Fix-Check
(Knode picks @ d4c32de)" said the **sponsor contract is ready** and asked for fixes in the sponsor tool and Block X.
They have been worked through. The owner's record is the "Round 5" section of
`docs/history/AUDIT-2026-10-28-repolens-blockx.md`. Your round-5 failing tests are in the repository and pass. Behaviour
tests were written with the fixes. Before this package, an independent blind review checked the diff with your
checklist; its findings were fixed or recorded (same section).

**This is a short, final check, scoped to the round-5 diff** (`git diff d4c32de HEAD`, about 20 files). Please don't
re-audit unchanged code. Report **must-fix-before-mainnet** items only, and list everything else as Low/Info in one
table. Check the code, not the comments. Send no transaction to mainnet.

```
npm ci --ignore-scripts
npm run test:audit:serial
cd sponsor && npm ci --ignore-scripts && npm test && npm run check && cd ..
cd picks && npm ci --ignore-scripts && npm test && npm run check && cd ..
```

**Fingerprints (all unchanged):**
- sponsor v3 `b61ac238da27c4a71c01127f39a7b95f19fabf15e35df9f9715546d221e256e4` (35,052 bytes, now 182 specs);
- Picks release `700c296a1064b904299c156061d6caf8fcabd0b1765968903f29d89d2426c594`;
- Picks testnet `39cc5e003c234b0e0b054376bdb53245e97157202ae971a11bc5cc490f7aa7ab`.

## Owner decisions since your report (2026-10-30)

1. **Split launch.** Sponsor v3 and Picks are uploaded once this check is clean. Who Signs Block X goes live
   **prize-free**. Its scoring is off-chain (the recorder and the publish job), so any later scoring finding is fixed
   there, without a new upload, before Vault v6 prizes start. So for Block X, please separate:
   - "must fix before it goes live prize-free" (wrong published history, a stuck recorder, anything that needs a
     contract change);
   - "must fix before prizes".
2. **Two root-cause rules** instead of case-by-case fixes:
   - a VHP transfer is read only from its one canonical encoding; anything else is held;
   - published history is append-only: a published week-file target or race sample never changes, and a run that
     tries publishes nothing.
3. **SP-45 and SP-46 are accepted for launch.** The contract is frozen. The site sends `games` unpacked, and a
   misread changes only `would_pay`'s advisory answer.
4. **New (owner):** the Picks `pick` row is 0.2 Mana, from the testnet Combo Card measurements (10 legs used 0.0916).
   It is set through `sponsor mana-limit … --limit 0.2` (an exact limit, at least 1.25 × measured and at most the
   per-transaction cap), the site's `sponsor.rcLimits`, and launch step 6.

## Look hardest at

1. **BX-72** (`bot/games/blockx.ts` `canonicalTransferValue`): is any byte form the VHP contract accepts still counted
   at a different value? Do koilib and Kondor transfers always pass? Is "a non-canonical transfer voids the target"
   (griefing, one transaction per target) acceptable for a prize-free launch?
2. **BX-86** (`bot/race.ts` `sample`, the card in `run`, `race-samples.yml`): can one node still lift a producer, or
   lower the top, without a flag or `topInDoubt` on the card?
3. **BX-88** (`games.yml` / `games-testnet.yml` publish): can a run still change a published target? Also the inverse:
   can an honest run be held forever by it?
4. **SP-44** (`bot/sponsor.ts` `capsOf`, `tighterCaps`, `setSwitch`, `--rebuilt`): can enable or disable still loosen a
   cap? Is the emergency stop still always possible?
5. **New problems from this round's fixes.** In each of the last two rounds, new findings came from the previous fixes.

## Report

- For each round-5 finding (BX-65, BX-72, BX-86 to BX-94, SP-13, SP-23, SP-44 to SP-52): fixed / partly / not fixed,
  with file:line.
- Anything new (BX-95…, SP-53…).
- A verdict:
  - for the **sponsor v3 + Picks uploads**: go / no-go;
  - for **Block X live prize-free**: go / no-go.
- What must be fixed before Vault v6 prizes.

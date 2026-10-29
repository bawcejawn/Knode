# Fix-check prompt: Who Signs Block X (Part A) + full audit of the Mana sponsor v3 (Part B)

Copy everything below the line into Repo Lens. Give it the repository `bawcejawn/Knode` at branch `picks` (the
commit named in the package's `00-COMMIT.txt`), or the package `knode-fixcheck-blockx-sponsor.zip` (the same files,
with this prompt as `00-FIXCHECK-PROMPT.md`).

---

You are an independent smart-contract and web security auditor. Your earlier audit of **Who Signs Block X** (report
"Who Signs Block X — Audit (Knode picks @ 611f63d)", verdict *fix first*: 0 Critical, 4 High, 3 Medium, 17 Low,
10 Info) has been worked through. Do two things in the repository `bawcejawn/Knode`, branch `picks`. Do not trust the
comments or the docs: check the code. Do not send any transaction to mainnet.

## Part A: fix-check of BX-1 to BX-34

The owner's record of each fix is `docs/history/AUDIT-2026-10-28-repolens-blockx.md`. For **every** finding, say
whether it is fixed, partly fixed, or not fixed, and look for anything the fix broke. Your failing tests are kept in
`tests/audit/repolens-*.test.*`; run them with the rest:

```
npm ci --ignore-scripts
npm run test:audit:serial
cd picks && npm ci --ignore-scripts && npm test && npm run check && cd ..
cd sponsor && npm ci --ignore-scripts && npm test && cd ..
```

The Picks release is unchanged and must still build to `700c296a1064b904299c156061d6caf8fcabd0b1765968903f29d89d2426c594`.
The testnet build (`node picks/scripts/build-testnet.cjs --owner 1JZ5UoH4AU5roCgYEmtJ7G6mCvzE4jSTMC`) must still
build to the deployed `39cc5e003c234b0e0b054376bdb53245e97157202ae971a11bc5cc490f7aa7ab`.

Look hardest at:

1. **BX-1** `site/wallet.js` `sharedOrigin()` / `guestOn()`: is guest play refused on every `*.github.io` page,
   including key creation, import and signing, whatever `deployment.json` says? Can any path still read or write the
   guest key there?
2. **BX-3 / BX-4 / BX-17** `bot/games/blockx.ts` (`latestCardAt`, `raceCardAt`, `rankedOf`, head) and `bot/race.ts`
   (the card's VHP on both nodes, 0.5% tolerance): can a late card, a missing signer, or one lying node still change
   a score or a board? Is a 0.5% tolerance safe, given VHP moves with block rewards between two reads?
3. **BX-5** `targetsCover` and the frozen `P<week>.json`: can a week still be final with a target missing, or a
   frozen prize list be replaced (recorder, workflow `git cat-file -e` check, publish shape check)?
4. **BX-6** `tools/pbjs-helpers/` (all 10 helpers pinned, `install.cjs` refuses anything unpinned) and
   `tools/protoc-pin.cjs` (protoc 21.12 by sha256): can anything unpinned still be fetched or run during a build?
5. **BX-9 / BX-19 / BX-20 / BX-21 / BX-22** `bot/picks.ts` `assertAuditedContract`, ABI pin, empty-wallet check.
6. **BX-10** the mainnet Kondor own-Mana path: explicit limit, chain id, `checkSigned`.
7. **BX-14** `boardPlace` (recorder), `freeWinners` (page): do the page's places and medals now match the recorder's
   boards and prize rule, ties included?
8. **BX-31 / BX-11** `tools/testnet-site.mjs` (Host on every request, funding reservation) and
   `site/testnet-wallet.js` (the `pick` entry point only).
9. **BX-23** the exact-shape publish checks in `games.yml` / `games-testnet.yml` (new key `boardPlace`).

10. **BX-3(b), new since the report** (owner approved 2026-10-28; `docs/HANDICAP-VHP.md`): card VHP is now the
    *effective* VHP (`effective_balance_of`, entry point 0x629f31e6, which counts added VHP only after 20 blocks), the
    **highest** of random samples over the last 6 hours (`bot/race.ts` `sample`, `windowHigh`;
    `.github/workflows/race-samples.yml`, every 10 minutes with a secret random wait of 0 to 8 minutes, both nodes),
    plus a floor from real block production (`productionFloor`: a producer signing more than 3 standard deviations
    above its card share is raised). Can a producer still look small on a card, by timing, by one lying node, or by
    the samples file (publish shape check, `race-samples` branch)? Can the floor be pushed the wrong way? These only
    choose the VHP behind the card; each game's own multiplier rule is unchanged.

Still open by the owner's choice (say if you disagree with leaving them open for a launch **without prizes**):
BX-2 (accepted: the free Mana total bounds the cost; winners watched) and BX-7 (sponsor watch). BX-1 and BX-13 are
resolved by the move to knodegames.com (done 28 October; guest play with sponsored Mana stays on there). BX-30: the
site is on its own origin now; GitHub Pages still can't send headers.

## Part B: full audit of the Mana sponsor v3 (not audited in the first round)

**What it is.** A contract uploaded onto the sponsor wallet `1ByDDSBUzy5zkRceELc54Jh8i41yNRoKt8` with only the
transaction-application override on. When a transaction names it as payer, its `authorize` decides whether to pay:
only listed player actions, signed by the player (payee) alone, within per-transaction, per-player daily/weekly,
everyone-daily and free-player-daily caps. Live on mainnet: v2 `fa4659e6…`. Candidate: v3 sha256
`21bec82583e1a7decbb2c70376f4b08e026f617c32bca268ab700f50e9aef2df` (33,210 bytes). Read `sponsor/README.md` and
`sponsor/assembly/proto/sponsor.proto`. Earlier audits: `docs/history/AUDIT-2026-10-27-sponsor-v3.md` (S3-1…S3-8)
and the v1/v2 audits it cites; check those fixes are still in place. Owner's own review of the new parts:
`docs/history/REVIEW-2026-10-28-sponsor-mana-limits.md`.

The owner's settings: 5,000 Mana a day for everyone, of which free players (no VHP, no stake; guests too) share at most
2,000; 50 per player per day; 300 per week; the sponsor wallet holds at least 25,000 KOIN.

Look hardest at:

1. `CAP_LIMIT` 5,000 Mana a day (was 1,000); weekly per-player ceiling 7 × that. Any u64 or ordering issue?
2. `config.mana_caps` (up to 16 rows {contract, entry point, max Mana}): a transaction's `rc_limit` must be at most
   the sum of its operations' rows (no row: `max_mana_per_tx`), and at most `max_mana_per_tx`. The caps count
   `rc_limit` (authorize runs before execution) while the chain charges only what is used. Can the budget check be
   bypassed, overflow, or make the sponsor pay for anything it shouldn't? Can a too-low row make players'
   transactions fail, and what is lost then?
3. The Mana adjuster (`bot/mana-limits.ts`; `bot/sponsor.ts` mana-report / mana-limit / site-limits / config): is the
   margin wide enough when Mana prices move with load? Can the website's copy (`sponsor.rcLimits` in
   `game-data/deployment.json` and `desk-data/deployment.json`, used by `site/wallet.js` `rcFor`) disagree with the
   chain in a way that hurts players (guests have no Mana to fall back on)? Is the two-step order (site first, then
   chain) enforced?
4. The allowlist row for the Picks `pick`: the sponsor and the Picks contract must read the same player from the same
   bytes (`argsPlayer`, `PICKS_ARG_TYPES`).
5. Spam: with free play paid for any wallet, what can one attacker cost the sponsor per day, and can they lock out
   real players? Use the measured 0.048 Mana per pick and the ~0.15 per-pick limit.
6. Upgrade path: `bot/sponsor.ts` `upload` on the live sponsor wallet (v2 → v3), `allowedBuilds` (v3 is testnet-only
   until this audit passes), and the runbook `docs/blockx/MAINNET-LAUNCH.md` steps 3, 4 and 6.

**Out of scope.** The game vault and the daily-questions game contract (audited separately).

## Report

Part A: one row per BX finding: fixed / partly / not fixed, with file:line and anything new the fix introduced (new
IDs BX-35, BX-36, …). Part B: a table of findings SP-1, SP-2, … with severity (Critical/High/Medium/Low/Info),
file:line, a concrete attack or failure scenario, and a fix. Then a verdict for each part: "ready for mainnet",
"fix first" or "not ready", and what must be fixed before mainnet. Where you can, add a failing test (as-pect for the
contracts, node:test for the rest) for each High or Medium finding.

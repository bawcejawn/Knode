# Fix-check prompt: Fantasy Producers (FX-1 to FX-10) + everything added since

Copy everything below the line into Repo Lens. Give it the package `knode-fantasy-fixcheck.zip` (the repository
`bawcejawn/Knode` at the commit in `00-COMMIT.txt`, branch `fantasy`, with this prompt as `00-FIXCHECK-PROMPT.md`).

---

You are an independent smart-contract and web security auditor, and a game-design reviewer. The first Fantasy
Producers audit (2026-10-28) found no Critical and no direct way to cheat, and listed FX-1 to FX-10. They have been
worked through, and the game has changed since. Check the code, not the comments. Send no transaction to mainnet.

The game, in one paragraph: a player drafts five Koinos block producers from a weekly price list (budget 100), the
first is the captain (×2). Each UTC day a producer scores `100 × blocks signed ÷ blocks expected` (expected from the
Producer Race's hourly VHP card), at most 130. One change a day (one swap, or moving the captain); each Monday starts
fresh. Picks go to the audited Picks contract (games 4 = team, 5 = Weekly Rival). A read-only recorder publishes the
results to the `games-data` branch, including one vault file per final week. Rules: `docs/fantasy/README.md`.

Run the repository's own tests:

```
npm ci --ignore-scripts
npm run test:audit:serial
node --import tsx tools/fantasy-testnet/rehearse.mjs      # about 5 minutes: 2.5 test weeks, offline, fake chains
cd picks && npm ci --ignore-scripts && npm test && cd ..
```

Known: one failing test, `site.mobile-nav.test.mjs` ("blockx.html: nav.js after the wallet scripts"), comes from
branch `picks` unchanged (Block X's page). It is not part of this review.

Fingerprint: Picks release `700c296a1064b904299c156061d6caf8fcabd0b1765968903f29d89d2426c594` (unchanged; Fantasy
needs no contract change).

## 1. The earlier findings: check each fix

| ID | The fix | Where |
|---|---|---|
| FX-1 | A week is final only when all 7 days' blocks (two nodes) and all 7 days' picks are read, the rivals and stakes are read, and 12 h have passed. Not final 2 days after the week: an `ALERT`. | `bot/games/fantasy.ts` (week finality); test "audit FX-1" |
| FX-2 | The workflow stops if `games-data` exists but can't be fetched (no recording from empty files). The publish job refuses to change a published price list, a final week, counted rival weeks, a rival record, an all-time total or a vault file. | `.github/workflows/games.yml` |
| FX-3 | Vault points: 255 for the best week, one less per lower distinct score, ties kept, at least 1, ranked among Fantasy stakers only. | `fantasy-math.js` `vaultPoints`; tests |
| FX-4 | Final weeks keep teams as positions on the price list (small files). Fantasy files may be up to 8 MB. A Fantasy failure never blocks Block X's publishing (`continue-on-error`). | `fantasy-math.js` `packTeam`; `games.yml` |
| FX-5 | A day with blocks in an hour no race card covers is never final. | `fantasy-math.js` `dayIndex` (`uncovered`) |
| FX-6 | Unfinished weeks are retried for 8 weeks. | `bot/games/fantasy.ts` `WEEKS_BACK` |
| FX-7, FX-10 | Fixed in the same pass (see the tests in `tests/audit/fantasy-*.test.mjs`). | |
| FX-8, FX-9 | Owner decisions: Terms section 3 (Knode's own nodes run the same whatever the game; Knode Games can't control others' staking), and rival matches need a stake. | `terms.html`; `bot/games/fantasy.ts` |

## 2. What changed since, to review

1. **Owner decisions 2026-10-28 evening.** An all-time table (`alltime.json`, board `allTime`). Rival matches count only
   when both players hold a stake (before the vault: a Knode Games stake; with the vault: staked in Fantasy that week,
   read on both nodes). The vault hand-off file `fantasy/vault/W<week>.json`, written only once the vault ABI has
   `get_game_player`.
2. **No rushed picks (owner, 2026-10-29).** The price list is made Saturday 00:00 UTC, two days before the week, from
   the 7 days before. A team, or a change, can be planned for any day up to 7 days ahead. A planned day can be changed
   until its own lock. The page warns when changing an earlier day would make a planned day break the one-change rule,
   and reminds players when next week's prices are out and their Monday team won't play.
3. **The page was rebuilt** (`fantasy.html`, `fantasy.js`, `fantasy.css`). It has:
   - a scoreboard with a lock countdown and a "Your move" line;
   - the team on a pitch, with SVG kits built node by node;
   - a players list with search, plain-word columns and "signed X of Y blocks";
   - a one-change counter, a quick guide, a questions section, and a dismissible guide and legend remembered in
     `localStorage`.

   It also mounts the site's shared stake panel (`stake-panel.js`) for game 4.
4. **Merged with `picks`.** The site is now served from the repository root (the Fantasy files moved out of `site/`).
   `games.yml` combines Block X's checks with Fantasy's: BX-34 line-by-line reads, BX-5 write-once files (now also
   `fantasy/vault`), and a publish allowlist for both games.
5. **The testnet practice kit** (`bot/fantasy-test.ts`, `tools/fantasy-testnet/`) is deployed on the Koinos Foundation
   testnet.
   - Picks go to a testnet copy of the Picks contract; scoring reads mainnet blocks, read only.
   - A local server on 127.0.0.1 signs only Fantasy team and rival picks for the test wallets. It checks the host,
     the origin and a token, and serves only top-level scripts, styles, images and `media/`.

## 3. Please look hard at

1. **Fairness and timing.** Can anyone gain by picking late, or by planning early and changing at the last moment?
   Think about VHP moves before a lock, the first race card of a day, and node health shown on the page. Can a planned
   day, a Monday carry-over or a captain move give two changes in one day, or let a team over budget or off the list
   score? Do the page and the recorder always agree (`F.teamsForWeek`, `F.changes`, `F.checkTeam`)?
2. **Small producers.** A producer due only a few blocks a day swings widely (3 blocks when due 2 is 150, capped at
   130; 0 is 0). Its price comes from 7 noisy days. Is there a reliable edge in cheap, swingy producers, or in
   pricing? Is the 8–40 price clamp, the 130 cap and the captain ×2 sound? Suggest changes only with numbers.
3. **Race cards changed under Fantasy.** Since the merge with `picks`, the Producer Race cards Fantasy reads for
   "expected blocks" use each producer's **highest** effective VHP over the last 6 hours (`bot/race.ts`
   `windowHigh`, BX-38). Cards made from fewer than 12 samples carry `samples` and are flagged; Block X skips those
   cards, but Fantasy still uses them.
   - A producer whose VHP falls is "expected" at the higher figure for up to 6 hours, so it scores below 100. Is that
     fair to Fantasy players?
   - Can anyone move a drafted producer's score by moving VHP (their own, or VHP sent to that producer) around a
     sample?
   - Should Fantasy skip flagged cards, as Block X does, or treat them some other way?
4. **The recorder.**
   - Two-node agreement; irreversible blocks only; a day is final only when every hour with blocks has a card.
   - The Saturday sheet, made once and never remade, with its sha256.
   - Previous-run files: can a crafted or stale file add, change or drop teams, points, rivals or all-time totals?
   - The vault file: stakers only, 1–255, ties, at least 1 point, every wallet once.
   - Stake reads on both nodes.
5. **Weekly Rival.** Throwaway wallets, collusion, challenging someone with no team, the stake rule, and the record
   counting made and received separately.
6. **The page.**
   - XSS: everything is built with `textContent`, including the SVG kits.
   - The CSP.
   - What it asks a wallet to sign: only `pick` for games 4 and 5, plus the shared stake panel's vault calls. It never
     sends to the testnet contract from the live page, and the reverse.
   - The planning warning's correctness.
   - `localStorage`: UI flags only.
   - The testnet page refuses mainnet.
7. **CI** (`games.yml`): no repository code runs next to a write token. Try files the publish shape check accepts but
   shouldn't. Only `blockx/` and `fantasy/` on `games-data` are pushed. Check the merge with Block X's job kept both
   games' rules intact.
8. **The testnet kit.**
   - It never signs for mainnet (chain id, settings, keys) and never prints or serves a key.
   - The server refuses other hosts, origins and paths (`/testnet-data/…`, `package.json`, `bot/…`, `..`).
   - It only uploads a Picks build that reproduces the audited bytes with exactly three lines changed.

**Out of scope:** the Vault (v6), the Picks contract's own code, the Mana sponsor, Block X, and `stake-panel.js` itself
(audited with the site). Only how Fantasy uses them is in scope.

**Report.** A table of findings with:
- an ID (FC-1, FC-2, …);
- a severity (Critical/High/Medium/Low/Info);
- file:line;
- a concrete attack or failure scenario;
- a fix.

Then, for FX-1 to FX-10, one line each: fixed / not fixed / partly. Then a verdict: "ready for mainnet", "fix first"
or "not ready", and the findings that must be fixed before launch. Where you can, add a failing test (node:test) that
shows each High or Medium finding.

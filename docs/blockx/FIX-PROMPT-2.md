# Fix prompt: Repo Lens fix-check of Block X + sponsor v3 audit (report @ 148c00f, 2026-10-28)

Paste everything below the line into Claude Code, in the `bawcejawn/Knode` repository. Attach the auditor's
`knode-fixcheck-failing-tests.zip` (its files go into the repository at the paths inside it).

---

You are fixing the findings of the Repo Lens report "Block X Fix-Check + Sponsor v3 Audit (Knode picks @ 148c00f)"
(`docs/history/AUDIT-2026-10-28-repolens-fixcheck.md`; earlier record
`docs/history/AUDIT-2026-10-28-repolens-blockx.md`). Work on branch `picks` only. Never push `main`, merge, deploy,
upload a contract or change chain settings. Never ask for, print or store a private key. Explain each change plainly
for an owner who is new to code, and give Windows PowerShell steps for `C:\kprediction` as copy-paste blocks with the
`cd` included.

## 0. First

1. `git fetch`, check out `picks`, merge `origin/main` into it. Main moved the site to the repository root and added
   `CNAME` (knodegames.com): follow the project doc `claude/site-at-root.md` (git mv the new `site/` files of this
   branch to the root, fix bot imports `../site/` → `../`, tests `${APP}/site/` → `${APP}/`, data bases `../` → `./`,
   re-run `node tools/site-seo.mjs` and `node tools/site-nav.mjs`). This also answers BX-39's "put the move into the
   branch".
2. Unzip the auditor's failing tests into the repository. Run `npm ci --ignore-scripts`, then
   `npm run test:audit:serial`, `cd picks && npm test && npm run check`, `cd sponsor && npm test`. Each auditor test
   should fail before its fix and pass after.

## 1. Must fix before mainnet

- **BX-37** (`bot/race.ts`, card ~262-269, sample ~424-428): judge each producer on its own. For a producer whose two
  reads differ by more than 0.5%, use the HIGHER of the two for that producer, but never let it raise the card's top
  above the top both nodes agree on. Never hold the whole card or drop the whole sample for one address; log it.
- **BX-38** (`bot/race.ts` sample, `race-samples.yml`): refuse a sample whose head time is more than 60 s ahead of the
  check node's head (and of the runner's clock); the publish check must refuse samples more than 10 minutes in the
  future of `updated`, and must never let a new file drop older valid samples. A card with fewer than 12 samples in
  its 6-hour window is still made but flagged (`samples: n` on the card, a warning); Block X holds a target scored
  with a flagged card until a card with enough samples exists, or voids it at the 3-hour limit.
- **BX-40 / BX-51** (`site/wallet.js`): replace the `*.github.io` suffix check with an allowlist: `knodegames.com`,
  `www.knodegames.com`, `localhost`, `127.0.0.1`. Put it in `guestReady()` and every guest path (reconnect, backup,
  restore, switch, create, sign). Off the allowlist the page never reads or writes the guest key.
- **BX-39**: the owner's decision (below) on guest keys made on `bawcejawn.github.io` since 26 Oct. Document it in
  `docs/history`; until decided, nothing else.
- **SP-1** (`docs/blockx/MAINNET-LAUNCH.md`, `bot/sponsor.ts`): `config` defaults to the owner's settings (per-tx 1,
  per-player-day 50, per-player-week 300, per-day 5000, free-per-day 2000, min-vhp 1), not to what is on chain; the
  runbook shows the full flag line too; the dry run prints old → new for every cap.
- **SP-4**: launch Picks with **no per-action row** (the owner's choice below); after the first full day on mainnet,
  set the row from `mana-report` (after SP-6/SP-7). Remove the `mana-limit picks:pick 0.0477` line from the runbook
  (also fixes SP-13's ordering); explain in the runbook.
- **SP-5** (`bot/sponsor.ts` setConfig): abort on a failed or empty `get_config`; read two nodes and refuse if they
  differ; show old → new before sending; `disable --send` skips the limit checks so the emergency stop always works.
- **SP-6** (`manaReport`): drop samples with no receipt, a mismatched transaction id or 0 used; read two nodes;
  require at least 20 samples per action before suggesting a limit.
- **SP-7** (`bot/mana-limits.ts` merge/summarize): a run-out with no previous row means the old limit was the
  per-transaction cap: suggest no row and report it. Never suggest a limit at or below anything that ran out.
- **SP-2 / SP-3** (sponsor contract): the owner's decision below. This changes the sponsor wasm, so give the new
  sha256, update `SPONSOR_V3_CANDIDATE`, the README and the audit prompt, and add as-pect tests (the auditor's
  `Sponsor.repolens-sp2-3.spec.ts` must pass). Also correct the "staked players always have 3,000 or more" wording, and
  add an hourly alert (in the operator bot's status) when the free pool or the total is more than 80% used.

## 2. Must fix before prizes (do them now too)

- **BX-35** (`bot/games/blockx.ts` ~297): score each target with the HIGHER VHP of (the card at or before the lock)
  and (the first card taken after block X), per producer, so the multiplier is the lower of the two. Hold the target
  until that later card exists (void at the existing 3-day limit).
- **BX-36** (`bot/race.ts` ~232, 254-258, 272-278): read the 7,200-block window and the head time on BOTH nodes; hold
  the card on any difference in the signer set, per-producer counts or block times; use the check node's head time
  too (take the earlier) so a card can't be back-dated.

## 3. Low and Info

BX-41 (use `boardPlace` everywhere, Staked board and "You: #n"), BX-42 (more, shorter samples: every 5 minutes with a
0-4 minute random wait), BX-43 (solve the production-floor raises jointly), BX-44 (exact keys for race cards and
samples, cards write-once, sample values bounded by VHP total supply), BX-45 (drop addresses with no blocks in
8 hours), BX-46 (the `get_game` check on both nodes, hold on error or missing game, also when `head` is given),
BX-47 (refuse equal node URLs, check the chain id on both), BX-48 (void a target with no possible card once head is
past lock + 3 h), BX-49 (replace source-text tests with tests that run the code: BX-1 regex, BX-31 count, BXS-4 at
exactly 3.0 h, BXS-3, and add tests for medals and the BX-10 limit), BX-50 (compare decoded args), BX-52 (runbook
notes yarn 1.x; the build script checks the protoc stamp), BX-18 race `readPicks` pages until empty.
SP-8 (fetch the deployed `game-data/deployment.json` and `desk-data/deployment.json` from knodegames.com, no cache,
and refuse unless every chain row has a site entry ≤ it and the 1-Mana fallback fits; the runbook pushes to `main`
via a PR, not `picks`), SP-9 (document; keep per-day well below the wallet's Mana), SP-11 (classify run-outs by the
receipt's "insufficient rc" log), SP-12 (mainnet decided by chain id; separate testnet state files), SP-13 (keep v2 as
a documented rollback build), SP-14 (check the on-chain code hash is v3 before sending v3 fields; refuse when the
Picks row can't be built), SP-15, SP-16 (refuse repeated fields, contract change: include with SP-2/3), SP-17 (align
rcLimitOther with the per-transaction cap or document), SP-18 (clearer guest messages), SP-19 (transition rows),
SP-20 (exact Mana values), SP-21 (keep the check in the runbook).

## 4. Then

- Update `docs/history/AUDIT-2026-10-28-repolens-blockx.md` with a row per new finding, `MAINNET-LAUNCH.md`,
  `sponsor/README.md`, `docs/HANDICAP-VHP.md`, and write a fix-check prompt for the next Repo Lens round
  (`docs/blockx/FIXCHECK-PROMPT.md`) and its package (repo at the new commit, prompt inside).
- All tests pass; the Picks hash stays `700c296a…`; give the new sponsor hash.
- Commit to `picks` and push `picks` only.

## Owner decisions (filled in by the owner)

- BX-39 old github.io guest keys: ______
- SP-2 / SP-3 sponsor pool design: ______
- SP-4 Picks per-action limit at launch: ______

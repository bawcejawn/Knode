# Knode audit

Audit date: 2026-10-19. Scope is the whole repository at `main` (`89228ce`): the game contract, the swap desk, the operator bot, the question generator and backtest, the static site, probes, node setup, and CI. This is a review only. No application code was changed.

The previous contents of this file were an auditor briefing (addresses, rebuild steps, what to look at). Those facts are kept in the appendix so they are not lost. The findings below are from reading the code, rebuilding both contracts, running their test suites, `npm audit`, and reading live mainnet state.

## Executive summary

Knode is a weekly Koinos prediction game plus a VHP-for-KOIN swap desk. Players stake VHP in a game contract. That VHP produces blocks. Each week the operator posts multiple-choice questions about block producers and network stats; after the week, winners share the pool's block rewards. A second contract (the desk) swaps a user's VHP for the desk's KOIN, 1:1 minus a 3% fee, and produces blocks with the VHP it receives. The website is static files on GitHub Pages. Wallets sign every user transaction. The hourly bot posts questions and results; its key cannot move funds.

The contracts are carefully written: player funds are not pulled without that player's signature, outside calls cannot move the contract's tokens, payouts are checked for solvency, and upgrades need the owner, a pre-announced bytecode hash, and a 48-hour wait. Game tests are 47/47 and desk tests are 25/25. The desk bytecode rebuilt here matches the hash recorded at deploy. No private keys were found in the tree or in git history.

The urgent problem is that **mainnet is not running the code this repository and the website describe**. The game was deployed on 2026-10-16 from commit `cce5dc3`. That bytecode still charges a 2% owner share and picks winners by stake, not by headcount. `main` has since changed the payout (5% fee only, top 30% of players by headcount, two baskets). An upgrade to exactly that newer bytecode was announced on chain. Its timelock expired at 2026-10-18 17:03 UTC, about seven hours before this audit, and it has not been applied. Week 0 started at 2026-10-19 00:00 UTC. The contract already holds about **21,010 VHP of player stake**, plus a 1,000 VHP / 50 KOIN seed. Until the upgrade is applied, or the site is changed back, players are being shown rules the chain will not pay.

No path was found that lets a stranger take another player's stake. The other material risks are a stolen operator key finalizing a bad result with no correction window, a stolen desk owner key draining the desk immediately (owner and treasury are the same address; the desk holds about 1,429 KOIN and 19,605 VHP), and the off-chain resolver having no tests.

## What the project is and how to run it

| Path | Role |
|---|---|
| `game/` | Game contract, AssemblyScript (`Kpred.ts`, `Tokens.ts`). Holds player VHP. |
| `desk/` | Swap desk contract. Holds the desk's own KOIN and VHP. |
| `bot/` | Operator bot: deploy, hourly tick, admin, rehearsal. |
| `generator.ts`, `backtest.ts`, `step0.ts`, `common.ts` | Question model, historical test, pool-economics report. |
| `site/` | Static site. GitHub Pages serves the repo root; `index.html` redirects to `site/`. `.nojekyll` is present. |
| `probes/` | Throwaway contracts used to prove token calls on chain. |
| `node/` | PowerShell scripts that install a Koinos node and producer. |
| `data/blocks-compact.csv.gz` | Packed public block history for the model. |
| `.github/workflows/` | Contract tests, desk tests, hourly bot, 15-minute node watchdog. |

Requirements are Node.js 22 (CI and `AUDIT` rebuild notes; the root README still says 20).

```text
npm install && npm run step0 -- --days 1     # read-only chain stats
npm run backtest                             # replay history through the question templates
npm run generate -- release                  # write a day's questions locally
npm run bot -- status                        # read-only game status
npm run bot -- tick --dry-run                # what the hourly job would do

cd game && npm ci && npm test && npm run check
cd desk && npm ci && npm test && npm run check
```

Deploy and the weekly clock are in `LAUNCH.md`. GitHub Pages is "deploy from branch `main`, folder `/`". The bot is `.github/workflows/bot.yml` (cron at minute 7, `BOT_ENABLED=true`, secret `OPERATOR_WIF`). It commits `game-data/` back to `main`.

Live addresses, verified on chain during this audit:

| | Address | Notes |
|---|---|---|
| Game | `1Mpmf2ERhjYpX7CCiM11WERuM4j17uT1sr` | Week 0 open. Stake 21,010 VHP. Seed 1,000 VHP + 50 KOIN. |
| Desk | `1FKTpXBhhHEbu5vVchM8UsVbAvPArJsRmR` | ~1,429 KOIN and ~19,605 VHP. One swap so far. |
| Owner, seed owner, desk treasury | `1635QUrBNDp7WqmFkRvrkGwjJXTtFvH717` | Same key for all three. |
| Operator | `1JSTwoKYNAUq2gmmTg4r1kdYCERR2kUrZ` | Posts and resolves only. |

## What was run

| Check | Result |
|---|---|
| `cd game && npm test` | **47 / 47 passed.** Release wasm 49.4 KB. |
| `cd game && npm run check` | **All offline checks passed** (no test ledger in the wasm, ABI entry points match). |
| `cd desk && npm test` | **25 / 25 passed.** Release wasm 29.6 KB. |
| `cd desk && npm run check` | **All offline checks passed.** |
| Fresh game wasm sha256 | `917708a7c567d9642a7a2f121c34fbc70200909787208705fc3aa5a2b1e6433a` |
| `game-data/deployment.json` `wasmSha256` | `ff4207b4…` (the 2026-10-16 deploy). **Does not match HEAD.** |
| On-chain `get_state().upgrade.hash` | `0x917708a7…` — **matches the HEAD rebuild.** `eta` 2026-10-18 17:03 UTC, already passed. Upgrade not applied. |
| Fresh desk wasm sha256 | `05039d743d383538d0078a89e3bfde56e052c0eb478cf14dad63afd366b761e4` — **matches** `desk-data/deployment.json`. |
| Root `npm audit` | 34 issues (2 critical, 28 high). Both criticals are transitive dev tooling under `@koinos/mock-vm`, not `koilib`. |
| `game` and `desk` `npm audit` | 67 issues each (4 critical, 41 high), all in the AssemblyScript build toolchain. |
| `probes` `npm install` then audit | Same toolchain set. `koilib`, `tsx`, and the SDK resolved to the same versions as the pinned packages, but `package.json` says `"latest"` and there is no lockfile. |
| Ad-hoc `tsc --strict` on the root TypeScript | No project `tsconfig`. One error: `bot/chain.ts:58` (`result` on `unknown`). Not run in CI. |
| Lint | No ESLint (or other) config. Nothing to run. |
| Secret scan of git history | No WIF or `.env` blobs. Matches were npm `integrity` hashes. |
| Backtest | Not re-run. It replays ~120 days of blocks and is not in CI. |

`npm test` shells out to protoc plugins that call `fs.readFileSync(process.stdin.fd)`. On this machine that read returns `EAGAIN` because Node sets stdin non-blocking. The plugins were patched locally inside `node_modules` so the suites could finish. That patch is not in the repo. GitHub Actions has been the environment these tests were written for; treat a local `EAGAIN` as an environment quirk, not a product bug.

## Findings

### Critical

#### C1. Mainnet is still the old payout rules, while the site, bot, and tests are the new ones. The upgrade is ready and has not been applied.

`game-data/deployment.json` records wasm `ff4207b477b0bee2d2f545b3ddfeff9a8dd1cc6fb804852f12d8102ecef5697f`, uploaded in `cce5dc3` (2026-10-16 02:03 UTC). `git diff cce5dc3 HEAD -- game/assembly/Kpred.ts` is 156 lines. At that deploy commit the contract header says the split is "5% creator fee, 2% owner share, 93% pot", and `finalizeInternal` sets the winner line from `eligible_stake`, not from a player count.

HEAD (`game/assembly/Kpred.ts` lines 6–14 and 664–669) charges only the 5% fee, pays with two baskets, and takes the top 30% of eligible **players**. The website copies that math (`site/app.js` lines 173–236). `LAUNCH.md` and `game/SECURITY.md` describe the same rules.

The live ABI still matches the deploy commit, not HEAD:

- On chain, `claim_owner_share` is "Claim the 2% owner share in VHP (owner only)."
- HEAD's `game/assembly/proto/kpred.proto` says that share is retired.

`get_state` on 2026-10-19 showed week 0 already started (`genesis_time` 2026-10-19 00:00 UTC), `total_stake` = 21,010 VHP, `seed_vhp` = 1,000 VHP, `seed_koin` = 50 KOIN, `upgrade.hash` = the sha256 of a clean HEAD rebuild, and `upgrade.eta` = 2026-10-18 17:03 UTC. Chain time was about seven hours past that eta. `owner_share` is still 0 only because no week has closed yet; the **deployed** code will still accrue the 2% when week 0 closes.

Why it matters: anyone staking or answering from the website is playing a different game than the one that will pay them. A whale who read "top 30% by headcount" can still be outside a stake-weighted cutoff, and the owner share the site says is gone will be skimmed. The storage change in the pending upgrade only **adds** protobuf fields (`rolled_over`, the accumulators, `pot_a` / `pot_b`, `sum_w`). Old state should decode. That does not make it safe to leave the mismatch in place through a close.

Fix:

1. Decide which rules week 0 will use, today, before any question is resolved.
2. If the new rules are the ones you want, apply the already-announced upgrade (`npm run bot -- upgrade apply`, dry-run first) and then set `game-data/deployment.json` `wasmSha256` to `917708a7…`. Re-read `get_state` and confirm the on-chain ABI text for `claim_owner_share` is the retired wording.
3. If you want the old rules for week 0, put the website and bot back on the deployed commit until the upgrade is applied, and cancel the announcement if you are not ready.
4. Add a CI check that fails when `deployment.json`'s hash differs from `sha256sum game/build/release/contract.wasm` unless `get_state().upgrade.hash` is that new hash and the upgrade is still pending. Do not leave a third possibility (repo, chain, and announcement all different).

### High

#### H1. A late resolution closes the week in the same transaction, so the owner never gets a correction window.

`resolve_question` (`game/assembly/Kpred.ts` lines 779–794) writes the outcome and then calls `advance`, which closes the week when `now >= weekEnd + close_delay` and every question is resolved (`closeDue`, lines 206–210). `correct_question` (lines 799–807) refuses once `wk.closed` is set.

The intended control, repeated in `docs/security-audit.md` and `game/SECURITY.md`, is that a bad operator result can be corrected during the 12-hour `close_delay`. That is true only if the result is posted **before** the delay elapses. An operator who waits until after Monday 12:00 UTC and then resolves the last open question locks the outcome in the same transaction that closes the week. The honest hourly bot usually resolves earlier (`bot/bot.ts` `resolvePass`, around lines 296–330, then `closeFinalizePass`). A stolen `OPERATOR_WIF`, or a bot that was down until after the delay, does not have to.

Why it matters: the operator cannot move stake, but they choose the pot. With a 21,010 VHP pool already producing, a wrong result is a real payout. The owner's 12-hour remedy is the published mitigation, and the contract does not enforce it.

Fix: do not call `advance` from `resolve_question`. Require `close_week` to see `now >= lastResolutionTime + close_delay` (store that timestamp on the week when `resolved` becomes equal to `questions`). Add a test where the last resolve happens after the delay and the week stays open until a later transaction. The bot can keep resolving promptly; it should not be what makes the delay real.

#### H2. The desk's 48-hour treasury delay does not protect the funds that are in it now.

`desk/assembly/Desk.ts` `withdraw_koin` / `withdraw_vhp` (lines 231–250) send to `c.treasury` as soon as the owner signs. Changing `treasury` waits `timelock_length` (lines 289–312). `desk/SECURITY.md` says a stolen owner key cannot redirect funds because you empty the desk to the treasury first.

On chain, `owner` and `treasury` are both `1635QUrBNDp7WqmFkRvrkGwjJXTtFvH717`. The same key that can sign a withdrawal is the key that receives it. A read of `get_state` showed about **1,429 KOIN** and **19,605 VHP** available to that call, with no treasury change and no upgrade pending. Swaps are atomic, so users do not leave a balance, but that inventory is the liquidity the swap page sells.

Fix: move the treasury to a key that is not the hot owner, announce it, wait 48 hours, and only then leave a large balance in the desk. Until that key split exists, treat the owner key like a hot wallet sitting on the whole desk: offline, not in GitHub, not on the build machine. Say this explicitly in `desk/SECURITY.md`; the current sentence is only true when the keys differ.

#### H3. The bot's GitHub Actions workflow can be changed into a key theft, and it is not pinned.

`.github/workflows/bot.yml` checks out with `actions/checkout@v4` and `actions/setup-node@v4` (floating tags), runs `npm ci` with `--no-audit`, then runs `npm run bot -- tick` with `OPERATOR_WIF` in the environment and `permissions: contents: write`. A pull request that edits that workflow, or a compromised action tag, runs next to the key that posts mainnet results. The workflow pushes to `main` (`bot/bot.ts` lines 982–990), which is also what GitHub Pages publishes.

Why it matters: the operator key cannot steal stake, but finding H1 shows what it can do, and a malicious commit from the bot token can change the site players trust.

Fix: pin every action to a full commit SHA. Restrict the bot token so it can push only `game-data/**` (a separate fine-grained token, or a workflow that fails if `git diff` touches anything else). Require a review before workflow files change. Turn `npm audit` back on for the root install, which is the one that runs beside the key.

### Medium

#### M1. The upgrade you are about to ship still describes the old winner rule.

`game/assembly/proto/kpred.proto` line 301 says winners are "the top 30% of eligible stake by points". The code at `Kpred.ts` lines 667–669 uses `eligible_players`. The on-chain ABI already shows the stale sentence, and HEAD's ABI file has the same sentence, so applying the upgrade will not fix the public description. `claim_creator_fee` / `claim_owner_share` descriptions were updated; this one was not.

Fix: change the `@description` to headcount, rebuild, and if the announced hash was `917708a7…` you must schedule a new hash. Do not apply an announcement and then "just fix the comment" afterwards; the hash will not match.

#### M2. Templates that failed the project's own bar are enabled, and the README describes a different schedule.

`generator.ts` lines 62–67 default to five questions a day Monday–Saturday and `enabled` includes `E3` and `M9`. The README's results table says those two void about 6.1% of the time, above the 5% pass line, and the "How a day is built" section still says 3 questions a day, or 2 on day 7. `LAUNCH.md` matches the code (five a day). The first run writes these defaults into `game.json`.

Why it matters: smaller producers will be offered as if they were fair, and they void more often than the published standard. A voided question drops out of scoring (`Kpred.ts` lines 512–521, `counted > 1`), so extra voids also knock players out of eligibility.

Fix: drop `E3` and `M9` from `enabled` until a longer backtest passes them, or raise the void budget in the README and say so on the question. Make the README's schedule match `questionsPerDay`.

#### M3. A bad block download can resolve the wrong blocks, and nothing checks the heights.

`common.ts` `fetchRange` (lines 68–78) appends whatever the node returns and never checks that `block_height` equals the height it asked for, or that the batch is contiguous. `generator.ts` `buildModel` (line 113) does refuse gaps at release. `resolve` (lines 552–569) does not: it treats `blocks[h - h0]` as height `h`. A short or shifted page silently scores the wrong window. The contract then accepts the operator's `outcome` and `data_hash` with no independent check (`Kpred.ts` lines 771–777).

Fix: in `fetchRange` and `syncBlocks`, require `item.block_height === requested` and `blocks[i].h === blocks[0].h + i`, and throw otherwise. In `resolve`, refuse a window whose first or last height does not match `windowStart` / `windowEnd`. Add a fixture test with a gap and a duplicated height.

#### M4. A question file is written once. If the chain rejects it, the bot retries the same windows until the day is skipped.

`bot/bot.ts` lines 359–384 generate a day only when the file does not exist, with `windowStart = height + ceil((lockTime - now) / 2800) + 20`. The contract recomputes the minimum start height at inclusion time (`Kpred.ts` lines 737–739). The `+20` is about a minute of blocks faster than the 2.8s assumption. If post fails, the next tick reuses the file (`postSkipped` is set only when less than an hour remains, lines 395–399). It does not rebuild the windows.

Fix: on a `post_question` revert whose message is the window check, delete the unpublished file and generate again. Keep the `+20` as slack, but base it on irreversible height plus a few minutes, not 20 blocks.

#### M5. The site hides old winnings and states a fixed Tuesday payout time.

`site/app.js` lines 156–158 only look at the last six finalized weeks for the claim button. The contract's `claim` has no expiry (`Kpred.ts` lines 541–576). A player who waits two months still has a claim on chain and no button.

Line 716 always says winners are final "Tuesdays at 12:00". That is true only when the week closes on time. `closeInternal` sets `settle_end = h + settle_length` from the actual close (`Kpred.ts` lines 645–646). A late close moves the deadline, and the page will not.

Fix: page claims from week 0, or from the player's `last_week`, not `weeks_finalized - 6`. Show `settle_end` from `get_week` once the week has closed.

#### M6. Wallet pages load unpinned third-party scripts with no CSP.

`site/index.html` lines 190–191 (and the same pattern on `swap.html`, `burn.html`, `producer.html`, `node.html`) load `koilib` and `kondor-js` from `cdn.jsdelivr.net` with a version in the URL and no `integrity`. `site/wallet.js` lines 109–114 then loads `qrcode-generator` from cdnjs, and line 132 assigns that library's SVG with `innerHTML`. `sessionStorage` holds the KOIN Vault session secret (`wallet.js` lines 70 and 142–143). There is no Content-Security-Policy.

The sandbox on ad iframes (`site/app.js` lines 341–345) is reasonable: no `allow-same-origin`, so the frame cannot read the page. `allow-popups-to-escape-sandbox` still lets an ad network open a normal tab. Sponsor links are https-only. That part is fine.

Fix: vendor the two libraries (or use SRI hashes you have verified), serve the QR script yourself, and add a CSP that allows only those script hosts and forbids `unsafe-inline`. Stop putting the Vault secret in HTML.

#### M7. Dependency risk sits on the machine that has the keys, and probes are unpinned.

`npm audit` after `npm ci`:

| Package | Production dependency? | Audit |
|---|---|---|
| Root (`koilib` 9.4.1) | Yes, this is what the bot runs | 34 (2 critical, 28 high). `koilib` depends on `protobufjs` **7.6.6**, which is **outside** every advisory range npm reported (the newest range is `<=7.6.2`). The critical `protobufjs` 6.11.6 and `tar` come through `@koinos/mock-vm` → `somap` → a nested `npm`. Dev only. |
| `game/`, `desk/` | Toolchain is devDependencies (`@koinos/sdk-as` 1.5.1, CLI 1.0.2) | 67 each (4 critical: `form-data`, `protobufjs`, `request`, `tar`; 41 high, including `lodash` prototype pollution). Not inside the wasm (the offline check looks for the test-ledger marker). They **do** run when you `npm test` or `npm run build` on the PC whose `.env` holds `OWNER_WIF`. |
| `probes/package.json` | `koilib`, `@koinos/sdk-as-cli`, and `tsx` are `"latest"` | No lockfile. A later install can change the code that runs next to probe keys. `LAUNCH.md` copies the probe owner key into `OPERATOR_WIF`. |

`@koinos/proto-js` is 2.1.0; npm reports 2.6.0 as latest. Nothing in the root package is unused in a mechanical sense (`koilib` and `tsx` are used; `@koinos/mock-vm` and `@koinos/proto-js` are only needed for the rehearsal and contract work).

Fix: build contracts on a machine that does not have mainnet keys, or build inside CI and only download the wasm. Pin probes the same way as `game/package.json`, and commit a lockfile. Re-run `npm audit` when you bump the SDK; don't expect `npm audit fix` on the toolchain to be safe without re-running the 47 and 25 tests.

#### M8. CI does not cover the path that decides winners, and it does not run on pull requests.

`.github/workflows/test.yml` and `desk-test.yml` trigger on `push` to `game/**` or `desk/**` only. There is no `pull_request` trigger. Nothing runs `generator.ts`, `backtest.ts`, `bot/`, or the site. `desk/scripts/check.ts` lines 29–31 compare entry points to a hardcoded table, not to `site/swap.js`, so the site can drift without the check noticing.

The payout formula is implemented three times: `game/assembly/Kpred.ts` `claim` (lines 551–561), `bot/payout.ts`, and `site/app.js` `applyPots`. They match each other today. They do not match mainnet until C1 is resolved. The forecast model is a second copy, in `backtest.ts` and `generator.ts`, not a shared module.

Fix: run contract tests on pull requests. Add a small Node test that feeds a fixed block slice to `resolve` and checks option boundaries, voids, and hashes. Diff `site/swap.js` entry points against the desk ABI in CI. Keep one payout implementation and test the other two against it.

#### M9. The node installer trusts the snapshot host for both the file and the hash.

`node/setup-node.ps1` lines 105–137 download the newest object from `https://snapshots.armana.io/index.json` and check SHA-256 against `sha256` in that same JSON. A compromised snapshot host can ship a bad chain and a matching hash. `curl.exe` is passed `--ssl-no-revoke`. The Koinos node itself is `git clone` of `github.com/koinos/koinos` with no commit pin (line 57). The script also writes the producer address into `config.yml`.

Fix: pin a snapshot hash in this repo (or a second source) and pin the `koinos/koinos` commit. Drop `--ssl-no-revoke`, or limit it to a documented corporate-proxy case.

#### M10. There is no license.

No `LICENSE` file, and no `"license"` field in any `package.json`. The repo is public and takes deposits. Default copyright means nobody else can legally copy, fork, or audit-and-republish the contracts, and contributors have not granted you their copyright either. Several commits are attributed to "Claude" as well as the owner.

Fix: add a license you mean (MIT/Apache-2.0 if you want forks and outside review; proprietary if you do not) and a one-line copyright notice. Do this before asking outsiders to rely on the contracts.

#### M11. Ownership transfer is instant. This is documented, and it is still the sharpest admin action.

`propose_owner` / `accept_owner` (`Kpred.ts` lines 856–872) move `owner` with no delay. The new owner still waits 48 hours to change code, and still cannot withdraw player stake. They can immediately `set_operator`, `correct_question`, pause deposits, and take the fee. Combined with H1, a new owner who also waits out `close_delay` can lock a week.

Fix: store `pending_owner` with an `eta`, the same shape as the seed withdrawal. The bot already emails on `pending_owner` (`bot/bot.ts` lines 241–242); the contract should make that email a real delay.

### Low

#### L1. The clone is large because of a branch that is not `main`, plus two committed binaries.

`git verify-pack` on this clone: `probes/toolchain.zip` is 61,936,146 bytes, on `origin/toolchain` (commit `fb6460d`), not on `main`. A normal `git clone` still downloads every branch tip, which is why the repo is ~67 MB. On `main` itself the big files are `data/blocks-compact.csv.gz` (7.5 MB, intentional public history) and `site/media/get-on-koinos.mp3` (1.1 MB). Build output is gitignored. `.gitignore` does not mention `*.wasm` or `*.zip` globally; `game/.gitignore` covers that package's build.

Fix: delete the `toolchain` branch if the zip is only a local compiler cache, or replace it with a release URL. If the mp3 is required, leave it; it is not why the clone is 67 MB.

#### L2. `LAUNCH.md` publishes a local username and an old OneDrive path.

`LAUNCH.md` line 23 copies `.env` from `C:\Users\cpada\OneDrive\Desktop\kprediction-git\probes\.env`. GitHub Pages serves the whole repo, so that path is on the public site as well as on GitHub. `.env` itself is gitignored and was not in history.

Fix: replace the example with a generic path. Do not keep key files in a synced folder; the rest of that section already says so.

#### L3. Docs disagree with the code in smaller ways.

- Root README "How a day is built" (questions per day, day-7 count) does not match `generator.ts` lines 62–64. `LAUNCH.md` does.
- `docs/security-audit.md` still says 44 tests and "2% owner share" in places. The suite that passed here is 47 game tests and 25 desk tests.
- `game/SECURITY.md` says the live contract pays by headcount. It does not, until C1 is applied.
- Retired templates `E1`, `E2`, `H2`, `H2s` remain in `TEMPLATES` (`generator.ts` lines 300–317) and are not in the default menus.
- `export function _addr` at `Kpred.ts` line 1096 exists to silence an unused import.

Fix: one pass over the docs after the upgrade, and delete unused templates so nobody re-enables them by mistake.

#### L4. Typing and a few sharp edges.

There is no root `tsconfig.json` and no typecheck script. `bot/` uses `any` throughout. An ad-hoc strict check reported only `bot/chain.ts:58`. `bot/bot.ts` `gitCheckpoint` (lines 987–990) interpolates `dir` and `message` into `execSync` strings. Today's callers pass `game-data` and fixed messages, so this is not currently exploitable; it becomes one if a label is ever user-controlled.

`bot/watch.mjs` exits 0 with a notice when `PERSONAL_PRODUCER` is unset (lines 47–49), so a green watchdog does not mean the pool is up. The bot's own health check is what watches the game producer.

`sponsorOk` for `settle` (`Kpred.ts` lines 1039–1048) does not check the player's signature. `settle` is intentionally permissionless. The pool can be made to pay mana for those calls, capped by `max_sponsor_rc` (2 KOIN on chain). That is the documented grief limit, not a theft.

Integer rounding in `claim` can leave dust in `pots_outstanding`. It is bounded by about one base unit per claim and cannot be withdrawn as surplus. Not worth a contract change by itself.

Fix: add a `tsconfig` that CI runs with `tsc --noEmit`. Pass `git` arguments as an array (`spawnSync`) instead of a shell string. Make the watchdog fail, or not run, when the producer variable is missing.

#### L5. Performance is acceptable for the current size, with one linear cliff.

Hourly `syncBlocks` over ~25 days at concurrency 2 is the right shape. The backtest's full download (about 3.5 million blocks) is the slow path and is documented. `finalizeInternal` walks at most 64 score buckets. The site stops the leaderboard after 40 pages (`site/app.js` lines 246–250), i.e. 2,000 players, and the bot sends one settle transaction per staked player per week (`bot/bot.ts` lines 464–467). A few hundred players is fine inside the 180-minute job; a few thousand will start missing the hour.

Fix: nothing to change now. If the board grows, batch settles and paginate the site until `list_players` returns a short page, not a fixed 40.

## What held up

Reviewed and not found to be a bug:

- Deposits, withdrawals, answers, and claims require the player's authority (`Kpred.ts`). The desk's `swap` requires the VHP owner's authority (`Desk.ts` lines 196–201), so a leftover approval is not enough.
- `authorize` returns false for ordinary contract calls on both contracts, and both upgrade paths reject bytecode that turns off `authorizes_call_contract`, `authorizes_transaction_application`, or `authorizes_upload_contract`.
- Stake is subtracted before VHP is sent. Claims set `claimed` before the transfer. A second claim fails.
- Reward math rounds down at each step and `assertSolvent` runs after fee and reward payouts. The 8-week randomized test in `Kpred.spec.ts` passed.
- `init` on both contracts requires the contract key, once.
- Question windows are bounded so a huge `window_end` cannot wrap the "ends before the week closes" check (`Kpred.ts` lines 743–745).
- The site builds DOM with `createElement` / `textContent` for question text (`site/app.js` `linkify`). The one `innerHTML` is the QR code (M6).
- Desk fee rounds up by at most one unit (`feeOf`, `Desk.ts` lines 46–51), and `min_koin_out` fails the swap instead of paying a worse price.
- `.env` is gitignored. The bot reads keys from the environment only. `probes/.env.example` has empty values.
- Desk production wasm matches the recorded deploy hash, and the pending game upgrade hash matches a rebuild of HEAD.

## Prioritized action plan

Do these in order. The first one is time-sensitive because week 0 has started.

1. **Today: resolve C1.** Apply the announced upgrade or roll the website and bot back to the deployed rules before any question is resolved. Confirm with `get_state` (ABI wording and `upgrade.hash`). Update `wasmSha256` only after the upload is in a block.
2. **Before that upgrade is announced again: fix M1** if you still can cancel and re-announce. If you apply `917708a7…` as-is, file a follow-up to correct the "eligible stake" sentence; do not pretend the ABI text matches the code.
3. **Next contract change: H1**, with a test that a late resolve does not close the week. Ship M11 (owner-transfer delay) in the same upgrade if you can afford the delay.
4. **This week: H2.** Split the desk treasury from the owner key before the desk balance grows further.
5. **This week: H3 and M7.** Pin Actions SHAs, stop the bot from being able to push arbitrary files, pin `probes/package.json`, and do not build the toolchain on the machine that holds `OWNER_WIF`.
6. **Next: M2, M3, M4.** Turn off `E3`/`M9` or document them, reject bad block pages, and regenerate a rejected question file.
7. **Next: M5, M6, M8, M10.** Claims UI, CSP/SRI, CI on pull requests plus a resolver test, and a license.
8. **When convenient: L1–L5.** Delete or ignore the toolchain branch, scrub the Windows path, align the docs with the 47/25 test counts, add `tsc --noEmit`.

## Appendix: addresses and rebuild (was the previous `AUDIT.md`)

| Component | Code | Holds funds? |
|---|---|---|
| Game | `game/assembly/Kpred.ts`, `Tokens.ts`, `proto/kpred.proto` | Yes: stakes, seed, unpaid fees |
| Desk | `desk/assembly/Desk.ts`, `Tokens.ts`, `proto/desk.proto` | Yes: the desk's KOIN and VHP |
| Website | `site/` | No. Kondor or KOIN Vault signs. |
| Bot | `bot/` | No. `OPERATOR_WIF` posts and resolves only. |

System contracts: KOIN `19GYjDBVXU7keLbYvMLazsGQn3GTWHjHkK`, VHP `12Y5vW6gk8GceH53YfRkRre2Rrcsgw7Naq`, Proof-of-Burn `159myq5YUhhoVWu3wsHKHiJYKPKGUrGiyv`.

Rebuild (Node 22): `cd game && npm ci && npm test && npm run check`, then the same in `desk/`. Compare `sha256sum` of `build/release/contract.wasm` with `wasmSha256` in the deployment files. As of this audit those two comparisons do **not** both succeed: the desk matches, the game matches the pending upgrade hash rather than `wasmSha256`. See C1.

`Tokens.ts` uses an in-contract ledger only when `BUILD_FOR_TESTING=1`. The offline check refuses a release build that contains it.

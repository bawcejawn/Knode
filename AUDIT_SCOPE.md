# Audit scope

For an independent audit of the whole repository at the commit that adds this file (branch `audit-fixes-1`). This
is the version we intend to deploy.

## What Knode is

Knode is a weekly prediction game on Koinos. Each day (Monday to Saturday) the bot posts a few questions about what
the next blocks will show: how many blocks a producer signs, head-to-head counts between producers, gaps between
blocks, transactions, the share of empty blocks. Players stake VHP (or KOIN, burned into VHP) in the game contract
(Kpred), answer on chain, and at the end of the week the top 30% of staked players with at least one point split 95%
of the block rewards the pool earned with everyone's VHP (5% is a producer fee). Anyone can also play for free. Every
answer is computed from block data alone and published with a hash of the exact blocks used, so anyone can re-check
it; questions are voided when a producer they ask about goes offline or swings its VHP too much.

The Knode Swap desk (Desk contract) is a separate, live contract: a user sends VHP and receives KOIN in the same
transaction, 1:1 minus a fee (3% at launch), paid from KOIN that the desk's own block production refills; the
owner's withdrawals go only to a treasury address. The operator bot (`bot/`) runs every
hour on GitHub Actions: it posts and resolves questions, closes, finalizes and settles weeks, compounds rewards,
records VHP readings and emails the owner about anything unusual; it signs with the operator key, which can post
and resolve questions but cannot move funds. The site (`site/`, GitHub Pages) shows the questions and results and
lets players deposit, answer, withdraw and claim with the Kondor extension or KOIN Vault.

## Repository map

| Path | What it holds |
|---|---|
| `game/` | Kpred game contract (AssemblyScript, `assembly/Kpred.ts`), its proto, unit tests (`assembly/__tests__`), build and check scripts, the storage-compatibility test (`scripts/storage-compat.test.ts`) and the live code's test build (`test-fixtures/`) |
| `desk/` | Desk (Knode Swap) contract, tests, checks, `SECURITY.md` |
| `bot/` | Operator bot (`bot.ts`: tick, admin commands, rehearsal), Desk tools, health/Mana checks, status watcher, their tests |
| `resolver.ts`, `generator.ts`, `common.ts` | Question rules: scoring from blocks, the VHP-swing and offline voids, the decided block (`resolver.ts`); question release and models (`generator.ts`); block history and VHP reads (`common.ts`) |
| `backtest.ts`, `step0.ts`, `export-blocks.ts`, `data/` | Off-line analysis used to calibrate the questions (historical block data) |
| `game-data/` | Live game data published by the bot: `deployment.json`, `game.json` (settings), daily question files, bot state |
| `desk-data/` | Desk `deployment.json` |
| `site/`, `index.html` | Static website and wallet code (`site/app.js`, `site/wallet.js`) |
| `tests/audit/` | Attack and regression tests from earlier internal reviews (each asserts the safe behaviour) |
| `.github/workflows/` | `bot.yml` (hourly bot: `tick` job with the operator key, `publish` job that pushes `game-data/`), contract/desk/resolver/status test workflows, a workflow guard and a status watcher |
| `docs/` | `UPGRADE-2026-10.md` (the planned game upgrade runbook), migration notes, an idea note, an earlier security review |
| `probes/` | Testnet probe contract and scripts used before launch (not deployed by this version) |
| `node/` | Setup scripts for the owner's block-producing nodes |
| `README.md`, `LAUNCH.md`, `AUDIT.md` | Overview and rules, launch guide, an earlier review (historical: it describes an older commit) |

## Scope

The whole repository at this commit. Most security-sensitive:

- **Game contract** (`game/assembly/Kpred.ts`) and its **upgrade path**: `docs/UPGRADE-2026-10.md`, the 48-hour
  timelock, and storage compatibility with the live version (`game/scripts/storage-compat.test.ts`, which runs the
  live code's test build and the new code on the same storage).
- **Desk contract** (`desk/assembly/Desk.ts`), live, with its own known items below.
- **The bot** (`bot/bot.ts`): it signs with the operator key on a schedule, decides question results, and its sealed
  files (`game-data/bot-state.json`, VHP readings) drive alerts and voids.
- **GitHub workflows**: `bot.yml` (the `tick` job holds the operator key; the `publish` job holds the only write token
  and merges the bot's files into `main`), and the test/guard workflows.
- **Resolver rules** (`resolver.ts`): scoring, the offline void, the VHP-swing void and the decided block
  (`decidedHeight`, statistical cut-off `decidedChance`).
- **Site wallet handling** (`site/wallet.js`, `site/app.js`): Kondor and KOIN Vault signing, the question-file hash
  check, which outcome is shown, own-Mana claims, CSP and framing defences.

Out of scope: the owner's block-producing nodes themselves (run separately, only to produce blocks).

## Build and test from a fresh clone

Toolchain: Node 22 (CI uses `actions/setup-node` with 22), npm 10; pinned by the lockfiles: `@koinos/sdk-as` 1.5.1,
`@koinos/sdk-as-cli` 1.0.2, AssemblyScript 0.27.37, `@as-pect/cli` 8.1.0, `@roamin/protoc` 2.5.0, koilib 9.4.1,
`@koinos/mock-vm` 1.3.0, tsx 4.23.15. The first contract build needs network access: the protobuf tool installs a
few helper packages (e.g. `semver`) at build time.

```
git clone --branch audit-fixes-1 https://github.com/bawcejawn/Knode.git && cd Knode

# Game contract: tests + release build, test build, storage compatibility, offline check
cd game && npm ci && npm test && npm run build:sim
cd .. && npm ci && node --import tsx --test game/scripts/storage-compat.test.ts
cd game && npm run check && cd ..

# Desk contract
cd desk && npm ci && npm test && npm run check && cd ..

# Off-chain (resolver, attack/regression tests, bot incl. the workflow guard)
npm run test:resolver
node --import tsx --test --test-concurrency=1 tests/audit/*.test.ts tests/audit/*.test.mjs
node --import tsx --test --test-concurrency=1 bot/*.test.ts

# Two-week rehearsal on a simulated chain (no network, no keys); needs game/build/sim
npm run bot -- rehearse --weeks 2
#   the same against the live code: copy game/test-fixtures/kpred-live-test-build.wasm to game/build/sim/contract.wasm
```

Run the node tests one file at a time (`--test-concurrency=1`): run all at once on a busy machine, some of them start
`git`/`tsx` processes that can fail for lack of resources. A few publish-job tests need bash and git and are skipped on
Windows.

Expected release builds (sha256 of `build/release/contract.wasm`):

| Contract | sha256 |
|---|---|
| Game (new, this commit) | `565e7eefa37098cfe83f58ef279b08c8092bd798939f966049eb153df972bc6f` (54,405 bytes) |
| Game test build (`build/sim`, never deployed) | `d50f652e22f03a4cc2396487cbce1f13fee1cd027dc18ffd9e1ff94b1c9fd6ae` |
| Game, live code (commit `1c25791`) | `917708a7c567d9642a7a2f121c34fbc70200909787208705fc3aa5a2b1e6433a`; its test build is `game/test-fixtures/kpred-live-test-build.wasm` (`cce79208…`) |
| Desk | `05039d743d383538d0078a89e3bfde56e052c0eb478cf14dad63afd366b761e4` (30,276 bytes), the same as `desk-data/deployment.json` |

Verified from a fresh clone of this branch (Node 22.23.4, npm 10.9.9, Linux, `node:22-bookworm`): both release
hashes above; game 104/104 tests, desk 25/25, storage compatibility 1/1, `npm run check` 48 and 34 PASS (0 FAIL),
resolver 11/11, `tests/audit` 200 passed and 0 failed (4 open cases, listed below), bot 14/14, and both two-week
rehearsals (new and live test builds) 49/49.

## Deployments (mainnet)

| | |
|---|---|
| Game contract | `1Mpmf2ERhjYpX7CCiM11WERuM4j17uT1sr`, live build `917708a7…` (commit `1c25791`); the upgrade to `565e7eef…` is planned (`docs/UPGRADE-2026-10.md`) |
| Desk contract | `1FKTpXBhhHEbu5vVchM8UsVbAvPArJsRmR`, build `05039d74…` |
| Game genesis | 2026-10-19 00:00 UTC; week 7 days, close delay 12 h, settle 24 h, timelock 48 h, minimum stake 1 VHP, sponsored Mana cap 2 KOIN |
| Tokens | KOIN `19GYjDBVXU7keLbYvMLazsGQn3GTWHjHkK`, VHP `12Y5vW6gk8GceH53YfRkRre2Rrcsgw7Naq`, PoB `159myq5YUhhoVWu3wsHKHiJYKPKGUrGiyv` |

Everything else is in `game-data/deployment.json` and `desk-data/deployment.json`.

## Keys and roles

| Role | Address | Can | Key is meant to live |
|---|---|---|---|
| Game owner | `1635QUrBNDp7WqmFkRvrkGwjJXTtFvH717` | correct a result before its week closes (and void an open question), set the operator, pause new deposits, register the node key, claim the producer fee, change the minimum stake (from the next week), set the sponsored-Mana limits, propose a new owner (accepted only a day later), schedule an upgrade (48 h timelock) | Offline / the owner's PC only; never on GitHub or the bot machine |
| Seed owner | same wallet | add seed VHP/KOIN; withdraw it only after an announced 48 h timelock | same |
| Operator (bot) | `1JSTwoKYNAUq2gmmTg4r1kdYCERR2kUrZ` | post and resolve questions; the bot also pays Mana for some settles; cannot move funds | Only the GitHub environment `bot`, limited to `main` (also the owner's local `.env` for manual runs) |
| Desk owner | same wallet as the game owner | fee (at most 10%), swap limits, pause, node key, withdraw to the treasury, schedule a treasury change or an upgrade (48 h timelock) | Offline / the owner's PC only |
| Desk treasury | same wallet as the game owner | receives every Desk withdrawal | Planned: a cold wallet |

Today one wallet holds the game owner, the seed owner, the Desk owner and the Desk treasury. Splitting the seed owner
off, and moving the Desk treasury to a cold wallet, are planned. Players' stakes and rewards can't be moved by any of
these roles; withdrawals can never be paused.

## Known and accepted items

- **Open test case FC3-VHP-2** (`tests/audit/vhp-decided.fc3.test.ts`): a borrowed VHP boost that decides a question
  before the bot's first hourly reading is not checked, because readings count only up to the decided block (owner's
  rule).
- **Open test case WEB3-23** (`tests/audit/web3.own-mana.test.mjs`): KOIN Vault has no documented way to ask for the
  player's own Mana, so the page keeps `mana: "auto"` and shows the player a notice when a claim should use their own
  Mana.
- **Open test case WEB3-31** (`tests/audit/web3.params-hash-canon.test.mjs`): questions posted before `hashRule` 2 have
  an on-chain hash that never covered their wording; the site does not offer them for answering instead.
- **Open test case S2** (`tests/audit/site.web2.test.mjs`): the wallet pages are served from the shared
  `<user>.github.io` origin until the site gets a custom domain (owner action).
- **`PREVIOUS_OPERATOR_WIF` is for local runs only**: after rotating the operator key while a VHP window is open, the
  bot holds those questions until it is run once on the owner's PC with the old key; GitHub holds only `OPERATOR_WIF`.
- **Desk, next Desk upgrade** (`desk/SECURITY.md`): the treasury timelock protects nothing while the treasury is the
  owner wallet (until it moves to a cold wallet); announced upgrades and treasury changes do not expire after their
  timelock.
- **Game, next contract upgrade** (not in `565e7eef…`): the sponsored-claim check can approve a claim whose compounding
  burns the Mana the transaction itself needs (the site makes players pay their own Mana for claims in that state);
  a late first result (the owner voiding a still-open question) reopens corrections for that whole week.
- **Disclosed rules**: anyone can influence results (sending transactions, staking, moving VHP; the project's own
  producers can be question subjects); a VHP-swing void can be triggered by third parties; readings are hourly samples.
- **Disclosed owner powers**: voiding open questions and correcting results until 21 h after the week ends;
  minimum-stake changes apply only from the next week; pausing new deposits (never withdrawals or claims); code
  upgrades and seed withdrawals only after a 48 h public timelock.

## Previous review

Internal automated reviews were run on this code. Their attack and regression tests are in the repository
(`tests/audit/`, and contract specs under `game/assembly/__tests__/` and `desk/assembly/__tests__/`); each asserts the
safe behaviour. `AUDIT.md` and `docs/security-audit.md` are earlier review documents about older commits.

## Reporting findings

Please report findings privately to the owner, not as public GitHub issues or pull requests: the repository is public
and the game is live on mainnet.

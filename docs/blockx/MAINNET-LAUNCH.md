# Who Signs Block X: mainnet launch (PowerShell)

Order matters. Nothing here starts until the Repo Lens findings are fixed and fix-checked (Block X **and** sponsor v3),
because changing a contract after upload means a new upload.

| # | Step | Who | Wait |
|---|---|---|---|
| 1 | Repo Lens audit → Claude fixes → Repo Lens fix-check (Part A Block X, Part B sponsor v3) | you + Claude | – |
| 2 | Claude allows the v3 build on mainnet in the tool (only after the fix-check) | Claude, with your OK | – |
| 3 | Build in a clean copy with no keys (audit BX-6) | you | – |
| 4a | Knode Swap pays its own Mana: `payer sponsor --send`, a pull request to `main` | you + Claude | a few minutes |
| 4 | Upgrade the Mana sponsor to v3 (dry-run its settings) | you | – |
| 5 | Upload the Picks contract; `status` on two nodes; retire the Picks key (audit BX-9) | you | minutes |
| 6 | Sponsor covers Picks: `payer sponsor`, a pull request to `main`, then `config` (audit BX-12, SP-8) | you + Claude | a few minutes |
| 7 | Announce game 2 | you | **48 hours** |
| 8 | Apply game 2 | you | – |
| 9 | Publish: `PINNED_PICKS` in `wallet.js`, merge `picks` into `main`, recorder on | Claude, with your OK | – |

Prizes (2 / 1 VHP) start when the Knode Games vault (v6) is live; until then the boards run without prizes.

**Split launch (owner, 2026-10-30):** the contracts go up once the short round-6 check of the round-5 fixes is clean
(Repo Lens round 5: sponsor contract ready, unchanged). Block X goes live prize-free. Its scoring runs off-chain (the
recorder and the publish job), so any later scoring finding is fixed there, without a new upload, before Vault v6
prizes start.

Every mainnet send needs `CONFIRM_MAINNET=yes` in `.env`; the Picks tool also needs `--mainnet` on the command line.

## 3. Build in a clean copy (no `.env` there)

The build runs other people's code (npm packages, protoc). Do it in a folder that holds no keys, then copy only the
`.wasm` files across. Both versions are pinned (protobufjs helpers by lockfile, protoc 21.12 by sha256), and install
scripts stay off. The contract build needs yarn 1.x installed once on the PC (`npm install -g yarn@1.22.22`; audit
BX-52). If a test run stops with `EAGAIN: resource temporarily unavailable`, that's Windows/Node being busy: run the
same `npm test` again.

```powershell
cd C:\
git clone --branch picks https://github.com/bawcejawn/Knode.git C:\knode-build
cd C:\knode-build\picks
npm ci --ignore-scripts
npm test
npm run check
cd C:\knode-build\sponsor
npm ci --ignore-scripts
npm test
npm run check
cd C:\knode-build
certutil -hashfile picks\build\release\contract.wasm SHA256
certutil -hashfile sponsor\build\release\contract.wasm SHA256
```

The two hashes must be:

- Picks `700c296a1064b904299c156061d6caf8fcabd0b1765968903f29d89d2426c594`
- Sponsor v3 `b61ac238da27c4a71c01127f39a7b95f19fabf15e35df9f9715546d221e256e4`

(or the new ones Claude gives you after the fix-check). If either differs, stop. Then copy the builds into your
working folder (the one with `.env`):

```powershell
cd C:\kprediction
git checkout picks
git pull
copy C:\knode-build\picks\build\release\contract.wasm C:\kprediction\picks\build\release\contract.wasm
copy C:\knode-build\sponsor\build\release\contract.wasm C:\kprediction\sponsor\build\release\contract.wasm
certutil -hashfile picks\build\release\contract.wasm SHA256
certutil -hashfile sponsor\build\release\contract.wasm SHA256
```

Same two hashes again. Don't install or build the contracts in `C:\kprediction`; the tools there only read the `.wasm`.

## 4a. Knode Swap uses players' own Mana first (owner, 2026-10-29)

Sponsor v3 never pays for swaps, so the live swap page must stop asking the sponsor BEFORE v3 goes on (otherwise
swaps would be refused until the page changes). The upload refuses while it still asks.

```powershell
cd C:\kprediction
npm run sponsor -- payer sponsor
npm run sponsor -- payer sponsor --send
```

That edits `game-data/deployment.json` (game pages: the sponsor pays) and `desk-data/deployment.json` (Knode Swap:
players' own Mana). Tell Claude "payer files ready": Claude opens the pull request to `main` for your OK. Once it is
merged, wait 5 minutes, then step 4.

## 4. Mana sponsor v3

The sponsor wallet should hold at least 25,000 KOIN (its Mana covers 5,000 a day). If it holds less, choose a smaller
`--per-day` below (the hourly check warns when the wallet's Mana is below what today's caps still allow).

```powershell
cd C:\kprediction
npm run sponsor -- status
npm run sponsor -- upload
```

The dry run must name the v3 build `b61ac238…` and show **Knode Swap page: Mana paid by self**. Then:

```powershell
npm run sponsor -- upload --send
npm run sponsor -- status
```

`status` must show the v3 code. Check the settings the sponsor will get (a dry run: nothing is sent):

```powershell
npm run sponsor -- config --per-tx 1 --per-player-day 25 --per-player-week 150 --per-day 5000 --free-per-day 2000 --min-vhp 1
```

(25 a day and 150 a week for every wallet, free or staked: owner, 2026-10-29.) These are also the defaults, so a plain `config` gives the same (audit SP-1: the tool never keeps old values just
because they are on chain); every line shows `old → new`. **No per-action Mana limit yet** (owner, 2026-10-28; audit
SP-4) except the Picks `pick` at 0.2 Mana, set in step 6 (owner, 2026-10-30): every other action may ask up to 1 Mana
until a full day of real mainnet use has been measured (step 10). The `--send`
comes in step 6, once the Picks contract exists. The dry run also shows **vault (v6) live: no** (audit SP-37: until
the vault is live the sponsor asks the game only for a question-game stake).

**On Vault v6 day (audit SP-49):** right after the v6 upload the game still answers "not live" until **v6's first
transaction** (its first write sets the rule). So, after that first v6 transaction, run `config` **with your caps**
(a plain `config` resets them to the defaults):

```powershell
cd C:\kprediction
npm run sponsor -- status
npm run sponsor -- config --per-tx 1 --per-player-day 25 --per-player-week 150 --per-day 5000 --free-per-day 2000 --min-vhp 1
```

(Use the caps `status` shows, if you changed them.) Check it says **vault (v6) live: no → yes** and that every cap
line is unchanged, then run the same line with `--send`. A stake in Block X, the Race and the other games then counts
and the vault's own calls are paid. If this is missed, `status` warns: "the game is Vault v6 now, but the sponsor
still treats it as v5". The Vault v6 chat has the same step for its upgrade runbook (project doc `claude/handoff-sponsor-v6-day.md`).

**Rollback (audit SP-13):** (and SP-53) if anything ever goes wrong with v3, first switch the sponsor **off while v3 is
still on chain** (after the v2 upload, v2 refuses the 5,000-a-day settings v3 stored until `config` runs, so a stop
then would fail). Then put the v2 build `fa4659e6…` into `sponsor\build\release\contract.wasm`, upload it, and send
v2's settings with caps v2 accepts (v2 refuses an everyone-per-day cap above 1,000 Mana, and the free pool can't be
above it):

```powershell
cd C:\kprediction
npm run sponsor -- disable
npm run sponsor -- disable --send
npm run sponsor -- upload --send
npm run sponsor -- config --per-tx 1 --per-player-day 25 --per-player-week 150 --per-day 1000 --free-per-day 1000 --min-vhp 1
npm run sponsor -- config --per-tx 1 --per-player-day 25 --per-player-week 150 --per-day 1000 --free-per-day 1000 --min-vhp 1 --send
```

(The tool sees v2 code and sends v2's settings, without the Picks row and per-action limits.) The website keeps
working with v2: it still marks free play for v2 (audit SP-40). Block X picks are then not sponsored (players pay their
own Mana) until v3 is back.

**Emergency stop (audit SP-44):** `npm run sponsor -- disable`, then `disable --send`, switches the sponsor off and
changes nothing else when the second node shows the same settings. If the preview says the second node doesn't agree,
it shows the settings it would rebuild (caps never looser than now, no per-action limits while off) and sends them only
with `npm run sponsor -- disable --rebuilt --send`. Before switching back on (`enable`), check the caps with `status`.

## 5. Upload the Picks contract

```powershell
cd C:\kprediction
npm run picks -- keys
```

This adds `PICKS_WIF` (a brand-new wallet) to `.env` and prints its address. **Send it no KOIN.** The upload refuses a
Picks wallet that holds KOIN or has sent anything (audit BX-22). The upload's Mana is paid by `PAYER_WIF` if set, else
the bot wallet `OPERATOR_WIF`. A separate `PAYER_WIF` is better: a bot transaction at the same moment can't take the
same nonce (audit BX-34; if that happens, nothing is sent and you run it again).

```powershell
npm run picks -- upload --mainnet
```

A dry run: the code line says "the audited mainnet build" and **Mana paid by** shows enough Mana (the testnet upload
used 2.8). Then:

```powershell
npm run picks -- upload --send --mainnet
npm run picks -- status --mainnet
```

`status` reads **two nodes** (koinos.armana.io and api.koinosblocks.com) and must show on both: **Code ✔ (the
expected build)**, **Overrides ✔ all three ON** and **Owner 1635QUrBNDp7WqmFkRvrkGwjJXTtFvH717 ✔**. Copy that output
into `docs/blockx/TESTNET-RESULTS.md` under "Mainnet upload" (or send it to Claude to record).

Retire the Picks key (audit BX-9): once the contract is on, the key has no power left, but nobody needs it either.
Open `.env` in Notepad, delete the `PICKS_WIF=` line, save. Send Claude the contract address; Claude commits
`picks-data/deployment.json`.

## 6. The sponsor covers Block X picks (audit BX-12)

First the Picks `pick` row: **0.2 Mana per pick** (owner, 2026-10-30, from the testnet Combo Card measurements: a
single Block X pick 0.0477, a 10-leg card 0.0916; 0.1 left too little room for a 10-leg card). The number the tool
checks it against is what a **sponsored** pick used on testnet, 0.116 (the sponsor's own reads add about 0.05 to 0.07;
audit SP-54): 0.2 is 1.7 × that. The mainnet Picks release has no Combo cards yet; **before Combo cards go live, measure
one sponsored 10-leg card on testnet** (about 0.145 to 0.16 expected) and, if it is above 0.16, set the row to 0.25.
This needs the `picks-data/deployment.json` the Picks upload (step 5) wrote:

```powershell
cd C:\kprediction
npm run sponsor -- mana-limit picks:pick 0.116 --source "testnet sponsored Block X pick 2026-10-30" --limit 0.2
npm run sponsor -- mana-limit picks:pick 0.116 --source "testnet sponsored Block X pick 2026-10-30" --limit 0.2 --save
npm run sponsor -- payer sponsor
npm run sponsor -- payer sponsor --send
```

The first line must say **limit 0.2 Mana (as you set it with --limit)**. That writes `sponsor-data/mana-limits.json`,
then `game-data/deployment.json` and `desk-data/deployment.json` on your PC: the sponsor block now covers the Picks
contract, its `rcLimits` asks 0.2 Mana for a pick, and other actions ask 1 Mana (audit SP-17). Every other action has
no row of its own yet (it may ask up to the 1 Mana cap) until step 10. The live site is served from `main`, so these two files
go there by a pull request: tell Claude "payer files ready" and Claude opens it for your OK (or push them on a branch
and open it yourself). Once it is merged, wait 5 minutes, then:

```powershell
npm run sponsor -- config --send
npm run sponsor -- status
```

`config --send` reads the website **as deployed on knodegames.com** and refuses while it would ask for more Mana than
the sponsor allows (audit SP-8); if it does, wait a few more minutes and run it again. Its preview must show the
per-action limit **KnodeGames Picks pick 0.2 Mana**. `status` must show the caps, the Picks `pick` row, and "free
players share 2000 Mana a day, released by the hour". Commit `sponsor-data/mana-limits.json` with the payer files.

## 7–8. Register Who Signs Block X (game 2)

These need the owner key (`OWNER_WIF` for `1635QUr…H717`) in `.env`. Each one first re-checks the contract's code and
overrides on both nodes, and stops if anything is off.

```powershell
npm run picks -- announce 2 --send --mainnet
```

Wait 48 hours. Then:

```powershell
npm run picks -- status --mainnet
npm run picks -- apply 2 --send --mainnet
npm run picks -- status --mainnet
```

The last `status` must list **2 Who Signs Block X: ON, every 2400 blocks, locks 100 before**.

## 9. Publish (Claude, with your OK)

- `PINNED_PICKS` in `wallet.js` set to the contract address (guest picks then go only there).
- Merge `picks` into `main`; the hourly recorder and the race VHP samples start with it.
- Audit BX-60: race cards made before the round-3 fixes have no sample count and are never used by Block X, so merge
  at least 6 hours before game 2 goes on (the samples and cards need that long to fill), or expect the first targets to
  be voided ("no handicap card").
- Audit BX-59: the recorders refuse to run on one node; the workflows set `RPC_CHECK` (`api.koinosblocks.com` by
  default). `ALLOW_ONE_NODE=yes` exists only for an emergency and prints a warning every run.
- Prizes start with the vault (v6) and `PRIZES_FROM_WEEK`.

## 10. After a full day of play: per-action Mana limits

```powershell
cd C:\kprediction
npm run sponsor -- mana-report
npm run sponsor -- mana-report --save
npm run sponsor -- site-limits --send
```

`mana-report` reads every sponsored transaction of the last day on two nodes, and suggests a limit only for actions
with at least 20 measured transactions (2 × the most used). Run it again a day after the sponsor's vault switch goes on (v6 day):
the sponsor then makes one more read per transaction, and the Picks `pick` row's 0.2 Mana is 2.2 × a testnet number
(blind review, round 5). `site-limits --send` writes the website's copy: Claude
opens the pull request to `main`; once merged and live, `npm run sponsor -- config --send`.

## Every hour

The hourly bot run shows a warning when the free pool (as released so far today) or everyone's total passes 80%
(`npm run sponsor -- watch`; owner, 2026-10-28). Check it now and then: if free Mana drains fast, lower
`--per-player-day` or `--free-per-day`.

## Correcting published Block X history by hand (audit BX-108)

Published week files are append-only: the publish job holds any run that changes a published target. If a target
ever has to be corrected (a recorder bug, say), that is a manual, reviewed edit of the `games-data` branch: Claude
prepares the corrected `blockx/W<week>.json` (and the board), you check the difference, and it is pushed to
`games-data` by hand. The next hourly run then builds on it. Never weaken the publish check for this.

**Deploying recorder changes (audit BX-103):** merge them outside the 6 hours before a Block X target's lock that
matters to you; samples written by an older recorder still count for up to 6 hours.

## If something looks wrong

```powershell
npm run picks -- pause 2 --send --mainnet
```

switches the game off at once (picks already made stay recorded). Switching it back on needs a new announcement and
the 48-hour wait. The sponsor can stop paying at once with `npm run sponsor -- disable --send`.

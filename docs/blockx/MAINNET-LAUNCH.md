# Who Signs Block X: mainnet launch (PowerShell)

Order matters. Nothing here starts until the Repo Lens findings are fixed and fix-checked (Block X **and** sponsor v3),
because changing a contract after upload means a new upload.

| # | Step | Who | Wait |
|---|---|---|---|
| 1 | Repo Lens audit → Claude fixes → Repo Lens fix-check (Part A Block X, Part B sponsor v3) | you + Claude | – |
| 2 | Claude allows the v3 build on mainnet in the tool (only after the fix-check) | Claude, with your OK | – |
| 3 | Build in a clean copy with no keys (audit BX-6) | you | – |
| 4 | Upgrade the Mana sponsor to v3 (dry-run its settings) | you | – |
| 5 | Upload the Picks contract; `status` on two nodes; retire the Picks key (audit BX-9) | you | minutes |
| 6 | Sponsor covers Picks: `payer sponsor`, a pull request to `main`, then `config` (audit BX-12, SP-8) | you + Claude | a few minutes |
| 7 | Announce game 2 | you | **48 hours** |
| 8 | Apply game 2 | you | – |
| 9 | Publish: `PINNED_PICKS` in `wallet.js`, merge `picks` into `main`, recorder on | Claude, with your OK | – |

Prizes (2 / 1 VHP) start when the Knode Games vault (v6) is live; until then the boards run without prizes.

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
- Sponsor v3 `3cdab1a75f066f0c65b09597ad8f35cf1b6e02fc2a37327bbf479db9a03b71a3`

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

## 4. Mana sponsor v3

The sponsor wallet should hold at least 25,000 KOIN (its Mana covers 5,000 a day).

```powershell
cd C:\kprediction
npm run sponsor -- status
npm run sponsor -- upload
```

The dry run must name the v3 build `3cdab1a7…`. Then:

```powershell
npm run sponsor -- upload --send
npm run sponsor -- status
```

`status` must show the v3 code. Check the settings the sponsor will get (a dry run: nothing is sent):

```powershell
npm run sponsor -- config --per-tx 1 --per-player-day 50 --per-player-week 300 --per-day 5000 --free-per-day 2000 --min-vhp 1
```

These are also the defaults, so a plain `config` gives the same (audit SP-1: the tool never keeps old values just
because they are on chain); every line shows `old → new`. **No per-action Mana limit yet** (owner, 2026-10-28; audit
SP-4): every action may ask up to 1 Mana until a full day of real mainnet use has been measured (step 10). The `--send`
comes in step 6, once the Picks contract exists. If anything ever goes wrong with v3, `upload --send` with the v2
build `fa4659e6…` is the rollback (audit SP-13).

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

```powershell
cd C:\kprediction
npm run sponsor -- payer sponsor
npm run sponsor -- payer sponsor --send
```

That edits `game-data/deployment.json` and `desk-data/deployment.json` on your PC: the sponsor block now covers the
Picks contract, and other actions ask 1 Mana (audit SP-17). The live site is served from `main`, so these two files
go there by a pull request: tell Claude "payer files ready" and Claude opens it for your OK (or push them on a branch
and open it yourself). Once it is merged, wait 5 minutes, then:

```powershell
npm run sponsor -- config --send
npm run sponsor -- status
```

`config --send` reads the website **as deployed on knodegames.com** and refuses while it would ask for more Mana than
the sponsor allows (audit SP-8); if it does, wait a few more minutes and run it again. `status` must show the caps,
the Picks `pick` row, and "free players share 2000 Mana a day, released by the hour".

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
- Prizes start with the vault (v6) and `PRIZES_FROM_WEEK`.

## 10. After a full day of play: per-action Mana limits

```powershell
cd C:\kprediction
npm run sponsor -- mana-report
npm run sponsor -- mana-report --save
npm run sponsor -- site-limits --send
```

`mana-report` reads every sponsored transaction of the last day on two nodes, and suggests a limit only for actions
with at least 20 measured transactions (2 × the most used). `site-limits --send` writes the website's copy: Claude
opens the pull request to `main`; once merged and live, `npm run sponsor -- config --send`.

## Every hour

The hourly bot run shows a warning when the free pool (as released so far today) or everyone's total passes 80%
(`npm run sponsor -- watch`; owner, 2026-10-28). Check it now and then: if free Mana drains fast, lower
`--per-player-day` or `--free-per-day`.

## If something looks wrong

```powershell
npm run picks -- pause 2 --send --mainnet
```

switches the game off at once (picks already made stay recorded). Switching it back on needs a new announcement and
the 48-hour wait. The sponsor can stop paying at once with `npm run sponsor -- disable --send`.

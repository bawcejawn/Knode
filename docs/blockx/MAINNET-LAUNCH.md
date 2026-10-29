# Who Signs Block X: mainnet launch (PowerShell)

Order matters. Nothing here starts until the Repo Lens findings are fixed and fix-checked (Block X **and** sponsor v3),
because changing a contract after upload means a new upload.

| # | Step | Who | Wait |
|---|---|---|---|
| 1 | Repo Lens audit → Claude fixes → Repo Lens fix-check (Part A Block X, Part B sponsor v3) | you + Claude | – |
| 2 | Claude allows the v3 build on mainnet in the tool (only after the fix-check) | Claude, with your OK | – |
| 3 | Build in a clean copy with no keys (audit BX-6) | you | – |
| 4 | Upgrade the Mana sponsor to v3, then set its limits | you | – |
| 5 | Upload the Picks contract; `status` on two nodes; retire the Picks key (audit BX-9) | you | minutes |
| 6 | Sponsor covers Picks: `payer sponsor`, `site-limits`, `config` (audit BX-12) | you | a few minutes |
| 7 | Announce game 2 | you | **48 hours** |
| 8 | Apply game 2 | you | – |
| 9 | Publish: `PINNED_PICKS` in `site/wallet.js`, merge `picks` into `main`, recorder on | Claude, with your OK | – |

Prizes (2 / 1 VHP) start when the Knode Games vault (v6) is live; until then the boards run without prizes.

Every mainnet send needs `CONFIRM_MAINNET=yes` in `.env`; the Picks tool also needs `--mainnet` on the command line.

## 3. Build in a clean copy (no `.env` there)

The build runs other people's code (npm packages, protoc). Do it in a folder that holds no keys, then copy only the
`.wasm` files across. Both versions are pinned (protobufjs helpers by lockfile, protoc 21.12 by sha256), and install
scripts stay off.

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
cd C:\knode-build
certutil -hashfile picks\build\release\contract.wasm SHA256
certutil -hashfile sponsor\build\release\contract.wasm SHA256
```

The two hashes must be:

- Picks `700c296a1064b904299c156061d6caf8fcabd0b1765968903f29d89d2426c594`
- Sponsor v3 `21bec82583e1a7decbb2c70376f4b08e026f617c32bca268ab700f50e9aef2df`

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

The dry run must name the v3 build `21bec825…`. Then:

```powershell
npm run sponsor -- upload --send
npm run sponsor -- status
```

`status` must show the v3 code. Now the caps (5,000 a day for everyone, 2,000 of it for free play, 50 per player per
day, 300 per week) and the first per-action limit, the Block X pick measured on the testnet (0.0477 for one pick):

```powershell
npm run sponsor -- mana-limit picks:pick 0.0477 --source "testnet 2026-10-28" --save
npm run sponsor -- config
```

Check the dry run, then `config --send` comes in step 6, once the Picks contract exists.

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
npm run sponsor -- payer sponsor
npm run sponsor -- payer sponsor --send
npm run sponsor -- site-limits --send
git add game-data/deployment.json desk-data/deployment.json sponsor-data/mana-limits.json
git commit -m "Sponsor pays Block X picks"
git push
```

Wait 5 minutes (the site picks up the new limits), then put them on chain:

```powershell
npm run sponsor -- config --send
npm run sponsor -- status
```

`status` must list the Picks `pick` row and the caps. `config --send` refuses if the website would still ask for more
Mana than the new limits; if it does, wait a few more minutes and run it again.

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

- `PINNED_PICKS` in `site/wallet.js` set to the contract address (guest picks then go only there).
- Merge `picks` into `main`; turn on the hourly recorder.
- Before the first prize week: the decisions on BX-2 (free-play prize rule) and BX-1 (guest play on the shared
  github.io address, until knodegames.com is live).

## If something looks wrong

```powershell
npm run picks -- pause 2 --send --mainnet
```

switches the game off at once (picks already made stay recorded). Switching it back on needs a new announcement and
the 48-hour wait. The sponsor can stop paying at once with `npm run sponsor -- disable --send`.

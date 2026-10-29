# Who Signs Block X: mainnet launch (PowerShell)

Order matters. Nothing here starts until the audit's findings are fixed and fix-checked, because changing the
contract after upload means a new upload.

| # | Step | Who | Wait |
|---|---|---|---|
| 1 | Repo Lens audit → Claude fixes → Repo Lens fix-check | you + Claude | – |
| 2 | Mana sponsor v3 live, so free players and guests can pick for free | you | – |
| 3 | Upload the Picks contract to mainnet | you | minutes |
| 4 | Sponsor: allow `pick` on the new Picks contract | you | – |
| 5 | Announce game 2 | you | **48 hours** |
| 6 | Apply game 2 | you | – |
| 7 | Publish: pin the contract in the site, merge `picks` into `main`, turn on the recorder | Claude, with your OK | – |

Prizes (2 / 1 VHP) start when the Knode Games vault (v6) is live; until then the boards run without prizes.

## 3. Upload (mainnet)

```powershell
cd C:\kprediction
git checkout picks
git pull
cd picks
npm ci
npm test
cd ..
certutil -hashfile picks\build\release\contract.wasm SHA256
```

The last line must print `700c296a1064b904299c156061d6caf8fcabd0b1765968903f29d89d2426c594` (or the new hash after
the audit fixes, which Claude will give you). If it doesn't, stop.

```powershell
npm run picks -- keys
```

This adds `PICKS_WIF` (a brand-new wallet) to `.env` and prints its address. **Send it no KOIN.** Once the contract is
on it, it refuses to move anything out, so any KOIN there would be stuck for good. The upload's Mana is paid by your
bot wallet (`OPERATOR_WIF`, which already holds KOIN).

```powershell
npm run picks -- upload
```

A dry run: check the code line says "the audited mainnet build" and the **Mana paid by** line shows the bot wallet
with enough Mana (the testnet upload used 2.8). Then:

```powershell
npm run picks -- upload --send --mainnet
npm run picks -- status
```

`status` must show **Code ✔ (the expected build)**, **Overrides ✔ all three ON** and **Owner
1635QUrBNDp7WqmFkRvrkGwjJXTtFvH717 ✔**. Send Claude the printed contract address. The upload writes
`picks-data\deployment.json`; Claude commits it.

## 5–6. Register Who Signs Block X (game 2)

These need the owner key (`OWNER_WIF` for `1635QUr…H717`) in `.env`.

```powershell
npm run picks -- announce 2 --send --mainnet
```

Wait 48 hours. Then:

```powershell
npm run picks -- status
npm run picks -- apply 2 --send --mainnet
npm run picks -- status
```

The last `status` must list **2 Who Signs Block X: ON, every 2400 blocks, locks 100 before**.

## If something looks wrong

```powershell
npm run picks -- pause 2 --send --mainnet
```

switches the game off at once (picks already made stay recorded). Switching it back on needs a new announcement and
the 48-hour wait.

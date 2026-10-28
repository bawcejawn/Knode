# Who Signs Block X on the testnet: runbook (PowerShell)

Everything here runs on the **Koinos Foundation testnet** (`https://testnet.koinosfoundation.org`, the testnet
SwarmTales uses) with **test KOIN only**. Nothing touches mainnet, the live Knode Games site or your mainnet keys:

- testnet keys live in `.env.testnet`, never `.env`;
- every send is a dry run until you add `--send`;
- the tools refuse a node that reports the mainnet chain id.

All commands run in `C:\kprediction` in PowerShell.

> **Never paste a private key (WIF) into a chat, an issue or GitHub**, testnet ones included. The tools print
> addresses only.

## 0. Get the code (once)

```powershell
cd C:\kprediction
git fetch origin
git checkout picks
git pull
npm ci
cd picks; npm ci; npm test; cd ..
```

`npm test` in `picks` must end with `46 / 46` and `✔ Pass!`.

## 1. Make the testnet keys (once)

```powershell
npm run bot -- keys --testnet       # OWNER_WIF (test owner), PLAYER_WIF (test player) and others, in .env.testnet
npm run picks -- keys --testnet     # PICKS_WIF: the brand-new wallet that becomes the testnet Picks contract
```

Both print **addresses**. Note three of them: the Picks wallet, the admin (owner) and the player. (The bot's message
mentions a Discord faucet; that's out of date. Use the Telegram bot below.)

## 2. Get test KOIN

In Telegram, open **@KoinosTestnetFaucetBot** and send, for each of the three addresses:

```
/faucet <address>
```

Each claim gives 100 test KOIN (one claim per address per day). The upload needs about 20 test KOIN of Mana on the
Picks wallet. Announcing, applying and test picks need a few each.

## 3. Build the testnet contract

```powershell
npm run picks -- build-testnet --testnet
```

This compiles the audited source with exactly three lines changed: your test owner, 10-minute waits instead of 48
hours, and 24 hours to apply instead of 7 days. It first proves that an untouched copy rebuilds to the audited
sha256 `700c296a…`. It writes `picks\build\testnet\contract.wasm` and `manifest.json`.

## 4. Upload it

```powershell
npm run picks -- upload --testnet           # dry run: shows the wallet, the code, the Mana
npm run picks -- upload --testnet --send    # uploads, then checks the code hash and the three overrides on chain
npm run picks -- status --testnet
```

`status` must show:

- **Code** `✔ (the expected build)`;
- **Overrides** `✔ all three ON`;
- **Owner** `✔`.

The upload saves the contract address to `testnet\blockx.json`.

## 5. Register the two games

| Game | Target every | Use |
|---|---|---|
| **2** "Who Signs Block X" | 2,400 blocks (~2 h) | the real mainnet settings |
| **92** "Block X fast test" | 300 blocks (~15 min) | quick testing; up to 50 picks a day |

```powershell
npm run picks -- announce 2 --testnet --send
npm run picks -- announce 92 --testnet --send
# wait 10 minutes
npm run picks -- status --testnet           # shows "ready now" for both
npm run picks -- apply 2 --testnet --send
npm run picks -- apply 92 --testnet --send
```

## 6. Play it on your own computer (no GitHub needed)

```powershell
npm run testnet-site -- --record
```

Leave that window open: it records results every 5 minutes. Then open in your browser:

- http://127.0.0.1:8350/site/blockx-testnet.html#game-92 (fast game)
- http://127.0.0.1:8350/site/blockx-testnet.html#game-2 (real settings)

Click **Connect a testnet wallet**, then **Make a Test wallet**, then **Copy my address**. Get test KOIN for it from
the faucet bot, then pick. (Kondor works too if it's switched to the testnet. If it keeps asking to "Refresh check",
use the Test wallet.)

The server only listens on your own computer (127.0.0.1) and only serves the page, its settings and the results. It
never serves `.env.testnet`. Stop it with **Ctrl+C**.

## 7. The two measurements

```powershell
npm run picks -- lock-test 92 --testnet --send    # ~5 min: one pick per block across a lock
npm run picks -- mana-test 92 --testnet --send    # 1, 3 and 7 picks in one transaction each
```

- **lock-test** must end with `✔ the contract sees the height of the block a pick lands in` and `✔ no pick was
  applied at or after the lock`.
- **mana-test** prints the Mana per pick. That number sizes the sponsor's per-pick limit.

Both save a file in `testnet-data\`. Send me the printed lines (never the `.env.testnet` file).

## 8. Optional: put it online for other testers

This needs your OK, because it changes GitHub:

1. Merge the `picks` branch into `main`. The testnet page then lives at
   `https://bawcejawn.github.io/Knode/site/blockx-testnet.html`. It is not linked from any page and not in search.
   The mainnet pages don't change.
2. Commit `testnet\blockx.json` (the contract address the upload wrote).
3. GitHub → **Settings → Secrets and variables → Actions → Variables → New variable**:
   `TESTNET_GAMES_ENABLED` = `true`.
4. **Actions → "Block X testnet recorder" → Run workflow.** From then on it runs every 20 minutes and publishes to
   the `testnet-data` branch.

## Stop or undo

| What | How |
|---|---|
| Stop a game | `npm run picks -- pause 92 --testnet --send` (at once) |
| Stop the online recorder | delete `TESTNET_GAMES_ENABLED` (or set it to `false`) |
| Start over | `npm run picks -- keys --testnet` won't replace an existing PICKS_WIF. Delete that line from `.env.testnet` to make a new Picks wallet, and reset `picks` to `null` in `testnet\blockx.json` |

## Good to know

- **One producer.** Right now the Foundation testnet has a single block producer (`147ABaHV…TrGR` signed all 7,200
  blocks of the last ~6 hours on 2026-10-28). Picks, locks, caps, Mana, the recorder and the boards can all be tested,
  but every right pick scores ×1. To test real multipliers, a second producer is needed on the testnet.
- **One node.** The testnet has one public node, so testnet results are checked on one node (mainnet: two).
- **Mana.** Wallet Mana is held for about 5 minutes after each transaction. If a pick says "no Mana", wait and retry.

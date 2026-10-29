# Last Node Standing on the testnet: practice runbook (PowerShell)

**What you get:** a practice copy of Last Node Standing on your own computer, at
`http://127.0.0.1:8350/lastnode-testnet.html`, with a red **TESTNET** bar.

- **Your picks** go to the testnet Picks contract you already uploaded for Block X (`12xNetHp…VrX5`), paid with free test KOIN.
- **The race** is the real Koinos producers, read live from mainnet. The testnet has only one block producer, so it can't hold a race. Mainnet is only read: nothing is ever sent there.
- **Two games:**
  - **94 Fast test:** a cut every 20 minutes, an event every 4 hours (00:00, 04:00, 08:00 … UTC = 5 pm, 9 pm, 1 am, 5 am, 9 am, 1 pm Pacific). Picks open 4 hours ahead and lock 10 minutes before the start.
  - **33 Real timing:** exactly the live game's settings. Daily at 14:00 UTC (7 am Pacific), a cut every hour; picks open 24 hours ahead and lock at 13:50 UTC (6:50 am Pacific).
  - **One pick per event (owner, 2026-10-29):** your node and an optional backup, made before the start. The first time your node is cut, the backup takes over automatically if it's still standing. Nothing can be picked or changed once the race starts.
  - Games 93 and 13, registered on 28 Oct, used the earlier hourly-pick rules. They stay on the testnet contract but are no longer used.

Everything runs in **its own folder, `C:\kprediction-lns`**, a separate copy of the code with only your testnet settings in it. Never check this branch out in `C:\kprediction`: that folder holds your mainnet `.env`, and the scheduled tasks there must keep running the `picks` code (audit LN-3).

> **Never paste a private key (WIF) into a chat, an issue or GitHub**, testnet ones included.

## 1. Get the code (a separate folder)

The first time:

```powershell
cd C:\
git clone https://github.com/bawcejawn/Knode.git kprediction-lns
cd C:\kprediction-lns
git checkout lastnode
Copy-Item C:\kprediction\.env.testnet .
Copy-Item C:\kprediction\testnet\blockx.json testnet\blockx.json
npm ci --ignore-scripts
```

- **Expect:** `Switched to a new branch 'lastnode'`, then npm installs and ends without errors.
- **Copy only `.env.testnet`** (test keys). Never copy `.env` (mainnet) into this folder.
- **`testnet\blockx.json`** holds your testnet Picks contract address; the copy keeps it.
- `--ignore-scripts`: packages install without running their own install scripts, as on the `picks` branch.

After that, to update:

```powershell
cd C:\kprediction-lns
git pull
npm ci --ignore-scripts
```

## 2. Check the testnet Picks contract

```powershell
npm run picks -- status --testnet
```

Expect:
- **Code** `✔`, **Overrides** `✔ all three ON`, **Owner** `✔`;
- games **2** and **92** listed as **ON**.

## 3. Register the two games (with the 10-minute wait)

```powershell
npm run picks -- announce 94 --testnet
```

This is a dry run. It shows `one pick per event, a start node and an optional backup` and `picks lock 10 min before each start`, and changes nothing. Then send both:

```powershell
npm run picks -- announce 94 --testnet --send
npm run picks -- announce 33 --testnet --send
```

Each ends with `✔ announced`. **Wait 10 minutes**, then:

```powershell
npm run picks -- status --testnet
npm run picks -- apply 94 --testnet --send
npm run picks -- apply 33 --testnet --send
```

- **Expect:** `status` shows both as `ready now`. Each apply ends with `✔ game … is in force`.
- **If you see `no Mana`:** the test owner wallet is low. Claim test KOIN for it from @KoinosTestnetFaucetBot and try again.

## 4. Start the test site and the recorder

```powershell
cd C:\kprediction-lns
npm run testnet-site -- --record
```

**Leave this window open.** Every 5 minutes it:
- records Block X and Last Node Standing;
- reads mainnet blocks for the race;
- reads testnet picks.

The first Last Node Standing run takes a minute or two: it works out the handicap (c) for the field. Then open:

- **Fast test:** http://127.0.0.1:8350/lastnode-testnet.html#game-94
- **Real timing:** http://127.0.0.1:8350/lastnode-testnet.html#game-33

Stop it with **Ctrl+C**. Running it again carries on where it left off.

## 5. Play

1. Press **Play free** (top right). The page makes a Test wallet in your browser, and your local server sends it 5 test KOIN (about 100 picks).
2. For the next event, tap a card under **Your node** and, if you like, one under **Backup (optional)**. Press **Lock in**, then confirm the pop-up says *Pick confirmed*. You can change it until 10 minutes before the start.
3. Watch the track once the race starts. The red lane is the node that would go if the cut were now.
4. If your node is knocked out, your backup takes over by itself (if it's still standing). Nothing to tap.

## What to try (tick off)

- [ ] Play free, then your first pick for the next fast event
- [ ] Change your pick before it locks; after the lock the chooser moves on to the next event
- [ ] Watch a cut happen live; a few minutes later the recorder confirms it
- [ ] Pick a node with a backup, then change the backup before the lock
- [ ] Get your node knocked out and watch the backup take over
- [ ] Ride a node to the end; the leaderboard shows your points (cuts survived + 5, or + 3 after a jump)
- [ ] Phone layout: in Chrome press **F12**, then the phone icon
- [ ] A pick in the real-timing game (#game-33) before 6:50 am Pacific

## Good to know

- **Field size:** the fast test holds at most 11 nodes, so one event always ends before the next one's picks lock. Today the field is 10.
- **Ranked on the testnet:** a wallet holding at least 1 test KOIN. Nothing is paid.
- **Two clocks (practice only):** picks lock on testnet block time, while cuts use mainnet block time, and testnet picks are read from one testnet node at its head. Both chains keep real time, so this rarely shows; the live game uses mainnet only, on two nodes.
- **Env names:** the testnet recorder reads only `TESTNET_LASTNODE_OUT`, `TESTNET_LASTNODE_PREV` and `TESTNET_RACE_DATA` (all must be inside `testnet-data\`), so mainnet settings left in your PowerShell window can't redirect it.
- **The test page and the live game page share one script** (`lastnode.js`). The test page loads only the testnet wallet, and that wallet refuses to sign for mainnet or for any contract except the testnet Picks contract.
- **Online version for other testers:** this needs your OK, because it changes `main` and GitHub settings. It is a separate step.

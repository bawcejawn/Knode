# Last Node Standing on the testnet: practice runbook (PowerShell)

**What you get:** a practice copy of Last Node Standing on your own computer, at
`http://127.0.0.1:8350/lastnode-testnet.html`, with a red **TESTNET** bar.

- **Your picks** go to the testnet Picks contract you already uploaded for Block X (`12xNetHp…VrX5`), paid with free test KOIN.
- **The race** is the real Koinos producers, read live from mainnet. The testnet has only one block producer, so it can't hold a race. Mainnet is only read: nothing is ever sent there.
- **Two games:**
  - **93 Fast test:** a cut every 20 minutes, an event every 4 hours (00:00, 04:00, 08:00 … UTC = 5 pm, 9 pm, 1 am, 5 am, 9 am, 1 pm Pacific). Start picks lock 15 minutes before the start. A jump is open until 5 minutes after your node's cut.
  - **13 Real settings:** exactly the live game's settings. Daily at 14:00 UTC (7 am Pacific), a cut every hour, start picks lock at 13:10 UTC (6:10 am Pacific), jumps until 10 past the hour.

Everything runs in `C:\kprediction`, where your `.env.testnet` and testnet settings already are.

> **Never paste a private key (WIF) into a chat, an issue or GitHub**, testnet ones included.

## 1. Get the code

```powershell
cd C:\kprediction
git fetch origin
git checkout lastnode
git pull
npm ci
```

- **Expect:** `Switched to branch 'lastnode'`, then npm installs and ends without errors.
- **The `lastnode` branch is the `picks` branch plus Last Node Standing.** Your scheduled tasks run the same bot code as before.
- **Your local file `testnet\blockx.json`** (it holds your testnet Picks contract address) comes along unchanged.

## 2. Check the testnet Picks contract

```powershell
npm run picks -- status --testnet
```

Expect:
- **Code** `✔`, **Overrides** `✔ all three ON`, **Owner** `✔`;
- games **2** and **92** listed as **ON**.

## 3. Register the two games (with the 10-minute wait)

```powershell
npm run picks -- announce 93 --testnet
```

This is a dry run. It shows `a cut every 20 min, an event every 240 min; each round locks 5 min after its cut` and changes nothing. Then send both:

```powershell
npm run picks -- announce 93 --testnet --send
npm run picks -- announce 13 --testnet --send
```

Each ends with `✔ announced`. **Wait 10 minutes**, then:

```powershell
npm run picks -- status --testnet
npm run picks -- apply 93 --testnet --send
npm run picks -- apply 13 --testnet --send
```

- **Expect:** `status` shows both as `ready now`. Each apply ends with `✔ game … is in force`.
- **If you see `no Mana`:** the test owner wallet is low. Claim test KOIN for it from @KoinosTestnetFaucetBot and try again.

## 4. Start the test site and the recorder

```powershell
cd C:\kprediction
npm run testnet-site -- --record
```

**Leave this window open.** Every 5 minutes it:
- records Block X and Last Node Standing;
- reads mainnet blocks for the race;
- reads testnet picks.

The first Last Node Standing run takes a minute or two: it works out the handicap (c) for the field. Then open:

- **Fast test:** http://127.0.0.1:8350/lastnode-testnet.html#game-93
- **Real settings:** http://127.0.0.1:8350/lastnode-testnet.html#game-13

Stop it with **Ctrl+C**. Running it again carries on where it left off.

## 5. Play

1. Press **Play free** (top right). The page makes a Test wallet in your browser, and your local server sends it 5 test KOIN (about 100 picks).
2. Under **Your node**, choose a node for the next event and press **Pick node**. Confirm the pop-up says *Pick confirmed*.
3. Watch the track. The red lane is the node that would go if the cut were now.
4. **Backup:** while your node is standing, set a backup. If your node goes, the backup is your jump.
5. **Jump:** if your node is knocked out and you have no valid backup, a red **Jump!** box appears. Pick a node still standing before the time it shows.

## What to try (tick off)

- [ ] Play free, then your first pick for the next fast event
- [ ] Change your pick before it locks; after the lock the chooser moves on to the next event
- [ ] Watch a cut happen live; a few minutes later the recorder confirms it
- [ ] Set a backup
- [ ] Get knocked out and jump (or let a backup jump for you)
- [ ] Ride a node to the end; the leaderboard shows your points (cuts survived + 5, or + 3 after a jump)
- [ ] Phone layout: in Chrome press **F12**, then the phone icon
- [ ] Tomorrow 6:10 am Pacific: a start pick in the real-settings game (#game-13)

## Good to know

- **Field size:** the fast test holds at most 11 nodes, so one event always ends before the next one's picks lock. Today the field is 10.
- **Ranked on the testnet:** a wallet holding at least 1 test KOIN. Nothing is paid.
- **The test page and the live game page share one script** (`lastnode.js`). The test page loads only the testnet wallet, and that wallet refuses to sign for mainnet or for any contract except the testnet Picks contract.
- **Online version for other testers:** this needs your OK, because it changes `main` and GitHub settings. It is a separate step.

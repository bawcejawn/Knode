# Fantasy Producers on the testnet: how to practice

This runs a complete copy of Fantasy Producers for practice, with play money. It gives you:
- your own test wallets: you play as **p1**;
- a testnet copy of the Picks contract (the audited one, with 3 settings changed for testing);
- a fast clock: **1 test "day" = 1 hour**, so a test week plays in 7 hours;
- five robot players to play against and to be your rivals;
- the recorder, and a practice page on your PC with a red **TESTNET** bar.

**What's real and what's practice.** Your teams and rival challenges go to the **testnet** (play money).
They are scored on **real Koinos mainnet producers' blocks**, read only, exactly as the live game will be. The testnet
has only one block producer, so a team of testnet producers couldn't score anything. The kit never signs or sends
anything to mainnet. It only reads mainnet blocks, the same way the website does.

**Time:** about 30 minutes to set up (including a 10-minute wait). Then leave it running.

---

## Quick start: Claude already deployed it

If Claude sent you a file named **`fantasy-testnet.zip`**, the testnet contract, the two games and the test week are
already set up, and the zip holds the test wallets. You only need the page and the robots on your PC (they read
mainnet blocks, which only your PC can reach):

```powershell
cd C:\
git clone https://github.com/bawcejawn/Knode.git C:\kprediction-fantasy
cd C:\kprediction-fantasy
git checkout fantasy
npm ci
Expand-Archive "$HOME\Downloads\fantasy-testnet.zip" -DestinationPath C:\kprediction-fantasy\testnet-data\fantasy
npm run fantasy-test -- status
npm run fantasy-test -- run --bots
```

What to expect:
- `status` lists the wallets with their test KOIN, games 4 and 5 **ON**, and the test week's start time.
- `run --bots` opens the practice page in your browser and keeps running. **Leave that window open.**

Then go to **7. Play** below. Steps 1 to 6 are only for setting it up yourself.

---

## 1. Get a separate copy of the code

Use a **separate folder**, so your mainnet scheduled tasks (which run from `C:\kprediction`) never see this branch.
Keep it out of OneDrive-synced folders such as Desktop and Documents. In PowerShell:

```powershell
cd C:\
git clone https://github.com/bawcejawn/Knode.git C:\kprediction-fantasy
cd C:\kprediction-fantasy
git checkout fantasy
npm ci
cd picks
npm ci
npm test
cd ..
```

What to expect: `npm test` in `picks` ends with `✔ Pass!`.

**Every command below runs in `C:\kprediction-fantasy`.**

## 2. Make the test wallets

```powershell
npm run fantasy-test -- setup
```

What to expect: it makes eight throwaway wallets:
- **owner**: runs the test games;
- **picks**: becomes the testnet Picks contract;
- **p1**: you;
- **p2** to **p6**: the robots.

Their keys go in `testnet-data\fantasy\keys.env`, which git ignores. They are for play money only: never use them on
mainnet, and never share them.

It finishes by printing a line like `/faucet 1AbC…`.

## 3. Get free test KOIN

1. In Telegram, open the faucet bot: https://t.me/KoinosTestnetFaucetBot
2. Send `/start`.
3. Send the `/faucet 1AbC…` line from step 2.

You get 100 test KOIN, one claim a day. That's enough for everything. Then share it out:

```powershell
npm run fantasy-test -- fund --send
```

What to expect:
- 50 test KOIN goes to the picks wallet (Mana for the upload);
- 6 goes to each player;
- each line ends with a transaction id.

## 4. Build and upload the testnet Picks contract

```powershell
npm run fantasy-test -- picks-build
```

This takes a minute or two. It first proves the compile reproduces the audited build exactly
(`✔ the compile reproduces the audited build exactly: 700c296a…`). Then it changes exactly 3 lines:
- the owner becomes your test owner;
- the admin wait becomes 10 minutes;
- the apply window becomes 24 hours.

```powershell
npm run fantasy-test -- picks-upload
npm run fantasy-test -- picks-upload --send
```

The first line is a dry run that shows what it will do. The second uploads. Expect `✔ uploaded`.

## 5. Register the two games (with the 10-minute wait)

```powershell
npm run fantasy-test -- games --send
```

Expect `✔ announced` twice: game 4 (your team) and game 5 (Weekly Rival). **Wait 10 minutes**, then run it again:

```powershell
npm run fantasy-test -- games --send
```

Expect `✔ game 4 (team) is in force` and `✔ game 5 (rival) is in force`.

## 6. Start the test week and run everything

```powershell
npm run fantasy-test -- week next
npm run fantasy-test -- run --bots
```

`week next` starts test week 1 on the next hour at least 2 h 15 min away. It prints when the price list comes out
(2 hours before, as the live game's 2 days) and when your first team locks.

`run --bots` keeps running; **leave that window open**. Every 2 minutes it:
- records mainnet blocks and the testnet picks;
- publishes the price list, scores, league and rivals for the page;
- lets the robots play:
  - **p2 "value"**: best form for the money;
  - **p3 "big names"**: the biggest producers it can afford;
  - **p4 "random"**: a random team, then random swaps;
  - **p5 "chaser"**: whoever scored best yesterday;
  - **p6 "late"**: joins on the 3rd test day of its first week.
- p2 and p5 challenge you every week; p3 challenges p2, and p4 picks someone at random.

Press **Ctrl+C** to stop it. Running it again carries on where it left off.

## 7. Play

The page opens by itself (or open the address `run` printed, usually
**http://127.0.0.1:8380/site/fantasy-testnet.html**). You are **p1** (red bar,
top right). You can switch to any robot to see its side, for example to check a rival match.

1. When the price list is out, press **Add** on five producers. The bar shows what you've spent of 100.
2. Press **Make C** on your captain (scores ×2).
3. Press **Save team**. The pop-up confirms it on the chain.
4. Each test day (each hour) you may make **one change**: swap one producer, or move the captain. The sheet tells you
   what your change is before you save. A second change is refused on the page.
5. At the start of each new test week you may pick a whole new team. New prices come out 2 hours before.
6. **Plan ahead:** the "Plan:" buttons on the team sheet let you set a change for any later test day now. You can
   still change it until that test day's lock; the page warns if an earlier change would make it break the rule.
7. **Weekly Rival:** choose a player and press **Challenge**. It counts for the next test week, if you both have a team
   all 7 test days. (In the live game both players must also hold a Knode Games stake; the test wallets hold none, so
   in practice every test player counts.)
8. **All time:** the league's "All time" tab adds up every finished test week.

### What to try (tick them off)
- [ ] Save a first team, then change the captain the next test day.
- [ ] Try two changes in one day: the page refuses, and explains why.
- [ ] Try a team over the budget: the page refuses.
- [ ] Watch "today so far" fill in during a test day, then the day's score appear once it's final.
- [ ] Plan a change for a later test day with the "Plan:" buttons, then change an earlier day and see the warning.
- [ ] Challenge p3, then see the match under Weekly Rival the next test week.
- [ ] Switch to p5 in the red bar: see that p5 challenged you.
- [ ] At a week's end, check the league goes "final" 30 minutes later, with Vault points (255 for the best week).
- [ ] After two finished test weeks, open the league's "All time" tab.
- [ ] Let a week roll over without saving: your team carries on if it fits the new prices. If it doesn't, the page
      says "Last week's team doesn't fit this week's prices".
- [ ] Run `npm run fantasy-test -- status` and send Claude the output, with anything that looked odd.

## Stop or start over

| What | How |
|---|---|
| Stop | Ctrl+C in the `run` window |
| See everything | `npm run fantasy-test -- status` |
| A team from the command line | `npm run fantasy-test -- team p1 #1,#5,#9,#12,#15 --send` (#n = nth on the price list, dearest first; captain first) |
| A challenge from the command line | `npm run fantasy-test -- rival p1 p3 --send` |
| New test week schedule | `npm run fantasy-test -- week next` (old results stay; move `testnet-data\fantasy\data` away for a clean board) |
| Start over completely | delete the folder `testnet-data\fantasy` and begin at step 2 |

## Good to know
- **Mana.** Each test pick uses about 0.05 test KOIN of Mana. Wallet Mana is held for a few minutes after each
  transaction: if a save says "Mana is still held", wait a minute and retry.
- **Race cards.** The expected share of blocks comes from the live Producer Race's hourly cards on GitHub.
- **Two mainnet nodes.** Days are final only when Armana and koinosblocks agree, as in the live game.
- **The robots** need their test KOIN. If a robot line says it's out of Mana, run `fund --send` again after a new
  faucet claim.
- Nothing here can pay or receive real VHP or KOIN. The live game's prizes come from the Knode Games vault.

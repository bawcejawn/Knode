# Survivor on the testnet: how to

This runs a complete copy of Survivor on the **Koinos Foundation testnet**. That is the same testnet SwarmTales uses,
and everything on it is play money. It gives you:
- your own test wallets;
- a testnet copy of the Picks contract;
- a fast clock: **1 round = 1 test "day" = 1 hour**, so a 14-day season plays in 14 hours;
- five robot players to play against;
- the recorder;
- a test page on your PC with a red **TESTNET** bar.

It doesn't touch the live game, mainnet, your mainnet keys or the mainnet nodes. You don't need a testnet node: it
uses the public testnet API at `https://testnet.koinosfoundation.org`. Every command checks the network first and
stops if it is mainnet.

**Time:** about 30 minutes to set up (including a 10-minute wait), then leave it running for the season.

---

## 1. Get a separate copy of the code

Use a **separate folder**, so your mainnet scheduled tasks (which run from `C:\kprediction`) never see this branch. Keep it out of OneDrive-synced folders such as Desktop and Documents, so the test keys aren't uploaded anywhere.
In PowerShell:

```powershell
cd C:\
git clone https://github.com/bawcejawn/Knode.git C:\kprediction-test
cd C:\kprediction-test
git checkout survivor
npm ci
```

Then the contract build tools (only needed once):

```powershell
cd C:\kprediction-test\picks
npm ci
cd C:\kprediction-test
yarn --version
```

If `yarn --version` says it isn't recognized, install it once with `npm install -g yarn`, then close and reopen
PowerShell.

**Every command below runs in `C:\kprediction-test`.**

## 2. Make the test wallets

```powershell
npm run survivor-test -- setup
```

What to expect: it creates eight throwaway wallets:
- **owner**: runs the test game;
- **picks**: becomes the testnet Picks contract;
- **p1** to **p6**: the players.

Their keys go in `C:\kprediction-test\testnet-data\survivor\keys.env`, which git ignores. They are for play money
only: never use them on mainnet, and never share them.

It finishes by printing a line like `/faucet 1AbC…`. That is the test owner's address.

## 3. Get free test KOIN

1. In Telegram, open the faucet bot: https://t.me/KoinosTestnetFaucetBot
2. Send `/start`.
3. Send the `/faucet 1AbC…` line from step 2.

It sends 100 test KOIN. You get one claim a day, and that one claim is enough for everything. Check with
`/balance 1AbC…`. If the bot is silent, ask in https://t.me/koinos_community.

Then share it out:

```powershell
npm run survivor-test -- fund --send
```

What to expect:
- 50 test KOIN goes to the picks wallet (its Mana for the upload);
- 6 goes to each player;
- about 14 stays with the owner;
- each line ends with a transaction id.

## 4. Build and upload the testnet Picks contract

```powershell
npm run survivor-test -- picks-build
```

This takes a minute or two. It copies the audited Picks contract and changes exactly two settings:
- the owner becomes your test owner;
- the admin wait becomes 10 minutes instead of 48 hours.

Then it builds the copy and runs the contract's safety check. Expect `✔ picks check` and `✔ testnet Picks build …
sha256 …`. (If the build says EAGAIN it retries by itself; that is a known harmless hiccup.)

```powershell
npm run survivor-test -- picks-upload
npm run survivor-test -- picks-upload --send
```

The first line is a dry run that shows what it will do. The second uploads.

## 5. Register the game (with the 10-minute wait)

```powershell
npm run survivor-test -- game --send
```

Expect `✔ announced`. This is the same two-step change the mainnet contract uses, with a 10-minute wait instead of
48 hours. **Wait 10 minutes**, then:

```powershell
npm run survivor-test -- game --send
```

Expect `✔ game 3 is in force`.

## 6. Start Season 1 and run everything

```powershell
npm run survivor-test -- season next
npm run survivor-test -- run --bots
```

`season next` starts Season 1 on the next hour you can still join, at least 15 minutes away, and prints the times in
your time zone.

`run --bots` keeps running; **leave that window open**. Every 2 minutes it:
- records the testnet's blocks and picks;
- publishes the handicaps and standings for the test page;
- has the robot players **p2 to p6** pick for the next round:
  - p2 picks the biggest producer it hasn't used, p3 the second biggest;
  - p4 picks at random, p5 the smallest;
  - p6 skips every third round, to test missed picks.

Press **Ctrl+C** to stop it. Running it again carries on where it left off.

**p1 is yours.** Open the test page in your browser:

> http://127.0.0.1:8370

(`run` prints the exact address. If port 8370 is busy it uses the next free one, 8371 and up. To choose one yourself
add `--port 9100`. It never uses 8090, your Koinos node, or 8350, the Block X test page, unless you ask.)

Choose **p1** in the red bar ("Play as"), then pick a producer for the first round and press **Pick**. There is no
wallet pop-up: the test server signs for p1 with its test key.

The first recording run after starting can take a few minutes, because it reads the 8 hours of testnet blocks the
handicaps need. Until then the page says it is waiting for the recorder.

## 7. What to try

Tick these off as you go. Each round lasts an hour, so spread them over the season:

- [ ] **Join:** pick for round 1 before it locks (5 minutes before the hour). The row turns purple and shows "Your pick".
- [ ] **Change a pick:** choose another producer for the same round and press **Change**.
- [ ] **Lock:** with less than 2 minutes to go, the round drops off the list. The contract refuses a pick after the lock.
- [ ] **Today:** the Today table updates every minute; the out-zone rows are red and your producer is marked.
- [ ] **Used producers:** after a round, the producer you picked is greyed out ("used" / "picked for …") in later rounds.
- [ ] **Lose a life:** skip a round on purpose (don't pick). After it ends, your hearts go from ♥♥ to ♥♡.
- [ ] **Standings:** after each round, the standings show lives, scores and who is out.
- [ ] **The end:** when 2 or fewer players are left, or after round 14, the season ends. 30 minutes later (the test
      correction window) it is final and the prizes show.
- [ ] **Phone layout:** in Chrome, press F12, then the phone icon, to see the page at phone width. (The test page only
      opens on this PC, so a real phone can't reach it.)

Any time, in a second PowerShell window in `C:\kprediction-test`:

```powershell
npm run survivor-test -- status
```

It shows:
- the testnet;
- each wallet's test KOIN and Mana;
- the producers;
- the contract and game 3;
- the season so far (lives, log letters and score for every player).

The log letters are one per round: s safe, o out-zone, n no pick, f not in the field, u already used, v saved.

## 8. Other commands

| Command | What it does |
|---|---|
| `npm run survivor-test -- pick p1 #2 --send` | Pick as p1 from the command line: `#2` is the 2nd producer in the field (or paste an address). Add a round number to pick a later round |
| `npm run survivor-test -- record` | One recording run, by hand |
| `npm run survivor-test -- run` | The test page and the recorder, without the robot players |
| `npm run survivor-test -- season next` | Start a new Season 1 (for a fresh test). Then restart `run` |

## 9. Testing points worth knowing

- **Small field.** The testnet may have only a few producers. The test clock always keeps at least one producer in the
  out-zone (the "out-zone floor"), so players still lose lives. Mainnet has no floor and doesn't need one.
- **VHP rule.** On mainnet a prize needs at least 1 VHP at every daily check. The test wallets have no VHP, so on
  the testnet the same check looks for **1 test KOIN** instead. Every player starts with 6, so prizes show at the end.
  To see the rule refuse a prize, send all of one player's test KOIN away from its wallet before a round ends.
- **The testnet resets now and then.** If a command says the chain id changed, the testnet was reset. Delete the
  folder `C:\kprediction-test\testnet-data\survivor` and start again from step 2.
- **Nothing here is secret** except `keys.env`, and that only holds play money.

## 10. When you are done

1. Stop `run` with Ctrl+C.
2. Send Claude the output of `npm run survivor-test -- status`, plus anything that looked wrong (a screenshot helps).
3. Then run the audit bot on the branch. Its brief is `claude/audit-survivor-prompt.md` in the Knode Games project.

## Rehearsal (no testnet needed)

The same flow runs against a fake testnet inside your PC in 5–10 minutes. This is how it was checked before you got it:

```powershell
node --import tsx tools/survivor-testnet/rehearse.mjs
```

Expect `✔ rehearsal passed`. The browser step is skipped unless Playwright is installed.

# Knode — launch guide

Follow the steps in order. Every command goes into **PowerShell**. Any command that sends something is a dry run
unless you add `--send`, so you can always check first.

> **The rule for keys:** private keys live only in `.env` files on your PC (and in the node's key file). Never
> paste one into a chat, an email or GitHub. The one exception is the bot's key, which goes into GitHub as an
> encrypted *secret* (step 8).

**You need, once:**
- [Git for Windows](https://git-scm.com/download/win)
- [Node.js LTS](https://nodejs.org)
- [Docker Desktop](https://www.docker.com/products/docker-desktop/). In its settings, turn on "Start Docker Desktop when you sign in".

---

## Step 0 — Move the project out of OneDrive

OneDrive uploads its folders to the cloud, including `.env` files that hold keys. Make a clean copy outside it:

```
git clone https://github.com/bawcejawn/Knode.git C:\kprediction
Copy-Item "C:\Users\cpada\OneDrive\Desktop\kprediction-git\probes\.env" "C:\kprediction\probes\.env"
cd C:\kprediction
```

From now on, use only `C:\kprediction`. Once everything below works, delete the old OneDrive folder.

## Step 1 — Install and check (≈ 15 min)

```
cd C:\kprediction
npm install
cd game
npm install
npm test                 # expect: [Tests]: 44 / 44  ✔ Pass!
npm run check            # expect: All offline checks passed.
npm run build:sim
cd ..
npm run bot -- rehearse --weeks 1      # ≈ 10 min, expect: All ... rehearsal checks passed.
git add package-lock.json game/package-lock.json
git commit -m "Add lockfiles"
git push
```

## Step 2 — Create the wallets

```
npm run bot -- keys
```

The keys are written to **`C:\kprediction\.env`**. Open it with `notepad .env`. The command prints four addresses:

| Role | Key in `.env` | What it is |
|---|---|---|
| **contract** | `CONTRACT_WIF` | The game's own address. **Send it nothing.** It must stay empty until deploy. |
| **admin** | `OWNER_WIF` | Owner and seed owner. **Back it up offline** (paper or a password manager). |
| **bot** | `OPERATOR_WIF` | Yesterday's probe owner wallet (~52 KOIN). Posts and resolves questions; it can't move game funds. |
| **player** | `PLAYER_WIF` | Yesterday's probe helper wallet, used for testing. |

## Step 3 — Fund the wallets

| Send to | Amount | Why |
|---|---|---|
| **bot** | **+50 KOIN** (≈ 100 in total) | Mana for uploading the contract (~55) and for the daily questions |
| **admin** | **1,000 VHP + 100 KOIN** | The soft-launch seed (1,000 VHP + 50 KOIN), plus Mana for admin actions |
| **player** | **5 VHP + 5 KOIN** | Test deposits and answers |
| contract | **nothing** | |

## Step 4 — The project's node (on this PC, separate from your 600k node)

One command sets everything up:
- a separate folder (`C:\kpred-node`);
- the official Koinos node;
- a block producer that produces for the **contract address**;
- the newest Armana chain snapshot, with its fingerprint checked, so the node doesn't replay the whole chain.

It needs about **200 GB free** while it unpacks. The download is about 60 GB. If the download stops, run the
same command again and it continues where it left off.

```
cd C:\kprediction
powershell -ExecutionPolicy Bypass -File node\setup-node.ps1 -Producer <contract address from step 2>
```

When it finishes:
```
npm run bot -- node-status      # wait until it says your node is caught up
npm run bot -- node-key         # prints the node's PUBLIC key (safe to share)
```

Keep the PC on and awake. Go to Settings → System → Power and set "When plugged in, put my device to sleep after" to **Never**.

## The weekly rhythm (built into the contract and the bot)

All times are UTC. Eastern time is UTC−4 in summer and UTC−5 in winter. The website shows every time in the visitor's own time zone.

| When | What happens |
|---|---|
| Monday 00:00 | The week starts |
| Monday–Saturday 12:00 | The day's questions come out: 4 on Monday and Tuesday, 3 on the other days, about 20 a week |
| Next day 00:00 | Answers close, 12 hours after the questions came out |
| A few hours later | Results are posted as soon as the watched blocks are final |
| Sunday | Results day, with no new questions |
| Monday 12:00 | The week closes: 12 hours for corrections, then the rewards are split |
| Tuesday 12:00 | Winners are final and can collect |

The contract uses each block's own timestamp, so these times are exact every week. They don't drift with block speed.
The questions themselves are still about real block ranges ("between block A and block B").

**Free play:** anyone can answer and appear on the leaderboard without staking. Rewards are points × stake, so free
players are never paid. Deposits are whole numbers only (1, 2, 3 VHP …); withdrawals can be any amount, down to the last
decimal, so everyone can always take out every unit. The pool only pays Mana for staked players;
free players use their own Mana or Kondor's free Mana.

## Step 4b — Lock the exact library versions

`npm install` wrote two `package-lock.json` files that record the exact version of every library. Commit them, so
GitHub's bot installs exactly what you tested (a surprise new library version never runs next to a key):
```
cd C:\kprediction
git add package-lock.json game/package-lock.json
git commit -m "Lock library versions"
git push
```

## Step 5 — Deploy the contract

```
npm run bot -- deploy            # dry run: check the addresses, the start (Monday 00:00 UTC) and the schedule
npm run bot -- deploy --send
git add game-data/deployment.json
git commit -m "Deployed"
git push
```

## Step 6 — Connect the node to the game

```
npm run bot -- register-key node            # dry run
npm run bot -- register-key node --send
```

This reads the node's key file on your PC and registers only its public key. It becomes active about 1 minute later.

## Step 7 — Soft-launch seed

```
npm run bot -- seed-vhp 1000 --send
npm run bot -- seed-koin 50 --send
npm run bot -- status
```

## Step 8 — Turn on the bot and the website (GitHub)

On github.com/bawcejawn/Knode:
1. **Settings → Secrets and variables → Actions**
   - New repository secret `OPERATOR_WIF`. The value is the `OPERATOR_WIF` line from `.env`, only the part after `=`.
   - On the Variables tab, add `BOT_ENABLED` = `true`.
2. **Settings → Pages**: Source "Deploy from a branch", branch `main`, folder `/ (root)`, then Save.
   The site appears at **https://bawcejawn.github.io/Knode/** within a few minutes. To preview it with sample data
   at any time, add `?demo` to the address.
3. **Actions → Kpred bot → Run workflow** starts the first run by hand. The first one takes several minutes.
4. Emails: click your picture → **Settings → Notifications → Actions**, then tick **"Notify on failed workflows only"**.

## Step 9 — The test week

Before Monday, with the player wallet, run `npm run bot -- deposit 2 --send`. Or use the website with Kondor.

During the week, answer on the website, or:
```
npm run bot -- status                 # open questions with their numbers and options
npm run bot -- answer 3 B --send      # answer question #3 with B
```
After the week (from Tuesday 12:00 UTC, once winners are final), collect: `npm run bot -- claim 0 --send`

To take money out: `npm run bot -- withdraw 0.5 --send` (any amount, decimals allowed) or `npm run bot -- withdraw all --send`.

## Step 10 — Full seed

Once week 0 has closed, settled and paid correctly:
```
npm run bot -- seed-vhp 169000 --send
npm run bot -- seed-koin 19950 --send
```
Moving KOIN needs Mana at least equal to the amount, so let the admin wallet's Mana refill first.

---

## Security in one page

See `docs/security-audit.md` for the full audit. The short version:
- **Players' stakes can only go back to the player who deposited them.** No one else can sign a withdrawal for them, and
  withdrawals can never be paused.
- **Nobody, not even the admin, can move the contract's tokens directly.** The contract refuses every outside request.
- **Code changes take 48 hours** and the bot emails you the moment one is scheduled, so players always have two days to leave.
- **After deploy, the contract key in `.env` (`CONTRACT_WIF`) has no power left.** Keep a backup anyway, offline.
- **Back up the admin key (`OWNER_WIF`) offline.** It is the most powerful key. Never put it on GitHub.

## What the email alerts mean

| Email says | What to do |
|---|---|
| "The pool has produced no block for N min" | Check the node: is the PC on, is Docker running? Run `npm run bot -- node-status` |
| "The bot's wallet … is low on Mana" | Send the bot address some KOIN |
| "The contract is low on Mana" | Usually temporary (it refills). If it repeats, tell Claude |
| "Week N is overdue to close" | Run `npm run bot -- status` and send Claude the output |
| "A code upgrade / seed withdrawal / ownership transfer is scheduled" | If you didn't do it, your admin key may be stolen. Tell Claude immediately |
| "A transaction failed" / "generator failed" | Often a busy network. If it repeats, tell Claude |

The 1-hour alarm: the bot raises it after 1 hour without a block. While the pool is small and normally goes
longer than that between blocks, it waits until the silence is unusual instead.

## Changing the website (no waiting)

The website is just files in the `site/` folder, served free by GitHub Pages. Any change you commit and push is live
within a few minutes. There's no timelock: the website can't touch anyone's money, it only asks Kondor to sign
transactions that the contract then checks.

## Ads

Edit `site/ads.json` (on github.com you can click the file, then the pencil icon), replace `null` for a slot, and
commit. Two kinds:
- **Direct sponsor:** put their image in `site/ads/` and fill in `image`, `link` and `alt`.
- **Ad network** (A-Ads and similar): paste the ad link from the network's dashboard as `src`, with its width and height.

Ads always run walled off from the page: they can't see or touch the wallet connection. Only `https` links are accepted.

## Fixing the contract later (48-hour upgrade)

```
cd game
npm test ; npm run check            # build and test the fixed code
cd ..
npm run bot -- upgrade status       # what is announced, and does it match your build
npm run bot -- upgrade schedule --send
#   ... 48 hours: the bot emails you (expected), players can see it and leave if they want ...
npm run bot -- upgrade apply        # dry run
npm run bot -- upgrade apply --send
git add game-data/deployment.json ; git commit -m "Upgraded" ; git push
```
All stakes, weeks, results and the seed carry over. `npm run bot -- upgrade cancel --send` withdraws an announcement.

## Emergency levers (instant) and how to undo them

| Lever | Undo | Notes |
|---|---|---|
| `pause on --send` (no new deposits) | `pause off --send` | Withdrawals and collecting rewards keep working |
| `sponsor-limit 0 --send` (stop paying players' Mana) | `sponsor-limit 2 --send` | |
| `void 12 "reason" --send` | can't be undone | That question just doesn't count |
| `admin set_operator operator=<new bot address> --as owner --send` | same command with the old address | Then update the `OPERATOR_WIF` secret on GitHub |

Players' withdrawals can never be paused, on purpose: a stolen admin key can never lock anyone's money.

## Taking the seed back

The seed can only go back to the seed owner, and only after a public 48-hour notice:
```
npm run bot -- seed-withdraw 1000 50 --send     # announce: 1,000 VHP + 50 KOIN (the bot emails you; that's expected)
npm run bot -- seed-withdraw execute --send     # 48 hours later: send it
```
If KOIN comes back short (moving KOIN needs Mana), run `execute` again after the contract's Mana refills.

## Everyday owner commands (dry run unless `--send`)

```
npm run bot -- status
npm run bot -- node-status
npm run bot -- void 12 "reason"       # VOID open question #12 (before its week closes)
npm run bot -- claim-fee              # the 5% producer fee (KOIN) to the admin wallet
npm run bot -- sponsor-limit 0        # stop paying players' Mana (players use their own / Kondor's free Mana)
npm run bot -- pause on|off           # pause NEW deposits (withdrawals and claims always work)
```

## The node, day to day

```
cd C:\kpred-node\koinos
docker compose ps                              # everything should say "running"
docker compose logs --tail 30 block_producer   # what the producer is doing
docker compose restart                         # restart it
```

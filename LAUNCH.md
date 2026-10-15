# Kprediction — launch guide

Follow these steps in order. Every command goes into **PowerShell**. Commands that send something are dry runs
unless you add `--send`, so you can always look first.

> **Rule for keys:** private keys live only in the `.env` file on your PC. Never paste one into a chat, an email
> or GitHub. The one exception is the bot's key, which goes into GitHub as an encrypted *secret* (step 8).

---

## Step 0 — Move the project out of OneDrive (once)

OneDrive uploads everything in its folders to the cloud, including `.env` files with private keys. Make a clean
copy outside OneDrive:

```
git clone https://github.com/bawcejawn/Kprediction.git C:\kprediction
Copy-Item "C:\Users\cpada\OneDrive\Desktop\kprediction-git\probes\.env" "C:\kprediction\probes\.env"
cd C:\kprediction
```

From now on, work only in `C:\kprediction`. Once everything below works, delete the old OneDrive folder.

## Step 1 — Install and check everything (≈ 15 min)

```
cd C:\kprediction
npm install
cd game
npm install
npm test                 # expect: [Tests]: 38 / 38  and  ✔ Pass!
npm run check            # expect: All offline checks passed.
npm run build:sim        # the test build the rehearsal needs
cd ..
npm run bot -- rehearse --weeks 1      # ≈ 10 min, expect: All ... rehearsal checks passed.
```

`npm install` creates `package-lock.json` in `C:\kprediction` and in `game`. Commit them; they pin exact versions
for the GitHub bot:
```
git add package-lock.json game/package-lock.json
git commit -m "Add lockfiles"
git push
```

## Step 2 — Create the wallets

```
npm run bot -- keys
```

This writes the keys into **`C:\kprediction\.env`** (open it with `notepad .env`) and prints four addresses:

| Role | Key name in `.env` | What it is |
|---|---|---|
| **contract** | `CONTRACT_WIF` | The game's own address. **Send it nothing.** It must be empty until it is deployed. |
| **admin** | `OWNER_WIF` | Owner and seed owner: the node key, fees, corrections, the seed. **Back this up offline.** |
| **bot** | `OPERATOR_WIF` | Yesterday's probe owner wallet (already ~52 KOIN). Posts and resolves questions. It cannot move game funds. |
| **player** | `PLAYER_WIF` | Yesterday's probe helper wallet. Used to test deposits and answers during the soft launch. |

Back up `OWNER_WIF` and `CONTRACT_WIF` on paper or in a password manager.

## Step 3 — Fund the wallets

| Send to | Amount | Why |
|---|---|---|
| **bot** address | **+50 KOIN** (≈100 in total) | Mana for uploading the contract (~55) and for daily questions afterwards |
| **admin** address | **1,000 VHP + 100 KOIN** | The small soft-launch seed (1,000 VHP + 50 KOIN), plus Mana for admin actions |
| **player** address | **5 VHP + 5 KOIN** | Test deposits and answers |
| contract address | **nothing** | It must stay empty |

Mana refills over about 5 days, so fund the bot wallet a day early if you can.

## Step 4 — The project's node (we'll do this together)

The project needs its own block producer, set to produce for the **contract address**. It will have its own
signing key, separate from your 600k node, so the VHP is never mixed. Send me the output of these four commands
(they only read, they change nothing):

```
docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Ports}}"
docker network ls
Get-ChildItem "$env:APPDATA\koinos-node-desktop\node" -Recurse -Depth 2 | Select-Object FullName
Get-PSDrive C
```

From that I'll give you exact commands. You will then send me the node's **public** key, which is safe to share.
Never send the private one.

## Step 5 — Deploy

```
npm run bot -- deploy            # dry run: check the addresses, start block (next Monday 00:00 UTC) and settings
npm run bot -- deploy --send     # uploads and initialises the contract
git add game-data/deployment.json
git commit -m "Deployed"
git push
```

## Step 6 — Register the node's key

```
npm run bot -- register-key <the node's PUBLIC key>            # dry run
npm run bot -- register-key <the node's PUBLIC key> --send
```

The key becomes active 20 blocks (~1 minute) later.

## Step 7 — Soft-launch seed

```
npm run bot -- seed-vhp 1000 --send
npm run bot -- seed-koin 50 --send
npm run bot -- status
```

## Step 8 — Turn on the bot in GitHub

1. On github.com/bawcejawn/Kprediction, go to **Settings → Secrets and variables → Actions**.
   - **New repository secret:** name `OPERATOR_WIF`, value: the `OPERATOR_WIF` line from `.env` (only the part after `=`).
   - **Variables tab → New variable:** name `BOT_ENABLED`, value `true`.
   - Optional variable: `EXCLUDE_PRODUCERS` = your own producer address, so the game never asks about your node.
2. Go to **Actions → Kpred bot → Run workflow** to start the first run by hand. It takes a few minutes the first
   time, because it downloads recent block history.
3. Emails: on github.com, click your picture → **Settings → Notifications → Actions** and tick
   **"Notify on failed workflows only"** with email. Any run that finds a problem ends as *failed*, and GitHub emails you.

## Step 9 — The test week

Before Monday, deposit with the player wallet. A deposit before the start counts for week 0:
```
npm run bot -- deposit 2 --send
```
During the week:
```
npm run bot -- status                      # shows open questions with their numbers and options
npm run bot -- answer 3 B --send           # answer question #3 with option B
```
After the week closes (Monday, plus 1 day for corrections and 2 days for settling), claim if you won:
```
npm run bot -- claim 0 --send
```

## Step 10 — Full seed

Once week 0 has closed, settled and paid correctly:
```
npm run bot -- seed-vhp 169000 --send
npm run bot -- seed-koin 19950 --send
```
Moving KOIN needs Mana at least equal to the amount, so make sure the admin wallet's Mana is full first.

---

## What the email alerts mean

| Email says | What to do |
|---|---|
| "The pool has produced no block for N min" | Check the project's node: is the PC on, is Docker running, does the node have internet? |
| "The bot's wallet … is low on Mana" | Send the bot address some KOIN |
| "The contract is low on Mana" | Usually temporary; it refills over hours. If it keeps happening, tell me |
| "Week N is overdue to close" | A question is stuck. Run `npm run bot -- status` and tell me what it shows |
| "A transaction failed" / "generator failed" | Often a busy RPC node. If you get it more than twice in a row, tell me |

**About the 1-hour alarm:** the bot raises the alarm after 1 hour without a block, or later if the pool normally
goes longer than that between blocks. With a small seed the pool may only make a block every few hours, and
alarming after 1 hour would email you about nothing. As the pool grows, the alarm tightens to 1 hour by itself.

## Owner commands (all dry runs unless `--send`)

```
npm run bot -- status
npm run bot -- void 12 "reason"            # VOID open question #12 (only before its week closes)
npm run bot -- claim-fee                   # 5% creator fee (KOIN) to the admin wallet
npm run bot -- claim-share 10              # 10 VHP of the 2% owner share
npm run bot -- sponsor-limit 0             # stop paying players' Mana (0) — or e.g. 2 to pay up to 2 KOIN per answer
npm run bot -- pause on|off                # pause NEW deposits (withdrawals and claims always work)
```

# Knode wallets: what each one does, and how to change them

Never paste a private key or recovery words into a chat, an email or GitHub (except `OPERATOR_WIF` as a GitHub
secret). Keys live only in `.env` on your PC.

## Today

| Wallet | Address | Role | Change it? |
|---|---|---|---|
| Owner | `1635QUrBNDp7WqmFkRvrkGwjJXTtFvH717` | Game owner, game seed owner, Desk owner **and** Desk treasury | Yes: split into a new owner and a cold treasury |
| Operator (bot) | `1HsM33pF8DbXPr8Vsd4vD7hQgvZ1SHY3Vv` (rotated 2026-10-26 from 1JSTwo…ZrZ) | Posts and resolves questions; the only key on GitHub | Yes, now (audit C1-3) |
| Game contract | `1Mpmf2ERhjYpX7CCiM11WERuM4j17uT1sr` | The game's own account | No (its address is the game). Its key can't act while the switches are on: move `CONTRACT_WIF` from `.env` to an offline backup |
| Desk contract | `1FKTpXBhhHEbu5vVchM8UsVbAvPArJsRmR` | The Desk's own account | No. Same: move `DESK_CONTRACT_WIF` offline |
| Mana sponsor | `1ByDDSBUzy5zkRceELc54Jh8i41yNRoKt8` (created 2026-10-26, 1,000 KOIN) | Pays players' Mana for Knode actions within its caps (`sponsor/README.md`) | Create it when you turn the sponsor on. Its key goes in `.env` as `SPONSOR_WIF` only; it holds the KOIN that becomes its Mana |
| Your personal producer | yours | Your own node's rewards | Not part of the platform |
| Node signing keys | (not wallets) | Sign blocks for the game and Desk nodes | Only if that computer is ever compromised |

## After the changes

| Wallet | Role | Where its key lives |
|---|---|---|
| **New owner** | Game owner, seed owner, Desk owner | `.env` on your PC as `OWNER_WIF` (and `SEED_WIF`), plus your paper backup. Never connected to websites |
| **New operator** | The bot | GitHub secret `OPERATOR_WIF` (environment `bot`) and `.env` |
| **Cold treasury** | Where the Desk's funds can be withdrawn to | Paper only. It only receives |
| **Mana sponsor** (optional) | Pays players' Mana (`sponsor/README.md`) | `.env` as `SPONSOR_WIF`, plus your paper backup. Never put it on GitHub |

So you create **3 new wallets**.

## Creating a wallet (Kondor), step by step

1. In Chrome, make a new browser profile just for this (top-right profile icon → Add). Install Kondor from the Chrome
   Web Store in that profile.
2. Kondor → **Create new wallet** → set a strong password.
3. Write the recovery words **on paper**, twice, and keep the copies in two safe places. No photos, no cloud, no chat.
4. Copy the new **address** (starts with 1). Sharing the address is safe.
5. For the owner and operator only: in Kondor, open the account's settings and choose the option that shows its
   private key (WIF). Paste it straight into `.env` on your PC (and, for the operator, into the GitHub secret), never
   anywhere else. If your Kondor version has no such option, the bot can create the key directly in `.env` instead
   (`npm run bot -- keys`): ask before doing that, since such a key has no recovery words and needs its own backup.
6. The cold treasury: stop after step 4. Never export its key, never connect it to a site.

## Order and timing

| When | What | Notes |
|---|---|---|
| Any Sunday, after Saturday's windows end | **Operator** | Independent of the upgrades |
| Any time | **Desk treasury** → cold wallet | 48 h wait; finish it **before** handing the Desk over (a handover clears a pending treasury change) |
| After both upgrades are live | **Game owner**, **seed owner**, **Desk owner** → new owner | The live v3 game has no seed handover and the live Desk has no owner change at all; the upgrades add them. A handover during the 48 h upgrade wait would cancel the announced upgrade |

### Operator (Sunday)
1. Send the new operator address ~5 KOIN (Mana for its daily transactions).
2. `npm run bot -- admin set_operator operator=<new operator address> --as owner`, check it, then add `--send`.
3. Right away on GitHub: Settings → Environments → `bot` → `OPERATOR_WIF` → update (before the merge: Settings →
   Secrets and variables → Actions → `OPERATOR_WIF`). Paste the new key there.
4. Update `OPERATOR_WIF` in `.env`. Send me the new **address** for `game-data/deployment.json` (`"operator"`).
5. Actions → Kpred bot → Run workflow: it must be green.
6. Move the KOIN left in the old operator wallet to your new owner wallet.

### Desk treasury (any time)
1. `npm run desk -- treasury schedule <cold address>`, check, then `--send`.
2. 48 hours later: `npm run desk -- treasury apply --send`.
3. Send me the address for `desk-data/deployment.json` (`"treasury"`); then `npm run bot -- chain-check`.

### Owner handovers (after both upgrades)
1. Game: `npm run bot -- admin propose_owner new_owner=<new owner> --as owner --send`.
2. Seed: `npm run bot -- admin propose_seed_owner new_seed_owner=<new owner> --as seed --send`.
3. Desk: `npm run desk -- owner propose <new owner> --send`.
4. Add the new owner's key to `.env` as `NEW_OWNER_WIF` (for the accept steps only).
5. About a day later: `npm run bot -- admin accept_owner --as new --send` and
   `npm run bot -- admin accept_seed_owner --as new --send`.
6. 48 hours after step 3: `npm run desk -- owner accept --send`.
7. In `.env`: set `OWNER_WIF` and `SEED_WIF` to the new owner's key, delete `NEW_OWNER_WIF`.
8. Send me the new owner address for both `deployment.json` files; then `npm run bot -- chain-check`.
9. Move anything left in the old owner wallet `1635QU…` to the new owner or the cold treasury. Keep its recovery
   words until everything checks out, then retire it.

The bot emails you about every proposed handover: that is expected (and it's how you'd learn of one you didn't make).

## GitHub: what protects `main` (audit 2026-10-26, M-3: accepted for now)

The hourly bot saves each day's questions and results by pushing `game-data/` to `main` with the workflow's own token.
So `main` can't require pull requests: that rule would block the bot. Its ruleset blocks deleting `main` and force
pushes only. Accepted for now because anyone able to push any branch of the repository could already push `main`
directly; what matters is who can push at all:

- Only you have write access. Add nobody else as a collaborator.
- Any personal access token on your PC (for example `GITHUB_ALERT_TOKEN`, used by the node self-heal alerts) must be a
  fine-grained token for this repository with **Actions: read and write** only: never **Contents: write**, which can push
  code.
- In Settings → Rules, consider making the "Workflow guard" check required once a pull-request flow is used.

A later change can move the bot's output to its own branch (as the block snapshot already is), after which `main` can
require reviewed pull requests.

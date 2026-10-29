# Who Signs Block X

**A free prediction game on Koinos.** Every 2,400th block (about every 2 hours) is a *target*. Before it is made, you
pick the block producer you think will sign it. Get it right and you score points. The less likely your producer was
to sign, the more points, up to ×3. The week's top 2 players win 2 VHP and 1 VHP (paid by the Knode
Games vault once it is live).

It is the first game on the **Picks** contract, a small contract that **holds no tokens and has no way to move any**.
It only keeps everyone's picks and makes the chain enforce the rules.

| | Mainnet | Testnet |
|---|---|---|
| Page | `site/blockx.html` | `site/blockx-testnet.html` (not linked anywhere, not in search) |
| Chain | Koinos mainnet | Koinos Foundation testnet (`testnet.koinosfoundation.org`) |
| Games | game 2: a target every 2,400 blocks | game 2 (same settings) and game 92: a target every 300 blocks (~15 min) |
| Wallet | your Knode wallet (Kondor, guest) | a Test wallet kept in that browser, or Kondor switched to the testnet |
| Mana | paid by the Knode Mana sponsor | your test wallet pays its own (free test KOIN) |
| Results | `games-data` branch | `testnet-data` branch (or your own computer, see [TESTNET.md](TESTNET.md)) |
| Prizes | the week's top 2 (everyone is a free player in Block X), from when the vault (v6) is live | listed for testing, never paid |

## How to play

1. **Open the page** and connect a wallet (mainnet: your Knode wallet; testnet: *Make a Test wallet*, then get free
   test KOIN for it from the Telegram faucet bot `@KoinosTestnetFaucetBot` with `/faucet <your address>`).
2. **Pick.** The next 12 targets are always open. For each, choose a producer from the list. The list shows each
   producer's share of the VHP and what a right pick on them would score.
3. **Change your mind** up to 5 times per target, until the lock. Each change counts toward the daily limit of 30
   picks (50 on the fast test game).
4. **The lock.** A target stops taking picks 100 blocks (about 5 minutes) before it is made. The chain enforces this,
   so nobody, the owner included, can pick after the lock.
5. **The result.** Once the target block is irreversible, the recorder reads who signed it, scores every pick and
   updates the leaderboards (Today, This week, Last week, All time) within the hour (testnet: within 20 minutes).

## Scoring

A right pick scores

```
min(3, top producer's VHP ÷ your producer's VHP)
```

using the VHP on the hourly handicap card at the moment of the lock. A wrong pick scores 0.

- Koinos chooses each block's signer in proportion to VHP, so a big producer signs often and scores ×1, while a
  producer with a quarter of the top's VHP signs less often and scores ×3 (capped).
- **The cap of 3** keeps a lucky long shot from winning a week. Every producer with at least a third of the top's VHP is
  an equally good pick on average. In simulation, players who think win about 96% of weeks (without the cap, lucky
  players would win about 88%).
- A producer missing from the card (a brand-new one) scores ×1 (audit BX-3).
- The card used is the latest one taken **at or before** the lock, never a later one (audit BX-3).
- Points are kept in hundredths, so totals never drift.

**Ties** on a leaderboard: more right picks first, then the earlier last right pick, then the address.

## Leaderboards and prizes

Two boards, as in every Knode Games game:

- **Staked:** wallets holding at least 1 VHP or with a Knode stake.
- **Free play:** everyone else, guest wallets included.

Your place on the page is your place on your own board (Staked or Free play). Medals on the Free play board follow
the prize rule below (picks on 3 days, ties share), and last week's come from the recorder's frozen prize list
(audit BX-14). The "×N if right" next to a producer is from the current card; the card taken at or before the lock
decides the score.

**Prizes:** the week's top 2 players win 2 VHP and 1 VHP. Player rule (owner, 2026-10-28, every game): only VHP
staked *in a game* makes a staked player there; nobody can stake in Block X, so every player is a free player and may
win, on either board. The Vault (v6) pays them: the recorder publishes `blockx/vault/W<week>.json` on `games-data`
once the week is final (1st and 2nd, ties included, at most 10 per place). To win, a wallet needs at least one point
and picks on **3 different days** that week (so one visit can't win). Ties share the prizes of the places they cover.
A week becomes final 12 hours after it ends. Prizes are listed only from the week the Knode Games vault (v6) goes live.
Nothing is owed for earlier weeks.

**Sponsored games (audit BX-27).** Sponsor v3 pays the Mana for `pick` on the Picks contract for any game on it. A new
game the owner adds with `announce_game` is sponsored too, within the same caps (50 Mana per wallet per day, 2,000 for
all free play, 5,000 in total, and the per-action Mana limit). That is intended; a future sponsor version could list
game ids if a game ever needs its own budget.

## Why your funds are safe

- The Picks contract **makes no call to any other contract**. The build fails if one appears (`npm run check`).
- It is uploaded with all three authority overrides **on**, and its `authorize` always refuses `contract_call` (moving
  anything out of its account) and `transaction_application` (paying Mana). The key it was uploaded with has no power
  left afterwards.
- New code needs the owner's signature, the announced sha256 and a 48-hour wait. Be clear about what that means
  (audit BX-8): the wait gives everyone 48 hours to see the change coming, but **the hash alone doesn't show what new
  code would do**. An upgrade that keeps the overrides on could, in principle, add a way to move tokens (the account
  holds none) or rewrite stored picks. So before any `schedule_upgrade`, the new source and a reproducible build are
  published, the upgrade event is watched, and rounds already scored are frozen in the published week files.
- Only the player can pick for their wallet (audit BX-28): the contract checks the caller is the player or the
  player's own wallet contract (a smart wallet). A smart wallet's `authorize` is told only that its owner is calling
  Picks, not which producer was picked.
- Picking never asks you to send tokens. On mainnet the Knode Mana sponsor pays the Mana. On the testnet, your own
  test wallet pays a little test Mana.

## Where everything lives

| Part | File | What it does |
|---|---|---|
| Contract | `picks/assembly/Picks.ts` | stores picks, enforces lock, window, caps; no tokens |
| Shared math | `site/blockx-math.js` | targets, lock, scoring, leaderboards, prizes; used by both page and recorder |
| Recorder | `bot/games/blockx.ts` | reads blocks and picks, scores, writes the leaderboard files |
| Page | `site/blockx.html`, `site/blockx.js` | mainnet page; `site/blockx-testnet.html` is the testnet copy |
| Testnet wallet | `site/testnet-wallet.js` | signs only testnet picks |
| Admin tool | `bot/picks.ts` (`npm run picks`) | upload, announce, apply, pause, lock-test, mana-test |
| Testnet build | `picks/scripts/build-testnet.cjs` | the audited code with exactly 3 settings changed |
| Recorders in CI | `.github/workflows/games.yml`, `games-testnet.yml` | hourly (mainnet) / every 20 min (testnet) |

More detail:

- [CODE-WALKTHROUGH.md](CODE-WALKTHROUGH.md): what each part of the code does, step by step.
- [TESTNET.md](TESTNET.md): the PowerShell runbook to put it on the testnet.
- [TEST-PLAN.md](TEST-PLAN.md): the checklist for testing.

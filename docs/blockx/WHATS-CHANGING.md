# What goes live with Who Signs Block X, and what changes

Three pieces. Each is on GitHub branch `picks` (never `main` until you say so), each has a fingerprint (sha256) you
can check, and nothing goes on chain until the audit is done and you run the command.

| # | Piece | Today on mainnet | After launch | Who uploads |
|---|---|---|---|---|
| 1 | **Picks contract** (`picks/`) | nothing | new contract, game 2 = Block X | you (`npm run picks`) |
| 2 | **Mana sponsor** (`sponsor/`) | v2 `fa4659e6…` | v3 `21bec825…` (same address, same KOIN, same counters) | you (`npm run sponsor`) |
| 3 | **Block X website + recorder** (`site/blockx.*`, `bot/games/blockx.ts`) | page shows targets only | live picks, results, boards | Claude merges `picks` → `main`, with your OK |

## 1. Picks contract (new)

- One contract that keeps everyone's picks for KnodeGames games. Block X is its game 2; later games (Survivor…) are
  more games in the same contract.
- Holds no tokens and can never move any. Its own account refuses every transfer and refuses to pay Mana.
- New code only with your owner key, a sha256 announced 48 hours ahead.
- Audited 2026-10-27, fix-checked, tested on the testnet 2026-10-28 (lock and Mana measured: see TESTNET-RESULTS.md).
- Fingerprint: `700c296a1064b904299c156061d6caf8fcabd0b1765968903f29d89d2426c594`.

## 2. Mana sponsor v2 → v3

The sponsor is the wallet `1ByDDSBUzy5zkRceELc54Jh8i41yNRoKt8` that pays players' Mana. The upgrade re-uploads its
code from its own key: the address, its KOIN, its settings and today's counters stay.

**What v3 adds**

| Change | Why | Your setting |
|---|---|---|
| Allowlist (up to 8 actions on other contracts) | so Block X picks can be paid without new sponsor code | the Picks `pick` is added once the Picks contract is live |
| Free players collect their own prizes | a guest who wins 2 VHP can claim it without KOIN | – |
| A stake counts like held VHP from 1 VHP | fairness for stakers (fix-check L-3) | – |
| Room for 10 picks in one transaction; refuses nested data in allowlisted calls; refuses transactions with more than 4 signatures early | audit S3-1, S3-2, S3-8 | – |
| **Ceiling 5,000 Mana a day** (was 1,000) | more players and games | everyone 5,000 a day |
| **Free players share at most 2,000 a day** | staked players always keep 3,000+ | free 2,000 |
| **50 Mana per player per day, 300 per week** | room for several games | 50 / 300 |
| **Per-action Mana limits + the Mana adjuster** | see below | from measurements |

**Per-action Mana limits, in plain words.** The chain charges the sponsor only what a transaction really uses (a
Block X pick: about 0.05 Mana). But the sponsor says yes *before* the transaction runs, so it has to count the most
the transaction may use (its limit) against the player's 50 a day and everyone's 5,000. Until now every action asked
for 1 Mana, so one pick used up 1 of a player's 50 and 1 of everyone's 5,000 though it really cost 0.05. Now each
kind of action gets its own limit, about twice the most it has ever used (a pick: about 0.1; 0.15 to start, from the
testnet number). The sponsor
refuses a transaction asking for more than its actions' limits, and the website asks for exactly that.

**The Mana adjuster** keeps the limits right:
`npm run sponsor -- mana-report` reads the sponsored transactions on mainnet (what each really used), and suggests a
limit for each action. It never sets a limit below 1.25 times the most an action has used, never lowers a limit,
and doubles the limit of any action seen to run out of Mana. The website is updated first with limits that fit both
the old and the new ones, so a player's transaction is never refused for its limit. Run it weekly or after any upgrade.

**What v3 does not change:** only the sponsor wallet's key changes its settings or moves its KOIN; `disable` still
stops it at once; it still pays only listed player actions, signed by the player alone.

**Status:** first audit (no Critical/High/Medium), fix-check ("ready for mainnet from the code"), then today's 5,000
ceiling and per-action limits, reviewed by an independent reviewer (see the review notes), **to be audited by Repo
Lens with the Picks contract**, then a testnet trial. Review notes: docs/history/REVIEW-2026-10-28-sponsor-mana-limits.md.

## 3. Website and recorder

- `site/blockx.html`: the new look (chain strip, producer buttons, your stats), live picks once the contract is on.
- The recorder (GitHub Actions, no keys) reads blocks and picks every hour and publishes the results and boards.
- The website pins the Picks contract's address so a guest's wallet can only ever sign a pick on it.
- Prizes start with the vault (v6).

## Order on launch day(s)

1. Repo Lens audit of 1 and 2 → Claude fixes → Repo Lens fix-check.
2. Sponsor v3 on the testnet (trial).
3. Sponsor v3 on mainnet: upload, `config` with the new caps, check `status`.
4. Picks contract on mainnet (docs/blockx/MAINNET-LAUNCH.md). Then `npm run sponsor -- mana-limit picks:pick 0.0477
   --source testnet --save` for its first limit, `site-limits --send` (commit, push, wait), and `config --send` so the
   sponsor pays Block X picks.
5. Announce game 2, wait 48 hours, apply.
6. Claude publishes the site (merge `picks` → `main`), the recorder starts.
7. After a day of play: `npm run sponsor -- mana-report --save`, `site-limits --send` (commit, push), `config --send`.

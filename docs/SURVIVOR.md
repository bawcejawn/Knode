# Survivor

A free, season-long game in Knode Games. Each day you pick one Koinos block producer that you think will stay out of
the bottom of the day's handicapped block count, the **out-zone**. You have two lives and can use each producer once a
season. The last players standing win the season's prize.

| | |
|---|---|
| Kind | Free (the Knode Mana sponsor pays the Mana; no entry fee, no wager) |
| Season | 14 UTC days, Monday 00:00 to Monday 00:00 |
| Picks | One a day, on the KnodeGames Picks contract (game 3). Each day locks at 23:55 UTC the night before and opens 7 days ahead |
| Prizes | 4 VHP for 1st and 2 VHP for 2nd each season, paid by the Knode Games vault once it is live |
| Page | `site/survivor.html` |
| Status | Built and audited on branch `survivor`. Not launched: waits for the Picks contract (Build 3) and the vault (Build 1) |

Contents: [How to play](#how-to-play) · [The rules in full](#the-rules-in-full) · [How it works](#how-it-works) ·
[Files](#files) · [Testing](#testing) · [Launch](#launch) · [Design notes](#design-notes)

The code explained line by line, in plain English: [SURVIVOR-CODE-WALKTHROUGH.md](SURVIVOR-CODE-WALKTHROUGH.md).
Trying it on the testnet: [SURVIVOR-TESTNET.md](SURVIVOR-TESTNET.md). Running it after launch:
[SURVIVOR-RUNBOOK.md](SURVIVOR-RUNBOOK.md).

## How to play

1. **Open the Survivor page** and connect a wallet: Kondor, KOIN Vault or a guest wallet.
2. **Join a season by picking for its day 1.** Each upcoming day has a row on the page with a menu of producers. Choose
   one and press **Pick**, then confirm in your wallet. You can change a pick up to 5 times until it locks.
3. **Pick a producer every day.** Choose one you think will sign enough blocks, for its handicap, to stay out of the
   out-zone. You can pick up to 7 days ahead, so a busy week can be filled in one sitting.
4. **Watch "Today".** The page shows every producer's blocks and score so far today, live from the chain, with the
   out-zone shaded red. Your producer is marked.
5. **Stay in.** Each producer can be used once a season, so save the strong ones for when you need them.

What each producer's **×** number means: it is the handicap. A producer that signs a quarter as many blocks as the
biggest one has ×4, so every producer has the same expected score and any of them can be a safe pick.

## The rules in full

**The day's score.** For each producer in the field:

```
score = blocks it signs that UTC day × its handicap
handicap = blocks of the busiest producer ÷ its own blocks   (over the 7 days d−8 … d−2)
```

The handicap uses the 7 days ending two days before, so it is known a full day before the lock. It is built from
blocks the producers actually signed, not their VHP: some producers sign fewer blocks than their VHP suggests (seen in
October 2026), and a VHP handicap would put them in the out-zone almost every day.

**The field.** Producers with at least 280 blocks in those 7 days (about 40 a day).

**The out-zone** grows through the season, from a quarter of the field on day 1 to half on day 14:

```
out-zone size on season day n = floor(field size × (12 + n) ÷ 52)
```

With 17 producers that is 4, 4, 4, 5, 5, 5, 6, 6, 6, 7, 7, 7, 8, 8. A producer is out when its score is below the
score at the out-zone line. A tie at the line is safe.

**Lives.** You start with 2. You lose one when:
- your producer lands in the out-zone;
- you have no pick that day;
- your producer isn't in that day's field;
- you already used that producer this season.

At 0 lives you are out of the season.

**The safety net.** If nobody still in has a safe pick on a day (each player's pick landed in the out-zone, or they
made no valid pick), nobody loses a life for the out-zone that day. That producer still counts as used. A missing pick,
a producer not in the field and a producer used before always cost a life, even on such a day.

**Picking ahead.** You can pick up to 7 days ahead, but a day's field (who has enough recent blocks) is set the day
before. If your producer isn't in that day's field, the pick costs a life, and the safety net doesn't cover it. The page
reminds you to check early picks once the field is out.

**Who counts.** Wallets that missed the 1-VHP check still play: they count as "still in" for the safety net and for the
end of the season, but can't win a prize. (Owner's decision pending; see the Repo Lense audit, SV-A10.)

**The end.** The season ends after the day on which 2 or fewer players are left (if more than 2 started), or after
day 14. Results are final 12 hours later.

**The ranking.**
1. Who lasted longest (still in beats out; out later beats out earlier).
2. More lives left.
3. Higher total score of your picks.

Equal on all three: the same place.

**Prizes.** 4 VHP for 1st and 2 VHP for 2nd. Tied players split the prizes of the places they cover. You can win only
if all of these hold:
- you held at least 1 VHP (or a Knode Games stake) at every daily check while you were in the season;
- you weren't knocked out by a missed pick;
- the season had at least 3 players who could win (the two rules above) and who each made at least 2 valid picks.

A stake counts only from 1 VHP, the same as a wallet balance.

These rules stop people from farming the prize with empty or idle wallets. Prizes are paid by the vault once it is
live; until then the page says so.

**Knode's own producers.** Knode Games runs two of the producers (the Knode pool and Knode Swap nodes). They are in the
field like any other producer and can be picked. The page says so.

## How it works

```
 The chain (Koinos)                      GitHub Actions, every hour                    The website
 ─────────────────────────────           ─────────────────────────────────────       ──────────────────────
 blocks (who signed each one)  ───────▶  recorder bot/games/survivor.ts      ───▶   games-data/survivor/
 Picks contract, game 3 (picks)  ─────▶    counts each finished UTC day,              days.json  fields.json
                                           two nodes must agree,                       S001.json  index.json
                                           plays the season with                              │
                                           site/survivor-math.js                              ▼
                                                                              site/survivor.html + survivor.js
 your wallet ◀──── a pick you confirm ─────────────────────────────────────── (same survivor-math.js; live
                                                                               standings from recent blocks)
```

1. **Picking.** The page asks your wallet to sign one call to the Picks contract: "player X picks producer Y for round
   d of game 3". The contract stores it and refuses it after the lock (23:55 UTC the night before) or more than 7 days
   early. Nobody, including Knode Games, can add, change or backdate a pick: the chain enforces it.
2. **Recording.** Every hour a GitHub Actions job runs the recorder. It holds no keys and only reads the chain.
   - It counts the blocks each producer signed in each finished UTC day. A day counts only once its blocks are
     irreversible and two independent nodes agree on every block.
   - It publishes today's and tomorrow's field and handicaps.
   - It reads each season day's picks from the contract, on both nodes, and checks who holds 1 VHP.
   - It plays the season with `site/survivor-math.js` and publishes the standings.
3. **Publishing.** A second job, which runs none of the repository's code, checks every file's shape. It pushes the
   files to the public `games-data` branch, which the website reads.
4. **The page.** The page and the recorder use the same file, `site/survivor-math.js`, so they always agree. The page
   also counts today's blocks itself, so "Today" is live; the recorded result is the one that counts.

## Files

| File | What it is |
|---|---|
| `site/survivor-math.js` | The rules: the clock, the field and handicaps, the out-zone, a day's score, a whole season, ranking and prizes. Shared by the page and the recorder. No network, no wallet |
| `bot/games/survivor.ts` | The recorder (`npm run survivor`). Reads two nodes; writes `days.json`, `fields.json`, `S<season>.json`, `index.json` |
| `.github/workflows/games.yml` | The hourly job: records Block X and Survivor, then checks and publishes their files |
| `site/survivor.html`, `site/survivor.js` | The page |
| `site/chain-blocks.js` | Shared: loads recent blocks for live standings (also used by the Race and Pulse pages) |
| `bot/survivor-test.ts` | The testnet tool (`npm run survivor-test`) |
| `tools/survivor-testnet/` | The test page's wallet and banner, a fake testnet and a full rehearsal |
| `tests/audit/site.survivor.test.mjs` | Tests of the rules and the page |
| `tests/audit/survivor-recorder.test.mjs` | Tests of the recorder against fake nodes (outages, disagreeing nodes, file size, prizes) |
| `tests/audit/survivor-testnet.test.mjs` | Tests of the testnet tool and its local server |
| `docs/SURVIVOR-RUNBOOK.md` | Launch settings and what to do when the recorder warns |

**The data files** (`games-data/survivor/` on the public branch):

| File | Holds |
|---|---|
| `days.json` | For each of the last 60 UTC days: its block heights and each producer's block count |
| `fields.json` | Today's and tomorrow's field: each producer's 7-day blocks (k) and handicap (h), and the out-zone size |
| `S001.json`, … | A season: each day's field, block counts and picks (for players still in), and the result: every player's lives, log (one letter a day: s safe, o out-zone, n no pick, f not in the field, u already used, v saved), total, place, and the prizes once final |
| `index.json` | Season 1's start, the Picks contract, and the list of seasons |

## Testing

All of these run offline. Run them from `C:\kprediction` in PowerShell:

```powershell
node --test tests/audit/site.survivor.test.mjs
node --import tsx --test tests/audit/survivor-recorder.test.mjs
node --import tsx --test tests/audit/survivor-testnet.test.mjs
```

The full suites, which CLAUDE.md asks for before any merge:

```powershell
node --test tests/audit/site.*.test.mjs
npm run test:audit:serial
```

The whole testnet flow against a fake testnet takes 5–10 minutes. It runs a full season and makes a pick on the test
page in a real browser:

```powershell
node --import tsx tools/survivor-testnet/rehearse.mjs
```

Then on the real testnet: [SURVIVOR-TESTNET.md](SURVIVOR-TESTNET.md).

## Launch

Steps in [SURVIVOR-RUNBOOK.md](SURVIVOR-RUNBOOK.md):
1. Register game 3 on the Picks contract with the exact settings listed there.
2. Set `FIRST_DAY` to the launch Monday.
3. Merge the branch.
4. Add the game to `site/games.json` and the menus.

The recorder refuses to record a season if game 3's settings on the chain differ from what the rules expect.

## Design notes

- **Why recent blocks for the handicap.** On 25–27 October 2026, three producers steadily signed 75–80% of what their
  VHP predicts. With a VHP handicap they landed in the out-zone about 90% of days, nobody else ever lost a life, and
  seasons always ran to the last day. With a handicap built from recent blocks, every producer lands in the out-zone
  16–40% of days. Simulation: `claude/builds/04-survivor-sim.mjs` in the Knode Games project.
- **Why two weeks and a growing out-zone.** Four-week seasons lock newcomers out for too long (owner, 27 Oct). Over
  two weeks, a fixed quarter out-zone left most players standing at the end, so the out-zone grows to half.
- **Simulated season length** on the live 17-producer field: ends about day 11 with 10 players and day 13 with 50; with
  200 players about 4 are left on day 14 and the ranking decides.
- **Audits.** An independent audit found 1 High, 4 Medium, 4 Low and 3 Info issues, all fixed or accepted. The worst:
  idle wallets could farm the prize through the safety net. A fix-check and a re-check followed; the re-check's verdict
  was "ready". Then the owner's Repo Lense audit (28 October 2026) found 1 Critical (testnet kit only), 2 High and 5
  Medium issues among 26; all were fixed except the owner's open decisions (SV-A2's residual, SV-A10, SV-A19). See
  `claude/builds/04-survivor-plan.md` in the project.

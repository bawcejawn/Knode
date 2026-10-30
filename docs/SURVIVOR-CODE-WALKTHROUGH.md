# Survivor, line by line

This explains what every part of Survivor's code does, in plain English, in the order the code runs. Line numbers are
from branch `survivor` on 28 October 2026; they move a little when code changes, but the section names stay.

Read it with the file open beside it. In VS Code, Ctrl+G jumps to a line.

| Part | File | Lines | Job |
|---|---|---|---|
| 1 | `survivor-math.js` | 235 | The rules. Pure arithmetic: no internet, no wallet |
| 2 | `bot/games/survivor.ts` | 388 | The recorder: reads the chain every hour and writes the results |
| 3 | `.github/workflows/games.yml` | (Survivor parts) | Runs the recorder, checks its files, publishes them |
| 4 | `survivor.html` + `survivor.js` | 339 | The page players use |
| 5 | `bot/survivor-test.ts` + `tools/survivor-testnet/` | 553 | The testnet kit |

Two words first:
- A **day** is a UTC day, numbered from 1 January 1970. Day 20,773 is 16 Nov 2026. Each day is one **round** on the
  Picks contract.
- An **address** is a Koinos wallet or contract, like `1Mpmf2…`.

---

## 1. `survivor-math.js`: the rules

Both the page and the recorder load this one file, so they can never disagree about who is out. It does no internet
calls and touches no wallet: it only does arithmetic on data it is given.

### Lines 1–49: the rule book in words
The big comment is the rules in plain language: format, score, out-zone, lives, safety net, end, ranking and prizes.
At the end (lines ~43–49) it explains **the clock**: the normal game is the mainnet game, and `withConfig` makes the same
game with a faster clock for the testnet.

### Lines 50–53: the wrapper
`(function (root) { … })(window or globalThis)` is the standard way to make one file work both in a browser (where it
attaches to `window`) and in Node (the recorder, where it attaches to `globalThis`). `"use strict"` makes JavaScript
refuse sloppy mistakes. `MAINNET_DAY = 86400000` is one day in milliseconds (24 × 60 × 60 × 1000).

### Lines 53–71: `make(cfg)`: the game's numbers
`make` builds one copy of the game from a small settings object (`cfg`). The mainnet copy is made once at the bottom
(line 234). The constants:

| Name | Value | Meaning |
|---|---|---|
| `DAY` | 86,400,000 (mainnet) | Length of a round in ms. 3,600,000 (1 hour) on the testnet |
| `GAME_ID` | 3 | Survivor's number on the Picks contract (Block X is 2) |
| `SEASON_DAYS, LIVES, USES` | 14, 2, 1 | 14 days a season, 2 lives, each producer once |
| `FORM_DAYS, FORM_GAP` | 7, 2 | The handicap uses 7 days, ending 2 days before |
| `MIN_FORM` | 280 | Blocks needed in those 7 days to be in the field (scaled for a test clock) |
| `LEAD_MS` | 300,000 | Picks lock 5 minutes before the round starts |
| `AHEAD_MS` | 7 days | Picks open 7 days ahead |
| `PICKS_PER_DAY, MAX_CHANGES` | 20, 5 | Shown on the page; the contract enforces them |
| `OUT_FLOOR` | 0 | Testnet only: a minimum out-zone for a small field |
| `PRIZES` | [4, 2] | VHP for 1st and 2nd |
| `MIN_PRIZE_PLAYERS, MIN_VALID_PICKS` | 3, 2 | A season needs 3 players who can win (1 VHP at every check, not out by a missed pick) with 2+ valid picks to pay prizes |
| `CODE` | s o n f u v | One letter per day in a player's log: safe, out-zone, no pick, not in field, used, saved |
| `CORRECTION_MS` | half a day (12 h) | Results are final this long after the season ends |
| `FIRST_DAY` | null | Season 1's first day. null until launch |

`round4` rounds to 4 decimals. `isAddr` checks the shape of a Koinos address. `cmpStr` sorts text the same way on every
computer, so ties always break the same way.

### Lines 73–96: time
- `dayIndex(t)`: which day a moment is in (time ÷ day length, rounded down).
- `dayStart(d)`: the moment a day starts.
- `dayLabel(d)`: a day as text, like "2026-11-16". On the test clock it includes the hour.
- `isMonday(d)`, `isSeasonStart(d)`: mainnet seasons must start on a Monday; a test season can start on any round.
- `lockTime(d)` (line 81): when picks for day d stop: its start minus 5 minutes, which is 23:55 UTC the night before.
- `isOpen(d, t)` (line 83): can a pick for day d land at time t? Three conditions, exactly the Picks contract's rule:
  - the day is a real future round;
  - it isn't locked yet;
  - it is no more than 7 days away.
- `openDays(t)` (line 85): every day open at time t, soonest first. The page shows one row for each.
- `seasonOf(d)` (line 91): which season day d is in, and which day of it (1–14), counting 14-day blocks from
  `FIRST_DAY`. Before Season 1, or with no launch set, it answers null.
- `seasonStartDay(season)`: the first day of a season.

### Lines 98–119: the field and the handicap
- `formDays(d)` (line 100): the 7 days behind day d's handicap: d−8 to d−2.
- `fieldFor(d, days)` (line 103) builds day d's field from the recorded days:
  - It adds up each producer's blocks over those 7 days. If any of the 7 days isn't recorded yet, it answers null:
    no guessing.
  - It keeps producers with at least `MIN_FORM` blocks.
  - It sorts them, biggest first.
  - It gives each a handicap `h = top ÷ k`. The biggest producer gets ×1; one with a quarter of its blocks gets ×4.
- `outSize(m, n)` (line 116): how many of `m` producers are in the out-zone on season day `n`:
  `floor(m × (12 + n) ÷ 52)`. The testnet floor applies only when set, and never takes the whole field.

### Lines 121–135: one day's result: `scoreDay(field, counts, n)`
1. Each producer's score = blocks that day × its handicap, rounded to 4 decimals (line 128).
2. Sort best first.
3. `o` = the out-zone size. The **line** is the (o+1)-th lowest score. Everyone strictly **below** the line is in the
   out-zone, so a tie at the line is safe.

Example: 8 producers on day 1 have `o = 2`. With scores 10, 9, 8, 7, 6, 4, 4, 3, the line is the 3rd lowest = 4. Only
the producer with 3 is out; both 4s are safe.

### Lines 137–182: a whole season: `playSeason(days)`
This replays the season from its first day, every time, from the recorded data. Replaying means the result can always
be re-checked by anyone.

- **Line 145–148: who is in.** Everyone with a pick on day 1. `started` remembers how many.
- **Line 150–152: one day at a time, in order.** It stops at a gap or once the season is over.
- **Lines 153–157: the day's facts.** The out-zone (from `scoreDay`), each player's pick, and who failed the 1 VHP check
  that day (`noVhp`).
- **Lines 158–162: each player's fate**, checked in this order:

  | Code | When |
  |---|---|
  | `none` | No pick |
  | `field` | The producer isn't in the field |
  | `used` | You already used that producer this season |
  | `out` | The producer is in the out-zone |
  | `safe` | Anything else |

- **Line 165: the safety net.** `allLose` is true when nobody still in is safe.
- **Lines 166–175: apply it.**
  - Failing the VHP check makes you ineligible for prizes for the season (line 167).
  - A valid pick (safe or out-zone) marks the producer used and adds its score to your total (line 169). Wrong or
    missing picks add nothing.
  - Safe: write `s`, no life lost.
  - On a safety-net day, an out-zone pick writes `v` (saved) and loses no life. The net never saves a missing or wrong
    pick; that was the audit's main finding.
  - Otherwise write the letter and take a life. At 0 lives, `outN` records the day you went out.
- **Lines 177–178: the end.** The season is over after a day that leaves 2 or fewer players (if more than 2 started),
  or after day 14.
- **Line 180: the result,** ranked.

### Lines 184–192: `rank(players)`
Each player gets a three-part key:
1. how long they lasted (still in counts as infinity);
2. lives left;
3. total score.

Players are sorted by that key, best first; the address breaks exact ties so the order is always the same. Equal keys
share a place, so two players can both be "1st".

### Lines 194–212: `prizes(players)`
- **Line 196, `validPicks`:** counts a player's safe, out-zone and saved days.
- **Line 198, `outByMissing`:** were you knocked out on a day with no pick?
- **Line 200:** no prizes at all unless 3+ players made 2+ valid picks. A few idle wallets can't win.
- **Line 201:** only eligible players count: they held 1 VHP at every check and weren't knocked out by a missed pick.
  Places are counted again among them.
- **Lines 203–211:** the money. Walk down the places. If several players share a place, they share the prizes of all
  the places they cover. Three tied for 1st share 4 + 2 = 6, so 2 VHP each. Amounts are rounded **down** to 8 decimals
  (VHP has 8), so the total can never exceed 6 VHP.

### Lines 215–235: hand the game out
- `Object.freeze` makes the finished game read-only, so no other script on the page can change a rule.
- `MAINNET` (line 224) is the real game's settings.
- `withConfig` (line 227) makes a test-clock copy, after checking its settings are sensible: 10 minutes to 24 hours,
  whole minutes, a floor of 0–3.
- Line 234 publishes the mainnet game as `KSurvivor`.

---

## 2. `bot/games/survivor.ts`: the recorder

Runs once an hour on GitHub (and every 2 minutes in the testnet kit). It **holds no keys and sends nothing**: it only
reads the chain and writes files. Its four steps match its comment at the top (lines 1–23).

### Lines 24–66: setup
- It loads koilib (the Koinos library), Node's file tools and the shared helpers, then `survivor-math.js`.
- `S` is the game it plays: mainnet, unless a testnet run hands it a test clock.
- The node addresses come from settings: `RPC` and `RPC_CHECK`, the second node that must agree.
- `MAX_DAYS_PER_RUN = 3`: it catches up at most 3 days a run, so a long outage is worked off over a few runs instead
  of one huge run.
- It keeps 60 days of history, and chases an unfinished season back at most 50 days.
- `type …` lines describe the shape of each record, so mistakes show up as errors.

### Lines 68–102: files from the last run
Each run starts from the files the previous run published.
- `readJson` reads one file and refuses symbolic links (a trick to read other files).
- `loadDays` keeps a recorded day only if its numbers add up: the block counts sum to the day's blocks, and the
  heights match. A damaged entry is dropped and simply recorded again.
- `loadSeason` keeps a season's days only in order from day 1, with no gaps and with valid addresses. It reads both
  file versions (v2 writes each wallet and producer once; see below) and never keeps the old result: every run plays
  every season again from its days (Repo Lense SV-A4).
- `defaultPicksContract` reads the Picks contract's address from `picks-data/deployment.json`.

### Lines 104–190: reading the chain
- `headOf` gets the newest block and the newest **irreversible** block: the chain can't change it any more.
- `blockReader` gets one block's time, or a range of blocks:
  - 200 per request, 4 requests at once;
  - every block in order;
  - any gap or wrong order is an error, not a guess.
- `readPicks` lists every pick for a day from the Picks contract, 100 at a time. Over 100,000 picks it stops with an
  error instead of quietly cutting the list (audit SV-9).
- `gameProblem` (line 159) compares game 3's settings on the chain with what the rules expect: one producer, list
  size 1, time lock, a round of exactly one day starting at 00:00, 5 minutes lead, 7 days ahead, 5 changes. If anything
  differs, seasons aren't recorded, because a mismatched round would score the wrong picks.
- `readRanked` decides who passes the "hold 1" check: at least 1 VHP in the wallet, or at least 1 VHP staked in the
  Knode game contract (a dust stake doesn't count: Repo Lense SV-A3). A failed stake read is an error, so the day is
  tried again next run instead of costing a staker the season (SV-A7).

### Lines 192–202: two helpers
- `heightAt` finds the first block at or after a moment, by repeatedly halving the search range (a binary search).
- `tally` counts how many blocks each producer signed.

### Lines 204–227: one run begins
- It picks the game (line 205) and where to read and write.
- Line 211: a mainnet season must start on a Monday.
- It reads the head and the irreversible block time from the main node, and sets up the second node.

### Lines 230–252: which seasons to look at
- `lastDone`: the last day whose following day already has an irreversible block, so the day is complete and final on
  the chain.
- Line 239: game 3's settings are checked once per run. If they're wrong, seasons pause and a warning says why.
- Every known season stays on the list (audit SV-4), and every one is played again from its days each run, final or
  not (Repo Lense SV-A4). A final season reads nothing new from the chain.

### Lines 254–312: step 1, record days
- **`recordDay(d)`**, lines 258–289:
  - It finds the day's first and last block. The fast path starts right after the previous day's last block, but
    always checks that the block before is from the day before. If the saved start doesn't fit, it searches again from
    scratch in the same run (fix-check FC-1).
  - It reads every block of the day, and the same blocks from the second node. Every signer and time must match, or
    the day waits for the next run.
  - It saves the day's height range and each producer's block count.
- **Lines 291–312: the order.**
  - First the 8 days behind today: those are what today's and tomorrow's handicaps need, so the game always moves
    forward.
  - Then, with what is left of the 3-a-run budget, older days an unfinished season still needs after an outage.
  - Never more than 50 days back. A season stuck that long gets a warning for the owner, instead of being chased
    forever (fix-check FC-2).

### Lines 314–321: step 2, today's and tomorrow's handicaps
For today and tomorrow it builds the field with `fieldFor` and saves it with the season, the day number and the
out-zone size. The page shows these, so players know the handicaps a day before they lock.

### Lines 323–367: step 3, play the seasons
- **`heldOf` (line 325):** asks both nodes who holds 1 VHP. Only those **both** nodes agree on pass (audit SV-7).
- **For each unfinished season (lines 331–366):**
  1. Replay what is recorded so far (line 333).
  2. While the season isn't over, take its next day (line 336), and only if that day is fully recorded and its 7-day
     handicap window is complete (lines 337–339).
  3. Read that day's picks on both nodes; they must agree, or the day waits (lines 341–348).
  4. From day 2 on, keep only the picks of players still in (line 350). That keeps files small, and a spam wallet that
     never joined adds nothing (audit SV-2).
  5. Ignore any pick made at or after the lock time (line 352). The chain already refuses those; this checks again.
  6. Run the VHP check on everyone still in, and store only the wallets that **failed** it (line 356). Usually that is
     few, so files stay small.
  7. Add the day and replay the season (lines 358–359).
  8. The season is **final** once it is over and 12 hours have passed since its last day (line 363). Only then are
     prizes worked out (line 364).

### Lines 369–383: step 4, write
It writes four kinds of file:
- `days.json` (the last 60 days);
- `fields.json`;
- one `S###.json` per season;
- `index.json` (Season 1's start, the Picks contract, the list of seasons).

Any problem becomes a warning line, which GitHub shows on the run.

### Lines 385–388: run it
When started as a program (`npm run survivor`), it connects to the two nodes from the settings and runs once.

### Changes after the third Repo Lense pass (30 October 2026)
- **Publish check has a clock** (S3-1): days, stake readings, finals, fields and vault files dated after the job's own
  time (an hour's slack) are refused; a vault file only for a week that is over; a vault file whose stakes were read late
  is held (S3-11). A failing vault file is left out on its own (S3-7); the season list in `index.json` only grows
  (S3-8, checked against the published one).
- **Recorder:** a day whose checks started within the budget is kept (S3-2; budget 8 min, `SURVIVOR_BUDGET_MS`); the
  vault comparison between nodes uses settings only (S3-5); published vault files come back from `games-data` and are
  re-emitted as they are, never rebuilt (S3-6); a down check node no longer stops the run (S3-9); one-node days are
  re-checked oldest first with their own slots (S3-10); the folder swap stays two renames everywhere (S3-18).
- **Workflow:** job 45 min, Block X step 25, Survivor 15 (S3-3); a recorder that failed has its files left out
  (S3-20); Survivor runs only from a successful fetch of the last run's files; Survivor's vault files come into PREV
  (S3-6) and published ones aren't checked again; no empty first commit (S3-24). (S3-21, `python3 -I` for Block X's
  check, is left to the Block X chat: its tests pin that line.)
- **Page:** your own pick is flagged whenever its producer is already used or picked for another day (S3-4); the clock
  keeps the largest chain lead seen (S3-12); "handicaps aren't out yet" instead of "costs a life" when there's no field
  (S3-13); sent picks stay listed until seen (S3-14); a tab that comes back reads again (S3-15); guests are told to pick
  early (S3-16); no picks offered after a season ended (S3-28); picking pauses if game 3's settings on the chain differ
  from the page's (S3-29).
- **Testnet kit:** `record` lets a crashed swap be put back (S3-17); the Picks build first reproduces the audited
  fingerprint and ignores `PICKS_*` variables from the shell (S3-19); no Windows device names or symlinks served (S3-33);
  one `run`/`record` at a time (S3-34).
- **Tests:** Repo Lense's failing tests are in `tests/audit/repolens-s3-*.test.mjs` (the page test runs the real page
  code in a small fake browser).

### Changes after the Repo Lense re-audit (29 October 2026)
- The site moved to the repository root (the `picks` branch merged in): `survivor.html`, `survivor.js`,
  `survivor-math.js`. The testnet page is `/survivor-testnet.html`; the test server only serves the files that page
  loads, plus media images (the root also holds code and the test keys' folder).
- Stake readings start only once season day 1 is recorded (S2-1). The 1 VHP rule counts all VHP in the vault
  (`stake + pending + stake_other` from the v6 `get_player`, S2-2). Vault reads run 8 at a time (`pool`) and season work
  has a time budget (S2-3). On mainnet seasons need two nodes, and a season day needs a day both nodes confirmed
  (S2-10, S2-11). `vaultMismatch` stops vault files while the vault's weeks or game 3's seasons don't line up (S2-7,
  S2-21). The write swaps the whole folder with two renames (SV-A26).
- Publish check: up to 100,000 producers in a season file; a season file that fails is left out on its own (exit 3);
  a season must sit at `firstDay + 14 × (season − 1)`, Season 1 on a Monday; a final stake reading must be dated after
  its week (S2-4, S2-13, S2-18). The publish shell is now tested for real (`tests/audit/survivor-publish-shell.test.mjs`).
- Page: the chain clock only moves the page clock forward (S2-5); a confirmed pick is listed at once and producers
  picked twice are flagged (S2-6); "couldn't read your picks" instead of "you're not in" (S2-16); only the newest read
  writes the list (S2-17).

### Changes after the Repo Lense audit (28 October 2026)
Line numbers above are from before these changes; the steps are the same.
- **Game 3's settings** are read on both nodes, which must agree; `enabled` and `max_picks_per_day` are checked too, and
  an announced change is reported (SV-A12, SV-A14).
- **`recordDay`** checks a saved day start against the chain *before* downloading anything, refuses a range bigger than
  a day can hold, and in both cases searches again in the same run (SV-A8). The second node reads one block either side
  of the day, so it confirms the day's edges on its own (SV-A12).
- **One node only:** each run says so, and days saved that way are checked on the second node once there is one
  (SV-A16).
- **Season files (v2):** each wallet and producer is written once, in `who` and `prods`; the days refer to them by
  position. A wallet that missed a VHP check is listed once, not every day. A file near 2 MB is reported (SV-A5).
- **Stakes (owner, 28 Oct: every game takes stakes):** `readStaked` asks the vault (`bot/games/vault-v6.koilib.json`,
  the v6 ABI) who is staked in game 3 in a vault week: `entry.peak_stake` (or `active_stake`) at least the week's
  minimum (`min_stake`, or `min_stake_next` from its week), the same test the vault uses for a free-prize winner. Before
  v6 is live it returns null (nobody staked). Each season keeps `stakes`: one reading per vault week, `final` once read
  after the week ended. Players get `staked: true` if staked in either week; `prizes` skips them; `weekRows` (in
  `survivor-math.js`) gives the staked players' points for each week. The 1 VHP rule also counts VHP staked in any vault
  game (`otherStakes`).
- **Vault files (Vault v6 hand-off, 28 Oct):** `vaultFiles` writes `vault/W<week>.json` for each season: the season's
  first vault week (once it is over) with no winners, and its last week (once the season is final) with the 1st- and
  2nd-place wallets from the season's prizes. A place with more than 10 tied wallets is left empty. The publish check
  compares each vault file with the season file published next to it; one it can't check is left out.
- **Writing:** everything is written to a side folder first and copied in at the end, `index.json` last (SV-A26).

---

## 3. `.github/workflows/games.yml`: the hourly job (Survivor's parts)

Two jobs, so repository code never runs next to the key that can write to GitHub:

1. **record** has read-only permission and no secrets.
   - It downloads last run's files. Only names like `index.json`, `days.json`, `fields.json` and `S001.json` are
     accepted.
   - It runs Block X's recorder, then **"Record Survivor"** (`npm run survivor`) with the two nodes.
   - Survivor runs even if Block X failed, and the files are handed on.
2. **publish** runs none of the repository's code.
   - It runs even if one recorder failed.
   - It refuses symbolic links and unexpected file names. A file over 2 MB is left out on its own; the rest of its
     game still publishes (Repo Lense SV-A5).
   - It checks every file's exact shape with a short Python script. For Survivor:
     - addresses are addresses;
     - lives are 0–2;
     - logs use only the letters `sonfuv`;
     - days are numbered 1–14 in order;
     - prizes total at most 6 VHP, counted in whole units of 0.00000001;
     - and the result itself: the check plays the season again from its days with the same rules (a short Python copy
       of `playSeason`, `rank` and `prizes`) and refuses any result or prize that differs. It can't tell whether the
       days themselves are true; only the chain can, so the vault recomputes before paying (Repo Lense SV-A4);
     - plus (SV-A13): the players are exactly the day-1 pickers; lives, "out" and used
       producers match each log; places are in order; prizes only when final, once per wallet, place 1 or 2, only to
       eligible players not knocked out by a missed pick, and only with 3 such players; integers are real integers in
       range; `updated` is a time; NaN is refused. Python runs isolated (`-I`).
   - A folder that fails is left out; the other game still publishes, and the job then fails so you get an alert.
   - The good files go to the `games-data` branch.

---

## 4. The page: `survivor.html` and `survivor.js`

### `survivor.html`
- **Content-Security-Policy line:** the browser may only run the site's own scripts plus three pinned library
  scripts, and may only talk to the Koinos nodes and the site's data branches. This blocks injected code.
- **Sections:**
  - Your picks (`#days`);
  - Today, live (`#today-rows`);
  - Season standings;
  - Handicaps;
  - How it works, including the disclosure that Knode runs two of the producers.
- **Scripts at the bottom, in order:**
  1. koilib and Kondor (pinned by hash);
  2. the guest wallet, the wallet and the header;
  3. the menus;
  4. `chain-blocks.js` (recent blocks);
  5. `survivor-math.js` (the rules);
  6. `survivor.js` (the page).

### `survivor.js`, lines 1–55: setup
- **Lines 6–15:** `NET` is empty on the real page. Only the local testnet server adds it. When it is there, the page
  uses the test clock, the testnet node, the testnet data and the testnet Picks contract. The real page can't be
  switched to testnet.
- **The rest of the setup:**
  - the node address, the data address, the explorer link;
  - the names shown for Knode's own two producers;
  - small helpers: `el` builds page elements with text only, never raw HTML, so data can't inject code; plus number
    formats, times and hearts (♥♡);
  - `fieldFor(d)` returns that day's published handicaps, or the latest ones with a note that they may change.

### Lines 56–71: `loadData`
Fetches `fields.json` and the current season's file (or the previous one, if the current one has no file yet).

### Lines 72–97: Today, live
- `liveCounts` counts who signed each block since the start of today, from the recent blocks `chain-blocks.js`
  loaded.
- `renderToday` scores them with `scoreDay`, the recorder's own function, and draws the table: out-zone rows are red,
  your pick is marked. It says "Live, not final": the recorded result is the one that counts.

### Lines 98–131: the Picks contract
- `setupPicks` connects only once the Picks contract is live (`picks-data/deployment.json` names it). Until then the
  page says picks open soon.
- `loadMine` reads **your** picks from the contract for every day of the current season so far, today and the open
  days, plus how many picks you have left today.

### Lines 132–164: where you stand
- `mySeason` finds your row in the standings.
- `canPickDay` decides whether you can pick a day: anyone can pick day 1; later days only if you're still in. Before
  the recorder has day 1, having a day-1 pick counts.
- `blockedFor(d)` lists the producers you can't pick for day d, with the reason. Those are:
  - producers already used this season (from the recorder);
  - your picks on season days the recorder hasn't recorded yet (audit SV-5);
  - your picks for other upcoming days this season.

  They show greyed out in the menu.

### Lines 165–226: the open days
`renderDays` draws one row per open day:
- the day and its season number;
- when it locks, with a countdown;
- the producer menu with each handicap.

It also shows:
- a line saying where you stand (hearts and lives);
- picks left today;
- a red "No pick yet" warning, on the next day only.

A day disappears from the list 2 minutes before it locks, so a pick sent at the last moment doesn't fail. If you're in
the middle of choosing from a menu, it doesn't redraw underneath you. `updateTimes` refreshes the countdowns.

### Lines 227–285: sending a pick
`sendPick(d, producer)` runs when you press Pick or Change:
1. **Checks first:** a producer is chosen, it isn't already your pick, it isn't used, and the lock isn't too close.
2. **Builds the exact contract call:** `pick { player: you, game: 3, round: d, producers: [producer] }`. It sends
   nothing else, ever.
3. **Your wallet** shows it for you to confirm. The Mana sponsor pays the Mana.
4. **Checks the chain** every 3 seconds, for up to 30 seconds, until your pick shows there, then says "Pick
   confirmed".
5. **Errors in plain words:** locked, not open yet, picks used up, too many changes, cancelled.

### Lines 286–319: standings and handicaps
- `renderStandings` lists every player: place, lives as hearts (or "out day N"), total score and producers used. It
  also shows:
  - "no prize" next to anyone who failed a VHP check;
  - your own line;
  - the prizes, once the season is final.
- `renderField` shows tomorrow's (or today's) handicap table, and which days it was built from.

### Lines 320–339: start
On load, the page:
1. connects the Picks contract;
2. loads the data;
3. draws everything;
4. loads recent blocks.

Then it keeps itself fresh:

| What | How often |
|---|---|
| Blocks and the Today table | every minute |
| Data | every 5 minutes |
| Your picks | every minute |
| Countdowns | every 15 seconds |

All of this pauses while the tab is hidden.

---

## 5. The testnet kit

### `bot/survivor-test.ts`
- **Lines 33–49: the testnet and its safety rails.**
  - It uses the Koinos Foundation testnet, with the address, chain id and test KOIN address taken from SwarmTales.
  - `MAINNET_CHAIN_ID` and the mainnet node names are written in so the tool can refuse them.
  - The six players, the pick entry point, 1-hour rounds and a 10-minute admin wait.
- **Lines 51–89: files.** Everything lives in `testnet-data/survivor/`, which git ignores:
  - `keys.env` holds the throwaway test keys;
  - `config.json` holds the clock, the contract and the season start;
  - `data/` holds the recorder's files;
  - `picks-src/` holds the testnet build.

  `mathOf` turns the saved clock into the test game.
- **Lines 91–101: `testnetProvider`, the guard.** Every command calls it first. It refuses mainnet by node name and by
  chain id, and stops if the testnet's chain id changed since setup (a reset).
- **Lines 103–150: helpers.**
  - Find the testnet's VHP from block events.
  - Count recent producers.
  - Read a balance.
  - Game 3's testnet settings (`testGame`): the mainnet shape with 1-hour rounds and 50 picks a day, because 24 hourly
    rounds would pass the mainnet cap of 20.
  - `send`: one contract call, signed and paid by one test wallet, waiting for its block.
- **Lines 152–415: the commands.**

  | Command | What it does |
  |---|---|
  | `setup` | Makes 8 random keys and saves the settings |
  | `status` | Prints everything |
  | `fund` | Shares one faucet claim: 50 to the contract wallet, 6 to each player |
  | `picks-build` | Copies the audited contract and changes exactly two lines (`patchPicksSource`: the owner and the admin wait), builds it and runs its safety check |
  | `picks-upload` | Uploads with the same three protections switched on as mainnet |
  | `game` | Announces game 3, then 10 minutes later puts it in force |
  | `season` | Picks Season 1's first round, at least 15 minutes ahead (`nextStart`) |
  | `pick` | One pick from the command line |
  | `record` | The real recorder, on the testnet, with the test clock |
  | `bots` | The robot players. Their choices are in `botChoice`; they never reuse a producer |

- **Lines 417–517: the local test page.**
  - `netScript` writes the page's test settings: addresses only, never keys.
  - `testPage` takes the real `survivor.html` and changes only these things:
    - "TESTNET" in the title;
    - the red bar;
    - the test settings script;
    - the test wallet, in place of the three real wallet scripts.

    The security rules are unchanged.
  - `startSite` is the small web server. It:
    - answers only `127.0.0.1` and only its own page (it checks the Host and Origin headers);
    - serves only the site's files, the contract's description and the recorder's four kinds of data file, so never
      `keys.env` or `config.json`;
    - passes only read-only calls to the testnet node;
    - signs only through `/test/send`. That needs a session token which only the page itself can read. It accepts
      exactly one call: a Survivor `pick` on the testnet Picks contract, for the chosen test player, with one valid
      producer.
- **Lines 519–553: `run` and the command list.** `run` starts the server, then every 2 minutes records (and moves the
  robots, with `--bots`).

### `tools/survivor-testnet/`
- `test-wallet.js` stands in for the real wallet on the test page. "Play as" picks a test player. A pick you confirm
  goes to `/test/send`. The keys stay in the server and never reach the browser.
- `testnet.css`: the red bar.
- `fake-testnet.mjs`: a pretend testnet for rehearsals and tests. It produces blocks every second, keeps balances,
  and runs a Picks contract with the real rules (owner-only announce, the 10-minute wait, the lock, the opening, the
  daily cap). It can jump its clock forward.
- `rehearse.mjs`: the whole testnet how-to against the fake testnet.
  1. Setup, faucet and funding, then build, upload and register.
  2. A full season with p1 and five robots, including a pick clicked on the test page in a real browser.
  3. The end, the correction window and the prizes.

  It passed before this kit was handed over.

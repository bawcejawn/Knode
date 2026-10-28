# Who Signs Block X: the code, step by step

Four pieces work together. A pick travels through them in this order:

```
 player's browser                       Koinos chain                      GitHub Actions (no keys)
 ┌──────────────────────┐   pick tx    ┌─────────────────────┐  reads   ┌──────────────────────────┐
 │ site/blockx.js       │ ───────────▶ │ Picks contract      │ ◀─────── │ bot/games/blockx.ts      │
 │  + blockx-math.js    │              │ picks/assembly/     │          │  + blockx-math.js        │
 │  + wallet            │              │   Picks.ts          │          │ writes board.json, W*.json│
 └──────────────────────┘              └─────────────────────┘          └────────────┬─────────────┘
            ▲                                                                         │ publish job
            └──────────── reads board.json from the data branch ◀─────────────────────┘
```

- **The contract** decides what is allowed: which rounds are open, the lock, the caps. It stores the picks.
- **The shared math** (`site/blockx-math.js`) is one file that both the page and the recorder run, so a score shown
  in the browser and a score recorded by the bot can never disagree.
- **The recorder** reads the chain after the fact (who signed each target, every pick) and writes the results.
- **The page** shows the open targets, sends picks and draws the leaderboards from the recorder's files.

Line numbers below are for the current `picks` branch.

---

## 1. The contract: `picks/assembly/Picks.ts`

### Storage (lines 16–20, 69–73)

Five storage spaces, all keyed by fixed-size bytes:

| Space | Key | Value |
|---|---|---|
| 0 `config` | (one object) | owner, pending owner and its time, announced upgrade hash and time, owner generation |
| 1 `games` | game id (4 bytes) | the game's settings (`game_config`) |
| 2 `pending` | game id (4 bytes) | an announced change, the time it can be applied, the owner generation |
| 3 `entries` | game (4) + round (8) + player (25) = 37 bytes | one pick: producers, number, block height, time, changes |
| 4 `days` | game (4) + player (25) | today's UTC day and how many picks the wallet made that day |

Because a pick's key starts with game + round, all the picks of one round sit next to each other. That is what lets
`list_picks` page through a round cheaply.

### Hard limits (lines 22–46)

Constants nobody can change without new code: lead at least **100 blocks** (or 5 minutes for time games), opening
window at most 35 days, at most 50 picks a day, 50 changes, 10 producers in a list, 32 games, names up to 40 bytes.
`TIMELOCK_MS` (48 hours) and `EXPIRY_MS` (7 days) are the owner's waits. `INITIAL_OWNER` is the KnodeGames owner
`1635QUr…H717` until a handover.

These three constants (`INITIAL_OWNER`, `TIMELOCK_MS`, `EXPIRY_MS`) are the **only** lines the testnet build changes
(see section 5).

### `authorize` (lines 77–81): why it can never move tokens

Koinos asks a contract's `authorize` whenever someone wants to act *as* that contract's account. This one answers:

- `contract_upload` (new code): only if `upgradeOk()`;
- **anything else** (`contract_call`, which would move tokens out, and `transaction_application`, which would pay
  Mana): **always no**.

The contract also never calls another contract, so it has no way to move anything. `npm run check` fails the build
if a call to another contract ever appears.

### `upgradeOk` (lines 85–108)

New code is allowed only if all of these hold:

1. the owner announced a sha256 with `schedule_upgrade`;
2. at least 48 hours have passed, and less than 48 hours + 7 days;
3. the upload in this transaction is for this contract, keeps **all three overrides on**, and its bytecode hashes to
   exactly the announced sha256;
4. the owner signed the transaction.

### `pick` (lines 112–158): the one thing players call

Step by step:

1. **The game exists and is on** (113–116).
2. **The player is a real address and signed** (117–119). `checkAuthority` means the player's own key signed this
   transaction.
3. **Only the player's own transaction** (122–123). If another contract calls `pick`, the caller must be the player
   itself. This stops a contract the player signed for something else from picking on their behalf (lesson R-3 from
   the race audit).
4. **Where are we?** (126–129). For Block X (`lock_mode` 1), the position is the head block's **height**.
5. **The target** (130–131): `round × round_size + round_offset`. Line 130 refuses rounds so large that the
   multiplication would overflow.
6. **The lock** (133): accepted only while `height < target − lead`. With lead 100, the last block a pick can land in
   is `X − 101`. `lock-test` measures exactly this on the testnet.
7. **The opening window** (134): `target − height ≤ ahead`. With ahead 28,900 and a target every 2,400, exactly 12
   targets are open.
8. **The choice fits** (136, `checkChoice` 437–447): for Block X, exactly one valid producer address and number 0.
9. **Change rules** (138–144): if the wallet already picked this round, the new pick must differ ("that is already
   your pick") and the pick must have fewer than `max_changes` changes.
10. **Daily cap** (146–151): the counter resets when the UTC day changes. At `max_picks_per_day`, it refuses.
    New picks and changes both count.
11. **Store and announce** (153–156): the pick is saved with the block height and time it was made and its change
    count, and a `pick_event` is emitted.

### Reads (lines 162–241)

- `get_pick`: one wallet's pick for one round.
- `list_picks`: up to 100 picks of a round, after the `start_after` wallet. A bad cursor is an error, never a silent
  restart (race lesson R-1).
- `get_usage`: today's count for a wallet.
- `get_config`, `get_game`, `list_games`.
- `list_pending`: announced changes still usable. It returns a `next` cursor whenever it stopped early, so monitoring
  can't be blinded (fix-check PF-1).

### Owner actions (lines 245–368)

| Function | What it does | Wait |
|---|---|---|
| `announce_game` | proposes a new game or a looser one; a game's *shape* (kind, list size, number range, lock mode, round size/offset) can never change | 48 h |
| `apply_game` | anyone may call it after the wait and within 7 days; announcements by an earlier owner are dead (fix P-1) | – |
| `tighten_game` | switches off, lowers caps, locks earlier, opens later, at once; it also drops any announcement for that game so it can't be undone later (fix P-2) | none |
| `cancel_game_change` | drops an announcement | none |
| `propose_owner` / `accept_owner` | handover; the new owner must sign, and the generation number goes up, which kills every older announcement | 48 h |
| `schedule_upgrade` | announces the sha256 of new code (or clears it) | 48 h |

### Helpers (lines 405–520)

- `checkGame`: every limit above.
- `sameShape`: the parts that never change.
- `pickKey` / `dayKey`: build the storage keys.
- `isAddress`: a real Koinos address (version byte 0, 20-byte hash, double-sha256 checksum).
- `txOps`: reads the transaction's operations for `upgradeOk`.

---

## 2. The shared math: `site/blockx-math.js`

The same file runs in the browser and in the recorder (loaded with `await import`), so both agree.

- **`MAINNET_GAME`** (line 37): game 2. A target every 2,400 blocks, lead 100, ahead 28,900, 30 picks a day, 5 changes.
- **`forGame(settings)`** (46–69): the target functions for any settings, checked against the contract's limits.
  - `target(r)` is `r × round + offset`.
  - `lockHeight(r)` is `target − lead`, the first height that refuses a pick.
  - `isOpen(r, height)` is the contract's rule for a pick landing in block `height`, exactly.
  - `openRounds(height)` lists every open round, soonest first.
  - `offerRounds(height, margin = 20)` drops rounds within 20 blocks of their lock, so a pick sent now doesn't land
    too late.
  - `roundOf(h)` turns a block height back into its round.
- **`vhpOf(card)` / `multiplier(card, producer)`** (76–90): reads a handicap card (field and paddock) and returns
  `min(3, top ÷ producer)` to 2 decimals. A producer missing from the card scores 3.
- **`pointsOf`** (92): the multiplier × 100 if the pick named the real signer, else 0. Points are whole hundredths.
- **`dayOf` / `weekOf`** (95–96): the UTC day; the Knode game week counted from Monday 2026-10-19.
- **`board(rows)`** (101–114): adds up each wallet's points, right picks and picks, its last right pick and how many
  different days it picked. Ranking: points, then right picks, then the *earlier* last right pick, then address.
- **`places`** (116–123): equal points, right picks and last right pick share a place.
- **`prizes(weekRows)`** (127–140): 2 and 1 VHP to the top 2 among wallets with picks on 3+ days and at least one
  point. Tied wallets split the prizes of the places they cover, rounded down to 8 decimals.

---

## 3. The recorder: `bot/games/blockx.ts`

It runs in GitHub Actions with **no keys and no secrets**. It only reads the chain. Each run, for one game:

**Setup** (182–205). It picks the game's settings (mainnet game 2, or the testnet game from `testnet/blockx.json`),
the input folder (`BLOCKX_PREV`, last run's files), the output folder (`BLOCKX_OUT`), and how it gets cards:
`race` on mainnet (the Producer Race recorder's hourly card), `self` on the testnet (it makes its own card).

**Self-made cards, testnet only** (207–227). Once an hour it reads who signed the last 7,200 blocks
(`readSigners`, 200 blocks a call), reads their VHP from the testnet VHP contract, and makes the same kind of card
the Producer Race makes (`M.makeCard`). Cards are kept 8 days in `cards.json`. `startHeight` remembers where the
recorder first ran, so targets from before it ran aren't listed as void.

**Targets** (238–287). From the newest irreversible target backwards (newest first, so targets that keep waiting
never crowd out new ones; at most 48 per run):

1. Skip targets already recorded.
2. Read the target block and the lock block (`X − lead`). On mainnet both are read on **two independent nodes**,
   which must agree on signer and time, or the target waits for the next run. The testnet has one public node, so
   it is checked once and marked `checked: 1`.
3. Read every pick for the round (`list_picks`, 100 at a time). On mainnet both nodes must return the same picks.
4. Find the card in force at the lock block's time. With no card yet, the target waits. After 3 days with no card,
   or (testnet) when the lock came long before the first card, it is recorded as **void**: no points.
5. Mark each player Staked or Free play (`readRanked`: 1 VHP, or a Knode stake including `stake_other`).
6. Score every pick with `pointsOf` and save the target in its week file.

**Leaderboards** (289–323). Every recorded pick goes through `board` and `places` for Today, This week, Last week
and All time, with a `ranked` flag per wallet so the page can split Staked and Free play. Last week becomes **final**
12 hours after it ends, if every target of the week was recorded with no gaps (`targetsCover`). Prizes are listed
only when final, only for weeks from `prizesFromWeek`, and only for the Free play board.

**Writing** (325–336): `index.json` (weeks, contract, game id, prizesFromWeek), `W<week>.json` (targets),
`board.json`, and on the testnet `cards.json`.

**The testnet entry point** (348–383). `readNetConfig` refuses a config that names the mainnet chain id, and checks
every game's settings. `main --testnet --game <id>` refuses to run if:

- the config has no Picks contract;
- it has no testnet VHP contract (it never falls back to the mainnet VHP);
- the node reports the mainnet chain id, or a chain other than the config's.

By default it writes only under `testnet-data/blockx-<id>/`.

---

## 4. The page: `site/blockx.js` (+ `blockx.html`, `blockx-testnet.html`)

- **Which network** (line 16): read from `<meta name="kg-network">`. Only `blockx-testnet.html` says `testnet`.
- **`setupNet`** (35–69):
  - Mainnet: mainnet nodes, `games-data`, the Producer Race cards, `KWallet`.
  - Testnet: it loads `testnet/blockx.json`, refuses mainnet, picks the game from the `#game-<id>` hash, checks the
    node's chain id and starts `KTestWallet`. On `localhost` it reads results from your own `testnet-data/` folder;
    otherwise from the `testnet-data` branch. It also writes the game's own numbers into the page text (target
    every N blocks, picks a day).
- **`loadCard` / `producers`** (93–114): the latest card, and each producer's VHP share and multiplier for the
  drop-down.
- **`setupPicks` / `loadMine`** (117–143): connects to the Picks contract and reads your pick for each open round
  and today's usage.
- **`renderTargets`** (147–188): the 12 open targets, each with its time, "locks in …", a producer list and Pick or
  Change. Buttons switch off while sending, when today's picks are used up, or when the pick has no changes left.
  Everything is built with `textContent`, never HTML strings.
- **`sendPick`** (218–259):
  1. refuses a pick within 20 blocks of the lock;
  2. builds the `pick` operation and gives it to the wallet;
  3. checks the chain up to 10 times (every 3 s) that the pick is stored;
  4. turns contract errors into plain words.
- **Results and leaderboard** (261–326): loads `index.json`, the week files and `board.json`, and draws the board
  with the shared `board.js` (Staked / Free play tabs, Free play top 6 shown). The multiplier table goes with it.

### The testnet wallet: `site/testnet-wallet.js`

- **Frame-buster** (line 16): the page refuses to run inside another site's frame.
- **Storage** (22): its own names, `kg-testnet-wallet-v1` and `kg-testnet-kind-v1`, so it can't read, overwrite or
  delete a mainnet guest wallet.
- **`init`** (56): throws if the chain id is mainnet's.
- **Test wallet** (70–76): a random key made in this browser with `crypto.getRandomValues`, kept in that browser
  only. Play money only.
- **`send`** (104–125):
  - it signs **only** calls to the testnet Picks contract;
  - it checks the node's chain id before signing;
  - it caps the Mana at 3 test Mana per transaction;
  - it checks the signed transaction is for this testnet and that the player pays.

### The testnet page: `site/blockx-testnet.html`

- Its Content-Security-Policy lets it reach **only** the testnet node and the `testnet-data` branch. Even a bug
  couldn't make it call a mainnet node.
- It doesn't load the mainnet wallet scripts (`wallet.js`, `guest.js`, `header-wallet.js`) or the site menu.
- It is `noindex` and linked from nowhere.

---

## 5. The testnet tools

### `picks/scripts/build-testnet.cjs`

`patchSource` replaces exactly three lines of the audited `Picks.ts`:

- `INITIAL_OWNER` becomes your test owner;
- `TIMELOCK_MS` becomes 10 minutes;
- `EXPIRY_MS` becomes 24 hours.

It refuses if any of those lines isn't found exactly once, and refuses the mainnet owner. It first compiles an
untouched copy and checks that copy reproduces the audited sha256 `700c296a…`, which proves the compiler and source
are the audited ones. It then compiles the patched copy and writes `picks/build/testnet/contract.wasm` with a
`manifest.json` (the hash, the audited hash, the owner, the waits and the changed lines).

### `bot/picks.ts` (`npm run picks`)

- **Dry run by default.** Every command that sends only shows what it would do, until you add `--send`. Mainnet also
  needs `CONFIRM_MAINNET=yes`.
- **`connect`** (79–86): checks the node's chain id before anything is signed. A `--testnet` command refuses a
  mainnet node.
- **`uploadBuild`** (152–166):
  - mainnet uploads only the audited build;
  - testnet uploads only a build whose manifest says it came from the audited source, and never the mainnet build.
- **`upload`** (168–201): puts the contract on the brand-new `PICKS_WIF` wallet with all three overrides on, then
  checks on chain that the code hash and overrides are as expected. On the testnet it saves the contract address,
  chain id and VHP contract to `testnet/blockx.json`.
- **`announce` / `apply` / `pause`**: the owner actions. `pause` is `tighten_game` with `enabled: false`.
- **`lock-test`** (318–366): sends one pick per block, from 6 blocks before the lock to 3 after, with its own nonces.
  It reports which were applied, the height the contract saw, and the real last block a pick can land in.
- **`mana-test`** (369–399): sends 1, 3 and 7 picks in one transaction each and reports the Mana per pick.

### `.github/workflows/games-testnet.yml`

- Off until the repository variable `TESTNET_GAMES_ENABLED=true`.
- Every 20 minutes the **record** job (read-only token, no secrets) runs the recorder for each game in
  `testnet/blockx.json`.
- The **publish** job runs **no project code**. It checks every file's name, size and JSON shape, then pushes to
  `testnet-data` and nothing else.

### `tools/testnet-site.mjs` (`npm run testnet-site`)

A tiny web server on `127.0.0.1` only, for testing on your own computer. It serves an allowlist only: `site/` files,
`testnet/blockx.json` and the recorder's results. It never serves `.env.testnet` or any other file. With `--record`
it runs the recorder every 5 minutes.

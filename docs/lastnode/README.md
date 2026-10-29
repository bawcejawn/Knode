# Last Node Standing (Knode Games, game 13): how it works

A staked daily game. Pick a block producer ("node"). Every hour the slowest node is knocked out. If yours goes, you get one jump to a node still standing. Ride the last node standing to win.

The live game is not launched. It waits for:
- the Picks contract (Build 3);
- Vault v6 (Build 1). Until the v6 vault ABI (`game/abi/kpred.koilib.json` with `get_game_player` and `get_state`) is on this branch, no vault file is written at all (audit LN-18: it fails safe, but merge that ABI before launch).

A testnet practice copy runs on the owner's PC (`docs/lastnode/TESTNET.md`).

## The rules (owner decisions, 2026-10-27)
- **Event:** daily at 14:00 UTC (block timestamps). A cut every hour on the hour until one node is left, so about 9 hours with 10 nodes.
- **Field:**
  - producers expected to sign at least 20 blocks an hour, at most 23 nodes;
  - taken from the Producer Race card (`race-data`) of the 12:00 UTC leg the day before;
  - if that leg has no card, the 13:00 leg's card is used, but only if it was taken before picks open (13:15 UTC the day before);
  - the field never changes after picks open.
- **Handicap:**
  - h = (kTop / k) × (1 − c / √k) ÷ (1 − c / √kTop), where k is the node's expected blocks per cut window;
  - c is in steps of 0.1 from 0.0 to 2.5. It is chosen so every node has the most equal chance of being last standing, using 20,000 simulated events with a fixed seed;
  - h is kept to 4 decimals, so step totals are exact integers in ten-thousandths.
- **The cut:** the node with the fewest handicapped steps since the start goes. Ties: fewer raw blocks, then smaller card VHP, then the address that sorts later. Totals never reset during an event; handicaps and c are fixed per event.
- **Picks (Picks contract, game 13):**
  - Settings: one producer, TIME lock, round_size 3,600,000 ms, round_offset 900,000, lead 300,000, ahead 86,400,000, at most 5 changes, at most 30 picks a day.
  - Every round locks at 10 minutes past its hour.
  - **Start pick:** the round locking at 13:10 UTC.
  - **Jump:** if your node is cut at hh:00, your pick for the round locking at hh:10 is your jump, if it names a node still standing. A pick made earlier for that round is a backup and counts the same way.
  - One jump per event. With no valid jump, or a second cut, you're out.
- **Points:**
  - 1 for each cut your node survives;
  - +5 for riding the last node without jumping, +3 after a jump.
- **Board:** points, then rides, then fewer jumps; exact ties share the place.

## Weekly results to the Vault (v6)
- **File:** `games-data:lastnode/vault/W<week>.json` with `{ game: 13, week, final: true, rows, first: [], second: [] }`.
- **rows:** wallets whose `week_stake` in game 13 is at least the vault's minimum stake for that week (1 VHP unless you change it; vault `get_game_player` and `get_state`) and that have at least 1 point. Stakes are read on both mainnet nodes; any difference holds the file to the next run.
- **Scores:** whole numbers 1–255 that keep the board's order and ties. Over 255 different places, the top 254 keep their tie-breaks and the rest share 1.
- **When it is written:** once the week is final (12 h after it ends), and only within the Vault's 3-day window.
- **No file at all** while the game contract has no per-game stakes (before v6).
- **Publishing:** the publish step takes only last week's file, from 12 hours to 3 days after the week ends, with rows that are the final "Last week" board's players in its order. It never replaces a published vault file, and a different copy fails the run so you are told. A file with no rows while the board has scoring players is not published (the week's bucket stays in the game if no file arrives).

## Where the code is
| File | What |
|---|---|
| `lastnode-math.js` | The rules. Shared by the page and the recorder. `KLastNode` is the real game; `KLastNode.forGame(settings)` gives any timing (the testnet fast game 93). |
| `bot/games/lastnode.ts` | Recorder. Reads blocks from two nodes, irreversible only; reads picks; writes `D<event>.json`, `index.json`, `board.json`, `vault/W<week>.json`. `--testnet --game N`: picks from the testnet, blocks from mainnet (read only). |
| `.github/workflows/lastnode.yml` | Record job (no secrets, read-only token). Publish job (runs no repo code; Python shape check; pushes only `games-data/lastnode/`). Off until `LASTNODE_ENABLED=true`. |
| `lastnode.html`, `lastnode.js`, `lastnode.css` | The live page. Its live cut is worked out from public blocks; the recorder's files are the final word. |
| `lastnode-testnet.html` | Testnet practice page: testnet wallet only; declares that it reads mainnet blocks. |
| `bot/picks.ts` | Registers games on the Picks contract. On the testnet: 2, 92, 13 and 93; on mainnet: only Block X so far. |
| `tools/testnet-site.mjs`, `testnet/lastnode.json` | Local test server and testnet settings. |
| `tools/sim/lastnode/` | The fairness simulations and a real-block replay. |
| Tests | `tests/audit/lastnode-*.test.mjs`, `tests/audit/site.lastnode.test.mjs`, `tests/audit/picks.tool.test.ts`. |

## Trust model
- **Nobody can sign for players except their own wallet.**
  - The page sends exactly one kind of transaction: a Picks `pick` for game 13 (93 or 13 on the testnet) for the connected wallet.
  - It checks the round is still open one minute before its lock.
- **The recorder holds no keys.** Results come from irreversible blocks that match on two independent mainnet nodes, and picks must match on both nodes. On the testnet there is one testnet node for picks.
- **The publish job** checks the shape of every file it pushes. It never lets the day list shrink and never replaces a published vault file.
- **Known limits (documented):**
  - The page's live standings use blocks that may not be irreversible yet.
  - The field's fairness depends on the race card.
  - Big nodes are steadier, so win-fair is not points-fair (accepted: c is tuned for wins).
  - Reliability (blocks signed vs VHP share) is the skill, and it is public.

## Earlier reviews
- **27 Oct:** independent audit, "fix first":
  - H-1: jumps locked 55 minutes into the deciding hour;
  - M-1: Jump box unreachable;
  - M-2: a failed data read could shorten the boards;
  - M-3: a mid-week launch never closed its week;
  - Lows.
  All fixed. Two fix-checks were clean (commits up to `f6a1e14`).
- **28 Oct:** Repo Lens audit of testnet practice, the page redesign and the vault file: 1 High, 3 Medium, 13 Low, 16 Info.
- **29 Oct:** all fixed or answered, and the branch rebuilt on the current `picks` with the site at the repo root. Tests in `tests/audit/lastnode-fixes.test.mjs`, `lastnode-vault.test.mjs`.

# Last Node Standing (Knode Games, game 13): how it works

A staked daily game. Pick a block producer ("node"). Every hour the slowest node is knocked out. Before the start you pick your node and an optional backup; if your node goes, the backup takes over (one jump). Ride the last node standing to win.

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
- **Form (owner, 2026-10-29):** k = the card's VHP share × the node's form. Form = blocks the node signed in the 48 hours before the card ÷ the blocks its VHP share gave it, hour by hour against that hour's **average** VHP from the 5-minute samples (race-samples; fix-check LNF-4, so VHP swapped between addresses counts once), kept between 0.80 and 1.20 (`formOf` in `lastnode-math.js`). No samples for 24+ of the hours: the field is set without form (testnet practice falls back to the hourly race cards).
  - Why: on real blocks (25–29 Oct) nodes signed a steady 78%–108% of their VHP share. With VHP alone, the steadiest over-signer won 35–40% of events and two under-signers never won (`tools/sim/lastnode/form/`). On 123 days of June–October blocks, the form rule gave a fair spread for the daily game (chi² 7.4 on 7 degrees of freedom).
  - Read on both mainnet nodes (irreversible blocks, must match). If the reads fail, disagree or take over 4 minutes, the field waits; 3 hours after picks open it is set without form (`field.form.note` says why). Who is in the field is still decided by VHP.
  - Gaming: a producer would have to sign fewer blocks for 2 days (losing real block rewards) to look weak, and the boost is capped at 1 ÷ 0.80.
- **Known limits (fix-check, 29 Oct):** the fast test (20-minute cuts) still leans to small nodes (big third about 0.73× a fair share, small third about 1.21×); form weighs all 48 hours the same, while in race hours the main producers sign up to 1.6% off their average.
- **VHP added after the field's card (owner, 2026-10-29; fix-check LNF-3):** each cut window is checked against the latest race card taken by its end. A node with more VHP on it than on the field's card has its multiplier cut by the same ratio for that window (`raceCut`). Multipliers are only ever lowered, never raised. The recorder stores the card and the lowered values with each window (`card`, `hh`), and the publish job checks them against race-data.
- **Watch-and-hold (owner, 2026-10-29; fix-check LNF-8/LNF-9):** a small steady edge decides a 9-hour race (in simulation, 5% above the multiplier wins about half the time). When a node signed at least max(5%, 3 standard deviations) above its multipliers across last week's races and won at least 2 of them, the week's vault file is held: `vault/HOLD-W<week>.json` is published instead, and the publish run fails so you get an email. After reviewing, release it with `gh variable set LASTNODE_RELEASE_WEEKS --body "<week>"` (comma-separated for several) inside the Vault's 3 days. Reading form and recent blocks stays part of the game ("hot hand" picks do better than chance).
- **The cut:** the node with the fewest handicapped steps since the start goes. Ties: fewer raw blocks, then smaller card VHP, then the address that sorts later. Totals never reset during an event; handicaps and c are fixed per event.
- **Picks (Picks contract, game 13; owner, 2026-10-29):**
  - One pick per event, made before it starts: your node and an optional backup.
  - Settings: a list of up to 2 producers (kind 2, list_size 2), TIME lock, one round a day (round_size 86,400,000 ms), round_offset 50,100,000 (13:55 UTC), lead 300,000, ahead 86,400,000, at most 5 changes, at most 10 picks a day.
  - Picks open at 13:55 UTC the day before and lock at 13:50 UTC, 10 minutes before the start. Nothing can be picked or changed during the race.
  - **Backup:** the first time your node is cut, the backup takes over automatically if it is still standing then (a jump; one per event). No backup, a backup already cut, or a cut of the node you jumped to, and you're out.
  - The cut where your backup takes over doesn't count as a cut survived (your node was cut); the backup's later cuts do.
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
- **Publishing:** the publish step takes only last week's file, from 12 hours to 3 days after the week ends.
  - Its rows must be exactly what last week's day files give (`vaultScores` for the wallets it lists), and those day files are replayed and can't be rewritten once published (fix-check LNF-1, LNF-2).
  - It never replaces a published vault file; a different copy, a file that doesn't match, or no file by the end of the 3 days fails the run so you are told.
  - A file with no rows while the week has scoring players is not published (the week's bucket stays in the game if no file arrives).
  - The publish job can't read stakes, so it can't tell an omitted wallet from an unstaked one: the Vault's own bot should check that every board player staked in game 13 that week is in the file (hand-off to the Vault chat).

## Where the code is
| File | What |
|---|---|
| `lastnode-math.js` | The rules. Shared by the page and the recorder. `KLastNode` is the real game; `KLastNode.forGame(settings)` gives any timing (the testnet fast game 94, and 33 for the real timing). |
| `bot/games/lastnode.ts` | Recorder. Reads blocks from two nodes, irreversible only; reads picks; writes `D<event>.json`, `index.json`, `board.json`, `vault/W<week>.json`. `--testnet --game N`: picks from the testnet, blocks from mainnet (read only). |
| `.github/workflows/lastnode.yml` | Record job (no secrets, read-only token). Publish job (runs no repo code; Python shape check; pushes only `games-data/lastnode/`). Off until `LASTNODE_ENABLED=true`. |
| `lastnode.html`, `lastnode.js`, `lastnode.css` | The live page. Its live cut is worked out from public blocks; the recorder's files are the final word. |
| `lastnode-testnet.html` | Testnet practice page: testnet wallet only; declares that it reads mainnet blocks. |
| `bot/picks.ts` | Registers games on the Picks contract. On the testnet: 2, 92, 94 and 33 (13 and 93 are the earlier rules, unused); on mainnet: only Block X so far. |
| `tools/testnet-site.mjs`, `testnet/lastnode.json` | Local test server and testnet settings. |
| `tools/sim/lastnode/` | The fairness simulations and a real-block replay. |
| Tests | `tests/audit/lastnode-*.test.mjs`, `tests/audit/site.lastnode.test.mjs`, `tests/audit/picks.tool.test.ts`. |

## Trust model
- **Nobody can sign for players except their own wallet.**
  - The page sends exactly one kind of transaction: a Picks `pick` ([start] or [start, backup]) for game 13 (94 or 33 on the testnet) for the connected wallet.
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

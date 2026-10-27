# KnodeGames Vault (game v6): design

Status: **being built on branch `vault-v6`.** Nothing here is deployed or scheduled. Every rule below was confirmed by
the owner on 2026-10-27 (checklist questions 1–9).

v6 upgrades the live question-game contract `1Mpmf2ERhjYpX7CCiM11WERuM4j17uT1sr` in place. Every stored v5 value keeps
its place and meaning; the question game stays game #1 with its on-chain scoring; other games are added beside it.

## Rules that never bend
1. A player can always withdraw any amount of their stake from any game. The withdraw path touches only the player's
   own records, the totals and the token transfer. It does **not** close or finalize weeks, read any game's results or
   call any contract except the VHP token (and Proof-of-Burn when VHP must be topped up from spare KOIN).
2. `assertSolvent` after every payout: holdings ≥ stakes + seed + fees + unclaimed pots + every rolled-over bucket.
3. Nobody can take player principal or seed principal: not the owner, the operator (bot) or a game.
4. The operator can post results and prize winners, never amounts or addresses without a stake.

## Rule switch
`config.v6_rule_week_plus_one` is set by the first v6 write to (current week + 2), like v5's switch. Weeks before it
are closed and paid by the v5 code paths unchanged. The per-game stake accumulators start at that first write.

## Games
| Field | Meaning |
|---|---|
| id | u32; 1 = question game (built in), 2–4294967295 others |
| staked | has a stake bucket (top 30% / baskets A+B) |
| free_prize | pays 2 VHP (1st) + 1 VHP (2nd) each week to its best free players |
| active | takes new deposits and moves, and earns from the next week |
| from_week | first week the game earns or pays |

- `propose_game` (owner) announces a new game or a re-activation; `apply_game` after 48 h (within 7 days).
- `deactivate_game` (owner) is immediate: no new deposits or moves in; it stops earning from the next week, and its
  VHP's rewards go to the games still running. Results for weeks it already earned can still be posted. Withdrawals
  are never affected.
- At most 12 games, so a week's close loop stays bounded.

## Per-game stakes
- Game 1's stakes stay in the existing player records. Other games use a per-game player record
  (`stake`, `pending`, `pending_week`, `void_week_plus_one`), key = game (4 bytes) + address (25 bytes).
- `deposit_to(game, amount)`: whole VHP or KOIN (burned into VHP); counts from next week.
- `move_stake(from_game, to_game, amount)`: no tokens move. The source side works like a withdrawal (voids that game's
  week only if it touches this week's active stake); the target side is a pending deposit for next week.
- `withdraw_from(game, amount)`: any amount, any time (rule 1).
- Because other games' players never touch the vault during play, any change to a per-game record first freezes a
  snapshot of the player's stake for the current and previous week. Results are posted within 3 days of the week's
  end, so the snapshot is always there when it matters.

## Weekly close (once per week, for every game at once)
1. `gain = holdings − owed` (rolled-over buckets are owed, so they never count as new gain).
2. `fee = 5% × (gain − carry)`, where the carry is unused prize money returned to the pool (already charged once).
   The fee is owed to the owner **in VHP**. KOIN fees earned before v6 stay claimable as KOIN.
3. **The seed's part pays the free prizes.** The pot is split by who produced it: the seed's VHP over time against
   everything the vault holds that produced (stakes, seed, unpaid pots, rollovers, the fee waiting in VHP). Only the
   seed's part pays prizes; players' rewards never do (owner: "staked players should be priority").
   Each free-prize game that earns this week gets 3 VHP. If the seed's part is short, every game's prize is cut in the
   same proportion that week, down to nothing if the part is 0, and **a cut is never owed later** (owner, 2026-10-27).
   Whatever the seed's part doesn't need for prizes joins the split. The owner funds the seed to cover at least 12 VHP
   a week before launch (at ~90 VHP of weekly rewards on ~22,000 VHP that is a seed of roughly 3,000 VHP).
4. The rest R is split by each staked game's **stake for that week, each player's stake counted at its lowest**:
   a deposit counts from the next week, a withdrawal lowers this week at once (owner: "an increase only impacts the
   following week"). `B_g = R × W_g ÷ ΣW`. No stake anywhere: all of R goes to game 1. A stopped game's share goes to
   the games still running.
5. Each game's bucket also gets back its own rollover from earlier weeks (fee-free).

## Inside a game
- Game 1: exactly the v5 machinery (questions, settle, finalize, claim). Its pot is `B_1 + its rollover + prize_1`.
  Free prize 2 + 1 VHP : players tied for 1st share all 3; otherwise 1st gets 2 and players tied
  for 2nd share 1. A share nobody can take goes to basket B (as in v5).
- Other staked games: the operator posts `(player, points)` batches for players with at least 1 point. The vault
  checks each player's own frozen or live stake (≥ 1 VHP, not voided) and adds them to that game's score buckets
  (points 1–255). Then the same paged finalize and the same basket math as game 1.
- Other free games: the operator posts the 1st-place and 2nd-place wallets (ties allowed, up to 10 each). Each must have
  less than the minimum stake in that game that week. A prize nobody wins returns to the pool, fee-free.

### Results timeline (other games)
| Step | When | Who |
|---|---|---|
| post results / prize winners | after the week ends, until the week's results deadline (week end + 3 days) | operator |
| seal | once posting is complete | operator |
| correct a player's points, remove a winner, or void the game's week | until seal + 12 h | owner |
| finalize | after the vault week is closed and seal + 12 h | anyone |
| roll over | not sealed by the deadline: anyone may finalize it as "no results"; the bucket rolls over within the game | anyone |

One game's missing results never hold up another game or the question game.

## Claims
`claim_game(game, week, player)` pays a staked winner or a free-prize winner. Unclaimed rewards never expire
. Every claim ends with `assertSolvent`.

## Compatibility
- `get_player`, `get_state` and every v5 method keep their arguments and results. New fields are appended only.
- The sponsor checks `get_player` (stake or pending > 0) to recognise real players. A player staked only in other
  games shows `stake_other > 0`, a new field; the sponsor's next version (Build 3's allowlist upgrade) must read it.
- New storage spaces 9–15; spaces 0–8 keep their v5 layout.

## Owner decisions (2026-10-27)
| # | Question | Decision |
|---|---|---|
| 1 | Fee currency | VHP |
| 2 | A game's share | its players' stake that week, each at its lowest |
| 3 | Prize shortfall | prizes come from the seed's part, never from players' rewards; if it's short, that week's prizes are cut or skipped and never owed later; the seed is funded to cover 12 VHP a week before launch |
| 4 | Ties for 1st | share all 3 VHP; otherwise 2 VHP to 1st, 1 VHP shared by 2nd |
| 5 | Free player | below the minimum stake in that game that week |
| 6 | Points | 1–255 a week per game |
| 7 | Stopped game | withdrawals open; its VHP's rewards go to the running games |
| 8 | Unclaimed rewards | never expire |
| 9 | Results deadline | 3 days after the week; then the bucket rolls over in its game |

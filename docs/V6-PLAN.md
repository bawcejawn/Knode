# KnodeGames Vault (game v6): design

Status: **draft, being built on branch `vault-v6`.** Nothing here is deployed or scheduled. Owner answers still open
are marked *(default)*: the build uses my recommendation until the owner confirms or changes it.

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
- `deactivate_game` (owner) is immediate: no new deposits or moves in; it stops earning from the next week. Results
  for weeks it already earned can still be posted. Withdrawals are never affected. *(default)*
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
   The fee is owed to the owner **in VHP** *(default)*. KOIN fees earned before v6 stay claimable as KOIN.
3. Free prizes: each free-prize game needs its carried shortfall plus 3 VHP. If the pot can't cover all of it, each
   game gets a share in proportion to what it needs, and the rest carries forward, capped at 12 VHP per game (4 weeks)
   *(default)*. Prizes never come out of stakes or seed.
4. The rest R is split by each game's **time-weighted stake** since the last close *(default)*:
   `B_g = R × acc_g ÷ Σacc`. No stake anywhere: all of R goes to game 1.
5. Each game's bucket also gets back its own rollover from earlier weeks (fee-free).

## Inside a game
- Game 1: exactly the v5 machinery (questions, settle, finalize, claim). Its pot is `B_1 + its rollover + prize_1`.
  Free prize 2 + 1 VHP *(tie rule default)*: players tied for 1st share all 3; otherwise 1st gets 2 and players tied
  for 2nd share 1. A share nobody can take goes to basket B (as in v5).
- Other staked games: the operator posts `(player, points)` batches for players with at least 1 point. The vault
  checks each player's own frozen or live stake (≥ 1 VHP, not voided) and adds them to that game's score buckets
  (points 1–255) *(default)*. Then the same paged finalize and the same basket math as game 1.
- Other free games: the operator posts the 1st-place and 2nd-place wallets (ties allowed, up to 10 each). Each must have
  less than the minimum stake in that game that week *(default)*. A prize nobody wins returns to the pool, fee-free.

### Results timeline (other games)
| Step | When | Who |
|---|---|---|
| post results / prize winners | after the week ends, until the week's results deadline (week end + 3 days) *(default)* | operator |
| seal | once posting is complete | operator |
| correct a player's points, remove a winner, or void the game's week | until seal + 12 h | owner |
| finalize | after the vault week is closed and seal + 12 h | anyone |
| roll over | not sealed by the deadline: anyone may finalize it as "no results"; the bucket rolls over within the game | anyone |

One game's missing results never hold up another game or the question game.

## Claims
`claim_game(game, week, player)` pays a staked winner or a free-prize winner. Unclaimed rewards never expire
*(default)*. Every claim ends with `assertSolvent`.

## Compatibility
- `get_player`, `get_state` and every v5 method keep their arguments and results. New fields are appended only.
- The sponsor checks `get_player` (stake or pending > 0) to recognise real players. A player staked only in other
  games shows `stake_other > 0`, a new field; the sponsor's next version (Build 3's allowlist upgrade) must read it.
- New storage spaces 9–15; spaces 0–8 keep their v5 layout.

## Owner questions still open (defaults above)
Fee in VHP · time-weighted shares · 12 VHP carry cap · free-prize tie rule · free player = below minimum in that game ·
points 1–255 · deactivation semantics · rewards never expire · 3-day results deadline.

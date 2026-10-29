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
| season_weeks | 1–4: the free prize is paid once a season of this many weeks, its weekly 3 VHP held until the season's last week (Survivor: 2 weeks, so 4 + 2 VHP). Seasons start at `from_week`. |
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
  Free prize 2 + 1 VHP: players tied for 1st share all 3; otherwise 1st gets 2 and players tied
  for 2nd share 1. A share nobody can take goes back to the pool, fee-free, as in every other game (owner,
  2026-10-28; v5-rule weeks keep the v5 rule: to basket B).
- Other staked games: the operator posts `(player, points)` batches for players with at least 1 point. The vault
  checks each player's own frozen or live stake (≥ 1 VHP, not voided) and adds them to that game's score buckets
  (points 1–255). Then the same paged finalize and the same basket math as game 1.
- Other free games: the operator posts the 1st-place and 2nd-place wallets (ties allowed, up to 10 each). Each must
  never have held the minimum stake in that game during that week (the question game's rule: a wallet staked at the
  week's start that withdraws later is still a staked player that week). A prize nobody wins returns to the pool,
  fee-free.
- **One player rule in every game (owner, 2026-10-28):** a wallet is a staked player in a game only if it is staked
  (at least the minimum) in that game. Anyone playing a game without a stake in it is a free player there, whatever
  it holds or stakes elsewhere.
- Games with prize seasons (Survivor): winners are posted only for a season's last week, which carries the whole
  season's funded prize. A game stopped mid-season returns its held prize to the pool, fee-free.
- Only the ORDER of posted points matters (rank weights 1/√rank and the top-30% headcount), so each game maps its own
  scores onto 1–255 keeping their order and ties (Block Golf: 7 × counted holes − strokes).

### Results timeline (other games)
| Step | When | Who |
|---|---|---|
| post results / prize winners | after the week ends, until the week's results deadline (week end + 3 days) | operator |
| seal | once posting is complete | operator |
| correct a player's points, remove a winner, or void the game's week | from the week's end until 24 h after the seal (unsealed: until the deadline), and never once finalizing has started | owner |
| finalize | after the vault week is closed, 24 h after the seal (the correction window has closed) and 12 h after the last correction; later pages at any time | anyone |
| roll over | not sealed by the deadline: anyone may finalize it as "no results"; the bucket rolls over within the game | anyone |

One game's missing results never hold up another game or the question game.

## Claims
`claim_game(player, game, week)` pays a staked winner or a free-prize winner. Unclaimed rewards never expire.
Every claim is capped by its own week's pot (a game week: its bucket plus prize; a question week: its pot), and ends
with `assertSolvent`, which is computed in 128 bits. Every counter of what the vault owes refuses to go below zero.

## Late closes
A week closes once someone sends a transaction after its close time (the hourly bot does). If closes fall behind,
the oldest open week measures all the gain since the last close, splits it by that week's games and funds one week of
prizes; the weeks after it close with no gain. Nothing is lost, but the gain lands in one week. The bot alerts when a
close is overdue.

## Upgrades and the emergency build
- The vault refuses to schedule the game's code from before the vault (v3 `917708a7…`, v5 `c17066ae…`): that code
  can't see stakes in other games or the fee and rollovers owed in VHP. **Never roll back to v5.**
- The emergency target is the **withdrawals-only build** (`npm run build:safe`): the same storage and code with
  `SAFE_MODE` on. It refuses deposits, moves, answers, results, closes and finalizing, and keeps open every way money
  leaves: `withdraw`, `withdraw_from`, claims of finished weeks, the seed withdrawal, the fee, and a later upgrade back
  to a fixed normal build. Rewards that arrive while it runs stay in the vault, owed to nobody yet; the next normal
  build's first close splits them. Weeks closed but not finalized wait for the normal build too. It never sponsors a
  call (so the vault's Mana stays for the KOIN it may need to burn into VHP for withdrawals).

## Compatibility
- `get_player`, `get_state` and every v5 method keep their arguments and results. New fields are appended only.
- The sponsor checks `get_player` (stake or pending > 0) to recognise real players. A player staked only in other
  games shows `stake_other > 0`, a new field; the sponsor's next version (Build 3's allowlist upgrade) must read it.
- New storage spaces 9–14; spaces 0–8 keep their v5 layout.
- Every new player action takes the player as argument field 1 (`deposit_to`, `withdraw_from`, `move_stake`,
  `claim_game`), like every v5 player action, so the Mana sponsor can check who it pays for.
- **Sponsor dependency:** sponsor v3 (branch `picks`) pays only for a fixed list of 8 game entry points and refuses the
  game contract on its allowlist. Until a sponsor version adds `deposit_to`, `withdraw_from`, `move_stake` and
  `claim_game` (the last as free play, for guest prize winners), players pay their own Mana for these calls.

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
| 10 | Unfilled 1st place | 2nd places still get their third; 1st's part goes back to the pool (2026-10-28) |
| 11 | Emergency | a withdrawals-only build is kept ready, so funds can always leave even if everything is shut down (2026-10-28) |

## RepoLens audit fixes (2026-10-28, `claude/audit-vault-v6-report.md`)
| Finding | Fix |
|---|---|
| V6-1 Critical: a correction between finalize pages overpaid a week | finalizing starts only after the correction window; corrections and voids refused once it starts; per-pot claim caps |
| V6-2 High: rollback to v5 | v3/v5 fingerprints refused; withdrawals-only build as the emergency target |
| V6-3 High: weight lost after 4 quiet weeks | every unclosed week a game passes keeps its weight; also on restart |
| V6-4 Medium: wrap hid an overdraw | checked subtractions; u128 liabilities and solvency check |
| V6-5 Medium: void without limits | only a past week the game earned, in the correction window, before finalizing |
| V6-6 Medium: restart reset the earning week | restart in the last earning week keeps running; after a gap, only once earned weeks are closed, and they keep their results |
| V6-7 Medium: new minimum folded early | folded only after the other games' last week under the old minimum is past corrections |
| V6-8 Low: 12 h to react | finalizing waits the full 24 h |
| V6-9 Low: 2nd with no 1st | 2nd gets its third |
| V6-10 Low: staked flag dropped with stake | refused |
| V6-11 Low: late closes | documented above |
| V6-12 Low: Mana not measured | measured on testnet before the upgrade (owner task) |
| V6-13 Low: tests | audit tests, 13-game close, late closes, safe mode, a conservation fuzz (`bot/vault-fuzz.test.ts`), check.ts lists the vault methods |

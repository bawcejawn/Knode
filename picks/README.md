# KnodeGames Picks

One small contract that keeps the picks for every KnodeGames game, free and staked. It holds **no tokens**, takes no
fee, never pays Mana and never calls another contract. It only keeps one pick per wallet per round of each game and
makes the **chain itself** enforce each game's rules. The recorders (`bot/games/`) score the picks off the chain, and
the vault pays prizes from the scores.

## What the chain enforces

- **Rounds and targets.** Round `r` of a game has a target `r × round_size + round_offset`, in block heights (height
  games) or in ms since 1970 (time games). Who Signs Block X: `round_size` 2,400, so round 20000 is block 48,000,000.
- **The lock.** A pick is refused once the head block has reached `target − lead`. `lead` is at least **100 blocks**
  (or 5 minutes), so every pick locks before the blocks that decide it. For Block X: the last block a pick can land in
  is `X − 101`.
- **The opening window.** Picks open `ahead` before the target. Block X: `ahead` 28,900, so exactly 12 targets are
  always open.
- **One pick per wallet per round.** It can be changed until the lock, at most `max_changes` times.
- **Daily cap.** At most `max_picks_per_day` picks (new picks and changes together) per wallet per game per UTC day.
- **The choice fits the game.** One producer (kind 1), a list of distinct producers up to `list_size` (kind 2), or a
  number from `number_min` to `number_max` (kind 3). A producer is any valid address.
- **Signed by the player** in the player's own transaction (not through another contract).
- **Cards (kind 4, the Combo Card; added 2026-10-28, not yet uploaded).** A pick is a card of 2 to `max_legs` legs
  (`max_legs` at most `list_size`, at most 10). Each leg is `{code, round, producer}`; its `code` names one of the game's
  `leg_types`, and each leg type has its own lock exactly like a game (target, `lead`, `ahead`, at most a day ahead). The
  chain refuses a card unless every leg is open now (and, for a change, every leg of the card it replaces), with one leg
  per leg type per round and each producer at most once. A card's round is its slot: UTC day × `round_size` + slot, made
  and changed only on that day. Leg types can only be **added** by the 48-hour announcement; tighten_game can switch one
  off, lock it earlier, open it later or lower `max_legs`.

## The owner (KnodeGames owner `1635QUr…H717`)

| Action | Wait |
|---|---|
| Add a game, or loosen one (`announce_game`, then anyone calls `apply_game`) | 48 hours, then 7 days to apply |
| Switch a game off, lower its caps, lock earlier, open later (`tighten_game`) | none |
| Hand over ownership (`propose_owner`, then the new owner calls `accept_owner`) | 48 hours; every earlier announcement becomes unusable |
| New code (`schedule_upgrade` with the sha256, then an upload signed by the owner) | 48 hours, then 7 days |

A game's **shape** (kind, list size, number range, lock mode, round size and offset) never changes once registered, so a
round always means the same target.

## Why it can never move tokens

- The code makes no call to any other contract (`npm run check` fails the build if one appears).
- It is uploaded with all three overrides **on**, and its `authorize` refuses `contract_call` (moving anything out of
  its account) and `transaction_application` (paying Mana) always. So after the upload, the wallet key it was uploaded
  with has no power over it, and anything sent to its address by mistake stays there.
- New code needs the owner's signature, the announced sha256 and the 48-hour wait, and must keep all three overrides on.

## Build and test (PowerShell, in `C:\kprediction`)

```
cd picks
npm ci
npm test
npm run check
cd ..
certutil -hashfile picks\build\release\contract.wasm SHA256
```

## Build

Independent audit 2026-10-27 (`docs/history/AUDIT-2026-10-27-picks.md`): verdict "fix first" for P-1 (High, an
announcement could survive an owner handover) and P-2 (Medium, tighten_game could be undone by an earlier
announcement). Both are fixed (owner generations; tighten_game drops the game's announcement), plus P-4 (the check
reads the compiled code too) and P-7 (`list_pending`). Fix-check 2026-10-27 (`docs/history/AUDIT-2026-10-27-picks-fixcheck.md`):
"ready for testnet"; its one new finding, PF-1 (Low, `list_pending` could come back empty with no cursor), is fixed
(`next`).

Release candidate sha256 (after the fix-check): `700c296a1064b904299c156061d6caf8fcabd0b1765968903f29d89d2426c594` (32,667 bytes).
Tests: 46 contract tests (`npm test`, in the Koinos mock VM), including the auditor's attack tests (`Picks.audit.spec.ts`).

Before announcing anything on mainnet (audit P-5, P-6): check on chain that all three overrides are on and the code's
fingerprint matches; on Harbinger, check that a pick's stored height is the height of the block that holds it, that a
Block X pick lands at X − 101 and is refused at X − 100.

Mock VM note: the test VM compares storage keys as strings, and some key bytes above 0x7f compare equal there (game ids
128 and 129 looked like the same game in a test). The chain compares raw bytes, so this affects tests only; tests keep
game ids below 128.

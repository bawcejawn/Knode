# Audit: KnodeGames Picks (`picks/`), 2026-10-27

Commit `85f6cdf` (branch `picks`). Scope: `picks/assembly/Picks.ts`, `picks/assembly/proto/picks.proto`,
`picks/assembly/__tests__/Picks.spec.ts`, `picks/scripts/check.cjs`, `picks/README.md`, `.github/workflows/picks-test.yml`.
Compared against `race/` (audited), `game/assembly/Kpred.ts` (`upgradeOk`, `txOps`) and `sponsor/assembly/Sponsor.ts`.

## 1. Summary

**Verdict: fix first.** No path moves tokens, pays Mana from the contract or replaces code outside the rules. Two
owner-timelock flaws need fixing: one lets a previous owner's announcements outlive the handover (P-1), and one lets a
stale announcement undo `tighten_game`, including an emergency switch-off, and anyone can trigger it (P-2). Both fixes
are small.

| Severity | Count |
|---|---|
| Critical | 0 |
| High | 1 (P-1) |
| Medium | 1 (P-2) |
| Low | 2 (P-3, P-4) |
| Info | 6 (P-5 to P-10) |

- `npm test`: **30 / 30 pass** (11 groups). `npm run check`: pass.
- Release `picks/build/release/contract.wasm`: **sha256 `25b78bb49b63424784f6bcca5fdea44761a0233e363b8696ec07e8dc52e1183d`**, 31,695 bytes. This matches the README.
- Auditor attack tests (`Audit.spec.ts`, 12 tests, alongside the 30 originals): **42 / 42 pass**. The tests assert the
  vulnerable behaviour, so "pass" means each attack works. The file is at
  `/tmp/claude-0/-home-claude/01aac551-8987-5a2a-8c8f-73ac9893e8c4/scratchpad/audit/picks/assembly/__tests__/Audit.spec.ts`.
- The repo was not modified.

## 2. Findings

### P-1: The owner handover does not clear more than 33 pending announcements, so a previous owner's loosening survives (High)

- **Where:** `Picks.ts:318-323` (`accept_owner` loop `i <= MAX_GAMES`) and `Picks.ts:223-236` (`announce_game` caps
  *registered* games, not pending ones).
- **Scenario:** The pending space has no size limit. While fewer than 32 games are registered, the owner can announce
  any number of new ids (1..1,000,000), and can also announce a loosening of a live game. `accept_owner` removes only
  the first 33 pending entries in key order, then stops. Everything after that stays pending. Once its eta passes,
  **anyone** can `apply_game` it under the new owner. The proto and README promise that the handover "clears every
  announced game change".
- **Impact:** The handover is the tool for rotating away from a lost or compromised owner key. An attacker holding
  that key can plant 34 or more announcements, and the planted loosenings of live games (caps up to the hard limits:
  50 picks a day, 50 changes, lead down to 100, ahead up to 35 days, re-enable) take effect under the new owner. There
  is no entry point to list pending announcements, so the new owner has to rebuild the list from `game_event`s and
  `cancel_game_change` each one. No tokens are at risk, and every value stays within the hard limits.
- **Fix:** Make clearing O(1) and complete. Store an `owner_epoch` (or generation) in `config`, write it into each
  `pending_game`, increment it in `accept_owner`, and have `apply_game` refuse a pending entry whose epoch differs.
  Alternatively, cap pending entries (for example a counter in config, at most 32) so the existing bounded loop
  provably clears them all. Also add a test with more than 33 pending entries.
- **Proof** (`Audit.spec.ts`, "AUDIT P-1"):
  ```ts
  const g90 = numberGame(); g90.id = 90; register(g90);
  for (let i: u32 = 0; i < 34; i++) { signedBy(OWNER); G = dummy(10 + i); announce(); MockVM.commitTransaction(); }
  const loose = numberGame(); loose.id = 90; loose.max_picks_per_day = 50; loose.max_changes = 50;
  signedBy(OWNER); G = loose; announce(); MockVM.commitTransaction();
  gOwner = P2; signedBy(OWNER); propose(); MockVM.commitTransaction();
  at(H, T0 + TIMELOCK_MS); signedBy(P2); acceptOwner(); MockVM.commitTransaction();
  expect(new Picks().get_game(new picks.get_game_arguments(90)).pending != null).toBe(true);
  nobody(); G = loose; apply(); MockVM.commitTransaction();                 // anyone
  expect(new Picks().get_game(new picks.get_game_arguments(90)).game!.max_picks_per_day).toBe(50);
  ```
  Output: `✔ ... [Log]: "pending dummies left after handover: 1"` (plus game 90's loosening). Test passes, so the
  attack works.

### P-2: `tighten_game` does not drop the pending announcement, so a stale announcement undoes the tightening and anyone can apply it (Medium)

- **Where:** `Picks.ts:256-275` (`tighten_game` leaves `pending` alone) and `Picks.ts:238-254` (`apply_game`, callable
  by anyone, overwrites the whole config).
- **Scenario:** The owner announces a change to game X, for example a cap from 30 to 40 (with `enabled = true`). The
  owner then switches X off with `tighten_game`, or tightens its lead, in response to an incident. 48 hours after the
  *original* announcement, any wallet calls `apply_game(X)`. The game is back on, and the tightening is gone.
- **Impact:** The emergency switch-off and the "tighten at once" guarantee can be reversed by anyone. The owner has to
  remember to `cancel_game_change` as well. The announced values were public for 48 hours, but switching on a game the
  owner had just switched off was never announced.
- **Fix:** In `tighten_game`, remove `pending[key]` if it exists and emit `"cancelled"`. Alternatively, have
  `apply_game` refuse when the pending entry is older than the game's last tighten (store `changed_at` in the game).
  Add a test for this case.
- **Proof** (`Audit.spec.ts`, "AUDIT P-2"):
  ```ts
  const loose = blockX(); loose.max_picks_per_day = 40;
  signedBy(OWNER); G = loose; announce(); MockVM.commitTransaction();
  const off = blockX(); off.enabled = false;
  signedBy(OWNER); G = off; tighten(); MockVM.commitTransaction();
  at(H, T0 + TIMELOCK_MS); signedBy(P3); G = loose; apply(); MockVM.commitTransaction();   // a stranger
  expect(new Picks().get_game(new picks.get_game_arguments(BX)).game!.enabled).toBe(true);
  at(TARGET - 500, T0 + TIMELOCK_MS); pick(P1, R, H1);   // the switched-off game takes picks again
  ```
  Passes.

### P-3: Picks `pick` has the same entry point as race `pick` (0x8ce33c6c); the sponsor's race mirror must not be reused (Low)

- **Where:** `picks/abi`, `check.cjs:35` (pick entry point `0x8ce33c6c`), and `Sponsor.ts:41,334-343` (`RACE_PICK` and
  `race_pick_args`).
- **Scenario:** Suppose the operator points the sponsor's existing `race` slot at the Picks contract, or adds Picks
  support by reusing `race_pick_args`. That is tempting because the entry point and the name are identical. Bytes
  `0a 19 <P1> 1a <L> <tail>` are canonical for `race_pick_args` (player P1, horse = tail). Picks' generated decoder
  ignores wire types, so it reads field 3 as `round = L`, then parses `tail` as fields, including `player = P2`. The
  sponsor sees P1 and the contract acts for P2. This is the same class as race finding S-1.
- **Impact:** As with S-1, Picks still requires P2's authority (`checkAuthority`), and the sponsor charges P1's caps.
  Nobody can pick for someone else, but the sponsor's "the payee's own pick" check would not hold.
- **Fix** (for the sponsor change, not this contract): use a separate `picks` contract slot in the sponsor config and
  an **exact** mirror of `picks.pick_arguments` (1 bytes, 2 uint32, 3 uint64, 4 repeated bytes, 5 uint64, with the same
  scalar types, because a uint64 `game` mirror would accept a value that Picks truncates). Require
  `encode(decode(args)) == args`, field 1 == payee, `producers.length <= 10`, and `args.length <= ~330`. The largest
  legitimate pick (10 producers, max round and number) is 317 bytes. Extend `npm run check` to compare the two
  definitions, as was done for race.
- **Proof** ("AUDIT P-3"): the bytes above decode as player P1 in the race mirror, and the mirror re-encodes them
  identically. Picks decodes them as player P2, game 2, round = L, and an exact Picks mirror's re-encode differs
  (refused). The related tests also pass: repeated field 1 (last one wins, refused by the canonical check), field 1
  sent with wire type 0 (read as bytes, refused by the canonical check), and `game` above 2^32 (truncated, refused by
  the canonical check).

### P-4: `check.cjs` checks source text, not the compiled contract (Low)

- **Where:** `check.cjs:7-15`.
- **Scenario:** The "no outgoing calls" check greps `Picks.ts` for `System.call(` and similar strings. A call made
  through a helper in another file, an SDK wrapper with a different name, or a change in `index.ts` would not be
  caught.
- **Fix:** Also check the release wasm. Parse `contract.wat` (or the wasm) and require that the only system call ids
  passed to `invoke_system_call` are the expected set. I extracted that set from the current release build:
  `{1, 103, 301, 302, 303, 304, 402, 501, 602, 603, 604, 605, 606}`. It contains no `601 call`,
  `5 apply_call_contract_operation` or `4 apply_upload_contract_operation`. That confirms guarantee 1 for this build.
- **Proof:** `grep "env.invokeSystemCall" -B12 build/release/contract.wat | grep -o "i32.const [0-9]*"` lists exactly
  the ids above.

### P-5: The lock edge depends on head-info semantics during block application; confirm on testnet (Info)

`pick` reads `get_head_info`. Reasoning from koinos-chain: while a block's transactions are applied, the head state
node is the block being built, so `head_topology.height` is **that block's height** and `head_block_time` is its
timestamp. In the mempool or RPC pre-check, it is the current head, one lower. If so, a pick is accepted in block B
only if `B < X − 100`, so the last block it can land in is **X − 101**, which is the design intent. If the chain
instead reported the parent, the last block would be X − 100, which is still well before X, so the lock is safe
either way.

**Testnet check:** submit picks near the edge and compare `pick_object.height` (stored from the head info) with the
height of the block containing the transaction. They must be equal. Also test `X − 101` (accepted) and `X − 100`
(refused).

Side effect: a transaction the mempool accepts at the edge can revert in the block. The payer, and later the sponsor,
still pays the Mana. Clients should stop offering a round a few blocks before `X − 101`. For time games, the block
producer sets the timestamp (race R-4, accepted).

### P-6: The code cannot enforce the deploy flags (Info)

Guarantee 1 holds only if the first upload sets all three overrides on. Nothing in scope deploys Picks:
`bot/race-picks.ts` uses all-false for race, and the Picks tooling (`bot/games/`) is untracked and out of scope. Before
`schedule_upgrade` and before announcing anything, verify the on-chain metadata (`bot/chaincheck.ts`) shows
`call/tx/upload = true` and the hash above.

### P-7: No way to list pending announcements (Info)

`get_game` works per id only, and ids go up to 1,000,000. Monitoring has to rely on `game_event`s. Consider a
`list_pending` entry point, which also helps the P-1 cleanup.

### P-8: Storage only grows (Info)

Pick objects (up to about 370 bytes including the key, for 10 producers) and day counts are never deleted. The cost per
wallet is bounded by `max_picks_per_day` per game per day (at most 50 × 32 games), and disk Mana falls on the payer.
For sponsored picks, the sponsor's own caps are the real bound, as in race S-2. Nothing a spammer can do costs more
than an ordinary maximal pick: the producer count is checked before any hashing (a 1,000-producer pick is refused with
`BAD_CHOICE`), and there are at most 20 hashes and 45 comparisons.

### P-9: Choice semantics to note for the recorders (Info)

A list game accepts 1 to `list_size` producers, not exactly `list_size`. The same producers in a different order is a
change: it uses one of `max_changes` and one of the day's picks (tested). If a game needs exactly N producers, the
contract does not enforce it.

### P-10: Minor (Info)

- After a successful upgrade, `upgrade_hash`/`upgrade_eta` stay set, so the same bytes could be uploaded again until
  expiry. That is harmless, but the new code or the bot should cancel the notice, as the Kpred runbook does.
- The workflow's `paths` filter leaves out `tools/pbjs-helpers/**`, which `prebuild` runs.
- The README build section still says "Not audited yet".

## 3. Checked and sound

- **No token movement or Mana payment:** `authorize` returns `false` for everything except `contract_upload`
  (`Picks.ts:77-81`). Tests confirmed this with OWNER and SELF signing, and also with an announced upload in the
  transaction. The release wasm makes no `call` or `apply_*` system call (P-4).
- **Upgrade hash:** `System.hash` gives a multihash, `Crypto.Multihash.deserialize(...).digest` is compared with the
  32-byte announced sha256, and a non-32-byte or empty hash is refused or cancels. This is identical to the audited
  Kpred code. `txOps` is byte-identical to Kpred's (diffed).
- **Several uploads:** every upload for SELF must match the hash and keep the three flags. One matching and one
  non-matching upload is refused. An upload for another contract id is ignored, and an upload only for another
  contract is refused (attack test).
- **Signer and window:** only the owner's `contract_call` authority counts. The upload key (SELF) alone is refused.
  The window `[eta, eta+7d)` is checked. The flags-off cases are refused (existing tests).
- **BUILD_FOR_TESTING:** the release build is `build-all release 0`, so `BUILD_FOR_TESTING=0`, and the release wasm
  contains the `"operations"` string and the `get_transaction_field` (103) call. That means the chain path is compiled.
- **Buffer size:** the system buffer is set to 1 MiB before reading the operations. Code larger than that makes the
  read fail, which reverts and refuses the upload (fail-closed). Other reads stay well under 1 KB: the largest pick
  object is about 300 bytes.
- **Lock arithmetic:** the overflow guard `round <= (MAX − offset)/size` (tests for `MAX/2400+1` and `MAX`).
  `target > lead && pos < target − lead` rules out underflow and makes round 0 always locked. `target − pos` cannot
  underflow because `pos < target`. `ahead` is inclusive and exact (tests at ahead and ahead+1). A missing topology
  gives height 0, so every pick is too early (attack test).
- **tighten_game:** all 14 fields are covered (shape and name must be equal; lead ≥; ahead ≤ and > lead; picks per
  day 1..≤; changes ≤; on→off only), followed by `checkGame`. My attack tests tried number range, offset, ahead below
  lead, 0 picks per day, lead equal to ahead and another id. All refused.
- **Game validation:** id 1..1,000,000, name 1..40 bytes, kind/list_size/number range per kind, lock mode,
  `round_offset < round_size`, lead and ahead limits per mode, caps. `apply_game` re-runs `checkGame`, `sameShape` and
  the count. At most 32 games (the `gameCount` and `list_games` loops are bounded at 33).
- **Owner handover:** propose (owner only, valid address, not SELF), empty cancels, 48 hours, 7-day expiry, only the
  proposed wallet's signature, and config reset (clears the upgrade). Correct apart from P-1.
- **pick authority:** `checkAuthority(player)`, and the caller must be empty or the player (race R-3). The player must
  be a valid address. Producers must be valid checksummed addresses and distinct. Number range is checked. SAME is
  refused. `max_changes` is enforced, and lowering it freezes picks already at the limit (attack test).
- **Daily cap:** per game, per player, per UTC day of `head_block_time`. Refused picks don't count (attack test: 5
  SAME refusals leave the count at 1).
- **Keys:** a pick key is game BE4 + round BE8 + player 25 = 37 bytes; a day key is 29 bytes in its own space. Both
  are fixed length with no collisions and sort by game, round, player.
- **list_picks:** limit ≤ 100. It starts after an all-zero address, which can never be valid. A cursor that is
  neither empty nor 25 bytes is refused (R-1). It stops at the prefix or length boundary, so it never returns another
  round's rows. `get_usage`, `get_game` and `list_games` are read-only and bounded.
- **Events:** `pick_event` lists the player as impacted, and game, owner and upgrade events list the contract.
- **Workflow:** actions pinned by SHA, `npm ci --ignore-scripts`, permissions `contents: read`.

## 4. Not checked, and why

- **koinos-chain head-info and caller semantics:** reasoned only, because I couldn't fetch the koinos-chain source
  from here (the URL is not on the allowlist). Confirm on testnet as described in P-5.
- **On-chain key order for game ids ≥ 128 and the `txOps` chain path:** the mock VM can't show either. They are
  reasoned from the code and the identical audited Kpred code.
- **The Picks deploy and recorder tooling (`bot/games/`) and the future sponsor change:** out of scope or not written
  yet. P-3 and P-6 give the requirements.
- **Real Mana costs:** there is no chain access by design.

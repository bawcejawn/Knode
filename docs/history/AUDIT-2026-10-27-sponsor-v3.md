# Audit: Mana sponsor v3 (`sponsor/`), commits 260bc1c, b149d7c and cbbcd4b

Compared against the live v2 (`fa4659e6…`). In scope: `sponsor/assembly/Sponsor.ts`, `sponsor.proto`,
`scripts/check.ts`, the v3 tests, `bot/sponsor.ts` (Picks row, caps), `site/wallet.js` (sponsor and guest paths), and
the Block X prize rule (`site/blockx-math.js`, `bot/games/blockx.ts`) for the sybil question.

## 1. Summary

**Verdict: ready for testnet, with two small fixes recommended before mainnet (S3-1, S3-2).** No Critical, High or
Medium findings. v3 pays nothing that v2 refused beyond the three intended additions: allowlisted rows, the payee's own
free claim, and a stricter real-player rule (L-3). For the Picks row, the argument scanner and the Picks decoder read
the same player in every case I could construct, including 20,000 structured fuzz cases. The 1 Mana per-transaction
cap and the 300 Mana/day free sub-cap still bound what the sponsor can spend. They do **not** stop sybil farming of
the Block X prize. That prize is small (3 VHP a week), so the effect is bounded (S3-4).

| Severity | Count |
|---|---|
| Critical / High / Medium | 0 |
| Low | 3 (S3-1, S3-2, S3-4) |
| Info | 4 (S3-3, S3-5, S3-6, S3-7) |

- Sponsor `npm test`: **140 / 140 pass**. `npm run check`: all offline checks pass. Release sha256
  **`bbd921e75a0e9fe48412ee65dab51539a2f5d7d3e8c65a956962b6c4af5e79d1`**, as expected. `cbbcd4b` does not change it.
- Root `npm run test:audit:serial` at cbbcd4b: **373 tests: 363 pass, 0 fail, 5 skipped, 5 todo**.
- My attack tests (`V3audit.spec.ts`, 7 tests, run with the v3 spec): **20 / 20 pass**. They are in
  `/tmp/claude-0/-home-claude/01aac551-8987-5a2a-8c8f-73ac9893e8c4/scratchpad/audit/sponsor/assembly/__tests__/V3audit.spec.ts`,
  with a transaction-size script at `…/scratchpad/audit/txsize.cjs`.
- The repo was not modified.

## 2. Findings

### S3-1: The sponsor reads the transaction into a 1 KB buffer, so more than 7 picks in one transaction is always refused (Low)

- **Where:** `Sponsor.ts:127` (`System.getTransaction()`, with no `setSystemBufferSize`) and `MAX_OPERATIONS = 10`.
- **Scenario:** The serialized transaction (header, operations, one signature) for Block X picks is:
  1: 343 B, 2: 442, 3: 541, 4: 640, 5: 739, 6: 838, 7: 937, **8: 1,036, 9: 1,135, 10: 1,234 B**. For 10-producer picks:
  1: 589 B, 2: 934 B, **3: 1,279 B**. Anything above 1,024 bytes fails the read. It fails closed, so the transaction is
  not paid. The mock VM shows the same thing ("Index out of range"): 7 picks are paid, 10 are refused.
- **Impact:** Nothing is lost, but the advertised "1 to 10 operations" is really about 7. `would_pay` does not see the
  transaction, so the site would get a "yes" and then a refusal when it sends. Today the site sends one pick per
  transaction (`site/blockx.js:171`), so nothing is affected yet. The same limit already exists in v2.
- **Fix:** Call `System.setSystemBufferSize(16 * 1024)` before `getTransaction()`, and keep the 400-byte argument cap.
  Alternatively, document the real limit, and have the site never batch more than about 6 picks or 2 list picks.
- **Proof:** `V3audit.spec.ts` "7 Block X picks in one transaction are paid; 10 overflow…" passes. `txsize.cjs`
  printed the sizes above.

### S3-2: The generic scanner can't protect rows whose later field is a nested message (Low, latent)

- **Where:** `argsPlayer` (`Sponsor.ts`, "3 = bytes or a message") and the `allowed_call.arg_types` documentation.
- **Scenario:** as-proto's nested decoder (`X.decode(reader, reader.uint32())`) does not stop at the nested length: a
  `bytes()` inside it can read past the end of the sub-message. The scanner treats every type-3 field as an opaque
  block. Example, using a `{1 bytes player, 2 message}` shape (Picks' own `pick_row`) with arg_types `0303`:
  - The scanner reads player = USER.
  - The as-proto decoder reads player = OTHER, because the nested field's length is ignored and decoding continues
    into an outer field 1.
- **Impact:** None for the Picks row. Its field 4 is plain `bytes`, never parsed, and the fuzz confirms this. The race
  slot and claims are also unaffected. A future allowlisted entry point that takes a sub-message (for example a game
  config or a struct argument) would bring back race finding S-1: the sponsor charges the payee while the contract
  acts for another wallet. That wallet's authority is still needed, and the sponsor requires exactly one signer (the
  payee), so another *wallet* can't be targeted. A contract account whose `authorize` says yes could be.
- **Fix:** Document and enforce that `arg_types` byte 3 means `bytes`/`string` only. Refuse nested-message rows in
  `set_config`, or add a "message" type that the sponsor recursively scans. In `bot/sponsor.ts` and `check.ts`, check
  each allowlisted shape against the target ABI (as is done for Picks) and refuse any `message` field.
- **Proof:** `V3audit.spec.ts` "S3-2 … pick_row" passes: the scanner returns USER and `pick_row.decode` returns OTHER.

### S3-3: Free claims are charged in full even when they revert, and `claim` runs `advance()` first (Info)

- **Where:** `isFreePlay` (claim branch) and `Kpred.ts:679-684` (`claim`: `advance(c)` runs *before* `claimCheck`).
- **Scenario:** Any empty wallet's own claim, for any week, is free play, including one it can never win (attack test:
  week 99, ten claims in one transaction, and an overlong week varint all paid). On chain the claim reverts at
  `claimCheck`. If a close or finalize step is due, `advance()` first does that work and then rolls it back. The Mana
  used, up to the transaction's `rc_limit`, is still charged.
- **Quantified:** each such transaction costs the sponsor at most 1 Mana (the per-transaction cap). The caps count
  `rc_limit`, not the real use, so the counted amount is always at least what was spent. Bounds: 25 per wallet per day,
  and **300 per day shared by all free wallets**, together with free answers and picks. So free claims can't make the
  sponsor spend more than v2's free total. They are one more way to use up the shared 300.
- **Fix (optional):** In the game's next version, run `claimCheck` before `advance`. In the sponsor, consider allowing
  only one claim operation per transaction.

### S3-4: Sybil farming of the Block X weekly prize is not bounded by the caps (Low; owner decision cbbcd4b)

- **Rule** (`site/blockx-math.js:107`): any wallet, guests included, with picks on at least 3 UTC days and at least 1
  point. 1st place gets 2 VHP and 2nd gets 1 VHP. Up to 12 targets a day, so about 84 picks a week for a fully active
  wallet. Points come only from correct picks (the multiplier is up to ×3).
- **What the sponsor bounds:** free wallets share 300 Mana a day, and each pick counts 1. So the sponsor pays for at
  most **300 free picks a day, 2,100 a week**, enough for **about 25 fully active sybil wallets** (25 × 12 a day). The
  attacker pays nothing: no KOIN, only free keys. The sponsor's real cost is at most 300 Mana a day of regenerating
  Mana, no KOIN spent, which is the same as v2.
- **What it doesn't bound:** the attacker can spread picks across producers so one of 25 wallets scores far above any
  single honest player. Each extra wallet is another lottery ticket. With their own KOIN (Mana regenerates, so about
  10 KOIN covers a wallet's picks), the number of wallets has no limit at all. The per-player caps (25/day, 150/week)
  don't help: each sybil is a new player.
- **Value at stake:** at most **3 VHP a week** (about 3 KOIN). The attacker's cost is close to zero, so farming pays
  whenever the attacker bothers. The larger harm is side effects. A farmer who uses the sponsor uses up the shared 300
  free Mana early in the UTC day, and then real guests pay their own Mana or can't play (the same denial of service
  already exists in v2, now with a reason to do it). Prizes also go to the farmer rather than real players.
- **Options:** accept it (the loss is bounded at 3 VHP a week, and monitor for clusters of wallets funded together or
  picking the same targets in a coordinated way); or pay prizes only to wallets that are real players (at least
  `min_vhp` or a stake), as before cbbcd4b; or require a minimum number of picks or days well above 3; or cap free-play
  sponsoring per day lower than the prize-relevant activity. Note that requiring real players for prizes doesn't stop
  sybils who hold KOIN; it only removes the free sponsor path.

### S3-5: Per-transaction Mana for 1 to 10 picks (Info; estimate, confirm on testnet)

- The sponsor counts the `rc_limit` (1 Mana) per transaction, whatever the number of picks, and the chain never
  charges more than `rc_limit`. So batching never lets the sponsor spend more than it counted.
- Real use per pick comes from: 2 storage writes (a 37-byte key with a pick object of about 80 bytes, and a day count)
  plus 4 reads, one event, up to 3 double-sha256 hashes (player and producers), and about 100 bytes of transaction.
  That is far below the 0.31 Mana that the owner's `schedule_upgrade` used, so one pick should be a small fraction of
  1 Mana. Ten 10-producer picks could come close to 1 Mana, but the 1 KB limit refuses more than 7 or 2 anyway (S3-1).
- **Testnet:** measure `rc_used` for 1, 3 and 7 Block X picks and one 10-producer pick, and set the site's `rcLimit` to
  about twice the single-pick cost. If one pick costs well under 1 Mana, a lower `rcLimit` lets the same caps cover
  more picks.

### S3-6: The free claim helps only guests; staked claims keep the existing path (Info)

The free-claim branch requires `argsPlayer(claim)` to be the payee. A non-canonical claim falls back to "real players
only" (test). For real players, claims were already paid in v2 (and their `rcLimitOther` is 3 Mana, above the 1 Mana
per-transaction cap, so the site's sponsored claims for real players are refused by the per-transaction cap unless the
caps change; this is unchanged from v2). `site/wallet.js` still tells guests "the sponsor doesn't pay it yet"
(`guestCant`): update it when v3 goes live.

### S3-7: `check.ts` compares the Picks shape only when `../picks` exists (Info)

On a checkout without `picks/`, the Picks checks are skipped silently. Make them required once the Picks row is in
the configuration.

## 3. Checked and sound

- **What v3 pays that v2 refused:** only
  - (a) a call that matches an allowlisted row, with the payee's own player in a shape the scanner accepts;
  - (b) the payee's own game claim with clean arguments, counted as free play;
  - (c) nothing else.

  L-3 is **stricter**: v2 counted any stake above 0 as a real player; v3 needs the stake (active, pending or both) to
  reach `min_vhp` (tests). `checkOperation` for game, desk, race and tokens is unchanged. The one-signer, payee and
  per-transaction rules come first, as in v2.
- **Allowlist validation:**
  - at most 8 rows;
  - each a valid address;
  - not the game, desk, race, a token, VHP or the sponsor; the race slot can't equal an allowlisted contract either
    (attack test);
  - arg_types 1 to 16 bytes, with the first byte 3 and only the values 0/1/2/3/6;
  - no duplicate (contract, entry point);
  - set only by the sponsor's own key (tests).
- **Scanner vs the Picks decoder:**
  - In the structured fuzz (20,000 cases: overlong tags, lengths and values, zero-length and length-25 bytes, repeated
    and out-of-order fields, every wire type, payloads over 400 bytes), 2,890 were accepted. Every accepted case
    decoded to the same player (USER). The 4,000-case mutation fuzz in the v3 spec agrees.
  - Overlong varints: the scanner accepts tags and lengths of up to 5 bytes and values of up to 10, which matches or is
    stricter than as-proto's `varint32`/`varint64` (5 + 5, and 10). A 5-byte tag with high bits gives a field number
    above 16, which is refused. Larger tags and lengths are refused. Tested.
  - A length beyond the end is refused (as-proto would trap).
  - Packed fields: Picks has no packed fields. A packed field 4 is plain bytes, read as an opaque producer, which then
    fails `isAddress` in Picks. A packed varint field (wire type 2 where 1 is listed) is refused.
  - Field 1 must be first, exactly once and exactly 25 bytes, so a repeated player (as-proto keeps the last one) is
    refused.
- **Claim arguments `{1 bytes, 2 uint64}`:** no nested messages, so the scanner's reading is exact. The game also
  requires the player's own authority.
- **Race slot:** unchanged; it still uses the canonical `race_pick_args` check from S-1. Picks and race share entry
  point `0x8ce33c6c` but are told apart by contract id, and they can't be the same contract.
- **The game's built-in sponsoring** (`Kpred.sponsorOk`) is separate: the game pays only for its own single-operation
  calls. v3 doesn't change it.
- **Caps (cbbcd4b):** per transaction 1, 25 per wallet per day, 150 per wallet per week, 1,000 for everyone per day,
  300 per day free. `buildConfig` still enforces per transaction ≤ day ≤ week and day ≤ everyone's daily total. The
  sponsor's worst case is unchanged: at most 1,000 Mana a day, which its 5,000 KOIN regenerates.
- **Site:** `sponsorFor` still refuses more than 10 operations and anything not in `covers`. Guests can sign only
  answers and picks on the pinned contracts (`PINNED_PICKS` empty, so none on mainnet yet). `checkGuestTx` checks
  `rc_limit` against `rcLimit`.

## 4. Not checked

- **Real Mana use** (`rc_used`) for picks and claims: there is no chain access. Estimate in S3-5; measure on testnet.
- **On-chain `get_transaction` behaviour with a buffer that is too small:** reasoned to fail closed, and the mock VM
  agrees. Confirm on testnet with an 8-pick transaction.
- **`bot/games/blockx.ts` recording and the prize payout:** out of scope apart from the eligibility rule used in S3-4.
- **Mainnet upload and config steps:** not run, by the rules of this audit.

## Re-check: d2a8f2e (/home/claude/knode, branch `picks`)

**Verdict: ready for testnet, and from the code, for mainnet.** Tests pass **147 / 147**. `npm run check` passes and
now requires the Picks ABI and checks that `pick_arguments` has no nested messages. Release sha256
**`15ffd998ee6bb28734ee3a209cd06fa6da5667ce28b1d867ad604f6be94849f7`**, as expected.

| ID | Status |
|---|---|
| S3-1 | **Fixed.** `setSystemBufferSize(16 KB)` is the first thing `authorize` does for transaction_application. The kept test pays 7 and 10 Block X picks in one transaction. The largest legitimate transaction (10 operations × 400 argument bytes plus header and signature) is about 4.6 KB, well under 16 KB. |
| S3-2 | **Mitigated as documented.** `sponsor.proto` says that allowlisted rows must not take nested messages, and `npm run check` asserts it for the Picks row. The contract itself still cannot enforce it, so any future row must be checked the same way before it goes into `set_config`. Accepted. |
| S3-7 | **Fixed** (the Picks ABI is now a required check). |
| S3-3, S3-4, S3-5, S3-6 | Unchanged (Info/Low, owner decisions or testnet measurements). |

**Does the 16 KB buffer have any downside?**

- **Mana for the sponsor:** none. If `authorize` refuses, the transaction is not included and nobody is charged. If it
  pays, the chain charges at most `rc_limit` (at most 1 Mana), which is what the caps count. A bigger transaction
  costs more compute inside that same limit. The sponsor can't be made to pay more than it counted.
- **Making authorize read huge transactions:** the buffer is the ceiling. A transaction serialized above 16 KB fails
  the `get_transaction` read and is refused, failing closed as before, only at a higher size. Below 16 KB, the
  `MAX_OPERATIONS`, operation-type and 400-byte argument checks still refuse anything that isn't a small player
  action. The owner's own large transactions (for example re-uploading the sponsor code) don't depend on it: the
  owner path reads only the `signatures` and `id` fields, before the whole transaction is read.
- **Memory:** one extra 16 KB allocation per `authorize` call, which is negligible.
- **One side effect (Info, S3-8):** `signatureAddresses()` now runs with the 16 KB buffer, so a transaction could
  carry about 240 signatures (before: about 15) and `authorize` would recover every public key before the "only the
  payee may sign" check refuses it. The sponsor pays nothing, because the transaction is refused before inclusion. It
  is only extra node CPU for a transaction that can't succeed, and the chain's own compute limit for `authorize`
  bounds it. Optional fix: read the signature list and refuse when it has more than one entry before recovering any
  keys, or set the 16 KB buffer only just before `getTransaction()`.

No new findings above Info.

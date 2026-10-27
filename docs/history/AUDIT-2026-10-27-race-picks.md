# Independent audit 2026-10-27: Producer Race picks (`race/`) and Mana sponsor v2 (`sponsor/`)

Audited commit `b3325cc` (branch `race-picks`); fixes in `85f3887`. The auditor's attack tests are kept as regression
tests: `race/assembly/__tests__/Race.audit.spec.ts` and `sponsor/assembly/__tests__/Sponsor.audit-v2.spec.ts`.

No Critical, High or Medium findings. A fix check of `85f3887` by the same auditor confirmed S-1, R-1 and R-3 fixed with no new issue (20 more sponsor tests, `Sponsor.fixcheck.spec.ts`, incl. 300 single-byte mutations; the caller check read against koinos-chain 1.5.2 `get_caller`: a direct transaction reports an empty caller). Audited builds: race `61e8f21230e8b4bdb165bacfe7281517a5adf78f6c6b1b8a0d84ce41537afac5`, sponsor v2 `fa4659e65c6156da3dde34238e0545a489a8b7f00cdf51df9bf79517a0019f33`.

| ID | Severity | Finding | Status |
|---|---|---|---|
| S-1 | Low | The sponsor and the race contract could decode a pick's arguments differently (a field skipped by wire type), so the sponsor's "a pick must be the payee's own" check could be bypassed: the sponsor read the payee, the race contract another player. Still needed that other player's authority, and charged the payee's caps. | **Fixed**: the sponsor reads all three fields like `race.proto` and requires the canonical encoding (`encode(decode(args)) == args`) before checking the player; `npm run check` compares the two definitions. |
| R-1 | Low | `list_picks` silently restarted from the first pick on a `start_after` of the wrong length. | **Fixed**: refused with `RACE: bad start_after` (empty = from the start). |
| R-2 | Info | The owner can be set to a contract address that never authorizes, freezing settings until new code is uploaded. | Accepted: `bot/race-picks.ts` always sets the Knode owner wallet from `game-data/deployment.json`. |
| R-3 | Info | `pick` had no caller check: a contract the player signs a transaction for could make or change picks. | **Fixed**: the caller must be empty (straight from a transaction) or the player. |
| R-4 | Info | The lock uses the block timestamp; the producer of the first block after a start could backdate it slightly (seconds of a 6-hour race). | Accepted (chain-wide property). |
| R-5 | Info | The race contract's own key can upload new code; picks are never deleted (about 70 bytes each, disk Mana paid by the sponsor). | Accepted: keep `RACE_WIF` offline. |
| S-2 | Info | The sponsor pays for picks the race contract then rejects; the sponsor's own caps bound it (as for answers in v1). | Accepted. |
| S-3 | Info | The website treated only answers as free play. | **Fixed** in `site/wallet.js` (answers and picks are free play; guests pick only on the pinned race contract). |
| T-1 | Info | The mock VM orders keys as strings, so the paging tests don't prove on-chain order; on chain every pick key is 33 bytes and sorts by race, then player. | Accepted (reasoned). |

## Checked and found safe (summary)

- Race: the lock is exact (`race > now / RACE_MS`), the 24-hour window (c+4 open at exactly 24 h, c+5 never), no u64
  overflow, the daily limit per UTC day (refused repeats not counted, failed picks roll back), signatures and address
  checks, fixed 33-byte keys with no collisions, `list_picks` never returns another race's rows, the first setup can't
  be front-run, entry points match the ABI.
- Sponsor v2: with `race` unset it behaves as v1 (an old config decodes with `race` = null); `set_config` validates
  `race`; only `pick` on the race is paid; a pick mixed with any non-free operation needs a real player; the one-signer
  rule comes first; the caps are unchanged and shared with answers, so v2 can't spend more per day than v1; the earlier
  audit-attacks suite still passes.

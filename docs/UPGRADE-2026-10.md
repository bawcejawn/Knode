# Kpred upgrade v4 (2026-10): runbook

Nothing in this file has been run. Every command below that changes something is a dry run until you add `--send`.

| | |
|---|---|
| Contract | Kpred `1Mpmf2ERhjYpX7CCiM11WERuM4j17uT1sr` (mainnet) |
| Live code | sha256 `917708a7c567d9642a7a2f121c34fbc70200909787208705fc3aa5a2b1e6433a` (commit `1c25791`) |
| **New code** | sha256 `ee5a9f8c3a3949b0749aee5a12712c5b56694f3e1342ec6e49e79bd7be8bf214` (`game/build/release/contract.wasm`, 53,837 bytes, built from branch `audit-fixes-1`) |
| Timelock | 48 hours after `schedule_upgrade`; the live code has no expiry, the new one gives 7 days after it |

## What changes

| Finding | Change in the contract |
|---|---|
| AB-004 | A week closes no sooner than `close_delay` (12 h) after its **last** resolution or correction, as well as 12 h after it ends. A late result never closes its week in the same transaction. Owner changes to a posted result stop a quarter of `close_delay` (3 h) before the close; each change restarts the 12 h. |
| AB-013 | `accept_owner` only 28,800 blocks (about 24 h) after `propose_owner`, so the hourly bot sees the pending transfer many times and emails you, and you have a day to propose your own address again. |
| AB-014 | An announced upgrade or seed withdrawal can be carried out only during the 7 days after its timelock ends; after that it must be announced again (fresh 48 h). |
| AB-015 | Answers stay open at least `week_length / 168` (exactly 1 hour with 7-day weeks). |
| AB-003, AB-017 | The contract pays Mana only for an answer, settle or claim that will succeed: no claims for weeks not yet finalized; `rc_limit` between a floor (default half the cap; `set_sponsor_limit` now takes an optional floor) and the cap; arguments must be canonical (re-encoded byte for byte, at most 64 bytes); each account gets at most "stake ÷ cap" sponsored answers per week, plus one settle and one claim. |
| AB-011 | Finalization is paged: at most 500 places per transaction; any game action (or `finalize_week`) runs the next page. Claims open when the last page is done. |
| AB-016, AB-020 | Eligibility stays "at least 2 counted answers and at least `min_stake`", plus stake > 0. New owner-only `set_min_stake` (never 0, applies from the next week, never the current one; `init` also refuses 0). From the week after the upgrade, the winners' 30% is counted over eligible players with at least one point, so zero-score accounts no longer pull the cutoff down. |
| AB-019 | New tests catch removing the solvency check, the house-share fallback and the `min_stake` boundary. |

The ABI gains `set_min_stake`, an optional `min_sponsor_rc` in `set_sponsor_limit`, and `done` in
`finalize_week_result`. Entry point ids of existing methods are unchanged (the bot and the website keep working with
both the live and the new code).

## Storage: compatibility and new fields

Every stored object keeps its space, key and fields. New fields are appended to existing messages (protobuf), so data
written by the live code reads back unchanged and the new fields read as their defaults until used. This is tested:
`game/scripts/storage-compat.test.ts` lets the live code (its test build, `game/test-fixtures/`) write a full game
history, swaps in the new code on the same storage, checks every read-only view returns exactly what the live code
returned, then keeps playing (claims, the running week, the seed withdrawal, all withdrawals, books balance).

| Object (space) | New field | Default in existing data | Meaning |
|---|---|---|---|
| config (0) | `min_stake_next` (13) | 0 | a scheduled minimum stake; 0 = none |
| config (0) | `min_stake_next_week` (14) | 0 | first week it applies to |
| config (0) | `pending_owner_height` (15) | 0 | height of `propose_owner`; a transfer proposed before the upgrade (0) must be proposed again |
| config (0) | `min_sponsor_rc` (16) | 0 | sponsorship floor; 0 = half of `max_sponsor_rc` |
| config (0) | `scorer_rule_week_plus_one` (17) | 0 | first week (+1) of the "players with points" 30%; the first action after the upgrade sets it to the next week |
| week (5) | `last_resolved_time` (26) | 0 | time of the latest resolution or correction |
| week (5) | `fin_started` (27), `fin_points` (28), `fin_index` (29), `fin_rank` (30), `fin_gw` (31) | false / 0 | paged finalization progress (weeks finalized before the upgrade never use them) |

No new storage space, no migration call. Players, entries, questions, buckets, totals, the seed and the timelocks are
untouched.

## Before you start

1. Review and merge `audit-fixes-1` (all GitHub checks green). The bot and website changes work with the live contract
   as well, so they can go first. The How it works text describes the v4 winners' rule, which applies from the week
   after the upgrade.
2. On your PC, in a clean checkout of the merged `main`:
   ```
   cd game
   npm ci
   npm test            # 86 contract tests, then the release build
   npm run check       # offline safety check
   ```
   ```
   certutil -hashfile build\release\contract.wasm SHA256
   ```
   It must print `ee5a9f8c3a3949b0749aee5a12712c5b56694f3e1342ec6e49e79bd7be8bf214`. If it does not, stop: you are not building the reviewed code.
3. `npm run bot -- status` and save the output (`npm run bot -- status > before-upgrade.txt`) to compare afterwards.
4. `npm run bot -- upgrade status`: nothing should be announced. If something is, find out why before going on.
5. Pick the timing: schedule on a Tuesday or Wednesday so the upload lands mid-week, away from the weekly close
   (Monday 12:00 UTC) and finalization (Tuesday 12:00 UTC). It is safe at any time (tested), this only keeps it simple.
6. The bot wallet (`OPERATOR_WIF`) needs about 60 KOIN of Mana for the upload.

## 1. Schedule (starts the 48 hours)

```
npm run bot -- upgrade schedule          (dry run: shows the hash it will announce)
npm run bot -- upgrade schedule --send
```

- It announces the sha256 of your local build; check it is `ee5a9f8c3a3949b0749aee5a12712c5b56694f3e1342ec6e49e79bd7be8bf214`.
- Note the time it prints ("can be uploaded from …").
- The bot emails you that an upgrade is scheduled: that is expected. Tell players (the Trust page shows the
  announcement); they can withdraw during the 48 hours if they disagree.

## 2. Wait 48 hours

Do not rebuild in between. `npm run bot -- upgrade status` shows the time left and "matches the local build".

## 3. Apply

```
npm run bot -- upgrade apply             (dry run: checks the hash, the time, the owner and the Mana)
npm run bot -- upgrade apply --send
```

It uploads exactly the announced code (owner authorizes, bot wallet pays), then clears the notice
(`cancel_upgrade`) and writes the new hash into `game-data/deployment.json`. Commit and push that file.

## 4. Verify

1. Code hash on chain (read-only; nothing is signed). Fetch the contract's metadata and check it with the audit tool,
   as in the audit report's §KX-26, expecting `0x1220ee5a9f8c3a3949b0749aee5a12712c5b56694f3e1342ec6e49e79bd7be8bf214` and all three authorize flags true:
   ```
   curl -s -X POST https://api.koinos.io -H "content-type: application/json" -d "{\"jsonrpc\": \"2.0\", \"id\": 1, \"method\": \"chain.invoke_system_call\", \"params\": {\"id\": 303, \"args\": \"CgYIARIAGAMSGQDka1eqiZY46QAtkl2DCfUVJJ_OmXITQJU=\"}}" > meta-kpred.json
   python C:\Users\alcat\.claude\skills\audit-bot\scripts\verify_deploy.py --contract 1Mpmf2ERhjYpX7CCiM11WERuM4j17uT1sr --wasm game\build\release\contract.wasm --meta-json meta-kpred.json --expect-upload-override yes --expect-call-override yes --expect-tx-override yes
   ```
2. `npm run bot -- status`: compare with `before-upgrade.txt`. Weeks closed/finalized, questions posted, holdings,
   owed (stakes, seed, fee, pots) must be the same, apart from new block rewards since then.
3. `npm run bot -- upgrade status`: nothing announced.
4. GitHub → Actions → Kpred bot → Run workflow. It must finish green, and the next resolution must post normally.
5. After the first game action (any answer or the bot's next post), `get_state` shows `scorer_rule_week_plus_one` set
   to the current week + 2.
6. The Trust page shows the new code fingerprint.

## After the upgrade

- Minimum stake: still 1 VHP. To change it: `npm run bot -- min-stake <VHP> --send` (applies from next week).
- Sponsorship: the cap is still 2 KOIN, so the floor is 1 KOIN. To set your own floor:
  `npm run bot -- sponsor-limit 2 0.5 --send`. To switch it off: `npm run bot -- sponsor-limit 0 --send`.
- A pending ownership transfer from before the upgrade must be proposed again (there should be none).

## If something goes wrong

There is no instant rollback: the only way back is another upgrade through the same 48-hour timelock (schedule the
live code's hash `917708a7…` built from commit `1c25791`). Players can withdraw at any time meanwhile. If the upload
itself fails, nothing changes; check `npm run bot -- upgrade status` before trying again.

# Upgrade to game v5 and Desk v2: runbook

Nothing in this file has been run. Every command that changes something is a dry run until you add `--send`
(mainnet also needs `CONFIRM_MAINNET=yes` in `.env`). The same steps are buttons on the admin page (`npm run admin`).

| | Game (Kpred) | Desk (Knode Swap) |
|---|---|---|
| Contract | `1Mpmf2ERhjYpX7CCiM11WERuM4j17uT1sr` | `1FKTpXBhhHEbu5vVchM8UsVbAvPArJsRmR` |
| Live code | `917708a7c567d9642a7a2f121c34fbc70200909787208705fc3aa5a2b1e6433a` (v3) | `05039d743d383538d0078a89e3bfde56e052c0eb478cf14dad63afd366b761e4` (v1) |
| **New code** | `fa44cfad0f04ab693ec1a2b981386281ff73aa04fc8f4659cc9c6b66173da526` (56,479 bytes) | `b8f1269f61b575a2862efb8eeefd1f1d0d3e9e0ac201f2d06c9fd803a113259d` (34,080 bytes) |
| Timelock | 48 h after `schedule`, then 7 days to upload (the live v3 has no expiry) | 48 h after `schedule` |
| Upload paid by | the owner wallet (~60 KOIN of Mana) | the owner wallet (~25 KOIN of Mana) |

Game v5 = the audited v4 (`docs/UPGRADE-2026-10.md` lists its changes) plus the v5 items below. Desk v2 is new.
Both were checked by an independent review of the code changes (no Critical or High findings; its Medium and Low
findings are fixed and tested).

## What changes

**Game v5** (on top of v4):
- Rewards, from the first full week after the upgrade: winners are the top 30% of staked players with at least one
  point (as v4). The pot (after the 5% fee) is split 40% / 60%: basket A by place weight × stake counted up to 10 VHP
  per wallet, basket B by place weight × full stake. Weeks before keep the old split.
- At most 30 questions a week, so at most 30 points.
- The seed can be handed over in two steps (`propose_seed_owner`, then `accept_seed_owner` a day later), never to the
  game contract itself.
- A minimum-stake change needs 48 h of notice (else it applies a week later), and one already promised for the coming
  week can't be overridden inside those 48 h.
- An owner handover clears an announced upgrade; sponsored transactions with more than one signature are refused;
  pots waiting to roll over count in the solvency check.

**Desk v2**:
- The Desk can change hands: `propose_owner`, then the new owner accepts after 48 h (the owner can cancel). Accepting
  clears anything the previous owner announced.
- A lower fee, a higher (or removed) daily cap and a new node key wait 48 h, then `settings apply`. A higher fee or
  lower cap applies at once.
- A daily payout cap: swaps pay out at most the cap at once, and room frees up at the cap per 24 h. **It starts with no
  cap**: set one right after the upgrade (step 6 below).
- The node key must be a valid compressed public key.

## Storage

Both upgrades keep every stored value. New fields read as their defaults. Tested: `game/scripts/storage-compat.test.ts`
(live v3 → v5 at every risky moment of a week, through the live code's own upload check, claims left open, rollback)
and `desk/scripts/storage-compat.test.ts` (live v1 → v2, rollback).

## Before you start

1. The audit-fix branch is merged into `main` (GitHub settings first: see `docs/WALLETS.md` and the merge notes).
2. On your PC, in the merged `main`:
   ```
   git pull
   cd game && npm ci && npm test && npm run check && cd ..
   cd desk && npm ci && npm test && npm run check && cd ..
   certutil -hashfile game\build\release\contract.wasm SHA256
   certutil -hashfile desk\build\release\contract.wasm SHA256
   ```
   They must print `fa44cfad…26` and `b8f1269f…79` (full values in the table). If not, stop.
3. `npm run bot -- chain-check`: every line ✔. Copy the chain id it prints into `"chainId"` of both
   `game-data/deployment.json` and `desk-data/deployment.json` (commit). Nothing may already be announced.
4. `npm run bot -- status > before-upgrade.txt` and `npm run desk -- status >> before-upgrade.txt`.
5. The owner wallet needs ~85 KOIN of Mana for both uploads.
6. Pick a Tuesday or Wednesday so the uploads land mid-week (safe at any time; this only keeps it simple).

## 1. Announce both (starts the 48 hours)

```
npm run bot -- upgrade schedule            then again with --send
npm run desk -- upgrade schedule           then again with --send
```
Both refuse if the live contract's safety switches are off. The bot emails you about both announcements (expected).
Players see them on the Trust page.

## 2. Wait 48 hours

Don't rebuild in between. `npm run bot -- upgrade status` / `npm run desk -- upgrade status` show "matches".

## 3. Upload

```
npm run bot -- upgrade apply               then again with --send
npm run desk -- upgrade apply              then again with --send
```
Each reads the new code fingerprint back **from the chain**, checks it and the switches, and writes it into its
`deployment.json`. Commit both files. Then clear the notices:
```
npm run bot -- admin cancel_upgrade --as owner --send
npm run desk -- upgrade cancel --send
```

## 4. Verify

1. `npm run bot -- chain-check`: every line ✔, fingerprints `fa44cfad…` and `b8f1269f…`.
2. `npm run bot -- status` and `npm run desk -- status`: compare with `before-upgrade.txt` (same stakes, seed, pots,
   Desk KOIN/VHP apart from new block rewards and swaps).
3. GitHub → Actions → Kpred bot → Run workflow: green.
4. After the first game action, `get_state` shows `reward_rule_week_plus_one` = this week + 2 (the 40/60 split starts
   with next week).

## 5. Set the Desk's daily cap

```
npm run desk -- daily-cap <KOIN> --send
```
Pick roughly what normal trading pays out in a day plus a margin (for example, 25% of the Desk's KOIN float). Lowering
it later is immediate; raising it waits 48 h.

## 6. Then: the wallet changes

Owner, seed owner and Desk owner handovers come **after** both uploads (see `docs/WALLETS.md`). The bot (operator)
key and the treasury can change any time.

## If something goes wrong

There is no instant rollback: going back is another upgrade with the same 48 h notice (schedule the live code's
hash). Players can withdraw at any time. A rollback loses what the old code doesn't know: on the game, a pending owner
transfer becomes acceptable at once (cancel it first), a minimum-stake change and the new reward split are dropped; on
the Desk, the daily cap and any waiting settings or owner change are ignored. Both rollbacks are rehearsed in the
storage tests.

A question still unresolved 6 hours after its window: the bot emails you. If its result can't be trusted in time,
pause deposits (`npm run bot -- pause on --send`) or void it (`npm run bot -- void <#> --send`).

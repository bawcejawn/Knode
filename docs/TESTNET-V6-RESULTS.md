# Vault v6 testnet check: results (29 Oct 2026)

`npm run bot -- testnet-v6` on the Koinos Foundation testnet: a fresh copy of the audited build `eed38f7c…`
at `1MXay5pSvPNzc8sBcZAMWfqaY4T9DkBvLn`, 13 games, 20 test players, 10-minute weeks, measured week 1 (all 13 earning).

## What the calls use (from the chain's receipts; independent of Mana prices)
| Call | Compute (ticks) | Disk (bytes) | Network (bytes) | Testnet Mana |
|---|---|---|---|---|
| A player's deposit that first closes a 13-game week (advance → closeV6) | 4,627,950 | 912 | 415 | 0.347 |
| A plain stake in another game (deposit_to, KOIN) | ~2,900,000 | 178–309 | 414 | 0.19–0.20 |
| Posting 16 result rows | 1,504,102 | 1,752 | 788 | 0.224 |
| Sealing | 688,629 | 9 | 285 | 0.045 |
| Finalizing 16 places | 1,748,184 | 88 | 285 | 0.114 |
| A winner's claim (claim_game) | 2,435,453 | 108 | 311 | 0.157 |
| A full withdrawal (withdraw_from) | 1,720,303 | 158 | 314 | 0.118 |
| Upload of the contract (84 KB) | 676,466 | 86,257 | 124,212 | 7.53 |

Chain limits per transaction: 287,500,000 ticks, 524,288 bytes of disk, 1,048,576 bytes of network. The heaviest call
measured, the 13-game close inside a player's deposit, uses **1.6 %** of the compute limit. Scaled up:
- 50 result rows: about 4.7 M ticks and 5.5 KB of disk at most (1.6 % / 1 %).
- A 500-place finalize page: at most about 55 M ticks (19 %), an upper bound (most of a call's cost isn't per place).

So no Vault call comes near the chain's limits (audit V6-12).

## Key order (audit V2-14)
`list_players` returned all 20 test players, every one with a high byte near the front of its address, **in byte
order**: the real chain orders storage keys bytewise, as the simulator and the tests now assume.

## Mainnet Mana
Mana per call = ticks × compute price + disk bytes × disk price + network bytes × network price, at mainnet's prices
(`chain.get_resource_limits`). Testnet prices on the day: compute 6, disk 7,130, network 1,079 (satoshi per unit).

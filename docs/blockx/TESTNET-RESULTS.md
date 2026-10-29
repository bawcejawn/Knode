# Block X testnet results (Koinos Foundation testnet, 2026-10-28)

Picks contract `12xNetHpajRi8Xrv4ub8MbMWWjC2q7VrX5` (testnet build 39cc5e00…, from audited 700c296a…), games 2 and 92 ON.
The owner then played the testnet page end to end (Play free, picks, changes, results): everything worked.

## Lock (audit P-5), game 92, target 9,609,300, lock at 9,609,200
Read from the chain afterwards:

| Block the pick landed in | Result |
|---|---|
| 9,609,196 (lock − 4) | applied |
| 9,609,197 (lock − 3) | applied; contract stored height 9,609,197 |
| 9,609,200 (the lock) | refused: "PICKS: this round is locked" |

- The contract sees the height of the block a pick lands in (stored = landing block). ✔
- A pick landing at the lock (target − 100) is refused. ✔
- No pick happened to land at 9,609,199 (target − 101), so the exact last-allowed block wasn't seen; it follows from the
  rule (height < lock).
- Tool bugs found and fixed: lock-test didn't find the landing blocks (it waited "byBlock" after they had passed), and
  alternating two producers made some picks "already your pick".

## Mana per pick (audit S3-5), game 92
| Picks in one transaction | Mana | Per pick |
|---|---|---|
| 1 | 0.04774581 | 0.0477 |
| 3 | 0.10505067 | 0.0350 |
| 7 | 0.21966039 | 0.0314 |

Sizing (mainnet costs are expected to be similar): 25 picks a day ≈ 1.2 Mana per player per day; the 150-a-week cap
≈ 7.2 Mana per player per week. A per-pick sponsor limit of 0.1 Mana leaves 2× headroom.

## Page fixes found while testing
- The local server didn't serve the Picks ABI → "Picks open soon" (fixed).
- The testnet wallet asked for a 3-Mana limit per pick; the network holds the limit aside until a pick settles, so the
  second pick failed with "insufficient pending account resources" (limit now 0.3).
- Port 8090 is the owner's personal node; the local server now uses 8350 (or the next free port).

# Swap desk — security review (2026-10-16)

This file is for you and for outside auditors. It lists what could go wrong, what stops it, and which test proves it. All tests run on GitHub on every push ("Desk contract tests").

Latest results: **25/25 tests passed**, **34/34 offline checks passed**. Release build: 29.3 KB, sha256 `ee56217b…`.

## Whose money is at risk, and how it's protected

| # | Threat | What stops it | Proven by test |
|---|---|---|---|
| 1 | Someone swaps another person's VHP. | `swap` requires the VHP owner's own signature. | "nobody can swap someone else's VHP…" |
| 2 | Someone uses an approval a user left open. | Same check: an approval alone is not enough. | "a leftover approval cannot be used…" |
| 3 | The owner raises the fee while a user's swap is in flight. | The user's `min_koin_out` makes the swap fail instead of paying less. | "a fee raised just before a swap lands…" |
| 4 | A swap takes VHP but pays no KOIN, or pays half. | It takes VHP and pays KOIN in one transaction; if either fails, both are undone. | "needs the VHP approval…", "refuses to pay less…" |
| 5 | Rounding leaks value. | The fee rounds up by at most 1 unit, so it is never under 3%. A 1-unit swap is refused, never paid for free. | "200 random swaps…", "tiny amounts…" |
| 6 | Tokens get created or destroyed by accounting bugs. | The only token moves are `transfer`s, and totals are tracked. | "200 random swaps": total KOIN and VHP unchanged across all accounts |
| 7 | Huge numbers overflow. | Fee math uses 128-bit numbers. | "huge amounts never overflow" |
| 8 | The desk pays out more than it can. | Each swap is capped at min(KOIN, Mana), exactly to the last unit. | "pays out at most…", "the exact last KOIN…" |
| 9 | A non-owner changes settings or withdraws. | Every owner action checks the owner's signature. | "every owner action is refused…" |
| 10 | A stolen owner key drains the desk. | Withdrawals go only to the treasury. Changing the treasury takes 48 h, and you empty the desk before then. | "a stolen owner key…" |
| 11 | Someone moves the desk's tokens directly, including with the deploy key. | `authorize` refuses every outside token move and every Mana payment. | "nobody can act as the desk's account…" |
| 12 | Malicious new code is uploaded. | An upload needs the owner's signature, the exact announced code, and the 48 h wait. The new code must keep these protections switched on. | same test (4 checks) |
| 13 | Swapping before setup, or setting up twice. | `not initialised` / `already initialised`. On chain, setup must be signed by the desk's own key. | "before setup…", "initialises once…" |
| 14 | Bad settings break the desk. | Fee max 10%, min swap > 0, max ≥ min, 33-byte producer key, 32-byte upgrade hash. | "refuses bad settings" |
| 15 | Pausing traps funds. | Pause stops swaps only; withdrawals to the treasury still work. | "pausing stops swaps but never stops withdrawals…" |

## Patterns already proven on Koinos mainnet (by the probes and the live game)
- Pulling a user's VHP with approve + call in one transaction.
- A contract sending its own KOIN, where Mana ≥ amount is needed.
- Registering a producer key from a contract.
- A contract whose `authorize` refuses outside calls still producing blocks: the game contract has produced blocks since 2026-10-16.

## What the tests cannot prove (check on mainnet with small amounts)
- How the desk's Mana refills after KOIN arrives from block production. "Available" is always computed from the real numbers, so this affects how fast liquidity grows, not safety.
- The website's transaction in Kondor. Check this with one small swap after going public. `npm run desk -- try-swap` sends the identical transaction from your PC first.

## Known limits, by design
- If people swap faster than the node produces, "available" drops to zero until blocks refill it.
- If the node is offline, there is no refill, but swaps still work up to what is there.
- Users pay their own Mana for a swap.

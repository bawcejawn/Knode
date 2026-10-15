# Idea (shelved): VHP → KOIN swap desk

Status: **parked** until after the soft launch. It would be built as a **separate contract**, completely apart from
the game pool, and linked from the website (for example from a "Swap" slot).

## Why it must be separate from the game pool
The game contract's KOIN isn't spare cash. It is made up of three things:
- the seed's Mana reserve;
- the unpaid creator fee;
- VHP that block production converted into KOIN, which belongs to players' stakes and the seed until it is compounded back.

Paying swaps out of it would mix customers' money with players' money and break the game's accounting
(holdings = what is owed). A separate contract keeps the fees cleanly yours.

## How a swap desk would work
1. You fund the desk contract with KOIN (its liquidity).
2. A user sends VHP and instantly receives KOIN at 1:1 minus a fee: **2% below 10,000, 3% from 10,000 up**.
   The exact boundary is to be decided.
3. The desk now holds VHP. Registered with a block producer, that VHP produces blocks, which turns it back into
   KOIN over time, **plus** block rewards. So the desk refills itself, and the fees and rewards are your income.

## Things to settle before building
- **Liquidity cap:** a swap can't exceed the desk's KOIN. The site would show "available now".
- **Mana:** sending KOIN needs Mana at least equal to the amount, so the desk's Mana caps swap size per few days.
- **Speed of refill:** production converts VHP to KOIN gradually; large swaps could empty the desk for a while.
- **Pricing:** fixed 1:1 minus the fee, or a rate that adjusts with demand.
- **Rules where you live:** charging fees for exchanging tokens may count as a regulated activity. Check before launch.

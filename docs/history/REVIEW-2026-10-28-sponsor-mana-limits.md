# Review 2026-10-28: sponsor v3, 5,000 ceiling and per-action Mana limits (commit 9e5478e)

Independent reviewer agent. Verdict: no High findings; the contract change is sound (a row only lowers the budget;
checkOperation still runs on every operation; the caps still count rc_limit, and real spend never exceeds it; no u64
overflow). The risks were in the Mana adjuster and in keeping the website in step with the chain.

| # | Severity | Finding | Fix |
|---|---|---|---|
| M1 | Medium | Mana prices move with load; 1.5 × a quiet maximum (or a testnet number), floor 0.02, can be too little | 2 × (3 × for typed-in/testnet numbers), floor 0.05 |
| M2 | Medium | Splitting a batch's Mana per operation under-counts a lone action (fixed cost per transaction) | Only single-action transactions are measured |
| M3 | Medium | Reverted transactions were skipped, so one that ran out of Mana never corrected its limit | A run-out (reverted, rc_used ≥ 99% of rc_limit) is counted and at least doubles the limit |
| L1 | Low | The website's copy lags the chain: a site limit above the chain's is refused (guests see "free play used up") | `site-limits --send` first (the lower of old and new per action), then `config --send`, which refuses while the site would ask for more than the new limits |
| L2 | Low | would_pay doesn't know the operations, so it can't check per-action limits | Accepted, documented; the site and the tool keep the website's copy in step |
| L3 | Low | A typo (0.00477) in mana-limit gives a too-low limit; it used the default per-transaction cap | Refuses values under 0.01 without --force, requires --source, reads the per-transaction cap from chain |
| L4 | Low | One heavy action (margin above the per-transaction cap) blocked the whole tool | That action gets no row (keeps the per-transaction cap) and is reported |
| Info | – | Bigint rounding correct; overlapping reports double-count (cosmetic); 2,000 free Mana at 0.05 rows ≈ 40,000 transactions a day; the 16-row loop adds a little compute | Noted |

Tests added for each fix (tests/audit/sponsor.tool.test.ts). Sponsor contract 153/153, tool and website 33/33.

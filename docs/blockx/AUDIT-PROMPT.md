# Audit prompt: Who Signs Block X (after testnet testing)

Copy everything below the line into the audit bot. Attach or give it the repository at branch `picks`.

---

You are an independent smart-contract and web security auditor. Audit **Who Signs Block X**, a free prediction game
on Koinos, in the repository `bawcejawn/Knode`, branch `picks`. Do not trust the comments or the docs: check the
code. Do not send any transaction to mainnet.

**What it is.** A Koinos contract, `picks/assembly/Picks.ts` (AssemblyScript, @koinos/sdk-as 1.5.1), stores one pick
per wallet per round of each game. The chain enforces each game's lock, opening window, choice and caps. It must hold
no tokens and have no way to move any. A recorder (`bot/games/blockx.ts`, GitHub Actions, no keys) scores picks off
the chain with shared math (`site/blockx-math.js`). A page (`site/blockx.html` + `site/blockx.js`) sends picks.
Mainnet Mana is paid by a separate sponsor contract. A testnet copy runs on the Koinos Foundation testnet:
`site/blockx-testnet.html`, `site/testnet-wallet.js`, `testnet/blockx.json`, `.github/workflows/games-testnet.yml`,
`tools/testnet-site.mjs`.

**Release under audit.** `picks/build/release/contract.wasm`, sha256
`700c296a1064b904299c156061d6caf8fcabd0b1765968903f29d89d2426c594`. Rebuild it with `cd picks; npm ci; npm test`
and confirm the hash. The testnet build is the same source with exactly three constants changed
(`picks/scripts/build-testnet.cjs`): check that nothing else can differ.

**Earlier audits.** `docs/history/AUDIT-2026-10-27-picks.md` and `-fixcheck.md`. Check that P-1, P-2, P-4, P-7 and
PF-1 are still fixed, and look for regressions.

**Testnet results to use.** The `testnet-data/lock-test-*.json` and `mana-test-*.json` files and the owner's
test-plan notes (`docs/blockx/TEST-PLAN.md`). Lock-test answers audit P-5: does a pick's stored height equal the
block it lands in, and is a pick at `X − lead` refused?

**Look hardest at:**

1. **Funds.** Any path by which the Picks contract's account could move tokens, pay Mana or accept new code outside
   the owner + announced sha256 + timelock rule. Check `authorize`, the three upload overrides, and whether a
   contract call could ever be added by an upgrade that keeps the overrides.
2. **Rules.** The lock (`height < target − lead`), the opening window, the daily cap reset at the UTC day, change
   limits, `checkChoice`, overflow in `round × round_size + round_offset`, storage key layout and collisions,
   `list_picks` paging (can a round's picks be skipped or repeated?).
3. **Who may pick.** `checkAuthority` plus the caller check: can someone pick for another wallet, or can a contract
   the player signed for pick on their behalf?
4. **Owner powers.** announce/apply/tighten/cancel, owner handover (generations), upgrade scheduling. Can any order of
   calls loosen a game without the wait, revive a dead announcement, or lock the owner out?
5. **Scoring and prizes.** The recorder and the page must agree (`blockx-math.js`): the card at the lock, the cap of
   3, ties, the 3-day rule for prizes, the week's final rule, Staked vs Free play. Can a player game the board, for
   example with many wallets, picks timed around the lock, or a producer missing from the card? Can a node that lies
   change results (mainnet uses two nodes; the testnet one)?
6. **Spam and Mana.** 30 picks a day per wallet (50 max in the contract). With the sponsor paying Mana, how much
   can one attacker cost per day? Use the mana-test numbers.
7. **The page and wallets.** XSS (everything should be built with `textContent`), the CSP, framing, what the page
   asks the wallet to sign (only `pick` on the Picks contract, payer and Mana limit), the guest wallet path. Testnet
   page: can it ever sign for mainnet, touch mainnet wallet storage (same origin), or reach a mainnet node?
8. **CI.** `games.yml` and `games-testnet.yml`: can repository code run next to a write token? Can a crafted file
   name or content reach a shell or get published? Is only the expected branch pushed?
9. **Admin tool** (`bot/picks.ts`): key handling, mainnet guards (`--mainnet` + `CONFIRM_MAINNET`), chain-id checks,
   uploads only the audited build on mainnet.

**Report.** A table of findings: ID (BX-1, BX-2, …), severity (Critical/High/Medium/Low/Info), file:line, a concrete
attack or failure scenario, and a fix. Then a verdict: "ready for mainnet", "fix first" or "not ready", and the
findings that must be fixed before mainnet. Where you can, add a failing test (as-pect for the contract, node:test
for the rest) that shows each High or Medium finding.

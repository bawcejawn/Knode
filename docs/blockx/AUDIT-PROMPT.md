# Audit prompt: Who Signs Block X + Mana sponsor v3 (for Repo Lens or any auditor)

Copy everything below the line into the auditor. Give it the repository `bawcejawn/Knode` at branch `picks`, or the
audit package `blockx-audit-package.zip` (the same files, with this prompt as `00-AUDIT-PROMPT.md`).

---

You are an independent smart-contract and web security auditor. Audit two things that go live together on Koinos
mainnet, in the repository `bawcejawn/Knode`, branch `picks`: **Part A, Who Signs Block X** (a free prediction game
and its Picks contract) and **Part B, the Mana sponsor v3** (the contract that pays players' Mana). Do not trust the comments or the docs: check the
code. Do not send any transaction to mainnet.

## Part A: Who Signs Block X and the Picks contract

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

**Testnet results (2026-10-28, `docs/blockx/TESTNET-RESULTS.md`).** On the Koinos Foundation testnet the contract
stored the height of the block a pick landed in, and a pick landing at `X − lead` was refused ("this round is locked").
A pick costs about 0.05 Mana (0.031 each when 7 share a transaction). The owner played the testnet page end to end
with no problems. Check these conclusions against the code; P-5 asked for exactly this.

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
8. **The testnet-only tools** (`tools/testnet-site.mjs`, `site/testnet-wallet.js`, `site/blockx-testnet.html`):
   the local page server holds a testnet key to fund "Play free" wallets (5 test KOIN, POST /api/fund). Can any
   other site, another device, or a mainnet node make it send, or read `.env.testnet`? Can the testnet page or its
   wallet ever sign for mainnet or touch mainnet wallet storage?
9. **CI.** `games.yml` and `games-testnet.yml`: can repository code run next to a write token? Can a crafted file
   name or content reach a shell or get published? Is only the expected branch pushed?
10. **Admin tool** (`bot/picks.ts`): key handling, mainnet guards (`--mainnet` + `CONFIRM_MAINNET`), chain-id checks,
   uploads only the audited build on mainnet; the upload is signed by the new Picks wallet and paid by a second
   wallet (`PAYER_WIF`, else `OPERATOR_WIF`), so the Picks wallet never holds KOIN it could not move out again.

## Part B: Mana sponsor v3 (`sponsor/`)

**What it is.** A contract uploaded onto the sponsor wallet `1ByDDSBUzy5zkRceELc54Jh8i41yNRoKt8` with only the
transaction-application override on. When a transaction names it as payer, its `authorize` decides whether to pay:
only listed player actions, signed by the player (payee) alone, within per-transaction, per-player daily/weekly,
everyone-daily and free-player-daily caps. Live on mainnet: v2 `fa4659e6…`. Candidate: v3 sha256
`21bec82583e1a7decbb2c70376f4b08e026f617c32bca268ab700f50e9aef2df` (rebuild: `cd sponsor; npm ci; npm test;
npm run check`). Read `sponsor/README.md` and `sponsor/assembly/proto/sponsor.proto`.

**Earlier audits.** `docs/history/AUDIT-2026-10-27-sponsor-v3.md` (S3-1…S3-8) and the v1/v2 audits it cites. Check
the fixes are still in place.

**New since that audit (look hardest here).**
1. `CAP_LIMIT` 5,000 Mana a day (was 1,000); weekly per-player ceiling 7 × that. Any u64 or ordering issue?
2. `config.mana_caps` (up to 16 rows {contract, entry point, max Mana}): a transaction's `rc_limit` must be at most
   the sum of its operations' rows (no row: `max_mana_per_tx`), and at most `max_mana_per_tx`. The caps count
   `rc_limit` (authorize runs before execution) while the chain charges the payer only what is used. Can the budget
   check be bypassed, overflow, or make the sponsor pay for anything it shouldn't? Can a too-low row make players'
   transactions fail, and what is lost then?
3. The Mana adjuster (`bot/mana-limits.ts`, `bot/sponsor.ts` mana-report / mana-limit / config): limits from
   measured `rc_used` of single-action transactions (2 ×, 3 × for a typed-in number, floor 0.05, never below 1.25 ×
   the most used, never lowered, doubled after a run-out; `site-limits` updates the website first). Is it wide enough
   when Mana prices move with load? Can the website's copy of the limits
   (`sponsor.rcLimits` in game-data/desk-data deployment.json, used by `site/wallet.js` `rcFor`) disagree with the
   chain in a way that hurts players (guests have no Mana to fall back on)?
4. The allowlist row for the Picks `pick` (built by `bot/sponsor.ts`): the sponsor and the Picks contract must read
   the same player from the same bytes (`argsPlayer`, `PICKS_ARG_TYPES`).
5. Spam: with free play paid for any wallet (2,000 Mana a day shared by wallets with no VHP and no stake; 50 per
   wallet per day), what can one attacker cost the sponsor per day, and can they lock out real players? Use the
   measured 0.048 Mana per pick.

**Out of scope.** The game vault and the daily-questions game contract (audited separately).

**Report.** A table of findings: ID (BX-1, BX-2, … for Part A; SP-1, SP-2, … for Part B), severity (Critical/High/Medium/Low/Info), file:line, a concrete
attack or failure scenario, and a fix. Then a verdict for each part: "ready for mainnet", "fix first" or "not
ready", and the findings that must be fixed before mainnet. Where you can, add a failing test (as-pect for the contract, node:test
for the rest) that shows each High or Medium finding.

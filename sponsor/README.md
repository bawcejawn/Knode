# Knode Mana sponsor

A small contract that lets one wallet pay the **Mana** for players' Knode transactions, so players don't need KOIN of
their own for Mana. It is a stand-in until the full Mana Station. Ported from the SwarmTales sponsor.

It is uploaded onto a **fresh wallet** (the sponsor address) with **only** the "transaction application" switch on.
From then on, when a transaction names the sponsor as payer, the chain asks this contract, and it says yes only when:

- the sponsor is switched on;
- the transaction is signed by the payee (the player) **and by nobody else**;
- every operation is a player action on the Knode game (`deposit_vhp`, `deposit_koin`, `withdraw`, `answer`,
  `settle`, `claim`, `close_week`, `finalize_week`) or a `swap` on Knode Swap, or a VHP/KOIN `approve` whose spender is
  the game or Knode Swap and whose owner is the payee (owner, operator, seed and upgrade actions are never paid);
- the payee is a **real Knode player**: holds at least `min_vhp` VHP (default 1 VHP) or has a stake (active or
  pending) in the game, so new empty wallets can't use up the budget (audit 2026-10-26, M-1). Free players without VHP
  pay their own Mana. The check reads the VHP token and the game (read-only); a read that fails counts as "no";
- the transaction's Mana limit is within the per-transaction cap, and this player's total today and this week (weeks
  start Monday 00:00 UTC, the same weeks as the game), and everyone's total today, stay within their caps.

A transaction signed by the sponsor wallet's own key is always paid: that is the owner changing settings or moving KOIN
out. Calls and code uploads are **not** overridden, so they stay with the sponsor wallet's key, like any wallet.

The game, Knode Swap and the tokens are settings (set by the sponsor wallet), not built into the code; the entry points
of the player actions are built in (`npm run check` confirms they match the game's and the Desk's ABIs).

## How the website uses it

`game-data/deployment.json` and `desk-data/deployment.json` carry `"payer"`:

- `"self"` (the default): players pay their own Mana, as before.
- `"sponsor"`: for each transaction whose operations the sponsor pays for, the page first asks the sponsor's read-only
  `would_pay` (on/off and caps). On yes it names the sponsor as payer and the player as payee, with the Mana limit in
  `"sponsor": { "rcLimit" }`; on no, or if the sponsor refuses when it is sent, the player's own Mana is used (one more
  confirmation in the wallet).
- Staked players' **answers** keep the existing path (the game contract pays when Kondor's free Mana option is on), so
  they don't use up the sponsor. Burning KOIN into VHP is not a Knode call: players pay their own Mana for it.
- **KOIN Vault** picks its own payer, so KOIN Vault users never use this sponsor.

Switch it from the admin page ("Mana paid by") or with `npm run sponsor -- payer sponsor|self --send`; then commit and
push the two deployment files. Switching the sponsor **off** (`disable`) takes effect on chain at once, whatever the
website says: the page then falls back to the player's own Mana.

## Set it up (PowerShell, in `C:\kprediction`)

1. **Create the sponsor wallet** in Kondor (see `docs/WALLETS.md`). Write its recovery words on paper. Put its private
   key (WIF) in `.env` as a new line `SPONSOR_WIF=...`. It must be a brand-new wallet, not the owner, bot or a contract.
2. **Send it KOIN**: its KOIN is its Mana. Knode keeps at least 5,000 KOIN in it (see sizing below).
3. **Build and check** (once, and again after any change):
   ```
   cd sponsor
   npm ci
   npm test
   npm run check
   cd ..
   certutil -hashfile sponsor\build\release\contract.wasm SHA256
   ```
   The hash must match the one in this README's "Build" line.
4. **Upload**: `npm run sponsor -- upload`, read it, then `npm run sponsor -- upload --send`. It refuses any build
   other than the audited one, and after uploading it stops with an error if the code or the switches on chain are not
   exactly right (pays for transactions ON, call and upload OFF).
5. **Set the caps** (dry run first, then `--send`):
   `npm run sponsor -- config --per-tx 1 --per-player-day 5 --per-player-week 20 --per-day 1000 --min-vhp 1`
6. **Switch it on**: `npm run sponsor -- enable --send`.
7. **Point the website at it**: `npm run sponsor -- payer sponsor --send`, then
   `git add game-data/deployment.json desk-data/deployment.json sponsor-data/deployment.json`,
   `git commit -m "Mana sponsor on"`, `git push`.
8. **Check**: `npm run sponsor -- status`.

To stop it: `npm run sponsor -- disable --send` (instant), and `payer self` for the website. To take the KOIN out, send
it from the sponsor wallet in Kondor, like any wallet.

## Sizing

- Mana amounts: 1 Mana = 1 KOIN's worth (100000000 units). A wallet's Mana is its KOIN balance and refills over about
  5 days.
- The caps count each transaction's **Mana limit**, not what it really used. The site asks for `rcLimit` (default
  1 Mana) per transaction. Knode's own transactions use well under that (announcing an upgrade used 0.31 Mana; the game
  pays up to 2 Mana for a sponsored player transaction).
- Knode's settings: **1** per transaction, **5** per player per day, **20** per player per week, **1,000** for everyone
  per day (a hard cap: 1,000 is also the contract's own ceiling, `CAP_LIMIT`), and players must hold **1 VHP** or have
  a stake.
- Knode's sponsor wallet `1ByDDSBUzy5zkRceELc54Jh8i41yNRoKt8` keeps at least **5,000 KOIN**: it refills about a fifth of
  its balance a day, so about 1,000 Mana a day, matching the cap. Keep some headroom above that for transactions waiting
  in a block.
- If use gets near 1,000 a day: add KOIN first. Going above 1,000 a day needs a new contract version (raise
  `CAP_LIMIT`, re-audit, re-upload by the sponsor wallet).

## Limits to know

- The caps count each transaction's Mana limit when the chain accepts it as payer. Those counts are **not** rolled back
  if the transaction's operations later revert (the auditor checked the Koinos chain source), and a transaction the
  sponsor refuses is never included and costs nothing. So the caps are exact upper bounds.
- Near 00:00 UTC a transaction can be accepted with today's counts and then dropped from the block (mempool expiry);
  the page may already say "Sent". The player simply tries again.
- A spammer now needs real VHP (or a stake) in every wallet they use. With per-player caps of 5 a day, using up
  1,000 a day takes 200 wallets each holding the VHP minimum. If that ever happens, raise `--min-vhp`. When the daily
  budget is used up, everyone pays their own Mana until the next UTC day. Nothing else is at risk: the sponsor never signs or moves
  anything for players, and it pays only for Knode player actions.
- `settle`, `close_week` and `finalize_week` can be called by anyone for anyone: a wallet can spend its own sponsored
  caps on them, never more.

## Build

Release build sha256: `ec398f546ceec2bdd81274e2e7d0b511223b6e2d6d84660a8d06b9ad1b719b22` (26,469 bytes).
Tests: 79 contract tests (including the auditor's attack and fuzz tests, `Sponsor.audit-attacks.spec.ts`) (`npm test`, real signatures from `scripts/make-test-fixtures.cjs`: test-only keys from public
labels, never fund them), plus `tests/audit/sponsor.wallet.test.mjs` (the website) and `tests/audit/sponsor.tool.test.ts`.

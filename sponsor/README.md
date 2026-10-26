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
2. **Send it KOIN**: its KOIN is its Mana. Start with about 300 KOIN (see sizing below).
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
4. **Upload**: `npm run sponsor -- upload`, read it, then `npm run sponsor -- upload --send`.
5. **Set the caps** (dry run first, then `--send`):
   `npm run sponsor -- config --per-tx 1 --per-player-day 5 --per-player-week 20 --per-day 100`
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
- Suggested start: **1** per transaction, **5** per player per day, **20** per player per week, **50** for everyone per
  day. That is about 5 sponsored actions per player per day and 20 per week, and 50 a day across all players.
- To sustain 50 Mana a day the wallet needs about **250 KOIN** (it refills a fifth of its balance per day), plus room
  for transactions waiting in a block: start with about 300.
- Raise the caps as play grows, and top the wallet up.
- Knode's sponsor wallet (`1ByDDSBUzy5zkRceELc54Jh8i41yNRoKt8`) holds 1,000 KOIN: at most 1,000 Mana at once, refilling
  about 200 a day. A daily cap of 200 never runs it dry; a cap of 1,000 can be spent in one day but then needs about
  5 days to refill (or about 5,000 KOIN in the wallet to refill 1,000 every day).

## Limits to know

- The caps count each transaction's Mana limit when it is applied; a transaction that later reverts may have its count
  rolled back with it, so the caps bound spending per day and week but are not exact.
- Anyone can make new wallets, so a determined spammer can use up everyone's daily budget (`--per-day`). After that
  everyone pays their own Mana until the next UTC day. Nothing else is at risk: the sponsor never signs or moves
  anything for players, and it pays only for Knode player actions.
- `settle`, `close_week` and `finalize_week` can be called by anyone for anyone: a wallet can spend its own sponsored
  caps on them, never more.

## Build

Release build sha256: `d6ee9beaf3d56a79f370b84e1c0ac7bc67a4df986562ecc94cc473c47e5b8c68` (24,556 bytes).
Tests: 54 contract tests (`npm test`, real signatures from `scripts/make-test-fixtures.cjs`: test-only keys from public
labels, never fund them), plus `tests/audit/sponsor.wallet.test.mjs` (the website) and `tests/audit/sponsor.tool.test.ts`.

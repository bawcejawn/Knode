# Knode Mana sponsor

A small contract that lets one wallet pay the **Mana** for players' Knode transactions, so players don't need KOIN of
their own for Mana. It is a stand-in until the full Mana Station. Ported from the SwarmTales sponsor.

It is uploaded onto a **fresh wallet** (the sponsor address) with **only** the "transaction application" switch on.
From then on, when a transaction names the sponsor as payer, the chain asks this contract, and it says yes only when:

- the sponsor is switched on;
- the transaction is signed by the payee (the player) **and by nobody else**;
- every operation is a player action on the Knode game (`deposit_vhp`, `deposit_koin`, `withdraw`, `answer`,
  `settle`, `claim`, `close_week`, `finalize_week`), a `swap` on Knode Swap, a `pick` on the Producer Race for the
  payee's own wallet (v2, once the `race` setting is set), or a VHP/KOIN `approve` whose spender is the game or Knode
  Swap and whose owner is the payee (owner, operator, seed and upgrade actions are never paid);
- **free play is free for everyone** (owner's decisions 2026-10-26 and 2026-10-27: free play drives chain activity and
  traffic): a transaction made only of game `answer` calls and Producer Race `pick` calls is paid for any wallet, even
  an empty one (a guest). Free play by wallets that hold no VHP and have no stake also counts against a separate daily
  total for everyone, `max_mana_free_day` (default 2,000 of the 5,000), so it can never use up what real players need
  (staked players always have 3,000 or more);
- **everything else** (approve, deposit, withdraw, settle, claim, close/finalize, swap) is paid only for a **real
  Knode player**: holds at least `min_vhp` VHP (default 1 VHP) or has a stake (active or pending) in the game
  (audit 2026-10-26, M-1). The check reads the VHP token and the game (read-only). For those actions a read that fails
  counts as "no"; for an answer it only means the wallet counts as free (against the free total), never a refusal;
- the transaction's Mana limit is within the per-transaction cap, and this player's total today and this week (weeks
  start Monday 00:00 UTC, the same weeks as the game), and everyone's total today, stay within their caps. These are
  checked before the player check, so a transaction they refuse costs no reads.

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
- Every player transaction, staked players' **answers** included, asks the sponsor first (owner, 2026-10-28). The game
  contract pays for nobody (`max_sponsor_rc` 0); when the sponsor says no, the page names the player's own wallet as
  payer. Burning KOIN into VHP is not a Knode call: players pay their own Mana for it.
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
   `npm run sponsor -- config --per-tx 1 --per-player-day 50 --per-player-week 300 --per-day 5000 --free-per-day 2000 --min-vhp 1`
   (once `race-data/deployment.json` exists, this also sets the race contract, so picks are sponsored)
   (`--free-per-day 0` turns free answers off; pass it each time you change the caps, because an unset value means 500)
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
- The caps count each transaction's **Mana limit**, not what it really used (the sponsor approves a transaction before
  it runs). With v3's per-action limits the site asks for each action's own limit (a Block X pick about 0.08), so the
  counts stay close to the Mana really spent. Actions without a limit yet ask for the old 1 Mana (answers) or 3 (others).
- Knode's settings (owner's decisions 2026-10-28): **1** per transaction, **50** per player per day and **300** per
  player per week, **5,000** for everyone per day (v3's ceiling, `CAP_LIMIT`; v2's was 1,000), of which at most
  **2,000** for free play by wallets with no VHP and no stake, so staked players always have **3,000** or more. Every
  other action needs **1 VHP** or a stake.
- Knode's sponsor wallet `1ByDDSBUzy5zkRceELc54Jh8i41yNRoKt8` keeps at least **25,000 KOIN**: it refills about a fifth
  of its balance a day, so about 5,000 Mana a day, matching the cap. Keep some headroom above that for transactions
  waiting in a block.
- If use gets near 5,000 a day: add KOIN first. Going above 5,000 a day needs a new contract version (raise
  `CAP_LIMIT`, re-audit, re-upload by the sponsor wallet).

## Limits to know

- The caps count each transaction's Mana limit when the chain accepts it as payer. Those counts are **not** rolled back
  if the transaction's operations later revert (the auditor checked the Koinos chain source), and a transaction the
  sponsor refuses is never included and costs nothing. So the caps are exact upper bounds.
- Near 00:00 UTC a transaction can be accepted with today's counts and then dropped from the block (mempool expiry);
  the page may already say "Sent". The player simply tries again.
- Free play: anyone can make new wallets, so empty wallets can use up the free total (2,000 a day: at 0.08 a pick that
  is about 25,000 picks, at 50 Mana per wallet at least 40 wallets). Then free wallets pay their own Mana until the
  next UTC day, while players with VHP or a stake keep the other 3,000 (they still count against everyone's 5,000). If
  spam appears, lower `--free-per-day`.
- Everything else needs real VHP (or a stake) in every wallet: using up the rest takes many wallets each holding the
  VHP minimum. If that ever happens, raise `--min-vhp`. When the daily budget is used up, everyone pays their own Mana
  until the next UTC day. Nothing else is at risk: the sponsor never signs or moves
  anything for players, and it pays only for Knode player actions.
- `settle`, `close_week` and `finalize_week` can be called by anyone for anyone: a wallet can spend its own sponsored
  caps on them, never more.

## Upgrading to v2 (Producer Race picks)

v2 adds one optional setting, `race` (the race picks contract), and pays for a `pick` on it exactly like a game answer
(only the payee's own pick; any other call on the race contract is refused). With `race` unset, v2 behaves exactly as
v1. The existing caps, counts and settings stay as they are on chain (the upgrade keeps the storage).

1. Build and test (step 3 above). The hash must match the "Build" line below.
2. `npm run sponsor -- upload`, then `--send` (the sponsor wallet's key re-uploads its own code; nothing else changes).
3. After the race contract is uploaded (race/README.md):
   `npm run sponsor -- config --per-player-day 25 --per-player-week 150 --send`, then `npm run sponsor -- payer sponsor --send`,
   and commit and push the deployment files.

## Upgrading to v3 (KnodeGames allowlist)

v3 adds three things. With no `allowed` rows it behaves as v2, except for the two fixes below.

- **Allowlist** (`allowed`, up to 8 rows): {contract, entry point, free play, argument shape}. A listed call is paid only
  when its arguments have exactly the listed shape: field 1 is the player (25 bytes) and must be the payee, it comes
  first and once, and every other field has its listed wire type, in field-number order (race audit S-1, for any
  contract: the sponsor and the target contract can't read different players). Free-play rows count like answers. The
  KnodeGames Picks contract's `pick` is added automatically once `picks-data/deployment.json` exists.
- **Free players' prize claims**: a game `claim` for the payee's own wallet (canonical arguments) is free play, so a
  free player (a guest too) can collect a free-game prize.
- **Fixcheck L-3**: a stake counts as a real player from `min_vhp` up (active and pending together), like held VHP.

Allowlisted calls and free claims are refused above 400 argument bytes (Picks audit P-3; the largest Picks pick is 317).
Audit 2026-10-27 (`docs/history/AUDIT-2026-10-27-sponsor-v3.md`): "ready for testnet; fix S3-1 and S3-2 before mainnet",
no Critical, High or Medium. Fixed: S3-1 (a 16 KB buffer, so 10 picks fit in one transaction), S3-2 (allowlisted
arguments must have no nested messages: documented, and `npm run check` confirms it for the Picks row), S3-7 (the Picks
ABI checks are required). Accepted by the owner: S3-4 (guests can win Block X prizes; the free daily total bounds the
cost, to be monitored).

Re-check of those fixes: "ready for testnet, and from the code, ready for mainnet"; its Info finding S3-8 is fixed too
(a transaction with more than 4 signatures is refused without recovering the rest).

Earlier v3 candidate (before the 5,000 ceiling and per-action limits): `b192e6f4…` (31,829 bytes), superseded.
The upload tool still pins v2 on mainnet until v3 has passed the audit, the fix-check and a testnet trial.

When v3 is live (audit S3-5, S3-6): measure `rc_used` for 1, 3 and 7 picks and set the site's `rcLimit` to about twice
one pick; change the guest prize message in `site/wallet.js` (the sponsor now pays a guest's own claim) and ask a
claim's Mana with the answers' 1 Mana limit, not `rcLimitOther`.

## Sponsor v3 additions (owner, 2026-10-28): 5,000 a day and per-action Mana limits

- **Ceiling 5,000 Mana a day** for everyone (was 1,000; weekly per-player ceiling 35,000). The sponsor wallet holds at
  least 25,000 KOIN, whose Mana refills in about 5 days, so 5,000 a day is always covered. Caps: 5,000 for everyone,
  of which free players (no VHP, no stake; guests too) share at most 2,000; 50 per player per day, 300 per week.
- **Per-action Mana limits** (`config.mana_caps`, up to 16 rows of contract, entry point, most Mana). The chain only
  charges the Mana a transaction really uses, but the sponsor approves a transaction before it runs, so its caps
  count the transaction's Mana *limit*. With one 1-Mana limit for everything, a 0.05-Mana pick used up 1 Mana of the
  player's day and of everyone's day. Now a transaction's limit must be at most the sum of its operations' rows (an
  operation with no row counts as the per-transaction cap, as before), and the website asks for exactly that sum.
- **The Mana adjuster** sets the rows from what each action really used on chain, with a margin, and never so tight
  that a transaction could run out:
  ```
  npm run sponsor -- mana-report            reads the last day of sponsored transactions; shows each action's use and a safe limit
  npm run sponsor -- mana-report --save     writes sponsor-data/mana-limits.json (public)
  npm run sponsor -- mana-limit picks:pick 0.0477 --source "testnet 2026-10-28" --save    one action measured elsewhere
  npm run sponsor -- config                 dry run: shows the caps and every limit; then --send (it also updates the website's copy)
  ```
  Rule: limit = 1.5 × the most that action has ever used (at least 0.02, at most the per-transaction cap), rounded up
  to 0.01; the tool refuses any limit below 1.25 × the most used, and a new report never lowers a limit below an
  older maximum. Run it weekly, or after a contract upgrade.

Release candidate sha256 (v3 with the above): `21bec82583e1a7decbb2c70376f4b08e026f617c32bca268ab700f50e9aef2df`
(33,210 bytes). Not yet audited: the upload tool allows it on the testnet only.

## Build

Release build sha256 (v2, race picks; audited 2026-10-27): `fa4659e65c6156da3dde34238e0545a489a8b7f00cdf51df9bf79517a0019f33` (28,916 bytes).
v1 (live until the upgrade): `8cfeff6209b8d5cbc3b3e5fa30751e995767f5904b77693ed8a41e323ea2a8ed` (27,473 bytes).
Tests: 127 contract tests (including the auditors' attack and fuzz tests: `Sponsor.audit-attacks.spec.ts`, and for v2 `Sponsor.audit-v2.spec.ts` and `Sponsor.fixcheck.spec.ts`) (`npm test`, real signatures from `scripts/make-test-fixtures.cjs`: test-only keys from public
labels, never fund them), plus `tests/audit/sponsor.wallet.test.mjs` (the website) and `tests/audit/sponsor.tool.test.ts`.

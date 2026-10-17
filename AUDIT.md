# Knode — information for auditors

Thank you for reviewing Knode. This page gives you the scope, the addresses on Koinos mainnet, and how to rebuild the
exact code that is deployed.

## Scope

| Component | Code | Holds funds? | Security notes |
|---|---|---|---|
| Game contract | `game/assembly/Kpred.ts`, `game/assembly/Tokens.ts`, `game/assembly/proto/kpred.proto` | Yes: players' VHP stakes, the seed, unpaid fees | [`game/SECURITY.md`](game/SECURITY.md), [`docs/security-audit.md`](docs/security-audit.md) |
| Swap desk contract | `desk/assembly/Desk.ts`, `desk/assembly/Tokens.ts`, `desk/assembly/proto/desk.proto` | Yes: the desk's own KOIN and VHP | [`desk/SECURITY.md`](desk/SECURITY.md) |
| Website | `site/` (static, GitHub Pages) | No. Every action is signed in the visitor's own wallet (Kondor). | — |
| Bot | `bot/` (GitHub Actions, hourly) | No. Its key can post questions and results only. | — |

Priority: the two contracts. They are written in AssemblyScript with the official Koinos SDK
(`@koinos/sdk-as` 1.5.1, `@koinos/sdk-as-cli` 1.0.2, versions pinned in each `package.json` and lockfile).

## Mainnet addresses

| What | Address |
|---|---|
| Game contract | `1Mpmf2ERhjYpX7CCiM11WERuM4j17uT1sr` |
| Swap desk contract | `1FKTpXBhhHEbu5vVchM8UsVbAvPArJsRmR` |
| Owner of both (admin) and desk treasury | `1635QUrBNDp7WqmFkRvrkGwjJXTtFvH717` |
| Game operator (bot) | `1JSTwoKYNAUq2gmmTg4r1kdYCERR2kUrZ` |
| KOIN / VHP / Proof-of-Burn | `19GYjDBVXU7keLbYvMLazsGQn3GTWHjHkK` / `12Y5vW6gk8GceH53YfRkRre2Rrcsgw7Naq` / `159myq5YUhhoVWu3wsHKHiJYKPKGUrGiyv` |

Live state (holdings vs liabilities, announced upgrades): https://bawcejawn.github.io/Knode/site/trust.html

## Rebuild and test (Node.js 22)

```
cd game && npm ci && npm test && npm run check      # 47 tests, offline checks; build in game/build/release/contract.wasm
cd desk && npm ci && npm test && npm run check      # 25 tests, offline checks; build in desk/build/release/contract.wasm
sha256sum game/build/release/contract.wasm desk/build/release/contract.wasm
```

Compare the fingerprints with `wasmSha256` in `game-data/deployment.json` and `desk-data/deployment.json`, and with the
"Release build sha256" note on each GitHub Actions run. A pending upgrade's fingerprint is readable on-chain from
`get_state().upgrade.hash`.

Tests run against `BUILD_FOR_TESTING=1`, where `Tokens.ts` uses an in-contract ledger instead of the KOIN/VHP system
contracts; the offline check refuses a release build that contains it. Token-call patterns used in production (approve +
transfer in one transaction, contract-owned KOIN transfers capped by Mana, PoB burn and key registration) were proven on
mainnet with a probe contract (`probes/`).

## What we'd most like checked

1. Can any path move players' stakes, prizes or the seed to anyone other than their owner?
2. Is the game's gain measurement (holdings − liabilities at each close) and the payout split always solvent?
3. Are the `authorize` rules (no outside token moves; sponsorship only for valid answer/settle/claim; upgrades only with
   the announced code after the timelock, protections kept on) complete?
4. Swap desk: can a swap ever pay more KOIN than `vhp_amount − fee`, or take VHP without paying `min_koin_out`?

Contact: open an issue on https://github.com/bawcejawn/Knode (for anything sensitive, ask there for a private channel first).

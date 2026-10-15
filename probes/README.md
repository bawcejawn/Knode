# Probes — can Koinos do everything the game needs?

Before writing the real prediction contract, this folder puts a small **probe contract** on the
Koinos testnet (Harbinger) and tries every on-chain move the game depends on. Each probe prints
**PASS** or **FAIL** and the Mana it used. Testnet only: tKOIN has no value, so nothing here can lose real money.

| Probe | What it proves | Expected |
|---|---|---|
| P1 | The contract can read its own address, owner, the KOIN/VHP/PoB contracts, its balances, its Mana and the block height | succeed |
| P1b | The owner can only be set once | refused |
| P0 | The owner can burn tKOIN into VHP (so it has VHP to deposit) | succeed |
| P2 | A user approves the contract and deposits VHP in **one** transaction | succeed |
| P2a / P2b | A deposit without approval, or by someone else using your approval | refused |
| P3 | A user deposits KOIN and the contract burns it 1:1 into its own VHP | succeed |
| P4 | The user withdraws their VHP | succeed |
| P4a–c | Withdrawing someone else's credit, with no credit, or more than credited | refused |
| P5 | Compound: the contract burns its spare KOIN into VHP, keeping a reserve, never more than its Mana | succeed |
| P5b | Running compound again right away burns nothing (safe to run on a timer) | succeed |
| P6 | The owner registers a block-producer key for the contract (the node can produce for the pool) | succeed |
| P6a | Anyone else registering a key | refused |
| P7 | A brand-new account with **zero** KOIN sends a ping, and the contract pays the Mana | succeed |
| P7a–c | The contract paying for anything other than a single ping | refused |
| P9a–c | The **deploy key** trying to move or approve the contract's VHP/KOIN | refused |
| P10a / P10b | Re-uploading the code without the owner's signature | refused |
| P10 | The owner upgrades the code, and the stored data survives | succeed |
| P11 | Anyone but the owner sweeping the contract's funds | refused |
| P8 | Mana cost of storage writes and reads (for sizing the real contract) | succeed |

A "refused" probe **passes** when the chain refuses it. That is the point: those are attacks.

## What you need

- Node.js 20+ (you already have it from Step 0).
- About **20 tKOIN** on the testnet. Get it in the Koinos Discord, channel **#faucet**: type `!faucet <address>`.

## Steps

Open a terminal in this `probes` folder.

**1. Install the tools (once).**

```
npm install -g yarn
npm install
```

**2. Build the probe contract.** This turns `assembly/Kprobe.ts` into `build/release/contract.wasm`.

```
npm run build
```

If this prints errors, copy the whole output into the chat. It has never been compiled before,
so a first-round fix or two is normal.

**3. Make the test keys.**

```
npm run probes -- keys
```

This creates three brand-new **testnet-only** accounts and saves their keys in a file called `.env`
in this folder. It prints three addresses:

- **owner**: the account that runs the tests. Send tKOIN here, from the faucet or from your
  testnet wallet (for example 1AA2uf6xvqo7NSTR9sBBzqWUeeEjDj33Sb).
- **contract**: where the probe contract will live.
- **helper**: a second "user" for the attack tests. Setup funds it.

> **Keys rule:** `.env` never leaves your computer. Never paste it, or any private key or seed
> phrase, into a chat, a screenshot or GitHub. Addresses are fine to share. `.gitignore` already
> keeps `.env` out of GitHub.

**4. Check the balance.**

```
npm run probes -- status
```

Wait until the owner shows about 20 KOIN.

**5. Deploy and fund.**

```
npm run probes -- setup
```

This deploys the contract, sets the owner, sends 10 tKOIN to the contract and 2 to the helper.
It is safe to run again; it skips steps that are already done.

**6. Run the probes.**

```
npm run probes -- run
```

It takes a few minutes (each step waits for a block). Paste the output into the chat. The full
results are also saved in `probes-output/results.json`.

**7. Get the funds back.**

```
npm run probes -- sweep
```

Sends all KOIN and VHP left in the contract, plus the helper's KOIN, back to the owner. Moving KOIN needs
Mana equal to the amount, so if some KOIN is left, run it again a day or two later.

## Testnet or mainnet?

The probes default to the testnet. They can run on mainnet with real KOIN (Koinos has no fees, only
Mana that regenerates), but only like this:

- Use a **brand-new wallet** made by `npm run probes -- keys`, funded with about 20 KOIN. Never your main wallet.
- Add `RPC=https://api.koinos.io` and `CONFIRM_MAINNET=yes` to `.env` (the script refuses mainnet otherwise).
- What is at stake: the ~10 KOIN sent to the contract and ~2 to the helper come back with `sweep`. The 3 KOIN
  the owner burns (P0) and the 1 KOIN deposited (P3) become VHP: still yours, but VHP can't be turned back
  into KOIN. If a bug stopped `sweep` from working, the owner can upgrade the contract code (P10) to fix it.
- Everything on mainnet is public and permanent, including the deployed probe contract.

## Settings (optional, in `.env`)

| Name | Default | Meaning |
|---|---|---|
| `RPC` | https://harbinger-api.koinos.io | Testnet node |
| `FUND_CONTRACT` | 10 | tKOIN sent to the contract |
| `FUND_HELPER` | 2 | tKOIN sent to the helper |
| `OWNER_BURN` | 3 | tKOIN the owner burns into VHP for the deposit tests |
| `DEPOSIT` | 1 | Size of each test deposit and withdrawal |
| `RESERVE` | 5 | KOIN the contract keeps during compound |
| `RC_LIMIT` | 2 | Max Mana per probe transaction |
| `KOIN_ADDRESS`, `VHP_ADDRESS` | detected | Only needed if detection from recent blocks fails |

## How the security works (in plain words)

On Koinos, a contract's address is just an account. Normally whoever holds that account's key
can do anything with it. The probe contract is deployed with three switches turned on, and they hand
every decision to the contract's own `authorize` function:

- **Moving its tokens from outside** → always "no". Only the contract's own code can move its
  VHP/KOIN, and only by its rules (withdraw only your own credit). So even the deploy key is useless
  for stealing (P9).
- **Paying for someone's transaction** → "yes" only for a single `ping`. That is how players will
  answer questions without holding any KOIN (P7).
- **Replacing the code** → "yes" only with the owner's signature (P10). On mainnet, the owner will be
  a multisig with a timelock.

## Files

| File | What it is |
|---|---|
| `assembly/Kprobe.ts` | The probe contract |
| `assembly/proto/kprobe.proto` | Its arguments and results |
| `scripts/probes.ts` | The test runner (keys, status, setup, run) |
| `scripts/abi.ts` | Tells koilib how to talk to the contract, KOIN/VHP and PoB |
| `koinos/`, `google/` | Standard definitions the build needs |

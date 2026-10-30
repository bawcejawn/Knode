# Knode Swap Desk — VHP → KOIN

People with VHP can swap it for KOIN right away on `swap.html`. They get **1:1 minus 3%**, paid in the same transaction.

## How the money moves

```
            ┌──────────── swap: VHP in, KOIN out (−3%) ────────────┐
  user ─────┤                                                       ├───── user
            └───────────────────────────────────────────────────────┘
                                   │ VHP (fee included) stays in the desk
                                   ▼
                    desk VHP ──► produces blocks on the desk's node
                                   │ every block turns some VHP back into KOIN, plus the block reward
                                   ▼
                    desk KOIN ──► available for the next swap
```

- **The desk is a separate contract.** It is completely apart from the game pool, so customers' money never mixes with players' money.
- **Available KOIN** is the smaller of two numbers: the desk's KOIN and the desk's Mana. Sending KOIN on Koinos needs Mana at least equal to the amount. The website always shows the largest swap possible right now.
- **The pool grows on its own.** It grows with every block the node produces, and the 3% fee stays in the node as extra VHP.
- **Your income** is the 3% plus block rewards. Both pile up inside the desk. You take them out with `withdraw`.

## Safety rules (enforced by the contract)

| Who | Can | Can't |
|---|---|---|
| A user | Swap their own VHP. Gets at least the KOIN shown, or nothing moves. | Use someone else's VHP, even with that person's open approval. |
| Owner (admin key) | Change the fee (max 10%), set limits, pause, register the node key, withdraw. | Send funds anywhere except the **treasury** address. |
| Owner, with 48 h notice | Change the treasury. Replace the code. | Do either instantly. |
| Anyone else, including the deploy key | Nothing. | Move the desk's tokens or replace its code. |

**If the admin key is ever stolen:** the thief can only send funds to *your* treasury. Changing the treasury or the code takes 48 hours. In that time you move everything to the treasury yourself (`withdraw koin` and `withdraw vhp`).

The desk never holds anyone else's money. Every swap starts and finishes in one transaction.

## Launch, step by step (on your PC, in `C:\kprediction`)

**1. Build and test the contract**
```
cd desk
npm install
npm test          ← every test must pass
npm run check     ← every line must say PASS
cd ..
```
This is the same as for the game: `npm install` downloads the build tools once, `npm test` builds and runs the tests on a simulated chain, and `npm run check` checks the real build is safe to deploy. GitHub also runs these on every push ("Desk contract tests" on the Actions tab).

**2. Create the desk's own key**
```
npm run desk -- keys
```
This adds `DESK_CONTRACT_WIF` to `.env` and prints the desk address. Back the key up offline. **Send nothing to this address yet.**

**3. Set up the desk's node** (a third node, next to the game node and your personal node)
```
powershell -ExecutionPolicy Bypass -File node\setup-node.ps1 -Producer <desk address> -Root C:\kpred-desk-node -Project kpred-desk-node -PortOffset 20
```
- This uses its own folder, Docker project and ports (RPC 8100, P2P 8908).
- The node needs its own copy of the chain, so check you have the disk space.
- Each node can produce for only one address, which is why the desk needs its own node.

**4. Deploy**
```
npm run desk -- deploy           ← dry run: read what it will do
npm run desk -- deploy --send
```
The bot wallet pays the Mana for the upload, about 20 KOIN of Mana. The desk starts with these settings:
- fee 3%
- smallest swap 1 VHP
- no fixed largest swap
- 48-hour timelock
- treasury = your admin address, or `DESK_TREASURY` in `.env`

**5. Small trial first (the page stays unpublished)**
```
npm run desk -- fund koin 20 --send       ← a little liquidity
npm run desk -- try-swap 1 --send         ← swap 1 VHP from your test player wallet, exactly like the website would
npm run desk -- status                    ← 1 swap, 0.97 KOIN out, 1 VHP in
npm run desk -- withdraw koin 5 --send    ← lands in the treasury
```

**6. Start producing**
```
npm run desk -- node-key
npm run desk -- register-key node --send
```
Then watch the desk produce its first blocks on https://koinosscan.com.

**7. Go public — only when you're satisfied.** Merge the `swap-desk` branch into `main` and commit `desk-data/deployment.json`. GitHub Pages then publishes `swap.html`. Fund it properly at that point (`fund koin …`).

## Day-to-day commands

| Command | What it does |
|---|---|
| `npm run desk -- status` | KOIN available, VHP producing, swaps and fees earned |
| `npm run desk -- withdraw koin 50 --send` | Takes profit to the treasury |
| `npm run desk -- fee 3 --send` | Sets the fee in percent (0–10) |
| `npm run desk -- limits 1 5000 --send` | Smallest and largest single swap in VHP (largest 0 = no cap) |
| `npm run desk -- pause on --send` / `pause off --send` | Stops or restarts swaps |
| `npm run desk -- treasury schedule <address> --send`, then `treasury apply --send` 48 h later | Changes the treasury |
| `npm run desk -- upgrade schedule --send`, then `upgrade apply --send` 48 h later | New code; all data is kept |

Every command is a dry run unless you add `--send`. On mainnet, `.env` also needs `CONFIRM_MAINNET=yes`.

## Things to keep in mind

- **Demand can outrun production.** If people swap faster than the node produces, "available" drops to zero until blocks refill it. You can add KOIN with `fund koin`.
- **The node must stay online.** If it stops, the desk's VHP stops producing and the pool stops refilling. Swaps still work up to what is already there.
- **Users pay their own Mana for a swap**, a fraction of a KOIN. Someone with VHP but no KOIN can use Kondor's free Mana option. Paying that Mana for them is a possible later upgrade.
- **Rules where you live:** charging a fee to exchange tokens may be a regulated activity. Check before promoting it widely.
- **Scaling later, without a rewrite:** the fee, limits and treasury are settings, and the code can be upgraded behind the 48 h notice. Adding outside liquidity providers or a second desk would be such an upgrade.

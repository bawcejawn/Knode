# Mana sponsor v3: the testnet trial (PowerShell)

The trial runs sponsor v3 on the **Koinos Foundation testnet** with test KOIN only, before the audit's fix-check is
back. Nothing here touches mainnet: every command has `--testnet`, and the tool refuses if the node isn't the testnet.

What it proves: a brand-new Test wallet with **no test KOIN at all** can make Block X picks, because the test sponsor
pays; the caps, the hourly free pool and the alerts behave as expected; `mana-report` measures what a pick really costs.

There is no Knode game or Knode Swap on the testnet, so only the Picks contract's picks are tried there.

Two ways to run it. The **admin page** does the same as the PowerShell blocks, with buttons.

## The admin page (easiest)

```powershell
cd C:\kprediction
git checkout picks
git pull
npm ci
npm run admin
```

It prints a link with a one-time key (`http://127.0.0.1:8787/#…`). Open it in your browser. It only works on
this PC. Go to the **Testnet trial** section and use the numbered steps 1 to 5 in order. Each one shows a **dry run**
first. Press **Send** only when the dry run looks right. Stop the page with Ctrl+C in PowerShell.

## The same in PowerShell

### 1. A testnet sponsor wallet

```powershell
cd C:\kprediction
git checkout picks
git pull
npm ci
npm run sponsor -- keys --testnet
```

This adds `SPONSOR_WIF` to `.env.testnet` (it is never printed) and shows the new address. In Telegram, send
`/faucet <that address>` to @KoinosTestnetFaucetBot. Do it a few times, a few hours apart: its test KOIN is its Mana,
and the upload needs about 17.

### 2. Build sponsor v3 in a clean copy

The same as mainnet step 3 (`MAINNET-LAUNCH.md`), sponsor only:

```powershell
cd C:\
git clone --branch picks https://github.com/bawcejawn/Knode.git C:\knode-build
cd C:\knode-build\sponsor
npm ci --ignore-scripts
npm test
npm run check
certutil -hashfile build\release\contract.wasm SHA256
```

If `C:\knode-build` already exists, use instead:

```powershell
cd C:\knode-build
git checkout picks
git pull
cd C:\knode-build\sponsor
npm ci --ignore-scripts
npm test
npm run check
certutil -hashfile build\release\contract.wasm SHA256
```

The hash must be `b21251d42beb1c4dd104194c6833d64abe0887c43d9631406765c8c7027aef96`. Then:

```powershell
cd C:\kprediction
copy C:\knode-build\sponsor\build\release\contract.wasm C:\kprediction\sponsor\build\release\contract.wasm
certutil -hashfile sponsor\build\release\contract.wasm SHA256
```

### 3. Upload, limits, switch on

```powershell
cd C:\kprediction
npm run sponsor -- upload --testnet
npm run sponsor -- upload --testnet --send
npm run sponsor -- config --testnet
npm run sponsor -- config --testnet --send
npm run sponsor -- enable --testnet --send
npm run sponsor -- status --testnet
```

`upload` writes the sponsor's address into `testnet/blockx.json` (`"sponsor"`); that's how the testnet page knows
to ask it. `config` uses the owner's caps (1 / 25 / 150 / 5000 / 2000, min VHP 1), the same as mainnet. `status` must
show **v3 code**, **ON**, the caps and the Picks `pick` row.

Tell Claude "testnet sponsor up" (or commit `testnet/blockx.json` yourself) so the address is saved on the branch.

### 4. Play from a wallet with no Mana

```powershell
cd C:\kprediction
npm run testnet-site -- --record
```

Open `http://127.0.0.1:8350/blockx-testnet.html` in a **private window** (so it's a brand-new Test wallet). Press
**Play free**: the page says the wallet has no test KOIN on purpose. Make a few picks. Each one should go through
with the wallet still at 0 test KOIN. If the sponsor refuses (for example the free pool for this hour is used up),
the page says why.

Try these on purpose:

- **Many picks quickly** from one wallet: once its free share for the hour is used, the page shows "today's
  free-player Mana is used up (more is released on the hour)".
- **Switch the sponsor off** (`npm run sponsor -- disable --testnet --send`): picks from the empty wallet now fail
  with "no test Mana of its own". Switch it back on with `enable --testnet --send`.

### 5. What it cost

In a second PowerShell window (the test site keeps running in the first):

```powershell
cd C:\kprediction
npm run sponsor -- mana-report --testnet
npm run sponsor -- watch --testnet
npm run sponsor -- status --testnet
```

`mana-report` reads every sponsored pick from the chain and shows its real Mana. `watch` shows the 80% warnings if
the free pool or the total is nearly used. Send Claude the output of all three; Claude records them in
`docs/blockx/TESTNET-RESULTS.md`.

## Stopping

```powershell
cd C:\kprediction
npm run sponsor -- disable --testnet --send
```

Then Ctrl+C in the test-site window. Test KOIN is worthless, so nothing needs to be returned.

## If something goes wrong

- "is not the Koinos Foundation testnet": the node in `testnet/sponsor.json` changed; tell Claude.
- "is not an allowed sponsor build": the `.wasm` copied in step 2 isn't the v3 build. Redo step 2.
- "Send at least … more KOIN": ask the faucet bot again later.

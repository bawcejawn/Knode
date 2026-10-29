# Moving Knode to a new computer

The game itself does not live on your PC: the contract is on Koinos, the website is on GitHub Pages and the bot runs
on GitHub Actions. Your PC holds three things: the **keys** (`.env`), the **game node** (produces blocks for the pool)
and your **personal node**. Moving means rebuilding those three on the new PC, then switching over.

Players are never affected: their stakes sit in the contract, not on any computer. If the game node is off for a few
hours, the pool only produces fewer blocks that week.

---

## A. What to carry over (everything else comes from GitHub or a download)

| File on the OLD PC | Why | Needed? |
|---|---|---|
| `C:\kprediction\.env` | All the project's private keys (owner, bot, contract, player) | **Yes, essential** |
| `C:\kprediction\.env.testnet` | Testnet keys (worthless test coins) | Optional; can be recreated |
| `C:\kprediction\probes\.env` | The old probe wallets (same keys as the bot and player in `.env`) | Optional; copy it if it exists |

**Not needed:** any node key (both nodes on the new PC get brand-new keys), the game node's key (the new game node gets a new one and we register it with one command), chain
data (a fresh snapshot is downloaded), `node_modules` (reinstalled), `game-data` (in GitHub), testnet data.
Your Kondor and MetaMask wallets come back from **your own seed phrase backups** on the new PC.

**How to carry the files:** a USB stick only. Never email, cloud drive, OneDrive, chat or GitHub. Delete them from the
stick when done.

---

## B. Set up the new PC (any time; the old PC keeps running meanwhile)

1. Install, once: [Git for Windows](https://git-scm.com/download/win), [Node.js LTS](https://nodejs.org),
   [Docker Desktop](https://www.docker.com/products/docker-desktop/) (in its settings turn on "Start Docker Desktop when
   you sign in"). Restart the PC after Docker.
2. Power: Settings → System → Power → "When plugged in, put my device to sleep after" → **Never**.
3. Disk: two mainnet nodes need about **300 GB free** on an SSD during setup (about 150 GB afterwards).
4. The project, in PowerShell:

```
git clone https://github.com/bawcejawn/knode.git C:\kprediction
cd C:\kprediction
npm ci --ignore-scripts
cd game
npm ci --ignore-scripts
npm test                  # expect: 47 / 47 pass
cd ..
```

5. Copy `.env` (and `.env.testnet`, `probes\.env` if you brought them) from the USB stick into `C:\kprediction\`
   and check:

```
npm run bot -- status     # should show the game, the pool and the upgrade, like on the old PC
```

---

## C. The game node (new key, no copying)

```
cd C:\kprediction
powershell -ExecutionPolicy Bypass -File node\setup-node.ps1 -Producer 1Mpmf2ERhjYpX7CCiM11WERuM4j17uT1sr -KeepArchive
```

`1Mpmf…T1sr` is the game contract's address. `-KeepArchive` keeps the 60 GB snapshot download so the personal node
can reuse it. Then wait until it's caught up:

```
npm run bot -- node-status      # repeat until it says the node is caught up
```

The new node runs with its own new key, which isn't registered yet, so it produces nothing and can't clash with the
old PC. **The switch** is one command, when the new node is caught up:

```
npm run bot -- register-key node            # dry run: check it shows the NEW node's public key
npm run bot -- register-key node --send
```

About a minute later the pool produces from the new PC and the old game node's key stops counting. Then, on the
OLD PC: `cd C:\kpred-node\koinos ; docker compose down`.

---

## D. The personal node (brand new: new address, new key)

1. In Kondor, add a **new account** (it comes from the same seed phrase, so no new backup is needed). This is the
   personal node's address. Send it a few KOIN from your old personal address for Mana.
2. Move the snapshot file from `C:\kpred-node\` into a new `C:\koinos-personal\` folder (so it isn't downloaded
   again), then:

```
cd C:\kprediction
powershell -ExecutionPolicy Bypass -File node\setup-node.ps1 -Producer <new personal address> -Root C:\koinos-personal -Project koinos-personal -PortOffset 10
npm run bot -- node-status personal      # repeat until caught up
npm run bot -- node-key personal         # its PUBLIC key
```

   It has its own Docker project and ports (RPC 8090, P2P 8898), so it never collides with the game node (8080, 8888)
   or the testnet node (8081, 8889). Delete the snapshot file afterwards to free 60 GB.
3. Register that public key for the new address at **https://knodegames.com/producer.html**:
   connect Kondor with the new account, paste the public key, Register, confirm in Kondor.
4. Move your VHP from the old personal address to the new one (a normal VHP transfer in Kondor). Send a small test
   amount first. The new node starts producing as soon as the VHP arrives.
5. On the OLD PC, stop the old personal node (`docker compose down` in its `koinos` folder).

## E. Finish

- After a few days of blocks from the new PC, delete `.env` files and node folders from the old PC (and empty the
  Recycle Bin). Until then, leave the old nodes **off**.
- Nothing changes on GitHub: the bot's `OPERATOR_WIF` secret stays as it is.
- Testnet (optional, later): `powershell -ExecutionPolicy Bypass -File node\setup-testnet.ps1`

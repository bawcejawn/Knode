# Test fixtures

`kpred-live-test-build.wasm` is the **test build** (simulated token ledger, `BUILD_FOR_TESTING=1`) of the game contract
exactly as it runs on mainnet today: source at commit `1c25791`, whose release build has the live sha256
`917708a7c567d9642a7a2f121c34fbc70200909787208705fc3aa5a2b1e6433a` (game-data/deployment.json).

- sha256 of the fixture: `cce79208d9ba41c369cccb4361c60835033c3891721591bf840ed385871396f3`
- made with: `git checkout 1c25791 -- game/assembly && cd game && npm run build:sim && cp build/sim/contract.wasm test-fixtures/kpred-live-test-build.wasm`

`scripts/storage-compat.test.ts` lets this code write a realistic game history, then swaps in the new code on the same
storage (as an upgrade does) and checks that every stored value reads back unchanged. Never deploy this file: it is a
test build.

`kpred-v5-test-build.wasm` is the **test build** of game v5: the source on `main` at commit `43151ea`, whose release build
has the scheduled v5 sha256 `c17066ae988d204fd43d43f662ad87fcdc38170419943c20b5164a5bd34dd784` (checked when the fixture was
made). `scripts/storage-compat-v6.test.ts` uses it for the v5 → v6 (KnodeGames vault) upgrade test.

- sha256 of the fixture: `4196491d71d54740eb2351016ea8ab572acab8bf972a67d7b44404c6f1c9a145`
- made with: `git worktree add ../v5 43151ea && cd ../v5/game && npm ci && npm run build:sim && cp build/sim/contract.wasm <repo>/game/test-fixtures/kpred-v5-test-build.wasm`

# Test fixtures

`kpred-live-test-build.wasm` is the **test build** (simulated token ledger, `BUILD_FOR_TESTING=1`) of the game contract
exactly as it runs on mainnet today: source at commit `1c25791`, whose release build has the live sha256
`917708a7c567d9642a7a2f121c34fbc70200909787208705fc3aa5a2b1e6433a` (game-data/deployment.json).

- sha256 of the fixture: `cce79208d9ba41c369cccb4361c60835033c3891721591bf840ed385871396f3`
- made with: `git checkout 1c25791 -- game/assembly && cd game && npm run build:sim && cp build/sim/contract.wasm test-fixtures/kpred-live-test-build.wasm`

`scripts/storage-compat.test.ts` lets this code write a realistic game history, then swaps in the new code on the same
storage (as an upgrade does) and checks that every stored value reads back unchanged. Never deploy this file: it is a
test build.

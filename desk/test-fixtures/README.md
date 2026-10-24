# Test fixtures

`desk-v1-test-build.wasm` is the **test build** (simulated token ledger, `BUILD_FOR_TESTING=1`) of the Knode Swap Desk
exactly as it runs on mainnet today: its release build from the same source has the live sha256
`05039d743d383538d0078a89e3bfde56e052c0eb478cf14dad63afd366b761e4` (desk-data/deployment.json).

- sha256 of the fixture: `643e9c37a253d91940423b19e03566011aa78fdf410aef51daf7a5f4e72c560d`
- made with: the desk/assembly of the commit before "desk v2", `npx koinos-sdk-as-cli build-all release 1 desk.proto --generate_authorize`

`scripts/storage-compat.test.ts` lets this code write a realistic history, swaps in the new code through the live code's
own `authorize(contract_upload)`, and checks every stored value reads back unchanged. Never deploy this file.

// Which build this is. The normal Vault build has SAFE_MODE = false. `npm run build:safe` compiles the same code with
// SAFE_MODE = true into build/safe/contract.wasm: the emergency, withdrawals-only build (docs/UPGRADE-V6.md,
// "Emergency: the withdrawals-only build"). Never edit this file by hand; the build script switches it and back.
export const SAFE_MODE: bool = false;

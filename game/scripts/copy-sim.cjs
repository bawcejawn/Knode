// Keeps a copy of the TEST build (simulated token ledger inside the contract) for the bot's rehearsal.
// Never deploy this file: deploy only build/release/contract.wasm after `npm run build` and `npm run check`.
const fs = require("fs");
fs.mkdirSync("build/sim", { recursive: true });
fs.copyFileSync("build/release/contract.wasm", "build/sim/contract.wasm");
console.log("build/sim/contract.wasm: test build for the rehearsal (never deploy it)");

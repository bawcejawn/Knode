// The contract builder writes into these folders but does not create them.
const fs = require("fs");
for (const d of ["abi", "build/release", "build/debug"]) fs.mkdirSync(d, { recursive: true });

// Pinned copies of the helper packages protobufjs would otherwise fetch unpinned at build time (see the script).
require("../../tools/pbjs-helpers/install.cjs");

// protoc 21.12, checked against its sha256, so the build never downloads the latest protoc unchecked (audit BX-6).
require("../../tools/protoc-pin.cjs").main().catch((e) => { console.error(e.message || e); process.exit(1); });

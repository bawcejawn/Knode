// The contract builder writes into these folders but does not create them.
const fs = require("fs");
for (const d of ["abi", "build/release", "build/debug"]) fs.mkdirSync(d, { recursive: true });

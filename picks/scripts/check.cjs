// Static checks for the Picks contract (npm run check, after npm run build). It must hold no tokens and never move
// any: its code makes no call to another contract at all, and no entry point is a token action.
const fs = require("fs");
const path = require("path");

const fail = [];
const src = fs.readFileSync(path.join(__dirname, "../assembly/Picks.ts"), "utf8");
// Strip comments so the rule text in them doesn't count.
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

// 1. No outgoing contract calls of any kind (token transfers, approvals, burns all go through System.call).
for (const bad of ["System.call(", "System.callContract", "Token", "transfer", "approve", "burn", "System.callUserContract"]) {
  if (code.includes(bad)) fail.push(`Picks.ts uses "${bad}"`);
}
// 2. authorize never says yes to contract_call or transaction_application.
const auth = code.match(/authorize\(args[\s\S]*?\n  }\n/);
if (!auth) fail.push("authorize() not found");
else {
  const body = auth[0];
  if (!/contract_upload\) return new authority\.authorize_result\(this\.upgradeOk\(\)\)/.test(body)) fail.push("authorize: the upload branch changed");
  if (!/return new authority\.authorize_result\(false\);\s*\n  }\n$/.test(body)) fail.push("authorize: everything else must be refused");
  if (/transaction_application|contract_call\b/.test(body.replace(/\/\/.*$/gm, ""))) fail.push("authorize: must not special-case contract_call or transaction_application");
}
// 3. The ABI: no token-like entry points.
const abiFile = path.join(__dirname, "../abi/picks.koilib.json");
if (!fs.existsSync(abiFile)) fail.push("abi/picks.koilib.json missing (run npm run build)");
else {
  const abi = JSON.parse(fs.readFileSync(abiFile, "utf8"));
  for (const name of Object.keys(abi.methods)) {
    if (/transfer|approve|burn|mint|balance|withdraw/i.test(name)) fail.push(`ABI has a token-like method: ${name}`);
  }
  const want = ["pick", "get_pick", "list_picks", "get_usage", "get_config", "get_game", "list_games", "announce_game", "apply_game",
    "tighten_game", "cancel_game_change", "propose_owner", "accept_owner", "schedule_upgrade", "authorize"];
  const have = Object.keys(abi.methods).sort();
  if (JSON.stringify(have) !== JSON.stringify([...want].sort())) fail.push(`ABI methods changed: ${have.join(", ")}`);
  if (abi.methods.pick && abi.methods.pick.entry_point !== 0x8ce33c6c) fail.push("pick entry point changed");
}

if (fail.length) { console.error("✗ picks check failed:\n  " + fail.join("\n  ")); process.exit(1); }
console.log("✔ picks check: no outgoing calls, authorize refuses calls and Mana, ABI has no token methods (15 entry points)");

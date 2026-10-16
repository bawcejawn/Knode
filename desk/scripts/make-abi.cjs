// Turns the compiler-generated ABI (abi/desk-abi.json) into the format koilib and wallets use
// (abi/desk.koilib.json): snake_case field names, entry_point / argument / return / read_only.
const fs = require("fs");
const gen = JSON.parse(fs.readFileSync("abi/desk-abi.json", "utf8"));
const snake = (s) => s.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase());
function fix(node) {
  if (Array.isArray(node)) return node.map(fix);
  if (!node || typeof node !== "object") return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) out[k] = fix(v);
  if (node.fields) {
    out.fields = {};
    for (const [name, f] of Object.entries(node.fields)) out.fields[snake(name)] = fix(f);
  }
  return out;
}
const abi = { methods: {}, koilib_types: fix(gen.types) };
for (const [name, m] of Object.entries(gen.methods)) {
  abi.methods[name] = { entry_point: m.entryPoint, argument: m.input, return: m.output, read_only: !!m.readOnly, description: m.description };
}
fs.writeFileSync("abi/desk.koilib.json", JSON.stringify(abi, null, 2));
console.log(`abi/desk.koilib.json: ${Object.keys(abi.methods).length} methods`);

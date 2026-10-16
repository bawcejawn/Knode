/**
 * Offline safety check for the swap desk contract — run after `npm run build`, before anything touches the chain.
 * No network, no keys.
 */
import fs from "node:fs";
import { Signer, Contract, Provider, Serializer } from "koilib";

let failures = 0;
const ok = (cond: boolean, what: string) => { console.log(`${cond ? "PASS" : "FAIL"}  ${what}`); if (!cond) failures++; };

const WASM = "build/release/contract.wasm", WAT = "build/release/contract.wat", ABI = "abi/desk.koilib.json";
ok(fs.existsSync(WASM), `${WASM} exists`);
const size = fs.existsSync(WASM) ? fs.statSync(WASM).size : 0;
ok(size > 5_000 && size < 120_000, `contract size ${(size / 1024).toFixed(1)} KB`);
const wat = fs.existsSync(WAT) ? fs.readFileSync(WAT, "utf8") : "";
ok(/\(export "_start"/.test(wat) && !/\(start /.test(wat), "exports _start (Koinos VM entry)");
ok(!/^\s+memory\.(copy|fill)\s*$/m.test(wat), "no bulk-memory instructions");
ok(!/\b(i32|i64)\.extend(8|16|32)_s\b/.test(wat), "no sign-extension instructions");
// Strings live in the binary as UTF-16, so search the bytes for the test ledger's marker.
const marker = Buffer.from("TEST LEDGER", "utf16le");
const bin = fs.existsSync(WASM) ? fs.readFileSync(WASM) : Buffer.alloc(0);
ok(bin.length > 0 && bin.indexOf(marker) === -1, "production build (the test ledger is NOT included)");

ok(fs.existsSync(ABI), `${ABI} exists`);
const abi = fs.existsSync(ABI) ? JSON.parse(fs.readFileSync(ABI, "utf8")) : { methods: {} };
const expected = ["get_state", "quote", "get_recent", "init", "swap", "withdraw_koin", "withdraw_vhp", "set_fee", "set_limits",
  "set_paused", "register_key", "schedule_treasury", "apply_treasury", "cancel_treasury", "schedule_upgrade", "cancel_upgrade"];
for (const m of expected) ok(!!abi.methods[m], `ABI has ${m}`);
// The website (site/swap.js) carries its own copy of these entry points: they must match the built contract.
const SITE: Record<string, number> = { get_state: 0x3d02a349, quote: 0x6327245c, get_recent: 0x3cc6b02a, swap: 0xda47c2f4 };
for (const [m, ep] of Object.entries(SITE)) ok(abi.methods[m]?.entry_point === ep, `website entry point for ${m} matches`);
for (const m of ["get_state", "quote", "get_recent"]) ok(abi.methods[m]?.read_only === true, `${m} is read-only`);

const s = Signer.fromSeed("desk-offline-check");
const k = new Contract({ id: s.getAddress(), abi, provider: new Provider(["http://127.0.0.1:1"]), signer: s });
const ser = new Serializer(abi.koilib_types);
const round = async (fn: string, args: any) => {
  const { operation } = await (k.functions as any)[fn](args, { onlyOperation: true });
  const back: any = await ser.deserialize(operation.call_contract.args, abi.methods[fn].argument);
  ok(Object.keys(args).every((key) => String(back[key]) === String(args[key])), `encode ${fn}`);
};
const A = s.getAddress();
await round("swap", { from: A, vhp_amount: "150000001", min_koin_out: "145500000" });
await round("withdraw_koin", { amount: "100000000" });
await round("set_fee", { fee_bps: 300 });
await round("set_limits", { min_swap: "100000000", max_swap: "0" });

console.log(failures ? `\n${failures} check(s) FAILED — do not deploy.` : "\nAll offline checks passed.");
process.exitCode = failures ? 1 : 0;

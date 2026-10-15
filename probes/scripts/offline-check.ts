/**
 * Offline safety check — run after `npm run build`, before anything touches the chain.
 * No network, no keys: it makes throwaway keys in memory and checks that
 *   1. the built contract exists and is a sensible size,
 *   2. every entry point in scripts/abi.ts matches the ABI the compiler generated,
 *   3. every operation the probes send encodes and decodes back to the same values,
 *   4. a transaction can carry two signatures (needed for deploy and the security tests).
 *
 *   npm run check
 */
import fs from "node:fs";
import { Signer, Contract, Transaction, Provider, utils, Serializer } from "koilib";
import { kprobeAbi, tokenAbi, pobAbi } from "./abi";

let failures = 0;
const ok = (cond: boolean, what: string) => { console.log(`${cond ? "PASS" : "FAIL"}  ${what}`); if (!cond) failures++; };

const WASM = "build/release/contract.wasm";
ok(fs.existsSync(WASM), `${WASM} exists`);
const wasm = fs.existsSync(WASM) ? new Uint8Array(fs.readFileSync(WASM)) : new Uint8Array();
ok(wasm.length > 10_000 && wasm.length < 200_000, `contract size ${(wasm.length / 1024).toFixed(1)} KB`);
// Koinos runs contracts in a WebAssembly VM without the newer "bulk memory" and "sign extension"
// instructions, and starts them through an exported "_start" function (same settings as the KOIN contract).
const WAT = "build/release/contract.wat";
const wat = fs.existsSync(WAT) ? fs.readFileSync(WAT, "utf8") : "";
ok(wat.length > 0, `${WAT} exists`);
ok(/\(export "_start"/.test(wat) && !/\(start /.test(wat), "contract exports _start (no automatic start section)");
ok(!/^\s+memory\.(copy|fill)\s*$/m.test(wat), "no bulk-memory instructions");
ok(!/\b(i32|i64)\.extend(8|16|32)_s\b/.test(wat), "no sign-extension instructions");

const abiFile = fs.existsSync("abi") ? fs.readdirSync("abi").find((f) => f.endsWith(".abi")) : undefined;
ok(!!abiFile, "compiler-generated ABI found in abi/");
if (abiFile) {
  const gen = JSON.parse(fs.readFileSync(`abi/${abiFile}`, "utf8"));
  for (const [name, m] of Object.entries<any>(gen.methods)) {
    const mine: any = (kprobeAbi.methods as any)[name];
    const genRo = Boolean(m["read-only"] ?? m.read_only);
    ok(!!mine && mine.entry_point === Number(m["entry-point"] ?? m.entry_point) && Boolean(mine.read_only) === genRo, `entry point ${name}`);
  }
}

const a = Signer.fromSeed("offline-check-a"), b = Signer.fromSeed("offline-check-b");
ok(Signer.fromWif(a.getPrivateKey("wif")).getAddress() === a.getAddress(), "private key export/import round trip");
const provider = new Provider(["http://127.0.0.1:1"]); // never contacted
const k = new Contract({ id: a.getAddress(), abi: kprobeAbi as any, provider, signer: a, bytecode: wasm });
const tok = new Contract({ id: b.getAddress(), abi: tokenAbi as any, provider });
const pob = new Contract({ id: b.getAddress(), abi: pobAbi as any, provider });

const roundTrip = async (c: Contract, fn: string, args: any) => {
  const { operation } = await (c.functions as any)[fn](args, { onlyOperation: true });
  const back = await new Serializer((c.abi as any).koilib_types).deserialize(operation.call_contract.args, (c.abi as any).methods[fn].argument);
  const same = Object.keys(args).every((key) => String((back as any)[key]) === String(args[key]));
  ok(same, `encode ${fn}`);
};
const A = a.getAddress(), B = b.getAddress();
const pk: any = (a as any).publicKey;
const keyB64 = utils.encodeBase64url(typeof pk === "string" ? utils.toUint8Array(pk) : pk);
await roundTrip(k, "init", { owner: B });
await roundTrip(k, "deposit_vhp", { from: B, amount: "100000000" });
await roundTrip(k, "deposit_koin", { from: B, amount: "100000000" });
await roundTrip(k, "withdraw_vhp", { to: B, amount: "100000000" });
await roundTrip(k, "compound", { keep_reserve: "300000000" });
await roundTrip(k, "register_key", { public_key: keyB64 });
await roundTrip(k, "ping", { note: "hi" });
await roundTrip(k, "stress", { writes: 20, bins: 3 });
await roundTrip(tok, "approve", { owner: B, spender: A, value: "5" });
await roundTrip(tok, "transfer", { from: B, to: A, value: "5" });
await roundTrip(pob, "burn", { token_amount: "200000000", burn_address: B, vhp_address: B });

const { operation } = await k.deploy({ authorizesCallContract: true, authorizesTransactionApplication: true, authorizesUploadContract: true, onlyOperation: true } as any);
const u: any = operation.upload_contract;
ok(u.contract_id === A && u.authorizes_call_contract && u.authorizes_transaction_application && u.authorizes_upload_contract, "upload operation carries all three authorize switches");

(provider as any).getNonce = async () => 0; // offline stand-in
const tx = new Transaction({ signer: a, provider, options: { payer: B, payee: A, rcLimit: "100000000", chainId: utils.encodeBase64url(new Uint8Array([0x12, 0x20, ...new Array(32).fill(7)])) } as any });
await tx.pushOperation(operation);
await tx.prepare();
let t: any = tx.transaction;
t = await a.signTransaction(t);
t = await b.signTransaction(t);
ok(t.signatures.length === 2 && t.header.payer === B && t.header.payee === A, "two-signature transaction with separate payer and payee");

console.log(failures ? `\n${failures} check(s) FAILED — do not run setup yet.` : "\nAll offline checks passed. Safe to continue.");
process.exitCode = failures ? 1 : 0;

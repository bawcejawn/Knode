/**
 * Offline safety check for the game contract — run after `npm run build`, before anything touches the chain.
 * No network, no keys.
 */
import fs from "node:fs";
import { Signer, Contract, Provider, Serializer } from "koilib";

let failures = 0;
const ok = (cond: boolean, what: string) => { console.log(`${cond ? "PASS" : "FAIL"}  ${what}`); if (!cond) failures++; };

const WASM = "build/release/contract.wasm", WAT = "build/release/contract.wat", ABI = "abi/kpred.koilib.json";
ok(fs.existsSync(WASM), `${WASM} exists`);
const size = fs.existsSync(WASM) ? fs.statSync(WASM).size : 0;
ok(size > 10_000 && size < 120_000, `contract size ${(size / 1024).toFixed(1)} KB`);
const wat = fs.existsSync(WAT) ? fs.readFileSync(WAT, "utf8") : "";
ok(/\(export "_start"/.test(wat) && !/\(start /.test(wat), "exports _start (Koinos VM entry)");
ok(!/^\s+memory\.(copy|fill)\s*$/m.test(wat), "no bulk-memory instructions");
ok(!/\b(i32|i64)\.extend(8|16|32)_s\b/.test(wat), "no sign-extension instructions");
// Strings live in the binary as UTF-16, so search the bytes for the test ledger's marker.
const marker = Buffer.from("TEST LEDGER", "utf16le");
const bin = fs.existsSync(WASM) ? fs.readFileSync(WASM) : Buffer.alloc(0);
ok(bin.length > 0 && bin.indexOf(marker) === -1, "production build (the test ledger is NOT included)");
ok(/SAFE_MODE: bool = false;/.test(fs.readFileSync("assembly/Mode.ts", "utf8")), "the normal build, not the withdrawals-only one (assembly/Mode.ts)");
{
  const SAFE = "build/safe/contract.wasm";
  const same = fs.existsSync(SAFE) && bin.length > 0 && Buffer.compare(fs.readFileSync(SAFE), bin) === 0;
  ok(!same, "build/release is not the withdrawals-only build (build/safe)");
}

ok(fs.existsSync(ABI), `${ABI} exists`);
const abi = fs.existsSync(ABI) ? JSON.parse(fs.readFileSync(ABI, "utf8")) : { methods: {} };
const expected = ["get_state", "get_player", "get_question", "get_week", "list_players", "init", "deposit_vhp", "deposit_koin", "withdraw", "answer",
  "settle", "claim", "compound", "close_week", "finalize_week", "post_question", "resolve_question", "correct_question", "set_operator",
  "set_paused", "propose_owner", "accept_owner", "register_key", "schedule_upgrade", "claim_creator_fee", "claim_owner_share",
  "seed_deposit_vhp", "seed_deposit_koin", "request_seed_withdrawal", "execute_seed_withdrawal", "cancel_upgrade", "set_sponsor_limit", "set_min_stake"];
// v6, the KnodeGames Vault (audit V6-13)
expected.push("deposit_to", "withdraw_from", "move_stake", "claim_game", "post_results", "post_prize_winners", "seal_results",
  "correct_result", "void_game_week", "finalize_game_week", "propose_game", "apply_game", "deactivate_game", "claim_fee_vhp",
  "get_game", "list_games", "get_game_player");
for (const m of expected) ok(!!abi.methods[m], `ABI has ${m}`);
// The entry points the sponsor pays for (claude/handoff-sponsor-vault-calls.md) must not move.
ok(abi.methods.deposit_to?.entry_point === 0x7bb5c436 && abi.methods.withdraw_from?.entry_point === 0x5b0aaef8
  && abi.methods.move_stake?.entry_point === 0x7c268e69 && abi.methods.claim_game?.entry_point === 0x4107e3ab
  && abi.methods.finalize_game_week?.entry_point === 0xec300c11, "the vault entry points match the sponsor hand-off");
ok(abi.methods.answer?.entry_point === 0x0db52f40 && abi.methods.settle?.entry_point === 0x6868e83d && abi.methods.claim?.entry_point === 0xdd1b3c31,
  "sponsored entry points match the ones hard-coded in the contract");

const s = Signer.fromSeed("kpred-offline-check");
const k = new Contract({ id: s.getAddress(), abi, provider: new Provider(["http://127.0.0.1:1"]), signer: s });
const ser = new Serializer(abi.koilib_types);
const round = async (fn: string, args: any) => {
  const { operation } = await (k.functions as any)[fn](args, { onlyOperation: true });
  const back: any = await ser.deserialize(operation.call_contract.args, abi.methods[fn].argument);
  ok(Object.keys(args).every((key) => String(back[key]) === String(args[key])), `encode ${fn}`);
};
const A = s.getAddress();
await round("answer", { player: A, question_id: 7, option: 2 });
await round("deposit_vhp", { from: A, amount: "100000000" });
await round("withdraw", { to: A, amount: "100000000" });
await round("settle", { player: A, week: "3" });
await round("claim", { player: A, week: "3" });
await round("deposit_to", { from: A, game: 2, amount: "100000000", koin: true });
await round("withdraw_from", { to: A, game: 2, amount: "100000000" });
await round("move_stake", { player: A, from_game: 1, to_game: 2, amount: "100000000" });
await round("claim_game", { player: A, game: 2, week: "3" });
await round("post_question", { k: 4, lock_time: "1000", window_start: "1001", window_end: "2000", params_hash: "0x" + "ab".repeat(32) });
await round("resolve_question", { id: 7, outcome: 1, data_hash: "0x" + "cd".repeat(32) });

console.log(failures ? `\n${failures} check(s) FAILED — do not deploy.` : "\nAll offline checks passed.");
process.exitCode = failures ? 1 : 0;

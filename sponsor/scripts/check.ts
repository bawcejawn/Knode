/**
 * Offline safety check for the mana sponsor contract: run after `npm run build`, before anything touches the chain.
 * No network, no keys.
 */
import fs from "node:fs";
import { Signer, Contract, Provider, Serializer } from "koilib";

let failures = 0;
const ok = (cond: boolean, what: string) => { console.log(`${cond ? "PASS" : "FAIL"}  ${what}`); if (!cond) failures++; };

const WASM = "build/release/contract.wasm", WAT = "build/release/contract.wat", ABI = "abi/sponsor.koilib.json";
ok(fs.existsSync(WASM), `${WASM} exists`);
const size = fs.existsSync(WASM) ? fs.statSync(WASM).size : 0;
ok(size > 5_000 && size < 80_000, `contract size ${(size / 1024).toFixed(1)} KB`);
const wat = fs.existsSync(WAT) ? fs.readFileSync(WAT, "utf8") : "";
ok(/\(export "_start"/.test(wat) && !/\(start /.test(wat), "exports _start (Koinos VM entry)");
ok(!/^\s+memory\.(copy|fill)\s*$/m.test(wat), "no bulk-memory instructions");
ok(!/\b(i32|i64)\.extend(8|16|32)_s\b/.test(wat), "no sign-extension instructions");

ok(fs.existsSync(ABI), `${ABI} exists`);
const abi = fs.existsSync(ABI) ? JSON.parse(fs.readFileSync(ABI, "utf8")) : { methods: {} };
for (const m of ["authorize", "get_config", "get_usage", "get_total_usage", "would_pay", "set_config"]) ok(!!abi.methods[m], `ABI has ${m}`);
for (const m of ["get_config", "get_usage", "get_total_usage", "would_pay"]) ok(abi.methods[m]?.read_only === true, `${m} is read-only`);
// The website (site/wallet.js) and the tools (bot/sponsor.ts) carry these entry points: they must match the built contract.
const SITE: Record<string, number> = { would_pay: 0xda1fd8f5, get_config: 0xbc4fcdd4 };
for (const [m, ep] of Object.entries(SITE)) ok(abi.methods[m]?.entry_point === ep, `website entry point for ${m} matches`);
const site = fs.existsSync("../site/wallet.js") ? fs.readFileSync("../site/wallet.js", "utf8") : "";
ok(/0xda1fd8f5/.test(site), "site/wallet.js asks would_pay at 0xda1fd8f5");

// The player actions the contract pays for are the game's and the Desk's entry points by name.
const game = JSON.parse(fs.readFileSync("../game/abi/kpred.koilib.json", "utf8"));
const desk = JSON.parse(fs.readFileSync("../desk/abi/desk.koilib.json", "utf8"));
const raceAbi = JSON.parse(fs.readFileSync("../race/abi/race.koilib.json", "utf8"));
const src = fs.readFileSync("assembly/Sponsor.ts", "utf8");
const pinned: Record<string, [any, string]> = {
  GAME_DEPOSIT_VHP: [game, "deposit_vhp"], GAME_DEPOSIT_KOIN: [game, "deposit_koin"], GAME_WITHDRAW: [game, "withdraw"],
  GAME_ANSWER: [game, "answer"], GAME_SETTLE: [game, "settle"], GAME_CLAIM: [game, "claim"],
  GAME_CLOSE_WEEK: [game, "close_week"], GAME_FINALIZE_WEEK: [game, "finalize_week"], DESK_SWAP: [desk, "swap"],
  RACE_PICK: [raceAbi, "pick"],
};
for (const [k, [a, name]] of Object.entries(pinned)) {
  const m = src.match(new RegExp(`${k}: u32 = (0x[0-9a-f]+)`));
  ok(!!m && Number(m[1]) === a.methods[name]?.entry_point, `${k} = ${name} (${a.methods[name]?.entry_point?.toString(16)})`);
}

// Audit S-1: the sponsor reads a pick's arguments exactly as the race contract does (same fields, numbers and types).
const fieldsOf = (a: any, pkg: string, msg: string) => JSON.stringify(a.koilib_types?.nested?.[pkg]?.nested?.[msg]?.fields ?? null);
ok(fieldsOf(abi, "sponsor", "race_pick_args") === fieldsOf(raceAbi, "race", "pick_arguments") && fieldsOf(abi, "sponsor", "race_pick_args") !== "null",
  "race_pick_args = the race contract's pick_arguments, field for field");
const testCopy = "assembly/__tests__/race_proto.ts", generated = "../race/assembly/proto/race.ts";
const body = (f: string) => fs.readFileSync(f, "utf8").replace(/^\/\/ A copy of[^\n]*\n/, "");
if (fs.existsSync(generated)) ok(body(testCopy) === body(generated), "the tests' copy of the race decoder is current");

const s = Signer.fromSeed("sponsor-offline-check");
const k = new Contract({ id: s.getAddress(), abi, provider: new Provider(["http://127.0.0.1:1"]), signer: s });
const ser = new Serializer(abi.koilib_types);
const { operation } = await (k.functions as any).set_config({ config: {
  enabled: true, game: "1Mpmf2ERhjYpX7CCiM11WERuM4j17uT1sr", desk: "1FKTpXBhhHEbu5vVchM8UsVbAvPArJsRmR",
  tokens: ["12Y5vW6gk8GceH53YfRkRre2Rrcsgw7Naq", "19GYjDBVXU7keLbYvMLazsGQn3GTWHjHkK"],
  max_mana_per_tx: "200000000", max_mana_per_account_day: "1000000000", max_mana_per_account_week: "3000000000", max_mana_per_day: "20000000000",
} }, { onlyOperation: true });
const back: any = await ser.deserialize(operation.call_contract.args, abi.methods.set_config.argument);
ok(back.config.game === "1Mpmf2ERhjYpX7CCiM11WERuM4j17uT1sr" && back.config.max_mana_per_account_week === "3000000000", "encode set_config");

console.log(failures ? `\n${failures} check(s) FAILED — do not deploy.` : "\nAll offline checks passed.");
process.exitCode = failures ? 1 : 0;

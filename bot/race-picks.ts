/**
 * PRODUCER RACE PICKS TOOL: put the race picks contract (race/) on chain and run it. Every command that sends is a dry
 * run (it only shows what it would do) unless you add --send.
 *
 *   npm run racepicks -- status                  the contract right now: code, settings, today's picks for a wallet
 *   npm run racepicks -- upload [--send]         put the contract on the race wallet (RACE_WIF), no overrides
 *   npm run racepicks -- setup [--send]          the first settings, signed by the race wallet's own key: owner = the
 *                                                Knode owner, picks ON, 5 picks per wallet per day
 *   npm run racepicks -- enable|disable [--send] switch picks on or off (owner's key: OWNER_WIF)
 *   npm run racepicks -- limit <1-20> [--send]   picks per wallet per day (owner's key)
 *
 * Keys come from the root .env (never GitHub):
 *   RACE_WIF    a brand-new wallet that becomes the race contract. Its key is needed for the upload and the first
 *               setup only (and future upgrades). The contract holds no funds and never pays Mana.
 *   OWNER_WIF   the Knode owner: changes the settings after the first setup.
 * The Mana for players' picks is paid by the Knode Mana sponsor (sponsor v2: npm run sponsor -- config --send once
 * race-data/deployment.json exists).
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Signer, Provider, Contract, Transaction } from "koilib";
import { KoinosChain, showKoin, toSat } from "./chain.ts";
import { contractMetadata } from "./chaincheck.ts";
import { isMainnet, pinDeployment, PINNED_MAINNET } from "./bot.ts";

const E = process.env;
const log = (...a: any[]) => console.log(...a);
const WASM = "race/build/release/contract.wasm";
const ABI_FILE = "race/abi/race.koilib.json";
const STATE = path.join("race-data", "deployment.json");
const GAME_DEP = path.join("game-data", "deployment.json");
/** The audited race build (race/README.md "Build"; audit 2026-10-27, docs/history/AUDIT-2026-10-27-race-picks.md).
 *  upload refuses any other wasm. */
export const RACE_SHA256 = "61e8f21230e8b4bdb165bacfe7281517a5adf78f6c6b1b8a0d84ce41537afac5";
export const DEFAULT_PICKS_PER_DAY = 5;

const sha256hex = (b: Uint8Array) => crypto.createHash("sha256").update(b).digest("hex");
const readJson = (f: string, d: any = null) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : d);
const writeJson = (f: string, v: any) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2) + "\n"); };
const need = (k: string) => { if (!E[k]) throw new Error(`${k} is missing from .env`); return E[k]!; };
const loadAbi = () => {
  if (!fs.existsSync(ABI_FILE)) throw new Error(`${ABI_FILE} not found: in the race folder run npm ci --ignore-scripts, npm test`);
  return JSON.parse(fs.readFileSync(ABI_FILE, "utf8"));
};
function game() {
  const g = readJson(GAME_DEP);
  if (!g?.contract || !g?.owner) throw new Error(`${GAME_DEP} is needed.`);
  const rpc = E.RPC ?? g.rpc ?? "https://api.koinos.io";
  pinDeployment("game", g, rpc, GAME_DEP);
  return { g, rpc };
}
/** The race wallet: a brand-new wallet, never one of the other Knode wallets. */
function raceKey(provider: Provider) {
  const s = Signer.fromWif(need("RACE_WIF"));
  s.provider = provider;
  const { g } = game();
  const a = s.getAddress();
  const taken: Record<string, string> = { [g.contract]: "the game contract", [g.owner]: "the owner wallet", [g.operator]: "the bot wallet", [PINNED_MAINNET.sponsor]: "the Mana sponsor", [PINNED_MAINNET.koin]: "KOIN", [PINNED_MAINNET.vhp]: "VHP" };
  if (taken[a]) throw new Error(`RACE_WIF is ${taken[a]}'s key. The race contract needs a brand-new wallet of its own.`);
  const st = readJson(STATE);
  if (st?.contract && st.contract !== a) throw new Error(`RACE_WIF belongs to ${a}, but ${STATE} says the race contract is ${st.contract}.`);
  return s;
}
function ownerKey(provider: Provider) {
  const s = Signer.fromWif(need("OWNER_WIF"));
  s.provider = provider;
  const { g } = game();
  if (s.getAddress() !== g.owner) throw new Error(`OWNER_WIF belongs to ${s.getAddress()}, not the Knode owner ${g.owner}.`);
  return s;
}
const raceAddress = () => readJson(STATE)?.contract ?? (E.RACE_WIF ? Signer.fromWif(E.RACE_WIF).getAddress() : null);
async function read(provider: Provider, id: string, method: string, args: any = {}) {
  const c = new Contract({ id, abi: loadAbi(), provider });
  return ((await (c.functions as any)[method](args)).result) ?? {};
}

/** The settings to send. Exported for the tests. */
export function buildRaceConfig(owner: string, enabled: boolean, perDay: number) {
  if (!/^1[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(owner)) throw new Error("The owner must be a Koinos address.");
  if (!Number.isInteger(perDay) || perDay < 1 || perDay > 20) throw new Error("Picks per day must be a whole number from 1 to 20.");
  return { owner, enabled, max_picks_per_day: perDay };
}

async function status() {
  const { g, rpc } = game();
  const A = raceAddress();
  if (!A) { log("No race contract yet: create a new wallet, put its key in .env as RACE_WIF, then: npm run racepicks -- upload"); return; }
  const provider = new Provider([rpc]);
  log(`Producer Race picks ${A} on ${rpc}${isMainnet(rpc) ? " (mainnet)" : ""}`);
  const m = await contractMetadata(provider, A);
  if (!m.exists) { log("  Contract       not uploaded yet (npm run racepicks -- upload)"); return; }
  const st = readJson(STATE);
  log(`  Code           sha256 ${m.hash.replace(/^0x1220/, "")}${st?.wasmSha256 && m.hash.endsWith(st.wasmSha256) ? " (as uploaded)" : ""}`);
  log(`  Overrides      ${m.tx || m.call || m.upload ? "SOME ON (must all be off!)" : "none (as it should be)"}`);
  const cfg = await read(provider, A, "get_config");
  log(`  Owner          ${cfg.owner ?? "not set (npm run racepicks -- setup)"}${cfg.owner && cfg.owner !== g.owner ? "  ⚠ not the Knode owner" : ""}`);
  log(`  Picks          ${cfg.enabled ? "ON" : "off"}, ${cfg.max_picks_per_day ?? 0} per wallet per day`);
}

async function upload(send: boolean) {
  const { rpc } = game();
  const mainnet = isMainnet(rpc);
  if (send && mainnet && E.CONFIRM_MAINNET !== "yes") throw new Error("MAINNET: add CONFIRM_MAINNET=yes to .env first.");
  const provider = new Provider([rpc]);
  const s = raceKey(provider);
  const A = s.getAddress();
  if (!fs.existsSync(WASM)) throw new Error(`${WASM} not found: in the race folder run npm ci && npm test`);
  const wasm = fs.readFileSync(WASM);
  if (!RACE_SHA256) throw new Error("The race contract has not been audited yet: upload is locked until RACE_SHA256 is set to the audited build.");
  if (sha256hex(wasm) !== RACE_SHA256) throw new Error(`${WASM} is not the audited race build (sha256 ${sha256hex(wasm)}, expected ${RACE_SHA256}). Rebuild: cd race, npm ci --ignore-scripts, npm test.`);
  const abi = loadAbi();
  const have = BigInt(await provider.getAccountRc(A));
  const needRc = toSat(Math.ceil(wasm.length / 1024 * 1.2 + 10));
  log(`Race wallet        ${A}${mainnet ? "   ⚠ MAINNET" : ""}`);
  log(`Code               ${WASM}, ${(wasm.length / 1024).toFixed(1)} KB, sha256 ${sha256hex(wasm)}`);
  log(`Overrides          none: it never pays Mana; settings and upgrades stay with keys`);
  log(`Mana               has ${showKoin(have)}, the upload needs about ${showKoin(needRc)}`);
  if (have < needRc) throw new Error(`Send at least ${showKoin(needRc - have + toSat(5))} more KOIN to ${A} first (its KOIN is its Mana; you can move it out again afterwards).`);
  if (!send) { log("\nDry run only. Nothing was sent. Run again with --send to upload."); return; }
  const c = new Contract({ id: A, abi, provider, signer: s, bytecode: new Uint8Array(wasm) });
  const { operation } = await c.deploy({ abi: JSON.stringify(abi), authorizesCallContract: false, authorizesTransactionApplication: false, authorizesUploadContract: false, onlyOperation: true } as any);
  const tx = new Transaction({ signer: s, provider, options: { payer: A, rcLimit: (needRc * 13n / 10n < have * 95n / 100n ? needRc * 13n / 10n : have * 95n / 100n).toString() } });
  await tx.pushOperation(operation);
  const receipt: any = await tx.send();
  if (receipt?.reverted) throw new Error(`upload reverted: ${JSON.stringify(receipt.logs)}`);
  await tx.wait("byBlock", 300_000).catch(() => { throw new Error("Sent but not confirmed within 5 minutes. Check status in a few minutes."); });
  const after = await contractMetadata(provider, A);
  const bad: string[] = [];
  if (after.hash.replace(/^0x1220/, "") !== RACE_SHA256) bad.push(`code on chain is ${after.hash}`);
  if (after.tx || after.call || after.upload) bad.push("an authority override is ON (all must be off)");
  if (bad.length) throw new Error(`Uploaded, but the race contract is not as expected: ${bad.join("; ")}. Do not set it up; check npm run racepicks -- status.`);
  writeJson(STATE, { network: mainnet ? "mainnet" : "testnet", rpc, contract: A, wasmSha256: sha256hex(wasm), uploadTx: tx.transaction?.id, uploadedAt: new Date().toISOString() });
  log(`✔ uploaded (Mana used ${showKoin(receipt?.rc_used)}). Saved ${STATE} (public; commit it). Next: npm run racepicks -- setup --send`);
}

async function setConfig(send: boolean, change: (cur: any) => { enabled: boolean; perDay: number }, firstSetup: boolean) {
  const { g, rpc } = game();
  if (send && isMainnet(rpc) && E.CONFIRM_MAINNET !== "yes") throw new Error("MAINNET: add CONFIRM_MAINNET=yes to .env first.");
  const provider = new Provider([rpc]);
  const A = raceAddress();
  if (!A) throw new Error("No race contract yet (npm run racepicks -- upload --send).");
  const cur = await read(provider, A, "get_config").catch(() => ({} as any));
  if (firstSetup && cur.owner) throw new Error(`Already set up (owner ${cur.owner}). Use enable, disable or limit.`);
  if (!firstSetup && !cur.owner) throw new Error("Not set up yet: npm run racepicks -- setup --send");
  const { enabled, perDay } = change(cur);
  const config = buildRaceConfig(g.owner, enabled, perDay);
  const signer = firstSetup ? raceKey(provider) : ownerKey(provider);
  log(`To the race contract ${A}, signed by ${firstSetup ? "the race wallet (first setup)" : "the Knode owner"}:`);
  log(`  owner ${config.owner}; picks ${enabled ? "ON" : "off"}; ${perDay} per wallet per day`);
  if (!send) { log("\nDry run only. Nothing was sent. Add --send to send it."); return; }
  const chain = new KoinosChain(rpc, signer.getAddress());
  const r = await chain.send([{ contract: A, abi: loadAbi(), method: "set_config", args: { config } }], [signer], { payer: signer.getAddress(), rcLimitKoin: 2 });
  log(r.ok ? `✔ done (Mana used ${showKoin(r.rcUsed)})  transaction ${r.txId}` : `✖ ${r.error}`);
  if (!r.ok) process.exitCode = 1;
}

async function main() {
  const [cmd = "status", ...a] = process.argv.slice(2);
  const send = a.includes("--send");
  switch (cmd) {
    case "status": return status();
    case "upload": return upload(send);
    case "setup": return setConfig(send, () => ({ enabled: true, perDay: DEFAULT_PICKS_PER_DAY }), true);
    case "enable": return setConfig(send, (c) => ({ enabled: true, perDay: Number(c.max_picks_per_day) || DEFAULT_PICKS_PER_DAY }), false);
    case "disable": return setConfig(send, (c) => ({ enabled: false, perDay: Number(c.max_picks_per_day) || DEFAULT_PICKS_PER_DAY }), false);
    case "limit": return setConfig(send, (c) => ({ enabled: !!c.enabled, perDay: Number(a[0]) }), false);
    default: throw new Error(`Unknown command "${cmd}". Commands: status, upload, setup, enable, disable, limit <n>`);
  }
}
if (process.argv[1] && /race-picks\.ts$/.test(process.argv[1])) {
  main().catch((e) => { console.error(`\n✖ ${e.message ?? e}`); process.exit(1); });
}

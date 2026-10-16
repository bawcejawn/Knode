/**
 * SWAP DESK TOOL — set up and run the VHP → KOIN swap desk from your PC. Every command is a dry run (it only shows
 * what it would do) unless you add --send.
 *
 *   npm run desk -- keys                         create the desk contract's own key in .env (never printed)
 *   npm run desk -- status                       the desk right now: KOIN available, VHP producing, swaps, settings
 *   npm run desk -- deploy [--send]              upload and set up the desk contract (fee 3%, timelock 48 h)
 *   npm run desk -- fund koin|vhp <amount> [--send]      send KOIN or VHP from the admin wallet into the desk
 *   npm run desk -- try-swap <vhp> [--send]      swap from the test player wallet (PLAYER_WIF), like a visitor would
 *   npm run desk -- withdraw koin|vhp <amount> [--send]  move KOIN or VHP out — always to the treasury address
 *   npm run desk -- fee <percent> [--send]       e.g. fee 3   (never above 10)
 *   npm run desk -- limits <min> <max> [--send]  smallest / largest single swap in VHP (max 0 = no fixed cap)
 *   npm run desk -- pause on|off [--send]        stop or restart swaps
 *   npm run desk -- node-key                     the desk node's PUBLIC key (read from its key file)
 *   npm run desk -- node-status                  is the desk's node (RPC 8100) caught up with the chain?
 *   npm run desk -- register-key node [--send]   register the desk node's key, so the desk's VHP produces blocks
 *   npm run desk -- treasury schedule <address> | apply | cancel [--send]   change the treasury (48 h timelock)
 *   npm run desk -- upgrade status | schedule | apply | cancel [--send]     replace the code (48 h timelock)
 *
 * Keys come from the root .env (never GitHub):
 *   DESK_CONTRACT_WIF   the desk contract's own key — only for deploy; the address must be EMPTY before deploying
 *   OWNER_WIF           the admin wallet: owns the desk (fee, limits, pause, node key, withdrawals, upgrades)
 *   OPERATOR_WIF        the bot wallet: pays the Mana for the upload (or set DESK_PAYER=owner to let the admin wallet pay)
 *   DESK_TREASURY       optional: where withdrawals go (default: the owner's address)
 *   DESK_NODE_KEY_FILE  optional: the desk node's key file (default C:\kpred-desk-node\basedir\block_producer\private.key)
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Signer, Provider, Contract, Transaction } from "koilib";
import { KoinosChain, Call, showKoin, toSat } from "./chain.ts";
import { tokenAbi } from "./token-abi.ts";
import { units, normalizeKey, nodePublicKey, isMainnet, utc, HOUR_MS } from "./bot.ts";

const E = process.env;
const log = (...a: any[]) => console.log(...a);
const DIR = "desk-data";
const DEPLOYMENT = path.join(DIR, "deployment.json");
const WASM = "desk/build/release/contract.wasm";
const ABI_FILE = "desk/abi/desk.koilib.json";
const DESK_NODE_KEY_FILE = E.DESK_NODE_KEY_FILE ?? "C:\\kpred-desk-node\\basedir\\block_producer\\private.key";
const FEE_BPS = 300;                     // 3% at launch
const MAINNET_TOKENS = { koin: "19GYjDBVXU7keLbYvMLazsGQn3GTWHjHkK", vhp: "12Y5vW6gk8GceH53YfRkRre2Rrcsgw7Naq", pob: "159myq5YUhhoVWu3wsHKHiJYKPKGUrGiyv" };

const sha256hex = (b: Uint8Array) => crypto.createHash("sha256").update(b).digest("hex");
const readJson = (f: string, d: any = null) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : d);
const writeJson = (f: string, v: any) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2) + "\n"); };
const loadAbi = () => {
  if (!fs.existsSync(ABI_FILE)) throw new Error(`${ABI_FILE} not found — in the desk folder run: npm install, npm test, npm run check`);
  return JSON.parse(fs.readFileSync(ABI_FILE, "utf8"));
};
const need = (k: string) => { if (!E[k]) throw new Error(`${k} is missing from .env`); return E[k]!; };
const pct = (bps: number | string) => `${Number(bps) / 100}%`;

function readBuild(): Buffer {
  if (!fs.existsSync(WASM)) throw new Error(`${WASM} not found — in the desk folder run: npm test && npm run check`);
  const wasm = fs.readFileSync(WASM);
  if (wasm.indexOf(Buffer.from("TEST LEDGER", "utf16le")) !== -1) throw new Error("This is the TEST build (simulated token ledger). Run `npm run build` in the desk folder.");
  return wasm;
}

function deployed() {
  const dep = readJson(DEPLOYMENT);
  if (!dep?.contract) throw new Error(`${DEPLOYMENT} not found — deploy the desk first (npm run desk -- deploy).`);
  const rpc = E.RPC ?? dep.rpc;
  return { dep, rpc, chain: new KoinosChain(rpc, dep.contract), abi: loadAbi() };
}

async function readDesk(chain: KoinosChain, abi: any, method: string, args: any = {}) {
  const c = new Contract({ id: chain.contractId, abi, provider: chain.provider });
  return ((await (c.functions as any)[method](args)).result) ?? {};
}

// ═══════════════════════════════ status ═══════════════════════════════
async function status() {
  const { dep, rpc, chain, abi } = deployed();
  const st = await readDesk(chain, abi, "get_state");
  const c = st.config ?? {}, t = st.totals ?? {};
  log(`Swap desk ${dep.contract} on ${rpc}${isMainnet(rpc) ? " (mainnet)" : ""}`);
  log(`  Swaps          ${c.paused ? "PAUSED" : "open"} — fee ${pct(c.fee_bps ?? 0)}, min ${showKoin(c.min_swap)} VHP, max ${c.max_swap && c.max_swap !== "0" ? showKoin(c.max_swap) + " VHP" : "only what is available"}`);
  log(`  KOIN           ${showKoin(st.koin_balance)} (Mana ${showKoin(st.mana)})`);
  log(`  Available now  ${showKoin(st.available)} KOIN  →  largest swap ${showKoin(st.max_vhp_in)} VHP`);
  log(`  VHP producing  ${showKoin(st.vhp_balance)}`);
  log(`  All-time       ${t.swaps ?? 0} swaps: ${showKoin(t.vhp_in)} VHP in, ${showKoin(t.koin_out)} KOIN out, fees earned ${showKoin(BigInt(t.vhp_in ?? 0) - BigInt(t.koin_out ?? 0))} VHP`);
  log(`  Owner          ${c.owner}`);
  log(`  Treasury       ${c.treasury}  (withdrawals can only go here)`);
  const now = Number(st.time ?? Date.now());
  if (st.treasury_change?.address) log(`  ⚠ Treasury change announced → ${st.treasury_change.address}, possible from ${utc(Number(st.treasury_change.eta))}${Number(st.treasury_change.eta) <= now ? " (now)" : ""}`);
  if (st.upgrade?.hash) log(`  ⚠ Code upgrade announced (sha256 ${st.upgrade.hash}), possible from ${utc(Number(st.upgrade.eta))}`);
  if (BigInt(st.vhp_balance ?? 0) > 0n) {
    try {
      const head: any = await chain.provider.getHeadInfo();
      log(`  Network block  ${Number(head.head_topology.height).toLocaleString()} — check the desk is producing: https://koinosscan.com/address/${dep.contract}`);
    } catch {}
  }
}

// ═══════════════════════════════ deploy ═══════════════════════════════
async function deploy(send: boolean) {
  const rpc = E.RPC ?? "https://api.koinos.io";
  const mainnet = isMainnet(rpc);
  if (send && mainnet && E.CONFIRM_MAINNET !== "yes") throw new Error(`RPC is ${rpc} (MAINNET, real KOIN). Add CONFIRM_MAINNET=yes to .env if you really mean it.`);
  const contractKey = Signer.fromWif(need("DESK_CONTRACT_WIF"));
  // Who pays the upload Mana: the bot wallet by default, or the admin wallet (DESK_PAYER=owner) so the game bot keeps its Mana.
  const payerOwner = (E.DESK_PAYER ?? "").toLowerCase() === "owner";
  const operator = Signer.fromWif(need(payerOwner ? "OWNER_WIF" : "OPERATOR_WIF"));
  const owner = E.OWNER_ADDRESS ?? (E.OWNER_WIF ? Signer.fromWif(E.OWNER_WIF).getAddress() : undefined);
  if (!owner) throw new Error("OWNER_WIF (or OWNER_ADDRESS) is missing from .env");
  const treasury = E.DESK_TREASURY ?? owner;
  const provider = new Provider([rpc]);
  contractKey.provider = provider; operator.provider = provider;
  const C = contractKey.getAddress();
  const prior = readJson(DEPLOYMENT);
  if (prior?.contract && prior.contract !== C) throw new Error(`${DEPLOYMENT} already records desk ${prior.contract}. Move it away to deploy a new one.`);
  if (E.CONTRACT_WIF && Signer.fromWif(E.CONTRACT_WIF).getAddress() === C) throw new Error("DESK_CONTRACT_WIF is the GAME contract's key. The desk needs its own new key.");

  const wasm = readBuild();
  const abi = loadAbi();
  const abiText = JSON.stringify(abi);
  const tokens = mainnet ? MAINNET_TOKENS : { koin: need("KOIN_ADDRESS"), vhp: need("VHP_ADDRESS"), pob: E.POB_ADDRESS ?? "" };
  const tok = (id: string) => new Contract({ id, abi: tokenAbi as any, provider });
  const bal = async (id: string, a: string) => BigInt(((await (tok(id).functions as any).balance_of({ owner: a })).result?.value) ?? 0);
  const opMana = BigInt(await provider.getAccountRc(operator.getAddress()));
  // Upload cost from the chain's current resource prices (same method as the game's deploy; the game's 25 KB upload used 18.7).
  const bytes = wasm.length + abiText.length;
  let estimate = toSat(Math.ceil(bytes / 1024 * 0.8 + 10));
  try {
    const d: any = ((await provider.call("chain.get_resource_limits", {})) as any)?.resource_limit_data ?? {};
    const disk = BigInt(d.disk_storage_cost ?? 0) * BigInt(bytes + 2_000);
    const net = BigInt(d.network_bandwidth_cost ?? 0) * BigInt(Math.ceil(bytes * 1.4) + 4_000);
    const comp = BigInt(d.compute_bandwidth_cost ?? 0) * 8_000_000n;
    if (disk + net + comp > 0n) estimate = disk + net + comp;
  } catch {}
  const init = {
    owner, treasury, fee_bps: FEE_BPS, min_swap: String(toSat(1)), max_swap: "0",
    timelock_length: String(mainnet ? 48 * HOUR_MS : 10 * 60_000),
  };
  log(`Network            ${rpc}${mainnet ? "   ⚠ MAINNET" : ""}`);
  log(`Desk address       ${C}`);
  log(`Code               ${WASM}, ${(wasm.length / 1024).toFixed(1)} KB, sha256 ${sha256hex(wasm)}`);
  log(`Owner              ${owner}`);
  log(`Treasury           ${treasury}   (the ONLY address withdrawals can go to)`);
  log(`Settings           fee ${pct(FEE_BPS)}, smallest swap 1 VHP, no fixed largest swap, timelock ${mainnet ? "48 h" : "10 min"}`);
  log(`Pays the Mana      ${payerOwner ? "admin" : "bot"} wallet ${operator.getAddress()} (has ${showKoin(opMana)}; the upload needs about ${showKoin(estimate)} + ~1 for setup)`);
  if (!prior?.uploaded) {
    const [k, v] = [await bal(tokens.koin, C), await bal(tokens.vhp, C)];
    if (k > 0n || v > 0n) throw new Error("The desk address already holds tokens. Use a fresh DESK_CONTRACT_WIF and fund it AFTER deploying.");
    if (opMana < (estimate * 13n) / 10n + toSat(1)) throw new Error(`The ${payerOwner ? "admin" : "bot"} wallet needs about ${showKoin((estimate * 13n) / 10n + toSat(1))} Mana but has ${showKoin(opMana)}.`);
  }
  if (!send) { log(`\nDry run only. Nothing was sent. Run again with --send to deploy.`); return; }

  const chain = new KoinosChain(rpc, C);
  const st: any = { network: mainnet ? "mainnet" : "testnet", rpc, contract: C, owner, treasury, ...tokens, wasmSha256: sha256hex(wasm), ...prior };
  if (!st.uploaded) { try { await readDesk(chain, abi, "get_state"); st.uploaded = true; log("\n1/2 The desk code is already on chain."); } catch { /* not uploaded yet */ } }
  if (!st.uploaded) {
    log("\n1/2 Uploading the desk contract (the bot wallet pays the Mana, the desk key authorizes) ...");
    const c = new Contract({ id: C, abi, provider, signer: contractKey, bytecode: new Uint8Array(wasm) });
    const { operation } = await c.deploy({ abi: abiText, authorizesCallContract: true, authorizesTransactionApplication: true, authorizesUploadContract: true, onlyOperation: true } as any);
    const cap = (estimate * 13n) / 10n < (opMana * 95n) / 100n ? (estimate * 13n) / 10n : (opMana * 95n) / 100n;
    const tx = new Transaction({ signer: operator, provider, options: { payer: operator.getAddress(), payee: operator.getAddress(), rcLimit: cap.toString() } });
    await tx.pushOperation(operation);
    await tx.prepare();
    let t: any = tx.transaction;
    t = await operator.signTransaction(t);
    t = await contractKey.signTransaction(t);
    const { receipt, transaction } = await provider.sendTransaction(t);
    if ((receipt as any)?.reverted) throw new Error(`upload reverted: ${JSON.stringify((receipt as any).logs)}`);
    await transaction.wait("byBlock", 300_000).catch(() => { throw new Error("Sent but not confirmed within 5 minutes. Wait, then run the same command again: it will see the code and continue."); });
    log(`    uploaded — Mana used ${showKoin((receipt as any).rc_used)}`);
    st.uploaded = true; st.uploadTx = t.id;
    writeJson(DEPLOYMENT, st);
  }
  const s0 = await readDesk(chain, abi, "get_state");
  if (!s0.config?.owner) {
    log("2/2 Setting up (signed by the desk key, paid by the bot wallet) ...");
    const r = await chain.send([{ contract: C, abi, method: "init", args: init }], [operator, contractKey]);
    if (!r.ok) throw new Error(`init failed: ${r.error}`);
    log(`    done — Mana used ${showKoin(r.rcUsed)}`);
  }
  st.deployedAt = new Date().toISOString();
  writeJson(DEPLOYMENT, st);
  log(`\nDone. Saved ${DEPLOYMENT} — commit it (it's public): the website reads it to find the desk.`);
  log(`Next: fund the desk (fund koin …), register the desk node's key (register-key node), then check status.`);
}

// ═══════════════════════════════ keys ═══════════════════════════════
/** Adds DESK_CONTRACT_WIF to the root .env if it is missing. The private key is never printed. */
function keys() {
  const file = path.resolve(".env");
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (!/^\s*DESK_CONTRACT_WIF\s*=/m.test(text)) {
    const s = new Signer({ privateKey: crypto.randomBytes(32).toString("hex") });
    fs.appendFileSync(file, `${text && !text.endsWith("\n") ? "\n" : ""}DESK_CONTRACT_WIF=${s.getPrivateKey("wif", true)}\n`);
    process.env.DESK_CONTRACT_WIF = s.getPrivateKey("wif", true);
    log("Created DESK_CONTRACT_WIF in .env (a brand-new, empty address).");
  }
  const addr = Signer.fromWif(process.env.DESK_CONTRACT_WIF!).getAddress();
  log(`Desk contract address: ${addr}
  • Back up DESK_CONTRACT_WIF offline, like your other keys. It is needed once, to deploy.
  • Send NOTHING to this address before the deploy. Fund it afterwards with: npm run desk -- fund koin <amount>
  • Set up the desk's node to produce for this address (see desk/README.md, step 3).`);
}

// ═══════════════════════════════ owner actions ═══════════════════════════════
async function asOwner(what: string, calls: (owner: string, dep: any, abi: any) => Call[], send: boolean) {
  const { dep, rpc, chain, abi } = deployed();
  if (send && isMainnet(rpc) && E.CONFIRM_MAINNET !== "yes") throw new Error("MAINNET: add CONFIRM_MAINNET=yes to .env first.");
  const owner = Signer.fromWif(need("OWNER_WIF"));
  owner.provider = chain.provider;
  const list = calls(owner.getAddress(), dep, abi);
  log(`${what}\nAs ${owner.getAddress()} on ${rpc}:`);
  for (const c of list) log(`  ${c.contract === dep.contract ? "desk" : c.contract === dep.koin ? "KOIN" : c.contract === dep.vhp ? "VHP" : c.contract}.${c.method} ${JSON.stringify(c.args)}`);
  if (!send) { log("\nDry run only — nothing was sent. Add --send to send it."); return; }
  const r = await chain.send(list, [owner], { rcLimitKoin: 5 });
  log(r.ok ? `✔ done (Mana used ${showKoin(r.rcUsed)})  transaction ${r.txId}` : `✖ ${r.error}`);
  if (!r.ok) process.exitCode = 1;
}
const desk = (dep: any, abi: any, method: string, args: any = {}): Call => ({ contract: dep.contract, abi, method, args });

async function upgrade(sub: string | undefined, send: boolean) {
  const { dep, rpc, chain, abi } = deployed();
  const st = await readDesk(chain, abi, "get_state");
  const wasm = readBuild();
  const local = "0x" + sha256hex(wasm);
  const announced = st.upgrade?.hash ? String(st.upgrade.hash) : "";
  if (!sub || sub === "status") {
    log(announced ? `Announced: ${announced}, possible from ${utc(Number(st.upgrade.eta))}\nLocal build: ${local} ${announced === local ? "(matches)" : "(DIFFERENT)"}` : `No upgrade announced. Local build: ${local}`);
    return;
  }
  if (sub === "schedule") return asOwner(`Announce the local build as the desk's next code (it can be uploaded after the timelock).`, (_o, d, a) => [desk(d, a, "schedule_upgrade", { hash: local })], send);
  if (sub === "cancel") return asOwner("Cancel the announced upgrade.", (_o, d, a) => [desk(d, a, "cancel_upgrade")], send);
  if (sub !== "apply") throw new Error("upgrade status | schedule | apply | cancel");
  if (announced !== local) throw new Error(`The local build (${local}) is not the announced one (${announced || "none"}).`);
  if (Number(st.upgrade.eta) > Number(st.time)) throw new Error(`The timelock ends ${utc(Number(st.upgrade.eta))}.`);
  if (send && isMainnet(rpc) && E.CONFIRM_MAINNET !== "yes") throw new Error("MAINNET: add CONFIRM_MAINNET=yes to .env first.");
  const owner = Signer.fromWif(need("OWNER_WIF"));
  owner.provider = chain.provider;
  log(`Upload the announced code to ${dep.contract} (owner signs and pays; storage is kept).`);
  if (!send) { log("\nDry run only — nothing was sent. Add --send to send it."); return; }
  const c = new Contract({ id: dep.contract, abi, provider: chain.provider, signer: owner, bytecode: new Uint8Array(wasm) });
  const { operation } = await c.deploy({ abi: JSON.stringify(abi), authorizesCallContract: true, authorizesTransactionApplication: true, authorizesUploadContract: true, onlyOperation: true } as any);
  const tx = new Transaction({ signer: owner, provider: chain.provider, options: { rcLimit: toSat(25).toString() } });
  await tx.pushOperation(operation);
  const receipt: any = await tx.send();
  if (receipt?.reverted) throw new Error(`upgrade reverted: ${JSON.stringify(receipt.logs)}`);
  await tx.wait("byBlock", 300_000);
  log(`✔ upgraded. Now clear the notice: npm run desk -- upgrade cancel --send`);
}

// ═══════════════════════════════ commands ═══════════════════════════════
async function main() {
  const [cmd = "status", ...a] = process.argv.slice(2);
  const send = a.includes("--send");
  const arg = (i: number, what: string) => { if (a[i] === undefined || a[i].startsWith("--")) throw new Error(`missing ${what}`); return a[i]; };
  const token = (i: number) => { const t = arg(i, "koin or vhp").toLowerCase(); if (t !== "koin" && t !== "vhp") throw new Error(`"${t}": say koin or vhp`); return t; };
  switch (cmd) {
    case "status": return status();
    case "keys": return keys();
    case "deploy": return deploy(send);
    case "fund": {
      const t = token(0), amt = units(arg(1, "amount"));
      return asOwner(`Send ${showKoin(amt)} ${t.toUpperCase()} from the admin wallet into the desk.${t === "koin" ? " (Moving KOIN needs this wallet's Mana ≥ the amount; the Mana moves with it.)" : ""}`,
        (o, d) => [{ contract: t === "koin" ? d.koin : d.vhp, abi: tokenAbi, method: "transfer", args: { from: o, to: d.contract, value: amt } }], send);
    }
    case "try-swap": {
      // Exactly what the website does: approve the VHP + swap, in one transaction, never accepting less than quoted.
      const { dep, rpc, chain, abi } = deployed();
      if (send && isMainnet(rpc) && E.CONFIRM_MAINNET !== "yes") throw new Error("MAINNET: add CONFIRM_MAINNET=yes to .env first.");
      const player = Signer.fromWif(need("PLAYER_WIF"));
      player.provider = chain.provider;
      const amt = units(arg(0, "VHP amount"));
      const q = await readDesk(chain, abi, "quote", { vhp_amount: amt });
      log(`Test swap from ${player.getAddress()}: ${showKoin(amt)} VHP → ${showKoin(q.koin_out)} KOIN (fee ${showKoin(q.fee)} VHP)`);
      if (q.problem) throw new Error(`The desk would refuse it: ${q.problem}`);
      if (!send) { log("\nDry run only — nothing was sent. Add --send to send it."); return; }
      const before = await chain.mana(player.getAddress());
      const r = await chain.send([
        { contract: dep.vhp, abi: tokenAbi, method: "approve", args: { owner: player.getAddress(), spender: dep.contract, value: amt } },
        { contract: dep.contract, abi, method: "swap", args: { from: player.getAddress(), vhp_amount: amt, min_koin_out: q.koin_out } },
      ], [player], { rcLimitKoin: 3 });
      log(r.ok ? `✔ swapped (Mana used ${showKoin(r.rcUsed)}, player had ${showKoin(before)})  transaction ${r.txId}` : `✖ ${r.error}`);
      if (!r.ok) process.exitCode = 1;
      return;
    }
    case "withdraw": {
      const t = token(0), amt = units(arg(1, "amount"));
      return asOwner(`Move ${showKoin(amt)} ${t.toUpperCase()} from the desk to the treasury.`, (_o, d, ab) => [desk(d, ab, t === "koin" ? "withdraw_koin" : "withdraw_vhp", { amount: amt })], send);
    }
    case "fee": {
      const p = Number(arg(0, "percent"));
      if (!isFinite(p) || p < 0 || p > 10) throw new Error("The fee is a percent from 0 to 10.");
      const bps = Math.round(p * 100);
      return asOwner(`Set the fee to ${pct(bps)}.`, (_o, d, ab) => [desk(d, ab, "set_fee", { fee_bps: bps })], send);
    }
    case "limits": {
      const min = units(arg(0, "smallest swap (VHP)")), max = units(arg(1, "largest swap (VHP, 0 = none)"));
      return asOwner(`Set swaps to between ${showKoin(min)} and ${max === "0" ? "whatever is available" : showKoin(max)} VHP.`, (_o, d, ab) => [desk(d, ab, "set_limits", { min_swap: min, max_swap: max })], send);
    }
    case "pause": {
      const on = arg(0, "on or off") === "on";
      return asOwner(on ? "Pause swaps." : "Resume swaps.", (_o, d, ab) => [desk(d, ab, "set_paused", { paused: on })], send);
    }
    case "node-key": {
      log(`The desk node's PUBLIC key (safe to share):\n  ${nodePublicKey(DESK_NODE_KEY_FILE)}\n\nRegister it for the desk with:\n  npm run desk -- register-key node          (dry run)\n  npm run desk -- register-key node --send`);
      return;
    }
    case "node-status": {
      const rpc = E.DESK_NODE_RPC ?? "http://127.0.0.1:8100";
      const pub: any = await new Provider([E.RPC ?? "https://api.koinos.io"]).getHeadInfo();
      const ph = Number(pub.head_topology.height);
      let lh = 0;
      try { lh = Number(((await new Provider([rpc]).getHeadInfo()) as any).head_topology.height); }
      catch { log(`The desk node doesn't answer on ${rpc}. Is Docker running? In C:\\kpred-desk-node\\koinos run: docker compose up -d`); process.exitCode = 1; return; }
      const behind = ph - lh;
      log(`Network block ${ph.toLocaleString()} — desk node ${lh.toLocaleString()}`);
      log(behind <= 20 ? "✔ The desk node is caught up. It can produce once its key is registered." : `… the desk node is ${behind.toLocaleString()} blocks behind (~${(behind * 3 / 3600).toFixed(1)} h of chain). It catches up much faster than real time.`);
      return;
    }
    case "register-key": {
      const k = arg(0, "the desk node's PUBLIC key (or: node)");
      const pub = k === "node" ? nodePublicKey(DESK_NODE_KEY_FILE) : fs.existsSync(k) ? nodePublicKey(k) : normalizeKey(k);
      return asOwner("Register the desk node's block-producer key, so the desk's VHP produces blocks.", (_o, d, ab) => [desk(d, ab, "register_key", { public_key: pub })], send);
    }
    case "treasury": {
      const sub = arg(0, "schedule, apply or cancel");
      if (sub === "schedule") { const to = arg(1, "new treasury address"); return asOwner(`Announce ${to} as the new treasury (takes effect with "treasury apply" after the timelock).`, (_o, d, ab) => [desk(d, ab, "schedule_treasury", { treasury: to })], send); }
      if (sub === "apply") return asOwner("Make the announced treasury change.", (_o, d, ab) => [desk(d, ab, "apply_treasury")], send);
      if (sub === "cancel") return asOwner("Cancel the announced treasury change.", (_o, d, ab) => [desk(d, ab, "cancel_treasury")], send);
      throw new Error("treasury schedule <address> | apply | cancel");
    }
    case "upgrade": return upgrade(a[0] && !a[0].startsWith("--") ? a[0] : undefined, send);
    default: throw new Error(`Unknown command "${cmd}". The list is at the top of bot/desk.ts and in desk/README.md.`);
  }
}

main().catch((e) => { console.error(`\n✖ ${e.message ?? e}`); process.exit(1); });

/**
 * Testnet probes for the prediction contract's building blocks.
 *
 *   npm run probes -- keys     make the test keys (saved only in your local .env) and print their addresses
 *   npm run probes -- status   balances and Mana of every test account
 *   npm run probes -- setup    deploy the probe contract, set its owner, fund it and the helper account
 *   npm run probes -- run      run every probe and print PASS / FAIL with the Mana each one used
 *   npm run probes -- sweep    send everything left in the contract and the helper back to the owner
 *
 * Runs on Harbinger (testnet) by default. Mainnet needs RPC=https://api.koinos.io AND CONFIRM_MAINNET=yes
 * in .env, and should only ever use a fresh wallet holding a small amount.
 */
import fs from "node:fs";
import crypto from "node:crypto";
import { Provider, Signer, Contract, Transaction, utils } from "koilib";
import { kprobeAbi, tokenAbi, pobAbi } from "./abi";

// ───────────────────────── settings ─────────────────────────

function loadEnv(file = ".env") {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
loadEnv();

const E = process.env;
const RPC = E.RPC ?? "https://harbinger-api.koinos.io";
const num = (k: string, d: number) => (E[k] ? Number(E[k]) : d);
const CFG = {
  fundContract: num("FUND_CONTRACT", 5),  // KOIN sent to the contract (its Mana pays for sponsored pings)
  fundHelper: num("FUND_HELPER", 2),      // KOIN for the helper (a second, unrelated user)
  ownerBurn: num("OWNER_BURN", 2),        // KOIN the owner burns into VHP so it has VHP to deposit
  deposit: num("DEPOSIT", 1),             // size of each test deposit / withdrawal
  reserve: num("RESERVE", 3),             // KOIN the contract keeps unburned during compound
  rcLimit: num("RC_LIMIT", 2),            // max Mana (in KOIN) a normal probe transaction may use
  stressRcLimit: num("STRESS_RC_LIMIT", 5),
  uploadRcLimit: num("UPLOAD_RC_LIMIT", 30), // max Mana for uploading the contract code (estimate is ~21 for 25 KB)
};
const NEED = CFG.fundContract + CFG.fundHelper + CFG.ownerBurn + CFG.deposit + CFG.uploadRcLimit; // ~40 // KOIN the owner should hold
const STATE_FILE = "probe-state.json";
const WASM = "build/release/contract.wasm";
const OUT_DIR = "probes-output";

const IS_TESTNET = /harbinger/i.test(RPC);
const provider = new Provider([RPC]);

/** Mainnet uses real KOIN: refuse unless the user has explicitly opted in. */
function guardNetwork() {
  if (IS_TESTNET) return;
  if (E.CONFIRM_MAINNET !== "yes") {
    throw new Error(`RPC is ${RPC}, which is MAINNET (real KOIN). Add CONFIRM_MAINNET=yes to .env if you really mean it.`);
  }
  console.log(`⚠ MAINNET (${RPC}) — real KOIN. Use a fresh wallet with only the amount needed.\n`);
}
const sat = (koin: number) => BigInt(Math.round(koin * 1e8)).toString();
const show = (s: string | number | bigint | undefined) => (Number(s ?? 0) / 1e8).toLocaleString("en-US", { maximumFractionDigits: 8 });

function signerFrom(wifName: string): Signer {
  const wif = E[wifName];
  if (!wif) throw new Error(`${wifName} is missing from .env — run: npm run probes -- keys`);
  const s = Signer.fromWif(wif);
  s.provider = provider;
  return s;
}

function readState(): any {
  return fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) : {};
}
function writeState(s: any) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

function pubKeyB64(s: Signer): string {
  const pk: any = (s as any).publicKey;
  const bytes: Uint8Array = typeof pk === "string" ? utils.toUint8Array(pk) : pk;
  return utils.encodeBase64url(bytes);
}

// ───────────────────────── chain helpers ─────────────────────────

/** KOIN and VHP addresses: from the saved state, from .env, or detected from recent blocks
 *  (every block mints KOIN to its signer and burns VHP from its signer). */
async function tokenAddresses(): Promise<{ koin: string; vhp: string }> {
  const st = readState();
  if (st.koin && st.vhp) return { koin: st.koin, vhp: st.vhp };
  if (E.KOIN_ADDRESS && E.VHP_ADDRESS) return { koin: E.KOIN_ADDRESS, vhp: E.VHP_ADDRESS };
  const head: any = await provider.getHeadInfo();
  const h = Number(head.head_topology.height);
  const res: any = await provider.call("block_store.get_blocks_by_height", {
    head_block_id: head.head_topology.id, ancestor_start_height: String(h - 30),
    num_blocks: 30, return_block: true, return_receipt: true,
  });
  const mint = new Map<string, number>(), burn = new Map<string, number>();
  for (const it of res.block_items ?? []) {
    const signer = it.block?.header?.signer;
    for (const ev of it.receipt?.events ?? []) {
      if (!ev.impacted?.includes(signer)) continue;
      if (String(ev.name).endsWith("mint_event")) mint.set(ev.source, (mint.get(ev.source) ?? 0) + 1);
      if (String(ev.name).endsWith("burn_event")) burn.set(ev.source, (burn.get(ev.source) ?? 0) + 1);
    }
  }
  const top = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const koin = top(mint), vhp = top(burn);
  if (!koin || !vhp) throw new Error("Could not detect the KOIN/VHP contracts — set KOIN_ADDRESS and VHP_ADDRESS in .env");
  return { koin, vhp };
}

function token(id: string) {
  return new Contract({ id, abi: tokenAbi as any, provider });
}
async function balance(tokenId: string, owner: string): Promise<bigint> {
  const { result } = await token(tokenId).functions.balance_of({ owner });
  return BigInt((result as any)?.value ?? 0);
}
async function mana(addr: string): Promise<bigint> {
  return BigInt(await provider.getAccountRc(addr));
}

type Sent = { ok: boolean; rc: string; error?: string; receipt?: any };

/**
 * Builds, signs and sends one transaction.
 * signers[0] is the payee (whose nonce is used); every signer adds its signature.
 * payer pays the Mana and defaults to the payee.
 */
async function send(ops: any[], signers: Signer[], payer?: string, rcLimitKoin = CFG.rcLimit): Promise<Sent> {
  try {
    const payee = signers[0].getAddress();
    // Never ask for more Mana than the payer has (the node would refuse the transaction outright).
    const available = await mana(payer ?? payee);
    const cap = BigInt(sat(rcLimitKoin));
    const limit = (available * 95n) / 100n < cap ? (available * 95n) / 100n : cap;
    const tx = new Transaction({
      signer: signers[0], provider,
      options: { payer: payer ?? payee, payee, rcLimit: limit.toString() },
    });
    for (const op of ops) await tx.pushOperation(op);
    await tx.prepare();
    let t: any = tx.transaction;
    for (const s of signers) t = await s.signTransaction(t);
    const { receipt, transaction } = await provider.sendTransaction(t);
    if ((receipt as any)?.reverted) {
      // A reverted transaction is still included (and uses its nonce), so wait for it too.
      await transaction.wait("byBlock", 120_000).catch(() => undefined);
      return { ok: false, rc: String((receipt as any).rc_used ?? 0), error: `reverted: ${JSON.stringify((receipt as any).logs ?? [])}`, receipt };
    }
    await transaction.wait("byBlock", 120_000);
    return { ok: true, rc: String((receipt as any)?.rc_used ?? 0), receipt };
  } catch (e) {
    return { ok: false, rc: "0", error: (e as Error).message };
  }
}

// Operation builders (no signing, no sending).
const op = async (c: Contract, fn: string, args: any) => (await (c.functions as any)[fn](args, { onlyOperation: true })).operation;

function kprobeContract(contractSigner: Signer, withBytecode = false) {
  return new Contract({
    id: contractSigner.getAddress(),
    abi: kprobeAbi as any,
    provider,
    signer: contractSigner,
    bytecode: withBytecode ? new Uint8Array(fs.readFileSync(WASM)) : undefined,
  });
}

/** A tiny valid (empty) WebAssembly module: used for the upload ATTACK tests, so a refused attempt costs
 *  almost no Mana and can only be refused by the security rule, not by running out of Mana. */
const TINY_WASM = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

async function uploadOp(contractSigner: Signer, tiny = false) {
  if (!tiny && !fs.existsSync(WASM)) throw new Error(`${WASM} not found — run: npm run build`);
  const c = kprobeContract(contractSigner, !tiny);
  if (tiny) (c as any).bytecode = TINY_WASM;
  const { operation } = await c.deploy({
    authorizesCallContract: true,
    authorizesTransactionApplication: true,
    authorizesUploadContract: true,
    onlyOperation: true,
  } as any);
  return operation;
}

async function info(contractSigner: Signer): Promise<any> {
  const { result } = await (kprobeContract(contractSigner).functions as any).info({});
  return result ?? {};
}

// ───────────────────────── commands ─────────────────────────

async function cmdKeys() {
  const lines: string[] = [];
  for (const name of ["OWNER_WIF", "CONTRACT_WIF", "HELPER_WIF"]) {
    if (E[name]) continue;
    const s = Signer.fromSeed(crypto.randomBytes(32).toString("hex"));
    const wif = s.getPrivateKey("wif");
    E[name] = wif;
    lines.push(`${name}=${wif}`);
  }
  const wantMainnet = process.argv.includes("--mainnet");
  if (lines.length || wantMainnet) {
    let existing = fs.existsSync(".env") ? fs.readFileSync(".env", "utf8") : `RPC=${RPC}\n`;
    if (wantMainnet) {
      existing = existing.replace(/^RPC=.*$/m, "").replace(/^CONFIRM_MAINNET=.*$/m, "");
      lines.unshift("RPC=https://api.koinos.io", "CONFIRM_MAINNET=yes");
    }
    fs.writeFileSync(".env", existing.replace(/\n{2,}/g, "\n").replace(/^\n/, "").replace(/\s*$/, "\n") + lines.join("\n") + "\n");
    console.log(`Updated .env: ${lines.map((l) => l.split("=")[0]).join(", ")} (this file stays on your computer — never share it).`);
    if (wantMainnet) console.log("⚠ .env now points at MAINNET (real KOIN).");
  } else {
    console.log("All three keys are already in .env.");
  }
  console.log("");
  const mainnetNow = process.argv.includes("--mainnet") || !IS_TESTNET;
  console.log(`  owner     ${signerFrom("OWNER_WIF").getAddress()}   ← send ${mainnetNow ? "KOIN" : "tKOIN"} here from your wallet`);
  console.log(`  contract  ${signerFrom("CONTRACT_WIF").getAddress()}   ← the probe contract will live at this address`);
  console.log(`  helper    ${signerFrom("HELPER_WIF").getAddress()}   ← a second user; setup funds it from the owner`);
  console.log(`\nThe owner needs about ${NEED} KOIN: about ${CFG.fundContract + CFG.fundHelper + CFG.ownerBurn + CFG.deposit} is moved around by the tests (and swept back),`);
  console.log(`the rest is Mana headroom for uploading the contract. Mana is not spent like a fee — it refills over ~5 days.`);
}

/** Mana the contract upload should need, from the chain's current resource prices (read-only query). */
async function uploadEstimate(): Promise<{ total: bigint; text: string } | null> {
  if (!fs.existsSync(WASM)) return null;
  try {
    const res: any = await provider.call("chain.get_resource_limits", {});
    const d = res?.resource_limit_data ?? {};
    const size = fs.statSync(WASM).size;
    const disk = BigInt(d.disk_storage_cost ?? 0) * BigInt(size + 1_000);           // stored bytecode + metadata
    const net = BigInt(d.network_bandwidth_cost ?? 0) * BigInt(Math.ceil(size * 1.4) + 2_000); // transaction bytes (base64 overhead included)
    const comp = BigInt(d.compute_bandwidth_cost ?? 0) * 5_000_000n;                // generous allowance for the upload's compute
    const total = disk + net + comp;
    return { total, text: `disk ${show(disk)} + network ${show(net)} + compute ${show(comp)} = about ${show(total)} Mana` };
  } catch {
    return null;
  }
}

async function cmdStatus() {
  const { koin, vhp } = await tokenAddresses();
  const head: any = await provider.getHeadInfo();
  console.log(`RPC ${RPC}   head ${head.head_topology.height}   KOIN ${koin}   VHP ${vhp}\n`);
  const rows: [string, string][] = [];
  for (const [label, key] of [["owner", "OWNER_WIF"], ["contract", "CONTRACT_WIF"], ["helper", "HELPER_WIF"]]) {
    if (E[key]) rows.push([label, signerFrom(key).getAddress()]);
  }
  for (const [label, addr] of rows) {
    const [k, v, m] = await Promise.all([balance(koin, addr), balance(vhp, addr), mana(addr)]);
    console.log(`  ${label.padEnd(9)} ${addr}   KOIN ${show(k).padStart(12)}   VHP ${show(v).padStart(12)}   Mana ${show(m).padStart(12)}`);
  }
  const est = await uploadEstimate();
  if (est) console.log(`\nUploading the contract (${(fs.statSync(WASM).size / 1024).toFixed(1)} KB): ${est.text}`);
}

async function cmdSetup() {
  guardNetwork();
  const owner = signerFrom("OWNER_WIF");
  const contract = signerFrom("CONTRACT_WIF");
  const helper = signerFrom("HELPER_WIF");
  const { koin } = await tokenAddresses();

  const need = NEED;
  const ownerKoin = await balance(koin, owner.getAddress());
  console.log(`Owner ${owner.getAddress()} has ${show(ownerKoin)} KOIN (needs about ${need}).`);
  if (ownerKoin < BigInt(sat(need))) {
    console.log("Not enough yet. Fund the owner address, then run setup again.");
    process.exitCode = 1;
    return;
  }

  const st = readState();
  if (!st.deployed) {
    // Check the upload fits in the owner's Mana before trying, so a failed upload can't waste it.
    const est = await uploadEstimate();
    const ownerMana = await mana(owner.getAddress());
    if (est) {
      console.log(`Upload estimate: ${est.text}. Owner Mana: ${show(ownerMana)}.`);
      if ((est.total * 13n) / 10n > ownerMana || est.total > BigInt(sat(CFG.uploadRcLimit))) {
        console.log("Not enough Mana for the upload with a safety margin. Nothing was sent. Paste this output in the chat.");
        process.exitCode = 1;
        return;
      }
    }
    console.log("1/4 Deploying the probe contract (owner pays the Mana, contract key authorizes the upload) ...");
    const r = await send([await uploadOp(contract)], [contract, owner], owner.getAddress(), CFG.uploadRcLimit);
    if (!r.ok) throw new Error(`deploy failed: ${r.error}`);
    console.log(`    deployed — Mana used ${show(r.rc)}`);
    st.deployed = true;
    writeState(st);
  }

  // `info` also reads the contract's producer key from Proof-of-Burn, and PoB fails the whole call while no
  // key is registered (lesson for the real contract: a failing call into a system contract aborts the caller).
  // So until a key exists, setup works without `info`.
  let before: any = null;
  try {
    before = await info(contract);
  } catch (e) {
    if (!/no public key record/i.test((e as Error).message)) throw e;
  }
  const k = kprobeContract(contract);
  if (!before?.owner) {
    console.log("2/4 Setting the owner (must be signed by the contract key) ...");
    const r = await send([await op(k, "init", { owner: owner.getAddress() })], [owner, contract]);
    if (!r.ok && !/owner already set/i.test(r.error ?? "")) throw new Error(`init failed: ${r.error}`);
    console.log(r.ok ? `    owner set — Mana used ${show(r.rc)}` : "    owner was already set");
  }
  if (!before) {
    console.log("2b/4 Registering a placeholder producer key for the contract (no node uses it) ...");
    const placeholder = Signer.fromSeed(crypto.randomBytes(32).toString("hex"));
    const r = await send([await op(k, "register_key", { public_key: pubKeyB64(placeholder) })], [owner]);
    if (!r.ok) throw new Error(`placeholder key failed: ${r.error}`);
    console.log(`    registered — Mana used ${show(r.rc)}`);
  }
  const i = await info(contract);
  Object.assign(st, { contract: i.contract, owner: i.owner, koin: i.koin, vhp: i.vhp, pob: i.pob, helper: helper.getAddress() });
  writeState(st);
  console.log(`    contract ${i.contract}   owner ${i.owner}\n    KOIN ${i.koin}   VHP ${i.vhp}   PoB ${i.pob}`);

  const kc = token(i.koin);
  const contractKoin = BigInt(i.koin_balance ?? 0);
  if (contractKoin < BigInt(sat(CFG.fundContract))) {
    console.log(`3/4 Sending ${CFG.fundContract} tKOIN to the contract ...`);
    const amt = BigInt(sat(CFG.fundContract)) - contractKoin;
    const r = await send([await op(kc, "transfer", { from: owner.getAddress(), to: i.contract, value: amt.toString() })], [owner]);
    if (!r.ok) throw new Error(`funding the contract failed: ${r.error}`);
  }
  const helperKoin = await balance(i.koin, helper.getAddress());
  if (helperKoin < BigInt(sat(CFG.fundHelper))) {
    console.log(`4/4 Sending ${CFG.fundHelper} tKOIN to the helper ...`);
    const amt = BigInt(sat(CFG.fundHelper)) - helperKoin;
    const r = await send([await op(kc, "transfer", { from: owner.getAddress(), to: helper.getAddress(), value: amt.toString() })], [owner]);
    if (!r.ok) throw new Error(`funding the helper failed: ${r.error}`);
  }
  console.log("\nSetup done. Next: npm run probes -- run");
}

// ───────────────────────── the probes ─────────────────────────

type Row = { id: string; what: string; expect: "succeed" | "fail"; pass: boolean; rc: string; note: string };
const rows: Row[] = [];

// A refusal only proves something if it was refused for the right reason, not for lack of Mana.
const RESOURCE_ERR = /insufficient (rc|mana)|rc limit|max.?payer.?rc|exceed.*(rc|resource|compute|disk|network)|not enough (rc|mana)/i;

function record(id: string, what: string, expect: "succeed" | "fail", r: Sent, check = true, note = "") {
  const resourceRefusal = !r.ok && RESOURCE_ERR.test(r.error ?? "");
  const pass = expect === "succeed" ? r.ok && check : !r.ok && !resourceRefusal;
  if (resourceRefusal) note = expect === "fail"
    ? "INCONCLUSIVE — refused for lack of Mana, not by the security rule; rerun later"
    : "INCONCLUSIVE — not enough Mana right now; rerun after Mana refills";
  const why = !pass && r.error ? ` — ${r.error.slice(0, 160)}` : !pass && expect === "succeed" && r.ok ? " — went through but the check failed" : "";
  const shownNote = resourceRefusal ? `${note}: ${r.error!.slice(0, 90)}` : expect === "fail" && r.error ? `refused as expected: ${r.error.slice(0, 90)}` : note;
  rows.push({ id, what, expect, pass, rc: r.rc, note: (shownNote + why).trim() });
  console.log(`${pass ? "PASS" : "FAIL"}  ${id.padEnd(4)} ${what}${r.ok ? `   (Mana ${show(r.rc)})` : ""}`);
  if (shownNote || why) console.log(`          ${(shownNote + why).trim()}`);
}

async function cmdRun() {
  guardNetwork();
  const owner = signerFrom("OWNER_WIF");
  const contract = signerFrom("CONTRACT_WIF");
  const helper = signerFrom("HELPER_WIF");
  const st = readState();
  if (!st.deployed || !st.owner) throw new Error("Run setup first: npm run probes -- setup");
  const k = kprobeContract(contract);
  const C = contract.getAddress(), O = owner.getAddress(), H = helper.getAddress();
  const koinC = token(st.koin), vhpC = token(st.vhp);
  const pobC = new Contract({ id: st.pob, abi: pobAbi as any, provider });
  const D = sat(CFG.deposit);

  // P1 — the contract can see itself and the chain
  const i0 = await info(contract);
  record("P1", "info: own address, owner, system contracts, balances, Mana, height", "succeed", { ok: true, rc: "0" },
    i0.contract === C && i0.owner === O && !!i0.koin && !!i0.vhp && !!i0.pob && Number(i0.head_height) > 0 && BigInt(i0.mana ?? 0) > 0n,
    `KOIN ${show(i0.koin_balance)}  VHP ${show(i0.vhp_balance)}  Mana ${show(i0.mana)}  height ${i0.head_height}`);

  record("P1b", "init cannot be run a second time", "fail",
    await send([await op(k, "init", { owner: H })], [owner, contract]));

  // Give the owner some VHP by burning tKOIN through Proof-of-Burn.
  const ownerVhp0 = await balance(st.vhp, O);
  if (ownerVhp0 < BigInt(sat(CFG.deposit * 2))) {
    const r = await send([await op(pobC, "burn", { token_amount: sat(CFG.ownerBurn), burn_address: O, vhp_address: O })], [owner]);
    record("P0", `owner burns ${CFG.ownerBurn} tKOIN into VHP (Proof-of-Burn)`, "succeed", r,
      (await balance(st.vhp, O)) >= ownerVhp0 + BigInt(sat(CFG.ownerBurn)));
  }

  // P2 — VHP deposit: approve + deposit in one transaction
  record("P2a", "deposit_vhp WITHOUT approving first is refused", "fail",
    await send([await op(k, "deposit_vhp", { from: O, amount: D })], [owner]));
  let a = await info(contract);
  let r = await send([
    await op(vhpC, "approve", { owner: O, spender: C, value: D }),
    await op(k, "deposit_vhp", { from: O, amount: D }),
  ], [owner]);
  let b = await info(contract);
  record("P2", `approve + deposit_vhp ${CFG.deposit} VHP in one transaction`, "succeed", r,
    BigInt(b.vhp_balance) - BigInt(a.vhp_balance) === BigInt(D) && BigInt(b.credited_total) - BigInt(a.credited_total) === BigInt(D),
    `contract VHP ${show(a.vhp_balance)} → ${show(b.vhp_balance)}`);
  // Owner leaves an approval open; the helper must still not be able to use it.
  await send([await op(vhpC, "approve", { owner: O, spender: C, value: D })], [owner]);
  record("P2b", "helper cannot deposit the owner's VHP, even with an open approval", "fail",
    await send([await op(k, "deposit_vhp", { from: O, amount: D })], [helper]));
  await send([await op(vhpC, "approve", { owner: O, spender: C, value: "0" })], [owner]); // close it again

  // P3 — KOIN deposit, burned 1:1 into the contract's own VHP
  a = await info(contract);
  r = await send([
    await op(koinC, "approve", { owner: O, spender: C, value: D }),
    await op(k, "deposit_koin", { from: O, amount: D }),
  ], [owner]);
  b = await info(contract);
  record("P3", `approve + deposit_koin ${CFG.deposit} KOIN → contract burns it into its own VHP`, "succeed", r,
    BigInt(b.vhp_balance) - BigInt(a.vhp_balance) === BigInt(D) && BigInt(b.koin_balance) === BigInt(a.koin_balance),
    `contract VHP ${show(a.vhp_balance)} → ${show(b.vhp_balance)}, KOIN unchanged at ${show(b.koin_balance)}`);

  // P4 — withdrawals go only to the owner of the credit
  record("P4a", "helper cannot withdraw the owner's credit", "fail",
    await send([await op(k, "withdraw_vhp", { to: O, amount: D })], [helper]));
  record("P4b", "helper cannot withdraw with no credit of its own", "fail",
    await send([await op(k, "withdraw_vhp", { to: H, amount: D })], [helper]));
  record("P4c", "owner cannot withdraw more than credited", "fail",
    await send([await op(k, "withdraw_vhp", { to: O, amount: sat(CFG.deposit * 100) })], [owner]));
  const ov = await balance(st.vhp, O);
  r = await send([await op(k, "withdraw_vhp", { to: O, amount: D })], [owner]);
  record("P4", `owner withdraws ${CFG.deposit} VHP`, "succeed", r,
    (await balance(st.vhp, O)) - ov === BigInt(D));

  // P9 — nobody can move the contract's tokens from outside, not even with the deploy key
  record("P9a", "deploy key signs a VHP transfer out of the contract", "fail",
    await send([await op(vhpC, "transfer", { from: C, to: O, value: D })], [owner, contract]));
  record("P9b", "deploy key signs a KOIN transfer out of the contract", "fail",
    await send([await op(koinC, "transfer", { from: C, to: O, value: D })], [owner, contract]));
  record("P9c", "deploy key signs a VHP approve for itself on the contract's tokens", "fail",
    await send([await op(vhpC, "approve", { owner: C, spender: O, value: D })], [owner, contract]));

  // P5 — compound: burn the contract's own KOIN above the reserve (limited by Mana)
  a = await info(contract);
  r = await send([await op(k, "compound", { keep_reserve: sat(CFG.reserve) })], [owner]);
  b = await info(contract);
  const burned = BigInt(a.koin_balance) - BigInt(b.koin_balance);
  record("P5", `compound keeps ${CFG.reserve} KOIN and burns the rest into VHP`, "succeed", r,
    burned >= 0n && BigInt(b.vhp_balance) - BigInt(a.vhp_balance) === burned && BigInt(b.koin_balance) >= BigInt(sat(CFG.reserve)),
    `burned ${show(burned)} KOIN; contract VHP ${show(a.vhp_balance)} → ${show(b.vhp_balance)}; Mana before ${show(a.mana)}`);
  a = b;
  r = await send([await op(k, "compound", { keep_reserve: sat(CFG.reserve) })], [owner]);
  b = await info(contract);
  record("P5b", "a second compound right away burns nothing (safe to run often)", "succeed", r,
    BigInt(b.koin_balance) === BigInt(a.koin_balance));

  // P6 — the contract can register a block-producer key
  const prodKey = Signer.fromSeed(crypto.randomBytes(32).toString("hex"));
  const keyB64 = pubKeyB64(prodKey);
  record("P6a", "helper cannot register a producer key", "fail",
    await send([await op(k, "register_key", { public_key: keyB64 })], [helper]));
  r = await send([await op(k, "register_key", { public_key: keyB64 })], [owner]);
  b = await info(contract);
  record("P6", "owner registers a producer key for the contract with Proof-of-Burn", "succeed", r,
    b.producer_key === keyB64, `registered ${keyB64.slice(0, 16)}…  read back ${String(b.producer_key ?? "").slice(0, 16)}…`);

  // P7 — the contract pays the Mana for a brand-new user's ping, and only for ping
  const fresh = Signer.fromSeed(crypto.randomBytes(32).toString("hex"));
  fresh.provider = provider;
  const F = fresh.getAddress();
  a = await info(contract);
  r = await send([await op(k, "ping", { note: "hello" })], [fresh], C, 1);
  b = await info(contract);
  record("P7", "a zero-KOIN account pings, the contract pays the Mana", "succeed", r,
    BigInt(b.pings) === BigInt(a.pings) + 1n && (await balance(st.koin, F)) === 0n,
    `new account ${F}; contract Mana ${show(a.mana)} → ${show(b.mana)}`);
  record("P7a", "the contract refuses to pay for anything except ping", "fail",
    await send([await op(k, "stress", { writes: 1, bins: 0 })], [fresh], C, 1));
  record("P7b", "the contract refuses to pay for a transaction with two operations", "fail",
    await send([await op(k, "ping", { note: "1" }), await op(k, "ping", { note: "2" })], [fresh], C, 1));
  record("P7c", "the contract refuses to pay for a KOIN transfer", "fail",
    await send([await op(koinC, "transfer", { from: F, to: O, value: "1" })], [fresh], C, 1));

  // P10 — the code can be replaced only with the owner's signature
  record("P10a", "deploy key alone cannot replace the code", "fail",
    await send([await uploadOp(contract, true)], [helper, contract], H, 1));
  record("P10b", "helper cannot replace the code", "fail",
    await send([await uploadOp(contract, true)], [helper], H, 1));
  const pingsBeforeUpgrade = BigInt((await info(contract)).pings ?? 0);

  // P11 — only the owner can recover the contract's funds
  record("P11", "helper cannot sweep the contract's funds", "fail",
    await send([await op(k, "sweep", {})], [helper]));

  // P8 — Mana cost of storage, for sizing the real contract
  const costs: Record<string, string> = {};
  for (const [w, n] of [[0, 0], [10, 0], [50, 0], [0, 50]] as const) {
    r = await send([await op(k, "stress", { writes: w, bins: n })], [owner], O, CFG.stressRcLimit);
    costs[`${w}w/${n}r`] = r.rc;
    record("P8", `stress: write ${w}, read ${n} storage entries`, "succeed", r);
  }
  const base = Number(costs["0w/0r"]);
  const perWrite = (Number(costs["50w/0r"]) - Number(costs["10w/0r"])) / 40;
  const perRead = (Number(costs["0w/50r"]) - base) / 50;
  console.log(`\n  Mana per storage write ≈ ${show(perWrite)} KOIN, per read ≈ ${show(perRead)} KOIN (base call ${show(base)})`);

  // P10 — last, because it costs the most Mana: the owner upgrades the code (same code) and the data survives.
  r = await send([await uploadOp(contract)], [owner], O, CFG.uploadRcLimit);
  const after = await info(contract);
  record("P10", "owner can re-upload (upgrade) the code, and the data survives", "succeed", r,
    after.owner === O && BigInt(after.pings ?? 0) === pingsBeforeUpgrade);

  // Summary
  const failed = rows.filter((x) => !x.pass);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(`${OUT_DIR}/results.json`, JSON.stringify({ when: new Date().toISOString(), rpc: RPC, contract: C, rows, perWrite, perRead }, null, 2));
  console.log(`\n${rows.length - failed.length}/${rows.length} passed.  Details: ${OUT_DIR}/results.json`);
  if (failed.length) {
    console.log("Failed: " + failed.map((x) => x.id).join(", "));
    process.exitCode = 1;
  }
}

// ───────────────────────── sweep ─────────────────────────

async function cmdSweep() {
  guardNetwork();
  const owner = signerFrom("OWNER_WIF");
  const contract = signerFrom("CONTRACT_WIF");
  const helper = signerFrom("HELPER_WIF");
  const st = readState();
  if (!st.deployed) throw new Error("Nothing deployed yet.");
  const O = owner.getAddress(), H = helper.getAddress();
  const before = await info(contract);
  console.log(`Contract holds KOIN ${show(before.koin_balance)}  VHP ${show(before.vhp_balance)}  (Mana ${show(before.mana)})`);
  const r = await send([await op(kprobeContract(contract), "sweep", {})], [owner]);
  if (!r.ok) throw new Error(`sweep failed: ${r.error}`);
  const after = await info(contract);
  console.log(`Swept to owner. Contract now holds KOIN ${show(after.koin_balance)}  VHP ${show(after.vhp_balance)}`);
  if (BigInt(after.koin_balance ?? 0) > 0n) console.log("Some KOIN is waiting for Mana to regenerate — run sweep again in a day or two.");

  // Helper: return its KOIN too, keeping a little Mana for the transaction itself.
  const hk = await balance(st.koin, H), hm = await mana(H);
  const keep = BigInt(sat(0.3));
  const amt = (hk < hm ? hk : hm) - keep;
  if (amt > 0n) {
    const r2 = await send([await op(token(st.koin), "transfer", { from: H, to: O, value: amt.toString() })], [helper], H, 0.3);
    console.log(r2.ok ? `Helper returned ${show(amt)} KOIN to the owner.` : `Helper return failed: ${r2.error}`);
  }
  console.log("\nNote: VHP the owner made with OWNER_BURN stays VHP (burning can't be undone); it is still yours.");
}

// ───────────────────────── main ─────────────────────────

const cmd = process.argv[2] ?? "help";
const cmds: Record<string, () => Promise<void>> = { keys: cmdKeys, status: cmdStatus, setup: cmdSetup, run: cmdRun, sweep: cmdSweep };
if (!cmds[cmd]) {
  console.log("Usage: npm run probes -- keys | status | setup | run | sweep");
} else {
  cmds[cmd]().catch((e) => {
    console.error("\nStopped: " + (e as Error).message);
    process.exitCode = 1;
  });
}

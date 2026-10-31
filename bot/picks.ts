/**
 * KNODEGAMES PICKS TOOL: put the Picks contract (picks/) on chain, register Who Signs Block X, and run tests on the
 * Koinos testnet. Every command that sends is a dry run (it only shows what it would do) unless you add --send.
 * Add --testnet to work on the Koinos Foundation testnet (keys in .env.testnet, settings in testnet/blockx.json).
 * Without it, the command is for MAINNET (keys in .env, settings in picks-data/deployment.json), and a mainnet send also
 * needs --mainnet on the command line (and CONFIRM_MAINNET=yes in .env), so a forgotten --testnet never reaches mainnet.
 *
 *   npm run picks -- keys [--testnet]                make PICKS_WIF (the contract's own new wallet) if it is missing
 *   npm run picks -- build-testnet --testnet         build the testnet version (audited code, test owner, 10-min waits)
 *   npm run picks -- status [--testnet]              the contract on chain: code, overrides, owner, games, announcements
 *   npm run picks -- upload [--testnet] [--send]     put the contract on the PICKS_WIF wallet, all three overrides ON
 *   npm run picks -- announce <id> [--testnet] [--send]   announce a game (owner's key); it can be applied after the wait
 *   npm run picks -- apply <id> [--testnet] [--send]      put an announced game in force (any key; the tool uses OWNER_WIF)
 *   npm run picks -- pause <id> [--testnet] [--send]      switch a game off at once (owner's key)
 *   npm run picks -- lock-test <id> --testnet --send      send one pick per block across a target's lock, report each
 *   npm run picks -- mana-test <id> --testnet --send      send 1, 3 and 7 picks in one transaction each, report the Mana
 *
 * The Picks v2 upgrade (Combo Card; docs/blockx/MAINNET-LAUNCH.md "Later: the Picks v2 upgrade", steps 2-4). Each one is
 * a dry run without --send; a mainnet send also needs --mainnet and --code 92d555d0 (the first 8 characters of v2's
 * sha256, typed by you), and every check runs on two nodes:
 *   npm run picks -- upgrade-schedule [--send]   owner announces v2's sha256; it can be uploaded 48 hours later, for 7 days
 *   npm run picks -- upgrade-upload [--send]     owner uploads v2 (PAYER_WIF, if set, pays the Mana); checks the code, the
 *                                                overrides, the owner and every game on both nodes afterwards
 *   npm run picks -- upgrade-clear [--send]      owner clears the announced hash, so the same code can't be uploaded again
 *
 * Keys come from the root .env / .env.testnet (never GitHub, never printed):
 *   PICKS_WIF   a brand-new wallet that becomes the Picks contract. Needed for the upload only; once uploaded, the
 *               contract decides for its own account (it refuses to move anything or pay Mana; new code needs the
 *               owner's key and the timelock), so this key has no power left. Never send it KOIN: it would be stuck.
 *   PAYER_WIF   pays the upload's Mana (both sign the upload). Default: OPERATOR_WIF (the bot wallet, which holds KOIN).
 *   OWNER_WIF   the KnodeGames owner (mainnet: 1635QUr…H717; testnet: the test owner from npm run bot -- keys --testnet).
 *   PLAYER_WIF  testnet only: the test player for lock-test and mana-test.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { Signer, Provider, Contract, Transaction, utils } from "koilib";
import { showKoin, toSat } from "./chain.ts";
import { contractMetadata } from "./chaincheck.ts";
import { isMainnet, TESTNET } from "./bot.ts";
await import("../blockx-math.js");
const X: any = (globalThis as any).KBlockX;

const E = process.env;
const log = (...a: any[]) => console.log(...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isAddr = (a: unknown): a is string => typeof a === "string" && /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a);
const sha256hex = (b: Uint8Array) => crypto.createHash("sha256").update(b).digest("hex");
const readJson = (f: string, d: any = null) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : d);
const writeJson = (f: string, v: any) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2) + "\n"); };

/** The audited Picks build (picks/README.md "Build"; audit + fix-check 2026-10-27). Mainnet upload refuses any other. */
export const PICKS_SHA256 = "700c296a1064b904299c156061d6caf8fcabd0b1765968903f29d89d2426c594";
/** Picks v2 (the CARD type, for the Combo Card): formal audit 2026-10-28 and Repo Lens final audit 2026-10-30, "ready for
 *  mainnet" (docs/history/AUDIT-2026-10-28-combo.md, AUDIT-2026-10-30-combo-repolens.md). It is uploaded over v1 by the
 *  owner's timelocked upgrade; this tool accepts it as the audited code on chain and its ABI for owner calls (audit
 *  BX-19 / BX-21, with the Combo chat 2026-10-30). Block X's calls encode the same bytes with either ABI. */
export const PICKS_V2_SHA256 = "92d555d0680157854452e35162c1b1c5c100904996194b8c1c848df50e5e1c3d";
export const AUDITED_PICKS = [PICKS_SHA256, PICKS_V2_SHA256];
export const MAINNET_OWNER = "1635QUrBNDp7WqmFkRvrkGwjJXTtFvH717";
export const MAINNET_CHAIN_ID = "EiBZK_GGVP0H_fXVAM3j6EAuz3-B-l3ejxRSewi7qIBfSA==";
const MAINNET_RPCS = ["https://koinos.armana.io", "https://api.koinosblocks.com"];
/** Audit BX-9/BX-20: the second, independent mainnet node every on-chain check also asks (RPC_CHECK overrides). */
const MAINNET_CHECK_RPC = () => E.RPC_CHECK && E.RPC_CHECK !== "off" ? E.RPC_CHECK : "https://api.koinosblocks.com";
/** Audit BX-21: the Picks ABI the owner calls are encoded with (picks/abi/picks.koilib.json, from the audited build). */
export const PICKS_ABI_SHA256 = "8efa3ad40d3d0bd9a3bfe22533fa2f9ca14445174095c66d3d34b1fc88e0a1ff";
export const PICKS_V2_ABI_SHA256 = "cea9b0736ce989e9b995735bf1330d6891861c999109c8ad7afacb1ce0f96aed";
const ABI_FILE = "picks/abi/picks.koilib.json";
const MAINNET_WASM = "picks/build/release/contract.wasm";
const TESTNET_WASM = "picks/build/testnet/contract.wasm", TESTNET_MANIFEST = "picks/build/testnet/manifest.json";
const MAINNET_STATE = path.join("picks-data", "deployment.json");
const TESTNET_CONFIG = path.join("testnet", "blockx.json");
/** Mainnet games this tool may register: Who Signs Block X, exactly as in claude/builds/03-block-x-plan.md. */
const MAINNET_GAMES = [{ ...X.MAINNET_GAME, name: "Who Signs Block X" }];
/** The picks per wallet per day and changes per pick the Picks contract allows at most. */
const MAX_PICKS_PER_DAY = 50, MAX_CHANGES = 50;

const loadAbi = () => {
  if (!fs.existsSync(ABI_FILE)) throw new Error(`${ABI_FILE} not found: in the picks folder run npm ci --ignore-scripts, npm test`);
  const raw = fs.readFileSync(ABI_FILE);
  if (![PICKS_ABI_SHA256, PICKS_V2_ABI_SHA256].includes(sha256hex(raw))) throw new Error(`${ABI_FILE} is not the audited Picks ABI (sha256 ${sha256hex(raw)}). Restore it: git checkout -- ${ABI_FILE}`);
  return JSON.parse(raw.toString("utf8"));
};
const need = (k: string) => { if (!E[k]) throw new Error(`${k} is missing from ${TESTNET ? ".env.testnet" : ".env"} (npm run picks -- keys${TESTNET ? " --testnet" : ""})`); return E[k]!; };

// ═══════════════════════════════ the network ═══════════════════════════════
type Net = { testnet: boolean; rpc: string[]; chainId: string | null; owner: string; picks: string | null; games: any[]; cfg: any };
/** Where this command works. Testnet: testnet/blockx.json. Mainnet: picks-data/deployment.json and the audited facts. */
export function network(testnet = TESTNET): Net {
  if (testnet) {
    const cfg = readJson(TESTNET_CONFIG);
    if (!cfg || cfg.network !== "koinos-foundation-testnet") throw new Error(`${TESTNET_CONFIG} is missing or not a testnet config.`);
    if (cfg.chainId === MAINNET_CHAIN_ID) throw new Error(`${TESTNET_CONFIG} names the MAINNET chain id. Refusing.`);
    const owner = readJson(TESTNET_MANIFEST)?.owner ?? (E.OWNER_WIF ? Signer.fromWif(E.OWNER_WIF).getAddress() : "");
    return { testnet: true, rpc: [E.TESTNET_RPC || cfg.rpc], chainId: cfg.chainId ?? null, owner, picks: isAddr(cfg.picks) ? cfg.picks : null, games: cfg.games, cfg };
  }
  const st = readJson(MAINNET_STATE);
  // Audit BX-47: one primary node only (koilib would quietly fall back to the second, which is the check node).
  return { testnet: false, rpc: [E.RPC || MAINNET_RPCS[0]], chainId: MAINNET_CHAIN_ID, owner: MAINNET_OWNER, picks: isAddr(st?.contract) ? st.contract : null, games: MAINNET_GAMES, cfg: st };
}
/** A provider for the network, after checking the node is on the expected chain (never sign for the wrong one). */
async function connect(net: Net) {
  const p = new Provider(net.rpc);
  const id = await p.getChainId();
  if (net.testnet && id === MAINNET_CHAIN_ID) throw new Error(`The node ${net.rpc[0]} is on MAINNET, but this is a --testnet command. Nothing was sent.`);
  if (net.chainId && id !== net.chainId) throw new Error(`The node ${net.rpc[0]} is on chain ${id}, expected ${net.chainId}. Nothing was sent.`);
  if (!net.testnet && !isMainnet(net.rpc[0])) throw new Error("This is a mainnet command, but the node looks like a testnet one. Add --testnet, or fix RPC in .env.");
  return { p, chainId: id };
}
/** A mainnet send needs --mainnet on the command line every time (review 2026-10-28: CONFIRM_MAINNET=yes is already in
 *  .env from npm run bot -- keys, so a forgotten --testnet must not be enough to reach mainnet), plus CONFIRM_MAINNET. */
export function mainnetGuard(net: { testnet: boolean }, send: boolean, argv = process.argv) {
  if (!send || net.testnet) return;
  if (!argv.includes("--mainnet")) throw new Error("This would send to MAINNET. Did you mean --testnet? For mainnet, add --mainnet to the command. Nothing was sent.");
  if (E.CONFIRM_MAINNET !== "yes") throw new Error("MAINNET: add CONFIRM_MAINNET=yes to .env first.");
}

// ═══════════════════════════════ keys ═══════════════════════════════
function signerOf(k: string, p: Provider) { const s = Signer.fromWif(need(k)); s.provider = p; return s; }
/** The contract's own wallet: brand-new, never the owner or player. */
function picksKey(net: Net, p: Provider) {
  const s = signerOf("PICKS_WIF", p), a = s.getAddress();
  const taken: Record<string, string> = { [net.owner]: "the owner wallet", [MAINNET_OWNER]: "the mainnet owner", "1Mpmf2ERhjYpX7CCiM11WERuM4j17uT1sr": "the game contract",
    "1EN7xU8R9tQXjHvrX79qZvvvGkkKWVnB5K": "the race contract", "1ByDDSBUzy5zkRceELc54Jh8i41yNRoKt8": "the Mana sponsor", "1FKTpXBhhHEbu5vVchM8UsVbAvPArJsRmR": "Knode Swap" };
  if (E.PLAYER_WIF) taken[Signer.fromWif(E.PLAYER_WIF).getAddress()] = "the test player";
  const mainPicks = readJson(MAINNET_STATE)?.contract;
  if (net.testnet && isAddr(mainPicks)) taken[mainPicks] = "the MAINNET Picks contract";
  if (taken[a]) throw new Error(`PICKS_WIF is ${taken[a]}'s key. The Picks contract needs a brand-new wallet of its own.`);
  if (net.picks && net.picks !== a) throw new Error(`PICKS_WIF belongs to ${a}, but the settings say the Picks contract is ${net.picks}.`);
  return s;
}
function ownerKey(net: Net, p: Provider) {
  const s = signerOf("OWNER_WIF", p);
  if (s.getAddress() !== net.owner) throw new Error(`OWNER_WIF belongs to ${s.getAddress()}, not the Picks owner ${net.owner}.`);
  return s;
}
/** keys: add PICKS_WIF to the env file if it is missing. Prints the address, never the key. */
function keys() {
  const file = path.resolve(TESTNET ? ".env.testnet" : ".env");
  let text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (/^PICKS_WIF=/m.test(text)) { log(`PICKS_WIF already exists in ${file}: ${Signer.fromWif(text.match(/^PICKS_WIF=(.*)$/m)![1].trim()).getAddress()}`); return; }
  const wif = Signer.fromSeed(crypto.randomBytes(32).toString("hex")).getPrivateKey("wif");
  text = (text.trim() ? text.replace(/\s*$/, "\n") : "") + `PICKS_WIF=${wif}\n`;
  fs.writeFileSync(file, text, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
  log(`Added PICKS_WIF (new) to ${file}. The Picks contract will live at:\n  ${Signer.fromWif(wif).getAddress()}`);
  log("Don't send KOIN to this address: once the contract is uploaded it refuses to move anything out of its own account,");
  log("so anything sent there stays there for good. The upload's Mana is paid by another wallet (PAYER_WIF, else OPERATOR_WIF).");
  if (!TESTNET) log("Write its recovery key down offline (it is only needed for the upload, but keep it until the upload is checked).");
}

// ═══════════════════════════════ reads ═══════════════════════════════
async function read(p: Provider, id: string, method: string, args: any = {}) {
  const c = new Contract({ id, abi: loadAbi(), provider: p });
  return ((await (c.functions as any)[method](args)).result) ?? {};
}

async function status() {
  const net = network();
  if (!net.picks) { log(`No Picks contract yet. Run: npm run picks -- keys${TESTNET ? " --testnet" : ""}, then upload.`); return; }
  const { p, chainId } = await connect(net);
  log(`Picks ${net.picks} on ${net.testnet ? "the Koinos TESTNET" : "MAINNET"} (${net.rpc[0]}, chain ${chainId})`);
  const m = await contractMetadata(p, net.picks);
  if (!m.exists) { log("  Contract       not uploaded yet (npm run picks -- upload)"); return; }
  const want: string[] = net.testnet ? [readJson(TESTNET_MANIFEST)?.sha256] : AUDITED_PICKS;
  const have = m.hash.replace(/^0x1220/, "");
  log(`  Code           sha256 ${have} ${want.includes(have) ? `✔ (the audited ${have === PICKS_V2_SHA256 ? "v2" : "build"})` : "⚠ NOT the expected build " + want.join(" or ")}`);
  log(`  Overrides      ${m.call && m.tx && m.upload ? "✔ all three ON (the contract decides for its own account)" : "⚠ NOT all on: the upload key still controls it. Do not announce games."}`);
  try { const n = await assertAuditedContract(net, p); log(`  Checked on     ${n} node${n > 1 ? "s (both agree)" : " (the testnet has one public node)"} ✔`); }
  catch (e) { log(`  ⚠ ${(e as Error).message}`); }
  const cfg = await read(p, net.picks, "get_config");
  log(`  Owner          ${cfg.owner}${cfg.owner === net.owner ? " ✔" : " ⚠ not " + net.owner}${cfg.pending_owner ? `  (handover proposed to ${cfg.pending_owner})` : ""}`);
  if (cfg.upgrade_eta && cfg.upgrade_eta !== "0") log(`  Upgrade        announced: ${cfg.upgrade_hash}, from ${new Date(Number(cfg.upgrade_eta)).toISOString()}`);
  const games = (await read(p, net.picks, "list_games")).games ?? [];
  log(`  Games          ${games.length ? "" : "none yet (npm run picks -- announce 2)"}`);
  for (const g of games) log(`    ${g.id} ${g.name}: ${g.enabled ? "ON" : "off"}, every ${g.round_size} blocks, locks ${g.lead} before, opens ${g.ahead} ahead, ${g.max_picks_per_day} picks a day, ${g.max_changes} changes`);
  const pend = (await read(p, net.picks, "list_pending", { limit: 50 })).pending ?? [];
  for (const x of pend) log(`  Announced      game ${x.game?.id} (${x.game?.name}): can be applied from ${new Date(Number(x.eta)).toISOString()}${Date.now() >= Number(x.eta) ? " — ready now: npm run picks -- apply " + x.game?.id : ""}`);
  log(`  Mana           contract wallet ${showKoin(await p.getAccountRc(net.picks))}`);
}

// ═══════════════════════════════ upload ═══════════════════════════════
/** The build to upload and why it is the right one. Exported for the tests. */
export function uploadBuild(testnet: boolean, files = { mainnet: MAINNET_WASM, testnet: TESTNET_WASM, manifest: TESTNET_MANIFEST }) {
  if (!testnet) {
    if (!fs.existsSync(files.mainnet)) throw new Error(`${files.mainnet} not found: in the picks folder run npm ci --ignore-scripts, npm test`);
    const wasm = fs.readFileSync(files.mainnet), h = sha256hex(wasm);
    if (!AUDITED_PICKS.includes(h)) throw new Error(`${files.mainnet} is not the audited Picks build (sha256 ${h}, expected ${AUDITED_PICKS.join(" or ")}). Rebuild: cd picks, npm ci --ignore-scripts, npm test (best in a clean copy with no .env).`);
    return { wasm, sha256: h, what: "the audited mainnet build" };
  }
  const man = readJson(files.manifest);
  if (!man || !fs.existsSync(files.testnet)) throw new Error("No testnet build yet: npm run picks -- build-testnet --testnet");
  const wasm = fs.readFileSync(files.testnet), h = sha256hex(wasm);
  if (!AUDITED_PICKS.includes(man.auditedSha256)) throw new Error(`The testnet build was made from ${man.auditedSha256}, not the audited ${AUDITED_PICKS.join(" or ")}. Rebuild it.`);
  if (man.sha256 !== h) throw new Error("The testnet build doesn't match its manifest. Rebuild it: npm run picks -- build-testnet --testnet");
  if (AUDITED_PICKS.includes(h)) throw new Error("The testnet build is the mainnet build (its owner would be the mainnet owner). Rebuild it.");
  return { wasm, sha256: h, what: `the testnet build (audited code, owner ${man.owner}, waits of ${man.timelockMs / 60000} min)` };
}

/** The upload transaction: the Picks wallet signs the upload (all three overrides on), another wallet signs to pay
 *  the Mana. Exported for the tests (with a nonce given, it needs no node until it is sent). */
export async function uploadTx(p: Provider, s: Signer, payer: Signer, wasm: Uint8Array, abi: any, chainId: string, rc: bigint, nonce?: string) {
  const A = s.getAddress();
  const c = new Contract({ id: A, abi, provider: p, signer: s, bytecode: new Uint8Array(wasm) });
  const { operation } = await c.deploy({ abi: JSON.stringify(abi), authorizesCallContract: true, authorizesTransactionApplication: true, authorizesUploadContract: true, onlyOperation: true } as any);
  const tx = new Transaction({ signer: s, provider: p, options: { payer: payer.getAddress(), chainId, rcLimit: rc.toString(), ...(nonce ? { nonce } : {}) } });
  await tx.pushOperation(operation);
  await tx.prepare();
  await tx.sign();                                    // the Picks wallet authorizes the upload
  await payer.signTransaction(tx.transaction as any); // the payer authorizes paying its Mana
  return tx;
}

async function upload(send: boolean) {
  const net = network();
  mainnetGuard(net, send);
  const { p, chainId } = await connect(net);
  const s = picksKey(net, p), A = s.getAddress();
  const b = uploadBuild(net.testnet);
  const m = await contractMetadata(p, A);
  if (m.exists) throw new Error(`${A} already has a contract (sha256 ${m.hash}). See npm run picks -- status.`);
  // Audit BX-22: the Picks wallet must be brand new and empty: once uploaded it can never move anything out.
  const koinId = net.testnet ? net.cfg?.koin : "19GYjDBVXU7keLbYvMLazsGQn3GTWHjHkK";
  const held = koinId ? BigInt(((await (new Contract({ id: koinId, abi: utils.tokenAbi, provider: p }).functions as any).balanceOf({ owner: A })).result?.value) ?? "0") : 0n;
  const used = BigInt(await p.getNonce(A).catch(() => 0));
  if (held > 0n) throw new Error(`The Picks wallet ${A} holds ${showKoin(held)} KOIN. Once uploaded it could never move it out. Use a brand-new, empty wallet (delete PICKS_WIF from the env file and run keys again), or move the KOIN out first.`);
  if (used > 0n) throw new Error(`The Picks wallet ${A} has already sent transactions. Use a brand-new wallet.`);
  const abi = loadAbi();
  // The Mana is paid by another wallet, so the Picks wallet never needs KOIN (anything it held would be stuck there).
  const payerKey = E.PAYER_WIF ? "PAYER_WIF" : "OPERATOR_WIF";
  if (!E[payerKey]) throw new Error(`${payerKey} is missing from ${net.testnet ? ".env.testnet" : ".env"}: the wallet that pays the upload's Mana.`);
  const payer = signerOf(payerKey, p), PA = payer.getAddress();
  if (PA === A) throw new Error(`${payerKey} is the Picks wallet itself; use another wallet to pay the Mana.`);
  const have = BigInt(await p.getAccountRc(PA));
  // Mainnet storage costs far more Mana than the testnet's (2026-10-30: two mainnet sends with a 17-Mana limit were
  // refused "insufficient rc" with 103 Mana in the payer wallet; nothing was charged). The same estimate as the sponsor
  // upload on mainnet: 1.2 Mana per KB + 10 (about 49 for 31.9 KB). The testnet upload of 31.9 KB used 2.8.
  const needRc = toSat(Math.ceil(b.wasm.length / 1024 * (net.testnet ? 0.35 : 1.2) + (net.testnet ? 5 : 10)));
  log(`Picks wallet       ${A}${net.testnet ? "  (testnet)" : "   ⚠ MAINNET"}  (send it no KOIN)`);
  log(`Code               ${b.what}, ${(b.wasm.length / 1024).toFixed(1)} KB, sha256 ${b.sha256}`);
  log(`Overrides          all three ON: it refuses to move anything or pay Mana; new code only by the owner after the wait`);
  log(`Mana paid by       ${PA} (${payerKey}): has ${showKoin(have)}, the upload may use up to ${showKoin(needRc)} (Mana not used is not charged)`);
  // Audit BX-34: the transaction uses the payer's nonce. If the payer is the hourly bot's wallet (OPERATOR_WIF), a bot
  // transaction at the same moment can take that nonce and this upload is refused (nothing happens; run it again).
  if (payerKey === "OPERATOR_WIF") log(`                   (tip: set PAYER_WIF to a wallet the hourly bot doesn't use, so their nonces can't collide)`);
  if (have < needRc) throw new Error(`${PA} needs at least ${showKoin(needRc)} Mana; it has ${showKoin(have)}. Send it ${net.testnet ? "test KOIN (faucet)" : "KOIN"} first.`);
  if (!send) { log("\nDry run only. Nothing was sent. Run again with --send to upload."); return; }
  const tx = await uploadTx(p, s, payer, b.wasm, abi, chainId, needRc);
  const receipt: any = await tx.send();
  if (receipt?.reverted) throw new Error(`upload reverted: ${JSON.stringify(receipt.logs)}`);
  await tx.wait("byBlock", 300_000).catch(() => { throw new Error("Sent but not confirmed within 5 minutes. Check npm run picks -- status in a few minutes."); });
  // Audit BX-9/BX-20: the code and all three overrides, confirmed on two nodes on mainnet, before anything else.
  try { await assertAuditedContract({ testnet: net.testnet, picks: A, cfg: net.cfg }, p, contractMetadata, b.sha256); }
  catch (e) { throw new Error(`Uploaded, but not as expected: ${(e as Error).message} Do not announce games; check npm run picks -- status.`); }
  const rec = { contract: A, wasmSha256: b.sha256, uploadTx: tx.transaction?.id, uploadedAt: new Date().toISOString() };
  if (net.testnet) writeJson(TESTNET_CONFIG, { ...net.cfg, chainId, picks: A, picksSha256: b.sha256, vhp: net.cfg.vhp ?? (await findVhp(p)) ?? null, uploadTx: rec.uploadTx, uploadedAt: rec.uploadedAt });
  else writeJson(MAINNET_STATE, { network: "mainnet", rpc: net.rpc[0], ...rec });
  log(`✔ uploaded (Mana used ${showKoin(receipt?.rc_used)}). Saved ${net.testnet ? TESTNET_CONFIG : MAINNET_STATE} (public; commit it). Next: npm run picks -- announce 2${net.testnet ? " --testnet" : ""}`);
}
/** The VHP token on a testnet: the contract whose burn event every block has (the block reward burns VHP). */
async function findVhp(p: Provider): Promise<string | null> {
  try {
    const head: any = await p.getHeadInfo();
    const h = Number(head.head_topology.height);
    const res: any = await p.call("block_store.get_blocks_by_height", { head_block_id: head.head_topology.id, ancestor_start_height: String(Math.max(1, h - 20)), num_blocks: 20, return_block: false, return_receipt: true });
    const burn = new Map<string, number>();
    for (const it of res.block_items ?? []) for (const ev of it.receipt?.events ?? []) if (/burn/i.test(ev.name ?? "")) burn.set(ev.source, (burn.get(ev.source) ?? 0) + 1);
    const koin = readJson(TESTNET_CONFIG)?.koin;
    for (const [id] of [...burn.entries()].sort((a, b) => b[1] - a[1])) {
      if (id === koin || !isAddr(id)) continue;
      const sym: any = await p.call("chain.read_contract", { contract_id: id, entry_point: 0xb76a7ca1, args: "" }).catch(() => null);   // symbol()
      const txt = sym?.result ? Buffer.from(utils.decodeBase64url(sym.result)).toString("utf8") : "";
      if (/VHP/.test(txt)) return id;
    }
    return null;
  } catch { return null; }
}

// ═══════════════════════════════ games ═══════════════════════════════
/** The game_config the contract takes for a Block X game (one producer, locked by block height). Exported for the tests. */
export function buildGameConfig(g: any, enabled = true) {
  X.forGame(g);   // the contract's own limits for a height game (lead ≥ 100, ahead > lead, ...)
  if (typeof g.name !== "string" || !g.name || Buffer.byteLength(g.name) > 40) throw new Error("A game needs a name of 1 to 40 bytes.");
  if (!(g.id >= 1 && g.id < 128)) throw new Error("Game ids are 1 to 127.");
  if (!(g.picksPerDay >= 1 && g.picksPerDay <= MAX_PICKS_PER_DAY)) throw new Error("Picks per day must be 1 to 50.");
  if (!(g.maxChanges >= 0 && g.maxChanges <= MAX_CHANGES)) throw new Error("Changes must be 0 to 50.");
  return { id: g.id, name: g.name, kind: 1, list_size: 1, number_min: "0", number_max: "0", lock_mode: 1, round_size: String(g.round), round_offset: String(g.offset),
    lead: String(g.lead), ahead: String(g.ahead), max_picks_per_day: g.picksPerDay, max_changes: g.maxChanges, enabled };
}
function gameOf(net: Net, id: number) {
  const g = net.games.find((x) => x.id === id);
  if (!g) throw new Error(`Game ${id} is not one this tool registers on ${net.testnet ? "the testnet (testnet/blockx.json)" : "mainnet (Who Signs Block X is game 2)"}.`);
  return g;
}
async function sendCall(net: Net, p: Provider, chainId: string, signer: Signer, method: string, args: any, rcKoin = 2) {
  const c = new Contract({ id: net.picks!, abi: loadAbi(), provider: p, signer });
  const { operation } = await (c.functions as any)[method](args, { onlyOperation: true });
  return sendOps(p, chainId, signer, [operation], rcKoin);
}
/** A nonce as the chain encodes it: koinos.chain.value_type with uint64_value (field 5, a varint), base64url. */
export function encodeNonce(n: number): string {
  const b: number[] = [0x28];
  let v = BigInt(n);
  do { let x = Number(v & 0x7fn); v >>= 7n; if (v > 0n) x |= 0x80; b.push(x); } while (v > 0n);
  return utils.encodeBase64url(new Uint8Array(b));
}
type SendOpts = { nonce?: number; wait?: boolean };
/** Send operations from one signer who pays its own Mana; report the block it landed in. With a nonce and wait false
 *  it only submits (for a pick per block, lock-test); call waitFor afterwards. Exported for the tests. */
export async function sendOps(p: Provider, chainId: string, signer: Signer, ops: any[], rcKoin = 2, o: SendOpts = {}) {
  const mana = BigInt(await p.getAccountRc(signer.getAddress()));
  const cap = toSat(rcKoin), limit = (mana * 95n) / 100n < cap ? (mana * 95n) / 100n : cap;
  const tx = new Transaction({ signer, provider: p, options: { payer: signer.getAddress(), chainId, rcLimit: limit.toString(), ...(o.nonce !== undefined ? { nonce: encodeNonce(o.nonce) } : {}) } });
  for (const op of ops) await tx.pushOperation(op);
  try {
    const receipt: any = await tx.send();
    if (receipt?.reverted) return { ok: false, error: `reverted: ${JSON.stringify(receipt.logs ?? [])}`, rcUsed: String(receipt?.rc_used ?? 0), txId: tx.transaction?.id, tx };
    if (o.wait === false) return { ok: true, rcUsed: String(receipt?.rc_used ?? 0), txId: tx.transaction?.id, tx };
    const w: any = await tx.wait("byBlock", 120_000).catch(() => null);
    return { ok: !!w, error: w ? undefined : "sent, not seen in a block within 2 minutes", rcUsed: String(receipt?.rc_used ?? 0), txId: tx.transaction?.id, block: w ? Number(w.blockNumber) : undefined };
  } catch (e) {
    return { ok: false, error: String((e as Error).message ?? e).slice(0, 300) };
  }
}

/** Audit BX-19: before the owner key signs anything for the Picks contract, check on chain that the address named in
 *  the settings holds exactly the expected build (mainnet: the audited one; testnet: the manifest's build) with all
 *  three overrides on. A wrong or edited deployment file can't make the owner sign for another contract. */
/** Audit BX-47: two node addresses are the same node when they match after trimming case and trailing slashes. */
export const sameNode = (a: string, b: string) => a.trim().toLowerCase().replace(/\/+$/, "") === b.trim().toLowerCase().replace(/\/+$/, "");
export async function assertAuditedContract(net: { testnet: boolean; picks: string | null; cfg?: any; rpc?: string[] }, p: Provider, meta = contractMetadata, wantOne?: string, checkNodes?: Provider[]) {
  if (!net.picks) throw new Error("No Picks contract yet.");
  const one = wantOne ?? (net.testnet ? (readJson(TESTNET_MANIFEST)?.sha256 ?? net.cfg?.picksSha256) : null);
  if (net.testnet && !one) throw new Error("No expected build for the testnet Picks contract (picks/build/testnet/manifest.json).");
  // Fix-check FC-27: once picks-data/deployment.json records the v2 code (the upgrade step writes wasmSha256), only v2
  // is accepted on chain: v1 there would be a downgrade.
  const v2Live = !net.testnet && readJson(MAINNET_STATE)?.wasmSha256 === PICKS_V2_SHA256;
  const want: string[] = one ? [one] : v2Live ? [PICKS_V2_SHA256] : AUDITED_PICKS;
  // Audit BX-9/BX-20: on mainnet a second, independent node must say the same (the testnet has one public node).
  // Audit BX-47: it must be a different node from the first, and on the mainnet chain too.
  let extra = checkNodes;
  if (!extra && !net.testnet) {
    const url = MAINNET_CHECK_RPC();
    if ((net.rpc ?? MAINNET_RPCS).slice(0, 1).some((u) => sameNode(u, url))) throw new Error(`RPC_CHECK (${url}) is the same node as RPC: the check needs a second, independent node. Nothing was signed.`);
    const cp = new Provider([url]);
    // (Tests pass their own `meta` and no network: the chain id is checked on real runs.)
    if (meta === contractMetadata && (await cp.getChainId()) !== MAINNET_CHAIN_ID) throw new Error(`The check node ${url} is not on Koinos mainnet. Nothing was signed.`);
    extra = [cp];
  }
  const nodes = [p, ...(extra ?? [])];
  for (const [i, node] of nodes.entries()) {
    const where = nodes.length > 1 ? ` (node ${i + 1} of ${nodes.length})` : "";
    const m = await meta(node, net.picks);
    if (!m.exists) throw new Error(`${net.picks} has no contract on chain${where}. Nothing was signed.`);
    const have = String(m.hash).replace(/^0x1220/, "");
    if (!want.includes(have)) throw new Error(`${net.picks} holds code ${have}${where}, not the expected Picks build ${want.join(" or ")}. Nothing was signed.`);
    if (!(m.call && m.tx && m.upload)) throw new Error(`${net.picks} does not have all three overrides on${where}. Nothing was signed.`);
  }
  return nodes.length;
}

async function announce(id: number, send: boolean) {
  const net = network();
  mainnetGuard(net, send);
  if (!net.picks) throw new Error("No Picks contract yet (npm run picks -- upload).");
  const { p, chainId } = await connect(net);
  await assertAuditedContract(net, p);
  const g = gameOf(net, id), cfg = buildGameConfig(g);
  const s = ownerKey(net, p);
  const wait = net.testnet ? (readJson(TESTNET_MANIFEST)?.timelockMs ?? 600000) / 60000 + " minutes" : "48 hours";
  log(`Announce game ${id} "${g.name}" on ${net.testnet ? "the testnet" : "MAINNET"} (owner ${s.getAddress()}):`);
  log(`  one producer per target; a target every ${g.round} blocks; locks ${g.lead} blocks before; opens ${g.ahead} ahead (${X.forGame(g).openRounds(g.ahead * 10).length} targets open at a time)`);
  log(`  ${g.picksPerDay} picks a day per wallet, ${g.maxChanges} changes per pick. It can be applied ${wait} after it is announced (anyone may apply it).`);
  if (!send) { log("\nDry run only. Nothing was sent. Add --send to send it."); return; }
  const r = await sendCall(net, p, chainId, s, "announce_game", { game: cfg });
  log(r.ok ? `✔ announced (Mana used ${showKoin(r.rcUsed)}, block ${r.block}). Then: npm run picks -- apply ${id}${net.testnet ? " --testnet" : ""} --send` : `✖ ${r.error}`);
  if (!r.ok) process.exitCode = 1;
}
async function apply(id: number, send: boolean) {
  const net = network();
  mainnetGuard(net, send);
  if (!net.picks) throw new Error("No Picks contract yet.");
  const { p, chainId } = await connect(net);
  await assertAuditedContract(net, p);
  const pend = (await read(p, net.picks, "get_game", { game: id })).pending;
  if (!pend) throw new Error(`Nothing is announced for game ${id}.`);
  const eta = Number(pend.eta);
  log(`Apply game ${id} "${pend.game?.name}": announced, can be applied from ${new Date(eta).toISOString()}${Date.now() < eta ? ` (in ${Math.ceil((eta - Date.now()) / 60000)} min)` : " ✔ now"}`);
  if (!send) { log("\nDry run only. Nothing was sent. Add --send to send it."); return; }
  const r = await sendCall(net, p, chainId, ownerKey(net, p), "apply_game", { game: id });
  log(r.ok ? `✔ game ${id} is in force (Mana used ${showKoin(r.rcUsed)})` : `✖ ${r.error}`);
  if (!r.ok) process.exitCode = 1;
}
async function pause(id: number, send: boolean) {
  const net = network();
  mainnetGuard(net, send);
  if (!net.picks) throw new Error("No Picks contract yet.");
  const { p, chainId } = await connect(net);
  await assertAuditedContract(net, p);
  const g = (await read(p, net.picks, "get_game", { game: id })).game;
  if (!g) throw new Error(`Game ${id} isn't registered.`);
  const off = { ...g, enabled: false };
  log(`Switch game ${id} "${g.name}" OFF at once (picks already made stay recorded; switching it on again needs an announcement and the wait).`);
  if (!send) { log("\nDry run only. Nothing was sent. Add --send to send it."); return; }
  const r = await sendCall(net, p, chainId, ownerKey(net, p), "tighten_game", { game: off });
  log(r.ok ? `✔ game ${id} is off` : `✖ ${r.error}`);
  if (!r.ok) process.exitCode = 1;
}

// ═══════════════════════════════ the Picks v2 upgrade ═══════════════════════════════
/** The testnet v2 build (tools/combo-testnet.mjs build): the audited v2 source with the test owner and 10-minute waits. */
const TESTNET_V2_DIR = path.join("picks", "build", "testnet-v2");
/** Does compiled AssemblyScript hold this address as a string literal (UTF-16)? (Repo Lens RL-23.) */
export const wasmHasAddress = (wasm: Uint8Array, a: string) => !!a && Buffer.from(wasm).indexOf(Buffer.from(a, "utf16le")) >= 0;
/** What the upgrade replaces (`from`, the code on chain now) and uploads (`to`). Mainnet: v1 → the audited v2, by hash.
 *  Testnet: the testnet v1 build → the testnet v2 build, which must come from the audited v2 source, hold its manifest's
 *  owner and not the mainnet owner. Exported for the tests. */
export function upgradeBuilds(testnet: boolean, files = { mainnet: MAINNET_WASM, v2dir: TESTNET_V2_DIR, v1manifest: TESTNET_MANIFEST }, cfg: any = null) {
  if (!testnet) {
    if (!fs.existsSync(files.mainnet)) throw new Error(`${files.mainnet} not found: in the picks folder run npm ci --ignore-scripts, npm test`);
    const wasm = fs.readFileSync(files.mainnet), h = sha256hex(wasm);
    if (h !== PICKS_V2_SHA256) throw new Error(`${files.mainnet} is not the audited Picks v2 build (sha256 ${h}, expected ${PICKS_V2_SHA256}). Build it on the combo branch: cd picks, npm ci --ignore-scripts, npm test.`);
    return { from: PICKS_SHA256, to: { wasm, sha256: h, what: "the audited Picks v2 build" } };
  }
  const m = path.join(files.v2dir, "manifest.json"), w = path.join(files.v2dir, "contract.wasm");
  if (!fs.existsSync(m) || !fs.existsSync(w)) throw new Error(`No testnet v2 build yet (${files.v2dir}): node tools/combo-testnet.mjs build --home <dir>`);
  const man = readJson(m), wasm = fs.readFileSync(w), h = sha256hex(wasm);
  if (man?.version !== 2 || man.network !== "koinos-foundation-testnet" || man.sha256 !== h) throw new Error(`${files.v2dir} doesn't match its manifest: build it again.`);
  if (man.auditedSha256 !== PICKS_V2_SHA256) throw new Error(`The testnet v2 build was made from ${man.auditedSha256}, not the audited v2 ${PICKS_V2_SHA256}. Build it again.`);
  if (h === PICKS_V2_SHA256 || wasmHasAddress(wasm, MAINNET_OWNER)) throw new Error("The testnet v2 build holds the MAINNET owner. Build it again with the test owner.");
  if (!wasmHasAddress(wasm, man.owner)) throw new Error(`The testnet v2 build doesn't hold the owner ${man.owner} its manifest names. Build it again.`);
  const from = readJson(files.v1manifest)?.sha256 ?? cfg?.picksSha256;
  if (!from) throw new Error("No testnet v1 build is known (picks/build/testnet/manifest.json or testnet/blockx.json picksSha256).");
  return { from, to: { wasm, sha256: h, what: `the testnet v2 build (audited v2 source, owner ${man.owner})` } };
}
/** A mainnet upgrade send needs --code with the first 8 characters of the code's sha256, typed on the command line, so
 *  nobody sends it by running a command from history or a copied line by mistake. Exported for the tests. */
export function codeGuard(net: { testnet: boolean }, send: boolean, sha: string, argv = process.argv) {
  if (!send || net.testnet) return;
  const i = argv.indexOf("--code"), typed = i >= 0 ? argv[i + 1] : undefined;
  if (typed !== sha.slice(0, 8)) throw new Error(`To send this to MAINNET, add --code ${sha.slice(0, 8)} (the first 8 characters of the new code's sha256). Nothing was sent.`);
}
/** Where an announced upgrade stands at chain time `now`. Exported for the tests. */
export function upgradeWindow(cfg: any, want: string, now: number, lockMs = 2 * 86400000, expiryMs = 7 * 86400000) {
  const hash = String(cfg?.upgrade_hash ?? "").replace(/^0x/, "").toLowerCase(), eta = Number(cfg?.upgrade_eta ?? 0);
  if (!hash || !eta) return { state: "none" as const, eta: 0, hash: "" };
  if (now >= eta + expiryMs) return { state: "expired" as const, eta, hash };
  if (hash !== want) return { state: "other" as const, eta, hash };
  return { state: now < eta ? ("waiting" as const) : ("open" as const), eta, hash, closes: eta + expiryMs, announcedAt: eta - lockMs };
}
/** The Picks contract's config, its games and the chain's head time, on every node (mainnet: two). They must agree.
 *  Returns the agreed values and the earliest head time (the chain decides the upgrade window, not this PC's clock). */
async function readEverywhere(net: Net, p: Provider) {
  const nodes = [p];
  if (!net.testnet) nodes.push(new Provider([MAINNET_CHECK_RPC()]));
  const got = [];
  for (const n of nodes) {
    const head: any = await n.getHeadInfo();
    got.push({ cfg: await read(n, net.picks!, "get_config"), games: (await read(n, net.picks!, "list_games")).games ?? [], time: Number(head.head_block_time) });
  }
  const key = (x: any) => JSON.stringify([x.cfg.owner, x.cfg.upgrade_hash ?? "", String(x.cfg.upgrade_eta ?? "0"), x.games]);
  if (got.some((x) => key(x) !== key(got[0]))) throw new Error("The two nodes disagree about the Picks contract's settings or games. Nothing was signed; try again in a few minutes.");
  return { cfg: got[0].cfg, games: got[0].games, now: Math.min(...got.map((x) => x.time)) };
}
const when = (t: number) => new Date(t).toISOString().replace("T", " ").replace(/:\d\d\.\d+Z$/, " UTC");

/** upgrade-schedule: the owner announces v2's sha256 (runbook step 2). */
async function upgradeSchedule(send: boolean) {
  const net = network();
  mainnetGuard(net, send);
  if (!net.picks) throw new Error("No Picks contract yet.");
  const { p, chainId } = await connect(net);
  const b = upgradeBuilds(net.testnet, undefined, net.cfg);
  codeGuard(net, send, b.to.sha256);
  const n = await assertAuditedContract(net, p, contractMetadata, b.from);            // still the code it replaces
  const s = ownerKey(net, p);
  const { cfg, games, now } = await readEverywhere(net, p);
  if (cfg.owner !== s.getAddress()) throw new Error(`The contract's owner is ${cfg.owner}, not OWNER_WIF's ${s.getAddress()}.`);
  const w = upgradeWindow(cfg, b.to.sha256, now);
  if (w.state === "waiting" || w.state === "open") throw new Error(`v2 is already announced: it can be uploaded from ${when(w.eta)} until ${when(w.closes!)}. Next: npm run picks -- upgrade-upload`);
  if (w.state === "other") throw new Error(`Other code (${w.hash}) is announced. Clear it first (npm run picks -- upgrade-clear) and check why it was announced.`);
  const wait = net.testnet ? "10 minutes" : "48 hours";
  log(`Announce new code for the Picks contract ${net.picks} on ${net.testnet ? "the testnet" : "MAINNET"} (checked on ${n} node${n > 1 ? "s" : ""}):`);
  log(`  now on chain   ${b.from} (v1)`);
  log(`  new code       ${b.to.sha256} (${b.to.what}, ${b.to.wasm.length.toLocaleString("en-US")} bytes)`);
  log(`  owner          ${s.getAddress()} signs and pays (about 0.1 Mana)`);
  log(`  then           it can be uploaded ${wait} after this lands, for 7 days. Games now: ${games.map((g: any) => `${g.id} ${g.name}`).join(", ") || "none"}.`);
  log(`  public         everyone sees the announcement (the upgrade event). Publish the v2 source and its build first (runbook step 1).`);
  if (!send) { log(`\nDry run only. Nothing was sent. To send: add --send${net.testnet ? "" : ` --mainnet --code ${b.to.sha256.slice(0, 8)}`}`); return; }
  const r = await sendCall(net, p, chainId, s, "schedule_upgrade", { hash: "0x" + b.to.sha256 });
  if (!r.ok) { log(`✖ ${r.error}`); process.exitCode = 1; return; }
  const after = await readEverywhere(net, p), w2 = upgradeWindow(after.cfg, b.to.sha256, after.now);
  log(w2.state === "waiting" || w2.state === "open" ? `✔ announced (Mana used ${showKoin(r.rcUsed)}, block ${r.block}). Upload from ${when(w2.eta)} until ${when(w2.closes!)}: npm run picks -- upgrade-upload${net.testnet ? " --testnet" : ""}`
    : `⚠ sent, but the nodes don't show the announcement yet (${w2.state}). Run npm run picks -- status in a minute.`);
}

/** The upgrade's upload transaction: the owner signs (the contract allows its own upload only with the owner's signature,
 *  the announced sha256, after the wait, with all three overrides kept on); the payer signs to pay the Mana (the owner,
 *  unless another wallet is given). Exported for the tests (with a nonce given, it needs no node until it is sent). */
export async function upgradeTx(p: Provider, picks: string, owner: Signer, payer: Signer, wasm: Uint8Array, abi: any, chainId: string, rc: bigint, nonce?: string) {
  const c = new Contract({ id: picks, abi, provider: p, signer: owner, bytecode: new Uint8Array(wasm) });
  const { operation } = await c.deploy({ abi: JSON.stringify(abi), authorizesCallContract: true, authorizesTransactionApplication: true, authorizesUploadContract: true, onlyOperation: true } as any);
  const tx = new Transaction({ signer: owner, provider: p, options: { payer: payer.getAddress(), chainId, rcLimit: rc.toString(), ...(nonce ? { nonce } : {}) } });
  await tx.pushOperation(operation);
  await tx.prepare();
  await tx.sign();                                                   // the owner authorizes the upload
  if (payer.getAddress() !== owner.getAddress()) await payer.signTransaction(tx.transaction as any);   // the payer, its Mana
  return tx;
}

/** upgrade-upload: the owner uploads v2 inside the window and checks everything on both nodes (runbook step 3). */
async function upgradeUpload(send: boolean) {
  const net = network();
  mainnetGuard(net, send);
  if (!net.picks) throw new Error("No Picks contract yet.");
  const { p, chainId } = await connect(net);
  const b = upgradeBuilds(net.testnet, undefined, net.cfg);
  codeGuard(net, send, b.to.sha256);
  await assertAuditedContract(net, p, contractMetadata, b.from);
  const s = ownerKey(net, p);
  const before = await readEverywhere(net, p);
  if (before.cfg.owner !== s.getAddress()) throw new Error(`The contract's owner is ${before.cfg.owner}, not OWNER_WIF's ${s.getAddress()}.`);
  const w = upgradeWindow(before.cfg, b.to.sha256, before.now);
  if (w.state === "none") throw new Error("Nothing is announced. Run npm run picks -- upgrade-schedule first.");
  if (w.state === "other") throw new Error(`The announced code is ${w.hash}, not this build's ${b.to.sha256}. Nothing was sent.`);
  if (w.state === "expired") throw new Error(`The announcement expired at ${when(w.eta + 7 * 86400000)}. Announce again (upgrade-schedule).`);
  if (w.state === "waiting") throw new Error(`Too early: the chain allows the upload from ${when(w.eta)} (${Math.ceil((w.eta - before.now) / 60000)} min from now).`);
  if (w.closes! - before.now < 10 * 60000) throw new Error(`The window closes at ${when(w.closes!)}, in under 10 minutes: too close to send safely. Announce again.`);
  const abi = loadAbi();
  const payerKey = E.PAYER_WIF ? "PAYER_WIF" : "OWNER_WIF";
  const payer = payerKey === "PAYER_WIF" ? signerOf("PAYER_WIF", p) : s, PA = payer.getAddress();
  if (PA === net.picks) throw new Error("PAYER_WIF is the Picks contract itself (it never pays Mana).");
  const have = BigInt(await p.getAccountRc(PA));
  const needRc = toSat(Math.ceil(b.to.wasm.length / 1024 * (net.testnet ? 0.35 : 1.2) + (net.testnet ? 5 : 10)));
  log(`Upload the new code to the Picks contract ${net.picks} on ${net.testnet ? "the testnet" : "MAINNET"}:`);
  log(`  now on chain   ${b.from} (v1)  →  new code ${b.to.sha256} (${b.to.what})`);
  log(`  window         open since ${when(w.eta)}, closes ${when(w.closes!)} (chain time)`);
  log(`  signed by      the owner ${s.getAddress()}; Mana paid by ${PA} (${payerKey}): has ${showKoin(have)}, may use up to ${showKoin(needRc)}`);
  log(`  overrides      all three stay ON (the contract refuses the upload otherwise)`);
  log(`  games          ${before.games.length} (${before.games.map((g: any) => `${g.id} ${g.name}`).join(", ") || "none"}): each must read back the same under v2`);
  if (have < needRc) throw new Error(`${PA} needs at least ${showKoin(needRc)} Mana; it has ${showKoin(have)}.`);
  if (!send) { log(`\nDry run only. Nothing was sent. To send: add --send${net.testnet ? "" : ` --mainnet --code ${b.to.sha256.slice(0, 8)}`}`); return; }
  const tx = await upgradeTx(p, net.picks, s, payer, b.to.wasm, abi, chainId, needRc);
  const receipt: any = await tx.send();
  if (receipt?.reverted) throw new Error(`the upload reverted: ${JSON.stringify(receipt.logs)}. Nothing changed.`);
  await tx.wait("byBlock", 300_000).catch(() => { throw new Error("Sent but not confirmed within 5 minutes. Run npm run picks -- status in a few minutes; don't send it again."); });
  const problems: string[] = [];
  try { await assertAuditedContract(net, p, contractMetadata, b.to.sha256); } catch (e) { problems.push((e as Error).message); }
  const after = await readEverywhere(net, p).catch((e) => { problems.push((e as Error).message); return null; });
  if (after && after.cfg.owner !== before.cfg.owner) problems.push(`the owner reads ${after.cfg.owner} under v2, was ${before.cfg.owner}`);
  if (after && JSON.stringify(after.games) !== JSON.stringify(before.games)) problems.push(`the games read differently under v2:\n    before ${JSON.stringify(before.games)}\n    after  ${JSON.stringify(after.games)}`);
  if (problems.length) { log(`⚠ uploaded (tx ${tx.transaction?.id}), but: ${problems.join("; ")}. Stop here and tell Claude; don't announce game 8.`); process.exitCode = 1; return; }
  log(`✔ v2 is live (Mana used ${showKoin(receipt?.rc_used)}): code ${b.to.sha256}, all three overrides ON, the owner and all ${after!.games.length} game(s) unchanged, on ${net.testnet ? "the node" : "both nodes"}.`);
  log(`Next: npm run picks -- upgrade-clear${net.testnet ? " --testnet" : ""} (runbook step 4).`);
  if (!net.testnet) {
    log(`Then runbook step 5, by a pull request to main (Claude opens it): in picks-data/deployment.json set`);
    log(`  "wasmSha256": "${b.to.sha256}",\n  "uploadTx": "${tx.transaction?.id}",\n  "uploadedAt": "${new Date().toISOString()}"`);
  }
}

/** upgrade-clear: once v2 runs, the owner clears the announced hash, so the same code can't be uploaded again (step 4). */
async function upgradeClear(send: boolean) {
  const net = network();
  mainnetGuard(net, send);
  if (!net.picks) throw new Error("No Picks contract yet.");
  const { p, chainId } = await connect(net);
  const b = upgradeBuilds(net.testnet, undefined, net.cfg);
  await assertAuditedContract(net, p, contractMetadata, b.to.sha256);                // v2 must already run
  const s = ownerKey(net, p);
  const { cfg, now } = await readEverywhere(net, p);
  const w = upgradeWindow(cfg, b.to.sha256, now);
  if (w.state === "none") { log("✔ Nothing is announced: there is nothing to clear."); return; }
  log(`Clear the announced code ${w.hash} on the Picks contract ${net.picks} (${net.testnet ? "testnet" : "MAINNET"}), signed by the owner ${s.getAddress()} (about 0.1 Mana).`);
  log("  After this, no code can be uploaded until a new announcement and its 48-hour wait.");
  if (!send) { log(`\nDry run only. Nothing was sent. To send: add --send${net.testnet ? "" : " --mainnet"}`); return; }
  const r = await sendCall(net, p, chainId, s, "schedule_upgrade", { hash: "0x" });
  if (!r.ok) { log(`✖ ${r.error}`); process.exitCode = 1; return; }
  const after = await readEverywhere(net, p);
  if (upgradeWindow(after.cfg, b.to.sha256, after.now).state !== "none") { log("⚠ sent, but the nodes still show an announced code. Run npm run picks -- status in a minute."); process.exitCode = 1; return; }
  log(`✔ cleared (Mana used ${showKoin(r.rcUsed)}). Next: runbook step 5 (the deployment file), then npm run picks -- status${net.testnet ? " --testnet" : " --mainnet"}.`);
}

// ═══════════════════════════════ testnet checks ═══════════════════════════════
function testnetOnly(net: Net, what: string) { if (!net.testnet) throw new Error(`${what} is for the testnet only (add --testnet).`); }
const pickOp = async (p: Provider, picks: string, player: string, game: number, round: number, producer: string) =>
  (await (new Contract({ id: picks, abi: loadAbi(), provider: p }).functions as any).pick({ player, game, round: String(round), producers: [producer], number: "0" }, { onlyOperation: true })).operation;

/** Where a transaction ended up: the block that holds it and whether it was applied or reverted there. */
export async function findTx(p: Provider, txId: string): Promise<{ block: number; reverted: boolean; logs: string[] } | null> {
  const t: any = await p.call("transaction_store.get_transactions_by_id", { transaction_ids: [txId] }).catch(() => null);
  const bid = t?.transactions?.[0]?.containing_blocks?.[0];
  if (!bid) return null;
  const b: any = await p.call("block_store.get_blocks_by_id", { block_ids: [bid], return_block: true, return_receipt: true }).catch(() => null);
  const it = b?.block_items?.[0];
  if (!it) return null;
  const i = (it.block?.transactions ?? []).findIndex((x: any) => x.id === txId);
  const rec = it.receipt?.transaction_receipts?.[i] ?? {};
  return { block: Number(it.block_height), reverted: !!rec.reverted, logs: rec.logs ?? [] };
}

/**
 * lock-test: is the lock exactly where the design says (audit P-5)? Picks the next target X of a game whose lock is at
 * least 40 blocks away, then sends one pick per new block, from 6 blocks before the lock to 3 after, rotating between
 * four producers so each pick is a change even while the node still sees an earlier one. Afterwards it reads, from the
 * chain itself, the block each pick landed in and whether it was applied there, and the height the contract stored.
 * The design: accepted while the contract's height < X − lead, so the last block a pick can land in is X − lead − 1.
 */
async function lockTest(id: number, send: boolean) {
  const net = network();
  testnetOnly(net, "lock-test");
  if (!net.picks) throw new Error("No Picks contract yet.");
  const { p, chainId } = await connect(net);
  const g = (await read(p, net.picks, "get_game", { game: id })).game;
  if (!g || !g.enabled) throw new Error(`Game ${id} isn't in force yet (announce, wait, apply).`);
  const G = X.forGame({ id, round: Number(g.round_size), offset: Number(g.round_offset), lead: Number(g.lead), ahead: Number(g.ahead), picksPerDay: g.max_picks_per_day, maxChanges: g.max_changes });
  if (G.MAX_CHANGES < 5) throw new Error("lock-test needs a game that allows at least 5 changes.");
  const player = signerOf("PLAYER_WIF", p), me = player.getAddress();
  // Four valid addresses to rotate between (who they are doesn't matter; a pick only has to differ from the last).
  const choices = [net.owner, net.picks, net.cfg?.koin, net.cfg?.vhp].filter((a, i, all) => isAddr(a) && all.indexOf(a) === i) as string[];
  if (choices.length < 3) throw new Error("lock-test needs testnet/blockx.json to name koin and vhp.");
  const head = async () => Number(((await p.getHeadInfo()) as any).head_topology.height);
  let h = await head();
  const r = G.openRounds(h).find((x: number) => G.lockHeight(x) - h >= 40);
  const lock = G.lockHeight(r), target = G.target(r);
  log(`lock-test on game ${id}: target block ${target}, the contract refuses picks from height ${lock} (target − ${G.LEAD}). Head now ${h}.`);
  log(`It sends one pick per block from head ${lock - 6} to ${lock + 3} (10 picks, from ${me}), about ${Math.ceil((lock - 6 - h) * 3 / 60)} min from now.`);
  if (!send) { log("\nDry run only. Nothing was sent. Add --send to run it (it costs a little test Mana)."); return; }
  // One pick per block without waiting for each to land: each gets its own nonce (only higher than the last is needed).
  let nonce = Number(await p.getNonce(me)) + 1;
  const rows: any[] = [];
  let i = 0;
  for (let at = lock - 6; at <= lock + 3; at++) {
    while ((h = await head()) < at) await sleep(500);
    const op = await pickOp(p, net.picks, me, id, r, choices[i++ % choices.length]);
    const res: any = await sendOps(p, chainId, player, [op], 1, { nonce, wait: false });
    if (res.txId) nonce++;   // sent: it uses its nonce whether it is applied or reverts in its block
    rows.push({ sentAtHead: h, sent: !!res.txId, error: res.error, txId: res.txId });
    log(`  sent at head ${h}: ${res.txId ? "taken by the node" : `refused by the node: ${String(res.error).replace(/^.*"error":"([^"]+)".*$/, "$1")}`}`);
  }
  log("\nReading where each pick landed…");
  await sleep(12000);
  for (const x of rows) if (x.txId) Object.assign(x, (await findTx(p, x.txId)) ?? { block: null });
  const stored = (await read(p, net.picks, "get_pick", { game: id, round: String(r), player: me })).pick;
  const landed = rows.filter((x) => x.block);
  const ok = landed.filter((x) => !x.reverted), bad = landed.filter((x) => x.reverted);
  log(`\nResult for target ${target} (picks are refused once the chain reaches block ${lock}):`);
  for (const x of landed) log(`  block ${x.block} (${x.block < lock ? `lock − ${lock - x.block}` : x.block === lock ? "the lock" : `lock + ${x.block - lock}`}): ${x.reverted ? `refused, ${String(x.logs?.[0] ?? "").replace(/^transaction reverted: /, "")}` : "applied"}`);
  const last = ok.sort((a, b) => b.block - a.block)[0];
  if (last && stored) {
    log(Number(stored.height) === last.block ? `  ✔ the contract stored height ${stored.height} for the last applied pick: the height of the block it landed in (as designed).`
      : `  ⚠ the last applied pick landed in block ${last.block} but the contract stored height ${stored.height}. Tell Claude.`);
  }
  if (ok.some((x) => x.block >= lock)) log("  ✖ a pick was applied at or after the lock. Stop and tell Claude.");
  else log(`  ✔ no pick was applied at or after the lock (block ${lock}).`);
  if (ok.some((x) => x.block === lock - 1)) log(`  ✔ a pick landing in block ${lock - 1} (target − ${G.LEAD + 1}) was applied: the last block a pick can land in.`);
  else log(`  · no pick happened to land in block ${lock - 1} this run, so that exact edge wasn't seen (run it again to catch it).`);
  if (bad.some((x) => x.block === lock && /locked/.test(String(x.logs)))) log(`  ✔ a pick landing in block ${lock} (the lock) was refused: "this round is locked".`);
  writeJson(path.join("testnet-data", `lock-test-${id}-${target}.json`), { game: id, target, lock, rows, stored });
}

/** mana-test: the real Mana of a pick, alone and batched (audit S3-5), to size the sponsor and the site's Mana limit. */
async function manaTest(id: number, send: boolean) {
  const net = network();
  testnetOnly(net, "mana-test");
  if (!net.picks) throw new Error("No Picks contract yet.");
  const { p, chainId } = await connect(net);
  const g = (await read(p, net.picks, "get_game", { game: id })).game;
  if (!g || !g.enabled) throw new Error(`Game ${id} isn't in force yet.`);
  const G = X.forGame({ id, round: Number(g.round_size), offset: Number(g.round_offset), lead: Number(g.lead), ahead: Number(g.ahead), picksPerDay: g.max_picks_per_day, maxChanges: g.max_changes });
  const player = signerOf("PLAYER_WIF", p), me = player.getAddress();
  const rounds = G.offerRounds(Number(((await p.getHeadInfo()) as any).head_topology.height), 60);
  if (rounds.length < 11) throw new Error("Fewer than 11 targets are open far enough from their lock; try again in a few minutes.");
  log(`mana-test on game ${id}: 1, then 3, then 7 picks in one transaction each, from ${me} (11 of today's ${G.PICKS_PER_DAY} picks).`);
  if (!send) { log("\nDry run only. Nothing was sent. Add --send to run it."); return; }
  const out: any[] = [];
  let k = 0;
  for (const n of [1, 3, 7]) {
    const ops = [];
    for (let j = 0; j < n; j++) {
      const r = rounds[k++];
      const cur = (await read(p, net.picks, "get_pick", { game: id, round: String(r), player: me })).pick;
      const producer = cur?.producers?.[0] === net.owner ? net.picks! : net.owner;   // always a change, never "already your pick"
      ops.push(await pickOp(p, net.picks, me, id, r, producer));
    }
    const res = await sendOps(p, chainId, player, ops, 5);
    out.push({ picks: n, ...res });
    log(`  ${n} pick${n > 1 ? "s" : ""}: ${res.ok ? `${showKoin(res.rcUsed)} Mana (${showKoin(BigInt(res.rcUsed ?? "0") / BigInt(n))} each)` : `failed: ${res.error}`}`);
    await sleep(4000);
  }
  writeJson(path.join("testnet-data", `mana-test-${id}.json`), { game: id, at: new Date().toISOString(), out });
  log("Saved testnet-data/mana-test-<id>.json. Send the numbers to Claude (they size the sponsor's per-pick Mana limit).");
}

function buildTestnet() {
  if (!TESTNET) throw new Error("build-testnet is for the testnet: add --testnet.");
  const owner = Signer.fromWif(need("OWNER_WIF")).getAddress();
  if (owner === MAINNET_OWNER) throw new Error("OWNER_WIF in .env.testnet is the MAINNET owner. Use a test owner (npm run bot -- keys --testnet).");
  execFileSync(process.execPath, ["scripts/build-testnet.cjs", "--owner", owner], { cwd: "picks", stdio: "inherit" });
}

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== "--testnet");
  const [cmd = "status", ...a] = args;
  const send = a.includes("--send");
  const num = () => { const n = Number(a.find((x) => /^\d+$/.test(x))); if (!Number.isInteger(n)) throw new Error(`${cmd} needs a game id, e.g. npm run picks -- ${cmd} 2`); return n; };
  switch (cmd) {
    case "keys": return keys();
    case "build-testnet": return buildTestnet();
    case "status": return status();
    case "upload": return upload(send);
    case "announce": return announce(num(), send);
    case "apply": return apply(num(), send);
    case "pause": return pause(num(), send);
    case "lock-test": return lockTest(num(), send);
    case "mana-test": return manaTest(num(), send);
    case "upgrade-schedule": return upgradeSchedule(send);
    case "upgrade-upload": return upgradeUpload(send);
    case "upgrade-clear": return upgradeClear(send);
    default: throw new Error(`Unknown command "${cmd}". Commands: keys, build-testnet, status, upload, announce <id>, apply <id>, pause <id>, lock-test <id>, mana-test <id>, upgrade-schedule, upgrade-upload, upgrade-clear`);
  }
}
if (process.argv[1] && /picks\.ts$/.test(process.argv[1])) {
  main().catch((e) => { console.error(`\n✖ ${e.message ?? e}`); process.exit(1); });
}

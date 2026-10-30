/**
 * COMBO CARD ON THE TESTNET: upgrade the testnet Picks contract from v1 (Block X) to v2 (CARD games) through the real
 * owner + timelock path, check that the Block X games survived, register a test Combo game, and measure what cards cost
 * in Mana. Koinos Foundation testnet ONLY: it refuses a node that reports the mainnet chain id, reads keys from
 * .env.testnet only, and every command that sends is a dry run unless you add --send. It never prints a key.
 *
 * Keys and the contract address come from your Block X testnet setup (claude/blockx/TESTNET.md):
 *   --home C:\kprediction     reads C:\kprediction\.env.testnet (OWNER_WIF, PLAYER_WIF) and testnet\blockx.json
 *
 * Two ways to test (pick one):
 *   --fresh   a brand-new Combo-only testnet Picks contract (settings in testnet\combo.json): nothing else on the testnet
 *             is touched. Needs a new wallet for it: `keys --fresh` makes COMBO_PICKS_WIF in .env.testnet.
 *   (default) upgrade the shared Block X testnet contract from v1 to v2: the real upgrade path, with the Block X and
 *             Last Node test games on it. The Block X tool (npm run picks) then refuses owner commands on it until it
 *             knows the v2 build (audit BX-19), so agree it with those chats first.
 *
 *   node tools/combo-testnet.mjs keys     --home <dir> --fresh    make COMBO_PICKS_WIF (prints the address only)
 *   node tools/combo-testnet.mjs upload   --home <dir> --fresh [--send]  put v2 on that new wallet, all three overrides ON
 *   node tools/combo-testnet.mjs build    --home <dir>            build the testnet v2 (audited v2 + test owner + 10-min waits)
 *   node tools/combo-testnet.mjs status   --home <dir>            the contract: code, overrides, owner, games, upgrade waiting
 *   node tools/combo-testnet.mjs schedule --home <dir> [--send]   owner announces the v2 code (sha256); upload after 10 min
 *   node tools/combo-testnet.mjs upgrade  --home <dir> [--send]   owner uploads v2; checks code + overrides; clears the hash
 *   node tools/combo-testnet.mjs announce --home <dir> [--send]   owner announces test game 98 "Combo test" (a card game)
 *   node tools/combo-testnet.mjs apply    --home <dir> [--send]   puts game 98 in force (after 10 min)
 *   node tools/combo-testnet.mjs cards    --home <dir> [--send]   the player sends 2-, 6- and 10-leg cards, a change and a
 *                                                                 card that must be refused; prints each one's Mana
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Signer, Provider, Contract, Transaction } from "koilib";

const MAINNET_CHAIN_ID = "EiBZK_GGVP0H_fXVAM3j6EAuz3-B-l3ejxRSewi7qIBfSA==";
const MAINNET_OWNER = "1635QUrBNDp7WqmFkRvrkGwjJXTtFvH717";
const GAME = 98;                                   // the test card game (mainnet Combo Card is game 8)
const DAY_MS = 86400000, RACE_MS = 6 * 3600000, RACE_LEAD = 25 * 60000, BLOCK_LEAD = 500, BLOCK_ROUND = 2400;
const LEGS = { WIN: 1, SHOW: 2, HALF: 3, BLOCK: 4 };
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const ABI_FILE = path.join(REPO, "picks/abi/picks.koilib.json");
const V2_DIR = path.join(REPO, "picks/build/testnet-v2");
// Producers for test legs: any valid addresses (the contract checks the address, not who produces on the testnet).
const PRODUCERS = ["15NZhQoewzsbVUcSVsZ8BEBEKgaBNPLLgZ", "1MbsVfNw6yzQqA8499d8KQj8qdLyRs8CzW", "1UG4UUn7Da9JqE4PKbYUWgjbNwE5F9531", "1GGxRhLN7Ek54xycG5XaZBE4bCgwV2xtvk",
  "14f34kUNZugf2DK4hPJGy4AkmBM7Y4pvVu", "1G2QjRtNwEfqGwX7SMD8LNjWgJdWA7XtSU", "18UYKhWVCbTpFs8oYC54xoiCQQthhEkX7m", "14MHW6TF8gw8EuMRLCJc2PQHLzZLKuwGqb",
  "1DAHmrQJMAbn4FmMMrew78wPUizjVdbBrd", "1Lk4D5bYDzMeh4CFXLWTpLEeJFqKmqbkEt", "15CM9Qr4GKREDgqnyXJ8tckPj2biERTM1T", "1JrsQXbrDqkT9yUH6gtj4yhQi1kgWwsohh"];

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (m) => { console.error(`✖ ${m}`); process.exit(1); };
const arg = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
const SEND = process.argv.includes("--send");
const mana = (rc) => (Number(BigInt(rc ?? 0)) / 1e8).toFixed(4);

// ── settings ──
const HOME = arg("--home");
if (!HOME) fail("Add --home C:\\kprediction (the folder with .env.testnet and testnet\\blockx.json from the Block X testnet setup).");
function readEnv(f) {
  if (!fs.existsSync(f)) fail(`${f} not found. Run the Block X testnet setup first (claude/blockx/TESTNET.md, step 1).`);
  const out = {};
  for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) { const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line); if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, ""); }
  return out;
}
const ENV = readEnv(path.join(HOME, ".env.testnet"));
const FRESH = process.argv.includes("--fresh");
const BX_FILE = path.join(HOME, "testnet", "blockx.json"), FRESH_FILE = path.join(HOME, "testnet", "combo.json");
// blockx.json is tracked on the picks branch only, so it disappears while C:\kprediction has another branch checked out.
// Once the fresh contract exists, combo.json carries the same node and chain id, so the fresh route can do without it.
const BX = fs.existsSync(BX_FILE) ? JSON.parse(fs.readFileSync(BX_FILE, "utf8"))
  : FRESH && fs.existsSync(FRESH_FILE) ? {}
  : fail(`${BX_FILE} not found. It is on the picks branch: in ${HOME} run  git checkout picks  (or, after upload --fresh, use --fresh).`);
// --fresh: the Combo-only contract (testnet\combo.json, written by upload --fresh); its node and chain from blockx.json.
const CFG = FRESH ? { ...BX, picks: null, picksSha256: null, games: [], ...(fs.existsSync(FRESH_FILE) ? JSON.parse(fs.readFileSync(FRESH_FILE, "utf8")) : {}) } : BX;
const CFG_FILE = FRESH ? FRESH_FILE : BX_FILE;
if (CFG.network !== "koinos-foundation-testnet") fail(`${CFG_FILE} is not a testnet config.`);
if (CFG.chainId === MAINNET_CHAIN_ID) fail(`${CFG_FILE} names the MAINNET chain id. Refusing.`);
const PICKS = CFG.picks;
const abi = JSON.parse(fs.readFileSync(ABI_FILE, "utf8"));
if (!JSON.stringify(abi).includes("leg_types")) fail("picks/abi/picks.koilib.json has no CARD types: run npm test in the picks folder of this (combo) checkout.");

async function connect() {
  const p = new Provider([ENV.TESTNET_RPC || CFG.rpc]);
  const id = await p.getChainId();
  if (id === MAINNET_CHAIN_ID) fail(`The node ${CFG.rpc} is on MAINNET. This tool is testnet only. Nothing was sent.`);
  if (CFG.chainId && id !== CFG.chainId) fail(`The node is on chain ${id}, expected ${CFG.chainId}. Nothing was sent.`);
  return { p, chainId: id };
}
function signer(k, p) {
  if (!ENV[k]) fail(`${k} is missing from ${path.join(HOME, ".env.testnet")}.`);
  const s = Signer.fromWif(ENV[k]); s.provider = p;
  if (s.getAddress() === MAINNET_OWNER) fail(`${k} is the MAINNET owner's key. Refusing.`);
  return s;
}
const picksC = (p, s) => new Contract({ id: PICKS, abi, provider: p, ...(s ? { signer: s } : {}) });
const read = async (p, method, args = {}) => ((await picksC(p).functions[method](args)).result) ?? {};
async function meta(p, id) {
  const v = (await p.invokeGetContractMetadata(id))?.value;
  if (!v) return null;
  const hex = typeof v.hash === "string" ? (v.hash.startsWith("0x") ? v.hash.slice(2) : Buffer.from(v.hash, "base64url").toString("hex")) : "";
  return { sha256: hex.startsWith("1220") ? hex.slice(4) : hex, call: !!v.authorizes_call_contract, tx: !!v.authorizes_transaction_application, upload: !!v.authorizes_upload_contract };
}
/** Does compiled AssemblyScript code hold this address as a string literal (UTF-16)? */
export const wasmHasOwner = (wasm, address) => typeof address === "string" && address.length > 0 && Buffer.from(wasm).indexOf(Buffer.from(address, "utf16le")) >= 0;
function v2Build() {
  const m = path.join(V2_DIR, "manifest.json"), w = path.join(V2_DIR, "contract.wasm");
  if (!fs.existsSync(m) || !fs.existsSync(w)) fail("No testnet v2 build yet: node tools/combo-testnet.mjs build --home <dir>");
  const man = JSON.parse(fs.readFileSync(m, "utf8")), wasm = fs.readFileSync(w);
  const s = crypto.createHash("sha256").update(wasm).digest("hex");
  if (s !== man.sha256 || man.network !== "koinos-foundation-testnet" || man.version !== 2) fail("build/testnet-v2 doesn't match its manifest: build again.");
  // Repo Lens RL-23: the owner is checked in the compiled code itself, not only in the manifest. The source's owner
  // address is a string literal, which AssemblyScript stores once, as UTF-16, in the code's data: the testnet owner must
  // be there and the KnodeGames (mainnet) owner must not.
  if (wasmHasOwner(wasm, MAINNET_OWNER)) fail("build/testnet-v2/contract.wasm still holds the mainnet owner's address. Nothing was sent: build again.");
  if (!wasmHasOwner(wasm, man.owner)) fail(`build/testnet-v2/contract.wasm doesn't hold the owner ${man.owner} its manifest names. Nothing was sent: build again.`);
  return { man, wasm, sha256: s };
}
/** The v2 build must keep the owner the contract has now. A contract never handed over takes its owner from the code
 *  (INITIAL_OWNER), so a build made for another test owner would change the owner on upgrade. Also OWNER_WIF must be it. */
async function sameOwner(p, b, owner) {
  const onChain = (await read(p, "get_config")).owner;
  if (b.man.owner !== onChain) fail(`The v2 build was made for owner ${b.man.owner}, but the contract's owner is ${onChain}. Build again with that owner's OWNER_WIF in .env.testnet (node tools/combo-testnet.mjs build --home ...).`);
  if (owner.getAddress() !== onChain) fail(`OWNER_WIF is ${owner.getAddress()}, not the contract's owner ${onChain}.`);
}
/** The network holds each transaction's whole Mana limit aside for a few minutes after it is sent ("insufficient
 *  pending account resources"). So limits are kept small (1 Mana: the sponsor's per-transaction cap at launch) and a
 *  send refused for that reason is retried every minute for up to 8 minutes. */
const HELD = /insufficient pending account resources/i;
async function sendOps(p, chainId, s, ops, rcKoin = 1) {
  for (let tries = 1; ; tries++) {
    const have = BigInt(await p.getAccountRc(s.getAddress())), cap = BigInt(Math.round(rcKoin * 1e8)), limit = (have * 95n) / 100n < cap ? (have * 95n) / 100n : cap;
    const tx = new Transaction({ signer: s, provider: p, options: { payer: s.getAddress(), chainId, rcLimit: limit.toString() } });
    for (const op of ops) await tx.pushOperation(op);
    try {
      const r = await tx.send();
      if (r?.reverted) return { ok: false, rcUsed: String(r?.rc_used ?? 0), error: `reverted: ${JSON.stringify(r.logs ?? [])}` };
      const w = await tx.wait("byBlock", 120000).catch(() => null);
      return { ok: !!w, rcUsed: String(r?.rc_used ?? 0), error: w ? undefined : "not seen in a block within 2 minutes", txId: tx.transaction?.id };
    } catch (e) {
      const error = String(e?.message ?? e).slice(0, 300);
      if (!HELD.test(error) || tries >= 8) return { ok: false, error: HELD.test(error) ? `${error} (still held after 8 minutes: wallet ${s.getAddress()} may be low on Mana)` : error };
      log(`  … Mana from the last transaction is still held by the network; trying again in 1 minute (${tries}/8)`);
      await sleep(60000);
    }
  }
}
const saveOut = (name, v) => { const d = path.join(HOME, "testnet-data"); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, name), JSON.stringify(v, null, 2) + "\n"); return path.join(d, name); };

// ── commands ──
async function build() {
  const owner = Signer.fromWif(ENV.OWNER_WIF || fail("OWNER_WIF missing")).getAddress();
  if (CFG.picks && CFG.owner && CFG.owner !== owner) fail(`OWNER_WIF (${owner}) isn't the testnet Picks owner ${CFG.owner}.`);
  execFileSync(process.execPath, [path.join(REPO, "picks/scripts/build-testnet-v2.cjs"), "--owner", owner], { cwd: path.join(REPO, "picks"), stdio: "inherit" });
}
async function status() {
  const { p } = await connect();
  log(`Testnet node   ${CFG.rpc}`);
  if (!PICKS) fail(FRESH ? "No Combo testnet contract yet: keys --fresh, build, then upload --fresh --send." : "No testnet Picks contract in testnet/blockx.json: do the Block X testnet setup first.");
  const m = await meta(p, PICKS), v2 = fs.existsSync(path.join(V2_DIR, "manifest.json")) ? JSON.parse(fs.readFileSync(path.join(V2_DIR, "manifest.json"), "utf8")) : null;
  const which = !m ? "no contract" : m.sha256 === CFG.picksSha256 ? "v1 (the Block X testnet build)" : v2 && m.sha256 === v2.sha256 ? "v2 (CARD games) ✔" : "an unknown build";
  log(`Picks contract ${PICKS}`);
  log(`Code           ${m?.sha256 ?? "–"}  = ${which}`);
  log(`Overrides      ${m ? (m.call && m.tx && m.upload ? "✔ all three ON" : `✖ call ${m.call}, tx ${m.tx}, upload ${m.upload}`) : "–"}`);
  const c = await read(p, "get_config");
  log(`Owner          ${c.owner}`);
  if (c.upgrade_hash && c.upgrade_hash !== "0x") {
    const eta = Number(c.upgrade_eta || 0);
    log(`Upgrade        announced: ${String(c.upgrade_hash).replace(/^0x/, "")} (${v2 && String(c.upgrade_hash).replace(/^0x/, "") === v2.sha256 ? "the v2 build" : "not this v2 build"}), ${Date.now() >= eta ? "can be uploaded now" : `uploadable from ${new Date(eta).toLocaleTimeString()}`}`);
  } else log("Upgrade        none announced");
  for (const g of (await read(p, "list_games")).games ?? []) log(`Game ${String(g.id).padStart(3)}       ${g.name} (kind ${g.kind}${Number(g.kind) === 4 ? `, max ${g.max_legs} legs, ${g.leg_types?.length ?? 0} leg types` : ""}) ${g.enabled ? "on" : "off"}`);
  const pend = await read(p, "get_game", { game: GAME });
  if (pend.pending) log(`Game ${GAME} pending: ${Date.now() >= Number(pend.pending.eta) ? "can be applied now" : `from ${new Date(Number(pend.pending.eta)).toLocaleTimeString()}`}`);
}
async function schedule() {
  const { p, chainId } = await connect();
  const b = v2Build(), m = await meta(p, PICKS);
  if (!m || !(m.call && m.tx && m.upload)) fail("The testnet Picks contract isn't there with all three overrides on.");
  if (m.sha256 === b.sha256) fail("The contract already runs this v2 build.");
  const owner = signer("OWNER_WIF", p);
  await sameOwner(p, b, owner);
  log(`Announce the v2 code on ${PICKS}: sha256 ${b.sha256} (${b.wasm.length.toLocaleString("en-US")} bytes). Upload possible 10 minutes later.`);
  if (!SEND) return log("\nDry run only. Add --send.");
  const { operation } = await picksC(p, owner).functions.schedule_upgrade({ hash: "0x" + b.sha256 }, { onlyOperation: true });
  const r = await sendOps(p, chainId, owner, [operation], 2);
  log(r.ok ? `✔ announced (Mana ${mana(r.rcUsed)}). Next, at ${new Date(Date.now() + 11 * 60000).toLocaleTimeString()} or later: upgrade --send` : `✖ ${r.error}`);
}
async function upgrade() {
  const { p, chainId } = await connect();
  const b = v2Build(), owner = signer("OWNER_WIF", p);
  await sameOwner(p, b, owner);
  const c = await read(p, "get_config");
  if (String(c.upgrade_hash || "").replace(/^0x/, "") !== b.sha256) fail("The v2 build isn't the announced code. Run schedule --send first.");
  if (Date.now() < Number(c.upgrade_eta)) fail(`Too early: uploadable from ${new Date(Number(c.upgrade_eta)).toLocaleTimeString()}.`);
  const before = await read(p, "list_games");
  log(`Upload v2 to ${PICKS}, signed and paid by the owner ${owner.getAddress()}. All three overrides stay ON.`);
  if (!SEND) return log("\nDry run only. Add --send.");
  // The contract authorizes its own upload (override on): only the owner, only the announced sha256, after the wait.
  const k = new Contract({ id: PICKS, abi, provider: p, signer: owner, bytecode: new Uint8Array(b.wasm) });
  const { operation } = await k.deploy({ abi: JSON.stringify(abi), authorizesCallContract: true, authorizesTransactionApplication: true, authorizesUploadContract: true, onlyOperation: true });
  const r = await sendOps(p, chainId, owner, [operation], 20);
  if (!r.ok) fail(`upload: ${r.error}`);
  const m = await meta(p, PICKS);
  if (!m || m.sha256 !== b.sha256 || !(m.call && m.tx && m.upload)) fail(`Uploaded, but the chain shows ${JSON.stringify(m)}. Stop and check.`);
  log(`✔ v2 is live (Mana ${mana(r.rcUsed)}): code ${m.sha256}, all three overrides ON.`);
  // v1's data, read by v2: every game is still there, unchanged.
  const after = await read(p, "list_games");
  const same = JSON.stringify(before.games ?? []) === JSON.stringify(after.games ?? []);
  log(same ? `✔ the ${after.games?.length ?? 0} existing game(s) read back unchanged under v2` : `✖ the games read differently under v2:\n  before ${JSON.stringify(before.games)}\n  after  ${JSON.stringify(after.games)}`);
  // Audit CC-A3: clear the announced hash, so the same bytes can't be uploaded again.
  const { operation: clear } = await picksC(p, owner).functions.schedule_upgrade({ hash: "0x" }, { onlyOperation: true });
  const r2 = await sendOps(p, chainId, owner, [clear], 2);
  log(r2.ok ? "✔ the announced hash is cleared" : `✖ clearing the hash: ${r2.error}`);
  log(`Saved ${saveOut("combo-upgrade.json", { at: new Date().toISOString(), picks: PICKS, v2: b.sha256, rcUsed: r.rcUsed, gamesUnchanged: same })}`);
}
function testGame() {
  const leg = (code, mode, size, lead, ahead) => ({ code, lock_mode: mode, round_size: String(size), round_offset: "0", lead: String(lead), ahead: String(ahead), enabled: true });
  return { id: GAME, name: "Combo test", kind: 4, list_size: 10, number_min: "0", number_max: "0", lock_mode: 2, round_size: "3", round_offset: "0",
    lead: String(300000), ahead: String(DAY_MS), max_picks_per_day: 50, max_changes: 3, enabled: true, max_legs: 10,
    leg_types: [leg(LEGS.WIN, 2, RACE_MS, RACE_LEAD, DAY_MS), leg(LEGS.SHOW, 2, RACE_MS, RACE_LEAD, DAY_MS), leg(LEGS.HALF, 2, RACE_MS, RACE_LEAD, DAY_MS), leg(LEGS.BLOCK, 1, BLOCK_ROUND, BLOCK_LEAD, 28800)] };
}
async function announce() {
  const { p, chainId } = await connect();
  const owner = signer("OWNER_WIF", p);
  log(`Announce game ${GAME} "Combo test": a card game with the mainnet Combo leg types, up to 10 legs, 3 cards a day.`);
  if (!SEND) return log("\nDry run only. Add --send.");
  const { operation } = await picksC(p, owner).functions.announce_game({ game: testGame() }, { onlyOperation: true });
  const r = await sendOps(p, chainId, owner, [operation], 2);
  log(r.ok ? `✔ announced (Mana ${mana(r.rcUsed)}). Next, at ${new Date(Date.now() + 11 * 60000).toLocaleTimeString()} or later: apply --send` : `✖ ${r.error}`);
}
async function apply() {
  const { p, chainId } = await connect();
  const owner = signer("OWNER_WIF", p);
  if (!SEND) return log(`Put game ${GAME} in force.\n\nDry run only. Add --send.`);
  const { operation } = await picksC(p, owner).functions.apply_game({ game: GAME }, { onlyOperation: true });
  const r = await sendOps(p, chainId, owner, [operation], 2);
  log(r.ok ? `✔ game ${GAME} is in force (Mana ${mana(r.rcUsed)}). Next: cards --send` : `✖ ${r.error}`);
}
/** One transaction paid by the testnet Mana sponsor: payer = the sponsor, payee = the player, Mana limit 1 (the
 *  sponsor's per-transaction cap), signed by the player only. The sponsor contract's own authorize decides whether it
 *  pays. Retries while the network still holds Mana from the last transaction. */
async function sendSponsored(p, chainId, s, ops, sponsor) {
  for (let tries = 1; ; tries++) {
    const tx = new Transaction({ signer: s, provider: p, options: { payer: sponsor, payee: s.getAddress(), chainId, rcLimit: "100000000" } });
    for (const op of ops) await tx.pushOperation(op);
    try {
      const r = await tx.send();
      if (r?.reverted) return { ok: false, rcUsed: String(r?.rc_used ?? 0), error: `reverted: ${JSON.stringify(r.logs ?? [])}` };
      const w = await tx.wait("byBlock", 120000).catch(() => null);
      return { ok: !!w, rcUsed: String(r?.rc_used ?? 0), error: w ? undefined : "not seen in a block within 2 minutes", txId: tx.transaction?.id };
    } catch (e) {
      const error = String(e?.message ?? e).slice(0, 300);
      if (!HELD.test(error) || tries >= 8) return { ok: false, error };
      log(`  … Mana from the last transaction is still held by the network; trying again in 1 minute (${tries}/8)`);
      await sleep(60000);
    }
  }
}
async function cards() {
  const { p, chainId } = await connect();
  const g = (await read(p, "get_game", { game: GAME })).game;
  if (!g || Number(g.kind) !== 4 || !g.enabled) fail(`Game ${GAME} isn't an enabled card game yet (announce, wait 10 min, apply).`);
  const SPONSOR = arg("--sponsor");
  if (SPONSOR !== undefined) return sponsoredCards(p, chainId, SPONSOR);
  const player = signer("PLAYER_WIF", p), me = player.getAddress();
  const h = await p.getHeadInfo(), now = Number(h.head_block_time), height = Number(h.head_topology.height);
  const day = Math.floor(now / DAY_MS);
  // Open legs: the next 3 races that lock more than 30 minutes from now; Block X targets locking more than 30 minutes out.
  const races = []; for (let i = Math.floor(now / RACE_MS) + 1; races.length < 3; i++) if (i * RACE_MS - RACE_LEAD - now > 30 * 60000 && i * RACE_MS - now <= DAY_MS - 60000) races.push(i);
  const blocks = []; for (let r = Math.floor(height / BLOCK_ROUND) + 1; blocks.length < 6; r++) if (r * BLOCK_ROUND - BLOCK_LEAD - height > 600 && r * BLOCK_ROUND - height <= 28700) blocks.push(r);
  const pool = [];
  for (const r of races) for (const c of [LEGS.WIN, LEGS.SHOW, LEGS.HALF]) pool.push({ code: c, round: r });
  for (const r of blocks) pool.push({ code: LEGS.BLOCK, round: r });
  const card = (n, from = 0) => pool.slice(0, n).map((l, i) => ({ code: l.code, round: String(l.round), producer: PRODUCERS[(i + from) % PRODUCERS.length] }));
  const op = async (slot, legs) => (await picksC(p, player).functions.pick({ player: me, game: GAME, round: String(day * 3 + slot), producers: [], number: "0", legs }, { onlyOperation: true })).operation;
  const plan = [["2 legs (slot 1)", 0, card(2)], ["6 legs (slot 2)", 1, card(6)], ["10 legs (slot 3)", 2, card(10)], ["change of the 6-leg card", 1, card(6, 3)],
    ["MUST BE REFUSED: one producer twice", 0, [...card(2), { ...card(1)[0], code: LEGS.BLOCK, round: String(blocks[0]) }]]];
  log(`cards on game ${GAME} from ${me}: ${plan.map((x) => x[0]).join("; ")}.`);
  log(`Today's slots: ${day * 3}..${day * 3 + 2}. Legs: races ${races.join(", ")}, Block X rounds ${blocks.join(", ")}.`);
  if (!SEND) return log("\nDry run only. Add --send.");
  const out = [];
  for (const [what, slot, legs] of plan) {
    const r = await sendOps(p, chainId, player, [await op(slot, legs)], 1);
    out.push({ what, legs: legs.length, ...r });
    const refusedOk = what.startsWith("MUST") ? !r.ok && /only once/.test(r.error ?? "") : null;
    log(`  ${what}: ${r.ok ? `${mana(r.rcUsed)} Mana` : `refused (${(r.error ?? "").slice(0, 120)})`}${refusedOk === true ? "  ✔ as it should be" : refusedOk === false ? "  ✖ this card should have been refused" : ""}`);
    await sleep(4000);
  }
  for (let k = 0; k < 3; k++) { const c = (await read(p, "get_pick", { game: GAME, round: String(day * 3 + k), player: me })).pick; log(`  slot ${k + 1} on chain: ${c?.legs?.length ?? 0} legs, changes ${c?.changes ?? 0}`); }
  log(`Saved ${saveOut("combo-cards.json", { game: GAME, at: new Date().toISOString(), out })}. Send me the lines above (never the .env.testnet file).`);
}

/** cards --sponsor <address>: a 6-leg and a 10-leg card into today's two free slots, paid by the testnet sponsor. */
async function sponsoredCards(p, chainId, sponsor) {
  if (!/^1[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(sponsor || "")) fail("--sponsor needs the testnet sponsor's address.");
  const player = signer("PLAYER_WIF", p), me = player.getAddress();
  const h = await p.getHeadInfo(), now = Number(h.head_block_time), height = Number(h.head_topology.height), day = Math.floor(now / DAY_MS);
  const races = []; for (let i = Math.floor(now / RACE_MS) + 1; races.length < 3; i++) if (i * RACE_MS - RACE_LEAD - now > 30 * 60000 && i * RACE_MS - now <= DAY_MS - 60000) races.push(i);
  const blocks = []; for (let r = Math.floor(height / BLOCK_ROUND) + 1; blocks.length < 6; r++) if (r * BLOCK_ROUND - BLOCK_LEAD - height > 600 && r * BLOCK_ROUND - height <= 28700) blocks.push(r);
  const pool = [];
  for (const r of races) for (const c of [LEGS.WIN, LEGS.SHOW, LEGS.HALF]) pool.push({ code: c, round: r });
  for (const r of blocks) pool.push({ code: LEGS.BLOCK, round: r });
  const card = (n) => pool.slice(0, n).map((l, i) => ({ code: l.code, round: String(l.round), producer: PRODUCERS[i % PRODUCERS.length] }));
  // Today's free slots (a card already in a slot would make this a change, and its old legs may have locked).
  const free = [];
  for (let k = 0; k < 3; k++) { const c = (await read(p, "get_pick", { game: GAME, round: String(day * 3 + k), player: me })).pick; if (!(c?.legs?.length)) free.push(k); }
  const hhmm = new Date((day + 1) * DAY_MS).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (free.length < 2) fail(`Today's card slots (UTC day) for ${me} are used (${3 - free.length} of 3). Run this again after 00:00 UTC (${hhmm} your time).`);
  const plan = [["6 legs, sponsored", free[0], card(6)], ["10 legs, sponsored", free[1], card(10)]];
  log(`Sponsored cards on game ${GAME} from ${me}: payer ${sponsor} (the testnet sponsor), payee the player, Mana limit 1.`);
  log(`Slots ${plan.map((x) => x[1] + 1).join(" and ")} of today. Legs: races ${races.join(", ")}, Block X rounds ${blocks.join(", ")}.`);
  if (!SEND) return log("\nDry run only. Add --send.");
  const out = [];
  for (const [what, slot, legs] of plan) {
    const { operation } = await picksC(p, player).functions.pick({ player: me, game: GAME, round: String(day * 3 + slot), producers: [], number: "0", legs }, { onlyOperation: true });
    const r = await sendSponsored(p, chainId, player, [operation], sponsor);
    out.push({ what, legs: legs.length, slot, ...r });
    log(`  ${what} (slot ${slot + 1}): ${r.ok ? `${mana(r.rcUsed)} Mana, paid by the sponsor` : `NOT sent (${(r.error ?? "").slice(0, 160)})`}`);
    await sleep(4000);
  }
  for (const [, slot] of plan) { const c = (await read(p, "get_pick", { game: GAME, round: String(day * 3 + slot), player: me })).pick; log(`  slot ${slot + 1} on chain: ${c?.legs?.length ?? 0} legs`); }
  log(`Saved ${saveOut("combo-cards-sponsored.json", { game: GAME, sponsor, at: new Date().toISOString(), out })}. Send me the lines above (never the .env.testnet file).`);
}

// ── the fresh route ──
async function keys() {
  if (!FRESH) fail("keys is for --fresh only (the upgrade route uses the existing Block X testnet contract).");
  if (ENV.COMBO_PICKS_WIF) return log(`COMBO_PICKS_WIF is already in .env.testnet: ${Signer.fromWif(ENV.COMBO_PICKS_WIF).getAddress()}`);
  const s = new Signer({ privateKey: crypto.randomBytes(32).toString("hex") });
  fs.appendFileSync(path.join(HOME, ".env.testnet"), `\n# Combo Card testnet: the brand-new wallet that becomes the Combo-only Picks contract (never send it KOIN)\nCOMBO_PICKS_WIF=${s.getPrivateKey("wif")}\n`, { mode: 0o600 });
  try { fs.chmodSync(path.join(HOME, ".env.testnet"), 0o600); } catch { /* Windows: the file stays as your account made it (Repo Lens RL-33) */ }
  log(`✔ COMBO_PICKS_WIF added to .env.testnet. The new contract wallet: ${s.getAddress()} (send it nothing).`);
}
async function uploadFresh() {
  if (!FRESH) fail("upload is for --fresh only. The upgrade route uses schedule, then upgrade.");
  const { p, chainId } = await connect();
  const b = v2Build(), k = signer("COMBO_PICKS_WIF", p), A = k.getAddress(), payer = signer("OWNER_WIF", p);
  if (b.man.owner !== payer.getAddress()) fail(`The v2 build was made for owner ${b.man.owner}, not OWNER_WIF ${payer.getAddress()}: build again.`);
  if (A === BX.picks || A === payer.getAddress()) fail("COMBO_PICKS_WIF must be a brand-new wallet of its own.");
  if (await meta(p, A)) fail(`${A} already has a contract. See status --fresh.`);
  if (BigInt(await p.getNonce(A).catch(() => 0)) > 0n) fail(`${A} has already sent transactions: use a brand-new wallet (delete COMBO_PICKS_WIF and run keys --fresh).`);
  log(`Upload v2 (testnet build ${b.sha256}) to the new wallet ${A}, all three overrides ON; Mana paid by the owner ${payer.getAddress()}.`);
  if (!SEND) return log("\nDry run only. Add --send.");
  const c = new Contract({ id: A, abi, provider: p, signer: k, bytecode: new Uint8Array(b.wasm) });
  const { operation } = await c.deploy({ abi: JSON.stringify(abi), authorizesCallContract: true, authorizesTransactionApplication: true, authorizesUploadContract: true, onlyOperation: true });
  const have = BigInt(await p.getAccountRc(payer.getAddress())), rc = 20n * 100000000n;
  const tx = new Transaction({ signer: k, provider: p, options: { payer: payer.getAddress(), chainId, rcLimit: (have * 95n / 100n < rc ? have * 95n / 100n : rc).toString() } });
  await tx.pushOperation(operation); await tx.prepare(); await tx.sign(); await payer.signTransaction(tx.transaction);
  const r = await tx.send();
  if (r?.reverted) fail(`upload reverted: ${JSON.stringify(r.logs)}`);
  await tx.wait("byBlock", 300000).catch(() => fail("Sent but not confirmed within 5 minutes; check status --fresh shortly."));
  const m = await meta(p, A);
  if (!m || m.sha256 !== b.sha256 || !(m.call && m.tx && m.upload)) fail(`Uploaded, but the chain shows ${JSON.stringify(m)}.`);
  fs.writeFileSync(FRESH_FILE, JSON.stringify({ v: 1, network: "koinos-foundation-testnet", note: "Combo Card testnet: a Combo-only Picks v2 contract (test KOIN only).", rpc: BX.rpc, chainId, picks: A, picksSha256: b.sha256, uploadedAt: new Date().toISOString() }, null, 2) + "\n");
  log(`✔ uploaded (Mana ${mana(r?.rc_used)}): ${A}, code ${m.sha256}, all three overrides ON. Saved ${FRESH_FILE}. Next: announce --fresh --send`);
}

const cmd = process.argv[2];
const run = { keys, upload: uploadFresh, build, status, schedule, upgrade, announce, apply, cards }[cmd];
if (!run) fail("Commands: keys, upload, build, status, schedule, upgrade, announce, apply, cards (each with --home <dir>; --fresh for the Combo-only contract; add --send to send).");
if (FRESH && (cmd === "schedule" || cmd === "upgrade")) fail("schedule and upgrade are the upgrade route (without --fresh).");
try { await run(); } catch (e) { fail(String(e?.message ?? e).slice(0, 400)); }

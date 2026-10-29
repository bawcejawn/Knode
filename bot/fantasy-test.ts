/**
 * FANTASY PRODUCERS TESTNET PRACTICE KIT. Runs a complete copy of Fantasy Producers for practice:
 *   - picks (teams and Weekly Rival challenges) go to a testnet copy of the KnodeGames Picks contract on the Koinos
 *     Foundation testnet (play money);
 *   - teams are scored on MAINNET producers' blocks, read only. The testnet has a single block producer, so a fantasy
 *     team of testnet producers could not score anything meaningful. Nothing is ever sent to mainnet: this tool never
 *     signs anything for it, and it checks each node's chain id before using it;
 *   - a fast clock: 1 test "day" = 1 hour, so a test week takes 7 hours; the price list comes out 30 minutes before;
 *   - five robot players with different styles, and a local practice page with a red TESTNET bar.
 *
 *   npm run fantasy-test -- setup                   make the test wallets (once)
 *   npm run fantasy-test -- status                  the testnet, the wallets, the contract, the games, the week
 *   npm run fantasy-test -- fund [--send]           send test KOIN from the test owner to the players and the Picks wallet
 *   npm run fantasy-test -- picks-build             build the testnet Picks contract (needs: cd picks; npm ci; npm test)
 *   npm run fantasy-test -- picks-upload [--send]   put it on the testnet
 *   npm run fantasy-test -- games [--send]          announce games 4 (team) and 5 (rival); run again 10 minutes later
 *   npm run fantasy-test -- week [next]             start test week 1 on the next hour at least 45 minutes away
 *   npm run fantasy-test -- team <player> <a,b,c,d,e> [--send]   save a team as a test player (captain first; #n = nth on the price list)
 *   npm run fantasy-test -- rival <player> <address|pN> [--send] challenge a rival for the next test week
 *   npm run fantasy-test -- record                  one recorder run (writes testnet-data/fantasy/data)
 *   npm run fantasy-test -- run [--bots]            the practice page (opens in your browser; --no-open not) + the recorder
 *                                                   every 2 minutes (+ robot players)
 *
 * Everything it makes stays in testnet-data/fantasy/ (git-ignored): keys.env (the throwaway TEST keys; never use them on
 * mainnet), config.json, picks/ (the testnet build), race/ (the race cards), data/ (the recorder's files), bots.json.
 * The practice page: http://127.0.0.1:8380/site/fantasy-testnet.html (or the next free port) while `run` is going.
 */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Signer, Provider, Contract } from "koilib";
import { tokenAbi } from "./token-abi.ts";
await import("../site/race-math.js");
await import("../site/fantasy-math.js");
const M: any = (globalThis as any).KRaceMath;
const FR: any = (globalThis as any).KFantasyMath;

export const TESTNET = {
  name: "Koinos testnet (Koinos Foundation)",
  rpc: process.env.FANTASY_TEST_RPC || "https://testnet.koinosfoundation.org",
  chainId: "EiAIKVvm6-V2qmsmUvPJy09vCCLbtn9lHFpwrJbcTIEWRQ==",
  koin: "1FaSvLjQJsCJKq5ybmGsMMQs8RQYyVv8ju",
  faucet: "https://t.me/KoinosTestnetFaucetBot",
};
export const MAINNET_CHAIN_ID = "EiBZK_GGVP0H_fXVAM3j6EAuz3-B-l3ejxRSewi7qIBfSA==";
/** The mainnet nodes the teams are scored from (read only), as the live recorder uses them. */
const MAINNET_READ = { rpc: process.env.FANTASY_TEST_MAINNET_RPC || "https://koinos.armana.io", check: process.env.FANTASY_TEST_MAINNET_CHECK ?? "https://api.koinosblocks.com" };
const MAINNET_RPC = /api\.koinos\.io|koinos\.armana\.io|koinosblocks\.com|api\.koinos\.pro(?!.*harbinger)/i;
const RACE_DATA_URL = "https://raw.githubusercontent.com/bawcejawn/Knode/race-data/";
export const PLAYERS = ["p1", "p2", "p3", "p4", "p5", "p6"];
export const TEST_DAY_MS = 3_600_000;              // one test "day" = 1 hour (owner, 2026-10-28)
const SHEET_BEFORE_MS = 30 * 60_000;               // the price list comes out 30 minutes before the test week
const GAMES = { team: 4, rival: 5 };
const PICK_RC_KOIN = 0.3;                          // see the Survivor kit: a big limit is held aside until the pick settles
const portArg = process.argv.indexOf("--port");
const SITE_PORT = Number((portArg > 0 && process.argv[portArg + 1]) || process.env.FANTASY_TEST_PORT || 8380);

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const DIR = () => process.env.FANTASY_TEST_DIR || path.join(ROOT, "testnet-data", "fantasy");
const KEYS = () => path.join(DIR(), "keys.env"), CONFIG = () => path.join(DIR(), "config.json"), DATA = () => path.join(DIR(), "data"), RACE = () => path.join(DIR(), "race");
const BUILD = () => path.join(DIR(), "picks"), BOTS = () => path.join(DIR(), "bots.json");
let log = (...a: any[]) => console.log(...a);
/** The kit's clock (the rehearsal moves it with its fake chains). */
let NOW = () => Date.now();
export const setNow = (f: () => number) => { NOW = f; };
export const quiet = (f: (...a: any[]) => void) => { log = f; };
const isAddr = (a: unknown): a is string => typeof a === "string" && /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a);
const sha256hex = (b: Uint8Array) => crypto.createHash("sha256").update(b).digest("hex");
const koin = (sat: bigint | string | number) => (Number(sat) / 1e8).toLocaleString("en-US", { maximumFractionDigits: 4 });
const toSat = (k: number) => BigInt(Math.round(k * 1e8));
const readJsonFile = (f: string) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };

// ── files ──
export type Config = {
  v: 1; rpc: string; chainId: string; koin: string;
  mainnet: { rpc: string; check: string };
  cards: "github" | "local";
  clock: { day: number; genesis: number | null; sheetBefore: number };
  games: { team: number; rival: number };
  picks: { contract: string; sha256: string; uploadTx?: string; uploadedAt?: string } | null;
};
export function readConfig(): Config {
  if (!fs.existsSync(CONFIG())) throw new Error("No practice setup yet. Run: npm run fantasy-test -- setup");
  return JSON.parse(fs.readFileSync(CONFIG(), "utf8"));
}
export const writeConfig = (c: Config) => { fs.mkdirSync(DIR(), { recursive: true }); fs.writeFileSync(CONFIG(), JSON.stringify(c, null, 2) + "\n"); };
export function readKeys(): Record<string, string> {
  if (!fs.existsSync(KEYS())) throw new Error("No test wallets yet. Run: npm run fantasy-test -- setup");
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(KEYS(), "utf8").split(/\r?\n/)) { const m = line.match(/^\s*([A-Z0-9_]+)_WIF\s*=\s*(\S+)\s*$/); if (m) out[m[1]] = m[2]; }
  return out;
}
const signerOf = (keys: Record<string, string>, who: string, provider?: Provider) => {
  const wif = keys[who.toUpperCase()];
  if (!wif) throw new Error(`No test key for ${who} in ${KEYS()}`);
  const s = Signer.fromWif(wif);
  if (provider) s.provider = provider;
  return s;
};
export const addressOf = (keys: Record<string, string>, who: string) => signerOf(keys, who).getAddress();
/** The test clock (needs the test week's start). */
export function mathOf(c: Config) {
  if (c.clock.genesis === null) throw new Error("No test week yet. Run: npm run fantasy-test -- week next");
  return FR.withClock({ day: c.clock.day, genesis: c.clock.genesis, sheetBefore: c.clock.sheetBefore });
}

// ── the network guards ──
let CHECKED_CHAIN: string | null = null;
/** The testnet node: must be the testnet this setup was made on, never mainnet. Every transaction is signed for it. */
export async function testnetProvider(c: { rpc: string; chainId?: string } = { rpc: TESTNET.rpc }): Promise<Provider> {
  if (MAINNET_RPC.test(c.rpc)) throw new Error(`${c.rpc} is a mainnet node. Picks go only to the testnet.`);
  const p = new Provider([c.rpc]);
  let id: string;
  try { id = await p.getChainId(); }
  catch {
    // One more try after a pause (a dropped connection, or a node busy for a moment).
    await new Promise((r) => setTimeout(r, 1500));
    try { id = await p.getChainId(); } catch (e) { throw new Error(`The testnet node ${c.rpc} doesn't answer (${(e as Error).message}). Check your internet, or try again in a minute.`); }
  }
  if (id === MAINNET_CHAIN_ID) throw new Error(`${c.rpc} is MAINNET (chain id ${id}). Picks go only to the testnet.`);
  if (c.chainId && id !== c.chainId) throw new Error(`The testnet's chain id is now ${id}, not ${c.chainId} as when you set up: the testnet was probably reset. Start again: delete the folder ${DIR()} and run setup.`);
  CHECKED_CHAIN = id;
  return p;
}
/** A mainnet node for READING blocks and VHP only (it is never given a signer). Must answer the mainnet chain id. */
export async function mainnetReader(rpc: string): Promise<Provider> {
  const p = new Provider([rpc]);
  let id: string;
  try { id = await p.getChainId(); } catch (e) { throw new Error(`The mainnet node ${rpc} doesn't answer (${(e as Error).message}).`); }
  if (id !== MAINNET_CHAIN_ID) throw new Error(`${rpc} is not Koinos mainnet (chain id ${id}). Teams are scored on mainnet blocks.`);
  return p;
}

async function balance(p: Provider, token: string, who: string): Promise<bigint> {
  const c = new Contract({ id: token, abi: tokenAbi as any, provider: p });
  const r: any = await (c.functions as any).balance_of({ owner: who });
  return BigInt(r?.result?.value ?? "0");
}
const PICKS_ABI = () => JSON.parse(fs.readFileSync(path.join(ROOT, "picks", "abi", "picks.koilib.json"), "utf8"));
const picksContract = (c: Config, p: Provider) => {
  if (!c.picks) throw new Error("No testnet Picks contract yet: npm run fantasy-test -- picks-upload --send");
  return new Contract({ id: c.picks.contract, abi: PICKS_ABI(), provider: p });
};
/** Send one contract call signed and paid by `signer`, for the checked testnet only, and wait for its block. */
async function send(c: Contract, method: string, args: any, signer: Signer, rcKoin = 2): Promise<string> {
  if (!CHECKED_CHAIN || CHECKED_CHAIN === MAINNET_CHAIN_ID) throw new Error("Not sending: the network wasn't checked (or is mainnet).");
  const have = BigInt(await (signer.provider as Provider).getAccountRc(signer.getAddress()));
  const rc = toSat(rcKoin) < have ? toSat(rcKoin) : (have * 95n) / 100n;
  const k = new Contract({ id: c.getId(), abi: c.abi, provider: signer.provider as Provider, signer });
  const { transaction, receipt } = await (k.functions as any)[method](args, { payer: signer.getAddress(), rcLimit: rc.toString(), chainId: CHECKED_CHAIN });
  if (receipt?.reverted) throw new Error(`${method} reverted: ${JSON.stringify(receipt.logs)}`);
  await transaction.wait("byBlock", 120_000);
  return transaction.id;
}
/** The Picks game settings for the test clock (they don't depend on when the test week starts). Exported for tests. */
export function testGames(c: Config) {
  return FR.withClock({ day: c.clock.day, genesis: 0, sheetBefore: c.clock.sheetBefore }).games(c.games, 50);
}

// ── commands ──
export async function setup() {
  if (fs.existsSync(KEYS())) { log(`Test wallets already exist in ${KEYS()}. (To start over, delete that folder.)`); return; }
  const p = await testnetProvider();
  const chainId = await p.getChainId();
  if (chainId !== TESTNET.chainId) log(`Note: the testnet's chain id is ${chainId} (it was ${TESTNET.chainId} on 25 Oct): it was reset since. Fine for practice.`);
  fs.mkdirSync(DIR(), { recursive: true });
  const lines = ["# Fantasy TESTNET wallets. Throwaway keys for play money only. NEVER use them on mainnet, never share or commit.", ""];
  for (const who of ["OWNER", "PICKS", ...PLAYERS.map((x) => x.toUpperCase())]) lines.push(`${who}_WIF=${new Signer({ privateKey: crypto.randomBytes(32).toString("hex") }).getPrivateKey("wif")}`);
  fs.writeFileSync(KEYS(), lines.join("\n") + "\n", { mode: 0o600 });
  writeConfig({ v: 1, rpc: TESTNET.rpc, chainId, koin: TESTNET.koin, mainnet: { ...MAINNET_READ }, cards: (process.env.FANTASY_TEST_CARDS as any) === "local" ? "local" : "github",
    clock: { day: TEST_DAY_MS, genesis: null, sheetBefore: SHEET_BEFORE_MS }, games: { ...GAMES }, picks: null });
  const keys = readKeys();
  log(`✔ Test wallets made (keys in ${KEYS()}, git-ignored).`);
  log(`\nNext: get free test KOIN for the test OWNER wallet from the faucet bot on Telegram (${TESTNET.faucet}).`);
  log(`Send it /start, then this line:`);
  log(`   /faucet ${addressOf(keys, "owner")}`);
  log(`(100 test KOIN per claim; one claim a day. Then run: npm run fantasy-test -- fund --send)`);
}

export async function status() {
  const c = readConfig(), keys = readKeys();
  const p = await testnetProvider(c);
  const head: any = await p.getHeadInfo();
  log(`${TESTNET.name}  ${c.rpc}`);
  log(`  chain id ${c.chainId}, head block ${Number(head.head_topology.height).toLocaleString()} (${new Date(Number(head.head_block_time)).toISOString()})`);
  try { const mp = await mainnetReader(c.mainnet.rpc); const mh: any = await mp.getHeadInfo(); log(`Scoring: Koinos MAINNET blocks (read only) from ${c.mainnet.rpc}, head ${Number(mh.head_topology.height).toLocaleString()}${c.mainnet.check ? `, checked against ${c.mainnet.check}` : ""}`); }
  catch (e) { log(`Scoring: ✖ ${(e as Error).message}`); }
  log(`Race cards: ${c.cards === "github" ? "the live Producer Race cards from GitHub (race-data)" : "taken here from mainnet VHP"}`);
  log(`\nWallets (KOIN = Mana)`);
  for (const who of ["owner", "picks", ...PLAYERS]) {
    const a = addressOf(keys, who);
    const [k, rc] = await Promise.all([balance(p, c.koin, a).catch(() => 0n), p.getAccountRc(a).catch(() => "0")]);
    log(`  ${who.padEnd(6)} ${a}  KOIN ${koin(k).padStart(8)}  Mana ${koin(rc).padStart(8)}${who === "p1" ? "  ← you" : PLAYERS.includes(who) ? "  (robot)" : ""}`);
  }
  if (!c.picks) { log(`\nPicks contract: not uploaded yet (npm run fantasy-test -- picks-build, then picks-upload --send)`); return; }
  const pc = picksContract(c, p);
  log(`\nPicks contract ${c.picks.contract} (testnet build ${c.picks.sha256.slice(0, 12)}…)`);
  for (const [k, id] of Object.entries(c.games)) {
    const g: any = (await (pc.functions as any).get_game({ game: id }).catch(() => ({ result: {} }))).result ?? {};
    log(`  game ${id} (${k}): ${g.game ? `${g.game.enabled ? "ON" : "off"}, round ${Number(g.game.round_size) / 60000} min, lead ${Number(g.game.lead) / 60000} min` : "not in force yet"}${g.pending ? `; announced, can be applied from ${new Date(Number(g.pending.eta)).toLocaleTimeString()}` : ""}`);
  }
  if (c.clock.genesis === null) { log(`\nTest week: not started (npm run fantasy-test -- week next)`); return; }
  const F = mathOf(c), now = NOW(), w = F.weekOf(now);
  log(`\nTest week 1 started ${new Date(c.clock.genesis).toLocaleString()}; now ${now < c.clock.genesis ? `not started (in ${Math.ceil((c.clock.genesis - now) / 60000)} min)` : `test week ${w + 1}, test day ${F.weekDays(w).indexOf(F.dayNo(now)) + 1} of 7`}`);
  const wf = readJsonFile(path.join(DATA(), `W${String(w).padStart(3, "0")}.json`));
  const names = new Map(PLAYERS.map((x) => [addressOf(keys, x), x]));
  if (wf) {
    log(`  price list: ${wf.sheet ? `${wf.sheet.pool.length} producers, budget ${wf.sheet.budget}, sha256 ${String(wf.sha256).slice(0, 12)}…` : "not out yet"}`);
    for (const x of wf.players || []) log(`  #${x.place} ${(names.get(x.a) ?? x.a).padEnd(4)} ${String(x.points).padStart(8)} pts${x.full ? "" : " (part week)"}`);
  }
  const rv = readJsonFile(path.join(DATA(), "rivals.json"));
  if (rv && rv.records) for (const [a, r] of Object.entries<any>(rv.records)) log(`  rival record ${(names.get(a) ?? a).padEnd(4)} made ${r.made.join("-")}  received ${r.received.join("-")}`);
}

export async function fund(sendIt: boolean) {
  const c = readConfig(), keys = readKeys();
  const p = await testnetProvider(c);
  const owner = signerOf(keys, "owner", p);
  const have = await balance(p, c.koin, owner.getAddress());
  const plan: [string, number][] = [["picks", 50], ...PLAYERS.map((w) => [w, 6] as [string, number])];
  const need = plan.reduce((s, [, k]) => s + k, 0);
  log(`Test owner ${owner.getAddress()} has ${koin(have)} test KOIN; this sends ${need} (50 to the Picks wallet for the upload, 6 to each player for Mana).`);
  if (have < toSat(need + 2)) throw new Error(`Not enough: claim test KOIN for the owner from the Telegram faucet bot ${TESTNET.faucet} (send /faucet ${owner.getAddress()}), then run fund again.`);
  if (!sendIt) { for (const [w, k] of plan) log(`  ${k} → ${w} ${addressOf(keys, w)}`); log("\nDry run. Add --send to send."); return; }
  const k = new Contract({ id: c.koin, abi: tokenAbi as any, provider: p });
  for (const [w, amt] of plan) {
    const to = addressOf(keys, w);
    if ((await balance(p, c.koin, to)) >= toSat(amt)) { log(`  ${w} already has ${amt}+`); continue; }
    const id = await send(k, "transfer", { from: owner.getAddress(), to, value: toSat(amt).toString() }, owner, 1);
    log(`  ✔ ${amt} → ${w} (${id.slice(0, 18)}…)`);
  }
  log("Done. Next: npm run fantasy-test -- picks-build");
}

/** The testnet Picks build: the audited source with three settings changed (picks/scripts/build-testnet.cjs proves
 *  the compile reproduces the audited build first), for this kit's test owner. Copied into testnet-data/fantasy/picks
 *  so the Block X tooling's own testnet build (picks/build/testnet) can't be mixed up with it. */
export async function picksBuild() {
  readConfig(); const keys = readKeys();
  if (!fs.existsSync(path.join(ROOT, "picks", "node_modules"))) throw new Error("First install and test the contract once: cd picks; npm ci; npm test; cd ..");
  execFileSync(process.execPath, ["scripts/build-testnet.cjs", "--owner", addressOf(keys, "owner")], { cwd: path.join(ROOT, "picks"), stdio: "inherit" });
  const src = path.join(ROOT, "picks", "build", "testnet");
  fs.mkdirSync(BUILD(), { recursive: true });
  for (const f of ["contract.wasm", "manifest.json"]) fs.copyFileSync(path.join(src, f), path.join(BUILD(), f));
  const man = readJsonFile(path.join(BUILD(), "manifest.json"));
  if (!man || man.owner !== addressOf(keys, "owner") || man.sha256 !== sha256hex(fs.readFileSync(path.join(BUILD(), "contract.wasm")))) throw new Error("The testnet build doesn't match its manifest or this test owner. Run picks-build again.");
  log(`✔ Fantasy testnet Picks build saved in ${BUILD()} (sha256 ${man.sha256.slice(0, 16)}…, owner ${man.owner}). Next: npm run fantasy-test -- picks-upload --send`);
}

export async function picksUpload(sendIt: boolean) {
  const c = readConfig(), keys = readKeys();
  const p = await testnetProvider(c);
  const wasmFile = path.join(BUILD(), "contract.wasm"), man = readJsonFile(path.join(BUILD(), "manifest.json"));
  if (!fs.existsSync(wasmFile) || !man) throw new Error("Build it first: npm run fantasy-test -- picks-build");
  const wasm = fs.readFileSync(wasmFile);
  if (man.owner !== addressOf(keys, "owner") || man.sha256 !== sha256hex(wasm)) throw new Error("The build isn't for this test owner, or doesn't match its manifest. Run picks-build again.");
  const abi = PICKS_ABI(), s = signerOf(keys, "picks", p), A = s.getAddress();
  const rc = BigInt(await p.getAccountRc(A));
  log(`Testnet Picks wallet ${A}: Mana ${koin(rc)}; code ${(wasm.length / 1024).toFixed(1)} KB, sha256 ${man.sha256}`);
  log("Overrides ON (as on mainnet): the contract itself refuses moving anything, paying Mana, and any upgrade except the owner's announced one.");
  const needRc = toSat(Math.ceil((wasm.length / 1024) * 1.2 + 10));
  if (rc < needRc) throw new Error(`The Picks wallet needs about ${koin(needRc)} test KOIN of Mana: npm run fantasy-test -- fund --send`);
  if (!sendIt) { log("\nDry run. Add --send to upload."); return; }
  if (!CHECKED_CHAIN || CHECKED_CHAIN === MAINNET_CHAIN_ID) throw new Error("Not sending: the network wasn't checked.");
  const k = new Contract({ id: A, abi, provider: p, signer: s, bytecode: new Uint8Array(wasm) });
  const { transaction, receipt } = await k.deploy({ abi: JSON.stringify(abi), authorizesCallContract: true, authorizesTransactionApplication: true, authorizesUploadContract: true,
    payer: A, rcLimit: ((rc * 95n) / 100n).toString(), chainId: CHECKED_CHAIN } as any);
  if (receipt?.reverted) throw new Error(`upload reverted: ${JSON.stringify(receipt.logs)}`);
  await transaction.wait("byBlock", 180_000);
  c.picks = { contract: A, sha256: man.sha256, uploadTx: transaction.id, uploadedAt: new Date().toISOString() };
  writeConfig(c);
  log(`✔ uploaded (Mana used ${koin(receipt?.rc_used ?? 0)}). Next: npm run fantasy-test -- games --send`);
}

/** Announce both games (the owner's key), then, after the 10-minute wait, put them in force. Run it twice. */
export async function games(sendIt: boolean) {
  const c = readConfig(), keys = readKeys();
  const p = await testnetProvider(c);
  const owner = signerOf(keys, "owner", p), pc = picksContract(c, p), want = testGames(c);
  const now = Number(((await p.getHeadInfo()) as any).head_block_time);
  let waiting = 0;
  for (const kind of ["team", "rival"] as const) {
    const g = want[kind], cur: any = (await (pc.functions as any).get_game({ game: g.id })).result ?? {};
    if (cur.game && cur.game.enabled && Number(cur.game.round_size) === Number(g.round_size) && Number(cur.game.kind) === g.kind) { log(`✔ game ${g.id} (${kind}) is in force`); continue; }
    if (cur.pending) {
      const eta = Number(cur.pending.eta);
      if (now < eta) { log(`game ${g.id} (${kind}) is announced; it can be put in force from ${new Date(eta).toLocaleTimeString()} (in ${Math.ceil((eta - now) / 60000)} minutes).`); waiting++; continue; }
      if (!sendIt) { log(`game ${g.id} (${kind}): ready to put in force. Dry run; add --send.`); continue; }
      const id = await send(pc, "apply_game", { game: g.id }, owner);
      log(`✔ game ${g.id} (${kind}) is in force (${id.slice(0, 18)}…)`);
      continue;
    }
    log(`Announcing game ${g.id} (${kind}): ${JSON.stringify(g)}`);
    if (!sendIt) { log("Dry run. Add --send."); continue; }
    const id = await send(pc, "announce_game", { game: g }, owner);
    log(`✔ announced (${id.slice(0, 18)}…)`); waiting++;
  }
  if (waiting) log("In 10 minutes run: npm run fantasy-test -- games --send");
  else if (sendIt) log(`Next: npm run fantasy-test -- week next${c.clock.genesis ? " (or carry on: the test week is set)" : ""}`);
}

/** The next hour at least `margin` away: the test week starts there (its price list 30 minutes before). */
export function nextGenesis(now: number, margin = 45 * 60_000, day = TEST_DAY_MS) { let g = Math.ceil(now / day) * day; while (g - now < margin) g += day; return g; }
export async function week(arg?: string) {
  const c = readConfig();
  const g = !arg || arg === "next" ? nextGenesis(NOW(), 45 * 60_000, c.clock.day) : Date.parse(arg);
  if (!Number.isFinite(g) || g % c.clock.day !== 0) throw new Error("Give 'next', or a start time on the hour (e.g. 2026-11-03T18:00:00Z).");
  if (c.clock.genesis !== null && c.clock.genesis <= NOW()) log(`Note: this replaces the running test schedule (started ${new Date(c.clock.genesis).toLocaleString()}). Old results stay in ${DATA()}; move them away for a clean board.`);
  c.clock.genesis = g;
  writeConfig(c);
  const F = mathOf(c);
  log(`✔ Test week 1 starts ${new Date(g).toLocaleString()} (your time). Each test day is ${c.clock.day / 60000} minutes; a test week is ${(7 * c.clock.day) / 3_600_000} hours.`);
  log(`  The price list comes out ${new Date(F.sheetTime(0)).toLocaleTimeString()}. Save your first team before ${new Date(F.lockOfDay(F.weekDays(0)[0])).toLocaleTimeString()}.`);
  log("  Restart the 'run' command if it is running, so the page sees the start.");
}

// ── race cards (for the expected share of blocks) ──
let lastCardsFetch = 0;
/** github: the live Producer Race's cards (race-data branch), refreshed every 10 minutes. local: take cards here from
 *  mainnet VHP with the race recorder's own code (read only). */
export async function refreshCards(c: Config, mainnet: Provider) {
  fs.mkdirSync(RACE(), { recursive: true });
  if (c.cards === "local") {
    const { run } = await import("./race.ts");
    const saved = console.log; console.log = () => {};
    try { await run({ p: mainnet, check: null, prev: RACE(), out: RACE(), raceContract: null }); } finally { console.log = saved; }
    return;
  }
  if (NOW() - lastCardsFetch < 10 * 60_000) return;
  const now = NOW();
  for (let w = M.weekOf(now - 12 * M.DAY); w <= M.weekOf(now); w++) {
    const name = `W${String(w).padStart(3, "0")}.json`;
    try {
      const r = await fetch(RACE_DATA_URL + name, { cache: "no-store" } as any);
      if (!r.ok) continue;
      const j: any = await r.json();
      if (j && j.v === 1 && j.week === w && Array.isArray(j.races)) fs.writeFileSync(path.join(RACE(), name), JSON.stringify(j));
    } catch { /* keep the last copy */ }
  }
  lastCardsFetch = now;
}

export async function record() {
  const c = readConfig();
  const F = mathOf(c);
  const tp = await testnetProvider(c), mp = await mainnetReader(c.mainnet.rpc);
  const mcheck = c.mainnet.check && c.mainnet.check !== c.mainnet.rpc ? await mainnetReader(c.mainnet.check).catch(() => null) : null;
  await refreshCards(c, mp);
  const { run } = await import("./games/fantasy.ts");
  fs.mkdirSync(DATA(), { recursive: true });
  const saved = console.log; console.log = () => {};
  try {
    // rivalStaked null: on the practice testnet every test player's rival matches count (test wallets hold no stake).
    return await run({ p: mp, check: mcheck, picksP: tp, picksCheck: null, prev: DATA(), out: DATA(), raceData: RACE(), math: F, games: c.games, picksContract: c.picks?.contract ?? null, rivalStaked: null });
  } finally { console.log = saved; }
}

// ── robot players ──
type Pool = { a: string; form: number | null; price: number }[];
/** All 5-producer teams of the pool within the budget, best first by value (captain = the best-valued one). */
export function bestTeam(pool: Pool, budget: number, value: (a: string) => number): string[] | null {
  const n = pool.length, price = pool.map((p) => p.price), v = pool.map((p) => value(p.a));
  let best: number[] | null = null, bv = -Infinity;
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) for (let c = b + 1; c < n; c++) for (let d = c + 1; d < n; d++) for (let e = d + 1; e < n; e++) {
    if (price[a] + price[b] + price[c] + price[d] + price[e] > budget) continue;
    const t = [a, b, c, d, e], s = t.reduce((x, i) => x + v[i], 0) + Math.max(...t.map((i) => v[i]));
    if (s > bv) { bv = s; best = t; }
  }
  if (!best) return null;
  return best.map((i) => pool[i].a).sort((x, y) => value(y) - value(x));
}
/** The best team within one change of `prev` (a swap, or the captain's armband), by value. */
export function oneStep(F: any, sheet: any, prev: string[], value: (a: string) => number): string[] {
  const score = (t: string[]) => t.reduce((s, a) => s + value(a), 0) + value(t[0]);
  let best = prev, bs = F.checkTeam(sheet, prev).ok ? score(prev) : -Infinity;
  const tryT = (t: string[]) => { if (F.changes(prev, t) <= 1 && F.checkTeam(sheet, t).ok) { const s = score(t); if (s > bs + 1e-9) { bs = s; best = t; } } };
  for (let i = 1; i < 5; i++) tryT([prev[i], ...prev.filter((_, j) => j !== i)]);
  for (let i = 0; i < 5; i++) for (const p of sheet.pool) if (!prev.includes(p.a)) { const t = [...prev]; t[i] = p.a; tryT(t); }
  return best;
}
/** What each robot does. p1 is left for you. Exported for the tests. */
export const ROBOTS: Record<string, { style: string; rival: (players: Record<string, string>, rand: () => number) => string | null }> = {
  p2: { style: "value: the best form for the money; captain = best form", rival: (pl) => pl.p1 },
  p3: { style: "big names: the biggest producers it can afford; captain = biggest", rival: (pl) => pl.p2 },
  p4: { style: "random: a random team, then a random swap half the days", rival: (pl, r) => [pl.p1, pl.p2, pl.p3, pl.p5][Math.floor(r() * 4)] },
  p5: { style: "chaser: whoever scored best yesterday", rival: (pl) => pl.p1 },
  p6: { style: "late: joins on the 3rd test day of its first week (a part week: no rival match that week), then keeps its team", rival: () => null },
};
export function robotTeam(who: string, F: any, sheet: any, prev: string[] | null, info: { yesterday: (a: string) => number; size: (a: string) => number }, dayOfWeek: number, rand = Math.random, played = !!prev): string[] | null {
  const pool: Pool = sheet.pool, form = (a: string) => pool.find((p) => p.a === a)?.form ?? 95;
  const val: Record<string, (a: string) => number> = { p2: (a) => form(a) - pool.find((p) => p.a === a)!.price * 0.3, p3: info.size, p5: info.yesterday };
  if (prev && !F.checkTeam(sheet, prev).ok) prev = null;      // last week's team doesn't fit this week's list: start over
  if (who === "p6" && !played && dayOfWeek < 2) return null;
  // Monday: a new week starts fresh, so the strategy robots redraft.
  if (dayOfWeek === 0 && who !== "p4" && who !== "p6") prev = null;
  if (who === "p4") {
    if (!prev) { for (let t = 0; t < 200; t++) { const x = [...pool].sort(() => rand() - 0.5).slice(0, 5).map((p) => p.a); if (F.checkTeam(sheet, x).ok) return x; } return null; }
    if (rand() < 0.5) return prev;
    for (let t = 0; t < 50; t++) { const x = [...prev]; x[Math.floor(rand() * 5)] = pool[Math.floor(rand() * pool.length)].a; if (F.changes(prev, x) <= 1 && F.checkTeam(sheet, x).ok) return x; }
    return prev;
  }
  const v = val[who] || val.p2;
  if (who === "p6") return prev || bestTeam(pool, sheet.budget, val.p2);
  return prev ? oneStep(F, sheet, prev, v) : bestTeam(pool, sheet.budget, v);
}
export async function bots() {
  const c = readConfig(), keys = readKeys();
  if (c.clock.genesis === null || !c.picks) return;
  const p = await testnetProvider(c), F = mathOf(c), pc = picksContract(c, p);
  const now = NOW();
  let td = Math.max(F.dayNo(now), F.weekDays(0)[0]); while (F.lockOfDay(td) - now < 3 * 60_000) td++;
  const tw = F.weekOf(F.dayStart(td));
  const wf = readJsonFile(path.join(DATA(), `W${String(tw).padStart(3, "0")}.json`));
  const days = readJsonFile(path.join(DATA(), "days.json"));
  const mem: Record<string, { team: string[]; day: number; week: number }> = readJsonFile(BOTS()) || {};
  const pl = Object.fromEntries(PLAYERS.map((w) => [w, addressOf(keys, w)]));
  if (wf && wf.sheet) {
    const last = days && Array.isArray(days.days) && days.days.length ? days.days[days.days.length - 1] : null;
    const yesterday = (a: string) => { const x = last?.producers?.[a]; return Array.isArray(x) && x[2] != null ? x[2] : 90; };
    const size = (a: string) => { const x = last?.producers?.[a]; return Array.isArray(x) ? x[1] : 0; };
    const dayOfWeek = F.weekDays(tw).indexOf(td);
    for (const who of Object.keys(ROBOTS)) {
      const a = pl[who];
      const cur: any = (await (pc.functions as any).get_pick({ game: c.games.team, round: String(td), player: a })).result?.pick;
      if (cur?.producers?.length) continue;
      // Its team in force: the last one it saved (a team carries on, across weeks too, until changed).
      const m = mem[who], prev = m && m.day < td ? m.team : null;
      const team = robotTeam(who, F, wf.sheet, prev, { yesterday, size }, dayOfWeek, Math.random, !!m);
      if (!team || (prev && team.every((x, i) => x === prev[i]))) continue;   // no change: yesterday's team carries on
      try {
        await send(pc, "pick", { player: a, game: c.games.team, round: String(td), producers: team, number: "0" }, signerOf(keys, who, p), PICK_RC_KOIN);
        mem[who] = { team, day: td, week: tw };
        log(`  robot ${who}: team for test day ${dayOfWeek + 1} (captain ${team[0].slice(0, 8)}…)`);
      } catch (e) { log(`  robot ${who}: ${(e as Error).message.slice(0, 160)}`); }
    }
    fs.writeFileSync(BOTS(), JSON.stringify(mem, null, 1));
  }
  // Rival challenges for the next test week.
  let rw = now < F.weekStart(0) ? 0 : F.weekOf(now) + 1; while (F.lockOfWeek(rw) - now < 3 * 60_000) rw++;
  for (const [who, r] of Object.entries(ROBOTS)) {
    const target = r.rival(pl, Math.random);
    if (!target) continue;
    const cur: any = (await (pc.functions as any).get_pick({ game: c.games.rival, round: String(F.rivalRound(rw)), player: pl[who] })).result?.pick;
    if (cur?.producers?.length) continue;
    try { await send(pc, "pick", { player: pl[who], game: c.games.rival, round: String(F.rivalRound(rw)), producers: [target], number: "0" }, signerOf(keys, who, p), PICK_RC_KOIN); log(`  robot ${who}: challenges ${target.slice(0, 8)}… for test week ${rw + 1}`); }
    catch (e) { log(`  robot ${who} rival: ${(e as Error).message.slice(0, 160)}`); }
  }
}

/** A team or a rival challenge from the command line, as one test player. */
export async function cliPick(kind: "team" | "rival", who: string, what: string, sendIt: boolean) {
  const c = readConfig(), keys = readKeys();
  if (!PLAYERS.includes(who)) throw new Error(`Player must be one of ${PLAYERS.join(", ")}`);
  const p = await testnetProvider(c), F = mathOf(c), pc = picksContract(c, p), now = NOW(), s = signerOf(keys, who, p);
  if (kind === "rival") {
    const target = PLAYERS.includes(what) ? addressOf(keys, what) : what;
    if (!isAddr(target)) throw new Error("Rival must be an address or p1…p6");
    let rw = now < F.weekStart(0) ? 0 : F.weekOf(now) + 1; while (F.lockOfWeek(rw) - now < 60_000) rw++;
    log(`${who} challenges ${target} for test week ${rw + 1}`);
    if (!sendIt) { log("Dry run. Add --send."); return; }
    log(`✔ sent (${(await send(pc, "pick", { player: s.getAddress(), game: c.games.rival, round: String(F.rivalRound(rw)), producers: [target], number: "0" }, s, PICK_RC_KOIN)).slice(0, 18)}…)`);
    return;
  }
  let td = Math.max(F.dayNo(now), F.weekDays(0)[0]); while (F.lockOfDay(td) - now < 60_000) td++;
  const tw = F.weekOf(F.dayStart(td)), wf = readJsonFile(path.join(DATA(), `W${String(tw).padStart(3, "0")}.json`));
  if (!wf || !wf.sheet) throw new Error(`No price list for test week ${tw + 1} yet (it comes out ${new Date(F.sheetTime(tw)).toLocaleTimeString()}; run record).`);
  const byPrice = [...wf.sheet.pool].sort((x: any, y: any) => y.price - x.price);
  const team = what.split(",").map((x) => x.trim()).map((x) => (/^#\d+$/.test(x) ? byPrice[Number(x.slice(1)) - 1]?.a : x));
  const chk = F.checkTeam(wf.sheet, team);
  log(`${who} team for test day ${F.weekDays(tw).indexOf(td) + 1} of week ${tw + 1}: ${team.join(", ")}  (${chk.ok ? `cost ${chk.cost}` : chk.why})`);
  if (!chk.ok) throw new Error(`Not a valid team: ${chk.why}`);
  if (!sendIt) { log("Dry run. Add --send."); return; }
  log(`✔ sent (${(await send(pc, "pick", { player: s.getAddress(), game: c.games.team, round: String(td), producers: team, number: "0" }, s, PICK_RC_KOIN)).slice(0, 18)}…)`);
}

// ── the local practice page ──
/** The page's settings (public: addresses only, no keys). */
export function netScript(c: Config, keys: Record<string, string>): string {
  const net = {
    name: TESTNET.name, rpc: "/rpc", data: "/testnet-data/fantasy/", chainId: c.chainId, picks: c.picks ? c.picks.contract : null,
    clock: c.clock, games: c.games, players: PLAYERS.map((w) => ({ name: w, address: addressOf(keys, w), robot: w !== "p1" })),
  };
  return `/* Fantasy TESTNET settings, made by bot/fantasy-test.ts. Only the local practice server serves this file. */\n` +
    `window.KFantasyNet = Object.freeze(${JSON.stringify(net)});\n`;
}
/** The practice page: fantasy.html with a TESTNET bar, the test settings and the test wallet instead of the real ones.
 *  Exported for the tests. */
export function testPage(html: string): string {
  const swap = (a: string, b: string) => { if (!html.includes(a)) throw new Error(`fantasy.html changed: "${a}" not found`); html = html.replace(a, b); };
  swap("<title>", "<title>TESTNET · ");
  swap('<link rel="stylesheet" href="fantasy.css">', '<link rel="stylesheet" href="fantasy.css">\n  <link rel="stylesheet" href="/testnet/testnet.css">');
  html = html.replace(/<body([^>]*)>/, '<body$1>\n  <div class="tn-bar" role="note"><b>TESTNET</b> Practice with play money. 1 test day = 1 hour. Scored on real mainnet blocks. Not the live game. <label>Play as <select id="tn-player" aria-label="Test player"></select></label></div>');
  swap('<script src="guest.js"></script>', "");
  swap('<script src="wallet.js"></script>', '<script src="/testnet/fantasy-net.js"></script>\n  <script src="/testnet/test-wallet.js"></script>');
  swap('<script src="header-wallet.js"></script>', "");
  html = html.replace(/\s*<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/kondor-js[^"]*"[^>]*><\/script>/, "");   // not used on the practice page
  return html;
}
const RPC_METHODS = new Set(["chain.get_head_info", "chain.get_chain_id", "chain.read_contract", "block_store.get_blocks_by_height", "chain.get_account_rc",
  "chain.get_account_nonce", "chain.get_resource_limits", "contract_meta_store.get_contract_meta"]);
export const PICK_ENTRY = 0x8ce33c6c;
export async function startSite(opts: { port?: number } = {}) {
  const c = readConfig(), keys = readKeys();
  await testnetProvider(c);
  let port = opts.port ?? (await freePort(SITE_PORT));
  const token = crypto.randomBytes(24).toString("hex");
  let origin = `http://127.0.0.1:${port}`;
  const p = new Provider([c.rpc]);
  const abi = PICKS_ABI();
  const types: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json" };
  const sendFile = (res: http.ServerResponse, file: string) => {
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); res.end("not found"); return; }
      res.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      res.end(buf);
    });
  };
  const body = (req: http.IncomingMessage, max = 256 * 1024) => new Promise<string>((ok, bad) => {
    let n = 0; const parts: Buffer[] = [];
    req.on("data", (d: Buffer) => { n += d.length; if (n > max) { bad(new Error("too big")); req.destroy(); } else parts.push(d); });
    req.on("end", () => ok(Buffer.concat(parts).toString("utf8"))); req.on("error", bad);
  });
  const json = (res: http.ServerResponse, code: number, v: any) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(v)); };
  const server = http.createServer(async (req, res) => {
    res.setHeader("x-frame-options", "DENY");
    res.setHeader("content-security-policy", "frame-ancestors 'none'");
    try {
      // Only this PC's browser, on this address: no other host name (DNS rebinding) and no other site (CSRF).
      if (req.headers.host !== `127.0.0.1:${port}`) { res.writeHead(403); res.end("use " + origin); return; }
      const url = new URL(req.url ?? "/", origin), u = decodeURIComponent(url.pathname);
      if (req.method === "POST") {
        if (req.headers.origin !== origin || (req.headers["sec-fetch-site"] && req.headers["sec-fetch-site"] !== "same-origin")) { json(res, 403, { error: "other sites can't use the practice server" }); return; }
        if (u === "/rpc") {
          const b = JSON.parse(await body(req));
          if (!b || typeof b.method !== "string" || !RPC_METHODS.has(b.method)) { json(res, 403, { error: `method not allowed: ${b?.method}` }); return; }
          const r = await fetch(c.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: b.id ?? 1, method: b.method, params: b.params ?? {} }) });
          res.writeHead(r.status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(await r.text()); return;
        }
        if (u === "/test/send") {
          const b = JSON.parse(await body(req));
          if (!b || b.token !== token) { json(res, 403, { error: "reload the page" }); return; }
          const who = String(b.as || "");
          if (!PLAYERS.includes(who)) { json(res, 400, { error: "unknown test player" }); return; }
          const cur = readConfig();
          if (cur.rpc !== c.rpc || cur.chainId !== c.chainId) { json(res, 409, { error: "the test settings changed: restart the run command" }); return; }
          const ops = Array.isArray(b.ops) ? b.ops : [];
          if (ops.length !== 1 || !cur.picks) { json(res, 400, { error: "a test wallet sends exactly one Fantasy pick" }); return; }
          const op = ops[0]?.call_contract;
          if (!op || op.contract_id !== cur.picks.contract || Number(op.entry_point) !== PICK_ENTRY) { json(res, 400, { error: "a test wallet signs only Fantasy picks on the testnet Picks contract" }); return; }
          const pc = new Contract({ id: cur.picks.contract, abi, provider: p });
          const dec: any = await pc.decodeOperation({ call_contract: op } as any);
          const s = signerOf(keys, who, p), a = dec?.args ?? {}, game = Number(a.game), list = Array.isArray(a.producers) ? a.producers : [];
          const okTeam = game === cur.games.team && list.length === 5 && list.every(isAddr) && new Set(list).size === 5;
          const okRival = game === cur.games.rival && list.length === 1 && isAddr(list[0]) && list[0] !== s.getAddress();
          if (dec?.name !== "pick" || a.player !== s.getAddress() || !(okTeam || okRival) || String(a.number || "0") !== "0") { json(res, 400, { error: "that isn't a Fantasy team or rival pick for this test player" }); return; }
          try { const id = await send(pc, "pick", { player: a.player, game, round: String(a.round), producers: list, number: "0" }, s, PICK_RC_KOIN); json(res, 200, { id }); }
          catch (e) { json(res, 400, { error: String((e as Error).message).slice(0, 300) }); }
          return;
        }
        res.writeHead(404); res.end(); return;
      }
      if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); res.end(); return; }
      if (u === "/" || u === "/site/" || u === "/site/fantasy.html") { res.writeHead(302, { location: "/site/fantasy-testnet.html" }); res.end(); return; }
      if (u === "/site/fantasy-testnet.html") { res.writeHead(200, { "content-type": types[".html"], "cache-control": "no-store" }); res.end(testPage(fs.readFileSync(path.join(ROOT, "site", "fantasy.html"), "utf8"))); return; }
      if (u === "/testnet/fantasy-net.js") { res.writeHead(200, { "content-type": types[".js"], "cache-control": "no-store" }); res.end(netScript(readConfig(), keys)); return; }
      if (u === "/testnet/session") {
        if (req.headers["sec-fetch-site"] && req.headers["sec-fetch-site"] !== "same-origin") { json(res, 403, {}); return; }
        json(res, 200, { token }); return;
      }
      if (/^\/testnet\/(test-wallet\.js|testnet\.css)$/.test(u)) { sendFile(res, path.join(ROOT, "tools", "fantasy-testnet", path.basename(u))); return; }
      const m = /^\/testnet-data\/fantasy\/(index|days|board|rivals|alltime|W\d{3})\.json$/.exec(u);
      if (m) { sendFile(res, path.join(DATA(), `${m[1]}.json`)); return; }
      if (u === "/picks/abi/picks.koilib.json") { sendFile(res, path.join(ROOT, "picks", "abi", "picks.koilib.json")); return; }
      // The site's own scripts, styles and images only; the only page here is the TESTNET one.
      const sm = /^\/site\/([A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.(?:js|css|json|svg|png|webmanifest))$/.exec(u);
      if (sm) { sendFile(res, path.join(ROOT, "site", ...sm[1].split("/"))); return; }
      res.writeHead(404); res.end("not found");
    } catch (e) { json(res, 500, { error: String((e as Error).message).slice(0, 200) }); }
  });
  await new Promise<void>((ok) => server.listen(port, "127.0.0.1", ok));
  port = (server.address() as any).port; origin = `http://127.0.0.1:${port}`;
  log(`Practice page: ${origin}/site/fantasy-testnet.html  (only this PC can open it)`);
  return server;
}
export async function freePort(start: number): Promise<number> {
  const net = await import("node:net");
  for (let p = start; p < start + 20; p++) {
    const ok = await new Promise<boolean>((done) => { const t = net.createServer(); t.once("error", () => done(false)); t.listen(p, "127.0.0.1", () => t.close(() => done(true))); });
    if (ok) return p;
  }
  throw new Error(`Ports ${start}–${start + 19} are all in use. Choose another: --port 9100`);
}

export async function tick(withBots: boolean) {
  try { const r = await record(); log(`[${new Date().toLocaleTimeString()}] recorded${r.problems.length ? `; ${r.problems.length} note(s): ${r.problems.slice(0, 3).join(" | ")}` : ""}`); }
  catch (e) { log(`[${new Date().toLocaleTimeString()}] recorder: ${(e as Error).message}`); }
  if (withBots) { try { await bots(); } catch (e) { log(`robots: ${(e as Error).message}`); } }
}
/** Open the practice page in the default browser (the address is this server's own, nothing from outside). */
async function openBrowser(url: string) {
  if (!/^http:\/\/127\.0\.0\.1:\d+\/site\/fantasy-testnet\.html$/.test(url)) return;
  const { spawn } = await import("node:child_process");
  const [cmd, args] = process.platform === "win32" ? ["explorer.exe", [url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try { spawn(cmd, args as string[], { stdio: "ignore", detached: true }).on("error", () => {}).unref(); } catch { /* open it by hand */ }
}
async function runAll(withBots: boolean, open: boolean) {
  const c = readConfig(); readKeys();
  if (c.clock.genesis === null) throw new Error("Set the test week first: npm run fantasy-test -- week next");
  const server = await startSite();
  if (open) await openBrowser(`http://127.0.0.1:${(server.address() as any).port}/site/fantasy-testnet.html`);
  await tick(withBots);
  setInterval(() => tick(withBots), 2 * 60_000);
  log("Running. Leave this window open; press Ctrl+C to stop.");
}

async function main() {
  const [cmd = "status", ...a] = process.argv.slice(2);
  const sendIt = a.includes("--send"), args = a.filter((x) => !x.startsWith("--"));
  switch (cmd) {
    case "setup": return setup();
    case "status": return status();
    case "fund": return fund(sendIt);
    case "picks-build": return picksBuild();
    case "picks-upload": return picksUpload(sendIt);
    case "games": return games(sendIt);
    case "week": return week(args[0]);
    case "team": return cliPick("team", args[0], args[1] || "", sendIt);
    case "rival": return cliPick("rival", args[0], args[1] || "", sendIt);
    case "record": { const r = await record(); log(r.problems.length ? r.problems.join("\n") : "recorded, no problems"); return; }
    case "bots": return bots();
    case "site": await startSite(); return;
    case "run": return runAll(a.includes("--bots"), !a.includes("--no-open"));
    default: throw new Error(`Unknown command "${cmd}". Commands: setup, status, fund, picks-build, picks-upload, games, week, team, rival, record, run`);
  }
}
if (process.argv[1] && /fantasy-test\.ts$/.test(process.argv[1])) {
  main().catch((e) => { console.error(`\n✖ ${e.message ?? e}`); process.exit(1); });
}

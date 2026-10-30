/**
 * SURVIVOR TESTNET TOOL. Runs a complete copy of Survivor on the Koinos Foundation testnet (play money), with a fast
 * clock (one "day" = one hour by default, so a 14-day season takes 14 hours), test wallets, a testnet copy of the
 * KnodeGames Picks contract, the recorder, robot players and a local test page. It never touches mainnet: every
 * command checks the node's chain id first and refuses mainnet.
 *
 *   npm run survivor-test -- setup                   make the test wallets (once)
 *   npm run survivor-test -- status                  the testnet, the wallets, the contract, the game and the season
 *   npm run survivor-test -- fund [--send]           send test KOIN from the test owner to the players and the Picks wallet
 *   npm run survivor-test -- picks-build             build the testnet Picks contract (test owner, 10-minute admin wait)
 *   npm run survivor-test -- picks-upload [--send]   put it on the testnet
 *   npm run survivor-test -- game [--send]           announce game 3 (Survivor), then (10 minutes later) put it in force
 *   npm run survivor-test -- season [round|next]     start Season 1 on a round (default: the next round you can join)
 *   npm run survivor-test -- pick <player> <producer|#n> [round] [--send]   pick as a test player (#n = nth in the field)
 *   npm run survivor-test -- record                  one recorder run (writes testnet-data/survivor/data)
 *   npm run survivor-test -- run [--bots]            the test page + the recorder every 2 minutes (+ robot players)
 *
 * Everything it makes stays in testnet-data/survivor/ (git-ignored): keys.env (the throwaway TEST keys; never use them
 * on mainnet), config.json, data/ (the recorder's files) and picks-src/ (the testnet build).
 * The test page: http://127.0.0.1:8370 (or the next free port; it prints the address) while `run` is going. It is served only to this PC.
 */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Signer, Provider, Contract } from "koilib";
import { tokenAbi } from "./token-abi.ts";
await import("../survivor-math.js");
const KS: any = (globalThis as any).KSurvivor;

// ── the testnet (from SwarmTales' deploy/lib.js, which the owner has used on it since October 2026) ──
export const TESTNET = {
  name: "Koinos testnet (Koinos Foundation)",
  rpc: process.env.SURVIVOR_TEST_RPC || "https://testnet.koinosfoundation.org",
  // Read 23–25 Oct 2026. The testnet can be reset with a new chain id: `setup` saves the one it finds, and every later
  // command stops if the node says something else.
  chainId: "EiAIKVvm6-V2qmsmUvPJy09vCCLbtn9lHFpwrJbcTIEWRQ==",
  koin: "1FaSvLjQJsCJKq5ybmGsMMQs8RQYyVv8ju",
  faucet: "https://t.me/KoinosTestnetFaucetBot",
};
export const MAINNET_CHAIN_ID = "EiBZK_GGVP0H_fXVAM3j6EAuz3-B-l3ejxRSewi7qIBfSA==";
const MAINNET_RPC = /api\.koinos\.io|koinos\.armana\.io|koinosblocks\.com|api\.koinos\.pro(?!.*harbinger)/i;
export const PLAYERS = ["p1", "p2", "p3", "p4", "p5", "p6"];
export const PICK_ENTRY = 0x8ce33c6c;
export const TEST_DAY_MS = 3_600_000;              // one test "day" (round) = 1 hour (owner, 2026-10-28)
export const TEST_TIMELOCK_MS = 10 * 60_000;       // the testnet Picks build waits 10 minutes, not 48 hours
// The test page's port: 8370, or the next free one (8090 is the owner's own Koinos node, 8350 the Block X test page).
// Choose another with --port 8400 or SURVIVOR_TEST_PORT.
const portArg = process.argv.indexOf("--port");
const SITE_PORT = Number((portArg > 0 && process.argv[portArg + 1]) || process.env.SURVIVOR_TEST_PORT || 8370);
/** A pick asks for at most this much Mana: ~0.05 is used (Block X testnet, 28 Oct). A big limit is held aside until the
 *  pick settles, so a second quick pick would fail with "insufficient pending account resources". */
const PICK_RC_KOIN = 0.3;
/** The first port from `start` that this PC isn't using (tries 20). Exported for the tests. */
export async function freePort(start: number): Promise<number> {
  const net = await import("node:net");
  for (let p = start; p < start + 20; p++) {
    const ok = await new Promise<boolean>((done) => { const t = net.createServer(); t.once("error", () => done(false)); t.listen(p, "127.0.0.1", () => t.close(() => done(true))); });
    if (ok) return p;
  }
  throw new Error(`Ports ${start}–${start + 19} are all in use. Choose another: --port 9100`);
}

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const DIR = process.env.SURVIVOR_TEST_DIR || path.join(ROOT, "testnet-data", "survivor");
/** The audited Picks build (Build 3), which this PC's tools must reproduce before the testnet copy is built. */
export const AUDITED_PICKS_WASM = "700c296a1064b904299c156061d6caf8fcabd0b1765968903f29d89d2426c594";
/** One run of the recorder at a time on the test data (Repo Lense S3-34): `run` holds the lock while it runs. */
export function takeLock(dir = DIR) {
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, ".lock");
  let pid = 0;
  try { pid = Number(fs.readFileSync(f, "utf8")) || 0; } catch { /* no lock */ }
  const alive = (n: number) => { try { process.kill(n, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } };
  if (pid && pid !== process.pid && alive(pid)) throw new Error(`Another survivor-test command (process ${pid}) is using the test data. Stop it first (Ctrl+C in its window).`);
  fs.writeFileSync(f, String(process.pid));
  process.on("exit", () => { try { if (Number(fs.readFileSync(f, "utf8")) === process.pid) fs.unlinkSync(f); } catch { /* gone */ } });
}
const KEYS = () => path.join(DIR, "keys.env"), CONFIG = () => path.join(DIR, "config.json"), DATA = () => path.join(DIR, "data");
const PICKS_SRC = () => path.join(DIR, "picks-src");
const log = (...a: any[]) => console.log(...a);
const isAddr = (a: unknown): a is string => typeof a === "string" && /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a);
const sha256hex = (b: Uint8Array) => crypto.createHash("sha256").update(b).digest("hex");
const koin = (sat: bigint | string | number) => (Number(sat) / 1e8).toLocaleString("en-US", { maximumFractionDigits: 4 });
const toSat = (k: number) => BigInt(Math.round(k * 1e8));

// ── files ──
type Config = {
  v: 1; rpc: string; chainId: string; koin: string; vhp: string | null; holdToken: string | null;
  clock: { day: number; firstDay: number | null; outFloor: number };
  picks: { contract: string; sha256: string; uploadTx?: string; uploadedAt?: string } | null;
  game: { announcedAt: number; eta: number } | null;
};
export function readConfig(): Config {
  if (!fs.existsSync(CONFIG())) throw new Error("No test setup yet. Run: npm run survivor-test -- setup");
  return JSON.parse(fs.readFileSync(CONFIG(), "utf8"));
}
const writeConfig = (c: Config) => { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(CONFIG(), JSON.stringify(c, null, 2) + "\n"); };
/** The test keys: OWNER, PICKS and P1…P6, from testnet-data/survivor/keys.env. */
export function readKeys(): Record<string, string> {
  if (!fs.existsSync(KEYS())) throw new Error("No test wallets yet. Run: npm run survivor-test -- setup");
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
const addressOf = (keys: Record<string, string>, who: string) => signerOf(keys, who).getAddress();
/** The test clock as KSurvivor.withConfig takes it. */
export const mathOf = (c: Config) => KS.withConfig({ day: c.clock.day, firstDay: c.clock.firstDay, outFloor: c.clock.outFloor });

// ── the network guard ──
/** The node must be the testnet this setup was made on, never mainnet. Returns a provider. */
export async function testnetProvider(c: { rpc: string; chainId?: string } = { rpc: TESTNET.rpc }): Promise<Provider> {
  if (MAINNET_RPC.test(c.rpc)) throw new Error(`${c.rpc} is a mainnet node. This tool only runs on the testnet.`);
  const p = new Provider([c.rpc]);
  let id: string;
  try { id = await p.getChainId(); } catch (e) { throw new Error(`The testnet node ${c.rpc} doesn't answer (${(e as Error).message}). Check your internet, or try again in a minute.`); }
  if (id === MAINNET_CHAIN_ID) throw new Error(`${c.rpc} is MAINNET (chain id ${id}). This tool only runs on the testnet.`);
  if (c.chainId && id !== c.chainId) throw new Error(`The testnet's chain id is now ${id}, not ${c.chainId} as when you set up: the testnet was probably reset. Start again: delete the folder ${DIR} and run setup.`);
  CHECKED_CHAIN = id;
  return p;
}
/** The chain id testnetProvider checked. Every transaction is signed for it (review TN-2): a node that changes its
 *  answer after the check can't get a signature for another chain. */
let CHECKED_CHAIN: string | null = null;

// ── tokens and producers on the testnet ──
/** KOIN and VHP from recent blocks' events (each block mints KOIN to its producer and burns VHP from it). */
async function discoverVhp(p: Provider): Promise<string | null> {
  try {
    const head: any = await p.getHeadInfo();
    const h = Number(head.head_topology.height);
    const res: any = await p.call("block_store.get_blocks_by_height", { head_block_id: head.head_topology.id, ancestor_start_height: String(Math.max(1, h - 40)), num_blocks: 40, return_block: false, return_receipt: true });
    const burn = new Map<string, number>();
    for (const it of res.block_items ?? []) for (const ev of it.receipt?.events ?? []) if (/burn/i.test(ev.name ?? "") && ev.source !== TESTNET.koin) burn.set(ev.source, (burn.get(ev.source) ?? 0) + 1);
    return [...burn.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  } catch { return null; }
}
/** Who signed the last n blocks, most first. */
async function recentProducers(p: Provider, n = 1200): Promise<[string, number][]> {
  const head: any = await p.getHeadInfo();
  const top = Number(head.head_topology.height), from = Math.max(1, top - n + 1), count = new Map<string, number>();
  for (let s = from; s <= top; s += 200) {
    const res: any = await p.call("block_store.get_blocks_by_height", { head_block_id: head.head_topology.id, ancestor_start_height: String(s), num_blocks: Math.min(200, top - s + 1), return_block: true, return_receipt: false });
    for (const it of res.block_items ?? []) { const a = it.block?.header?.signer; if (isAddr(a)) count.set(a, (count.get(a) || 0) + 1); }
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1]);
}
async function balance(p: Provider, token: string, who: string): Promise<bigint> {
  const c = new Contract({ id: token, abi: tokenAbi as any, provider: p });
  const r: any = await (c.functions as any).balance_of({ owner: who });
  return BigInt(r?.result?.value ?? "0");
}
const PICKS_ABI = () => JSON.parse(fs.readFileSync(path.join(ROOT, "picks", "abi", "picks.koilib.json"), "utf8"));
const picksContract = (c: Config, p: Provider, signer?: Signer) => {
  if (!c.picks) throw new Error("No testnet Picks contract yet: npm run survivor-test -- picks-upload --send");
  return new Contract({ id: c.picks.contract, abi: PICKS_ABI(), provider: p, ...(signer ? { signer } : {}) });
};
/** Game 3 with the test clock. Exported for the tests. */
export function testGame(day: number) {
  return { id: 3, name: "Survivor (testnet)", kind: 1, list_size: 1, number_min: "0", number_max: "0", lock_mode: 2,
    round_size: String(day), round_offset: "0", lead: String(KS.LEAD_MS), ahead: String(7 * day),
    max_picks_per_day: 50, max_changes: KS.MAX_CHANGES, enabled: true };
}
/** Send one contract call signed and paid by `signer`, and wait for its block. */
async function send(c: Contract, method: string, args: any, signer: Signer, rcKoin = 2): Promise<string> {
  const have = BigInt(await (signer.provider as Provider).getAccountRc(signer.getAddress()));
  const rc = toSat(rcKoin) < have ? toSat(rcKoin) : (have * 95n) / 100n;
  const k = new Contract({ id: c.getId(), abi: c.abi, provider: signer.provider as Provider, signer });
  if (!CHECKED_CHAIN || CHECKED_CHAIN === MAINNET_CHAIN_ID) throw new Error("Not sending: the network wasn't checked (or is mainnet).");
  const { transaction, receipt } = await (k.functions as any)[method](args, { payer: signer.getAddress(), rcLimit: rc.toString(), chainId: CHECKED_CHAIN });
  if (receipt?.reverted) throw new Error(`${method} reverted: ${JSON.stringify(receipt.logs)}`);
  await transaction.wait("byBlock", 120_000);
  return transaction.id;
}

// ── commands ──
async function setup() {
  if (fs.existsSync(KEYS())) { log(`Test wallets already exist in ${KEYS()}. (To start over, delete that folder.)`); return status(); }
  const p = await testnetProvider();
  const chainId = await p.getChainId();
  if (chainId !== TESTNET.chainId) log(`Note: the testnet's chain id is ${chainId} (it was ${TESTNET.chainId} on 25 Oct): it was reset since. Fine for testing.`);
  fs.mkdirSync(DIR, { recursive: true });
  const lines = ["# Survivor TESTNET wallets. Throwaway keys for play money only. NEVER use them on mainnet, never share or commit.", ""];
  for (const who of ["OWNER", "PICKS", ...PLAYERS.map((x) => x.toUpperCase())]) {
    const s = new Signer({ privateKey: crypto.randomBytes(32).toString("hex") });
    lines.push(`${who}_WIF=${s.getPrivateKey("wif")}`);
  }
  fs.writeFileSync(KEYS(), lines.join("\n") + "\n", { mode: 0o600 });
  const vhp = await discoverVhp(p);
  // The "hold 1 VHP" rule checks test KOIN on the testnet: the test wallets have no VHP, and the check runs the same way.
  writeConfig({ v: 1, rpc: TESTNET.rpc, chainId, koin: TESTNET.koin, vhp, holdToken: TESTNET.koin, clock: { day: TEST_DAY_MS, firstDay: null, outFloor: 1 }, picks: null, game: null });
  const keys = readKeys();
  log(`✔ Test wallets made (keys in ${KEYS()}, git-ignored).`);
  log(`\nNext: get free test KOIN for the test OWNER wallet from the faucet bot on Telegram (${TESTNET.faucet}).`);
  log(`Send it /start, then this line:`);
  log(`   /faucet ${addressOf(keys, "owner")}`);
  log(`(100 test KOIN per claim; one claim a day. Then run: npm run survivor-test -- fund --send)`);
}

async function status() {
  const c = readConfig(), keys = readKeys();
  const p = await testnetProvider(c);
  const head: any = await p.getHeadInfo();
  const S = mathOf(c), now = Number(head.head_block_time), r = S.dayIndex(now);
  log(`${TESTNET.name}  ${c.rpc}`);
  log(`  chain id ${c.chainId}, head block ${Number(head.head_topology.height).toLocaleString()} (${new Date(now).toISOString()})`);
  log(`  test clock: 1 round = ${c.clock.day / 60000} minutes; now round ${r} (${S.dayLabel(r)} UTC); out-zone floor ${c.clock.outFloor}`);
  log(`\nWallets (KOIN = Mana)`);
  for (const who of ["owner", "picks", ...PLAYERS]) {
    const a = addressOf(keys, who);
    const [k, rc] = await Promise.all([balance(p, c.koin, a).catch(() => 0n), p.getAccountRc(a).catch(() => "0")]);
    const v = c.holdToken ? await balance(p, c.holdToken, a).catch(() => 0n) : 0n;
    log(`  ${who.padEnd(6)} ${a}  KOIN ${koin(k).padStart(8)}  Mana ${koin(rc).padStart(8)}${c.holdToken ? `  hold-token ${koin(v)}` : ""}`);
  }
  const prods = await recentProducers(p, 1200).catch(() => []);
  log(`\nProducers in the last 1,200 blocks: ${prods.length}${prods.length < 4 ? "  (a small field: the out-zone floor keeps at least 1 out)" : ""}`);
  for (const [a, n] of prods.slice(0, 20)) log(`  ${a}  ${n}`);
  if (!c.picks) { log(`\nPicks contract: not uploaded yet (npm run survivor-test -- picks-build, then picks-upload --send)`); return; }
  const pc = picksContract(c, p);
  const g: any = (await (pc.functions as any).get_game({ game: 3 }).catch(() => ({ result: {} }))).result ?? {};
  log(`\nPicks contract ${c.picks.contract} (testnet build ${c.picks.sha256.slice(0, 12)}…)`);
  log(`  game 3: ${g.game ? `${g.game.enabled ? "ON" : "off"}, round ${Number(g.game.round_size) / 60000} min, lead ${Number(g.game.lead) / 60000} min` : "not in force yet"}${g.pending ? `; announced, can be applied from ${new Date(Number(g.pending.eta)).toISOString()}` : ""}`);
  if (c.clock.firstDay === null) { log(`\nSeason 1: not started (npm run survivor-test -- season)`); return; }
  const se = S.seasonOf(r);
  log(`\nSeason 1 starts round ${c.clock.firstDay} (${S.dayLabel(c.clock.firstDay)} UTC)${se ? `; now season ${se.season}, day ${se.n} of 14` : `; in ${((S.dayStart(c.clock.firstDay) - now) / 60000).toFixed(0)} minutes`}`);
  const sf = path.join(DATA(), `S${String(se ? se.season : 1).padStart(3, "0")}.json`);
  if (fs.existsSync(sf)) {
    const j = JSON.parse(fs.readFileSync(sf, "utf8"));
    const names = new Map(["owner", ...PLAYERS].map((w) => [addressOf(keys, w), w]));
    log(`  recorded days: ${j.days.length}${j.result?.over ? " (over)" : ""}${j.result?.final ? " (final)" : ""}`);
    for (const x of j.result?.players ?? []) log(`  #${x.place} ${(names.get(x.a) ?? x.a).padEnd(6)} lives ${x.lives}${x.outN ? ` (out day ${x.outN})` : ""}  score ${x.total}  log ${x.log}`);
    for (const pr of j.result?.prizes ?? []) log(`  prize: ${names.get(pr.player) ?? pr.player} ${pr.vhp} VHP (place ${pr.place})`);
  }
}

async function fund(sendIt: boolean) {
  const c = readConfig(), keys = readKeys();
  const p = await testnetProvider(c);
  const owner = signerOf(keys, "owner", p);
  const have = await balance(p, c.koin, owner.getAddress());
  // One faucet claim (100) covers it all: 50 for the contract upload, 6 for each player, ~14 left for the owner's Mana.
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
  log("Done. Next: npm run survivor-test -- picks-build");
}

/** sha256 of picks/assembly/Picks.ts as audited (LF line endings). The testnet build starts only from this exact source
 *  (audit SV-A22): if the contract changes, this tool must be re-checked and the hash updated with it. */
export const PICKS_SOURCE_SHA256 = "444209c16b2ad517e335ead1f5eef740e63761bc1d26b8115b56461ea1e583d6";
/** Build the testnet Picks contract: the audited source with two constants changed (the test owner, a 10-minute admin
 *  wait). Each change must match exactly once (audit SV-A22). Exported for the tests (which pass pinned = null to test
 *  the exactly-once rule on an edited source). Returns the patched source. */
export function patchPicksSource(src: string, owner: string, pinned: string | null = PICKS_SOURCE_SHA256): string {
  if (!isAddr(owner)) throw new Error("bad test owner address");
  src = src.replace(/\r\n/g, "\n");
  if (pinned !== null && crypto.createHash("sha256").update(src, "utf8").digest("hex") !== pinned)
    throw new Error("picks/assembly/Picks.ts changed since the audit (its sha256 isn't the pinned one): the testnet patch needs re-checking before it builds anything");
  const a = 'export const INITIAL_OWNER: Uint8Array = Base58.decode("1635QUrBNDp7WqmFkRvrkGwjJXTtFvH717");';
  const b = /^export const TIMELOCK_MS: u64 = 2 \* DAY_MS;.*$/gm;
  const nA = src.split(a).length - 1, nB = (src.match(b) ?? []).length;
  if (nA !== 1 || nB !== 1) throw new Error(`picks/assembly/Picks.ts changed: the testnet patch must change each line exactly once (owner line found ${nA}×, admin-wait line ${nB}×)`);
  return src.replace(a, `export const INITIAL_OWNER: Uint8Array = Base58.decode("${owner}");   // TESTNET BUILD: the test owner`)
    .replace(b, `export const TIMELOCK_MS: u64 = ${TEST_TIMELOCK_MS};   // TESTNET BUILD: 10 minutes, not 48 hours`);
}
async function picksBuild() {
  const c = readConfig(), keys = readKeys();
  const src = path.join(ROOT, "picks"), dst = PICKS_SRC();
  if (!fs.existsSync(path.join(src, "node_modules"))) throw new Error("First install the contract tools once: cd picks; npm ci; cd ..");
  try { execSync("yarn --version", { stdio: "ignore" }); } catch { throw new Error("The contract builder needs yarn. Install it once: npm install -g yarn"); }
  // Remove the old copy's link to picks/node_modules first, so deleting the copy never reaches into the real folder
  // (review TN-4: Windows junctions).
  const link = path.join(dst, "node_modules");
  try { if (fs.lstatSync(link).isSymbolicLink() || process.platform === "win32") { try { fs.unlinkSync(link); } catch { fs.rmdirSync(link); } } } catch { /* no old copy */ }
  fs.rmSync(dst, { recursive: true, force: true });
  fs.cpSync(src, dst, { recursive: true, filter: (f) => !/[\\/](node_modules|build|abi)([\\/]|$)/.test(f.slice(src.length)) });
  fs.symlinkSync(path.join(src, "node_modules"), path.join(dst, "node_modules"), "junction");
  // The build's helper scripts sit at the repo root (the pinned protobuf helpers and the checked protoc 21.12, Repo
  // Lense S2-8); point the copy at them. Each must be there exactly once.
  const pre = path.join(dst, "scripts", "prebuild.cjs");
  let preSrc = fs.readFileSync(pre, "utf8");
  for (const helper of ["pbjs-helpers/install.cjs", "protoc-pin.cjs"]) {
    const rel = `require("../../tools/${helper}")`;
    if (preSrc.split(rel).length !== 2) throw new Error(`picks/scripts/prebuild.cjs changed (${helper}): the testnet build needs updating`);
    preSrc = preSrc.replace(rel, `require(${JSON.stringify(path.join(ROOT, "tools", ...helper.split("/")))})`);
  }
  if (/\.\.\/\.\.\//.test(preSrc)) throw new Error("picks/scripts/prebuild.cjs reaches outside the folder in a way the testnet build doesn't know");
  fs.writeFileSync(pre, preSrc);
  // The build and its safety check never take their paths from the shell (Repo Lense S3-19).
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^PICKS_/.test(k)) delete env[k];
  const build = () => {
    let ok = false;
    for (let i = 0; i < 4 && !ok; i++) {
      try { execSync("npm run build", { cwd: dst, env, stdio: ["ignore", "ignore", "pipe"] }); ok = true; } catch { log(`  build try ${i + 1} failed (often a temporary EAGAIN), trying again…`); }
    }
    if (!ok) throw new Error(`The build failed. Try: cd ${dst}; npm run build — and send Claude the error.`);
  };
  // First the audited source as it is: this PC's tools must reproduce the audited contract exactly (S3-19), so the
  // testnet copy differs from it only by the two changed lines.
  log("Checking that this PC's tools rebuild the audited Picks contract exactly (a minute or two)…");
  build();
  const audited = sha256hex(fs.readFileSync(path.join(dst, "build", "release", "contract.wasm")));
  if (audited !== AUDITED_PICKS_WASM) throw new Error(`This PC's tools build the audited Picks contract as ${audited.slice(0, 12)}…, not the audited ${AUDITED_PICKS_WASM.slice(0, 12)}…: stopping. Send Claude this message.`);
  log(`  ✔ audited build reproduced (${AUDITED_PICKS_WASM.slice(0, 12)}…)`);
  const file = path.join(dst, "assembly", "Picks.ts");
  fs.writeFileSync(file, patchPicksSource(fs.readFileSync(file, "utf8"), addressOf(keys, "owner")));
  log("Building the testnet Picks contract (a minute or two)…");
  build();
  execSync("node scripts/check.cjs", { cwd: dst, env, stdio: "inherit" });
  const wasm = fs.readFileSync(path.join(dst, "build", "release", "contract.wasm"));
  log(`✔ testnet Picks build ${(wasm.length / 1024).toFixed(1)} KB, sha256 ${sha256hex(wasm)} (owner ${addressOf(keys, "owner")}, admin wait 10 minutes)`);
  log("Next: npm run survivor-test -- picks-upload --send");
  void c;
}

/** Exported for the tests (audit SV-A1). */
export async function picksUpload(sendIt: boolean) {
  const c = readConfig(), keys = readKeys();
  const p = await testnetProvider(c);
  const wasmFile = path.join(PICKS_SRC(), "build", "release", "contract.wasm");
  if (!fs.existsSync(wasmFile)) throw new Error("Build it first: npm run survivor-test -- picks-build");
  const src = fs.readFileSync(path.join(PICKS_SRC(), "assembly", "Picks.ts"), "utf8");
  if (!src.includes(addressOf(keys, "owner"))) throw new Error("The build isn't for this test owner. Run picks-build again.");
  const wasm = fs.readFileSync(wasmFile), abi = JSON.parse(fs.readFileSync(path.join(PICKS_SRC(), "abi", "picks.koilib.json"), "utf8"));
  const s = signerOf(keys, "picks", p), A = s.getAddress();
  const rc = BigInt(await p.getAccountRc(A));
  log(`Testnet Picks wallet ${A}: Mana ${koin(rc)}; code ${(wasm.length / 1024).toFixed(1)} KB, sha256 ${sha256hex(wasm)}`);
  log("Overrides ON (as on mainnet): the contract itself refuses moving anything, paying Mana, and any upgrade except the owner's announced one.");
  const needRc = toSat(Math.ceil((wasm.length / 1024) * 1.2 + 10));     // the race tool's estimate for an upload
  log(`Mana needed: about ${koin(needRc)}`);
  if (rc < needRc) throw new Error(`The Picks wallet needs about ${koin(needRc)} test KOIN of Mana: npm run survivor-test -- fund --send`);
  if (!sendIt) { log("\nDry run. Add --send to upload."); return; }
  // Signed for the chain id checked above, like every other send (audit SV-A1): without chainId, koilib asks the node
  // again while it builds the transaction, and a node that changed its answer would get a signature for another chain.
  if (!CHECKED_CHAIN || CHECKED_CHAIN === MAINNET_CHAIN_ID) throw new Error("Not uploading: the network wasn't checked (or is mainnet).");
  const k = new Contract({ id: A, abi, provider: p, signer: s, bytecode: new Uint8Array(wasm) });
  const { transaction, receipt } = await k.deploy({ abi: JSON.stringify(abi), authorizesCallContract: true, authorizesTransactionApplication: true, authorizesUploadContract: true,
    payer: A, rcLimit: ((rc * 95n) / 100n).toString(), chainId: CHECKED_CHAIN } as any);
  if (receipt?.reverted) throw new Error(`upload reverted: ${JSON.stringify(receipt.logs)}`);
  await transaction.wait("byBlock", 180_000);
  c.picks = { contract: A, sha256: sha256hex(wasm), uploadTx: transaction.id, uploadedAt: new Date().toISOString() };
  c.game = null;
  writeConfig(c);
  log(`✔ uploaded (Mana used ${koin(receipt?.rc_used ?? 0)}). Next: npm run survivor-test -- game --send`);
}

async function game(sendIt: boolean) {
  const c = readConfig(), keys = readKeys();
  const p = await testnetProvider(c);
  const owner = signerOf(keys, "owner", p), pc = picksContract(c, p);
  const cur: any = (await (pc.functions as any).get_game({ game: 3 })).result ?? {};
  const want = testGame(c.clock.day);
  if (cur.game && Number(cur.game.round_size) === c.clock.day && cur.game.enabled) { log(`Game 3 is in force: 1 round = ${c.clock.day / 60000} minutes. Next: npm run survivor-test -- season`); return; }
  if (cur.pending) {
    const eta = Number(cur.pending.eta), now = Number((await p.getHeadInfo() as any).head_block_time);
    if (now < eta) { log(`Game 3 is announced; it can be put in force from ${new Date(eta).toLocaleTimeString()} (in ${Math.ceil((eta - now) / 60000)} minutes). Run this again then.`); return; }
    log("Putting game 3 in force (apply_game)…");
    if (!sendIt) { log("Dry run. Add --send."); return; }
    const id = await send(pc, "apply_game", { game: 3 }, owner);
    log(`✔ game 3 is in force (${id.slice(0, 18)}…). Next: npm run survivor-test -- season`);
    return;
  }
  log(`Announcing game 3 (Survivor, testnet clock): ${JSON.stringify(want)}`);
  if (!sendIt) { log("Dry run. Add --send."); return; }
  const id = await send(new Contract({ id: c.picks!.contract, abi: PICKS_ABI(), provider: p }), "announce_game", { game: want }, owner);
  c.game = { announcedAt: Date.now(), eta: Date.now() + TEST_TIMELOCK_MS };
  writeConfig(c);
  log(`✔ announced (${id.slice(0, 18)}…). In 10 minutes run: npm run survivor-test -- game --send`);
}

/** The first round a new season can start on: the next round whose lock is at least `margin` away. Exported for tests. */
export function nextStart(S: any, now: number, margin = 15 * 60_000): number {
  let r = S.dayIndex(now) + 1;
  while (S.lockTime(r) - now < margin) r++;
  return r;
}
async function season(arg?: string) {
  const c = readConfig();
  const p = await testnetProvider(c);
  const now = Number((await p.getHeadInfo() as any).head_block_time);
  const S = mathOf(c);
  const r = !arg || arg === "next" ? nextStart(S, now) : Number(arg);
  if (!Number.isInteger(r) || S.lockTime(r) <= now) throw new Error(`Round ${arg} has locked already. Use: season next`);
  c.clock.firstDay = r;
  writeConfig(c);
  const S2 = mathOf(c);
  log(`✔ Season 1 starts round ${r}: ${S2.dayLabel(r)} UTC (${new Date(S2.dayStart(r)).toLocaleString()} your time).`);
  log(`  Join by picking for it before ${new Date(S2.lockTime(r)).toLocaleTimeString()} (picks lock 5 minutes before each round).`);
  log(`  A season is 14 rounds (${(14 * c.clock.day) / 3_600_000} hours). Restart the 'run' command if it is running, so the page sees the start.`);
}

async function pick(who: string, producer: string, roundArg: string | undefined, sendIt: boolean) {
  const c = readConfig(), keys = readKeys();
  if (!PLAYERS.includes(who)) throw new Error(`Player must be one of ${PLAYERS.join(", ")}`);
  const p = await testnetProvider(c);
  const S = mathOf(c), now = Number((await p.getHeadInfo() as any).head_block_time);
  const r = roundArg ? Number(roundArg) : S.openDays(now).find((d: number) => S.lockTime(d) - now > 60_000);
  if (!Number.isInteger(r)) throw new Error("No open round");
  let a = producer;
  if (/^#\d+$/.test(producer)) {
    const f = readFields().get(r) ?? [...readFields().values()].pop();
    a = f?.[Number(producer.slice(1)) - 1]?.a;
    if (!a) throw new Error(`No producer ${producer} in the field yet (the recorder publishes it: npm run survivor-test -- record)`);
  }
  if (!isAddr(a)) throw new Error("Producer must be an address or #n");
  const s = signerOf(keys, who, p);
  log(`${who} (${s.getAddress()}) picks ${a} for round ${r} (${S.dayLabel(r)} UTC)`);
  if (!sendIt) { log("Dry run. Add --send."); return; }
  const id = await send(picksContract(c, p), "pick", { player: s.getAddress(), game: 3, round: String(r), producers: [a], number: "0" }, s, PICK_RC_KOIN);
  log(`✔ picked (${id.slice(0, 18)}…)`);
}
function readFields(): Map<number, { a: string; k: number; h: number }[]> {
  try { const j = JSON.parse(fs.readFileSync(path.join(DATA(), "fields.json"), "utf8")); return new Map(j.fields.map((x: any) => [x.day, x.field])); } catch { return new Map(); }
}

async function record() {
  const c = readConfig();
  const p = await testnetProvider(c);
  const { run } = await import("./games/survivor.ts");
  // OUT isn't made here: run() puts back a folder a crashed run left parked first (Repo Lense S3-17).
  const r = await run({ p, check: null, prev: DATA(), out: DATA(), firstDay: c.clock.firstDay, picksContract: c.picks?.contract ?? null,
    math: mathOf(c), holdToken: c.holdToken ?? c.koin, gameContract: null });
  return r;
}

/** Robot players p2…p6, so a season has company: each picks for the next open round if it hasn't yet.
 *  p2 picks the biggest unused producer, p3 the second biggest, p4 a random one, p5 the smallest, and p6 skips
 *  every third day of the season (days 3, 6, 9 …: to test missed picks; it always joins on day 1). p1 is left for you.
 *  n is the season day of the round being picked. Exported for the tests. */
export function botChoice(who: string, field: { a: string; k: number }[], used: Set<string>, n: number, rand = Math.random): string | null {
  const ok = field.filter((f) => !used.has(f.a));
  if (!ok.length) return null;
  switch (who) {
    case "p2": return ok[0].a;
    case "p3": return (ok[1] ?? ok[0]).a;
    case "p4": return ok[Math.floor(rand() * ok.length)].a;
    case "p5": return ok[ok.length - 1].a;
    case "p6": return n % 3 === 0 ? null : ok[Math.floor(ok.length / 2)].a;
    default: return null;
  }
}
async function bots() {
  const c = readConfig(), keys = readKeys();
  if (c.clock.firstDay === null || !c.picks) return;
  const p = await testnetProvider(c), S = mathOf(c), pc = picksContract(c, p);
  const now = Number((await p.getHeadInfo() as any).head_block_time);
  const r = S.openDays(now).find((d: number) => S.lockTime(d) - now > 2 * 60_000);
  const se = r !== undefined ? S.seasonOf(r) : null;
  if (!se) return;
  const field = readFields().get(r) ?? [...readFields().values()].pop();
  if (!field || !field.length) return;
  const sf = path.join(DATA(), `S${String(se.season).padStart(3, "0")}.json`);
  const players = fs.existsSync(sf) ? JSON.parse(fs.readFileSync(sf, "utf8")).result?.players ?? [] : [];
  for (const who of PLAYERS.slice(1)) {
    const a = addressOf(keys, who), me = players.find((x: any) => x.a === a);
    if (se.n > 1 && me && me.outN !== null) continue;
    const mine: any = (await (pc.functions as any).get_pick({ game: 3, round: String(r), player: a })).result?.pick;
    if (mine?.producers?.length) continue;
    // Picks for earlier rounds the recorder hasn't recorded yet count as used too.
    const used = new Set<string>(me?.used ?? []);
    for (let d = se.start; d < r; d++) {
      const x: any = (await (pc.functions as any).get_pick({ game: 3, round: String(d), player: a }).catch(() => ({}))).result?.pick;
      if (x?.producers?.[0]) used.add(x.producers[0]);
    }
    const choice = botChoice(who, field, used, se.n);
    if (!choice) { log(`  bot ${who}: skips round ${r}`); continue; }
    try { await send(pc, "pick", { player: a, game: 3, round: String(r), producers: [choice], number: "0" }, signerOf(keys, who, p), PICK_RC_KOIN); log(`  bot ${who}: picked ${choice.slice(0, 8)}… for round ${r}`); }
    catch (e) { log(`  bot ${who}: ${(e as Error).message}`); }
  }
}

// ── the local test page ──
/** The page's network settings (public: addresses only, no keys). */
export function netScript(c: Config, keys: Record<string, string>): string {
  const net = {
    name: TESTNET.name, rpc: "/rpc", data: "/testnet-data/survivor/", chainId: c.chainId, explorer: null, blocks: Math.ceil((c.clock.day / 3000) * 1.2) + 200,
    picks: c.picks ? c.picks.contract : null, clock: c.clock,
    players: PLAYERS.map((w) => ({ name: w, address: addressOf(keys, w) })),
  };
  return `/* Survivor TESTNET settings, made by bot/survivor-test.ts. Only the local test server serves this file. */\n` +
    `window.KSurvivorNet = Object.freeze(${JSON.stringify(net)});\nwindow.KBlocksConfig = Object.freeze({ snapshot: null, store: "kb-blocks-survivor-testnet" });\n`;
}
/** The test page: survivor.html with a TESTNET banner, the test settings and the test wallet instead of the real ones.
 *  Exported for the tests. */
export function testPage(html: string): string {
  const swap = (a: string, b: string) => { if (!html.includes(a)) throw new Error(`survivor.html changed: "${a}" not found`); html = html.replace(a, b); };
  swap("<title>", "<title>TESTNET · ");
  swap('<link rel="stylesheet" href="styles.css">', '<link rel="stylesheet" href="styles.css">\n  <link rel="stylesheet" href="/testnet/testnet.css">');
  html = html.replace(/<body([^>]*)>/, '<body$1>\n  <div class="tn-bar" role="note"><b>TESTNET</b> Play money on the Koinos testnet. 1 round = 1 test "day" (fast clock). Not the live game. <label>Play as <select id="tn-player" aria-label="Test player"></select></label></div>');
  swap('<script src="guest.js"></script>', "");
  swap('<script src="wallet.js"></script>', '<script src="/testnet/survivor-net.js"></script>\n  <script src="/testnet/test-wallet.js"></script>');
  swap('<script src="header-wallet.js"></script>', "");
  return html;
}
const RPC_METHODS = new Set(["chain.get_head_info", "chain.get_chain_id", "chain.read_contract", "block_store.get_blocks_by_height", "chain.get_account_rc",
  "chain.get_account_nonce", "chain.get_resource_limits", "contract_meta_store.get_contract_meta"]);
export async function startSite(opts: { port?: number } = {}) {
  const c = readConfig(), keys = readKeys();
  // The same check as every other command, before anything can be signed (review TN-1): testnet only, same chain id.
  await testnetProvider(c);
  let port = opts.port ?? (await freePort(SITE_PORT));
  const token = crypto.randomBytes(24).toString("hex");
  let origin = `http://127.0.0.1:${port}`;
  const p = new Provider([c.rpc]);
  const abi = PICKS_ABI();
  const PAGE_FILES = new Set([...fs.readFileSync(path.join(ROOT, "survivor.html"), "utf8").matchAll(/(?:src|href)="([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.(?:js|css|webmanifest))"/g)].map((m) => m[1]));
  const types: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json" };
  const sendFile = (res: http.ServerResponse, file: string) => {
    // Never a Windows device name (con, nul, com1 …) or a link out of the folder (Repo Lense S3-33).
    const base = path.basename(file).split(".")[0].toLowerCase();
    let real = "";
    try { real = fs.realpathSync(file); } catch { /* missing: 404 below */ }
    if (/^(con|prn|aux|nul|com\d|lpt\d)$/.test(base) || (real && (real !== path.resolve(file) || fs.lstatSync(file).isSymbolicLink()))) { res.writeHead(404); res.end("not found"); return; }
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
  const json = (res: http.ServerResponse, code: number, v: any) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" }); res.end(JSON.stringify(v)); };
  const server = http.createServer(async (req, res) => {
    // No other site may frame the test page (review TN-3).
    res.setHeader("x-frame-options", "DENY");
    res.setHeader("content-security-policy", "frame-ancestors 'none'");
    try {
      // Only this PC's browser, on this address: no other host name (DNS rebinding) and no other site (CSRF).
      if (req.headers.host !== `127.0.0.1:${port}`) { res.writeHead(403); res.end("use " + origin); return; }
      const url = new URL(req.url ?? "/", origin), u = decodeURIComponent(url.pathname);
      if (req.method === "POST") {
        if (req.headers.origin !== origin || (req.headers["sec-fetch-site"] && req.headers["sec-fetch-site"] !== "same-origin")) { json(res, 403, { error: "other sites can't use the test server" }); return; }
        if (u === "/rpc") {
          const b = JSON.parse(await body(req));
          if (!b || typeof b.method !== "string" || !RPC_METHODS.has(b.method)) { json(res, 403, { error: `method not allowed: ${b?.method}` }); return; }
          const r = await fetch(c.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: b.id ?? 1, method: b.method, params: b.params ?? {} }) });
          res.writeHead(r.status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" }); res.end(await r.text()); return;
        }
        if (u === "/test/send") {
          const b = JSON.parse(await body(req));
          if (!b || b.token !== token) { json(res, 403, { error: "reload the page" }); return; }
          const who = String(b.as || "");
          if (!PLAYERS.includes(who)) { json(res, 400, { error: "unknown test player" }); return; }
          const ops = Array.isArray(b.ops) ? b.ops : [];
          const cur = readConfig();                     // the current contract (review TN-6: no restart after an upload)
          if (cur.rpc !== c.rpc || cur.chainId !== c.chainId) { json(res, 409, { error: "the test settings changed: restart the run command" }); return; }
          c.picks = cur.picks;
          if (ops.length !== 1 || !c.picks) { json(res, 400, { error: "a test wallet sends exactly one Survivor pick" }); return; }
          const op = ops[0]?.call_contract;
          if (!op || op.contract_id !== c.picks.contract || Number(op.entry_point) !== PICK_ENTRY) { json(res, 400, { error: "a test wallet signs only Survivor picks on the testnet Picks contract" }); return; }
          const pc = new Contract({ id: c.picks.contract, abi, provider: p });
          const dec: any = await pc.decodeOperation({ call_contract: op } as any);
          const s = signerOf(keys, who, p), a = dec?.args ?? {};
          if (dec?.name !== "pick" || a.player !== s.getAddress() || Number(a.game) !== 3 || !Array.isArray(a.producers) || a.producers.length !== 1 || !isAddr(a.producers[0])) {
            json(res, 400, { error: "that isn't a Survivor pick for this test player" }); return;
          }
          // Only a round that is open now, on the test clock (audit SV-A24). The contract checks this too.
          const round = Number(a.round);
          if (!Number.isSafeInteger(round) || !mathOf(cur).isOpen(round, Date.now())) { json(res, 400, { error: "that round isn't open for picks now (it is locked, or not open yet)" }); return; }
          try { const id = await send(pc, "pick", { player: a.player, game: 3, round: String(a.round), producers: a.producers, number: "0" }, s, PICK_RC_KOIN); json(res, 200, { id }); }
          catch (e) { json(res, 400, { error: String((e as Error).message).slice(0, 300) }); }
          return;
        }
        res.writeHead(404); res.end(); return;
      }
      if (req.method !== "GET") { res.writeHead(405); res.end(); return; }
      if (u === "/" || u === "/survivor.html") { res.writeHead(302, { location: "/survivor-testnet.html" }); res.end(); return; }
      if (u === "/survivor-testnet.html") { res.writeHead(200, { "content-type": types[".html"], "cache-control": "no-store" }); res.end(testPage(fs.readFileSync(path.join(ROOT, "survivor.html"), "utf8"))); return; }
      if (u === "/testnet/survivor-net.js") {
        // Loaded by the test page only (audit SV-A23): not as a script on another site. It holds no keys either way.
        const sfs = req.headers["sec-fetch-site"];
        if (sfs && sfs !== "same-origin" && sfs !== "none") { res.writeHead(403); res.end(); return; }
        res.writeHead(200, { "content-type": types[".js"], "cache-control": "no-store" }); res.end(netScript(readConfig(), keys)); return; }
      if (u === "/testnet/session") {
        // Read with fetch from the page only: the browser won't let another site read this answer (no CORS header).
        if (req.headers["sec-fetch-site"] && req.headers["sec-fetch-site"] !== "same-origin") { json(res, 403, {}); return; }
        json(res, 200, { token }); return;
      }
      if (/^\/testnet\/(test-wallet\.js|testnet\.css)$/.test(u)) { sendFile(res, path.join(ROOT, "tools", "survivor-testnet", path.basename(u))); return; }
      const m = /^\/testnet-data\/survivor\/(index|days|fields|S\d{3})\.json$/.exec(u);
      if (m) { sendFile(res, path.join(DATA(), `${m[1]}.json`)); return; }
      if (u === "/picks/abi/picks.koilib.json") { sendFile(res, path.join(ROOT, "picks", "abi", "picks.koilib.json")); return; }
      // The site sits at the repository root, next to the keys' folder and the code, so only the files the Survivor
      // page itself loads are served (its scripts, styles and icons, read from survivor.html), plus images under
      // media/. No other page: the only page here is the TESTNET one (review TN-7).
      const sm = /^\/((?:media\/)?[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.(?:js|css|svg|png|webmanifest))$/.exec(u);
      if (sm && (PAGE_FILES.has(sm[1]) || (sm[1].startsWith("media/") && /\.(svg|png)$/.test(sm[1])))) { sendFile(res, path.join(ROOT, ...sm[1].split("/"))); return; }
      res.writeHead(404); res.end("not found");
    } catch (e) { json(res, 500, { error: String((e as Error).message).slice(0, 200) }); }
  });
  // Another program can take the port between freePort's check and here (audit SV-A26): then try the next free one.
  for (let i = 0; ; i++) {
    const err = await new Promise<NodeJS.ErrnoException | null>((ok) => {
      const onErr = (e: NodeJS.ErrnoException) => ok(e);
      server.once("error", onErr);
      server.listen(port, "127.0.0.1", () => { server.off("error", onErr); ok(null); });
    });
    if (!err) break;
    if (err.code !== "EADDRINUSE" || opts.port !== undefined || i >= 4) throw err;
    port = await freePort(port + 1); origin = `http://127.0.0.1:${port}`;
  }
  log(`Test page: ${origin}/survivor-testnet.html  (only this PC can open it)`);
  return server;
}

async function runAll(withBots: boolean) {
  readConfig(); readKeys();
  await startSite();
  const tick = async () => {
    try { const r = await record(); log(`[${new Date().toLocaleTimeString()}] recorded${r.problems.length ? `; ${r.problems.length} note(s): ${r.problems.slice(0, 3).join(" | ")}` : ""}`); }
    catch (e) { log(`[${new Date().toLocaleTimeString()}] recorder: ${(e as Error).message}`); }
    if (withBots) { try { await bots(); } catch (e) { log(`bots: ${(e as Error).message}`); } }
  };
  await tick();
  setInterval(tick, 2 * 60_000);
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
    case "game": return game(sendIt);
    case "season": return season(args[0]);
    case "pick": return pick(args[0], args[1], args[2], sendIt);
    case "record": { takeLock(); const r = await record(); log(r.problems.length ? r.problems.join("\n") : "recorded, no problems"); return; }
    case "bots": return bots();
    case "site": await startSite(); return;
    case "run": takeLock(); return runAll(a.includes("--bots"));
    default: throw new Error(`Unknown command "${cmd}". Commands: setup, status, fund, picks-build, picks-upload, game, season, pick, record, run`);
  }
}
if (process.argv[1] && /survivor-test\.ts$/.test(process.argv[1])) {
  main().catch((e) => { console.error(`\n✖ ${e.message ?? e}`); process.exit(1); });
}

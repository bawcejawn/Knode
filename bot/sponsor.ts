/**
 * MANA SPONSOR TOOL: set up and run the wallet whose Mana pays for players' Knode transactions (sponsor/README.md).
 * Every command that sends is a dry run (it only shows what it would do) unless you add --send.
 *
 *   npm run sponsor -- status                       the sponsor right now: on/off, caps, KOIN and Mana, today's use
 *   npm run sponsor -- upload [--send]              put the sponsor contract on the sponsor wallet (SPONSOR_WIF)
 *   npm run sponsor -- config [--per-tx 1] [--per-player-day 25] [--per-player-week 150] [--per-day 5000] [--free-per-day 2000] [--min-vhp 1] [--send]
 *                                                   set the caps (in Mana; 1 Mana = 1 KOIN of Mana) and the per-action
 *                                                   Mana limits (sponsor-data/mana-limits.json); keeps on/off as is
 *   npm run sponsor -- mana-limit <game|desk|race|picks>:<action> <most used> --source <text> [--save]
 *                                                   add one action measured elsewhere (e.g. picks:pick 0.0477 --source testnet)
 *   npm run sponsor -- site-limits [--send]         step 1 of a limits change: give the website limits that fit both
 *                                                   the sponsor's current and new limits (commit and push them)
 *   npm run sponsor -- mana-report [--blocks 28800] [--save]
 *                                                   the Mana adjuster: what each sponsored action really used (read
 *                                                   from the chain), and a safe limit for each; --save writes them to
 *                                                   sponsor-data/mana-limits.json (then config --send puts them on chain)
 *   npm run sponsor -- enable [--send]              switch the sponsor on (it pays within the caps)
 *   npm run sponsor -- disable [--send]             switch it off (players pay their own Mana)
 *   npm run sponsor -- payer sponsor|self [--rc-limit 1] [--send]
 *                                                   who the WEBSITE asks to pay the Mana: the sponsor, or players
 *                                                   themselves. Edits game-data and desk-data deployment.json on this
 *                                                   PC (nothing is sent): commit and push them for the site to follow.
 *
 * Keys come from the root .env (never GitHub):
 *   SPONSOR_WIF   the sponsor wallet's key. The wallet pays the Mana and holds the KOIN; only this key changes settings
 *                 or moves its KOIN (in Kondor, like any wallet).
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Signer, Provider, Contract, Transaction } from "koilib";
import { KoinosChain, showKoin, toSat } from "./chain.ts";
import { tokenAbi } from "./token-abi.ts";
import { contractMetadata } from "./chaincheck.ts";
import { units, isMainnet, pinDeployment, PINNED_MAINNET, TESTNET } from "./bot.ts";
import { readLimits as readLimitsFile, summarize, merge, chainRows, siteMap, actionNames, checkRows, toMana, key, transitionRows, siteFits, siteMisfits, LIMITS_FILE as MAINNET_LIMITS_FILE, MARGIN, type Sample } from "./mana-limits.ts";

const E = process.env;
const log = (...a: any[]) => console.log(...a);
const WASM = "sponsor/build/release/contract.wasm";
const ABI_FILE = "sponsor/abi/sponsor.koilib.json";
// Audit SP-12: which chain this is comes from the node's chain id (main() sets it), and the testnet keeps its own
// state and limits files, so a testnet run never writes the mainnet ones or the website's.
export const MAINNET_CHAIN_ID = "EiBZK_GGVP0H_fXVAM3j6EAuz3-B-l3ejxRSewi7qIBfSA==";
let MAINNET: boolean | null = null;
const onMainnet = (rpc: string) => (MAINNET ?? isMainnet(rpc));
let STATE = path.join("sponsor-data", "deployment.json");
let LIMITS_FILE = MAINNET_LIMITS_FILE;
const readLimits = () => readLimitsFile(LIMITS_FILE);
const GAME_DEP = path.join("game-data", "deployment.json");
const DESK_DEP = path.join("desk-data", "deployment.json");
const RACE_DEP = path.join("race-data", "deployment.json");
const PICKS_DEP = path.join("picks-data", "deployment.json");
/** v3: the KnodeGames Picks contract's `pick` (picks/abi/picks.koilib.json) and its argument shape, one byte per field:
 *  wire type + 1 (player bytes, game varint, round varint, producers bytes, number varint). npm run check (sponsor)
 *  confirms the shape against the Picks ABI. */
export const PICKS_PICK = 0x8ce33c6c;
// Audit SP-16: one byte per field, wire type + 1, plus 0x10 for a repeated field: player, game, round, producers
// (repeated), number. The game id is argument 2 (game_arg), so a stake in that game makes a real player.
export const PICKS_ARG_TYPES = "0x0301011301";
/** Combo Card (Build 8): the same pick with field 6, legs (repeated). Used once picks-data/deployment.json says
 *  "cards": true (the Picks v2 contract with the CARD type is live); a config change, no new sponsor code. */
export const PICKS_ARG_TYPES_CARDS = "0x030101130113";
export const PICKS_GAME_ARG = 2;
/** Suggested caps (Mana): per transaction, per player per day, per player per week, everyone per day.
 *  Owner's decisions 2026-10-28: everyone 5,000 a day (the sponsor wallet holds at least 25,000 KOIN, whose Mana refills
 *  in about 5 days), of which free players (no stake this week; guests too) share at most 2,000 (2026-10-29: 25 per
 *  wallet per day, 150 a week); the caps are first come, first served (audit SP-23). The caps count each transaction's
 *  Mana limit: a Picks pick counts its 0.2 row (launch step 6), other actions 1 until step 10's measured rows. */
// Owner, 2026-10-29: 25 Mana a day (150 a week) for every wallet, free or staked; a pick uses a small part of 1 Mana.
export const DEFAULT_CAPS = { perTx: "1", perPlayerDay: "25", perPlayerWeek: "150", perDay: "5000", minVhp: "1", freePerDay: "2000" };
// (Audit SP-2 wording: "staked players always have 3,000 or more" held only while the free pool was the only shared
//  one; the caps are first come, first served. Sponsor v3 counts only a STAKE as a player, and releases the free
//  pool by the hour, so neither pool can be emptied cheaply in one burst; status warns at 80%.)
/** The audited sponsor build (sponsor/README.md "Build"). upload refuses any other wasm. v2 (race picks), audited
 *  2026-10-27 (docs/history/AUDIT-2026-10-27-race-picks.md); v1 was 8cfeff6209b8d5cbc3b3e5fa30751e995767f5904b77693ed8a41e323ea2a8ed. */
export const SPONSOR_SHA256 = "fa4659e65c6156da3dde34238e0545a489a8b7f00cdf51df9bf79517a0019f33";
/** v3 (allowlist, free claims, 5,000 ceiling, per-action Mana limits, the vault switch). Repo Lens round 6
 *  (2026-10-30): "GO" for the mainnet upload (launch step 2): mainnet takes v3, and v2 stays allowed as the rollback. */
export const SPONSOR_V3_CANDIDATE = "b61ac238da27c4a71c01127f39a7b95f19fabf15e35df9f9715546d221e256e4";
/** The builds this network may receive. Audit SP-13: v2 stays allowed as the documented rollback target. */
// The testnet trial is for v3: only the v3 candidate goes on there (2026-10-30: a v2 build was about to be uploaded).
export const allowedBuilds = (mainnet: boolean) => (mainnet ? [SPONSOR_V3_CANDIDATE, SPONSOR_SHA256] : TESTNET ? [SPONSOR_V3_CANDIDATE] : [SPONSOR_SHA256, SPONSOR_V3_CANDIDATE]);
/** v3 code on chain (the per-action and allowlist fields mean nothing to v2). */
const V3_BUILDS = [SPONSOR_V3_CANDIDATE];

const sha256hex = (b: Uint8Array) => crypto.createHash("sha256").update(b).digest("hex");
const readJson = (f: string, d: any = null) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : d);
const writeJson = (f: string, v: any) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2) + "\n"); };
const need = (k: string) => { if (!E[k]) throw new Error(`${k} is missing from .env`); return E[k]!; };
const loadAbi = () => {
  if (!fs.existsSync(ABI_FILE)) throw new Error(`${ABI_FILE} not found: in the sponsor folder run npm ci --ignore-scripts, npm test, npm run check`);
  return JSON.parse(fs.readFileSync(ABI_FILE, "utf8"));
};

/** The game and the Desk, from their deployment files (pinned to the real mainnet contracts), and the Producer Race
 *  picks contract once it is uploaded (race-data/deployment.json; optional). */
/** --testnet (the sponsor v3 trial): the Koinos Foundation testnet's settings (testnet/sponsor.json), never the
 *  mainnet deployment files. Keys from .env.testnet. */
export const TESTNET_SPONSOR = "testnet/sponsor.json";
function knode() {
  if (TESTNET) {
    const t = readJson(TESTNET_SPONSOR);
    if (!t?.rpc || !t?.picks) throw new Error(`${TESTNET_SPONSOR} is missing or incomplete.`);
    return { game: { contract: t.game, vhp: t.vhp, koin: t.koin }, desk: { contract: t.desk }, rpc: E.TESTNET_RPC || t.rpc, race: undefined, picks: t.picks as string, picksCards: false, testnetChainId: t.chainId as string };
  }
  const game = readJson(GAME_DEP), desk = readJson(DESK_DEP), race = readJson(RACE_DEP);
  if (!game?.contract || !desk?.contract) throw new Error(`${GAME_DEP} and ${DESK_DEP} are needed.`);
  const rpc = E.RPC ?? game.rpc ?? "https://koinos.armana.io";
  pinDeployment("game", game, rpc, GAME_DEP);
  pinDeployment("desk", desk, rpc, DESK_DEP);
  const picks = readJson(PICKS_DEP);
  return { game, desk, rpc, race: race?.contract ? String(race.contract) : undefined, picks: picks?.contract ? String(picks.contract) : undefined, picksCards: picks?.cards === true };
}

function sponsorKey(provider: Provider) {
  const s = Signer.fromWif(need("SPONSOR_WIF"));
  s.provider = provider;
  const { game, desk } = knode();
  const a = s.getAddress();
  const taken: Record<string, string> = { [game.contract]: "the game contract", [desk.contract]: "Knode Swap", [game.owner]: "the owner wallet", [game.operator]: "the bot wallet", [PINNED_MAINNET.koin]: "KOIN", [PINNED_MAINNET.vhp]: "VHP" };
  if (taken[a]) throw new Error(`SPONSOR_WIF is ${taken[a]}'s key. The sponsor needs a brand-new wallet of its own.`);
  if (E.OWNER_WIF && Signer.fromWif(E.OWNER_WIF).getAddress() === a) throw new Error("SPONSOR_WIF is the owner's key. Use a new wallet.");
  if (onMainnet(knode().rpc) && a !== PINNED_MAINNET.sponsor) throw new Error(`SPONSOR_WIF belongs to ${a}, not the Knode sponsor wallet ${PINNED_MAINNET.sponsor}. Check the SPONSOR_WIF line in .env.`);
  return s;
}

async function readSponsor(provider: Provider, address: string, method: string, args: any = {}) {
  const c = new Contract({ id: address, abi: loadAbi(), provider });
  return ((await (c.functions as any)[method](args)).result) ?? {};
}

const mana = (sat: any) => `${showKoin(sat ?? 0)} Mana`;

// ═══════════════════════════════ status ═══════════════════════════════
async function status() {
  const { game, desk, rpc } = knode();
  const st = readJson(STATE);
  const address = st?.address ?? (E.SPONSOR_WIF ? Signer.fromWif(E.SPONSOR_WIF).getAddress() : null);
  if (!address) { log("No sponsor yet: create a new wallet, put its key in .env as SPONSOR_WIF, then: npm run sponsor -- upload"); return; }
  const provider = new Provider([rpc]);
  log(`Mana sponsor ${address} on ${rpc}${onMainnet(rpc) ? " (mainnet)" : ""}`);
  const koin = new Contract({ id: TESTNET ? (game as any).koin : PINNED_MAINNET.koin, abi: tokenAbi as any, provider });
  const bal = ((await (koin.functions as any).balance_of({ owner: address })).result?.value) ?? "0";
  log(`  KOIN           ${showKoin(bal)}  (Mana now ${mana(await provider.getAccountRc(address))}; it refills over about 5 days)`);
  const m = await contractMetadata(provider, address);
  if (!m.exists) { log("  Contract       not uploaded yet (npm run sponsor -- upload)"); return; }
  log(`  Code           sha256 ${m.hash.replace(/^0x1220/, "")}${st?.wasmSha256 && m.hash.endsWith(st.wasmSha256) ? " (as uploaded)" : ""}`);
  log(`  Switches       pays for transactions: ${m.tx ? "yes" : "NO"}; its settings use its own key: ${m.call ? "NO (overridden!)" : "yes"}; uploads use its own key: ${m.upload ? "NO (overridden!)" : "yes"}`);
  const cfg = await readSponsor(provider, address, "get_config");
  log(`  Switched       ${cfg.enabled ? "ON" : "off"}`);
  log(`  Pays for       game ${cfg.game === game.contract ? "✔" : `✖ (${cfg.game ?? "not set"})`}, Knode Swap ${cfg.desk === desk.contract ? "✔ (v2 only: sponsor v3 never pays swaps)" : `✖ (${cfg.desk ?? "not set"})`}, approves on ${(cfg.tokens ?? []).length} token(s)`);
  if (cfg.allowed?.length) log(`  Allowlisted    ${cfg.allowed.map((x: any) => `${x.contract} (entry ${x.entry_point})`).join(", ")}`);
  if ("game_has_vault" in cfg || cfg.allowed) log(`  Vault (v6)     ${cfg.game_has_vault ? "live: a stake in any Knode game counts" : "not live yet: only a question-game stake counts"}`);
  // Audit SP-49 (round 5): the game is already v6 but the sponsor's vault switch is still off (the "config on v6 day"
  // step was missed). One node is enough for a warning.
  if (cfg.allowed && !cfg.game_has_vault && !TESTNET) {
    const live = await vaultLiveOn(rpc, game.contract, false).catch(() => false);
    if (live) log(`  ⚠ the game is Vault v6 now, but the sponsor still treats it as v5: run config with your caps (docs/blockx/MAINNET-LAUNCH.md, "On Vault v6 day")`);
  }
  log(`  Caps           ${mana(cfg.max_mana_per_tx)} per transaction, ${mana(cfg.max_mana_per_account_day)} per player per day, ${mana(cfg.max_mana_per_account_week)} per player per week, ${mana(cfg.max_mana_per_day)} for everyone per day`);
  log(`  Race picks     ${cfg.race ? `free play, on ${cfg.race}` : "not sponsored"}`);
  log(`  Players        ${cfg.allowed ? `any covered call for any wallet within its caps; wallets without at least ${showKoin(cfg.min_vhp ?? "0")} VHP STAKED this week draw from the free pool (v3)` : `answers: any wallet; everything else: wallets holding at least ${showKoin(cfg.min_vhp ?? "0")} VHP, or with a stake in the game (v2)`}`);
  const t = await readSponsor(provider, address, "get_total_usage");
  log(`  Used today     ${mana(t.used_day)} of ${mana(cfg.max_mana_per_day)}`);
  const fu = await readSponsor(provider, address, "get_free_usage").catch(() => ({} as any));
  log(`  Free pool      ${mana(fu.used_day)} of ${mana(cfg.max_mana_free_day)} today (wallets with no stake; released by the hour on v3)`);
  for (const w of usageAlerts(t, fu, cfg, Date.now())) log(`  ⚠ ${w}`);
  const site = (d: any) => (d?.payer === "sponsor" && d?.sponsor?.address === address ? "the sponsor" : "players' own Mana");
  log(`  Website        game pages: ${site(game)}; Knode Swap: ${site(desk)}  (npm run sponsor -- payer sponsor|self)`);
}

/** Owner, 2026-10-28: warn when the free pool (as released so far today) or everyone's total is more than 80% used,
 *  so the caps can be adjusted if free Mana drains fast. Exported for the tests. */
export function usageAlerts(total: any, free: any, cfg: any, now: number): string[] {
  const out: string[] = [];
  const day = BigInt(cfg?.max_mana_per_day ?? 0), freeDay = BigInt(cfg?.max_mana_free_day ?? 0);
  const hour = BigInt(Math.floor((now % 86400000) / 3600000));
  const released = freeDay / 24n * (hour + 1n) + (hour === 23n ? freeDay % 24n : 0n);
  const t = BigInt(total?.used_day ?? 0), f = BigInt(free?.used_day ?? 0);
  if (day > 0n && t * 100n > day * 80n) out.push(`everyone's sponsored Mana today is ${Number(t * 100n / day)}% used (${showKoin(t)} of ${showKoin(day)})`);
  if (released > 0n && f * 100n > released * 80n) out.push(`free play has used ${Number(f * 100n / released)}% of what is released so far today (${showKoin(f)} of ${showKoin(released)}; ${showKoin(freeDay)} by the end of the day)`);
  return out;
}

/** The sponsor wallet's own Mana against what today's caps still allow it to spend (audit SP-31). Exported for tests. */
export function manaAlerts(mana: bigint, cfg: any, total: any): string[] {
  const day = BigInt(cfg?.max_mana_per_day ?? 0), used = BigInt(total?.used_day ?? 0);
  const left = day > used ? day - used : 0n;
  if (cfg?.enabled && left > 0n && mana < left) return [`the sponsor wallet has ${showKoin(mana)} Mana, less than the ${showKoin(left)} today's caps still allow: players may be refused before the caps are reached (add KOIN or lower --per-day)`];
  return [];
}

/** watch: read-only, for the hourly bot: prints a ::warning:: line for each alert (exit 0 either way). */
async function watch() {
  const { rpc } = knode();
  const st = readJson(STATE);
  const address = st?.address ?? PINNED_MAINNET.sponsor;
  const provider = new Provider([rpc]);
  const cfg = await configOn(rpc, address);
  const t = await readSponsor(provider, address, "get_total_usage");
  const fu = await readSponsor(provider, address, "get_free_usage").catch(() => ({} as any));
  const alerts = usageAlerts(t, fu, cfg, Date.now());
  // Audit SP-31: the sponsor wallet's own Mana too (it is what actually pays).
  const mana = BigInt(await provider.getAccountRc(address).catch(() => "0"));
  alerts.push(...manaAlerts(mana, cfg, t));
  for (const w of alerts) console.log(`::warning::Mana sponsor: ${w.replace(/[\r\n]+/g, " ").replace(/::/g, ": ")}`);
  if (!alerts.length) log(`Mana sponsor: under 80% of today's caps; the wallet has ${showKoin(mana)} Mana.`);
  // Audit SP-31 / SP-52: an alert ends this step with exit code 1; the workflow's last step ("Mana sponsor alert") then
  // fails the run, so GitHub emails you (the other steps still run).
  if (alerts.length) process.exitCode = 1;
}

// ═══════════════════════════════ upload ═══════════════════════════════
async function upload(send: boolean) {
  const { rpc } = knode();
  const mainnet = onMainnet(rpc);
  if (send && mainnet && E.CONFIRM_MAINNET !== "yes") throw new Error("MAINNET: add CONFIRM_MAINNET=yes to .env first.");
  const provider = new Provider([rpc]);
  const s = sponsorKey(provider);
  const A = s.getAddress();
  if (!fs.existsSync(WASM)) throw new Error(`${WASM} not found: in the sponsor folder run npm test && npm run check`);
  const wasm = fs.readFileSync(WASM);
  // Audit L-1: only the audited build goes on chain.
  const okBuilds = allowedBuilds(mainnet);
  if (!okBuilds.includes(sha256hex(wasm))) throw new Error(`${WASM} is not ${mainnet ? "the audited sponsor build" : "an allowed sponsor build"} (sha256 ${sha256hex(wasm)}, expected ${okBuilds.join(" or ")}). Rebuild: cd sponsor, npm ci --ignore-scripts, npm test, npm run check (best in a clean copy with no .env).`);
  const abi = loadAbi();
  const m = await contractMetadata(provider, A);
  const have = BigInt(await provider.getAccountRc(A));
  // (The testnet upload of the 32 KB Picks contract used 2.8 Mana; the testnet faucet gives little, so ask less there.)
  const need = toSat(Math.ceil(wasm.length / 1024 * (mainnet ? 1.2 : 0.35) + (mainnet ? 10 : 5)));
  log(`Sponsor wallet     ${A}${mainnet ? "   ⚠ MAINNET" : ""}`);
  log(`Code               ${WASM}, ${(wasm.length / 1024).toFixed(1)} KB, sha256 ${sha256hex(wasm)}`);
  log(`Switches           pays for transactions ON; settings and uploads stay with this wallet's key`);
  log(`Mana               has ${showKoin(have)}, the upload needs about ${showKoin(need)}`);
  if (m.exists) log(`Note               this wallet already has code (sha256 ${m.hash.replace(/^0x1220/, "")}); uploading replaces it`);
  if (have < need) throw new Error(`Send at least ${showKoin(need - have + toSat(5))} more KOIN to ${A} first (its KOIN is its Mana).`);
  // Owner, 2026-10-29: v3 refuses Knode Swap swaps, so the live swap page must already use players' own Mana first.
  if (mainnet && V3_BUILDS.includes(sha256hex(wasm))) {
    let deskPayer = "unknown";
    try { deskPayer = String((await deployedSite()).desk?.payer ?? "self"); } catch (e) { deskPayer = `unreadable (${(e as Error).message})`; }
    log(`Knode Swap page   Mana paid by ${deskPayer === "sponsor" ? "the sponsor  ✖ (v3 refuses swaps)" : deskPayer}`);
    if (deskPayer !== "self") { if (send) throw new Error("Not sent: the live Knode Swap page (knodegames.com/desk-data/deployment.json) must use players' own Mana before v3 goes on, because v3 refuses swaps. Run npm run sponsor -- payer sponsor --send, have the pull request to main merged, wait a few minutes, then upload again."); }
  }
  if (!send) { log("\nDry run only. Nothing was sent. Run again with --send to upload."); return; }
  const c = new Contract({ id: A, abi, provider, signer: s, bytecode: new Uint8Array(wasm) });
  const { operation } = await c.deploy({ abi: JSON.stringify(abi), authorizesCallContract: false, authorizesTransactionApplication: true, authorizesUploadContract: false, onlyOperation: true } as any);
  const tx = new Transaction({ signer: s, provider, options: { payer: A, payee: A, rcLimit: (need * 13n / 10n < have * 95n / 100n ? need * 13n / 10n : have * 95n / 100n).toString() } });
  await tx.pushOperation(operation);
  const receipt: any = await tx.send();
  if (receipt?.reverted) throw new Error(`upload reverted: ${JSON.stringify(receipt.logs)}`);
  await tx.wait("byBlock", 300_000).catch(() => { throw new Error("Sent but not confirmed within 5 minutes. Check status in a few minutes."); });
  const after = await contractMetadata(provider, A);
  // Audit L-1: the chain must now hold exactly this code, with only "pays for transactions" switched on.
  const bad: string[] = [];
  if (after.hash.replace(/^0x1220/, "") !== sha256hex(wasm)) bad.push(`code on chain is ${after.hash}`);
  if (!after.tx) bad.push("pays for transactions is OFF");
  if (after.call) bad.push("call override is ON (must be off)");
  if (after.upload) bad.push("upload override is ON (must be off)");
  if (bad.length) throw new Error(`Uploaded, but the sponsor wallet is not as expected: ${bad.join("; ")}. Do not switch it on; check npm run sponsor -- status.`);
  writeJson(STATE, { network: mainnet ? "mainnet" : "testnet", rpc, address: A, wasmSha256: sha256hex(wasm), uploadTx: tx.transaction?.id, uploadedAt: new Date().toISOString() });
  // The trial: the testnet page asks this sponsor to pay (testnet/blockx.json "sponsor"; commit it).
  if (!mainnet && TESTNET) { const f = "testnet/blockx.json", c = readJson(f); if (c) { c.sponsor = A; writeJson(f, c); log(`Wrote "sponsor": "${A}" into ${f}: the testnet page asks it to pay for picks.`); } }
  log(`✔ uploaded (Mana used ${showKoin(receipt?.rc_used)}). On chain: ${after.hash}; pays for transactions: ${after.tx}`);
  log(`Saved ${STATE} (public; commit it). Next: npm run sponsor -- config --send, then enable --send.`);
}

// ═══════════════════════════════ settings ═══════════════════════════════
function flag(a: string[], name: string, d: string) { const i = a.indexOf(name); return i >= 0 && a[i + 1] && !a[i + 1].startsWith("--") ? a[i + 1] : d; }

/** Builds the config: the pinned game, Desk, VHP and KOIN, and the caps. Exported for the tests. */
export function buildConfig(game: any, desk: any, caps: { perTx: string; perPlayerDay: string; perPlayerWeek: string; perDay: string; minVhp?: string; freePerDay?: string }, enabled: boolean, race?: string, picks?: string, manaRows: ReturnType<typeof readLimits>["rows"] = [], picksCards = false, gameHasVault = false) {
  const vhp = game.vhp ?? PINNED_MAINNET.vhp;
  const c = {
    enabled, game: game.contract, desk: desk.contract, tokens: [vhp, game.koin ?? PINNED_MAINNET.koin],
    max_mana_per_tx: units(caps.perTx), max_mana_per_account_day: units(caps.perPlayerDay),
    max_mana_per_account_week: units(caps.perPlayerWeek), max_mana_per_day: units(caps.perDay),
    // Only real players are sponsored (audit M-1): at least this much VHP in the wallet, or a stake in the game.
    vhp, min_vhp: units(caps.minVhp ?? DEFAULT_CAPS.minVhp),
    // v3: any covered call is paid for any wallet within its caps; wallets that aren't real players (no stake this week)
    // also count against this daily free pool, released by the hour.
    // Not given: the default, but never above everyone's daily cap.
    max_mana_free_day: caps.freePerDay !== undefined ? units(caps.freePerDay)
      : (BigInt(units(DEFAULT_CAPS.freePerDay)) < BigInt(units(caps.perDay)) ? units(DEFAULT_CAPS.freePerDay) : units(caps.perDay)),
    // Producer Race picks are free play like answers (sponsor v2). Left out: picks aren't sponsored.
    ...(race ? { race } : {}),
    // v3: the KnodeGames Picks contract's picks are free play like answers (the payee's own, arguments in the Picks shape).
    ...(picks ? { allowed: [{ contract: picks, entry_point: PICKS_PICK, free_play: true, arg_types: picksCards ? PICKS_ARG_TYPES_CARDS : PICKS_ARG_TYPES, game_arg: PICKS_GAME_ARG }] } : {}),
    // v3: each action's own Mana limit (sponsor-data/mana-limits.json, from mana-report). No rows: the per-transaction cap.
    ...(manaRows.length ? { mana_caps: chainRows(manaRows) } : {}),
    // v3, audit SP-37: ask the game for a stake in another game (get_game_player) only once it is the vault (v6).
    ...(gameHasVault ? { game_has_vault: true } : {}),
  };
  checkRows(manaRows, BigInt(units(caps.perTx)));
  if (race && [c.game, c.desk, ...c.tokens].includes(race)) throw new Error("The race contract must differ from the game, Knode Swap and the tokens.");
  if (picks && [c.game, c.desk, ...c.tokens, race].includes(picks)) throw new Error("The Picks contract must differ from the game, Knode Swap, the race and the tokens.");
  if (BigInt(c.min_vhp) === 0n) throw new Error("The VHP minimum must be above 0 (empty wallets would be sponsored).");
  const n = (x: string) => BigInt(x);
  if (!(n(c.max_mana_per_tx) <= n(c.max_mana_per_account_day) && n(c.max_mana_per_account_day) <= n(c.max_mana_per_account_week) && n(c.max_mana_per_account_day) <= n(c.max_mana_per_day)))
    throw new Error("Caps must be per transaction ≤ per player per day ≤ per player per week, and per player per day ≤ everyone per day.");
  if (n(c.max_mana_per_day) > toSat(5000)) throw new Error("Everyone's daily cap can't be above 5,000 Mana.");
  if (n(c.max_mana_free_day) > n(c.max_mana_per_day)) throw new Error("The free-player daily cap can't be above everyone's daily cap.");
  if (enabled && n(c.max_mana_per_tx) === 0n) throw new Error("A per-transaction cap of 0 with the sponsor on would refuse everything.");
  return c;
}

/** Audit SP-8: the website as it is DEPLOYED (knodegames.com, never cached), not this PC's copy. Exported for the tests. */
export const SITE_URL = () => E.SITE_URL || "https://knodegames.com/";
export async function deployedSite(fetcher: (u: string) => Promise<any> = async (u) => { const r = await fetch(u, { cache: "no-store" as any }); if (!r.ok) throw new Error(`${u}: HTTP ${r.status}`); return r.json(); }) {
  const t = Date.now();
  const game = await fetcher(`${SITE_URL()}game-data/deployment.json?t=${t}`);
  const desk = await fetcher(`${SITE_URL()}desk-data/deployment.json?t=${t}`);
  return { game, desk };
}
/** What the deployed site asks for, against the chain's rows and cap (its answers' fallback and its other actions'). */
export function siteProblems(site: { game: any; desk: any }, rows: { contract: string; entry_point: number; max_mana: string }[], perTx: bigint, v3 = true): string[] {
  const out: string[] = [];
  // Owner, 2026-10-29: sponsor v3 refuses swaps, so the live Knode Swap page must already use players' own Mana.
  // Audit SP-50 (round 5): only once v3 is the code on chain (v2 still pays swaps, so enable after an emergency
  // disable must not be blocked by it).
  if (v3 && site.desk?.payer === "sponsor") out.push("Knode Swap still asks the sponsor to pay for swaps, which sponsor v3 refuses (npm run sponsor -- payer sponsor --send, then a pull request to main)");
  for (const [name, d] of [["game pages", site.game], ["Knode Swap", site.desk]] as const) {
    const sp = d?.sponsor;
    if (!sp) continue;
    const fallback = BigInt(sp.rcLimit ?? units(DEFAULT_CAPS.perTx)), other = BigInt(sp.rcLimitOther ?? units("3"));
    for (const k of siteMisfits(sp.rcLimits ?? {}, rows, perTx, fallback)) out.push(`${name}: ${k} would ask for more than the sponsor allows`);
    if (fallback > perTx) out.push(`${name}: answers ask ${toMana(fallback)} Mana, above the ${toMana(perTx)} per-transaction cap`);
    if (other > perTx) out.push(`${name}: other actions ask ${toMana(other)} Mana, above the ${toMana(perTx)} per-transaction cap (audit SP-17)`);
  }
  return out;
}
/** The sponsor's config as one node has it. Audit SP-5: a failed read stops (it never becomes "nothing set"). */
async function configOn(rpc: string, address: string) {
  try { return await readSponsor(new Provider([rpc]), address, "get_config"); }
  catch (e) { throw new Error(`Couldn't read the sponsor's settings from ${rpc} (${(e as Error).message}). Nothing was sent.`); }
}
// Audit SP-30: RPC_CHECK=off really means "no second node" (null). Only switching off (disable) may then go ahead on
// mainnet; config and enable refuse without a second node.
const CHECK_RPC = (): string | null => (E.RPC_CHECK === "off" ? null : (E.RPC_CHECK || "https://api.koinosblocks.com"));
function secondNode(): string {
  const r = CHECK_RPC();
  if (!r) throw new Error("RPC_CHECK=off: on mainnet this needs a second node to agree. Remove RPC_CHECK=off from .env (only disable works without one). Nothing was sent.");
  return r;
}

async function setConfig(a: string[], send: boolean, enabledArg?: boolean) {
  const { game, desk, rpc, race, picks, picksCards } = knode();
  const mainnet = onMainnet(rpc);
  if (send && mainnet && E.CONFIRM_MAINNET !== "yes") throw new Error("MAINNET: add CONFIRM_MAINNET=yes to .env first.");
  const provider = new Provider([rpc]);
  const s = sponsorKey(provider);
  const A = s.getAddress();
  const cur = await configOn(rpc, A);
  // Audit SP-29/SP-30/SP-39: disable is the emergency stop (setSwitch). enable rebuilds every setting from this PC's
  // deployment files, exactly like config, keeping only the CAPS as they are on chain (both nodes agreeing), and shows
  // every line old → new: so neither a lowered cap is lost nor a setting one node once fed to disable is re-signed.
  if (enabledArg !== undefined && !(cur.max_mana_per_day && cur.max_mana_per_day !== "0")) throw new Error("The sponsor has no settings yet: run config first (npm run sponsor -- config, then --send).");
  if (enabledArg === false) return setSwitch(rpc, provider, s, A, cur, false, send, mainnet, a.includes("--rebuilt"));
  // Audit SP-5: on mainnet a second node must hold the same settings (one node can't feed values you then re-sign).
  // (Audit SP-52: disable has already gone to setSwitch above; `enabledArg !== false` only keeps that order explicit.)
  if (mainnet && enabledArg !== false) {
    const other = await configOn(secondNode(), A);
    if (JSON.stringify(other) !== JSON.stringify(cur)) throw new Error(`The two nodes (${rpc}, ${CHECK_RPC()}) show different sponsor settings. Nothing was sent; try again in a minute.`);
  }
  const configured = !!(cur.max_mana_per_day && cur.max_mana_per_day !== "0");
  const fromSat = (x: any) => (x && x !== "0" ? (Number(x) / 1e8).toString() : "0");
  // Audit SP-1: config uses the owner's settings (DEFAULT_CAPS) unless a flag says otherwise. enable keeps the caps on
  // chain (both nodes agree, checked above), so a cap lowered after a drain stays lowered (audit SP-29).
  const base = enabledArg === true ? capsOf(cur) : DEFAULT_CAPS;
  const caps = {
    perTx: flag(a, "--per-tx", base.perTx),
    perPlayerDay: flag(a, "--per-player-day", base.perPlayerDay),
    perPlayerWeek: flag(a, "--per-player-week", base.perPlayerWeek),
    perDay: flag(a, "--per-day", base.perDay),
    minVhp: flag(a, "--min-vhp", base.minVhp),
    freePerDay: flag(a, "--free-per-day", base.freePerDay),
  };
  const enabled = enabledArg ?? !!cur.enabled;
  const limits = readLimits();
  // Audit SP-14: v3 settings only to v3 code; never silently drop the Picks row.
  const code = await codeOn(rpc, provider, A, mainnet);
  const v3 = V3_BUILDS.includes(code);
  const hadPicks = Array.isArray(cur.allowed) && cur.allowed.length > 0;
  if (hadPicks && !picks) throw new Error(`The sponsor pays for KnodeGames picks now, but ${PICKS_DEP} is missing here, so the new settings would drop them. Nothing was sent.`);
  // Audit SP-37: whether the game is already the vault (v6), read from the game on both nodes. Until it is, the sponsor
  // must not ask it for a stake in another game (v5 has no get_game_player, and that failed read aborts the sponsor).
  const vaultLive = v3 ? await vaultLiveOn(rpc, game.contract, mainnet) : false;
  const config: any = buildConfig(game, desk, caps, enabled, race, v3 ? picks : undefined, v3 ? limits.rows : [], picksCards, vaultLive);
  if (!v3 && (picks || limits.rows.length)) log(`  ⚠ the code on chain (${code.slice(0, 12)}…) is not sponsor v3: the KnodeGames picks row and per-action limits are left out (upload v3 first)`);
  const row = (label: string, was: string, now: string) => log(`  ${label.padEnd(28)} ${was === now ? now : `${was} → ${now}`}`);
  log(`To the sponsor contract ${A} on ${rpc}${mainnet ? "   ⚠ MAINNET" : ""}, signed and paid by the sponsor wallet:`);
  row("switched", configured ? (cur.enabled ? "ON" : "off") : "(never set)", enabled ? "ON" : "off");
  row("per transaction", fromSat(cur.max_mana_per_tx), caps.perTx);
  row("per player per day", fromSat(cur.max_mana_per_account_day), caps.perPlayerDay);
  row("per player per week", fromSat(cur.max_mana_per_account_week), caps.perPlayerWeek);
  row("everyone per day", fromSat(cur.max_mana_per_day), caps.perDay);
  row("free players per day", fromSat(cur.max_mana_free_day), (Number(config.max_mana_free_day) / 1e8).toString());
  row("real player: stake of", fromSat(cur.min_vhp), caps.minVhp);
  if (v3) row("vault (v6) live", cur.game_has_vault ? "yes" : "no", vaultLive ? "yes" : "no");
  for (const [label, k] of [["game", "game"], ["Knode Swap (never paid)", "desk"], ["VHP", "vhp"], ["race", "race"]] as const) row(label, String(cur[k] ?? "(none)"), String(config[k] ?? "(none)"));
  row("tokens", (cur.tokens ?? []).join(", "), (config.tokens ?? []).join(", "));
  row("allowlisted calls", (cur.allowed ?? []).map((x: any) => `${x.contract}:${x.entry_point}`).join(", ") || "(none)", (config.allowed ?? []).map((x: any) => `${x.contract}:${x.entry_point}`).join(", ") || "(none)");
  log(`  race picks: ${race ? `free play like answers, on ${race}` : "not sponsored (no race-data/deployment.json yet)"}`);
  log(`  KnodeGames picks: ${config.allowed ? `free play like answers, on ${picks}${picksCards ? " (with Combo cards)" : ""}; a stake in the pick's game counts` : "not sponsored"}`);
  log(`  players: any covered call for any wallet, within its caps; a wallet without ${caps.minVhp} VHP STAKED this week (holding VHP doesn't count) draws from the free pool; Knode Swap is never paid`);
  log(`  free players share ${Number(config.max_mana_free_day) / 1e8} Mana a day, released by the hour (1/24 at 00:00 UTC, 1/24 more each hour)`);
  if (config.mana_caps) {
    log(`  per-action Mana limits (${LIMITS_FILE}; any other action: ${caps.perTx} per transaction):`);
    for (const r of limits.rows) log(`    ${r.name.padEnd(32)} ${toMana(r.max_mana)} Mana${r.observed ? `   (has used up to ${toMana(r.observed.max)}, ${r.observed.count} seen, ${r.observed.source})` : ""}`);
  } else log(`  per-action Mana limits: none (every action may ask for up to ${caps.perTx})`);
  // Audit SP-56 (round 6): say so when a per-action limit on chain isn't in this PC's file (it would be dropped).
  const rowKey = (x: any) => `${x.contract}:${x.entry_point}`;
  const kept = new Set((config.mana_caps ?? []).map(rowKey));
  const dropped = (cur.mana_caps ?? []).filter((x: any) => !kept.has(rowKey(x)));
  if (dropped.length) log(`  ⚠ drops ${dropped.length} per-action limit(s) now on chain (${dropped.map((x: any) => `${rowKey(x)} ${toMana(String(x.max_mana))} Mana`).join(", ")}): ${LIMITS_FILE} on this PC doesn't have them (pull the branch first if that's not intended)`);
  // Audit SP-5: switching OFF is the emergency stop: no website checks may block it.
  const stopping = enabledArg === false;
  let siteBad: string[] = [];
  if (!stopping && mainnet) {
    try { siteBad = siteProblems(await deployedSite(), chainRows(config.mana_caps ? limits.rows : []), BigInt(units(caps.perTx)), v3); }
    catch (e) { siteBad = [`couldn't read the deployed website (${(e as Error).message})`]; }
    for (const x of siteBad) log(`  ⚠ website: ${x}`);
  }
  if (!send) { log("\nDry run only. Nothing was sent. Add --send to send it."); return; }
  if (siteBad.length) throw new Error("Not sent: the website (as deployed on knodegames.com) would ask for more than these limits. First: npm run sponsor -- site-limits --send, open a pull request to main with game-data/ and desk-data/deployment.json, merge it, wait a few minutes, then run this again.");
  const chain = new KoinosChain(rpc, A);
  const r = await chain.send([{ contract: A, abi: loadAbi(), method: "set_config", args: { config } }], [s], { payer: A, rcLimitKoin: 2 });
  log(r.ok ? `✔ done (Mana used ${showKoin(r.rcUsed)})  transaction ${r.txId}` : `✖ ${r.error}`);
  if (!r.ok) { process.exitCode = 1; return; }
  // The website asks for the same limits the sponsor now accepts.
  if (mainnet && config.mana_caps && syncSiteLimits(limits.rows)) log(`Updated the per-action limits in ${GAME_DEP} and ${DESK_DEP} to the new ones: open a pull request to main with them (any limit that went up is used once the site updates).`);
}

/** The caps as they are on chain, in Mana (enable keeps them; audit SP-29). Audit SP-44 (round 5): a cap that is on
 *  chain is kept exactly, 0 included (koilib reads a 0 as "0": a free pool you switched off stays off); only a field
 *  the chain doesn't have at all takes the default. Exported for the tests. */
export function capsOf(cur: any) {
  const m = (x: any, d: string) => (x !== undefined && x !== null && x !== "" ? toMana(String(x)) : d);
  return { perTx: m(cur?.max_mana_per_tx, DEFAULT_CAPS.perTx), perPlayerDay: m(cur?.max_mana_per_account_day, DEFAULT_CAPS.perPlayerDay),
    perPlayerWeek: m(cur?.max_mana_per_account_week, DEFAULT_CAPS.perPlayerWeek), perDay: m(cur?.max_mana_per_day, DEFAULT_CAPS.perDay),
    minVhp: m(cur?.min_vhp, DEFAULT_CAPS.minVhp), freePerDay: m(cur?.max_mana_free_day, DEFAULT_CAPS.freePerDay) };
}
/** Audit SP-44 (round 5): the disable fallback never loosens a cap. Each cap is the LOWER of the chain's (as this node
 *  shows it) and the owner's default, the minimum stake the HIGHER, then only lowered further so they stay in order
 *  (per transaction ≤ per player per day ≤ per player per week; per player per day and free ≤ everyone per day).
 *  Unreadable chain caps: all 0 (switched off, nothing is paid; run config with your caps before enable).
 *  Exported for the tests. */
export function tighterCaps(cur: any, other: any = null, code = ""): { caps: typeof DEFAULT_CAPS; unreadable: boolean } {
  const sat = (x: string) => BigInt(units(x));
  const lo = (a: string, b: string) => (sat(a) < sat(b) ? a : b), hi = (a: string, b: string) => (sat(a) > sat(b) ? a : b);
  const read = (x: any): typeof DEFAULT_CAPS => { const c = capsOf(x); for (const v of Object.values(c)) if (!/^\d+(\.\d+)?$/.test(v)) throw new Error("not a number"); return c; };
  let c: typeof DEFAULT_CAPS;
  try { c = read(cur); }
  catch { return { caps: { perTx: "0", perPlayerDay: "0", perPlayerWeek: "0", perDay: "0", minVhp: DEFAULT_CAPS.minVhp, freePerDay: "0" }, unreadable: true }; }
  // Review (round 5, #5): with the second node's settings too (the node this one disagrees with), the lower of both,
  // so a primary that reports a higher cap than the chain has can't get it kept.
  if (other) {
    try {
      const o = read(other);
      c = { perTx: lo(c.perTx, o.perTx), perPlayerDay: lo(c.perPlayerDay, o.perPlayerDay), perPlayerWeek: lo(c.perPlayerWeek, o.perPlayerWeek),
        perDay: lo(c.perDay, o.perDay), minVhp: hi(c.minVhp, o.minVhp), freePerDay: lo(c.freePerDay, o.freePerDay) };
    } catch { /* the second node's answer is unreadable: this node's, still never above the defaults */ }
  }
  const perDay = lo(c.perDay, DEFAULT_CAPS.perDay);
  const perPlayerWeek = lo(c.perPlayerWeek, DEFAULT_CAPS.perPlayerWeek);
  const perPlayerDay = lo(lo(lo(c.perPlayerDay, DEFAULT_CAPS.perPlayerDay), perPlayerWeek), perDay);
  const perTx = lo(lo(c.perTx, DEFAULT_CAPS.perTx), perPlayerDay);
  const freePerDay = lo(lo(c.freePerDay, DEFAULT_CAPS.freePerDay), perDay);
  const minVhp = hi(sat(c.minVhp) > 0n ? c.minVhp : DEFAULT_CAPS.minVhp, DEFAULT_CAPS.minVhp);
  // Audit SP-53 (round 6): v2 code (a rollback) refuses a daily cap above 1,000 Mana and a weekly one above 7,000, so
  // the stop must fit those too (only ever lower).
  if (code === SPONSOR_SHA256) {
    const d = lo(perDay, "1000"), wk = lo(perPlayerWeek, "7000"), pd = lo(lo(perPlayerDay, wk), d);
    return { caps: { perTx: lo(perTx, pd), perPlayerDay: pd, perPlayerWeek: wk, perDay: d, minVhp, freePerDay: lo(freePerDay, d) }, unreadable: false };
  }
  return { caps: { perTx, perPlayerDay, perPlayerWeek, perDay, minVhp, freePerDay }, unreadable: false };
}
/** Audit SP-48 (round 5): the sponsor's code hash, from this node and, on mainnet, the second node (they must agree). */
async function codeOn(rpc: string, provider: Provider, A: string, mainnet: boolean): Promise<string> {
  const a = String((await contractMetadata(provider, A)).hash || "").replace(/^0x1220/, "");
  if (mainnet) {
    const b = String((await contractMetadata(new Provider([secondNode()]), A)).hash || "").replace(/^0x1220/, "");
    if (a !== b) throw new Error(`The two nodes (${rpc}, ${CHECK_RPC()}) show different sponsor code. Nothing was sent; try again in a minute.`);
  }
  return a;
}
/** Audit SP-37: is the game already the vault (v6)? Its get_state config.v6_rule_week_plus_one > 0, read on this node and,
 *  on mainnet, the second node (they must agree). The testnet trial has no Knode game: never. Exported for the tests. */
const STATE_ABI = {
  methods: { get_state: { entry_point: 1023583049, argument: "kpred.get_state_arguments", return: "kpred.get_state_result", read_only: true } },
  koilib_types: { nested: { kpred: { nested: { get_state_arguments: { fields: {} }, get_state_result: { fields: { config: { type: "config_object", id: 1 } } },
    config_object: { fields: { owner: { type: "bytes", id: 1, options: { "(koinos.btype)": "ADDRESS" } }, v6_rule_week_plus_one: { type: "uint64", id: 21, options: { jstype: "JS_STRING" } } } } } } } },
};
export async function vaultLiveOn(rpc: string, game: string, mainnet: boolean, read = async (node: string) => {
  const r: any = await new Contract({ id: game, abi: STATE_ABI as any, provider: new Provider([node]) }).functions.get_state({});
  const c = r?.result?.config;
  if (!c?.owner) throw new Error(`the game ${game} gave no state on ${node}`);
  return Number(c.v6_rule_week_plus_one || 0) > 0;
}): Promise<boolean> {
  if (TESTNET && !mainnet) return false;
  const a = await read(rpc);
  if (mainnet) { const b = await read(secondNode()); if (a !== b) throw new Error("The two nodes disagree about whether the game is the vault (v6) yet. Nothing was sent; try again in a minute."); }
  return a;
}
/** disable (audit SP-30, SP-39, SP-44, SP-47): the emergency stop. With a second node that shows the same settings,
 *  only the switch changes. Otherwise (no second node, or the two differ) the settings are rebuilt from this PC's
 *  deployment files, switched off, with caps that are never looser than the chain's or your defaults (tighterCaps) and
 *  no per-action rows (nothing is paid while off; enable rebuilds them): a node that lied can't get settings signed,
 *  and the stop can't fail on a row. Audit SP-44: that rebuilt path is sent only with --rebuilt, which its preview
 *  asks for, so what you approve is what is signed. Exported for the tests. */
export function switchedConfig(cur: any, on: boolean): any {
  if (!cur || !(cur.max_mana_per_day && cur.max_mana_per_day !== "0")) throw new Error("The sponsor has no settings yet: run config first (npm run sponsor -- config, then --send).");
  return { ...cur, enabled: on };
}
async function setSwitch(rpc: string, provider: Provider, s: Signer, A: string, cur: any, on: false, send: boolean, mainnet: boolean, rebuiltOk = false) {
  let agreed = !mainnet, other: any = null;
  if (mainnet) {
    try { other = await configOn(secondNode(), A); agreed = JSON.stringify(other) === JSON.stringify(cur); } catch { agreed = false; other = null; }
  }
  let config: any;
  if (agreed) {
    config = switchedConfig(cur, on);
    // Review (round 6, #6; audit SP-53): right after a v2 rollback upload the stored settings may hold v3's 5,000 a day,
    // which v2 refuses: on v2 code the stop also lowers the caps to what v2 accepts (only ever lower).
    let code = "";
    try { code = String((await contractMetadata(provider, A)).hash || "").replace(/^0x1220/, ""); } catch { /* not v2 as far as we know */ }
    if (code === SPONSOR_SHA256) {
      const { caps } = tighterCaps(cur, null, code);
      const fit = buildConfig({ contract: cur.game, vhp: cur.vhp, koin: (cur.tokens ?? [])[1] }, { contract: cur.desk }, { ...capsOf(cur), ...caps }, false);
      for (const k of ["max_mana_per_tx", "max_mana_per_account_day", "max_mana_per_account_week", "max_mana_per_day", "max_mana_free_day", "min_vhp"]) config[k] = fit[k];
      log("  (v2 code on chain: the caps are lowered to what v2 accepts)");
    }
  } else {
    // Rebuilt from the files: game, Knode Swap, tokens, race and the Picks row as config would send them, switched off,
    // no vault reads (the safe setting), no per-action rows (audit SP-47), caps never loosened (audit SP-44).
    const { game, desk, race, picks, picksCards } = knode();
    let code = "";
    try { code = String((await contractMetadata(provider, A)).hash || "").replace(/^0x1220/, ""); } catch { /* treated as not v3: no Picks row while off */ }
    const v3 = V3_BUILDS.includes(code);
    const { caps, unreadable } = tighterCaps(cur, other, code);
    config = buildConfig(game, desk, caps, false, race, v3 ? picks : undefined, [], picksCards, false);
    log("  ⚠ no second node agrees with this node's settings: switching off with the settings rebuilt from this PC's files,");
    log(unreadable ? "    and every cap 0 (this node's caps couldn't be read): before enable, run config with your caps"
      : `    each cap the LOWEST of this node's${other ? ", the second node's" : ""} and your default (never looser), and no per-action limits until enable or config`);
  }
  const fromSat = (x: any) => (x && x !== "0" ? toMana(String(x)) : "0");
  const ids = (x: any) => (x ?? []).map((r: any) => `${r.contract}:${r.entry_point}`).join(", ") || "(none)";
  const row = (label: string, was: string, now: string) => log(`  ${label.padEnd(28)} ${was === now ? now : `${was} → ${now}`}`);
  log(`To the sponsor contract ${A} on ${rpc}${mainnet ? "   ⚠ MAINNET" : ""}, signed and paid by the sponsor wallet:`);
  // Audit SP-52: every setting the send can change, as config prints them.
  row("switched", cur.enabled ? "ON" : "off", "off");
  for (const [label, k] of [["per transaction", "max_mana_per_tx"], ["per player per day", "max_mana_per_account_day"], ["per player per week", "max_mana_per_account_week"],
    ["everyone per day", "max_mana_per_day"], ["free players per day", "max_mana_free_day"], ["real player: stake of", "min_vhp"]] as const) row(label, fromSat(cur[k]), fromSat(config[k]));
  for (const [label, k] of [["game", "game"], ["Knode Swap (never paid)", "desk"], ["VHP", "vhp"], ["race", "race"]] as const) row(label, String(cur[k] ?? "(none)"), String(config[k] ?? "(none)"));
  row("tokens", (cur.tokens ?? []).join(", "), (config.tokens ?? []).join(", "));
  row("allowlisted calls", ids(cur.allowed), ids(config.allowed));
  row("per-action limits", `${(cur.mana_caps ?? []).length} row(s)`, `${(config.mana_caps ?? []).length} row(s)`);
  row("vault (v6) live", cur.game_has_vault ? "yes" : "no", config.game_has_vault ? "yes" : "no");
  if (!send) {
    log(agreed ? "\nDry run only. Nothing was sent. Add --send to send it (only the switch changes)."
      : "\nDry run only. Nothing was sent. These rebuilt settings are sent only with: npm run sponsor -- disable --rebuilt --send");
    return;
  }
  // Audit SP-44 (round 5): never sign a different path from the one previewed.
  if (!agreed && !rebuiltOk) throw new Error("Not sent: the second node doesn't agree with this node's settings now, so switching off would also rebuild the settings (see the preview without --send). If that is what you want: npm run sponsor -- disable --rebuilt --send");
  if (agreed && rebuiltOk) log("  (the two nodes agree now: only the switch changes, less than the rebuilt preview showed)");
  const chain = new KoinosChain(rpc, A);
  const r = await chain.send([{ contract: A, abi: loadAbi(), method: "set_config", args: { config } }], [s], { payer: A, rcLimitKoin: 2 });
  log(r.ok ? `✔ done (Mana used ${showKoin(r.rcUsed)})  transaction ${r.txId}` : `✖ ${r.error}`);
  if (!r.ok) process.exitCode = 1;
}

/** Copies the per-action limits into the website's sponsor block (game and desk deployment files), if it has one. */
export function syncSiteLimits(rows: ReturnType<typeof readLimits>["rows"], files = { game: GAME_DEP, desk: DESK_DEP }): boolean {
  let changed = false;
  for (const f of [files.game, files.desk]) {
    const d = readJson(f);
    if (!d?.sponsor) continue;
    d.sponsor.rcLimits = siteMap(rows);
    writeJson(f, d); changed = true;
  }
  return changed;
}

// ═══════════════════════════════ the Mana adjuster ═══════════════════════════════
/** One action measured elsewhere (the testnet, before it is sponsored on mainnet): adds it with the manual margin (3 ×). */
async function manaLimit(a: string[]) {
  const source = flag(a, "--source", "");
  const pos = a.filter((x, i) => !x.startsWith("--") && a[i - 1] !== "--source" && a[i - 1] !== "--limit");
  // Owner, 2026-10-30: --limit sets the row to an exact number (the Picks pick at 0.2 Mana for 10-leg Combo cards),
  // instead of 3 × the measured number; still at least 1.25 × the measured number and at most the per-transaction cap.
  const exact = flag(a, "--limit", "");
  const [what, most] = pos;
  const m = /^(game|desk|race|picks):([a-z_]+)$/.exec(what ?? "");
  if (!m || !/^\d+(\.\d{1,8})?$/.test(most ?? "") || !(Number(most) > 0) || !source)
    throw new Error('Usage: npm run sponsor -- mana-limit picks:pick 0.0477 --source "testnet 2026-10-28" [--limit 0.2] [--save]');
  if (exact && !(/^\d+(\.\d{1,8})?$/.test(exact) && Number(exact) > 0)) throw new Error(`--limit ${exact}: a number of Mana, like 0.2`);
  // Review L3: a missing zero would set a limit far too low; a Knode action uses at least about 0.01 Mana.
  if (Number(most) < 0.01 && !a.includes("--force")) throw new Error(`${most} Mana is less than any Knode action uses (about 0.01 and up). Check the number; add --force only if it is right.`);
  const k = knode();
  const contract = ({ game: k.game.contract, desk: k.desk.contract, race: k.race, picks: k.picks } as any)[m[1]];
  if (!contract) throw new Error(`No ${m[1]} contract yet (its deployment.json is missing).`);
  const names = actionNames({ game: k.game.contract, desk: k.desk.contract, race: k.race, picks: k.picks });
  const hit = Object.entries(names).find(([kk, n]) => kk.startsWith(contract + ":") && n.endsWith(" " + m[2]));
  if (!hit) throw new Error(`${m[2]} is not a sponsored action of the ${m[1]} contract.`);
  const entry = parseInt(hit[0].split(":")[1], 16);
  const perTx = await chainPerTx(), old = readLimits(), at = new Date().toISOString(), skipped: string[] = [];
  const rows = merge(old.rows, [{ contract, entry, name: hit[1], count: 1, maxSat: BigInt(units(String(most))), typicalSat: BigInt(units(String(most))), manual: true }], perTx, source, at, skipped);
  for (const x of skipped) log(`⚠ ${x}`);
  const r = rows.find((x) => x.contract === contract && x.entry_point === entry);
  if (!r) return;
  if (exact) {
    // Audit SP-55 (round 6): against the most this action has EVER used (the row's merged maximum, which includes
    // earlier reports), not only the number typed now, so re-running this can't cut a row below what it needs.
    const want = BigInt(units(exact)), most_ = BigInt(r.observed!.max);
    if (want * 4n < most_ * 5n) throw new Error(`--limit ${exact} is less than 1.25 × the ${toMana(most_)} Mana this action has used: too little room. Nothing saved.`);
    if (want > perTx) throw new Error(`--limit ${exact} is above the ${toMana(perTx)} Mana per-transaction cap. Nothing saved.`);
    if (BigInt(r.max_mana) > want) log(`⚠ the row was ${toMana(r.max_mana)} Mana; --limit lowers it to ${exact}`);
    r.max_mana = want.toString();
    checkRows(rows, perTx);
  }
  log(`${r.name}: has used up to ${toMana(r.observed!.max)} Mana (${source}) → limit ${toMana(r.max_mana)} Mana (${exact ? "as you set it with --limit" : "3 × for a number measured elsewhere, at least 0.05"}).`);
  if (!a.includes("--save")) { log("Nothing saved. Add --save."); return; }
  writeJson(LIMITS_FILE, { v: 1, updated: at, margin: MARGIN, rows });
  log(`✔ saved ${LIMITS_FILE}. Next: npm run sponsor -- site-limits --send (pull request to main, merge, wait), then config --send.`);
}
/** The per-transaction cap the sponsor has on chain now (else the default). */
async function chainPerTx(): Promise<bigint> {
  const cur = await currentChainConfig();
  return BigInt(cur.max_mana_per_tx && cur.max_mana_per_tx !== "0" ? cur.max_mana_per_tx : units(DEFAULT_CAPS.perTx));
}
/** Audit SP-33: a failed read stops (it never becomes "nothing set"), as config does. */
async function currentChainConfig(): Promise<any> {
  const { rpc } = knode(); const address = readJson(STATE)?.address ?? PINNED_MAINNET.sponsor;
  return configOn(rpc, address);
}
/** Step 1 of a limits change (review L1): the website gets, for each action, the lower of the sponsor's current limit
 *  and the new one, so whatever the page asks for is accepted before and after the chain changes. */
async function siteLimits(send: boolean) {
  const cur = await currentChainConfig();
  const perTx = BigInt(cur.max_mana_per_tx && cur.max_mana_per_tx !== "0" ? cur.max_mana_per_tx : units(DEFAULT_CAPS.perTx));
  const rows = transitionRows(cur.mana_caps ?? [], readLimits().rows, perTx);
  for (const r of rows) log(`  ${r.name.padEnd(32)} the website will ask for ${toMana(r.max_mana)} Mana`);
  if (!send) { log("\nDry run only. Add --send to write game-data/ and desk-data/deployment.json."); return; }
  log(syncSiteLimits(rows) ? `✔ written. Commit and push ${GAME_DEP} and ${DESK_DEP}, wait for the site to update (a few minutes), then: npm run sponsor -- config --send` : "No sponsor block in the deployment files yet (npm run sponsor -- payer sponsor --send).");
}

/** Reads sponsored transactions from the last `blocks` blocks: what each action used (read-only). */
async function manaReport(a: string[]) {
  const { game, desk, rpc, race, picks } = knode();
  const st = readJson(STATE);
  const address = st?.address ?? PINNED_MAINNET.sponsor;
  const provider = new Provider([rpc]);
  const blocks = Math.max(100, Math.min(201600, Number(flag(a, "--blocks", "28800")) || 28800));
  const head: any = await provider.getHeadInfo();
  const top = Number(head.last_irreversible_block), from = Math.max(1, top - blocks + 1);
  log(`Mana adjuster: sponsored transactions (payer ${address}) in blocks ${from}–${top} (~${Math.round(blocks * 3 / 3600)} hours) on ${rpc}…`);
  const samples: Sample[] = [];
  let seenTx = 0;
  for (let h = from; h <= top; h += 100) {
    const n = Math.min(100, top - h + 1);
    const r: any = await provider.call("block_store.get_blocks_by_height", { head_block_id: head.head_topology.id, ancestor_start_height: String(h), num_blocks: n, return_block: true, return_receipt: true });
    for (const it of r?.block_items ?? []) {
      const txs = it.block?.transactions ?? [], recs = it.receipt?.transaction_receipts ?? [];
      // Audit SP-6: each transaction with ITS receipt (matched by id), never by position alone.
      const byId = new Map<string, any>(recs.map((x: any) => [String(x?.id ?? ""), x]));
      for (let i = 0; i < txs.length; i++) {
        const tx = txs[i], rec = byId.get(String(tx?.id ?? ""));
        if (tx?.header?.payer !== address) continue;
        seenTx++;
        if (!rec) continue;
        const calls = (tx.operations ?? []).map((o: any) => o.call_contract).filter(Boolean);
        if (!calls.length || calls.length !== (tx.operations ?? []).length) continue;
        const k0 = key(calls[0].contract_id, calls[0].entry_point >>> 0);
        if (!calls.every((c: any) => key(c.contract_id, c.entry_point >>> 0) === k0)) continue;   // mixed: can't split fairly
        const outOfRc = (rec.logs ?? []).some((l: any) => /insufficient (rc|mana|resources)|resource limit|rc limit/i.test(String(l)));
        samples.push({ contract: calls[0].contract_id, entry: calls[0].entry_point >>> 0, rcUsed: BigInt(rec.rc_used ?? 0), rcLimit: BigInt(rec.rc_limit ?? tx.header?.rc_limit ?? 0), ops: calls.length, reverted: !!rec.reverted, outOfRc, height: h, txId: String(tx.id) } as any);
      }
    }
    if ((h - from) % 5000 < 100) process.stdout.write(`  …block ${h}\r`);
  }
  // Audit SP-6: every measured transaction's receipt is read again from the second node; a difference drops it.
  if (onMainnet(rpc)) {
    const check = new Provider([secondNode()]);
    const ch: any = await check.getHeadInfo();
    const keep: Sample[] = [];
    const heights = [...new Set(samples.map((x: any) => x.height))];
    const theirs = new Map<string, string>();
    for (let i = 0; i < heights.length; i += 1) {
      const r: any = await check.call("block_store.get_blocks_by_height", { head_block_id: ch.head_topology.id, ancestor_start_height: String(heights[i]), num_blocks: 100, return_block: true, return_receipt: true });
      for (const it of r?.block_items ?? []) for (const x of it.receipt?.transaction_receipts ?? []) theirs.set(String(x.id), String(x.rc_used ?? ""));
    }
    for (const x of samples as any[]) if (theirs.get(x.txId) === x.rcUsed.toString()) keep.push(x);
    if (keep.length !== samples.length) log(`⚠ ${samples.length - keep.length} transaction(s) left out: the second node (${CHECK_RPC()}) shows them differently or not at all.`);
    samples.length = 0; samples.push(...keep);
  }
  const cfg = await configOn(rpc, address);
  const perTx = BigInt(cfg.max_mana_per_tx && cfg.max_mana_per_tx !== "0" ? cfg.max_mana_per_tx : units(DEFAULT_CAPS.perTx));
  const names = actionNames({ game: game.contract, desk: desk.contract, race, picks, tokens: [game.vhp ?? PINNED_MAINNET.vhp, game.koin ?? PINNED_MAINNET.koin] });
  const stats = summarize(samples, names);
  const old = readLimits();
  log(`\n${seenTx} sponsored transactions; ${samples.filter((x) => x.ops === 1 && !x.reverted).length} single-action ones measured.`);
  for (const x of stats) if (x.ranOut) log(`⚠ ${x.name}: ${x.ranOut} transaction(s) ran out of Mana: its limit goes up.`);
  log(`${"Action".padEnd(32)} ${"seen".padStart(5)} ${"typical".padStart(9)} ${"most".padStart(9)} ${"limit now".padStart(10)} ${"suggested".padStart(10)}`);
  const at = new Date().toISOString();
  const skipped: string[] = [];
  const rows = merge(old.rows, stats, perTx, `mainnet blocks ${from}-${top}`, at, skipped);
  for (const x of skipped) log(`⚠ ${x}`);
  for (const r of rows) {
    const s = stats.find((x) => key(x.contract, x.entry) === key(r.contract, r.entry_point));
    const now = old.rows.find((x) => key(x.contract, x.entry_point) === key(r.contract, r.entry_point));
    log(`${r.name.padEnd(32)} ${String(s?.count ?? "–").padStart(5)} ${(s ? toMana(s.typicalSat) : "–").padStart(9)} ${(s ? toMana(s.maxSat) : "–").padStart(9)} ${(now ? toMana(now.max_mana) : toMana(perTx)).padStart(10)} ${toMana(r.max_mana).padStart(10)}`);
  }
  log(`\nRule: limit = 2 × the most an action has used in one transaction (at least 0.05, at most the ${toMana(perTx)} per-transaction cap), never lowered, never below 1.25 ×.`);
  if (!a.includes("--save")) { log(`Nothing saved. Add --save to write ${LIMITS_FILE}, then: npm run sponsor -- config --send (and commit both).`); return; }
  fs.mkdirSync("sponsor-data", { recursive: true });
  writeJson(LIMITS_FILE, { v: 1, updated: at, margin: MARGIN, rows });
  log(`✔ saved ${LIMITS_FILE}. Next: npm run sponsor -- site-limits --send (pull request to main, merge, wait), then config --send; commit ${LIMITS_FILE} too.`);
}

// ═══════════════════════════════ website payer ═══════════════════════════════
/** Who the website asks to pay: writes "payer" (and the "sponsor" block) into both deployment files. Exported for tests. */
export function setPayer(choice: "sponsor" | "self", rcLimitMana = "1", files: { game: string; desk: string; state: string; race?: string; picks?: string } = { game: GAME_DEP, desk: DESK_DEP, state: STATE, race: RACE_DEP, picks: PICKS_DEP }) {
  const game = readJson(files.game), desk = readJson(files.desk), st = readJson(files.state);
  const race = files.race ? readJson(files.race)?.contract : undefined;
  const picks = files.picks ? readJson(files.picks)?.contract : undefined;
  if (!game?.contract || !desk?.contract) throw new Error("game-data and desk-data deployment.json are needed.");
  if (choice === "sponsor" && !st?.address) throw new Error(`${files.state} has no sponsor yet: upload it first (npm run sponsor -- upload --send).`);
  const block = st?.address ? {
    address: st.address,
    // Owner, 2026-10-29: Knode Swap is never sponsored, so it isn't among what the sponsor covers.
    covers: [game.contract, game.vhp ?? PINNED_MAINNET.vhp, game.koin ?? PINNED_MAINNET.koin, ...(race ? [race] : []), ...(picks ? [picks] : [])],
    // Producer Race picks: free play like answers (the website asks with the answers' Mana limit).
    ...(race ? { race } : {}),
    // KnodeGames picks (sponsor v3): free play like answers.
    ...(picks ? { picks } : {}),
    tokens: [game.vhp ?? PINNED_MAINNET.vhp, game.koin ?? PINNED_MAINNET.koin],
    rcLimit: units(rcLimitMana),
    // Staking, withdrawing, swapping and claiming do more than an answer, but the sponsor pays at most its
    // per-transaction cap (audit SP-17: asking for more meant the sponsor was never asked at all).
    rcLimitOther: units(DEFAULT_CAPS.perTx),
    // v3: each action's own Mana limit; the page asks for the sum of its actions' limits. Audit SP-19: the lower of the
    // site's current entry and the new one, so whatever the chain has now still accepts it.
    rcLimits: (() => { const now = game?.sponsor?.rcLimits ?? {}, next = siteMap(readLimits().rows), out: Record<string, string> = {};
      for (const [k, v] of Object.entries(next)) out[k] = now[k] !== undefined && BigInt(now[k]) < BigInt(v as string) ? now[k] : (v as string);
      return out; })(),
  } : undefined;
  // Owner, 2026-10-29: Knode Swap pages always use the player's own Mana (sponsor v3 refuses swaps).
  desk.payer = "self"; delete desk.sponsor;
  writeJson(files.desk, desk);
  for (const [f, d] of [[files.game, game]] as const) {
    d.payer = choice;
    // Keep the owner's guest-play switch ("sponsor": { "guest": true }) when the sponsor block is rewritten.
    if (block && (d as any).sponsor?.guest === true) (block as any).guest = true;
    if (block) d.sponsor = block; else delete d.sponsor;
    writeJson(f, d);
  }
  return block;
}

/** keys --testnet: a new sponsor wallet for the testnet trial, written to .env.testnet (never printed). */
function keys() {
  if (!TESTNET) throw new Error("keys is for the testnet trial only (add --testnet). The mainnet sponsor wallet already exists.");
  const file = path.resolve(".env.testnet");
  let text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const have = text.match(/^SPONSOR_WIF=(.*)$/m);
  if (have) { log(`SPONSOR_WIF already exists in .env.testnet: ${Signer.fromWif(have[1].trim()).getAddress()}`); return; }
  const wif = Signer.fromSeed(crypto.randomBytes(32).toString("hex")).getPrivateKey("wif");
  text = (text.trim() ? text.replace(/\s*$/, "\n") : "") + `SPONSOR_WIF=${wif}\n`;
  fs.writeFileSync(file, text, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
  log(`Added SPONSOR_WIF (new) to .env.testnet. The testnet sponsor wallet is:\n  ${Signer.fromWif(wif).getAddress()}\nGet it test KOIN from the faucet bot (@KoinosTestnetFaucetBot, /faucet <address>), a few times: its KOIN is its Mana.`);
}

async function main() {
  const [cmd = "status", ...a] = process.argv.slice(2).filter((x) => x !== "--testnet");
  if (cmd === "keys") return keys();
  const send = a.includes("--send");
  // Audit SP-32: --testnet always uses the testnet's own files, decided before (and whatever) the chain-id read.
  if (TESTNET) {
    STATE = path.join("sponsor-data", "testnet", "deployment.json");
    LIMITS_FILE = path.join("sponsor-data", "testnet", "mana-limits.json");
    if (cmd === "payer" || cmd === "site-limits") throw new Error(`${cmd} changes the website, which runs on mainnet: not on the testnet.`);
  }
  // Audit SP-12: mainnet or not by the node's chain id; the testnet keeps its own files.
  try {
    const id = await new Provider([knode().rpc]).getChainId();
    MAINNET = id === MAINNET_CHAIN_ID;
    const k: any = knode();
    if (TESTNET && (MAINNET || (k.testnetChainId && id !== k.testnetChainId))) throw new Error(`--testnet, but the node ${k.rpc} is not the Koinos Foundation testnet. Nothing was done.`);
    if (!TESTNET && !MAINNET) throw new Error(`The node ${k.rpc} is not Koinos mainnet. For the testnet trial add --testnet.`);
  } catch (e) { if (/Nothing was done|not Koinos mainnet/.test(String((e as Error).message))) throw e; MAINNET = null; }
  if (MAINNET === false) {
    STATE = path.join("sponsor-data", "testnet", "deployment.json");
    LIMITS_FILE = path.join("sponsor-data", "testnet", "mana-limits.json");
    if (cmd === "payer" || cmd === "site-limits") throw new Error(`${cmd} changes the website, which runs on mainnet: not on the testnet.`);
  }
  if (send && MAINNET === null && cmd !== "payer") throw new Error("Couldn't read the node's chain id, so it isn't clear whether this is mainnet. Nothing was sent.");
  switch (cmd) {
    // Audit SP-43: a failed read is reported as such, not as a usage warning.
    case "watch": return watch().catch((e) => { console.log(`::warning::Mana sponsor watch failed: ${String((e as Error).message).replace(/[\r\n]+/g, " ").replace(/::/g, ": ")}`); process.exitCode = 1; });
    case "status": return status();
    case "upload": return upload(send);
    case "config": return setConfig(a, send);
    case "enable": return setConfig(a, send, true);
    case "disable": return setConfig(a, send, false);
    case "mana-report": return manaReport(a);
    case "mana-limit": return manaLimit(a);
    case "site-limits": return siteLimits(send);
    case "payer": {
      const choice = a[0];
      if (choice !== "sponsor" && choice !== "self") throw new Error('payer sponsor | payer self');
      if (!send) {
        log(`Would set "payer": "${choice}" in ${GAME_DEP} and ${DESK_DEP} (on this PC; nothing goes on chain).`);
        log("\nDry run only. Nothing was changed. Add --send to change the files.");
        return;
      }
      const b = setPayer(choice, flag(a, "--rc-limit", "1"));
      log(choice === "sponsor"
        ? `The website will ask the sponsor ${b!.address} to pay players' Mana (up to ${Number(b!.rcLimit) / 1e8} Mana per answer and ${Number(b!.rcLimitOther) / 1e8} for other actions; staked players' answers stay with the game).`
        : "The website will let players pay their own Mana (the sponsor is not asked).");
      log(`Edited ${GAME_DEP} and ${DESK_DEP}. Commit and push them (git add game-data/deployment.json desk-data/deployment.json, git commit, git push): the site follows within a few minutes.`);
      return;
    }
    default: throw new Error(`Unknown command "${cmd}". Commands: status, watch, upload, config, enable, disable, mana-report, mana-limit, site-limits, payer sponsor|self`);
  }
}

if (process.argv[1] && /sponsor\.ts$/.test(process.argv[1])) {
  main().catch((e) => { console.error(`\n✖ ${e.message ?? e}`); process.exit(1); });
}

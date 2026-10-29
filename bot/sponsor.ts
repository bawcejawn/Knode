/**
 * MANA SPONSOR TOOL: set up and run the wallet whose Mana pays for players' Knode transactions (sponsor/README.md).
 * Every command that sends is a dry run (it only shows what it would do) unless you add --send.
 *
 *   npm run sponsor -- status                       the sponsor right now: on/off, caps, KOIN and Mana, today's use
 *   npm run sponsor -- upload [--send]              put the sponsor contract on the sponsor wallet (SPONSOR_WIF)
 *   npm run sponsor -- config [--per-tx 1] [--per-player-day 50] [--per-player-week 300] [--per-day 5000] [--free-per-day 2000] [--min-vhp 1] [--send]
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
import { units, isMainnet, pinDeployment, PINNED_MAINNET } from "./bot.ts";
import { readLimits, summarize, merge, chainRows, siteMap, actionNames, checkRows, toMana, key, transitionRows, siteFits, LIMITS_FILE, MARGIN, type Sample } from "./mana-limits.ts";

const E = process.env;
const log = (...a: any[]) => console.log(...a);
const WASM = "sponsor/build/release/contract.wasm";
const ABI_FILE = "sponsor/abi/sponsor.koilib.json";
const STATE = path.join("sponsor-data", "deployment.json");
const GAME_DEP = path.join("game-data", "deployment.json");
const DESK_DEP = path.join("desk-data", "deployment.json");
const RACE_DEP = path.join("race-data", "deployment.json");
const PICKS_DEP = path.join("picks-data", "deployment.json");
/** v3: the KnodeGames Picks contract's `pick` (picks/abi/picks.koilib.json) and its argument shape, one byte per field:
 *  wire type + 1 (player bytes, game varint, round varint, producers bytes, number varint). npm run check (sponsor)
 *  confirms the shape against the Picks ABI. */
export const PICKS_PICK = 0x8ce33c6c;
export const PICKS_ARG_TYPES = "0x0301010301";
/** Suggested caps (Mana): per transaction, per player per day, per player per week, everyone per day.
 *  Owner's decisions 2026-10-28: everyone 5,000 a day (the sponsor wallet holds at least 25,000 KOIN, whose Mana refills
 *  in about 5 days), of which free players (no VHP, no stake; guests too) share at most 2,000, so staked players always
 *  have 3,000 or more; 50 per player per day (300 a week). The caps count each transaction's Mana limit, and with the
 *  per-action limits (mana-report) a Block X pick counts about 0.1, not 1. */
export const DEFAULT_CAPS = { perTx: "1", perPlayerDay: "50", perPlayerWeek: "300", perDay: "5000", minVhp: "1", freePerDay: "2000" };
/** The audited sponsor build (sponsor/README.md "Build"). upload refuses any other wasm. v2 (race picks), audited
 *  2026-10-27 (docs/history/AUDIT-2026-10-27-race-picks.md); v1 was 8cfeff6209b8d5cbc3b3e5fa30751e995767f5904b77693ed8a41e323ea2a8ed. */
export const SPONSOR_SHA256 = "fa4659e65c6156da3dde34238e0545a489a8b7f00cdf51df9bf79517a0019f33";
/** v3 release candidate (allowlist, free claims, 5,000 ceiling, per-action Mana limits): NOT yet audited, so it may go
 *  only on the testnet. After the audit and fix-check it replaces SPONSOR_SHA256. */
export const SPONSOR_V3_CANDIDATE = "21bec82583e1a7decbb2c70376f4b08e026f617c32bca268ab700f50e9aef2df";
/** The builds this network may receive. */
export const allowedBuilds = (mainnet: boolean) => (mainnet ? [SPONSOR_SHA256] : [SPONSOR_SHA256, SPONSOR_V3_CANDIDATE]);

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
function knode() {
  const game = readJson(GAME_DEP), desk = readJson(DESK_DEP), race = readJson(RACE_DEP);
  if (!game?.contract || !desk?.contract) throw new Error(`${GAME_DEP} and ${DESK_DEP} are needed.`);
  const rpc = E.RPC ?? game.rpc ?? "https://koinos.armana.io";
  pinDeployment("game", game, rpc, GAME_DEP);
  pinDeployment("desk", desk, rpc, DESK_DEP);
  const picks = readJson(PICKS_DEP);
  return { game, desk, rpc, race: race?.contract ? String(race.contract) : undefined, picks: picks?.contract ? String(picks.contract) : undefined };
}

function sponsorKey(provider: Provider) {
  const s = Signer.fromWif(need("SPONSOR_WIF"));
  s.provider = provider;
  const { game, desk } = knode();
  const a = s.getAddress();
  const taken: Record<string, string> = { [game.contract]: "the game contract", [desk.contract]: "Knode Swap", [game.owner]: "the owner wallet", [game.operator]: "the bot wallet", [PINNED_MAINNET.koin]: "KOIN", [PINNED_MAINNET.vhp]: "VHP" };
  if (taken[a]) throw new Error(`SPONSOR_WIF is ${taken[a]}'s key. The sponsor needs a brand-new wallet of its own.`);
  if (E.OWNER_WIF && Signer.fromWif(E.OWNER_WIF).getAddress() === a) throw new Error("SPONSOR_WIF is the owner's key. Use a new wallet.");
  if (isMainnet(knode().rpc) && a !== PINNED_MAINNET.sponsor) throw new Error(`SPONSOR_WIF belongs to ${a}, not the Knode sponsor wallet ${PINNED_MAINNET.sponsor}. Check the SPONSOR_WIF line in .env.`);
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
  log(`Mana sponsor ${address} on ${rpc}${isMainnet(rpc) ? " (mainnet)" : ""}`);
  const koin = new Contract({ id: PINNED_MAINNET.koin, abi: tokenAbi as any, provider });
  const bal = ((await (koin.functions as any).balance_of({ owner: address })).result?.value) ?? "0";
  log(`  KOIN           ${showKoin(bal)}  (Mana now ${mana(await provider.getAccountRc(address))}; it refills over about 5 days)`);
  const m = await contractMetadata(provider, address);
  if (!m.exists) { log("  Contract       not uploaded yet (npm run sponsor -- upload)"); return; }
  log(`  Code           sha256 ${m.hash.replace(/^0x1220/, "")}${st?.wasmSha256 && m.hash.endsWith(st.wasmSha256) ? " (as uploaded)" : ""}`);
  log(`  Switches       pays for transactions: ${m.tx ? "yes" : "NO"}; its settings use its own key: ${m.call ? "NO (overridden!)" : "yes"}; uploads use its own key: ${m.upload ? "NO (overridden!)" : "yes"}`);
  const cfg = await readSponsor(provider, address, "get_config");
  log(`  Switched       ${cfg.enabled ? "ON" : "off"}`);
  log(`  Pays for       game ${cfg.game === game.contract ? "✔" : `✖ (${cfg.game ?? "not set"})`}, Knode Swap ${cfg.desk === desk.contract ? "✔" : `✖ (${cfg.desk ?? "not set"})`}, approves on ${(cfg.tokens ?? []).length} token(s)`);
  log(`  Caps           ${mana(cfg.max_mana_per_tx)} per transaction, ${mana(cfg.max_mana_per_account_day)} per player per day, ${mana(cfg.max_mana_per_account_week)} per player per week, ${mana(cfg.max_mana_per_day)} for everyone per day`);
  log(`  Race picks     ${cfg.race ? `free play, on ${cfg.race}` : "not sponsored"}`);
  log(`  Players        answers: any wallet; everything else: wallets holding at least ${showKoin(cfg.min_vhp ?? "0")} VHP, or with a stake in the game`);
  const t = await readSponsor(provider, address, "get_total_usage");
  log(`  Used today     ${mana(t.used_day)} of ${mana(cfg.max_mana_per_day)}`);
  const fu = await readSponsor(provider, address, "get_free_usage").catch(() => ({} as any));
  log(`  Free answers   ${mana(fu.used_day)} of ${mana(cfg.max_mana_free_day)} today (wallets with no VHP and no stake)`);
  const site = (d: any) => (d?.payer === "sponsor" && d?.sponsor?.address === address ? "the sponsor" : "players' own Mana");
  log(`  Website        game pages: ${site(game)}; Knode Swap: ${site(desk)}  (npm run sponsor -- payer sponsor|self)`);
}

// ═══════════════════════════════ upload ═══════════════════════════════
async function upload(send: boolean) {
  const { rpc } = knode();
  const mainnet = isMainnet(rpc);
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
  const need = toSat(Math.ceil(wasm.length / 1024 * 1.2 + 10));
  log(`Sponsor wallet     ${A}${mainnet ? "   ⚠ MAINNET" : ""}`);
  log(`Code               ${WASM}, ${(wasm.length / 1024).toFixed(1)} KB, sha256 ${sha256hex(wasm)}`);
  log(`Switches           pays for transactions ON; settings and uploads stay with this wallet's key`);
  log(`Mana               has ${showKoin(have)}, the upload needs about ${showKoin(need)}`);
  if (m.exists) log(`Note               this wallet already has code (sha256 ${m.hash.replace(/^0x1220/, "")}); uploading replaces it`);
  if (have < need) throw new Error(`Send at least ${showKoin(need - have + toSat(5))} more KOIN to ${A} first (its KOIN is its Mana).`);
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
  log(`✔ uploaded (Mana used ${showKoin(receipt?.rc_used)}). On chain: ${after.hash}; pays for transactions: ${after.tx}`);
  log(`Saved ${STATE} (public; commit it). Next: npm run sponsor -- config --send, then enable --send.`);
}

// ═══════════════════════════════ settings ═══════════════════════════════
function flag(a: string[], name: string, d: string) { const i = a.indexOf(name); return i >= 0 && a[i + 1] && !a[i + 1].startsWith("--") ? a[i + 1] : d; }

/** Builds the config: the pinned game, Desk, VHP and KOIN, and the caps. Exported for the tests. */
export function buildConfig(game: any, desk: any, caps: { perTx: string; perPlayerDay: string; perPlayerWeek: string; perDay: string; minVhp?: string; freePerDay?: string }, enabled: boolean, race?: string, picks?: string, manaRows: ReturnType<typeof readLimits>["rows"] = []) {
  const vhp = game.vhp ?? PINNED_MAINNET.vhp;
  const c = {
    enabled, game: game.contract, desk: desk.contract, tokens: [vhp, game.koin ?? PINNED_MAINNET.koin],
    max_mana_per_tx: units(caps.perTx), max_mana_per_account_day: units(caps.perPlayerDay),
    max_mana_per_account_week: units(caps.perPlayerWeek), max_mana_per_day: units(caps.perDay),
    // Only real players are sponsored (audit M-1): at least this much VHP in the wallet, or a stake in the game.
    vhp, min_vhp: units(caps.minVhp ?? DEFAULT_CAPS.minVhp),
    // Answers are paid for any wallet; those by wallets that aren't real players also count against this daily total.
    // Not given: the default, but never above everyone's daily cap.
    max_mana_free_day: caps.freePerDay !== undefined ? units(caps.freePerDay)
      : (BigInt(units(DEFAULT_CAPS.freePerDay)) < BigInt(units(caps.perDay)) ? units(DEFAULT_CAPS.freePerDay) : units(caps.perDay)),
    // Producer Race picks are free play like answers (sponsor v2). Left out: picks aren't sponsored.
    ...(race ? { race } : {}),
    // v3: the KnodeGames Picks contract's picks are free play like answers (the payee's own, arguments in the Picks shape).
    ...(picks ? { allowed: [{ contract: picks, entry_point: PICKS_PICK, free_play: true, arg_types: PICKS_ARG_TYPES }] } : {}),
    // v3: each action's own Mana limit (sponsor-data/mana-limits.json, from mana-report). No rows: the per-transaction cap.
    ...(manaRows.length ? { mana_caps: chainRows(manaRows) } : {}),
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

async function setConfig(a: string[], send: boolean, enabledArg?: boolean) {
  const { game, desk, rpc, race, picks } = knode();
  if (send && isMainnet(rpc) && E.CONFIRM_MAINNET !== "yes") throw new Error("MAINNET: add CONFIRM_MAINNET=yes to .env first.");
  const provider = new Provider([rpc]);
  const s = sponsorKey(provider);
  const A = s.getAddress();
  const cur = await readSponsor(provider, A, "get_config").catch(() => ({} as any));
  const fromSat = (x: any, d: string) => (x && x !== "0" ? (Number(x) / 1e8).toString() : d);
  const caps = {
    perTx: flag(a, "--per-tx", fromSat(cur.max_mana_per_tx, DEFAULT_CAPS.perTx)),
    perPlayerDay: flag(a, "--per-player-day", fromSat(cur.max_mana_per_account_day, DEFAULT_CAPS.perPlayerDay)),
    perPlayerWeek: flag(a, "--per-player-week", fromSat(cur.max_mana_per_account_week, DEFAULT_CAPS.perPlayerWeek)),
    perDay: flag(a, "--per-day", fromSat(cur.max_mana_per_day, DEFAULT_CAPS.perDay)),
    minVhp: flag(a, "--min-vhp", fromSat(cur.min_vhp, DEFAULT_CAPS.minVhp)),
    // Audit L-4: once the sponsor has been configured (its daily cap is set), its free cap is read back as it is,
    // 0 included, so enable/disable never switch free answers back on or fail. Only a never-configured sponsor
    // starts from the default.
    freePerDay: flag(a, "--free-per-day", cur.max_mana_per_day && cur.max_mana_per_day !== "0"
      ? (Number(cur.max_mana_free_day ?? 0) / 1e8).toString() : undefined as any),
  };
  const enabled = enabledArg ?? !!cur.enabled;
  const limits = readLimits();
  const config = buildConfig(game, desk, caps, enabled, race, picks, limits.rows);
  log(`To the sponsor contract ${A} on ${rpc}${isMainnet(rpc) ? "   ⚠ MAINNET" : ""}, signed and paid by the sponsor wallet:`);
  log(`  set_config: ${enabled ? "ON" : "off"}; pays for the game ${config.game} and Knode Swap ${config.desk}; approves on VHP and KOIN`);
  log(`  caps: ${caps.perTx} Mana per transaction, ${caps.perPlayerDay} per player per day, ${caps.perPlayerWeek} per player per week, ${caps.perDay} for everyone per day`);
  log(`  race picks: ${race ? `free play like answers, on ${race}` : "not sponsored (no race-data/deployment.json yet)"}`);
  log(`  KnodeGames picks: ${picks ? `free play like answers, on ${picks} (sponsor v3)` : "not sponsored (no picks-data/deployment.json yet)"}`);
  log(`  players: answers${race ? " and race picks" : ""}${picks ? " and KnodeGames picks" : ""} for any wallet; everything else only for wallets holding at least ${caps.minVhp} VHP, or with a stake in the game`);
  log(`  free answers (wallets with no VHP and no stake): at most ${Number(config.max_mana_free_day) / 1e8} Mana for everyone per day, inside the ${caps.perDay}`);
  if (limits.rows.length) {
    log(`  per-action Mana limits (${LIMITS_FILE}; any other action: ${caps.perTx} per transaction):`);
    for (const r of limits.rows) log(`    ${r.name.padEnd(32)} ${toMana(r.max_mana)} Mana${r.observed ? `   (has used up to ${toMana(r.observed.max)}, ${r.observed.count} seen, ${r.observed.source})` : ""}`);
  } else log(`  per-action Mana limits: none yet (every action may ask for up to ${caps.perTx}; run mana-report)`);
  // Review L1: the website must never ask for more than the sponsor accepts, before or after this change.
  const site = readJson(GAME_DEP)?.sponsor?.rcLimits ?? {};
  const perTxNew = BigInt(units(caps.perTx));
  const misfitNew = siteFits(site, chainRows(limits.rows), perTxNew), misfitNow = siteFits(site, cur.mana_caps ?? [], BigInt(cur.max_mana_per_tx && cur.max_mana_per_tx !== "0" ? cur.max_mana_per_tx : perTxNew));
  if (misfitNew.length) log(`  ⚠ the website would ask for more than the new limits for: ${misfitNew.join(", ")}. First: npm run sponsor -- site-limits --send, commit and push.`);
  if (!send) { log("\nDry run only. Nothing was sent. Add --send to send it."); return; }
  if (misfitNew.length) throw new Error("Not sent: give the website the safe limits first (npm run sponsor -- site-limits --send, then commit and push, then wait a few minutes).");
  void misfitNow;
  const chain = new KoinosChain(rpc, A);
  const r = await chain.send([{ contract: A, abi: loadAbi(), method: "set_config", args: { config } }], [s], { payer: A, rcLimitKoin: 2 });
  log(r.ok ? `✔ done (Mana used ${showKoin(r.rcUsed)})  transaction ${r.txId}` : `✖ ${r.error}`);
  if (!r.ok) { process.exitCode = 1; return; }
  // The website asks for the same limits the sponsor now accepts.
  if (syncSiteLimits(limits.rows)) log(`Updated the per-action limits in ${GAME_DEP} and ${DESK_DEP} to the new ones: commit and push them (any limit that went up is used once the site updates).`);
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
  const pos = a.filter((x, i) => !x.startsWith("--") && a[i - 1] !== "--source");
  const [what, most] = pos;
  const m = /^(game|desk|race|picks):([a-z_]+)$/.exec(what ?? "");
  if (!m || !/^\d+(\.\d{1,8})?$/.test(most ?? "") || !(Number(most) > 0) || !source)
    throw new Error('Usage: npm run sponsor -- mana-limit picks:pick 0.0477 --source "testnet 2026-10-28" [--save]');
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
  log(`${r.name}: has used up to ${toMana(r.observed!.max)} Mana (${source}) → limit ${toMana(r.max_mana)} Mana (3 × for a number measured elsewhere, at least 0.05).`);
  if (!a.includes("--save")) { log("Nothing saved. Add --save."); return; }
  writeJson(LIMITS_FILE, { v: 1, updated: at, margin: MARGIN, rows });
  log(`✔ saved ${LIMITS_FILE}. Next: npm run sponsor -- site-limits --send (commit and push), then config --send.`);
}
/** The per-transaction cap the sponsor has on chain now (else the default). */
async function chainPerTx(): Promise<bigint> {
  const cur = await currentChainConfig();
  return BigInt(cur.max_mana_per_tx && cur.max_mana_per_tx !== "0" ? cur.max_mana_per_tx : units(DEFAULT_CAPS.perTx));
}
async function currentChainConfig(): Promise<any> {
  try { const { rpc } = knode(); const address = readJson(STATE)?.address ?? PINNED_MAINNET.sponsor; return await readSponsor(new Provider([rpc]), address, "get_config"); } catch { return {}; }
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
      for (let i = 0; i < txs.length; i++) {
        const tx = txs[i], rec = recs[i] ?? {};
        if (tx?.header?.payer !== address) continue;
        seenTx++;
        const calls = (tx.operations ?? []).map((o: any) => o.call_contract).filter(Boolean);
        if (!calls.length || calls.length !== (tx.operations ?? []).length) continue;
        const k0 = key(calls[0].contract_id, calls[0].entry_point >>> 0);
        if (!calls.every((c: any) => key(c.contract_id, c.entry_point >>> 0) === k0)) continue;   // mixed: can't split fairly
        samples.push({ contract: calls[0].contract_id, entry: calls[0].entry_point >>> 0, rcUsed: BigInt(rec.rc_used ?? 0), rcLimit: BigInt(rec.rc_limit ?? tx.header?.rc_limit ?? 0), ops: calls.length, reverted: !!rec.reverted });
      }
    }
    if ((h - from) % 5000 < 100) process.stdout.write(`  …block ${h}\r`);
  }
  const cfg = await readSponsor(provider, address, "get_config").catch(() => ({} as any));
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
  log(`✔ saved ${LIMITS_FILE}. Next: npm run sponsor -- site-limits --send (commit and push), then config --send; commit ${LIMITS_FILE} too.`);
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
    covers: [game.contract, desk.contract, game.vhp ?? PINNED_MAINNET.vhp, game.koin ?? PINNED_MAINNET.koin, ...(race ? [race] : []), ...(picks ? [picks] : [])],
    // Producer Race picks: free play like answers (the website asks with the answers' Mana limit).
    ...(race ? { race } : {}),
    // KnodeGames picks (sponsor v3): free play like answers.
    ...(picks ? { picks } : {}),
    tokens: [game.vhp ?? PINNED_MAINNET.vhp, game.koin ?? PINNED_MAINNET.koin],
    rcLimit: units(rcLimitMana),
    // Staking, withdrawing, swapping and claiming do far more than an answer (approve, transfer, Proof-of-Burn, stake).
    rcLimitOther: units("3"),
    // v3: each action's own Mana limit (sponsor-data/mana-limits.json); the page asks for the sum of its actions' limits.
    rcLimits: siteMap(readLimits().rows),
  } : undefined;
  for (const [f, d] of [[files.game, game], [files.desk, desk]] as const) {
    d.payer = choice;
    // Keep the owner's guest-play switch ("sponsor": { "guest": true }) when the sponsor block is rewritten.
    if (block && (d as any).sponsor?.guest === true) (block as any).guest = true;
    if (block) d.sponsor = block; else delete d.sponsor;
    writeJson(f, d);
  }
  return block;
}

async function main() {
  const [cmd = "status", ...a] = process.argv.slice(2);
  const send = a.includes("--send");
  switch (cmd) {
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
    default: throw new Error(`Unknown command "${cmd}". Commands: status, upload, config, enable, disable, mana-report, mana-limit, site-limits, payer sponsor|self`);
  }
}

if (process.argv[1] && /sponsor\.ts$/.test(process.argv[1])) {
  main().catch((e) => { console.error(`\n✖ ${e.message ?? e}`); process.exit(1); });
}

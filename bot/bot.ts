/**
 * KPRED OPERATOR BOT — keeps the weekly game running. Every command is safe to run again at any time.
 *
 *   npm run bot -- status                     what the game looks like right now (read-only, no key needed).
 *                                             Production is read from recent block signers, not from bot-state.json.
 *   npm run bot -- tick                       do whatever is due: resolve finished questions, post today's
 *                                             questions, close/finalize weeks, settle players, compound
 *   npm run bot -- tick --dry-run             show what tick would do without sending anything
 *   npm run bot -- deploy                     dry run of the contract deployment (prints the plan)
 *   npm run bot -- deploy --send              deploy and initialise the contract (mainnet needs CONFIRM_MAINNET=yes)
 *   npm run bot -- admin <method> '<json>' --as owner|seed|operator [--send]
 *                                             one owner / seed-owner action (dry run unless --send)
 *   npm run bot -- rehearse [--weeks 3]       run whole weeks on a simulated chain built from real block history
 *
 * Keys come only from the environment (.env on your PC, or GitHub secrets for the scheduled bot):
 *   OPERATOR_WIF   the bot's key: posts and resolves questions, pays for its own transactions. It cannot move funds.
 *   CONTRACT_WIF   the contract's own key — only for `deploy` (keep it offline afterwards)
 *   OWNER_WIF / SEED_WIF   only for `admin` on your PC — never put these in GitHub
 *
 * Public data lives in game-data/ and is committed to the repo so anyone can check every question:
 *   deployment.json   contract address, settings, block heights        questions/W003-D2.json   one day's questions
 *   game.json         question-generator settings                       state.json / bot-state.json   bookkeeping
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync, execSync } from "node:child_process";
import { createRequire } from "node:module";
import { Signer, Provider, Contract } from "koilib";
import { Chain, KoinosChain, SimChain, Call, showKoin, toSat, loadAbi } from "./chain.ts";
import { tokenAbi } from "./token-abi.ts";
import { readCsv, syncBlocks, fetchRange, readVhp, MAINNET_VHP, type Blk } from "../common.ts";
import { chainOutcome, scoreQuestion, storedOutcome, paramsHashOf, vhpSubjects, type VhpReading } from "../resolver.ts";
import { pobAbi } from "../probes/scripts/abi.ts";
import { formatProduction, loadSigners, signerFromBlockItem, type SignedBlock } from "./production.ts";
import { contractManaVerdict } from "./mana.ts";

// ───────────────────────── settings ─────────────────────────

function loadEnv(file = ".env") {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
// --testnet: everything runs against the local Harbinger testnet node with its own keys (.env.testnet) and its own
// data folder (testnet-data). Mainnet keys, files and the live game are never touched.
export const TESTNET = process.argv.includes("--testnet");
if (TESTNET) {
  loadEnv(".env.testnet");
  process.env.NETWORK = "testnet";
  process.env.RPC ??= "http://127.0.0.1:8081";
  process.env.NODE_RPC ??= process.env.RPC;
  process.env.GEN_DIR ??= "testnet-data";
} else loadEnv();
const E = process.env;
/** Is this RPC the real network? Only the testnet flag or a Harbinger address says no. */
export const isMainnet = (rpc: string) => E.NETWORK !== "testnet" && !/harbinger/i.test(rpc);

export const DAY = 28_800;               // blocks per day (3-second blocks) — used for block-history bookkeeping only
export const HOUR_MS = 3_600_000, DAY_MS = 24 * HOUR_MS;
// The weekly rhythm (all UTC). Weeks start Monday 00:00. Questions come out at 12:00 Monday–Saturday and answers close
// at 00:00 the next day (12 hours). Sunday is results day.
export const RELEASE_HOUR = 12, LOCK_HOUR = 24, QUESTION_DAYS = 6;
const MIN_BLOCK_MS = 2_800, MAX_BLOCK_MS = 3_500; // the same bounds the contract enforces
const RESOLVE_MARGIN = 60;               // the contract resolves only after window_end + 60
const RESOLVE_SLACK = 1_200;             // windows must end ≥ ~1 hour (in blocks) before the week can close, so the bot has time
const MIN_ANSWER_MS = HOUR_MS;           // never post a question with less than 1 hour left to answer
export const utc = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC";
const COMPOUND_MIN = toSat(1);           // compound once at least 1 KOIN of block rewards has piled up
const SPACE = (n: number) => String(n).padStart(3, "0");

const sha256hex = (s: string | Uint8Array) => crypto.createHash("sha256").update(s).digest("hex");
const log = (...a: any[]) => console.log(...a);

// ───────────────────────── files ─────────────────────────

export type Paths = { dir: string; questions: string; deployment: string; botState: string };
export const paths = (dir: string): Paths => ({
  dir, questions: path.join(dir, "questions"), deployment: path.join(dir, "deployment.json"), botState: path.join(dir, "bot-state.json"),
});
const readJson = (f: string, d: any = {}) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : d);
const writeJson = (f: string, v: any) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2) + "\n"); };

type BotState = {
  checkedUpTo: number; orphans: number[]; lastCompound: number; warnings: string[];
  /** Block production by the pool: last block it produced, and blocks produced per day (day = height / 28,800). */
  lastProduced: number; producedByDay: Record<string, number>; producerScannedTo: number;
  /** Owner-only changes already emailed about (so each one fails a run, and emails you, once — not every hour). */
  notified?: string[];
  /** Block-producer keys first seen on record for the game and the desk (used when deployment.json names none). */
  producerKey?: string; deskProducerKey?: string;
  /** The owner-only settings seen on the last run (to report a change). */
  settings?: string;
};
type DayFile = { date: string; week: number; day: number; questions: any[]; skipped?: string };

function dayFiles(P: Paths): Array<{ file: string; data: DayFile }> {
  if (!fs.existsSync(P.questions)) return [];
  return fs.readdirSync(P.questions).filter((f) => f.endsWith(".json")).sort()
    .map((f) => ({ file: path.join(P.questions, f), data: readJson(path.join(P.questions, f)) }));
}

// ───────────────────────── context ─────────────────────────

export type Ctx = {
  chain: Chain;
  operator: Signer;
  P: Paths;
  dryRun: boolean;
  /** Runs the question generator (generator.ts) with these arguments. Returns true on success. */
  generator: (args: string[]) => { ok: boolean; output: string };
  /** Saves game-data/ to the repo (scheduled bot only) so a crash can never lose a posted question's details. */
  checkpoint: (message: string) => void;
  /** Recent irreversible blocks (height + producer), for the production health check. */
  recentBlocks?: () => Promise<Array<{ h: number; signer: string }>>;
  /** Recent block signers, read from the chain for the status line. Not set on the simulated chain. */
  recentSigners?: (lib: number, maxBlocks: number) => Promise<{ blocks: SignedBlock[]; from: number; to: number }>;
  /** Things that need a human. A scheduled run with problems ends as "failed", which makes GitHub email you. */
  problems: string[];
  quiet?: boolean;
  /** A question window's blocks read fresh from the chain (irreversible blocks only). Without it the bot uses
   *  blocks.csv (simulations and tests). */
  windowBlocks?: (from: number, to: number) => Promise<Blk[]>;
  /** VHP of these addresses ("network" = the whole network) right now, with the block height (read after the values,
   *  so the values are from that block or an earlier one). */
  vhp?: (who: string[]) => Promise<VhpReading>;
  /** The block-producer public key Proof-of-Burn has on record for an address ("" when none). */
  producerKey?: (producer: string) => Promise<string>;
  /** The Desk Swap contract, for its health check. */
  desk?: { deployment: any; read: (method: string, args?: any) => Promise<any> };
  /** Settles the bot paid for itself this run, because the contract declined to (capped by MAX_BOT_PAID_SETTLES). */
  botPaid?: number;
  /** Lifts the cap on bot-paid settles (the last hours before a week's settle_end). */
  botPaidUncapped?: boolean;
};

const num = (x: any) => Number(x ?? 0);
const big = (x: any) => BigInt(x ?? 0);

async function state(ctx: Ctx) {
  const s = await ctx.chain.read("get_state", {});
  const c = s.config ?? {}, t = s.totals ?? {};
  return {
    raw: s, c, t,
    height: num(s.height), time: num(s.time), genesis: num(c.genesis_time), weekLen: num(c.week_length), closeDelay: num(c.close_delay),
    weeksClosed: num(t.weeks_closed), weeksFinalized: num(t.weeks_finalized), nextId: num(t.next_question_id),
  };
}
/** Time (ms) week w ends. */
const weekEnd = (st: { genesis: number; weekLen: number }, w: number) => st.genesis + (w + 1) * st.weekLen;
/** Earliest time (ms) week w can close: close_delay after the week ends and after its latest resolution (v4). */
const closeAt = (st: { genesis: number; weekLen: number; closeDelay: number }, w: number, wk: any) =>
  Math.max(weekEnd(st, w), num(wk?.last_resolved_time)) + st.closeDelay;
/** The minimum stake for week w (a change applies from the week after it was made). */
const minStakeFor = (c: any, w: number) => (big(c.min_stake_next) > 0n && w >= num(c.min_stake_next_week) ? big(c.min_stake_next) : big(c.min_stake));

/** The most settles the bot pays for itself in one run when the contract declines to. The bot's Mana must stay
 *  available for posting and resolving questions. */
export const MAX_BOT_PAID_SETTLES = Number(E.MAX_BOT_PAID_SETTLES ?? 10);
/** In the last hours before settle_end the cap is lifted: a player nobody settles by then loses the week's reward. */
export const SETTLE_LAST_HOURS_MS = 3 * HOUR_MS;

async function sendOp(ctx: Ctx, what: string, calls: Call[], opts: { sponsored?: boolean } = {}): Promise<boolean> {
  if (ctx.dryRun) { log(`  [dry run] would send: ${what}`); return true; }
  let r = await ctx.chain.send(calls, [ctx.operator], opts);
  if (!r.ok && opts.sponsored) {
    // The contract only sponsors what it can verify is valid; if it declines, the bot pays instead, a few per run.
    ctx.botPaid = (ctx.botPaid ?? 0) + 1;
    if (!ctx.botPaidUncapped && ctx.botPaid > MAX_BOT_PAID_SETTLES) {
      if (ctx.botPaid === MAX_BOT_PAID_SETTLES + 1) {
        ctx.problems.push(`The contract declined to pay for more than ${MAX_BOT_PAID_SETTLES} settles this run. The bot paid for ${MAX_BOT_PAID_SETTLES} and left the rest for later runs (anyone can settle any player).`);
      }
      return false;
    }
    r = await ctx.chain.send(calls, [ctx.operator], {});
  }
  if (r.ok) { if (!ctx.quiet) log(`  ✔ ${what}${r.rcUsed && r.rcUsed !== "0" ? `  (Mana ${showKoin(r.rcUsed)})` : ""}`); }
  else { log(`  ✖ ${what}: ${r.error}`); ctx.problems.push(`A transaction failed: ${what} — ${String(r.error).slice(0, 200)}`); }
  return r.ok;
}

// ═══════════════════════════════ the tick ═══════════════════════════════

export async function tick(ctx: Ctx) {
  const P = ctx.P;
  const st0 = await state(ctx);
  if (!st0.c.owner) throw new Error("The contract is not initialised yet (run deploy first).");
  if (st0.weekLen !== 7 * DAY_MS) throw new Error(`week_length (${st0.weekLen}) must be 7 days`);
  const bs: BotState = { checkedUpTo: 0, orphans: [], lastCompound: 0, warnings: [], lastProduced: 0, producedByDay: {}, producerScannedTo: 0, ...readJson(P.botState) };
  const save = () => { if (!ctx.dryRun) writeJson(P.botState, bs); };

  // Each step is protected: one failing step (a busy RPC node, say) never stops the others.
  const step = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); } catch (e) { ctx.problems.push(`${name} failed: ${(e as Error).message ?? e}`); log(`  ✖ ${name} failed: ${(e as Error).message ?? e}`); }
    save();
  };
  await step("resolving questions", () => resolvePass(ctx, bs));
  await step("posting questions", () => postPass(ctx, bs));
  await step("closing / finalizing", () => closeFinalizePass(ctx));
  await step("settling players", () => settlePass(ctx));
  await step("compounding", () => compoundPass(ctx, bs));
  await step("health check", () => healthPass(ctx, bs));
  if (!ctx.dryRun) writeIndex(P);
  ctx.checkpoint("bot: tick");
}

/** game-data/index.json: the list of day files, so the website (a static page) can find every question. */
function writeIndex(P: Paths) {
  const days = fs.existsSync(P.questions) ? fs.readdirSync(P.questions).filter((f) => f.endsWith(".json")).sort().map((f) => `questions/${f}`) : [];
  writeJson(path.join(P.dir, "index.json"), { updated: new Date().toISOString(), days });
}

// ───────────── health: is the pool producing blocks? is anything stuck or running low? ─────────────

export const ALERT_BLOCKS = Math.round(Number(E.PRODUCER_ALERT_MINUTES ?? 60) * 20); // 60 minutes = 1,200 blocks

/** Expected blocks per block-height from the last 7 full days of the pool's production. */
export function productionRate(bs: BotState, lib: number): number {
  const today = Math.floor(lib / DAY);
  let blocks = 0, days = 0;
  for (let d = today - 7; d < today; d++) if (bs.producedByDay[String(d)] !== undefined) { blocks += bs.producedByDay[String(d)]; days++; }
  return days ? blocks / (days * DAY) : 0;
}

/** How long a silence must last before it is an alarm. At least PRODUCER_ALERT_MINUTES (default 60). If the pool is
 *  small and normally goes longer than that between blocks, waiting for a silence that would happen by pure luck
 *  less than 1 time in 1,000 avoids emailing you about nothing. */
export function alertAfter(rate: number): number {
  if (rate <= 0) return Infinity;
  return Math.max(ALERT_BLOCKS, Math.ceil(Math.log(1000) / rate));
}

async function healthPass(ctx: Ctx, bs: BotState) {
  const st = await state(ctx);
  const { lib } = await ctx.chain.head();
  const C = ctx.chain.contractId;

  // 1. Block production by the pool.
  if (ctx.recentBlocks) {
    const blocks = await ctx.recentBlocks();
    for (const b of blocks) {
      if (b.h <= bs.producerScannedTo) continue;
      if (b.signer === C) {
        const d = String(Math.floor(b.h / DAY));
        bs.producedByDay[d] = (bs.producedByDay[d] ?? 0) + 1;
        if (b.h > bs.lastProduced) bs.lastProduced = b.h;
      }
      bs.producerScannedTo = b.h;
    }
    const today = Math.floor(lib / DAY);
    for (const d of Object.keys(bs.producedByDay)) if (Number(d) < today - 8) delete bs.producedByDay[d];
    const rate = productionRate(bs, lib);
    if (bs.lastProduced === 0) {
      if (!ctx.quiet) log(`  the pool has not produced a block yet (normal until the producer key is registered and the seed is in)`);
    } else {
      const gap = lib - bs.lastProduced, limit = alertAfter(rate);
      const mins = (n: number) => `${Math.round(n / 20)} min`;
      if (!ctx.quiet) log(`  pool production: last block ${bs.lastProduced} (${mins(gap)} ago); ~${(rate * DAY).toFixed(0)} blocks/day; alarm after ${isFinite(limit) ? mins(limit) : "a first full day of data"}`);
      if (gap > limit) ctx.problems.push(`The pool has produced no block for ${mins(gap)} (last block ${bs.lastProduced}). Check the project's node.`);
    }
  }

  // 2. A week that should have closed but has not. Measured from its normal close (week end + close_delay) as well as
  //    from the close time that corrections move, so a week held open by repeated corrections is reported too.
  const w = st.weeksClosed;
  const wk = (await ctx.chain.read("get_week", { week: String(w) })).week ?? {};
  if (st.time > closeAt(st, w, wk) + 3 * HOUR_MS) {
    ctx.problems.push(`Week ${w} is overdue to close (${num(wk.questions) - num(wk.resolved)} question(s) still open).`);
  } else if (st.time > weekEnd(st, w) + st.closeDelay + 3 * HOUR_MS && num(wk.last_resolved_time) > weekEnd(st, w)) {
    ctx.problems.push(`Week ${w} is still open ${((st.time - weekEnd(st, w) - st.closeDelay) / HOUR_MS).toFixed(0)} h after its normal close: its latest result or correction was at ${utc(num(wk.last_resolved_time))}. Only the owner key can change results; if you did not, your admin key may be compromised.`);
  }

  // 3. Changes only the owner should ever make. If the admin key were stolen, these are the first signs; the
  //    48-hour timelock gives everyone time to react (players can always withdraw).
  //    Each one emails you once (the first run that sees it fails); later runs only mention it in the log.
  const up = st.raw.upgrade ?? {}, wd = st.raw.seed_withdrawal ?? {};
  const seen = new Set(bs.notified ?? []), still = new Set<string>();
  const ownerAlert = (key: string, text: string) => {
    still.add(key);
    if (seen.has(key)) { if (!ctx.quiet) log(`  (already emailed) ${text}`); }
    else ctx.problems.push(text);
  };
  if (num(up.eta) > 0) ownerAlert(`upgrade:${up.hash}:${up.eta}`, `A code upgrade is scheduled (possible from ${utc(num(up.eta))}). If you did not do this, your admin key may be compromised.`);
  if (num(wd.eta) > 0) ownerAlert(`seed:${wd.vhp}:${wd.koin}:${wd.eta}`, `A seed withdrawal is scheduled (possible from ${utc(num(wd.eta))}). If you did not do this, your admin key may be compromised.`);
  if (st.c.pending_owner) ownerAlert(`owner:${st.c.pending_owner}:${st.c.pending_owner_height ?? ""}`, `An ownership transfer to ${st.c.pending_owner} is pending (it can be accepted a day after it was proposed). If you did not do this, your admin key may be compromised: propose your own address again right away.`);
  // The roles and the producer key must be the ones recorded at deployment (game-data/deployment.json).
  const dep = readJson(ctx.P.deployment, null);
  if (dep?.owner && st.c.owner && st.c.owner !== dep.owner)
    ownerAlert(`owner-changed:${st.c.owner}`, `The game's owner is ${st.c.owner}, not ${dep.owner} as in deployment.json. If you did not hand it over, your admin key is compromised.`);
  if (dep?.operator && st.c.operator && st.c.operator !== dep.operator)
    ownerAlert(`operator-changed:${st.c.operator}`, `The game's operator is ${st.c.operator}, not ${dep.operator} as in deployment.json. If you did not change it, your admin key may be compromised (if you did, update deployment.json).`);
  // Owner-only settings: compared with deployment.json where it records them, and with the last run.
  const settings = { min_stake: String(st.c.min_stake ?? "0"), min_stake_next: String(st.c.min_stake_next ?? "0"), min_stake_next_week: String(st.c.min_stake_next_week ?? "0"),
    max_sponsor_rc: String(st.c.max_sponsor_rc ?? "0"), min_sponsor_rc: String(st.c.min_sponsor_rc ?? "0"), paused: !!st.c.paused };
  const fp = JSON.stringify(settings), odd: string[] = [];
  if (dep?.minStake !== undefined && settings.min_stake !== String(dep.minStake)) odd.push(`min_stake is ${showKoin(settings.min_stake)} VHP (deployment.json: ${showKoin(dep.minStake)})`);
  if (big(settings.min_stake_next) > 0n && big(settings.min_stake_next) !== big(settings.min_stake)) odd.push(`min_stake changes to ${showKoin(settings.min_stake_next)} VHP from week ${num(settings.min_stake_next_week) + 1}`);
  if (dep?.maxSponsorRc !== undefined && settings.max_sponsor_rc !== String(dep.maxSponsorRc)) odd.push(`free transactions are capped at ${showKoin(settings.max_sponsor_rc)} Mana (deployment.json: ${showKoin(dep.maxSponsorRc)})`);
  if (settings.paused) odd.push("the game is paused");
  if (bs.settings && bs.settings !== fp) odd.push("the owner settings changed since the last run");
  bs.settings = fp;
  if (odd.length) ownerAlert(`settings:${fp}`, `Owner settings: ${odd.join("; ")}. If you did not do this, your admin key may be compromised (if you did, update deployment.json).`);
  if (ctx.producerKey) {
    const k = await ctx.producerKey(C);
    const expected = dep?.producerKey ?? bs.producerKey;
    if (!expected) {
      if (k) {
        bs.producerKey = k;
        ownerAlert(`key-noted:${k}`, `game-data/deployment.json has no "producerKey". The key registered for the game is ${k}: if it is yours, add it to deployment.json (until then the bot keeps it only in bot-state.json).`);
      }
    }
    else if (k !== expected) ownerAlert(`key-changed:${k}`, `The block-producer key registered for the game is ${k || "none"}, not ${expected}. If you did not register it, your admin key may be compromised (if you did, set "producerKey" in deployment.json).`);
  }
  if (ctx.desk) await deskHealth(ctx, bs, ownerAlert);
  bs.notified = [...still];
  if (st.c.operator && st.c.operator !== ctx.operator.getAddress() && ctx.chain.kind === "koinos" && E.OPERATOR_WIF)
    ctx.problems.push(`The contract's operator is ${st.c.operator}, not this bot (${ctx.operator.getAddress()}).`);

  // 4. Mana running low (real chain only).
  if (ctx.chain.kind === "koinos") {
    const opMana = await ctx.chain.mana(ctx.operator.getAddress());
    if (opMana < toSat(2)) ctx.problems.push(`The bot's wallet ${ctx.operator.getAddress()} is low on Mana (${showKoin(opMana)}). Send it some KOIN.`);
    const cMana = big(st.raw.mana);
    const verdict = contractManaVerdict(cMana, big(st.t.seed_koin), st.height, bs.lastCompound);
    if (verdict === "after-compound") {
      // compound burns the contract's own Mana; it refills by itself, so this is expected and does not fail the run.
      const text = `The contract's Mana is low (${showKoin(cMana)}) because the bot compounded at block ${bs.lastCompound}. Expected; it refills on its own.`;
      log(`  note: ${text}`);
      if (process.env.GITHUB_ACTIONS) console.log(`::warning title=Contract Mana::${text}`);
    } else if (verdict === "low") ctx.problems.push(`The contract is low on Mana (${showKoin(cMana)}) and no recent compound explains it: free transactions may be refused for a while.`);
  }
}

/** The Desk Swap: owner and treasury as deployed, no surprise announcements, the same producer key. */
async function deskHealth(ctx: Ctx, bs: BotState, alert: (key: string, text: string) => void) {
  const d = ctx.desk!;
  const s = await d.read("get_state");
  const c = s.config ?? {};
  const dep = d.deployment ?? {};
  if (dep.owner && c.owner !== dep.owner) alert(`desk-owner:${c.owner}`, `The Desk's owner is ${c.owner}, not ${dep.owner} as in desk-data/deployment.json. If you did not change it, your admin key is compromised.`);
  if (dep.treasury && c.treasury !== dep.treasury) alert(`desk-treasury-now:${c.treasury}`, `The Desk's treasury is ${c.treasury}, not ${dep.treasury} as in desk-data/deployment.json. If you did not change it, your admin key is compromised (if you did, update desk-data/deployment.json).`);
  const up = s.upgrade ?? {}, tc = s.treasury_change ?? {};
  if (num(up.eta) > 0) alert(`desk-upgrade:${up.hash}:${up.eta}`, `A Desk code upgrade is scheduled (possible from ${utc(num(up.eta))}). If you did not do this, your admin key may be compromised.`);
  if (num(tc.eta) > 0) alert(`desk-treasury:${tc.address}:${tc.eta}`, `A Desk treasury change to ${tc.address} is scheduled (possible from ${utc(num(tc.eta))}). If you did not do this, your admin key may be compromised.`);
  if (c.paused && !ctx.quiet) log(`  the Desk is paused`);
  if (ctx.producerKey && ctx.chain.kind === "koinos") {
    const k = await ctx.producerKey(dep.contract);
    const expected = dep.producerKey ?? bs.deskProducerKey;
    if (!expected) {
      if (k) {
        bs.deskProducerKey = k;
        alert(`desk-key-noted:${k}`, `desk-data/deployment.json has no "producerKey". The key registered for the Desk is ${k}: if it is yours, add it to deployment.json (until then the bot keeps it only in bot-state.json).`);
      }
    }
    else if (k !== expected) alert(`desk-key:${k}`, `The block-producer key registered for the Desk is ${k || "none"}, not ${expected}. If you did not register it, your admin key may be compromised (if you did, set "producerKey" in desk-data/deployment.json).`);
  }
}

// ───────────── link on-chain question ids to local files, find orphans ─────────────

/** Walks question ids not yet checked and links each to the local question with the same params hash.
 *  An id that matches nothing local is an "orphan" (e.g. the bot crashed after posting, before saving):
 *  it gets resolved as VOID so its week can still close. */
async function scanIds(ctx: Ctx, bs: BotState) {
  const st = await state(ctx);
  if (bs.checkedUpTo >= st.nextId) return;
  const files = dayFiles(ctx.P);
  const byHash = new Map<string, { file: string; data: DayFile; q: any }>();
  for (const f of files) for (const q of f.data.questions ?? []) if (q.paramsHash) byHash.set(q.paramsHash.toLowerCase(), { ...f, q });
  for (let id = bs.checkedUpTo; id < st.nextId; id++) {
    const q = (await ctx.chain.read("get_question", { id })).question;
    const h = String(q?.params_hash ?? "").replace(/^0x/, "").toLowerCase();
    const hit = byHash.get(h);
    if (hit && (hit.q.chainId === undefined || hit.q.chainId === id)) {
      if (hit.q.chainId === undefined) {
        hit.q.chainId = id;
        if (!ctx.dryRun) writeJson(hit.file, hit.data);
        log(`  linked on-chain question #${id} to ${hit.q.id}`);
      }
    } else if (!bs.orphans.includes(id)) {
      bs.orphans.push(id);
      log(`  ⚠ on-chain question #${id} has no matching local question — it will be resolved as VOID`);
      ctx.problems.push(`On-chain question #${id} matches no question file (params_hash ${String(q?.params_hash ?? "")}). It will be voided. Unless the bot crashed right after posting it, the operator key may be compromised.`);
    }
    bs.checkedUpTo = id + 1;
  }
}

// ───────────── resolve ─────────────

async function resolvePass(ctx: Ctx, bs: BotState) {
  // Safety net: if a week is overdue to close because some question is still open, re-check every question id
  // from the start (each one is either linked to a local question by its hash, or resolved as VOID).
  const st = await state(ctx);
  const wk = (await ctx.chain.read("get_week", { week: String(st.weeksClosed) })).week ?? {};
  if (st.time > closeAt(st, st.weeksClosed, wk) + 2 * HOUR_MS && num(wk.resolved) < num(wk.questions) && bs.checkedUpTo > 0) {
    log(`  ⚠ week ${st.weeksClosed} is overdue to close with ${num(wk.questions) - num(wk.resolved)} open question(s): re-checking every question id`);
    bs.checkedUpTo = 0;
  }
  await scanIds(ctx, bs);
  const { height } = await ctx.chain.head();
  const due = (q: any) => height > num(q.window_end) + RESOLVE_MARGIN;

  // Orphans: void with a hash that says so.
  for (const id of bs.orphans) {
    const q = (await ctx.chain.read("get_question", { id })).question;
    if (!q || num(q.outcome) !== 0 || !due(q)) continue;
    const dataHash = "0x" + sha256hex(`orphan question ${id} params ${q.params_hash}`);
    await sendOp(ctx, `resolve orphan #${id} as VOID`, [{ method: "resolve_question", args: { id, outcome: 1000, data_hash: dataHash } }]);
  }

  // A failed VHP read only costs this run's reading; every other question is still resolved below.
  try { await vhpReadPass(ctx, height); }
  catch (e) { ctx.problems.push(`Reading VHP for open question windows failed: ${(e as Error).message ?? e}`); log(`  ✖ reading VHP failed: ${(e as Error).message ?? e}`); }

  // Local questions: the answer is recomputed every time from the window's blocks (read fresh from the chain on the
  // live bot), then posted. A saved result that does not match those blocks is replaced; it is never what gets posted.
  // On the simulated chain the blocks come from blocks.csv, and the generator is asked to download missing ones.
  let ranGenerator = false;
  const fresh = new Map<string, Blk[]>();
  const windowOf = async (q: any, csv: Blk[]) => {
    if (!ctx.windowBlocks) return csv;
    const k = `${q.windowStart}-${q.windowEnd}`;
    if (!fresh.has(k)) fresh.set(k, await ctx.windowBlocks(q.windowStart, q.windowEnd));
    return fresh.get(k)!;
  };
  for (let pass = 0; pass < 2; pass++) {
    let needGenerator = false;
    const csv = ctx.windowBlocks ? [] : readCsv(path.join(ctx.P.dir, "blocks.csv"));
    for (const f of dayFiles(ctx.P)) {
      let dirty = false;
      for (const q of f.data.questions ?? []) {
        if (q.chainId === undefined) continue;
        if (q.chainOutcome !== undefined) { if (q.week >= st.weeksClosed && await correctionCheck(ctx, q)) dirty = true; continue; }
        const onChain = (await ctx.chain.read("get_question", { id: q.chainId })).question;
        const resolved = num(onChain.outcome) !== 0;
        if (!resolved && !due(onChain)) continue;
        // The file must still be exactly the question that was posted: its parameters must hash to the on-chain
        // params_hash. An edited file is never used to resolve.
        const fileHash = paramsHashOf(q), chainHash = String(onChain.params_hash ?? "").replace(/^0x/, "").toLowerCase();
        if (fileHash !== chainHash) {
          ctx.problems.push(`${q.id} (#${q.chainId}): the question file no longer matches the on-chain params_hash (file ${fileHash.slice(0, 12)}…, chain ${chainHash.slice(0, 12)}…). Not resolving it from that file: restore the published version (git history).`);
          continue;
        }
        const scored = scoreQuestion(q, await windowOf(q, csv), { vhpReadings: q.vhpReadings, vhpEnd: q.vhpEnd });
        if (resolved) {
          q.chainOutcome = num(onChain.outcome);
          q.chainDataHash = String(onChain.data_hash ?? "");
          dirty = true;
          // The bot only resolves once the window's blocks are final, so an earlier result was set by someone else.
          if (!due(onChain)) {
            ctx.problems.push(`${q.id} (#${q.chainId}) got outcome ${q.chainOutcome}${q.chainOutcome === 1000 ? " (void)" : ""} on chain before its window's blocks were final; the bot did not post it. If you did not void it, your admin key may be compromised.`);
          }
          if (scored.ok) {
            const mine = storedOutcome(scored.result);
            if (!q.result || q.result.dataHash !== scored.result.dataHash || q.result.void !== scored.result.void || q.result.option !== scored.result.option) {
              q.result = scored.result;
            }
            if (mine !== q.chainOutcome) {
              log(`  ⚠ ${q.id} (#${q.chainId}): on-chain outcome ${q.chainOutcome} differs from the blocks (${mine}${scored.result.void ? ", void" : ""}).`);
              ctx.problems.push(`${q.id} (#${q.chainId}): the on-chain outcome (${q.chainOutcome}) differs from what the blocks say (${mine}${scored.result.void ? ", void" : ""}). Check it; the owner can still correct it before the week closes.`);
            }
          }
          continue;
        }
        if (!scored.ok) {
          if (q.result?.reason === "window older than stored history") { delete q.result; dirty = true; }
          if (scored.pending) {
            if (/VHP reading/.test(scored.reason)) ctx.problems.push(`${q.id} (#${q.chainId}) is ready to resolve, but ${scored.reason}.`);
            else if (ctx.windowBlocks) log(`  ${q.id}: waiting for the window's blocks to become final`);
            else if (ranGenerator) ctx.problems.push(`${q.id} (#${q.chainId}) is ready to resolve, but its blocks are still not in the history.`);
            else needGenerator = true;
          } else ctx.problems.push(`${q.id} (#${q.chainId}) was not resolved: ${scored.reason}`);
          continue;
        }
        if (!q.result || q.result.dataHash !== scored.result.dataHash || q.result.void !== scored.result.void || q.result.option !== scored.result.option || q.result.value !== scored.result.value) {
          if (q.result) log(`  ${q.id}: saved result did not match the blocks; using the recomputed answer`);
          q.result = scored.result;
          dirty = true;
        }
        if (scored.result.vhpCheck?.skipped) log(`  ${q.id}: VHP-swing check skipped (${scored.result.vhpCheck.skipped})`);
        const outcome = chainOutcome(scored.result);
        const dataHash = "0x" + scored.result.dataHash;
        const label = scored.result.void ? `VOID (${scored.result.reason})` : `option ${String.fromCharCode(65 + (scored.result.option ?? 0))} (actual ${scored.result.value})`;
        // Not marked done here: the next pass reads the outcome back from the chain, so a transaction that never
        // made it into a block is simply sent again.
        await sendOp(ctx, `resolve ${q.id} (#${q.chainId}) → ${label}`, [{ method: "resolve_question", args: { id: q.chainId, outcome, data_hash: dataHash } }]);
      }
      if (dirty && !ctx.dryRun) writeJson(f.file, f.data);
    }
    if (!needGenerator || ranGenerator) break;
    // Some finished questions have no result yet: download the blocks (the generator also refreshes the public files).
    ranGenerator = true;
    const g = ctx.generator(["resolve"]);
    if (!g.ok) { log(`  ✖ resolving from block data failed:\n${g.output.slice(-1500)}`); ctx.problems.push("Resolving questions from block data failed."); break; }
  }
}

/** A posted result changed on chain (only the owner can do that, with correct_question): record it and email. */
async function correctionCheck(ctx: Ctx, q: any): Promise<boolean> {
  const onChain = (await ctx.chain.read("get_question", { id: q.chainId })).question ?? {};
  const now = num(onChain.outcome);
  const hex = (x: any) => String(x ?? "").replace(/^0x/, "").toLowerCase();
  if (now === q.chainOutcome) {
    // Same outcome: compare the data_hash with the one recorded (or, for older files, the bot's own result).
    const known = hex(q.chainDataHash ?? q.result?.dataHash), seen = hex(onChain.data_hash);
    if (!seen || seen === known) return false;
    if (!known) { q.chainDataHash = String(onChain.data_hash); return true; }
    (q.corrections ??= []).push({ from: q.chainOutcome, to: now, dataHash: onChain.data_hash, seenAt: new Date().toISOString() });
    ctx.problems.push(`A result was re-posted on chain with the same outcome: ${q.id} (#${q.chainId}) now has data_hash ${String(onChain.data_hash).slice(0, 18)}…. Only the owner key can do that; if you did not, your admin key may be compromised.`);
    q.chainDataHash = String(onChain.data_hash);
    return true;
  }
  (q.corrections ??= []).push({ from: q.chainOutcome, to: now, dataHash: onChain.data_hash, seenAt: new Date().toISOString() });
  ctx.problems.push(`A result was changed on chain: ${q.id} (#${q.chainId}) went from outcome ${q.chainOutcome} to ${now}${now === 1000 ? " (void)" : ""}. If you did not do this, your admin key may be compromised.`);
  q.chainOutcome = now;
  q.chainDataHash = String(onChain.data_hash ?? "");
  return true;
}

/** The VHP-swing rule's readings: on every run while a posted question's window is open, read the VHP of the producers
 *  it is about (or the network's) and add the reading (height and values) to the question file. Only readings taken
 *  inside the window count; one that lands after the window's last block is dropped. */
async function vhpReadPass(ctx: Ctx, height: number) {
  const open: Array<{ f: { file: string; data: DayFile }; q: any }> = [];
  for (const f of dayFiles(ctx.P)) for (const q of f.data.questions ?? []) {
    if (q.chainId === undefined || q.chainOutcome !== undefined || !q.model?.vhp || q.model.voidVhpSwing === undefined) continue;
    if (height >= q.windowStart && height <= q.windowEnd) open.push({ f, q });
  }
  if (!open.length) return;
  if (!ctx.vhp) { ctx.problems.push(`${open.length} question(s) have an open window and need a VHP reading, but this run cannot read VHP.`); return; }
  const reading = await ctx.vhp([...new Set(open.flatMap(({ q }) => vhpSubjects(q)))]);
  const readAt = new Date().toISOString();
  const saved = new Set<{ file: string; data: DayFile }>();
  for (const { f, q } of open) {
    if (reading.height < q.windowStart || reading.height > q.windowEnd) { log(`  ${q.id}: VHP read at block ${reading.height}, outside its window; not kept`); continue; }
    const values: Record<string, string> = {};
    for (const w of vhpSubjects(q)) {
      const v = reading.values[w];
      if (v === undefined || !/^\d+$/.test(String(v))) throw new Error(`the VHP read returned no value for ${w}`);
      values[w] = String(v);
    }
    (q.vhpReadings ??= []).push({ height: reading.height, readAt, values });
    saved.add(f);
    log(`  read ${q.id}'s VHP during its window (block ${reading.height})`);
  }
  if (!ctx.dryRun) for (const f of saved) writeJson(f.file, f.data);
}

// ───────────── post today's questions ─────────────

async function postPass(ctx: Ctx, bs: BotState) {
  const st = await state(ctx);
  const { height, time } = st;
  if (time < st.genesis) { if (!ctx.quiet) log(`  the game starts ${utc(st.genesis)} — nothing to post yet`); return; }
  const d = Math.floor((time - st.genesis) / DAY_MS);
  const w = Math.floor(d / 7), dd = d % 7;
  if (dd >= QUESTION_DAYS) return; // Sunday: results day, no questions
  const dayStart = st.genesis + d * DAY_MS;
  const releaseAt = dayStart + RELEASE_HOUR * HOUR_MS, lockTime = dayStart + LOCK_HOUR * HOUR_MS;
  if (time < releaseAt) { if (!ctx.quiet) log(`  today's questions come out at ${utc(releaseAt)}`); return; }
  const label = `W${SPACE(w)}-D${dd + 1}`;
  const file = path.join(ctx.P.questions, `${label}.json`);
  const wEnd = weekEnd(st, w);
  if (st.weeksClosed > w) return; // (only possible right at a boundary)

  if (!fs.existsSync(file)) {
    if (lockTime - time < MIN_ANSWER_MS) {
      if (!ctx.dryRun) writeJson(file, { date: label, week: w, day: dd + 1, questions: [], skipped: "the bot was down: too late to release today's questions" });
      log(`  skipped ${label}: too late to release (answers close ${utc(lockTime)})`);
      return;
    }
    // The watched blocks start after answers close even if blocks ran at the fastest pace the contract allows, and
    // they end early enough for the week to close on time even at the slowest pace (the contract checks both).
    const windowStart = height + Math.ceil((lockTime - time) / MIN_BLOCK_MS) + 20;
    const maxEnd = height + Math.floor((wEnd + st.closeDelay - time) / MAX_BLOCK_MS) - RESOLVE_MARGIN - RESOLVE_SLACK;
    log(`  releasing ${label} (week ${w + 1}, day ${dd + 1}) — answers close ${utc(lockTime)}; watched blocks from ${windowStart}`);
    if (ctx.dryRun) { log(`  [dry run] would run the generator and post its questions`); return; }
    const g = ctx.generator(["release", "--label", label, "--week", String(w), "--day", String(dd),
      "--lock-height", String(windowStart - 1), "--lock-time", String(lockTime), "--max-end", String(maxEnd),
      // never ask about the pool itself or the operator's own producer(s): they could sway the answer
      "--exclude", [ctx.chain.contractId, ...(E.EXCLUDE_PRODUCERS ?? "").split(",")].map((x) => x.trim()).filter(Boolean).join(",")]);
    if (!g.ok) {
      if (/Too late/i.test(g.output)) {
        writeJson(file, { date: label, week: w, day: dd + 1, questions: [], skipped: "too late to release today's questions" });
        log(`  skipped ${label}: too late`);
      } else { log(`  ✖ the generator failed (will retry next run):\n${g.output.slice(-1500)}`); ctx.problems.push(`The question generator failed for ${label}.`); }
      return;
    }
    // Save the questions publicly BEFORE posting them, so their details can never be lost.
    ctx.checkpoint(`bot: questions for ${label}`);
  }

  const data: DayFile = readJson(file);
  if (!data.questions?.some((q: any) => q.chainId === undefined && !q.postSkipped)) return;
  await scanIds(ctx, bs); // a previous run may have posted some of these already (crash before saving)
  for (let i = 0; ; i++) {
    const cur: DayFile = readJson(file); // re-read every time: scanIds may have linked questions meanwhile
    if (i >= cur.questions.length) break;
    const q = cur.questions[i];
    if (q.chainId !== undefined || q.postSkipped) continue;
    const now = (await state(ctx)).time;
    if ((q.lockTime ?? 0) - now < MIN_ANSWER_MS) {
      q.postSkipped = `posted too late: answers would close ${utc(q.lockTime ?? 0)}`;
      log(`  skipped ${q.id}: ${q.postSkipped}`);
      writeJson(file, cur);
      continue;
    }
    const before = await state(ctx);
    const args = { k: q.options.length, lock_time: String(q.lockTime), window_start: String(q.windowStart), window_end: String(q.windowEnd), params_hash: "0x" + q.paramsHash };
    const ok = await sendOp(ctx, `post ${q.id}: ${q.title}`, [{ method: "post_question", args }]);
    if (!ok || ctx.dryRun) continue;
    const id = before.nextId;
    const onChain = (await ctx.chain.read("get_question", { id })).question;
    if (String(onChain?.params_hash ?? "").replace(/^0x/, "").toLowerCase() === q.paramsHash.toLowerCase() && bs.checkedUpTo === id) {
      q.chainId = id;
      bs.checkedUpTo = id + 1;
      writeJson(file, cur);
    } else {
      await scanIds(ctx, bs); // something else was posted in between: find ours by its hash
    }
  }
}

// ───────────── close and finalize ─────────────

async function closeFinalizePass(ctx: Ctx) {
  // Finalizing a big week takes several pages (one transaction each); the loop runs until nothing is due.
  for (let i = 0; i < 60; i++) {
    const st = await state(ctx);
    const h = st.time;
    const w = st.weeksClosed;
    const wk = (await ctx.chain.read("get_week", { week: String(w) })).week ?? {};
    if (h >= closeAt(st, w, wk) && num(wk.resolved) === num(wk.questions)) {
      if (!(await sendOp(ctx, `close week ${w}`, [{ method: "close_week", args: { week: String(w) } }])) || ctx.dryRun) return;
      continue;
    }
    if (st.weeksFinalized < st.weeksClosed) {
      const fw = (await ctx.chain.read("get_week", { week: String(st.weeksFinalized) })).week ?? {};
      if (h > num(fw.settle_end)) {
        if (!(await sendOp(ctx, `finalize week ${st.weeksFinalized}`, [{ method: "finalize_week", args: { week: String(st.weeksFinalized) } }])) || ctx.dryRun) return;
        continue;
      }
    }
    return;
  }
}

// ───────────── settle everyone who answered ─────────────

export async function allPlayers(chain: Chain, week: number) {
  const rows: any[] = [];
  let start = "";
  for (;;) {
    const page = (await chain.read("list_players", { start, limit: 50, week: String(week) })).rows ?? [];
    rows.push(...page);
    if (page.length < 50) return rows;
    start = page[page.length - 1].address;
  }
}

async function settlePass(ctx: Ctx) {
  const st = await state(ctx);
  const h = st.time;
  for (let w = st.weeksFinalized; w < st.weeksClosed; w++) {
    const wk = (await ctx.chain.read("get_week", { week: String(w) })).week ?? {};
    if (h < num(wk.settle_start) || h > num(wk.settle_end)) continue;
    // Free players (no stake that week) can never be paid, so the bot doesn't spend Mana settling them.
    const minStake = minStakeFor(st.c, w);
    const unsettled = async () => (await allPlayers(ctx.chain, w)).filter((r) => r.entry && !r.entry.settled && big(r.entry.stake) >= minStake && big(r.entry.stake) > 0n);
    // Largest stakes first, so if the bot has to stop paying, it stops at the smallest entries.
    const todo = (await unsettled()).sort((a, b) => (big(b.entry.stake) > big(a.entry.stake) ? 1 : big(b.entry.stake) < big(a.entry.stake) ? -1 : 0));
    const lastHours = num(wk.settle_end) - h <= SETTLE_LAST_HOURS_MS;
    if (todo.length) log(`  settling ${todo.length} player(s) for week ${w}${lastHours ? " (last hours before settle_end: no cap on bot-paid settles)" : ""}`);
    let n = 0;
    ctx.botPaidUncapped = lastHours;
    try {
      for (const r of todo) {
        if (await sendOp(ctx, `settle ${r.address} for week ${w}`, [{ method: "settle", args: { player: r.address, week: String(w) } }], { sponsored: true })) n++;
      }
    } finally { ctx.botPaidUncapped = false; }
    if (todo.length) log(`  settled ${n}/${todo.length}`);
    if (lastHours && todo.length && !ctx.dryRun) {
      const left = await unsettled();
      if (left.length) ctx.problems.push(`Week ${w}: ${left.length} staked player(s) are still not settled and settlement ends ${utc(num(wk.settle_end))}. Anyone can send their settle; after that time they get no reward for the week.`);
    }
  }
}

// ───────────── compound block rewards into VHP ─────────────

async function compoundPass(ctx: Ctx, bs: BotState) {
  const st = await state(ctx);
  const spare = big(st.raw.koin_balance) - big(st.t.seed_koin) - big(st.t.creator_fee);
  if (spare < COMPOUND_MIN || st.height - bs.lastCompound < DAY) return;
  if (await sendOp(ctx, `compound ${showKoin(spare)} KOIN of block rewards into VHP`, [{ method: "compound", args: {} }]) && !ctx.dryRun) bs.lastCompound = st.height;
}

// ═══════════════════════════════ status ═══════════════════════════════

export async function status(ctx: Ctx) {
  const st = await state(ctx);
  const { height, lib } = await ctx.chain.head();
  const t = st.t;
  const holdings = big(st.raw.vhp_balance) + big(st.raw.koin_balance);
  const owed = ["total_stake", "seed_vhp", "seed_koin", "owner_share", "creator_fee", "pots_outstanding"].reduce((s, k) => s + big(t[k]), 0n);
  const now = st.time;
  const w = now < st.genesis ? 0 : Math.floor((now - st.genesis) / st.weekLen);
  const inH = (ms: number) => `${((ms - now) / HOUR_MS).toFixed(1)} h`;
  log(`Contract ${ctx.chain.contractId}  (${ctx.chain.kind})   block ${height} (irreversible ${lib}), chain time ${utc(now)}`);
  log(now < st.genesis ? `Game starts ${utc(st.genesis)} (in ${inH(st.genesis)})`
    : `Week ${w + 1}: ends ${utc(weekEnd(st, w))} (in ${inH(weekEnd(st, w))}); results final ${utc(weekEnd(st, w) + st.closeDelay)}`);
  log(`Weeks closed ${st.weeksClosed}, finalized ${st.weeksFinalized}; questions posted ${st.nextId}`);
  log(`Holdings  ${showKoin(holdings)}  (VHP ${showKoin(st.raw.vhp_balance)} + KOIN ${showKoin(st.raw.koin_balance)})   contract Mana ${showKoin(st.raw.mana)}`);
  log(`Owed      ${showKoin(owed)}  = stakes ${showKoin(t.total_stake)} + seed ${showKoin(big(t.seed_vhp) + big(t.seed_koin))} + producer fee ${showKoin(t.creator_fee)} + unclaimed pots ${showKoin(t.pots_outstanding)}${big(t.owner_share) > 0n ? ` + old owner share ${showKoin(t.owner_share)}` : ""}`);
  log(`Earned since the last close (not yet split): ${showKoin(holdings - owed)}${big(t.rolled_over) > 0n ? `  (includes ${showKoin(t.rolled_over)} carried over from a week with no winners; no fee on that part)` : ""}`);
  for (let k = Math.max(0, st.weeksClosed - 2); k <= Math.min(w, st.weeksClosed); k++) {
    const r = await ctx.chain.read("get_week", { week: String(k) });
    const wk = r.week ?? {};
    log(`  week ${k + 1}: ${num(wk.questions)} questions (${num(wk.resolved)} resolved)` + (wk.closed
      ? `, gain ${showKoin(wk.gain)} → pot ${showKoin(wk.pot)}; ${num(wk.eligible_players)} eligible` + (wk.finalized ? `, cutoff ${num(wk.cutoff)} pts, ${num(wk.winners)} winner(s), claimed ${showKoin(wk.claimed)}${wk.rolled_over ? " (rolled over)" : ""}` : `, settling until ${utc(num(wk.settle_end))}`)
      : ""));
  }
  // Questions you can still answer (from the public question files).
  for (const f of dayFiles(ctx.P)) for (const q of f.data.questions ?? []) {
    if (q.chainId === undefined || !q.lockTime || q.lockTime <= now) continue;
    log(`  open question #${q.chainId} (answers close ${utc(q.lockTime)}, in ${inH(q.lockTime)}): ${q.text}`);
    for (const o of q.options) log(`      ${String.fromCharCode(65 + o.index)}) ${o.label}`);
  }
  await logLiveProduction(ctx, lib, now);
  if (ctx.chain.kind === "koinos") log(`Bot wallet ${ctx.operator.getAddress()} Mana ${showKoin(await ctx.chain.mana(ctx.operator.getAddress()))}`);
}

/** Last blocks signed by the game and the desk, from the chain. The saved bot-state.json height is not used. */
async function logLiveProduction(ctx: Ctx, lib: number, nowMs: number) {
  if (!ctx.recentSigners) {
    log("Pool production (live): this run cannot list block signers.");
    return;
  }
  const scanBlocks = Number(E.STATUS_SCAN_BLOCKS ?? 4800); // about 4 hours of 3-second blocks
  try {
    const scanned = await ctx.recentSigners(lib, scanBlocks);
    log(formatProduction("Pool production (live)", ctx.chain.contractId, scanned.blocks, scanned.from, scanned.to, nowMs));
    const desk = E.DESK_ADDRESS || readJson(path.join("desk-data", "deployment.json"), null)?.contract;
    if (desk) log(formatProduction("Desk production (live)", String(desk), scanned.blocks, scanned.from, scanned.to, nowMs));
    else log("Desk production (live): no desk address (desk-data/deployment.json or DESK_ADDRESS).");
  } catch (e) {
    log(`Pool production (live): could not read recent block signers (${(e as Error).message ?? e}).`);
  }
}

// ═══════════════════════════════ deploy ═══════════════════════════════

const WASM = "game/build/release/contract.wasm";

// Koinos mainnet system contracts (KOIN and VHP confirmed against the explorer). The game contract itself never uses
// these: on-chain it asks the chain for "koin", "vhp" and "pob" by name. The bot only needs KOIN and VHP to approve
// deposits; PoB is recorded for reference.
const MAINNET = { koin: "19GYjDBVXU7keLbYvMLazsGQn3GTWHjHkK", vhp: "12Y5vW6gk8GceH53YfRkRre2Rrcsgw7Naq", pob: "159myq5YUhhoVWu3wsHKHiJYKPKGUrGiyv" };

async function tokenAddresses(provider: Provider, mainnet: boolean): Promise<{ koin: string; vhp: string; pob: string }> {
  let koin = E.KOIN_ADDRESS ?? (mainnet ? MAINNET.koin : undefined);
  let vhp = E.VHP_ADDRESS ?? (mainnet ? MAINNET.vhp : undefined);
  const pob = E.POB_ADDRESS ?? (mainnet ? MAINNET.pob : "");
  if (!koin || !vhp) {
    // Not mainnet and not set: discover them from recent blocks (each block mints KOIN to its producer and burns VHP).
    const found = await discoverTokens(provider);
    koin = koin ?? found.koin; vhp = vhp ?? found.vhp;
    if (koin && vhp) log(`Found the tokens from recent blocks: KOIN ${koin}, VHP ${vhp}`);
  }
  if (!koin || !vhp) throw new Error("Couldn't find the KOIN and VHP addresses on this network. Set KOIN_ADDRESS and VHP_ADDRESS in .env.");
  // Sanity check against the chain: every block mints KOIN to its producer and burns VHP from it.
  try {
    const head: any = await provider.getHeadInfo();
    const h = Number(head.head_topology.height);
    const res: any = await provider.call("block_store.get_blocks_by_height", {
      head_block_id: head.head_topology.id, ancestor_start_height: String(h - 10), num_blocks: 10, return_block: false, return_receipt: true,
    });
    const sources = new Set<string>();
    for (const it of res.block_items ?? []) for (const ev of it.receipt?.events ?? []) sources.add(ev.source);
    if (sources.size && (!sources.has(koin) || !sources.has(vhp))) log(`⚠ Recent blocks don't show KOIN ${koin} / VHP ${vhp} activity — double-check these addresses.`);
  } catch { /* the check is only a hint */ }
  return { koin, vhp, pob };
}

/** Find the KOIN and VHP contracts from the last blocks' events: the block reward mints KOIN and burns VHP. */
async function discoverTokens(provider: Provider): Promise<{ koin?: string; vhp?: string }> {
  try {
    const head: any = await provider.getHeadInfo();
    const h = Number(head.head_topology.height);
    const res: any = await provider.call("block_store.get_blocks_by_height", {
      head_block_id: head.head_topology.id, ancestor_start_height: String(Math.max(1, h - 20)), num_blocks: 20, return_block: false, return_receipt: true,
    });
    const mint = new Map<string, number>(), burn = new Map<string, number>();
    for (const it of res.block_items ?? []) for (const ev of it.receipt?.events ?? []) {
      if (/mint/i.test(ev.name ?? "")) mint.set(ev.source, (mint.get(ev.source) ?? 0) + 1);
      if (/burn/i.test(ev.name ?? "")) burn.set(ev.source, (burn.get(ev.source) ?? 0) + 1);
    }
    const top = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    return { koin: top(mint), vhp: top(burn) };
  } catch { return {}; }
}

/** Next Monday 00:00 UTC (ms). */
function nextMonday(): number {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + (((8 - d.getUTCDay()) % 7) || 7));
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

async function deploy(send: boolean) {
  const rpc = E.RPC ?? "https://api.koinos.io";
  const mainnet = isMainnet(rpc);
  if (send && mainnet && E.CONFIRM_MAINNET !== "yes") throw new Error(`RPC is ${rpc} (MAINNET, real KOIN). Add CONFIRM_MAINNET=yes to .env if you really mean it.`);
  const need = (k: string) => { if (!E[k]) throw new Error(`${k} is missing from .env`); return E[k]!; };
  const contractKey = Signer.fromWif(need("CONTRACT_WIF"));
  const operator = Signer.fromWif(need("OPERATOR_WIF"));
  const addrOf = (wif?: string) => (wif ? Signer.fromWif(wif).getAddress() : undefined);
  const owner = E.OWNER_ADDRESS ?? addrOf(E.OWNER_WIF);
  if (!owner) throw new Error("OWNER_WIF (or OWNER_ADDRESS) is missing from .env — run: npm run bot -- keys");
  const seedOwner = E.SEED_OWNER_ADDRESS ?? addrOf(E.SEED_WIF) ?? owner;
  const provider = new Provider([rpc]);
  contractKey.provider = provider; operator.provider = provider;
  const P = paths(E.GEN_DIR ?? "game-data");
  const prior = readJson(P.deployment, null);
  if (prior?.contract && prior.contract !== contractKey.getAddress()) throw new Error(`${P.deployment} already records contract ${prior.contract}. Move it away to deploy a new one.`);

  if (!fs.existsSync(WASM)) throw new Error(`${WASM} not found — in the game folder run: npm run build && npm run check`);
  const wasm = fs.readFileSync(WASM);
  if (wasm.indexOf(Buffer.from("TEST LEDGER", "utf16le")) !== -1) throw new Error("This is the TEST build (simulated token ledger). Run `npm run build` in the game folder.");
  const abi = loadAbi();
  const tokens = await tokenAddresses(provider, mainnet);
  const C = contractKey.getAddress();
  const koinC = new Contract({ id: tokens.koin, abi: tokenAbi as any, provider });
  const vhpC = new Contract({ id: tokens.vhp, abi: tokenAbi as any, provider });
  const bal = async (c: Contract, a: string) => BigInt(((await (c.functions as any).balance_of({ owner: a })).result?.value) ?? 0);
  const [cKoin, cVhp] = [await bal(koinC, C), await bal(vhpC, C)];
  const opMana = BigInt(await provider.getAccountRc(operator.getAddress()));
  // Testnet: fast weeks so whole cycles (and upgrades) can be tested in an afternoon.
  const fast = !mainnet && E.FAST !== "no";
  const genesis = E.GENESIS_TIME ? Date.parse(E.GENESIS_TIME) : fast ? Math.ceil((Date.now() + 10 * 60_000) / 600_000) * 600_000 : nextMonday();
  if (!fast && (!isFinite(genesis) || new Date(genesis).getUTCDay() !== 1 || genesis % DAY_MS !== 0)) throw new Error("The start must be a Monday 00:00 UTC (GENESIS_TIME like 2026-10-19T00:00:00Z).");
  const n = (k: string, d: number) => String(E[k] ? Number(E[k]) : d);
  const init = {
    owner, operator: operator.getAddress(), seed_owner: seedOwner, genesis_time: String(genesis),
    // week Mon 00:00 → Mon 00:00; corrections until Mon 12:00 (close); settling until Tue 12:00 (winners final)
    week_length: String(fast ? HOUR_MS : 7 * DAY_MS), close_delay: String(fast ? 5 * 60_000 : 12 * HOUR_MS), settle_length: String(fast ? 10 * 60_000 : 24 * HOUR_MS),
    timelock_length: String(fast ? 10 * 60_000 : 48 * HOUR_MS), min_stake: n("MIN_STAKE", 100_000_000), max_sponsor_rc: n("MAX_SPONSOR_RC", 200_000_000),
  };
  const hash = sha256hex(wasm);
  log(`Network            ${rpc}${mainnet ? "   ⚠ MAINNET" : ""}`);
  log(`Contract address   ${C}   (holds ${showKoin(cKoin)} KOIN, ${showKoin(cVhp)} VHP — must be 0 before setup)`);
  log(`Code               ${WASM}, ${(wasm.length / 1024).toFixed(1)} KB, sha256 ${hash}`);
  // Upload cost from the chain's current resource prices (stored bytes + transaction bytes + a compute allowance).
  const abiText = JSON.stringify(abi);
  const bytes = wasm.length + abiText.length;
  let estimate = toSat(Math.ceil(bytes / 1024 * 0.8 + 10));
  try {
    const d: any = (await provider.call("chain.get_resource_limits", {}) as any)?.resource_limit_data ?? {};
    const disk = BigInt(d.disk_storage_cost ?? 0) * BigInt(bytes + 2_000);
    const net = BigInt(d.network_bandwidth_cost ?? 0) * BigInt(Math.ceil(bytes * 1.4) + 4_000);
    const comp = BigInt(d.compute_bandwidth_cost ?? 0) * 8_000_000n;
    if (disk + net + comp > 0n) estimate = disk + net + comp;
  } catch {}
  log(`Pays the Mana      bot wallet ${operator.getAddress()} (has ${showKoin(opMana)} Mana; the upload needs about ${showKoin(estimate)}, plus ~2 for setup)`);
  log(`Owner              ${owner}`);
  log(`Seed owner         ${seedOwner}`);
  log(`Week 1 starts      ${utc(genesis)} (a Monday). Every week: Monday 00:00 → next Monday 00:00 UTC`);
  log(`Daily questions    Monday–Saturday: out at ${RELEASE_HOUR}:00 UTC, answers close at 00:00 UTC (12 hours). Sunday: results day`);
  log(`After each week    corrections until Monday 12:00 UTC, then winners are final Tuesday 12:00 UTC; code/seed timelock 48 h`);
  log(`Settings           min stake ${showKoin(init.min_stake)} VHP, sponsored tx limit ${showKoin(init.max_sponsor_rc)} Mana`);
  log(`Tokens             KOIN ${tokens.koin}  VHP ${tokens.vhp}  PoB ${tokens.pob}`);
  if (cKoin > 0n || cVhp > 0n) throw new Error("The contract address already holds tokens; they would count as the first week's earnings. Use a fresh CONTRACT_WIF.");
  if (!prior?.uploaded && opMana < (estimate * 13n) / 10n + toSat(2)) throw new Error(`The bot wallet needs about ${showKoin((estimate * 13n) / 10n + toSat(2))} Mana for the upload (with a 30% margin) but has ${showKoin(opMana)}. Send it more KOIN (Mana refills as KOIN sits there), then try again.`);
  if (!send) { log(`\nDry run only. Nothing was sent. Run again with --send to deploy.`); return; }

  const chain = new KoinosChain(rpc, C);
  const st: any = { network: mainnet ? "mainnet" : "testnet", rpc, contract: C, owner, operator: operator.getAddress(), seedOwner, ...tokens, wasmSha256: hash, ...prior };
  // If an earlier run's upload went through but the confirmation timed out, the code is already there: don't upload twice.
  if (!st.uploaded) { try { await chain.read("get_state", {}); st.uploaded = true; log("\n1/2 The contract code is already on chain."); } catch { /* not uploaded yet */ } }
  if (!st.uploaded) {
    log("\n1/2 Uploading the contract (the operator pays the Mana, the contract key authorizes) ...");
    const c = new Contract({ id: C, abi, provider, signer: contractKey, bytecode: new Uint8Array(wasm) });
    const { operation } = await c.deploy({ abi: abiText, authorizesCallContract: true, authorizesTransactionApplication: true, authorizesUploadContract: true, onlyOperation: true } as any);
    const tx = new (await import("koilib")).Transaction({ signer: operator, provider, options: { payer: operator.getAddress(), payee: operator.getAddress(), rcLimit: (((estimate * 13n) / 10n) < (opMana * 95n) / 100n ? (estimate * 13n) / 10n : (opMana * 95n) / 100n).toString() } });
    await tx.pushOperation(operation);
    await tx.prepare();
    let t: any = tx.transaction;
    t = await operator.signTransaction(t);
    t = await contractKey.signTransaction(t);
    const { receipt, transaction } = await provider.sendTransaction(t);
    if ((receipt as any)?.reverted) throw new Error(`upload reverted: ${JSON.stringify((receipt as any).logs)}`);
    await transaction.wait("byBlock", 300_000).catch(() => { throw new Error("The upload was sent but not confirmed within 5 minutes. Wait a few minutes and run the same deploy --send command again: it will see the code and continue."); });
    log(`    uploaded — Mana used ${showKoin((receipt as any).rc_used)}`);
    st.uploaded = true; st.uploadTx = t.id;
    writeJson(P.deployment, st);
  }
  const s0 = await chain.read("get_state", {});
  if (!s0.config?.owner) {
    log("2/2 Initialising (signed by the contract key, paid by the operator) ...");
    const r = await chain.send([{ method: "init", args: init }], [operator, contractKey]);
    if (!r.ok) throw new Error(`init failed: ${r.error}`);
    log(`    initialised — Mana used ${showKoin(r.rcUsed)}`);
  }
  const s1 = await chain.read("get_state", {});
  Object.assign(st, { genesisTime: Number(s1.config.genesis_time), genesis: utc(Number(s1.config.genesis_time)), weekLength: Number(s1.config.week_length),
    closeDelay: Number(s1.config.close_delay), settleLength: Number(s1.config.settle_length), timelockLength: Number(s1.config.timelock_length),
    minStake: s1.config.min_stake, maxSponsorRc: s1.config.max_sponsor_rc, deployedAt: new Date().toISOString() });
  writeJson(P.deployment, st);
  log(`\nDone. Saved ${P.deployment} (commit it — it is public information).`);
  log(`Next (see LAUNCH.md): commit game-data/deployment.json, add the seed (seed-vhp / seed-koin), register the node key (register-key node), turn on the bot.`);
}

// ═══════════════════════════════ upgrade (code fix after the 48-hour notice) ═══════════════════════════════
// The contract only accepts new code that (1) was announced by its sha256 with schedule_upgrade, (2) is uploaded after
// the 48-hour timelock, (3) is signed by the owner, and (4) keeps the contract in charge of its own account. All data
// (stakes, weeks, the seed) stays. Steps:
//   upgrade status            what is announced, and whether the local build matches it
//   upgrade schedule          announce the local build (game/build/release/contract.wasm); the 48 hours start
//   upgrade apply             after the 48 hours: upload exactly that build, then clear the notice
//   upgrade cancel            withdraw the announcement
async function upgrade(sub: string | undefined, send: boolean) {
  const P = paths(E.GEN_DIR ?? "game-data");
  const dep = readJson(P.deployment, null);
  if (!dep?.contract) throw new Error(`${P.deployment} not found — deploy first.`);
  const rpc = E.RPC ?? dep.rpc;
  const mainnet = isMainnet(rpc);
  if (send && mainnet && E.CONFIRM_MAINNET !== "yes") throw new Error("MAINNET: add CONFIRM_MAINNET=yes to .env first.");
  if (!fs.existsSync(WASM)) throw new Error(`${WASM} not found — in the game folder run: npm test && npm run check`);
  const wasm = fs.readFileSync(WASM);
  if (wasm.indexOf(Buffer.from("TEST LEDGER", "utf16le")) !== -1) throw new Error("This is the TEST build (simulated token ledger). Run `npm run build` in the game folder.");
  const local = "0x" + sha256hex(wasm);
  const chain = new KoinosChain(rpc, dep.contract);
  const st = await chain.read("get_state", {});
  const up = st.upgrade ?? {};
  const announced = up.hash ? String(up.hash).toLowerCase() : "";
  const eta = Number(up.eta ?? 0);
  const now = Number(st.time ?? Date.now());
  log(`Contract           ${dep.contract} on ${rpc}${mainnet ? "  ⚠ MAINNET" : ""}`);
  log(`Local build        ${WASM}, ${(wasm.length / 1024).toFixed(1)} KB, sha256 ${local}`);
  log(eta > 0 ? `Announced          sha256 ${announced}, can be uploaded from ${utc(eta)}${now >= eta ? " (now)" : ` (in ${((eta - now) / HOUR_MS).toFixed(1)} h)`}` : "Announced          nothing");
  if (eta > 0) log(announced === local ? "                   ✔ matches the local build" : "                   ✖ does NOT match the local build");

  if (!sub || sub === "status") return;
  if (sub === "schedule") {
    if (eta > 0 && announced === local) { log("\nThis build is already announced."); return; }
    log(`\nThis announces the local build. Players see it on chain (and the bot emails you): they have 48 hours to withdraw if they disagree.`);
    return act("owner", "schedule_upgrade", { hash: local }, send);
  }
  if (sub === "cancel") return act("owner", "cancel_upgrade", {}, send);
  if (sub !== "apply") throw new Error("upgrade status | schedule | apply | cancel");

  if (eta === 0) throw new Error("Nothing is announced. Run: npm run bot -- upgrade schedule --send   (then wait 48 hours)");
  if (announced !== local) throw new Error("The announced code is not this build. Rebuild the exact announced version, or cancel and schedule this one.");
  if (now < eta) throw new Error(`Too early: the upload is accepted from ${utc(eta)}.`);
  if (!E.OWNER_WIF || !E.OPERATOR_WIF) throw new Error("OWNER_WIF and OPERATOR_WIF are needed in .env (owner authorizes, the bot wallet pays the Mana).");
  const provider = new Provider([rpc]);
  const owner = Signer.fromWif(E.OWNER_WIF), operator = Signer.fromWif(E.OPERATOR_WIF);
  owner.provider = provider; operator.provider = provider;
  if (owner.getAddress() !== st.config?.owner) throw new Error(`OWNER_WIF is ${owner.getAddress()}, but the contract's owner is ${st.config?.owner}.`);
  const abiText = JSON.stringify(loadAbi());
  const opMana = BigInt(await provider.getAccountRc(operator.getAddress()));
  const rcLimit = (opMana * 95n) / 100n;
  log(`Pays the Mana      bot wallet ${operator.getAddress()} (has ${showKoin(opMana)} Mana; an upload needs about 60)`);
  if (opMana < toSat(60)) throw new Error("The bot wallet needs about 60 Mana for the upload. Send it more KOIN and let the Mana refill.");
  if (!send) { log("\nDry run only — nothing was sent. Add --send to upload."); return; }
  log("\n1/2 Uploading the announced code (owner authorizes, bot wallet pays) ...");
  const c = new Contract({ id: dep.contract, abi: loadAbi(), provider, signer: owner, bytecode: new Uint8Array(wasm) });
  // The three switches must stay on: the contract refuses any upload that turns one off.
  const { operation } = await c.deploy({ abi: abiText, authorizesCallContract: true, authorizesTransactionApplication: true, authorizesUploadContract: true, onlyOperation: true } as any);
  const tx = new (await import("koilib")).Transaction({ signer: operator, provider, options: { payer: operator.getAddress(), payee: operator.getAddress(), rcLimit: rcLimit.toString() } });
  await tx.pushOperation(operation);
  await tx.prepare();
  let t: any = tx.transaction;
  t = await operator.signTransaction(t);
  t = await owner.signTransaction(t);
  const { receipt, transaction } = await provider.sendTransaction(t);
  if ((receipt as any)?.reverted) throw new Error(`upload reverted: ${JSON.stringify((receipt as any).logs)}`);
  await transaction.wait("byBlock", 300_000).catch(() => { throw new Error("Sent but not confirmed within 5 minutes. Check `npm run bot -- upgrade status` before trying again."); });
  log(`    uploaded — Mana used ${showKoin((receipt as any).rc_used)}`);
  log("2/2 Clearing the notice ...");
  await act("owner", "cancel_upgrade", {}, true);
  dep.wasmSha256 = local.slice(2);
  dep.upgradedAt = new Date().toISOString();
  writeJson(P.deployment, dep);
  log(`\nDone. Commit ${P.deployment}. Check everything with: npm run bot -- status`);
}

// ═══════════════════════════════ actions with your own keys (owner / seed / player) ═══════════════════════════════

/** Whole-token amount ("1000", "0.5") → the chain's 8-decimal units, exactly (no floating point). */
export function units(amount: string): string {
  const m = String(amount).trim().match(/^(\d+)(?:\.(\d{0,8}))?$/);
  if (!m) throw new Error(`"${amount}" is not an amount (examples: 1000 or 0.5)`);
  return (BigInt(m[1]) * 100_000_000n + BigInt((m[2] ?? "").padEnd(8, "0"))).toString();
}

/** Deposits are whole numbers only (1, 2, 3 …), as the contract requires. (Withdrawals may be any amount.) */
export function whole(amount: string): string {
  if (!/^\d+$/.test(String(amount).trim())) throw new Error(`Stakes are whole numbers only (like 1 or 25), not "${amount}".`);
  return units(amount);
}

/** A producer public key in any common text form (base64, base64url or hex) → the base64url the ABI expects. */
export function normalizeKey(k: string): string {
  const t = k.trim();
  let bytes: Buffer;
  if (/^(0x)?[0-9a-fA-F]{66}$/.test(t)) bytes = Buffer.from(t.replace(/^0x/, ""), "hex");
  else bytes = Buffer.from(t.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (bytes.length !== 33 || (bytes[0] !== 2 && bytes[0] !== 3)) throw new Error("That does not look like a producer PUBLIC key (33-byte compressed key). Never paste a private key.");
  return bytes.toString("base64url");
}

const ROLES: Record<string, { key: string; fallback?: string }> = {
  owner: { key: "OWNER_WIF" }, seed: { key: "SEED_WIF", fallback: "OWNER_WIF" }, operator: { key: "OPERATOR_WIF" }, player: { key: "PLAYER_WIF" },
};

async function act(role: string, method: string, args: any, send: boolean) {
  const P = paths(E.GEN_DIR ?? "game-data");
  const dep = readJson(P.deployment, null);
  if (!dep?.contract) throw new Error(`${P.deployment} not found — deploy first.`);
  const rpc = E.RPC ?? dep.rpc;
  if (send && isMainnet(rpc) && E.CONFIRM_MAINNET !== "yes") throw new Error("MAINNET: add CONFIRM_MAINNET=yes to .env first.");
  const r0 = ROLES[role];
  if (!r0) throw new Error(`--as must be one of ${Object.keys(ROLES).join(", ")}`);
  const wif = E[r0.key] ?? (r0.fallback ? E[r0.fallback] : undefined);
  if (!wif) throw new Error(`${r0.key} is missing from .env`);
  const signer = Signer.fromWif(wif);
  const chain = new KoinosChain(rpc, dep.contract);
  signer.provider = chain.provider;
  const abi = loadAbi();
  if (!abi.methods[method] || abi.methods[method].read_only) throw new Error(`unknown or read-only method ${method}`);
  const calls: Call[] = [];
  // Deposits pull tokens with transfer(from → contract), which the token only allows after an approve in the same transaction.
  const pull: Record<string, [string, string]> = { seed_deposit_vhp: [dep.vhp, "VHP"], seed_deposit_koin: [dep.koin, "KOIN"], deposit_vhp: [dep.vhp, "VHP"], deposit_koin: [dep.koin, "KOIN"] };
  if (pull[method]) calls.push({ contract: pull[method][0], abi: tokenAbi, method: "approve", args: { owner: signer.getAddress(), spender: dep.contract, value: String(args.amount) } });
  calls.push({ method, args });
  log(`As ${role} (${signer.getAddress()}) on ${rpc}:`);
  for (const c of calls) log(`  ${c.contract ? `${pull[method][1]}.` : ""}${c.method} ${JSON.stringify(c.args)}`);
  if (method === "seed_deposit_koin" || method === "deposit_koin") log(`  note: moving KOIN needs this wallet's Mana ≥ the amount (${showKoin(args.amount)}); the Mana moves with it.`);
  if (!send) { log("\nDry run only — nothing was sent. Add --send to send it."); return; }
  const r = await chain.send(calls, [signer], { rcLimitKoin: 5 });
  log(r.ok ? `✔ done (Mana used ${showKoin(r.rcUsed)})  transaction ${r.txId}` : `✖ ${r.error}`);
  if (!r.ok) process.exitCode = 1;
}

/** Friendly commands (amounts in whole KOIN / VHP). Each is a dry run unless --send is added. */
async function friendly(cmd: string, a: string[], send: boolean): Promise<boolean> {
  const me = (role: string) => {
    const r0 = ROLES[role];
    const wif = E[r0.key] ?? (r0.fallback ? E[r0.fallback] : undefined);
    if (!wif) throw new Error(`${r0.key} is missing from .env`);
    return Signer.fromWif(wif).getAddress();
  };
  const need = (i: number, what: string) => { if (a[i] === undefined || a[i].startsWith("--")) throw new Error(`missing ${what}`); return a[i]; };
  switch (cmd) {
    case "register-key": {
      const k = need(0, "the node's PUBLIC key (or: node)");
      const pub = k === "node" || fs.existsSync(k) ? nodePublicKey(k === "node" ? undefined : k) : normalizeKey(k);
      await act("owner", "register_key", { public_key: pub }, send); return true;
    }
    case "node-key": {
      if (a[0] === "personal") {
        const pub = nodePublicKey(PERSONAL_KEY_FILE);
        log(`Your PERSONAL node's PUBLIC key (safe to share):\n  ${pub}\n\nRegister it for your own address on https://bawcejawn.github.io/Knode/site/producer.html (signed in Kondor).\nDo NOT register this one for the game contract.`);
        return true;
      }
      const pub = nodePublicKey(a[0] && !a[0].startsWith("--") ? a[0] : undefined);
      log(`The project node's PUBLIC key (safe to share):\n  ${pub}\n\nRegister it for the game contract with:\n  npm run bot -- register-key node          (dry run)\n  npm run bot -- register-key node --send`);
      return true;
    }
    case "node-status": await nodeStatus(a[0] === "personal"); return true;
    case "seed-vhp": await act("seed", "seed_deposit_vhp", { amount: units(need(0, "amount")) }, send); return true;
    case "seed-koin": await act("seed", "seed_deposit_koin", { amount: units(need(0, "amount")) }, send); return true;
    case "seed-withdraw": {
      // seed-withdraw <VHP> [KOIN]   announce taking the seed back (48-hour timelock starts; the bot will email you)
      // seed-withdraw execute        after the 48 hours: send it to the seed owner (run again if KOIN is capped by Mana)
      if (a[0] === "execute") { await act("seed", "execute_seed_withdrawal", {}, send); return true; }
      const vhp = units(need(0, "VHP amount (or: execute)")), koin = units(a[1] && !a[1].startsWith("--") ? a[1] : "0");
      log("This starts the 48-hour timelock. Players can see it on chain, and the bot will email you about it (expected).");
      log("After 48 hours run:  npm run bot -- seed-withdraw execute --send");
      await act("seed", "request_seed_withdrawal", { vhp, koin }, send); return true;
    }
    case "deposit": await act("player", "deposit_vhp", { from: me("player"), amount: whole(need(0, "amount")) }, send); return true;
    case "deposit-koin": await act("player", "deposit_koin", { from: me("player"), amount: whole(need(0, "amount")) }, send); return true;
    case "withdraw": {
      // Any amount down to the last unit (0.12345678), or "all" for everything (active stake + any pending top-up).
      const amt = need(0, "amount (or: all)");
      let amount: string;
      if (amt.toLowerCase() === "all") {
        const dep = readJson(paths(E.GEN_DIR ?? "game-data").deployment, null);
        if (!dep?.contract) throw new Error("game-data/deployment.json not found — deploy first.");
        const pl = (await new KoinosChain(E.RPC ?? dep.rpc, dep.contract).read("get_player", { player: me("player"), week: "0" })).player ?? {};
        amount = (BigInt(pl.stake ?? 0) + BigInt(pl.pending ?? 0)).toString();
        if (amount === "0") throw new Error("This wallet has nothing staked in the game.");
        log(`Withdrawing everything: ${showKoin(amount)} VHP`);
      } else amount = units(amt);
      await act("player", "withdraw", { to: me("player"), amount }, send); return true;
    }
    case "answer": {
      const letter = need(1, "the option letter (A, B, C …)").toUpperCase();
      await act("player", "answer", { player: me("player"), question_id: Number(need(0, "question number")), option: letter.charCodeAt(0) - 65 }, send); return true;
    }
    case "claim": await act("player", "claim", { player: me("player"), week: need(0, "week number") }, send); return true;
    case "claim-fee": await act("owner", "claim_creator_fee", { to: a[0] && !a[0].startsWith("--") ? a[0] : me("owner") }, send); return true;
    case "void": await act("owner", "correct_question", { id: Number(need(0, "question number")), outcome: 1000, data_hash: "0x" + sha256hex(`voided by the owner: ${a.slice(1).filter((x) => !x.startsWith("--")).join(" ") || "no reason given"}`) }, send); return true;
    case "sponsor-limit": await act("owner", "set_sponsor_limit", { max_sponsor_rc: units(need(0, "KOIN of Mana (0 = off)")), min_sponsor_rc: units(a[1] && !a[1].startsWith("--") ? a[1] : "0") }, send); return true;
    case "min-stake": await act("owner", "set_min_stake", { min_stake: whole(need(0, "VHP (whole number, at least 1)")) }, send); return true;
    case "pause": await act("owner", "set_paused", { paused: need(0, "on or off") === "on" }, send); return true;
  }
  return false;
}

// ═══════════════════════════════ the project's node ═══════════════════════════════

const NODE_KEY_FILE = "C:\\kpred-node\\basedir\\block_producer\\private.key";
const PERSONAL_KEY_FILE = "C:\\koinos-personal\\basedir\\block_producer\\private.key";

/** Reads the node's block-producer key file on this PC and returns only its PUBLIC key (base64url). The private
 *  key never leaves this function and is never printed. */
export function nodePublicKey(file = E.NODE_KEY_FILE ?? NODE_KEY_FILE): string {
  if (!fs.existsSync(file)) throw new Error(`No key file at ${file}. Is the project node set up and started? (node/setup-node.ps1)`);
  const raw = fs.readFileSync(file, "utf8").trim();
  let signer: Signer;
  if (/^[5KL][1-9A-HJ-NP-Za-km-z]{50,51}$/.test(raw)) signer = Signer.fromWif(raw);
  else if (/^(0x)?[0-9a-fA-F]{64}$/.test(raw)) signer = new Signer({ privateKey: raw.replace(/^0x/, "") });
  else throw new Error(`${file} is not in a key format this tool knows. Tell Claude (do NOT paste the file's contents).`);
  const pk: any = (signer as any).publicKey;
  const bytes: Uint8Array = typeof pk === "string" ? Buffer.from(pk.replace(/^0x/, ""), "hex") : pk;
  return Buffer.from(bytes).toString("base64url");
}

/** Is the project's node running and caught up with the chain? */
async function nodeStatus(personal = false) {
  if (TESTNET) {
    // No public testnet node to compare with: a node is caught up when its newest block is only seconds old.
    const local = new Provider([E.NODE_RPC!]);
    let head: any;
    try { head = await local.getHeadInfo(); }
    catch { log(`The testnet node doesn't answer on ${E.NODE_RPC}. In C:\\kpred-testnet\\koinos run: docker compose up -d`); process.exitCode = 1; return; }
    const ageMin = (Date.now() - Number(head.head_block_time)) / 60_000;
    log(`Testnet node at block ${Number(head.head_topology.height).toLocaleString()}, newest block from ${utc(Number(head.head_block_time))}`);
    log(ageMin < 2 ? "✔ The testnet node is caught up." : `… still syncing: about ${ageMin < 120 ? `${ageMin.toFixed(0)} minutes` : `${(ageMin / 60 / 24).toFixed(1)} days`} of testnet chain to go.`);
    return;
  }
  const localRpc = personal ? "http://127.0.0.1:8090" : (E.NODE_RPC ?? "http://127.0.0.1:8080");
  const local = new Provider([localRpc]);
  const pub = new Provider([E.RPC ?? "https://api.koinos.io"]);
  const p: any = await pub.getHeadInfo();
  const ph = Number(p.head_topology.height);
  let lh = 0;
  try { lh = Number(((await local.getHeadInfo()) as any).head_topology.height); }
  catch { log(personal ? "Your personal node doesn't answer on 127.0.0.1:8090. Is Docker running? In C:\\koinos-personal\\koinos run: docker compose up -d" : "The project node doesn't answer on 127.0.0.1:8080. Is Docker running? In C:\\kpred-node\\koinos run: docker compose up -d"); process.exitCode = 1; return; }
  const behind = ph - lh;
  log(`Network block ${ph.toLocaleString()} — your node ${lh.toLocaleString()}`);
  if (behind <= 20) log("✔ Your node is caught up. The block producer can produce.");
  else log(`… your node is ${behind.toLocaleString()} blocks behind (~${(behind * 3 / 3600).toFixed(1)} h of chain). It catches up much faster than real time; check again later.`);
}

// ═══════════════════════════════ keys ═══════════════════════════════

/** Creates the keys this project needs in the root .env (never prints a private key). Every key is new: no wallet is
 *  shared with the probes (their keys sat in probes/.env, next to code that installed unpinned packages). */
function keys() {
  const file = path.resolve(TESTNET ? ".env.testnet" : ".env");
  let text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const has = (k: string) => new RegExp(`^${k}=`, "m").test(text);
  const add = (k: string, v: string) => { text = (text.trim() ? text.replace(/\s*$/, "\n") : "") + `${k}=${v}\n`; E[k] = v; };
  const added: string[] = [];
  if (!TESTNET && !has("RPC")) add("RPC", "https://api.koinos.io");
  if (!TESTNET && !has("CONFIRM_MAINNET")) add("CONFIRM_MAINNET", "yes");
  for (const k of ["OPERATOR_WIF", "PLAYER_WIF", "CONTRACT_WIF", "OWNER_WIF"]) {
    if (has(k)) continue;
    add(k, Signer.fromSeed(crypto.randomBytes(32).toString("hex")).getPrivateKey("wif"));
    added.push(`${k} (new)`);
  }
  fs.writeFileSync(file, text);
  try { fs.chmodSync(file, 0o600); } catch {}
  const addr = (k: string) => Signer.fromWif(E[k] ?? text.match(new RegExp(`^${k}=(.*)$`, "m"))![1].trim()).getAddress();
  log(added.length ? `Added to ${file}:\n  ${added.join("\n  ")}` : `All keys already exist in ${file}.`);
  log(`
  Role                      Address                                 What it does
  contract (CONTRACT_WIF)   ${addr("CONTRACT_WIF")}      the game itself. Must stay EMPTY until deploy. Used once.
  admin    (OWNER_WIF)      ${addr("OWNER_WIF")}      owner + seed owner: fees, corrections, node key, the seed
  bot      (OPERATOR_WIF)   ${addr("OPERATOR_WIF")}      posts/resolves questions; pays its own Mana (needs KOIN)
  player   (PLAYER_WIF)     ${addr("PLAYER_WIF")}      test player for the soft launch

The private keys are ONLY in: ${file}
  • Back up OWNER_WIF and CONTRACT_WIF offline (write them on paper or a password manager). Lose OWNER_WIF and nobody
    can claim the producer fee, correct a question or upgrade the code.
  • Never paste a private key in a chat, email or GitHub. Only OPERATOR_WIF ever goes into GitHub (as a secret).
  • Open the file with:  notepad ${TESTNET ? ".env.testnet" : ".env"}${TESTNET ? `

TESTNET: get free test KOIN for each wallet in the Koinos Discord (#faucet):  !faucet <address>
  At least the bot, admin and player wallets. Never send real KOIN to these addresses.` : ""}`);
}
// ═══════════════════════════════ wiring ═══════════════════════════════

const require = createRequire(import.meta.url);
export function generatorRunner(dir: string, extra: string[] = []) {
  return (args: string[]) => {
    const r = spawnSync(process.execPath, [require.resolve("tsx/cli"), "generator.ts", ...args, ...extra], {
      env: { ...process.env, GEN_DIR: dir }, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    });
    return { ok: r.status === 0, output: (r.stdout ?? "") + (r.stderr ?? "") };
  };
}

/** In the scheduled GitHub run (BOT_GIT_PUSH=1), commit game-data/ locally at each checkpoint. The bot itself holds
 *  no push token: the workflow's separate publish job pushes game-data/ (and nothing else) when the run ends, even
 *  if the run failed, so nothing posted is lost. */
function gitCheckpoint(dir: string) {
  return (message: string) => {
    if (E.BOT_GIT_PUSH !== "1") return;
    try {
      execSync(`git add ${dir}`, { stdio: "ignore" });
      if (!execSync("git status --porcelain " + dir, { encoding: "utf8" }).trim()) return;
      execSync(`git -c user.name="kpred-bot" -c user.email="kpred-bot@users.noreply.github.com" commit -q -m "${message}"`, { stdio: "ignore" });
    } catch (e) {
      log(`  ⚠ could not commit ${dir}: ${(e as Error).message}`);
    }
  };
}

function liveCtx(dryRun: boolean): Ctx {
  const P = paths(E.GEN_DIR ?? "game-data");
  const dep = readJson(P.deployment, null);
  const contract = E.CONTRACT_ADDRESS ?? dep?.contract;
  if (!contract) throw new Error(`No contract yet: ${P.deployment} is missing (run deploy) or set CONTRACT_ADDRESS.`);
  const rpc = E.RPC ?? dep?.rpc ?? "https://api.koinos.io";
  const chain = new KoinosChain(rpc, contract);
  const operator = E.OPERATOR_WIF ? Signer.fromWif(E.OPERATOR_WIF) : Signer.fromSeed("read-only placeholder");
  operator.provider = chain.provider;
  if (!dryRun && !E.OPERATOR_WIF) throw new Error("OPERATOR_WIF is missing (use --dry-run to look without a key).");
  const deskDep = readJson(path.join("desk-data", "deployment.json"), null);
  const deskContract = deskDep?.contract && fs.existsSync("desk/abi/desk.koilib.json")
    ? new Contract({ id: deskDep.contract, abi: JSON.parse(fs.readFileSync("desk/abi/desk.koilib.json", "utf8")), provider: chain.provider }) : null;
  const pob = new Contract({ id: dep?.pob ?? MAINNET.pob, abi: pobAbi as any, provider: chain.provider });
  return {
    chain, operator, P, dryRun, generator: generatorRunner(P.dir), checkpoint: gitCheckpoint(P.dir), problems: [],
    // Window blocks are read fresh from the chain for every resolution; the cached blocks.csv is never trusted for that.
    windowBlocks: async (from, to) => {
      const head: any = await chain.provider.getHeadInfo();
      const last = Math.min(to, Number(head.last_irreversible_block));
      return last < from ? [] : fetchRange(chain.provider, head.head_topology.id, from, last);
    },
    vhp: (who) => readVhp(chain.provider, dep?.vhp ?? MAINNET_VHP, who),
    producerKey: async (producer) => String(((await (pob.functions as any).get_public_key({ producer })).result ?? {}).value ?? ""),
    desk: deskContract ? { deployment: deskDep, read: async (method, args = {}) => ((await (deskContract.functions as any)[method](args)).result ?? {}) } : undefined,
    // The same block history the question generator uses (game-data/blocks.csv), topped up to the newest final block.
    recentBlocks: async () => (await syncBlocks(chain.provider, path.join(P.dir, "blocks.csv"), 26)).blocks,
    recentSigners: async (lib, maxBlocks) => {
      const head: any = await chain.provider.getHeadInfo();
      const headId = head.head_topology.id;
      return loadSigners(async (from, to) => {
        let last: unknown;
        for (let attempt = 1; attempt <= 4; attempt++) {
          try {
            const res: any = await chain.provider.call("block_store.get_blocks_by_height", {
              head_block_id: headId, ancestor_start_height: String(from),
              num_blocks: to - from + 1, return_block: true, return_receipt: false,
            });
            const items = res?.block_items ?? [];
            if (items.length === 0) throw new Error(`node returned no blocks at ${from}`);
            return items.map(signerFromBlockItem);
          } catch (e) {
            last = e;
            await new Promise((r) => setTimeout(r, 400 * attempt));
          }
        }
        throw last;
      }, lib, maxBlocks);
    },
  };
}

async function main() {
  const [cmd = "status", ...rest] = process.argv.slice(2);
  const flag = (f: string) => rest.includes(f);
  const opt = (f: string, d?: string) => { const i = rest.indexOf(f); return i >= 0 ? rest[i + 1] : d; };
  if (cmd === "status") return status(liveCtx(true));
  if (cmd === "tick") {
    const ctx = liveCtx(flag("--dry-run"));
    log(`tick at ${new Date().toISOString()}${ctx.dryRun ? " (dry run)" : ""}`);
    try { await tick(ctx); }
    catch (e) { ctx.problems.push(`the tick stopped early: ${(e as Error).message ?? e}`); }
    // The status summary is only a printout: a hiccup reading it (a busy RPC node) is not a reason to fail the run.
    try { await status(ctx); }
    catch (e) { log(`  (status summary skipped: ${(e as Error).message ?? e})`); }
    if (ctx.problems.length) {
      log(`\n⚠ NEEDS ATTENTION (${ctx.problems.length}):\n${ctx.problems.map((p) => "  • " + p).join("\n")}`);
      // On GitHub, also show each one on the run's summary page (and in the email), not only inside the log.
      if (process.env.GITHUB_ACTIONS) for (const p of ctx.problems) console.log(`::error title=Needs attention::${p.replace(/\r?\n/g, " ")}`);
      process.exitCode = 1; // a failed scheduled run makes GitHub email you
    }
    return;
  }
  if (cmd === "deploy") return deploy(flag("--send"));
  if (cmd === "keys") return keys();
  if (cmd === "admin") {
    // admin <method> key=value key=value … --as owner|seed|operator|player [--send]
    const args: any = {};
    for (const kv of rest.slice(1)) { const m = kv.match(/^([a-z_]+)=(.*)$/); if (m) args[m[1]] = m[2]; }
    return act(opt("--as", "owner")!, rest[0], args, flag("--send"));
  }
  if (cmd === "upgrade") return upgrade(rest[0] && !rest[0].startsWith("--") ? rest[0] : undefined, flag("--send"));
  if (await friendly(cmd, rest, flag("--send"))) return;
  if (cmd === "rehearse") { const { rehearse } = await import("./rehearse.ts"); return rehearse({ weeks: Number(opt("--weeks", "3")), verbose: flag("--verbose") }); }
  throw new Error(`Unknown command "${cmd}". See bot/README.md for the list of commands.`);
}

if (process.argv[1] && /bot\.ts$/.test(process.argv[1])) {
  main().catch((e) => { console.error(`\n✖ ${e.message ?? e}`); process.exit(1); });
}

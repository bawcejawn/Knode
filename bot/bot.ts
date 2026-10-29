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
 *   npm run bot -- chain-check                read-only: code fingerprints, switches, owners, chain id
 *   npm run bot -- verify-results [--days 3]  on your PC: recount posted results from YOUR OWN node (127.0.0.1 only)
 *   npm run bot -- games                      the vault's games (v6), their stakes, weeks and announcements
 *   npm run bot -- vault-snapshot [--out f]   read-only: save the live contract's state to a file (for rehearse-v6)
 *   npm run bot -- rehearse-v6 [--snapshot f] [--weeks 3] [--reward 90]   the v6 upgrade on a copy of that state
 *   Vault v6 commands (dry run unless --send; bot/README.md has the details):
 *     owner     game-add <id> "<name>" [--staked] [--free] [--season <weeks>] · game-apply <id> · game-stop <id>
 *               game-correct <id> <week> <player> <points> · game-unprize <id> <week> <player> · game-void <id> <week>
 *               claim-fee-vhp [to] [VHP|all]
 *     operator  game-post <id> <week> [<folder or branch:folder>] · game-seal <id> <week> · game-finalize <id> <week>
 *     player    stake <id> <VHP> · stake-koin <id> <KOIN> · unstake <id> <VHP|all> · move <from id> <to id> <VHP|all>
 *               claim-game <id> <week>
 *
 * Keys come only from the environment (.env on your PC, or GitHub secrets for the scheduled bot):
 *   OPERATOR_WIF   the bot's key: posts and resolves questions, pays for its own transactions. It cannot move funds.
 *   CONTRACT_WIF   the contract's own key — only for `deploy` (keep it offline afterwards)
 *   OWNER_WIF / SEED_WIF   only for `admin` on your PC — never put these in GitHub
 *   NEW_OWNER_WIF  only while a new owner / seed owner accepts a handover (--as new); remove it afterwards
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
import { Chain, KoinosChain, SimChain, Call, showKoin, toSat, loadAbi, pagePlayers } from "./chain.ts";
import { tokenAbi } from "./token-abi.ts";
import { readCsv, syncBlocks, fetchRange, readVhp, MAINNET_VHP, type Blk } from "../common.ts";
import { chainOutcome, scoreQuestion, storedOutcome, paramsHashOf, vhpSubjects, type VhpReading } from "../resolver.ts";
import { pobAbi } from "./token-abi.ts";
import { formatProduction, loadSigners, signerFromBlockItem, type SignedBlock } from "./production.ts";
import { contractManaVerdict } from "./mana.ts";
import { contractMetadata, checkMeta, sha256OfMeta, type Check } from "./chaincheck.ts";
import { vaultView, vaultResultsPass, vaultFinalizePass, vaultAlerts, recentGameWeeks, vaultStatus, type VaultCtx } from "./vault.ts";

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
/** A posted question still unresolved this many blocks (about 6 hours) after its window is reported (audit H-2). */
export const LATE_RESULT_BLOCKS = 7_200;
const RESOLVE_SLACK = 1_200;             // windows must end ≥ ~1 hour (in blocks) before the week can close, so the bot has time
const MIN_ANSWER_MS = HOUR_MS;           // never post a question with less than 1 hour left to answer
export const utc = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC";
const COMPOUND_MIN = toSat(1);           // compound once at least 1 KOIN of block rewards has piled up
const SPACE = (n: number) => String(n).padStart(3, "0");

const sha256hex = (s: string | Uint8Array) => crypto.createHash("sha256").update(s).digest("hex");
/** bot-state.json and the VHP readings in question files are written only by the bot. Each carries a seal (an HMAC with
 *  a key derived from OPERATOR_WIF), so an edit pushed by anyone without that key is noticed and not trusted. */
export const sealOf = (op: Signer, what: string, v: unknown) =>
  crypto.createHmac("sha256", crypto.createHash("sha256").update("kpred bot seal v1:" + op.getPrivateKey("hex")).digest())
    .update(`${what}:${JSON.stringify(v)}`).digest("hex");
const readingSeal = (op: Signer, q: any, r: VhpReading) => sealOf(op, `vhp:${String(q.paramsHash ?? "").toLowerCase()}`, { height: r.height, readAt: r.readAt, values: r.values });
/** The seal over a question's whole list of VHP readings (each reading, how many there are, and the latest height), so
 *  a reading removed, added, reordered or changed is noticed, not only an edited one. */
const readingsSeal = (op: Signer, q: any) => {
  const list = (q.vhpReadings ?? []).map((r: any) => ({ height: r.height, readAt: r.readAt, values: r.values }));
  return sealOf(op, `vhp-set:${String(q.paramsHash ?? "").toLowerCase()}`, { n: list.length, last: list.length ? list[list.length - 1].height : null, list });
};
/** Seals a question's VHP readings as the bot writes them: each reading, and the whole list (q.vhpSeal). */
export function sealReadings(op: Signer, q: any) {
  for (const r of q.vhpReadings ?? []) r.seal = readingSeal(op, q, r);
  q.vhpSeal = readingsSeal(op, q);
}
/** The seal on a day of questions, made when the bot generates them (audit M-10). It covers each question's id and the
 *  hash of its parameters, so a question file planted on main (a future day, or extra questions) is never posted. */
export const daySeal = (op: Signer, d: { date?: string; questions?: any[] }) =>
  sealOf(op, `day:${d.date ?? ""}`, (d.questions ?? []).map((q: any) => [String(q.id), paramsHashOf(q)]));
/** Which of the bot's keys made `seal` (the operator key, or PREVIOUS_OPERATOR_WIF after a rotation), if any. */
const sealKey = (ctx: Ctx, seal: unknown, f: (op: Signer) => string): Signer | undefined =>
  [ctx.operator, ...(ctx.previousOperator ? [ctx.previousOperator] : [])].find((op) => seal === f(op));
/** bot-state.json saved longer ago than this (in blocks, 90 minutes; the bot runs every hour) has its alert history
 *  re-checked: an older copy put back could otherwise hide a change that was emailed, undone and made again. Only the
 *  previous run's copy is younger, and its alert history holds only what was still live then. */
export const BOT_STATE_MAX_AGE = 1_800;
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
  /** Mana the bot wallet spent per UTC day ("YYYY-MM-DD" → units), last 60 days: for the platform's daily Mana budget. */
  manaByDay?: Record<string, string>;
  /** Block-producer keys first seen on record for the game and the desk (used when deployment.json names none). */
  producerKey?: string; deskProducerKey?: string;
  /** The owner-only settings seen on the last run (to report a change). */
  settings?: string;
  /** The last irreversible block when the bot last saved this file (sealed: an old copy put back is noticed). */
  sealedAt?: number;
  /** For each open question (by paramsHash): how many VHP readings the bot has recorded and the newest one's height.
   *  An older, validly sealed list put back in the question file is noticed against this (audit F-02). */
  vhpLists?: Record<string, { n: number; last: number }>;
  /** The Desk as last seen (audit D1-04): its settings, KOIN balance and total KOIN paid out by swaps. */
  desk?: { settings: string; koin: string; koinOut: string; at: number };
  /** The vault's game list as last seen (v6): a change is reported once. */
  games?: string;
};
const vhpKey = (q: any) => String(q.paramsHash ?? "").toLowerCase();
/** Records the list the bot just sealed. */
function noteReadings(bs: BotState, q: any) {
  const list = q.vhpReadings ?? [];
  (bs.vhpLists ??= {})[vhpKey(q)] = { n: list.length, last: list.length ? Number(list[list.length - 1].height) : 0 };
}
/** True when the file's (validly sealed) list is older than the one the bot last recorded. */
function staleReadings(bs: BotState, q: any): boolean {
  const seen = bs.vhpLists?.[vhpKey(q)];
  if (!seen) return false;
  const list = q.vhpReadings ?? [];
  return list.length < seen.n || (list.length ? Number(list[list.length - 1].height) : 0) < seen.last;
}
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
  /** Mana (units) this run's bot-paid transactions used, from their receipts. */
  manaUsed?: bigint;
  quiet?: boolean;
  /** Real runs only: when the day's release time is this close (ms), wait for it instead of leaving it to the next
   *  run, so questions come out on the dot (the release run is started a few minutes early). */
  releaseWaitMs?: number;
  /** A question window's blocks read fresh from the chain (irreversible blocks only). Without it the bot uses
   *  blocks.csv (simulations and tests). */
  windowBlocks?: (from: number, to: number) => Promise<Blk[]>;
  /** The same window read from a second, independent node (RPC_CHECK). When set, a result is posted only if both
   *  nodes give the same blocks (audit M-9). */
  crossCheckBlocks?: (from: number, to: number) => Promise<Blk[]>;
  /** VHP of these addresses ("network" = the whole network) right now, with the block height (read after the values,
   *  so the values are from that block or an earlier one). */
  vhp?: (who: string[]) => Promise<VhpReading>;
  /** The block-producer public key Proof-of-Burn has on record for an address ("" when none). */
  producerKey?: (producer: string) => Promise<string>;
  /** The code fingerprint and authorize switches the chain holds for a contract (real chain only). */
  metadata?: (contract: string) => Promise<import("./chaincheck.ts").ContractMeta>;
  /** The Desk Swap contract, for its health check. */
  desk?: { deployment: any; read: (method: string, args?: any) => Promise<any> };
  /** Settles the bot paid for itself this run, because the contract declined to (capped by MAX_BOT_PAID_SETTLES). */
  botPaid?: number;
  /** Lifts the cap on bot-paid settles (the last hours before a week's settle_end). */
  botPaidUncapped?: boolean;
  /** Set once this run's bot-paid settles stopped at BOT_MANA_FLOOR. */
  botManaFloorHit?: boolean;
  /** No operator key (a dry run without OPERATOR_WIF): seals cannot be checked, so the files are shown as they are. */
  noSealKey?: boolean;
  /** The operator key before a rotation (PREVIOUS_OPERATOR_WIF): seals it made are still accepted, and re-sealed. */
  previousOperator?: Signer;
  /** Set when bot-state.json was not trusted this run and the state started afresh. */
  stateReset?: boolean;
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
/** Even then, the bot stops paying for settles when its own Mana falls below this: posting and resolving come first. */
export const BOT_MANA_FLOOR = toSat(Number(E.BOT_MANA_FLOOR ?? 2));

async function sendOp(ctx: Ctx, what: string, calls: Call[], opts: { sponsored?: boolean } = {}): Promise<boolean> {
  if (ctx.dryRun) { log(`  [dry run] would send: ${what}`); return true; }
  let r = await ctx.chain.send(calls, [ctx.operator], opts);
  const contractPaid = !!opts.sponsored && r.ok;
  if (!r.ok && opts.sponsored) {
    // The contract only sponsors what it can verify is valid; if it declines, the bot pays instead, a few per run.
    ctx.botPaid = (ctx.botPaid ?? 0) + 1;
    if (!ctx.botPaidUncapped && ctx.botPaid > MAX_BOT_PAID_SETTLES) {
      if (ctx.botPaid === MAX_BOT_PAID_SETTLES + 1) {
        ctx.problems.push(`More than ${MAX_BOT_PAID_SETTLES} players needed settling this run. The game contract no longer pays Mana for anyone, so the bot paid for ${MAX_BOT_PAID_SETTLES} itself and left the rest for later runs (anyone can settle any player).`);
      }
      return false;
    }
    if (ctx.botPaidUncapped && await ctx.chain.mana(ctx.operator.getAddress()) < BOT_MANA_FLOOR) {
      if (!ctx.botManaFloorHit) {
        ctx.botManaFloorHit = true;
        ctx.problems.push(`The bot's Mana is below ${showKoin(BOT_MANA_FLOOR)}: it stopped paying for settles, to keep Mana for posting and resolving questions. Send its wallet some KOIN, or settle the remaining players yourself (anyone can).`);
      }
      return false;
    }
    r = await ctx.chain.send(calls, [ctx.operator], {});
  }
  // Count what the bot wallet paid (a reverted transaction is paid too; one the contract paid for is not).
  if (!contractPaid && r.rcUsed) { try { ctx.manaUsed = (ctx.manaUsed ?? 0n) + BigInt(r.rcUsed); } catch { /* not a number: not counted */ } }
  if (r.ok) { if (!ctx.quiet) log(`  ✔ ${what}${r.rcUsed && r.rcUsed !== "0" ? `  (Mana ${showKoin(r.rcUsed)})` : ""}`); }
  else { log(`  ✖ ${what}: ${r.error}`); ctx.problems.push(`A transaction failed: ${what} — ${String(r.error).slice(0, 200)}`); }
  return r.ok;
}

/** The bot's context as the vault passes need it (bot/vault.ts). */
const vaultCtx = (ctx: Ctx): VaultCtx => ({
  chain: ctx.chain, operator: ctx.operator, dryRun: ctx.dryRun, problems: ctx.problems, quiet: ctx.quiet,
  deployment: readJson(ctx.P.deployment, null),
});

// ═══════════════════════════════ the tick ═══════════════════════════════

export async function tick(ctx: Ctx) {
  const P = ctx.P;
  const st0 = await state(ctx);
  if (!st0.c.owner) throw new Error("The contract is not initialised yet (run deploy first).");
  if (st0.weekLen !== 7 * DAY_MS) throw new Error(`week_length (${st0.weekLen}) must be 7 days`);
  const raw = readJson(P.botState, null);
  const { seal, ...stored } = raw ?? {};
  const fresh = (): BotState => ({ checkedUpTo: 0, orphans: [], lastCompound: 0, warnings: [], lastProduced: 0, producedByDay: {}, producerScannedTo: 0 });
  let bs: BotState = { ...fresh(), ...stored };
  const { lib } = await ctx.chain.head();
  if (ctx.noSealKey) log("  (no OPERATOR_WIF: the seals on bot-state.json and VHP readings are not checked in this dry run)");
  else {
    // Nothing from a file the bot did not write, or from an old copy of one, may silence an alert, name the expected
    // producer key, get a question voided or hold back compounding: the state starts afresh, is re-checked from the
    // chain, and you are told why.
    let distrust = "";
    if (!raw) {
      if (fs.existsSync(path.join(P.dir, "index.json"))) {
        distrust = "game-data/bot-state.json is missing although the bot has run before. Its alert history and the owner-settings baseline are gone, so an owner-only change made since the last run cannot be reported as a change: check the settings on chain, and the file's git history.";
      }
    } else if (!sealKey(ctx, seal, (op) => sealOf(op, "bot-state", stored))) {
      distrust = "game-data/bot-state.json was not written by this bot (no valid seal: edited by hand, the operator key changed, or the first run after the update that added seals). None of it was trusted; the bot started its state afresh and re-checked it from the chain.";
    } else if (!Number.isInteger(stored.sealedAt) || stored.sealedAt > lib || lib - stored.sealedAt > BOT_STATE_MAX_AGE) {
      // Sealed, but old: the bot was down, or an older copy was put back. Its alert history may predate a change that
      // happened since, so every live owner-only change is emailed again.
      log(`  bot-state.json was last written at block ${stored.sealedAt ?? "?"} (now ${lib}): its alert history is not trusted`);
      bs.notified = [];
    }
    if (distrust) { ctx.problems.push(distrust); bs = fresh(); ctx.stateReset = true; }
  }
  const save = () => {
    if (ctx.dryRun) return;
    const plain = JSON.parse(JSON.stringify({ ...bs, sealedAt: lib }));
    writeJson(P.botState, { ...plain, seal: sealOf(ctx.operator, "bot-state", plain) });
  };

  // Each step is protected: one failing step (a busy RPC node, say) never stops the others.
  const step = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); } catch (e) { ctx.problems.push(`${name} failed: ${(e as Error).message ?? e}`); log(`  ✖ ${name} failed: ${(e as Error).message ?? e}`); }
    save();
  };
  // The withdrawals-only build refuses new questions, closes and finalizing (fix-check 2, V2-2): don't spend Mana on
  // calls it always refuses. Recording results (resolving, settling, other games' results) goes on.
  const safe = !!st0.raw.safe_mode;
  if (safe) log("  The vault runs the WITHDRAWALS-ONLY build: no new questions, closes or finalizing; results are still recorded.");
  await step("resolving questions", () => resolvePass(ctx, bs));
  if (!safe) await step("posting questions", () => postPass(ctx, bs));
  if (!safe) await step("closing / finalizing", () => closeFinalizePass(ctx));
  // v6: other games' results (posted once their week is final) and their weeks' finalization. Skipped on v5.
  await step("other games' results", () => vaultResultsPass(vaultCtx(ctx), (what, calls) => sendOp(ctx, what, calls)));
  if (!safe) await step("finalizing other games", () => vaultFinalizePass(vaultCtx(ctx), (what, calls) => sendOp(ctx, what, calls)));
  // The alerts run before the settle pass (audit L-6): a week with a great many entries to settle must never delay an
  // alert about an announced upgrade or owner change. The settle pass also has its own time budget.
  await step("health check", () => healthPass(ctx, bs));
  await step("settling players", () => settlePass(ctx));
  await step("compounding", () => compoundPass(ctx, bs));
  if (!ctx.dryRun && ctx.manaUsed) {
    const day = new Date().toISOString().slice(0, 10), m = { ...(bs.manaByDay ?? {}) };
    m[day] = String(big(m[day]) + ctx.manaUsed);
    bs.manaByDay = Object.fromEntries(Object.entries(m).sort().slice(-60));
    ctx.manaUsed = 0n;
    save();
  }
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
    if (bs.producerScannedTo > lib) bs.producerScannedTo = 0;
    if (bs.lastProduced > lib) {
      ctx.problems.push(`The pool's last block is unknown: bot-state.json says block ${bs.lastProduced}, ahead of the chain (${lib}). Until the bot sees a new one, treat the pool as having produced no block; check the project's node.`);
      bs.lastProduced = lib;
    }
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
    if (bs.lastProduced === 0 && ctx.stateReset) {
      // The production history was not trusted: whether the pool still produces is unknown until it is seen again.
      ctx.problems.push(`The pool's last block is unknown (bot-state.json was not trusted). Until the bot sees a new one, treat the pool as having produced no block; check the project's node.`);
    } else if (bs.lastProduced === 0) {
      if (!ctx.quiet) log(`  the pool has not produced a block yet (normal until the producer key is registered and the seed is in)`);
    } else {
      const gap = lib - bs.lastProduced, limit = alertAfter(rate);
      const mins = (n: number) => `${Math.round(n / 20)} min`;
      if (!ctx.quiet) log(`  pool production: last block ${bs.lastProduced} (${mins(gap)} ago); ~${(rate * DAY).toFixed(0)} blocks/day; alarm after ${isFinite(limit) ? mins(limit) : "a first full day of data"}`);
      if (gap > limit) ctx.problems.push(`The pool has produced no block for ${mins(gap)} (last block ${bs.lastProduced}). Check the project's node.`);
    }
  }

  // 1b. A question still unresolved 6 hours after its window ended (audit H-2). On the live contract, the operator key
  //     holding a result back past the week's end and then resolving late is how a stolen key would lock in its own
  //     answers; the bot normally resolves within an hour. If this fires: pause deposits and void the question.
  const { height } = await ctx.chain.head();
  for (const f of dayFiles(ctx.P)) for (const q of f.data.questions ?? []) {
    if (q.chainId === undefined || q.chainOutcome !== undefined || !q.windowEnd) continue;
    const late = height - num(q.windowEnd) - RESOLVE_MARGIN;
    if (late > LATE_RESULT_BLOCKS) ctx.problems.push(`${q.id} (#${q.chainId}) is still unresolved ${(late / 1200).toFixed(1)} h after its window ended. The bot resolves within about an hour, so something is holding it back (read this run's log). If a result then appears late that you did not expect, pause deposits (npm run bot -- pause on --send) and void the question (npm run bot -- void ${q.chainId} --send).`);
  }

  // 2. A week that should have closed but has not. Measured from its normal close (week end + close_delay) as well as
  //    from the close time that corrections move, so a week held open by repeated corrections is reported too.
  const w = st.weeksClosed;
  const wk = (await ctx.chain.read("get_week", { week: String(w) })).week ?? {};
  if (st.raw.safe_mode) {
    // The withdrawals-only build closes nothing: not an alarm (fix-check 3, V3-4).
    if (st.time > closeAt(st, w, wk)) log(`  Safe mode: closes are paused (week ${w} waits for the normal build).`);
  } else if (st.time > closeAt(st, w, wk) + 3 * HOUR_MS) {
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
  if (st.c.pending_seed_owner) ownerAlert(`seed-owner:${st.c.pending_seed_owner}:${st.c.pending_seed_owner_height ?? ""}`, `A seed handover to ${st.c.pending_seed_owner} is pending (it can be accepted a day after it was proposed). If you did not do this, your seed key may be compromised: propose your own seed address again right away (npm run bot -- admin propose_seed_owner new_seed_owner=<your seed address> --as seed --send).`);
  // The roles and the producer key must be the ones recorded at deployment (game-data/deployment.json).
  const dep = readJson(ctx.P.deployment, null);
  if (dep?.seedOwner && st.c.seed_owner && st.c.seed_owner !== dep.seedOwner)
    ownerAlert(`seed-owner-changed:${st.c.seed_owner}`, `The game's seed owner is ${st.c.seed_owner}, not ${dep.seedOwner} as in deployment.json. If you did not hand it over, your seed key is compromised (if you did, update deployment.json).`);
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
  // The code the chain runs, and the three authorize switches, hourly: an upload you did not make shows up here.
  if (ctx.metadata && dep?.wasmSha256) {
    const m = await ctx.metadata(C);
    const bad = checkMeta("game", m, dep.wasmSha256).filter((x) => !x.ok);
    if (bad.length) ownerAlert(`game-meta:${m.hash}:${m.call}${m.tx}${m.upload}`, `The game contract on chain is not what deployment.json records: ${bad.map((x) => x.text).join("; ")}. If you did not upgrade it, your admin key may be compromised (if you did, record the new fingerprint in deployment.json).`);
  }
  // Orphans (on-chain questions with no file) must end VOID. Any other outcome was set by the operator key before the bot
  // voided it, or by the owner key since.
  for (const id of bs.orphans) {
    const q = (await ctx.chain.read("get_question", { id })).question;
    const o = num(q?.outcome);
    if (o !== 0 && o !== 1000) ownerAlert(`orphan-outcome:${id}:${o}:${q?.data_hash ?? ""}`, `Orphan question #${id} (it matches no question file) has outcome ${o} on chain, not VOID. Only the operator key or the owner key can set that: if you did not, a key may be compromised. The owner can void it with correct_question.`);
  }
  if (ctx.desk) await deskHealth(ctx, bs, ownerAlert);
  // v6: game announcements, changes to the game list, owner corrections and voided game weeks.
  const view = await vaultView(ctx.chain);
  if (view) bs.games = vaultAlerts(view, st, await recentGameWeeks(ctx.chain, view, st.weeksClosed), ownerAlert, bs.games);
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
  // Desk v2: a proposed owner change and waiting loosenings (fee cut, cap raise, node key) are announced 48 h ahead.
  const oc = s.owner_change ?? {}, pend = s.pending ?? {};
  if (num(oc.eta) > 0) alert(`desk-owner-change:${oc.address}:${oc.eta}`, `A Desk owner change to ${oc.address} is proposed (it can accept from ${utc(num(oc.eta))}). If you did not do this, your admin key is compromised: cancel it (npm run desk -- owner cancel --send) and withdraw the Desk to the treasury.`);
  if (num(pend.eta) > 0) alert(`desk-pending:${pend.eta}:${pend.fee_bps}:${pend.daily_cap}:${pend.public_key}`, `A Desk settings change is waiting (from ${utc(num(pend.eta))}):${pend.has_fee ? ` fee to ${num(pend.fee_bps) / 100}%` : ""}${pend.has_cap ? ` daily cap to ${big(pend.daily_cap) === 0n ? "none" : showKoin(pend.daily_cap) + " KOIN"}` : ""}${pend.public_key ? ` new node key ${pend.public_key}` : ""}. If you did not do this, cancel it (npm run desk -- settings cancel --send).`);
  if (c.paused && !ctx.quiet) log(`  the Desk is paused`);
  // Audit D1-04: the Desk's settings, and its KOIN going out other than through swaps. A stolen owner key can set the fee
  // to 0 and empty the float at once, or withdraw to the treasury; these are the first signs.
  const settings = JSON.stringify({ fee_bps: num(c.fee_bps), min_swap: String(c.min_swap ?? "0"), max_swap: String(c.max_swap ?? "0"), paused: !!c.paused, timelock: String(c.timelock_length ?? "0"), ...(big(c.daily_cap ?? 0) > 0n ? { daily_cap: String(c.daily_cap) } : {}) });
  const odd: string[] = [];
  if (dep.feeBps !== undefined && num(c.fee_bps) < num(dep.feeBps)) odd.push(`the fee is ${num(c.fee_bps) / 100}% (deployment.json: ${num(dep.feeBps) / 100}%)`);
  if (dep.timelockLength !== undefined && big(c.timelock_length) < big(dep.timelockLength)) odd.push(`the timelock is ${num(c.timelock_length) / HOUR_MS} h (deployment.json: ${num(dep.timelockLength) / HOUR_MS} h)`);
  if (bs.desk && bs.desk.settings !== settings) odd.push(`its settings changed since the last run (${settings})`);
  if (odd.length) alert(`desk-settings:${settings}`, `The Desk: ${odd.join("; ")}. If you did not do this, your admin key may be compromised (if you did, update desk-data/deployment.json).`);
  const koin = big(s.koin_balance), koinOut = big(s.totals?.koin_out);
  if (bs.desk) {
    const fell = big(bs.desk.koin) - koin, bySwaps = koinOut - big(bs.desk.koinOut);
    // Swaps explain KOIN paid out; block rewards only add. Anything else left through the owner's withdrawal.
    if (fell - bySwaps > toSat(1)) alert(`desk-koin:${bs.desk.at}:${koin}`, `The Desk's KOIN fell by ${showKoin(fell)} since the last run, of which swaps paid out ${showKoin(bySwaps > 0n ? bySwaps : 0n)}: ${showKoin(fell - bySwaps)} left another way (an owner withdrawal to the treasury). If you did not do this, your admin key may be compromised.`);
    if (bySwaps > 0n && big(bs.desk.koin) > 0n && bySwaps * 2n > big(bs.desk.koin)) alert(`desk-drain:${bs.desk.at}`, `Swaps took ${showKoin(bySwaps)} KOIN from the Desk in one hour, more than half of what it held. If that is not normal trading, pause the Desk (npm run desk -- pause on --send).`);
  }
  bs.desk = { settings, koin: koin.toString(), koinOut: koinOut.toString(), at: num(s.time) };
  // Its code and switches (D1-06), hourly.
  if (ctx.metadata && dep.contract && dep.wasmSha256) {
    const m = await ctx.metadata(dep.contract);
    const bad = checkMeta("desk", m, dep.wasmSha256).filter((x) => !x.ok);
    if (bad.length) alert(`desk-meta:${m.hash}:${m.call}${m.tx}${m.upload}`, `The Desk contract on chain is not what desk-data/deployment.json records: ${bad.map((x) => x.text).join("; ")}. If a switch is off, the Desk's tokens are not protected: act now.`);
  }
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
      if (hit) {
        // The same question landed twice: a post the bot thought had failed (not seen in time) was included after all,
        // and the next run posted it again (audit F-10). The copy is voided; nobody's key was misused.
        log(`  (#${id} is a second copy of ${hit.q.id}, already posted as #${hit.q.chainId}: a retried post that landed twice)`);
        if (!ctx.quiet && process.env.GITHUB_ACTIONS) console.log(`::warning title=Duplicate question::#${id} is a second copy of ${hit.q.id} (#${hit.q.chainId}); it is voided.`);
      } else ctx.problems.push(`On-chain question #${id} matches no question file (params_hash ${String(q?.params_hash ?? "")}). It will be voided. Unless the bot crashed right after posting it, the operator key may be compromised.`);
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

  // Orphans: void with a hash that says so. Each is re-checked first: one that matches a question file after all is
  // linked instead (scanned again), never voided.
  const fileQs = dayFiles(ctx.P).flatMap((f) => f.data.questions ?? []);
  for (const id of [...bs.orphans]) {
    const q = (await ctx.chain.read("get_question", { id })).question;
    const h = String(q?.params_hash ?? "").replace(/^0x/, "").toLowerCase();
    if (fileQs.some((x: any) => String(x.paramsHash ?? "").toLowerCase() === h && (x.chainId === undefined || x.chainId === id))) {
      bs.orphans = bs.orphans.filter((x) => x !== id);
      bs.checkedUpTo = Math.min(bs.checkedUpTo, id);
      log(`  on-chain question #${id} matches a question file: not an orphan`);
      continue;
    }
    if (!q || num(q.outcome) !== 0 || !due(q)) continue;
    const dataHash = "0x" + sha256hex(`orphan question ${id} params ${q.params_hash}`);
    await sendOp(ctx, `resolve orphan #${id} as VOID`, [{ method: "resolve_question", args: { id, outcome: 1000, data_hash: dataHash } }]);
  }

  // A failed VHP read only costs this run's reading; every other question is still resolved below.
  try { await vhpReadPass(ctx, height, bs); }
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
        // The VHP readings must be exactly the list this bot recorded (one seal over the whole list). A reading removed,
        // added or changed holds the question back: it is reported, never resolved silently.
        if (!ctx.noSealKey && !resolved && (q.vhpReadings?.length || q.vhpEnd || q.vhpSeal !== undefined)) {
          const by = q.vhpEnd ? undefined : sealKey(ctx, q.vhpSeal, (op) => readingsSeal(op, q));
          if (!by) {
            ctx.problems.push(`${q.id} (#${q.chainId}): its VHP readings are not the list this bot recorded (a VHP reading was removed, added or changed, or the operator key changed). Not resolving it: restore the file from git history; after an operator-key change, set PREVIOUS_OPERATOR_WIF; or void it with the owner key.`);
            continue;
          }
          if (staleReadings(bs, q)) {
            ctx.problems.push(`${q.id} (#${q.chainId}): its VHP readings are an older list than the one this bot last recorded (an earlier copy of the file was put back). Not resolving it: restore the newest version from git history, or void it with the owner key.`);
            continue;
          }
          if (by !== ctx.operator) { sealReadings(ctx.operator, q); noteReadings(bs, q); dirty = true; }
        }
        const scored = scoreQuestion(q, await windowOf(q, csv), { vhpReadings: q.vhpReadings ?? [] });
        if (resolved) {
          if (bs.vhpLists) delete bs.vhpLists[vhpKey(q)];
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
              ctx.problems.push(`${q.id} (#${q.chainId}): the on-chain outcome (${q.chainOutcome}) differs from what the blocks say (${mine}${scored.result.void ? ", void" : ""}). Check it; ${await correctionDeadline(ctx, st, num(onChain.week))}.`);
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
        if (scored.result.vhpCheck?.skipped) {
          log(`  ${q.id}: VHP-swing check skipped (${scored.result.vhpCheck.skipped})`);
          // Readings were taken, but all after the blocks decided the answer: the bot worked, nothing to report.
          if (!scored.result.vhpCheck.readingsInWindow) ctx.problems.push(`${q.id} (#${q.chainId}) was resolved without the VHP-swing rule: ${scored.result.vhpCheck.skipped} (was the bot down, or every VHP read failing?). Its result on the site says so.`);
        }
        // A second node must agree on the window's blocks before anything is posted (M-9): one lying or broken node
        // can then no longer choose a result.
        if (ctx.crossCheckBlocks) {
          let alt: ReturnType<typeof scoreQuestion> | undefined, why = "";
          try { alt = scoreQuestion(q, await ctx.crossCheckBlocks(q.windowStart, q.windowEnd), { vhpReadings: q.vhpReadings ?? [] }); }
          catch (e) { why = (e as Error).message ?? String(e); }
          if (!alt || !alt.ok) {
            const pending = alt && !alt.ok && alt.pending;
            if (pending) log(`  ${q.id}: the second node does not have the window's final blocks yet; resolving next run`);
            else ctx.problems.push(`${q.id} (#${q.chainId}): could not check its blocks on the second node (RPC_CHECK): ${why || (alt && !alt.ok ? alt.reason : "")}. Not resolved this run.`);
            continue;
          }
          if (alt.result.dataHash !== scored.result.dataHash) {
            ctx.problems.push(`${q.id} (#${q.chainId}): the two nodes disagree about its window's blocks (RPC ${scored.result.dataHash.slice(0, 12)}…, RPC_CHECK ${alt.result.dataHash.slice(0, 12)}…). Not resolved. One node is wrong or lying: check both before anything else.`);
            continue;
          }
        }
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

/** Until when the owner can still change a result of week w: the contract refuses a change less than a quarter of
 *  close_delay before 2 × close_delay after max(week end, the week's latest first result), i.e. 21 h with 12 h. */
async function correctionDeadline(ctx: Ctx, st: { genesis: number; weekLen: number; closeDelay: number; time: number }, w: number): Promise<string> {
  const wk = (await ctx.chain.read("get_week", { week: String(w) })).week ?? {};
  if (wk.closed) return "its week is already closed, so it can no longer be corrected";
  const end = Math.max(weekEnd(st, w), num(wk.last_result_time)) + 2 * st.closeDelay - Math.floor(st.closeDelay / 4);
  return st.time <= end ? `the owner can correct it until ${utc(end)}` : `it can no longer be corrected (changes ended ${utc(end)})`;
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
async function vhpReadPass(ctx: Ctx, height: number, bs: BotState) {
  const open: Array<{ f: { file: string; data: DayFile }; q: any }> = [];
  for (const f of dayFiles(ctx.P)) for (const q of f.data.questions ?? []) {
    if (q.chainId === undefined || q.chainOutcome !== undefined || !q.model?.vhp || q.model.voidVhpSwing === undefined) continue;
    if (height >= q.windowStart && height <= q.windowEnd) open.push({ f, q });
  }
  if (!open.length) return;
  if (!ctx.vhp) { ctx.problems.push(`${open.length} question(s) have an open window and need a VHP reading, but this run cannot read VHP.`); return; }
  // A failed read is tried again a few times: one hiccup would otherwise lose this hour's reading for every open
  // window (audit F-11).
  const who = [...new Set(open.flatMap(({ q }) => vhpSubjects(q)))];
  let reading: VhpReading | undefined, lastErr: unknown;
  for (let attempt = 1; attempt <= 3 && !reading; attempt++) {
    try { reading = await ctx.vhp(who); }
    catch (e) { lastErr = e; if (attempt < 3) await new Promise((r) => setTimeout(r, (ctx.chain.kind === "koinos" ? 2000 : 0) * attempt)); }
  }
  if (!reading) throw lastErr;
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
    const r: VhpReading = { height: reading.height, readAt, values };
    // The list already in the file must still be the one this bot sealed, or a new seal would cover the edit: the
    // reading is then not added, and the resolve step reports the file.
    if (!ctx.noSealKey && (q.vhpReadings?.length || q.vhpSeal !== undefined) && (!sealKey(ctx, q.vhpSeal, (op) => readingsSeal(op, q)) || staleReadings(bs, q))) {
      log(`  ${q.id}: its VHP readings are not the newest list this bot recorded; reading not added`);
      continue;
    }
    (q.vhpReadings ??= []).push(r);
    if (!ctx.noSealKey) { sealReadings(ctx.operator, q); noteReadings(bs, q); }
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
  if (time < releaseAt) {
    const wait = releaseAt - time;
    if (!ctx.dryRun && ctx.releaseWaitMs && wait <= ctx.releaseWaitMs) {
      log(`  today's questions come out at ${utc(releaseAt)}: waiting ${Math.ceil(wait / 1000)} s for it`);
      await new Promise((r) => setTimeout(r, wait + 5_000));
      // The chain's clock can trail by a block or two: one more short wait at most, then leave it to the next run.
      ctx.releaseWaitMs = ctx.releaseWaitMs > 60_000 ? 60_000 : 0;
      return postPass(ctx, bs);
    }
    if (!ctx.quiet) log(`  today's questions come out at ${utc(releaseAt)}`);
    return;
  }
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
      "--lock-height", String(windowStart - 1), "--lock-time", String(lockTime), "--max-end", String(maxEnd)]);
    // Every active producer stays in the game (owner decision on audit F-09); the generator's weekly cap
    // (game.json "maxUsesPerWeek") keeps any one node out of too many questions.
    if (!g.ok) {
      if (/Too late/i.test(g.output)) {
        writeJson(file, { date: label, week: w, day: dd + 1, questions: [], skipped: "too late to release today's questions" });
        log(`  skipped ${label}: too late`);
      } else { log(`  ✖ the generator failed (will retry next run):\n${g.output.slice(-1500)}`); ctx.problems.push(`The question generator failed for ${label}.`); }
      return;
    }
    // Seal what the generator made (only this run's generator output is ever posted), then save the questions publicly
    // BEFORE posting them, so their details can never be lost.
    const made: DayFile & { daySeal?: string } = readJson(file);
    for (const q of made.questions ?? []) {
      if (paramsHashOf(q) !== String(q.paramsHash ?? "").toLowerCase()) throw new Error(`the generator wrote ${q.id} with a paramsHash that does not match its parameters`);
    }
    if (!ctx.noSealKey) { made.daySeal = daySeal(ctx.operator, made); writeJson(file, made); }
    ctx.checkpoint(`bot: questions for ${label}`);
  }

  const data: DayFile & { daySeal?: string } = readJson(file);
  if (!data.questions?.some((q: any) => q.chainId === undefined && !q.postSkipped)) return;
  // Post only questions this bot generated and sealed, whose parameters still hash to the recorded paramsHash. A file
  // that arrived some other way (a commit to main) is reported and never posted (audit M-10).
  if (!ctx.noSealKey && !sealKey(ctx, data.daySeal, (op) => daySeal(op, data))) {
    ctx.problems.push(`${label}: the question file was not generated by this bot (no valid seal: edited or added by a commit, or made before seals). Nothing from it is posted. If you did not change it, check the file's git history; to start the day over, delete the file and the bot generates it again.`);
    return;
  }
  for (const q of data.questions ?? []) {
    if (q.chainId === undefined && paramsHashOf(q) !== String(q.paramsHash ?? "").toLowerCase()) {
      ctx.problems.push(`${label}: ${q.id}'s parameters no longer hash to its paramsHash. Nothing from this file is posted.`);
      return;
    }
  }
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
    // v5 takes at most 30 questions a week (v3 64). A stray or duplicate post can use up a slot: then the remaining
    // questions are skipped once, with a note, instead of failing (and costing Mana) every hour.
    const gs = await ctx.chain.read("get_state", {});
    const maxQ = num(gs.config?.reward_rule_week_plus_one) > 0 ? 30 : 64;
    const wkQ = num(((await ctx.chain.read("get_week", { week: String(cur.week ?? q.week) })).week ?? {}).questions);
    if (wkQ >= maxQ) {
      q.postSkipped = `the week already has ${wkQ} questions on chain (the most it takes)`;
      log(`  skipped ${q.id}: ${q.postSkipped}`);
      ctx.problems.push(`${label}: ${q.id} was not posted: the week already has ${wkQ} questions on chain (a stray or duplicate question used a slot). Players get one question fewer this week; nothing else to do.`);
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
  return pagePlayers(chain, week);   // stops with an error rather than loop (fix-check 2, V2-1)
}

const FREE_SETTLE_MAX = 20;
/** The settle pass stops after this long (audit L-6): the hourly run has to finish, and the next run continues. */
const SETTLE_BUDGET_MS = 40 * 60_000;

async function settlePass(ctx: Ctx) {
  const st = await state(ctx);
  const h = st.time;
  const started = Date.now();
  const outOfTime = () => Date.now() - started > SETTLE_BUDGET_MS;
  for (let w = st.weeksFinalized; w < st.weeksClosed; w++) {
    const wk = (await ctx.chain.read("get_week", { week: String(w) })).week ?? {};
    if (h < num(wk.settle_start) || h > num(wk.settle_end)) continue;
    // Free players (no stake that week) and voided entries (the player withdrew everything) can never be paid, so the
    // bot doesn't spend Mana settling them.
    const minStake = minStakeFor(st.c, w);
    const unsettled = async () => (await allPlayers(ctx.chain, w)).filter((r) => r.entry && !r.entry.settled && !r.entry.voided && big(r.entry.stake) >= minStake && big(r.entry.stake) > 0n);
    // Largest stakes first, so if the bot has to stop paying, it stops at the smallest entries.
    const todo = (await unsettled()).sort((a, b) => (big(b.entry.stake) > big(a.entry.stake) ? 1 : big(b.entry.stake) < big(a.entry.stake) ? -1 : 0));
    const lastHours = num(wk.settle_end) - h <= SETTLE_LAST_HOURS_MS;
    if (todo.length) log(`  settling ${todo.length} player(s) for week ${w}${lastHours ? " (last hours before settle_end: no cap on bot-paid settles)" : ""}`);
    let n = 0;
    ctx.botPaidUncapped = lastHours;
    try {
      for (const r of todo) {
        if (outOfTime()) { log(`  stopped settling for this run (time budget); the next run continues`); break; }
        if (await sendOp(ctx, `settle ${r.address} for week ${w}`, [{ method: "settle", args: { player: r.address, week: String(w) } }], { sponsored: true })) n++;
      }
    } finally { ctx.botPaidUncapped = false; }
    if (todo.length) log(`  settled ${n}/${todo.length}`);
    if (lastHours && todo.length && !ctx.dryRun) {
      const left = await unsettled();
      if (left.length) ctx.problems.push(`Week ${w}: ${left.length} staked player(s) are still not settled and settlement ends ${utc(num(wk.settle_end))}. Anyone can send their settle; after that time they get no reward for the week.`);
    }
    // v5: the 2 best free players share up to 2 VHP. The bot settles (and pays the Mana for) only the free players who
    // can be among them: the two best free scores, at most FREE_SETTLE_MAX wallets, best first. A crowd of free
    // wallets can't make the bot spend more than that; anyone can still settle their own entry.
    if (wk.reward_rule) {
      // A free player never held the minimum stake this week (a staked player who withdrew below it is not one: audit L-4).
      const peakOf = (e: any) => { const a = big(e.stake), b = big(e.peak_stake); return a > b ? a : b; };
      const rows = (await allPlayers(ctx.chain, w)).filter((r) => r.entry && !r.entry.voided && peakOf(r.entry) < minStake && (!r.entry.settled || r.entry.free_player));
      const ids = [...new Set(rows.flatMap((r) => (r.entry.answers ?? []).map((a: any) => num(a.question_id))))];
      const outcome = new Map<number, number>();
      for (const id of ids) outcome.set(id, num(((await ctx.chain.read("get_question", { id })).question ?? {}).outcome));
      const scored = rows.map((r) => {
        if (r.entry.settled) return { r, p: num(r.entry.points), c: num(r.entry.counted) };
        let p = 0, c = 0;
        for (const a of r.entry.answers ?? []) { const o = outcome.get(num(a.question_id)) ?? 0; if (!o || o === 1000) continue; c++; if (o === num(a.option) + 1) p++; }
        return { r, p, c };
      }).filter((x) => x.c > 1 && x.p >= 1);
      const scores = [...new Set(scored.map((x) => x.p))].sort((a, b) => b - a).slice(0, 2);
      const line = scores.length ? scores[scores.length - 1] : Infinity;
      // A budget for the whole week, not per run. Only settled free entries at or above the projected line count against
      // it (audit M-1): low-score wallets settled early by someone else can't use it up. The two best projected scorers
      // are always settled first, whatever the budget.
      const spent = scored.filter((x) => x.r.entry.settled && x.p >= line).length;
      const left = Math.max(0, FREE_SETTLE_MAX - spent);
      const want = scored.filter((x) => !x.r.entry.settled && x.p >= line).sort((a, b) => b.p - a.p);
      const free = want.slice(0, Math.max(left, 2));
      if (free.length) log(`  settling ${free.length} free player(s) with the best free scores for week ${w}`);
      for (const x of free) {
        if (outOfTime()) { log(`  stopped settling free players for this run (time budget)`); break; }
        // Never below the Mana the bot needs for posting and resolving questions.
        if (await ctx.chain.mana(ctx.operator.getAddress()) < BOT_MANA_FLOOR) { log(`  stopped settling free players: the bot's Mana is low`); break; }
        await sendOp(ctx, `settle free player ${x.r.address} (${x.p} pts) for week ${w}`, [{ method: "settle", args: { player: x.r.address, week: String(w) } }]);
      }
      if (want.length > free.length && !ctx.dryRun && h > num(wk.settle_end) - SETTLE_LAST_HOURS_MS) log(`  week ${w}: ${want.length - free.length} more free player(s) tied at the top were not settled by the bot (weekly limit ${FREE_SETTLE_MAX}); they can settle themselves`);
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
  // v6 adds the fee owed in VHP and the buckets waiting to roll over (both 0 before v6).
  const owed = ["total_stake", "seed_vhp", "seed_koin", "owner_share", "creator_fee", "pots_outstanding", "fee_vhp", "games_rolled"].reduce((s, k) => s + big(t[k]), 0n);
  const now = st.time;
  const w = now < st.genesis ? 0 : Math.floor((now - st.genesis) / st.weekLen);
  const inH = (ms: number) => `${((ms - now) / HOUR_MS).toFixed(1)} h`;
  log(`Contract ${ctx.chain.contractId}  (${ctx.chain.kind})   block ${height} (irreversible ${lib}), chain time ${utc(now)}`);
  log(now < st.genesis ? `Game starts ${utc(st.genesis)} (in ${inH(st.genesis)})`
    : `Week ${w + 1}: ends ${utc(weekEnd(st, w))} (in ${inH(weekEnd(st, w))}); results final ${utc(weekEnd(st, w) + st.closeDelay)}`);
  log(`Weeks closed ${st.weeksClosed}, finalized ${st.weeksFinalized}; questions posted ${st.nextId}`);
  log(`Holdings  ${showKoin(holdings)}  (VHP ${showKoin(st.raw.vhp_balance)} + KOIN ${showKoin(st.raw.koin_balance)})   contract Mana ${showKoin(st.raw.mana)}`);
  log(`Owed      ${showKoin(owed)}  = stakes ${showKoin(t.total_stake)} + seed ${showKoin(big(t.seed_vhp) + big(t.seed_koin))} + producer fee ${showKoin(big(t.creator_fee) + big(t.fee_vhp))} + unclaimed pots ${showKoin(t.pots_outstanding)}${big(t.games_rolled) > 0n ? ` + buckets rolling over ${showKoin(t.games_rolled)}` : ""}${big(t.owner_share) > 0n ? ` + old owner share ${showKoin(t.owner_share)}` : ""}`);
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
  await vaultStatus(ctx.chain, log);
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
const SAFE_WASM = "game/build/safe/contract.wasm";   // the withdrawals-only emergency build (npm run build:safe)

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
  const rpc = E.RPC ?? "https://koinos.armana.io";
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
//                             add --safe (to every step) for the withdrawals-only build, game/build/safe/contract.wasm
//   upgrade apply             after the 48 hours: upload exactly that build, then clear the notice
//   upgrade cancel            withdraw the announcement
/** Why this local build must not be announced or uploaded ("" = fine). Normal: never the withdrawals-only build (by its
 *  file or the pinned fingerprint), and assembly/Mode.ts must be the normal one. Safe: exactly the pinned fingerprint.
 *  Never the test build. (Fix-check VN-10, V2-3, V3-10, V3-12.) */
export function upgradeGuard(wasm: Buffer, safe: boolean, dep: any, safeFile: Buffer | null, modeTs: string): string {
  const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");
  const h = sha(wasm);
  if (wasm.indexOf(Buffer.from("TEST LEDGER", "utf16le")) !== -1) return "This is the TEST build (simulated token ledger). Run `npm run build` in the game folder.";
  if (safe) {
    if (!dep.safeWasmSha256) return "game-data/deployment.json has no safeWasmSha256: the withdrawals-only build's fingerprint must be pinned there first.";
    if (h !== dep.safeWasmSha256) return `${SAFE_WASM} has sha256 ${h}, not the pinned withdrawals-only build ${dep.safeWasmSha256} (game-data/deployment.json safeWasmSha256).`;
    return "";
  }
  if ((safeFile && sha(safeFile) === h) || (dep.safeWasmSha256 && h === dep.safeWasmSha256))
    return `${WASM} is the withdrawals-only build. In the game folder run: npm run build, then npm run check.`;
  // The switch line itself, not a comment (V3-10): exactly one live SAFE_MODE declaration, and it is false.
  const decl = modeTs.split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, "").trim()).filter((l) => /\bSAFE_MODE\b/.test(l));
  if (decl.length !== 1 || !/^export const SAFE_MODE: bool = false;$/.test(decl[0]))
    return "game/assembly/Mode.ts is not the normal build's (SAFE_MODE must be false). Restore it (git checkout game/assembly/Mode.ts), then npm run build and npm run check.";
  return "";
}

async function upgrade(sub: string | undefined, send: boolean, botPays = false, safe = false) {
  const WASM_FILE = safe ? SAFE_WASM : WASM;
  const P = paths(E.GEN_DIR ?? "game-data");
  const dep = readJson(P.deployment, null);
  if (!dep?.contract) throw new Error(`${P.deployment} not found — deploy first.`);
  const rpc = E.RPC ?? dep.rpc;
  const mainnet = isMainnet(rpc);
  pinDeployment("game", dep, rpc, P.deployment);
  if (send && mainnet && E.CONFIRM_MAINNET !== "yes") throw new Error("MAINNET: add CONFIRM_MAINNET=yes to .env first.");
  // Cancelling needs no local build (fix-check 3, V3-9).
  if (sub === "cancel") return act("owner", "cancel_upgrade", {}, send);
  if (!fs.existsSync(WASM_FILE)) throw new Error(`${WASM_FILE} not found — in the game folder run: ${safe ? "npm run build:safe" : "npm test && npm run check"}`);
  const wasm = fs.readFileSync(WASM_FILE);
  // The local-build guards stop schedule and apply; status only reports them (fix-check 3, V3-9).
  const guard = upgradeGuard(wasm, safe, dep, fs.existsSync(SAFE_WASM) ? fs.readFileSync(SAFE_WASM) : null, fs.readFileSync("game/assembly/Mode.ts", "utf8"));
  if (guard && sub && sub !== "status") throw new Error(guard);
  const local = "0x" + sha256hex(wasm);
  const chain = new KoinosChain(rpc, dep.contract);
  const st = await chain.read("get_state", {});
  const up = st.upgrade ?? {};
  const announced = up.hash ? String(up.hash).toLowerCase() : "";
  const eta = Number(up.eta ?? 0);
  const now = Number(st.time ?? Date.now());
  log(`Contract           ${dep.contract} on ${rpc}${mainnet ? "  ⚠ MAINNET" : ""}`);
  log(`Local build        ${WASM_FILE}${safe ? " (WITHDRAWALS-ONLY emergency build)" : ""}, ${(wasm.length / 1024).toFixed(1)} KB, sha256 ${local}`);
  log(eta > 0 ? `Announced          sha256 ${announced}, can be uploaded from ${utc(eta)}${now >= eta ? " (now)" : ` (in ${((eta - now) / HOUR_MS).toFixed(1)} h)`}` : "Announced          nothing");
  if (eta > 0) log(announced === local ? "                   ✔ matches the local build" : "                   ✖ does NOT match the local build");
  if (guard) log(`                   ✖ ${guard}`);

  if (!sub || sub === "status") return;
  if (sub === "schedule") {
    if (eta > 0 && announced === local) { log("\nThis build is already announced."); return; }
    log(`\nThis announces the local build. Players see it on chain (and the bot emails you): they have 48 hours to withdraw if they disagree.`);
    return act("owner", "schedule_upgrade", { hash: local }, send);
  }
  if (sub !== "apply") throw new Error("upgrade status | schedule | apply | cancel");

  if (eta === 0) throw new Error("Nothing is announced. Run: npm run bot -- upgrade schedule --send   (then wait 48 hours)");
  if (announced !== local) throw new Error("The announced code is not this build. Rebuild the exact announced version, or cancel and schedule this one.");
  if (now < eta) throw new Error(`Too early: the upload is accepted from ${utc(eta)}.`);
  if (!E.OWNER_WIF) throw new Error("OWNER_WIF is needed in .env (the owner authorizes the upload).");
  if (botPays && !E.OPERATOR_WIF) throw new Error("--bot-pays needs OPERATOR_WIF in .env.");
  const provider = new Provider([rpc]);
  const owner = Signer.fromWif(E.OWNER_WIF);
  owner.provider = provider;
  if (owner.getAddress() !== st.config?.owner) throw new Error(`OWNER_WIF is ${owner.getAddress()}, but the contract's owner is ${st.config?.owner}.`);
  // The owner's wallet pays the upload's Mana by default (audit U1-05): the bot wallet's key lives on GitHub, so it
  // should never hold the ~60 KOIN an upload needs. --bot-pays keeps the old way (then move the KOIN out afterwards).
  const payer = botPays ? Signer.fromWif(E.OPERATOR_WIF!) : owner;
  payer.provider = provider;
  // Before: the contract must still decide for its own account (all three switches on), or the timelock means nothing.
  const before = await contractMetadata(provider, dep.contract);
  const pre = checkMeta("the live contract", before);
  for (const x of pre) log(`${x.ok ? "  ✔" : "  ✖"} ${x.text}`);
  if (pre.some((x) => !x.ok)) throw new Error("The live contract's metadata is not as expected (see above). Stop: re-plan the upgrade.");
  const abiText = JSON.stringify(loadAbi());
  const mana = BigInt(await provider.getAccountRc(payer.getAddress()));
  const rcLimit = (mana * 95n) / 100n;
  // Upload Mana grows with the code's size: about 60 KOIN for v5's 57.7 KB, so v6's ~82 KB needs about 85 (+5 margin).
  const needKoin = Math.ceil((wasm.length / 57_699) * 60) + 5;
  log(`Pays the Mana      ${botPays ? "bot" : "owner"} wallet ${payer.getAddress()} (has ${showKoin(mana)} Mana; this upload needs about ${needKoin})`);
  if (mana < toSat(needKoin)) throw new Error(`The ${botPays ? "bot" : "owner"} wallet needs about ${needKoin} Mana for this upload (${(wasm.length / 1024).toFixed(1)} KB). Add KOIN to it and let the Mana refill${botPays ? "" : " (or use --bot-pays, then move the KOIN out of the bot wallet afterwards)"}.`);
  if (!send) { log("\nDry run only — nothing was sent. Add --send to upload."); return; }
  log(`\n1/2 Uploading the announced code (owner authorizes, ${botPays ? "bot" : "owner"} wallet pays) ...`);
  const c = new Contract({ id: dep.contract, abi: loadAbi(), provider, signer: owner, bytecode: new Uint8Array(wasm) });
  // The three switches must stay on: the contract refuses any upload that turns one off.
  const { operation } = await c.deploy({ abi: abiText, authorizesCallContract: true, authorizesTransactionApplication: true, authorizesUploadContract: true, onlyOperation: true } as any);
  const tx = new (await import("koilib")).Transaction({ signer: payer, provider, options: { payer: payer.getAddress(), payee: payer.getAddress(), rcLimit: rcLimit.toString() } });
  await tx.pushOperation(operation);
  await tx.prepare();
  let t: any = tx.transaction;
  t = await payer.signTransaction(t);
  if (payer !== owner) t = await owner.signTransaction(t);
  const { receipt, transaction } = await provider.sendTransaction(t);
  if ((receipt as any)?.reverted) throw new Error(`upload reverted: ${JSON.stringify((receipt as any).logs)}`);
  await transaction.wait("byBlock", 300_000).catch(() => { throw new Error("Sent but not confirmed within 5 minutes. Check `npm run bot -- upgrade status` before trying again."); });
  log(`    uploaded — Mana used ${showKoin((receipt as any).rc_used)}`);
  // After: what the chain now runs (audit U1-04). deployment.json records the chain's fingerprint, never the local
  // build's, and a mismatch stops here.
  const after = await contractMetadata(provider, dep.contract);
  const post = checkMeta("the upgraded contract", after, local.slice(2));
  for (const x of post) log(`${x.ok ? "  ✔" : "  ✖"} ${x.text}`);
  dep.wasmSha256 = sha256OfMeta(after) || dep.wasmSha256;
  dep.upgradedAt = new Date().toISOString();
  writeJson(P.deployment, dep);
  if (post.some((x) => !x.ok)) {
    log(`\n✖ The chain does not run the announced build with all three switches on (see above). ${P.deployment} records what the chain runs. Do not clear the notice; investigate first.`);
    process.exitCode = 1;
    return;
  }
  log("2/2 Clearing the notice ...");
  if (!(await act("owner", "cancel_upgrade", {}, true))) {
    log(`\n✖ The code is uploaded (${P.deployment} is updated), but clearing the notice failed. Run: npm run bot -- upgrade cancel --send`);
    process.exitCode = 1;
    return;
  }
  log(`\nDone. Commit ${P.deployment}. Check everything with: npm run bot -- status`);
}

/** Read-only checks of both contracts on chain (audit 2026-10 Section 10): code fingerprints, the three authorize
 *  switches, announced changes, roles. Nothing is signed. Exits with an error if anything is unexpected. */
/**
 * verify-results — on YOUR PC, against YOUR OWN node: recount every posted result from your node's blocks and compare
 * with what the contract recorded. Read-only and local: it only reads from a node on this computer (127.0.0.1), opens
 * no port and sends nothing. It finds the node by itself (or: --rpc http://127.0.0.1:<port>).
 *
 *   npm run bot -- verify-results [--days 3] [--rpc http://127.0.0.1:8080]
 *
 * Run `git pull` first so the question files are current. Exit code 1 (and VERIFY-ALERT lines in verify-results.log)
 * when a posted result disagrees with your node's blocks.
 */
const LOCAL_PORTS = [8080, 8081, 8082, 8083, 8100, 8101, 8102, 8200, 8090, 8000];
const withTimeout = <T,>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);

async function findLocalNode(expectChainId: string | null): Promise<{ rpc: string; lib: number; headId: string } | null> {
  const found: Array<{ rpc: string; lib: number; headId: string }> = [];
  const candidates = [...new Set([E.NODE_RPC, ...LOCAL_PORTS.map((p) => `http://127.0.0.1:${p}`)].filter(Boolean) as string[])]
    .filter((u) => /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(u));   // this computer only
  await Promise.all(candidates.map(async (rpc) => {
    try {
      const pr = new Provider([rpc]);
      const head: any = await withTimeout(pr.getHeadInfo(), 3000);
      const id = await withTimeout(pr.getChainId(), 3000);
      if (expectChainId && id !== expectChainId) { log(`  ${rpc}: a Koinos node, but not mainnet (chain ${id}); skipped`); return; }
      found.push({ rpc, lib: Number(head.last_irreversible_block), headId: head.head_topology.id });
    } catch { /* nothing on that port */ }
  }));
  found.sort((a, b) => b.lib - a.lib);
  return found[0] ?? null;
}

async function verifyResults(days: number, rpcArg?: string) {
  const P = paths(E.GEN_DIR ?? "game-data");
  const dep = readJson(P.deployment, null);
  if (!dep?.contract) throw new Error(`${P.deployment} not found.`);
  pinDeployment("game", dep, dep.rpc ?? "https://koinos.armana.io", P.deployment);
  // Which chain is mainnet: deployment.json's pinned id, else the public node's (one read), else the known value.
  let expect: string | null = dep.chainId ?? null;
  if (!expect) { try { expect = await withTimeout(new Provider([dep.rpc ?? "https://koinos.armana.io"]).getChainId(), 5000); } catch { expect = "EiBZK_GGVP0H_fXVAM3j6EAuz3-B-l3ejxRSewi7qIBfSA=="; } }
  let node: { rpc: string; lib: number; headId: string } | null;
  if (rpcArg) {
    if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(rpcArg)) throw new Error("--rpc must be a node on this computer (http://127.0.0.1:<port>).");
    const pr = new Provider([rpcArg]);
    const head: any = await withTimeout(pr.getHeadInfo(), 5000);
    if ((await pr.getChainId()) !== expect) throw new Error(`${rpcArg} is not a mainnet node.`);
    node = { rpc: rpcArg, lib: Number(head.last_irreversible_block), headId: head.head_topology.id };
  } else {
    log("Looking for a Koinos node on this computer (127.0.0.1) ...");
    node = await findLocalNode(expect);
    if (!node) throw new Error(`No mainnet node answered on this computer (ports ${LOCAL_PORTS.join(", ")}). Is Docker running? If your node uses another port, add --rpc http://127.0.0.1:<port>.`);
  }
  const pubLib = await withTimeout(new Provider([dep.rpc ?? "https://koinos.armana.io"]).getHeadInfo(), 5000).then((h: any) => Number(h.last_irreversible_block)).catch(() => 0);
  log(`Using your node at ${node.rpc} (final block ${node.lib.toLocaleString()})${pubLib && pubLib - node.lib > 200 ? ` — it is ${(pubLib - node.lib).toLocaleString()} blocks behind the network, so the newest windows are skipped` : ""}.\n`);
  const provider = new Provider([node.rpc]);
  const local = new KoinosChain(node.rpc, dep.contract);   // the contract's records, read through YOUR node too
  const since = Date.now() - days * DAY_MS;
  let checked = 0, pending = 0, bad = 0;
  const lines: string[] = [];
  for (const { data } of dayFiles(P)) for (const q of data.questions ?? []) {
    if (q.chainId === undefined || !q.windowEnd) continue;
    if (data.date && Date.parse(data.date) < since - DAY_MS) continue;
    if (q.windowEnd > node.lib) { pending++; continue; }
    const oc = (await local.read("get_question", { id: q.chainId })).question ?? {};
    const outcome = num(oc.outcome);
    if (outcome === 0) { pending++; continue; }
    // The question on chain must be this file's question (audit L-8): the same parameters hash.
    {
      const onChain = String(oc.params_hash ?? "").replace(/^0x/, "").toLowerCase();
      if (onChain !== paramsHashOf(q)) {
        bad++;
        lines.push(`VERIFY-ALERT ✖ ${q.id} (#${q.chainId}): the question on chain (params hash ${onChain.slice(0, 12)}…) is not this file's question.`);
        continue;
      }
    }
    const blocks = await fetchRange(provider, node.headId, q.windowStart, q.windowEnd);
    const sc = scoreQuestion(q, blocks, { vhpReadings: q.vhpReadings ?? [] });
    // A result that can't be recounted is not a pass (audit L-8).
    if (!sc.ok) { bad++; lines.push(`VERIFY-ALERT ?  ${q.id} (#${q.chainId}): could not recount (${sc.reason})`); continue; }
    checked++;
    const mine = storedOutcome(sc.result), hashOk = String(oc.data_hash ?? "").replace(/^0x/, "").toLowerCase() === sc.result.dataHash;
    const show = (o: number) => (o === 1000 ? "void" : `option ${String.fromCharCode(64 + o)}`);
    if (mine === outcome && hashOk) lines.push(`✔  ${q.id} (#${q.chainId}): ${show(outcome)} — matches your node's blocks`);
    else {
      bad++;
      lines.push(`VERIFY-ALERT ✖ ${q.id} (#${q.chainId}): the contract says ${show(outcome)}, your node's blocks say ${show(mine)}${hashOk ? "" : " (and the blocks used differ)"}.`);
    }
  }
  for (const l of lines) log(l);
  log(`\n${checked} result(s) checked against your node, ${bad} disagree, ${pending} not final yet.`);
  try { fs.appendFileSync("verify-results.log", `${new Date().toISOString()} node ${node.rpc}: ${checked} checked, ${bad} disagree\n${lines.filter((l) => l.startsWith("VERIFY-ALERT")).map((l) => l + "\n").join("")}`); } catch {}
  if (bad) {
    log(`\n✖ Something disagrees. Results can still be corrected for about 21 hours after the week ends (after the October upgrade).`);
    log(`  Check the bot's latest run first (GitHub → Actions), then, to void a wrong result: npm run bot -- void <#> --send`);
    process.exitCode = 1;
  }
}

async function chainCheck() {
  const P = paths(E.GEN_DIR ?? "game-data");
  const dep = readJson(P.deployment, null), deskDep = readJson(path.join("desk-data", "deployment.json"), null);
  if (!dep?.contract) throw new Error(`${P.deployment} not found.`);
  const rpc = E.RPC ?? dep.rpc ?? "https://koinos.armana.io";
  pinDeployment("game", dep, rpc, P.deployment);
  if (deskDep?.contract) pinDeployment("desk", deskDep, rpc, path.join("desk-data", "deployment.json"));
  const provider = new Provider([rpc]);
  const checks: Check[] = [];
  const say = (ok: boolean, text: string) => checks.push({ ok, text });
  log(`Reading ${rpc} (read-only: nothing is signed or sent)\n`);

  // The chain id the website pins (deployment.json "chainId"; Koinos mainnet's is EiBZK_GGVP0H_fXVAM3j6EAuz3-B-l3ejxRSewi7qIBfSA==)
  const chainId = await provider.getChainId();
  say(!dep.chainId || dep.chainId === chainId, `chain id ${chainId} (deployment.json: ${dep.chainId ?? "not pinned yet: copy this value into game-data and desk-data deployment.json"})`);

  // The game
  const gm = await contractMetadata(provider, dep.contract);
  checks.push(...checkMeta(`game ${dep.contract}`, gm, dep.wasmSha256));
  const g = await new KoinosChain(rpc, dep.contract).read("get_state", {});
  const c = g.config ?? {}, t = g.totals ?? {};
  say(!dep.owner || c.owner === dep.owner, `game owner ${c.owner} (deployment.json: ${dep.owner ?? "not recorded"})`);
  say(!dep.operator || c.operator === dep.operator, `game operator ${c.operator} (deployment.json: ${dep.operator ?? "not recorded"})`);
  say(!c.pending_owner, `game ownership transfer: ${c.pending_owner ? `PENDING to ${c.pending_owner}` : "none"}`);
  const up = g.upgrade ?? {}, wd = g.seed_withdrawal ?? {};
  say(true, `game announced upgrade: ${num(up.eta) > 0 ? `sha256 ${String(up.hash).replace(/^0x/, "")}, from ${utc(num(up.eta))}  ← make sure this is the one you announced` : "none"}`);
  say(!(num(wd.eta) > 0), `game seed withdrawal: ${num(wd.eta) > 0 ? `ANNOUNCED (${showKoin(wd.vhp ?? 0)} VHP + ${showKoin(wd.koin ?? 0)} KOIN, from ${utc(num(wd.eta))})` : "none"}`);
  say(big(t.owner_share) === 0n, `game retired owner share: ${showKoin(t.owner_share ?? 0)} (must be 0)`);
  say(!c.paused, `game paused: ${!!c.paused}`);

  // The Desk
  if (deskDep?.contract) {
    const dm = await contractMetadata(provider, deskDep.contract);
    checks.push(...checkMeta(`desk ${deskDep.contract}`, dm, deskDep.wasmSha256));
    if (fs.existsSync("desk/abi/desk.koilib.json")) {
      const desk = new Contract({ id: deskDep.contract, abi: JSON.parse(fs.readFileSync("desk/abi/desk.koilib.json", "utf8")), provider });
      const d: any = (await (desk.functions as any).get_state({})).result ?? {};
      const dc = d.config ?? {};
      say(!deskDep.owner || dc.owner === deskDep.owner, `desk owner ${dc.owner} (deployment.json: ${deskDep.owner ?? "not recorded"})`);
      say(!deskDep.treasury || dc.treasury === deskDep.treasury, `desk treasury ${dc.treasury} (deployment.json: ${deskDep.treasury ?? "not recorded"})${dc.treasury === dc.owner ? "  (note: the treasury is the owner wallet)" : ""}`);
      const du = d.upgrade ?? {}, dt = d.treasury_change ?? {};
      say(true, `desk announced upgrade: ${num(du.eta) > 0 ? `sha256 ${String(du.hash).replace(/^0x/, "")}, from ${utc(num(du.eta))}  ← make sure this is yours` : "none"}`);
      say(!(num(dt.eta) > 0), `desk treasury change: ${num(dt.eta) > 0 ? `ANNOUNCED to ${dt.address}, from ${utc(num(dt.eta))}` : "none"}`);
      say(true, `desk fee ${num(dc.fee_bps) / 100}%, swaps ${showKoin(dc.min_swap ?? 0)} to ${big(dc.max_swap) > 0n ? showKoin(dc.max_swap) : "unlimited"} VHP, paused ${!!dc.paused}; holds ${showKoin(d.koin_balance ?? 0)} KOIN + ${showKoin(d.vhp_balance ?? 0)} VHP`);
    } else say(false, "desk: desk/abi/desk.koilib.json missing (build the desk once) — its state was not checked");
  }

  for (const x of checks) log(`${x.ok ? "  ✔" : "  ✖"} ${x.text}`);
  const bad = checks.filter((x) => !x.ok);
  if (bad.length) {
    log(`\n✖ ${bad.length} check(s) failed. Do not schedule or apply an upgrade until each one is understood.`);
    process.exitCode = 1;
  } else log("\n✔ Everything matches.");
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
  // a new owner / seed owner accepting a handover (v5): its key sits in .env only for that one step
  new: { key: "NEW_OWNER_WIF" },
};

async function act(role: string, method: string, args: any, send: boolean): Promise<boolean> {
  const P = paths(E.GEN_DIR ?? "game-data");
  const dep = readJson(P.deployment, null);
  if (!dep?.contract) throw new Error(`${P.deployment} not found — deploy first.`);
  const rpc = E.RPC ?? dep.rpc;
  pinDeployment("game", dep, rpc, P.deployment);
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
  // v6: staking in another game pulls VHP, or KOIN when `koin` is set.
  if (method === "deposit_to") pull.deposit_to = args.koin ? [dep.koin, "KOIN"] : [dep.vhp, "VHP"];
  if (pull[method]) calls.push({ contract: pull[method][0], abi: tokenAbi, method: "approve", args: { owner: signer.getAddress(), spender: dep.contract, value: String(args.amount) } });
  calls.push({ method, args });
  log(`As ${role} (${signer.getAddress()}) on ${rpc}, to the game contract ${dep.contract}:`);
  for (const c of calls) log(`  ${c.contract ? `${pull[method][1]}.` : ""}${c.method} ${JSON.stringify(c.args)}`);
  if (method === "seed_deposit_koin" || method === "deposit_koin" || (method === "deposit_to" && args.koin)) log(`  note: moving KOIN needs this wallet's Mana ≥ the amount (${showKoin(args.amount)}); the Mana moves with it.`);
  if (!send) { log("\nDry run only — nothing was sent. Add --send to send it."); return false; }
  const r = await chain.send(calls, [signer], { rcLimitKoin: 5 });
  log(r.ok ? `✔ done (Mana used ${showKoin(r.rcUsed)})  transaction ${r.txId}` : `✖ ${r.error}`);
  if (!r.ok) process.exitCode = 1;
  return r.ok;
}

/** The game contract on the network in deployment.json (read-only use). */
function gameChain(): KoinosChain {
  const P = paths(E.GEN_DIR ?? "game-data");
  const dep = readJson(P.deployment, null);
  if (!dep?.contract) throw new Error(`${P.deployment} not found — deploy first.`);
  const rpc = E.RPC ?? dep.rpc;
  pinDeployment("game", dep, rpc, P.deployment);
  return new KoinosChain(rpc, dep.contract);
}

/** Runs a vault pass (bot/vault.ts) by hand with one role's key: a dry run unless `sendIt`. */
async function vaultCommand(role: string, sendIt: boolean, fn: (v: VaultCtx, send: (what: string, calls: Call[]) => Promise<boolean>) => Promise<void>) {
  const P = paths(E.GEN_DIR ?? "game-data");
  const dep = readJson(P.deployment, null);
  const chain = gameChain();
  if (sendIt && isMainnet(chain.rpc) && E.CONFIRM_MAINNET !== "yes") throw new Error("MAINNET: add CONFIRM_MAINNET=yes to .env first.");
  const r0 = ROLES[role];
  const wif = E[r0.key] ?? (r0.fallback ? E[r0.fallback] : undefined);
  if (!wif) throw new Error(`${r0.key} is missing from .env`);
  const signer = Signer.fromWif(wif);
  signer.provider = chain.provider;
  log(`As ${role} (${signer.getAddress()}) on ${chain.rpc}, to the game contract ${chain.contractId}:`);
  const problems: string[] = [];
  await fn({ chain, operator: signer, dryRun: !sendIt, problems, deployment: dep }, async (what, calls) => {
    if (!sendIt) { log(`  [dry run] would send: ${what}`); for (const c of calls) log(`      ${c.method} ${JSON.stringify(c.args)}`); return true; }
    const r = await chain.send(calls, [signer], { rcLimitKoin: 5 });
    log(r.ok ? `  ✔ ${what}  (Mana used ${showKoin(r.rcUsed)})  transaction ${r.txId}` : `  ✖ ${what}: ${r.error}`);
    if (!r.ok) process.exitCode = 1;
    return r.ok;
  });
  for (const pr of problems) log(`  ⚠ ${pr}`);
  if (!sendIt) log("\nDry run only — nothing was sent. Add --send to send it.");
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
        log(`Your PERSONAL node's PUBLIC key (safe to share):\n  ${pub}\n\nRegister it for your own address on https://knodegames.com/producer.html (signed in Kondor).\nDo NOT register this one for the game contract.`);
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
        pinDeployment("game", dep, E.RPC ?? dep.rpc, paths(E.GEN_DIR ?? "game-data").deployment);
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

    // ─────────── Vault v6: games ───────────
    case "games": await vaultStatus(gameChain(), log); return true;
    case "game-add": {
      // game-add <id> "<name>" [--staked] [--free] [--season <weeks>]   announce a game (48-hour notice)
      const id = Number(need(0, "game id (2 or more)")), name = need(1, "game name");
      const si = a.indexOf("--season"), season = si >= 0 ? Number(a[si + 1]) : 1;
      if (!a.includes("--staked") && !a.includes("--free")) throw new Error("say what the game has: --staked (a stake bucket), --free (a free prize) or both");
      log(`This starts the 48-hour notice; the bot will email you about it (expected). After it, within 7 days:  npm run bot -- game-apply ${id} --send`);
      await act("owner", "propose_game", { game: id, name, staked: a.includes("--staked"), free_prize: a.includes("--free"), season_weeks: season }, send); return true;
    }
    case "game-apply": await act("owner", "apply_game", { game: Number(need(0, "game id")) }, send); return true;
    case "game-stop": {
      log("The game takes no new stakes from now and earns through this week. Players keep full access to their stake and can still claim what they won.");
      await act("owner", "deactivate_game", { game: Number(need(0, "game id")) }, send); return true;
    }
    case "game-correct": await act("owner", "correct_result", { game: Number(need(0, "game id")), week: need(1, "week"), player: need(2, "player address"), points: Number(need(3, "points (0 removes the player)")), remove_prize: false }, send); return true;
    case "game-unprize": await act("owner", "correct_result", { game: Number(need(0, "game id")), week: need(1, "week"), player: need(2, "player address"), points: 0, remove_prize: true }, send); return true;
    case "game-void": {
      log("The week's bucket rolls over within the game and its prize goes back to the pool.");
      await act("owner", "void_game_week", { game: Number(need(0, "game id")), week: need(1, "week") }, send); return true;
    }
    case "game-post": {
      // game-post <id> <week> [<folder or branch:folder>]   post a game's week from its results file, then seal it
      const id = Number(need(0, "game id")), w = Number(need(1, "week")), src = a[2] && !a[2].startsWith("--") ? a[2] : undefined;
      await vaultCommand("operator", send, (v, s) => vaultResultsPass(v, s, { game: id, week: w, source: src })); return true;
    }
    case "game-seal": await act("operator", "seal_results", { game: Number(need(0, "game id")), week: need(1, "week") }, send); return true;
    case "game-finalize": await act("operator", "finalize_game_week", { game: Number(need(0, "game id")), week: need(1, "week") }, send); return true;
    case "claim-fee-vhp": {
      const to = a[0] && !a[0].startsWith("--") && a[0] !== "all" && !/^[0-9.]+$/.test(a[0]) ? a[0] : me("owner");
      const amt = a.find((x, i) => i <= 1 && (x === "all" || /^[0-9.]+$/.test(x))) ?? "all";
      const owed = big((await gameChain().read("get_state", {})).totals?.fee_vhp);
      const amount = amt === "all" ? owed.toString() : units(amt);
      if (big(amount) === 0n) throw new Error("No fee is owed in VHP yet.");
      log(`Fee owed in VHP: ${showKoin(owed)}; claiming ${showKoin(amount)} to ${to}`);
      await act("owner", "claim_fee_vhp", { to, amount }, send); return true;
    }

    // ─────────── Vault v6: a player's stake in other games ───────────
    case "stake": await act("player", "deposit_to", { from: me("player"), game: Number(need(0, "game id")), amount: whole(need(1, "VHP (whole number)")), koin: false }, send); return true;
    case "stake-koin": await act("player", "deposit_to", { from: me("player"), game: Number(need(0, "game id")), amount: whole(need(1, "KOIN (whole number)")), koin: true }, send); return true;
    case "unstake": {
      const id = Number(need(0, "game id")), amt = need(1, "VHP (or: all)");
      if (id === 1) throw new Error("The question game uses: npm run bot -- withdraw <VHP|all>");
      let amount = amt === "all" ? "" : units(amt);
      if (!amount) {
        const p = (await gameChain().read("get_game_player", { player: me("player"), game: id, week: "0" })).player ?? {};
        amount = (big(p.stake) + big(p.pending)).toString();
        if (amount === "0") throw new Error("This wallet has nothing staked in that game.");
      }
      await act("player", "withdraw_from", { to: me("player"), game: id, amount }, send); return true;
    }
    case "move": {
      const from = Number(need(0, "from game id")), to = Number(need(1, "to game id")), amt = need(2, "VHP (or: all)");
      let amount = amt === "all" ? "" : units(amt);
      if (!amount) {
        const c = gameChain();
        const p = from === 1 ? (await c.read("get_player", { player: me("player"), week: "0" })).player ?? {}
          : (await c.read("get_game_player", { player: me("player"), game: from, week: "0" })).player ?? {};
        amount = (big(p.stake) + big(p.pending)).toString();
        if (amount === "0") throw new Error("This wallet has nothing staked in that game.");
      }
      log("No tokens move. The stake counts in the new game from next Monday; taking all of this week's stake out of a game ends your week there.");
      await act("player", "move_stake", { player: me("player"), from_game: from, to_game: to, amount }, send); return true;
    }
    case "claim-game": await act("player", "claim_game", { player: me("player"), game: Number(need(0, "game id")), week: need(1, "week") }, send); return true;
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
  const pub = new Provider([E.RPC ?? "https://koinos.armana.io"]);
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
  if (!TESTNET && !has("RPC")) add("RPC", "https://koinos.armana.io");
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
/** The environment the question generator runs with: everything except keys and tokens. The generator signs nothing,
 *  so it never gets the operator key (audit M-8): a compromised package it loads cannot read it. */
export function generatorEnv(env: NodeJS.ProcessEnv, dir: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (!/WIF|SECRET|TOKEN|PASSWORD|PRIVATE|(^|_)KEY$|^ACTIONS_ID_TOKEN|^ACTIONS_RUNTIME/i.test(k)) out[k] = v;
  return { ...out, GEN_DIR: dir };
}
export function generatorRunner(dir: string, extra: string[] = []) {
  return (args: string[]) => {
    const r = spawnSync(process.execPath, [require.resolve("tsx/cli"), "generator.ts", ...args, ...extra], {
      env: generatorEnv(process.env, dir), encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    });
    return { ok: r.status === 0, output: (r.stdout ?? "") + (r.stderr ?? "") };
  };
}

/** For the website's producer lookup: the last two days of blocks (signer, time, transaction count) as one compact
 *  file, so a visitor's browser reads one file instead of ~144 requests to the public node. The bot holds no push
 *  token (audit H-1): it writes the file to SNAPSHOT_OUT, and the workflow's publish job checks its shape and puts it
 *  on the branch "blocks-data" as a single commit that is replaced every run (no history piles up). Display only:
 *  the page spot-checks it against the chain and falls back to reading blocks itself if anything differs. */
const SNAPSHOT_BLOCKS = 57_600;
export function publishBlockSnapshot(P: Paths) {
  const out = E.SNAPSHOT_OUT;
  if (!out) return;
  try {
    const rows = readCsv(path.join(P.dir, "blocks.csv")).slice(-SNAPSHOT_BLOCKS);
    if (rows.length < 1000) return;
    for (let i = 1; i < rows.length; i++) if (rows[i].h !== rows[i - 1].h + 1) throw new Error(`gap in the block history at ${rows[i].h}`);
    const signers: string[] = [], idx = new Map<string, number>();
    const sig = rows.map((b) => { let i = idx.get(b.signer); if (i === undefined) { i = signers.length; signers.push(b.signer); idx.set(b.signer, i); } return i; });
    const dts = rows.map((b, i) => (i === 0 ? 0 : b.ts - rows[i - 1].ts));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify({ v: 1, made: new Date().toISOString(), from: rows[0].h, top: rows[rows.length - 1].h, t0: rows[0].ts, signers, sig, dts, ntx: rows.map((b) => b.ntx) }));
    log(`  wrote the block snapshot (${rows.length.toLocaleString()} blocks, to ${rows[rows.length - 1].h})`);
  } catch (e) {
    log(`  ⚠ block snapshot not written: ${(e as Error).message}`);
  }
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

/** The mainnet contracts, pinned in code: an edit to the (unsealed) deployment.json cannot point the bot at another
 *  contract (audit F-03, Info). A deliberate change sets CONTRACT_ADDRESS / DESK_CONTRACT_ADDRESS. */
export const PINNED_MAINNET = {
  game: "1Mpmf2ERhjYpX7CCiM11WERuM4j17uT1sr", desk: "1FKTpXBhhHEbu5vVchM8UsVbAvPArJsRmR",
  koin: "19GYjDBVXU7keLbYvMLazsGQn3GTWHjHkK", vhp: "12Y5vW6gk8GceH53YfRkRre2Rrcsgw7Naq", pob: "159myq5YUhhoVWu3wsHKHiJYKPKGUrGiyv",
  // The Mana sponsor wallet (created by the owner 2026-10-26). npm run sponsor refuses any other key on mainnet.
  sponsor: "1ByDDSBUzy5zkRceELc54Jh8i41yNRoKt8",
};

/** Audit M-5: on mainnet, every command that signs or reads with a key uses only the pinned contract and token
 *  addresses, whatever deployment.json says (a changed deployment.json could otherwise point a signed owner or seed
 *  transaction at a look-alike contract). A deliberate move to a new contract sets CONTRACT_ADDRESS /
 *  DESK_CONTRACT_ADDRESS and updates PINNED_MAINNET. Fills in missing token addresses; throws on any mismatch. */
export function pinDeployment(which: "game" | "desk", dep: any, rpc: string, file: string) {
  if (!isMainnet(rpc)) return dep;
  const want = (which === "game" ? E.CONTRACT_ADDRESS : E.DESK_CONTRACT_ADDRESS) ?? PINNED_MAINNET[which];
  if (dep.contract !== want) throw new Error(`${file} names the ${which} contract ${dep.contract}, not ${want}. If that change is intended, set ${which === "game" ? "CONTRACT_ADDRESS" : "DESK_CONTRACT_ADDRESS"} (and update PINNED_MAINNET in bot/bot.ts).`);
  for (const k of ["koin", "vhp", "pob"] as const) {
    if (dep[k] !== undefined && dep[k] !== PINNED_MAINNET[k]) throw new Error(`${file} names the ${k.toUpperCase()} token ${dep[k]}, not the Koinos system contract ${PINNED_MAINNET[k]}. Refusing to sign anything.`);
    dep[k] = PINNED_MAINNET[k];
  }
  return dep;
}

/** How far the two nodes' VHP values may differ (basis points) for a reading to be kept: block rewards move balances a
 *  little between the two reads; a VHP-swing void needs a far larger move. */
const VHP_AGREE_BPS = 50;

function liveCtx(dryRun: boolean): Ctx {
  const P = paths(E.GEN_DIR ?? "game-data");
  const dep = readJson(P.deployment, null);
  const contract = E.CONTRACT_ADDRESS ?? dep?.contract;
  if (!contract) throw new Error(`No contract yet: ${P.deployment} is missing (run deploy) or set CONTRACT_ADDRESS.`);
  const rpc = E.RPC ?? dep?.rpc ?? "https://koinos.armana.io";
  if (isMainnet(rpc) && !E.CONTRACT_ADDRESS && contract !== PINNED_MAINNET.game)
    throw new Error(`${P.deployment} names the game contract ${contract}, not ${PINNED_MAINNET.game}. If that change is intended, set CONTRACT_ADDRESS (and update PINNED_MAINNET in bot/bot.ts).`);
  if (dep) pinDeployment("game", { ...dep, contract }, rpc, P.deployment);
  // A second, independent node for cross-checks (audit M-4). The workflow sets one by default; "off" turns it off.
  const rpcCheck = E.RPC_CHECK && E.RPC_CHECK !== "off" && E.RPC_CHECK !== rpc ? E.RPC_CHECK : "";
  const chain = new KoinosChain(rpc, contract);
  const operator = E.OPERATOR_WIF ? Signer.fromWif(E.OPERATOR_WIF) : Signer.fromSeed("read-only placeholder");
  operator.provider = chain.provider;
  if (!dryRun && !E.OPERATOR_WIF) throw new Error("OPERATOR_WIF is missing (use --dry-run to look without a key).");
  const deskDep = readJson(path.join("desk-data", "deployment.json"), null);
  if (deskDep && isMainnet(rpc)) deskDep.contract = E.DESK_CONTRACT_ADDRESS ?? PINNED_MAINNET.desk;
  const deskContract = deskDep?.contract && fs.existsSync("desk/abi/desk.koilib.json")
    ? new Contract({ id: deskDep.contract, abi: JSON.parse(fs.readFileSync("desk/abi/desk.koilib.json", "utf8")), provider: chain.provider }) : null;
  const pob = new Contract({ id: dep?.pob ?? MAINNET.pob, abi: pobAbi as any, provider: chain.provider });
  return {
    chain, operator, P, dryRun, generator: generatorRunner(P.dir), checkpoint: gitCheckpoint(P.dir), problems: [], noSealKey: !E.OPERATOR_WIF,
    releaseWaitMs: 12 * 60_000,
    previousOperator: E.PREVIOUS_OPERATOR_WIF ? Signer.fromWif(E.PREVIOUS_OPERATOR_WIF) : undefined,
    // Window blocks are read fresh from the chain for every resolution; the cached blocks.csv is never trusted for that.
    windowBlocks: async (from, to) => {
      const head: any = await chain.provider.getHeadInfo();
      const last = Math.min(to, Number(head.last_irreversible_block));
      return last < from ? [] : fetchRange(chain.provider, head.head_topology.id, from, last);
    },
    ...(rpcCheck ? { crossCheckBlocks: async (from: number, to: number) => {
      const second = new Provider([rpcCheck]);
      const head: any = await second.getHeadInfo();
      const last = Math.min(to, Number(head.last_irreversible_block));
      return last < from ? [] : fetchRange(second, head.head_topology.id, from, last);
    } } : {}),
    metadata: (c) => contractMetadata(chain.provider, c),
    // VHP readings decide VHP-swing voids, so they are read from both nodes too (audit M-4): a reading is kept only if
    // the second node agrees (same values within VHP_AGREE_BPS, heads within a minute). Otherwise this hour's reading is
    // skipped and reported; the next run reads again.
    vhp: async (who) => {
      const vhpAddr = isMainnet(rpc) ? MAINNET_VHP : (dep?.vhp ?? MAINNET_VHP);
      const a = await readVhp(chain.provider, vhpAddr, who);
      if (!rpcCheck) return a;
      const b = await readVhp(new Provider([rpcCheck]), vhpAddr, who);
      if (Math.abs(a.height - b.height) > 20) throw new Error(`the two nodes are ${Math.abs(a.height - b.height)} blocks apart (RPC ${a.height}, RPC_CHECK ${b.height}); VHP reading skipped this run`);
      for (const w of Object.keys(a.values)) {
        const x = BigInt(a.values[w]), y = BigInt(b.values[w] ?? "-1");
        const diff = x > y ? x - y : y - x, base = x > y ? x : y;
        if (y < 0n || diff * 10_000n > base * BigInt(VHP_AGREE_BPS)) throw new Error(`the two nodes disagree about the VHP of ${w} (RPC ${a.values[w]}, RPC_CHECK ${b.values[w] ?? "none"}); VHP reading skipped this run. One node is wrong or lying: check both.`);
      }
      return a;
    },
    producerKey: async (producer) => String(((await (pob.functions as any).get_public_key({ producer })).result ?? {}).value ?? ""),
    desk: deskContract ? { deployment: deskDep, read: async (method, args = {}) => ((await (deskContract.functions as any)[method](args)).result ?? {}) } : undefined,
    // The same block history the question generator uses (game-data/blocks.csv), topped up to the newest final block.
    // Hourly, for the production count only: older rows are spot-checked (the generator checks its newest days in full).
    recentBlocks: async () => (await syncBlocks(chain.provider, path.join(P.dir, "blocks.csv"), 26, undefined, { checkAllDays: 0 })).blocks,
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
    if (!ctx.dryRun) publishBlockSnapshot(ctx.P);
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
  if (cmd === "upgrade") return upgrade(rest[0] && !rest[0].startsWith("--") ? rest[0] : undefined, flag("--send"), flag("--bot-pays"), flag("--safe"));
  if (cmd === "chain-check") return chainCheck();
  if (cmd === "verify-results") return verifyResults(Number(opt("--days", "3")), opt("--rpc"));
  if (await friendly(cmd, rest, flag("--send"))) return;
  if (cmd === "rehearse") { const { rehearse } = await import("./rehearse.ts"); return rehearse({ weeks: Number(opt("--weeks", "3")), verbose: flag("--verbose") }); }
  // Vault v6: copy the live contract's state to a file (read-only, no key), and rehearse the upgrade on that copy.
  if (cmd === "vault-snapshot") { const { snapshotCommand } = await import("./rehearse-v6.ts"); return snapshotCommand(gameChain(), opt("--out", "v5-snapshot.json")!); }
  if (cmd === "rehearse-v6") { const { rehearseCommand } = await import("./rehearse-v6.ts"); return rehearseCommand(opt("--snapshot", "v5-snapshot.json")!, Number(opt("--weeks", "3")), opt("--reward")); }
  throw new Error(`Unknown command "${cmd}". See bot/README.md for the list of commands.`);
}

if (process.argv[1] && /bot\.ts$/.test(process.argv[1])) {
  main().catch((e) => { console.error(`\n✖ ${e.message ?? e}`); process.exit(1); });
}

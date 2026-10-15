/**
 * KPRED OPERATOR BOT — keeps the weekly game running. Every command is safe to run again at any time.
 *
 *   npm run bot -- status                     what the game looks like right now (read-only, no key needed)
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

export const DAY = 28_800;               // blocks per day (3-second blocks)
const RESOLVE_MARGIN = 60;               // the contract resolves only after window_end + 60
const RESOLVE_SLACK = 1_200;             // windows must end ≥ 1 hour before the week can close, so the bot has time
const MIN_ANSWER_TIME = 1_200;           // never post a question with less than ~1 hour left to answer
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

type BotState = { checkedUpTo: number; orphans: number[]; lastCompound: number; warnings: string[] };
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
  quiet?: boolean;
};

const num = (x: any) => Number(x ?? 0);
const big = (x: any) => BigInt(x ?? 0);

async function state(ctx: Ctx) {
  const s = await ctx.chain.read("get_state", {});
  const c = s.config ?? {}, t = s.totals ?? {};
  return {
    raw: s, c, t,
    height: num(s.height), genesis: num(c.genesis_height), weekBlocks: num(c.week_blocks), closeDelay: num(c.close_delay),
    weeksClosed: num(t.weeks_closed), weeksFinalized: num(t.weeks_finalized), nextId: num(t.next_question_id),
  };
}
const weekEnd = (st: { genesis: number; weekBlocks: number }, w: number) => st.genesis + (w + 1) * st.weekBlocks;

async function sendOp(ctx: Ctx, what: string, calls: Call[], opts: { sponsored?: boolean } = {}): Promise<boolean> {
  if (ctx.dryRun) { log(`  [dry run] would send: ${what}`); return true; }
  let r = await ctx.chain.send(calls, [ctx.operator], opts);
  if (!r.ok && opts.sponsored) {
    // The contract only sponsors what it can verify is valid; if it declines, the bot pays instead.
    r = await ctx.chain.send(calls, [ctx.operator], {});
  }
  if (r.ok) { if (!ctx.quiet) log(`  ✔ ${what}${r.rcUsed && r.rcUsed !== "0" ? `  (Mana ${showKoin(r.rcUsed)})` : ""}`); }
  else log(`  ✖ ${what}: ${r.error}`);
  return r.ok;
}

// ═══════════════════════════════ the tick ═══════════════════════════════

export async function tick(ctx: Ctx) {
  const P = ctx.P;
  const st0 = await state(ctx);
  if (!st0.c.owner) throw new Error("The contract is not initialised yet (run deploy first).");
  if (st0.weekBlocks % DAY !== 0) throw new Error(`week_blocks (${st0.weekBlocks}) must be a whole number of days`);
  const bs: BotState = { checkedUpTo: 0, orphans: [], lastCompound: 0, warnings: [], ...readJson(P.botState) };
  const save = () => { if (!ctx.dryRun) writeJson(P.botState, bs); };

  await resolvePass(ctx, bs);
  save();
  await postPass(ctx, bs);
  save();
  await closeFinalizePass(ctx);
  await settlePass(ctx);
  await compoundPass(ctx, bs);
  save();
  ctx.checkpoint("bot: tick");
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
  if (st.height > weekEnd(st, st.weeksClosed) + st.closeDelay + 2 * RESOLVE_SLACK && num(wk.resolved) < num(wk.questions) && bs.checkedUpTo > 0) {
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

  // Local questions: compute results from block data (generator), then post them.
  let ranGenerator = false;
  for (let pass = 0; pass < 2; pass++) {
    let needGenerator = false;
    for (const f of dayFiles(ctx.P)) {
      let dirty = false;
      for (const q of f.data.questions ?? []) {
        if (q.chainId === undefined || q.chainOutcome !== undefined) continue;
        const onChain = (await ctx.chain.read("get_question", { id: q.chainId })).question;
        if (num(onChain.outcome) !== 0) {
          q.chainOutcome = num(onChain.outcome);
          dirty = true;
          const mine = q.result ? (q.result.void ? 1000 : q.result.option + 1) : undefined;
          if (mine !== undefined && mine !== q.chainOutcome) log(`  ⚠ ${q.id} (#${q.chainId}): on-chain outcome ${q.chainOutcome} differs from the computed one ${mine} (corrected by the owner?)`);
          continue;
        }
        if (!due(onChain)) continue;
        if (!q.result) { needGenerator = true; continue; }
        const outcome = q.result.void ? 1000 : q.result.option;
        const dataHash = "0x" + (q.result.dataHash ?? sha256hex(`void: ${q.result.reason}`));
        const label = q.result.void ? `VOID (${q.result.reason})` : `option ${String.fromCharCode(65 + q.result.option)} (actual ${q.result.value})`;
        if (await sendOp(ctx, `resolve ${q.id} (#${q.chainId}) → ${label}`, [{ method: "resolve_question", args: { id: q.chainId, outcome, data_hash: dataHash } }])) {
          q.chainOutcome = outcome === 1000 ? 1000 : outcome + 1;
          dirty = true;
        }
      }
      if (dirty && !ctx.dryRun) writeJson(f.file, f.data);
    }
    if (!needGenerator || ranGenerator) break;
    // Some finished questions have no result yet: let the generator read the blocks and work them out.
    ranGenerator = true;
    const g = ctx.generator(["resolve"]);
    if (!g.ok) { log(`  ✖ resolving from block data failed:\n${g.output.slice(-1500)}`); break; }
  }
}

// ───────────── post today's questions ─────────────

async function postPass(ctx: Ctx, bs: BotState) {
  const st = await state(ctx);
  const { height } = await ctx.chain.head();
  if (height < st.genesis) { if (!ctx.quiet) log(`  the game starts at block ${st.genesis} (now ${height}) — nothing to post yet`); return; }
  const daysPerWeek = st.weekBlocks / DAY;
  const d = Math.floor((height - st.genesis) / DAY);
  const w = Math.floor(d / daysPerWeek), dd = d % daysPerWeek;
  const label = `W${SPACE(w)}-D${dd + 1}`;
  const file = path.join(ctx.P.questions, `${label}.json`);
  const wEnd = weekEnd(st, w);
  if (st.weeksClosed > w) return; // (only possible right at a boundary)

  if (!fs.existsSync(file)) {
    const maxEnd = wEnd + st.closeDelay - RESOLVE_MARGIN - RESOLVE_SLACK;
    log(`  releasing ${label} (week ${w}, day ${dd + 1}) — answers must close by ${wEnd}, windows must end by ${maxEnd}`);
    if (ctx.dryRun) { log(`  [dry run] would run the generator and post its questions`); return; }
    const g = ctx.generator(["release", "--label", label, "--week", String(w), "--day", String(dd % 7),
      "--max-lock", String(wEnd), "--max-end", String(maxEnd)]);
    if (!g.ok) {
      if (/Too late in the week/i.test(g.output)) {
        writeJson(file, { date: label, week: w, day: dd + 1, questions: [], skipped: "too late in the week to release questions" });
        log(`  skipped ${label}: too late in the week`);
      } else log(`  ✖ the generator failed (will retry next run):\n${g.output.slice(-1500)}`);
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
    const head = (await ctx.chain.head()).height;
    if (q.lockHeight - head < MIN_ANSWER_TIME) {
      q.postSkipped = `posted too late: answers would close in ${q.lockHeight - head} blocks`;
      log(`  skipped ${q.id}: ${q.postSkipped}`);
      writeJson(file, cur);
      continue;
    }
    const before = await state(ctx);
    const args = { k: q.options.length, lock_height: String(q.lockHeight), window_start: String(q.windowStart), window_end: String(q.windowEnd), params_hash: "0x" + q.paramsHash };
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
  for (let i = 0; i < 4; i++) {
    const st = await state(ctx);
    const h = (await ctx.chain.head()).height;
    const w = st.weeksClosed;
    const wk = (await ctx.chain.read("get_week", { week: String(w) })).week ?? {};
    if (h >= weekEnd(st, w) + st.closeDelay && num(wk.resolved) === num(wk.questions)) {
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
  const h = (await ctx.chain.head()).height;
  for (let w = st.weeksFinalized; w < st.weeksClosed; w++) {
    const wk = (await ctx.chain.read("get_week", { week: String(w) })).week ?? {};
    if (h < num(wk.settle_start) || h > num(wk.settle_end)) continue;
    const todo = (await allPlayers(ctx.chain, w)).filter((r) => r.entry && !r.entry.settled);
    if (todo.length) log(`  settling ${todo.length} player(s) for week ${w}`);
    let n = 0;
    for (const r of todo) {
      if (await sendOp(ctx, `settle ${r.address} for week ${w}`, [{ method: "settle", args: { player: r.address, week: String(w) } }], { sponsored: true })) n++;
    }
    if (todo.length) log(`  settled ${n}/${todo.length}`);
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
  const w = height < st.genesis ? 0 : Math.floor((height - st.genesis) / st.weekBlocks);
  log(`Contract ${ctx.chain.contractId}  (${ctx.chain.kind})   block ${height} (irreversible ${lib})`);
  log(height < st.genesis ? `Game starts at block ${st.genesis} (in ~${((st.genesis - height) * 3 / 3600).toFixed(1)} h)`
    : `Week ${w}: ends at block ${weekEnd(st, w)} (in ~${((weekEnd(st, w) - height) * 3 / 3600).toFixed(1)} h)`);
  log(`Weeks closed ${st.weeksClosed}, finalized ${st.weeksFinalized}; questions posted ${st.nextId}`);
  log(`Holdings  ${showKoin(holdings)}  (VHP ${showKoin(st.raw.vhp_balance)} + KOIN ${showKoin(st.raw.koin_balance)})   contract Mana ${showKoin(st.raw.mana)}`);
  log(`Owed      ${showKoin(owed)}  = stakes ${showKoin(t.total_stake)} + seed ${showKoin(big(t.seed_vhp) + big(t.seed_koin))} + fee ${showKoin(t.creator_fee)} + owner share ${showKoin(t.owner_share)} + unclaimed pots ${showKoin(t.pots_outstanding)}`);
  log(`Earned since the last close (not yet split): ${showKoin(holdings - owed)}`);
  for (let k = Math.max(0, st.weeksClosed - 2); k <= Math.min(w, st.weeksClosed); k++) {
    const r = await ctx.chain.read("get_week", { week: String(k) });
    const wk = r.week ?? {};
    log(`  week ${k}: ${num(wk.questions)} questions (${num(wk.resolved)} resolved)` + (wk.closed
      ? `, gain ${showKoin(wk.gain)} → pot ${showKoin(wk.pot)}; ${num(wk.eligible_players)} eligible` + (wk.finalized ? `, cutoff ${num(wk.cutoff)} pts, ${num(wk.winners)} winner(s), claimed ${showKoin(wk.claimed)}${wk.rolled_over ? " (rolled over)" : ""}` : `, settling until block ${num(wk.settle_end)}`)
      : ""));
  }
  if (ctx.chain.kind === "koinos") log(`Operator ${ctx.operator.getAddress()} Mana ${showKoin(await ctx.chain.mana(ctx.operator.getAddress()))}`);
}

// ═══════════════════════════════ deploy ═══════════════════════════════

const WASM = "game/build/release/contract.wasm";

async function tokenAddresses(provider: Provider): Promise<{ koin: string; vhp: string; pob: string }> {
  if (E.KOIN_ADDRESS && E.VHP_ADDRESS && E.POB_ADDRESS) return { koin: E.KOIN_ADDRESS, vhp: E.VHP_ADDRESS, pob: E.POB_ADDRESS };
  // Every block mints KOIN to its signer and burns VHP from it: the busiest minter/burner are the KOIN/VHP contracts,
  // and the burner of KOIN in a burn transaction is PoB. PoB is taken from .env or the probe results.
  const head: any = await provider.getHeadInfo();
  const h = Number(head.head_topology.height);
  const res: any = await provider.call("block_store.get_blocks_by_height", {
    head_block_id: head.head_topology.id, ancestor_start_height: String(h - 30), num_blocks: 30, return_block: true, return_receipt: true,
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
  const probe = readJson("probes/probe-state.json");
  const koin = top(mint) ?? probe.koin, vhp = top(burn) ?? probe.vhp, pob = E.POB_ADDRESS ?? probe.pob;
  if (!koin || !vhp || !pob) throw new Error("Could not find the KOIN/VHP/PoB contracts — set KOIN_ADDRESS, VHP_ADDRESS and POB_ADDRESS in .env");
  return { koin, vhp, pob };
}

/** Block height of the next Monday 00:00 UTC, from the recent average block time. */
async function nextMondayHeight(provider: Provider): Promise<{ height: number; when: string; msPerBlock: number }> {
  const head: any = await provider.getHeadInfo();
  const h = Number(head.head_topology.height);
  const at = async (height: number) => {
    const r: any = await provider.call("block_store.get_blocks_by_height", { head_block_id: head.head_topology.id, ancestor_start_height: String(height), num_blocks: 1, return_block: true });
    return Number(r.block_items[0].block.header.timestamp);
  };
  const [t0, t1] = [await at(h - DAY), await at(h)];
  const msPerBlock = (t1 - t0) / DAY;
  const d = new Date(t1);
  d.setUTCDate(d.getUTCDate() + (((8 - d.getUTCDay()) % 7) || 7));
  d.setUTCHours(0, 0, 0, 0);
  return { height: h + Math.round((d.getTime() - t1) / msPerBlock), when: d.toISOString(), msPerBlock };
}

async function deploy(send: boolean) {
  const rpc = E.RPC ?? "https://api.koinos.io";
  const mainnet = !/harbinger/i.test(rpc);
  if (send && mainnet && E.CONFIRM_MAINNET !== "yes") throw new Error(`RPC is ${rpc} (MAINNET, real KOIN). Add CONFIRM_MAINNET=yes to .env if you really mean it.`);
  const need = (k: string) => { if (!E[k]) throw new Error(`${k} is missing from .env`); return E[k]!; };
  const contractKey = Signer.fromWif(need("CONTRACT_WIF"));
  const operator = Signer.fromWif(need("OPERATOR_WIF"));
  const owner = need("OWNER_ADDRESS"), seedOwner = E.SEED_OWNER_ADDRESS ?? owner;
  const provider = new Provider([rpc]);
  contractKey.provider = provider; operator.provider = provider;
  const P = paths(E.GEN_DIR ?? "game-data");
  const prior = readJson(P.deployment, null);
  if (prior?.contract && prior.contract !== contractKey.getAddress()) throw new Error(`${P.deployment} already records contract ${prior.contract}. Move it away to deploy a new one.`);

  if (!fs.existsSync(WASM)) throw new Error(`${WASM} not found — in the game folder run: npm run build && npm run check`);
  const wasm = fs.readFileSync(WASM);
  if (wasm.indexOf(Buffer.from("TEST LEDGER", "utf16le")) !== -1) throw new Error("This is the TEST build (simulated token ledger). Run `npm run build` in the game folder.");
  const abi = loadAbi();
  const tokens = await tokenAddresses(provider);
  const C = contractKey.getAddress();
  const koinC = new Contract({ id: tokens.koin, abi: tokenAbi as any, provider });
  const vhpC = new Contract({ id: tokens.vhp, abi: tokenAbi as any, provider });
  const bal = async (c: Contract, a: string) => BigInt(((await (c.functions as any).balance_of({ owner: a })).result?.value) ?? 0);
  const [cKoin, cVhp] = [await bal(koinC, C), await bal(vhpC, C)];
  const opMana = BigInt(await provider.getAccountRc(operator.getAddress()));
  const g = E.GENESIS_HEIGHT ? { height: Number(E.GENESIS_HEIGHT), when: "(set in .env)", msPerBlock: 3000 } : await nextMondayHeight(provider);
  const n = (k: string, d: number) => String(E[k] ? Number(E[k]) : d);
  const init = {
    owner, operator: operator.getAddress(), seed_owner: seedOwner, genesis_height: String(g.height),
    week_blocks: n("WEEK_BLOCKS", 7 * DAY), close_delay: n("CLOSE_DELAY", DAY), settle_blocks: n("SETTLE_BLOCKS", 2 * DAY),
    timelock_blocks: n("TIMELOCK_BLOCKS", 2 * DAY), min_stake: n("MIN_STAKE", 100_000_000), max_sponsor_rc: n("MAX_SPONSOR_RC", 200_000_000),
  };
  const hash = sha256hex(wasm);
  log(`Network            ${rpc}${mainnet ? "   ⚠ MAINNET" : ""}`);
  log(`Contract address   ${C}   (holds ${showKoin(cKoin)} KOIN, ${showKoin(cVhp)} VHP — must be 0 before setup)`);
  log(`Code               ${WASM}, ${(wasm.length / 1024).toFixed(1)} KB, sha256 ${hash}`);
  log(`Pays the Mana      operator ${operator.getAddress()} (has ${showKoin(opMana)} Mana; the upload needs ~${Math.ceil(wasm.length / 1024 * 0.8 + 5)})`);
  log(`Owner              ${owner}`);
  log(`Seed owner         ${seedOwner}`);
  log(`Week 0 starts      block ${g.height} ≈ ${g.when} (average block ${(g.msPerBlock / 1000).toFixed(3)} s)`);
  log(`Settings           week ${init.week_blocks} blocks, correction delay ${init.close_delay}, settlement ${init.settle_blocks}, timelock ${init.timelock_blocks},`);
  log(`                   min stake ${showKoin(init.min_stake)} VHP, sponsored tx limit ${showKoin(init.max_sponsor_rc)} Mana`);
  log(`Tokens             KOIN ${tokens.koin}  VHP ${tokens.vhp}  PoB ${tokens.pob}`);
  if (cKoin > 0n || cVhp > 0n) throw new Error("The contract address already holds tokens; they would count as the first week's earnings. Use a fresh CONTRACT_WIF.");
  if (!send) { log(`\nDry run only. Nothing was sent. Run again with --send to deploy.`); return; }

  const chain = new KoinosChain(rpc, C);
  const st: any = { network: mainnet ? "mainnet" : "harbinger", rpc, contract: C, owner, operator: operator.getAddress(), seedOwner, ...tokens, wasmSha256: hash, ...prior };
  if (!st.uploaded) {
    log("\n1/2 Uploading the contract (the operator pays the Mana, the contract key authorizes) ...");
    const c = new Contract({ id: C, abi, provider, signer: contractKey, bytecode: new Uint8Array(wasm) });
    const { operation } = await c.deploy({ abi: JSON.stringify(abi), authorizesCallContract: true, authorizesTransactionApplication: true, authorizesUploadContract: true, onlyOperation: true } as any);
    const tx = new (await import("koilib")).Transaction({ signer: operator, provider, options: { payer: operator.getAddress(), payee: operator.getAddress(), rcLimit: toSat(Math.min(Number(opMana) / 1e8 * 0.95, 60)).toString() } });
    await tx.pushOperation(operation);
    await tx.prepare();
    let t: any = tx.transaction;
    t = await operator.signTransaction(t);
    t = await contractKey.signTransaction(t);
    const { receipt, transaction } = await provider.sendTransaction(t);
    await transaction.wait("byBlock", 180_000);
    if ((receipt as any)?.reverted) throw new Error(`upload reverted: ${JSON.stringify((receipt as any).logs)}`);
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
  Object.assign(st, { genesis: Number(s1.config.genesis_height), weekBlocks: Number(s1.config.week_blocks), closeDelay: Number(s1.config.close_delay),
    settleBlocks: Number(s1.config.settle_blocks), timelockBlocks: Number(s1.config.timelock_blocks), minStake: s1.config.min_stake, maxSponsorRc: s1.config.max_sponsor_rc,
    genesisApprox: g.when, deployedAt: new Date().toISOString() });
  writeJson(P.deployment, st);
  log(`\nDone. Saved ${P.deployment} (commit it — it is public information).`);
  log(`Next: register the node's producer key (admin register_key), add the seed (admin seed_deposit_vhp / seed_deposit_koin), start the bot.`);
}

// ═══════════════════════════════ admin ═══════════════════════════════

async function admin(method: string, json: string, as: string, send: boolean) {
  const P = paths(E.GEN_DIR ?? "game-data");
  const dep = readJson(P.deployment, null);
  if (!dep?.contract) throw new Error(`${P.deployment} not found — deploy first.`);
  const rpc = E.RPC ?? dep.rpc;
  if (send && !/harbinger/i.test(rpc) && E.CONFIRM_MAINNET !== "yes") throw new Error("MAINNET: add CONFIRM_MAINNET=yes to .env first.");
  const keyName = ({ owner: "OWNER_WIF", seed: "SEED_WIF", operator: "OPERATOR_WIF" } as any)[as];
  if (!keyName) throw new Error("--as must be owner, seed or operator");
  if (!E[keyName]) throw new Error(`${keyName} is missing from .env`);
  const signer = Signer.fromWif(E[keyName]!);
  const chain = new KoinosChain(rpc, dep.contract);
  signer.provider = chain.provider;
  const abi = loadAbi();
  if (!abi.methods[method] || abi.methods[method].read_only) throw new Error(`unknown or read-only method ${method}`);
  const args = JSON.parse(json || "{}");
  const calls: Call[] = [];
  // Deposits pull tokens with transfer(from → contract), which the token only allows after an approve in the same transaction.
  const pull: Record<string, [string, string]> = { seed_deposit_vhp: [dep.vhp, "VHP"], seed_deposit_koin: [dep.koin, "KOIN"], deposit_vhp: [dep.vhp, "VHP"], deposit_koin: [dep.koin, "KOIN"] };
  if (pull[method]) calls.push({ contract: pull[method][0], abi: tokenAbi, method: "approve", args: { owner: signer.getAddress(), spender: dep.contract, value: String(args.amount) } });
  calls.push({ method, args });
  log(`As ${as} (${signer.getAddress()}) on ${rpc}:`);
  for (const c of calls) log(`  ${c.contract ? `${pull[method][1]}.` : ""}${c.method} ${JSON.stringify(c.args)}`);
  if (method === "seed_deposit_koin") log(`  note: moving KOIN needs the sender's Mana ≥ the amount (${showKoin(args.amount)}); the Mana moves with it.`);
  if (!send) { log("Dry run only. Add --send to send it."); return; }
  const r = await chain.send(calls, [signer], { rcLimitKoin: 5 });
  log(r.ok ? `✔ sent (Mana ${showKoin(r.rcUsed)})  ${r.txId}` : `✖ ${r.error}`);
  if (!r.ok) process.exitCode = 1;
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

/** In the scheduled GitHub run (BOT_GIT_PUSH=1), commit and push game-data/ so nothing posted is ever lost. */
function gitCheckpoint(dir: string) {
  return (message: string) => {
    if (E.BOT_GIT_PUSH !== "1") return;
    try {
      execSync(`git add ${dir}`, { stdio: "ignore" });
      if (!execSync("git status --porcelain " + dir, { encoding: "utf8" }).trim()) return;
      execSync(`git -c user.name="kpred-bot" -c user.email="kpred-bot@users.noreply.github.com" commit -q -m "${message}"`, { stdio: "ignore" });
      execSync("git pull -q --rebase && git push -q", { stdio: "inherit" });
    } catch (e) {
      log(`  ⚠ could not push ${dir}: ${(e as Error).message}`);
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
  return { chain, operator, P, dryRun, generator: generatorRunner(P.dir), checkpoint: gitCheckpoint(P.dir) };
}

async function main() {
  const [cmd = "status", ...rest] = process.argv.slice(2);
  const flag = (f: string) => rest.includes(f);
  const opt = (f: string, d?: string) => { const i = rest.indexOf(f); return i >= 0 ? rest[i + 1] : d; };
  if (cmd === "status") return status(liveCtx(true));
  if (cmd === "tick") {
    const ctx = liveCtx(flag("--dry-run"));
    log(`tick at ${new Date().toISOString()}${ctx.dryRun ? " (dry run)" : ""}`);
    await tick(ctx);
    return status(ctx);
  }
  if (cmd === "deploy") return deploy(flag("--send"));
  if (cmd === "admin") return admin(rest[0], rest[1] && !rest[1].startsWith("--") ? rest[1] : "{}", opt("--as", "owner")!, flag("--send"));
  if (cmd === "rehearse") { const { rehearse } = await import("./rehearse.ts"); return rehearse({ weeks: Number(opt("--weeks", "3")), verbose: flag("--verbose") }); }
  throw new Error(`Unknown command "${cmd}". Use status, tick, deploy, admin or rehearse.`);
}

if (process.argv[1] && /bot\.ts$/.test(process.argv[1])) {
  main().catch((e) => { console.error(`\n✖ ${e.message ?? e}`); process.exit(1); });
}

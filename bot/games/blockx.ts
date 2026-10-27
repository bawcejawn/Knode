/**
 * Who Signs Block X recorder (run every hour by .github/workflows/games.yml; read-only on the chain, holds no key).
 *
 * Each run:
 *  1. Targets. Every height that is a multiple of 2,400 is a target (round r = block r × 2,400). A target is recorded
 *     once its block is irreversible and the block (signer and time) matches on two independent nodes (RPC and
 *     RPC_CHECK). Until then it waits.
 *  2. The card. A correct pick scores min(3, top VHP ÷ picked VHP) with the VHP from the Producer Race card in force at
 *     the lock (the time of block X − 100, the first block that refuses a pick), read from the race recorder's files
 *     (race-data). A target whose card can't be found yet waits; after 3 days it is recorded as void (no points).
 *  3. The picks: every pick for the round from the Picks contract (game 2), on both nodes; they must agree. The chain
 *     locked them 100 blocks before the target. Each pick is stored with its time, points and whether the wallet may
 *     be ranked (holds 1 VHP or has a Knode stake when the target is recorded, like the race). Ranking is shown on
 *     the board; prizes are open to every wallet, guests included (owner's decision 2026-10-27), with picks on 3+ days.
 *  4. Leaderboards (board.json): Today, This week, Last week (with its prizes once final) and All time, by
 *     site/blockx-math.js, the same file the page runs. A week is final 12 hours after it ends (the correction window)
 *     when every target in it is recorded.
 *  5. Writes games-data/blockx/index.json, W<week>.json and board.json; the publish job puts them on the games-data
 *     branch for the website.
 *
 *   RPC, RPC_CHECK ("off" to skip the second node), BLOCKX_PREV (last run's files), BLOCKX_OUT, RACE_DATA (race files).
 *   npm run blockx         (or: npx tsx bot/games/blockx.ts)
 */
import { Provider, Contract } from "koilib";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { readVhp, MAINNET_VHP, withRetry } from "../../common.ts";
await import("../../site/race-math.js");
await import("../../site/blockx-math.js");
const M: any = (globalThis as any).KRaceMath;
const X: any = (globalThis as any).KBlockX;

const E = process.env;
const RPC = E.RPC || "https://api.koinos.io";
const RPC_CHECK = E.RPC_CHECK && E.RPC_CHECK !== "off" && E.RPC_CHECK !== RPC ? E.RPC_CHECK : "";
const LOOKBACK_BLOCKS = 3 * 28800;          // targets older than ~3 days: void if they still can't be recorded
const MAX_TARGETS_PER_RUN = 48;             // ~4 days of targets, so a long outage catches up over a few runs
const CORRECTION_MS = 12 * 3600000;         // a week's results are final 12 hours after it ends
const ONE_VHP = 100000000n;
const isAddr = (a: unknown) => typeof a === "string" && /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a);

/** A recorded pick: [player, producer, pick time (ms), points (hundredths), may be ranked (1/0)]. */
type Pick = [string, string, number, number, number];
type Target = {
  round: number; height: number; final: true; checked: number;
  signer: string | null; time: number; lockTime: number;
  card: { at: number; top: number; signerVhp: number | null } | null;
  void?: string; picks: Pick[];
};
type WeekFile = { v: 1; week: number; start: number; end: number; targets: Target[] };
export type RawPick = { player: string; producer: string; time: number };
type Opts = {
  p: any; check: any | null; prev?: string; out?: string; raceDir?: string;
  picksContract?: string | null;                                           // default: picks-data/deployment.json
  picksOf?: (node: any, round: number) => Promise<RawPick[]>;             // for the tests
  blockOf?: (node: any, height: number) => Promise<{ signer: string; time: number }>;
  rankedOf?: (who: string[]) => Promise<Set<string>>;
  head?: { height: number; time: number; lib: number };
};

// ── files ──
function readJson(dir: string | undefined, name: string): any {
  if (!dir) return null;
  const f = path.join(dir, name);
  try { if (fs.lstatSync(f).isSymbolicLink()) return null; return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; }
}
const wName = (w: number) => `W${String(w).padStart(3, "0")}.json`;
function loadWeek(dir: string | undefined, w: number): WeekFile {
  const fresh: WeekFile = { v: 1, week: w, start: M.weekStart(w), end: M.weekStart(w + 1), targets: [] };
  const old = readJson(dir, wName(w));
  if (!old || old.v !== 1 || old.week !== w || !Array.isArray(old.targets)) return fresh;
  fresh.targets = old.targets.filter((t: any) => t && Number.isInteger(t.round) && t.height === t.round * X.ROUND && t.final === true);
  return fresh;
}
function defaultPicksContract(): string | null {
  try { const d = JSON.parse(fs.readFileSync(new URL("../../picks-data/deployment.json", import.meta.url), "utf8")); return isAddr(d.contract) ? d.contract : null; } catch { return null; }
}

// ── chain reads ──
async function headOf(node: any) {
  const h: any = await withRetry("head", () => node.getHeadInfo());
  return { id: h.head_topology.id as string, height: Number(h.head_topology.height), time: Number(h.head_block_time), lib: Number(h.last_irreversible_block) };
}
function blockReader(node: any, headId: string) {
  return async (h: number) => {
    const res: any = await withRetry(`block ${h}`, () => node.call("block_store.get_blocks_by_height", { head_block_id: headId, ancestor_start_height: String(h), num_blocks: 1, return_block: true, return_receipt: false }));
    const it = res?.block_items?.[0];
    if (!it || Number(it.block_height) !== h) throw new Error(`block ${h} not returned`);
    return { signer: String(it.block.header.signer), time: Number(it.block.header.timestamp) };
  };
}
const PICKS_ABI = () => JSON.parse(fs.readFileSync(new URL("../../picks/abi/picks.koilib.json", import.meta.url), "utf8"));
async function readPicks(node: any, contract: string, round: number): Promise<RawPick[]> {
  const c = new Contract({ id: contract, abi: PICKS_ABI(), provider: node });
  const out: RawPick[] = [];
  let after: string | undefined;
  for (let page = 0; page < 1000; page++) {
    const r: any = await withRetry(`picks for round ${round}`, () => (c.functions as any).list_picks({ game: X.GAME_ID, round: String(round), ...(after ? { start_after: after } : {}), limit: 100 }));
    const rows = r?.result?.rows ?? [];
    for (const x of rows) {
      const ps = x.pick?.producers;
      if (isAddr(x.player) && Array.isArray(ps) && ps.length === 1 && isAddr(ps[0])) out.push({ player: x.player, producer: ps[0], time: Number(x.pick.time || 0) });
    }
    if (rows.length < 100) break;
    after = rows[rows.length - 1].player;
  }
  return out;
}
const GAME = (() => { try { return JSON.parse(fs.readFileSync(new URL("../../game-data/deployment.json", import.meta.url), "utf8")).contract as string; } catch { return ""; } })();
const GAME_ABI = () => JSON.parse(fs.readFileSync(new URL("../../game/abi/kpred.koilib.json", import.meta.url), "utf8"));
/** Who may be ranked for prizes: at least 1 VHP, or a Knode stake (the Mana sponsor's "real player" rule). */
async function readRanked(node: any, who: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (!who.length) return out;
  const vhp = (await readVhp(node, MAINNET_VHP, who)).values;
  for (const a of who) {
    if (BigInt(vhp[a] || "0") >= ONE_VHP) { out.add(a); continue; }
    if (!GAME) continue;
    try {
      const c = new Contract({ id: GAME, abi: GAME_ABI(), provider: node });
      const r: any = await withRetry(`Knode player ${a}`, () => (c.functions as any).get_player({ player: a, week: "0" }));
      const p = r?.result?.player ?? {};
      if (BigInt(p.stake || "0") + BigInt(p.pending || "0") > 0n) out.add(a);
    } catch { /* not ranked */ }
  }
  return out;
}

// ── the card in force at a time (race-data) ──
function cardAt(raceDir: string | undefined, t: number): any | null {
  const ra = M.raceAt(t);
  const wf = readJson(raceDir, wName(M.weekOf(ra.start)));
  const race = wf && Array.isArray(wf.races) ? wf.races.find((r: any) => r && r.id === ra.id) : null;
  if (!race || !Array.isArray(race.cards)) return null;
  const n = M.legsOf(race.cards);
  const c = M.cardForLeg(race.cards, M.legOf(ra.start, t, n));
  return c && Array.isArray(c.field) && c.field.length ? c : null;
}

/** One run. Exported for the tests, which pass fake nodes. */
export async function run(o: Opts) {
  const OUT = o.out ?? E.BLOCKX_OUT ?? "games-data/blockx";
  const PREV = o.prev ?? E.BLOCKX_PREV ?? "";
  const RACE = o.raceDir ?? E.RACE_DATA ?? "";
  const problems: string[] = [];
  const contract = o.picksContract === undefined ? defaultPicksContract() : o.picksContract;

  const live = o.head ? null : await headOf(o.p);
  const head = o.head ?? live!;
  const headId = live ? live.id : "";
  const blockP = o.blockOf ? (h: number) => o.blockOf!(o.p, h) : blockReader(o.p, headId);
  let blockC: ((h: number) => Promise<{ signer: string; time: number }>) | null = null;
  if (o.check) {
    if (o.blockOf) blockC = (h: number) => o.blockOf!(o.check, h);
    else { const ch = await headOf(o.check); blockC = blockReader(o.check, ch.id); }
  }
  const picksRead = o.picksOf ?? (contract ? (node: any, r: number) => readPicks(node, contract, r) : null);
  const rankedRead = o.rankedOf ?? ((who: string[]) => readRanked(o.p, who));
  console.log(`head ${head.height} (${new Date(head.time).toISOString()}), irreversible ${head.lib}`);

  // The weeks touched: the last 3 days and now.
  const weeks = new Map<number, WeekFile>();
  const weekFor = (w: number) => { let f = weeks.get(w); if (!f) { f = loadWeek(PREV, w); weeks.set(w, f); } return f; };
  const idx = readJson(PREV, "index.json");
  const known = new Set<number>(Array.isArray(idx?.weeks) ? idx.weeks.filter((w: any) => Number.isInteger(w) && w >= 0 && w < 10000) : []);
  const done = new Set<number>();
  const nowW = M.weekOf(head.time);
  for (const w of [nowW - 1, nowW]) if (w >= 0) for (const t of weekFor(w).targets) done.add(t.round);

  // ── 1–3. targets ──
  const firstRound = Math.max(1, Math.ceil((head.lib - LOOKBACK_BLOCKS) / X.ROUND));
  const lastRound = Math.floor(head.lib / X.ROUND);
  let n = 0;
  for (let r = firstRound; r <= lastRound && n < MAX_TARGETS_PER_RUN; r++) {
    if (done.has(r)) continue;
    n++;
    const h = r * X.ROUND, old = h < head.lib - LOOKBACK_BLOCKS + X.ROUND;
    try {
      const b = await blockP(h), lock = await blockP(h - X.LEAD);
      let checked = 1;
      if (blockC) {
        const b2 = await blockC(h), l2 = await blockC(h - X.LEAD);
        if (b2.signer !== b.signer || b2.time !== b.time || l2.time !== lock.time) { problems.push(`block ${h}: the two nodes disagree; not recorded this run`); continue; }
        checked = 2;
      }
      let raw: RawPick[] = [];
      if (picksRead) {
        raw = await picksRead(o.p, r);
        if (o.check) {
          const other = await picksRead(o.check, r);
          const key = (x: RawPick[]) => JSON.stringify([...x].sort((u, v) => (u.player < v.player ? -1 : 1)));
          if (key(raw) !== key(other)) { problems.push(`block ${h}: the two nodes disagree about the picks; not recorded this run`); continue; }
        }
      }
      const card = cardAt(RACE, lock.time);
      if (!card && !old) { problems.push(`block ${h}: no race card yet for ${new Date(lock.time).toISOString()}; tried again next run`); continue; }
      const ranked = await rankedRead([...new Set(raw.map((x) => x.player))]);
      const { m, top } = card ? X.vhpOf(card) : { m: new Map(), top: 0 };
      const picks: Pick[] = raw.map((x) => [x.player, x.producer, x.time, card ? X.pointsOf(card, x.producer, b.signer) : 0, ranked.has(x.player) ? 1 : 0]);
      const t: Target = {
        round: r, height: h, final: true, checked, signer: isAddr(b.signer) ? b.signer : null, time: b.time, lockTime: lock.time,
        card: card ? { at: Number(card.at) || 0, top, signerVhp: m.get(b.signer) ?? null } : null, picks,
      };
      if (!card) t.void = "no race card was recorded for this target's lock; no points";
      const wf = weekFor(M.weekOf(b.time));
      wf.targets = wf.targets.filter((x) => x.round !== r).concat([t]).sort((x, y) => x.round - y.round);
      done.add(r);
      console.log(`block ${h}: signed by ${b.signer}, ${picks.length} picks, ${picks.filter((x) => x[3] > 0).length} right, checked on ${checked} node(s)`);
    } catch (e) { problems.push(`block ${h}: ${(e as Error).message} (tried again next run)`); }
  }

  // ── 4. leaderboards ──
  const all = new Map(weeks);
  for (const w of known) if (!all.has(w)) all.set(w, loadWeek(PREV, w));
  const rowsOf = (from: number, to: number) => {
    const rows: any[] = [];
    for (const wf of all.values()) for (const t of wf.targets) {
      if (t.time < from || t.time >= to || t.void) continue;
      for (const [player, producer, pickTime, pts, ranked] of t.picks) rows.push({ player, height: t.height, time: t.time, pickTime, correct: pts > 0 && producer === t.signer, pts, ranked: !!ranked });
    }
    return rows;
  };
  const rankedSet = (rows: any[]) => new Set(rows.filter((x) => x.ranked).map((x) => x.player));
  const view = (rows: any[]) => { const rk = rankedSet(rows); return X.places(X.board(rows)).map((x: any) => ({ a: x.player, place: x.place, pts: x.pts, correct: x.correct, picks: x.picks, days: x.days, lastCorrect: x.lastCorrect, ranked: rk.has(x.player) })); };
  const day0 = Math.floor(head.time / M.DAY) * M.DAY;
  const lw = nowW - 1;
  let lastWeek: any = null;
  if (lw >= 0) {
    const rows = rowsOf(M.weekStart(lw), M.weekStart(nowW));
    // Final: 12 hours after the week ended, with every target of the week recorded.
    const wf = all.get(lw);
    const complete = !!wf && wf.targets.length > 0 && targetsCover(wf, M.weekStart(lw), M.weekStart(nowW));
    const final = head.time >= M.weekStart(nowW) + CORRECTION_MS && complete;
    // Prizes: every wallet, guests included (owner's decision 2026-10-27); the 3-day rule and ≥1 point apply.
    lastWeek = { week: lw, start: M.weekStart(lw), final, rows: view(rows), prizes: final ? X.prizes(rows) : [] };
  }
  const board = {
    v: 1, updated: new Date(head.time).toISOString(),
    today: { day: M.dayOf(head.time), rows: view(rowsOf(day0, day0 + M.DAY)) },
    week: { week: nowW, start: M.weekStart(nowW), rows: view(rowsOf(M.weekStart(nowW), M.weekStart(nowW + 1))) },
    lastWeek,
    allTime: { rows: view(rowsOf(0, Infinity)) },
  };

  // ── 5. write ──
  fs.mkdirSync(OUT, { recursive: true });
  for (const [w, wf] of weeks) {
    if (!wf.targets.length) continue;
    known.add(w);
    fs.writeFileSync(path.join(OUT, wName(w)), JSON.stringify(wf) + "\n");
  }
  fs.writeFileSync(path.join(OUT, "index.json"), JSON.stringify({ v: 1, updated: new Date(head.time).toISOString(), weeks: [...known].sort((a, b) => a - b), contract: contract || null }) + "\n");
  fs.writeFileSync(path.join(OUT, "board.json"), JSON.stringify(board) + "\n");
  for (const pr of problems) console.log(`::warning::${pr}`);
  return { problems, weeks, board };
}

/** Every target whose block time falls in [from, to) is recorded: the rounds between the first and last recorded run
 *  without a gap, and the neighbours just outside fall outside the week. */
function targetsCover(wf: WeekFile, from: number, to: number): boolean {
  const rs = wf.targets.map((t) => t.round).sort((a, b) => a - b);
  for (let i = 1; i < rs.length; i++) if (rs[i] !== rs[i - 1] + 1) return false;
  const first = wf.targets.find((t) => t.round === rs[0])!, last = wf.targets.find((t) => t.round === rs[rs.length - 1])!;
  // ~2 hours between targets: the first is within 3 hours of the start and the last within 3 hours of the end.
  return first.time - from < 3 * 3600000 && to - last.time < 3 * 3600000;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run({ p: new Provider([RPC]), check: RPC_CHECK ? new Provider([RPC_CHECK]) : null }).catch((e) => { console.error(e); process.exit(1); });
}

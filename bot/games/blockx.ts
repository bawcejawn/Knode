/**
 * Who Signs Block X recorder (run every hour by GitHub Actions; read-only on the chain, holds no key).
 *   mainnet  .github/workflows/games.yml          game 2, cards from the Producer Race recorder, data → games-data/blockx
 *   testnet  .github/workflows/games-testnet.yml  every game in testnet/blockx.json, its own cards, data → testnet-data
 *
 * Each run, for one game:
 *  1. Targets. Every height r × round (+ offset) is a target; mainnet: every 2,400 blocks. A target is recorded once its
 *     block is irreversible and the block (signer and time) and the lock block match on two independent nodes (RPC and
 *     RPC_CHECK; the testnet has one public node (the Koinos Foundation's), so it is checked once and says so).
 *     Until then it waits.
 *  2. The card. A correct pick scores min(3, top VHP ÷ picked VHP) with the VHP from the handicap card in force at the
 *     lock (the time of block X − lead, the first block that refuses a pick):
 *       CARDS=race (mainnet): the Producer Race recorder's hourly card (race-data).
 *       CARDS=self (testnet): this recorder takes the same kind of card itself each run, from the VHP of the producers
 *       that signed the last ~6 hours of blocks (cards.json), because the testnet has no Producer Race.
 *     Only a card taken at or before the lock counts (audit BX-3). A target whose card can't be found yet waits; after
 *     3 days it is recorded as void (no points).
 *  3. The picks: every pick for the round from the Picks contract, on both nodes; they must agree. The chain locked them
 *     `lead` blocks before the target. Each pick is stored with its time, points and whether the wallet is Staked
 *     (holds 1 VHP or has a Knode stake when the target is recorded) or Free play (everyone else).
 *  4. Leaderboards (board.json): Today, This week, Last week and All time, by site/blockx-math.js, the same file the
 *     page runs, for the two boards of site/board.js (Staked / Free play). A week is final 12 hours after it ends (the
 *     correction window) when every target in it is recorded. Prizes (2 / 1 VHP to the top 2 of the Free play board,
 *     picks on 3+ days, ≥ 1 point) are listed only for weeks from PRIZES_FROM_WEEK: none until the Knode Games vault is
 *     live (owner, 2026-10-28). The vault pays them; this file only records.
 *  5. Writes index.json, W<week>.json, board.json (and cards.json with CARDS=self); the publish job puts them on the
 *     data branch for the website.
 *
 *   npm run blockx                          mainnet (RPC, RPC_CHECK, BLOCKX_PREV, BLOCKX_OUT, RACE_DATA)
 *   npm run blockx -- --testnet --game 2    one game of testnet/blockx.json (TESTNET_RPC overrides its rpc)
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
const LOOKBACK_BLOCKS = 3 * 28800;          // targets older than ~3 days: void if they still can't be recorded
const MAX_TARGETS_PER_RUN = 48;             // so a long outage catches up over a few runs
const CORRECTION_MS = 12 * 3600000;         // a week's results are final 12 hours after it ends
const CARD_BLOCKS = 7200;                   // a self-made card looks at the last ~6 hours of blocks
const CARD_KEEP_MS = 8 * 86400000;          // and cards.json keeps 8 days of them
const ONE_VHP = 100000000n;
const isAddr = (a: unknown) => typeof a === "string" && /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a);

/** A recorded pick: [player, producer, pick time (ms), points (hundredths), Staked (1) or Free play (0)]. */
type Pick = [string, string, number, number, number];
type Target = {
  round: number; height: number; final: true; checked: number;
  signer: string | null; time: number; lockTime: number;
  card: { at: number; top: number; signerVhp: number | null } | null;
  void?: string; picks: Pick[];
};
type WeekFile = { v: 1; week: number; start: number; end: number; game?: number; targets: Target[] };
type Card = { at: number; field: { a: string; vhp: number }[]; paddock: { a: string; vhp: number }[]; [k: string]: any };
export type RawPick = { player: string; producer: string; time: number };
export type Opts = {
  p: any; check: any | null; prev?: string; out?: string; raceDir?: string;
  picksContract?: string | null;                                           // default: picks-data/deployment.json
  game?: Partial<{ id: number; round: number; offset: number; lead: number; ahead: number; picksPerDay: number; maxChanges: number }>;
  cards?: "race" | "self";                                                 // default: race
  vhpContract?: string;                                                    // default: mainnet VHP
  knodeGame?: string | null;                                               // the question game, for "has a Knode stake"
  prizesFromWeek?: number | null;                                          // default: none (no prizes listed)
  picksOf?: (node: any, round: number) => Promise<RawPick[]>;             // for the tests
  blockOf?: (node: any, height: number) => Promise<{ signer: string; time: number }>;
  rankedOf?: (who: string[], node: any) => Promise<Set<string>>;
  signersOf?: (node: any, from: number, to: number) => Promise<{ signers: string[]; first: number; last: number; n: number }>;
  vhpOf?: (who: string[]) => Promise<Record<string, string>>;
  head?: { height: number; time: number; lib: number };
};

// ── files ──
function readJson(dir: string | undefined, name: string): any {
  if (!dir) return null;
  const f = path.join(dir, name);
  try { if (fs.lstatSync(f).isSymbolicLink()) return null; return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; }
}
const wName = (w: number) => `W${String(w).padStart(3, "0")}.json`;
function loadWeek(dir: string | undefined, w: number, G: any): WeekFile {
  const fresh: WeekFile = { v: 1, week: w, start: M.weekStart(w), end: M.weekStart(w + 1), game: G.GAME_ID, targets: [] };
  const old = readJson(dir, wName(w));
  if (!old || old.v !== 1 || old.week !== w || !Array.isArray(old.targets) || (old.game !== undefined && old.game !== G.GAME_ID)) return fresh;
  fresh.targets = old.targets.filter((t: any) => t && Number.isInteger(t.round) && t.height === G.target(t.round) && t.final === true);
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
/** The producers that signed blocks from..to, with the first and last block times (200 blocks per call). */
async function readSigners(node: any, headId: string, from: number, to: number) {
  const signers = new Set<string>();
  let first = 0, last = 0, n = 0;
  for (let s = from; s <= to; s += 200) {
    const res: any = await withRetry(`blocks at ${s}`, () => node.call("block_store.get_blocks_by_height", { head_block_id: headId, ancestor_start_height: String(s), num_blocks: Math.min(200, to - s + 1), return_block: true, return_receipt: false }));
    for (const it of res?.block_items ?? []) {
      const t = Number(it.block.header.timestamp);
      if (!first) first = t;
      last = t; n++;
      if (isAddr(it.block.header.signer)) signers.add(it.block.header.signer);
    }
  }
  return { signers: [...signers], first, last, n };
}
const PICKS_ABI = () => JSON.parse(fs.readFileSync(new URL("../../picks/abi/picks.koilib.json", import.meta.url), "utf8"));
async function readPicks(node: any, contract: string, game: number, round: number): Promise<RawPick[]> {
  const c = new Contract({ id: contract, abi: PICKS_ABI(), provider: node });
  const out: RawPick[] = [];
  let after: string | undefined;
  for (let page = 0; page < 1000; page++) {
    const r: any = await withRetry(`picks for round ${round}`, () => (c.functions as any).list_picks({ game, round: String(round), ...(after ? { start_after: after } : {}), limit: 100 }));
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
const MAINNET_KNODE_GAME = (() => { try { return JSON.parse(fs.readFileSync(new URL("../../game-data/deployment.json", import.meta.url), "utf8")).contract as string; } catch { return ""; } })();
const GAME_ABI = () => JSON.parse(fs.readFileSync(new URL("../../game/abi/kpred.koilib.json", import.meta.url), "utf8"));
/** Staked board: at least 1 VHP, or a Knode stake (active, pending, or in another game with vault v6). */
async function readRanked(node: any, vhpContract: string, knodeGame: string | null, who: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (!who.length) return out;
  const vhp = (await readVhp(node, vhpContract, who)).values;
  for (const a of who) {
    if (BigInt(vhp[a] || "0") >= ONE_VHP) { out.add(a); continue; }
    if (!knodeGame) continue;
    try {
      const c = new Contract({ id: knodeGame, abi: GAME_ABI(), provider: node });
      const r: any = await withRetry(`Knode player ${a}`, () => (c.functions as any).get_player({ player: a, week: "0" }));
      const p = r?.result?.player ?? {};
      if (BigInt(p.stake || "0") + BigInt(p.pending || "0") + BigInt(p.stake_other || "0") > 0n) out.add(a);
    } catch { /* Free play */ }
  }
  return out;
}

// ── cards ──
/** The handicap card for a lock at time t (audit BX-3): the latest card TAKEN at or before t (its `at`), no older than
 *  3 hours, so a card made after the lock (with VHP that moved after it) is never used. Race cards come from the race
 *  at t and the one before; self-made cards (testnet) from cards.json. None: the target waits (then void). */
const CARD_MAX_AGE_MS = 3 * 3600000;
function latestCardAt(cards: (Card | null | undefined)[], t: number): Card | null {
  let best: Card | null = null;
  for (const c of cards) {
    if (!c || !Number.isFinite(c.at) || !Array.isArray(c.field) || !c.field.length) continue;
    if (c.at <= t && t - c.at <= CARD_MAX_AGE_MS && (!best || c.at > best.at)) best = c;
  }
  return best;
}
function raceCardAt(raceDir: string | undefined, t: number): Card | null {
  const all: (Card | null)[] = [];
  for (const at of [t, t - M.RACE]) {
    const ra = M.raceAt(at);
    const wf = readJson(raceDir, wName(M.weekOf(ra.start)));
    const race = wf && Array.isArray(wf.races) ? wf.races.find((r: any) => r && r.id === ra.id) : null;
    if (race && Array.isArray(race.cards)) all.push(...race.cards);
  }
  return latestCardAt(all, t);
}
const selfCardAt = (cards: Card[], t: number): Card | null => latestCardAt(cards, t);

/** One run for one game. Exported for the tests, which pass fake nodes. */
export async function run(o: Opts) {
  const G = X.forGame(o.game ?? X.MAINNET_GAME);
  const OUT = o.out ?? E.BLOCKX_OUT ?? "games-data/blockx";
  const PREV = o.prev ?? E.BLOCKX_PREV ?? "";
  const RACE = o.raceDir ?? E.RACE_DATA ?? "";
  const CARDS = o.cards ?? "race";
  const VHP = o.vhpContract ?? MAINNET_VHP;
  const KNODE = o.knodeGame === undefined ? MAINNET_KNODE_GAME || null : o.knodeGame;
  const PRIZES_FROM = o.prizesFromWeek ?? null;
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
  const picksRead = o.picksOf ?? (contract ? (node: any, r: number) => readPicks(node, contract, G.GAME_ID, r) : null);
  const rankedRead = o.rankedOf ?? ((who: string[], node: any) => readRanked(node, VHP, KNODE, who));
  console.log(`game ${G.GAME_ID}: every ${G.ROUND} blocks, lock ${G.LEAD} before; head ${head.height} (${new Date(head.time).toISOString()}), irreversible ${head.lib}`);

  // ── self-made cards (CARDS=self): one per hour, from the VHP of the producers of the last ~6 hours ──
  let cards: Card[] = [];
  let startHeight = 0;                       // CARDS=self: the head when this recorder first ran (targets start there)
  if (CARDS === "self") {
    const prev = readJson(PREV, "cards.json");
    startHeight = prev && prev.v === 1 && Number.isInteger(prev.startHeight) && prev.startHeight > 0 ? prev.startHeight : head.height;
    cards = (prev && prev.v === 1 && Array.isArray(prev.cards) ? prev.cards : []).filter((c: any) => c && Number.isFinite(c.at) && Array.isArray(c.field) && head.time - c.at <= CARD_KEEP_MS);
    const hour = Math.floor(head.time / 3600000);
    if (!cards.some((c) => Math.floor(c.at / 3600000) === hour)) {
      try {
        const from = Math.max(1, head.height - CARD_BLOCKS + 1);
        const sg = o.signersOf ? await o.signersOf(o.p, from, head.height) : await readSigners(o.p, headId, from, head.height);
        const values = o.vhpOf ? await o.vhpOf(sg.signers) : (await readVhp(o.p, VHP, sg.signers)).values;
        const span = sg.last - sg.first, perRace = span > 0 ? (sg.n - 1) * M.RACE / span : 7200;
        const card = M.makeCard(sg.signers.map((a) => [a, Number(values[a] || "0") / 1e8]), perRace, head.time);
        if (card.field.length + card.paddock.length) { cards.push(card); console.log(`card taken: ${card.field.length + card.paddock.length} producers`); }
      } catch (e) { problems.push(`card: ${(e as Error).message} (tried again next run)`); }
    }
    cards.sort((a, b) => a.at - b.at);
  }
  const cardAt = (t: number) => (CARDS === "self" ? selfCardAt(cards, t) : raceCardAt(RACE, t));

  // The weeks touched: the last 3 days and now.
  const weeks = new Map<number, WeekFile>();
  const weekFor = (w: number) => { let f = weeks.get(w); if (!f) { f = loadWeek(PREV, w, G); weeks.set(w, f); } return f; };
  const idx = readJson(PREV, "index.json");
  const known = new Set<number>(Array.isArray(idx?.weeks) ? idx.weeks.filter((w: any) => Number.isInteger(w) && w >= 0 && w < 10000) : []);
  const done = new Set<number>();
  const nowW = M.weekOf(head.time);
  for (const w of [nowW - 1, nowW]) if (w >= 0) for (const t of weekFor(w).targets) done.add(t.round);

  // ── 1–3. targets ──
  let firstRound = Math.max(1, Math.ceil((head.lib - LOOKBACK_BLOCKS - G.OFFSET) / G.ROUND));
  // CARDS=self: only targets whose lock comes at most ~an hour (1,200 blocks) before the first run; earlier ones could
  // never have a card, so they are not part of this recorder's game at all (no "void" rows for days before it ran).
  if (CARDS === "self") firstRound = Math.max(firstRound, Math.ceil((startHeight - 1200 + G.LEAD - G.OFFSET) / G.ROUND));
  const lastRound = Math.floor((head.lib - G.OFFSET) / G.ROUND);
  let n = 0;
  // Newest first, so targets that keep waiting (no card) never crowd out the new ones within a run's budget.
  for (let r = lastRound; r >= firstRound && n < MAX_TARGETS_PER_RUN; r--) {
    if (done.has(r)) continue;
    const h = G.target(r);
    if (h <= G.LEAD) continue;
    n++;
    const old = h < head.lib - LOOKBACK_BLOCKS + G.ROUND;
    try {
      const b = await blockP(h), lock = await blockP(h - G.LEAD);
      let checked = 1;
      if (blockC) {
        const b2 = await blockC(h), l2 = await blockC(h - G.LEAD);
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
      const card = cardAt(lock.time);
      // CARDS=self: cards are only ever taken going forward, so a lock more than an hour before the first card will
      // never get one (the recorder wasn't running yet): void now rather than waiting 3 days.
      const never = CARDS === "self" && cards.length > 0 && lock.time < cards[0].at;
      if (!card && !old && !never) { problems.push(`block ${h}: no handicap card yet for ${new Date(lock.time).toISOString()}; tried again next run`); continue; }
      // Audit BX-4: Staked or Free play is read on both nodes too; a disagreement holds the target like a block's.
      const players = [...new Set(raw.map((x) => x.player))];
      const ranked = await rankedRead(players, o.p);
      if (o.check) {
        const other = await rankedRead(players, o.check);
        if (ranked.size !== other.size || [...ranked].some((a) => !other.has(a))) { problems.push(`block ${h}: the two nodes disagree about which players are Staked; not recorded this run`); continue; }
      }
      const { m, top } = card ? X.vhpOf(card) : { m: new Map(), top: 0 };
      const picks: Pick[] = raw.map((x) => [x.player, x.producer, x.time, card ? X.pointsOf(card, x.producer, b.signer) : 0, ranked.has(x.player) ? 1 : 0]);
      const t: Target = {
        round: r, height: h, final: true, checked, signer: isAddr(b.signer) ? b.signer : null, time: b.time, lockTime: lock.time,
        card: card ? { at: Number(card.at) || 0, top, signerVhp: m.get(b.signer) ?? null } : null, picks,
      };
      if (!card) t.void = "no handicap card was recorded for this target's lock; no points";
      const wf = weekFor(M.weekOf(b.time));
      wf.targets = wf.targets.filter((x) => x.round !== r).concat([t]).sort((x, y) => x.round - y.round);
      done.add(r);
      console.log(`block ${h}: signed by ${b.signer}, ${picks.length} picks, ${picks.filter((x) => x[3] > 0).length} right, checked on ${checked} node(s)`);
    } catch (e) { problems.push(`block ${h}: ${(e as Error).message} (tried again next run)`); }
  }

  // ── 4. leaderboards ──
  const all = new Map(weeks);
  for (const w of known) if (!all.has(w)) all.set(w, loadWeek(PREV, w, G));
  const rowsOf = (from: number, to: number) => {
    const rows: any[] = [];
    for (const wf of all.values()) for (const t of wf.targets) {
      if (t.time < from || t.time >= to || t.void) continue;
      for (const [player, producer, pickTime, pts, ranked] of t.picks) rows.push({ player, height: t.height, time: t.time, pickTime, correct: pts > 0 && producer === t.signer, pts, ranked: !!ranked });
    }
    return rows;
  };
  // A wallet is Staked for a period when any of its picks in that period was recorded as Staked.
  const rankedSet = (rows: any[]) => new Set(rows.filter((x) => x.ranked).map((x) => x.player));
  const view = (rows: any[]) => { const rk = rankedSet(rows); return X.places(X.board(rows)).map((x: any) => ({ a: x.player, place: x.place, pts: x.pts, correct: x.correct, picks: x.picks, days: x.days, lastCorrect: x.lastCorrect, ranked: rk.has(x.player) })); };
  const day0 = Math.floor(head.time / M.DAY) * M.DAY;
  const lw = nowW - 1;
  let lastWeek: any = null;
  if (lw >= 0) {
    const rows = rowsOf(M.weekStart(lw), M.weekStart(nowW));
    // Final: 12 hours after the week ended, with every target of the week recorded.
    const wf = all.get(lw);
    const complete = !!wf && wf.targets.length > 0 && targetsCover(wf, M.weekStart(lw), M.weekStart(nowW), all);
    const final = head.time >= M.weekStart(nowW) + CORRECTION_MS && complete;
    // Prizes: the Free play board's top 2 (owner, 2026-10-28), only from PRIZES_FROM_WEEK (none until the vault).
    const rk = rankedSet(rows);
    const prizeWeek = PRIZES_FROM !== null && lw >= PRIZES_FROM;
    lastWeek = { week: lw, start: M.weekStart(lw), final, rows: view(rows), prizes: final && prizeWeek ? X.prizes(rows.filter((x) => !rk.has(x.player))) : [] };
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
  fs.writeFileSync(path.join(OUT, "index.json"), JSON.stringify({ v: 1, updated: new Date(head.time).toISOString(), weeks: [...known].sort((a, b) => a - b), contract: contract || null, game: G.GAME_ID, prizesFromWeek: PRIZES_FROM }) + "\n");
  fs.writeFileSync(path.join(OUT, "board.json"), JSON.stringify(board) + "\n");
  if (CARDS === "self") fs.writeFileSync(path.join(OUT, "cards.json"), JSON.stringify({ v: 1, updated: new Date(head.time).toISOString(), startHeight, cards }) + "\n");
  for (const pr of problems) console.log(`::warning::${pr.replace(/[\r\n]+/g, " ").replace(/::/g, ": ")}`);
  return { problems, weeks, board, cards };
}

/** Every target whose block time falls in [from, to) is recorded (audit BX-5): the week's rounds run without a gap,
 *  the round right after the last one is recorded and falls at or after the week's end (so no target at the end of
 *  the week is missing), and the round right before the first one is recorded before the week's start (or, for the
 *  game's first week, the first target is within 3 hours of the start). */
export function targetsCover(wf: WeekFile, from: number, to: number, all: Map<number, WeekFile>): boolean {
  const rs = wf.targets.map((t) => t.round).sort((a, b) => a - b);
  for (let i = 1; i < rs.length; i++) if (rs[i] !== rs[i - 1] + 1) return false;
  const find = (r: number) => { for (const w of all.values()) { const t = w.targets.find((x) => x.round === r); if (t) return t; } return null; };
  const after = find(rs[rs.length - 1] + 1);
  if (!after || after.time < to) return false;
  const before = find(rs[0] - 1);
  if (before) return before.time < from;
  const first = wf.targets.find((t) => t.round === rs[0])!;
  const earlier = [...all.keys()].some((w) => w < wf.week && (all.get(w)?.targets.length ?? 0) > 0);
  return !earlier && first.time - from < 3 * 3600000;
}

// ── the testnet config (testnet/blockx.json), read and checked ──
export type NetConfig = { v: 1; network: "koinos-foundation-testnet"; chainId: string | null; rpc: string; koin: string; picks: string | null; vhp: string | null; prizesFromWeek: number | null;
  data: string; games: { id: number; name: string; round: number; offset: number; lead: number; ahead: number; picksPerDay: number; maxChanges: number }[] };
export const MAINNET_CHAIN_ID = "EiBZK_GGVP0H_fXVAM3j6EAuz3-B-l3ejxRSewi7qIBfSA==";
export function readNetConfig(file: URL | string = new URL("../../testnet/blockx.json", import.meta.url)): NetConfig {
  const c = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!c || c.v !== 1 || c.network !== "koinos-foundation-testnet" || !Array.isArray(c.games) || !c.games.length) throw new Error("testnet/blockx.json is not a testnet Block X config");
  if (c.chainId === MAINNET_CHAIN_ID) throw new Error("testnet/blockx.json names the MAINNET chain id: refusing");
  for (const g of c.games) X.forGame(g);   // throws on settings the contract would refuse
  return c;
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.includes("--testnet")) {
    const RPC = E.RPC || "https://api.koinos.io";
    const RPC_CHECK = E.RPC_CHECK && E.RPC_CHECK !== "off" && E.RPC_CHECK !== RPC ? E.RPC_CHECK : "";
    const r = await run({ p: new Provider([RPC]), check: RPC_CHECK ? new Provider([RPC_CHECK]) : null, prizesFromWeek: E.PRIZES_FROM_WEEK ? Number(E.PRIZES_FROM_WEEK) : null });
    return r;
  }
  // Testnet: one game of the config. Never touches mainnet files: data goes to BLOCKX_OUT (default testnet-data/blockx-<id>).
  const cfg = readNetConfig();
  const i = argv.indexOf("--game"), id = i >= 0 ? Number(argv[i + 1]) : cfg.games[0].id;
  const game = cfg.games.find((g) => g.id === id);
  if (!game) throw new Error(`game ${id} is not in testnet/blockx.json`);
  if (!isAddr(cfg.picks)) throw new Error("testnet/blockx.json has no Picks contract yet (npm run picks -- upload --testnet --send)");
  if (!isAddr(cfg.vhp)) throw new Error("testnet/blockx.json has no testnet VHP contract (vhp); the upload finds it, or set it by hand. The mainnet VHP is never used on the testnet.");
  const rpc = E.TESTNET_RPC || cfg.rpc;
  const p = new Provider([rpc]);
  // The node must be the testnet the config names, never mainnet.
  const chain = await withRetry("chain id", () => p.getChainId());
  if (chain === MAINNET_CHAIN_ID || (cfg.chainId && chain !== cfg.chainId)) throw new Error(`the node at ${rpc} is on chain ${chain}, not the testnet in testnet/blockx.json (${cfg.chainId})`);
  return run({
    p, check: null, game, cards: "self", picksContract: cfg.picks, vhpContract: cfg.vhp!, knodeGame: null,
    prizesFromWeek: cfg.prizesFromWeek, out: E.BLOCKX_OUT || `testnet-data/blockx-${id}`, prev: E.BLOCKX_PREV || `testnet-data/blockx-${id}`,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

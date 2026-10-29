/**
 * Combo Card recorder (run every hour by .github/workflows/combo.yml; read-only on the chain, holds no key).
 *
 * Each run:
 *  1. Cards. A wallet has 3 card slots a UTC day (Picks game 8, round = day × 3 + slot). A slot's cards are read from
 *     the Picks contract on two independent nodes (RPC and RPC_CHECK), which must agree. The contract lets a card be
 *     made or changed only on its own day, so once the last irreversible block is past the end of that day, the
 *     slot is FIXED: stored, and never read again. Until then it is re-read every run (shown as "open").
 *  2. Prices. Each leg is priced (site/combo-math.js, the same file the page runs) with the Producer Race card in force
 *     when the card was last sent: the latest race card taken at or before that time (race-data). A card with no race
 *     card to price it is void.
 *  3. Results. Race legs from the race recorder's final standings (race-data), Block X legs from the Block X recorder's
 *     final targets (games-data/blockx). A leg still without a result 3 days after it was decided is void (dropped),
 *     so one missing result never holds a week open. A card is final when every leg is final.
 *  4. Players. A player counts for the week only with at least 1 VHP staked in the Combo Card that week (the owner's
 *     player rule; the Vault checks it again). Until the Vault (v6) can be read, a player's stake is "unknown" (null).
 *  5. Weeks. A card counts in the KnodeGames week of its slot day. A player's week = the sum of their best 10 cards.
 *     The week is final 12 hours after it ends, once every card of it is final (Sunday's cards settle by about Monday
 *     24:00 UTC). Then the Vault file vault/W<week>.json is written: players with at least 1 point, mapped onto 1..255.
 *  6. Writes games-data/combo/index.json, W<week>.json (cards), board.json (Today, This week, Last week, All time) and
 *     vault/W<week>.json; the workflow puts them on the games-data branch.
 *
 *   RPC, RPC_CHECK ("off" to skip the second node), COMBO_PREV (last run's files), COMBO_OUT, RACE_DATA (race files),
 *   BLOCKX_DATA (Block X files).      npm run combo        (or: npx tsx bot/games/combo.ts)
 */
import { Provider, Contract } from "koilib";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { withRetry } from "../../common.ts";
await import("../../site/race-math.js");
await import("../../site/blockx-math.js");
await import("../../site/combo-math.js");
const M: any = (globalThis as any).KRaceMath;
const X: any = (globalThis as any).KBlockX;
const C: any = (globalThis as any).KCombo;

const E = process.env;
const RPC = E.RPC || "https://koinos.armana.io";
const RPC_CHECK = E.RPC_CHECK && E.RPC_CHECK !== "off" && E.RPC_CHECK !== RPC ? E.RPC_CHECK : "";
const LOOKBACK_DAYS = 3;                     // slots of the last 3 days (and today) are read until fixed
const VOID_AFTER_MS = 3 * M.DAY;             // a leg with no result 3 days after it was decided is void
const VOID_AFTER_BLOCKS = 3 * 28800;
const CORRECTION_MS = 12 * 3600000;          // a week is final 12 hours after it ends (once every card is final)
const ONE_VHP = 100000000n;
const isAddr = (a: unknown) => typeof a === "string" && /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a);

export type RawLeg = { code: number; round: number; producer: string };
export type RawCard = { player: string; legs: RawLeg[]; time: number; height: number; changes: number };
/** A recorded leg: [code, round, producer, worth (hundredths, or 0 if it can't be priced), result]. */
type Leg = [number, number, string, number, string];
type Card = {
  player: string; round: number; time: number; changes: number; priceAt: number | null;
  legs: Leg[]; state: "pending" | "final"; outcome: string | null; pts: number; settled: number;
};
type Slot = { round: number; fixed: boolean; cards: Card[] };
type WeekFile = { v: 1; week: number; start: number; end: number; slots: Slot[] };
type Head = { height: number; time: number; lib: number; libTime: number };
type Opts = {
  p: any; check: any | null; prev?: string; out?: string; raceDir?: string; blockxDir?: string;
  picksContract?: string | null;                                              // default: picks-data/deployment.json
  cardsOf?: (node: any, round: number) => Promise<RawCard[]>;                 // for the tests
  stakedOf?: (week: number, who: string[]) => Promise<Map<string, boolean> | null>;
  head?: Head;
};

// ── files ──
function readJson(dir: string | undefined, name: string): any {
  if (!dir) return null;
  const f = path.join(dir, name);
  try { if (fs.lstatSync(f).isSymbolicLink()) return null; return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; }
}
const wName = (w: number) => `W${String(w).padStart(3, "0")}.json`;
const legOk = (l: any) => Array.isArray(l) && l.length === 5 && C.CODES.includes(l[0]) && Number.isSafeInteger(l[1]) && isAddr(l[2]) && Number.isSafeInteger(l[3]) && typeof l[4] === "string";
function cardOk(c: any): boolean {
  return !!c && isAddr(c.player) && Number.isSafeInteger(c.round) && Number.isSafeInteger(c.time) && Array.isArray(c.legs) && c.legs.length >= C.MIN_LEGS &&
    c.legs.length <= C.HARD_MAX_LEGS && c.legs.every(legOk) && (c.state === "pending" || c.state === "final") && Number.isSafeInteger(c.pts);
}
function loadWeek(dir: string | undefined, w: number): WeekFile {
  const fresh: WeekFile = { v: 1, week: w, start: M.weekStart(w), end: M.weekStart(w + 1), slots: [] };
  const old = readJson(dir, wName(w));
  if (!old || old.v !== 1 || old.week !== w || !Array.isArray(old.slots)) return fresh;
  // Only fixed slots carry over (open ones are read again), and only with well-formed cards of that slot.
  fresh.slots = old.slots.filter((s: any) => s && s.fixed === true && Number.isSafeInteger(s.round) && Array.isArray(s.cards) &&
    s.cards.every((c: any) => cardOk(c) && c.round === s.round) && M.weekOf(C.dayOfRound(s.round) * M.DAY) === w);
  return fresh;
}
function defaultPicksContract(): string | null {
  try { const d = JSON.parse(fs.readFileSync(new URL("../../picks-data/deployment.json", import.meta.url), "utf8")); return isAddr(d.contract) ? d.contract : null; } catch { return null; }
}

// ── chain reads ──
async function headOf(node: any): Promise<Head> {
  const h: any = await withRetry("head", () => node.getHeadInfo());
  const lib = Number(h.last_irreversible_block);
  const res: any = await withRetry(`block ${lib}`, () => node.call("block_store.get_blocks_by_height", { head_block_id: h.head_topology.id, ancestor_start_height: String(lib), num_blocks: 1, return_block: true, return_receipt: false }));
  const it = res?.block_items?.[0];
  if (!it || Number(it.block_height) !== lib) throw new Error(`block ${lib} not returned`);
  return { height: Number(h.head_topology.height), time: Number(h.head_block_time), lib, libTime: Number(it.block.header.timestamp) };
}
const PICKS_ABI = () => JSON.parse(fs.readFileSync(new URL("../../picks/abi/picks.koilib.json", import.meta.url), "utf8"));
async function readCards(node: any, contract: string, round: number): Promise<RawCard[]> {
  const c = new Contract({ id: contract, abi: PICKS_ABI(), provider: node });
  const out: RawCard[] = [];
  let after: string | undefined;
  for (let page = 0; page < 1000; page++) {
    const r: any = await withRetry(`cards for slot ${round}`, () => (c.functions as any).list_picks({ game: C.GAME_ID, round: String(round), ...(after ? { start_after: after } : {}), limit: 100 }));
    const rows = r?.result?.rows ?? [];
    for (const x of rows) {
      const legs = (x.pick?.legs ?? []).map((l: any) => ({ code: Number(l.code), round: Number(l.round), producer: String(l.producer) }));
      if (isAddr(x.player)) out.push({ player: x.player, legs, time: Number(x.pick?.time || 0), height: Number(x.pick?.height || 0), changes: Number(x.pick?.changes || 0) });
    }
    if (rows.length < 100) break;
    after = rows[rows.length - 1].player;
  }
  return out;
}
/** Who is staked in the Combo Card for a week, from the Vault (v6) once its ABI has get_game_player; null before. */
const GAME = (() => { try { return JSON.parse(fs.readFileSync(new URL("../../game-data/deployment.json", import.meta.url), "utf8")).contract as string; } catch { return ""; } })();
async function readStaked(node: any, week: number, who: string[]): Promise<Map<string, boolean> | null> {
  let abi: any;
  try { abi = JSON.parse(fs.readFileSync(new URL("../../game/abi/kpred.koilib.json", import.meta.url), "utf8")); } catch { return null; }
  if (!GAME || !abi?.methods?.get_game_player) return null;
  const c = new Contract({ id: GAME, abi, provider: node });
  const out = new Map<string, boolean>();
  for (const a of who) {
    const r: any = await withRetry(`Combo stake of ${a}`, () => (c.functions as any).get_game_player({ player: a, game: C.GAME_ID, week: String(week) }));
    out.set(a, BigInt(r?.result?.week_stake || "0") >= ONE_VHP);
  }
  return out;
}

// ── results from the other recorders ──
function raceRecord(raceDir: string | undefined, round: number): any | null {
  const start = M.raceStart(round), wf = readJson(raceDir, wName(M.weekOf(start)));
  return wf && Array.isArray(wf.races) ? wf.races.find((r: any) => r && r.id === M.raceId(round)) ?? null : null;
}
function racesAround(raceDir: string | undefined, t: number): any[] {
  const w = M.weekOf(t), out: any[] = [];
  for (const k of [w - 1, w]) { const wf = readJson(raceDir, wName(k)); if (wf && Array.isArray(wf.races)) out.push(...wf.races); }
  return out;
}
function blockTargets(blockxDir: string | undefined, weeks: number[]): Map<number, any> {
  const m = new Map<number, any>();
  for (const w of weeks) { const wf = readJson(blockxDir, wName(w)); if (wf && Array.isArray(wf.targets)) for (const t of wf.targets) if (t && Number.isInteger(t.round)) m.set(t.round, t); }
  return m;
}

/** One run. Exported for the tests, which pass fake nodes and files. */
export async function run(o: Opts) {
  const OUT = o.out ?? E.COMBO_OUT ?? "games-data/combo";
  const PREV = o.prev ?? E.COMBO_PREV ?? "";
  const RACE = o.raceDir ?? E.RACE_DATA ?? "";
  const BX = o.blockxDir ?? E.BLOCKX_DATA ?? "";
  const problems: string[] = [];
  const contract = o.picksContract === undefined ? defaultPicksContract() : o.picksContract;
  const head = o.head ?? (await headOf(o.p));
  const cardsRead = o.cardsOf ?? (contract ? (node: any, r: number) => readCards(node, contract, r) : null);
  const stakedRead = o.stakedOf ?? ((w: number, who: string[]) => readStaked(o.p, w, who));
  console.log(`head ${head.height} (${new Date(head.time).toISOString()}), irreversible ${head.lib} (${new Date(head.libTime).toISOString()})`);

  const weeks = new Map<number, WeekFile>();
  const weekFor = (w: number) => { let f = weeks.get(w); if (!f) { f = loadWeek(PREV, w); weeks.set(w, f); } return f; };
  const idx = readJson(PREV, "index.json");
  const known = new Set<number>(Array.isArray(idx?.weeks) ? idx.weeks.filter((w: any) => Number.isInteger(w) && w >= 0 && w < 10000) : []);
  const nowW = M.weekOf(head.time), today = C.utcDay(head.time);
  for (const w of [nowW - 1, nowW]) if (w >= 0) weekFor(w);
  const bxWeeks = [nowW - 2, nowW - 1, nowW].filter((w) => w >= 0);
  const targets = blockTargets(BX, bxWeeks);

  // ── 1. cards: read the slots of the last days that aren't fixed yet ──
  if (cardsRead) {
    for (let day = today - LOOKBACK_DAYS; day <= today; day++) {
      const wf = weekFor(M.weekOf(day * M.DAY));
      for (let s = 0; s < C.CARDS_PER_DAY; s++) {
        const round = C.slotRound(day, s);
        if (wf.slots.some((x) => x.round === round && x.fixed)) continue;
        try {
          const fixed = head.libTime >= (day + 1) * M.DAY;
          const raw = await cardsRead(o.p, round);
          if (o.check) {
            const other = await cardsRead(o.check, round);
            const key = (x: RawCard[]) => JSON.stringify([...x].sort((u, v) => (u.player < v.player ? -1 : 1)));
            if (key(raw) !== key(other)) { problems.push(`slot ${round}: the two nodes disagree about the cards; read again next run`); continue; }
          }
          const cards: Card[] = [];
          for (const x of raw) {
            if (!Array.isArray(x.legs) || x.legs.length < C.MIN_LEGS || x.legs.length > C.HARD_MAX_LEGS || !x.legs.every((l) => C.CODES.includes(l.code) && isAddr(l.producer))) {
              problems.push(`slot ${round}: a card of ${x.player} has a leg this recorder doesn't know; left out`); continue;
            }
            const price = C.priceCard(racesAround(RACE, x.time), x.time);
            const legs: Leg[] = x.legs.map((l) => { const p = price ? C.priceLeg(price, l) : null; return [l.code, l.round, l.producer, p ? p.f100 : 0, "pending"]; });
            cards.push({ player: x.player, round, time: x.time, changes: x.changes, priceAt: price ? price.at : null, legs, state: "pending", outcome: null, pts: 0, settled: 0 });
          }
          wf.slots = wf.slots.filter((x) => x.round !== round).concat([{ round, fixed, cards }]).sort((a, b) => a.round - b.round);
          if (cards.length) console.log(`slot ${round} (${M.dayOf(day * M.DAY)} #${s + 1}): ${cards.length} card(s)${fixed ? ", fixed" : ""}`);
        } catch (e) { problems.push(`slot ${round}: ${(e as Error).message} (read again next run)`); }
      }
    }
  }

  // ── 2–3. results: every card not final yet ──
  for (const w of new Set([...weeks.keys()])) for (const sl of weekFor(w).slots) for (const c of sl.cards) {
    if (c.state === "final") continue;
    if (c.priceAt === null) {
      if (sl.fixed) { c.state = "final"; c.outcome = "void"; c.pts = 0; c.settled = head.time; }
      continue;
    }
    const price = C.priceCard(racesAround(RACE, c.time), c.time);
    if (!price || price.at !== c.priceAt) { problems.push(`slot ${c.round}: the race card that priced ${c.player}'s card is missing; scored next run`); continue; }
    const results = c.legs.map((l) => {
      const leg = { code: l[0], round: l[1], producer: l[2] };
      const isRace = C.FAMILY[l[0]] === "race";
      let r = isRace ? C.legResult(leg, raceRecord(RACE, l[1]), null) : C.legResult(leg, null, targets.get(l[1]) ?? null);
      if (r === "pending") {
        const late = isRace ? head.time > M.raceStart(l[1]) + M.RACE + VOID_AFTER_MS : head.lib > X.target(l[1]) + VOID_AFTER_BLOCKS;
        if (late) r = "void";
      }
      return r;
    });
    c.legs.forEach((l, i) => { l[4] = results[i]; });
    const sc = C.scoreCard(price, c.legs.map((l) => ({ code: l[0], round: l[1], producer: l[2] })), results);
    // A card is final only once its slot is fixed (no more changes) and every leg is final.
    if (sc.state === "final" && sl.fixed) { c.state = "final"; c.outcome = sc.outcome; c.pts = sc.pts; c.settled = head.time; }
    else { c.outcome = sc.outcome; c.pts = 0; }
  }

  // ── 4–5. players, boards and the Vault ──
  const all = new Map(weeks);
  for (const w of known) if (!all.has(w)) all.set(w, loadWeek(PREV, w));
  const cardRows = (from: number, to: number) => {
    const rows: any[] = [];
    for (const wf of all.values()) for (const sl of wf.slots) {
      const t = C.dayOfRound(sl.round) * M.DAY;
      if (t < from || t >= to) continue;
      for (const c of sl.cards) if (c.state === "final" && c.outcome !== "void") rows.push({ player: c.player, round: c.round, pts: c.pts, hit: c.outcome === "hit", lastLegTime: c.settled });
    }
    return rows;
  };
  const stakeCache = new Map<number, Map<string, boolean> | null>();
  async function stakes(w: number, who: string[]) {
    if (!stakeCache.has(w)) { try { stakeCache.set(w, await stakedRead(w, who)); } catch (e) { problems.push(`stakes for week ${w}: ${(e as Error).message}`); stakeCache.set(w, null); } }
    return stakeCache.get(w)!;
  }
  const view = async (rows: any[], w: number | null) => {
    const ranked = C.places(C.board(rows));
    const st = w === null ? null : await stakes(w, ranked.map((x: any) => x.player));
    return ranked.map((x: any) => {
      const staked = st ? st.get(x.player) ?? false : null;
      return { a: x.player, place: x.place, pts: x.pts, hits: x.hits, cards: x.cards, best: x.best, days: x.days, lastHit: x.lastHit, staked, ranked: staked !== false };
    });
  };
  const day0 = today * M.DAY, lw = nowW - 1;
  const weekDone = (w: number) => { const wf = all.get(w); if (!wf) return false; const days = 7 * C.CARDS_PER_DAY; return wf.slots.filter((s) => s.fixed).length === days && wf.slots.every((s) => s.cards.every((c) => c.state === "final")); };
  let lastWeek: any = null;
  if (lw >= 0) {
    const final = head.time >= M.weekStart(nowW) + CORRECTION_MS && weekDone(lw);
    lastWeek = { week: lw, start: M.weekStart(lw), final, rows: await view(cardRows(M.weekStart(lw), M.weekStart(nowW)), lw) };
  }
  const board = {
    v: 1, updated: new Date(head.time).toISOString(),
    today: { day: M.dayOf(head.time), rows: await view(cardRows(day0, day0 + M.DAY), nowW) },
    week: { week: nowW, start: M.weekStart(nowW), rows: await view(cardRows(M.weekStart(nowW), M.weekStart(nowW + 1)), nowW) },
    lastWeek,
    allTime: { rows: await view(cardRows(0, Infinity), null) },
  };

  // ── 6. write ──
  fs.mkdirSync(path.join(OUT, "vault"), { recursive: true });
  for (const [w, wf] of weeks) {
    if (!wf.slots.some((s) => s.cards.length || s.fixed)) continue;
    known.add(w);
    fs.writeFileSync(path.join(OUT, wName(w)), JSON.stringify(wf) + "\n");
  }
  // The Vault file for each final week the prev run hadn't written yet (and last week's, rewritten while final).
  const vaultWritten: number[] = [];
  if (lastWeek && lastWeek.final) {
    const rows = lastWeek.rows.map((r: any) => ({ player: r.a, pts: r.pts, staked: r.staked }));
    fs.writeFileSync(path.join(OUT, "vault", `W${lw}.json`), JSON.stringify(C.vaultFile(lw, true, rows)) + "\n");
    vaultWritten.push(lw);
    console.log(`week ${lw} final: vault/W${lw}.json with ${C.vaultFile(lw, true, rows).rows.length} player(s)`);
  }
  fs.writeFileSync(path.join(OUT, "index.json"), JSON.stringify({ v: 1, updated: new Date(head.time).toISOString(), weeks: [...known].sort((a, b) => a - b), contract: contract || null }) + "\n");
  fs.writeFileSync(path.join(OUT, "board.json"), JSON.stringify(board) + "\n");
  for (const pr of problems) console.log(`::warning::${pr}`);
  return { problems, weeks, board, vaultWritten };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run({ p: new Provider([RPC]), check: RPC_CHECK ? new Provider([RPC_CHECK]) : null }).catch((e) => { console.error(e); process.exit(1); });
}

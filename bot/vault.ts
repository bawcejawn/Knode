/**
 * The KnodeGames Vault (game v6) side of the operator bot: other games' weekly results, finalizing their weeks, alerts
 * for game announcements and owner corrections, and the status lines. Everything here also runs against the v5
 * contract: `vaultView` returns null there and every pass skips.
 *
 * Results files. Each game's recorder publishes one file per vault week, when its week is final:
 *
 *   { "game": 2, "week": 57, "final": true,
 *     "rows":   [ { "player": "1Abc…", "points": 12 }, … ],     staked games: every staked player with 1-255 points
 *     "first":  [ "1Abc…" ],  "second": [ "1Def…" ] }            free-prize games: the winners of 1st and 2nd (ties: several)
 *
 * `week` is the vault's week number (week 0 began at the contract's genesis, Mon 19 Oct 2026 00:00 UTC). Points keep
 * the game's own order and ties: only the order matters to the vault. Where the files live is set per game in
 * game-data/deployment.json, e.g.
 *
 *   "vaultGames": { "2": { "name": "Who Signs Block X", "results": "games-data:blockx/vault" } }
 *
 * "<branch>:<folder>" reads <folder>/W<week>.json from that branch (fetched first); a plain folder path reads files on
 * disk. The bot checks every row against the chain before sending it (the vault checks again), posts what is new,
 * then seals the week. The owner then has 24 hours to correct anything (npm run bot -- game-correct …).
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { Signer } from "koilib";
import { showKoin, type Chain, type Call } from "./chain.ts";

export const Q_GAME = 1;
export const MAX_ROWS = 50;                   // results per post_results call (the contract's limit)
export const MAX_PRIZE_WINNERS = 10;          // wallets per prize place (the contract's limit)
export const MAX_POINTS = 255;
const HOUR_MS = 3_600_000;

const num = (x: any) => Number(x ?? 0);
const big = (x: any) => BigInt(x ?? 0);
const utc = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC";

export type VaultCtx = {
  chain: Chain;
  operator: Signer;
  dryRun: boolean;
  problems: string[];
  quiet?: boolean;
  /** game-data/deployment.json (for `vaultGames`). */
  deployment?: any;
  /** Reads a results file; tests pass their own. Default: `<branch>:<folder>` from git, or a folder on disk. */
  readResults?: (source: string, week: number) => any | null;
};
export type Send = (what: string, calls: Call[]) => Promise<boolean>;
const log = (ctx: VaultCtx, ...a: any[]) => { if (!ctx.quiet) console.log(...a); };

export type VaultView = { games: any[]; proposals: any[] };

/** The game list, or null when the contract is not v6 yet. */
export async function vaultView(chain: Chain): Promise<VaultView | null> {
  try {
    const r = await chain.read("list_games", {});
    return { games: r.games ?? [], proposals: r.proposals ?? [] };
  } catch {
    return null;
  }
}

/** The chain's clock and the settings every pass needs. */
async function clock(chain: Chain) {
  const s = await chain.read("get_state", {});
  const c = s.config ?? {}, t = s.totals ?? {};
  const time = num(s.time), genesis = num(c.genesis_time), weekLen = num(c.week_length);
  const week = time < genesis ? 0 : Math.floor((time - genesis) / weekLen);
  const minStakeFor = (w: number) => (big(c.min_stake_next) > 0n && w >= num(c.min_stake_next_week) ? big(c.min_stake_next) : big(c.min_stake));
  return {
    raw: s, c, t, time, genesis, weekLen, week, closeDelay: num(c.close_delay), weeksClosed: num(t.weeks_closed), minStakeFor,
    weekEnd: (w: number) => genesis + (w + 1) * weekLen,
    resultsDue: (w: number) => genesis + (w + 1) * weekLen + Math.floor(weekLen / 7) * 3,
  };
}

/** Whether week w is the last week of one of the game's prize seasons (the contract's seasonEnds). */
export function seasonEnds(g: any, w: number): boolean {
  const n = Math.max(1, num(g.season_weeks));
  const from = num(g.from_week);
  return w >= from && (w - from) % n === n - 1;
}

/** Whether a game earns (has a week to report) for week w. */
/** Whether a game has results for week w, as the contract decides (requireResults): it earns that week now, or the
 *  vault closed that week with it earning (a game restarted after a gap keeps those weeks). */
export function earnedWeek(g: any, w: number, gw: any): boolean {
  return !!gw?.closed || gameEarns(g, w);
}

export function gameEarns(g: any, w: number): boolean {
  const last = num(g.last_week_plus_one);
  return num(g.from_week) <= w && (last === 0 || w + 1 <= last);
}

/** Default reader: "<branch>:<folder>" from git (fetching the branch first, once per run), or a folder on disk. */
const fetched = new Set<string>();
export function readResultsFile(source: string, week: number): any | null {
  const file = `W${week}.json`;
  const m = source.match(/^([A-Za-z0-9._\/-]+):(.+)$/);
  if (!m) {
    const f = path.join(source, file);
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null;
  }
  const [, branch, folder] = m;
  if (!/^[A-Za-z0-9._-]+$/.test(branch) || folder.includes("..")) throw new Error(`results source "${source}" is not <branch>:<folder>`);
  try {
    if (!fetched.has(branch)) { execFileSync("git", ["fetch", "--quiet", "--depth=1", "origin", branch], { stdio: "ignore" }); fetched.add(branch); }
    const text = execFileSync("git", ["show", `origin/${branch}:${folder.replace(/\/$/, "")}/${file}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const ADDRESS = /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/;

/** Checks a results file's shape. Returns the reason it can't be used, or "". */
export function checkResults(r: any, game: number, week: number): string {
  if (!r || typeof r !== "object") return "not a JSON object";
  if (num(r.game) !== game || num(r.week) !== week) return `it is for game ${r.game} week ${r.week}, not game ${game} week ${week}`;
  if (r.final !== true) return "not final yet";
  const rows = r.rows ?? [], first = r.first ?? [], second = r.second ?? [];
  if (!Array.isArray(rows) || !Array.isArray(first) || !Array.isArray(second)) return "rows, first and second must be lists";
  const seen = new Set<string>();
  for (const x of rows) {
    if (!x || !ADDRESS.test(String(x.player))) return `a row has no valid address (${JSON.stringify(x)})`;
    if (!Number.isInteger(x.points) || x.points < 1 || x.points > MAX_POINTS) return `${x.player} has ${x.points} points (must be a whole number 1-255)`;
    if (seen.has(x.player)) return `${x.player} appears twice`;
    seen.add(x.player);
  }
  for (const a of [...first, ...second]) {
    if (!ADDRESS.test(String(a))) return `a prize winner is not a valid address (${a})`;
    if (seen.has(a)) return `${a} appears twice`;
    seen.add(a);
  }
  if (first.length > MAX_PRIZE_WINNERS || second.length > MAX_PRIZE_WINNERS) return `more than ${MAX_PRIZE_WINNERS} winners for one place`;
  return "";
}

/**
 * Posts other games' finished weeks: points for staked players, prize winners, then the seal. Only the week that just
 * ended can be posted (results are due 3 days after it). Rows the chain would refuse are left out and reported.
 * `only`: one game and week (the game-post command); otherwise every game.
 */
export async function vaultResultsPass(ctx: VaultCtx, send: Send, only?: { game: number; week: number; source?: string }) {
  const view = await vaultView(ctx.chain);
  if (!view) { if (only) throw new Error("The contract is not v6 yet: it has no other games."); return; }
  const k = await clock(ctx.chain);
  const cfg = ctx.deployment?.vaultGames ?? {};
  const read = ctx.readResults ?? readResultsFile;
  for (const g of view.games) {
    const id = num(g.id);
    if (id === Q_GAME || (only && only.game !== id)) continue;
    const w = only ? only.week : k.week - 1;
    const name = g.name ?? `game ${id}`;
    if (w < 0) { if (only) throw new Error(`${name} has no results for week ${w}.`); continue; }
    const gw = (await ctx.chain.read("get_game", { game: id, week: String(w) })).week ?? {};
    // Fix-check VN-3: the contract's rule. A game restarted after a gap keeps the weeks it earned (closed with it).
    if (!earnedWeek(g, w, gw)) { if (only) throw new Error(`${name} has no results for week ${w}.`); continue; }
    const source = only?.source ?? cfg[String(id)]?.results;
    if (!source) { log(ctx, `  ${name}: no results source in deployment.json (vaultGames.${id}.results)`); continue; }
    if (k.time < k.weekEnd(w)) { if (only) throw new Error(`Week ${w} of ${name} is not over yet.`); continue; }
    const due = k.resultsDue(w);
    if (gw.sealed || gw.finalized || gw.voided) { if (only) log(ctx, `  ${name} week ${w} is already ${gw.finalized ? "final" : gw.voided ? "voided" : "sealed"}.`); continue; }
    if (k.time >= due) { if (only) throw new Error(`Week ${w} of ${name} is past its results deadline (${utc(due)}).`); continue; }
    const r = read(source, w);
    const why = r ? checkResults(r, id, w) : "no file yet";
    if (why) {
      const hoursLeft = (due - k.time) / HOUR_MS;
      if (only) throw new Error(`Results for ${name} week ${w} can't be used: ${why}.`);
      log(ctx, `  ${name} week ${w}: results not ready (${why}); due ${utc(due)}`);
      if (hoursLeft < 12) ctx.problems.push(`${name}: week ${w}'s results are not ready (${why}) and are due ${utc(due)} (${hoursLeft.toFixed(1)} h). Without them the week rolls over: its bucket stays in the game and its prize goes back to the pool.`);
      continue;
    }
    const min = k.minStakeFor(w);
    // Points for staked players: only rows the chain would take, and only once.
    const rows: Array<{ player: string; points: number }> = [];
    let skipped = 0;
    if (g.staked || big(gw.bucket) > 0n) {
      for (const x of r.rows ?? []) {
        const p = await ctx.chain.read("get_game_player", { player: x.player, game: id, week: String(w) });
        const posted = num(p.entry?.points);
        if (posted === x.points) continue;
        if (posted > 0) { ctx.problems.push(`${name} week ${w}: ${x.player} already has ${posted} points on chain; the results file says ${x.points}. If the file is right, correct it: npm run bot -- game-correct ${id} ${w} ${x.player} ${x.points} --send`); continue; }
        if (num(p.entry?.prize_place) > 0) { skipped++; continue; }
        if (big(p.week_stake) < min || big(p.week_stake) === 0n) { skipped++; continue; }
        rows.push({ player: x.player, points: x.points });
      }
    } else if ((r.rows ?? []).length) log(ctx, `  ${name} has no stake bucket: its ${r.rows.length} row(s) of points are not sent`);
    // Prize winners, on the last week of the game's season only, each a free player there.
    const places: Array<{ place: number; players: string[] }> = [];
    if (g.free_prize && (gw.closed ? big(gw.prize) > 0n : seasonEnds(g, w))) {
      for (const [place, list] of [[1, r.first ?? []], [2, r.second ?? []]] as Array<[number, string[]]>) {
        const fresh: string[] = [];
        for (const a of list) {
          const p = await ctx.chain.read("get_game_player", { player: a, game: id, week: String(w) });
          if (num(p.entry?.prize_place) === place) continue;
          if (num(p.entry?.prize_place) > 0 || num(p.entry?.points) > 0) { ctx.problems.push(`${name} week ${w}: ${a} already has another result on chain; not posted as a prize winner.`); continue; }
          const peak = p.entry ? big(p.entry.peak_stake) : big(p.active_stake);
          if (peak >= min) { ctx.problems.push(`${name} week ${w}: ${a} is in the results file as a prize winner but was staked in the game that week, so it can't win the free prize. Check the game's recorder.`); continue; }
          fresh.push(a);
        }
        const already = place === 1 ? num(gw.first_n) : num(gw.second_n);
        if (fresh.length + already > MAX_PRIZE_WINNERS) { ctx.problems.push(`${name} week ${w}: more than ${MAX_PRIZE_WINNERS} winners tied for place ${place}; none posted for that place.`); continue; }
        if (fresh.length) places.push({ place, players: fresh });
      }
    } else if ((r.first ?? []).length || (r.second ?? []).length) {
      if (g.free_prize) log(ctx, `  ${name} week ${w} is not the last week of its prize season: prize winners are posted with the season's last week`);
    }
    if (skipped) log(ctx, `  ${name} week ${w}: ${skipped} row(s) left out (not staked in the game that week, or already a prize winner)`);
    let ok = true;
    for (let i = 0; i < rows.length && ok; i += MAX_ROWS) {
      const batch = rows.slice(i, i + MAX_ROWS);
      ok = await send(`${name} week ${w}: points for ${batch.length} player(s)`, [{ method: "post_results", args: { game: id, week: String(w), rows: batch } }]);
    }
    for (const pl of places) {
      if (!ok) break;
      ok = await send(`${name} week ${w}: prize place ${pl.place} → ${pl.players.join(", ")}`, [{ method: "post_prize_winners", args: { game: id, week: String(w), place: pl.place, players: pl.players } }]);
    }
    if (ok) await send(`${name} week ${w}: seal the results (the owner can correct them for 24 h)`, [{ method: "seal_results", args: { game: id, week: String(w) } }]);
  }
}

/** Finalizes other games' weeks once they may be: a day (2 × close_delay) after the seal, once the last correction has
 *  stood for close_delay (the owner's correction window has closed: audit V6-1), or (no results) once the deadline has
 *  passed, or when the owner voided them. A week already started pages on at once. Pages until done. */
export async function vaultFinalizePass(ctx: VaultCtx, send: Send) {
  const view = await vaultView(ctx.chain);
  if (!view) return;
  const k = await clock(ctx.chain);
  if (k.raw?.safe_mode) { log(ctx, "  withdrawals-only build: finalizing waits for the normal build"); return; }   // V2-2
  for (const g of view.games) {
    const id = num(g.id);
    if (id === Q_GAME) continue;
    // Every closed week of the game (a closed game week is one it earned, also before a restart: fix-check VN-3).
    // Twelve weeks back, so a long bot outage is caught up (fix-check 2, V2-8); older weeks: game-finalize by hand.
    for (let w = Math.max(0, k.weeksClosed - 12); w < k.weeksClosed; w++) {
      for (let page = 0; page < 20; page++) {
        const gw = (await ctx.chain.read("get_game", { game: id, week: String(w) })).week ?? {};
        if (!gw.closed || gw.finalized) break;
        const ready = gw.voided || gw.fin_started || (gw.sealed
          ? k.time >= num(gw.seal_time) + 2 * k.closeDelay && k.time >= num(gw.last_change_time) + k.closeDelay
          : k.time >= k.resultsDue(w));
        if (!ready) break;
        const what = gw.sealed && !gw.voided ? "find the winners" : "no results: roll the week over";
        if (!(await send(`${g.name ?? `game ${id}`} week ${w}: finalize (${what})`, [{ method: "finalize_game_week", args: { game: id, week: String(w) } }])) || ctx.dryRun) break;
      }
    }
  }
}

/** Owner-only changes to the game list and results, for the hourly alerts (each emails you once). */
export function vaultAlerts(view: VaultView, k: { weeksClosed: number }, gameWeeks: Map<string, any>, ownerAlert: (key: string, text: string) => void, known?: string): string {
  for (const p of view.proposals) {
    const g = p.game ?? {};
    ownerAlert(`game-proposal:${num(g.id)}:${p.eta}`, `A game is announced: id ${num(g.id)} "${g.name}" (${[g.staked ? "stake bucket" : "", g.free_prize ? "free prize" : "", num(g.season_weeks) > 1 ? `${num(g.season_weeks)}-week seasons` : ""].filter(Boolean).join(", ")}), possible from ${utc(num(p.eta))}. If you did not do this, your admin key may be compromised.`);
  }
  const fp = JSON.stringify(view.games.map((g) => [num(g.id), !!g.active, !!g.staked, !!g.free_prize, num(g.season_weeks), num(g.from_week), num(g.last_week_plus_one)]));
  if (known && known !== fp) ownerAlert(`games:${fp}`, `The vault's game list changed (a game was added, stopped or restarted). If you did not do this, your admin key may be compromised.`);
  for (const [key, gw] of gameWeeks) {
    if (num(gw.last_change_time) > 0) ownerAlert(`game-correction:${key}:${gw.last_change_time}`, `The owner corrected results for ${key.replace(":", " week ")} at ${utc(num(gw.last_change_time))}. If you did not do this, your admin key may be compromised.`);
    if (gw.voided) ownerAlert(`game-void:${key}`, `The owner voided ${key.replace(":", " week ")}: its bucket rolls over and its prize goes back to the pool. If you did not do this, your admin key may be compromised.`);
  }
  return fp;
}

/** The weeks the alerts look at: each game's last 3 weeks. Returns "game <name>:<week>" → week record. */
export async function recentGameWeeks(chain: Chain, view: VaultView, weeksClosed: number): Promise<Map<string, any>> {
  const out = new Map<string, any>();
  for (const g of view.games) {
    const id = num(g.id);
    if (id === Q_GAME) continue;
    for (let w = Math.max(0, weeksClosed - 3); w <= weeksClosed; w++) {
      const gw = (await chain.read("get_game", { game: id, week: String(w) })).week ?? {};
      if (!earnedWeek(g, w, gw)) continue;
      out.set(`${g.name ?? `game ${id}`}:${w}`, gw);
    }
  }
  return out;
}

/** Status lines for the vault (printed by `npm run bot -- status`). */
export async function vaultStatus(chain: Chain, print: (s: string) => void) {
  const view = await vaultView(chain);
  if (!view) return;
  const k = await clock(chain);
  const t = k.t;
  print(`Vault: fee owed ${showKoin(t.fee_vhp)} VHP · buckets rolling over ${showKoin(t.games_rolled)} VHP · stake in other games ${showKoin(t.stake_other)} VHP`);
  for (const g of view.games) {
    const id = num(g.id);
    const kind = [g.staked ? "staked" : "", g.free_prize ? `free prize${num(g.season_weeks) > 1 ? ` (${num(g.season_weeks)}-week seasons)` : ""}` : ""].filter(Boolean).join(" + ");
    const state = g.active ? `from week ${num(g.from_week)}` : `stopped (last week ${num(g.last_week_plus_one) - 1})`;
    let line = `  game ${id} ${g.name}: ${kind}, ${state}; stake ${showKoin(g.stake)} VHP (counted this week ${showKoin(g.week_stake)})`;
    if (big(g.rolled) > 0n) line += `; rolling over ${showKoin(g.rolled)}`;
    if (big(g.prize_held) > 0n) line += `; season prize held ${showKoin(g.prize_held)}`;
    print(line);
    if (id === Q_GAME) continue;
    const w = k.weeksClosed - 1;
    const gw = w >= 0 ? (await chain.read("get_game", { game: id, week: String(w) })).week ?? {} : {};
    if (w >= 0 && earnedWeek(g, w, gw)) {
      const st = gw.finalized ? (gw.rolled_over ? "rolled over" : `final: ${num(gw.winners)} winner(s), cutoff ${num(gw.cutoff)}, claimed ${showKoin(gw.claimed)}`)
        : gw.voided ? "voided" : gw.sealed ? `sealed ${utc(num(gw.seal_time))}` : `results due ${utc(k.resultsDue(w))}`;
      print(`      week ${w}: bucket ${showKoin(gw.bucket)}, prize ${showKoin(gw.prize)}; ${num(gw.eligible_players)} player(s) posted; ${st}`);
    }
  }
  for (const p of view.proposals) print(`  announced: game ${num(p.game?.id)} "${p.game?.name}", can be applied from ${utc(num(p.eta))} (npm run bot -- game-apply ${num(p.game?.id)} --send)`);
}

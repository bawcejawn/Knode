/**
 * MANA ADJUSTER (sponsor v3, owner 2026-10-28): each kind of player action gets its own Mana limit, close to what it
 * really uses, so the sponsor's caps (which count each transaction's LIMIT, because the sponsor approves a transaction
 * before it runs) match the Mana really spent, while every transaction still has room to finish.
 *
 * Where the numbers come from: sponsored transactions already on the chain. Each block's receipts say who paid, the
 * limit asked for and the Mana really used (rc_used). `npm run sponsor -- mana-report` reads them, groups them by
 * action, and suggests a limit for each:
 *
 *   limit = max(the most it ever used × 2 (× 3 for a number typed in or measured on the testnet), floor 0.05 Mana),
 *           rounded up to 0.01, never above the per-transaction cap.
 *
 * Why the margin is that wide (review 2026-10-28, M1–M3): Koinos prices Mana from the market prices of disk, network
 * and compute, which move with load, so a quiet day's maximum can be too little on a busy one; a transaction also has a
 * fixed cost (its signature, its bytes, the sponsor's own checks), so only single-action transactions are measured (a
 * batch's cost split per action would under-count a lone action); and a transaction that ran out of Mana (reverted with
 * all of its limit used) means the limit was too low, so it raises that action's limit instead of being ignored.
 *
 * Safety rules (enforced here):
 *   - never below 1.25 × the most that action has ever been seen to use (else the action gets no row: the
 *     per-transaction cap, as before);
 *   - a report never lowers a limit below an older maximum's margin;
 *   - a limit is stored with the measurement it came from (sponsor-data/mana-limits.json, public), so it can be checked.
 * The result goes on chain (config.mana_caps) and into the website's deployment files (sponsor.rcLimits), so the page
 * asks for each action's own limit and the sponsor agrees.
 */
import fs from "node:fs";

export const MARGIN = 2, MANUAL_MARGIN = 3, MIN_MARGIN = 1.25;
export const FLOOR_SAT = 5000000n;             // 0.05 Mana
const STEP_SAT = 1000000n;                     // limits are rounded up to 0.01 Mana
export const LIMITS_FILE = "sponsor-data/mana-limits.json";

/** One measured action: what it is and what it used. */
export type Sample = { contract: string; entry: number; rcUsed: bigint; ops: number; reverted: boolean; rcLimit?: bigint; outOfRc?: boolean };
/** Audit SP-6: an action needs this many measured transactions before a report suggests a limit for it. */
export const MIN_SAMPLES = 20;
export type ActionStat = { contract: string; entry: number; name: string; count: number; maxSat: bigint; typicalSat: bigint; ranOut?: number; manual?: boolean };
export type LimitRow = { name: string; contract: string; entry_point: number; max_mana: string; observed?: { count: number; max: string; typical: string; source: string; at: string } };
export type LimitsFile = { v: 1; updated: string; margin: number; rows: LimitRow[] };

const roundUp = (x: bigint) => ((x + STEP_SAT - 1n) / STEP_SAT) * STEP_SAT;
// Audit SP-20: exact (8 decimals, trailing zeros trimmed), so a number shown can be typed back without rounding.
export const toMana = (sat: bigint | string) => { const v = BigInt(sat), w = v / 100000000n, f = (v % 100000000n).toString().padStart(8, "0").replace(/0+$/, ""); return f ? `${w}.${f}` : `${w}`; };
export const key = (contract: string, entry: number) => `${contract}:${(entry >>> 0).toString(16).padStart(8, "0")}`;

/** Group samples by action. Only transactions with ONE operation are measured (a transaction's fixed cost would be
 *  under-counted if a batch were split per action). Reverted transactions don't count as measurements, but one that
 *  used all of its limit "ran out" and is counted, so the limit for that action goes up (review M3). */
export function summarize(samples: Sample[], names: Record<string, string> = {}): ActionStat[] {
  const by = new Map<string, { used: bigint[]; ranOut: number }>();
  for (const s of samples) {
    if (s.ops !== 1) continue;
    const k = key(s.contract, s.entry);
    const a = by.get(k) ?? { used: [], ranOut: 0 };
    // Audit SP-11: a run-out is a reverted transaction whose receipt says it ran out of resources, or (no such log)
    // one that used 99% of its limit or more. Audit SP-6: a successful transaction that used 0 (no receipt) is no sample.
    if (s.reverted) { if (s.outOfRc || (s.rcLimit !== undefined && s.rcLimit > 0n && s.rcUsed * 100n >= s.rcLimit * 99n)) a.ranOut++; }
    else if (s.rcUsed > 0n) a.used.push(s.rcUsed);
    by.set(k, a);
  }
  return [...by.entries()].filter(([, v]) => v.used.length || v.ranOut).map(([k, v]) => {
    v.used.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const [contract, hex] = k.split(":");
    return { contract, entry: parseInt(hex, 16), name: names[k] ?? k, count: v.used.length, ranOut: v.ranOut,
      maxSat: v.used.length ? v.used[v.used.length - 1] : 0n, typicalSat: v.used.length ? v.used[Math.floor(v.used.length / 2)] : 0n };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

/** The suggested limit for an action: 2 × its maximum (3 × for a manual or testnet number), at least 0.05, rounded up,
 *  at most the per-transaction cap. */
export function suggest(maxSat: bigint, perTxSat: bigint, manual = false): bigint {
  let s = roundUp(maxSat * (manual ? 3n : 2n));
  if (s < FLOOR_SAT) s = FLOOR_SAT;
  return s > perTxSat ? perTxSat : s;
}

/** Refuses any row that could make transactions fail: below 1.25 × what was measured, 0, or above the per-transaction cap. */
export function checkRows(rows: LimitRow[], perTxSat: bigint): void {
  const seen = new Set<string>();
  if (rows.length > 16) throw new Error("At most 16 per-action Mana limits.");
  for (const r of rows) {
    const k = key(r.contract, r.entry_point);
    if (seen.has(k)) throw new Error(`${r.name}: listed twice.`);
    seen.add(k);
    const lim = BigInt(r.max_mana);
    if (lim <= 0n) throw new Error(`${r.name}: a limit must be above 0.`);
    if (lim > perTxSat) throw new Error(`${r.name}: ${toMana(lim)} Mana is above the per-transaction cap ${toMana(perTxSat)}.`);
    if (r.observed) {
      const need = (BigInt(r.observed.max) * 5n + 3n) / 4n;   // 1.25 × the most ever seen, rounded up
      if (lim < need) throw new Error(`${r.name}: ${toMana(lim)} Mana is too tight: it has used up to ${toMana(r.observed.max)}, so the limit must be at least ${toMana(need)} (1.25 ×).`);
    }
  }
}

/** New rows from a report, keeping rows for actions this report didn't see (an action rarely used keeps its limit).
 *  A new measurement never lowers a limit below the older maximum's margin. An action that ran out of Mana gets at
 *  least twice its old limit. An action too heavy for a row (its margin would pass the per-transaction cap) gets no
 *  row, so it keeps the per-transaction cap, and is listed in `skipped` (review L4). */
export function merge(old: LimitRow[], stats: ActionStat[], perTxSat: bigint, source: string, at: string, skipped: string[] = []): LimitRow[] {
  const out = new Map(old.map((r) => [key(r.contract, r.entry_point), { ...r }]));
  for (const s of stats) {
    const k = key(s.contract, s.entry), prev = out.get(k);
    // Audit SP-7: an action that ran out with no row of its own ran out at the per-transaction cap: it gets no row.
    if (s.ranOut && !prev) { skipped.push(`${s.name}: ran out of Mana at the per-transaction cap; it gets no row of its own (keeps the cap)`); continue; }
    // Audit SP-6: too few measurements (a number typed in, from mana-limit, is one on purpose).
    if (!s.manual && !s.ranOut && s.count < MIN_SAMPLES) { skipped.push(`${s.name}: only ${s.count} measured transaction(s) (need ${MIN_SAMPLES}); no change`); continue; }
    const prevMax = prev?.observed ? BigInt(prev.observed.max) : 0n;
    const max = s.maxSat > prevMax ? s.maxSat : prevMax;
    let lim = suggest(max, perTxSat, !!s.manual);
    if (prev && BigInt(prev.max_mana) > lim) lim = BigInt(prev.max_mana);              // never lowered by a report
    if (s.ranOut && prev) { const up = BigInt(prev.max_mana) * 2n; lim = up > lim ? up : lim; }
    if (lim > perTxSat) lim = perTxSat;
    const need = (max * 5n + 3n) / 4n;
    if (lim < need || (s.ranOut && prev && lim <= BigInt(prev.max_mana))) { out.delete(k); skipped.push(`${s.name}: too heavy for its own limit; it keeps the per-transaction cap`); continue; }
    out.set(k, { name: s.name, contract: s.contract, entry_point: s.entry, max_mana: lim.toString(),
      observed: { count: s.count + (prev?.observed?.count ?? 0), max: max.toString(), typical: s.typicalSat.toString(), source, at } });
  }
  const rows = [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
  checkRows(rows, perTxSat);
  return rows;
}

/** Website first, chain second (review L1): the site asks for the sum of its rows, so a site row ABOVE the chain's row
 *  would be refused. Rows the site may use while the chain still has the old ones: for each action, the lower of the
 *  chain's current row (or the per-transaction cap if none) and the new row. Pushing these first is always safe. */
export function transitionRows(chainNow: { contract: string; entry_point: number; max_mana: string }[], next: LimitRow[], perTxSat: bigint): LimitRow[] {
  const cur = new Map(chainNow.map((r) => [key(r.contract, Number(r.entry_point)), BigInt(r.max_mana)]));
  return next.map((r) => { const c = cur.get(key(r.contract, r.entry_point)) ?? perTxSat; const n = BigInt(r.max_mana); return { ...r, max_mana: (n < c ? n : c).toString() }; });
}
/** Every site row is at most the chain's row for the same action (or the per-transaction cap): nothing the site asks
 *  for can be refused for its Mana limit. */
export function siteFits(site: Record<string, string>, chainRowsNow: { contract: string; entry_point: number; max_mana: string }[], perTxSat: bigint): string[] {
  const cur = new Map(chainRowsNow.map((r) => [key(r.contract, Number(r.entry_point)), BigInt(r.max_mana)]));
  return Object.entries(site).filter(([k, v]) => BigInt(v) > (cur.get(k) ?? perTxSat)).map(([k]) => k);
}

/** Audit SP-8: what the DEPLOYED website will ask for, against the chain's rows. For every chain row, the site's entry
 *  (or, with none, its fallback limit) must be at most the row; and every site entry at most its row or the cap. */
export function siteMisfits(site: Record<string, string>, chainRowsNow: { contract: string; entry_point: number; max_mana: string }[], perTxSat: bigint, fallbackSat: bigint): string[] {
  const bad = new Set(siteFits(site, chainRowsNow, perTxSat));
  for (const r of chainRowsNow) {
    const k = key(r.contract, Number(r.entry_point)), want = site[k] !== undefined ? BigInt(site[k]) : fallbackSat;
    if (want > BigInt(r.max_mana)) bad.add(k);
  }
  return [...bad];
}

export function readLimits(file = LIMITS_FILE): LimitsFile {
  try { const j = JSON.parse(fs.readFileSync(file, "utf8")); if (j && j.v === 1 && Array.isArray(j.rows)) return j; } catch { /* none yet */ }
  return { v: 1, updated: "", margin: MARGIN, rows: [] };
}

/** The on-chain rows (config.mana_caps) and the website's map (sponsor.rcLimits: "contract:entry" → Mana in sats). */
export function chainRows(rows: LimitRow[]) { return rows.map((r) => ({ contract: r.contract, entry_point: r.entry_point, max_mana: r.max_mana })); }
export function siteMap(rows: LimitRow[]) { return Object.fromEntries(rows.map((r) => [key(r.contract, r.entry_point), r.max_mana])); }

/** Action names for the report, from the contracts' ABIs (only the player actions the sponsor pays for). */
export function actionNames(contracts: { game?: string; desk?: string; race?: string; picks?: string; tokens?: string[] }): Record<string, string> {
  const n: Record<string, string> = {};
  const add = (c: string | undefined, label: string, abiFile: string, only?: string[]) => {
    if (!c) return;
    try {
      const abi = JSON.parse(fs.readFileSync(abiFile, "utf8"));
      for (const [m, v] of Object.entries<any>(abi.methods ?? {})) if (!v.read_only && (!only || only.includes(m))) n[key(c, v.entry_point >>> 0)] = `${label} ${m}`;
    } catch { /* no ABI here */ }
  };
  add(contracts.game, "Daily Questions", "game/abi/kpred.koilib.json", ["deposit_vhp", "deposit_koin", "withdraw", "answer", "settle", "claim", "close_week", "finalize_week"]);
  add(contracts.desk, "Knode Swap", "desk/abi/desk.koilib.json", ["swap"]);
  add(contracts.race, "Producer Race", "race/abi/race.koilib.json", ["pick"]);
  add(contracts.picks, "KnodeGames Picks", "picks/abi/picks.koilib.json", ["pick"]);
  for (const t of contracts.tokens ?? []) n[key(t, 0x74e21680)] = `approve on ${t.slice(0, 6)}…`;
  return n;
}

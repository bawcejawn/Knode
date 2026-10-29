/**
 * MANA ADJUSTER (sponsor v3, owner 2026-10-28): each kind of player action gets its own Mana limit, close to what it
 * really uses, so the sponsor's caps (which count each transaction's LIMIT, because the sponsor approves a transaction
 * before it runs) match the Mana really spent, while every transaction still has room to finish.
 *
 * Where the numbers come from: sponsored transactions already on the chain. Each block's receipts say who paid, the
 * limit asked for and the Mana really used (rc_used). `npm run sponsor -- mana-report` reads them, groups them by
 * action, and suggests a limit for each:
 *
 *   limit = max(observed maximum × 1.5, floor 0.02 Mana), rounded up to 0.01, never above the per-transaction cap.
 *
 * Safety rules (enforced here, so neither the tool nor a typo can set a limit that would make transactions fail):
 *   - never below 1.25 × the most that action has ever been seen to use;
 *   - an action with no measurement keeps the per-transaction cap (no row on chain), as before;
 *   - a limit is stored with the measurement it came from (sponsor-data/mana-limits.json, public), so it can be checked.
 * The result goes on chain (config.mana_caps) and into the website's deployment files (sponsor.rcLimits), so the page
 * asks for each action's own limit and the sponsor agrees.
 */
import fs from "node:fs";

export const MARGIN = 1.5, MIN_MARGIN = 1.25;
export const FLOOR_SAT = 2000000n;             // 0.02 Mana
const STEP_SAT = 1000000n;                     // limits are rounded up to 0.01 Mana
export const LIMITS_FILE = "sponsor-data/mana-limits.json";

/** One measured action: what it is and what it used. */
export type Sample = { contract: string; entry: number; rcUsed: bigint; ops: number; reverted: boolean };
export type ActionStat = { contract: string; entry: number; name: string; count: number; maxSat: bigint; typicalSat: bigint };
export type LimitRow = { name: string; contract: string; entry_point: number; max_mana: string; observed?: { count: number; max: string; typical: string; source: string; at: string } };
export type LimitsFile = { v: 1; updated: string; margin: number; rows: LimitRow[] };

const roundUp = (x: bigint) => ((x + STEP_SAT - 1n) / STEP_SAT) * STEP_SAT;
export const toMana = (sat: bigint | string) => (Number(sat) / 1e8).toFixed(Number(sat) % 1000000 ? 4 : 2);
export const key = (contract: string, entry: number) => `${contract}:${(entry >>> 0).toString(16).padStart(8, "0")}`;

/** Group samples by action. A transaction with several operations of the same action counts as rc_used ÷ operations
 *  each (that is how the website asks: the sum of the per-action limits). Mixed transactions are skipped (they can't
 *  be split fairly). Reverted transactions are skipped (their use says nothing about a successful one). */
export function summarize(samples: Sample[], names: Record<string, string> = {}): ActionStat[] {
  const by = new Map<string, bigint[]>();
  for (const s of samples) {
    if (s.reverted || s.ops < 1) continue;
    const k = key(s.contract, s.entry);
    const per = (s.rcUsed + BigInt(s.ops) - 1n) / BigInt(s.ops);   // round up: never under-count
    const a = by.get(k) ?? []; a.push(per); by.set(k, a);
  }
  return [...by.entries()].map(([k, v]) => {
    v.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const [contract, hex] = k.split(":");
    return { contract, entry: parseInt(hex, 16), name: names[k] ?? k, count: v.length, maxSat: v[v.length - 1], typicalSat: v[Math.floor(v.length / 2)] };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

/** The suggested limit for an action: 1.5 × its maximum, at least 0.02, rounded up, at most the per-transaction cap. */
export function suggest(maxSat: bigint, perTxSat: bigint): bigint {
  let s = roundUp((maxSat * 3n + 1n) / 2n);
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
 *  A new measurement never lowers a limit below 1.25 × the older maximum either. */
export function merge(old: LimitRow[], stats: ActionStat[], perTxSat: bigint, source: string, at: string): LimitRow[] {
  const out = new Map(old.map((r) => [key(r.contract, r.entry_point), { ...r }]));
  for (const s of stats) {
    const k = key(s.contract, s.entry), prev = out.get(k);
    const prevMax = prev?.observed ? BigInt(prev.observed.max) : 0n;
    const max = s.maxSat > prevMax ? s.maxSat : prevMax;
    out.set(k, { name: s.name, contract: s.contract, entry_point: s.entry, max_mana: suggest(max, perTxSat).toString(),
      observed: { count: s.count + (prev?.observed?.count ?? 0), max: max.toString(), typical: s.typicalSat.toString(), source, at } });
  }
  const rows = [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
  checkRows(rows, perTxSat);
  return rows;
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

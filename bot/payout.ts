/**
 * The game's payout rules, written independently of the contract (plain BigInt), so the rehearsal can recount every
 * week and the website can show estimates. Must match game/assembly/Kpred.ts exactly.
 *
 *  - Winners: the top 30% of eligible (staked) players by points, headcount, everyone tied at the line included.
 *    From v4 (scorersOnly), the 30% is counted over eligible players with at least one point.
 *    A score of 0 never wins.
 *  - Each place r has a rank weight 1e9/√r; players tied share their places' weights evenly.
 *  - Basket B (pot_b): split by rank weight × stake.
 *  - Basket A (pot_a): before v5, split by rank weight only. From v5 (week.reward_rule): split by rank weight × stake
 *    counted up to 10 VHP (CAP_A), and pot_a is 40% of the pot.
 */
export const CAP_A = 10n * 100_000_000n;
const capA = (stake: bigint) => (stake < CAP_A ? stake : CAP_A);
export const W_SCALE = 1_000_000_000_000_000_000n;

export function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = n, y = n / 2n + 1n;
  while (y < x) { x = y; y = (x + n / x) / 2n; }
  return x;
}
export const rankWeight = (r: number | bigint) => isqrt(W_SCALE / BigInt(r));

export type Eligible = { pts: number; stake: bigint };
export type Group = { pts: number; players: number; stake: bigint; capped: bigint; sumW: bigint };

export function winnersOf(elig: Eligible[], scorersOnly = true) {
  const counted = scorersOnly ? elig.filter((e) => e.pts > 0).length : elig.length;
  const exactNeed = (BigInt(counted) * 30n + 99n) / 100n;               // 30%, rounded up — same as the contract
  const byPts = new Map<number, { players: number; stake: bigint; capped: bigint }>();
  for (const e of elig) { const g = byPts.get(e.pts) ?? { players: 0, stake: 0n, capped: 0n }; g.players++; g.stake += e.stake; g.capped += capA(e.stake); byPts.set(e.pts, g); }
  const maxP = Math.max(0, ...elig.map((e) => e.pts));
  let cutoff = 0, cum = 0n;
  if (exactNeed > 0n) for (let p = maxP; p >= 1; p--) { cum += BigInt(byPts.get(p)?.players ?? 0); cutoff = p; if (cum >= exactNeed) break; }
  const groups: Group[] = [];
  let rank = 1n, sumW = 0n, bw = 0n, aw = 0n;
  if (cutoff >= 1) for (let p = maxP; p >= cutoff; p--) {
    const g = byPts.get(p);
    if (!g || !g.players) continue;
    let gw = 0n;
    for (let i = 0; i < g.players; i++) { gw += rankWeight(rank); rank++; }
    groups.push({ pts: p, players: g.players, stake: g.stake, capped: g.capped, sumW: gw });
    sumW += gw;
    bw += (gw * g.stake) / BigInt(g.players);
    aw += (gw * g.capped) / BigInt(g.players);
  }
  return { cutoff, groups, sumW, bw, aw, winners: groups.reduce((a, g) => a + g.players, 0) };
}

/** One winner's reward (rounded down at every step, like the contract). `aw` given = a v5 week. */
export function rewardOf(g: Group, stake: bigint, potA: bigint, potB: bigint, sumW: bigint, bw: bigint, aw?: bigint): bigint {
  const n = BigInt(g.players);
  let r = 0n;
  if (aw !== undefined) { if (aw > 0n) r = (potA * ((g.sumW * capA(stake)) / n)) / aw; }
  else r = sumW > 0n ? (potA * g.sumW) / (n * sumW) : 0n;
  if (bw > 0n) r += (potB * ((g.sumW * stake) / n)) / bw;
  return r;
}

/** v5: up to 2 VHP of each pot go to the 2 best free players (answered at least 2 counted questions, never held the
 *  minimum stake that week). Paid even in a week whose other pots rolled over. Same as Kpred.freePrizeOf, from the
 *  finalized week's numbers. */
export const FREE_PRIZE = 2n * 100_000_000n;
export function freePrizeOf(wk: { reward_rule?: boolean; pot_free?: string | number; free_best?: number; free_best_n?: number; free_second?: number; free_second_n?: number }, pts: number, entry?: { voided?: boolean; counted?: number | string; free_player?: boolean; settled?: boolean }): bigint {
  if (entry && (entry.voided || Number(entry.counted ?? 0) < 2)) return 0n;
  // Only an entry that settled as a free player (never held the minimum stake that week: audit L-4).
  if (entry && entry.settled && !entry.free_player) return 0n;
  const pot = BigInt(wk.pot_free ?? 0), best = Number(wk.free_best ?? 0), bn = Number(wk.free_best_n ?? 0), second = Number(wk.free_second ?? 0), sn = Number(wk.free_second_n ?? 0);
  if (!wk.reward_rule || pot === 0n || pts === 0) return 0n;
  if (pts === best) return bn >= 2 ? pot / BigInt(bn) : sn > 0 ? pot / 2n : pot;
  if (pts === second && bn === 1 && sn > 0) return (pot - pot / 2n) / BigInt(sn);
  return 0n;
}
/** v5: the two best free scores and how many players share each (the contract keeps the same from settles). */
export function freeTop(free: number[]) {
  let best = 0, bn = 0, second = 0, sn = 0;
  for (const p of free) {
    if (p < 1) continue;
    if (p > best) { second = best; sn = bn; best = p; bn = 1; } else if (p === best) bn++;
    else if (p > second) { second = p; sn = 1; } else if (p === second) sn++;
  }
  return { best, bn, second, sn };
}

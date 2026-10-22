/**
 * The game's payout rules, written independently of the contract (plain BigInt), so the rehearsal can recount every
 * week and the website can show estimates. Must match game/assembly/Kpred.ts exactly.
 *
 *  - Winners: the top 30% of eligible (staked) players by points, headcount, everyone tied at the line included.
 *    From v4 (scorersOnly), the 30% is counted over eligible players with at least one point.
 *    A score of 0 never wins.
 *  - Each place r has a rank weight 1e9/√r; players tied share their places' weights evenly.
 *  - Basket A (pot_a): split by rank weight only.  Basket B (pot_b): split by rank weight × stake.
 */
export const W_SCALE = 1_000_000_000_000_000_000n;

export function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = n, y = n / 2n + 1n;
  while (y < x) { x = y; y = (x + n / x) / 2n; }
  return x;
}
export const rankWeight = (r: number | bigint) => isqrt(W_SCALE / BigInt(r));

export type Eligible = { pts: number; stake: bigint };
export type Group = { pts: number; players: number; stake: bigint; sumW: bigint };

export function winnersOf(elig: Eligible[], scorersOnly = true) {
  const counted = scorersOnly ? elig.filter((e) => e.pts > 0).length : elig.length;
  const exactNeed = (BigInt(counted) * 30n + 99n) / 100n;               // 30%, rounded up — same as the contract
  const byPts = new Map<number, { players: number; stake: bigint }>();
  for (const e of elig) { const g = byPts.get(e.pts) ?? { players: 0, stake: 0n }; g.players++; g.stake += e.stake; byPts.set(e.pts, g); }
  const maxP = Math.max(0, ...elig.map((e) => e.pts));
  let cutoff = 0, cum = 0n;
  if (exactNeed > 0n) for (let p = maxP; p >= 1; p--) { cum += BigInt(byPts.get(p)?.players ?? 0); cutoff = p; if (cum >= exactNeed) break; }
  const groups: Group[] = [];
  let rank = 1n, sumW = 0n, bw = 0n;
  if (cutoff >= 1) for (let p = maxP; p >= cutoff; p--) {
    const g = byPts.get(p);
    if (!g || !g.players) continue;
    let gw = 0n;
    for (let i = 0; i < g.players; i++) { gw += rankWeight(rank); rank++; }
    groups.push({ pts: p, players: g.players, stake: g.stake, sumW: gw });
    sumW += gw;
    bw += (gw * g.stake) / BigInt(g.players);
  }
  return { cutoff, groups, sumW, bw, winners: groups.reduce((a, g) => a + g.players, 0) };
}

/** One winner's reward (rounded down at every step, like the contract). */
export function rewardOf(g: Group, stake: bigint, potA: bigint, potB: bigint, sumW: bigint, bw: bigint): bigint {
  const n = BigInt(g.players);
  let r = sumW > 0n ? (potA * g.sumW) / (n * sumW) : 0n;
  if (bw > 0n) r += (potB * ((g.sumW * stake) / n)) / bw;
  return r;
}

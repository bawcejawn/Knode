/* Producer Bracket: the shared math. The page (bracket.js) and the recorder (bot/games/bracket.ts) both use this one
 * file, so a bracket scored in the browser and one scored by the bot always agree. No network, no page, no wallet.
 *
 * THE WEEK (owner decisions 2026-10-27)
 * - Seeding: the race field (paddock excluded) on the race card in force at Saturday 12:00 UTC before the week,
 *   ordered by VHP (biggest = seed 1; equal VHP: address order). Picks open then and lock Sunday 23:55 UTC.
 * - Size from the field: 32 or more → a 32-producer bracket (5 rounds, Monday–Friday); 16–31 → the top 16 (4 rounds,
 *   Monday–Thursday); 12–15 → 16 slots with byes for the top seeds; 8–11 → an 8-producer bracket (3 rounds,
 *   Monday–Wednesday); under 8 → no bracket that week.
 * - Round r is played on the week's UTC day r (0 = Monday). A matchup is won by the higher day index:
 *     index = blocks signed that day ÷ blocks expected that day,
 *     expected = Σ over the day's 24 hours of (blocks in that hour × the producer's VHP share on that hour's race card).
 *   That is the plain handicap (c = 0) with the hourly cards, so VHP added mid-week doesn't help. An exact tie goes to
 *   the lower seed (the underdog).
 *
 * THE PICK: one number for the whole bracket (one Picks game, kind NUMBER).
 * - The bracket has size − 1 matchups, numbered round by round, top to bottom. Bit n of the number says who wins
 *   matchup n in the player's own bracket: 0 = the better (smaller) seed, 1 = the other one. Every number is a whole,
 *   consistent bracket. A bye matchup has no choice: its bit must be 0. A number with bits set above the bracket's size
 *   or on a bye is not a valid bracket and scores nothing (the page never makes one).
 *
 * SCORING: a correct winner scores 1, 2, 4, 8, 16 points by round (round 1 = 1 point), plus 2 for the right champion.
 *   Byes score nothing. Ranking: points, then a correct champion, then more correct winners; still tied → shared place. */
(function (root) {
  "use strict";
  const HOUR = 3600000, DAY = 24 * HOUR, WEEK = 7 * DAY;
  const GENESIS = 1792368000000;               // KnodeGames week 0: Monday 2026-10-19 00:00 UTC (same as race-math)
  const SEED_BEFORE = 36 * HOUR;               // seeding card: Saturday 12:00 UTC before the week
  const LOCK_BEFORE = 5 * 60000;               // picks lock Sunday 23:55 UTC (Picks `lead`, ≥ 100 blocks)
  const MIN_FIELD = 8;
  const MAX_SIZE = 32, NUMBER_MAX = 2 ** (MAX_SIZE - 1) - 1;   // the Picks game's number range: 0 … 2,147,483,647
  const CHAMPION_BONUS = 2;
  const GAME_ID = 9;                           // the Bracket's game id in the Picks contract (Block X is 2)
  const MAX_CHANGES = 20, PICKS_PER_DAY = 20;  // the Picks game's limits
  const ROUND_NAMES = { 32: ["Round of 32", "Round of 16", "Quarterfinals", "Semifinals", "Final"],
    16: ["Round of 16", "Quarterfinals", "Semifinals", "Final"], 8: ["Quarterfinals", "Semifinals", "Final"] };

  // ── time ──
  const weekStart = (w) => GENESIS + w * WEEK;
  const weekOf = (t) => (t <= GENESIS ? 0 : Math.floor((t - GENESIS) / WEEK));
  const seedTime = (w) => weekStart(w) - SEED_BEFORE;
  const lockTime = (w) => weekStart(w) - LOCK_BEFORE;
  /** The day (ms start) on which round r of week w is played. */
  const roundDay = (w, r) => weekStart(w) + r * DAY;
  /** The Picks contract round for week w: target = round × WEEK + (GENESIS mod WEEK) = weekStart(w). */
  const ROUND_OFFSET = GENESIS % WEEK;
  const picksRound = (w) => Math.floor(GENESIS / WEEK) + w;
  const weekOfPicksRound = (r) => r - Math.floor(GENESIS / WEEK);

  // ── shape ──
  /** Bracket size for a field of n producers: 0 (no bracket), 8, 16 or 32. */
  const sizeFor = (n) => (n >= 32 ? 32 : n >= 12 ? 16 : n >= MIN_FIELD ? 8 : 0);
  const roundsOf = (size) => Math.round(Math.log2(size));
  const pointsFor = (r) => 2 ** r;
  const maxPoints = (size) => (size ? roundsOf(size) * (size / 2) + CHAMPION_BONUS : 0);
  /** Seeds in bracket line order, so 1 and 2 can only meet in the final: 16 → [1,16,8,9,4,13,5,12,2,15,7,10,3,14,6,11]. */
  function lineOrder(size) {
    let o = [1, 2];
    while (o.length < size) { const n = o.length * 2; o = o.flatMap((s) => (s % 2 ? [s, n + 1 - s] : [n + 1 - s, s])); }
    return o.length === size ? o : [];
  }
  /** Index of the first matchup of round r. */
  const roundOffset = (size, r) => size - size / 2 ** r;

  /** The seeding from a race card: { size, seeds: [address of seed 1, …] (only the producers in the bracket), out: [the
   *  rest of the field] }. size 0 means no bracket this week. */
  function seeding(card) {
    const field = (card && Array.isArray(card.field) ? card.field : []).filter((r) => r && typeof r.a === "string" && Number.isFinite(r.vhp) && r.vhp > 0);
    const seen = new Set(), rows = [];
    for (const r of field) if (!seen.has(r.a)) { seen.add(r.a); rows.push(r); }
    rows.sort((x, y) => y.vhp - x.vhp || (x.a < y.a ? -1 : x.a > y.a ? 1 : 0));
    const size = sizeFor(rows.length), n = Math.min(rows.length, size);
    return { size, seeds: rows.slice(0, n).map((r) => r.a), out: rows.slice(n).map((r) => r.a) };
  }

  /** Round 1 pairs as seed numbers [better, other]; other = 0 is a bye (no producer in that slot). */
  function firstRound(size, nSeeds) {
    const o = lineOrder(size), out = [];
    for (let i = 0; i < size; i += 2) { const a = Math.min(o[i], o[i + 1]), b = Math.max(o[i], o[i + 1]); out.push([a, b <= nSeeds ? b : 0]); }
    return out;
  }

  /** Play the bracket with a chooser for each matchup: choose(round, matchIndex, better, other) → true if `other` wins.
   *  better/other are seed numbers (other is 0 for a bye, which `better` always wins). Returns { rounds: [[winner seed of
   *  each matchup]], byes: [matchup numbers that were byes] }. */
  function play(size, nSeeds, choose) {
    let pairs = firstRound(size, nSeeds), rounds = [], byes = [];
    for (let r = 0; r < roundsOf(size); r++) {
      const winners = pairs.map(([a, b], m) => {
        if (!b) { byes.push(roundOffset(size, r) + m); return a; }
        return choose(r, m, a, b) ? b : a;
      });
      rounds.push(winners);
      pairs = [];
      for (let i = 0; i < winners.length; i += 2) pairs.push([Math.min(winners[i], winners[i + 1]), Math.max(winners[i], winners[i + 1])]);
    }
    return { rounds, byes };
  }

  /** The bye matchup numbers of a bracket. */
  const byesOf = (size, nSeeds) => play(size, nSeeds, () => false).byes;

  /** Decode a pick. Returns { rounds: [[winner seed of each matchup]] } or null if the number isn't a valid bracket. */
  function decode(number, size, nSeeds) {
    if (!size || typeof number !== "number" || !Number.isSafeInteger(number) || number < 0) return null;
    if (number >= 2 ** (size - 1)) return null;
    const bit = (n) => Math.floor(number / 2 ** n) % 2 === 1;
    for (const b of byesOf(size, nSeeds)) if (bit(b)) return null;
    return { rounds: play(size, nSeeds, (r, m) => bit(roundOffset(size, r) + m)).rounds };
  }

  /** Encode a bracket given as winner seeds per round (same shape as decode's result). Throws if it isn't consistent. */
  function encode(rounds, size, nSeeds) {
    let number = 0;
    const res = play(size, nSeeds, (r, m, a, b) => {
      const w = rounds[r] && rounds[r][m];
      if (w !== a && w !== b) throw new Error(`round ${r + 1} matchup ${m + 1}: winner must be seed ${a} or ${b}`);
      if (w === b) number += 2 ** (roundOffset(size, r) + m);
      return w === b;
    });
    for (let r = 0; r < res.rounds.length; r++) for (let m = 0; m < res.rounds[r].length; m++) {
      if (!rounds[r] || rounds[r][m] !== res.rounds[r][m]) throw new Error(`round ${r + 1} matchup ${m + 1}: not consistent`);
    }
    return number;
  }

  // ── the day index ──
  /** A producer's VHP share on a race card: its VHP ÷ the card's total VHP (field and paddock). Map address → share. */
  function sharesOf(card) {
    const rows = card ? [...(card.field || []), ...(card.paddock || [])].filter((r) => r && typeof r.a === "string" && Number.isFinite(r.vhp) && r.vhp > 0) : [];
    const tot = rows.reduce((s, r) => s + r.vhp, 0), m = new Map();
    for (const r of rows) m.set(r.a, (m.get(r.a) || 0) + r.vhp / tot);
    return m;
  }
  /** One UTC hour as the recorder stores it: { n: all blocks in the hour, by: { address: blocks signed }, share:
   *  { address: VHP share on that hour's card } or null when the hour has no card }. `only` limits by/share to the
   *  bracket's producers (the rest don't matter to any matchup). */
  function hourOf(B, from, card, only) {
    const keep = only ? new Set(only) : null, by = {};
    if (keep) for (const a of keep) by[a] = 0;
    let n = 0, i = lowerBound(B.ts, from);
    for (; i < B.ts.length && B.ts[i] < from + HOUR; i++) { n++; const a = B.signers[B.sig[i]]; if (!keep || keep.has(a)) by[a] = (by[a] || 0) + 1; }
    let share = null;
    if (card) { share = {}; for (const [a, v] of sharesOf(card)) if (!keep || keep.has(a)) share[a] = v; if (keep) for (const a of keep) if (!(a in share)) share[a] = 0; }
    return { n, by, share };
  }
  /** Day index from recorded hours (24 entries; null = an hour not recorded yet, counted as no blocks). An hour without
   *  a card uses the nearest earlier hour's card of the day, else the nearest later. Returns Map address → { blocks,
   *  expected, index }, or null when no hour of the day has a card. */
  function indexFromHours(hours) {
    if (!Array.isArray(hours) || hours.length !== 24) return null;
    const sh = hours.map((h) => (h && h.share && typeof h.share === "object" ? h.share : null));
    if (!sh.some(Boolean)) return null;
    const use = sh.map((_, h) => { for (let i = h; i >= 0; i--) if (sh[i]) return sh[i]; for (let i = h + 1; i < 24; i++) if (sh[i]) return sh[i]; return null; });
    const out = new Map(), get = (a) => { let r = out.get(a); if (!r) out.set(a, (r = { blocks: 0, expected: 0, index: 0 })); return r; };
    for (let h = 0; h < 24; h++) {
      const hr = hours[h]; if (!hr) continue;
      const n = Number(hr.n) || 0;
      for (const [a, s] of Object.entries(use[h])) if (Number.isFinite(s) && s >= 0) get(a).expected += n * s;
      for (const [a, b] of Object.entries(hr.by || {})) if (Number.isFinite(b) && b >= 0) get(a).blocks += b;
    }
    for (const r of out.values()) r.index = r.expected > 0 ? r.blocks / r.expected : 0;
    return out;
  }
  /** Day index of each producer straight from blocks. B: blocks { ts: [...ascending ms], sig: [index], signers:
   *  [address] }; hourCards: 24 race cards, one per UTC hour (null where missing). Same rules as indexFromHours. */
  function dayIndex(B, dayStart, hourCards) {
    if (!Array.isArray(hourCards) || hourCards.length !== 24) return null;
    return indexFromHours(hourCards.map((c, h) => hourOf(B, dayStart + h * HOUR, c, null)));
  }
  /** Does `other` beat `better` on a day? Higher index wins; an exact tie (compared without division) goes to `other`,
   *  the lower seed. A producer missing from the day's index counts as 0 blocks. */
  function otherWins(idx, better, other) {
    const A = idx.get(better) || { blocks: 0, expected: 0 }, B = idx.get(other) || { blocks: 0, expected: 0 };
    const sa = A.blocks * B.expected, sb = B.blocks * A.expected;   // index A vs index B, cross-multiplied
    if (A.expected <= 0 && B.expected <= 0) return true;
    if (B.expected <= 0) return false;   // the underdog was on no card all day: it can't win
    if (A.expected <= 0) return true;
    const tol = 1e-9 * Math.max(1, Math.abs(sa), Math.abs(sb));
    return sb > sa - tol;   // other's index ≥ better's index → other (tie → underdog)
  }

  /** The real results of a week: seeds (addresses), days: [dayIndex Map for each round, or null if not known yet].
   *  Returns { rounds: [[winner seed]] for each round played so far, done: true when every round is known }. */
  function results(seeds, size, days) {
    const nSeeds = seeds.length, R = roundsOf(size), rounds = [];
    let known = 0; while (known < R && days[known]) known++;
    const full = play(size, nSeeds, (r, m, a, b) => (r < known ? otherWins(days[r], seeds[a - 1], seeds[b - 1]) : false));
    for (let r = 0; r < known; r++) rounds.push(full.rounds[r]);
    return { rounds, done: known === R };
  }

  /** Score a decoded pick against results (both as winner seeds per round). Byes score nothing. */
  function score(pick, res, size, nSeeds) {
    const s = { points: 0, correct: 0, champion: false };
    if (!pick) return s;
    const byes = new Set(byesOf(size, nSeeds));
    for (let r = 0; r < res.rounds.length; r++) for (let m = 0; m < res.rounds[r].length; m++) {
      if (byes.has(roundOffset(size, r) + m)) continue;
      if (pick.rounds[r][m] === res.rounds[r][m]) { s.points += pointsFor(r); s.correct++; }
    }
    if (res.done && pick.rounds[roundsOf(size) - 1][0] === res.rounds[roundsOf(size) - 1][0]) { s.champion = true; s.points += CHAMPION_BONUS; }
    return s;
  }

  /** Rank rows [{ player, points, champion, correct }]: points, then a correct champion, then more correct winners.
   *  Tied rows share a place (1, 2, 2, 4 …). Returns new rows with `place`, best first (ties by player for a stable order). */
  function rank(rows) {
    const key = (r) => [r.points, r.champion ? 1 : 0, r.correct];
    const cmp = (x, y) => { const a = key(x), b = key(y); for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return b[i] - a[i]; return 0; };
    const out = rows.map((r) => ({ ...r })).sort((x, y) => cmp(x, y) || (x.player < y.player ? -1 : x.player > y.player ? 1 : 0));
    out.forEach((r, i) => { r.place = i > 0 && cmp(out[i - 1], r) === 0 ? out[i - 1].place : i + 1; });
    return out;
  }

  function lowerBound(ts, t) { let lo = 0, hi = ts.length; while (lo < hi) { const m = (lo + hi) >> 1; if (ts[m] < t) lo = m + 1; else hi = m; } return lo; }

  root.KBracketMath = {
    GAME_ID, MAX_CHANGES, PICKS_PER_DAY, HOUR, DAY, WEEK, GENESIS, SEED_BEFORE, LOCK_BEFORE, MIN_FIELD, MAX_SIZE, NUMBER_MAX, CHAMPION_BONUS, ROUND_NAMES, ROUND_OFFSET,
    weekStart, weekOf, seedTime, lockTime, roundDay, picksRound, weekOfPicksRound,
    sizeFor, roundsOf, pointsFor, maxPoints, lineOrder, roundOffset, seeding, firstRound, play, byesOf, decode, encode,
    sharesOf, hourOf, indexFromHours, dayIndex, otherWins, results, score, rank,
  };
})(typeof window !== "undefined" ? window : globalThis);

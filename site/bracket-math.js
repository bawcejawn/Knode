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
 *     expected = Σ over every block of the day of (the producer's VHP ÷ the VHP of every active producer), both taken
 *                just before that block, exactly, from the chain's own VHP events (owner decision 2026-10-28, option A).
 *   "Active" = signed at least one of the 7,200 blocks (about 6 hours) before. Koinos picks each block's signer in
 *   proportion to VHP, so a producer that signs its share scores about 1 whatever its size (the plain handicap, c = 0).
 *   VHP is read block by block, not at set times, so moving VHP away or adding it changes what a producer is expected
 *   to sign exactly as much as it changes its real chances: there is nothing to gain either way. Each block burns about
 *   4 VHP of its signer's (the block reward is paid in KOIN), which the rebuild follows too.
 *   An exact tie goes to the lower seed (the underdog).
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
  const ACTIVE_BLOCKS = 7200;                   // a producer is active if it signed one of the 7,200 blocks before
  const VHP_CONTRACT = "12Y5vW6gk8GceH53YfRkRre2Rrcsgw7Naq";   // mainnet VHP (the race recorder reads the same)
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

  // ── exact VHP, block by block ──
  /** VHP changes from decoded token events of the VHP contract: [{ h (height of the block holding the event), a,
   *  d (satoshi, + in / − out) }]. events: [{ h, src, name, from, to, value }]; others are ignored. */
  function vhpDeltas(events, contract = VHP_CONTRACT) {
    const out = [];
    for (const e of Array.isArray(events) ? events : []) {
      if (!e || e.src !== contract || !Number.isInteger(e.h)) continue;
      const v = Number(e.value); if (!Number.isFinite(v) || v < 0) continue;
      const n = String(e.name || "");
      if (/transfer_event$/.test(n)) { if (typeof e.from === "string") out.push({ h: e.h, a: e.from, d: -v }); if (typeof e.to === "string") out.push({ h: e.h, a: e.to, d: v }); }
      else if (/mint_event$/.test(n)) { if (typeof e.to === "string") out.push({ h: e.h, a: e.to, d: v }); }
      else if (/burn_event$/.test(n)) { if (typeof e.from === "string") out.push({ h: e.h, a: e.from, d: -v }); }
    }
    return out;
  }
  /** A VHP book: anchors { address: { h, v } } (v = satoshi balance AFTER block h, read on the chain) and the deltas of
   *  every block between the anchor and any height asked about. book.before(a, h) = satoshi balance just before block
   *  h (after block h − 1), or null for an address without an anchor. */
  function vhpBook(anchors, deltas) {
    const per = new Map();
    for (const x of deltas) { if (!anchors[x.a]) continue; let l = per.get(x.a); if (!l) per.set(x.a, (l = [])); l.push(x); }
    const idx = new Map();
    for (const [a, l] of per) {
      l.sort((p, q) => p.h - q.h);
      const hs = l.map((x) => x.h), cum = new Float64Array(l.length + 1);
      for (let i = 0; i < l.length; i++) cum[i + 1] = cum[i] + l[i].d;
      idx.set(a, { hs, cum });
    }
    const upTo = (a, x) => { const t = idx.get(a); if (!t) return 0; let lo = 0, hi = t.hs.length; while (lo < hi) { const m = (lo + hi) >> 1; if (t.hs[m] <= x) lo = m + 1; else hi = m; } return t.cum[lo]; };
    return {
      before(a, h) {
        const an = anchors[a]; if (!an) return null;
        return an.v + upTo(a, h - 1) - upTo(a, an.h);   // after block h − 1 = anchor ± the blocks in between
      },
    };
  }
  /** Hour records from blocks. B: { hs: [heights], ts: [ms], sig: [index], signers: [address] }, contiguous and starting
   *  at least ACTIVE_BLOCKS before the first hour (fewer: the active set is what is there). starts: hour starts (ms).
   *  Returns one { from, to, n, by: { seed: blocks }, exp: { seed: expected blocks } } per start (to < from when the
   *  hour had no block), or throws if a needed balance is missing. */
  function exactHours(B, starts, seeds, book) {
    const out = [], keep = new Set(seeds);
    const lb = (t) => lowerBound(B.ts, t);
    for (const start of starts) {
      const i0 = lb(start), i1 = lb(start + HOUR);
      const by = {}, exp = {};
      for (const a of seeds) { by[a] = 0; exp[a] = 0; }
      const last = new Map();
      for (let i = Math.max(0, i0 - ACTIVE_BLOCKS); i < i0; i++) last.set(B.signers[B.sig[i]], i);
      for (let i = i0; i < i1; i++) {
        let tot = 0; const vs = [];
        for (const [a, j] of last) {
          if (j < i - ACTIVE_BLOCKS) { last.delete(a); continue; }
          const v = book.before(a, B.hs[i]);
          if (v === null) throw new Error(`no VHP balance for ${a} at block ${B.hs[i]}`);
          if (v > 0) { tot += v; vs.push([a, v]); }
        }
        if (tot > 0) for (const [a, v] of vs) if (keep.has(a)) exp[a] += v / tot;
        for (const a of seeds) if (!last.has(a)) {   // a seed that wasn't active: still expected in proportion (it holds VHP)
          const v = book.before(a, B.hs[i]);
          if (v !== null && v > 0 && tot > 0) exp[a] += v / (tot + v);
        }
        const s = B.signers[B.sig[i]];
        if (keep.has(s)) by[s]++;
        last.set(s, i);
      }
      for (const a of seeds) exp[a] = Math.round(exp[a] * 1e6) / 1e6;
      out.push({ from: i1 > i0 ? B.hs[i0] : (i0 < B.hs.length ? B.hs[i0] : B.hs[B.hs.length - 1] + 1), to: i1 > i0 ? B.hs[i1 - 1] : (i0 < B.hs.length ? B.hs[i0] - 1 : B.hs[B.hs.length - 1]), n: i1 - i0, by, exp });
    }
    return out;
  }
  /** Day index from the 24 recorded hours: Map address → { blocks, expected, index }; null unless every hour is in. */
  function indexFromHours(hours) {
    if (!Array.isArray(hours) || hours.length !== 24 || !hours.every((h) => h && h.exp && typeof h.exp === "object")) return null;
    const out = new Map(), get = (a) => { let r = out.get(a); if (!r) out.set(a, (r = { blocks: 0, expected: 0, index: 0 })); return r; };
    const ok = (x) => Number.isFinite(x) && x >= 0;
    for (const hr of hours) {
      for (const [a, e] of Object.entries(hr.exp)) if (ok(e)) get(a).expected += e;
      for (const [a, b] of Object.entries(hr.by || {})) if (ok(b)) get(a).blocks += b;
    }
    for (const r of out.values()) r.index = r.expected > 0 ? r.blocks / r.expected : 0;
    return out;
  }
  /** The index so far in a day still being played (hours recorded up to now; for the page's live view). */
  function indexSoFar(hours) {
    const got = (Array.isArray(hours) ? hours : []).filter((h) => h && h.exp);
    if (!got.length) return null;
    return indexFromHours([...got, ...new Array(24 - got.length).fill({ n: 0, by: {}, exp: {} })].slice(0, 24));
  }
  /** Day index straight from blocks and a book (tests and the replay): the 24 hours from dayStart. */
  function dayIndex(B, dayStart, seeds, book) {
    return indexFromHours(exactHours(B, Array.from({ length: 24 }, (_, h) => dayStart + h * HOUR), seeds, book));
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
    ACTIVE_BLOCKS, VHP_CONTRACT, vhpDeltas, vhpBook, exactHours, indexFromHours, indexSoFar, dayIndex, otherWins, results, score, rank,
  };
})(typeof window !== "undefined" ? window : globalThis);

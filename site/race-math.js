/* Producer Race: the shared math. The page (race.js) and the race recorder (bot/race.ts) both use this one file, so
 * a race scored in the browser and a race recorded by the bot always agree. No network, no page, no wallet.
 *
 * FORMAT
 * - 4 races a day, 6 hours each, on UTC boundaries: 00:00, 06:00, 12:00, 18:00. The week is the KnodeGames week
 *   (Monday 00:00 UTC, counted from the game's start on 2026-10-19), so a week holds exactly 28 races.
 * - Every block a producer signs during a race moves its horse forward by that producer's handicap. Each race starts
 *   from 0. The winner is the horse with the most steps when the 6 hours are up.
 * - Each race has 6 handicap cards, one per 1-hour leg: the starting card and an update every hour (owner's decision
 *   2026-10-27; races recorded before that have 3 cards of 2 hours, and keep them). A card is set from each producer's
 *   VHP at the time it is taken, and applies to the blocks signed in its leg. A race's leg length is 6 h divided by its
 *   number of cards.
 *
 * THE HANDICAP
 *   h = (VHP of the biggest producer ÷ this producer's VHP) × (1 − c ÷ √k) ÷ (1 − c ÷ √k_top)
 * - The first part gives every horse the same expected speed (Koinos picks block signers in proportion to VHP).
 * - The second part trims luck: a small producer's few blocks come in lucky or unlucky bursts (luck in a count of k
 *   blocks is about √k), which would otherwise let the smallest horses win most races. k = the blocks a producer is
 *   expected to sign in a whole race (6 hours).
 * - c is tuned for each card: the value (0.0 to 2.5 in steps of 0.1) that gives every horse the most equal chance of
 *   winning a fresh 6-hour race, from 4,000 simulated races with a fixed seed, so anyone re-running it gets the same c.
 * - Producers expected to sign fewer than 10 blocks in a race wait in the paddock: with so few blocks one lucky block
 *   decides the race, and no handicap gives them a fair chance (at 6 blocks it is about half a fair chance).
 * - The biggest producer always moves exactly 1 step per block. Handicaps are rounded to 4 decimals.
 *
 * SCORING A PICK
 * - A pick on the winner scores a win (3 points); a pick on the horse that finishes 2nd or 3rd scores a show (1 point). */
(function (root) {
  "use strict";
  const HOUR = 3600000, RACE = 6 * HOUR, LEG = HOUR, LEGS = 6, DAY = 24 * HOUR, WEEK = 7 * DAY;
  const GENESIS = 1792368000000;    // the KnodeGames week 0: Monday 2026-10-19 00:00 UTC (game-data/deployment.json genesisTime)
  const MIN_K = 10;                 // expected blocks in a race to enter (fewer: too few blocks for any handicap to be fair)
  const C_GRID = Array.from({ length: 26 }, (_, i) => i / 10);
  const SEED = 20261027, TRIALS = 4000;
  const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;

  // ── time ──
  const raceIndex = (t) => Math.floor(t / RACE);
  const raceStart = (i) => i * RACE;
  /** "2026-10-27T06": the UTC start of the race. */
  const raceId = (i) => new Date(raceStart(i)).toISOString().slice(0, 13);
  function parseRaceId(id) { const m = /^(\d{4}-\d{2}-\d{2})T(00|06|12|18)$/.exec(String(id)); return m ? raceIndex(Date.parse(`${m[1]}T${m[2]}:00:00Z`)) : null; }
  /** The race running at time t. */
  function raceAt(t) { const i = raceIndex(t), start = raceStart(i); return { index: i, id: raceId(i), start, end: start + RACE, number: ((i % 4) + 4) % 4 + 1 }; }
  /** The leg of a race at time t, clamped to the race; n = the race's number of cards (6, or 3 for older races). */
  const legOf = (start, t, n = LEGS) => Math.min(n - 1, Math.max(0, Math.floor((t - start) / (RACE / n))));
  /** How many legs (cards) a race has: its cards array, else the current format. */
  const legsOf = (cards) => (Array.isArray(cards) && (cards.length === 3 || cards.length === 6) ? cards.length : LEGS);
  /** The KnodeGames week of a time (same as the game contract's week_of: weeks before the start count as 0). */
  const weekOf = (t) => (t <= GENESIS ? 0 : Math.floor((t - GENESIS) / WEEK));
  const weekStart = (w) => GENESIS + w * WEEK;
  const dayOf = (t) => new Date(t).toISOString().slice(0, 10);   // UTC day

  // ── seeded random numbers ──
  function rng(seed) {
    let a = seed >>> 0, spare = null;
    const next = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const normal = () => { if (spare !== null) { const s = spare; spare = null; return s; } let u = 0; while (u === 0) u = next(); const v = next(); const r = Math.sqrt(-2 * Math.log(u)); spare = r * Math.sin(2 * Math.PI * v); return r * Math.cos(2 * Math.PI * v); };
    const poisson = (mean) => {
      if (mean <= 0) return 0;
      if (mean >= 30) return Math.max(0, Math.round(mean + Math.sqrt(mean) * normal()));
      const L = Math.exp(-mean); let k = 0, p = 1;
      do { k++; p *= next(); } while (p > L);
      return k - 1;
    };
    return { next, normal, poisson };
  }

  // ── handicap ──
  const handicapOf = (k, kTop, c) => (kTop / k) * (1 - c / Math.sqrt(k)) / (1 - c / Math.sqrt(kTop));
  function drawCounts(ks, trials = TRIALS, seed = SEED) {
    const R = rng(seed), out = new Array(trials);
    for (let t = 0; t < trials; t++) { const row = new Float64Array(ks.length); for (let i = 0; i < ks.length; i++) row[i] = R.poisson(ks[i]); out[t] = row; }
    return out;
  }
  function chancesFrom(counts, hs) {
    const n = hs.length, wins = new Array(n).fill(0);
    for (const row of counts) {
      let best = -1, nb = 0;
      for (let i = 0; i < n; i++) { const p = row[i] * hs[i]; if (p > best + 1e-9) { best = p; nb = 1; } else if (Math.abs(p - best) <= 1e-9) nb++; }
      for (let i = 0; i < n; i++) if (Math.abs(row[i] * hs[i] - best) <= 1e-9) wins[i] += 1 / nb;
    }
    return wins.map((w) => w / counts.length);
  }
  /** Chance each horse wins a fresh race (for checking fairness only; the page never shows it). */
  const winChances = (ks, hs, trials = TRIALS, seed = SEED) => chancesFrom(drawCounts(ks, trials, seed), hs);
  /** The luck trim c that makes the horses' chances most equal. */
  function calibrate(ks, trials = TRIALS) {
    if (ks.length < 2) return { c: 0, spread: 0 };
    const kTop = ks[0], fair = 1 / ks.length, cMax = Math.sqrt(Math.min(...ks)) * 0.8, counts = drawCounts(ks, trials);
    let best = null;
    for (const c of C_GRID) {
      if (c >= cMax) break;
      const w = chancesFrom(counts, ks.map((k) => handicapOf(k, kTop, c)));
      const err = w.reduce((s, x) => s + (x - fair) * (x - fair), 0);
      if (!best || err < best.err - 1e-12) best = { c, err, min: Math.min(...w), max: Math.max(...w) };
    }
    return { c: best.c, min: best.min, max: best.max };
  }

  /** A handicap card from VHP readings. vhp: [[address, VHP as a number], ...] for the producers seen recently;
   *  blocksPerRace: how many blocks a 6-hour race is expected to have (from the recent fill rate). */
  function makeCard(vhp, blocksPerRace, at = 0) {
    const all = vhp.filter(([a, v]) => typeof a === "string" && Number.isFinite(v) && v > 0);
    const total = all.reduce((s, [, v]) => s + v, 0);
    const rows = all.map(([a, v]) => ({ a, vhp: v, k: total > 0 ? blocksPerRace * v / total : 0 })).sort((x, y) => y.vhp - x.vhp || (x.a < y.a ? -1 : 1));
    const field = rows.filter((r) => r.k >= MIN_K), paddock = rows.filter((r) => r.k < MIN_K);
    const ks = field.map((r) => r.k), cal = calibrate(ks);
    return {
      at, blocksPerRace: round(blocksPerRace, 1), c: cal.c,
      fairness: field.length ? [round(cal.min, 4), round(cal.max, 4)] : null,
      field: field.map((r) => ({ a: r.a, vhp: round(r.vhp, 2), k: round(r.k, 2), h: round(handicapOf(r.k, ks[0], cal.c), 4) })),
      paddock: paddock.map((r) => ({ a: r.a, vhp: round(r.vhp, 2), k: round(r.k, 2) })),
    };
  }
  /** The card for a leg: that leg's own card, else the latest earlier one, else the earliest later one (a leg the
   *  recorder missed keeps the card before it; a race whose first card came late uses that card from the start). */
  function cardForLeg(cards, leg) {
    if (!Array.isArray(cards)) return null;
    for (let l = leg; l >= 0; l--) if (cards[l]) return cards[l];
    for (let l = leg + 1; l < cards.length; l++) if (cards[l]) return cards[l];
    return null;
  }
  /** The finish line: the steps the biggest producer is expected to cover in the whole race (its k on each leg's card,
   *  a third of the race each). Every horse races toward it; the handicap makes it the same distance for all. */
  function finishLine(cards) {
    let s = 0;
    const n = legsOf(cards);
    for (let l = 0; l < n; l++) { const c = cardForLeg(cards, l); if (!c || !c.field.length) return null; s += c.field[0].k / n; }
    return round(s, 2);
  }

  /** Steps of every horse in a race up to time T. B: blocks { ts: [...ascending], sig: [index], signers: [address] }.
   *  Returns horses sorted by steps (ties: whoever reached the total first), each { a, steps, blocks, last }. */
  function standings(B, race, cards, T = race.end) {
    const n = legsOf(cards), until = Math.min(T, race.end);
    const hs = Array.from({ length: n }, (_, l) => { const c = cardForLeg(cards, l); return new Map((c ? c.field : []).map((r) => [r.a, r.h])); });
    const horses = new Map();
    for (const m of hs) for (const a of m.keys()) if (!horses.has(a)) horses.set(a, { a, steps: 0, blocks: 0, last: 0 });
    let i = lowerBound(B.ts, race.start);
    for (; i < B.ts.length && B.ts[i] < until; i++) {
      const a = B.signers[B.sig[i]], h = hs[legOf(race.start, B.ts[i], n)].get(a);
      if (!h) continue;
      const r = horses.get(a); r.steps += h; r.blocks++; r.last = B.ts[i];
    }
    const out = [...horses.values()].map((r) => ({ ...r, steps: round(r.steps, 4) }));
    out.sort((x, y) => y.steps - x.steps || (x.last || Infinity) - (y.last || Infinity) || (x.a < y.a ? -1 : 1));
    return out;
  }
  /** The winner of finished standings: most steps; on an exact tie, the horse that reached that total first. */
  function winners(st) { return st.length && st[0].steps > 0 ? [st[0].a] : []; }
  /** Show: the horses that finish 2nd and 3rd (each with at least one step), once the race has a winner. A pick on the
   *  winner is a win, not a show. Points: a win 3, a show 1 (owner's default 2026-10-27). */
  const POINTS = Object.freeze({ win: 3, show: 1 });
  function shows(st) { return winners(st).length ? st.slice(1, 3).filter((r) => r.steps > 0).map((r) => r.a) : []; }
  /** What the track shows during a race: a horse never passes the finish line, and the order among horses at the line
   *  stays hidden until the race ends. behind = steps behind the leader as drawn (capped at the line). */
  function track(st, line, ended) {
    const leadDrawn = st.length ? Math.min(st[0].steps, line) : 0;
    return st.map((r) => {
      const atLine = r.steps >= line;
      return { ...r, x: line > 0 ? Math.min(1, r.steps / line) : 0, atLine, behind: ended ? round(st[0].steps - r.steps, 1) : (atLine ? 0 : round(leadDrawn - r.steps, 1)) };
    });
  }
  function lowerBound(ts, t) { let lo = 0, hi = ts.length; while (lo < hi) { const m = (lo + hi) >> 1; if (ts[m] < t) lo = m + 1; else hi = m; } return lo; }

  root.KRaceMath = {
    HOUR, RACE, LEG, LEGS, DAY, WEEK, GENESIS, MIN_K, SEED, TRIALS,
    raceIndex, raceStart, raceId, parseRaceId, raceAt, legOf, legsOf, weekOf, weekStart, dayOf,
    rng, handicapOf, winChances, calibrate, makeCard, cardForLeg, finishLine, standings, winners, shows, POINTS, track, lowerBound,
  };
})(typeof window !== "undefined" ? window : globalThis);

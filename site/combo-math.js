/* Combo Card: the shared math. The page (combo.js) and the recorder (bot/games/combo.ts) both use this one file, so a
 * card priced in the browser and a card scored by the recorder always agree. No network, no page, no wallet.
 * Needs site/race-math.js and site/blockx-math.js loaded first. Owner's decisions 2026-10-28 (claude/builds/08-combo-card-plan.md).
 *
 * A CARD is 2 to 6 legs. Every leg must hit for the card to score; one miss and it scores 0.
 *
 * LEGS (code: what it says)
 *   1 Race Win:      horse P wins race R.
 *   2 Race Show:     horse P finishes in the top 3 of race R.
 *   3 Race Top-half: horse P finishes in the top half of race R's field (places 1 to floor(N / 2), N = horses in the
 *                    race's final standings).
 *   4 Block X:       producer P signs block T (T a multiple of 2,400; round = T / 2,400).
 *   A race leg needs the horse to have moved (steps > 0). Race legs' round is the race index (KRaceMath.raceIndex).
 *   PER RACE (owner, 2026-10-28): up to 3 legs on one race, at most one of each type (a Win, a Show and a Top half,
 *   on different horses). PER BLOCK: one leg (two producers can't both sign it).
 *   ONE LEG PER PRODUCER (owner, 2026-10-28): a producer appears in at most one leg of the whole card, Block X
 *   included, because a producer's good day carries all its legs at once and they would hit together far more often
 *   than their prices say. Legs on different horses of one race slightly work against each other (one finishing high
 *   leaves less room for the other), so they never pay more than they should.
 *
 * LOCKS (the Picks contract enforces them): a card can be made or changed only while EVERY leg is open:
 *   - race legs until 25 minutes before the race starts, at most 24 hours ahead (owner, 2026-10-28);
 *   - Block X legs until 500 blocks (~25 min) before the target, at most 28,800 blocks (~24 h) ahead (owner,
 *     2026-10-28: earlier than Block X's own 100-block lock).
 *   3 cards per wallet per UTC day (slots 0, 1, 2: round = UTC day × 3 + slot); each changeable up to 3 times, only
 *   on its own UTC day and only while every leg of the old and the new card is still open.
 *
 * PRICE: each leg has a factor = clamp(0.5 ÷ chance, 0.25, 3), 2 decimals. The chance comes from the PRICE CARD: the
 * latest Producer Race card taken (card.at) at or before the time the card was made (or last changed):
 *   - race legs: the horse's chance of winning / finishing top 3 / top half of a fresh 6-hour race with that card's
 *     handicaps, from 4,000 simulated races with a fixed seed (anyone re-running it gets the same numbers);
 *   - Block X: the producer's share of all VHP on the card (field and paddock).
 *   A race leg on a horse that is not in the price card's field can't be priced: it counts as a miss (the page never
 *   offers it). A Block X leg on a producer missing from the card gets the top factor, 3 (as in Block X).
 *   Points = base × all factors, with NO cap (owner, 2026-10-28: "if they can build it they can win it"), base by legs:
 *   2 → 3, 3 → 7, 4 → 15, 5 → 30, 6 → 60, 7 → 120, 8 → 240, 9 → 480, 10 → 960 (each leg roughly doubles it, so a
 *   fairly priced leg keeps a card's expected points level). Kept in hundredths. The game runs at up to 6 legs
 *   (MAX_LEGS); the contract allows up to 10 (HARD_MAX_LEGS), opened with 48 hours' notice when more games add legs.
 *   Simulated 2026-10-28: removing the cap doesn't change who reaches the top 30%; the week's #1 is then usually
 *   decided by one big card (80% of the leader's week vs 45% with a 150 cap).
 *   Easy legs are worth less than ×1 (down to ×0.25), so stacking near-certain legs is not free points.
 *
 * VOID LEGS: a leg whose race or target is void (no card, never recorded), or whose horse is not in the race at all,
 * is dropped. The card scores on the rest with the base for that many legs; with fewer than 2 legs left it is void.
 * A card is final only when every one of its legs is final.
 *
 * WEEK: a card counts in the KnodeGames week of the UTC day it was made (its slot day). A player's week = the sum of
 * their best 10 cards. Ties: more cards that hit, then the earlier last hit, then address. */
(function (root) {
  "use strict";
  const M = root.KRaceMath, X = root.KBlockX;
  if (!M || !X) throw new Error("combo-math needs race-math.js and blockx-math.js first");

  const GAME_ID = 8;
  const WIN = 1, SHOW = 2, HALF = 3, BLOCK = 4;
  const CODES = [WIN, SHOW, HALF, BLOCK];
  const NAMES = { 1: "Win", 2: "Show", 3: "Top half", 4: "Block X" };
  const FAMILY = { 1: "race", 2: "race", 3: "race", 4: "block" };
  const MIN_LEGS = 2, MAX_LEGS = 6;
  const BASE = { 2: 3, 3: 7, 4: 15, 5: 30, 6: 60, 7: 120, 8: 240, 9: 480, 10: 960 };
  const HARD_MAX_LEGS = 10;                // the Picks contract's limit (list_size)
  const CAP = null;                        // no cap on a card's points (owner, 2026-10-28)
  const PREF = 0.5, F_MIN = 0.25, F_MAX = 3;
  const CARDS_PER_DAY = 3, MAX_CHANGES = 3, BEST = 10;
  const RACE_LEAD_MS = 25 * 60000, RACE_AHEAD_MS = 24 * M.HOUR;
  const BLOCK_LEAD = 500, BLOCK_AHEAD = 28800;
  const DAY = M.DAY;
  const round2 = (x) => Math.round(x * 100) / 100;
  const round4 = (x) => Math.round(x * 1e4) / 1e4;
  const isAddr = (a) => typeof a === "string" && /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a);
  const isRace = (code) => FAMILY[code] === "race";
  /** Window legs: outcomes over a stretch of blocks (later games' legs will be window legs too). Block X is one block. */
  const isWindow = (code) => code !== BLOCK;
  /** What a leg occupies on a card: one per type per race ("1:race 1234"), one per block ("block:5678"). */
  const slotKey = (l) => (isRace(l.code) ? `${l.code}:race:${l.round}` : `block:${l.round}`);

  // ── slots ──
  const slotRound = (day, slot) => day * CARDS_PER_DAY + slot;
  const dayOfRound = (round) => Math.floor(round / CARDS_PER_DAY);
  const utcDay = (t) => Math.floor(t / DAY);

  // ── locks (exactly the contract's rules) ──
  /** When a leg locks: { mode: "time", at: ms } or { mode: "height", at: height } (the first time/height refused). */
  function lockOf(leg) {
    return isRace(leg.code) ? { mode: "time", at: M.raceStart(leg.round) - RACE_LEAD_MS } : { mode: "height", at: X.target(leg.round) - BLOCK_LEAD };
  }
  /** Is this leg open for a card landing in a block at `head` = { height, time }? */
  function legOpen(leg, head) {
    if (isRace(leg.code)) { const start = M.raceStart(leg.round); return leg.round >= 1 && head.time < start - RACE_LEAD_MS && start - head.time <= RACE_AHEAD_MS; }
    const t = X.target(leg.round);
    return leg.round >= 1 && head.height < t - BLOCK_LEAD && t - head.height <= BLOCK_AHEAD;
  }
  /** The earliest lock of a card, as an estimated time (Block X heights at ~3 s a block from the head). */
  function cardLockTime(legs, head) {
    let best = Infinity;
    for (const l of legs) { const k = lockOf(l); const t = k.mode === "time" ? k.at : X.aboutTime(k.at, head.height, head.time); if (t < best) best = t; }
    return best;
  }

  /** Why a card can't be made now (null if it can). legs: [{ code, round, producer }]. Same order as the contract. */
  function cardProblem(legs, head) {
    if (!Array.isArray(legs) || legs.length < MIN_LEGS) return "A card needs at least 2 legs.";
    if (legs.length > MAX_LEGS) return "A card has at most 6 legs.";
    const seen = new Set(), producers = new Set();
    for (const l of legs) {
      if (!l || !CODES.includes(l.code) || !Number.isSafeInteger(l.round) || l.round < 1) return "Unknown leg.";
      if (!isAddr(l.producer)) return "A leg names an invalid producer.";
      const k = slotKey(l);
      if (seen.has(k)) return isRace(l.code) ? `Only one ${NAMES[l.code]} leg per race.` : "Only one leg per block.";
      seen.add(k);
      if (producers.has(l.producer)) return "A producer can be in only one leg per card.";
      producers.add(l.producer);
      if (!legOpen(l, head)) return `${NAMES[l.code]} leg is locked or not open yet.`;
    }
    return null;
  }

  // ── price ──
  /** The price card at time t: the latest race card taken at or before t, from a list of races (race-data weeks). */
  function priceCard(races, t) {
    let best = null;
    for (const r of races || []) for (const c of (r && Array.isArray(r.cards) ? r.cards : [])) {
      if (c && Number.isFinite(c.at) && c.at <= t && Array.isArray(c.field) && c.field.length && (!best || c.at > best.at)) best = c;
    }
    return best;
  }

  /** Each field horse's chance to win, finish top 3 and finish top half of a fresh race with this card (seeded).
   *  Ties share the places they cover. Returns Map(address → { win, show, half }) with 4 decimals. */
  const chanceCache = new Map();
  function raceChances(card) {
    const key = card && card.at + ":" + card.field.map((r) => r.a + "/" + r.k + "/" + r.h).join(",");
    if (chanceCache.has(key)) return chanceCache.get(key);
    const F = card.field, n = F.length, ks = F.map((r) => r.k), hs = F.map((r) => r.h);
    const R = M.rng(M.SEED), cut = [1, 3, Math.floor(n / 2)];
    const acc = F.map(() => [0, 0, 0]);
    const steps = new Float64Array(n), idx = Array.from({ length: n }, (_, i) => i);
    for (let t = 0; t < M.TRIALS; t++) {
      for (let i = 0; i < n; i++) steps[i] = R.poisson(ks[i]) * hs[i];
      idx.sort((a, b) => steps[b] - steps[a] || a - b);
      for (let p = 0; p < n; ) {
        let q = p + 1;
        while (q < n && Math.abs(steps[idx[q]] - steps[idx[p]]) <= 1e-9) q++;
        for (let c = 0; c < 3; c++) { const share = Math.max(0, Math.min(q, cut[c]) - p) / (q - p); if (share) for (let j = p; j < q; j++) acc[idx[j]][c] += share; }
        p = q;
      }
    }
    const out = new Map(F.map((r, i) => [r.a, { win: round4(acc[i][0] / M.TRIALS), show: round4(acc[i][1] / M.TRIALS), half: round4(acc[i][2] / M.TRIALS) }]));
    if (chanceCache.size > 50) chanceCache.clear();
    chanceCache.set(key, out);
    return out;
  }
  const factorOf = (chance) => (chance > 0 ? round2(Math.min(F_MAX, Math.max(F_MIN, PREF / chance))) : F_MAX);

  /** A leg's price with a card: { chance, factor } (factor in hundredths as f100), or null if it can't be priced
   *  (a race leg on a horse not in the card's field). */
  function priceLeg(card, leg) {
    if (!card) return null;
    if (leg.code === BLOCK) {
      const { m } = X.vhpOf(card);
      let total = 0; for (const v of m.values()) total += v;
      const v = m.get(leg.producer);
      if (!v || !total) return { chance: null, factor: F_MAX, f100: F_MAX * 100 };
      const chance = round4(v / total), f = factorOf(chance);
      return { chance, factor: f, f100: Math.round(f * 100) };
    }
    const c = raceChances(card).get(leg.producer);
    if (!c) return null;
    const chance = leg.code === WIN ? c.win : leg.code === SHOW ? c.show : c.half, f = factorOf(chance);
    return { chance, factor: f, f100: Math.round(f * 100) };
  }

  /** Points (hundredths) for legs with these factors (hundredths): base × product, rounded down, no cap. Exact
   *  (BigInt), so the page and the recorder never differ by a rounding. Up to 10 legs (the contract's limit): the
   *  most a card can score is 960 × 3^10 = 56,687,040 points, well inside exact integers. */
  function pointsFor(f100s) {
    const n = f100s.length;
    if (n < MIN_LEGS || n > HARD_MAX_LEGS) return 0;
    let num = BigInt(BASE[n] * 100), den = 1n;
    for (const f of f100s) { num *= BigInt(f); den *= 100n; }
    return Number(num / den);
  }
  /** What a card would pay if every leg hits (hundredths), and each leg's price. null if a leg can't be priced. */
  function potential(card, legs) {
    const prices = legs.map((l) => priceLeg(card, l));
    if (prices.some((p) => !p)) return { pts: 0, prices, unpriced: true };
    return { pts: pointsFor(prices.map((p) => p.f100)), prices, unpriced: false };
  }

  // ── results ──
  /** A leg's result: "hit", "miss", "void" or "pending".
   *  race: the race's record from race-data ({ result: { final, missed?, standings } }) or null;
   *  target: the Block X target record ({ final, signer, void? }) or null. */
  function legResult(leg, race, target) {
    if (isRace(leg.code)) {
      const res = race && race.result;
      if (!res || !res.final) return "pending";
      if (res.missed || res.void || !Array.isArray(res.standings)) return "void";
      const st = res.standings, i = st.findIndex((s) => s && s.a === leg.producer);
      if (i < 0) return "void";                       // not in the race at all: no fault of the player
      if (!(st[i].steps > 0)) return "miss";
      const need = leg.code === WIN ? 1 : leg.code === SHOW ? 3 : Math.floor(st.length / 2);
      return i < need ? "hit" : "miss";
    }
    if (!target || target.final !== true) return "pending";
    if (target.void || !target.signer) return "void";
    return target.signer === leg.producer ? "hit" : "miss";
  }

  /** Score a card. legs: [{ code, round, producer }]; card: its price card; results: one per leg (legResult).
   *  Returns { state: "pending" | "final", outcome: "hit" | "miss" | "void" | null, pts (hundredths), counted (legs scored) }.
   *  A miss is final as soon as it is known only for display (outcome); the card itself is final when every leg is. */
  function scoreCard(card, legs, results) {
    const pending = results.some((r) => r === "pending");
    const anyMiss = results.some((r) => r === "miss");
    const prices = legs.map((l) => priceLeg(card, l));
    // A leg that can't be priced (horse not on the price card) is a miss, unless that leg is void anyway.
    const eff = results.map((r, i) => (r !== "void" && r !== "pending" && !prices[i] ? "miss" : r));
    const miss = anyMiss || eff.some((r) => r === "miss");
    const kept = legs.map((_, i) => i).filter((i) => eff[i] !== "void");
    if (pending) return { state: "pending", outcome: miss ? "miss" : null, pts: 0, counted: kept.length };
    if (kept.length < MIN_LEGS) return { state: "final", outcome: "void", pts: 0, counted: kept.length };
    if (miss) return { state: "final", outcome: "miss", pts: 0, counted: kept.length };
    return { state: "final", outcome: "hit", pts: pointsFor(kept.map((i) => prices[i].f100)), counted: kept.length };
  }

  // ── leaderboard ──
  /** rows: [{ player, round (slot round), pts (hundredths), hit (bool), lastLegTime }]. Week = best 10 cards. */
  function board(rows) {
    const by = new Map();
    for (const x of rows) {
      let b = by.get(x.player);
      if (!b) { b = { player: x.player, list: [], cards: 0, hits: 0, lastHit: 0, days: new Set() }; by.set(x.player, b); }
      b.cards++; b.list.push(x.pts || 0); b.days.add(dayOfRound(x.round));
      if (x.hit) { b.hits++; if ((x.lastLegTime || 0) > b.lastHit) b.lastHit = x.lastLegTime || 0; }
    }
    const out = [...by.values()].map((b) => {
      const best = b.list.sort((u, v) => v - u).slice(0, BEST);
      return { player: b.player, pts: best.reduce((s, v) => s + v, 0), best: best[0] || 0, cards: b.cards, hits: b.hits, lastHit: b.lastHit, days: b.days.size };
    });
    out.sort((a, b) => b.pts - a.pts || b.hits - a.hits || (a.lastHit || Infinity) - (b.lastHit || Infinity) || (a.player < b.player ? -1 : a.player > b.player ? 1 : 0));
    return out;
  }
  function places(ranked) {
    let place = 0;
    return ranked.map((r, i) => { const p = ranked[i - 1]; if (!p || p.pts !== r.pts || p.hits !== r.hits || p.lastHit !== r.lastHit) place = i + 1; return { ...r, place }; });
  }

  // ── share ──
  /** A short text for sharing a card: "KnodeGames Combo · 4 legs · ✅✅⏳❌ · 0 pts". */
  function shareText(legs, results, pts) {
    const icon = { hit: "✅", miss: "❌", void: "➖", pending: "⏳" };
    return `KnodeGames Combo · ${legs.length} legs · ${results.map((r) => icon[r] || "⏳").join("")} · ${(pts / 100).toFixed(2).replace(/\.00$/, "")} pts`;
  }

  root.KCombo = {
    GAME_ID, WIN, SHOW, HALF, BLOCK, CODES, NAMES, FAMILY, MIN_LEGS, MAX_LEGS, HARD_MAX_LEGS, BASE, CAP, PREF, F_MIN, F_MAX,
    CARDS_PER_DAY, MAX_CHANGES, BEST, RACE_LEAD_MS, RACE_AHEAD_MS, BLOCK_LEAD, BLOCK_AHEAD,
    isWindow, slotKey, slotRound, dayOfRound, utcDay, lockOf, legOpen, cardLockTime, cardProblem,
    priceCard, raceChances, factorOf, priceLeg, pointsFor, potential, legResult, scoreCard, board, places, shareText,
  };
})(typeof window !== "undefined" ? window : globalThis);

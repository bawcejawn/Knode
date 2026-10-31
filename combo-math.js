/* Combo Card: the shared math. The page (combo.js) and the recorder (bot/games/combo.ts) both use this one file, so a
 * card priced in the browser and a card scored by the recorder always agree. No network, no page, no wallet.
 * Needs race-math.js and blockx-math.js loaded first. Owner's decisions 2026-10-28 (claude/builds/08-combo-card-plan.md).
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
 * PRICE: each leg has a factor = clamp(0.5 ÷ chance, 0.25, 3), rounded DOWN to 2 decimals (Repo Lens RL-17). The
 * chance comes from the PRICE CARD: the latest USABLE Producer Race card taken (card.at) at or before the time the card
 * was made (or last changed), at most 3 hours before it. Usable is Block X's own rule (bot/games/blockx.ts, audits
 * BX-3, BX-38, BX-55, BX-73; Repo Lens RL-8): made from at least 12 VHP samples, no producer flagged (the two nodes
 * read its VHP differently) and the top producer not in doubt. No usable card: the card can't be priced (void).
 *   - race legs: the horse's chance of winning / finishing top 3 / top half of a fresh 6-hour race with that card's
 *     handicaps, from 16,000 simulated races with a fixed seed (anyone re-running it gets the same numbers);
 *   - Block X: the producer's share of all VHP on the card (field and paddock).
 *   A race leg on a horse that is not in the price card's field can't be priced: it counts as a miss (the page never
 *   offers it). A Block X leg on a producer missing from the card is worth ×1 (as Block X since its audit BX-3; Repo
 *   Lens RL-1: a producer nobody has measured is never priced as a long shot).
 *   Points = base × all factors, with NO cap (owner, 2026-10-28: "if they can build it they can win it"), base by legs:
 *   2 → 3, 3 → 7, 4 → 15, 5 → 30, 6 → 60, 7 → 120, 8 → 240, 9 → 480, 10 → 960 (each leg roughly doubles it, so a
 *   fairly priced leg keeps a card's expected points level). Kept in hundredths. The game runs at up to 6 legs
 *   (MAX_LEGS); the contract allows up to 10 (HARD_MAX_LEGS), opened with 48 hours' notice when more games add legs.
 *   Simulated 2026-10-28: removing the cap doesn't change who reaches the top 30%; the week's #1 is then usually
 *   decided by one big card (80% of the leader's week vs 45% with a 150 cap).
 *   Easy legs are worth less than ×1 (down to ×0.25), so stacking near-certain legs is not free points.
 *   For scoring, a leg keeps its worth from when the card was sent unless a later check card gives a worth more than
 *   10% lower; then it takes the lowest (finalWorth; audit CC-B5, fix-check FC-2; owner 2026-10-30: keep 10%). The
 *   check cards: the card in force when the leg locks, and for a Block X leg also the first card after the block
 *   (Block X's BX-35), both with any VHP moved into the producer between its lock card and the block added (BX-53;
 *   Repo Lens RL-2). A producer whose VHP grows can't keep a long-shot price; the hourly drift changes nothing.
 *
 * VOID LEGS: a leg whose horse is not in the race at all is dropped (owner, 2026-10-30: kept); the card scores on the
 * rest with the base for that many legs, and with fewer than 2 legs left it is void.
 * UNRESOLVED LEGS (fix-check FC-2, fix-check 2 FC2-2/FC2-9): a race nobody decided (missed, void, or not checked on
 * two nodes), a block without a signer checked on two nodes, or a leg the recorder can't check (no usable price card,
 * a moved-VHP read held to its edge, the deadline) is never dropped: a miss on another leg still decides the card,
 * otherwise the whole card is void. A Block X target that Block X voids for its own scoring (a flagged or missing card)
 * still decides the leg by its checked signer (Repo Lens RL-3).
 * A card is final once its slot is fixed and every leg is decided, or as soon as one leg missed (a miss decides).
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
  /** Price cards (Repo Lens RL-8: Block X's rule): taken at most 3 hours before, from at least 12 VHP samples. */
  const CARD_MAX_AGE_MS = 3 * M.HOUR, MIN_CARD_SAMPLES = 12;
  /** Simulated races per price (Repo Lens RL-17: 4,000 left a 3-5% edge on some legs; 16,000 halves the noise). */
  const TRIALS = 16000;
  /** A Block X producer missing from the card (Repo Lens RL-1; Block X BX-3): ×1. */
  const MISSING_F100 = 100;
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
  function cardProblem(legs, head, max = MAX_LEGS) {
    const most = Math.min(HARD_MAX_LEGS, Math.max(MIN_LEGS, max | 0));   // the game's max_legs on chain (6 at launch)
    if (!Array.isArray(legs) || legs.length < MIN_LEGS) return "A card needs at least 2 legs.";
    if (legs.length > most) return `A card has at most ${most} legs.`;
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
  /** Can this race card price legs? Block X's rule (bot/games/blockx.ts usable): a field and at least 12 VHP samples
   *  (Repo Lens RL-8). Flags are per producer (flagsFor), as Block X's flags(card, signer) (fix-check FC-8). */
  function usableCard(c) {
    return !!c && Number.isFinite(c.at) && Array.isArray(c.field) && c.field.length > 0 && Number.isInteger(c.samples) && c.samples >= MIN_CARD_SAMPLES;
  }
  /** Block X's flags(card, who): the two nodes read this producer's VHP differently, or the top producer is in doubt
   *  (which puts every price on the card in doubt). Such a card never prices this producer's legs. */
  const flagsFor = (c, who) => !!c && (c.topInDoubt === true || (Array.isArray(c.flagged) && c.flagged.includes(who)));
  const cardsOf = (races, who) => { const out = []; for (const r of races || []) for (const c of (r && Array.isArray(r.cards) ? r.cards : [])) if (usableCard(c) && !(who && flagsFor(c, who))) out.push(c); return out; };
  /** The price card at time t: the latest usable race card taken at or before t and at most 3 hours before it; with
   *  `who`, the latest one that doesn't flag that producer. */
  function priceCard(races, t, who = null) {
    let best = null;
    for (const c of cardsOf(races, who)) if (c.at <= t && t - c.at <= CARD_MAX_AGE_MS && (!best || c.at > best.at)) best = c;
    return best;
  }
  /** The first usable race card taken after time t, at most 3 hours after it (Block X's BX-35 "first card after X"),
   *  not flagging `who`. */
  function cardAfter(races, t, who = null) {
    let best = null;
    for (const c of cardsOf(races, who)) if (c.at > t && c.at - t <= CARD_MAX_AGE_MS && (!best || c.at < best.at)) best = c;
    return best;
  }
  /** The card with `vhp` (KOIN units) added to `who` (Block X's withMoved, BX-53): VHP moved into a producer between its
   *  lock card and the block counts on both check cards. The same card when nothing moved. */
  function withMoved(card, who, vhp) {
    if (!card || !(vhp > 0)) return card;
    const bump = (rows) => (rows || []).map((r) => (r && r.a === who ? { ...r, vhp: r.vhp + vhp } : r));
    return { ...card, field: bump(card.field), paddock: bump(card.paddock) };
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
    for (let t = 0; t < TRIALS; t++) {
      for (let i = 0; i < n; i++) steps[i] = R.poisson(ks[i]) * hs[i];
      idx.sort((a, b) => steps[b] - steps[a] || a - b);
      for (let p = 0; p < n; ) {
        let q = p + 1;
        while (q < n && Math.abs(steps[idx[q]] - steps[idx[p]]) <= 1e-9) q++;
        for (let c = 0; c < 3; c++) { const share = Math.max(0, Math.min(q, cut[c]) - p) / (q - p); if (share) for (let j = p; j < q; j++) acc[idx[j]][c] += share; }
        p = q;
      }
    }
    const out = new Map(F.map((r, i) => [r.a, { win: round4(acc[i][0] / TRIALS), show: round4(acc[i][1] / TRIALS), half: round4(acc[i][2] / TRIALS) }]));
    if (chanceCache.size > 50) chanceCache.clear();
    chanceCache.set(key, out);
    return out;
  }
  /** The factor in hundredths: clamp(0.5 ÷ chance, 0.25, 3), rounded DOWN (Repo Lens RL-17). */
  const f100Of = (chance) => (chance > 0 ? Math.min(F_MAX * 100, Math.max(F_MIN * 100, Math.floor((PREF * 100) / chance + 1e-9))) : F_MAX * 100);
  const factorOf = (chance) => f100Of(chance) / 100;

  /** A leg's price with a card: { chance, factor } (factor in hundredths as f100), or null if it can't be priced
   *  (a race leg on a horse not in the card's field). */
  function priceLeg(card, leg) {
    if (!card) return null;
    if (leg.code === BLOCK) {
      const { m } = X.vhpOf(card);
      let total = 0; for (const v of m.values()) total += v;
      const v = m.get(leg.producer);
      if (!v || !total) return { chance: null, factor: MISSING_F100 / 100, f100: MISSING_F100 };
      const chance = round4(v / total), f100 = f100Of(chance);
      return { chance, factor: f100 / 100, f100 };
    }
    const c = raceChances(card).get(leg.producer);
    if (!c) return null;
    const chance = leg.code === WIN ? c.win : leg.code === SHOW ? c.show : c.half, f100 = f100Of(chance);
    return { chance, factor: f100 / 100, f100 };
  }

  /** A leg's worth for scoring (hundredths): its worth on the card in force when the card was sent, or the lowest
   *  worth on the check cards if that is more than 10% lower (audit CC-B5; owner 2026-10-30: 10%). The check cards:
   *  the card in force when the leg locks and, for a Block X leg, the first card after the block (Repo Lens RL-2), the
   *  recorder having added any VHP moved into the producer since its lock card (withMoved). null if the leg can't be
   *  priced at sending. A check card that is missing (or without the horse) is skipped. */
  function finalWorth(sendCard, lockCard, leg, afterCard = null) {
    const a = priceLeg(sendCard, leg);
    if (!a) return null;
    let low = null;
    for (const c of [lockCard, afterCard]) { const b = c ? priceLeg(c, leg) : null; if (b && (low === null || b.f100 < low)) low = b.f100; }
    // Only a real change counts (fix-check FC-2): the hourly cards move chances a little by themselves (block rate,
    // simulation), so the worth drops only when a check card's worth is more than 10% below the worth when sent.
    return low !== null && low * 10 < a.f100 * 9 ? low : a.f100;
  }
  /** When a leg locks (ms): race legs 25 minutes before the start; Block X legs about 500 blocks before the block
   *  (targetTime = the recorded time of the target block, else an estimate). */
  const legLockTime = (leg, targetTime) => (isRace(leg.code) ? M.raceStart(leg.round) - RACE_LEAD_MS : targetTime - BLOCK_LEAD * X.BLOCK_MS);

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
  /** The order a card's legs are sent in (Repo Lens RL-13; fix-check FC-14): by code, round and producer only, never by
   *  an estimated time, so the same legs always make the same card and re-sending them never spends a change. */
  function sortLegs(legs) {
    return [...legs].sort((a, b) => a.code - b.code || a.round - b.round || (a.producer < b.producer ? -1 : a.producer > b.producer ? 1 : 0));
  }
  /** What a card would pay if every leg hits (hundredths), and each leg's price. null if a leg can't be priced. */
  function potential(card, legs) {
    const prices = legs.map((l) => priceLeg(card, l));
    if (prices.some((p) => !p)) return { pts: 0, prices, unpriced: true };
    return { pts: pointsFor(prices.map((p) => p.f100)), prices, unpriced: false };
  }

  // ── results ──
  /** A leg's result: "hit", "miss", "void" (dropped from the card), "unresolved" (fix-check FC-2: its source never
   *  decided it; the card is void unless another leg missed) or "pending".
   *  race: the race's record from race-data ({ result: { final, missed?, standings } }) or null;
   *  target: the Block X target record ({ final, checked, signer, void? }) or null. A Block X leg is decided by the
   *  target's signer whenever the two nodes agreed on it (checked 2), even if Block X voided the target for its own
   *  scoring (Repo Lens RL-3: a flagged or missing handicap card is Block X's business, not who signed). */
  function legResult(leg, race, target) {
    if (isRace(leg.code)) {
      const res = race && race.result;
      if (!res || !res.final) return "pending";
      // A race nobody decided (no handicap card, so "missed"; or results not checked on two nodes) is unresolved, as a
      // Block X target without an agreed signer (fix-check 2 FC2-2, FC2-9): the card is void unless another leg missed.
      if (res.missed || res.void || !Array.isArray(res.standings) || res.checked !== 2) return "unresolved";
      const st = res.standings, i = st.findIndex((s) => s && s.a === leg.producer);
      if (i < 0) return "void";                       // not in the race at all: no fault of the player
      if (!(st[i].steps > 0)) return "miss";
      const need = leg.code === WIN ? 1 : leg.code === SHOW ? 3 : Math.floor(st.length / 2);
      return i < need ? "hit" : "miss";
    }
    if (!target || target.final !== true) return "pending";
    // Recorded but without a signer the two nodes agreed on (Block X gave up on it): never decided. The card can't
    // score on its other legs (FC-2: that would let one node turn a losing card into a hit).
    if (target.checked !== 2 || !isAddr(target.signer)) return "unresolved";
    return target.signer === leg.producer ? "hit" : "miss";
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

  // ── the Vault's weekly file (hand-off from the Vault v6 chat, 2026-10-28) ──
  /** The Vault week of a time: week 0 began Monday 19 Oct 2026 00:00 UTC (the same week as KRaceMath.weekOf). */
  const vaultWeek = (t) => M.weekOf(t);
  /** Board places onto 1..255 for the Vault, which only uses their order (Block X's vaultPoints; fix-check FC-17):
   *  distinct places, best first, get 255, 254, ...; a shared place stays shared. Past 254 distinct places the rest
   *  share 1 (the top 254 keep their exact order, which covers every prize place up to 846 players). */
  function toVaultPoints(placeList) {
    const distinct = [...new Set(placeList)].sort((a, b) => a - b);
    const rank = new Map(distinct.map((v, i) => [v, Math.max(1, 255 - i)]));
    return placeList.map((v) => rank.get(v));
  }
  /** Combo Card's file for the Vault: staked game, so rows only (no free prizes). boardRows: the week's board in
   *  order, each { player, pts (hundredths), place, staked (true / false / null) }. Listed: players staked in the
   *  Combo Card that week (staked === true) with at least 1 full point (owner, 2026-10-28), by board place. */
  const MIN_WEEK_PTS = 100;   // 1 point, in hundredths
  function vaultFile(week, final, boardRows) {
    const ok = (boardRows || []).filter((r) => r && r.staked === true && Number.isSafeInteger(r.pts) && r.pts >= MIN_WEEK_PTS && isAddr(r.player) && Number.isSafeInteger(r.place));
    const pts = toVaultPoints(ok.map((r) => r.place));
    return { game: GAME_ID, week, final: final === true, rows: ok.map((r, i) => ({ player: r.player, points: pts[i] })), first: [], second: [] };
  }

  // ── share ──
  /** A short text for sharing a card: "KnodeGames Combo · 4 legs · ✅✅⏳❌ · 0 pts". */
  function shareText(legs, results, pts) {
    const icon = { hit: "✅", miss: "❌", void: "➖", unresolved: "➖", pending: "⏳" };
    return `KnodeGames Combo · ${legs.length} legs · ${results.map((r) => icon[r] || "⏳").join("")} · ${(pts / 100).toFixed(2).replace(/\.00$/, "")} pts`;
  }

  root.KCombo = {
    GAME_ID, WIN, SHOW, HALF, BLOCK, CODES, NAMES, FAMILY, MIN_LEGS, MAX_LEGS, HARD_MAX_LEGS, BASE, CAP, PREF, F_MIN, F_MAX,
    CARDS_PER_DAY, MAX_CHANGES, BEST, RACE_LEAD_MS, RACE_AHEAD_MS, BLOCK_LEAD, BLOCK_AHEAD,
    isWindow, slotKey, slotRound, dayOfRound, utcDay, lockOf, legOpen, cardLockTime, cardProblem,
    CARD_MAX_AGE_MS, MIN_CARD_SAMPLES, TRIALS, MISSING_F100, usableCard, flagsFor, priceCard, cardAfter, withMoved, sortLegs,
    raceChances, factorOf, priceLeg, finalWorth, legLockTime, pointsFor, potential, legResult, board, places, shareText,
    vaultWeek, toVaultPoints, vaultFile, MIN_WEEK_PTS,
  };
})(typeof window !== "undefined" ? window : globalThis);

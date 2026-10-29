/* Who Signs Block X: the shared math. The page (blockx.js) and the recorder (bot/games/blockx.ts) both use this one
 * file, so a pick scored in the browser and a pick recorded by the bot always agree. No network, no page, no wallet.
 *
 * FORMAT
 * - Targets are the block heights that are multiples of 2,400 (about every 2 hours at ~3 s a block). Round r is block
 *   r × 2,400. No admin input.
 * - A pick is one producer for one target. The Picks contract locks it 100 blocks (~5 min) before the target: the last
 *   block a pick can land in is target − 101. Picks open 28,900 blocks ahead, so 12 targets are always open.
 * - A pick can be changed until the lock (at most 5 times), up to 30 picks and changes a day per wallet.
 * - Those are the mainnet settings (Picks game 2). forGame() gives the same rules for other settings, such as the
 *   Koinos testnet's fast game (targets every 300 blocks, about 15 minutes); each network's config names its games.
 *
 * SCORING
 *   a correct pick scores min(3, top producer's VHP ÷ picked producer's VHP), to 2 decimals; a wrong pick scores 0.
 * - The VHP comes from the Producer Race card in force at the lock block's time (race-math.js: the hourly card of
 *   that race leg), field and paddock together, so every producer that can sign counts. On a network with no Producer
 *   Race (the testnet), the recorder takes the same hourly card itself (bot/games/blockx.ts, CARDS=self).
 * - Koinos picks signers in proportion to VHP, so a pick's expected score is min(3 × its share, the top's share): every
 *   producer with at least a third of the top's VHP is an equally good pick on average, and the cap of 3 keeps a
 *   lucky long shot from running away with a week (simulated 2026-10-27: thoughtful players win ~96% of weeks; with
 *   no cap lucky players would win ~88%).
 * - A signer missing from the card (a brand-new producer) scores ×1 (audit BX-3: a fresh producer address must not
 *   be worth the cap to the wallets that know it will sign).
 * - Points are kept in hundredths (integers), so sums never drift.
 *
 * LEADERBOARD: Today (the target block's UTC day), This week (the Knode game week of the target block) and All time.
 *   Ranked by points; ties: more correct picks, then the earlier last correct pick (lower height), then address.
 *   Two boards, as in every Knode Games game (board.js): Staked (wallets holding 1 VHP or with a Knode stake) and
 *   Free play (everyone else, guests included).
 * PRIZES (weekly 2 VHP / 1 VHP, owner's decisions 2026-10-27/28): the top 2 of the Free play board, each with at least
 *   one point and picks on at least 3 different UTC days that week (so a wallet can't win from one visit). Ties share.
 *   None until the Knode Games vault (v6) is live: the recorder lists prizes only from its PRIZES_FROM_WEEK, and nothing
 *   is owed for earlier weeks. The vault pays them. */
(function (root) {
  "use strict";
  // The mainnet game (Picks game 2). Another network can run Block X with other settings (the testnet's fast game):
  // forGame(settings) gives the same functions for those settings, read from the network's config.
  const MAINNET_GAME = Object.freeze({ id: 2, round: 2400, offset: 0, lead: 100, ahead: 28900, picksPerDay: 30, maxChanges: 5 });
  const CAP = 3, OPEN = 12, MIN_PRIZE_DAYS = 3;
  const BLOCK_MS = 3000;            // ~3 s a block (an estimate for showing times as "about")
  const DAY = 86400000, WEEK = 7 * DAY;
  const GENESIS = 1792368000000;    // the Knode game's week 0: Monday 2026-10-19 00:00 UTC (as race-math.js)
  const round2 = (x) => Math.round(x * 100) / 100;

  // ── targets (per game) ──
  /** The target functions for one game's settings: exactly the Picks contract's rules for a height-locked game. */
  function forGame(g) {
    const s = Object.assign({}, MAINNET_GAME, g || {});
    for (const k of ["id", "round", "offset", "lead", "ahead", "picksPerDay", "maxChanges"])
      if (!Number.isInteger(s[k]) || s[k] < 0) throw new Error(`Block X settings: ${k} must be a whole number`);
    if (s.round < 1 || s.offset >= s.round || s.lead < 100 || s.ahead <= s.lead) throw new Error("Block X settings are outside the Picks contract's limits");
    const target = (r) => r * s.round + s.offset;
    /** The first height at which the contract refuses a pick for round r. */
    const lockHeight = (r) => target(r) - s.lead;
    /** Is round r open for a pick that lands in block `height`? Exactly the contract's rule. */
    const isOpen = (r, height) => r >= 1 && target(r) > s.lead && height < lockHeight(r) && target(r) - height <= s.ahead;
    /** The rounds open for a pick landing in block `height`, soonest first. */
    function openRounds(height) {
      const out = [];
      for (let r = Math.max(1, Math.floor((height - s.offset) / s.round)); target(r) <= height + s.ahead; r++) if (isOpen(r, height)) out.push(r);
      return out;
    }
    /** What the page offers: open rounds whose lock is more than `margin` blocks away (so a pick sent now doesn't land
     *  after the lock), soonest first. */
    const offerRounds = (height, margin = 20) => openRounds(height).filter((r) => lockHeight(r) - height > margin);
    /** The round whose target is block h, or null. */
    const roundOf = (h) => (Number.isInteger(h) && h >= s.offset && (h - s.offset) % s.round === 0 && h > s.offset ? (h - s.offset) / s.round : null);
    return Object.freeze({ GAME_ID: s.id, ROUND: s.round, OFFSET: s.offset, LEAD: s.lead, AHEAD: s.ahead, PICKS_PER_DAY: s.picksPerDay, MAX_CHANGES: s.maxChanges,
      settings: Object.freeze(s), target, lockHeight, isOpen, openRounds, offerRounds, roundOf });
  }
  const MAIN = forGame(MAINNET_GAME);
  /** About when block h will be made, from the head block's height and time. */
  const aboutTime = (h, headHeight, headTime) => headTime + (h - headHeight) * BLOCK_MS;

  // ── scoring ──
  /** VHP by producer from a race card (field and paddock), and the biggest. */
  function vhpOf(card) {
    const m = new Map();
    let top = 0;
    for (const r of [...((card && card.field) || []), ...((card && card.paddock) || [])]) {
      if (r && typeof r.a === "string" && Number.isFinite(r.vhp) && r.vhp > 0) { m.set(r.a, r.vhp); if (r.vhp > top) top = r.vhp; }
    }
    return { m, top };
  }
  /** What a correct pick on `producer` scores with this card: min(3, top ÷ its VHP), 2 decimals; 1 if not on the card. */
  function multiplier(card, producer) {
    const { m, top } = vhpOf(card);
    const v = m.get(producer);
    if (!top) return CAP;          // no card at all: never used for points (the recorder voids such targets)
    if (!v) return 1;              // audit BX-3: a producer missing from the card scores ×1, never the cap
    return round2(Math.min(CAP, top / v));
  }
  /** Points (hundredths) for a pick: the multiplier if it named the signer, else 0. */
  const pointsOf = (card, picked, signer) => (picked && picked === signer ? Math.round(multiplier(card, picked) * 100) : 0);

  // ── time ──
  const dayOf = (t) => new Date(t).toISOString().slice(0, 10);
  const weekOf = (t) => (t <= GENESIS ? 0 : Math.floor((t - GENESIS) / WEEK));

  // ── leaderboard ──
  /** rows: [{ player, round, height (target), time (target block time), pickTime, correct, pts }] (pts in hundredths).
   *  Returns [{ player, pts, correct, picks, lastCorrect, days }] ranked. */
  function board(rows) {
    const by = new Map();
    for (const x of rows) {
      let b = by.get(x.player);
      if (!b) { b = { player: x.player, pts: 0, correct: 0, picks: 0, lastCorrect: 0, days: new Set() }; by.set(x.player, b); }
      b.picks++;
      b.pts += x.pts || 0;
      if (x.correct) { b.correct++; if (x.height > b.lastCorrect) b.lastCorrect = x.height; }
      if (Number.isFinite(x.pickTime)) b.days.add(dayOf(x.pickTime));
    }
    const out = [...by.values()].map((b) => ({ player: b.player, pts: b.pts, correct: b.correct, picks: b.picks, lastCorrect: b.lastCorrect, days: b.days.size }));
    out.sort((a, b) => b.pts - a.pts || b.correct - a.correct || (a.lastCorrect || Infinity) - (b.lastCorrect || Infinity) || (a.player < b.player ? -1 : a.player > b.player ? 1 : 0));
    return out;
  }
  /** The places on a ranked board: equal points, correct picks and last correct pick share a place. */
  function places(ranked) {
    let place = 0;
    return ranked.map((r, i) => {
      const p = ranked[i - 1];
      if (!p || p.pts !== r.pts || p.correct !== r.correct || p.lastCorrect !== r.lastCorrect) place = i + 1;
      return { ...r, place };
    });
  }
  /** A week's prizes (2 VHP for 1st, 1 VHP for 2nd) among the eligible players: picks on 3+ days and at least one
   *  point. Tied players split the prizes of the places they cover (two tied for 1st get 1.5 VHP each; a tie for 2nd
   *  splits the 1 VHP). Returns [{ player, place, vhp }] (vhp as a number of VHP). The vault pays them (Build 1). */
  function prizes(weekRows, amounts = [2, 1]) {
    const ranked = places(board(weekRows).filter((r) => r.days >= MIN_PRIZE_DAYS && r.pts > 0));
    const out = [];
    for (let i = 0; i < ranked.length && i < amounts.length; ) {
      let j = i;
      while (j + 1 < ranked.length && ranked[j + 1].place === ranked[i].place) j++;
      let pot = 0;
      for (let k = i; k <= j && k < amounts.length; k++) pot += amounts[k];
      const each = Math.floor((pot / (j - i + 1)) * 1e8) / 1e8;   // VHP has 8 decimals; round down
      for (let k = i; k <= j; k++) out.push({ player: ranked[k].player, place: ranked[k].place, vhp: each });
      i = j + 1;
    }
    return out;
  }

  root.KBlockX = {
    // the mainnet game's settings and target functions (game 2), and forGame for any other settings
    ...MAIN, MAINNET_GAME, forGame,
    CAP, OPEN, MIN_PRIZE_DAYS, BLOCK_MS, DAY, WEEK, GENESIS,
    aboutTime, vhpOf, multiplier, pointsOf, dayOf, weekOf, board, places, prizes,
  };
})(typeof window !== "undefined" ? window : globalThis);

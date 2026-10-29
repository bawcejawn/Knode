/* Block Golf: the shared rules. The page (golf.js) and the recorder (bot/games/golf.ts) both use this one file, so a
 * scorecard drawn in the browser and one recorded by the bot always agree. No network, no page, no wallet.
 *
 * THE GAME (owner, 2026-10-28)
 * - Block Golf is a golf course made of every other Knode Games game. Each live game is a hole (a par 4). There is
 *   nothing to pick: a player's place on that game's weekly leaderboard sets their strokes on that hole.
 * - The week's lowest score wins. The worst hole a player PLAYED is dropped (the mulligan); a game not played is a
 *   lost ball (7) and is never dropped.
 *
 * STROKES ON A HOLE (from the player's place among that game's ranked players that week)
 *     1st place (scored something; ties share)   hole in one    1
 *     top 5%                                      eagle          2
 *     top 25%                                     birdie         3
 *     top 65%                                     par            4
 *     top 90%                                     bogey          5
 *     the rest                                    double bogey   6
 *     didn't play that game this week            lost ball      7
 * - The field is the players who scored on that game that week; wallets that played but scored nothing don't count
 *   (audit H5). A player outside the field is placed among it as if they were one more 1-VHP player, so a player who
 *   played but scored nothing gets a double bogey (6): still better than a lost ball.
 * - STAKED weeks count VHP, not wallets (owner, 2026-10-28): the field is the players staked in Block Golf that week,
 *   each weighted by the whole VHP they have staked in it, so 10 VHP split over ten wallets counts exactly like one
 *   10-VHP wallet. A place is a position in VHP: "top 25%" means a quarter of the field's Block Golf stake is at or
 *   ahead of you. Your own stake never moves you: you are placed as one unit among everyone else's stake (fix-check
 *   V1), so a 50-VHP player and a 1-VHP player with the same result get the same strokes. A hole needs at least
 *   MIN_FIELD_VHP of Block Golf stake among its scorers, a fixed number nobody can move after the fact (fix-check V2).
 * - Players on the same score share the middle of their places, so tied players are treated alike.
 * - A hole whose field is too small is skipped for everyone. A hole whose results aren't final in time is skipped for
 *   everyone too, never guessed.
 * - PRACTICE weeks (before Block Golf pays prizes; owner, 2026-10-28): every player who scored makes the field, one
 *   wallet = one place, and a hole needs only PRACTICE_MIN_FIELD players.
 *
 * THE WEEK
 * - Holes counted = holes on the course − 1 (the mulligan); par = 4 per counted hole. A course needs 2+ holes.
 * - Points (higher is better, what the vault receives): 7 × counted holes − strokes. A player who played no hole has
 *   no scorecard.
 * - Places: more points, then fewer lost balls, then more holes under par, then the better best hole. Players equal on
 *   all four share the place.
 *
 * Every number here is a small integer, so the page and the recorder can't round differently.
 */
(function (root) {
  "use strict";
  const PAR = 4, LOST = 7, MIN_FIELD = 5, PRACTICE_MIN_FIELD = 3, MIN_FIELD_VHP = 10;
  // [percent (inclusive), strokes]; a place at exactly the limit gets the better score.
  const BANDS = [[5, 2], [25, 3], [65, 4], [90, 5], [100, 6]];
  const NAMES = Object.freeze({ 1: "Hole in one", 2: "Eagle", 3: "Birdie", 4: "Par", 5: "Bogey", 6: "Double bogey", 7: "Lost ball" });
  const SHORT = Object.freeze({ 1: "Ace", 2: "Eagle", 3: "Birdie", 4: "Par", 5: "Bogey", 6: "Double", 7: "Lost" });
  const ICON = Object.freeze({ 1: "⛳", 2: "🦅", 3: "🐦", 4: "⚪", 5: "🟧", 6: "🟥", 7: "⬛" });
  // The course, in the order holes are played. A game joins only when it is live in games.json AND has a reader here
  // (bot/games/golf.ts). New games add their id here and their reader in the recorder, with a test.
  const COURSE_ORDER = Object.freeze(["questions", "race", "blockx", "survivor", "lastnode", "bracket", "fantasy", "combo"]);
  const isAddr = (a) => typeof a === "string" && /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a);

  /** Strokes for a place, counted in units (a wallet in practice weeks, a whole VHP of Block Golf stake in staked
   *  weeks). The player counts as ONE unit among everyone else's: better = other players' units strictly ahead,
   *  same = other players' units on the same score, others = all other players' units in the field. With one unit
   *  per wallet this is the plain place. scored: did they score anything (only a scoring player can hole in one). */
  function strokesFor(better, same, others, scored) {
    if (better === 0 && scored) return 1;
    const size = same + 1, N = others + 1;
    // The middle place of the group, doubled to stay an integer: places better+1 … better+size.
    const place2 = 2 * better + size + 1;
    for (const [pct, s] of BANDS) if (place2 * 100 <= pct * 2 * N) return s;
    return 6;
  }

  /** A row's weight: ranked true = 1, a whole number = that many units (VHP staked), else 0. */
  const weightOf = (r) => (r === true ? 1 : Number.isInteger(r) && r > 0 ? r : 0);
  /** One hole. rows: [{ a, score (higher is better), scored (bool), ranked (bool, or the whole VHP staked) }] for
   *  everyone who played it. everyone: a practice week (every player is in the field, one unit each). minWeight:
   *  staked weeks, the units (VHP) the field needs; else minField wallets. Returns { skipped, why, field (wallets),
   *  weight (units), results: { address: { place, of, strokes } } } (place and of count wallets, for display). */
  function scoreHole(rows, minField = MIN_FIELD, everyone = false, minWeight = 0) {
    const by = new Map();
    for (const r of Array.isArray(rows) ? rows : []) {
      if (!r || !isAddr(r.a) || typeof r.score !== "number" || !isFinite(r.score)) continue;
      const old = by.get(r.a);
      // The same wallet twice (it shouldn't happen): keep its better score, and ranked if either says so.
      const w = weightOf(r.ranked);
      if (!old || r.score > old.score) by.set(r.a, { a: r.a, score: r.score, scored: !!r.scored, w: Math.max(w, old ? old.w : 0) });
      else old.w = Math.max(old.w, w);
    }
    const all = [...by.values()];
    if (everyone) for (const r of all) r.w = 1;
    const field = all.filter((r) => r.w > 0 && r.scored);
    const n = field.length, units = field.reduce((t, r) => t + r.w, 0);
    if (minWeight > 0 ? units < minWeight : n < minField) {
      const why = minWeight > 0 ? `less than ${minWeight} VHP of Block Golf stake among the players who scored` : `fewer than ${minField} ${everyone ? "" : "ranked "}players scored`;
      return { skipped: true, why, field: n, weight: units, results: {} };
    }
    const results = {};
    for (const r of all) {
      let better = 0, same = 0, ahead = 0;
      for (const f of field) { if (f === r) continue; if (f.score > r.score) { better += f.w; ahead++; } else if (f.score === r.score) same += f.w; }
      const inField = r.w > 0 && r.scored;
      const strokes = r.scored ? strokesFor(better, same, units - (inField ? r.w : 0), true) : 6;
      results[r.a] = { place: ahead + 1, of: inField ? n : n + 1, strokes };
    }
    return { skipped: false, why: "", field: n, weight: units, results };
  }

  /** One player's week. holes: [{ id, skipped, results }] in course order. Null if they played no counted hole or the
   *  course has fewer than 2 counted holes. */
  function card(holes, a) {
    const live = (Array.isArray(holes) ? holes : []).filter((h) => h && !h.skipped);
    if (live.length < 2) return null;
    const row = live.map((h) => {
      const r = h.results && Object.prototype.hasOwnProperty.call(h.results, a) ? h.results[a] : null;
      return { id: h.id, strokes: r ? r.strokes : LOST, place: r ? r.place : null, of: r ? r.of : null, played: !!r };
    });
    const played = row.filter((x) => x.played);
    if (!played.length) return null;
    // The mulligan: the worst played hole (on a tie, the first in course order).
    let drop = played[0];
    for (const x of played) if (x.strokes > drop.strokes) drop = x;
    const counted = row.filter((x) => x !== drop);
    const strokes = counted.reduce((s, x) => s + x.strokes, 0), par = PAR * counted.length;
    return {
      a, holes: row, mulligan: drop.id, strokes, par, toPar: strokes - par,
      pts: LOST * counted.length - strokes,
      lost: counted.filter((x) => !x.played).length,
      under: counted.filter((x) => x.strokes < PAR).length,
      best: Math.min(...counted.map((x) => x.strokes)),
    };
  }

  const cmp = (x, y) => y.pts - x.pts || x.lost - y.lost || y.under - x.under || x.best - y.best;
  /** Every scorecard of a week, in place order, each with its place (equal players share it). */
  function cards(holes) {
    const who = new Set();
    for (const h of Array.isArray(holes) ? holes : []) if (h && !h.skipped && h.results) for (const a of Object.keys(h.results)) who.add(a);
    const out = [];
    for (const a of who) { const c = card(holes, a); if (c) out.push(c); }
    out.sort((x, y) => cmp(x, y) || (x.a < y.a ? -1 : x.a > y.a ? 1 : 0));
    for (let i = 0; i < out.length; i++) out[i].place = i > 0 && cmp(out[i - 1], out[i]) === 0 ? out[i - 1].place : i + 1;
    return out;
  }

  /** "−3", "E", "+5". */
  const toParText = (n) => (n === 0 ? "E" : n < 0 ? `−${-n}` : `+${n}`);
  /** The share line: "⛳ Block Golf · Week 3 · −1 (27 on par 28) 🐦⚪🦅⚪⬛🟧🐦⚪". */
  function shareText(c, week) {
    if (!c) return "";
    const icons = c.holes.map((x) => ICON[x.strokes] || "⚪").join("");
    return `⛳ Knode Games · Block Golf · Week ${week + 1}: ${toParText(c.toPar)} (${c.strokes} on par ${c.par}) ${icons}`;
  }

  /** The course for a week from games.json's live games and the weeks each joined (index.json "course"): a game that
   *  went live during week w plays from week w + 1. Only ids with a reader count. */
  function courseFor(week, joined, readable) {
    const ok = new Set(readable);
    const ids = Object.keys(joined || {}).filter((id) => ok.has(id) && Number.isInteger(joined[id]) && joined[id] <= week);
    return ids.sort((x, y) => orderOf(x) - orderOf(y) || (x < y ? -1 : 1));
  }
  function orderOf(id) { const i = COURSE_ORDER.indexOf(id); return i < 0 ? 999 : i; }

  /** The field rule of a week: practice until stakedFrom (null: not yet decided, so practice). */
  function rule(week, stakedFrom) {
    const practice = !(Number.isInteger(stakedFrom) && week >= stakedFrom);
    return { practice, everyone: practice, minField: practice ? PRACTICE_MIN_FIELD : MIN_FIELD };
  }


  root.KGolf = {
    PAR, LOST, MIN_FIELD, PRACTICE_MIN_FIELD, MIN_FIELD_VHP, rule, weightOf, BANDS, NAMES, SHORT, ICON, COURSE_ORDER,
    strokesFor, scoreHole, card, cards, toParText, shareText, courseFor, orderOf, isAddr,
  };
})(typeof window !== "undefined" ? window : globalThis);

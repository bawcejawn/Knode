/* Fantasy Producers: the shared math. The page (fantasy.js) and the recorder (bot/games/fantasy.ts) both use this one
 * file, so a score shown in the browser and a score recorded by the bot always agree. No network, no page, no wallet.
 * Needs site/race-math.js loaded first (KRaceMath: the game week, race cards and their legs).
 *
 * RULES (owner decisions 2026-10-27; claude/builds/05-fantasy-plan.md)
 * - Each game week (Monday 00:00 UTC to Monday) a player fields a team of 5 different producers from the week's pool,
 *   within a salary budget of 100. The first producer is the captain and scores double.
 * - Points: for every UTC day, each producer gets an index = 100 × blocks it signed ÷ blocks it was expected to sign.
 *   Expected = every hour's blocks × the producer's share of VHP on the race card in force for that hour. 100 means it
 *   signed exactly its fair share. This is the plain handicap (c = 0): every producer has the same expected score, so
 *   the skill is judging which producers keep their nodes healthy. A producer's score is capped at 130 a day.
 * - Salary: each producer's price comes from its form, its index over the 7 days before the price sheet:
 *   price = 20 + 1.5 × (form − the pool's median form), rounded, between 8 and 40. A producer with no form costs 20.
 *   Centring on the median keeps the middle producer at 20, so 5 producers within 100 always exist (with 9 or more in
 *   the pool; a smaller pool's budget is raised to what its 5 cheapest cost).
 *   The sheet is made on Sunday 12:00 UTC for the next week; its pool is the race field on the card in force then.
 * - A team is picked for a UTC day and locks before that day starts (the Picks contract enforces the lock).
 *   Each week starts fresh: Monday's team may be any valid team on the new price list. From one day to the next after
 *   that, a team may make one change: swap one producer, or move the captaincy. A swapped-in producer may take the
 *   captaincy of the one it replaced as part of that one change. A day with no new pick keeps yesterday's team; last
 *   week's team carries into Monday only if it fits the new list (all 5 still on it, within the budget). An invalid
 *   pick (not 5 different pool producers, over budget, more than one change) is ignored and yesterday's team stays.
 *   Days before a player's first valid team score 0.
 * - Week points = the sum of the 7 days. The vault takes whole points 1 to 255 and uses only their ORDER (rank weights
 *   and the top-30% headcount; docs/V6-PLAN.md on branch vault-v6), so the best week gets 255, the next distinct
 *   score 254, and so on, keeping every tie; players below the 255th distinct score all get 1. Only scores above 0.
 * - Weekly Rival: a player may challenge one other player for the week. The match counts only when both had a team on
 *   all 7 days and both hold a Knode Games stake (owner, 2026-10-28: throwaway wallets can't farm records).
 * - All time: each final week adds every player's points to an all-time table (total, weeks played, best week).
 *   Bragging rights only; prizes stay weekly. More week points wins; equal is a draw. Two players who challenge each other play one match.
 *   A record keeps challenges made and challenges received apart. Rivals carry no prize money.
 *
 * THE CLOCK. KFantasyMath runs on the real clock (days of 24 hours, weeks from the Knode game's Monday). The testnet
 * practice kit runs the same rules faster: KFantasyMath.withClock({ day: 3600000, genesis }) makes 1 test "day" = 1 hour
 * and 1 test week = 7 hours. Everything that depends on time comes from the clock; the scoring rules do not change.
 *
 * THE PICKS CONTRACT. Two games (claude/launch-order.md: Fantasy 4, Weekly Rival 5):
 * - Team: a list of 5 producers, captain first; round = the day number (target = the day's start); locks 5 minutes
 *   before the day starts; opens 7 days ahead. The contract checks 1 to 5 distinct valid addresses; this file checks the
 *   rest (exactly 5, the pool, the budget, one change a day).
 * - Rival: one address (any wallet); round = the first day of its week (target = the week's start); locks 5 minutes
 *   before it. Rounds that aren't a week's first day are never used. */
(function (root) {
  "use strict";
  const R = root.KRaceMath;
  if (!R) throw new Error("fantasy-math.js needs race-math.js loaded first");
  const HOUR = R.HOUR, DAY = R.DAY;
  const TEAM = 5, BUDGET = 100, DAY_CAP = 130, CAPTAIN = 2;
  const PRICE = { base: 20, per: 1.5, min: 8, max: 40, none: 20 };
  const FORM_DAYS = 7;                           // form = the index over the 7 days before the sheet's day
  const VAULT_MAX = 255;
  const LEAD_MS = 5 * 60000;                     // picks lock 5 minutes before their day (or week) starts
  const GAMES = Object.freeze({ team: 4, rival: 5 });
  const isAddr = (a) => typeof a === "string" && /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a);
  const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;
  /** The real clock: UTC days, weeks from the Knode game's week 0, the sheet on Sunday 12:00 UTC. */
  const REAL = Object.freeze({ day: DAY, genesis: R.GENESIS, sheetBefore: 12 * HOUR });

  function make(clock) {
    const C = Object.assign({}, REAL, clock || {});
    if (!(C.day >= 60000 && C.day <= DAY && DAY % C.day === 0 && HOUR % Math.min(C.day, HOUR) === 0)) throw new Error("fantasy clock: a day must divide 24 hours (and be whole minutes)");
    if (!(Number.isInteger(C.genesis) && C.genesis % C.day === 0)) throw new Error("fantasy clock: the genesis must start a day");
    if (!(C.sheetBefore > LEAD_MS && C.sheetBefore <= C.day)) throw new Error("fantasy clock: the sheet comes at most a day and more than 5 minutes before the week");
    const WEEK = 7 * C.day;

    // ── time ──
    const dayNo = (t) => Math.floor(t / C.day);               // the Picks round of a day
    const dayStart = (d) => d * C.day;
    /** The game week of a time (weeks before the start count as 0, as in race-math.js). */
    const weekOf = (t) => (t <= C.genesis ? 0 : Math.floor((t - C.genesis) / WEEK));
    const weekStart = (w) => C.genesis + w * WEEK;
    /** The 7 day numbers of game week w. */
    const weekDays = (w) => { const d0 = dayNo(weekStart(w)); return Array.from({ length: 7 }, (_, i) => d0 + i); };
    /** When the price sheet for week w is made (real clock: Sunday 12:00 UTC before it), and the form days it uses. */
    const sheetTime = (w) => weekStart(w) - C.sheetBefore;
    const formDays = (w) => { const last = dayNo(sheetTime(w)) - 1; return Array.from({ length: FORM_DAYS }, (_, i) => last - FORM_DAYS + 1 + i); };
    /** The Picks rounds: a team pick's round is its day. A rival pick's round is the first day of its week, in a game
     *  whose rounds are days too, so the game's settings never depend on when week 0 began (only week starts are used). */
    const rivalRound = (w) => dayNo(weekStart(w));
    const weekOfRivalRound = (r) => (dayStart(r) - C.genesis) % WEEK === 0 && dayStart(r) >= C.genesis ? (dayStart(r) - C.genesis) / WEEK : null;
    /** When a day's team (or a week's rival) locks: 5 minutes before it starts. */
    const lockOfDay = (d) => dayStart(d) - LEAD_MS;
    const lockOfWeek = (w) => weekStart(w) - LEAD_MS;
    /** The Picks contract's game settings for this clock (owner announces them; the contract enforces them). */
    const games = (ids = GAMES, perDay = 20) => ({
      team: { id: ids.team, kind: 2, list_size: TEAM, number_min: "0", number_max: "0", lock_mode: 2, round_size: String(C.day), round_offset: "0",
        lead: String(LEAD_MS), ahead: String(WEEK), max_picks_per_day: perDay, max_changes: 20, enabled: true },
      rival: { id: ids.rival, kind: 1, list_size: 1, number_min: "0", number_max: "0", lock_mode: 2, round_size: String(C.day), round_offset: "0",
        lead: String(LEAD_MS), ahead: String(WEEK), max_picks_per_day: 10, max_changes: 5, enabled: true },
    });

    // ── shares from the race cards ──
    /** The card in force at hour start t, from the race weeks: { [raceId]: cards[] }. The race's own leg card, else the
     *  latest earlier card of that race, else (a race with no card) the latest card up to 24 hours before. */
    function cardAt(racesById, t) {
      for (let back = 0; back <= 24; back++) {
        const u = t - back * HOUR, ra = R.raceAt(u), cards = racesById[ra.id];
        if (!Array.isArray(cards) || !cards.some(Boolean)) continue;
        const c = back === 0 ? R.cardForLeg(cards, R.legOf(ra.start, u, R.legsOf(cards))) : lastCardUpTo(cards, ra.start, u);
        if (c) return c;
      }
      return null;
    }
    function lastCardUpTo(cards, start, u) {
      for (let l = R.legOf(start, u, R.legsOf(cards)); l >= 0; l--) if (cards[l]) return cards[l];
      return null;
    }
    /** Shares of VHP on a card: field and paddock together (every producer that can sign blocks). */
    function sharesOf(card) {
      const rows = [...(card?.field || []), ...(card?.paddock || [])], tot = rows.reduce((s, r) => s + (r.vhp > 0 ? r.vhp : 0), 0);
      const m = new Map();
      if (tot > 0) for (const r of rows) if (isAddr(r.a) && r.vhp > 0) m.set(r.a, r.vhp / tot);
      return m;
    }

    // ── a day's producer index ──
    /** For one day: blocks B = { ts: [...ascending], sig: [index], signers: [address] } covering at least the day.
     *  Expected comes from each hour's blocks (or each part of a shorter test day) and the card in force at its start.
     *  Returns { [address]: [signed, expected (2 decimals), index (2 decimals) or null] } for every producer on a card
     *  that day or that signed a block, the day's block count, and `uncovered`: how many hours (steps) had blocks but no
     *  card (such a day must not be final: its blocks would count as signed without being expected; audit FX-5). */
    function dayIndex(B, racesById, d) {
      const t0 = dayStart(d), out = new Map();
      let i = R.lowerBound(B.ts, t0), blocks = 0, uncovered = 0;
      const get = (a) => { let x = out.get(a); if (!x) { x = { got: 0, exp: 0 }; out.set(a, x); } return x; };
      const step = Math.min(HOUR, C.day);
      for (let hs = t0; hs < t0 + C.day; hs += step) {
        const he = hs + step;
        let n = 0;
        for (; i < B.ts.length && B.ts[i] < he; i++) { if (B.ts[i] < hs) continue; n++; const a = B.signers[B.sig[i]]; if (isAddr(a)) get(a).got++; }
        blocks += n;
        const card = cardAt(racesById, hs), sh = card ? sharesOf(card) : null;
        if (sh && sh.size) for (const [a, s] of sh) get(a).exp += n * s;
        else if (n > 0) uncovered++;
      }
      const res = {};
      for (const [a, x] of [...out].sort((u, v) => (u[0] < v[0] ? -1 : 1))) res[a] = [x.got, round(x.exp, 2), x.exp > 0 ? round(100 * x.got / x.exp, 2) : null];
      return { blocks, producers: res, uncovered };
    }
    /** A producer's index over several days (the sums of signed and expected), or null if it was never expected. */
    function spanIndex(days, a) {
      let got = 0, exp = 0;
      for (const d of days) { const x = d?.producers?.[a]; if (Array.isArray(x)) { got += x[0]; exp += x[1]; } }
      return exp > 0 ? round(100 * got / exp, 2) : null;
    }

    // ── the price sheet ──
    /** A price from a form and the pool's median form. */
    const priceOf = (form, median) => (form === null || !Number.isFinite(form) || !Number.isFinite(median) ? PRICE.none : Math.min(PRICE.max, Math.max(PRICE.min, Math.round(PRICE.base + PRICE.per * (form - median)))));
    /** The median of the known forms (the lower middle one for an even count), or null. */
    function medianOf(forms) { const f = forms.filter((x) => x !== null && Number.isFinite(x)).sort((a, b) => a - b); return f.length ? f[Math.floor((f.length - 1) / 2)] : null; }
    /** The sheet for week w: pool = the race field on `card`, form from the form-window days. Sorted by address. */
    function makeSheet(w, card, formWindow) {
      const pool = (card?.field || []).filter((r) => isAddr(r.a)).map((r) => r.a).sort();
      const forms = pool.map((a) => spanIndex(formWindow, a)), median = medianOf(forms);
      const rows = pool.map((a, i) => ({ a, form: forms[i], price: priceOf(forms[i], median) }));
      const cheapest = rows.map((r) => r.price).sort((x, y) => x - y).slice(0, TEAM).reduce((s, x) => s + x, 0);
      return { week: w, at: sheetTime(w), budget: Math.max(BUDGET, cheapest), median, pool: rows };
    }
    /** The canonical text of a sheet, which its sha256 is taken over (the recorder publishes the hash). */
    const sheetText = (s) => JSON.stringify({ week: s.week, at: s.at, budget: s.budget, median: s.median, pool: s.pool.map((p) => [p.a, p.form, p.price]) });

    // ── teams ──
    /** Is a pick (list of addresses, captain first) a valid team on this sheet? Returns { ok, why?, cost }. */
    function checkTeam(sheet, list) {
      if (!Array.isArray(list) || list.length !== TEAM) return { ok: false, why: `a team is ${TEAM} producers` };
      if (new Set(list).size !== TEAM) return { ok: false, why: "the same producer twice" };
      const price = new Map((sheet?.pool || []).map((p) => [p.a, p.price]));
      let cost = 0;
      for (const a of list) { if (!price.has(a)) return { ok: false, why: "a producer not in this week's pool" }; cost += price.get(a); }
      if (cost > (sheet.budget || BUDGET)) return { ok: false, why: `over the budget (${cost} of ${sheet.budget || BUDGET})`, cost };
      return { ok: true, cost };
    }
    /** Changes from yesterday's team to today's: producers swapped out, plus 1 if the captaincy moved to a producer that
     *  was already on the team (a swapped-in producer taking the captaincy is part of its own swap). */
    function changes(prev, next) {
      const old = new Set(prev), out = prev.filter((a) => !next.includes(a)).length;
      const capMoved = prev[0] !== next[0] && old.has(next[0]);
      return out + (capMoved ? 1 : 0);
    }
    /** The team in force on each of the 7 days of a week. picks: { [dayNo]: list } (the player's last pick for that day,
     *  as the Picks contract holds it). start: the team carried in from before the week, or null: it plays Monday only
     *  if there's no valid Monday pick and it fits this week's list. Monday's pick may change any number of producers.
     *  Returns [{ day, team (or null), note? }] for the 7 days. */
    function teamsForWeek(sheet, days, picks, start = null) {
      let cur = start && checkTeam(sheet, start).ok ? start : null;
      return days.map((d, i) => {
        if (i === 0) {
          const p = picks?.[d];
          if (Array.isArray(p)) { const c = checkTeam(sheet, p); if (c.ok) cur = [...p]; else return { day: d, team: cur ? [...cur] : null, note: `ignored: ${c.why}` }; }
          return { day: d, team: cur ? [...cur] : null };
        }
        const p = picks?.[d];
        let note;
        if (Array.isArray(p) && !(cur && p.length === cur.length && p.every((a, i) => a === cur[i]))) {
          const c = checkTeam(sheet, p);
          if (!c.ok) note = `ignored: ${c.why}`;
          else if (cur && changes(cur, p) > 1) note = "ignored: more than one change from yesterday";
          else cur = [...p];
        }
        return { day: d, team: cur ? [...cur] : null, ...(note ? { note } : {}) };
      });
    }
    /** A team's score for one day from that day's producer index: each producer's index capped at 130, captain double. */
    function dayScore(team, day) {
      if (!team) return 0;
      let s = 0;
      team.forEach((a, i) => { const x = day?.producers?.[a]; const ix = Array.isArray(x) && x[2] !== null ? Math.min(DAY_CAP, x[2]) : 0; s += ix * (i === 0 ? CAPTAIN : 1); });
      return round(s, 2);
    }
    /** A player's week: the day-by-day teams and scores, the total, and whether a team stood on all 7 days. */
    function scoreWeek(sheet, dayRecords, picks, start = null) {
      const days = dayRecords.map((x) => x.day), teams = teamsForWeek(sheet, days, picks, start);
      const rows = teams.map((t, i) => ({ ...t, score: dayScore(t.team, dayRecords[i]) }));
      return { days: rows, points: round(rows.reduce((s, r) => s + r.score, 0), 2), full: rows.every((r) => r.team) };
    }
    /** The vault's whole points for a week's players: 255 for the best score, one less for each lower distinct score
     *  (ties keep the same points), never below 1; a score of 0 gets nothing. Ranked among `eligible` only (the wallets
     *  with a Fantasy stake that week) when given: free players must not push stakers down (audit FX-3).
     *  Returns a Map address → points. */
    function vaultPoints(rows, eligible = null) {
      const ok = rows.filter((r) => r.points > 0 && (!eligible || eligible.has(r.a)));
      const scores = [...new Set(ok.map((r) => r.points))].sort((x, y) => y - x);
      const at = new Map(scores.map((p, i) => [p, Math.max(1, VAULT_MAX - i)]));
      return new Map(ok.map((r) => [r.a, at.get(r.points)]));
    }
    /** A team as positions on the week's price list (the W files keep teams this small; audit FX-4), and back. */
    const packTeam = (sheet, team) => (team ? team.map((a) => sheet.pool.findIndex((p) => p.a === a)) : null);
    const unpackTeam = (sheet, t) => (Array.isArray(t) && t.every((i) => Number.isInteger(i) && sheet && sheet.pool[i]) ? t.map((i) => sheet.pool[i].a) : null);
    /** Rank players by week points (more first); equal points share a place. Returns rows with place. */
    function rank(rows) {
      const s = [...rows].sort((x, y) => y.points - x.points || (x.a < y.a ? -1 : 1));
      let place = 0;
      return s.map((r, i) => { if (i === 0 || r.points !== s[i - 1].points) place = i + 1; return { ...r, place }; });
    }

    // ── Weekly Rival ──
    /** The week's matches. challenges: [[challenger, target]]; players: { [address]: { points, full } }; staked: the
     *  wallets holding a Knode Games stake (null = not checked: everyone counts, used only for tests and practice).
     *  A challenge counts if both are different, both had a team all 7 days and both are staked. Mutual challenges
     *  are one match.
     *  Returns [{ a, b, mutual, result }] with result "a" | "b" | "draw" (a = the challenger). */
    function matches(challenges, players, staked = null) {
      const seen = new Map(), out = [];
      for (const [a, b] of challenges || []) {
        if (!isAddr(a) || !isAddr(b) || a === b) continue;
        const pa = players[a], pb = players[b];
        if (!pa?.full || !pb?.full) continue;
        if (staked && !(staked.has(a) && staked.has(b))) continue;
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        if (seen.has(key)) { seen.get(key).mutual = true; continue; }
        const m = { a, b, mutual: false, result: pa.points > pb.points ? "a" : pb.points > pa.points ? "b" : "draw" };
        seen.set(key, m); out.push(m);
      }
      return out;
    }
    /** Add a week's matches to the records: { [address]: { made: [w, l, d], received: [w, l, d] } }. In a mutual match
     *  both players count it as made. Returns a new records object. */
    function addRecords(records, ms) {
      const r = JSON.parse(JSON.stringify(records || {}));
      const rec = (x) => (r[x] = r[x] || { made: [0, 0, 0], received: [0, 0, 0] });
      const put = (x, part, res) => { rec(x)[part][res === "w" ? 0 : res === "l" ? 1 : 2]++; };
      for (const m of ms) {
        const ra = m.result === "a" ? "w" : m.result === "b" ? "l" : "d", rb = ra === "w" ? "l" : ra === "l" ? "w" : "d";
        put(m.a, "made", ra); put(m.b, m.mutual ? "made" : "received", rb);
      }
      return r;
    }
    /** Add a final week's players to the all-time table { [address]: { points, weeks, best } }. Returns a new table. */
    function addAllTime(table, rows) {
      const t = JSON.parse(JSON.stringify(table || {}));
      for (const r of rows) {
        if (!isAddr(r.a) || !(r.points > 0)) continue;
        const x = (t[r.a] = t[r.a] || { points: 0, weeks: 0, best: 0 });
        x.points = round(x.points + r.points, 2); x.weeks += 1; x.best = Math.max(x.best, r.points);
      }
      return t;
    }
    /** The all-time table as ranked rows: most points first; equal points share a place. */
    const allTimeRows = (table) => rank(Object.entries(table || {}).map(([a, x]) => ({ a, points: x.points, weeks: x.weeks, best: x.best })));
    /** One record's combined line and win share (draws count half). */
    function recordLine(x) {
      const w = x.made[0] + x.received[0], l = x.made[1] + x.received[1], d = x.made[2] + x.received[2], n = w + l + d;
      return { w, l, d, n, pct: n ? round((w + d / 2) / n, 4) : 0 };
    }

    return {
      TEAM, BUDGET, DAY_CAP, CAPTAIN, PRICE, FORM_DAYS, VAULT_MAX, LEAD_MS, GAMES, isAddr,
      clock: Object.freeze({ ...C, week: WEEK }), DAY_MS: C.day, WEEK_MS: WEEK,
      dayNo, dayStart, weekOf, weekStart, weekDays, sheetTime, formDays, rivalRound, weekOfRivalRound, lockOfDay, lockOfWeek, games,
      cardAt, sharesOf, dayIndex, spanIndex, priceOf, medianOf, makeSheet, sheetText,
      checkTeam, changes, teamsForWeek, dayScore, scoreWeek, vaultPoints, packTeam, unpackTeam, rank,
      matches, addRecords, recordLine, addAllTime, allTimeRows,
    };
  }

  root.KFantasyMath = Object.freeze({ ...make(REAL), REAL, withClock: (c) => Object.freeze(make(c)) });
})(typeof window !== "undefined" ? window : globalThis);

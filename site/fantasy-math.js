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
 *   From one day to the next, a team may make one change: swap one producer, or move the captaincy. A swapped-in
 *   producer may take the captaincy of the one it replaced as part of that one change. A day with no new pick keeps
 *   yesterday's team. An invalid pick (not 5 different pool producers, over budget, more than one change) is ignored
 *   and yesterday's team stays. Days before a player's first valid team score 0.
 * - Week points = the sum of the 7 days. The vault takes whole points 1 to 255: round(points ÷ 25), at least 1 for any
 *   player who scored.
 * - Weekly Rival: a player may challenge one other player for the week. The match counts only when both had a team on
 *   all 7 days. More week points wins; equal is a draw. Two players who challenge each other play one match.
 *   A record keeps challenges made and challenges received apart. Rivals carry no prize money. */
(function (root) {
  "use strict";
  const R = root.KRaceMath;
  if (!R) throw new Error("fantasy-math.js needs race-math.js loaded first");
  const HOUR = R.HOUR, DAY = R.DAY, WEEK = R.WEEK;
  const TEAM = 5, BUDGET = 100, DAY_CAP = 130, CAPTAIN = 2;
  const PRICE = { base: 20, per: 1.5, min: 8, max: 40, none: 20 };
  const SHEET_AT = 6 * DAY + 12 * HOUR;          // the sheet for week w+1 is made at week w's Sunday 12:00 UTC
  const FORM_DAYS = 7;                           // form = the index over the 7 UTC days before the sheet's day
  const VAULT_DIV = 25, VAULT_MAX = 255;
  const isAddr = (a) => typeof a === "string" && /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a);
  const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;

  // ── time ──
  const dayNo = (t) => Math.floor(t / DAY);                 // the Picks round of a UTC day
  const dayStart = (d) => d * DAY;
  /** The 7 UTC day numbers of game week w. */
  const weekDays = (w) => { const d0 = dayNo(R.weekStart(w)); return Array.from({ length: 7 }, (_, i) => d0 + i); };
  /** When the price sheet for week w is made (Sunday 12:00 UTC before it), and the form window it uses. */
  const sheetTime = (w) => R.weekStart(w - 1) + SHEET_AT;
  const formDays = (w) => { const last = dayNo(sheetTime(w)) - 1; return Array.from({ length: FORM_DAYS }, (_, i) => last - FORM_DAYS + 1 + i); };

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
  /** For one UTC day: blocks B = { ts: [...ascending], sig: [index], signers: [address] } covering at least the day.
   *  Returns { [address]: [signed, expected (2 decimals), index (2 decimals) or null] } for every producer on a card
   *  that day or that signed a block, and the day's block count. */
  function dayIndex(B, racesById, d) {
    const t0 = dayStart(d), out = new Map();
    let i = R.lowerBound(B.ts, t0), blocks = 0;
    const get = (a) => { let x = out.get(a); if (!x) { x = { got: 0, exp: 0 }; out.set(a, x); } return x; };
    for (let h = 0; h < 24; h++) {
      const hs = t0 + h * HOUR, he = hs + HOUR;
      let n = 0;
      for (; i < B.ts.length && B.ts[i] < he; i++) { if (B.ts[i] < hs) continue; n++; const a = B.signers[B.sig[i]]; if (isAddr(a)) get(a).got++; }
      blocks += n;
      const card = cardAt(racesById, hs);
      if (card) for (const [a, s] of sharesOf(card)) get(a).exp += n * s;
    }
    const res = {};
    for (const [a, x] of [...out].sort((u, v) => (u[0] < v[0] ? -1 : 1))) res[a] = [x.got, round(x.exp, 2), x.exp > 0 ? round(100 * x.got / x.exp, 2) : null];
    return { blocks, producers: res };
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
   *  as the Picks contract holds it). start: the team carried in from before the week, or null.
   *  Returns [{ day, team (or null), note? }] for the 7 days. */
  function teamsForWeek(sheet, days, picks, start = null) {
    let cur = start && checkTeam(sheet, start).ok ? start : null;
    return days.map((d) => {
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
  /** The vault's whole points: round(points ÷ 25), at least 1 for any score above 0, at most 255. */
  const vaultPoints = (p) => (p > 0 ? Math.min(VAULT_MAX, Math.max(1, Math.round(p / VAULT_DIV))) : 0);
  /** Rank players by week points (more first); equal points share a place. Returns rows with place. */
  function rank(rows) {
    const s = [...rows].sort((x, y) => y.points - x.points || (x.a < y.a ? -1 : 1));
    let place = 0;
    return s.map((r, i) => { if (i === 0 || r.points !== s[i - 1].points) place = i + 1; return { ...r, place }; });
  }

  // ── Weekly Rival ──
  /** The week's matches. challenges: [[challenger, target]]; players: { [address]: { points, full } }.
   *  A challenge counts if both are different, both had a team all 7 days. Mutual challenges are one match.
   *  Returns [{ a, b, mutual, result }] with result "a" | "b" | "draw" (a = the challenger). */
  function matches(challenges, players) {
    const seen = new Map(), out = [];
    for (const [a, b] of challenges || []) {
      if (!isAddr(a) || !isAddr(b) || a === b) continue;
      const pa = players[a], pb = players[b];
      if (!pa?.full || !pb?.full) continue;
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
  /** One record's combined line and win share (draws count half). */
  function recordLine(x) {
    const w = x.made[0] + x.received[0], l = x.made[1] + x.received[1], d = x.made[2] + x.received[2], n = w + l + d;
    return { w, l, d, n, pct: n ? round((w + d / 2) / n, 4) : 0 };
  }

  root.KFantasyMath = {
    TEAM, BUDGET, DAY_CAP, CAPTAIN, PRICE, FORM_DAYS, VAULT_DIV, VAULT_MAX,
    dayNo, dayStart, weekDays, sheetTime, formDays,
    cardAt, sharesOf, dayIndex, spanIndex, priceOf, medianOf, makeSheet, sheetText,
    checkTeam, changes, teamsForWeek, dayScore, scoreWeek, vaultPoints, rank,
    matches, addRecords, recordLine,
  };
})(typeof window !== "undefined" ? window : globalThis);

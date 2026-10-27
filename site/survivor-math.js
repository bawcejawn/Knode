/* Survivor: the shared math. The page (survivor.js) and the recorder (bot/games/survivor.ts) both use this one file,
 * so a day scored in the browser and a day recorded by the bot always agree. No network, no page, no wallet.
 *
 * FORMAT (owner's decisions 2026-10-27)
 * - A season is 14 UTC days (two game weeks), Monday 00:00 UTC to Monday 00:00 UTC; the next starts right after.
 *   Season 1 starts on FIRST_DAY (set at launch; null until then, when the page shows practice standings only).
 * - One pick a day: the producer you think will NOT land in the day's out-zone. A day's pick is round d of the
 *   KnodeGames Picks contract (game 3, time-locked: round d's target is 00:00 UTC of day d). The contract refuses a
 *   pick from 23:55 UTC the night before (5 minutes ahead, before any block of the day), and opens it 7 days ahead.
 * - You are in the season if you have a pick for day 1. Nobody can join after day 1 locks.
 *
 * THE DAY'S SCORE
 *   score = blocks the producer signs that UTC day × h,   h = kTop ÷ k   (the plain handicap, c = 0)
 * - k is the producer's own blocks over the 7 full days ending two days before (days d−8 … d−2), so the handicap is
 *   known all through day d−1, before the lock. Using real recent blocks rather than VHP matters: on 25–27 Oct three
 *   producers signed only 75–80% of what their VHP predicted, and a VHP handicap put them in the out-zone ~90% of
 *   days (re-run of the 27 Oct simulation). With recent blocks, every producer lands there 16–40% of days.
 * - The field: producers with at least 280 blocks in those 7 days (40 a day, the race's "10 a race" entry level).
 * - Rounded to 4 decimals, as the race does.
 *
 * THE OUT-ZONE grows through the season, from a quarter of the field on day 1 to half on day 14:
 *   out(day n of the season) = floor(field size × (12 + n) ÷ 52)      (17 producers: 4,4,4,5,5,5,6,6,6,7,7,7,8,8)
 * - The out-zone is the producers whose score is below the (out + 1)-th lowest score: ties at the line are safe.
 *
 * LIVES AND PICKS
 * - 2 lives. You lose one when your producer lands in the out-zone, or when you have no valid pick: no pick, a
 *   producer not in the day's field, or a producer you already used this season (each producer once a season).
 * - Safety net: if everyone still in would lose a life on the same day, nobody loses one for the out-zone. A missing
 *   pick, a producer not in the field or a reused producer still costs the life (audit SV-1: otherwise wallets that
 *   pick on day 1 and never again would all be saved every day). A producer picked on a saved day still counts as used.
 * - The season ends after the day on which 2 or fewer players are left (if it started with more than 2), or after
 *   day 14. Simulated on the live 17-producer field: ends about day 11 with 10 players, day 13 with 50; with 200
 *   about 4 are left on day 14 and the ranking decides.
 *
 * RANKING: still in (or out later) first, then more lives left, then the higher total score of your picks.
 *   Equal on all three: the same place.
 * PRIZES at season end: 4 VHP for 1st and 2 VHP for 2nd (two weeks of the free-game 2 + 1), ties split the places
 *   they cover. Only for wallets that held at least 1 VHP (or a Knode stake) at every daily check while they were in
 *   the season, so a farm of empty wallets can't win it, and only in a season that at least 3 players joined
 *   (default pending the owner's OK, audit SV-1). The vault pays them (Build 1). */
(function (root) {
  "use strict";
  const DAY = 86400000;
  const GAME_ID = 3;
  const SEASON_DAYS = 14, LIVES = 2, USES = 1;
  const FORM_DAYS = 7, FORM_GAP = 2, MIN_FORM = 280;
  const LEAD_MS = 5 * 60000, AHEAD_MS = 7 * DAY, PICKS_PER_DAY = 20, MAX_CHANGES = 5;
  const PRIZES = [4, 2];
  const MIN_PRIZE_PLAYERS = 3;             // a season needs at least this many players for prizes (default, audit SV-1)
  /** One letter a day in a player's log: s safe, o out-zone, n no pick, f not in the field, u already used, v saved. */
  const CODE = { safe: "s", out: "o", none: "n", field: "f", used: "u", saved: "v" };
  const CORRECTION_MS = 12 * 3600000;      // a season's result is final 12 hours after it ends
  /** Season 1's first UTC day (days since 1970), a Monday. null until the owner sets the launch. */
  const FIRST_DAY = null;
  const round4 = (x) => Math.round(x * 1e4) / 1e4;
  const isAddr = (a) => typeof a === "string" && /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a);
  const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

  // ── time ──
  const dayIndex = (t) => Math.floor(t / DAY);
  const dayStart = (d) => d * DAY;
  const dayLabel = (d) => new Date(d * DAY).toISOString().slice(0, 10);
  const isMonday = (d) => new Date(d * DAY).getUTCDay() === 1;
  /** The time from which the Picks contract refuses a pick for day d (23:55 UTC the night before). */
  const lockTime = (d) => d * DAY - LEAD_MS;
  /** Is day d open for a pick in a block made at time t? Exactly the contract's rule (round d, target d × DAY). */
  const isOpen = (d, t) => d * DAY > LEAD_MS && t < lockTime(d) && d * DAY - t <= AHEAD_MS;
  /** The days open at time t, soonest first. */
  function openDays(t) {
    const out = [];
    for (let d = dayIndex(t); d * DAY - t <= AHEAD_MS; d++) if (isOpen(d, t)) out.push(d);
    return out;
  }
  /** The season and its day number (1–14) for a UTC day, or null before Season 1 (or with no launch set). */
  function seasonOf(d, first = FIRST_DAY) {
    if (!Number.isInteger(first) || !Number.isInteger(d) || d < first) return null;
    const s = Math.floor((d - first) / SEASON_DAYS);
    return { season: s + 1, n: d - first - s * SEASON_DAYS + 1, start: first + s * SEASON_DAYS };
  }
  const seasonStartDay = (season, first = FIRST_DAY) => (Number.isInteger(first) ? first + (season - 1) * SEASON_DAYS : null);

  // ── the field ──
  /** The days whose blocks set day d's handicap: d−8 … d−2. */
  const formDays = (d) => Array.from({ length: FORM_DAYS }, (_, i) => d - FORM_GAP - FORM_DAYS + 1 + i);
  /** Day d's field from recorded days. days: Map(day → { counts: [[address, blocks], ...] }). null if one is missing.
   *  Returns [{ a, k, h }] biggest first (ties: address order). */
  function fieldFor(d, days) {
    const k = new Map();
    for (const x of formDays(d)) {
      const rec = days.get(x);
      if (!rec || !Array.isArray(rec.counts)) return null;
      for (const [a, n] of rec.counts) if (isAddr(a) && Number.isInteger(n) && n > 0) k.set(a, (k.get(a) || 0) + n);
    }
    const rows = [...k.entries()].filter(([, n]) => n >= MIN_FORM).sort((x, y) => y[1] - x[1] || cmpStr(x[0], y[0]));
    if (!rows.length) return [];
    const top = rows[0][1];
    return rows.map(([a, n]) => ({ a, k: n, h: round4(top / n) }));
  }
  /** How many producers are in the out-zone on season day n (1–14) with a field of size m. */
  const outSize = (m, n) => Math.floor((m * (12 + Math.min(SEASON_DAYS, Math.max(1, n)))) / 52);

  // ── a day ──
  /** The day's standings: field [{a, k, h}], counts [[address, blocks]] for that day (or a live partial day), n =
   *  the season day. Returns { rows: [{ a, blocks, h, score }] best first, out: [addresses], line } where line is the
   *  score a producer must reach to be safe (ties at the line are safe). */
  function scoreDay(field, counts, n) {
    const got = new Map();
    for (const [a, c] of counts || []) if (isAddr(a) && Number.isInteger(c) && c >= 0) got.set(a, c);
    const rows = (field || []).map((f) => { const blocks = got.get(f.a) || 0; return { a: f.a, blocks, h: f.h, score: round4(blocks * f.h) }; });
    rows.sort((x, y) => y.score - x.score || cmpStr(x.a, y.a));
    const o = outSize(rows.length, n);
    if (!o) return { rows, out: [], line: null };
    const asc = rows.map((r) => r.score).sort((x, y) => x - y);
    const line = asc[o];
    return { rows, out: rows.filter((r) => r.score < line).map((r) => r.a), line };
  }

  // ── a season ──
  /** Play a season from its recorded days, in order. days: [{ n, field, counts, picks: [[player, producer]],
   *  noVhp: [players still in who did NOT hold 1 VHP or a stake at that day's check] }] for n = 1, 2, … without gaps.
   *  Returns { players: [...ranked, with place], over, endN }. Each player: { a, lives, outN (the day they went out,
   *  or null), total (sum of their picks' scores, 4 decimals), used: [producers], log (one letter per day played, see
   *  CODE), eligible }. */
  function playSeason(days) {
    const ps = new Map();
    const first = days.find((x) => x.n === 1);
    if (!first) return { players: [], over: false, endN: 0 };
    for (const [p] of first.picks || []) if (isAddr(p) && !ps.has(p)) ps.set(p, { a: p, lives: LIVES, outN: null, total4: 0, used: [], log: "", eligible: true });
    const started = ps.size;
    let over = false, endN = 0;
    for (let i = 0; i < days.length; i++) {
      const day = days[i];
      if (day.n !== i + 1 || over) break;
      const sc = scoreDay(day.field, day.counts, day.n);
      const score = new Map(sc.rows.map((r) => [r.a, r.score])), out = new Set(sc.out);
      const pick = new Map();
      for (const [p, a] of day.picks || []) if (isAddr(p) && isAddr(a)) pick.set(p, a);
      const noVhp = new Set(day.noVhp || []);
      const alive = [...ps.values()].filter((x) => x.outN === null);
      const fate = alive.map((x) => {
        const a = pick.get(x.a) || null;
        const code = !a ? "none" : !score.has(a) ? "field" : x.used.includes(a) ? "used" : out.has(a) ? "out" : "safe";
        return { x, a, code };
      });
      // The safety net: everyone still in would lose a life today. It saves only out-zone losses (audit SV-1).
      const allLose = fate.length > 0 && fate.every((f) => f.code !== "safe");
      for (const { x, a, code } of fate) {
        if (noVhp.has(x.a)) x.eligible = false;
        const valid = code === "safe" || code === "out";
        if (valid) { x.used.push(a); x.total4 += Math.round(score.get(a) * 1e4); }
        if (code === "safe") { x.log += CODE.safe; continue; }
        if (allLose && code === "out") { x.log += CODE.saved; continue; }
        x.log += CODE[code];
        x.lives--;
        if (x.lives <= 0) x.outN = day.n;
      }
      endN = day.n;
      const left = [...ps.values()].filter((x) => x.outN === null).length;
      if ((started > 2 && left <= 2) || day.n >= SEASON_DAYS) over = true;
    }
    const players = rank([...ps.values()].map((x) => ({ a: x.a, lives: Math.max(0, x.lives), outN: x.outN, total: x.total4 / 1e4, used: x.used, log: x.log, eligible: x.eligible })));
    return { players, over, endN };
  }
  /** Ranking: in longest (still in first), then lives, then total score; equal on all three share a place. */
  function rank(players) {
    const key = (x) => [x.outN === null ? Infinity : x.outN, x.lives, x.total];
    const sorted = [...players].sort((x, y) => { const a = key(x), b = key(y); return b[0] - a[0] || b[1] - a[1] || b[2] - a[2] || cmpStr(x.a, y.a); });
    let place = 0;
    return sorted.map((x, i) => {
      const p = sorted[i - 1];
      if (!p || key(p).some((v, j) => v !== key(x)[j])) place = i + 1;
      return { ...x, place };
    });
  }
  /** Season prizes among eligible players (held 1 VHP at every check): 4 VHP for 1st, 2 VHP for 2nd; tied players
   *  split the prizes of the places they cover. Places are re-counted among the eligible. Returns [{ player, place, vhp }]. */
  function prizes(players, amounts = PRIZES) {
    if (players.length < MIN_PRIZE_PLAYERS) return [];
    const ranked = rank(players.filter((x) => x.eligible));
    const out = [];
    for (let i = 0; i < ranked.length && i < amounts.length; ) {
      let j = i;
      while (j + 1 < ranked.length && ranked[j + 1].place === ranked[i].place) j++;
      let pot = 0;
      for (let k = i; k <= j && k < amounts.length; k++) pot += amounts[k];
      const each = Math.floor((pot / (j - i + 1)) * 1e8) / 1e8;   // VHP has 8 decimals; round down
      for (let k = i; k <= j; k++) out.push({ player: ranked[k].a, place: ranked[k].place, vhp: each });
      i = j + 1;
    }
    return out;
  }

  root.KSurvivor = {
    DAY, GAME_ID, SEASON_DAYS, LIVES, USES, FORM_DAYS, FORM_GAP, MIN_FORM, LEAD_MS, AHEAD_MS, PICKS_PER_DAY, MAX_CHANGES,
    PRIZES, MIN_PRIZE_PLAYERS, CODE, CORRECTION_MS, FIRST_DAY,
    dayIndex, dayStart, dayLabel, isMonday, lockTime, isOpen, openDays, seasonOf, seasonStartDay,
    formDays, fieldFor, outSize, scoreDay, playSeason, rank, prizes,
  };
})(typeof window !== "undefined" ? window : globalThis);

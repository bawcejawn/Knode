/* Last Node Standing: the shared math. The page (lastnode.js) and the recorder (bot/games/lastnode.ts) both use this
 * one file, so a cut seen in the browser and a cut recorded by the bot always agree. No network, no page, no wallet.
 *
 * THE EVENT (owner's decisions 2026-10-27)
 * - Daily, starting 14:00 UTC (block timestamps). One cut every hour on the hour until one node is left; with 10 nodes
 *   that is 9 cuts, ending 23:00 UTC. The event counts in the KnodeGames week it starts in.
 * - The field and its handicaps are fixed for the whole event, from the Producer Race card of the 12:00 UTC leg the
 *   day before (race-math.js), so the field is known when picks open (24 hours ahead): producers expected to sign
 *   at least 20 blocks an hour (the 23 biggest if more, so an event never reaches the next day's start round).
 * - Handicap (the race formula): h = (kTop ÷ k) × (1 − c ÷ √k) ÷ (1 − c ÷ √kTop), k = expected blocks an hour.
 * - FORM (owner, 2026-10-29): k is the card's VHP share × the node's form, and form = the blocks the node actually
 *   signed in the 48 hours before the card ÷ the blocks its VHP share (hour by hour, that hour's average VHP from the
 *   5-minute race-samples readings; fix-check LNF-4) gave
 *   it, kept between 0.80 and 1.20. Real blocks showed nodes signing a steady 78% to 108% of their VHP share; with VHP
 *   alone, the steady over-signers won most events and the under-signers never did. Form takes the part that can be
 *   seen in advance out of the handicap. What's left is the day itself: a node running hot or cold (which can last a
 *   few days, so a node can win more than its share for a while) and luck. Watch-and-hold looks for a node that signs
 *   far above its multiplier (fix-check L-12).
 *   c (0.0 to 2.5 in steps of 0.1) is the value that gives every node the most equal chance of being last standing,
 *   from 20,000 simulated events with a fixed seed, so anyone re-running it gets the same c (0.2 on 2026-10-27).
 *   h is kept in ten-thousandths (an integer), so steps are exact integers and the browser and the bot never differ.
 * - The cut: at each hour, the node with the fewest handicapped steps since the start is knocked out. Ties: fewer raw
 *   blocks, then smaller VHP on the card, then the address that sorts later.
 *
 * PLAYING (the Picks contract, game 13: a list of up to 2 producers, one round per event; owner, 2026-10-29)
 * - One pick per event, made before it starts: your start node and, optionally, a backup. Picks open 24 hours ahead
 *   and lock at 13:50 UTC, 10 minutes before the start; nothing can be picked or changed during the race. A pick on a
 *   node outside the field, or none, is no entry; a backup outside the field is ignored.
 * - The first time your start node is cut, your backup takes over automatically, if it is still standing then (a jump,
 *   one per event). No backup, a backup already cut, or a cut of the node you jumped to, and your run ends there.
 * - Points: 1 for each cut your node survives (points before a jump are kept), plus a bonus for riding the last node
 *   standing: +5 if you never jumped, +3 if you did.
 * - Leaderboard: points, then last-node rides, then fewer jumps; players equal on all three share the place. Free
 *   players are shown; prizes follow the staked rules in the vault.
 *
 * OTHER TIMINGS (testnet practice). KLastNode is the real game (13). KLastNode.forGame(settings) gives the same rules for
 * another timing: a cut every `cut` ms, events every `period` ms starting `phase` ms into each period, picks locking
 * `lockBefore` before each start and opening `ahead` before the round's target. The fast test game 94 cuts every
 * 20 minutes, with an event every 4 hours; game 33 is the real timing on the testnet. */
(function (root) {
  "use strict";
  const HOUR = 3600000, DAY = 24 * HOUR, WEEK = 7 * DAY, MIN = 60000;
  const GENESIS = 1792368000000;     // KnodeGames week 0: Monday 2026-10-19 00:00 UTC (as race-math.js)
  const MIN_KH = 20;                 // expected blocks an hour to be in the field (by VHP, before form)
  const FORM_HOURS = 48, FORM_MIN = 0.8, FORM_MAX = 1.2, FORM_MIN_HOURS = 24;
  const BONUS = Object.freeze({ stayed: 5, jumped: 3 });
  const C_GRID = Array.from({ length: 26 }, (_, i) => i / 10);
  const SEED = 20261027, TRIALS = 20000;
  const H_SCALE = 10000;
  const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;

  /** The real game: game 13, a cut every hour from 14:00 UTC daily; rounds target hh:15 and lock at hh:10 (lead 5 min);
   *  picks open 24 hours ahead. Its Picks registration never changes once made, so these are registered exactly. */
  /** The real game (owner, 2026-10-29): one pick per event, a start node and an optional backup, made before the start.
   *  Picks open 24 hours ahead and lock 10 minutes before the 14:00 UTC start (lockBefore); the contract's lead is
   *  5 minutes, so each daily round's target is 13:55 UTC. */
  const MAINNET_GAME = Object.freeze({ id: 13, name: "Last Node Standing", cut: HOUR, lockBefore: 10 * MIN, lead: 5 * MIN, ahead: DAY,
    period: DAY, phase: 14 * HOUR, picksPerDay: 10, maxChanges: 5 });
  /** Testnet practice: game 94, a cut every 20 minutes, an event every 4 hours (00, 04, … UTC), picks lock 10 minutes
   *  before each start and open 4 hours ahead. (Games 93 and 13 on the testnet are the earlier, hourly-pick rules.) */
  const FAST_GAME = Object.freeze({ id: 94, name: "Last Node Standing fast test", cut: 20 * MIN, lockBefore: 10 * MIN, lead: 5 * MIN, ahead: 4 * HOUR,
    period: 4 * HOUR, phase: 0, picksPerDay: 50, maxChanges: 5 });
  /** Testnet practice with the real game's timing (daily at 14:00 UTC): the same settings under testnet id 33. */
  const REAL_TEST_GAME = Object.freeze({ ...MAINNET_GAME, id: 33, name: "Last Node Standing real timing", picksPerDay: 30 });

  // ── seeded random numbers (the same generator as race-math.js) ──
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
  const handicapOf = (k, kTop, c) => (kTop / k) * (1 - c / Math.sqrt(k)) / (1 - c / Math.sqrt(kTop));
  /** Chance each node is last standing with handicaps hs, from pre-drawn counts per cut (counts[t][cut][node]). */
  function chancesFrom(counts, hs) {
    const n = hs.length, wins = new Array(n).fill(0);
    const cum = new Float64Array(n), alive = new Uint8Array(n);
    for (const trial of counts) {
      cum.fill(0); alive.fill(1);
      for (let hr = 0; hr < n - 1; hr++) {
        const row = trial[hr];
        let worst = -1;
        for (let i = 0; i < n; i++) {
          if (!alive[i]) continue;
          cum[i] += row[i] * hs[i];
          if (worst < 0 || cum[i] < cum[worst] - 1e-9) worst = i;
        }
        alive[worst] = 0;
      }
      for (let i = 0; i < n; i++) if (alive[i]) wins[i]++;
    }
    return wins.map((w) => w / counts.length);
  }
  function drawCounts(ks, trials = TRIALS, seed = SEED) {
    const R = rng(seed), n = ks.length, out = new Array(trials);
    for (let t = 0; t < trials; t++) {
      const hours = new Array(Math.max(0, n - 1));
      for (let hr = 0; hr < n - 1; hr++) { const row = new Float64Array(n); for (let i = 0; i < n; i++) row[i] = R.poisson(ks[i]); hours[hr] = row; }
      out[t] = hours;
    }
    return out;
  }
  /** The c that makes every node's chance to be last standing most equal (ks: expected blocks per cut, biggest first). */
  function calibrate(ks, trials = TRIALS) {
    if (ks.length < 2) return { c: 0, min: 1, max: 1 };
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
  const hInt = (node) => Math.round(node.h * H_SCALE);
  /** Form from hourly windows: hours = [{ blocks: { address: count } (every signer), shares: { address: VHP share } }].
   *  Each node's blocks ÷ (each hour's total × its share that hour), kept within FORM_MIN..FORM_MAX, 3 decimals.
   *  Hours without shares (no race card) are left out; fewer than FORM_MIN_HOURS usable hours gives null (no form). */
  function formOf(hours) {
    const A = {}, E = {};
    let used = 0;
    for (const h of hours || []) {
      if (!h || !h.blocks || !h.shares) continue;
      const N = Object.values(h.blocks).reduce((s, x) => s + (Number(x) || 0), 0);
      if (!N) continue;
      used++;
      for (const [a, sh] of Object.entries(h.shares)) { if (!(sh > 0)) continue; A[a] = (A[a] || 0) + (Number(h.blocks[a]) || 0); E[a] = (E[a] || 0) + N * sh; }
    }
    if (used < FORM_MIN_HOURS) return null;
    const out = {};
    for (const a of Object.keys(E)) out[a] = round(Math.min(FORM_MAX, Math.max(FORM_MIN, A[a] / E[a])), 3);
    return out;
  }
  const weekOf = (t) => (t <= GENESIS ? 0 : Math.floor((t - GENESIS) / WEEK));
  const weekStart = (w) => GENESIS + w * WEEK;

  /** The rules for one timing. Throws on settings the Picks contract (time lock) would refuse, or that would let one
   *  event's rounds reach the next event's start round. */
  function forGame(g) {
    const ok = (x) => Number.isInteger(x) && x > 0;
    if (!g || !ok(g.id) || g.id >= 128 || !ok(g.cut) || !ok(g.lead) || !ok(g.lockBefore) || !ok(g.ahead) || !ok(g.period) || !Number.isInteger(g.phase))
      throw new Error("Last Node Standing: incomplete game settings");
    if (g.lead < 5 * MIN) throw new Error("the Picks contract needs a lead of at least 5 minutes");
    if (g.lockBefore < g.lead) throw new Error("picks must lock at least the contract's lead before the start (lockBefore >= lead)");
    if (!(g.ahead > g.lockBefore && g.ahead <= g.period)) throw new Error("picks open at most one event ahead (lockBefore < ahead <= period)");
    if (g.period % g.cut || g.phase % g.cut || g.phase < 0 || g.phase >= g.period || DAY % g.period || HOUR % g.cut && g.cut % HOUR)
      throw new Error("events must start on cut boundaries, a whole number of events a day");
    // Audit LN-14: an event's id is its UTC day, or its UTC hour, so every event must start on the hour.
    if (g.period < HOUR || g.period % HOUR || g.phase % HOUR) throw new Error("events must start on the hour (a period of at least 1 hour)");
    const CUT = g.cut, LEAD = g.lead, AHEAD = g.ahead, PERIOD = g.period, PHASE = g.phase, LOCK_BEFORE = g.lockBefore;
    /** At most 23 nodes, and fewer than the cuts that fit in a period, so an event ends before the next one's picks lock. */
    const MAX_FIELD = Math.min(23, PERIOD / CUT - 1);
    if (LOCK_BEFORE >= 2 * CUT) throw new Error("picks must lock less than two cuts before the start");
    const KSCALE = CUT / HOUR;       // expected blocks per cut = kh × KSCALE

    // ── time ──
    /** One round per event (the contract's round_size = the period). Round r's target is r × period + offset, chosen so
     *  that the round locks (lead before its target) exactly lockBefore before its event's start. */
    const OFFSET = (((PHASE - LOCK_BEFORE + LEAD) % PERIOD) + PERIOD) % PERIOD;
    const roundOf = (t) => Math.floor((t - OFFSET) / PERIOD);
    const roundTime = (r) => r * PERIOD + OFFSET;
    const lockTime = (r) => roundTime(r) - LEAD;
    /** Is round r open for a pick in a block made at time t? Exactly the contract's rule (time games). */
    const isOpen = (r, t) => roundTime(r) > LEAD && t < lockTime(r) && roundTime(r) - t <= AHEAD;
    const idOf = (start) => (PERIOD === DAY ? new Date(start).toISOString().slice(0, 10) : new Date(start).toISOString().slice(0, 13));
    /** An event, from its id ("YYYY-MM-DD" for daily games, "YYYY-MM-DDTHH" otherwise) or from a time (the event whose
     *  period holds that time). day = the event's id (it names the event's file). */
    function eventOf(x) {
      let start;
      if (typeof x === "string") {
        const m = PERIOD === DAY ? /^\d{4}-\d{2}-\d{2}$/.exec(x) : /^\d{4}-\d{2}-\d{2}T\d{2}$/.exec(x);
        if (!m) return null;
        start = PERIOD === DAY ? Date.parse(`${x}T00:00:00Z`) + PHASE : Date.parse(`${x}:00:00Z`);
        if (!Number.isFinite(start) || (start - PHASE) % PERIOD !== 0 || idOf(start) !== x) return null;
      } else {
        if (!Number.isFinite(x)) return null;
        start = Math.floor((x - PHASE) / PERIOD) * PERIOD + PHASE;
        if (PERIOD === DAY) start = Math.floor(x / DAY) * DAY + PHASE;   // the UTC day's event, as before
      }
      // The event's round: its target is lead after the lock, lockBefore before the start.
      const r = roundOf(start - LOCK_BEFORE + LEAD), opens = roundTime(r) - AHEAD;
      return { day: idOf(start), start, round: r, lock: lockTime(r), opens, cardTime: Math.floor((opens - HOUR) / HOUR) * HOUR };
    }
    /** The event after ev. */
    const nextEvent = (ev) => eventOf(ev.start + PERIOD + (PERIOD === DAY ? -PHASE : 0));
    /** The page's view of a round (audit LN-6/LN-22): reg = the game's lead and ahead as registered (default: these
     *  rules'), margin = how long before the lock the page stops sending. pickable: open now and before the cut-off. */
    const pickable = (r, t, reg = {}, margin = 0) => { const lead = reg.lead ?? LEAD, ahead = reg.ahead ?? AHEAD, rt = roundTime(r); return rt > lead && t >= rt - ahead && t + margin < rt - lead; };
    /** The next event whose start pick isn't past the page's cut-off, and whether picks for it are open at t. */
    function nextEntry(t, reg = {}, margin = 0) {
      const lead = reg.lead ?? LEAD, ahead = reg.ahead ?? AHEAD;
      let ev = eventOf(t);
      for (let k = 0; k < 4 && t + margin >= roundTime(ev.round) - lead; k++) ev = nextEvent(ev);
      return { ...ev, lock: roundTime(ev.round) - lead, opens: roundTime(ev.round) - ahead, open: pickable(ev.round, t, reg, margin) };
    }

    /** The event's field from the race card of its cardTime. card: { at, field: [{ a, vhp, k }] } (k = expected blocks
     *  in a 6-hour race). Returns { at, c, fairness, nodes: [{ a, vhp, kh, h }] }, biggest first, or null when fewer
     *  than 2 nodes sign 20 blocks an hour. */
    /** A race card's total VHP (field and paddock, in the card's order), to 2 decimals: each node's VHP share is
     *  its VHP ÷ this. */
    function cardTotal(card) {
      let t = 0;
      for (const x of [...(card && Array.isArray(card.field) ? card.field : []), ...(card && Array.isArray(card.paddock) ? card.paddock : [])]) if (x && Number.isFinite(x.vhp) && x.vhp > 0) t += x.vhp;
      return round(t, 2);
    }
    /** Fix-check LNF-3 (owner, 2026-10-29): VHP added after the field's card can only LOWER a node's multiplier during
     *  the race. For one cut window, card = the latest race card taken by the window's end. A node with more VHP on it
     *  than on the field's card gets its multiplier cut by the same ratio (in ten-thousandths, as hInt); never raised.
     *  (Everyone's blocks shift together when the total VHP changes, so the node's own VHP is the fair measure.)
     *  Returns { address: lowered hInt } (empty when nobody gained). */
    function raceCut(field, card) {
      const out = {};
      if (!field || !Array.isArray(field.nodes) || !card || !Array.isArray(card.field)) return out;
      const on = new Map();
      for (const x of [...card.field, ...(Array.isArray(card.paddock) ? card.paddock : [])]) if (x && typeof x.a === "string" && Number.isFinite(x.vhp) && x.vhp > 0 && !on.has(x.a)) on.set(x.a, x.vhp);
      for (const n of field.nodes) {
        const v = on.get(n.a);
        if (!v) continue;
        if (!(v > n.vhp)) continue;
        const h = Math.floor(hInt(n) * n.vhp / v + 0.5);
        if (h >= 1 && h < hInt(n)) out[n.a] = h;
      }
      return out;
    }
    /** The field from a race card. form (optional, from formOf): { address: factor }; a node's expected blocks are its
     *  VHP share × its form (1 if missing). Who is in the field is still decided by VHP alone. formInfo is stored as is. */
    function makeField(card, trials = TRIALS, form = null, formInfo = null) {
      if (!card || !Array.isArray(card.field)) return null;
      const rows = card.field
        .filter((r) => r && typeof r.a === "string" && Number.isFinite(r.vhp) && r.vhp > 0 && Number.isFinite(r.k) && r.k > 0)
        .map((r) => ({ a: r.a, vhp: r.vhp, kh: r.k / 6 }))
        .filter((r) => r.kh >= MIN_KH)
        .sort((x, y) => y.vhp - x.vhp || (x.a < y.a ? -1 : 1))
        .slice(0, MAX_FIELD);
      if (rows.length < 2) return null;
      const fo = (a) => { const x = form && Number(form[a]); return Number.isFinite(x) && x > 0 ? Math.min(FORM_MAX, Math.max(FORM_MIN, x)) : 1; };
      for (const r of rows) { r.r = fo(r.a); r.kh = r.kh * r.r; }
      // The biggest expected k sets the scale (with form, that may not be the biggest VHP).
      // Without form this is exactly the earlier rule (the biggest VHP sets the scale).
      const ks = rows.map((r) => r.kh * KSCALE), order = ks.map((k, i) => i);
      if (form) order.sort((x, y) => ks[y] - ks[x] || x - y);
      const kTop = ks[order[0]], cal = calibrate(order.map((i) => ks[i]), trials);
      const f = {
        at: Number(card.at) || 0, c: cal.c, fairness: [round(cal.min, 4), round(cal.max, 4)], vt: cardTotal(card),
        nodes: rows.map((r, i) => ({ a: r.a, vhp: round(r.vhp, 2), kh: round(r.kh, 2), h: Math.round(handicapOf(ks[i], kTop, cal.c) * H_SCALE) / H_SCALE, ...(form ? { r: r.r } : {}) })),
      };
      if (form) f.form = formInfo || { hours: FORM_HOURS };
      return f;
    }

    // ── the cuts ──
    /** Cuts from the recorded windows. hours[i] = { blocks: { address: count } } for the window start + i cuts.
     *  Returns { cuts: [{ at (cut number 1..), a, steps, blocks }], standing, winner, done, totals }. */
    function cutsFrom(field, hours) {
      const nodes = field.nodes, n = nodes.length;
      const steps = new Array(n).fill(0), blocks = new Array(n).fill(0), out = new Array(n).fill(0);
      const cuts = [];
      for (let hr = 0; hr < hours.length && cuts.length < n - 1; hr++) {
        const b = (hours[hr] && hours[hr].blocks) || {};
        const hh = (hours[hr] && hours[hr].hh) || null;          // fix-check LNF-3: lowered multipliers for this window
        for (let i = 0; i < n; i++) if (!out[i]) { const k = Number(b[nodes[i].a]) || 0; blocks[i] += k; steps[i] += k * (hh && Number.isInteger(hh[nodes[i].a]) && hh[nodes[i].a] < hInt(nodes[i]) && hh[nodes[i].a] >= 1 ? hh[nodes[i].a] : hInt(nodes[i])); }
        let worst = -1;
        for (let i = 0; i < n; i++) {
          if (out[i]) continue;
          if (worst < 0) { worst = i; continue; }
          const w = worst;
          if (steps[i] < steps[w] || (steps[i] === steps[w] && (blocks[i] < blocks[w] || (blocks[i] === blocks[w] &&
            (nodes[i].vhp < nodes[w].vhp || (nodes[i].vhp === nodes[w].vhp && nodes[i].a > nodes[w].a)))))) worst = i;
        }
        out[worst] = cuts.length + 1;
        cuts.push({ at: hr + 1, a: nodes[worst].a, steps: steps[worst], blocks: blocks[worst] });
      }
      const standing = nodes.filter((_, i) => !out[i]).map((x) => x.a);
      const done = cuts.length === n - 1;
      return { cuts, standing, done, winner: done ? standing[0] : null, totals: nodes.map((x, i) => ({ a: x.a, steps: steps[i], blocks: blocks[i], out: out[i] })) };
    }

    // ── a player's event ──
    /** choice: { start, backup } (the one pick a player made before the start; backup may be null). The backup takes
     *  over automatically the first time the start node is cut, if it is still standing then (a jump; one per event).
     *  Otherwise, or when the node ridden after a jump is cut, the run ends there.
     *  Returns { entered, start, backup, node, jumped, jumpTo, out (cut number or 0), survived, rode, points, path }. */
    function playerResult(field, result, choice) {
      const inField = new Set(field.nodes.map((x) => x.a));
      const start = choice && choice.start, backup = choice && choice.backup;
      const r = { entered: false, start: null, backup: null, node: null, jumped: false, jumpTo: null, out: 0, survived: 0, rode: false, points: 0, path: [] };
      if (!start || !inField.has(start)) return r;
      r.entered = true; r.start = start; r.node = start; r.path.push({ at: 0, a: start });
      if (backup && backup !== start && inField.has(backup)) r.backup = backup;
      const standing = new Set(inField);
      for (let k = 0; k < result.cuts.length; k++) {
        const cut = result.cuts[k], at = cut.at;
        standing.delete(cut.a);
        if (r.out) continue;
        if (cut.a !== r.node) { r.survived++; continue; }
        if (!r.jumped && r.backup && standing.has(r.backup)) { r.jumped = true; r.jumpTo = r.backup; r.node = r.backup; r.path.push({ at, a: r.backup }); }
        else r.out = k + 1;
      }
      if (result.done && !r.out && r.node === result.winner) { r.rode = true; r.points = r.survived + (r.jumped ? BONUS.jumped : BONUS.stayed); }
      else r.points = r.survived;
      return r;
    }
    /** The game's registration in the Picks contract (announce_game): a list of up to 2 producers ([start, backup]),
     *  time lock, one round per event. */
    const PICKS_GAME = Object.freeze({ game: g.id, kind: 2, list_size: 2, lock_mode: 2, round_size: PERIOD, round_offset: OFFSET, lead: LEAD, ahead: AHEAD, max_changes: g.maxChanges, max_picks_per_day: g.picksPerDay });

    return {
      GAME: g, GAME_ID: g.id, PICKS_GAME, CUT, LEAD, OFFSET, AHEAD, PERIOD, PHASE, LOCK_BEFORE, MAX_FIELD,
      HOUR, DAY, WEEK, GENESIS, MIN_KH, FORM_HOURS, FORM_MIN, FORM_MAX, FORM_MIN_HOURS, formOf, BONUS, SEED, TRIALS, H_SCALE, START_HOUR: PERIOD === DAY ? PHASE / HOUR : null,
      roundOf, roundTime, lockTime, isOpen, eventOf, nextEvent, pickable, nextEntry, cardTotal, raceCut, weekOf, weekStart, rng, handicapOf, calibrate, makeField, hInt,
      cutsFrom, playerResult, board, places, forGame, MAINNET_GAME, FAST_GAME, REAL_TEST_GAME,
    };
  }

  // ── leaderboard (the same for every timing) ──
  /** rows: [{ player, points, rode, jumped }]. Ranked by points, then rides, then fewer jumps, then address. */
  function board(rows) {
    const by = new Map();
    for (const x of rows) {
      let b = by.get(x.player);
      if (!b) { b = { player: x.player, pts: 0, rides: 0, jumps: 0, events: 0 }; by.set(x.player, b); }
      b.pts += x.points || 0; b.rides += x.rode ? 1 : 0; b.jumps += x.jumped ? 1 : 0; b.events++;
    }
    const out = [...by.values()];
    out.sort((a, b) => b.pts - a.pts || b.rides - a.rides || a.jumps - b.jumps || (a.player < b.player ? -1 : a.player > b.player ? 1 : 0));
    return out;
  }
  /** Places: players equal on points, rides and jumps share a place (owner's rule: ties share). */
  function places(ranked) {
    let place = 0;
    return ranked.map((r, i) => {
      const p = ranked[i - 1];
      if (!p || p.pts !== r.pts || p.rides !== r.rides || p.jumps !== r.jumps) place = i + 1;
      return { ...r, place };
    });
  }

  root.KLastNode = forGame(MAINNET_GAME);
})(typeof window !== "undefined" ? window : globalThis);

/* KnodeGames VHP STANDARD (owner decision 2026-10-28): the one way every game measures a producer's VHP.
 * Pure math, no network: the recorders (bot/vhp-chain.ts) feed it blocks and VHP events read from two nodes; the
 * pages can run the same code. Each game keeps its own multiplier / handicap rule ON TOP of these numbers.
 *
 * 1. THE SOURCE. A producer's VHP is rebuilt exactly, block by block, from the chain's own VHP contract events (every
 *    transfer, mint, burn; reverted transactions excluded), anchored by one balance read pinned to a block and checked
 *    on two nodes. Never from a reading taken at a set time: a producer can move VHP away for a moment.
 * 2. EFFECTIVE VHP (what block production uses; koinos-contracts-as vhp effective_balance_of, read by pob): VHP received
 *    counts only after 20 blocks, VHP removed stops counting at once. Exactly:
 *      effective(a, H) = max(0, balance just before block H − everything a received in blocks H−19 … H−1).
 *    Every block burns about 4 VHP of its signer's (the block reward is paid in KOIN).
 * 3. THE STANDARD MEASURES (each game picks the one that fits; "window" = a range of blocks):
 *    - cardVhp:   the HIGHEST effective VHP held over the CARD_BLOCKS (7,200, ~6 hours) before a card's block. Sets a
 *                 producer's OWN multiplier fixed before picks (race handicaps, Block X multipliers, salaries…). Looking
 *                 big only lowers your own multiplier. Looking small can't pay either, because of the CARD CREDIT:
 *                 a scored block is worth multiplier × min(1, cardVhp ÷ its effective VHP at that block) (audit S-1:
 *                 hiding VHP for 6+ hours, then bringing it back, would otherwise sign at full strength on a big
 *                 multiplier).
 *    - card totals and the field/paddock split use the AVERAGE effective VHP over the same 7,200 blocks, never the
 *                 maximum: VHP shuffled between one owner's addresses would be counted twice (audit S-2).
 *    - so on a card: a producer's OWN number (cardVhp, k = expected blocks from cardVhp ÷ the average total) sets its
 *                 multiplier; anything about OTHER producers (the total, "the top producer", the field) uses averages
 *                 (`avg`, `kAvg`, `topAvg`). A multiplier from an average-based number reopens S-1 (fix-check F-3).
 *    - baseline:  a producer's effective VHP at the START of a scoring window (e.g. the Bracket's UTC day), for judging
 *                 how it did after the fact. It is expected to sign at its baseline all window long, so moving VHP away
 *                 only lowers its real chances. A block it signs while holding MORE than its baseline counts as
 *                 baseline ÷ VHP of a block, which exactly cancels the extra chance: VHP added during the window, by the
 *                 producer or sent by anyone else, neither helps nor hurts (bracket audits A-1, G-1, G-2).
 *    - averageVhp: effective VHP averaged over the SEED_BLOCKS (28,800, ~1 day) before a time. For fields and seeding
 *                 (who is in, in what order).
 *    - the active set at a block: producers that signed one of the ACTIVE_BLOCKS (7,200) blocks before it.
 *    - expected blocks over a window = baseline × Σ over the window's blocks of 1 ÷ (effective VHP of the active set);
 *      credited blocks = Σ over the blocks it signed of min(1, baseline ÷ its effective VHP at that block).
 *      The Σ is the same for every producer, so comparing producers is credited blocks per baseline.
 *    A field (race card shape) = active producers by cardVhp (or averageVhp for seeding), "field" when they'd expect at
 *    least MIN_K = 10 blocks in a 6-hour race, else "paddock".
 * 4. GAME-SPECIFIC (not here): the race's calibrated handicap, Block X's min(3, top ÷ yours), plain kTop ÷ k, the
 *    Bracket's index, Golf/Fantasy/Survivor rules… all take these VHP numbers as their input. */
(function (root) {
  "use strict";
  const VHP_CONTRACT = "12Y5vW6gk8GceH53YfRkRre2Rrcsgw7Naq";   // mainnet VHP
  const DELAY_BLOCKS = 20;                       // vhp contract _delay_blocks
  const ACTIVE_BLOCKS = 7200, CARD_BLOCKS = 7200, SEED_BLOCKS = 28800;
  const MIN_K = 10, RACE_BLOCKS = 7200;           // the race field rule: ≥ 10 expected blocks in a 6-hour race
  const Q_SCALE = 1e15;

  /** VHP changes from decoded token events of the VHP contract: [{ h, a, d (satoshi, + in / − out) }].
   *  events: [{ h, src, name, from, to, value }] in block order; others (approve, other contracts) are ignored. */
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
   *  every block between the anchor and any height asked about.
   *   before(a, h)    satoshi balance just before block h (after block h − 1), or null without an anchor;
   *   effective(a, h) effective VHP for producing block h (rule 2), or null;
   *   maxEffective(a, h0, h1) the most effective VHP over blocks h0 … h1 − 1 (null without an anchor);
   *   avgEffective(a, h0, h1) the average over blocks h0 … h1 − 1. */
  function vhpBook(anchors, deltas) {
    const per = new Map();
    for (const x of deltas) { if (!anchors[x.a]) continue; let l = per.get(x.a); if (!l) per.set(x.a, (l = [])); l.push(x); }
    const idx = new Map();
    for (const [a, l] of per) {
      l.sort((p, q) => p.h - q.h);
      const hs = l.map((x) => x.h), cum = new Float64Array(l.length + 1), inc = new Float64Array(l.length + 1);
      for (let i = 0; i < l.length; i++) { cum[i + 1] = cum[i] + l[i].d; inc[i + 1] = inc[i] + Math.max(0, l[i].d); }
      idx.set(a, { hs, cum, inc });
    }
    const pos = (t, x) => { let lo = 0, hi = t.hs.length; while (lo < hi) { const m = (lo + hi) >> 1; if (t.hs[m] <= x) lo = m + 1; else hi = m; } return lo; };
    const upTo = (a, x) => { const t = idx.get(a); return t ? t.cum[pos(t, x)] : 0; };
    const incIn = (a, x0, x1) => { const t = idx.get(a); return t ? t.inc[pos(t, x1)] - t.inc[pos(t, x0 - 1)] : 0; };   // received in blocks x0 … x1
    const before = (a, h) => { const an = anchors[a]; if (!an) return null; return an.v + upTo(a, h - 1) - upTo(a, an.h); };
    const effective = (a, h) => { const b = before(a, h); if (b === null) return null; return Math.max(0, b - incIn(a, h - DELAY_BLOCKS + 1, h - 1)); };
    /** The blocks where a's effective VHP can change: after any delta, and DELAY_BLOCKS after a receipt. */
    function changePoints(a, h0, h1) {
      const t = idx.get(a), pts = [h0];
      if (t) for (const h of t.hs) for (const c of [h + 1, h + DELAY_BLOCKS]) if (c > h0 && c < h1) pts.push(c);
      return [...new Set(pts)].sort((x, y) => x - y);
    }
    return {
      before, effective,
      maxEffective(a, h0, h1) {
        if (!anchors[a] || h1 <= h0) return anchors[a] ? 0 : null;
        let m = 0; for (const h of changePoints(a, h0, h1)) m = Math.max(m, effective(a, h));
        return m;
      },
      avgEffective(a, h0, h1) {
        if (!anchors[a] || h1 <= h0) return anchors[a] ? 0 : null;
        const pts = changePoints(a, h0, h1); let s = 0;
        for (let i = 0; i < pts.length; i++) s += effective(a, pts[i]) * ((i + 1 < pts.length ? pts[i + 1] : h1) - pts[i]);
        return s / (h1 - h0);
      },
    };
  }

  /** Producers that signed one of the ACTIVE_BLOCKS blocks before index i of B ({ hs, sig, signers }). */
  function activeAt(B, i) {
    const s = new Set(); for (let j = Math.max(0, i - ACTIVE_BLOCKS); j < i; j++) s.add(B.signers[B.sig[j]]);
    return s;
  }
  /** A field in the race card's shape from VHP per producer (in VHP): rows sorted biggest first (equal: address), field
   *  when expecting ≥ MIN_K blocks in a 6-hour race. */
  function fieldOf(vhpOf) {
    const rows = [...vhpOf].filter(([, v]) => v > 0).map(([a, v]) => ({ a, vhp: Math.round(v / 1e6) / 100 }));
    const tot = rows.reduce((t, r) => t + r.vhp, 0), field = [], paddock = [];
    for (const r of rows.sort((x, y) => y.vhp - x.vhp || (x.a < y.a ? -1 : 1))) {
      const k = tot > 0 ? RACE_BLOCKS * r.vhp / tot : 0;
      (k >= MIN_K ? field : paddock).push({ ...r, k: Math.round(k * 100) / 100 });
    }
    return { field, paddock };
  }
  /** The standard CARD at index i of B: every producer active at i. Each row: `vhp` = its cardVhp (the most effective
   *  VHP over the CARD_BLOCKS blocks before i) and `k` = RACE_BLOCKS × cardVhp ÷ the total of averages: its OWN numbers,
   *  for its multiplier; `avg` = its average over the same blocks and `kAvg` = RACE_BLOCKS × avg ÷ that total: for
   *  anything about the others and for the field/paddock split (≥ MIN_K). Also `topAvg`, the biggest average, for
   *  "top ÷ yours" style multipliers (audit S-2, fix-check F-3). Rows sorted by cardVhp. */
  function cardAt(B, i, book) {
    const h0 = B.hs[Math.max(0, i - CARD_BLOCKS)], h1 = B.hs[i], rows = [];
    for (const a of activeAt(B, i)) {
      const mx = book.maxEffective(a, h0, h1), av = book.avgEffective(a, h0, h1);
      if (mx === null || av === null) throw new Error(`no VHP balance for ${a}`);
      if (mx > 0) rows.push({ a, vhp: Math.round(mx / 1e6) / 100, avg: Math.round(av / 1e6) / 100 });
    }
    const tot = rows.reduce((t, r) => t + r.avg, 0), field = [], paddock = [];
    const r2 = (x) => Math.round(x * 100) / 100;
    for (const r of rows.sort((x, y) => y.vhp - x.vhp || (x.a < y.a ? -1 : 1))) {
      const k = tot > 0 ? RACE_BLOCKS * r.vhp / tot : 0, kAvg = tot > 0 ? RACE_BLOCKS * r.avg / tot : 0;
      (kAvg >= MIN_K ? field : paddock).push({ ...r, k: r2(k), kAvg: r2(kAvg) });
    }
    return { field, paddock, topAvg: rows.reduce((m, r) => Math.max(m, r.avg), 0) };
  }
  /** The CARD CREDIT (audit S-1): what one block signed at height h is worth, as a share of the card multiplier, for a
   *  producer whose cardVhp (VHP, as on the card) was `cardVhp`: min(1, cardVhp ÷ its effective VHP at h). */
  function cardCredit(book, a, h, cardVhp) {
    const v = book.effective(a, h); if (v === null) throw new Error(`no VHP balance for ${a} at block ${h}`);
    const c = cardVhp * 1e8; return v <= c ? 1 : c / v;
  }
  /** The standard SEEDING / field over blocks [i0, i1) of B: every producer that signed one of them, by averageVhp. */
  function averageCard(B, i0, i1, book) {
    const who = new Set(); for (let i = i0; i < i1; i++) who.add(B.signers[B.sig[i]]);
    const m = new Map();
    for (const a of who) { const v = book.avgEffective(a, B.hs[i0], B.hs[i1 - 1] + 1); if (v === null) throw new Error(`no VHP balance for ${a}`); m.set(a, v); }
    return fieldOf(m);
  }
  /** Scoring-window stats for blocks i0 … i1 − 1 of B (a part of a window that started at block index `startI`, or
   *  baselines `base` already known for the window): per address in `who` its baseline (effective VHP just before the
   *  window's first block, satoshi), blocks signed, credited blocks (each signed block counts min(1, baseline ÷ its
   *  effective VHP then)), and q = Σ over the blocks of Q_SCALE ÷ (effective VHP of the active set). */
  function windowStats(B, i0, i1, who, book, base) {
    const keep = new Set(who), by = {}, cr = {}, w = {};
    const need = (a, h) => { const v = book.effective(a, h); if (v === null) throw new Error(`no VHP balance for ${a} at block ${h}`); return v; };
    for (const a of who) { by[a] = 0; cr[a] = 0; w[a] = base && Number.isFinite(base[a]) ? base[a] : need(a, B.hs[i0]); }
    const last = new Map();
    for (let i = Math.max(0, i0 - ACTIVE_BLOCKS); i < i0; i++) last.set(B.signers[B.sig[i]], i);
    let q = 0;
    for (let i = i0; i < i1; i++) {
      let tot = 0;
      for (const [a, j] of last) { if (j < i - ACTIVE_BLOCKS) { last.delete(a); continue; } tot += need(a, B.hs[i]); }
      if (tot > 0) q += Q_SCALE / tot;
      const s = B.signers[B.sig[i]];
      if (keep.has(s)) { by[s]++; const v = need(s, B.hs[i]); cr[s] += w[s] <= 0 ? 0 : v <= w[s] ? 1 : w[s] / v; }
      last.set(s, i);
    }
    return { by, cr, w, q };
  }
  /** Expected blocks = baseline (satoshi) × Σq ÷ Q_SCALE. */
  const expectedBlocks = (w, q) => w * q / Q_SCALE;

  root.KVhp = { VHP_CONTRACT, DELAY_BLOCKS, ACTIVE_BLOCKS, CARD_BLOCKS, SEED_BLOCKS, MIN_K, Q_SCALE,
    vhpDeltas, vhpBook, activeAt, fieldOf, cardAt, cardCredit, averageCard, windowStats, expectedBlocks };
})(typeof window !== "undefined" ? window : globalThis);

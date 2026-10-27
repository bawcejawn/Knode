/* race.html: the Producer Race. Read only: it reads blocks and VHP balances from the chain; guesses stay in this
   browser. Nothing here signs or sends a transaction.

   The race: every block producer is a horse. The track is a rolling 24-hour window: each block a producer signed in
   the last 24 hours moves its horse forward by that producer's handicap, and blocks older than 24 hours drop off.

   The handicap (why it is fair):
   - Blocks go to producers in proportion to their VHP. A producer with half the top producer's VHP signs about half
     as many blocks, so moving it 2 steps per block gives every horse the same EXPECTED speed. That is the first part:
     VHP of the biggest producer ÷ this producer's VHP. The biggest producer always moves exactly 1 step per block.
   - Same speed is not yet the same chance: a small producer's few blocks come in lucky or unlucky bursts, so its
     total swings much more, and over a day the streaky small horses would win most races. The second part trims
     that: × (1 − c/√k) ÷ (1 − c/√k_top), where k is the producer's expected blocks in 24 hours. (Luck in a count of
     k blocks is about √k blocks, so this removes c "lucky streaks" from every horse alike.)
   - c is re-tuned on this page from the current field (thousands of simulated 24-hour races, the same seeded runs
     for every visitor) to the value that gives every horse the most equal chance of leading a fresh 24 hours.
     With today's Koinos producers it lands near 1.2, and each horse then leads about 1 race in N for N horses.
   - Producers expected to sign fewer than 24 blocks a day (under one an hour) wait in the paddock: with so few blocks
     no handicap can be fair, a single block would decide the race. */
(() => {
  "use strict";
  const DAY = 86400000;
  const MIN_BLOCKS = 24;            // expected blocks per 24 h to enter the race
  const C_GRID = Array.from({ length: 26 }, (_, i) => i / 10);   // c = 0.0 … 2.5

  // ── seeded random numbers (the same simulated races for every visitor) ──
  function rng(seed) {
    let a = seed >>> 0;
    const next = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    let spare = null;
    const normal = () => { if (spare !== null) { const s = spare; spare = null; return s; } let u = 0; while (u === 0) u = next(); const v = next(); const r = Math.sqrt(-2 * Math.log(u)); spare = r * Math.sin(2 * Math.PI * v); return r * Math.cos(2 * Math.PI * v); };
    /** Poisson(mean): exact for small means, normal approximation for large ones. */
    const poisson = (mean) => {
      if (mean <= 0) return 0;
      if (mean >= 30) return Math.max(0, Math.round(mean + Math.sqrt(mean) * normal()));
      const L = Math.exp(-mean); let k = 0, p = 1;
      do { k++; p *= next(); } while (p > L);
      return k - 1;
    };
    return { next, normal, poisson };
  }

  /** Handicap for each entrant: k = expected blocks per 24 h (array, biggest first), c = luck trim. */
  const handicapOf = (k, kTop, c) => (kTop / k) * (1 - c / Math.sqrt(k)) / (1 - c / Math.sqrt(kTop));

  /** Seeded simulated 24-hour block counts: trials × horses (the same draws are reused for every handicap tried). */
  function drawCounts(ks, trials, seed = 20261027) {
    const R = rng(seed), out = new Array(trials);
    for (let t = 0; t < trials; t++) { const row = new Float64Array(ks.length); for (let i = 0; i < ks.length; i++) row[i] = R.poisson(ks[i]); out[t] = row; }
    return out;
  }
  /** Chance each horse leads, given simulated counts and handicaps (ties share). */
  function chancesFrom(counts, hs) {
    const n = hs.length, wins = new Array(n).fill(0);
    for (const row of counts) {
      let best = -1, nb = 0;
      for (let i = 0; i < n; i++) { const p = row[i] * hs[i]; if (p > best + 1e-9) { best = p; nb = 1; } else if (Math.abs(p - best) <= 1e-9) nb++; }
      for (let i = 0; i < n; i++) if (Math.abs(row[i] * hs[i] - best) <= 1e-9) wins[i] += 1 / nb;
    }
    return wins.map((w) => w / counts.length);
  }
  /** Chance each horse leads after a fresh 24 hours, from `trials` seeded races. */
  const winChances = (ks, hs, trials = 4000, seed = 20261027) => chancesFrom(drawCounts(ks, trials, seed), hs);

  /** The c that makes the chances most equal (smallest spread around 1/n). */
  function calibrate(ks, trials = 4000) {
    if (ks.length < 2) return { c: 0, chances: ks.map(() => 1) };
    const kTop = ks[0], fair = 1 / ks.length, cMax = Math.sqrt(Math.min(...ks)) * 0.8, counts = drawCounts(ks, trials);
    let best = null;
    for (const c of C_GRID) {
      if (c >= cMax) break;
      const w = chancesFrom(counts, ks.map((k) => handicapOf(k, kTop, c)));
      const err = w.reduce((s, x) => s + (x - fair) * (x - fair), 0);
      if (!best || err < best.err - 1e-12) best = { c, err, chances: w };
    }
    return best;
  }

  /** The field: producers with VHP > 0 that signed in the window. vhp: Map(address → VHP as a number). */
  function field(vhp, blocksPerDay) {
    const all = [...vhp.entries()].filter(([, v]) => v > 0);
    const total = all.reduce((s, [, v]) => s + v, 0);
    const rows = all.map(([addr, v]) => ({ addr, vhp: v, share: v / total, k: blocksPerDay * v / total })).sort((a, b) => b.vhp - a.vhp);
    const entrants = rows.filter((r) => r.k >= MIN_BLOCKS), paddock = rows.filter((r) => r.k < MIN_BLOCKS);
    const ks = entrants.map((r) => r.k);
    const cal = calibrate(ks);
    entrants.forEach((r, i) => { r.h = handicapOf(r.k, ks[0], cal.c); r.chance = cal.chances[i]; });
    return { entrants, paddock, c: cal.c, total };
  }

  /** Positions at time T: blocks signed in (T − 24 h, T] × handicap. B: block arrays; hOf: Map(signer index → h). */
  function positions(B, hOf, T) {
    const pos = new Map();
    let i = upper(B.ts, T) - 1;
    for (; i >= 0 && B.ts[i] > T - DAY; i--) { const h = hOf.get(B.sig[i]); if (h) pos.set(B.sig[i], (pos.get(B.sig[i]) || 0) + h); }
    return { pos, complete: i >= 0 || B.ts[0] <= T - DAY };   // complete = the data reaches back a full 24 h
  }
  /** First index with ts > T. */
  function upper(ts, T) { let lo = 0, hi = ts.length; while (lo < hi) { const m = (lo + hi) >> 1; if (ts[m] <= T) lo = m + 1; else hi = m; } return lo; }

  /** Chance each entrant leads at future time T (now = the newest block's time). */
  function oddsAt(B, entrants, idxOf, now, T, trials = 4000) {
    const n = entrants.length, base = new Array(n).fill(0), ahead = Math.max(0, T - now);
    if (ahead < DAY) {
      // What each horse has now, minus the blocks that will have dropped off by T (known already).
      const hOf = new Map(entrants.map((r) => [idxOf.get(r.addr), r.h]));
      const at = positions(B, hOf, now).pos, drop = new Map();
      for (let i = upper(B.ts, now - DAY); i < B.ts.length && B.ts[i] <= T - DAY; i++) { const h = hOf.get(B.sig[i]); if (h) drop.set(B.sig[i], (drop.get(B.sig[i]) || 0) + h); }
      entrants.forEach((r, j) => { const s = idxOf.get(r.addr); base[j] = (at.get(s) || 0) - (drop.get(s) || 0); });
    }
    const R = rng(Math.floor(T / 60000)), wins = new Array(n).fill(0), frac = Math.min(1, ahead / DAY);
    for (let t = 0; t < trials; t++) {
      let best = -Infinity; const p = new Array(n);
      for (let j = 0; j < n; j++) { p[j] = base[j] + R.poisson(entrants[j].k * frac) * entrants[j].h; if (p[j] > best) best = p[j]; }
      let nb = 0; for (let j = 0; j < n; j++) if (Math.abs(p[j] - best) <= 1e-9) nb++;
      for (let j = 0; j < n; j++) if (Math.abs(p[j] - best) <= 1e-9) wins[j] += 1 / nb;
    }
    return wins.map((w) => w / trials);
  }
  /** What a correct guess pays: the fair odds (1 ÷ chance), between 1.1× and 50×. */
  const paysFor = (p) => Math.min(50, Math.max(1.1, Math.round((1 / Math.max(p, 1e-6)) * 10) / 10));

  window.KRaceMath = { rng, handicapOf, winChances, calibrate, field, positions, oddsAt, paysFor, upper, MIN_BLOCKS, DAY };
  if (typeof document === "undefined" || !document.getElementById("track")) return;   // loaded by a test

  // ════════════════════════════ the page ════════════════════════════
  const lib = window.koilib || window.koinos || window;
  const RPC = "https://api.koinos.io";
  const VHP = "12Y5vW6gk8GceH53YfRkRre2Rrcsgw7Naq";
  const EXPLORER = "https://koinosscan.com/address/";
  const NAMES = { "1Mpmf2ERhjYpX7CCiM11WERuM4j17uT1sr": "Knode pool", "1FKTpXBhhHEbu5vVchM8UsVbAvPArJsRmR": "Knode Swap" };
  const GUESSES = "pr-guesses-v1", MILESTONES = [1, 3, 6, 12, 24];   // hours ahead
  const COLORS = ["#2F6B4F", "#F2B33D", "#B4432F", "#3E6FB0", "#8A4FB0", "#23845E", "#FF8A4C", "#5E6B63", "#C2547F", "#2D8C9E", "#9C7A2B", "#4B5BD6", "#7A9A3A", "#D9693F", "#6C4A3B", "#1F7A7A", "#A23B72", "#557C00", "#CC5500", "#456990"];

  const provider = new lib.Provider([RPC]);
  const types = { nested: { t: { nested: {
    balance_of_arguments: { fields: { owner: { type: "bytes", id: 1, options: { "(koinos.btype)": "ADDRESS" } } } },
    balance_of_result: { fields: { value: { type: "uint64", id: 1, options: { jstype: "JS_STRING" } } } },
  } } } };
  const vhpToken = new lib.Contract({ id: VHP, provider, abi: { methods: { balance_of: { entry_point: 0x5c721497, argument: "t.balance_of_arguments", return: "t.balance_of_result", read_only: true } }, koilib_types: types } });

  const $ = (id) => document.getElementById(id);
  const el = (tag, attrs = {}, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (k === "text") e.textContent = v; else e.setAttribute(k, v); } for (const c of kids) if (c != null) e.append(c); return e; };
  const say = (t) => { $("status").textContent = t; };
  const nameOf = (a) => NAMES[a] || a.slice(0, 5) + "…" + a.slice(-4);
  const fmt = (n, d = 0) => Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
  const pct = (p) => (p >= 0.995 ? ">99%" : p < 0.005 ? "<1%" : `${Math.round(p * 100)}%`);
  const when = (t) => new Date(t).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
  const store = { get: (k) => { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } };

  let B = null, F = null, idxOf = new Map(), colorOf = new Map(), now = 0, vhpAt = 0, vhp = new Map(), pick = null, lastTop = 0;

  async function readVhp(addrs) {
    const out = new Map(), queue = addrs.slice();
    const worker = async () => {
      while (queue.length) {
        const a = queue.shift();
        for (let t = 0; ; t++) {
          try { const r = await vhpToken.functions.balance_of({ owner: a }); out.set(a, Number((r.result && r.result.value) || 0) / 1e8); break; }
          catch (e) { if (t >= 2) throw e; await new Promise((r) => setTimeout(r, 800 * (t + 1))); }
        }
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    return out;
  }

  async function refresh(first = false) {
    const r = await KBlocks.ensure(provider, { blocks: 57000, onStatus: first ? (t) => t && say(t) : null });
    B = r.B; now = B.ts[B.ts.length - 1];
    idxOf = new Map(B.signers.map((a, i) => [a, i]));
    // Who signed in the last 24 hours, and how many blocks a day the chain makes.
    const i0 = upper(B.ts, now - DAY), seen = new Set();
    for (let i = i0; i < B.sig.length; i++) seen.add(B.signers[B.sig[i]]);
    const blocksPerDay = (B.sig.length - i0) * DAY / Math.max(1, now - B.ts[i0]);
    if (first || Date.now() - vhpAt > 600000 || [...seen].some((a) => !vhp.has(a))) {
      if (first) say("Reading each producer's VHP…");
      vhp = await readVhp([...seen]); vhpAt = Date.now();
      F = field(vhp, blocksPerDay);
      F.entrants.forEach((e, i) => { if (!colorOf.has(e.addr)) colorOf.set(e.addr, COLORS[colorOf.size % COLORS.length]); });
    }
    F.blocksPerDay = blocksPerDay;
    render();
    resolveGuesses();
    renderGuesses();
    say("");
  }

  // ── the track ──
  function render() {
    const hOf = new Map(F.entrants.map((r) => [idxOf.get(r.addr), r.h]));
    const { pos } = positions(B, hOf, now);
    const rows = F.entrants.map((r) => ({ ...r, pos: pos.get(idxOf.get(r.addr)) || 0 })).sort((a, b) => b.pos - a.pos);
    const par = F.entrants.length ? F.entrants[0].k : 1;
    const max = Math.max(par, ...rows.map((r) => r.pos)) * 1.06;
    const track = $("track");
    const existing = new Map([...track.children].map((c) => [c.dataset.addr, c]));
    rows.forEach((r, rank) => {
      let lane = existing.get(r.addr);
      if (!lane) {
        lane = el("div", { class: "pr-lane", "data-addr": r.addr },
          el("div", { class: "pr-who" }, el("span", { class: "pr-rank" }), el("span", { class: "pr-dot" }), el("a", { class: "pr-name", href: EXPLORER + r.addr, target: "_blank", rel: "noopener noreferrer" }), el("span", { class: "pr-meta" })),
          el("div", { class: "pr-run" }, el("div", { class: "pr-par" }), el("div", { class: "pr-trail" }), el("div", { class: "pr-horse", "aria-hidden": "true", text: "🏇" })));
        lane.querySelector(".pr-dot").style.background = colorOf.get(r.addr) || "var(--violet)";
        lane.querySelector(".pr-trail").style.background = colorOf.get(r.addr) || "var(--violet)";
      }
      lane.querySelector(".pr-rank").textContent = `${rank + 1}`;
      lane.querySelector(".pr-name").textContent = nameOf(r.addr);
      lane.querySelector(".pr-meta").textContent = `×${r.h.toFixed(2)} · ${fmt(r.pos, 0)} steps · ${fmt(r.share * 100, r.share < 0.01 ? 2 : 1)}% VHP`;
      const x = Math.min(100, (r.pos / max) * 100);
      lane.querySelector(".pr-horse").style.left = `calc(${x}% - 14px)`;
      lane.querySelector(".pr-trail").style.width = `${x}%`;
      lane.querySelector(".pr-par").style.left = `${(par / max) * 100}%`;
      lane.classList.toggle("pr-lead", rank === 0);
      lane.classList.toggle("pr-picked", pick === r.addr);
      lane.setAttribute("aria-label", `${rank + 1}. ${nameOf(r.addr)}: ${fmt(r.pos, 0)} steps, handicap ${r.h.toFixed(2)}`);
      track.append(lane);   // re-append in rank order
      existing.delete(r.addr);
    });
    for (const old of existing.values()) old.remove();

    const lead = rows[0];
    $("leader").textContent = lead ? nameOf(lead.addr) : "–";
    $("leader-by").textContent = rows[1] ? `ahead by ${fmt(lead.pos - rows[1].pos, 1)} steps` : "";
    $("field").textContent = `${F.entrants.length} horses`;
    $("calib").textContent = `c = ${F.c.toFixed(1)}`;
    $("calib-s").textContent = `each horse leads about ${pct(1 / Math.max(1, F.entrants.length))} of fresh races (range ${pct(Math.min(...F.entrants.map((e) => e.chance)))}–${pct(Math.max(...F.entrants.map((e) => e.chance)))})`;
    $("bpd").textContent = fmt(F.blocksPerDay, 0);
    $("par-note").textContent = `The dashed post is par: ${fmt(par, 0)} steps, what every horse covers in an average 24 hours.`;

    // Paddock
    $("paddock").replaceChildren(...F.paddock.map((p) => el("li", {}, el("a", { href: EXPLORER + p.addr, target: "_blank", rel: "noopener noreferrer", text: nameOf(p.addr) }), ` · ${fmt(p.share * 100, 3)}% VHP, about ${fmt(p.k, 1)} blocks a day`)));
    $("paddock-box").hidden = F.paddock.length === 0;

    // Latest blocks
    const feed = [];
    for (let i = B.sig.length - 1; i >= 0 && feed.length < 8; i--) {
      const a = B.signers[B.sig[i]], e = F.entrants.find((x) => x.addr === a);
      feed.push(el("li", {}, el("span", { class: "pr-dot" }), `${nameOf(a)} `, el("b", { text: e ? `+${e.h.toFixed(2)}` : "paddock" }), el("span", { class: "pr-ago", text: ` · block ${fmt(B.from + i)} · ${Math.max(0, Math.round((Date.now() - B.ts[i]) / 1000))} s ago` })));
      feed[feed.length - 1].querySelector(".pr-dot").style.background = colorOf.get(a) || "var(--line)";
    }
    $("feed").replaceChildren(...feed);
    if (B.top !== lastTop && lastTop) { const lane = track.querySelector(`[data-addr="${CSS.escape(B.signers[B.sig[B.sig.length - 1]])}"]`); if (lane) { lane.classList.remove("pr-step"); void lane.offsetWidth; lane.classList.add("pr-step"); } }
    lastTop = B.top;
    renderPicker();
  }

  // ── guesses ──
  function milestoneTimes() {
    const hour = 3600000, base = Math.ceil(Date.now() / hour) * hour;
    return MILESTONES.map((h) => base + (h - 1) * hour + (h === 1 && base - Date.now() < 20 * 60000 ? hour : 0));
  }
  let odds = new Map();   // milestone → chances array (entrants order)
  function renderPicker() {
    const sel = $("ms"), cur = Number(sel.value) || 0, times = milestoneTimes();
    sel.replaceChildren(...times.map((t, i) => el("option", { value: String(t), text: `${when(t)} (in about ${MILESTONES[i]} h)` })));
    sel.value = String(times.includes(cur) ? cur : times[0]);
    renderOdds();
  }
  function renderOdds() {
    const T = Number($("ms").value);
    let ch = odds.get(T);
    if (!ch || ch.at !== B.top) { ch = { at: B.top, p: oddsAt(B, F.entrants, idxOf, now, T) }; odds.set(T, ch); }
    const rows = F.entrants.map((e, j) => ({ e, p: ch.p[j] })).sort((a, b) => b.p - a.p);
    const mine = (store.get(GUESSES) || []).find((g) => g.T === T && !g.result);
    pick = mine ? mine.addr : null;
    for (const lane of $("track").children) lane.classList.toggle("pr-picked", lane.dataset.addr === pick);
    $("odds").replaceChildren(...rows.map(({ e, p }) => {
      const btn = el("button", { type: "button", class: "pr-pick" + (mine && mine.addr === e.addr ? " on" : "") },
        el("span", { class: "pr-dot" }), el("span", { class: "pr-pn", text: nameOf(e.addr) }), el("span", { class: "pr-pp", text: pct(p) }), el("span", { class: "pr-pay", text: `pays ${paysFor(p).toFixed(1)}×` }));
      btn.querySelector(".pr-dot").style.background = colorOf.get(e.addr) || "var(--violet)";
      btn.onclick = () => guess(T, e.addr, p);
      return btn;
    }));
    $("odds-note").textContent = mine ? `Your pick for ${when(T)}: ${nameOf(mine.addr)} (pays ${mine.pays.toFixed(1)}×). Tap another horse to change it; the odds update as blocks come in.` : `Who will lead at ${when(T)}? Tap a horse. Chances come from thousands of simulated races from right now.`;
  }
  function guess(T, addr, p) {
    const gs = (store.get(GUESSES) || []).filter((g) => !(g.T === T && !g.result));
    gs.push({ T, addr, pays: paysFor(p), p, made: Date.now() });
    store.set(GUESSES, gs.slice(-200));
    renderOdds(); renderGuesses();
  }
  /** Settle guesses whose milestone has passed, using the blocks up to that time and today's handicaps. */
  function resolveGuesses() {
    const gs = store.get(GUESSES) || []; let changed = false;
    const hOf = new Map(F.entrants.map((r) => [idxOf.get(r.addr), r.h]));
    for (const g of gs) {
      if (g.result || g.T > now) continue;
      const { pos, complete } = positions(B, hOf, g.T);
      if (!complete) { if (B.ts[0] > g.T - DAY) { g.result = "expired"; changed = true; } continue; }
      let best = null; for (const [s, v] of pos) if (!best || v > best.v) best = { s, v };
      g.winner = best ? B.signers[best.s] : null;
      g.result = g.winner === g.addr ? "won" : "lost"; changed = true;
    }
    if (changed) store.set(GUESSES, gs);
  }
  function renderGuesses() {
    const gs = (store.get(GUESSES) || []).slice().sort((a, b) => b.T - a.T);
    const done = gs.filter((g) => g.result === "won" || g.result === "lost"), won = done.filter((g) => g.result === "won");
    let streak = 0; for (const g of done) { if (g.result === "won") streak++; else break; }
    $("g-points").textContent = fmt(won.reduce((s, g) => s + g.pays, 0), 1);
    $("g-record").textContent = `${won.length} of ${done.length}`;
    $("g-streak").textContent = String(streak);
    $("g-open").textContent = String(gs.filter((g) => !g.result).length);
    $("guesses").replaceChildren(...gs.slice(0, 12).map((g) => el("li", { class: `pr-g ${g.result || "open"}` },
      el("b", { text: g.result === "won" ? "✓ Won" : g.result === "lost" ? "✗ Lost" : g.result === "expired" ? "– Not checked" : "⏳ Open" }),
      ` ${nameOf(g.addr)} to lead at ${when(g.T)} · pays ${g.pays.toFixed(1)}×`,
      g.result === "lost" && g.winner ? el("span", { class: "pr-ago", text: ` · ${nameOf(g.winner)} led` }) : null)));
    $("g-empty").hidden = gs.length > 0;
  }

  $("ms").onchange = renderOdds;
  $("clear").onclick = () => { if (window.confirm("Clear your guesses and points in this browser?")) { store.set(GUESSES, []); renderGuesses(); renderOdds(); } };

  (async () => {
    try { await refresh(true); }
    catch (e) { say("Couldn't reach the Koinos network. Trying again in a moment…"); if (window.console) console.warn("race:", e); }
    setInterval(() => { if (!document.hidden) refresh().catch(() => {}); }, 15000);
    setInterval(() => { if (B && F && !document.hidden) { const items = $("feed").querySelectorAll(".pr-ago"); items.forEach((n, j) => { const i = B.sig.length - 1 - j; if (i >= 0) n.textContent = ` · block ${fmt(B.from + i)} · ${Math.max(0, Math.round((Date.now() - B.ts[i]) / 1000))} s ago`; }); } }, 1000);
  })();
})();

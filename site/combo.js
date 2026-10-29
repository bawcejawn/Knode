/* combo.html: Combo Card builder. It reads the chain's head block, the race recorder's handicap cards (race-data) and,
   once it exists, the Combo recorder's leaderboard (games-data/combo). It prices each leg with combo-math.js, the same
   file the recorder (bot/games/combo.ts) will score with, and draws a share image on the page.
   Sending a card waits for the Combo upgrade of the Picks contract (CARD choice type): until then the page is a
   builder and never sends anything. Nothing leaves the browser except reads of public data. */
(() => {
  "use strict";
  const C = window.KCombo, M = window.KRaceMath, X = window.KBlockX;
  if (!C || !M || !X || typeof document === "undefined" || !document.getElementById("legs")) return;

  const lib = window.koilib || window.koinos || window;
  const RPC = "https://koinos.armana.io";
  const RACE_DATA = "https://raw.githubusercontent.com/bawcejawn/Knode/race-data/";
  const DATA = "https://raw.githubusercontent.com/bawcejawn/Knode/games-data/combo/";
  const EXPLORER = "https://koinosscan.com/address/";
  const PAGE = "https://bawcejawn.github.io/Knode/site/combo.html";
  const NAMES = { "1Mpmf2ERhjYpX7CCiM11WERuM4j17uT1sr": "Knode pool", "1FKTpXBhhHEbu5vVchM8UsVbAvPArJsRmR": "Knode Swap" };
  const DRAFT_KEY = "kg.combo.draft.v1";
  const CARD_STALE_MS = 65 * 60000;     // race cards come every hour; older than this, a new one is due
  const SHOW_HORSES = 5;                // horses shown per race before "Show all"
  // Games that will add legs when they launch (shown as "soon"; owner, 2026-10-28).
  const SOON = [["🛡️", "Survivor"], ["🏁", "Last Node"], ["🏆", "Bracket"], ["⛳", "Block Golf"]];
  const provider = lib.Provider ? new lib.Provider([RPC]) : null;
  const W = window.KWallet;
  const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  const $ = (id) => document.getElementById(id);
  const el = (tag, attrs = {}, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (v == null || v === false) continue; if (k === "text") e.textContent = v; else if (k.startsWith("on")) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v === true ? "" : v); } for (const c of kids) if (c != null) e.append(c); return e; };
  const isAddr = (a) => typeof a === "string" && /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a);
  const nameOf = (a) => (isAddr(a) ? NAMES[a] || a.slice(0, 5) + "…" + a.slice(-4) : "–");
  const fmt = (n, d = 0) => Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
  const pts = (h) => fmt(h / 100, h % 100 ? 2 : 0);
  const pct = (p) => (p == null ? "–" : `${fmt(p * 100, p < 0.01 ? 2 : p < 0.1 ? 1 : 0)}%`);
  const xf = (f) => `×${fmt(f, 2)}`;
  const clock = (t) => new Date(t).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const dayTime = (t) => new Date(t).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
  const dur = (ms) => { const m = Math.max(0, Math.ceil(ms / 60000)); return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min` : `${m} min`; };
  const say = (t) => { $("status").textContent = t; };
  async function fetchJson(url) { const r = await fetch(url, { cache: "no-cache" }); if (!r.ok) throw new Error(String(r.status)); return r.json(); }

  let head = null;                  // { height, time } of the chain's head block
  let races = [];                   // race records (this week and last) from race-data
  let card = null;                  // the price card: latest race card taken at or before now
  let filter = "all";               // which games the board shows
  let legs = [];                    // the card being built: [{ code, round, producer }]
  let toast = "", lastAdded = "";
  const allHorses = new Set(), openBlocks = new Set(), openRaceSet = new Set();
  let racesOpened = false;          // the first open race starts unfolded, once
  let board = null;
  const me = () => (W && W.address) || null;
  // Sending (live once the Picks contract with CARD games is published and game 8 is a card game on chain).
  const ROOT = new URL("../", location.href);
  let picksC = null, cardsLive = false, liveMax = 0, usage = null;
  let slots = [null, null, null];   // today's cards on chain, by slot
  let editing = null;               // the slot being changed, or null for a new card
  let stake = null;                 // staked in the Combo Card this week: true, false, or null (can't tell yet)
  let sending = false;
  const maxLegs = () => Math.min(C.HARD_MAX_LEGS, liveMax || C.MAX_LEGS);
  const legId = (l) => `${l.code}:${l.round}:${l.producer}`;

  // ── the draft survives a reload on this device (a convenience only) ──
  function saveDraft() { try { localStorage.setItem(DRAFT_KEY, JSON.stringify(legs)); } catch { /* storage off */ } }
  function loadDraft() {
    try {
      const v = JSON.parse(localStorage.getItem(DRAFT_KEY) || "[]");
      if (Array.isArray(v)) legs = v.filter((l) => l && C.CODES.includes(l.code) && Number.isSafeInteger(l.round) && isAddr(l.producer)).slice(0, C.HARD_MAX_LEGS);
    } catch { legs = []; }
  }

  // ── data ──
  async function readHead() {
    if (!provider) throw new Error("no provider");
    const h = await provider.getHeadInfo();
    head = { height: Number(h.head_topology.height), time: Number(h.head_block_time) };
    return head;
  }
  const about = (h) => X.aboutTime(h, head.height, head.time);
  async function loadRaces() {
    const w = M.weekOf(Date.now()), got = [];
    for (const k of [w - 1, w]) {
      if (k < 0) continue;
      try { const j = await fetchJson(`${RACE_DATA}W${String(k).padStart(3, "0")}.json`); if (j && Array.isArray(j.races)) got.push(...j.races); } catch { /* not there yet */ }
    }
    if (got.length) races = got;
    card = C.priceCard(races, Date.now()) || card;
  }

  // ── what can be added ──
  function openRaces() {
    if (!head) return [];
    const out = [];
    for (let i = M.raceIndex(head.time); M.raceStart(i) <= head.time + C.RACE_AHEAD_MS; i++) if (C.legOpen({ code: C.SHOW, round: i }, head)) out.push(i);
    return out;
  }
  function openTargets() {
    if (!head) return [];
    const out = [];
    for (let r = Math.floor(head.height / X.ROUND); X.target(r) <= head.height + C.BLOCK_AHEAD; r++) if (C.legOpen({ code: C.BLOCK, round: r }, head)) out.push(r);
    return out;
  }
  const isRaceLeg = (l) => C.FAMILY[l.code] === "race";
  /** Why a leg can't go on the card (null if it can). A leg on a taken slot (same type on the same race, or the same
   *  block) replaces the leg there. */
  function addProblem(l) {
    const rest = legs.filter((x) => C.slotKey(x) !== C.slotKey(l));
    if (rest.length >= maxLegs()) return `Your card is full (${maxLegs()} legs).`;
    if (rest.some((x) => x.producer === l.producer)) return "This producer is already on your card.";
    if (head && !C.legOpen(l, head)) return "Locked.";
    return null;
  }
  const legTitle = (l) => `${C.NAMES[l.code]} · ${nameOf(l.producer)}`;
  const legWhen = (l) => (isRaceLeg(l) ? `Race of ${dayTime(M.raceStart(l.round))}` : `Block ${fmt(X.target(l.round))}, about ${dayTime(about(X.target(l.round)))}`);
  function toggleLeg(l) {
    const i = legs.findIndex((x) => legId(x) === legId(l));
    if (i >= 0) { legs.splice(i, 1); toast = ""; lastAdded = ""; }
    else {
      if (addProblem(l)) return;
      const old = legs.find((x) => C.slotKey(x) === C.slotKey(l));
      legs = legs.filter((x) => C.slotKey(x) !== C.slotKey(l));
      legs.push(l);
      lastAdded = legId(l);
      toast = old ? (isRaceLeg(l) ? `Swapped your ${C.NAMES[l.code]} leg on this race: ${nameOf(old.producer)} → ${nameOf(l.producer)}. One ${C.NAMES[l.code]} per race.` : `Swapped your pick for block ${fmt(X.target(l.round))}: ${nameOf(old.producer)} → ${nameOf(l.producer)}.`) : "";
      bump();
    }
    saveDraft(); render();
  }
  function dropLocked() {
    if (!head) return false;
    const gone = legs.filter((l) => !C.legOpen(l, head));
    if (!gone.length) return false;
    legs = legs.filter((l) => C.legOpen(l, head));
    toast = `Removed ${gone.length === 1 ? "a leg that" : `${gone.length} legs that`} locked: ${gone.map(legTitle).join(", ")}.`;
    saveDraft();
    return true;
  }
  /** Quick card: 3 random legs with at least a 1-in-5 chance each, following every rule. */
  function quickCard() {
    if (!card || !head) return;
    const cands = [];
    for (const r of openRaces()) for (const h of card.field) for (const code of [C.WIN, C.SHOW, C.HALF]) cands.push({ code, round: r, producer: h.a });
    const { m } = X.vhpOf(card);
    for (const r of openTargets()) for (const a of m.keys()) cands.push({ code: C.BLOCK, round: r, producer: a });
    const ok = cands.filter((l) => { const p = C.priceLeg(card, l); return p && p.chance != null && p.chance >= 0.2; });
    for (let i = ok.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [ok[i], ok[j]] = [ok[j], ok[i]]; }
    const pick = [], slots = new Set(), prods = new Set();
    for (const l of ok) { if (pick.length === 3) break; if (slots.has(C.slotKey(l)) || prods.has(l.producer)) continue; pick.push(l); slots.add(C.slotKey(l)); prods.add(l.producer); }
    if (pick.length < 2) return;
    legs = pick; lastAdded = ""; toast = "Quick card: 3 random legs. Swap any you don't like.";
    saveDraft(); bump(); render();
  }

  // ── the board ──
  function renderGames() {
    const b = (id, label, count) => el("button", { type: "button", "aria-pressed": String(filter === id), "data-k": `g:${id}`, onclick: () => { filter = id; render(); } }, label, count != null ? el("small", { text: String(count) }) : null);
    $("games").replaceChildren(
      b("all", "All"), b("race", "🏇 Races", openRaces().length), b("block", "🎯 Block X", openTargets().length),
      ...SOON.map(([i, n]) => el("button", { type: "button", disabled: true, title: `${n} legs arrive when ${n} launches` }, `${i} ${n}`, el("small", { text: "soon" }))));
  }
  function priceBtn(l, label) {
    const p = card ? C.priceLeg(card, l) : null;
    const on = legs.some((x) => legId(x) === legId(l));
    const why = on ? null : addProblem(l);
    const swap = !on && !why && legs.some((x) => C.slotKey(x) === C.slotKey(l));
    const b = el("button", { type: "button", class: "price", "data-k": legId(l), "aria-pressed": String(on),
      "aria-label": `${label || C.NAMES[l.code]} ${nameOf(l.producer)}: ${p ? xf(p.factor) : "can't be priced"}${p && p.chance != null ? `, ${pct(p.chance)} chance` : ""}${why ? `. ${why}` : swap ? ". Replaces your pick here" : ""}`,
      title: why || (swap ? "Replaces your pick here" : null), onclick: () => toggleLeg(l) },
      el("b", { text: on ? `✓ ${p ? xf(p.factor) : "–"}` : p ? xf(p.factor) : "–" }), el("small", { text: p && p.chance != null ? pct(p.chance) : "" }));
    if (!on && (why || !p)) b.disabled = true;
    return b;
  }
  function raceCard(r) {
    const start = M.raceStart(r), lockAt = start - C.RACE_LEAD_MS, mine = legs.filter((l) => isRaceLeg(l) && l.round === r);
    const { m } = X.vhpOf(card), total = [...m.values()].reduce((s, v) => s + v, 0);
    const field = card.field;
    const usedIdx = Math.max(-1, ...mine.map((l) => field.findIndex((h) => h.a === l.producer)));
    const all = allHorses.has(r) || usedIdx >= SHOW_HORSES;
    const shown = all ? field : field.slice(0, SHOW_HORSES);
    const d = el("details", { class: `ev rc${mine.length ? " has" : ""}`, "data-k": `race:${r}` },
      el("summary", { class: "ev-h" },
        el("div", {}, el("b", { text: `Race · ${dayTime(start)}` }), el("div", { class: "when", text: `6 hours, to ${clock(start + M.RACE)}` })),
        mine.length ? el("div", { class: "picks" }, ...mine.map((l) => el("span", { class: "picked", text: `${C.NAMES[l.code]}: ${nameOf(l.producer)}` }))) : null,
        el("span", { class: `lock${lockAt - Date.now() < 30 * 60000 ? " soon-lock" : ""}`, text: `locks in ${dur(lockAt - Date.now())}` })),
      el("table", { class: "px" },
        el("thead", {}, el("tr", {}, el("th", { text: "Horse" }), el("th", { text: "Win" }), el("th", { text: "Show" }), el("th", { text: "Top half" }))),
        el("tbody", {}, ...shown.map((h) => el("tr", {},
          el("td", {}, el("div", { class: "who" }, el("a", { href: EXPLORER + h.a, target: "_blank", rel: "noopener noreferrer", text: nameOf(h.a) }), el("small", { class: "hide-sm", text: `${pct(total ? h.vhp / total : 0)} of VHP` }))),
          ...[C.WIN, C.SHOW, C.HALF].map((code) => el("td", { class: "p" }, priceBtn({ code, round: r, producer: h.a }))))))),
      field.length > SHOW_HORSES ? el("button", { type: "button", class: "more", "data-k": `more:${r}`, "aria-expanded": String(all),
        onclick: () => { if (allHorses.has(r)) allHorses.delete(r); else allHorses.add(r); render(); } }, all ? "Show fewer horses" : `Show all ${field.length} horses`) : null);
    if (openRaceSet.has(r)) d.open = true;
    d.addEventListener("toggle", () => { if (d.open) openRaceSet.add(r); else openRaceSet.delete(r); });
    return d;
  }
  function blockCard(list) {
    const { m } = X.vhpOf(card), total = [...m.values()].reduce((s, v) => s + v, 0);
    const rows = [...m.entries()].sort((a, b) => b[1] - a[1]);
    return el("article", { class: "ev", "aria-label": "Block X targets" }, ...list.map((r) => {
      const t = X.target(r), lockAt = about(t - C.BLOCK_LEAD), mine = legs.find((l) => l.code === C.BLOCK && l.round === r);
      const p = mine && C.priceLeg(card, mine);
      const d = el("details", { class: `bx${mine ? " has" : ""}`, "data-k": `bx:${r}` },
        el("summary", {}, el("b", { text: `Block ${fmt(t)}` }),
          el("span", { class: "act", text: mine ? `✓ ${nameOf(mine.producer)} ${p ? xf(p.factor) : ""}` : "Pick a producer" }),
          el("span", { class: "when", text: `about ${dayTime(about(t))}, locks in ${dur(lockAt - Date.now())}` })),
        el("div", { class: "grid" }, ...rows.map(([a]) => { const b = priceBtn({ code: C.BLOCK, round: r, producer: a }, "Signs block");
          b.replaceChildren(el("span", { text: nameOf(a) }), el("em", {}, b.querySelector("b"), el("small", { text: pct(total ? m.get(a) / total : 0) }))); return b; })));
      if (openBlocks.has(r)) d.open = true;
      d.addEventListener("toggle", () => { if (d.open) openBlocks.add(r); else openBlocks.delete(r); });
      return d;
    }));
  }
  function renderBoard() {
    const out = [];
    if (!card) out.push(el("p", { class: "note", text: "Waiting for the Producer Race's handicap card…" }));
    else {
      if (filter !== "block") {
        const rs = openRaces();
        if (!racesOpened && rs.length) { openRaceSet.add(rs[0]); racesOpened = true; }
        out.push(el("div", { class: "group-h" }, el("h2", { text: "Races" }), el("span", { text: "Up to 3 legs a race: a Win, a Show and a Top half" })));
        out.push(...(rs.length ? rs.map(raceCard) : [el("p", { class: "note", text: head ? "No race is open right now." : "Reading the chain…" })]));
      }
      if (filter !== "race") {
        const ts = openTargets();
        out.push(el("div", { class: "group-h" }, el("h2", { text: "Block X" }), el("span", { text: "Who signs each 2,400th block" })));
        out.push(ts.length ? blockCard(ts) : el("p", { class: "note", text: head ? "No block is open right now." : "Reading the chain…" }));
      }
    }
    $("board").replaceChildren(...out);
    const stale = card && Date.now() - card.at > CARD_STALE_MS;
    $("price-note").textContent = card ? `Worth and chances from the Producer Race card of ${clock(card.at)}.${stale ? " A new card is due, so they may shift a little." : ""}` : "";
  }

  // ── the slip ──
  const lockTimeOf = (l) => (isRaceLeg(l) ? M.raceStart(l.round) - C.RACE_LEAD_MS : head ? about(X.target(l.round) - C.BLOCK_LEAD) : Infinity);
  function cardStats() {
    const sorted = [...legs].sort((a, b) => lockTimeOf(a) - lockTimeOf(b));
    const pot = card ? C.potential(card, sorted) : { pts: 0, prices: sorted.map(() => null), unpriced: true };
    const chances = pot.prices.map((p) => (p ? p.chance : null));
    const chance = chances.length && chances.every((c) => c != null) ? chances.reduce((s, c) => s * c, 1) : null;
    return { sorted, pot, chance };
  }
  let shownPts = 0, anim = 0;
  function countTo(target) {
    cancelAnimationFrame(anim);
    const from = shownPts, t0 = performance.now(), D = 450;
    if (reduced() || from === target) { shownPts = target; $("pays").textContent = pts(target); return; }
    const step = (t) => { const k = Math.min(1, (t - t0) / D), e = 1 - Math.pow(1 - k, 3); shownPts = Math.round(from + (target - from) * e); $("pays").textContent = pts(shownPts); if (k < 1) anim = requestAnimationFrame(step); };
    anim = requestAnimationFrame(step);
  }
  function bump() { const s = $("slip"); s.classList.remove("bump"); void s.offsetWidth; s.classList.add("bump"); }
  function renderSlip() {
    const { sorted, pot, chance } = cardStats(), n = legs.length;
    $("t-count").textContent = `${n} of ${maxLegs()} legs`;
    $("legs").replaceChildren(...sorted.map((l, i) => el("li", { class: legId(l) === lastAdded ? "fresh" : null },
      el("span", { class: "what" }, el("b", { text: legTitle(l) }), el("small", { text: legWhen(l) })),
      el("span", { class: "x", text: pot.prices[i] ? xf(pot.prices[i].factor) : "–" }),
      el("button", { type: "button", "aria-label": `Remove ${legTitle(l)}`, "data-k": `rm:${legId(l)}`, onclick: () => toggleLeg(l) }, "×"))));
    if (!n) $("legs").replaceChildren(el("li", { class: "empty", text: "Tap a price on the left to add a leg." }));
    lastAdded = "";
    const ready = n >= C.MIN_LEGS && !pot.unpriced;
    $("chain").textContent = n >= C.MIN_LEGS ? `${C.BASE[n]} base × ${pot.prices.map((p) => (p ? fmt(p.factor, 2) : "–")).join(" × ")}` : n === 1 ? "One more leg and your card can pay." : "";
    if (ready) countTo(pot.pts); else { cancelAnimationFrame(anim); shownPts = 0; $("pays").textContent = "–"; }
    $("pays").classList.toggle("long", ready && pts(pot.pts).length > 6);
    $("pays-unit").textContent = ready ? "pts if every leg hits" : "pts";
    $("chance").textContent = !ready || chance == null ? "–" : `about ${chance >= 0.0001 ? pct(chance) : "<0.01%"}`;
    const lock = n && head ? C.cardLockTime(legs, head) : null;
    $("locks").textContent = lock ? `${clock(lock)}, in ${dur(lock - Date.now())}` : "–";
    const rungs = [];
    for (let k = C.MIN_LEGS; k <= maxLegs(); k++) rungs.push(el("div", { class: k === n ? "on" : k === n + 1 ? "next" : null }, el("b", { text: String(C.BASE[k]) }), `${k} legs`));
    $("ladder").replaceChildren(...rungs);
    $("ladder-note").textContent = n >= maxLegs() ? "Your card is full." : n >= C.MIN_LEGS ? `Base points by legs. One more leg takes the base from ${C.BASE[n]} to ${C.BASE[n + 1]}.` : "Base points by legs: each leg roughly doubles it.";
    $("toast").textContent = toast;
    const problem = n >= C.MIN_LEGS && head ? C.cardProblem(legs, head, maxLegs()) : null;
    $("problem").textContent = problem || (pot.unpriced && n ? "A leg can't be priced on the current card; remove it." : "");
    renderSend(ready && !problem && !pot.unpriced);
    $("bar-n").textContent = String(n);
    $("bar-v").replaceChildren(ready ? `${pts(pot.pts)}` : "–", el("small", { text: ready ? "pts" : n ? "add a leg" : "tap a price" }));
  }
  $("slip-bar").onclick = () => { const s = $("slip"), open = !s.classList.contains("open"); s.classList.toggle("open", open); $("slip-bar").setAttribute("aria-expanded", String(open)); };

  // ── sending a card ──
  async function fetchJsonAt(u) { const r = await fetch(u, { cache: "no-cache" }); if (!r.ok) throw new Error(String(r.status)); return r.json(); }
  /** Live only when picks-data/deployment.json names the Picks contract and game 8 on it is an enabled card game. */
  async function setupCards() {
    let pdep = null, dep = null;
    try { pdep = await fetchJsonAt(new URL("picks-data/deployment.json", ROOT)); } catch { return; }
    if (!pdep || !isAddr(pdep.contract) || !provider) return;
    try { dep = await fetchJsonAt(new URL("game-data/deployment.json", ROOT)); } catch { /* the wallet keeps its defaults */ }
    try {
      const abi = await fetchJsonAt(new URL("picks/abi/picks.koilib.json", ROOT));
      if (!abi.methods || !abi.methods.pick || !JSON.stringify(abi).includes("leg_types")) return;   // a Picks contract without cards
      picksC = new lib.Contract({ id: pdep.contract, abi, provider });
      const g = (await picksC.functions.get_game({ game: C.GAME_ID })).result;
      const game = g && g.game;
      if (!game || Number(game.kind) !== 4 || !game.enabled) return;
      liveMax = Number(game.max_legs) || C.MAX_LEGS;
      cardsLive = true;
    } catch { return; }
    if (W) W.init({ provider, chainId: dep && dep.chainId, payer: dep && dep.payer, sponsor: dep && dep.sponsor, game: dep && dep.contract, onChange: () => loadMine() });
    $("cards-soon").hidden = true;
    await loadMine();
  }
  /** Today's 3 cards, today's usage, and the stake in the Combo Card (from the Vault, once it can tell). */
  async function loadMine() {
    slots = [null, null, null]; usage = null; stake = null;
    const who = me();
    if (cardsLive && who && head) {
      const day = C.utcDay(head.time);
      try {
        const got = await Promise.all([0, 1, 2].map((k) => picksC.functions.get_pick({ game: C.GAME_ID, round: String(C.slotRound(day, k)), player: who }).then((x) => (x.result && x.result.pick) || null)));
        slots = got.map((p) => (p && Array.isArray(p.legs) && p.legs.length ? p : null));
        usage = (await picksC.functions.get_usage({ game: C.GAME_ID, player: who })).result || null;
      } catch { /* shown as unknown */ }
      stake = await readStake(who);
    }
    if (editing !== null && !slots[editing]) editing = null;
    renderSlip();
  }
  async function readStake(who) {
    try {
      const dep = await fetchJsonAt(new URL("game-data/deployment.json", ROOT));
      const abi = await fetchJsonAt(new URL("game/abi/kpred.koilib.json", ROOT));
      if (!isAddr(dep.contract) || !abi.methods || !abi.methods.get_game_player) return null;   // the Vault isn't v6 yet
      const v = new lib.Contract({ id: dep.contract, abi, provider });
      const r = (await v.functions.get_game_player({ player: who, game: C.GAME_ID, week: String(M.weekOf(head.time)) })).result || {};
      return BigInt(r.week_stake || "0") >= 100000000n || BigInt(r.active_stake || "0") >= 100000000n;
    } catch { return null; }
  }
  /** Which slot a send goes to: the card being changed, else today's first free slot (null if all 3 are used). */
  const targetSlot = () => (editing !== null ? editing : slots.findIndex((p) => !p) >= 0 ? slots.findIndex((p) => !p) : null);
  function renderSlots() {
    const box = $("slots");
    box.hidden = !cardsLive || !me();
    if (box.hidden) return;
    box.replaceChildren(...slots.map((p, k) => el("button", { type: "button", class: `slot${editing === k ? " on" : ""}`, "data-k": `slot:${k}`, disabled: !p ? true : null,
      "aria-pressed": String(editing === k), onclick: () => editCard(k) },
      el("b", { text: `Card ${k + 1}` }), el("span", { text: p ? `${p.legs.length} legs · ${editing === k ? "editing" : "edit"}` : "free" }))));
  }
  function editCard(k) {
    const p = slots[k];
    if (!p) return;
    if (editing === k) { editing = null; toast = "Back to a new card."; render(); return; }
    editing = k;
    legs = p.legs.map((l) => ({ code: Number(l.code), round: Number(l.round), producer: String(l.producer) }));
    toast = `Editing card ${k + 1}. Change its legs, then send to replace it (up to ${3 - Number(p.changes || 0)} more change${3 - Number(p.changes || 0) === 1 ? "" : "s"}).`;
    saveDraft(); render();
  }
  function renderSend(okCard) {
    const b = $("send"), who = me(), slot = targetSlot();
    renderSlots();
    let why = null;
    if (!cardsLive) why = "Cards open when the Combo upgrade of the Picks contract is live.";
    else if (!who) why = "Connect a wallet to send a card.";
    else if (W && W.kind === "guest") why = "The Combo Card is a staked game: connect Kondor or KOIN Vault.";
    else if (stake === false) why = "Stake at least 1 VHP in the Combo Card to play.";
    else if (slot === null) why = "You've used today's 3 cards. Pick one above to change it.";
    else if (usage && Number(usage.picks_today) >= Number(usage.max_picks_per_day)) why = "Today's cards and changes are used up. More after 00:00 UTC.";
    else if (!okCard) why = null;
    b.textContent = !cardsLive ? "Send card (soon)" : sending ? "Sending…" : editing !== null ? `Send changes to card ${editing + 1}` : slot !== null ? `Send card ${slot + 1} of 3` : "Send card";
    b.disabled = !cardsLive || sending || !!why || !okCard;
    b.title = why || "";
    if (cardsLive && why && legs.length >= C.MIN_LEGS && !toast) $("problem").textContent = why;
  }
  const CONTRACT_SAYS = [
    [/leg of this card is locked|round is locked/i, "A leg locked before your card landed. Remove it and send again."],
    [/not open yet/i, "A leg isn't open yet: legs open at most a day ahead."],
    [/only once/i, "A producer can be on your card only once."],
    [/one leg per leg type/i, "One Win, one Show and one Top half per race, and one leg per block."],
    [/own UTC day/i, "A card can only be sent or changed on its own UTC day."],
    [/2 to max_legs/i, "That card has too many or too few legs."],
    [/used up/i, "Today's cards and changes are used up. More after 00:00 UTC."],
    [/can't be changed again/i, "That card has been changed 3 times already."],
    [/already your pick/i, "That's already your card."],
    [/switched-off leg type|unknown/i, "One of these leg types is switched off for now."],
    [/reject|denied|cancel/i, "Cancelled in your wallet. Nothing was sent."],
  ];
  async function sendCard() {
    const who = me(), slot = targetSlot();
    if (!cardsLive || !who || sending || slot === null || legs.length < C.MIN_LEGS) return;
    try { await readHead(); } catch { /* the last head */ }
    const problem = C.cardProblem(legs, head, maxLegs());
    if (problem) { toast = problem; render(); return; }
    // Legs whose lock is under 2 minutes away may land after it: ask for a fresh card instead of a failed send.
    if (C.cardLockTime(legs, head) - Date.now() < 120000) { toast = "Your card locks in under 2 minutes; remove the leg that's about to lock."; render(); return; }
    const round = C.slotRound(C.utcDay(head.time), slot), { sorted, pot } = cardStats();
    sending = true; toast = W.kind === "guest" ? "Sending your card…" : `Confirm in ${W.label ? W.label() : "your wallet"}…`; render();
    try {
      const { operation } = await picksC.functions.pick({ player: who, game: C.GAME_ID, round: String(round), producers: [], number: "0",
        legs: sorted.map((l) => ({ code: l.code, round: String(l.round), producer: l.producer })) }, { onlyOperation: true });
      await W.send(`Combo card ${slot + 1}: ${sorted.length} legs, ${pts(pot.pts)} pts if every leg hits`, [operation]);
      toast = "Sent. Checking the chain…"; render();
      let seen = false;
      for (let t = 0; t < 10 && !seen; t++) {
        try { const x = (await picksC.functions.get_pick({ game: C.GAME_ID, round: String(round), player: who })).result; seen = !!(x && x.pick && Array.isArray(x.pick.legs) && x.pick.legs.length === sorted.length && sorted.every((l, i) => Number(x.pick.legs[i].code) === l.code && Number(x.pick.legs[i].round) === l.round && x.pick.legs[i].producer === l.producer)); } catch { /* again */ }
        if (!seen) await new Promise((res) => setTimeout(res, 3000));
      }
      toast = seen ? `Card ${slot + 1} is locked in on the chain. It locks for good at ${clock(C.cardLockTime(legs, head))}; until then you can change it.` : "Sent. It isn't showing on the chain yet; this updates by itself.";
      if (seen) { editing = null; legs = []; saveDraft(); }
    } catch (e) {
      const m = String((e && e.message) || e);
      const hit = CONTRACT_SAYS.find(([re]) => re.test(m));
      toast = hit ? hit[1] : `Not sent: ${m.slice(0, 200)}`;
    } finally { sending = false; await loadMine(); render(); }
  }
  $("send").onclick = sendCard;

  // ── render all, keeping keyboard focus on the same control ──
  let shareKey = "";
  function render() {
    const k = document.activeElement && document.activeElement.getAttribute && document.activeElement.getAttribute("data-k");
    renderGames(); renderBoard(); renderSlip();
    if (k) { const n = document.querySelector(`[data-k="${CSS.escape(k)}"]`); if (n) n.focus({ preventScroll: true }); }
    const sk = JSON.stringify([legs, card && card.at]);
    if (sk !== shareKey) { shareKey = sk; renderShare(); }
  }

  // ── share: an image drawn on the page and a line of text ──
  function shareText() {
    const { sorted, pot } = cardStats();
    const lines = sorted.map((l, i) => `${i + 1}. ${legTitle(l)} (${legWhen(l)})${pot.prices[i] ? ` ${xf(pot.prices[i].factor)}` : ""}`);
    return `My Knode Games Combo Card: ${sorted.length} legs, pays ${pts(pot.pts)} pts if every leg hits.\n${lines.join("\n")}\n${PAGE}`;
  }
  function utcOff() { const m = -new Date().getTimezoneOffset(); if (!m) return ""; const s = m > 0 ? "+" : "−", a = Math.abs(m); return `${s}${Math.floor(a / 60)}${a % 60 ? ":" + String(a % 60).padStart(2, "0") : ""}`; }
  function drawImage() {
    const { sorted, pot, chance } = cardStats();
    const cv = document.createElement("canvas"); cv.width = 1200; cv.height = 630;
    const g = cv.getContext("2d");
    if (!g) return null;
    const navy = "#14213D", navy2 = "#1E2E52", ink = "#FFF8F1", muted = "#C9D2E3", sun = "#F2B33D", tang = "#FF8A4C";
    const disp = "'Bricolage Grotesque', system-ui, sans-serif", body = "'Atkinson Hyperlegible', system-ui, sans-serif", num = "'Archivo', system-ui, sans-serif";
    g.fillStyle = "#F3F1EA"; g.fillRect(0, 0, 1200, 630);
    const rr = (x, y, w, h, r) => { g.beginPath(); if (g.roundRect) g.roundRect(x, y, w, h, r); else g.rect(x, y, w, h); };
    g.fillStyle = navy; rr(30, 30, 1140, 570, 28); g.fill();
    // the stub: payout on the right, past a perforation
    const sx = 800;
    g.strokeStyle = "rgba(255,255,255,.25)"; g.setLineDash([10, 10]); g.lineWidth = 3; g.beginPath(); g.moveTo(sx, 60); g.lineTo(sx, 570); g.stroke(); g.setLineDash([]);
    g.fillStyle = "#F3F1EA"; g.beginPath(); g.arc(sx, 30, 22, 0, Math.PI * 2); g.arc(sx, 600, 22, 0, Math.PI * 2); g.fill();
    g.fillStyle = sun; g.font = `800 30px ${disp}`; g.fillText("Combo Card", 70, 92);
    g.fillStyle = muted; g.font = `400 22px ${body}`; g.fillText(`Knode Games · ${sorted.length} legs`, 70, 126);
    const rowH = Math.min(64, Math.floor(400 / Math.max(1, sorted.length)));
    sorted.forEach((l, i) => {
      const y = 152 + i * rowH, h = rowH - 10, mid = y + h / 2 + 8;
      g.fillStyle = navy2; rr(70, y, 690, h, 12); g.fill();
      g.fillStyle = ink; g.font = `700 ${Math.min(24, h * .5)}px ${body}`; g.fillText(`${C.NAMES[l.code]} · ${nameOf(l.producer)}`, 90, mid - (h > 40 ? 8 : 0));
      if (h > 40) { g.fillStyle = muted; g.font = `400 17px ${body}`; g.fillText(isRaceLeg(l) ? `race ${dayTime(M.raceStart(l.round))} UTC${utcOff()}` : `block ${fmt(X.target(l.round))}`, 90, mid + 16); }
      g.fillStyle = sun; g.font = `800 ${Math.min(28, h * .55)}px ${num}`; g.textAlign = "right"; g.fillText(pot.prices[i] ? xf(pot.prices[i].factor) : "–", 740, mid); g.textAlign = "left";
    });
    g.textAlign = "center";
    g.fillStyle = muted; g.font = `400 24px ${body}`; g.fillText("pays", 985, 210);
    g.fillStyle = sun; g.font = `900 ${pts(pot.pts).length > 5 ? 84 : 104}px ${num}`; g.fillText(pts(pot.pts), 985, 310);
    g.fillStyle = ink; g.font = `700 28px ${body}`; g.fillText("points", 985, 352);
    if (chance != null) { g.fillStyle = muted; g.font = `400 22px ${body}`; g.fillText(`about ${chance >= 0.0001 ? pct(chance) : "<0.01%"} chance`, 985, 400); }
    g.fillStyle = tang; rr(895, 470, 180, 52, 26); g.fill();
    g.fillStyle = navy; g.font = `800 22px ${body}`; g.fillText("every leg hits", 985, 504);
    g.textAlign = "left";
    g.fillStyle = muted; g.font = `400 18px ${body}`; g.fillText("Points only · bawcejawn.github.io/Knode", 70, 572);
    return cv;
  }
  let shareBlob = null;
  function renderShare() {
    const ok = legs.length >= C.MIN_LEGS && !!card;
    $("share-empty").hidden = ok; $("share-img").hidden = !ok; $("share-dl").hidden = !ok; $("share-copy").disabled = !ok; $("share-msg").textContent = "";
    $("share-native").hidden = true; shareBlob = null;
    if (!ok) return;
    const cv = drawImage();
    if (!cv) return;
    const url = cv.toDataURL("image/png");
    $("share-img").src = url; $("share-dl").href = url;
    if (cv.toBlob && navigator.share && navigator.canShare) cv.toBlob((b) => {
      if (!b) return;
      try { const f = new File([b], "combo-card.png", { type: "image/png" }); if (navigator.canShare({ files: [f] })) { shareBlob = f; $("share-native").hidden = false; } } catch { /* no file sharing here */ }
    }, "image/png");
  }
  $("share-native").onclick = async () => { if (!shareBlob) return; try { await navigator.share({ files: [shareBlob], text: shareText(), title: "My Combo Card" }); } catch { /* cancelled */ } };
  $("share-copy").onclick = async () => {
    try { await navigator.clipboard.writeText(shareText()); $("share-msg").textContent = "Copied."; }
    catch { $("share-msg").textContent = "Couldn't copy here. Download the image instead."; }
  };

  $("clear").onclick = () => { legs = []; toast = ""; saveDraft(); render(); };
  $("quick").onclick = quickCard;

  // ── how it works: the base table from the math ──
  (() => {
    const ns = []; for (let k = C.MIN_LEGS; k <= C.MAX_LEGS; k++) ns.push(k);   // drawn at load: the launch maximum
    $("base-table").replaceChildren(
      el("tr", {}, el("th", { text: "Legs" }), ...ns.map((k) => el("td", { text: String(k) }))),
      el("tr", {}, el("th", { text: "Base" }), ...ns.map((k) => el("td", { text: String(C.BASE[k]) }))));
  })();

  // ── leaderboard (games-data/combo/board.json once the recorder runs) ──
  const lb = window.KBoard ? window.KBoard.create($("combo-board"), {
    label: "Combo Card leaderboard",
    columns: [{ key: "pts", label: "Points" }, { key: "hits", label: "Cards hit" }, { key: "cards", label: "Cards", wide: true }, { key: "best", label: "Best card", wide: true }],
    scored: (r) => r.pts > 0,
    summary: (r) => `${pts(r.pts)} pts · ${fmt(r.hits)} of ${fmt(r.cards)} cards hit`,
    name: nameOf, link: (a) => EXPLORER + a,
    me: (r, place) => `${place ? `You: #${place} with` : "Your score:"} ${pts(r.pts)} points from your best ${Math.min(C.BEST, r.cards)} cards (${fmt(r.hits)} of ${fmt(r.cards)} hit).`,
    unranked: "To be ranked, stake at least 1 VHP in the Combo Card.",
  }) : null;
  async function loadBoard() {
    try { const b = await fetchJson(DATA + "board.json"); if (b && b.v === 1 && lb) { board = b; $("board-box").hidden = false; lb.setMe(me() || ""); lb.set(board); } } catch { /* not running yet */ }
  }
  if (W && W.subscribe) W.subscribe(() => { if (lb && board) { lb.setMe(me() || ""); lb.set(board); } loadMine(); });

  // ── start ──
  (async () => {
    loadDraft();
    try { await readHead(); say(""); } catch { say("Couldn't reach the Koinos network. Trying again in a moment…"); }
    await setupCards().catch(() => {});
    await loadRaces();
    dropLocked(); render();
    loadBoard();
    setInterval(() => {
      if (document.hidden) return;
      readHead().then(() => { say(""); dropLocked(); if (!document.querySelector("#board :focus")) render(); else renderSlip(); })
        .catch(() => say("Reconnecting to the Koinos network…"));
    }, 20000);
    setInterval(() => { if (!document.hidden) loadRaces().then(render); }, 300000);
    setInterval(() => { if (!document.hidden) loadBoard(); }, 600000);
    setInterval(() => { if (!document.hidden && cardsLive) loadMine(); }, 60000);
  })();
})();

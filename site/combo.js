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
  const RPC = "https://api.koinos.io";
  const RACE_DATA = "https://raw.githubusercontent.com/bawcejawn/Knode/race-data/";
  const DATA = "https://raw.githubusercontent.com/bawcejawn/Knode/games-data/combo/";
  const EXPLORER = "https://koinosscan.com/address/";
  const PAGE = "https://bawcejawn.github.io/Knode/site/combo.html";
  const NAMES = { "1Mpmf2ERhjYpX7CCiM11WERuM4j17uT1sr": "Knode pool", "1FKTpXBhhHEbu5vVchM8UsVbAvPArJsRmR": "Knode Swap" };
  const DRAFT_KEY = "kg.combo.draft.v1";
  const CARD_STALE_MS = 65 * 60000;     // race cards come every hour; older than this, a new one is due
  const provider = lib.Provider ? new lib.Provider([RPC]) : null;
  const W = window.KWallet;

  const $ = (id) => document.getElementById(id);
  const el = (tag, attrs = {}, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (v == null) continue; if (k === "text") e.textContent = v; else if (k.startsWith("on")) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v); } for (const c of kids) if (c != null) e.append(c); return e; };
  const isAddr = (a) => typeof a === "string" && /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a);
  const nameOf = (a) => (isAddr(a) ? NAMES[a] || a.slice(0, 5) + "…" + a.slice(-4) : "–");
  const fmt = (n, d = 0) => Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
  const pts = (h) => fmt(h / 100, h % 100 ? 2 : 0);
  const pct = (p) => (p == null ? "–" : `${fmt(p * 100, p < 0.01 ? 2 : 1)}%`);
  const xf = (f) => `×${fmt(f, 2)}`;
  const clock = (t) => new Date(t).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const dayTime = (t) => new Date(t).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
  const dur = (ms) => { const m = Math.max(0, Math.ceil(ms / 60000)); return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min` : `${m} min`; };
  const say = (t) => { $("status").textContent = t; $("status").hidden = !t; };
  async function fetchJson(url) { const r = await fetch(url, { cache: "no-cache" }); if (!r.ok) throw new Error(String(r.status)); return r.json(); }

  let head = null;                  // { height, time } of the chain's head block
  let races = [];                   // race records (this week and last) from race-data
  let card = null;                  // the price card: latest race card taken at or before now
  let tab = "race", event = null;   // which list is shown and which race / block is chosen
  let legs = [];                    // the card being built: [{ code, round, producer }]
  let note = "";                    // a one-off message under the card (a leg that locked, ...)
  let board = null;
  const me = () => (W && W.address) || null;

  // ── the draft survives a reload on this device (a convenience only) ──
  function saveDraft() { try { localStorage.setItem(DRAFT_KEY, JSON.stringify(legs)); } catch { /* storage off */ } }
  function loadDraft() {
    try {
      const v = JSON.parse(localStorage.getItem(DRAFT_KEY) || "[]");
      if (Array.isArray(v)) legs = v.filter((l) => l && C.CODES.includes(l.code) && Number.isSafeInteger(l.round) && isAddr(l.producer)).slice(0, C.MAX_LEGS);
    } catch { legs = []; }
  }

  // ── data ──
  async function readHead() {
    if (!provider) throw new Error("no provider");
    const h = await provider.getHeadInfo();
    head = { height: Number(h.head_topology.height), time: Number(h.head_block_time) };
    return head;
  }
  /** About when block h is made. */
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

  // ── what can be added now ──
  /** Races open for a card now (lock 25 min before the start, at most 24 h ahead), soonest first. */
  function openRaces() {
    if (!head) return [];
    const out = [];
    for (let i = M.raceIndex(head.time); M.raceStart(i) <= head.time + C.RACE_AHEAD_MS; i++) if (C.legOpen({ code: C.SHOW, round: i }, head)) out.push(i);
    return out;
  }
  /** Block X targets open for a card now (lock 500 blocks before, at most 28,800 ahead), soonest first. */
  function openBlocks() {
    if (!head) return [];
    const out = [];
    for (let r = Math.floor(head.height / X.ROUND); X.target(r) <= head.height + C.BLOCK_AHEAD; r++) if (C.legOpen({ code: C.BLOCK, round: r }, head)) out.push(r);
    return out;
  }
  const legKey = (l) => `${C.FAMILY[l.code]}:${l.round}`;
  const eventOf = (l) => (C.FAMILY[l.code] === "race" ? "race" : "block");
  /** Why a leg can't be added to the card (null if it can). A leg on an event already on the card replaces it. */
  function addProblem(l) {
    const rest = legs.filter((x) => legKey(x) !== legKey(l));
    if (rest.length >= C.MAX_LEGS) return "The card is full (6 legs).";
    if (C.isWindow(l.code) && rest.some((x) => C.isWindow(x.code) && x.producer === l.producer)) return "This producer is already in a race leg on your card.";
    if (!C.legOpen(l, head)) return "Locked.";
    return null;
  }
  function toggleLeg(l) {
    const i = legs.findIndex((x) => x.code === l.code && x.round === l.round && x.producer === l.producer);
    if (i >= 0) legs.splice(i, 1);
    else {
      if (addProblem(l)) return;
      legs = legs.filter((x) => legKey(x) !== legKey(l));
      legs.push(l);
    }
    note = "";
    saveDraft(); render();
  }
  /** Drop legs that locked since they were added. */
  function dropLocked() {
    if (!head) return;
    const gone = legs.filter((l) => !C.legOpen(l, head));
    if (!gone.length) return;
    legs = legs.filter((l) => C.legOpen(l, head));
    note = `Removed ${gone.length === 1 ? "a leg" : `${gone.length} legs`} that locked: ${gone.map(legTitle).join(", ")}.`;
    saveDraft();
  }
  const legTitle = (l) => `${C.NAMES[l.code]} ${nameOf(l.producer)}`;
  const legWhen = (l) => (eventOf(l) === "race" ? `Race of ${dayTime(M.raceStart(l.round))}` : `Block ${fmt(X.target(l.round))} · about ${dayTime(about(X.target(l.round)))}`);

  // ── render: the event chips and the odds table ──
  function renderEvents() {
    const list = tab === "race" ? openRaces() : openBlocks();
    if (!list.includes(event)) event = list[0] ?? null;
    const used = new Set(legs.filter((l) => eventOf(l) === tab).map((l) => l.round));
    $("events").replaceChildren(...list.map((r) => {
      const lockAt = tab === "race" ? M.raceStart(r) - C.RACE_LEAD_MS : about(X.target(r) - C.BLOCK_LEAD);
      const label = tab === "race" ? dayTime(M.raceStart(r)) : `Block ${fmt(X.target(r))}`;
      const b = el("button", { type: "button", class: `chip${used.has(r) ? " used" : ""}`, "aria-pressed": String(r === event), onclick: () => { event = r; render(); } },
        el("span", { text: (used.has(r) ? "✓ " : "") + label }), el("small", { text: tab === "race" ? `locks in ${dur(lockAt - Date.now())}` : `about ${clock(about(X.target(r)))} · locks in ${dur(lockAt - Date.now())}` }));
      return b;
    }));
    if (!list.length) $("events").replaceChildren(el("span", { class: "note", text: head ? "Nothing open right now." : "Reading the chain…" }));
  }
  function legButton(l, price) {
    const on = legs.some((x) => x.code === l.code && x.round === l.round && x.producer === l.producer);
    const why = on ? null : addProblem(l);
    const label = `${C.NAMES[l.code]}: ${nameOf(l.producer)}, ${price ? xf(price.factor) : "can't be priced"}${why ? ` (${why})` : ""}`;
    const b = el("button", { type: "button", class: "leg-btn", "aria-pressed": String(on), "aria-label": label, title: why || "", onclick: () => toggleLeg(l) },
      price ? xf(price.factor) : "–", el("small", { text: price && price.chance != null ? pct(price.chance) : "" }));
    if (!on && (why || !price)) b.disabled = true;
    return b;
  }
  function renderOdds() {
    const body = $("odds-rows");
    if (!card) { $("odds-head").replaceChildren(); body.replaceChildren(el("tr", {}, el("td", { class: "note", text: "Waiting for the Producer Race's handicap card…" }))); return; }
    if (event == null) { $("odds-head").replaceChildren(); body.replaceChildren(); $("event-line").textContent = ""; return; }
    const { m } = X.vhpOf(card), total = [...m.values()].reduce((s, v) => s + v, 0);
    if (tab === "race") {
      const start = M.raceStart(event);
      $("event-line").textContent = `Race of ${dayTime(start)} to ${clock(start + M.RACE)} (6 hours). Locks at ${clock(start - C.RACE_LEAD_MS)}.`;
      $("odds-head").replaceChildren(el("tr", {}, el("th", { text: "Horse" }), el("th", { class: "num hide-sm", text: "VHP share" }),
        el("th", { class: "num", text: "Win" }), el("th", { class: "num", text: "Show" }), el("th", { class: "num", text: "Top half" })));
      body.replaceChildren(...card.field.map((r) => el("tr", {},
        el("td", { class: "mono" }, el("a", { href: EXPLORER + r.a, target: "_blank", rel: "noopener noreferrer", text: nameOf(r.a) })),
        el("td", { class: "num hide-sm", text: pct(total ? r.vhp / total : 0) }),
        ...[C.WIN, C.SHOW, C.HALF].map((code) => { const l = { code, round: event, producer: r.a }; return el("td", { class: "num" }, legButton(l, C.priceLeg(card, l))); }))));
      $("odds-note").textContent = "Each button shows what the leg is worth and its chance. One leg per race; a producer can be in only one race leg per card. Paddock producers (too few blocks for a fair race) can't be picked.";
    } else {
      const t = X.target(event);
      $("event-line").textContent = `Block ${fmt(t)}, about ${dayTime(about(t))}. Locks 500 blocks before, about ${clock(about(t - C.BLOCK_LEAD))}.`;
      $("odds-head").replaceChildren(el("tr", {}, el("th", { text: "Producer" }), el("th", { class: "num hide-sm", text: "VHP share" }), el("th", { class: "num", text: "Signs it" })));
      const rows = [...m.entries()].sort((a, b) => b[1] - a[1]);
      body.replaceChildren(...rows.map(([a]) => { const l = { code: C.BLOCK, round: event, producer: a }; return el("tr", {},
        el("td", { class: "mono" }, el("a", { href: EXPLORER + a, target: "_blank", rel: "noopener noreferrer", text: nameOf(a) })),
        el("td", { class: "num hide-sm", text: pct(total ? m.get(a) / total : 0) }),
        el("td", { class: "num" }, legButton(l, C.priceLeg(card, l)))); }));
      $("odds-note").textContent = "Koinos picks who signs each block in proportion to VHP. One leg per block; the same producer may sign several of your blocks.";
    }
  }

  // ── render: the card ──
  function cardStats() {
    const sorted = [...legs].sort((a, b) => lockTimeOf(a) - lockTimeOf(b));
    const pot = card ? C.potential(card, sorted) : { pts: 0, prices: sorted.map(() => null), unpriced: true };
    const chances = pot.prices.map((p) => (p ? p.chance : null));
    const chance = chances.length && chances.every((c) => c != null) ? chances.reduce((s, c) => s * c, 1) : null;
    return { sorted, pot, chance };
  }
  const lockTimeOf = (l) => (eventOf(l) === "race" ? M.raceStart(l.round) - C.RACE_LEAD_MS : head ? about(X.target(l.round) - C.BLOCK_LEAD) : Infinity);
  function renderCard() {
    const { sorted, pot, chance } = cardStats();
    $("legs").replaceChildren(...sorted.map((l, i) => {
      const p = pot.prices[i];
      return el("li", {}, el("span", { class: "n", text: String(i + 1) }),
        el("span", { class: "what" }, el("b", { text: legTitle(l) }), el("small", { text: legWhen(l) })),
        el("span", { class: "x", text: p ? xf(p.factor) : "–" }),
        el("button", { type: "button", "aria-label": `Remove ${legTitle(l)}`, onclick: () => toggleLeg(l) }, "×"));
    }));
    if (!legs.length) $("legs").replaceChildren(el("li", { class: "empty", text: "Add legs from the list: 2 to 6." }));
    const n = legs.length;
    $("pays").textContent = n < C.MIN_LEGS ? "–" : `${pts(pot.pts)} pts`;
    $("chance").textContent = n < C.MIN_LEGS || chance == null ? "–" : `about ${chance >= 0.0001 ? pct(chance) : "<0.01%"}`;
    const lock = n && head ? C.cardLockTime(legs, head) : null;
    $("locks").textContent = lock ? `${dayTime(lock)} (in ${dur(lock - Date.now())})` : "–";
    const problem = n === 0 ? "" : n < C.MIN_LEGS ? `Add ${C.MIN_LEGS - n} more leg${C.MIN_LEGS - n === 1 ? "" : "s"}.` : head ? C.cardProblem(legs, head) : null;
    $("problem").textContent = note || problem || (pot.pts >= C.CAP * 100 ? "This card is at the 150-point cap: more legs add risk but no points." : "");
    $("send").disabled = true;
    $("send").title = "Cards open when the Combo upgrade of the Picks contract is live.";
    $("send").textContent = "Send card (soon)";
  }
  function renderPriceNote() {
    if (!card) { $("price-note").textContent = ""; return; }
    const stale = Date.now() - card.at > CARD_STALE_MS;
    $("price-note").textContent = `Prices from the race card of ${clock(card.at)}${stale ? " · a new card is due: prices may shift a little" : ""}`;
  }
  let shareKey = "";
  function render() {
    renderPriceNote(); renderEvents(); renderOdds(); renderCard();
    const k = JSON.stringify([legs, card && card.at]);
    if (k !== shareKey) { shareKey = k; renderShare(); }
  }

  // ── share: an image drawn on the page and a line of text ──
  function shareText() {
    const { sorted, pot } = cardStats();
    const lines = sorted.map((l, i) => `${i + 1}. ${legTitle(l)} (${legWhen(l)})${pot.prices[i] ? ` ${xf(pot.prices[i].factor)}` : ""}`);
    return `My Knode Games Combo Card: ${sorted.length} legs, pays ${pts(pot.pts)} pts if every leg hits.\n${lines.join("\n")}\n${PAGE}`;
  }
  function drawImage() {
    const { sorted, pot, chance } = cardStats();
    const cv = document.createElement("canvas"); cv.width = 1200; cv.height = 630;
    const g = cv.getContext("2d");
    if (!g) return null;
    const css = getComputedStyle(document.documentElement);
    const v = (name, d) => (css.getPropertyValue(name) || "").trim() || d;
    const ink = "#14213D", gold = "#FFB703", paper = "#FBF8F1", violet = v("--violet", "#6C4AB6");
    const disp = "'Bricolage Grotesque', system-ui, sans-serif", body = "'Atkinson Hyperlegible', system-ui, sans-serif", mono = "ui-monospace, Consolas, monospace";
    g.fillStyle = ink; g.fillRect(0, 0, 1200, 630);
    g.fillStyle = gold; g.fillRect(0, 0, 1200, 10);
    g.fillStyle = gold; g.font = `800 26px ${disp}`; g.fillText("KNODE GAMES · COMBO CARD", 60, 70);
    g.fillStyle = paper; g.font = `800 64px ${disp}`; g.fillText(`${pts(pot.pts)} pts`, 60, 150);
    g.font = `400 26px ${body}`; g.fillStyle = "rgba(251,248,241,.75)";
    g.fillText(`if all ${sorted.length} legs hit${chance != null ? ` · about ${chance >= 0.0001 ? pct(chance) : "<0.01%"} chance` : ""}`, 60, 192);
    const rowH = Math.min(62, Math.floor(330 / Math.max(1, sorted.length)));
    sorted.forEach((l, i) => {
      const y = 232 + i * rowH;
      g.fillStyle = "rgba(251,248,241,.08)"; g.beginPath(); (g.roundRect ? g.roundRect(60, y, 1080, rowH - 10, 12) : g.rect(60, y, 1080, rowH - 10)); g.fill();
      const mid = y + (rowH - 10) / 2 + 9;
      g.fillStyle = gold; g.font = `800 26px ${disp}`; g.fillText(String(i + 1), 82, mid);
      g.fillStyle = paper; g.font = `700 26px ${body}`; g.fillText(C.NAMES[l.code], 124, mid);
      g.font = `400 24px ${mono}`; g.fillText(nameOf(l.producer), 290, mid);
      g.fillStyle = "rgba(251,248,241,.7)"; g.font = `400 22px ${body}`;
      g.fillText(eventOf(l) === "race" ? `race ${dayTime(M.raceStart(l.round))} UTC${utcOff()}` : `block ${fmt(X.target(l.round))}`, 560, mid);
      g.fillStyle = pot.prices[i] ? gold : paper; g.font = `800 28px ${disp}`; g.textAlign = "right";
      g.fillText(pot.prices[i] ? xf(pot.prices[i].factor) : "–", 1116, mid); g.textAlign = "left";
    });
    g.fillStyle = "rgba(251,248,241,.6)"; g.font = `400 22px ${body}`;
    g.fillText("Every leg must hit. Points only. bawcejawn.github.io/Knode", 60, 600);
    g.fillStyle = violet; g.fillRect(1040, 584, 100, 6);
    return cv;
  }
  /** The viewer's offset shown next to a local time on the image ("UTC−7"), so others can read it. */
  function utcOff() { const m = -new Date().getTimezoneOffset(); if (!m) return ""; const s = m > 0 ? "+" : "−", a = Math.abs(m); return `${s}${Math.floor(a / 60)}${a % 60 ? ":" + String(a % 60).padStart(2, "0") : ""}`; }
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
  $("share-native").onclick = async () => {
    if (!shareBlob) return;
    try { await navigator.share({ files: [shareBlob], text: shareText(), title: "My Combo Card" }); } catch { /* cancelled */ }
  };
  $("share-copy").onclick = async () => {
    try { await navigator.clipboard.writeText(shareText()); $("share-msg").textContent = "Copied."; }
    catch { $("share-msg").textContent = "Couldn't copy here. Select the text from the download instead."; }
  };

  // ── controls ──
  const setTab = (t) => { tab = t; event = null; $("t-race").setAttribute("aria-pressed", String(t === "race")); $("t-block").setAttribute("aria-pressed", String(t === "block")); render(); };
  $("t-race").onclick = () => setTab("race");
  $("t-block").onclick = () => setTab("block");
  $("clear").onclick = () => { legs = []; note = ""; saveDraft(); render(); };

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
  if (W && W.subscribe) W.subscribe(() => { if (lb && board) { lb.setMe(me() || ""); lb.set(board); } });

  // ── start ──
  (async () => {
    loadDraft();
    try { await readHead(); say(""); } catch { say("Couldn't reach the Koinos network. Trying again in a moment…"); }
    await loadRaces();
    dropLocked(); render();
    loadBoard();
    setInterval(() => { if (!document.hidden) readHead().then(() => { say(""); const before = legs.length; dropLocked(); if (legs.length !== before) render(); else { renderEvents(); renderCard(); } }).catch(() => say("Reconnecting to the Koinos network…")); }, 15000);
    setInterval(() => { if (!document.hidden) loadRaces().then(render); }, 300000);
    setInterval(() => { if (!document.hidden) loadBoard(); }, 600000);
  })();
})();

/* blockx.html: Who Signs Block X. It reads the chain's head block, the race recorder's handicap cards (race-data), the
   Block X recorder's results (games-data/blockx) and, once the KnodeGames Picks contract is live (picks-data/
   deployment.json), your picks from the contract. It sends one thing: a pick you confirm in your wallet.
   The scoring is blockx-math.js, the same file the recorder (bot/games/blockx.ts) uses. */
(() => {
  "use strict";
  const X = window.KBlockX, M = window.KRaceMath;
  if (!X || !M || typeof document === "undefined" || !document.getElementById("targets")) return;

  const lib = window.koilib || window.koinos || window;
  const RPC = "https://api.koinos.io";
  const RACE_DATA = "https://raw.githubusercontent.com/bawcejawn/Knode/race-data/";
  const DATA = "https://raw.githubusercontent.com/bawcejawn/Knode/games-data/blockx/";
  const EXPLORER = "https://koinosscan.com/address/";
  const NAMES = { "1Mpmf2ERhjYpX7CCiM11WERuM4j17uT1sr": "Knode pool", "1FKTpXBhhHEbu5vVchM8UsVbAvPArJsRmR": "Knode Swap" };
  const ROOT = new URL("../", location.href);
  const provider = new lib.Provider([RPC]);
  const W = window.KWallet;

  const $ = (id) => document.getElementById(id);
  const el = (tag, attrs = {}, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (k === "text") e.textContent = v; else if (k.startsWith("on")) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v); } for (const c of kids) if (c != null) e.append(c); return e; };
  const isAddr = (a) => typeof a === "string" && /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a);
  const nameOf = (a) => (isAddr(a) ? NAMES[a] || a.slice(0, 5) + "…" + a.slice(-4) : "–");
  const fmt = (n, d = 0) => Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
  const pts = (h) => fmt(h / 100, 2);
  const clock = (t) => new Date(t).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const dayTime = (t) => new Date(t).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
  const dur = (ms) => { const m = Math.max(0, Math.ceil(ms / 60000)); return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min` : `${m} min`; };
  const say = (t) => { $("status").textContent = t; $("status").hidden = !t; };
  async function fetchJson(url) { const r = await fetch(url, { cache: "no-cache" }); if (!r.ok) throw new Error(String(r.status)); return r.json(); }

  let head = null;                 // { height, time }
  let card = null, cardAt = 0;     // the race card in force now
  let picksContract = null, myPicks = new Map(), usage = null, sending = false;
  let weeks = new Map(), board = null, boardMode = "week";
  const drafts = new Map();
  const me = () => (W && W.address) || null;

  // ── chain head ──
  async function readHead() {
    const h = await provider.getHeadInfo();
    head = { height: Number(h.head_topology.height), time: Number(h.head_block_time) };
    return head;
  }
  /** About when block h is made, from the head. */
  const about = (h) => X.aboutTime(h, head.height, head.time);

  // ── the producers and their multipliers: the race recorder's card for this hour ──
  async function loadCard() {
    const now = Date.now(), ra = M.raceAt(now), w = M.weekOf(ra.start);
    try {
      const wf = await fetchJson(`${RACE_DATA}W${String(w).padStart(3, "0")}.json`);
      const race = wf && Array.isArray(wf.races) ? wf.races.find((r) => r && r.id === ra.id) : null;
      const c = race && Array.isArray(race.cards) ? M.cardForLeg(race.cards, M.legOf(ra.start, now, M.legsOf(race.cards))) : null;
      if (c && Array.isArray(c.field) && c.field.length) { card = c; cardAt = now; }
    } catch { /* keep the last card */ }
  }
  /** Producers for the chooser: field and paddock, biggest first, with their share and multiplier. */
  function producers() {
    if (!card) return [];
    const { m } = X.vhpOf(card), tot = [...m.values()].reduce((s, v) => s + v, 0);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([a, v]) => ({ a, share: tot ? v / tot : 0, mult: X.multiplier(card, a) }));
  }

  // ── picks contract (live once picks-data/deployment.json is on the site) ──
  async function setupPicks() {
    let pdep = null, dep = null;
    try { pdep = await fetchJson(new URL("picks-data/deployment.json", ROOT)); } catch { return; }
    if (!pdep || !isAddr(pdep.contract)) return;
    try { dep = await fetchJson(new URL("game-data/deployment.json", ROOT)); } catch { /* the wallet keeps its defaults */ }
    const abi = await fetchJson(new URL("picks/abi/picks.koilib.json", ROOT));
    picksContract = new lib.Contract({ id: pdep.contract, abi, provider });
    if (W) W.init({ provider, chainId: dep && dep.chainId, payer: dep && dep.payer, sponsor: dep && dep.sponsor, onChange: () => loadMine() });
    $("picks-soon").hidden = true;
    loadMine();
  }
  async function loadMine() {
    if (!picksContract || !head) { renderTargets(true); return; }
    const who = me();
    myPicks = new Map(); usage = null;
    if (who) {
      const rounds = X.openRounds(head.height);
      try {
        const got = await Promise.all(rounds.map((r) => picksContract.functions.get_pick({ game: X.GAME_ID, round: String(r), player: who })
          .then((x) => [r, x.result && x.result.pick && Array.isArray(x.result.pick.producers) ? x.result.pick : null])));
        for (const [r, p] of got) if (p) myPicks.set(r, p);
        usage = (await picksContract.functions.get_usage({ game: X.GAME_ID, player: who })).result || null;
      } catch { /* shown as unknown */ }
    }
    renderTargets(true);
  }

  // ── the 12 open targets ──
  let targetsKey = "";
  function renderTargets(force = false) {
    if (!head) return;
    const list = $("targets");
    if (!force && list.contains(document.activeElement) && document.activeElement.tagName === "SELECT") return;
    const who = me(), rounds = X.offerRounds(head.height), ps = producers();
    const key = JSON.stringify([who, W && W.kind, rounds[0], sending, !!picksContract, cardAt, usage && usage.picks_today, [...myPicks.keys()]]);
    if (!force && key === targetsKey && list.childElementCount) { updateTimes(); return; }
    targetsKey = key;
    $("head-line").textContent = `Head block ${fmt(head.height)} · next target block ${fmt(X.target(X.openRounds(head.height)[0]))}`;
    const max = usage ? Number(usage.max_picks_per_day) || X.PICKS_PER_DAY : X.PICKS_PER_DAY, used = usage ? Number(usage.picks_today) || 0 : 0;
    $("picks-left").textContent = usage ? `${Math.max(0, max - used)} of ${max} picks left today` : "";
    $("picks-who").textContent = !picksContract ? "" : who ? `Picking as ${nameOf(who)}${W.kind === "guest" ? " (guest)" : ""}.` : "Connect a wallet to pick (Kondor, KOIN Vault or a guest wallet).";
    const rows = [];
    for (const r of rounds) {
      const h = X.target(r), mine = myPicks.get(r), mineP = mine && mine.producers && mine.producers[0];
      const when = el("div", { class: "bx-when" },
        el("b", { text: `Block ${fmt(h)}` }),
        el("span", { "data-h": String(h), class: "bx-eta", text: `about ${clock(about(h))} · locks in ${dur(about(X.lockHeight(r)) - Date.now())}` }));
      let pickCell;
      if (!picksContract) pickCell = el("div", { class: "bx-now", text: "Picks open soon" });
      else if (!who) pickCell = el("div", { class: "bx-now", text: mineP ? `Your pick: ${nameOf(mineP)}` : "–" });
      else {
        const sel = el("select", { "aria-label": `Producer for block ${fmt(h)}` },
          el("option", { value: "", text: !ps.length ? "Loading producers…" : mineP ? "Change to…" : "Who signs it?" }),
          ...ps.map((p) => { const o = el("option", { value: p.a, text: `${nameOf(p.a)} · ${fmt(p.share * 100, p.share < 0.01 ? 2 : 1)}% · ×${fmt(p.mult, 2)}` }); if (p.a === (drafts.get(r) || mineP)) o.selected = true; return o; }));
        if (!ps.length) sel.disabled = true;
        sel.addEventListener("change", () => { if (sel.value) drafts.set(r, sel.value); else drafts.delete(r); });
        const btn = el("button", { class: "btn", type: "button", onclick: () => sendPick(r, sel.value) }, mineP ? "Change" : "Pick");
        if (sending || used >= max || (mine && Number(mine.changes) >= X.MAX_CHANGES)) btn.disabled = true;
        pickCell = el("div", { class: "bx-pick" }, sel, btn, mineP ? el("div", { class: "bx-now ago", text: `Your pick: ${nameOf(mineP)} (×${fmt(X.multiplier(card, mineP), 2)} if right)` }) : null);
      }
      rows.push(el("div", { class: `bx-row${mineP ? " mine" : ""}` }, when, pickCell));
    }
    list.replaceChildren(...rows);
  }
  function updateTimes() {
    if (!head) return;
    document.querySelectorAll("#targets [data-h]").forEach((n) => {
      const h = Number(n.dataset.h);
      n.textContent = `about ${clock(about(h))} · locks in ${dur(about(h - X.LEAD) - Date.now())}`;
    });
  }

  // ── the pick pop-up: wallet → sent → confirmed on the chain ──
  let modal = null;
  function pickModal(state, title, lines = [], actions = []) {
    if (!modal) {
      modal = el("div", { class: "pk-modal", role: "dialog", "aria-modal": "true", "aria-labelledby": "pk-m-title" });
      modal.addEventListener("click", (e) => { if (e.target === modal && !modal.querySelector(".pk-spin")) closeModal(); });
      document.body.append(modal);
    }
    const icon = { busy: el("span", { class: "pk-spin", "aria-hidden": "true" }), ok: el("span", { class: "pk-big ok", text: "✓" }), bad: el("span", { class: "pk-big bad", text: "✗" }), info: el("span", { class: "pk-big", text: "ℹ" }) }[state];
    modal.replaceChildren(el("div", { class: `pk-box ${state}` }, icon, el("h3", { id: "pk-m-title", text: title }), ...lines.map((l) => (typeof l === "string" ? el("p", { text: l }) : l)),
      actions.length ? el("div", { class: "pk-acts" }, ...actions) : null));
    modal.hidden = false;
    const b = modal.querySelector("button"); if (b) b.focus();
  }
  function closeModal() { if (modal) modal.hidden = true; }
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && modal && !modal.hidden && !modal.querySelector(".pk-spin")) closeModal(); });
  const okBtn = (text = "Done") => el("button", { class: "btn", type: "button", onclick: closeModal }, text);

  async function sendPick(r, producer) {
    const who = me();
    if (!who || !picksContract || sending) return;
    const h = X.target(r);
    if (!isAddr(producer)) return pickModal("info", "Choose a producer first", ["Pick who you think signs the block, then press Pick."], [okBtn("OK")]);
    const mine = myPicks.get(r);
    if (mine && mine.producers && mine.producers[0] === producer) return pickModal("info", "That is already your pick", [`${nameOf(producer)} for block ${fmt(h)}.`], [okBtn("OK")]);
    try { await readHead(); } catch { /* use the last head */ }
    if (!(X.lockHeight(r) - head.height > 20)) return pickModal("bad", "Too close to the lock", [`Block ${fmt(h)} locks in a few minutes. Pick a later one.`], [okBtn("OK")]);
    sending = true; renderTargets(true);
    const mult = X.multiplier(card, producer);
    const what = `${nameOf(producer)} signs block ${fmt(h)} (about ${dayTime(about(h))})`;
    const wallet = W.kind === "guest" ? "your guest wallet" : W.label ? W.label() : "your wallet";
    pickModal("busy", W.kind === "guest" ? "Sending your pick…" : `Confirm in ${wallet}`, [what, `Scores ×${fmt(mult, 2)} if right.`, "Free: the Knode Mana sponsor pays the Mana."]);
    try {
      const { operation } = await picksContract.functions.pick({ player: who, game: X.GAME_ID, round: String(r), producers: [producer], number: "0" }, { onlyOperation: true });
      const id = await W.send(`pick ${nameOf(producer)} for block ${fmt(h)}`, [operation]);
      pickModal("busy", "Sent. Checking the chain…", [what]);
      let onChain = false;
      for (let t = 0; t < 10 && !onChain; t++) {
        try { const x = await picksContract.functions.get_pick({ game: X.GAME_ID, round: String(r), player: who }); onChain = !!(x.result && x.result.pick && x.result.pick.producers && x.result.pick.producers[0] === producer); } catch { /* again */ }
        if (!onChain) await new Promise((res) => setTimeout(res, 3000));
      }
      drafts.delete(r);
      if (onChain) pickModal("ok", "Pick confirmed", [el("p", {}, "Your pick: ", el("b", { text: nameOf(producer) }), ` for block ${fmt(h)}.`),
        `It locks 100 blocks (about 5 minutes) before the block. Until then you can change it (up to ${X.MAX_CHANGES} times; changes count toward today's ${X.PICKS_PER_DAY}).`,
        id ? el("p", { class: "ago mono", text: `Transaction ${String(id).slice(0, 18)}…` }) : null].filter(Boolean), [okBtn()]);
      else pickModal("info", "Sent, not seen on the chain yet", ["Your wallet sent it. It usually shows within a minute; this list updates by itself."], [okBtn("OK")]);
    } catch (e) {
      const m = String((e && e.message) || e);
      const why = /locked/i.test(m) ? "That block is locked: picks close 100 blocks before it."
        : /not open yet/i.test(m) ? "That block isn't open yet."
        : /used up/i.test(m) ? "Today's picks are used up (changes count). More after 00:00 UTC."
        : /changed again/i.test(m) ? `That pick has been changed ${X.MAX_CHANGES} times already.`
        : /already your pick/i.test(m) ? "That is already your pick."
        : /reject|denied|cancel/i.test(m) ? "Cancelled in your wallet. Nothing was sent."
        : `Not sent: ${m.slice(0, 200)}`;
      pickModal(/Cancelled/.test(why) ? "info" : "bad", /Cancelled/.test(why) ? "Cancelled" : "Pick not sent", [why], [okBtn("OK")]);
    } finally { sending = false; await loadMine(); }
  }

  // ── results and the leaderboard (games-data/blockx) ──
  async function loadResults() {
    const wNow = M.weekOf(Date.now());
    for (const w of [wNow - 1, wNow]) {
      if (w < 0) continue;
      try { const j = await fetchJson(`${DATA}W${String(w).padStart(3, "0")}.json`); if (j && j.v === 1 && j.week === w && Array.isArray(j.targets)) weeks.set(w, j); } catch { /* none yet */ }
    }
    try { const b = await fetchJson(DATA + "board.json"); if (b && b.v === 1) board = b; } catch { /* none yet */ }
    renderResults(); renderBoard();
  }
  function renderResults() {
    const all = [...weeks.values()].flatMap((w) => w.targets).filter((t) => t && Number.isInteger(t.height)).sort((a, b) => b.height - a.height).slice(0, 12);
    $("results-box").hidden = !all.length;
    const who = me();
    $("res-rows").replaceChildren(...all.map((t) => {
      const p = who && Array.isArray(t.picks) ? t.picks.find((x) => x[0] === who) : null;
      const right = p && p[3] > 0;
      return el("tr", { class: right ? "me" : "" },
        el("td", { class: "num", text: fmt(t.height) }),
        el("td", { class: "hide-sm", text: dayTime(t.time) }),
        el("td", { class: "mono" }, t.signer ? el("a", { href: EXPLORER + t.signer, target: "_blank", rel: "noopener noreferrer", text: nameOf(t.signer) }) : el("span", { text: "–" })),
        el("td", { class: "num hide-sm", text: t.void ? "void" : String((t.picks || []).filter((x) => x[3] > 0).length) + " / " + String((t.picks || []).length) }),
        el("td", { text: !p ? "" : right ? `✓ ${nameOf(p[1])} +${pts(p[3])}` : `✗ ${nameOf(p[1])}` }));
    }));
  }
  function renderBoard() {
    if (!board) { $("board-box").hidden = true; return; }
    $("board-box").hidden = false;
    const part = boardMode === "today" ? board.today : boardMode === "last" ? board.lastWeek : boardMode === "all" ? board.allTime : board.week;
    const rows = (part && part.rows) || [], who = me();
    // Places among ranked wallets only (unranked wallets see their own score below, never a place in the list).
    const ranked = X.places(rows.filter((r) => r.ranked).map((r) => ({ ...r, player: r.a }))).map((r) => ({ ...r, a: r.player }));
    const medal = ["🥇", "🥈", "🥉"];
    $("board-sub").textContent = boardMode === "week" && board.week ? `week ${board.week.week + 1}, from ${dayTime(board.week.start)}`
      : boardMode === "last" && board.lastWeek ? `week ${board.lastWeek.week + 1}${board.lastWeek.final ? ", final" : ", checking (final 12 hours after the week ends)"}`
      : boardMode === "today" ? `${board.today.day} (UTC)` : "";
    const prizes = boardMode === "last" && board.lastWeek && board.lastWeek.final ? board.lastWeek.prizes || [] : [];
    $("prizes").replaceChildren(...prizes.map((p) => el("div", { class: "champ" }, el("b", { text: `${p.place === 1 ? medal[0] : medal[1]} ${fmt(p.vhp, p.vhp % 1 ? 2 : 0)} VHP` }), el("span", { class: "mono", text: nameOf(p.player) }))));
    $("board-rows").replaceChildren(...ranked.slice(0, 50).map((r, i) => el("tr", { class: `${i < 3 ? "top" : ""} ${r.a === who ? "me" : ""}` },
      el("td", { text: r.place <= 3 ? medal[r.place - 1] : String(r.place) }),
      el("td", { class: "mono" }, el("a", { href: EXPLORER + r.a, target: "_blank", rel: "noopener noreferrer", text: nameOf(r.a) })),
      el("td", { class: "num", text: pts(r.pts) }), el("td", { class: "num", text: fmt(r.correct) }),
      el("td", { class: "num hide-sm", text: fmt(r.picks) }), el("td", { class: "num hide-sm", text: fmt(r.days) }))));
    if (!ranked.length) $("board-rows").replaceChildren(el("tr", {}, el("td", { colspan: "6", class: "ago", text: "No ranked picks yet." })));
    const mine = who && rows.find((r) => r.a === who);
    $("board-me").textContent = !who ? "" : !mine ? "You have no recorded picks here yet." : mine.ranked
      ? `You: #${(ranked.find((r) => r.a === who) || mine).place} with ${pts(mine.pts)} points (${mine.correct} right of ${mine.picks}).`
      : `Your score (only you see this): ${pts(mine.pts)} points, ${mine.correct} right of ${mine.picks}. To be ranked and win prizes, hold at least 1 VHP or stake in Knode.`;
  }
  const setBoard = (m) => { boardMode = m; for (const [id, k] of [["b-today", "today"], ["b-week", "week"], ["b-last", "last"], ["b-all", "all"]]) $(id).setAttribute("aria-pressed", String(m === k)); renderBoard(); };
  $("b-today").onclick = () => setBoard("today"); $("b-week").onclick = () => setBoard("week"); $("b-last").onclick = () => setBoard("last"); $("b-all").onclick = () => setBoard("all");
  if (W && W.subscribe) W.subscribe(() => { loadMine(); renderBoard(); renderResults(); });

  // ── the multiplier table ──
  function renderMults() {
    const ps = producers();
    $("mult-sub").textContent = card ? `From the Producer Race card of ${dayTime(card.at || cardAt)}. A right pick scores the multiplier: top producer's VHP ÷ yours, at most ×3.` : "Waiting for the race recorder's card…";
    $("mult-rows").replaceChildren(...ps.map((p) => el("tr", {},
      el("td", { class: "mono" }, el("a", { href: EXPLORER + p.a, target: "_blank", rel: "noopener noreferrer", text: nameOf(p.a) })),
      el("td", { class: "num", text: `${fmt(p.share * 100, p.share < 0.01 ? 2 : 1)}%` }),
      el("td", { class: "num", text: `×${fmt(p.mult, 2)}` }),
      el("td", { class: "num hide-sm", text: fmt(p.share * p.mult * 100, 1) }))));
  }

  // ── start ──
  (async () => {
    const picksReady = setupPicks().catch(() => {});
    try { await readHead(); say(""); } catch { say("Couldn't reach the Koinos network. Trying again in a moment…"); }
    await loadCard(); renderMults();
    await picksReady; renderTargets(true);
    loadResults();
    setInterval(() => { if (!document.hidden) readHead().then(() => { say(""); renderTargets(); }).catch(() => say("Reconnecting to the Koinos network…")); }, 6000);
    setInterval(() => { if (!document.hidden) loadCard().then(renderMults); }, 600000);
    setInterval(() => { if (!document.hidden) loadResults(); }, 300000);
    setInterval(() => { if (!document.hidden && picksContract) loadMine(); }, 60000);
    setInterval(updateTimes, 15000);
  })();
})();

/* games.html: the KnodeGames hub. One card per game from games.json (the site's own file), with the player's status
   on the live games: their place on the Race board and how many daily questions are open now.
   Read-only: no transaction, no storage. It reads only games.json, the question files (game-data/) and the race
   recorder's board (race-data branch), and builds everything with textContent. */
(() => {
  "use strict";
  const M = window.KRaceMath;
  const W = window.KWallet;
  const BASE = location.pathname.includes("/site/") ? "../" : "./";
  const GAME_DATA = BASE + "game-data/";
  const RACE_DATA = "https://raw.githubusercontent.com/bawcejawn/Knode/race-data/";
  const $ = (id) => document.getElementById(id);
  const SVG = "http://www.w3.org/2000/svg";

  // Card icons (fixed drawings, never from data).
  const ICONS = {
    race: ["M5 21V4", "M5 4h12l-2.5 4L17 12H5"],
    questions: ["M12 3l2.6 5.6 6 .7-4.5 4.1 1.2 6L12 16.6 6.7 19.4l1.2-6L3.4 9.3l6-.7z"],
    blockx: ["M4 7a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3z", "M9 12h6", "M12 9v6"],
    survivor: ["M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6z", "M9 12l2 2 4-4"],
    fantasy: ["M12 5a3 3 0 1 1 0 6a3 3 0 1 1 0-6z", "M5 20c1-4 4-6 7-6s6 2 7 6"],
    golf: ["M7 21V4l9 4-9 4", "M4 21h8"],
  };
  const KINDS = { free: "Free", staked: "Staked" };

  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) { if (v == null) continue; if (k === "text") e.textContent = v; else e.setAttribute(k, v); }
    for (const c of kids) if (c) e.append(c);
    return e;
  }
  function icon(id) {
    const s = document.createElementNS(SVG, "svg");
    s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("aria-hidden", "true");
    for (const d of ICONS[id] || ICONS.blockx) { const p = document.createElementNS(SVG, "path"); p.setAttribute("d", d); s.append(p); }
    return s;
  }
  const dur = (ms) => {
    if (!(ms > 0)) return "now";
    const m = Math.round(ms / 60000), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60);
    return d ? `${d} d ${h} h` : h ? `${h} h ${m % 60} m` : `${m} m`;
  };
  async function fetchJson(url) { const r = await fetch(url, { cache: "no-cache" }); if (!r.ok) throw new Error(String(r.status)); return r.json(); }

  /** games.json, checked: only known kinds and statuses, plain text, and links to this site's own pages. */
  function clean(list) {
    const ok = (g) => g && typeof g.id === "string" && /^[a-z0-9-]{1,24}$/.test(g.id) && typeof g.name === "string" && g.name.length <= 40
      && typeof g.line === "string" && g.line.length <= 200 && Array.isArray(g.kinds) && g.kinds.length && g.kinds.every((k) => k in KINDS)
      && (g.status === "live" || g.status === "soon") && typeof g.href === "string"
      && (g.status === "soon" ? g.href === "" : /^[a-z0-9-]+\.html(#[a-z/]+)?$/.test(g.href));
    return Array.isArray(list) ? list.filter(ok).slice(0, 40) : [];
  }

  // ── the week strip ──
  function week() {
    if (!M) return;
    const now = Date.now(), w = M.weekOf(now), end = M.weekStart(w + 1);
    $("wk-num").textContent = String(w + 1);
    $("wk-left").textContent = dur(end - now);
  }

  // ── live status for each game (the card shows "–" until it arrives; a failed read leaves the card as it is) ──
  let raceBoard = null, questionsOpen = null, nextQuestions = null;
  const status = {
    race(box) {
      const chips = [];
      const who = W && W.address;
      const rows = raceBoard && raceBoard.week && Array.isArray(raceBoard.week.rows) ? raceBoard.week.rows : null;
      if (who && rows) {
        const ranked = rows.filter((r) => r.ranked), mine = rows.find((r) => r.a === who);
        if (mine && mine.ranked) chips.push(el("span", { class: "me", text: `#${ranked.indexOf(mine) + 1} this week · ${mine.pts ?? 0} pts` }));
        else if (mine) chips.push(el("span", { class: "me", text: `${mine.pts ?? 0} pts this week` }));
      }
      if (M) { const now = Date.now(), next = M.raceStart(M.raceIndex(now) + 1); chips.push(el("span", { text: `Next race locks in ~${dur(next - now)}` })); }
      box.replaceChildren(...chips);
    },
    questions(box) {
      const chips = [];
      if (questionsOpen > 0) chips.push(el("span", { class: "me", text: `${questionsOpen} open now` }));
      else if (nextQuestions) chips.push(el("span", { text: nextQuestions }));
      box.replaceChildren(...chips);
    },
  };
  function refresh() { document.querySelectorAll("[data-status]").forEach((b) => { const f = status[b.dataset.status]; if (f) f(b); }); }

  async function loadRace() {
    try { const b = await fetchJson(RACE_DATA + "board.json"); if (b && b.v === 1) raceBoard = b; } catch { /* no board yet */ }
    refresh();
  }
  async function loadQuestions() {
    try {
      const idx = await fetchJson(GAME_DATA + "index.json");
      const days = Array.isArray(idx && idx.days) ? idx.days.filter((d) => typeof d === "string" && /^questions\/W\d{3}-D[1-7]\.json$/.test(d)) : [];
      if (!days.length) return;
      const day = await fetchJson(GAME_DATA + days[days.length - 1]);
      const now = Date.now(), qs = Array.isArray(day && day.questions) ? day.questions : [];
      questionsOpen = qs.filter((q) => q && Number(q.lockTime) > now).length;
      if (!questionsOpen) nextQuestions = "New questions Mon–Sat, 12:00 UTC";
    } catch { /* no data: leave the card plain */ }
    refresh();
  }

  function card(g) {
    const live = g.status === "live";
    const pills = [...g.kinds.map((k) => el("span", { class: `pill ${k}`, text: KINDS[k] })), live ? null : el("span", { class: "pill soon", text: "Soon" })];
    const body = el("span", { class: "g-bd" },
      el("span", { class: "g-t" }, el("span", { class: "g-name", text: g.name }), ...pills),
      el("span", { class: "g-line", text: g.line }),
      live && status[g.id] ? el("span", { class: "g-st", "data-status": g.id }) : null);
    const ic = el("span", { class: "g-ic" }); ic.append(icon(g.id));
    return live
      ? el("a", { class: "g", href: g.href, "data-game": g.id }, ic, body, el("span", { class: "g-go", "aria-hidden": "true", text: "›" }))
      : el("div", { class: "g soon", "data-game": g.id }, ic, body);
  }

  async function main() {
    week();
    let games = [];
    try { games = clean((await fetchJson("games.json")).games); } catch { /* shown below */ }
    if (!games.length) { $("g-live").replaceChildren(el("p", { class: "note", text: "The games list couldn't load. Reload the page to try again." })); return; }
    const free = games.filter((g) => g.status === "live" && g.kinds.includes("free"));
    const stakedOnly = games.filter((g) => g.status === "live" && !g.kinds.includes("free"));
    $("g-live").replaceChildren(...free.map(card), ...stakedOnly.map(card));
    // Every live game's own leaderboard, one tap away (the Leaderboards page, a tab per game).
    const boards = games.filter((g) => g.status === "live" && (g.id === "questions" || (g.board && typeof g.board === "object")));
    if (boards.length) {
      const links = [];
      boards.forEach((g, i) => { if (i) links.push(" · "); links.push(el("a", { href: g.id === "questions" ? "index.html#leaderboard" : `index.html#leaderboard/${g.id}`, text: g.name })); });
      $("g-boards").replaceChildren(el("b", { text: "Leaderboards: " }), ...links);
      $("g-boards").hidden = false;
    }
    $("g-soon").replaceChildren(...games.filter((g) => g.status === "soon").map(card));
    $("soon-box").hidden = !games.some((g) => g.status === "soon");
    refresh();
    loadRace(); loadQuestions();
    setInterval(() => { week(); refresh(); }, 60000);
    if (W && W.subscribe) W.subscribe(refresh);
  }
  main();
})();

/* The Leaderboards page (index.html#leaderboard): one tab per game, each with its own players and points.
   "Daily Questions" is the question game's own table (drawn by app.js from the chain). Every other live game in
   games.json that names a `board` gets the shared KnodeGames leaderboard (board.js) fed with that game's recorder
   file (its board.json on the race-data or games-data branch). A new game shows up here by adding `board` to its
   games.json entry, plus its data branch in index.html's connect-src (race-data is there; games-data is added by
   the first game that publishes to it).
   Links: index.html#leaderboard (questions), index.html#leaderboard/race, …/blockx and so on.
   Read-only: no transaction, no storage, nothing built from HTML. */
(() => {
  "use strict";
  const host = document.getElementById("lb-games");
  if (!host || !window.KBoard) return;
  const W = window.KWallet;
  const RAW = "https://raw.githubusercontent.com/bawcejawn/Knode/";
  const EXPLORER = "https://koinosscan.com/address/";
  const $ = (id) => document.getElementById(id);
  const fmt = (x) => (typeof x === "number" && isFinite(x) ? x.toLocaleString("en-US") : "–");
  const short = (a) => (typeof a === "string" && a.length > 12 ? a.slice(0, 4) + "…" + a.slice(-4) : String(a || ""));
  const me = () => (W && W.address) || "";

  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) { if (v == null) continue; if (k === "text") e.textContent = v; else e.setAttribute(k, v); }
    for (const c of kids) if (c) e.append(c);
    return e;
  }
  async function fetchJson(url) { const r = await fetch(url, { cache: "no-cache" }); if (!r.ok) throw new Error(String(r.status)); return r.json(); }

  /** A game's `board` from games.json, checked: a recorder file on this repo's data branches, plain column keys and labels. */
  function boardOf(g) {
    const b = g && g.board;
    if (!b || typeof b !== "object") return null;
    if (typeof b.data !== "string" || !/^(race-data|games-data)\/([a-z0-9-]{1,24}\/)?board\.json$/.test(b.data)) return null;
    const cols = Array.isArray(b.columns) ? b.columns.filter((c) => c && /^[a-z]{1,12}$/.test(c.key) && typeof c.label === "string" && c.label.length <= 20).slice(0, 6) : [];
    if (!cols.length) return null;
    return {
      url: RAW + b.data,
      columns: cols.map((c) => ({ key: c.key, label: c.label, wide: c.wide === true })),
      unit: typeof b.unit === "string" && b.unit.length <= 12 ? b.unit : "pts",
      unranked: typeof b.unranked === "string" && b.unranked.length <= 160 ? b.unranked : "",
      main: cols[0].key,
    };
  }

  let games = [{ id: "questions", name: "Daily Questions" }];
  let current = "questions";
  const boards = new Map();   // id → { lb, data, loaded }
  const panel = $("lb-game"), qPart = $("lb-q");

  function buttons() {
    host.replaceChildren(...games.map((g) => {
      const b = el("button", { type: "button", "aria-pressed": String(g.id === current), text: g.name });
      b.addEventListener("click", () => { if (location.hash !== `#leaderboard/${g.id}`) location.hash = g.id === "questions" ? "#leaderboard" : `#leaderboard/${g.id}`; else show(g.id); });
      return b;
    }));
  }

  async function show(id) {
    if (!games.some((g) => g.id === id)) id = "questions";
    current = id;
    buttons();
    const q = id === "questions";
    qPart.hidden = !q; panel.hidden = q;
    $("lb-title").textContent = q ? "Leaderboard · Daily Questions" : `Leaderboard · ${games.find((g) => g.id === id).name}`;
    if (q) return;
    const g = games.find((x) => x.id === id), cfg = g.cfg;
    let b = boards.get(id);
    if (!b) {
      const box = el("div");
      const note = el("p", { class: "muted lb-game-note", text: "Points count when each result is final. Each game has its own players and points." });
      b = {
        box, note, data: null,
        lb: window.KBoard.create(box, {
          label: `${g.name} leaderboard`, columns: cfg.columns, name: short, link: (a) => EXPLORER + a,
          scored: (r) => (r[cfg.main] ?? 0) > 0,
          summary: (r) => `${fmt(r[cfg.main] ?? 0)} ${cfg.columns[0].label.toLowerCase()}`,
          me: (r, place) => `${place ? `You: #${place} with` : "Your score (only you see this):"} ${fmt(r[cfg.main] ?? 0)} ${cfg.columns[0].label.toLowerCase()}.`,
          unranked: cfg.unranked,
        }),
      };
      boards.set(id, b);
    }
    panel.replaceChildren(b.note, b.box);
    b.lb.setMe(me());
    try { const d = await fetchJson(cfg.url); if (d && d.v === 1) { b.data = d; b.lb.set(d); } }
    catch { if (!b.data) b.note.textContent = "Couldn't load this leaderboard right now. Trying again when you come back to it."; }
  }

  function route() {
    const [view, sub] = (location.hash || "").slice(1).split("/");
    if (view === "leaderboard") show(sub || "questions");
  }

  async function load() {
    try {
      const list = (await fetchJson("games.json")).games;
      const extra = (Array.isArray(list) ? list : []).filter((g) => g && g.status === "live" && g.id !== "questions"
        && typeof g.id === "string" && /^[a-z0-9-]{1,24}$/.test(g.id) && typeof g.name === "string" && g.name.length <= 40)
        .map((g) => ({ id: g.id, name: g.name, cfg: boardOf(g) })).filter((g) => g.cfg);
      games = [games[0], ...extra];
    } catch { /* only the question game */ }
    buttons();
    route();
  }

  window.addEventListener("hashchange", route);
  if (W && W.subscribe) W.subscribe(() => { for (const b of boards.values()) b.lb.setMe(me()); });
  setInterval(() => { if (!document.hidden && current !== "questions" && !panel.hidden) show(current); }, 300000);
  load();
})();

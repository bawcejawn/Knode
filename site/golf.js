/* Block Golf: the game page. Read-only: it reads the Block Golf recorder's files (games-data/golf) and site/games.json,
 * and the connected wallet's address to show that player's card. It sends nothing and stores nothing. Everything is
 * built with textContent, never HTML. The scoring is golf-math.js, the same file the recorder runs. */
(() => {
  "use strict";
  const G = window.KGolf;
  if (!G || typeof document === "undefined" || !document.getElementById("card-rows")) return;
  const DATA = "https://raw.githubusercontent.com/bawcejawn/Knode/games-data/golf/";
  const EXPLORER = "https://koinosscan.com/address/";
  const $ = (id) => document.getElementById(id);
  const el = (tag, attrs = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) { if (v == null) continue; if (k === "text") e.textContent = v; else e.setAttribute(k, v); }
    for (const c of kids) if (c != null) e.append(c);
    return e;
  };
  const isAddr = G.isAddr;
  const short = (a) => (isAddr(a) ? a.slice(0, 4) + "…" + a.slice(-4) : "–");
  const ord = (n) => { const s = ["th", "st", "nd", "rd"], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
  const day = (t) => new Date(t).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  const say = (t) => { $("status").textContent = t; $("status").hidden = !t; };
  async function fetchJson(url) { const r = await fetch(url, { cache: "no-cache" }); if (!r.ok) throw new Error(String(r.status)); return r.json(); }
  const wName = (w) => `W${String(w).padStart(3, "0")}.json`;

  let games = new Map();          // id → { name, href }
  let weeks = { this: null, last: null };
  let showing = "this";
  let board = null, lb = null;
  const me = () => (window.KWallet && isAddr(window.KWallet.address) ? window.KWallet.address : "");

  // The key in How it works: one row per score.
  function drawKey() {
    const rows = [["1st place (ties share)", 1], ["Top 5%", 2], ["Top 25%", 3], ["Top 65%", 4], ["Top 90%", 5], ["The rest", 6], ["Didn't play that game", 7]];
    $("key-rows").replaceChildren(...rows.map(([what, s]) => el("tr", {}, el("td", { text: what }), el("td", { text: G.NAMES[s] }), el("td", { class: "num" }, mark(s)))));
  }
  function mark(s) { return el("span", { class: `gf-mark s${s}`, title: G.NAMES[s], text: String(s) }); }

  function gameCell(id, name) {
    const g = games.get(id);
    const label = (g && g.name) || name || id;
    const href = g && typeof g.href === "string" && /^[a-z0-9-]+\.html(#[a-z0-9/-]*)?$/.test(g.href) ? g.href : null;
    return el("td", { class: "gf-game" }, href ? el("a", { href, text: label }) : label);
  }

  /** The card to show: the player's, else (no wallet) the leader's. A player with no card plays every hole as a lost ball. */
  function pick(wf, who) {
    if (!wf) return { card: null, whose: "none" };
    const mine = who ? wf.cards.find((c) => c.a === who) : null;
    if (mine) return { card: mine, whose: "me" };
    if (who) return { card: null, whose: "me-empty" };
    return { card: wf.cards[0] || null, whose: "leader" };
  }

  function drawCard() {
    const wf = weeks[showing];
    const who = me();
    $("wk-last").hidden = !weeks.last;
    $("wk-this").setAttribute("aria-pressed", String(showing === "this"));
    $("wk-last").setAttribute("aria-pressed", String(showing === "last"));
    const body = $("card-rows");
    if (!wf) {
      body.replaceChildren(el("tr", {}, el("td", { colspan: "5", text: "No Block Golf week here yet. The course opens with the first week its games are live." })));
      $("card-sub").textContent = "–";
      $("par-total").textContent = "–"; $("strokes-total").textContent = "–"; $("mull-note").textContent = "";
      setTotal(null, "none");
      return;
    }
    const { card, whose } = pick(wf, who);
    const live = wf.holes.filter((h) => h.status !== "skipped");
    const counted = live.length >= 2 ? live.length - 1 : 0;
    $("card-sub").textContent = `Week ${wf.week + 1}, from ${day(wf.start)} (UTC) · ${wf.final ? "final" : "in play"} · ${live.length} holes, par ${G.PAR * counted} after the mulligan`
      + (whose === "leader" ? " · showing the leader's card" : "");
    const byHole = new Map(card ? card.holes.map((x) => [x[0], x]) : []);
    let n = 0;
    body.replaceChildren(...wf.holes.map((h) => {
      if (h.status === "skipped") {
        return el("tr", { class: "gf-off" }, el("td", { class: "gf-hole", text: "–" }), gameCell(h.id, h.name),
          el("td", { class: "hide-sm", text: "" }), el("td", { class: "num", text: "–" }),
          el("td", { class: "num" }, el("span", { class: "gf-tag", text: "Skipped" }), el("span", { class: "gf-name", text: h.why || "" })));
      }
      n++;
      const x = byHole.get(h.id);
      const s = x ? x[1] : G.LOST;
      const dropped = card && card.mulligan === h.id;
      const placeText = x && x[2] ? `${ord(x[2])} of ${x[3]}` : card || whose === "me-empty" ? "Didn't play" : "–";
      const scoreCell = card || whose === "me-empty"
        ? el("td", { class: "num" }, mark(s), el("span", { class: "gf-name", text: dropped ? `${G.NAMES[s]} · mulligan` : G.NAMES[s] }))
        : el("td", { class: "num", text: "–" });
      const game = gameCell(h.id, h.name);
      if (h.status === "live") game.append(el("span", { class: "gf-tag live", text: wf.final ? "" : "so far" }));
      return el("tr", { class: dropped ? "gf-dropped" : null }, el("td", { class: "gf-hole", text: String(n) }), game,
        el("td", { class: "hide-sm gf-place", text: placeText }), el("td", { class: "num", text: String(G.PAR) }), scoreCell);
    }));
    $("par-total").textContent = card ? String(card.par) : counted ? String(G.PAR * counted) : "–";
    $("strokes-total").textContent = card ? String(card.strokes) : whose === "me-empty" && counted ? String(G.LOST * counted) : "–";
    $("mull-note").textContent = card ? `(mulligan: ${games.get(card.mulligan)?.name || card.mulligan})` : "";
    setTotal(card, whose, wf);
    const share = $("share");
    share.disabled = !(card && whose === "me");
  }

  function setTotal(card, whose, wf) {
    const b = $("total-par");
    b.className = "";
    if (!card) {
      b.textContent = "–";
      $("total-label").textContent = "Your week";
      $("total-line").textContent = whose === "me-empty" ? "No holes played yet this week" : whose === "none" ? "The course isn't open yet" : "Connect a wallet to see your card";
      return;
    }
    b.textContent = G.toParText(card.toPar);
    if (card.toPar < 0) b.className = "under"; else if (card.toPar > 0) b.className = "over";
    $("total-label").textContent = whose === "leader" ? "This week's leader" : showing === "last" ? "Your last week" : "Your week";
    $("total-line").textContent = `${card.strokes} on par ${card.par} · ${card.pts} pts · ${ord(card.place)} of ${wf.cards.length}${whose === "leader" ? ` · ${short(card.a)}` : ""}`;
  }

  function drawTodo() {
    const wf = weeks.this, who = me();
    const box = $("todo-box");
    if (!wf || !who || wf.final) { box.hidden = true; return; }
    const card = wf.cards.find((c) => c.a === who);
    const played = new Set(card ? card.holes.filter((x) => x[2] !== null).map((x) => x[0]) : []);
    const todo = wf.holes.filter((h) => h.status !== "skipped" && !played.has(h.id));
    box.hidden = !todo.length;
    $("todo").replaceChildren(...todo.map((h) => {
      const g = games.get(h.id);
      const href = g && typeof g.href === "string" && /^[a-z0-9-]+\.html(#[a-z0-9/-]*)?$/.test(g.href) ? g.href : "games.html";
      return el("a", { href, text: `Play ${(g && g.name) || h.name}` });
    }));
  }

  function drawBoard() {
    if (!window.KBoard) return;
    if (!lb) {
      lb = window.KBoard.create($("gf-board"), {
        label: "Block Golf leaderboard",
        columns: [{ key: "pts", label: "Points" }, { key: "topar", label: "To par" }, { key: "holes", label: "Holes played", wide: true }, { key: "lost", label: "Lost balls", wide: true }],
        name: short, link: (a) => EXPLORER + a,
        scored: (r) => r.pts > 0,
        summary: (r) => `${G.toParText(r.topar)} · ${r.pts} pts`,
        me: (r, place) => `${place ? `You: #${place} at` : "Your score (only you see this):"} ${G.toParText(r.toPar)}, ${r.pts} points.`,
        unranked: "To be ranked, hold at least 1 VHP or stake in Knode Games.",
        free: { show: 6, prize: "Practice weeks have no prizes. Once the vault is live, Block Golf is a staked game." },
      });
    }
    lb.setMe(me());
    if (board) lb.set(board);
  }

  function drawAll() { drawCard(); drawTodo(); drawBoard(); }

  $("wk-this").addEventListener("click", () => { showing = "this"; drawCard(); });
  $("wk-last").addEventListener("click", () => { if (weeks.last) { showing = "last"; drawCard(); } });
  $("share").addEventListener("click", async () => {
    const wf = weeks[showing], card = wf && wf.cards.find((c) => c.a === me());
    if (!card) return;
    const text = G.shareText(card, wf.week) + "\nhttps://bawcejawn.github.io/Knode/site/golf.html";
    const pre = $("share-text");
    pre.textContent = text; pre.hidden = false;
    try { await navigator.clipboard.writeText(text); $("share-note").textContent = "Copied. Paste it anywhere."; }
    catch { $("share-note").textContent = "Select the text below and copy it."; }
  });

  async function load() {
    drawKey();
    try {
      const gj = await fetchJson("games.json");
      for (const g of Array.isArray(gj.games) ? gj.games : []) if (g && typeof g.id === "string") games.set(g.id, { name: typeof g.name === "string" ? g.name : g.id, href: g.status === "live" ? g.href : null });
    } catch { /* names fall back to the recorder's */ }
    try {
      const idx = await fetchJson(DATA + "index.json");
      const list = Array.isArray(idx.weeks) ? idx.weeks.filter((w) => Number.isInteger(w) && w >= 0) : [];
      const last2 = list.slice(-2);
      const files = await Promise.all(last2.map((w) => fetchJson(DATA + wName(w)).catch(() => null)));
      const ok = files.filter((f) => f && f.v === 1 && Array.isArray(f.holes) && Array.isArray(f.cards));
      weeks.this = ok[ok.length - 1] || null;
      weeks.last = ok.length > 1 ? ok[ok.length - 2] : null;
      board = await fetchJson(DATA + "board.json").catch(() => null);
      say(weeks.this ? "" : "No Block Golf week yet.");
    } catch {
      say("Block Golf opens with Who Signs Block X. Until then, play the games: every one of them will be a hole.");
    }
    drawAll();
  }

  if (window.KWallet && window.KWallet.subscribe) window.KWallet.subscribe(drawAll);
  setInterval(() => { if (!document.hidden) load(); }, 600000);
  load();
})();

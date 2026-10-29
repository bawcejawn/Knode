/* Knode Games leaderboard: one box shared by every game page. Today / This week / All time, the week's top 3 on a
 * podium, the player's own row marked, and a line telling the player where they stand.
 *
 * A game page links board.css and board.js, then passes its board data (the recorder's board.json shape: { today, week, lastWeek, allTime }, each with
 * rows) and says which columns to show. Everything is built with textContent, never HTML, so names and numbers from
 * data files can't inject markup. No network, no storage, no wallet: the page passes the player's address.
 *
 *   const lb = KBoard.create(hostElement, {
 *     label: "Race leaderboard",
 *     columns: [{ key: "pts", label: "Points" }, { key: "correct", label: "Wins" }, { key: "picks", label: "Picks", wide: true }],
 *     summary: (row) => "14 pts · 3 wins",   // one line under each podium place
 *     scored: (row) => row.pts > 0,          // only scoring rows reach the podium
 *     me: (row, place) => "You: #4 …",       // the player's line (place is null when not ranked)
 *     link: (addr) => "https://…",           // optional: each wallet links here
 *     name: (addr) => "1Ab…9xT",             // how a wallet is shown
 *     unranked: "To be ranked, …",           // shown to a player who is listed but not ranked
 *     free: { show: 6, prize: "1st and 2nd collect the weekly free-play prize." },
 *                                            // optional: a second board for wallets without VHP or a stake (rows with
 *                                            // ranked: false). Only its top `show` are listed; everyone else stays
 *                                            // hidden, and a free player sees their own place privately.
 *   });
 *   lb.set(boardJson); lb.setMe(address);
 */
(function (root) {
  "use strict";
  const MEDAL = ["🥇", "🥈", "🥉"], ORD = ["1st", "2nd", "3rd"];
  const LABELS = Object.freeze({ staked: "Staked", free: "Free play" });   // the same in every game
  // "Last week" appears only when the data has it, so the week that just ended stays visible on Monday.
  const MODES = [["today", "Today"], ["week", "This week"], ["last", "Last week"], ["all", "All time"]];
  let n = 0;

  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined) continue;
      if (k === "text") e.textContent = v; else e.setAttribute(k, v);
    }
    for (const c of kids) if (c) e.append(c);
    return e;
  }
  const fmt = (x) => (typeof x === "number" && isFinite(x) ? x.toLocaleString("en-US") : "–");
  const short = (a) => (typeof a === "string" && a.length > 12 ? a.slice(0, 4) + "…" + a.slice(-4) : String(a || ""));
  const day = (t) => new Date(t).toLocaleDateString("en-US", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

  /** The rows for one view, ranked rows only, in the order the data gives (the recorder already sorted them). */
  function partOf(data, mode) {
    if (!data) return null;
    return mode === "today" ? data.today : mode === "all" ? data.allTime : mode === "last" ? data.lastWeek : data.week;
  }

  function create(host, opt) {
    const id = "kb" + ++n, o = Object.assign({ columns: [], name: short, scored: () => true, summary: () => "", me: null, link: null, unranked: "" }, opt || {});
    let data = null, mode = "week", who = "", kind = "main";
    // The two boards have the same names in every game (owner, 2026-10-28): KBoard.LABELS, never set per game.
    const F = o.free ? { show: Number.isInteger(o.free.show) ? o.free.show : 6, prize: typeof o.free.prize === "string" ? o.free.prize : "", main: LABELS.staked, label: LABELS.free } : null;
    const kinds = F ? [["main", F.main], ["free", F.label]].map(([k, label]) => {
      const b = el("button", { type: "button", "aria-pressed": String(k === kind), text: label });
      b.addEventListener("click", () => { kind = k; kinds.forEach((x) => x.setAttribute("aria-pressed", String(x === b))); render(); });
      return b;
    }) : [];
    const btns = MODES.map(([m, label]) => {
      const b = el("button", { type: "button", id: `${id}-${m}`, "aria-pressed": String(m === mode), text: label });
      b.addEventListener("click", () => { mode = m; btns.forEach((x, i) => x.setAttribute("aria-pressed", String(MODES[i][0] === m))); render(); });
      return b;
    });
    const sub = el("p", { class: "note kb-sub" });
    const podium = el("div", { class: "champs kb-podium" });
    const body = el("tbody");
    const head = el("tr", {}, el("th", { text: "#" }), el("th", { text: "Wallet" }),
      ...o.columns.map((c) => el("th", { class: "num" + (c.wide ? " hide-sm" : ""), text: c.label })));
    const mine = el("p", { class: "note kb-me", role: "status" });
    host.classList.add("kb");
    host.replaceChildren(
      F ? el("div", { class: "tabs2 kb-kinds", role: "group", "aria-label": "Who" }, ...kinds) : null,
      el("div", { class: "tabs2", role: "group", "aria-label": o.label || "Leaderboard" }, ...btns),
      sub, podium,
      el("div", { class: "table-scroll" }, el("table", { class: "hist kb-table" }, el("thead", {}, head), body)),
      mine);

    function render() {
      const part = partOf(data, mode), rows = (part && Array.isArray(part.rows)) ? part.rows : [];
      const weekly = mode === "week" || mode === "last";
      btns[2].hidden = !(data && data.lastWeek);
      if (mode === "last" && btns[2].hidden) { mode = "week"; btns.forEach((x, i) => x.setAttribute("aria-pressed", String(MODES[i][0] === mode))); return render(); }
      if (F && kind === "free") return renderFree(part, rows, weekly);
      const ranked = rows.filter((r) => r && r.ranked);
      sub.textContent = weekly && part && part.start ? `Week ${part.week + 1}, from ${day(part.start)} (UTC)` : mode === "today" && part && part.day ? `${part.day} (UTC)` : mode === "all" ? "Every week so far" : "";
      // Audit BX-41: the row's own-board place (boardPlace, ties share it) when the game publishes one.
      const placeOf = (r, i) => (Number.isInteger(r.boardPlace) && r.boardPlace > 0 ? r.boardPlace : i + 1);
      podium.replaceChildren(...(weekly ? ranked.map((r, i) => [r, placeOf(r, i)]).filter(([r, p]) => p <= 3 && o.scored(r)).slice(0, 10).map(([r, p]) =>
        el("div", { class: "champ" + (r.a === who ? " me" : "") }, el("b", { text: `${MEDAL[p - 1]} ${ORD[p - 1]}` }), el("span", { class: "mono", text: o.name(r.a) }), el("div", { class: "ago", text: o.summary(r) }))) : []));
      body.replaceChildren(...ranked.slice(0, 50).map((r, i) => {
        const href = o.link ? o.link(r.a) : null, pl = placeOf(r, i);
        return el("tr", { class: [pl <= 3 && weekly && o.scored(r) ? "top" : "", r.a === who ? "me" : ""].join(" ").trim() || null },
          el("td", { text: pl <= 3 && o.scored(r) ? MEDAL[pl - 1] : String(pl) }),
          el("td", { class: "mono" }, href ? el("a", { href, target: "_blank", rel: "noopener noreferrer", text: o.name(r.a) }) : el("span", { text: o.name(r.a) })),
          ...o.columns.map((c) => el("td", { class: "num" + (c.wide ? " hide-sm" : ""), text: fmt(r[c.key]) })));
      }));
      if (!ranked.length) body.replaceChildren(el("tr", {}, el("td", { colspan: String(2 + o.columns.length), class: "ago", text: "No ranked players yet." })));
      const row = who && rows.find((r) => r && r.a === who);
      const place = row && row.ranked ? placeOf(row, ranked.indexOf(row)) : null;
      mine.textContent = !who ? "" : !row ? "You have no finished picks here yet." : o.me ? o.me(row, place) : place ? `You: #${place}.` : "";
      if (row && !row.ranked && o.unranked) mine.append(" ", o.unranked);
      if (row && !row.ranked && F) mine.append(" ", `Your place is on the ${F.label} board.`);
    }

    /** Free play: wallets without VHP or a stake. Only the top F.show are listed; the rest stay hidden. */
    function renderFree(part, rows, weekly) {
      const free = rows.filter((r) => r && !r.ranked && o.scored(r));
      sub.textContent = [weekly && F.prize ? F.prize : "", `Top ${F.show} shown; everyone else stays private.`].filter(Boolean).join(" ");
      podium.replaceChildren();
      const shown = free.slice(0, F.show);
      // o.freeWinners(part, rows, weekly) → Map(address → 1 | 2): who gets a medal (a game's own prize rule and ties).
      // Without it, the top 2 of a weekly board. Shown places use the row's own-board place (boardPlace) when present.
      const win = o.freeWinners ? o.freeWinners(part, free, weekly) : null;
      const medal = (r, i) => (win ? win.get(r.a) || 0 : weekly && i < 2 ? i + 1 : 0);
      body.replaceChildren(...shown.map((r, i) => el("tr", { class: [medal(r, i) ? "top" : "", r.a === who ? "me" : ""].join(" ").trim() || null },
        el("td", { text: medal(r, i) ? MEDAL[medal(r, i) - 1] : String(r.boardPlace || i + 1) }),
        el("td", { class: "mono" }, el("span", { text: o.name(r.a) })),
        ...o.columns.map((c) => el("td", { class: "num" + (c.wide ? " hide-sm" : ""), text: fmt(r[c.key]) })))));
      if (!shown.length) body.replaceChildren(el("tr", {}, el("td", { colspan: String(2 + o.columns.length), class: "ago", text: "No free-play scores yet." })));
      const row = who && rows.find((r) => r && r.a === who);
      const place = row && !row.ranked ? free.indexOf(row) + 1 : 0;
      mine.textContent = !who ? "" : !row ? "You have no finished picks here yet."
        : row.ranked ? `You play on the ${F.main} board.`
        : place ? `You: #${place} in free play${place > F.show ? " (only you see this)" : ""}.` : "No points yet this period.";
    }
    render();
    return {
      set(d) { data = d && typeof d === "object" ? d : null; render(); },
      setMe(a) { who = typeof a === "string" ? a : ""; render(); },
      mode: () => mode,
    };
  }

  root.KBoard = { create, partOf, LABELS };
})(typeof window !== "undefined" ? window : globalThis);

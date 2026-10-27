/* KnodeGames leaderboard: one box shared by every game page. Today / This week / All time, the week's top 3 on a
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
 *   });
 *   lb.set(boardJson); lb.setMe(address);
 */
(function (root) {
  "use strict";
  const MEDAL = ["🥇", "🥈", "🥉"], ORD = ["1st", "2nd", "3rd"];
  const MODES = [["today", "Today"], ["week", "This week"], ["all", "All time"]];
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
    return mode === "today" ? data.today : mode === "all" ? data.allTime : data.week;
  }

  function create(host, opt) {
    const id = "kb" + ++n, o = Object.assign({ columns: [], name: short, scored: () => true, summary: () => "", me: null, link: null, unranked: "" }, opt || {});
    let data = null, mode = "week", who = "";
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
      el("div", { class: "tabs2", role: "group", "aria-label": o.label || "Leaderboard" }, ...btns),
      sub, podium,
      el("div", { class: "table-scroll" }, el("table", { class: "hist kb-table" }, el("thead", {}, head), body)),
      mine);

    function render() {
      const part = partOf(data, mode), rows = (part && Array.isArray(part.rows)) ? part.rows : [];
      const ranked = rows.filter((r) => r && r.ranked);
      sub.textContent = mode === "week" && part && part.start ? `Week ${part.week + 1}, from ${day(part.start)} (UTC)` : mode === "today" && part && part.day ? `${part.day} (UTC)` : mode === "all" ? "Every week so far" : "";
      podium.replaceChildren(...(mode === "week" ? ranked.slice(0, 3).filter(o.scored).map((r, i) =>
        el("div", { class: "champ" + (r.a === who ? " me" : "") }, el("b", { text: `${MEDAL[i]} ${ORD[i]}` }), el("span", { class: "mono", text: o.name(r.a) }), el("div", { class: "ago", text: o.summary(r) }))) : []));
      body.replaceChildren(...ranked.slice(0, 50).map((r, i) => {
        const href = o.link ? o.link(r.a) : null;
        return el("tr", { class: [i < 3 && mode === "week" && o.scored(r) ? "top" : "", r.a === who ? "me" : ""].join(" ").trim() || null },
          el("td", { text: i < 3 && o.scored(r) ? MEDAL[i] : String(i + 1) }),
          el("td", { class: "mono" }, href ? el("a", { href, target: "_blank", rel: "noopener noreferrer", text: o.name(r.a) }) : el("span", { text: o.name(r.a) })),
          ...o.columns.map((c) => el("td", { class: "num" + (c.wide ? " hide-sm" : ""), text: fmt(r[c.key]) })));
      }));
      if (!ranked.length) body.replaceChildren(el("tr", {}, el("td", { colspan: String(2 + o.columns.length), class: "ago", text: "No ranked players yet." })));
      const row = who && rows.find((r) => r && r.a === who);
      const place = row && row.ranked ? ranked.indexOf(row) + 1 : null;
      mine.textContent = !who ? "" : !row ? "You have no finished picks here yet." : o.me ? o.me(row, place) : place ? `You: #${place}.` : "";
      if (row && !row.ranked && o.unranked) mine.append(" ", o.unranked);
    }
    render();
    return {
      set(d) { data = d && typeof d === "object" ? d : null; render(); },
      setMe(a) { who = typeof a === "string" ? a : ""; render(); },
      mode: () => mode,
    };
  }

  root.KBoard = { create, partOf };
})(typeof window !== "undefined" ? window : globalThis);

/* The Results page (index.html#results): one tab per game, past and present.
   "Daily Questions" is the question game's own results (drawn by app.js). Every other live game in games.json with
   `"results": true` and a drawing below gets its own tab: index.html#results/race and so on.
   Producer Race: every recorded week from the race recorder (race-data branch: index.json + W###.json), a day at a
   time, each race with its winner, top 3, how the picks went, the player's own pick and points, and the full standings.
   "Only mine" and search look through the whole week.
   Read-only: no transaction, no storage, everything built with textContent. */
(() => {
  "use strict";
  const host = document.getElementById("res-games");
  const M = window.KRaceMath;
  if (!host || !M) return;
  const W = window.KWallet;
  const RAW = "https://raw.githubusercontent.com/bawcejawn/Knode/";
  const EXPLORER = "https://koinosscan.com/address/";
  const NAMES = { "1Mpmf2ERhjYpX7CCiM11WERuM4j17uT1sr": "Knode Games pool", "1FKTpXBhhHEbu5vVchM8UsVbAvPArJsRmR": "Knode Games Swap" };
  const ADDR = /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/;
  const $ = (id) => document.getElementById(id);
  const me = () => (W && W.address) || "";
  // Producer names (names.js): "Name · 1Abc12…wxyz", or the short address.
  const nameOf = (a) => (window.KNames && typeof a === "string" ? window.KNames.of(a) : NAMES[a] || (typeof a === "string" ? a.slice(0, 5) + "…" + a.slice(-4) : ""));
  const fmt = (n, d = 0) => (typeof n === "number" && isFinite(n) ? n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }) : "–");
  const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const utcTime = (t) => new Date(t).toISOString().slice(11, 16) + " UTC";
  const utcDay = (t) => new Date(t).toLocaleDateString("en-US", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) { if (v == null) continue; if (k === "text") e.textContent = v; else e.setAttribute(k, v); }
    for (const c of kids) if (c != null && c !== false) e.append(c);
    return e;
  }
  async function fetchJson(url) { const r = await fetch(url, { cache: "no-cache" }); if (!r.ok) throw new Error(String(r.status)); return r.json(); }
  const link = (a) => (ADDR.test(a) ? el("a", { href: EXPLORER + a, target: "_blank", rel: "noopener noreferrer", class: "mono", text: nameOf(a) }) : el("span", { text: "–" }));

  // ───────────────── Producer Race ─────────────────
  const race = {
    weeks: null, files: new Map(), week: null, day: null, mine: false, q: "",
    async open(box) {
      this.box = box;
      if (!this.weeks) {
        box.replaceChildren(el("p", { class: "muted", text: "Loading race results…" }));
        try {
          const ix = await fetchJson(RAW + "race-data/index.json");
          this.weeks = (ix && Array.isArray(ix.weeks) ? ix.weeks : []).filter((w) => Number.isInteger(w) && w >= 0 && w < 10000).sort((a, b) => b - a);
        } catch { box.replaceChildren(el("p", { class: "muted", text: "Couldn't load race results right now. Try again in a moment." })); return; }
      }
      if (!this.weeks.length) { box.replaceChildren(el("div", { class: "empty", text: "No races recorded yet." })); return; }
      if (this.week == null || !this.weeks.includes(this.week)) this.week = this.weeks[0];
      await this.load(this.week);
      this.draw();
    },
    async load(w) {
      if (this.files.has(w)) return;
      try {
        const f = await fetchJson(RAW + `race-data/W${String(w).padStart(3, "0")}.json`);
        if (f && f.v === 1 && f.week === w && Array.isArray(f.races)) this.files.set(w, f);
      } catch { /* drawn as "couldn't load" */ }
    },
    /** One race's facts, from the recorder's file. */
    facts(r) {
      const now = Date.now(), res = r.result;
      const status = now < r.start ? "up" : now < r.end ? "live" : !res ? "checking" : res.missed ? "missed" : res.final ? "final" : "checking";
      const st = status === "final" && Array.isArray(res.standings) ? res.standings : [];
      const picks = status === "final" && Array.isArray(res.picks) ? res.picks : [];
      const wins = M.winners(st), show = M.shows(st);
      const isWin = (p) => p[3] === 1, isShow = (p) => !isWin(p) && (p.length > 5 ? p[5] === 1 : show.includes(p[1]));
      const my = me() ? picks.find((p) => p[0] === me()) : null;
      return { r, status, st, picks, wins, show, isWin, isShow, my, myPts: my ? (isWin(my) ? M.POINTS.win : isShow(my) ? M.POINTS.show : 0) : 0 };
    },
    draw() {
      const f = this.files.get(this.week), box = this.box;
      const weekStart = M.weekStart(this.week), now = Date.now();
      const all = f ? f.races.map((r) => this.facts(r)).filter((x) => x.status !== "up") : [];
      const dayOf = (x) => Math.floor((x.r.start - weekStart) / M.DAY);
      const ended = all.filter((x) => x.status !== "live");
      if (this.day == null || !all.some((x) => dayOf(x) === this.day)) this.day = ended.length ? dayOf(ended[ended.length - 1]) : 0;

      // Band: title, the player's week, weeks and days.
      const mineAll = all.filter((x) => x.my);
      const score = me() ? el("p", { class: "rband-score" }, el("b", { text: fmt(mineAll.reduce((s, x) => s + x.myPts, 0)) }), ` pts this week · ${mineAll.length} pick${mineAll.length === 1 ? "" : "s"}`)
        : el("p", { class: "rband-score", text: `${ended.filter((x) => x.status === "final").length} races final this week` });
      const weeks = el("div", { class: "rweeks", role: "group", "aria-label": "Week" }, ...this.weeks.map((w) => {
        const b = el("button", { type: "button", "aria-pressed": String(w === this.week), text: w === M.weekOf(now) ? `This week (${w + 1})` : `Week ${w + 1}` });
        b.addEventListener("click", async () => { this.week = w; this.day = null; await this.load(w); this.draw(); });
        return b;
      }));
      const days = el("div", { class: "rdays", role: "group", "aria-label": "Day" }, ...DAYS.map((d, i) => {
        const has = all.some((x) => dayOf(x) === i);
        const b = el("button", { type: "button", "aria-pressed": String(i === this.day && !this.mine && !this.q), text: d });
        if (!has) b.disabled = true;
        b.addEventListener("click", () => { this.day = i; this.mine = false; this.q = ""; this.draw(); });
        return b;
      }));
      const band = el("div", { class: "rband" }, el("div", { class: "rband-top" }, el("h1", { text: "Race results" }), score), weeks, days);

      // Tools: search the week, only mine.
      const search = el("input", { type: "search", "aria-label": "Find a producer or wallet", placeholder: "Find a producer or wallet", autocomplete: "off" });
      search.value = this.q;
      search.addEventListener("input", () => { this.q = search.value.trim(); this.drawList(); });
      const mineBtn = el("button", { type: "button", class: "rmine", "aria-pressed": String(this.mine), text: "Only mine" });
      mineBtn.hidden = !me();
      mineBtn.addEventListener("click", () => { this.mine = !this.mine; mineBtn.setAttribute("aria-pressed", String(this.mine)); this.drawList(); });
      const tools = el("div", { class: "rtools" }, el("label", { class: "rsearch" }, search), mineBtn);

      this.list = el("div", { class: "results rr-list" });
      this.all = all; this.dayOf = dayOf;
      box.replaceChildren(band, tools, f ? this.list : el("div", { class: "empty", text: "Couldn't load this week's races. Try again in a moment." }),
        el("p", { class: "muted res-foot" }, "Results become final once their blocks are irreversible and two nodes agree. ", el("a", { href: "race.html", text: "Watch the live race" }), " · ", el("a", { href: "index.html#leaderboard/race", text: "Race leaderboard" })));
      if (f) this.drawList();
    },
    drawList() {
      const q = this.q.toLowerCase();
      const hit = (x) => !q || [x.r.id, ...x.st.slice(0, 3).map((s) => s.a), ...x.picks.map((p) => p[0]), ...x.picks.map((p) => p[1]), ...x.st.slice(0, 3).map((s) => nameOf(s.a))].some((t) => String(t).toLowerCase().includes(q));
      const filtered = this.mine || q ? this.all.filter((x) => (!this.mine || x.my) && hit(x)) : this.all.filter((x) => this.dayOf(x) === this.day);
      const rows = filtered.slice().sort((a, b) => b.r.start - a.r.start);
      this.list.replaceChildren(...(rows.length ? rows.map((x) => this.card(x))
        : [el("div", { class: "empty", text: this.mine ? "No picks of yours this week." : q ? "Nothing matches that search this week." : "No races finished on this day yet." })]));
    },
    card(x) {
      const { r, status } = x;
      const PILL = { live: "Live now", final: "Final", checking: "Checking", missed: "Not recorded" };
      const head = el("div", { class: "rr-head" },
        el("h3", {}, `Race ${Math.floor((r.start % M.DAY) / M.RACE) + 1} · ${utcDay(r.start)}, ${utcTime(r.start)}`),
        el("span", { class: `rr-pill ${status}`, text: PILL[status] || status }));
      const body = [];
      if (status === "live") body.push(el("p", { class: "res-line" }, "This race is running now. ", el("a", { href: "race.html", text: "Watch it live" })));
      else if (status === "missed") body.push(el("p", { class: "res-line muted", text: "This race wasn't recorded, so it scores nobody." }));
      else if (status === "checking") body.push(el("p", { class: "res-line muted", text: "Finished: the result is being checked against two nodes. It's final within a few hours." }));
      else {
        const MED = ["🥇", "🥈", "🥉"];
        body.push(el("ol", { class: "rr-podium" }, ...x.st.slice(0, 3).map((s, i) => el("li", {}, el("span", { class: "rr-med", text: MED[i] }), link(s.a), el("span", { class: "muted", text: ` ${fmt(s.steps, 1)} steps` })))));
        const nW = x.picks.filter(x.isWin).length, nS = x.picks.filter(x.isShow).length;
        body.push(el("p", { class: "res-line rr-picks" }, x.picks.length ? `${x.picks.length} pick${x.picks.length === 1 ? "" : "s"}: ${nW} won, ${nS} showed` : "No picks on this race."));
        if (x.my) {
          const outcome = x.isWin(x.my) ? `won · +${M.POINTS.win} pts` : x.isShow(x.my) ? `showed · +${M.POINTS.show} pt` : "missed · 0 pts";
          body.push(el("p", { class: `res-line rr-mine ${x.myPts ? "ok" : ""}` }, el("b", { text: "You: " }), link(x.my[1]), ` ${outcome}`));
        }
        body.push(el("details", { class: "res-how" }, el("summary", {}, "Full standings"),
          el("div", { class: "table-wrap" }, el("table", { class: "board rr-table" },
            el("thead", {}, el("tr", {}, el("th", { text: "#" }), el("th", { text: "Producer" }), el("th", { class: "num", text: "Steps" }), el("th", { class: "num", text: "Blocks" }))),
            el("tbody", {}, ...x.st.map((s, i) => el("tr", { class: x.my && x.my[1] === s.a ? "me" : null }, el("td", { text: String(i + 1) }), el("td", {}, link(s.a)), el("td", { class: "num", text: fmt(s.steps, 1) }), el("td", { class: "num", text: fmt(s.blocks) }))))))));
      }
      return el("article", { class: `res rr res-st-${status === "final" ? (x.my ? (x.myPts ? "right" : "wrong") : "none") : "wait"}` }, head, ...body);
    },
  };

  // ───────────────── tabs ─────────────────
  // A drawing per game; a game shows here when games.json says `"results": true` and it has a drawing.
  const ADAPTERS = { race };
  let games = [{ id: "questions", name: "Daily Questions" }], current = "questions";
  const qPart = $("res-q"), gPart = $("res-g");

  function buttons() {
    host.replaceChildren(...games.map((g) => {
      const b = el("button", { type: "button", "aria-pressed": String(g.id === current), text: g.name });
      b.addEventListener("click", () => { location.hash = g.id === "questions" ? "#results" : `#results/${g.id}`; });
      return b;
    }));
  }
  function show(id) {
    if (!games.some((g) => g.id === id)) id = "questions";
    current = id; buttons();
    qPart.hidden = id !== "questions"; gPart.hidden = id === "questions";
    if (id !== "questions") ADAPTERS[id].open(gPart);
  }
  function route() { const [view, sub] = (location.hash || "").slice(1).split("/"); if (view === "results") show(sub || "questions"); }
  async function load() {
    try {
      const list = (await fetchJson("games.json")).games;
      const extra = (Array.isArray(list) ? list : []).filter((g) => g && g.status === "live" && g.results === true && ADAPTERS[g.id]
        && typeof g.name === "string" && g.name.length <= 40).map((g) => ({ id: g.id, name: g.name }));
      games = [games[0], ...extra];
    } catch { /* only the question game */ }
    buttons(); route();
  }
  if (window.KNames) window.KNames.onChange(() => { if (current !== "questions" && ADAPTERS[current]) ADAPTERS[current].open(gPart); });
  window.addEventListener("hashchange", route);
  if (W && W.subscribe) W.subscribe(() => { if (current !== "questions" && race.weeks) race.draw(); });
  load();
})();

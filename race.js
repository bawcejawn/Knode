/* race.html: the Producer Race page. Read only: it reads blocks and VHP from the chain and the race recorder's public
   files (race-data branch). It never signs or sends anything. The scoring is race-math.js, the same file the
   recorder (bot/race.ts) uses.
   - The live race is scored here from the chain, with the recorder's handicap cards. Until the recorder has published
     a card, the page makes a provisional one from VHP right now and says so.
   - Finished races show the recorder's final result; a race that has ended but is not final yet is scored here and
     marked "checking". */
(() => {
  "use strict";
  const M = window.KRaceMath;
  if (!M || typeof document === "undefined" || !document.getElementById("track")) return;

  const lib = window.koilib || window.koinos || window;
  const RPC = "https://koinos.armana.io";
  const DATA = "https://raw.githubusercontent.com/bawcejawn/Knode/race-data/";
  const VHP = "12Y5vW6gk8GceH53YfRkRre2Rrcsgw7Naq";
  const EXPLORER = "https://koinosscan.com/address/";
  const NAMES = { "1Mpmf2ERhjYpX7CCiM11WERuM4j17uT1sr": "Knode Games pool", "1FKTpXBhhHEbu5vVchM8UsVbAvPArJsRmR": "Knode Games Swap" };
  const COLORS = ["#2F6B4F", "#F2B33D", "#B4432F", "#3E6FB0", "#8A4FB0", "#23845E", "#FF8A4C", "#5E6B63", "#C2547F", "#2D8C9E", "#9C7A2B", "#4B5BD6", "#7A9A3A", "#D9693F", "#6C4A3B", "#1F7A7A", "#A23B72", "#557C00", "#CC5500", "#456990"];
  try { localStorage.removeItem("pr-guesses-v1"); } catch { /* the old rolling race's guesses are retired */ }

  const provider = new lib.Provider([RPC]);
  const types = { nested: { t: { nested: {
    balance_of_arguments: { fields: { owner: { type: "bytes", id: 1, options: { "(koinos.btype)": "ADDRESS" } } } },
    balance_of_result: { fields: { value: { type: "uint64", id: 1, options: { jstype: "JS_STRING" } } } },
  } } } };
  const vhpToken = new lib.Contract({ id: VHP, provider, abi: { methods: { balance_of: { entry_point: 0x5c721497, argument: "t.balance_of_arguments", return: "t.balance_of_result", read_only: true } }, koilib_types: types } });

  const $ = (id) => document.getElementById(id);
  const el = (tag, attrs = {}, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (k === "text") e.textContent = v; else if (k.startsWith("on")) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v); } for (const c of kids) if (c != null) e.append(c); return e; };
  const say = (t) => { $("status").textContent = t; };
  const nameOf = (a) => NAMES[a] || a.slice(0, 5) + "…" + a.slice(-4);
  /** A pick scored a show (its horse finished 2nd or 3rd): the recorder's 6th field, or for races recorded before
   *  Show existed, worked out from the race's stored standings with the same rule (race-math.js). */
  const isShow = (result, p) => !p[3] && (p.length > 5 ? p[5] === 1 : !!result && Array.isArray(result.standings) && M.shows(result.standings).includes(p[1]));
  const fmt = (n, d = 0) => Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
  const clock = (t) => new Date(t).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const dayTime = (t) => new Date(t).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
  const dur = (ms) => { const m = Math.max(0, Math.ceil(ms / 60000)); return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min` : `${m} min`; };
  const colorOf = new Map();
  const colour = (a) => { if (!colorOf.has(a)) colorOf.set(a, COLORS[colorOf.size % COLORS.length]); return colorOf.get(a); };

  let B = null, headT = 0, weeks = new Map(), prov = null, view = null, histMode = "today", lastTop = 0;
  // Steps and blocks each horse had at the last refresh, to flash "+steps" on the horses that moved since.
  let seen = { race: null, steps: new Map(), blocks: new Map() };

  // ── data ──
  async function fetchJson(url) { const r = await fetch(url, { cache: "no-cache" }); if (!r.ok) throw new Error(String(r.status)); return r.json(); }
  async function loadWeeks(ws) {
    for (const w of ws) {
      try { const j = await fetchJson(`${DATA}W${String(w).padStart(3, "0")}.json`); if (j && j.v === 1 && j.week === w && Array.isArray(j.races)) weeks.set(w, j); }
      catch { /* no file yet: the recorder hasn't run for that week */ }
    }
  }
  const recorded = (id) => { for (const wf of weeks.values()) { const r = wf.races.find((x) => x.id === id); if (r) return r; } return null; };
  /** A race as the page uses it: times, the recorder's cards (or the provisional card), and its result if final. */
  function raceObj(index) {
    const start = M.raceStart(index), id = M.raceId(index), rec = recorded(id);
    const cards = rec && Array.isArray(rec.cards) && rec.cards.some(Boolean) ? rec.cards : null;
    return { index, id, start, end: start + M.RACE, number: ((index % 4) + 4) % 4 + 1, cards: cards || (prov ? [prov, ...new Array(M.LEGS - 1).fill(null)] : null), provisional: !cards, result: rec && rec.result };
  }
  async function readVhp(addrs) {
    const out = [], queue = addrs.slice();
    const worker = async () => { while (queue.length) { const a = queue.shift(); for (let t = 0; ; t++) { try { const r = await vhpToken.functions.balance_of({ owner: a }); out.push([a, Number((r.result && r.result.value) || 0) / 1e8]); break; } catch (e) { if (t >= 2) throw e; await new Promise((r) => setTimeout(r, 800 * (t + 1))); } } } };
    await Promise.all(Array.from({ length: 4 }, worker));
    return out;
  }
  /** Until the recorder has a card for the race, one made here from VHP right now (same math, marked provisional). */
  async function provisionalCard() {
    if (prov && Date.now() - prov.madeHere < 600000) return;
    const i0 = M.lowerBound(B.ts, headT - M.RACE), seen = new Set();
    for (let i = i0; i < B.sig.length; i++) seen.add(B.signers[B.sig[i]]);
    const span = headT - B.ts[i0], bpr = span > 0 ? (B.sig.length - 1 - i0) * M.RACE / span : 7200;
    prov = { ...M.makeCard(await readVhp([...seen]), bpr, Date.now()), madeHere: Date.now() };
  }

  async function refresh(first = false) {
    const r = await KBlocks.ensure(provider, { blocks: 31000, onStatus: first ? (t) => t && say(t) : null });
    B = r.B; headT = B.ts[B.ts.length - 1];
    const cur = M.raceAt(Date.now());
    if (first || Date.now() - (refresh.dataAt || 0) > 300000) {
      refresh.dataAt = Date.now();
      await loadWeeks([...new Set([M.weekOf(Date.now() - M.DAY), M.weekOf(Date.now())])]);
    }
    if (!raceObj(cur.index).cards || raceObj(cur.index).provisional) { if (first) say("Reading each producer's VHP…"); await provisionalCard(); }
    render();
    renderPicks();
    say("");
  }

  // ── the race on the track ──
  function render() {
    if (!B) return;                                     // the blocks aren't loaded yet (the picks panel can be first)
    const cur = M.raceAt(Date.now());
    const race = raceObj(view == null ? cur.index : view);
    const live = race.index === cur.index, ended = Date.now() >= race.end;
    const final = race.result && race.result.final && !race.result.missed;
    // Steps: the recorder's final standings, or scored here from the blocks.
    let st = null;
    if (final && Array.isArray(race.result.standings)) st = race.result.standings.map((x) => ({ ...x }));
    else if (race.cards && B && B.ts[0] <= race.start) st = M.standings(B, race, race.cards, Math.min(headT + 1, race.end));
    const line = M.finishLine(race.cards || []) || (race.result && race.result.line) || 0;
    const nLegs = M.legsOf(race.cards), legMs = M.RACE / nLegs;
    const legNow = M.legOf(race.start, Math.min(Date.now(), race.end - 1), nLegs), card = race.cards ? M.cardForLeg(race.cards, legNow) : null;

    // Title, tag and clock
    $("race-title").textContent = `Race ${race.number} of 4 (${race.id.slice(11)}:00 UTC) · ${dayTime(race.start)} – ${clock(race.end)}`;
    const tag = $("race-tag");
    tag.textContent = live ? "Live" : !ended ? "Upcoming" : final ? "Final" : race.result && race.result.missed ? "Not recorded" : "Checking";
    tag.classList.toggle("done", !live);
    const frac = Math.min(1, Math.max(0, (Date.now() - race.start) / M.RACE));
    $("clock-fill").style.width = `${frac * 100}%`;
    $("clock-fill").classList.toggle("done", frac >= 1 || !live);
    $("clock").setAttribute("aria-valuenow", String(Math.round(frac * 100)));
    $("clock-txt").textContent = live ? `${dur(race.end - Date.now())} left · finishes ${clock(race.end)}` : ended ? "Race over" : `Starts in ${dur(race.start - Date.now())}`;
    // A dashed mark at every handicap update (every hour; every 2 hours for races recorded before hourly cards).
    const marks = $("clock-marks");
    if (marks.childElementCount !== nLegs - 1) marks.replaceChildren(...Array.from({ length: nLegs - 1 }, (_, l) => el("div", { class: "clock-leg", style: `left:${((l + 1) / nLegs) * 100}%` })));
    const nextLeg = Date.now() < race.start ? race.start : race.start + (legNow + 1) * legMs;
    $("leg1").textContent = `Start ${clock(race.start)}`;
    $("leg2").textContent = `Handicap updates every ${nLegs === 6 ? "hour" : "2 hours"}`;
    $("leg3").textContent = live && nextLeg < race.end ? `Next card ${clock(nextLeg)}` : `Finish ${clock(race.end)}`;

    // Lanes
    const track = $("track");
    if (!st || !st.length) {
      track.replaceChildren(el("p", { class: "note", text: race.result && race.result.missed ? "This race wasn't recorded." : !ended && !live ? "The horses are in the stalls. The race starts on time, from 0." : "Loading the race…" }));
    } else {
      // The live order, all the way to the finish: nobody waits at the line (see KRaceMath.track).
      const rows = M.track(st, line, ended), ordered = rows;
      const existing = new Map([...track.querySelectorAll(".pr-lane")].map((c) => [c.dataset.addr, c]));
      // Who moved since the last refresh (only while watching the live race; a new race or view starts clean).
      const fresh = seen.race !== race.id;
      const gained = new Map();
      if (live && !fresh) for (const r of rows) { const d = r.steps - (seen.steps.get(r.a) || 0); if (d > 1e-9) gained.set(r.a, { steps: d, blocks: r.blocks - (seen.blocks.get(r.a) || 0) }); }
      seen = { race: race.id, steps: new Map(rows.map((r) => [r.a, r.steps])), blocks: new Map(rows.map((r) => [r.a, r.blocks])) };
      const keep = [];
      ordered.forEach((r, i) => {
        let lane = existing.get(r.a);
        if (!lane) {
          lane = el("div", { class: "pr-lane", "data-addr": r.a },
            el("div", { class: "pr-who" }, el("span", { class: "pr-rank" }), el("span", { class: "pr-dot" }), el("a", { class: "pr-name", href: EXPLORER + r.a, target: "_blank", rel: "noopener noreferrer" }), el("span", { class: "pr-plus", "aria-hidden": "true" }), el("span", { class: "pr-meta" })),
            el("div", { class: "pr-run" }, el("div", { class: "pr-trail" }), el("div", { class: "pr-horse", "aria-hidden": "true", text: "🏇" })),
            el("div", { class: "pr-gap" }));
          lane.querySelector(".pr-dot").style.background = colour(r.a);
          lane.querySelector(".pr-trail").style.background = colour(r.a);
        }
        const h = card && card.field.find((x) => x.a === r.a), share = card ? h ? h.vhp / card.field.concat(card.paddock).reduce((s, x) => s + x.vhp, 0) : 0 : 0;
        lane.querySelector(".pr-rank").textContent = String(i + 1);
        lane.querySelector(".pr-name").textContent = nameOf(r.a);
        const plus = lane.querySelector(".pr-plus"), g = gained.get(r.a);
        if (g) {
          plus.textContent = `+${fmt(g.steps, 2)}${g.blocks > 1 ? ` (${g.blocks} blocks)` : ""}`;
          plus.classList.remove("on"); lane.classList.remove("moved"); void plus.offsetWidth;   // restart the flash
          plus.classList.add("on"); lane.classList.add("moved");
        } else { plus.classList.remove("on"); lane.classList.remove("moved"); if (!live) plus.textContent = ""; }
        lane.querySelector(".pr-meta").textContent = `${h ? `×${h.h.toFixed(2)} per block` : "no handicap this leg"} · ${fmt(r.blocks)} blocks${share ? ` · ${fmt(share * 100, share < 0.01 ? 2 : 1)}% VHP` : ""}`;
        const x = r.x * 100;
        lane.querySelector(".pr-horse").style.left = `calc(${x}% - ${x > 4 ? 30 : 0}px)`;   // never past the line; only the winner reaches it, at the end
        lane.querySelector(".pr-trail").style.width = `${x}%`;
        const gap = lane.querySelector(".pr-gap");
        if (ended) gap.replaceChildren(i === 0 ? el("b", { text: "Winner" }) : `${fmt(r.behind, 1)} behind`, el("br"), el("span", { class: "ago", text: `${fmt(r.steps, 1)} steps` }));
        else if (i === 0) gap.replaceChildren(el("b", { text: "Leading" }), el("br"), el("span", { class: "ago", text: `${fmt(r.steps, 1)} steps` }));
        else gap.replaceChildren(`${fmt(r.behind, 1)} behind`, el("br"), el("span", { class: "ago", text: `${fmt(r.steps, 1)} steps` }));
        lane.classList.toggle("lead", !ended && i === 0);
        lane.classList.toggle("win", ended && i === 0);
        lane.classList.toggle("mine", myPicks.get(race.index) === r.a);
        lane.setAttribute("aria-label", `${nameOf(r.a)}: ${ended ? "place" : "running"} ${i + 1}, ${fmt(r.steps, 1)} steps`);
        keep.push(lane);
      });
      track.replaceChildren(...keep);
      if (live && B.top !== lastTop && lastTop) { const lane = existing.get(B.signers[B.sig[B.sig.length - 1]]); if (lane) { lane.classList.remove("pr-step"); void lane.offsetWidth; lane.classList.add("pr-step"); } }
      lastTop = B.top;
    }
    const stretch = live && race.end - Date.now() <= 30 * 60000;
    const lineNote = ended ? "" : `${stretch ? "Final stretch: the order shown is live. " : ""}The flag is the 6-hour finish; the order shown is the real live order, and the winner crosses the line when time runs out.`;
    $("track-note").textContent = [
      race.provisional && !ended ? "Provisional handicap: made in your browser from VHP right now, until the race recorder publishes the official card." : "",
      lineNote, ended ? "" : "Steps behind are counted with the handicap.",
    ].filter(Boolean).join(" ");

    renderCard(race, card, legNow, nLegs);
    renderFeed(race, card);
    renderHistory();
  }

  function renderCard(race, card, leg, n) {
    const legMs = M.RACE / n;
    $("card-title").textContent = `Handicap card ${leg + 1} of ${n}`;
    if (!card) { $("card-sub").textContent = "No card yet."; $("card-rows").replaceChildren(); $("paddock-box").hidden = true; return; }
    const total = card.field.concat(card.paddock).reduce((s, x) => s + x.vhp, 0);
    $("card-sub").textContent = `${race.provisional ? "Provisional, from VHP right now" : `Set at ${dayTime(card.at)}`}. Applies ${clock(race.start + leg * legMs)}–${clock(race.start + (leg + 1) * legMs)}. Luck trim c = ${card.c}.`;
    $("card-rows").replaceChildren(...card.field.map((r) => el("tr", {},
      el("td", {}, el("span", { class: "pr-dot", style: `background:${colour(r.a)};margin-right:6px` }), el("a", { class: "mono", href: EXPLORER + r.a, target: "_blank", rel: "noopener noreferrer", text: nameOf(r.a) })),
      el("td", { class: "num", text: `${fmt((r.vhp / total) * 100, r.vhp / total < 0.01 ? 2 : 1)}%` }),
      el("td", { class: "num", text: `×${r.h.toFixed(2)}` }))));
    $("paddock").replaceChildren(...card.paddock.map((p) => el("li", {}, el("a", { class: "mono", href: EXPLORER + p.a, target: "_blank", rel: "noopener noreferrer", text: nameOf(p.a) }), ` · about ${fmt(p.k, 1)} blocks a race`)));
    $("paddock-box").hidden = !card.paddock.length;
  }

  function renderFeed(race, card) {
    const items = [];
    for (let i = B.sig.length - 1; i >= 0 && items.length < 8; i--) {
      const a = B.signers[B.sig[i]], live = B.ts[i] >= race.start && B.ts[i] < race.end;
      const leg = M.legOf(race.start, B.ts[i], M.legsOf(race.cards)), c = live && race.cards ? M.cardForLeg(race.cards, leg) : card, h = c && c.field.find((x) => x.a === a);
      items.push(el("li", {}, el("span", { class: "pr-dot", style: `background:${colour(a)}` }), `${nameOf(a)} `, el("b", { text: !live ? "between races" : h ? `+${h.h.toFixed(2)}` : "paddock" }),
        el("span", { class: "ago", "data-t": String(B.ts[i]), text: ` · block ${fmt(B.from + i)} · ${Math.max(0, Math.round((Date.now() - B.ts[i]) / 1000))} s ago` })));
    }
    $("feed").replaceChildren(...items);
  }

  // ── results ──
  function renderHistory() {
    const now = Date.now(), cur = M.raceIndex(now);
    let from, to;
    if (histMode === "today") { const d0 = Math.floor(now / M.DAY) * M.DAY; from = M.raceIndex(d0); to = from + 3; }
    else { const w0 = M.weekStart(M.weekOf(now)); from = M.raceIndex(w0); to = Math.min(from + 27, cur + 4); }
    const rows = [];
    for (let i = to; i >= from; i--) {
      const r = raceObj(i), ended = now >= r.end, live = i === cur;
      let status = live ? "live" : !ended ? "up" : r.result && r.result.missed ? "missed" : r.result && r.result.final ? "final" : "checking";
      let st = null;
      if (status === "final") st = r.result.standings;
      else if ((status === "checking" || live) && r.cards && !r.provisional && B && B.ts[0] <= r.start) st = M.standings(B, r, r.cards, Math.min(headT + 1, r.end));
      else if (status === "checking" && r.provisional) status = "missed";
      const w = st && st.length ? st[0] : null, margin = st && st.length > 1 ? st[0].steps - st[1].steps : null;
      rows.push(el("tr", { class: view === i || (view == null && live) ? "sel" : "" },
        el("td", { text: dayTime(r.start) }),
        el("td", {}, el("span", { class: `st ${status}`, text: { live: "Live", up: "Upcoming", missed: "Not recorded", final: "Final", checking: "Checking" }[status] })),
        el("td", { class: "mono" }, w ? el("a", { href: EXPLORER + w.a, target: "_blank", rel: "noopener noreferrer", text: `${live ? "leading: " : ""}${nameOf(w.a)}` }) : "–"),
        el("td", { class: "num hide-sm", text: w ? fmt(w.steps, 1) : "–" }),
        el("td", { class: "num hide-sm", text: margin != null ? fmt(margin, 1) : "–" }),
        el("td", { class: "num hide-sm", text: status === "final" && Array.isArray(r.result.picks) ? `${r.result.picks.filter((x) => x[3]).length} · ${r.result.picks.filter((x) => isShow(r.result, x)).length} of ${r.result.picks.length}` : "–" }),
        el("td", {}, (ended || live) && status !== "missed" ? el("button", { type: "button", onclick: () => { view = live ? null : i; render(); window.scrollTo({ top: 0, behavior: "smooth" }); } }, live ? "Watch" : "View") : null)));
    }
    $("hist-rows").replaceChildren(...rows);
  }
  // ── picks (once the race picks contract is live: race-data/deployment.json on the site) ──
  const ROOT = new URL("./", location.href);
  const W = window.KWallet;
  let raceContract = null, myPicks = new Map(), usage = null, sending = false, board = null;
  // The pick panel is redrawn only when something in it changed (the race redraws every few seconds), and a horse you
  // chose but haven't sent yet is kept across redraws.
  let picksKey = "";
  const drafts = new Map();
  const me = () => (W && W.address) || null;
  async function setupPicks() {
    let rdep = null, dep = null;
    try { rdep = await fetchJson(new URL("race-data/deployment.json", ROOT)); } catch { return; }   // not live yet
    if (!rdep || !KBlocks.isAddr(rdep.contract)) return;
    try { dep = await fetchJson(new URL("game-data/deployment.json", ROOT)); } catch { /* the wallet keeps its defaults */ }
    const abi = await fetchJson(new URL("race/abi/race.koilib.json", ROOT));
    raceContract = new lib.Contract({ id: rdep.contract, abi, provider });
    // The Mana sponsor pays for picks (free play): the wallet needs the same settings as the game page.
    if (W) W.init({ provider, chainId: dep && dep.chainId, payer: dep && dep.payer, sponsor: dep && dep.sponsor, onChange: () => loadMine() });
    $("picks-soon").hidden = true; $("picks").hidden = false;
    loadMine();
  }
  /** My picks: the live race and the next 4 from the contract; finished ones from the recorded results. */
  async function loadMine() {
    if (!raceContract) return;
    myPicks = new Map(); usage = null;
    const who = me(), cur = M.raceIndex(Date.now());
    if (who) {
      try {
        const reads = [0, 1, 2, 3, 4].map((k) => raceContract.functions.get_pick({ player: who, race: String(cur + k) }).then((r) => [cur + k, r.result && r.result.pick && r.result.pick.horse]));
        for (const [i, h] of await Promise.all(reads)) if (h) myPicks.set(i, h);
        usage = (await raceContract.functions.get_usage({ player: who })).result || null;
      } catch { /* shown as "couldn't read" below */ }
      for (const wf of weeks.values()) for (const r of wf.races) {
        const p = r.result && Array.isArray(r.result.picks) && r.result.picks.find((x) => x[0] === who);
        if (p) myPicks.set(M.parseRaceId(r.id), p[1]);
      }
    }
    renderPicks(); render();
  }
  function renderPicks(force = false) {
    if (!raceContract) return;
    const who = me(), list = $("pk-list"), cur = M.raceIndex(Date.now());
    // Leave the panel alone while a list is open or focused, or when nothing in it changed.
    if (!force && list.contains(document.activeElement) && document.activeElement.tagName === "SELECT") return;
    const fieldSig = [1, 2, 3, 4].map((k) => { const r = raceObj(cur + k), c = (r.cards && !r.provisional && M.cardForLeg(r.cards, 0)) || prov; return c ? `${c.at}:${c.field.length}` : "-"; }).join(",");
    const key = JSON.stringify([who, W && W.kind, cur, sending, usage && usage.picks_today, usage && usage.max_picks_per_day, [...myPicks], fieldSig, [...weeks.keys()]]);
    if (!force && key === picksKey && list.childElementCount) return;
    picksKey = key;
    if (!who) {
      $("picks-who").textContent = "Connect a wallet to pick (Kondor, KOIN Vault or a guest wallet).";
      $("picks-left").textContent = "";
      list.replaceChildren(el("button", { class: "btn", type: "button", onclick: () => W && W.connect() }, "Connect wallet"));
      return;
    }
    $("picks-who").textContent = `Picking as ${nameOf(who)}${W.kind === "guest" ? " (guest)" : ""}.`;
    const max = usage ? Number(usage.max_picks_per_day) || 5 : 5, used = usage ? Number(usage.picks_today) || 0 : 0;
    $("picks-left").textContent = usage ? `${Math.max(0, max - used)} of ${max} picks left today` : "";
    const rows = [];
    // The live race: locked.
    const live = raceObj(cur), mineLive = myPicks.get(cur);
    rows.push(el("div", { class: "pk-row live" },
      el("div", { class: "pk-when" }, el("b", { text: `Live now (${live.id.slice(11)}:00 UTC)` }), el("span", { text: `ends ${clock(live.end)}` })),
      el("div", { class: "pk-now", text: mineLive ? `Your pick: ${nameOf(mineLive)} 🔒` : "No pick for this race (locked)" }), el("span")));
    // The next 4: open.
    // The field for a race: its own starting card once the recorder has set it (about an hour before the start);
    // until then the latest card there is (the live race's current one), or the provisional card made here.
    const latest = () => { const lr = raceObj(cur); return (lr.cards && M.cardForLeg(lr.cards, M.legOf(lr.start, Date.now(), M.legsOf(lr.cards)))) || prov; };
    const fieldOf = (r) => (r.cards && !r.provisional && M.cardForLeg(r.cards, 0)) || latest();
    const label = (c, x) => { const tot = c.field.concat(c.paddock || []).reduce((t, y) => t + y.vhp, 0); const sh = tot ? (x.vhp / tot) * 100 : 0; return `${nameOf(x.a)} · ${fmt(sh, sh < 1 ? 2 : 1)}% VHP · ×${x.h.toFixed(2)} per block`; };
    for (let k = 1; k <= 4; k++) {
      const r = raceObj(cur + k), mine = myPicks.get(cur + k), c = fieldOf(r);
      const opts = c ? c.field : [];
      const sel = el("select", { "aria-label": `Horse for the race at ${dayTime(r.start)}` },
        el("option", { value: "", text: !opts.length ? "Loading the horses…" : mine ? "Change to…" : "Choose a horse…" }),
        ...opts.map((x) => { const o = el("option", { value: x.a, text: label(c, x) }); if (x.a === (drafts.get(cur + k) || mine)) o.selected = true; return o; }));
      if (!opts.length) sel.disabled = true;
      sel.addEventListener("change", () => { if (sel.value) drafts.set(cur + k, sel.value); else drafts.delete(cur + k); });
      const btn = el("button", { class: "btn", type: "button", onclick: () => sendPick(cur + k, sel.value) }, mine ? "Change" : "Pick");
      if (sending || used >= max) btn.disabled = true;
      rows.push(el("div", { class: "pk-row" },
        el("div", { class: "pk-when" }, el("b", { text: `${dayTime(r.start)}` }), el("span", { "data-lock": String(r.start), text: `${r.id.slice(11)}:00 UTC · locks in ${dur(r.start - Date.now())}` })),
        el("div", {}, sel, mine ? el("div", { class: "pk-now ago", text: `Your pick: ${nameOf(mine)}` }) : null), btn));
    }
    // Finished races today with a pick: right or not.
    const d0 = M.raceIndex(Math.floor(Date.now() / M.DAY) * M.DAY);
    for (let i = cur - 1; i >= d0 - 4 && i >= 0; i--) {
      const r = raceObj(i), p = r.result && Array.isArray(r.result.picks) ? r.result.picks.find((x) => x[0] === who) : null;
      if (!p) continue;
      rows.push(el("div", { class: "pk-row done" },
        el("div", { class: "pk-when" }, el("b", { text: dayTime(r.start) }), el("span", { text: "final" })),
        el("div", { class: "pk-now", text: `You picked ${nameOf(p[1])}; ${nameOf(r.result.winner || "")} won` }),
        el("span", { class: p[3] || isShow(r.result, p) ? "pk-ok" : "pk-no", text: p[3] ? `✓ Win +${M.POINTS.win}` : isShow(r.result, p) ? `✓ Show +${M.POINTS.show}` : "✗" })));
    }
    list.replaceChildren(...rows);
  }
  // ── the pick pop-up: wallet → sent → confirmed on the chain ──
  let modal = null;
  function pickModal(state, title, lines = [], actions = []) {
    if (!modal) {
      modal = el("div", { class: "pk-modal", role: "dialog", "aria-modal": "true", "aria-labelledby": "pk-m-title" });
      modal.addEventListener("click", (e) => { if (e.target === modal && state !== "busy") closeModal(); });
      document.body.append(modal);
    }
    const icon = { busy: el("span", { class: "pk-spin", "aria-hidden": "true" }), ok: el("span", { class: "pk-big ok", text: "✓" }), bad: el("span", { class: "pk-big bad", text: "✗" }), info: el("span", { class: "pk-big", text: "ℹ" }) }[state];
    modal.replaceChildren(el("div", { class: `pk-box ${state}` }, icon, el("h3", { id: "pk-m-title", text: title }), ...lines.map((l) => (typeof l === "string" ? el("p", { text: l }) : l)),
      actions.length ? el("div", { class: "pk-acts" }, ...actions) : null));
    modal.hidden = false;
    const btn = modal.querySelector("button"); if (btn) btn.focus();
  }
  function closeModal() { if (modal) modal.hidden = true; }
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && modal && !modal.hidden && !modal.querySelector(".pk-spin")) closeModal(); });
  const okBtn = (text = "Done") => el("button", { class: "btn", type: "button", onclick: closeModal }, text);

  async function sendPick(index, horse) {
    const who = me();
    if (!who || !raceContract || sending) return;
    const when = `${dayTime(M.raceStart(index))} (${M.raceId(index).slice(11)}:00 UTC)`;
    if (!KBlocks.isAddr(horse)) return pickModal("info", "Choose a horse first", ["Pick a producer from the list, then press Pick."], [okBtn("OK")]);
    if (myPicks.get(index) === horse) return pickModal("info", "That is already your pick", [`${nameOf(horse)} for the race at ${when}.`], [okBtn("OK")]);
    if (Date.now() >= M.raceStart(index)) return pickModal("bad", "That race has started", ["Picks lock when a race starts."], [okBtn("OK")]);
    sending = true; renderPicks(true);
    const wallet = W.kind === "guest" ? "your guest wallet" : W.label ? W.label() : "your wallet";
    pickModal("busy", W.kind === "guest" ? "Sending your pick…" : `Confirm in ${wallet}`, [`${nameOf(horse)} for the race at ${when}.`, W.kind === "guest" ? "Free: the Knode Games Mana sponsor pays." : "Free: the Knode Games Mana sponsor pays the Mana. Approve it in your wallet."]);
    try {
      const { operation } = await raceContract.functions.pick({ player: who, race: String(index), horse }, { onlyOperation: true });
      const id = await W.send(`pick ${nameOf(horse)} for the race at ${dayTime(M.raceStart(index))}`, [operation]);
      pickModal("busy", "Sent. Checking the chain…", [`${nameOf(horse)} for the race at ${when}.`]);
      // Read the pick back from the race contract: confirmed only when the chain has it.
      let onChain = false;
      for (let t = 0; t < 10 && !onChain; t++) {
        try { const r = await raceContract.functions.get_pick({ player: who, race: String(index) }); onChain = !!(r.result && r.result.pick && r.result.pick.horse === horse); } catch { /* try again */ }
        if (!onChain) await new Promise((res) => setTimeout(res, 3000));
      }
      drafts.delete(index);
      if (onChain) {
        pickModal("ok", "Pick confirmed", [
          el("p", {}, "Your horse: ", el("b", { text: nameOf(horse) })),
          `Race: ${when}. It locks when the race starts; until then you can change it (changes count toward today's 5).`,
          id ? el("p", { class: "ago mono", text: `Transaction ${String(id).slice(0, 18)}…` }) : null,
          el("p", { class: "ago" }, el("a", { href: EXPLORER + who, target: "_blank", rel: "noopener noreferrer", text: "See your wallet on Koinosscan" })),
        ].filter(Boolean), [okBtn()]);
      } else {
        pickModal("info", "Sent, not seen on the chain yet", ["Your wallet sent it. It usually shows within a minute; this panel updates by itself.", id ? `Transaction ${String(id).slice(0, 18)}…` : ""].filter(Boolean), [okBtn("OK")]);
      }
    } catch (e) {
      const m = String((e && e.message) || e);
      const why = /locked|started/i.test(m) ? "That race has started: picks are locked."
        : /used up/i.test(m) ? "Today's picks are used up (changes count). More tomorrow, 00:00 UTC."
        : /already your pick/i.test(m) ? "That is already your pick."
        : /reject|denied|cancel/i.test(m) ? "Cancelled in your wallet. Nothing was sent."
        : `Not sent: ${m.slice(0, 200)}`;
      pickModal(/Cancelled/.test(why) ? "info" : "bad", /Cancelled/.test(why) ? "Cancelled" : "Pick not sent", [why], [okBtn("OK")]);
    } finally { sending = false; await loadMine(); renderPicks(true); }
  }

  // ── leaderboard (the recorder's board.json, shown by the shared Knode Games board in board.js) ──
  const lb = window.KBoard ? window.KBoard.create($("race-board"), {
    label: "Race leaderboard",
    columns: [{ key: "pts", label: "Points" }, { key: "correct", label: "Wins" }, { key: "shows", label: "Shows" }, { key: "picks", label: "Picks", wide: true }, { key: "answers", label: "Question answers", wide: true }],
    scored: (r) => (r.pts ?? r.correct) > 0,
    summary: (r) => `${fmt(r.pts ?? 0)} pts · ${fmt(r.correct)} W ${fmt(r.shows ?? 0)} S`,
    name: nameOf, link: (a) => EXPLORER + a,
    me: (r, place) => `${place ? `You: #${place} with` : "Your score (only you see this):"} ${fmt(r.pts ?? 0)} points (${fmt(r.correct)} wins, ${fmt(r.shows ?? 0)} shows) from ${fmt(r.picks)} picks.`,
    unranked: "To be ranked, hold at least 1 VHP or stake in Knode Games.",
    free: { show: 6, prize: "1st and 2nd at the end of the week win the free-play prize (paid once the Knode Games vault is live)." },
  }) : null;
  async function loadBoard() {
    try { const b = await fetchJson(DATA + "board.json"); if (b && b.v === 1 && lb) { board = b; $("board-box").hidden = false; renderBoard(); } } catch { /* none yet */ }
  }
  function renderBoard() { if (lb && board) { lb.setMe(me() || ""); lb.set(board); } }
  if (W && W.subscribe) W.subscribe(() => { loadMine(); renderBoard(); });

  const setMode = (m) => { histMode = m; $("h-today").setAttribute("aria-pressed", String(m === "today")); $("h-week").setAttribute("aria-pressed", String(m === "week")); renderHistory(); };
  $("h-today").onclick = () => setMode("today");
  $("h-week").onclick = () => setMode("week");

  // ── start ──
  (async () => {
    // The wallet's settings (Mana sponsor, guest play) first, so Connect offers everything at once.
    const picksReady = setupPicks().catch(() => {});
    try { await refresh(true); }
    catch (e) { say("Couldn't reach the Koinos network. Trying again in a moment…"); }
    await picksReady; renderPicks();
    loadBoard();
    setInterval(() => { if (!document.hidden) loadBoard(); }, 300000);
    setInterval(() => { if (!document.hidden && raceContract) loadMine(); }, 60000);
    let shown = M.raceIndex(Date.now());
    setInterval(() => { if (!document.hidden) refresh().catch(() => {}); }, 6000);   // new blocks every ~3 s: a light top-up
    setInterval(() => {
      if (!B) return;
      // A new race starts by itself: every horse back to 0, the last one goes to the results.
      const now = M.raceIndex(Date.now());
      if (now !== shown) { shown = now; if (view == null) { prov = null; refresh().catch(() => {}); loadMine(); } }
      const race = raceObj(view == null ? now : view);
      if (Date.now() < race.end) {
        const frac = Math.min(1, Math.max(0, (Date.now() - race.start) / M.RACE));
        $("clock-fill").style.width = `${frac * 100}%`;
        if (view == null) $("clock-txt").textContent = `${dur(race.end - Date.now())} left · finishes ${clock(race.end)}`;
      }
      document.querySelectorAll("#pk-list [data-lock]").forEach((n) => { const t = Number(n.dataset.lock); n.textContent = n.textContent.replace(/locks in .*$/, `locks in ${dur(t - Date.now())}`); });
      document.querySelectorAll("#feed .ago[data-t]").forEach((n) => { const t = Number(n.dataset.t); n.textContent = n.textContent.replace(/· \d+ s ago$/, `· ${Math.max(0, Math.round((Date.now() - t) / 1000))} s ago`); });
    }, 1000);
  })();

  // Stake in the Race (vault game 7): the shared panel stays hidden until the Knode Games vault (v6) is live.
  if (window.KStake) window.KStake.mount(document.getElementById("stake"), { game: 7 });
})();

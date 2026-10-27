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
  const RPC = "https://api.koinos.io";
  const DATA = "https://raw.githubusercontent.com/bawcejawn/Knode/race-data/";
  const VHP = "12Y5vW6gk8GceH53YfRkRre2Rrcsgw7Naq";
  const EXPLORER = "https://koinosscan.com/address/";
  const NAMES = { "1Mpmf2ERhjYpX7CCiM11WERuM4j17uT1sr": "Knode pool", "1FKTpXBhhHEbu5vVchM8UsVbAvPArJsRmR": "Knode Swap" };
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
    return { index, id, start, end: start + M.RACE, number: ((index % 4) + 4) % 4 + 1, cards: cards || (prov ? [prov, null, null] : null), provisional: !cards, result: rec && rec.result };
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
    const cur = M.raceAt(Date.now());
    const race = raceObj(view == null ? cur.index : view);
    const live = race.index === cur.index, ended = Date.now() >= race.end;
    const final = race.result && race.result.final && !race.result.missed;
    // Steps: the recorder's final standings, or scored here from the blocks.
    let st = null;
    if (final && Array.isArray(race.result.standings)) st = race.result.standings.map((x) => ({ ...x }));
    else if (race.cards && B && B.ts[0] <= race.start) st = M.standings(B, race, race.cards, Math.min(headT + 1, race.end));
    const line = M.finishLine(race.cards || []) || (race.result && race.result.line) || 0;
    const legNow = M.legOf(race.start, Math.min(Date.now(), race.end - 1)), card = race.cards ? M.cardForLeg(race.cards, legNow) : null;

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
    ["leg1", "leg2", "leg3"].forEach((id, l) => {
      const t = race.start + l * M.LEG;
      $(id).textContent = l === 0 ? `Start ${clock(t)}` : `${Date.now() >= t ? "Card" : "Next card"} ${l + 1} at ${clock(t)}`;
    });

    // Lanes
    const track = $("track");
    if (!st || !st.length) {
      track.replaceChildren(el("p", { class: "note", text: race.result && race.result.missed ? "This race wasn't recorded." : !ended && !live ? "The horses are in the stalls. The race starts on time, from 0." : "Loading the race…" }));
    } else {
      const rows = M.track(st, line, ended);
      // While the race runs, horses at the line are listed by name: their order is revealed at the end.
      const atLine = rows.filter((r) => r.atLine && !ended).sort((a, b) => (a.a < b.a ? -1 : 1)), rest = rows.filter((r) => !(r.atLine && !ended));
      const ordered = [...atLine, ...rest];
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
        lane.querySelector(".pr-rank").textContent = !ended && r.atLine ? "🏁" : String(i + 1);
        lane.querySelector(".pr-name").textContent = nameOf(r.a);
        const plus = lane.querySelector(".pr-plus"), g = gained.get(r.a);
        if (g) {
          plus.textContent = `+${fmt(g.steps, 2)}${g.blocks > 1 ? ` (${g.blocks} blocks)` : ""}`;
          plus.classList.remove("on"); lane.classList.remove("moved"); void plus.offsetWidth;   // restart the flash
          plus.classList.add("on"); lane.classList.add("moved");
        } else { plus.classList.remove("on"); lane.classList.remove("moved"); if (!live) plus.textContent = ""; }
        lane.querySelector(".pr-meta").textContent = `${h ? `×${h.h.toFixed(2)} per block` : "no handicap this leg"} · ${fmt(r.blocks)} blocks${share ? ` · ${fmt(share * 100, share < 0.01 ? 2 : 1)}% VHP` : ""}`;
        const x = r.x * 100;
        lane.querySelector(".pr-horse").style.left = `calc(${x}% - ${x > 4 ? 30 : 0}px)`;   // stops at the line, never past it
        lane.querySelector(".pr-trail").style.width = `${x}%`;
        const gap = lane.querySelector(".pr-gap");
        if (ended) gap.replaceChildren(i === 0 ? el("b", { text: "Winner" }) : `${fmt(r.behind, 1)} behind`, el("br"), el("span", { class: "ago", text: `${fmt(r.steps, 1)} steps` }));
        else if (r.atLine) gap.replaceChildren("🏁 At the line");
        else if (r.behind === 0 && !atLine.length) gap.replaceChildren(el("b", { text: "Leading" }), el("br"), el("span", { class: "ago", text: `${fmt(r.steps, 1)} steps` }));
        else gap.replaceChildren(`${fmt(r.behind, 1)} behind`, el("br"), el("span", { class: "ago", text: `${fmt(r.steps, 1)} steps` }));
        lane.classList.toggle("lead", !ended && (r.atLine || (i === 0 && !atLine.length)));
        lane.classList.toggle("line", !ended && r.atLine);
        lane.classList.toggle("win", ended && i === 0);
        lane.classList.toggle("mine", myPicks.get(race.index) === r.a);
        lane.setAttribute("aria-label", `${nameOf(r.a)}: ${ended ? `place ${i + 1}, ` : r.atLine ? "at the finish line, " : ""}${fmt(r.steps, 1)} steps`);
        keep.push(lane);
      });
      track.replaceChildren(...keep);
      if (live && B.top !== lastTop && lastTop) { const lane = existing.get(B.signers[B.sig[B.sig.length - 1]]); if (lane) { lane.classList.remove("pr-step"); void lane.offsetWidth; lane.classList.add("pr-step"); } }
      lastTop = B.top;
    }
    const lineNote = line ? `The finish line is ${fmt(line, 0)} steps: how far every horse is expected to get in 6 hours.` : "";
    $("track-note").textContent = [
      race.provisional && !ended ? "Provisional handicap: made in your browser from VHP right now, until the race recorder publishes the official card." : "",
      lineNote, ended ? "" : "Steps behind are counted with the handicap.",
    ].filter(Boolean).join(" ");

    renderCard(race, card, legNow);
    renderFeed(race, card);
    renderHistory();
  }

  function renderCard(race, card, leg) {
    $("card-title").textContent = `Handicap card ${leg + 1} of 3`;
    if (!card) { $("card-sub").textContent = "No card yet."; $("card-rows").replaceChildren(); $("paddock-box").hidden = true; return; }
    const total = card.field.concat(card.paddock).reduce((s, x) => s + x.vhp, 0);
    $("card-sub").textContent = `${race.provisional ? "Provisional, from VHP right now" : `Set at ${dayTime(card.at)}`}. Applies ${clock(race.start + leg * M.LEG)}–${clock(race.start + (leg + 1) * M.LEG)}. Luck trim c = ${card.c}.`;
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
      const leg = M.legOf(race.start, B.ts[i]), c = live && race.cards ? M.cardForLeg(race.cards, leg) : card, h = c && c.field.find((x) => x.a === a);
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
        el("td", { class: "num hide-sm", text: status === "final" && Array.isArray(r.result.picks) ? `${r.result.picks.filter((x) => x[3]).length} of ${r.result.picks.length}` : "–" }),
        el("td", {}, (ended || live) && status !== "missed" ? el("button", { type: "button", onclick: () => { view = live ? null : i; render(); window.scrollTo({ top: 0, behavior: "smooth" }); } }, live ? "Watch" : "View") : null)));
    }
    $("hist-rows").replaceChildren(...rows);
  }
  // ── picks (once the race picks contract is live: race-data/deployment.json on the site) ──
  const ROOT = new URL("../", location.href);
  const W = window.KWallet;
  let raceContract = null, myPicks = new Map(), usage = null, sending = false, board = null, boardMode = "week";
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
  function renderPicks() {
    if (!raceContract) return;
    const who = me(), list = $("pk-list"), cur = M.raceIndex(Date.now());
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
    const latest = () => { const lr = raceObj(cur); return (lr.cards && M.cardForLeg(lr.cards, M.legOf(lr.start, Date.now()))) || prov; };
    const fieldOf = (r) => (r.cards && !r.provisional && M.cardForLeg(r.cards, 0)) || latest();
    const label = (c, x) => { const tot = c.field.concat(c.paddock || []).reduce((t, y) => t + y.vhp, 0); const sh = tot ? (x.vhp / tot) * 100 : 0; return `${nameOf(x.a)} · ${fmt(sh, sh < 1 ? 2 : 1)}% VHP · ×${x.h.toFixed(2)} per block`; };
    for (let k = 1; k <= 4; k++) {
      const r = raceObj(cur + k), mine = myPicks.get(cur + k), c = fieldOf(r);
      const opts = c ? c.field : [];
      const sel = el("select", { "aria-label": `Horse for the race at ${dayTime(r.start)}` },
        el("option", { value: "", text: !opts.length ? "Loading the horses…" : mine ? "Change to…" : "Choose a horse…" }),
        ...opts.map((x) => { const o = el("option", { value: x.a, text: label(c, x) }); if (x.a === mine) o.selected = true; return o; }));
      if (!opts.length) sel.disabled = true;
      const btn = el("button", { class: "btn", type: "button", onclick: () => sendPick(cur + k, sel.value) }, mine ? "Change" : "Pick");
      if (sending || used >= max) btn.disabled = true;
      rows.push(el("div", { class: "pk-row" },
        el("div", { class: "pk-when" }, el("b", { text: `${dayTime(r.start)}` }), el("span", { text: `${r.id.slice(11)}:00 UTC · locks in ${dur(r.start - Date.now())}` })),
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
        el("span", { class: p[3] ? "pk-ok" : "pk-no", text: p[3] ? "✓ Right" : "✗" })));
    }
    list.replaceChildren(...rows);
  }
  async function sendPick(index, horse) {
    const who = me();
    if (!who || !raceContract || sending) return;
    if (!KBlocks.isAddr(horse)) { $("pk-msg").textContent = "Choose a horse first."; return; }
    if (myPicks.get(index) === horse) { $("pk-msg").textContent = "That is already your pick."; return; }
    if (Date.now() >= M.raceStart(index)) { $("pk-msg").textContent = "That race has started: picks are locked."; return; }
    sending = true; renderPicks();
    $("pk-msg").textContent = `Sending your pick: ${nameOf(horse)} for ${dayTime(M.raceStart(index))}…`;
    try {
      const { operation } = await raceContract.functions.pick({ player: who, race: String(index), horse }, { onlyOperation: true });
      const id = await W.send(`pick ${nameOf(horse)} for the race at ${dayTime(M.raceStart(index))}`, [operation]);
      $("pk-msg").textContent = id ? `Picked ${nameOf(horse)}. It locks when the race starts.` : "Sent; it should show in a few seconds.";
    } catch (e) {
      const m = String((e && e.message) || e);
      $("pk-msg").textContent = /locked|started/i.test(m) ? "That race has started: picks are locked." : /used up/i.test(m) ? "Today's picks are used up (changes count). More tomorrow (UTC)." : /reject|denied|cancel/i.test(m) ? "Cancelled in your wallet." : `Not sent: ${m.slice(0, 200)}`;
    } finally { sending = false; await loadMine(); }
  }

  // ── leaderboard (the recorder's board.json) ──
  async function loadBoard() {
    try { const b = await fetchJson(DATA + "board.json"); if (b && b.v === 1) { board = b; $("board-box").hidden = false; renderBoard(); } } catch { /* none yet */ }
  }
  function renderBoard() {
    if (!board) return;
    const part = boardMode === "today" ? board.today : boardMode === "all" ? board.allTime : board.week;
    const rows = (part && part.rows) || [], ranked = rows.filter((r) => r.ranked), who = me();
    $("board-sub").textContent = boardMode === "week" && board.week ? `week ${board.week.week + 1}, from ${dayTime(board.week.start)}` : boardMode === "today" ? `${board.today.day} (UTC)` : "";
    const medal = ["🥇", "🥈", "🥉"];
    $("champs").replaceChildren(...(boardMode === "week" ? ranked.slice(0, 3).filter((r) => r.correct > 0).map((r, i) => el("div", { class: "champ" }, el("b", { text: `${medal[i]} ${i + 1}${["st", "nd", "rd"][i]}` }), el("span", { class: "mono", text: nameOf(r.a) }), el("div", { class: "ago", text: `${r.correct} right of ${r.picks}` }))) : []));
    $("board-rows").replaceChildren(...ranked.slice(0, 50).map((r, i) => el("tr", { class: `${i < 3 && boardMode === "week" ? "top" : ""} ${r.a === who ? "me" : ""}` },
      el("td", { text: i < 3 ? medal[i] : String(i + 1) }),
      el("td", { class: "mono" }, el("a", { href: EXPLORER + r.a, target: "_blank", rel: "noopener noreferrer", text: nameOf(r.a) })),
      el("td", { class: "num", text: fmt(r.correct) }), el("td", { class: "num hide-sm", text: fmt(r.picks) }),
      el("td", { class: "num hide-sm", text: fmt(r.answers) }), el("td", { class: "num hide-sm", text: fmt(r.points) }))));
    if (!ranked.length) $("board-rows").replaceChildren(el("tr", {}, el("td", { colspan: "6", class: "ago", text: "No ranked picks yet." })));
    const mine = who && rows.find((r) => r.a === who);
    $("board-me").textContent = !who ? "" : !mine ? "You have no finished picks here yet." : mine.ranked
      ? `You: #${ranked.indexOf(mine) + 1} with ${mine.correct} right of ${mine.picks} picks.`
      : `Your score (only you see this): ${mine.correct} right of ${mine.picks} picks. To be ranked, hold at least 1 VHP or stake in Knode.`;
  }
  const setBoard = (m) => { boardMode = m; for (const [id, k] of [["b-today", "today"], ["b-week", "week"], ["b-all", "all"]]) $(id).setAttribute("aria-pressed", String(m === k)); renderBoard(); };
  $("b-today").onclick = () => setBoard("today"); $("b-week").onclick = () => setBoard("week"); $("b-all").onclick = () => setBoard("all");
  if (W && W.subscribe) W.subscribe(() => { loadMine(); renderBoard(); });

  const setMode = (m) => { histMode = m; $("h-today").setAttribute("aria-pressed", String(m === "today")); $("h-week").setAttribute("aria-pressed", String(m === "week")); renderHistory(); };
  $("h-today").onclick = () => setMode("today");
  $("h-week").onclick = () => setMode("week");

  // ── start ──
  (async () => {
    try { await refresh(true); }
    catch (e) { say("Couldn't reach the Koinos network. Trying again in a moment…"); }
    setupPicks().catch(() => {});
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
      document.querySelectorAll("#feed .ago[data-t]").forEach((n) => { const t = Number(n.dataset.t); n.textContent = n.textContent.replace(/· \d+ s ago$/, `· ${Math.max(0, Math.round((Date.now() - t) / 1000))} s ago`); });
    }, 1000);
  })();
})();

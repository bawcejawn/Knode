/* Fantasy Producers: the game page. One script for two pages:
 *   fantasy.html          Koinos MAINNET: the live game (Picks games 4 and 5).
 *   the testnet practice page, served only on your own computer by bot/fantasy-test.ts: it sets window.KFantasyNet
 *   (the testnet Picks contract, a fast clock, the local data folder) and its own test wallet.
 * It reads the recorder's files (price list, days, league, rivals) and your picks from the Picks contract. It sends
 * two things, each confirmed in your wallet: your team for the next day, and your rival challenge for the next week.
 * The rules and the scoring are fantasy-math.js, the same file the recorder uses. Everything on screen is built with
 * textContent: no HTML strings. */
(() => {
  "use strict";
  const R = window.KRaceMath, FR = window.KFantasyMath;
  if (!R || !FR || typeof document === "undefined" || !document.getElementById("fx-slots")) return;

  const lib = window.koilib || window.koinos || window;
  const MAINNET_CHAIN_ID = "EiBZK_GGVP0H_fXVAM3j6EAuz3-B-l3ejxRSewi7qIBfSA==";
  const TNET = window.KFantasyNet || null;
  const TESTNET = !!TNET;
  const ROOT = new URL("../", location.href);
  /** Knode's own nodes: in the pool like any other producer, and marked (owner decision 2026-10-27). */
  const NAMES = { "1Mpmf2ERhjYpX7CCiM11WERuM4j17uT1sr": "Knode pool", "1FKTpXBhhHEbu5vVchM8UsVbAvPArJsRmR": "Knode Swap" };

  const $ = (id) => document.getElementById(id);
  const el = (tag, attrs = {}, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (v == null) continue; if (k === "text") e.textContent = v; else if (k.startsWith("on")) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v); } for (const c of kids) if (c != null && c !== false) e.append(c); return e; };
  const isAddr = FR.isAddr;
  const players = new Map((TNET && Array.isArray(TNET.players) ? TNET.players : []).map((p) => [p.address, p.name]));
  const nameOf = (a) => (isAddr(a) ? NAMES[a] || (players.has(a) ? `${players.get(a)} · ${a.slice(0, 5)}…` : a.slice(0, 5) + "…" + a.slice(-4)) : "–");
  const fmt = (n, d = 0) => (n == null || !Number.isFinite(Number(n)) ? "–" : Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }));
  const when = (t) => new Date(t).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
  const dur = (ms) => { const m = Math.max(0, Math.ceil(ms / 60000)); return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min` : `${m} min`; };
  const say = (t) => { $("status").textContent = t; $("status").hidden = !t; };
  async function fetchJson(url) { const r = await fetch(url, { cache: "no-cache" }); if (!r.ok) throw new Error(String(r.status)); return r.json(); }
  function colorOf(a) {
    let x = 2166136261;
    for (let i = 0; i < (a || "").length; i++) { x ^= a.charCodeAt(i); x = Math.imul(x, 16777619) >>> 0; }
    const hues = [152, 12, 205, 268, 330, 100, 180, 230, 295, 350];
    return `hsl(${hues[x % hues.length] + ((x >>> 8) % 14) - 7} ${58 + ((x >>> 12) % 18)}% ${46 + ((x >>> 16) % 12)}%)`;
  }
  const dot = (a) => { const d = el("span", { class: "fx-dot", "aria-hidden": "true" }); d.style.setProperty("--c", colorOf(a)); return d; };
  const nameCell = (a) => el("span", { class: "fx-name" }, dot(a), el("span", { text: nameOf(a) }), NAMES[a] ? el("span", { class: "fx-own", title: "One of Knode's own nodes", text: "Knode" }) : null);

  // ── the network ──
  let F = FR, G = FR.GAMES, NET = null, provider = null, W = null, picks = null;
  async function setupNet() {
    if (TESTNET) {
      if (TNET.chainId === MAINNET_CHAIN_ID) throw new Error("the test settings name mainnet");
      F = FR.withClock(TNET.clock);
      G = TNET.games;
      NET = { rpc: [TNET.rpc], data: TNET.data, picks: isAddr(TNET.picks) ? TNET.picks : null, explorer: null, chainId: TNET.chainId };
      provider = new lib.Provider(NET.rpc);
      const id = await provider.getChainId();
      if (id === MAINNET_CHAIN_ID || (NET.chainId && id !== NET.chainId)) throw new Error("the node isn't the testnet in this page's settings");
      W = window.KWallet || null;
      if (W && W.init) W.init({ onChange: () => refreshMine() });
      // Words for the fast clock.
      const mins = Math.round(F.DAY_MS / 60000);
      const words = { day: `test day`, sheet: `${Math.round(F.clock.sheetBefore / 60000)} minutes before the test week`, half: `${Math.round(F.DAY_MS / 120000)} minutes` };
      for (const e of document.querySelectorAll("[data-fx]")) { const w = words[e.getAttribute("data-fx")]; if (w) e.textContent = w; }
      $("how-text").prepend(el("p", {}, el("b", { text: "Testnet practice. " }), `1 test day = ${mins} minutes, so a test week is ${Math.round(7 * mins / 60)} hours. Picks go to a testnet copy of the Picks contract (play money). Teams are scored on real Koinos mainnet producers' blocks, read only, exactly as in the live game.`));
      return;
    }
    let dep = null;
    try { dep = await fetchJson(new URL("picks-data/deployment.json", ROOT)); } catch { /* not live yet */ }
    NET = { rpc: ["https://koinos.armana.io", "https://api.koinos.io"], data: "https://raw.githubusercontent.com/bawcejawn/Knode/games-data/fantasy/",
      picks: dep && isAddr(dep.contract) ? dep.contract : null, explorer: "https://koinosscan.com/address/", chainId: MAINNET_CHAIN_ID };
    provider = new lib.Provider(NET.rpc);
    W = window.KWallet || null;
    if (W && NET.picks) {
      let gd = null;
      try { gd = await fetchJson(new URL("game-data/deployment.json", ROOT)); } catch { /* the wallet keeps its defaults */ }
      W.init({ provider, chainId: gd && gd.chainId, payer: gd && gd.payer, sponsor: gd && gd.sponsor, onChange: () => refreshMine() });
    }
  }
  async function setupPicks() {
    if (!NET.picks) return;
    const abi = await fetchJson(new URL(TESTNET ? "/picks/abi/picks.koilib.json" : "picks/abi/picks.koilib.json", TESTNET ? location.origin : ROOT));
    picks = new lib.Contract({ id: NET.picks, abi, provider });
  }
  const me = () => (W && W.address) || null;

  // ── the recorder's files ──
  const files = { index: null, board: null, days: null, rivals: null, weeks: new Map() };
  const pad = (w) => String(w).padStart(3, "0");
  async function loadFiles() {
    const now = Date.now(), wNow = F.weekOf(now);
    const get = async (name) => { try { const j = await fetchJson(NET.data + name); return j && j.v === 1 ? j : null; } catch { return null; } };
    const [index, board, days, rivals] = await Promise.all(["index.json", "board.json", "days.json", "rivals.json"].map(get));
    Object.assign(files, { index, board, days, rivals });
    for (const w of [wNow - 2, wNow - 1, wNow, wNow + 1]) {
      if (w < 0) continue;
      const j = await get(`W${pad(w)}.json`);
      if (j && j.week === w && j.start === F.weekStart(w)) files.weeks.set(w, j); else files.weeks.delete(w);
    }
  }
  const dayRec = (d) => (files.days && Array.isArray(files.days.days) ? files.days.days.find((x) => x.day === d) : null) || null;
  const liveRec = () => (files.days && files.days.live && files.days.live.final === false ? files.days.live : null);
  const lastFinalDay = () => (files.days && Array.isArray(files.days.days) && files.days.days.length ? files.days.days[files.days.days.length - 1] : null);
  const ixOf = (rec, a) => { const x = rec && rec.producers && rec.producers[a]; return Array.isArray(x) && x[2] != null ? x[2] : null; };

  // ── your picks, from the Picks contract ──
  let mine = { td: null, tw: null, inForce: null, saved: null, weekTeams: [], rivalNow: null, rivalNext: null, rw: null };
  /** Your pick for each day of a week up to day `upTo` (the contract keeps one per round: the latest). */
  async function picksFor(week, upTo) {
    const who = me(), out = {};
    if (!who || !picks) return out;
    const ds = F.weekDays(week).filter((d) => d <= upTo);
    const got = await Promise.all(ds.map((d) => picks.functions.get_pick({ game: G.team, round: String(d), player: who })
      .then((x) => [d, x.result && x.result.pick && Array.isArray(x.result.pick.producers) && x.result.pick.producers.length ? x.result.pick.producers : null]).catch(() => [d, null])));
    for (const [d, l] of got) if (l) out[d] = l;
    return out;
  }
  /** The team in force at the end of `week` (it carries into the next week). From the recorder's final file when
   *  there is one; else worked out from the contract, one week further back at most. */
  async function lastTeamOf(week, depth = 0) {
    if (week < 0) return null;
    const wf = files.weeks.get(week), who = me();
    if (!wf || !wf.sheet || !who) return null;
    const row = (wf.players || []).find((x) => x.a === who);
    if (wf.final) return row && row.days && row.days[6] ? row.days[6].team : null;
    const days = F.weekDays(week), pk = await picksFor(week, days[6]);
    const carried = depth < 1 ? await lastTeamOf(week - 1, depth + 1) : null;
    return F.teamsForWeek(wf.sheet, days, pk, carried)[6].team;
  }
  /** The next day you can still pick for (its lock at least a minute away). */
  /** Before week 1 starts, its first day and the week itself. */
  function targetDay(now = Date.now()) { let d = Math.max(F.dayNo(now), F.weekDays(0)[0]); while (F.lockOfDay(d) - now < 60000) d++; return d; }
  function rivalWeek(now = Date.now()) { let w = now < F.weekStart(0) ? 0 : F.weekOf(now) + 1; while (F.lockOfWeek(w) - now < 60000) w++; return w; }

  let draft = [], draftFor = null;
  async function refreshMine() {
    const now = Date.now(), td = targetDay(now), tw = F.weekOf(F.dayStart(td)), wNow = F.weekOf(now), rw = rivalWeek(now);
    const next = { td, tw, inForce: null, saved: null, weekTeams: [], rivalNow: null, rivalNext: null, rw };
    const who = me();
    if (who && picks) {
      try {
        const twf = files.weeks.get(tw);
        if (twf && twf.sheet) {
          const pk = await picksFor(tw, td);
          next.saved = pk[td] || null;
          const before = { ...pk }; delete before[td];
          const carried = await lastTeamOf(tw - 1);
          const days = F.weekDays(tw), i = days.indexOf(td);
          const teams = F.teamsForWeek(twf.sheet, days, before, carried);
          next.inForce = i > 0 ? teams[i - 1].team : carried;
          next.monday = i === 0;
          next.carriedFits = !!(carried && F.checkTeam(twf.sheet, carried).ok);
          if (tw === wNow) next.weekTeams = teams;
        }
        if (tw !== wNow) {
          const nwf = files.weeks.get(wNow);
          if (nwf && nwf.sheet) { const days = F.weekDays(wNow); next.weekTeams = F.teamsForWeek(nwf.sheet, days, await picksFor(wNow, days[6]), await lastTeamOf(wNow - 1)); }
        }
        const rv = async (w) => { const x = await picks.functions.get_pick({ game: G.rival, round: String(F.rivalRound(w)), player: who }); const l = x.result && x.result.pick && x.result.pick.producers; return Array.isArray(l) && isAddr(l[0]) ? l[0] : null; };
        [next.rivalNow, next.rivalNext] = await Promise.all([rv(wNow).catch(() => null), rv(rw).catch(() => null)]);
      } catch (e) { say(`Couldn't read your picks: ${String((e && e.message) || e).slice(0, 120)}`); }
    }
    const fresh = draftFor !== `${who}|${td}`;
    mine = next;
    if (fresh) { draft = [...(next.saved || next.inForce || [])]; draftFor = `${who}|${td}`; }
    render();
  }

  // ── the team sheet ──
  const sheetOf = (w) => { const wf = files.weeks.get(w); return wf && wf.sheet ? wf.sheet : null; };
  const priceMap = (s) => new Map((s ? s.pool : []).map((p) => [p.a, p.price]));
  const same = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);
  function add(a) { if (draft.includes(a) || draft.length >= FR.TEAM) return; draft.push(a); render(); }
  function remove(a) { draft = draft.filter((x) => x !== a); render(); }
  function captain(a) { if (!draft.includes(a)) return; draft = [a, ...draft.filter((x) => x !== a)]; render(); }
  /** What the draft would do, in words, and whether it can be saved. */
  function verdict() {
    const s = sheetOf(mine.tw);
    if (!s) return { ok: false, text: "" };
    if (!me()) return { ok: false, text: "Connect a wallet to save a team." };
    if (draft.length < FR.TEAM) return { ok: false, text: `Add ${FR.TEAM - draft.length} more producer${FR.TEAM - draft.length > 1 ? "s" : ""}.` };
    const c = F.checkTeam(s, draft);
    if (!c.ok) return { ok: false, bad: true, text: `Can't save: ${c.why}.` };
    if (mine.saved && same(mine.saved, draft)) return { ok: false, text: "This is your saved team." };
    if (mine.monday) {
      // A new week starts fresh: any valid team. Last week's team carries on only if it fits the new list.
      if (!mine.saved && mine.inForce && same(mine.inForce, draft) && mine.carriedFits) return { ok: false, text: "No change: last week's team fits the new prices and carries on." };
      const warn = mine.inForce && !mine.carriedFits && !mine.saved ? " Last week's team doesn't fit the new prices, so save one." : "";
      return { ok: true, text: `New week: pick any team that fits. Cost ${c.cost} of ${s.budget}.${warn}` };
    }
    if (mine.inForce) {
      const n = F.changes(mine.inForce, draft);
      if (n > 1) return { ok: false, bad: true, text: `That's ${n} changes from today's team. One a day: a swap, or moving the captain. Undo ${n - 1}.` };
      if (n === 0 && !mine.saved && same(mine.inForce, draft)) return { ok: false, text: "No change: today's team carries on." };
      const outs = mine.inForce.filter((a) => !draft.includes(a)), ins = draft.filter((a) => !mine.inForce.includes(a));
      const what = outs.length ? `${nameOf(outs[0])} out, ${nameOf(ins[0])} in${draft[0] === ins[0] ? " as captain" : ""}` : draft[0] !== mine.inForce[0] ? `captain's armband to ${nameOf(draft[0])}` : "same producers, new order";
      return { ok: true, text: `Your one change: ${what}. Cost ${c.cost}.` };
    }
    return { ok: true, text: `Your first team. Cost ${c.cost} of ${s.budget}.` };
  }
  function renderSheet() {
    const s = sheetOf(mine.tw), now = Date.now(), lock = mine.td != null ? F.lockOfDay(mine.td) : null;
    $("fx-for").replaceChildren(el("b", { text: `Team for ${when(F.dayStart(mine.td))}` }), ` · week ${mine.tw + 1}${TESTNET ? " (test)" : ""}`);
    $("fx-lock").replaceChildren(lock ? "Locks in " : "", lock ? el("b", { text: dur(lock - now) }) : "");
    const price = priceMap(s);
    $("fx-slots").replaceChildren(...Array.from({ length: FR.TEAM }, (_, i) => {
      const a = draft[i];
      if (!a) return el("div", { class: "fx-slot" }, el("span", { class: "n", text: String(i + 1) }), el("span", { class: "fx-empty-slot", text: i === 0 ? "Captain (×2)" : "Empty" }));
      const slot = el("div", { class: "fx-slot filled" + (i === 0 ? " cap" : "") },
        el("span", { class: "n", text: String(i + 1) }), i === 0 ? el("span", { class: "fx-band", text: "C ×2" }) : null,
        el("span", { class: "who", text: nameOf(a) }),
        el("span", { class: "meta", text: `price ${price.has(a) ? price.get(a) : "–"} · form ${fmt(s && (s.pool.find((p) => p.a === a) || {}).form, 1)}` }),
        el("span", { class: "acts" },
          el("button", { type: "button", "aria-pressed": String(i === 0), "aria-label": `Make ${nameOf(a)} captain`, onclick: () => captain(a) }, i === 0 ? "Captain" : "Make C"),
          el("button", { type: "button", "aria-label": `Remove ${nameOf(a)}`, onclick: () => remove(a) }, "Remove")));
      slot.style.setProperty("--c", colorOf(a));
      return slot;
    }));
    const budget = s ? s.budget : FR.BUDGET, spent = draft.reduce((t, a) => t + (price.get(a) || 0), 0);
    $("fx-spent").textContent = String(spent); $("fx-budget").textContent = String(budget);
    $("fx-left").textContent = spent <= budget ? `${budget - spent} left` : `${spent - budget} over`;
    $("fx-bar").classList.toggle("over", spent > budget);
    $("fx-bar").firstElementChild.style.setProperty("--p", `${Math.min(100, (spent / budget) * 100)}%`);
    const v = verdict(), chk = $("fx-check");
    chk.textContent = !s ? sheetWait() : v.text;
    chk.className = "fx-check" + (v.bad ? " bad" : v.ok ? " ok" : "");
    $("fx-save").disabled = sending || !v.ok || !picks;
    $("fx-save").textContent = !me() ? (TESTNET ? "Choose a test player" : "Connect to save") : mine.saved ? "Save new team" : "Save team";
    if (!me()) $("fx-save").disabled = !picks;
    $("fx-reset").hidden = same(draft, mine.saved || mine.inForce || []);
    $("fx-saved").replaceChildren(...(mine.saved ? ["Saved for this day: ", el("b", { text: mine.saved.map(nameOf).join(", ") })]
      : mine.monday && mine.inForce && !mine.carriedFits ? [el("b", { text: "Last week's team doesn't fit this week's prices." }), " Save a new team, or you score nothing until you do."]
      : mine.inForce ? [mine.monday ? "No new team saved: last week's team carries on." : "No new team saved: today's carries on."] : me() ? ["You have no team yet."] : []));
  }
  function sheetWait() {
    const t = F.sheetTime(mine.tw);
    return Date.now() < t ? `The price list for week ${mine.tw + 1} comes out ${when(t)}. Teams can be saved from then.` : "Waiting for the recorder to publish the price list (every run checks).";
  }

  // ── the price list ──
  let sortBy = "price";
  function renderPool() {
    const s = sheetOf(mine.tw) || sheetOf(F.weekOf(Date.now()));
    const tbody = $("fx-pool").tBodies[0];
    if (!s) { tbody.replaceChildren(); $("pool-sub").textContent = ""; $("pool-note").textContent = sheetWait(); return; }
    const y = lastFinalDay(), lv = liveRec(), vhp = new Map();
    for (const rec of [y, lv]) if (rec && rec.producers) for (const [a, x] of Object.entries(rec.producers)) vhp.set(a, Math.max(vhp.get(a) || 0, x[1]));
    const rows = s.pool.map((p) => ({ ...p, y: ixOf(y, p.a), t: ixOf(lv, p.a), size: vhp.get(p.a) || 0 }));
    const key = { price: (r) => -r.price, form: (r) => -(r.form ?? -1), today: (r) => -(r.t ?? -1), vhp: (r) => -r.size }[sortBy];
    rows.sort((a, b) => key(a) - key(b) || (a.a < b.a ? -1 : 1));
    const full = draft.length >= FR.TEAM, price = priceMap(s), spent = draft.reduce((t, a) => t + (price.get(a) || 0), 0);
    const ixCell = (v) => { const c = el("span", { class: "fx-form" + (v == null ? "" : v >= 103 ? " hi" : v < 90 ? " lo" : ""), text: v == null ? "–" : fmt(v, 1) }); return c; };
    tbody.replaceChildren(...rows.map((r) => {
      const on = draft.includes(r.a), fits = spent + r.price <= s.budget;
      const btn = on ? el("button", { type: "button", class: "rm", "aria-label": `Remove ${nameOf(r.a)}`, onclick: () => remove(r.a) }, "Remove")
        : el("button", { type: "button", "aria-label": `Add ${nameOf(r.a)}`, onclick: () => add(r.a), disabled: full || s !== sheetOf(mine.tw) ? "" : null,
            title: full ? "Your team has 5: remove one first" : fits ? null : "Over the budget with your other picks" }, full || fits ? "Add" : "Add (over)");
      return el("tr", { class: on ? "on" : null }, el("td", {}, nameCell(r.a)), el("td", { class: "num" }, ixCell(r.form)), el("td", { class: "num hide-sm" }, ixCell(r.y)),
        el("td", { class: "num hide-sm" }, ixCell(r.t)), el("td", { class: "num" }, el("span", { class: "fx-price", text: String(r.price) })), el("td", { class: "num" }, btn));
    }));
    $("pool-sub").textContent = `${s.pool.length} producers · median form ${fmt(s.median, 1)} · budget ${s.budget}${s.late ? " · made late" : ""}`;
    const wf = files.weeks.get(s.week);
    $("pool-note").replaceChildren(`Form = blocks signed ÷ expected over the 7 ${TESTNET ? "test days" : "days"} before the list (100 = its fair share). Today = so far, provisional. `,
      wf && wf.sha256 ? el("span", { class: "mono", title: "sha256 of this price list", text: `Fingerprint ${wf.sha256.slice(0, 16)}…` }) : "",
      s.week !== mine.tw ? ` This is week ${s.week + 1}'s list; week ${mine.tw + 1}'s comes out ${when(F.sheetTime(mine.tw))}.` : "");
  }

  // ── your week ──
  function renderWeek() {
    const now = Date.now(), wNow = F.weekOf(now), days = F.weekDays(wNow), today = F.dayNo(now), who = me();
    const wf = files.weeks.get(wNow), row = who && wf ? (wf.players || []).find((x) => x.a === who) : null;
    $("week-sub").textContent = `Week ${wNow + 1}${TESTNET ? " (test)" : ""} · ${when(F.weekStart(wNow))} to ${when(F.weekStart(wNow + 1))}`;
    const lv = liveRec();
    let total = 0;
    $("fx-days").replaceChildren(...days.map((d, i) => {
      const t = mine.weekTeams[i] || null, team = t ? t.team : null;
      const rec = dayRec(d), recRow = row && row.days ? row.days.find((x) => x.day === d) : null;
      let score = null, live = false;
      if (recRow && rec && rec.final) score = recRow.score;
      else if (team && rec && rec.final) score = F.dayScore(team, rec);
      else if (team && d === today && lv && lv.day === d) { score = F.dayScore(team, lv); live = true; }
      if (score != null && !live) total += score;          // today so far is shown on its own, not in the week's points
      const label = new Date(F.dayStart(d)).toLocaleString(undefined, TESTNET ? { hour: "numeric", minute: "2-digit" } : { weekday: "short" });
      return el("div", { class: "fx-day" + (d === today ? " now" : "") + (live ? " live" : ""), title: team ? team.map(nameOf).join(", ") : "" },
        el("span", { text: label }), el("b", { text: score == null ? (d > today ? "·" : "–") : fmt(score, 0) }),
        el("span", { class: "cap", text: team ? `C ${nameOf(team[0])}` : d > today ? "to come" : "no team" }),
        t && t.note ? el("span", { class: "warn", text: t.note }) : null);
    }));
    const lb = files.board && files.board.week && files.board.week.week === wNow ? files.board.week.rows : [];
    const mineRow = who ? lb.find((x) => x.a === who) : null;
    $("you").hidden = !who;
    $("you-pts").textContent = fmt(total, 0);
    $("you-rank").textContent = mineRow ? `#${mineRow.place}` : "–";
    const tToday = mine.weekTeams[days.indexOf(today)];
    $("you-today").textContent = tToday && tToday.team && lv && lv.day === today ? fmt(F.dayScore(tToday.team, lv), 0) : "–";
    $("you-rival").textContent = mine.rivalNow ? nameOf(mine.rivalNow) : "none";
    $("week-note").textContent = !who ? "Connect a wallet to see your week." : `Recorded ${TESTNET ? "test days" : "days"} count once their blocks are irreversible and match on two nodes; today (·) is provisional. Points are the recorder's when it has them.`;
  }

  // ── the league ──
  let leagueWeek = "now";
  function renderLeague() {
    const b = files.board, part = b ? (leagueWeek === "now" ? b.week : b.lastWeek) : null, who = me();
    const wf = part ? files.weeks.get(part.week) : null, vault = new Map(((wf && wf.players) || []).map((x) => [x.a, x.vault]));
    const rows = part && Array.isArray(part.rows) ? part.rows : [];
    $("fx-league").tBodies[0].replaceChildren(...rows.slice(0, 50).map((r) => el("tr", { class: r.a === who ? "me" : null },
      el("td", { class: "num", text: String(r.place) }), el("td", {}, el("span", { class: "fx-name" }, dot(r.a), el("span", { text: nameOf(r.a) }), r.full ? null : el("span", { class: "fx-pill", title: "Didn't have a team all 7 days", text: "part week" }))),
      el("td", { class: "num", text: fmt(r.points, 0) }), el("td", { class: "num hide-sm", text: vault.has(r.a) && part.final ? String(vault.get(r.a)) : "–" }))));
    $("league-sub").textContent = part ? `Week ${part.week + 1}${part.final ? " · final" : " · still counting"}` : "";
    const meRow = who ? rows.find((x) => x.a === who) : null;
    $("league-note").textContent = !rows.length ? "No teams recorded yet." : `${rows.length} player${rows.length > 1 ? "s" : ""}.${meRow && rows.length > 50 && meRow.place > 50 ? ` You: #${meRow.place}.` : ""} Vault = the points posted to the vault: 255 for the best week, one less for each lower score (only the order counts).`;
  }

  // ── Weekly Rival ──
  function renderRival() {
    const who = me(), wNow = F.weekOf(Date.now()), b = files.board, wf = files.weeks.get(wNow);
    const pts = new Map(((b && b.week && b.week.rows) || []).map((r) => [r.a, r]));
    const match = $("fx-match");
    if (!who) match.replaceChildren(el("p", { class: "note", text: "Connect a wallet to see your rival." }));
    else if (mine.rivalNow) {
      const a = pts.get(who), z = pts.get(mine.rivalNow);
      match.replaceChildren(el("div", { class: "fx-vs" },
        el("div", { class: "side" }, el("span", { text: "You" }), el("b", { text: fmt(a ? a.points : 0, 0) })),
        el("span", { class: "mid", text: "vs" }),
        el("div", { class: "side r" }, el("span", { text: nameOf(mine.rivalNow) }), el("b", { text: fmt(z ? z.points : 0, 0) }))),
        el("p", { class: "note", text: "This week's challenge. It counts if you both have a team all 7 days." }));
    } else match.replaceChildren(el("p", { class: "note", text: `No rival this week.` }));
    const against = wf && Array.isArray(wf.rivals) ? wf.rivals.filter((x) => x[1] === who).map((x) => x[0]) : [];
    if (who && against.length) match.append(el("p", { class: "note", text: `Challenged by ${against.length}: ${against.slice(0, 6).map(nameOf).join(", ")}${against.length > 6 ? "…" : ""}` }));
    // Your record.
    const rec = who && files.rivals && files.rivals.records ? files.rivals.records[who] : null;
    const line = (x) => (x ? `${x[0]}–${x[1]}–${x[2]}` : "0–0–0");
    const all = rec ? F.recordLine(rec) : null;
    $("fx-rec").replaceChildren(el("div", {}, el("b", { text: line(rec && rec.made) }), "challenges made"), el("div", {}, el("b", { text: line(rec && rec.received) }), "challenges received"),
      el("div", {}, el("b", { text: all ? `${Math.round(all.pct * 100)}%` : "–" }), all ? `of ${all.n} matches won` : "no matches yet"));
    // Challenge for next week.
    $("ch-title").textContent = `Challenge someone for week ${mine.rw + 1}`;
    const sel = $("fx-rival-pick"), opts = new Map();
    for (const part of [b && b.week, b && b.lastWeek]) for (const r of (part && part.rows) || []) if (r.a !== who && !opts.has(r.a)) opts.set(r.a, r);
    for (const [a] of players) if (a !== who && !opts.has(a)) opts.set(a, null);
    const keep = sel.value;
    sel.replaceChildren(el("option", { value: "", text: opts.size ? "Choose a player…" : "No players yet: paste an address" }),
      ...[...opts.keys()].map((a) => el("option", { value: a, text: `${nameOf(a)}${opts.get(a) ? ` · ${fmt(opts.get(a).points, 0)} pts` : ""}` })));
    if ([...opts.keys()].includes(keep)) sel.value = keep;
    $("fx-rival-send").disabled = sending || !picks || !who;
    $("rival-note").textContent = !picks ? "Challenges open when the Picks contract is live." : mine.rivalNext ? `Your challenge for week ${mine.rw + 1}: ${nameOf(mine.rivalNext)}. You can change it until ${when(F.lockOfWeek(mine.rw))}.` : `Locks ${when(F.lockOfWeek(mine.rw))}.`;
    // The best records and the most challenged.
    const rows = (b && Array.isArray(b.rivals) ? b.rivals : []).slice(0, 10);
    $("fx-rivals").tBodies[0].replaceChildren(...rows.map((r) => el("tr", { class: r.a === who ? "me" : null }, el("td", {}, nameCell(r.a)), el("td", { class: "num", text: `${r.w}–${r.l}–${r.d}` }), el("td", { class: "num", text: `${Math.round(r.pct * 100)}%` }))));
    const most = b && Array.isArray(b.mostChallenged) ? b.mostChallenged : [];
    $("rivals-note").textContent = `${rows.length ? "" : "No one has 4 matches yet. "}${most.length ? `Most challenged this week: ${most.map((x) => `${nameOf(x.a)} (${x.n})`).join(", ")}.` : ""}`;
  }

  // ── sending ──
  let sending = false, modal = null;
  function pop(state, title, lines = [], actions = []) {
    if (!modal) { modal = el("div", { class: "fx-modal", role: "dialog", "aria-modal": "true", "aria-labelledby": "fx-m-title" }); modal.addEventListener("click", (e) => { if (e.target === modal && !modal.querySelector(".fx-spin")) closePop(); }); document.body.append(modal); }
    const icon = { busy: el("span", { class: "fx-spin", "aria-hidden": "true" }), ok: el("span", { class: "fx-big ok", text: "✓" }), bad: el("span", { class: "fx-big bad", text: "✗" }), info: el("span", { class: "fx-big", text: "ℹ" }) }[state];
    modal.replaceChildren(el("div", { class: "fx-box" }, icon, el("h3", { id: "fx-m-title", text: title }), ...lines.map((l) => (typeof l === "string" ? el("p", { text: l }) : l)), actions.length ? el("div", { class: "acts" }, ...actions) : null));
    modal.hidden = false;
    const b = modal.querySelector("button"); if (b) b.focus();
  }
  function closePop() { if (modal) modal.hidden = true; }
  const okBtn = (t = "Done") => el("button", { class: "btn btn-primary", type: "button", onclick: closePop }, t);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && modal && !modal.hidden && !modal.querySelector(".fx-spin")) closePop(); });
  function why(e) {
    const m = String((e && e.message) || e);
    return /locked/i.test(m) ? "That one has locked: picks close 5 minutes before."
      : /not open yet/i.test(m) ? "That isn't open yet."
      : /used up/i.test(m) ? "Today's picks are used up (changes count). More after 00:00 UTC."
      : /changed again|changes/i.test(m) && /PICKS/.test(m) ? "That pick has been changed too many times already."
      : /already your pick/i.test(m) ? "That is already your pick."
      : /closed|switched off/i.test(m) ? "This game is switched off right now."
      : /pending account resources|insufficient.*(rc|mana|resources)/i.test(m) ? "Your Mana is still held by your last transaction. Try again in a minute."
      : /reject|denied|cancel/i.test(m) ? "Cancelled in your wallet. Nothing was sent."
      : `Not sent: ${m.slice(0, 200)}`;
  }
  async function confirmPick(game, round, list, check) {
    for (let t = 0; t < 10; t++) {
      try { const x = await picks.functions.get_pick({ game, round: String(round), player: me() }); const l = x.result && x.result.pick && x.result.pick.producers; if (same(l, list)) return true; } catch { /* again */ }
      await new Promise((r) => setTimeout(r, 3000));
    }
    void check; return false;
  }
  async function saveTeam() {
    if (!me()) { if (W && W.connect) W.connect(); else say(TESTNET ? "Choose a test player in the red bar first." : "Connect a wallet first."); return; }
    const v = verdict();
    if (!v.ok || sending || !picks) return;
    const td = mine.td, list = [...draft];
    if (F.lockOfDay(td) - Date.now() < 60000) { pop("bad", "Too close to the lock", ["That day locks in under a minute. Your team goes to the next one: try again."], [okBtn("OK")]); await refreshMine(); return; }
    sending = true; render();
    const what = `C ${nameOf(list[0])}, ${list.slice(1).map(nameOf).join(", ")}`;
    pop("busy", W.kind === "test" || W.kind === "guest" ? "Saving your team…" : `Confirm in ${W.label ? W.label() : "your wallet"}`, [`For ${when(F.dayStart(td))}: ${what}.`, TESTNET ? "Testnet: play money." : "Free: the Knode Mana sponsor pays the Mana."]);
    try {
      const { operation } = await picks.functions.pick({ player: me(), game: G.team, round: String(td), producers: list, number: "0" }, { onlyOperation: true });
      const id = await W.send(`Fantasy team for ${when(F.dayStart(td))}`, [operation]);
      pop("busy", "Sent. Checking the chain…", [what]);
      const ok = await confirmPick(G.team, td, list);
      draftFor = null;
      pop(ok ? "ok" : "info", ok ? "Team saved" : "Sent, not seen yet", [ok ? `It plays from ${when(F.dayStart(td))} and carries on until you change it. You can change it until ${when(F.lockOfDay(td))}.` : "Your wallet sent it. It usually shows within a minute.",
        id ? el("p", { class: "mono", text: `Transaction ${String(id).slice(0, 18)}…` }) : null].filter(Boolean), [okBtn()]);
    } catch (e) { const w = why(e); pop(/Cancelled/.test(w) ? "info" : "bad", /Cancelled/.test(w) ? "Cancelled" : "Team not saved", [w], [okBtn("OK")]); }
    finally { sending = false; await refreshMine(); }
  }
  async function sendRival() {
    if (!me()) { if (W && W.connect) W.connect(); return; }
    const typed = $("fx-rival-addr").value.trim(), target = typed || $("fx-rival-pick").value;
    if (!isAddr(target)) { pop("info", "Choose a rival", ["Choose a player from the list, or paste a Koinos wallet address."], [okBtn("OK")]); return; }
    if (target === me()) { pop("info", "Not yourself", ["Choose someone else to challenge."], [okBtn("OK")]); return; }
    if (target === mine.rivalNext) { pop("info", "Already your challenge", [`${nameOf(target)} for week ${mine.rw + 1}.`], [okBtn("OK")]); return; }
    if (sending || !picks) return;
    const rw = mine.rw;
    sending = true; render();
    pop("busy", W.kind === "test" || W.kind === "guest" ? "Sending your challenge…" : `Confirm in ${W.label ? W.label() : "your wallet"}`, [`You challenge ${nameOf(target)} for week ${rw + 1}.`]);
    try {
      const { operation } = await picks.functions.pick({ player: me(), game: G.rival, round: String(F.rivalRound(rw)), producers: [target], number: "0" }, { onlyOperation: true });
      await W.send(`Weekly Rival: challenge ${nameOf(target)}`, [operation]);
      const ok = await confirmPick(G.rival, F.rivalRound(rw), [target]);
      $("fx-rival-addr").value = "";
      pop(ok ? "ok" : "info", ok ? "Challenge sent" : "Sent, not seen yet", [ok ? `${nameOf(target)} is your rival for week ${rw + 1}. It counts if you both have a team all 7 days.` : "It usually shows within a minute."], [okBtn()]);
    } catch (e) { const w = why(e); pop(/Cancelled/.test(w) ? "info" : "bad", /Cancelled/.test(w) ? "Cancelled" : "Challenge not sent", [w], [okBtn("OK")]); }
    finally { sending = false; await refreshMine(); }
  }

  function render() {
    if (mine.td == null) return;
    renderSheet(); renderPool(); renderWeek(); renderLeague(); renderRival();
  }

  // ── start ──
  (async () => {
    try { await setupNet(); }
    catch (e) { say(TESTNET ? `Testnet settings problem: ${String((e && e.message) || e)}` : "Couldn't load the game settings."); return; }
    $("fx-save").addEventListener("click", saveTeam);
    $("fx-reset").addEventListener("click", () => { draft = [...(mine.saved || mine.inForce || [])]; render(); });
    $("fx-rival-send").addEventListener("click", sendRival);
    for (const b of document.querySelectorAll("[data-sort]")) b.addEventListener("click", () => { sortBy = b.dataset.sort; for (const x of document.querySelectorAll("[data-sort]")) x.setAttribute("aria-pressed", String(x === b)); renderPool(); });
    for (const b of document.querySelectorAll("[data-week]")) b.addEventListener("click", () => { leagueWeek = b.dataset.week; for (const x of document.querySelectorAll("[data-week]")) x.setAttribute("aria-pressed", String(x === b)); renderLeague(); });
    if (W && W.subscribe) W.subscribe(() => { draftFor = null; refreshMine(); });
    await setupPicks().catch(() => {});
    await loadFiles();
    mine.td = targetDay(); mine.tw = F.weekOf(F.dayStart(mine.td)); mine.rw = rivalWeek();
    say(!NET.picks ? "Teams open when the Knode Games Picks contract is live. Until then you can watch the price list and the league." : files.index ? "" : "No results recorded yet.");
    await refreshMine();
    setInterval(() => { if (!document.hidden) renderSheet(); }, 15000);
    setInterval(() => { if (!document.hidden) loadFiles().then(refreshMine); }, TESTNET ? 60000 : 300000);
    // A new day to pick for (the old one locked): move the sheet on.
    setInterval(() => { if (!document.hidden && mine.td !== targetDay()) { draftFor = null; refreshMine(); } }, 20000);
  })();
})();

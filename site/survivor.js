/* survivor.html: Survivor. It reads the chain's recent blocks (for today's live standings), the Survivor recorder's
   files (games-data/survivor: the handicaps and the season) and, once the KnodeGames Picks contract is live
   (picks-data/deployment.json), your picks from the contract. It sends one thing: a pick you confirm in your wallet.
   The scoring is survivor-math.js, the same file the recorder (bot/games/survivor.ts) uses. */
(() => {
  "use strict";
  const S = window.KSurvivor;
  if (!S || typeof document === "undefined" || !document.getElementById("days")) return;

  const lib = window.koilib || window.koinos || window;
  const RPC = "https://api.koinos.io";
  const DATA = "https://raw.githubusercontent.com/bawcejawn/Knode/games-data/survivor/";
  const EXPLORER = "https://koinosscan.com/address/";
  // Knode's own two producers are in the field like any other (owner's decision 2026-10-27; disclosed on the page).
  const NAMES = { "1Mpmf2ERhjYpX7CCiM11WERuM4j17uT1sr": "Knode pool", "1FKTpXBhhHEbu5vVchM8UsVbAvPArJsRmR": "Knode Swap" };
  const ROOT = new URL("../", location.href);
  const provider = new lib.Provider([RPC]);
  const W = window.KWallet;
  const MARGIN = 2 * 60000;                     // the page offers a day only while its lock is more than 2 minutes away

  const $ = (id) => document.getElementById(id);
  const el = (tag, attrs = {}, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (k === "text") e.textContent = v; else if (k.startsWith("on")) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v); } for (const c of kids) if (c != null) e.append(c); return e; };
  const isAddr = (a) => typeof a === "string" && /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a);
  const nameOf = (a) => (isAddr(a) ? NAMES[a] || a.slice(0, 5) + "…" + a.slice(-4) : "–");
  const fmt = (n, d = 0) => Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
  const dayName = (d) => new Date(S.dayStart(d)).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  const localTime = (t) => new Date(t).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
  const dur = (ms) => { const m = Math.max(0, Math.ceil(ms / 60000)); return m >= 1440 ? `${Math.floor(m / 1440)} d ${Math.floor((m % 1440) / 60)} h` : m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min` : `${m} min`; };
  const hearts = (n) => "♥".repeat(Math.max(0, n)) + "♡".repeat(Math.max(0, S.LIVES - n));
  const say = (t) => { $("status").textContent = t; $("status").hidden = !t; };
  async function fetchJson(url) { const r = await fetch(url, { cache: "no-cache" }); if (!r.ok) throw new Error(String(r.status)); return r.json(); }
  const me = () => (W && W.address) || null;

  let fields = new Map();          // day → { field, out, n, season } from fields.json
  let season = null;               // the current (or last) season file
  let B = null;                    // recent blocks (chain-blocks.js)
  let picksContract = null, myPicks = new Map(), usage = null, sending = false;
  const drafts = new Map();

  const today = () => S.dayIndex(Date.now());
  /** The field for day d: its own when published, else the latest one (the page says which). */
  function fieldFor(d) {
    if (fields.has(d)) return { ...fields.get(d), exact: true };
    const known = [...fields.keys()].sort((a, b) => b - a);
    return known.length ? { ...fields.get(known[0]), exact: false } : null;
  }

  // ── data ──
  async function loadData() {
    try {
      const f = await fetchJson(DATA + "fields.json");
      if (f && f.v === 1 && Array.isArray(f.fields)) fields = new Map(f.fields.filter((x) => x && Number.isInteger(x.day) && Array.isArray(x.field)).map((x) => [x.day, x]));
    } catch { /* none yet */ }
    const se = S.seasonOf(today());
    season = null;
    if (se) {
      for (const s of [se.season, se.season - 1]) {
        if (s < 1) continue;
        try { const j = await fetchJson(`${DATA}S${String(s).padStart(3, "0")}.json`); if (j && j.v === 1 && j.season === s && Array.isArray(j.days)) { season = j; break; } } catch { /* none yet */ }
      }
    }
  }

  // ── today, live ──
  function liveCounts() {
    if (!B) return null;
    const from = S.dayStart(today()), m = new Map();
    for (let i = B.ts.length - 1; i >= 0 && B.ts[i] >= from; i--) { const a = B.signers[B.sig[i]]; m.set(a, (m.get(a) || 0) + 1); }
    return [...m.entries()];
  }
  function renderToday() {
    const d = today(), f = fields.get(d), se = S.seasonOf(d), n = se ? se.n : 1;
    $("today-title").textContent = se ? `Today: season ${se.season}, day ${se.n} of ${S.SEASON_DAYS}` : "Today (practice)";
    if (!f) { $("today-sub").textContent = "Waiting for the recorder's handicaps for today…"; $("today-rows").replaceChildren(); return; }
    const counts = liveCounts();
    if (!counts) { $("today-sub").textContent = "Reading today's blocks…"; return; }
    const sc = S.scoreDay(f.field, counts, n), out = new Set(sc.out);
    const mine = me() ? myPicks.get(d) : null, mineP = mine && mine.producers && mine.producers[0];
    const total = counts.reduce((s, x) => s + x[1], 0);
    $("today-sub").textContent = `${fmt(total)} blocks so far today (UTC). The bottom ${sc.out.length} of ${sc.rows.length} are in the out-zone right now${sc.line !== null ? `; safe from a score of ${fmt(sc.line, 1)}` : ""}. Live, not final.`;
    $("today-rows").replaceChildren(...sc.rows.map((r, i) => el("tr", { class: `${out.has(r.a) ? "oz" : ""} ${r.a === mineP ? "me" : ""}` },
      el("td", { class: "num", text: String(i + 1) }),
      el("td", { class: "mono" }, el("a", { href: EXPLORER + r.a, target: "_blank", rel: "noopener noreferrer", text: nameOf(r.a) }), r.a === mineP ? el("span", { class: "you", text: " your pick" }) : null),
      el("td", { class: "num", text: fmt(r.blocks) }),
      el("td", { class: "num hide-sm", text: `×${fmt(r.h, 2)}` }),
      el("td", { class: "num", text: fmt(r.score, 1) }),
      el("td", {}, el("span", { class: `chip ${out.has(r.a) ? "bad" : "ok"}`, text: out.has(r.a) ? "Out-zone" : "Safe" })))));
  }

  // ── the picks contract (live once picks-data/deployment.json is on the site) ──
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
    const who = me();
    myPicks = new Map(); usage = null;
    if (picksContract && who) {
      // Today, the open days, and day 1 of the current season (whether you joined, before the recorder has it).
      const se = S.seasonOf(today());
      const days = [today(), ...S.openDays(Date.now()), ...(se ? [se.start] : [])].filter((d, i, a) => a.indexOf(d) === i);
      try {
        const got = await Promise.all(days.map((d) => picksContract.functions.get_pick({ game: S.GAME_ID, round: String(d), player: who })
          .then((x) => [d, x.result && x.result.pick && Array.isArray(x.result.pick.producers) && x.result.pick.producers.length ? x.result.pick : null])));
        for (const [d, p] of got) if (p) myPicks.set(d, p);
        usage = (await picksContract.functions.get_usage({ game: S.GAME_ID, player: who })).result || null;
      } catch { /* shown as unknown */ }
    }
    renderDays(true); renderToday(); renderStandings();
  }

  // ── where I stand in the season ──
  function mySeason(s = null) {
    const who = me();
    if (!who || !season || !season.result || (s !== null && season.season !== s)) return null;
    return season.result.players.find((x) => x.a === who) || null;
  }
  /** Can I pick for day d? Day 1 of a season is open to everyone; later days only to players still in. */
  function canPickDay(d) {
    const sd = S.seasonOf(d);
    if (!sd) return false;
    if (sd.n === 1) return true;
    const rec = mySeason(sd.season);
    if (rec) return rec.outN === null;
    // The recorder hasn't recorded day 1 yet: you're in if you picked for it.
    return !(season && season.season === sd.season && season.days.length) && myPicks.has(sd.start);
  }
  /** Producers I can't pick for day d: used this season, or already my pick for another open day this season. */
  function blockedFor(d) {
    const out = new Map();
    const se = S.seasonOf(d);
    const mineS = se ? mySeason(se.season) : null;
    for (const a of (mineS && mineS.used) || []) out.set(a, "used");
    for (const [x, p] of myPicks) {
      const sx = S.seasonOf(x);
      if (x !== d && se && sx && sx.season === se.season && p.producers && p.producers[0] && x >= today()) out.set(p.producers[0], `picked for ${dayName(x)}`);
    }
    return out;
  }

  // ── the open days ──
  let daysKey = "";
  function renderDays(force = false) {
    const list = $("days");
    if (!force && list.contains(document.activeElement) && document.activeElement.tagName === "SELECT") return;
    const who = me(), now = Date.now(), days = S.openDays(now).filter((d) => S.lockTime(d) - now > MARGIN);
    const key = JSON.stringify([who, W && W.kind, days[0], sending, !!picksContract, [...fields.keys()], usage && usage.picks_today, [...myPicks.entries()].map(([d, p]) => [d, p.producers && p.producers[0]]), season && season.days.length]);
    if (!force && key === daysKey && list.childElementCount) { updateTimes(); return; }
    daysKey = key;
    const se = S.seasonOf(today());
    const mineS = se ? mySeason(se.season) : null;
    $("season-line").textContent = !Number.isInteger(S.FIRST_DAY) ? "Season 1 starts after launch. Until then, watch the live standings and the handicaps."
      : !se ? `Season 1 starts ${dayName(S.FIRST_DAY)}. Pick for its day 1 to join.`
      : mineS ? (mineS.outN === null ? `Season ${se.season}: you're in, ${hearts(mineS.lives)} (${mineS.lives} ${mineS.lives === 1 ? "life" : "lives"} left).` : `Season ${se.season}: you went out on day ${mineS.outN}. Next season starts ${dayName(S.seasonStartDay(se.season + 1))}.`)
      : `Season ${se.season}, day ${se.n}. Join season ${se.season + 1} by picking for its day 1, ${dayName(S.seasonStartDay(se.season + 1))}.`;
    const max = usage ? Number(usage.max_picks_per_day) || S.PICKS_PER_DAY : S.PICKS_PER_DAY, used = usage ? Number(usage.picks_today) || 0 : 0;
    $("picks-left").textContent = usage ? `${Math.max(0, max - used)} of ${max} picks left today` : "";
    $("picks-who").textContent = !picksContract ? "" : who ? `Picking as ${nameOf(who)}${W.kind === "guest" ? " (guest)" : ""}.` : "Connect a wallet to pick (Kondor, KOIN Vault or a guest wallet).";
    const rows = [];
    for (const d of days) {
      const sd = S.seasonOf(d), f = fieldFor(d), mine = myPicks.get(d), mineP = mine && mine.producers && mine.producers[0];
      const blocked = blockedFor(d);
      const label = sd ? `Season ${sd.season} · day ${sd.n}` : "Practice";
      const when = el("div", { class: "bx-when" },
        el("b", { text: dayName(d) }),
        el("span", { class: "bx-eta", text: label }),
        el("span", { class: "bx-eta", "data-lock": String(S.lockTime(d)), text: `locks ${localTime(S.lockTime(d))} · in ${dur(S.lockTime(d) - now)}` }));
      let cell;
      if (!picksContract) cell = el("div", { class: "bx-now", text: "Picks open soon" });
      else if (!sd) cell = el("div", { class: "bx-now", text: "Practice day: no season yet." });
      else if (!canPickDay(d)) cell = el("div", { class: "bx-now", text: `You're not in season ${sd.season} (or you're out). Join the next one by picking for its day 1.` });
      else if (!who) cell = el("div", { class: "bx-now", text: mineP ? `Your pick: ${nameOf(mineP)}` : "–" });
      else {
        const opts = f ? f.field : [];
        const sel = el("select", { "aria-label": `Producer for ${dayName(d)}` },
          el("option", { value: "", text: !opts.length ? "Waiting for the handicaps…" : mineP ? "Change to…" : "Who stays out of the out-zone?" }),
          ...opts.map((p) => {
            const why = p.a !== mineP ? blocked.get(p.a) : null;
            const o = el("option", { value: p.a, text: `${nameOf(p.a)} · ×${fmt(p.h, 2)}${why ? ` · ${why}` : ""}` });
            if (why) o.disabled = true;
            if (p.a === (drafts.get(d) || mineP)) o.selected = true;
            return o;
          }));
        if (!opts.length) sel.disabled = true;
        sel.addEventListener("change", () => { if (sel.value) drafts.set(d, sel.value); else drafts.delete(d); });
        const btn = el("button", { class: "btn", type: "button", onclick: () => sendPick(d, sel.value) }, mineP ? "Change" : "Pick");
        if (sending || used >= max || (mine && Number(mine.changes) >= S.MAX_CHANGES)) btn.disabled = true;
        const notes = [];
        if (mineP) notes.push(el("div", { class: "bx-now", text: `Your pick: ${nameOf(mineP)}${f && f.exact && !f.field.some((x) => x.a === mineP) ? " (not in this day's field: it would cost a life)" : ""}` }));
        else if (sd.n > 1) notes.push(el("div", { class: "bx-now warn", text: "No pick yet: a day without a pick costs a life." }));
        if (f && !f.exact) notes.push(el("div", { class: "bx-now", text: "Handicaps for this day aren't out yet; showing the latest. They're published the day before." }));
        cell = el("div", { class: "bx-pick" }, sel, btn, ...notes);
      }
      rows.push(el("div", { class: `bx-row${mineP ? " mine" : ""}` }, when, cell));
    }
    list.replaceChildren(...rows);
  }
  function updateTimes() {
    document.querySelectorAll("#days [data-lock]").forEach((n) => { const t = Number(n.dataset.lock); n.textContent = `locks ${localTime(t)} · in ${dur(t - Date.now())}`; });
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

  async function sendPick(d, producer) {
    const who = me();
    if (!who || !picksContract || sending) return;
    if (!isAddr(producer)) return pickModal("info", "Choose a producer first", ["Pick the producer you think stays out of the out-zone, then press Pick."], [okBtn("OK")]);
    const mine = myPicks.get(d);
    if (mine && mine.producers && mine.producers[0] === producer) return pickModal("info", "That is already your pick", [`${nameOf(producer)} for ${dayName(d)}.`], [okBtn("OK")]);
    const why = blockedFor(d).get(producer);
    if (why) return pickModal("info", "You can't use that producer again", [`${nameOf(producer)}: ${why}. Each producer once a season.`], [okBtn("OK")]);
    if (!(S.lockTime(d) - Date.now() > MARGIN)) return pickModal("bad", "Too close to the lock", [`${dayName(d)} locks in a moment. Pick a later day.`], [okBtn("OK")]);
    sending = true; renderDays(true);
    const f = fieldFor(d), h = f && f.field.find((x) => x.a === producer);
    const what = `${nameOf(producer)} for ${dayName(d)} (UTC)`;
    const wallet = W.kind === "guest" ? "your guest wallet" : W.label ? W.label() : "your wallet";
    pickModal("busy", W.kind === "guest" ? "Sending your pick…" : `Confirm in ${wallet}`, [what, h ? `Handicap ×${fmt(h.h, 2)}.` : "", "Free: the Knode Mana sponsor pays the Mana."].filter(Boolean));
    try {
      const { operation } = await picksContract.functions.pick({ player: who, game: S.GAME_ID, round: String(d), producers: [producer], number: "0" }, { onlyOperation: true });
      const id = await W.send(`Survivor pick ${nameOf(producer)} for ${dayName(d)}`, [operation]);
      pickModal("busy", "Sent. Checking the chain…", [what]);
      let onChain = false;
      for (let t = 0; t < 10 && !onChain; t++) {
        try { const x = await picksContract.functions.get_pick({ game: S.GAME_ID, round: String(d), player: who }); onChain = !!(x.result && x.result.pick && x.result.pick.producers && x.result.pick.producers[0] === producer); } catch { /* again */ }
        if (!onChain) await new Promise((res) => setTimeout(res, 3000));
      }
      drafts.delete(d);
      if (onChain) pickModal("ok", "Pick confirmed", [el("p", {}, "Your pick: ", el("b", { text: nameOf(producer) }), ` for ${dayName(d)}.`),
        `It locks at 23:55 UTC the night before (${localTime(S.lockTime(d))} your time). Until then you can change it (up to ${S.MAX_CHANGES} times).`,
        id ? el("p", { class: "ago mono", text: `Transaction ${String(id).slice(0, 18)}…` }) : null].filter(Boolean), [okBtn()]);
      else pickModal("info", "Sent, not seen on the chain yet", ["Your wallet sent it. It usually shows within a minute; this list updates by itself."], [okBtn("OK")]);
    } catch (e) {
      const m = String((e && e.message) || e);
      const why2 = /locked/i.test(m) ? "That day is locked: picks close at 23:55 UTC the night before."
        : /not open yet/i.test(m) ? "That day isn't open yet (picks open 7 days ahead)."
        : /used up/i.test(m) ? "Today's picks are used up (changes count). More after 00:00 UTC."
        : /changed again/i.test(m) ? `That pick has been changed ${S.MAX_CHANGES} times already.`
        : /already your pick/i.test(m) ? "That is already your pick."
        : /reject|denied|cancel/i.test(m) ? "Cancelled in your wallet. Nothing was sent."
        : `Not sent: ${m.slice(0, 200)}`;
      pickModal(/Cancelled/.test(why2) ? "info" : "bad", /Cancelled/.test(why2) ? "Cancelled" : "Pick not sent", [why2], [okBtn("OK")]);
    } finally { sending = false; await loadMine(); }
  }

  // ── the season standings ──
  function renderStandings() {
    if (!season || !season.result || !season.result.players.length) { $("standings-box").hidden = true; return; }
    $("standings-box").hidden = false;
    const r = season.result, who = me();
    const inNow = r.players.filter((x) => x.outN === null).length;
    $("standings-title").textContent = `Season ${season.season} standings`;
    $("standings-sub").textContent = r.final ? `final after day ${r.endN}` : r.over ? `ended after day ${r.endN}; final 12 hours later` : `after day ${r.endN} of ${S.SEASON_DAYS} · ${inNow} of ${r.players.length} still in`;
    const medal = ["🥇", "🥈"];
    $("prizes").replaceChildren(...(r.final ? r.prizes : []).map((p) => el("div", { class: "champ" }, el("b", { text: `${medal[p.place - 1] || "🥈"} ${fmt(p.vhp, p.vhp % 1 ? 2 : 0)} VHP` }), el("span", { class: "mono", text: nameOf(p.player) }))));
    $("standings-rows").replaceChildren(...r.players.slice(0, 100).map((x) => el("tr", { class: `${x.outN === null ? "" : "gone"} ${x.a === who ? "me" : ""}` },
      el("td", { class: "num", text: String(x.place) }),
      el("td", { class: "mono" }, el("a", { href: EXPLORER + x.a, target: "_blank", rel: "noopener noreferrer", text: nameOf(x.a) }), x.eligible ? null : el("span", { class: "ago", title: "Didn't hold 1 VHP at every daily check: can't win a prize", text: " · no prize" })),
      el("td", { class: "lives", "aria-label": `${x.lives} lives`, text: x.outN === null ? hearts(x.lives) : `out day ${x.outN}` }),
      el("td", { class: "num", text: fmt(x.total, 1) }),
      el("td", { class: "num hide-sm", text: String(x.used.length) }))));
    const mine = mySeason();
    $("me-line").textContent = !who ? "" : !mine ? "You're not in this season." : `You: #${mine.place}, ${mine.outN === null ? `${mine.lives} ${mine.lives === 1 ? "life" : "lives"} left` : `out on day ${mine.outN}`}, ${mine.used.length} producer${mine.used.length === 1 ? "" : "s"} used.${mine.eligible ? "" : " You didn't hold 1 VHP at every daily check, so you can't win a prize this season."}`;
  }

  // ── tomorrow's handicaps ──
  function renderField() {
    const d = today() + 1, f = fields.get(d) || fields.get(today());
    if (!f) { $("field-sub").textContent = "Waiting for the recorder…"; return; }
    const sd = S.seasonOf(f.day);
    $("field-title").textContent = f.day === d ? "Tomorrow's handicaps" : "Today's handicaps";
    $("field-sub").textContent = `${dayName(f.day)}${sd ? `, season ${sd.season} day ${sd.n}` : ""}: ${f.field.length} producers, the bottom ${f.out} are the out-zone. From each producer's blocks over ${dayName(f.day - 8)} to ${dayName(f.day - 2)}.`;
    $("field-rows").replaceChildren(...f.field.map((p) => el("tr", {},
      el("td", { class: "mono" }, el("a", { href: EXPLORER + p.a, target: "_blank", rel: "noopener noreferrer", text: nameOf(p.a) })),
      el("td", { class: "num", text: fmt(p.k) }),
      el("td", { class: "num hide-sm", text: fmt(p.k / S.FORM_DAYS, 0) }),
      el("td", { class: "num", text: `×${fmt(p.h, 2)}` }))));
  }

  // ── start ──
  async function refreshBlocks(first = false) {
    try { const r = await KBlocks.ensure(provider, { blocks: 30500, onStatus: first ? (t) => t && say(t) : null }); B = r.B; say(""); }
    catch { say("Couldn't reach the Koinos network. Trying again in a moment…"); }
    renderToday();
  }
  if (W && W.subscribe) W.subscribe(() => { loadMine(); });
  (async () => {
    const picksReady = setupPicks().catch(() => {});
    await loadData();
    renderField(); renderStandings(); renderDays(true);
    await picksReady;
    await refreshBlocks(true);
    renderDays(true);
    setInterval(() => { if (!document.hidden) refreshBlocks(); }, 60000);
    setInterval(() => { if (!document.hidden) loadData().then(() => { renderField(); renderStandings(); renderDays(); renderToday(); }); }, 300000);
    setInterval(() => { if (!document.hidden && picksContract) loadMine(); }, 60000);
    setInterval(() => { if (!document.hidden) renderDays(); }, 15000);
  })();
})();

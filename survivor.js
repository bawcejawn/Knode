/* survivor.html: Survivor. It reads the chain's recent blocks (for today's live standings), the Survivor recorder's
   files (games-data/survivor: the handicaps and the season) and, once the KnodeGames Picks contract is live
   (picks-data/deployment.json), your picks from the contract. It sends one thing: a pick you confirm in your wallet.
   The scoring is survivor-math.js, the same file the recorder (bot/games/survivor.ts) uses. */
(() => {
  "use strict";
  // TESTNET: the local test server (bot/survivor-test.ts) adds window.KSurvivorNet: the testnet node (through the
  // server), its recorder's files, its Picks contract and the test clock. The real page never has it.
  const NET = window.KSurvivorNet || null;
  const S = window.KSurvivor && (NET ? window.KSurvivor.withConfig(NET.clock) : window.KSurvivor);
  if (!S || typeof document === "undefined" || !document.getElementById("days")) return;

  const lib = window.koilib || window.koinos || window;
  const RPC = NET ? new URL(NET.rpc, location.href).href : "https://koinos.armana.io";
  const DATA = NET ? NET.data : "https://raw.githubusercontent.com/bawcejawn/Knode/games-data/survivor/";
  const EXPLORER = NET ? null : "https://koinosscan.com/address/";
  // Knode's own two producers are in the field like any other (owner's decision 2026-10-27; disclosed on the page).
  const NAMES = { "1Mpmf2ERhjYpX7CCiM11WERuM4j17uT1sr": "Knode pool", "1FKTpXBhhHEbu5vVchM8UsVbAvPArJsRmR": "Knode Swap" };
  const ROOT = new URL("./", location.href);            // the pages sit at the site root
  const provider = new lib.Provider([RPC]);
  const W = window.KWallet;
  const MARGIN = 2 * 60000;                     // the page offers a day only while its lock is more than 2 minutes away

  const $ = (id) => document.getElementById(id);
  const el = (tag, attrs = {}, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (k === "text") e.textContent = v; else if (k.startsWith("on")) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v); } for (const c of kids) if (c != null) e.append(c); return e; };
  const isAddr = (a) => typeof a === "string" && /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a);
  const nameOf = (a) => (isAddr(a) ? NAMES[a] || a.slice(0, 5) + "…" + a.slice(-4) : "–");
  const fmt = (n, d = 0) => Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
  // A day's name: its UTC date ("Mon, Nov 16"); on the test clock, its start in your time ("Wed 2:00 PM").
  const dayName = (d) => (S.MAINNET ? new Date(S.dayStart(d)).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" })
    : new Date(S.dayStart(d)).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" }));
  const LOCK_TEXT = S.MAINNET ? "23:55 UTC the night before" : "5 minutes before the round starts";
  /** A wallet, linked to the explorer (mainnet) or as plain text (testnet: no explorer). */
  const addrLink = (a) => (EXPLORER ? el("a", { href: EXPLORER + a, target: "_blank", rel: "noopener noreferrer", text: nameOf(a) }) : el("span", { text: nameOf(a) }));
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

  // The chain's clock, not the viewer's, decides the lock: the page reads the chain's head time and keeps the
  // difference (Repo Lense SV-A21). Until it has read it, the viewer's clock.
  let skew = 0;
  const now = () => Date.now() + skew;
  const today = () => S.dayIndex(now());
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
        try { const j = await fetchJson(`${DATA}S${String(s).padStart(3, "0")}.json`); if (j && (j.v === 1 || j.v === 2) && j.season === s && Array.isArray(j.days)) { season = j; break; } } catch { /* none yet */ }
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
    $("today-sub").textContent = `${fmt(total)} blocks so far ${S.MAINNET ? "today (UTC)" : "this round"}. ${sc.out.length === 1 ? "The bottom 1" : `The bottom ${sc.out.length}`} of ${sc.rows.length} ${sc.out.length === 1 ? "is" : "are"} in the out-zone right now${sc.line !== null ? `; safe from a score of ${fmt(sc.line, 1)}` : ""}. Live, not final.`;
    $("today-rows").replaceChildren(...sc.rows.map((r, i) => el("tr", { class: `${out.has(r.a) ? "oz" : ""} ${r.a === mineP ? "me" : ""}` },
      el("td", { class: "num", text: String(i + 1) }),
      el("td", { class: "mono" }, addrLink(r.a), r.a === mineP ? el("span", { class: "you", text: " your pick" }) : null),
      el("td", { class: "num", text: fmt(r.blocks) }),
      el("td", { class: "num hide-sm", text: `×${fmt(r.h, 2)}` }),
      el("td", { class: "num", text: fmt(r.score, 1) }),
      el("td", {}, el("span", { class: `chip ${out.has(r.a) ? "bad" : "ok"}`, text: out.has(r.a) ? "Out-zone" : "Safe" })))));
  }

  // ── the picks contract (live once picks-data/deployment.json is on the site) ──
  async function setupPicks() {
    let pdep = null, dep = null;
    if (NET) { pdep = { contract: NET.picks }; dep = { chainId: NET.chainId }; }
    else {
      try { pdep = await fetchJson(new URL("picks-data/deployment.json", ROOT)); } catch { return; }
      try { dep = await fetchJson(new URL("game-data/deployment.json", ROOT)); } catch { /* the wallet keeps its defaults */ }
    }
    if (!pdep || !isAddr(pdep.contract)) return;
    const abi = await fetchJson(new URL("picks/abi/picks.koilib.json", ROOT));
    picksContract = new lib.Contract({ id: pdep.contract, abi, provider });
    // The page times the lock with its own copy of game 3's settings; if the chain's differ (an owner change), picking
    // pauses with a note rather than show wrong lock times (Repo Lense S3-29).
    try {
      const g = ((await picksContract.functions.get_game({ game: S.GAME_ID })).result || {}).game;
      const want = { lock_mode: 2, round_size: S.DAY, round_offset: 0, lead: S.LEAD_MS, ahead: S.AHEAD_MS };
      if (g && Object.entries(want).some(([k, v]) => Number(g[k] || 0) !== v)) gameChanged = true;
    } catch { /* read again with the picks */ }
    if (W) W.init({ provider, chainId: dep && dep.chainId, payer: dep && dep.payer, sponsor: dep && dep.sponsor, onChange: () => loadMine() });
    $("picks-soon").hidden = true;
    loadMine();
  }
  // mineOk: my picks were read in full, without an error, for the wallet shown. Until then Pick and Change are off,
  // because a missing pick would make a used producer look free (Repo Lense SV-A6).
  // A read that fails is tried once more, and a clean read from the last 3 minutes keeps picking on through one bad
  // pass (fix-check: a busy public node used to switch picking off and on).
  // Repo Lense S2-6: after this page's own pick the grace is dropped (the next read must be clean), and the confirmed
  // pick goes into the list at once. S2-17: only the newest read may write the list.
  let mineOk = false, mineWho = null, mineAt = 0, mineSeq = 0, gameChanged = false;
  // Picks this page sent: kept in the list until a read shows them or their day locks (Repo Lense S3-14), so a pick the
  // chain hasn't shown yet still blocks its producer for other days.
  const sentPicks = new Map();                    // day → { producers, changes }
  const twice = (f) => f().catch(() => new Promise((res) => setTimeout(res, 1500)).then(f));
  async function loadMine() {
    const who = me(), seq = ++mineSeq;
    if (who !== mineWho) { myPicks = new Map(); usage = null; mineOk = false; mineAt = 0; mineWho = who; }
    if (picksContract && who) {
      // Every day of the current season so far (whether you joined, and the producers you already picked, before
      // the recorder has those days: audit SV-5), today, and the open days.
      const se = S.seasonOf(today());
      const past = se ? Array.from({ length: today() - se.start }, (_, i) => se.start + i) : [];
      const days = [...past, today(), ...S.openDays(now())].filter((d, i, a) => a.indexOf(d) === i);
      const got = await Promise.allSettled(days.map((d) => twice(() => picksContract.functions.get_pick({ game: S.GAME_ID, round: String(d), player: who }))
        .then((x) => [d, x.result && x.result.pick && Array.isArray(x.result.pick.producers) && x.result.pick.producers.length ? x.result.pick : null])));
      const use = await Promise.allSettled([twice(() => picksContract.functions.get_usage({ game: S.GAME_ID, player: who }))]);
      if (me() !== who || seq !== mineSeq) return;                // the wallet changed, or a newer read started
      if (got.every((x) => x.status === "fulfilled") && use[0].status === "fulfilled") {
        myPicks = new Map(got.map((x) => x.value).filter(([, p]) => p));
        for (const [d, p] of sentPicks) {
          const seen = myPicks.get(d);
          if ((seen && seen.producers[0] === p.producers[0]) || S.lockTime(d) <= now()) sentPicks.delete(d);
          else myPicks.set(d, p);
        }
        usage = use[0].value.result || null;
        mineOk = true; mineAt = Date.now();
      } else mineOk = mineAt > 0 && Date.now() - mineAt < 3 * 60000;   // keep the last good list; Pick waits for a clean read
      try {
        const h = await provider.getHeadInfo();
        const t = Number(h && h.head_block_time);
        // Only ever forward: a lagging node must not make the page offer a day the chain has already locked (S2-5).
        // And never back: the largest difference seen is kept (Repo Lense S3-12: a slow device, then a lagging node).
        if (t > 0 && t - Date.now() > 30000) skew = Math.max(skew, t - Date.now());
      } catch { /* the viewer's clock */ }
    }
    renderDays(true); renderToday(); renderStandings();
  }
  /** Producers I picked for two or more days of the same season that the recorder hasn't recorded yet: all but one of
   *  those picks will cost a life (Repo Lense S2-6: e.g. a second tab). */
  function doubles() {
    const seen = new Map(), out = new Set();
    for (const [d, p] of myPicks) {
      const sd = S.seasonOf(d), a = p.producers && p.producers[0];
      if (!sd || !a || (season && season.season === sd.season && d < season.startDay + season.days.length)) continue;
      const k = `${sd.season}|${a}`;
      if (seen.has(k)) out.add(a); else seen.set(k, d);
    }
    return [...out];
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
    // A season that already ended (2 or fewer left) has no more days to pick (Repo Lense S3-28).
    if (season && season.season === sd.season && season.result && season.result.over) return false;
    const rec = mySeason(sd.season);
    if (rec) return rec.outN === null;
    // The recorder hasn't recorded day 1 yet: you're in if you picked for it.
    return !(season && season.season === sd.season && season.days.length) && myPicks.has(sd.start);
  }
  /** Producers I can't pick for day d: used this season (as recorded), my pick on a season day the recorder hasn't
   *  recorded yet (audit SV-5: it most likely counts as used), or my pick for another upcoming day this season. */
  function blockedFor(d) {
    const out = new Map();
    const se = S.seasonOf(d);
    const mineS = se ? mySeason(se.season) : null;
    for (const a of (mineS && mineS.used) || []) out.set(a, "used");
    const recorded = season && se && season.season === se.season ? season.startDay + season.days.length : null;
    for (const [x, p] of myPicks) {
      const sx = S.seasonOf(x), a = p.producers && p.producers[0];
      if (x === d || !se || !sx || sx.season !== se.season || !a || out.has(a)) continue;
      if (x >= today()) out.set(a, `picked for ${dayName(x)}`);
      else if (recorded === null || x >= recorded) out.set(a, `picked for ${dayName(x)}`);
    }
    return out;
  }

  // ── the open days ──
  let daysKey = "";
  function renderDays(force = false) {
    const list = $("days");
    if (!force && list.contains(document.activeElement) && document.activeElement.tagName === "SELECT") return;
    const who = me(), t = now(), days = S.openDays(t).filter((d) => S.lockTime(d) - t > MARGIN);
    const key = JSON.stringify([who, W && W.kind, days[0], sending, mineOk, !!picksContract, [...fields.keys()], usage && usage.picks_today, [...myPicks.entries()].map(([d, p]) => [d, p.producers && p.producers[0]]), season && season.days.length]);
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
    $("picks-who").textContent = !picksContract ? "" : who ? `Picking as ${nameOf(who)}${W.kind === "guest" ? " (guest)" : ""}.${mineOk ? "" : " Couldn't read your picks from the chain yet, so picking is paused; it tries again every minute."}${doubles().length ? ` Warning: you picked ${doubles().map(nameOf).join(", ")} for more than one day this season; each producer counts once, so change all but one of those picks or they cost a life.` : ""}` : "Connect a wallet to pick (Kondor, KOIN Vault or a guest wallet).";
    const rows = [];
    for (const d of days) {
      const sd = S.seasonOf(d), f = fieldFor(d), mine = myPicks.get(d), mineP = mine && mine.producers && mine.producers[0];
      const blocked = blockedFor(d);
      const label = sd ? `Season ${sd.season} · day ${sd.n}` : "Practice";
      const when = el("div", { class: "bx-when" },
        el("b", { text: dayName(d) }),
        el("span", { class: "bx-eta", text: label }),
        el("span", { class: "bx-eta", "data-lock": String(S.lockTime(d)), text: `locks ${localTime(S.lockTime(d))} · in ${dur(S.lockTime(d) - t)}` }));
      let cell;
      if (!picksContract) cell = el("div", { class: "bx-now", text: "Picks open soon" });
      else if (gameChanged) cell = el("div", { class: "bx-now warn", text: "Survivor's settings on the chain changed; picking is paused on this page until it is updated." });
      else if (!sd) cell = el("div", { class: "bx-now", text: "Practice day: no season yet." });
      else if (who && !mineOk && sd.n > 1) cell = el("div", { class: "bx-now", text: "Couldn't read your picks from the chain yet; retrying every minute." });
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
        if (sending || !mineOk || used >= max || (mine && Number(mine.changes) >= S.MAX_CHANGES)) btn.disabled = true;
        const notes = [];
        // Your pick's producer already used (recorded) or picked for another day this season: it costs a life, so say so
        // whenever it is the case, recorded day or not (Repo Lense S3-4).
        const mineWhy = mineP ? blocked.get(mineP) : null;
        if (mineP) notes.push(el("div", { class: `bx-now${mineWhy ? " warn" : ""}`, text: `Your pick: ${nameOf(mineP)}${mineWhy ? ` (${mineWhy === "used" ? "already used this season" : mineWhy}: each producer counts once, so this pick costs a life; change it)` : f && f.exact && !f.field.some((x) => x.a === mineP) ? " (not in this day's field: it would cost a life)" : ""}` }));
        // The warning only on the next day to lock: the later ones can wait.
        else if (sd.n > 1 && d === days[0] && opts.length) notes.push(el("div", { class: "bx-now warn", text: `No pick yet: a ${S.MAINNET ? "day" : "round"} without a pick costs a life.` }));
        // No handicaps published yet: nothing to pick from (Repo Lense S3-13).
        if (!opts.length) notes.push(el("div", { class: "bx-now", text: `The handicaps aren't out yet, so picking isn't possible right now. They're published the ${S.MAINNET ? "day" : "round"} before; come back then.` }));
        // Guest picks use the sponsor's shared free pool, which can run out near the lock (Repo Lense S3-16).
        if (W && W.kind === "guest" && !mineP) notes.push(el("div", { class: "bx-now", text: "Guest picks use the shared free Mana pool, which can run out late in the day: pick early." }));
        if (f && !f.exact) notes.push(el("div", { class: "bx-now", text: `Handicaps for this ${S.MAINNET ? "day" : "round"} aren't out yet; showing the latest. They're published the ${S.MAINNET ? "day" : "round"} before.` }));
        // Repo Lense SV-A11: a pick made early can drop out of that day's field, and that costs a life.
        if (mineP && !(f && f.exact)) notes.push(el("div", { class: "bx-now warn", text: `Check this pick once the ${S.MAINNET ? "day's" : "round's"} field is out: if ${nameOf(mineP)} isn't in it, the pick costs a life (the safety net doesn't cover that).` }));
        cell = el("div", { class: "bx-pick" }, sel, btn, ...notes);
      }
      rows.push(el("div", { class: `bx-row${mineP ? " mine" : ""}` }, when, cell));
    }
    list.replaceChildren(...rows);
  }
  function updateTimes() {
    document.querySelectorAll("#days [data-lock]").forEach((n) => { const t = Number(n.dataset.lock); n.textContent = `locks ${localTime(t)} · in ${dur(t - now())}`; });
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
    if (!mineOk) return pickModal("info", "Your picks aren't loaded yet", ["The page couldn't read your earlier picks from the chain, so it can't tell which producers you've used. It tries again every minute."], [okBtn("OK")]);
    if (!isAddr(producer)) return pickModal("info", "Choose a producer first", ["Pick the producer you think stays out of the out-zone, then press Pick."], [okBtn("OK")]);
    const mine = myPicks.get(d);
    if (mine && mine.producers && mine.producers[0] === producer) return pickModal("info", "That is already your pick", [`${nameOf(producer)} for ${dayName(d)}.`], [okBtn("OK")]);
    const why = blockedFor(d).get(producer);
    if (why) return pickModal("info", "You can't use that producer again", [`${nameOf(producer)}: ${why}. Each producer once a season.`], [okBtn("OK")]);
    if (!(S.lockTime(d) - now() > MARGIN)) return pickModal("bad", "Too close to the lock", [`${dayName(d)} locks in a moment. Pick a later day.`], [okBtn("OK")]);
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
      // Sent (seen on the chain or not): in the list at once, and kept until a read shows it (S2-6, S3-14).
      { const p = { producers: [producer], changes: mine ? Number(mine.changes || 0) + 1 : 0 }; myPicks.set(d, p); sentPicks.set(d, p); mineAt = 0; }
      if (onChain) pickModal("ok", "Pick confirmed", [el("p", {}, "Your pick: ", el("b", { text: nameOf(producer) }), ` for ${dayName(d)}.`),
        `It locks ${LOCK_TEXT} (${localTime(S.lockTime(d))} your time). Until then you can change it (up to ${S.MAX_CHANGES} times).`,
        id ? el("p", { class: "ago mono", text: `Transaction ${String(id).slice(0, 18)}…` }) : null].filter(Boolean), [okBtn()]);
      else pickModal("info", "Sent, not seen on the chain yet", ["Your wallet sent it. It usually shows within a minute; this list updates by itself."], [okBtn("OK")]);
    } catch (e) {
      const m = String((e && e.message) || e);
      const why2 = /locked/i.test(m) ? `The chain says that ${S.MAINNET ? "day" : "round"} is locked (picks close ${LOCK_TEXT}, by the chain's clock). Your pick wasn't saved.`
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
  // Two boards (owner, 28 Oct): wallets staked in Survivor in the vault, and free players. Places are counted within
  // each board; the free prize is the free board's.
  let board = "free";
  function setBoard(b) { board = b; $("board-free").setAttribute("aria-pressed", String(b === "free")); $("board-staked").setAttribute("aria-pressed", String(b === "staked")); renderStandings(); }
  function renderStandings() {
    if (!season || !season.result || !season.result.players.length) { $("standings-box").hidden = true; return; }
    $("standings-box").hidden = false;
    const r = season.result, who = me();
    const inNow = r.players.filter((x) => x.outN === null).length;
    $("standings-title").textContent = `Season ${season.season} standings`;
    $("standings-sub").textContent = r.final ? `final after day ${r.endN}` : r.over ? `ended after day ${r.endN}; final once both of its weeks are over and 12 hours have passed` : `after day ${r.endN} of ${S.SEASON_DAYS} · ${inNow} of ${r.players.length} still in`;
    const rows = S.rank(r.players.filter((x) => !!x.staked === (board === "staked")));
    $("board-note").textContent = board === "staked"
      ? `${rows.length} staked player${rows.length === 1 ? "" : "s"}. Each week the vault pays the top 30% of that week's staked players (those still in when the week began) from Survivor's bucket; they can't win the free prize.`
      : `${rows.length} free player${rows.length === 1 ? "" : "s"}. Free players play for the season prize: up to 4 VHP for 1st and 2 VHP for 2nd (less in a week the vault's prize money runs short).`;
    const medal = ["🥇", "🥈"];
    $("prizes").replaceChildren(...(r.final && board === "free" ? r.prizes : []).map((p) => el("div", { class: "champ" }, el("b", { text: `${medal[p.place - 1] || "🥈"} ${fmt(p.vhp, p.vhp % 1 ? 2 : 0)} VHP` }), el("span", { class: "mono", text: nameOf(p.player) }))));
    $("standings-rows").replaceChildren(...rows.slice(0, 100).map((x) => el("tr", { class: `${x.outN === null ? "" : "gone"} ${x.a === who ? "me" : ""}` },
      el("td", { class: "num", text: String(x.place) }),
      el("td", { class: "mono" }, addrLink(x.a), x.eligible || x.staked ? null : el("span", { class: "ago", title: "Didn't hold 1 VHP at every daily check: can't win a prize", text: " · no prize" })),
      el("td", { class: "lives", "aria-label": `${x.lives} lives`, text: x.outN === null ? hearts(x.lives) : `out day ${x.outN}` }),
      el("td", { class: "num", text: fmt(x.total, 1) }),
      el("td", { class: "num hide-sm", text: String(x.used.length) }))));
    const mine = mySeason();
    const myBoard = mine ? S.rank(r.players.filter((x) => !!x.staked === !!mine.staked)).find((x) => x.a === mine.a) : null;
    $("me-line").textContent = !who ? "" : !mine ? "You're not in this season." : `You: #${myBoard.place} on the ${mine.staked ? "Staked" : "Free play"} board, ${mine.outN === null ? `${mine.lives} ${mine.lives === 1 ? "life" : "lives"} left` : `out on day ${mine.outN}`}, ${mine.used.length} producer${mine.used.length === 1 ? "" : "s"} used.${mine.staked ? " You're staked in Survivor this season: you share its weekly bucket, not the free prize." : mine.eligible ? "" : " You didn't hold 1 VHP at every daily check, so you can't win a prize this season."}`;
  }

  // ── tomorrow's handicaps ──
  function renderField() {
    const d = today() + 1, f = fields.get(d) || fields.get(today());
    if (!f) { $("field-sub").textContent = "Waiting for the recorder…"; return; }
    const sd = S.seasonOf(f.day);
    $("field-title").textContent = f.day === d ? "Tomorrow's handicaps" : "Today's handicaps";
    $("field-sub").textContent = `${dayName(f.day)}${sd ? `, season ${sd.season} day ${sd.n}` : ""}: ${f.field.length} producers, the bottom ${f.out} are the out-zone. From each producer's blocks over ${dayName(f.day - 8)} to ${dayName(f.day - 2)}.`;
    $("field-rows").replaceChildren(...f.field.map((p) => el("tr", {},
      el("td", { class: "mono" }, addrLink(p.a)),
      el("td", { class: "num", text: fmt(p.k) }),
      el("td", { class: "num hide-sm", text: fmt(p.k / S.FORM_DAYS, 0) }),
      el("td", { class: "num", text: `×${fmt(p.h, 2)}` }))));
  }

  // ── start ──
  async function refreshBlocks(first = false) {
    try { const r = await KBlocks.ensure(provider, { blocks: NET ? NET.blocks : 30500, onStatus: first ? (t) => t && say(t) : null }); B = r.B; say(""); }
    catch { say("Couldn't reach the Koinos network. Trying again in a moment…"); }
    renderToday();
  }
  if (W && W.subscribe) W.subscribe(() => { loadMine(); });
  $("board-free").addEventListener("click", () => setBoard("free"));
  $("board-staked").addEventListener("click", () => setBoard("staked"));
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
    // A tab that comes back after a while reads the picks again before offering Pick (Repo Lense S3-15).
    document.addEventListener("visibilitychange", () => { if (!document.hidden && picksContract) { if (Date.now() - mineAt > 60000) mineOk = false; loadMine(); } });
    setInterval(() => { if (!document.hidden) renderDays(); }, 15000);
  })();
})();

/* lastnode.html: Last Node Standing. It reads the chain's recent blocks (chain-blocks.js), the recorder's files
   (games-data/lastnode: the field, the recorded hours, the leaderboard), the race recorder's current card (race-data,
   for reliability only) and, once the KnodeGames Picks contract is live (picks-data/deployment.json), your picks.
   It sends one thing: a pick you confirm in your wallet (your start node, a backup or a jump).
   TESTNET (lastnode-testnet.html, <meta name="kg-network" content="testnet">): picks go to the testnet Picks contract
   (testnet/blockx.json) with the testnet wallet (testnet-wallet.js, test KOIN only); the race is still the real MAINNET
   producers, read only, because the testnet has a single producer. #game-93 is the fast test game, #game-13 the real
   settings.
   The rules are lastnode-math.js, the same file the recorder (bot/games/lastnode.ts) runs. The live cut shown here is
   worked out from blocks that may not be irreversible yet; the recorder's file is the final word. */
(() => {
  "use strict";
  const L0 = window.KLastNode, M = window.KRaceMath;
  if (!L0 || !M || typeof document === "undefined" || !document.getElementById("track")) return;
  const meta = document.querySelector('meta[name="kg-network"]');
  const TESTNET = !!(meta && meta.getAttribute("content") === "testnet");
  // Testnet: the fast test game (93) unless the address asks for the real settings (#game-13).
  const L = TESTNET && location.hash !== "#game-13" ? L0.forGame(L0.FAST_GAME) : L0;

  const lib = window.koilib || window.koinos || window;
  const MAINNET_RPC = ["https://koinos.armana.io", "https://api.koinos.io"];
  const MAINNET_CHAIN_ID = "EiBZK_GGVP0H_fXVAM3j6EAuz3-B-l3ejxRSewi7qIBfSA==";
  const RACE_DATA = "https://raw.githubusercontent.com/bawcejawn/Knode/race-data/";
  let DATA = "https://raw.githubusercontent.com/bawcejawn/Knode/games-data/lastnode/";
  const EXPLORER = "https://koinosscan.com/address/";
  const NAMES = { "1Mpmf2ERhjYpX7CCiM11WERuM4j17uT1sr": "KnodeGames pool", "1FKTpXBhhHEbu5vVchM8UsVbAvPArJsRmR": "KnodeGames Swap" };
  const ROOT = new URL("../", location.href);
  const provider = new lib.Provider(MAINNET_RPC);   // the race: always mainnet blocks, read only
  let picksProvider = provider;                      // the picks: mainnet, or the testnet on the test page
  let NET = null;                                    // testnet settings (testnet/lastnode.json)
  const W = TESTNET ? window.KTestWallet : window.KWallet;
  const H = L.CUT, SEND_MARGIN = 60000;      // H: one cut window (1 hour; 20 minutes in the fast test game)

  // Audit LN-5: the page's clock is the chain's (the newest block's time when it was read), not the device's. Stalls
  // only make a reading older, so the freshest of the last 10 minutes' readings is used. Readings are anchored to the
  // page's own steady timer (performance.now), so a device clock that jumps (a phone syncing its time) changes nothing.
  const mono = () => performance.now();
  const offsets = [];
  const nowT = () => (offsets.length ? mono() + Math.max(...offsets) : Date.now());
  function noteChainTime(tip) {
    const off = tip - mono();
    if (!Number.isFinite(off) || Math.abs(tip - Date.now()) > 3600000) return;     // a clock over an hour out: leave it alone
    offsets.push(off); if (offsets.length > 20) offsets.shift();
  }
  // Audit LN-22: the lock and open times of the game as registered in the Picks contract (get_game), so a later
  // tighten_game (a longer lead, a shorter ahead) is followed here. Until it is read: the rules' own settings.
  const REG = { lead: L.LEAD, ahead: L.AHEAD };
  const lockAt = (r) => L.roundTime(r) - REG.lead;
  const openAt = (r) => L.roundTime(r) - REG.ahead;
  /** A pick for round r can be sent now: the round is open, and its lock is more than a minute away. */
  const pickable = (r, t = nowT()) => L.pickable(r, t, REG, SEND_MARGIN);
  /** The page's own cut-off for a round: a minute before the lock (what the countdowns count down to). */
  const cutoff = (r) => lockAt(r) - SEND_MARGIN;

  const $ = (id) => document.getElementById(id);
  const el = (tag, attrs = {}, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (v == null) continue; if (k === "text") e.textContent = v; else if (k.startsWith("on")) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v); } for (const c of kids) if (c != null) e.append(c); return e; };
  const isAddr = (a) => typeof a === "string" && /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a);
  const nameOf = (a) => (isAddr(a) ? NAMES[a] || a.slice(0, 5) + "…" + a.slice(-4) : "–");
  const fmt = (n, d = 0) => Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
  const clock = (t) => new Date(t).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const dayTime = (t) => new Date(t).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
  const dur = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)), m = Math.floor(s / 60); return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min` : m >= 1 ? `${m} min` : `${s} s`; };
  const steps = (x) => fmt(x / L.H_SCALE, 0);
  const say = (t) => { $("status").textContent = t; $("status").hidden = !t; };
  async function fetchJson(url) { const r = await fetch(url, { cache: "no-cache" }); if (!r.ok) throw new Error(String(r.status)); return r.json(); }

  let B = null;                    // recent blocks (chain-blocks.js)
  const days = new Map();          // day → the recorder's D file (or a field worked out here from the card)
  let card = null;                 // the race card in force now (for reliability)
  let picksContract = null, sending = false;
  const myPicks = new Map();       // round → producer (for the shown event and the next one)
  let board = null;
  const me = () => (W && W.address) || null;

  // ── which event to show: one still running (a big field runs past midnight), else today's ──
  function shownEvent(now = nowT()) {
    const today = L.eventOf(now), y = L.eventOf(today.start - L.PERIOD);
    const yd = days.get(y.day);
    if (yd && yd.field && !yd.void && now < today.start && !result(yd).done) return { ev: y, df: yd };
    return { ev: today, df: days.get(today.day) || null };
  }
  /** Audit LN-6: the next event whose start pick isn't past the page's cut-off; open: whether its picks are open now. */
  const nextEntry = (now = nowT()) => L.nextEntry(now, REG, SEND_MARGIN);

  // ── the hours: the recorder's where it has them, else counted here from recent blocks ──
  function liveHours(df, now = nowT()) {
    const hours = (df.hours || []).map((h) => ({ blocks: h.blocks, recorded: true }));
    if (!B || !B.ts.length || !df.field) return { hours, partial: null };
    const inField = new Set(df.field.nodes.map((n) => n.a));
    const tip = B.ts[B.ts.length - 1];
    const count = (t0, t1) => {
      const c = {};
      for (let i = M.lowerBound(B.ts, t0); i < B.ts.length && B.ts[i] < t1; i++) { const a = B.signers[B.sig[i]]; if (inField.has(a)) c[a] = (c[a] || 0) + 1; }
      return c;
    };
    // Whole hours past the recorder's, while the chain has gone past their end; then the hour running now.
    for (let i = hours.length; i < df.field.nodes.length - 1; i++) {
      const t0 = df.start + i * H, t1 = t0 + H;
      if (t0 < B.ts[0]) return { hours, partial: null };
      if (tip < t1) return { hours, partial: tip > t0 && now >= t0 ? { i, blocks: count(t0, t1), t0, t1 } : null };
      hours.push({ blocks: count(t0, t1), recorded: false });
    }
    return { hours, partial: null };
  }
  function result(df) { return L.cutsFrom(df.field, (df.hours || []).map((h) => ({ blocks: h.blocks }))); }

  // ── loading ──
  async function loadDay(day) {
    const ev0 = L.eventOf(day);
    try {
      const j = await fetchJson(`${DATA}D${day}.json`);
      // Audit LN-24/LN-32: the event's own start, and no more nodes than the rules allow.
      if (j && j.v === 1 && j.day === day && ev0 && j.start === ev0.start && (j.field === null || (j.field && Array.isArray(j.field.nodes) && j.field.nodes.length <= L.MAX_FIELD))) {
        if (j.field) j.field.nodes = j.field.nodes.filter((n) => n && isAddr(n.a) && Number.isFinite(n.h) && n.h > 0 && (n.r === undefined || (Number.isFinite(n.r) && n.r >= L.FORM_MIN && n.r <= L.FORM_MAX)));
        days.set(day, j);
        return;
      }
    } catch (e) {
      // Audit LN-29: a failed read (not "not published yet") keeps the recorder's file the page already has.
      const have = days.get(day);
      if (String((e && e.message) || e) !== "404" && have) return;
    }
    // No recorder file yet: the field waits for it (it needs each node's form, from 48 hours of blocks).
  }
  async function loadAll() {
    const now = nowT();
    const cur = L.eventOf(now);
    await Promise.all([L.eventOf(cur.start - L.PERIOD).day, cur.day, L.nextEvent(cur).day].map(loadDay));
    try { card = await raceCardNow(); } catch { /* keep */ }
    try { const b = await fetchJson(DATA + "board.json"); if (b && b.v === 1) board = b; } catch { /* none yet */ }
  }
  async function raceCardNow() {
    const now = nowT(), ra = M.raceAt(now), w = M.weekOf(ra.start);
    const wf = await fetchJson(`${RACE_DATA}W${String(w).padStart(3, "0")}.json`);
    const race = wf && Array.isArray(wf.races) ? wf.races.find((r) => r && r.id === ra.id) : null;
    return race && Array.isArray(race.cards) ? M.cardForLeg(race.cards, M.legOf(ra.start, now, M.legsOf(race.cards))) : null;
  }
  async function loadBlocks() {
    // A copy: the block loader trims and re-reads its newest blocks while it updates, and the page must never draw
    // from that half-updated list (it showed a cut disappear and come back, and announced it twice).
    try { const r = await KBlocks.ensure(provider, { blocks: 31000 }); B = { ts: r.B.ts.slice(), sig: r.B.sig.slice(), signers: r.B.signers.slice() }; if (B.ts.length) noteChainTime(B.ts[B.ts.length - 1]); say(""); } catch { say("Couldn't reach the Koinos network. Trying again in a moment…"); }
  }

  /** Each node's blocks over the last day ÷ what its VHP share says (the current race card, field and paddock). */
  function reliability() {
    const out = new Map();
    if (!B || !card || B.ts.length < 1000) return out;
    const vhp = new Map();
    for (const r of [...(card.field || []), ...(card.paddock || [])]) if (r && isAddr(r.a) && r.vhp > 0) vhp.set(r.a, r.vhp);
    const tot = [...vhp.values()].reduce((s, v) => s + v, 0);
    const from = M.lowerBound(B.ts, B.ts[B.ts.length - 1] - L.DAY), n = B.ts.length - from, c = new Map();
    for (let i = from; i < B.ts.length; i++) { const a = B.signers[B.sig[i]]; c.set(a, (c.get(a) || 0) + 1); }
    for (const [a, v] of vhp) out.set(a, (c.get(a) || 0) / (n * v / tot));
    return out;
  }

  // ── drawing: the night arena (lastnode.css) ──
  /** Each node's own colour and badge letters, from its address, so a node looks the same everywhere on the page. */
  const hueOf = (a) => { let h = 7; for (const ch of String(a)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return 25 + (h % 290); };   // never the storm's red
  const colorOf = (a) => `hsl(${hueOf(a)} 82% 68%)`;
  const callsign = (a) => (NAMES[a] ? NAMES[a].replace(/[^A-Z]/g, "").slice(0, 2) || "KG" : String(a).slice(1, 3));
  const badge = (a, size = "") => el("span", { class: `ln-badge${size ? " " + size : ""}`, style: `--node:${colorOf(a)}`, "aria-hidden": "true", text: callsign(a) });
  /** The big clock: m:ss, or h:mm:ss over an hour. */
  const timer = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = String(s % 60).padStart(2, "0"); return h ? `${h}:${String(m).padStart(2, "0")}:${x}` : `${m}:${x}`; };
  /** Audit LN-7: a node's field entry (handicap) in the event being picked for. */
  function nodeInfo(a, df) { return (df && df.field && df.field.nodes.find((x) => x.a === a)) || null; }
  let seen = null;                 // { day, cuts, done }: the most cuts drawn so far, to spot a new cut
  const announced = new Set();     // "event:cut" notes already shown (each cut is announced once)

  function render() {
    const now = nowT(), { ev, df } = shownEvent(now);
    $("ev-title").textContent = `${new Date(ev.start).toLocaleDateString(undefined, { weekday: "long" })} ${clock(ev.start)} event`;
    const track = $("track");
    const tag = (text, cls) => { $("ev-tag").textContent = text; $("ev-tag").className = `ln-tag ${cls}`; };
    if (!df || !df.field) {
      tag(df && df.void ? "Void" : "Field soon", "done");
      const nx = now < ev.start ? ev : L.nextEvent(ev);
      $("ev-clockbox").className = "ln-clock";
      $("ev-clock").textContent = timer(nx.start - now);
      $("ev-clock-label").textContent = `until the ${clock(nx.start)} drop`;
      $("ev-sub").textContent = df && df.void ? `No race this time: ${df.void}.` : "The field is set from a Producer Race card and each node's form, a few minutes after picks open.";
      track.replaceChildren(el("p", { class: "note", style: "margin:6px 2px", text: `No race in the arena right now. The next one starts at ${clock(nx.start)}: pick your node below.` }));
      $("fallen").replaceChildren();
      legendYou(ev, null);
      renderField(null); renderMe(ev, null, null); return;
    }
    const { hours, partial } = liveHours(df, now);
    const res = L.cutsFrom(df.field, hours);
    // Live standings including the window running now (who would go if the cut were now).
    const live = partial ? L.cutsFrom(df.field, [...hours, { blocks: partial.blocks }]) : res;
    const nextCut = res.done ? null : df.start + (res.cuts.length + 1) * H;
    const n = df.field.nodes.length;
    tag(res.done ? "Finished" : now < ev.start ? "Picks open" : "Live", res.done ? "done" : now < ev.start ? "wait" : "live");
    $("ev-clockbox").className = `ln-clock${res.done ? " done" : now >= ev.start && nextCut - now < 60000 ? " hot" : ""}`;
    $("ev-clock").textContent = res.done ? nameOf(res.winner) : timer((now < ev.start ? ev.start : nextCut) - now);
    $("ev-clock-label").textContent = res.done ? "last node standing" : now < ev.start ? "until the drop" : `until cut ${res.cuts.length + 1} of ${n - 1}`;
    const recorded = (df.hours || []).length;
    $("ev-sub").textContent = res.done ? `${res.cuts.length} cuts, ${clock(ev.start)} to ${clock(df.start + res.cuts.length * H)}.`
      : now < ev.start ? `${n} nodes. Picks close at ${clock(cutoff(ev.round))}, first cut at ${clock(ev.start + H)}.`
      : `${res.standing.length} of ${n} still standing${recorded < res.cuts.length ? " · latest cut not final yet" : ""}`;
    const mine = myState(ev, df, res);
    legendYou(ev, mine);
    const tot = new Map(live.totals.map((t) => [t.a, t]));
    // The node that would go if the cut were now: the live cut beyond the recorded ones (none before the start).
    const wouldGo = partial && live.cuts.length > res.cuts.length ? live.cuts[res.cuts.length].a : null;
    const max = Math.max(1, ...live.totals.map((t) => t.steps));
    const outAt = new Map(res.cuts.map((c) => [c.a, c]));
    const standing = df.field.nodes.filter((x) => !outAt.has(x.a)).sort((a, b) => tot.get(b.a).steps - tot.get(a.a).steps);
    // The cut line: the node furthest back, once the event is running.
    const line = now >= ev.start && !res.done && standing.length ? Math.min(...standing.map((x) => tot.get(x.a).steps)) : 0;
    // Bars show only each node's lead over the slowest one (the cut line), so the whole bar is the gap that matters.
    const base = line > 0 ? line : 0;
    const pctOf = (x) => Math.max(0, Math.min(100, ((x - base) / Math.max(1, max - base)) * 100));
    const just = seen && seen.day === ev.day && res.cuts.length > seen.cuts ? res.cuts[res.cuts.length - 1] : null;
    track.replaceChildren(...[...standing, ...(just ? [df.field.nodes.find((x) => x.a === just.a)] : [])].map((nd) => {
      const t = tot.get(nd.a), danger = !res.done && wouldGo === nd.a && now >= ev.start, isMine = mine && mine.node === nd.a, won = res.done && res.winner === nd.a;
      const gone = just && just.a === nd.a;
      const cls = ["ln-lane", danger ? "danger" : "", isMine ? "mine" : "", won ? "winner" : "", gone ? "just-out" : ""].filter(Boolean).join(" ");
      const run = el("div", { class: "ln-run", role: "img", "aria-label": `${steps(t.steps)} steps` },
        el("i", { style: `--node:${colorOf(nd.a)};width:${Math.max(2, Math.round(pctOf(t.steps)))}%` }));
      return el("div", { class: cls },
        badge(nd.a),
        el("div", { class: "ln-who" }, el("b", {}, (won ? "👑 " : "") + nameOf(nd.a), isMine ? el("span", { class: "ln-you", text: "you" }) : null),
          el("small", { text: gone ? "knocked out" : won ? "last node standing" : danger ? "out if the cut were now" : `×${fmt(nd.h, 2)} a block` })),
        run,
        el("div", { class: "ln-num", text: steps(t.steps) }, el("em", { text: `${fmt(t.blocks)} blocks` })));
    }));
    // The fallen: knocked-out nodes, latest cut first.
    const myPath = mine ? new Set(mine.path.map((p) => p.a)) : new Set();
    $("fallen").replaceChildren(...(res.cuts.length ? [el("p", { class: "ln-fallen-title", text: "Knocked out" })] : []),
      ...[...res.cuts].reverse().map((c, i) => el("span", { class: `ln-ko${myPath.has(c.a) ? " mine" : ""}`, title: `Out at cut ${res.cuts.length - i} (${clock(df.start + c.at * H)})` },
        badge(c.a, "sm"), el("s", { text: nameOf(c.a) }), `cut ${res.cuts.length - i}`)));
    // A short note when a cut happens while you watch: once per cut, only within 5 minutes of it, never covering the race.
    const fresh = (c) => now - (df.start + c.at * H) < 5 * 60000;
    // Audit LN-4: whether the cut was yours is told only once your picks have been read (else the note waits for them).
    // (fix-check) While the note waits, the cut isn't marked as seen, so the note still comes once the picks are read.
    const holdNote = !!(me() && picksContract && !mineOk && just && fresh(just));
    if (seen && seen.day === ev.day && !holdNote) {
      if (res.done && !seen.done && !announced.has(`${ev.day}:won`) && fresh(res.cuts[res.cuts.length - 1]) && announced.add(`${ev.day}:won`)) flash(`${nameOf(res.winner)} wins`, mine && mine.rode ? `You rode it home: +${mine.points} points` : "The last node standing", "gold");
      else if (just && !announced.has(`${ev.day}:${res.cuts.length}`) && fresh(just) && announced.add(`${ev.day}:${res.cuts.length}`)) {
        const hit = mine && mine.entered && (mine.path[mine.path.length - 1].a === just.a || (mine.out && mine.out === res.cuts.length));
        const backedUp = mine && mine.jumped && mine.path.some((p) => p.at === just.at);
        flash(`${nameOf(just.a)} is out`, backedUp ? `Your backup kicked in: now riding ${nameOf(mine.node)}` : hit ? (jumpOpen(df, res, ev) ? "That was your node. Jump now!" : "That was your node.") : mine && mine.entered && !mine.out ? `You survived cut ${res.cuts.length}` : `Cut ${res.cuts.length} of ${n - 1}`, hit || backedUp ? "you" : "");
      }
    }
    if (!holdNote) seen = { day: ev.day, cuts: Math.max(res.cuts.length, seen && seen.day === ev.day ? seen.cuts : 0), done: res.done };
    renderField(df);
    renderMe(ev, df, res, mine);
  }
  /** Audit LN-15: the Jump box is open (a jump due and its round before the page's cut-off). */
  function jumpOpen(df, res, ev, now = nowT()) {
    const at = L.canJump(df.field, res, picksFor(ev)), r = at ? L.roundForJump(df.start, at) : null;
    return r != null && now < cutoff(r) ? r : null;
  }
  /** The legend's "Your node": shown when you're in the race on screen. With a pick only for a later event, it says
   *  which one, so a missing highlight isn't a surprise. */
  function legendYou(ev, mine) {
    const box = $("legend-you"), txt = $("legend-you-text");
    if (!box || !txt) return;
    if (mine && mine.entered) { box.hidden = false; txt.textContent = "Your node"; return; }
    let later = null;
    for (let e = L.nextEvent(ev), k = 0; k < 3 && !later; k++, e = L.nextEvent(e)) if (myPicks.has(e.round)) later = e;
    box.hidden = !later;
    if (later) txt.textContent = `Your pick, ${nameOf(myPicks.get(later.round))}, races in the ${dayTime(later.start)} event, not this one`;
  }
  function flash(big, small, kind) {
    const box = $("arena");
    if (!box) return;
    for (const old of box.querySelectorAll(".ln-flash")) old.remove();
    const f = el("div", { class: `ln-flash${kind ? " " + kind : ""}`, role: "status" }, el("b", { text: big }), el("span", { text: small }));
    box.prepend(f);
    setTimeout(() => f.remove(), 6000);
  }

  /** Once a second: only the clock (a full redraw comes with new blocks, every 30 seconds). */
  function tick() {
    const now = nowT(), { ev, df } = shownEvent(now);
    if (!df || !df.field) { $("ev-clock").textContent = timer((now < ev.start ? ev : L.nextEvent(ev)).start - now); return; }
    const res = L.cutsFrom(df.field, liveHours(df, now).hours);
    if (res.done) return;
    const nextCut = df.start + (res.cuts.length + 1) * H;
    $("ev-clock").textContent = timer((now < ev.start ? ev.start : nextCut) - now);
    $("ev-clockbox").className = `ln-clock${now >= ev.start && nextCut - now < 60000 ? " hot" : ""}`;
    // Audit LN-17: while the blocks are late after a cut, redraw at most every 15 seconds (not every second), so taps
    // on the cards aren't lost to a redraw.
    if ((now >= ev.start && $("ev-tag").textContent !== "Live") || (now >= nextCut + 2 * 60000 && now - lastStale >= 15000)) { lastStale = now; render(); }
  }
  let lastStale = 0;

  function renderField(df) {
    const rel = reliability();
    const fo = df && df.field && df.field.form;
    $("field-sub").textContent = !df || !df.field ? "The field appears a few minutes after picks open." : `Each node's chance to be last standing: ${fmt(df.field.fairness[0] * 100, 1)}–${fmt(df.field.fairness[1] * 100, 1)}% (fair is ${fmt(100 / df.field.nodes.length, 1)}%). Luck trim c = ${fmt(df.field.c, 1)}.${fo && fo.hours ? ` Form from ${fo.hours} hours of blocks.` : fo && fo.note ? ` No form this event (${fo.note}).` : ""}`;
    $("field-rows").replaceChildren(...(df && df.field ? df.field.nodes : []).map((nd) => {
      // On par = signing what the handicap expects (its VHP share × its form).
      const r = rel.get(nd.a), pct = Number.isFinite(r) ? (r / (nd.r || 1)) * 100 : null;
      return el("tr", {},
        el("td", { class: "who" }, el("span", { class: "ln-whobox" }, badge(nd.a, "sm"), el("a", { href: EXPLORER + nd.a, target: "_blank", rel: "noopener noreferrer", text: nameOf(nd.a) }))),
        el("td", { class: "num hide-sm", text: fmt(nd.kh, 0) }), el("td", { class: "num hide-sm", text: Number.isFinite(nd.r) ? fmt(nd.r, 2) : "–" }), el("td", { class: "num", text: `×${fmt(nd.h, 2)}` }),
        el("td", { class: "rel" }, pct == null ? "–" : el("span", { class: "relbar" }, el("i", { class: pct < 90 ? "lo" : pct < 98 ? "mid" : "hi", style: `width:${Math.min(100, Math.round(pct))}%` })), pct == null ? null : `${fmt(pct, 0)}%`));
    }));
  }

  // ── you ──
  function picksFor(ev) {
    const out = {};
    for (const [r, a] of myPicks) { const o = r - ev.round; if (o >= 0 && o <= 48) out[o] = a; }
    return out;
  }
  function myState(ev, df, res) {
    if (!me() || !df || !df.field) return null;
    return L.playerResult(df.field, res, picksFor(ev));
  }
  const drafts = new Map();        // round → the node chosen on a card but not sent yet (kept across redraws)
  /** Node cards to choose from, and one button that sends the choice. */
  function picker(label, options, current, onPick, cls = "", round = null, df = null) {
    const rel = reliability();
    const want = round != null && drafts.has(round) ? drafts.get(round) : current;
    const cards = el("div", { class: "ln-cards", role: "group", "aria-label": label }, ...options.map((a) => {
      const info = nodeInfo(a, df), r0 = rel.get(a), r = Number.isFinite(r0) && info && info.r ? r0 / info.r : r0;
      const b = el("button", { type: "button", class: "ln-card", style: `--node:${colorOf(a)}`, "aria-pressed": String(a === want),
        onclick: () => { if (round != null) drafts.set(round, a); render(); } },
        badge(a, "sm"), el("b", { text: NAMES[a] || `${a.slice(0, 4)}…${a.slice(-3)}` }),
        el("small", {}, el("span", { text: info ? `×${fmt(info.h, 2)}` : "" }), el("span", { text: Number.isFinite(r) ? `${fmt(r * 100, 0)}% on par` : "" })),
        el("span", { class: "ln-rel", "aria-hidden": "true" }, el("i", { style: `width:${Number.isFinite(r) ? Math.min(100, Math.round(r * 100)) : 0}%` })));
      if (sending) b.disabled = true;
      return b;
    }));
    const go = el("button", { class: `ln-go${cls ? " " + cls : ""}`, type: "button", onclick: () => onPick(want) }, want && want !== current ? `${label}: ${nameOf(want)}` : current ? "Tap another node to switch" : "Choose a node");
    if (sending || !want || want === current) go.disabled = true;
    return el("div", { class: "ln-act" }, cards, go);
  }
  function runCard(st, df, res, extraCls = "") {
    const n = df.field.nodes.length, pips = [];
    for (let k = 1; k <= n - 1; k++) pips.push(el("i", { class: k <= res.cuts.length ? (st.out === k ? "ko" : st.out && k > st.out ? "" : k === n - 1 && st.rode ? "crown" : "ok") : "" }));
    const bonus = st.jumped ? L.BONUS.jumped : L.BONUS.stayed;
    const title = res.done && st.rode ? `You rode ${nameOf(st.node)} home` : st.out ? `Knocked out at cut ${st.out}` : `Riding ${nameOf(st.node)}`;
    const line = res.done ? (st.rode ? `${st.survived} cuts survived + ${bonus} bonus${st.jumped ? " (after a jump)" : ""}.` : `${st.survived} cut${st.survived === 1 ? "" : "s"} survived.`)
      : st.out ? `${st.survived} cut${st.survived === 1 ? "" : "s"} survived. Your points count.` : `${st.survived} cut${st.survived === 1 ? "" : "s"} survived${st.jumped ? " (after your jump)" : ""}. +${bonus} if it's the last node standing.`;
    return el("div", { class: `ln-runcard${res.done && st.rode ? " won" : st.out ? " out" : ""}${extraCls}` },
      badge(st.node, "lg"),
      el("div", {}, el("h3", { text: title }), el("p", { text: line }), el("div", { class: "ln-pips", "aria-label": `${st.survived} of ${n - 1} cuts survived` }, ...pips)),
      el("div", { class: "ln-pts" }, String(st.points), el("small", { text: st.points === 1 ? "point" : "points" })));
  }
  function renderMe(ev, df, res, st) {
    const box = $("me"), now = nowT(), who = me(), parts = [];
    $("me-who").textContent = !picksContract ? "" : who ? `as ${nameOf(who)}${W.kind === "guest" ? " (guest: can play, can't win; this is a staked game)" : ""}` : "";
    if (!picksContract) { box.replaceChildren(); return; }
    const nx = nextEntry(now), nf = days.get(nx.day);
    if (!who) {
      box.replaceChildren(el("p", { class: "ln-cta", text: `Pick a node for the ${clock(nx.start)} drop` }),
        el("p", { class: "note", style: "margin:0", text: TESTNET ? "Play free gives you a Test wallet with test KOIN in one tap." : "Connect a wallet to pick (Kondor, KOIN Vault or a guest wallet)." }),
        TESTNET ? el("button", { class: "ln-go", type: "button", onclick: () => walletButton() }, "Play free") : null);
      return;
    }
    // The event running now: your run, a jump or a backup.
    if (df && df.field && res && now >= ev.start && !res.done) {
      const jumpRound = st && st.entered ? jumpOpen(df, res, ev, now) : null;
      const standing = res.standing;
      // Audit LN-4: until your picks have been read, the page doesn't say you're not in (or out).
      if (!mineOk) parts.push(el("p", { class: "note", style: "margin:0", text: mineErr ? "Couldn't read your picks. Retrying…" : "Reading your picks…" }));
      else if (!st || !st.entered) parts.push(el("p", { class: "note", style: "margin:0", text: `You're not in the ${clock(ev.start)} event. Get in the next one below.` }));
      // Your node is the one just cut and no valid jump is set yet: the Jump box, until the page's cut-off.
      else if (jumpRound)
        parts.push(el("div", { class: "ln-jump" }, el("h3", { text: `${nameOf(st.node)} is out. Jump!` }),
          el("p", { class: "note", style: "margin:0 0 12px", text: `Pick a node still standing before ${clock(cutoff(jumpRound))} (${dur(cutoff(jumpRound) - now)} left). One jump per event.` }),
          picker("Jump", standing, myPicks.get(jumpRound), (a) => sendPick(jumpRound, a, "your jump"), "storm", jumpRound, df)));
      else if (st.out) parts.push(runCard(st, df, res), el("p", { class: "note", style: "margin:0", text: `You're out: your node was cut at cut ${st.out}. Points this event: ${st.points}.` }));
      else {
        parts.push(runCard(st, df, res));
        if (!st.jumped) {
          const nextAt = res.cuts.length + 1, backupRound = L.roundForJump(df.start, nextAt), backup = myPicks.get(backupRound);
          if (nextAt < df.field.nodes.length - 1 && now < cutoff(backupRound))
            parts.push(el("div", {}, el("p", { class: "note", style: "margin:0 0 10px", text: (backup ? `Backup set: if ${nameOf(st.node)} goes at ${clock(df.start + nextAt * H)}, you jump to ${nameOf(backup)} (if it's still standing).` : `Set a backup: if ${nameOf(st.node)} goes at ${clock(df.start + nextAt * H)}, you jump to it automatically.`) + ` It covers that cut only; set by ${clock(cutoff(backupRound))}.` }),
              picker(backup ? "Change backup" : "Set backup", standing.filter((a) => a !== st.node), backup, (a) => sendPick(backupRound, a, "your backup"), "ghost", backupRound, df)));
        }
      }
    } else if (df && df.field && res && res.done && st && st.entered) parts.push(runCard(st, df, res));
    // The start pick for the next event that is still open.
    const startMine = myPicks.get(nx.round);
    if (nf && nf.field && !nx.open) parts.push(el("p", { class: "note", style: "margin:0", text: `Picks for the ${dayTime(nx.start)} event open at ${clock(nx.opens)} (in ${dur(nx.opens - now)}).` }));
    else if (nf && nf.field) parts.push(el("div", { class: "ln-act" },
      el("p", { class: "ln-cta", text: startMine ? `You drop in on ${nameOf(startMine)} at ${clock(nx.start)}` : `Pick your node for the ${clock(nx.start)} drop` }),
      el("p", { class: "note", style: "margin:0", text: `Picks close in ${dur(cutoff(nx.round) - now)}, at ${clock(cutoff(nx.round))}${startMine ? "; you can switch until then" : ""}. Tip: a node that signs every block it should is hard to knock out.` }),
      picker(startMine ? "Switch to" : "Drop in", nf.field.nodes.map((x) => x.a), startMine, (a) => sendPick(nx.round, a, `your node for the ${clock(nx.start)} event`), "", nx.round, nf)));
    // A backup for the first cut, set ahead of the start (owner, 2026-10-29): if your node goes at the first cut, you
    // jump to it automatically. Later backups are set from "Your run" once the race is on.
    if (nf && nf.field && nx.open && startMine) {
      const b1 = L.roundForJump(nx.start, 1), backup = myPicks.get(b1);
      if (pickable(b1)) parts.push(el("div", { class: "ln-act" },
        el("p", { class: "note", style: "margin:0 0 10px", text: (backup ? `Backup set: if ${nameOf(startMine)} goes at the first cut (${clock(nx.start + H)}), you jump to ${nameOf(backup)}.` : `Optional backup: if ${nameOf(startMine)} goes at the first cut (${clock(nx.start + H)}), you jump to it automatically.`) + " It covers that cut only; one jump per event." }),
        picker(backup ? "Change backup" : "Set backup", nf.field.nodes.map((x) => x.a).filter((a) => a !== startMine), backup, (a) => sendPick(b1, a, "your backup for the first cut"), "ghost", b1, nf)));
    }
    else parts.push(el("p", { class: "note", style: "margin:0", text: `The field for the ${dayTime(nx.start)} event appears when picks open, at ${clock(nx.opens)}.` }));
    box.replaceChildren(...parts);
  }

  /** Audit LN-22: the game as registered in the Picks contract. Its timing must be this page's rules; its lead and
   *  ahead (which tighten_game can change) set the page's lock and open times. */
  async function readRegistration() {
    const g = (await picksContract.functions.get_game({ game: L.GAME_ID })).result?.game;
    if (!g) return;                                 // not registered yet: the pick error explains it
    if (String(g.round_size) !== String(L.PICKS_GAME.round_size) || String(g.round_offset) !== String(L.PICKS_GAME.round_offset) || Number(g.lock_mode) !== 2) {
      picksContract = null; say("This game's registration in the Picks contract doesn't match this page's rules. Picks are off here.");
      return;
    }
    const lead = Number(g.lead), ahead = Number(g.ahead);
    if (Number.isFinite(lead) && lead > 0) REG.lead = lead;
    if (Number.isFinite(ahead) && ahead > 0) REG.ahead = ahead;
  }

  // ── picks (live once picks-data/deployment.json is on the site; on the test page, the testnet Picks contract) ──
  async function setupPicks() {
    if (TESTNET) return setupTestnet();
    let pdep = null, dep = null;
    try { pdep = await fetchJson(new URL("picks-data/deployment.json", ROOT)); } catch { return; }
    if (!pdep || !isAddr(pdep.contract)) return;
    try { dep = await fetchJson(new URL("game-data/deployment.json", ROOT)); } catch { /* the wallet keeps its defaults */ }
    const abi = await fetchJson(new URL("picks/abi/picks.koilib.json", ROOT));
    picksContract = new lib.Contract({ id: pdep.contract, abi, provider });
    await readRegistration().catch(() => { /* the rules' own settings */ });
    if (!picksContract) return;
    if (W) W.init({ provider, chainId: dep && dep.chainId, payer: dep && dep.payer, sponsor: dep && dep.sponsor, onChange: () => loadMine().then(render) });
    $("picks-soon").hidden = true;
  }
  /** The test page: testnet settings, the testnet Picks contract and the testnet wallet. Refuses anything on mainnet. */
  async function setupTestnet() {
    const cfg = await fetchJson(new URL("testnet/lastnode.json", ROOT));
    if (!cfg || cfg.network !== "koinos-foundation-testnet" || !cfg.chainId || cfg.chainId === MAINNET_CHAIN_ID) throw new Error("This page's testnet settings are missing or name mainnet.");
    const g = Array.isArray(cfg.games) ? cfg.games.find((x) => x && x.id === L.GAME_ID) : null;
    if (!g || ["cut", "offset", "lead", "ahead", "period", "phase"].some((k) => g[k] !== L.GAME[k])) throw new Error(`Game ${L.GAME_ID}'s settings don't match the rules on this page.`);
    // Audit LN-28: the faucet link must be an https address.
    if (cfg.faucet != null && !/^https:\/\/[^\s"<>]+$/.test(String(cfg.faucet))) cfg.faucet = null;
    NET = cfg;
    const local = location.hostname === "localhost" || location.hostname === "127.0.0.1";
    DATA = local ? new URL(`testnet-data/lastnode-${L.GAME_ID}/`, ROOT).href : `${cfg.data}lastnode-${L.GAME_ID}/`;
    picksProvider = new lib.Provider([cfg.rpc]);
    const id = await picksProvider.getChainId();
    if (id === MAINNET_CHAIN_ID || id !== cfg.chainId) throw new Error("The testnet node isn't the testnet in this page's settings.");
    renderGameTabs(cfg.games);
    const bx = await fetchJson(new URL("testnet/blockx.json", ROOT)).catch(() => null);
    if (!bx || bx.network !== "koinos-foundation-testnet" || !isAddr(bx.picks)) return;   // no testnet Picks contract yet
    const abi = await fetchJson(new URL("picks/abi/picks.koilib.json", ROOT));
    picksContract = new lib.Contract({ id: bx.picks, abi, provider: picksProvider });
    await readRegistration().catch(() => { /* the rules' own settings */ });
    if (!picksContract) return;
    if (W) W.init({ provider: picksProvider, chainId: cfg.chainId, picks: bx.picks });
    $("picks-soon").hidden = true;
    renderWallet();
  }
  function renderGameTabs(games) {
    const box = $("game-tabs");
    if (!box) return;
    box.hidden = false;
    box.replaceChildren(...games.map((g) => el("a", { href: `#game-${g.id}`, class: "btn" + (g.id === L.GAME_ID ? "" : " ghost"), "aria-current": g.id === L.GAME_ID ? "page" : null, text: g.id === 93 ? "Fast test (cut every 20 min)" : "Real settings (daily, 14:00 UTC)" })));
    window.addEventListener("hashchange", () => location.reload());
  }
  // ── test page: the wallet button and "Play free" (a Test wallet in this browser, funded by the local test server) ──
  function renderWallet() {
    const b = $("wallet-btn");
    if (!b || !W || !TESTNET) return;
    const who = me();
    b.textContent = who ? nameOf(who) : "Play free";
  }
  async function walletButton() {
    if (!W || !picksContract) return pickModal("info", "Picks aren't open yet", ["The testnet Picks contract isn't in this page's settings yet."], [okBtn("OK")]);
    const who = me();
    if (who) return pickModal("info", W.kind === "test" ? "Your Test wallet" : "Your wallet", [el("p", { class: "mono", text: who }),
      NET && NET.faucet ? el("p", {}, "More test KOIN: send ", el("b", { text: `/faucet ${who}` }), " to ", el("a", { href: NET.faucet, target: "_blank", rel: "noopener noreferrer", text: "the faucet bot" }), ".") : null].filter(Boolean),
      [el("button", { class: "btn ghost", type: "button", onclick: () => { closeModal(); W.disconnect(); } }, "Disconnect"), okBtn("Close")]);
    let a;
    try { a = W.quick(); } catch (e) { return pickModal("bad", "Couldn't make a wallet", [String((e && e.message) || e)], [el("button", { class: "btn", type: "button", onclick: () => { closeModal(); W.connect(); } }, "Use Kondor"), okBtn("OK")]); }
    const local = location.hostname === "localhost" || location.hostname === "127.0.0.1";
    if (!local) return fundHelp(a);
    pickModal("busy", "Adding test KOIN…", ["Your Test wallet is ready. The test server on your computer is sending it 5 test KOIN (enough for about 100 picks)."]);
    try {
      const r = await fetch("/api/fund", { method: "POST", headers: { "Content-Type": "application/json", "X-KG-Testnet": "fund" }, body: JSON.stringify({ address: a }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `the test server answered ${r.status}`);
      pickModal("ok", "You're in", ["Your Test wallet has test KOIN. Pick your node under “Your node”."], [okBtn("Pick now")]);
    } catch (e) { fundHelp(a, String((e && e.message) || e)); }
  }
  function fundHelp(who, why) {
    pickModal("info", "One more step: test KOIN", [why ? `Couldn't add test KOIN automatically: ${why}` : "Your wallet is ready in this browser. It needs free test KOIN to pay for picks.",
      el("p", {}, "In Telegram, send ", el("b", { text: `/faucet ${who}` }), " to ", el("a", { href: (NET && NET.faucet) || "https://t.me/KoinosTestnetFaucetBot", target: "_blank", rel: "noopener noreferrer", text: "@KoinosTestnetFaucetBot" }), ".")], [okBtn("Done")]);
  }
  if ($("wallet-btn")) $("wallet-btn").addEventListener("click", walletButton);

  /** Your picks for the rounds that matter: the shown event's start and jump rounds, and the next event's start. */
  // Audit LN-4: picks are read into a new map and swapped in only when every read worked; a failed read keeps the old
  // ones, says so, and tries again in 8 seconds. The map is cleared only when the wallet changes.
  let mineCall = 0, mineWho = null, mineOk = false, mineErr = false, mineRetry = null;
  async function loadMine() {
    const call = ++mineCall, who = me();
    if (who !== mineWho) { drafts.clear(); myPicks.clear(); mineWho = who; mineOk = false; mineErr = false; }
    if (!picksContract || !who) { mineOk = true; return; }
    const { ev, df } = shownEvent(), nx = nextEntry();
    const rounds = new Set([nx.round, ev.round, L.roundForJump(nx.start, 1)]);
    const n = df && df.field ? df.field.nodes.length : 0;
    for (let o = 2; o <= n; o++) rounds.add(ev.round + o);
    try {
      const got = await Promise.all([...rounds].map((r) => picksContract.functions.get_pick({ game: L.GAME_ID, round: String(r), player: who })
        .then((x) => [r, x.result && x.result.pick && Array.isArray(x.result.pick.producers) ? x.result.pick.producers[0] : null])));
      if (call !== mineCall || me() !== who) return;      // a newer call (or another wallet) took over
      myPicks.clear();
      for (const [r, a] of got) if (isAddr(a)) myPicks.set(r, a);
      mineOk = true; mineErr = false;
    } catch {
      if (call !== mineCall || me() !== who) return;
      mineErr = true;
      clearTimeout(mineRetry);
      mineRetry = setTimeout(() => loadMine().then(render), 8000);
    }
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

  async function sendPick(round, producer, what) {
    const who = me();
    if (!who || !picksContract || sending) return;
    if (!isAddr(producer)) return pickModal("info", "Choose a node first", ["Choose a node from the list, then press the button."], [okBtn("OK")]);
    if (myPicks.get(round) === producer) return pickModal("info", "That is already your pick", [`${nameOf(producer)} is ${what}.`], [okBtn("OK")]);
    if (!pickable(round)) return pickModal("bad", nowT() < openAt(round) ? "Not open yet" : "Too close to the lock", [nowT() < openAt(round) ? `Picks for this round open at ${clock(openAt(round))}.` : "This pick locks in under a minute. It can't be sent safely now."], [okBtn("OK")]);
    sending = true; render();
    const line = `${nameOf(producer)} as ${what} (round of ${dayTime(L.roundTime(round))}, locks ${clock(lockAt(round))})`;
    const wallet = W.kind === "guest" ? "your guest wallet" : W.label ? W.label() : "your wallet";
    pickModal("busy", W.kind === "guest" ? "Sending your pick…" : `Confirm in ${wallet}`, [line, TESTNET ? "Testnet: the Mana comes from your test KOIN. Nothing here is real money." : "Free: the KnodeGames Mana sponsor pays the Mana."]);
    try {
      const { operation } = await picksContract.functions.pick({ player: who, game: L.GAME_ID, round: String(round), producers: [producer], number: "0" }, { onlyOperation: true });
      const id = await W.send(`pick ${nameOf(producer)} as ${what}`, [operation]);
      pickModal("busy", "Sent. Checking the chain…", [line]);
      let onChain = false;
      for (let t = 0; t < 10 && !onChain; t++) {
        try { const x = await picksContract.functions.get_pick({ game: L.GAME_ID, round: String(round), player: who }); onChain = !!(x.result && x.result.pick && x.result.pick.producers && x.result.pick.producers[0] === producer); } catch { /* again */ }
        if (!onChain) await new Promise((res) => setTimeout(res, 3000));
      }
      if (onChain) pickModal("ok", "Pick confirmed", [el("p", {}, el("b", { text: nameOf(producer) }), ` is ${what}.`),
        `You can change it until ${clock(cutoff(round))}.`,
        id ? el("p", { class: "ago mono", text: `Transaction ${String(id).slice(0, 18)}…` }) : null].filter(Boolean), [okBtn()]);
      else pickModal("info", "Sent, not seen on the chain yet", ["Your wallet sent it. It usually shows within a minute; this page updates by itself."], [okBtn("OK")]);
    } catch (e) {
      const m = String((e && e.message) || e);
      const why = /no such game/i.test(m) ? (TESTNET ? `Game ${L.GAME_ID} isn't switched on in the testnet Picks contract yet. Register it first (in PowerShell: npm run picks -- announce ${L.GAME_ID} --testnet --send, wait 10 minutes, then apply ${L.GAME_ID}).` : "This game isn't open in the Picks contract yet.")
        : /game is closed/i.test(m) ? "This game is switched off in the Picks contract right now."
        : /locked/i.test(m) ? "That pick is locked: the start of the event (or the jump window) has closed."
        : /not open yet/i.test(m) ? "That round isn't open yet."
        : /used up/i.test(m) ? "Today's picks are used up (changes count). More after 00:00 UTC."
        : /changed again/i.test(m) ? "That pick has been changed too many times already."
        : /reject|denied|cancel/i.test(m) ? "Cancelled in your wallet. Nothing was sent."
        : `Not sent: ${m.slice(0, 200)}`;
      pickModal(/Cancelled/.test(why) ? "info" : "bad", /Cancelled/.test(why) ? "Cancelled" : "Pick not sent", [why], [okBtn("OK")]);
    } finally { sending = false; drafts.delete(round); await loadMine(); render(); }
  }

  // ── leaderboard (the recorder's board.json, shown by the shared board.js) ──
  const lb = window.KBoard ? window.KBoard.create($("ln-board"), {
    label: "Last Node Standing leaderboard",
    columns: [{ key: "pts", label: "Points" }, { key: "rides", label: "Rides" }, { key: "jumps", label: "Jumps", wide: true }, { key: "events", label: "Events", wide: true }],
    scored: (r) => r.pts > 0,
    summary: (r) => `${fmt(r.pts)} pts · ${fmt(r.rides)} ride${r.rides === 1 ? "" : "s"}`,
    name: nameOf, link: (a) => EXPLORER + a,
    me: (r, place) => `${place ? `You: #${place} with` : "Your score (only you see this):"} ${fmt(r.pts)} points from ${fmt(r.events)} event${r.events === 1 ? "" : "s"} (${fmt(r.rides)} rides, ${fmt(r.jumps)} jumps).`,
    unranked: TESTNET ? "On the testnet, wallets holding at least 1 test KOIN are ranked. Nothing here is paid." : "To be ranked, hold at least 1 VHP or stake in KnodeGames. Weekly rewards go to players staked in this game.",
  }) : null;
  function renderBoard() { if (lb && board) { $("board-box").hidden = false; lb.setMe(me() || ""); lb.set(board); } }
  if (W && W.subscribe) W.subscribe(() => { renderWallet(); loadMine().then(render); renderBoard(); });

  // ── start ──
  (async () => {
    const picksReady = setupPicks().catch((e) => { if (TESTNET) say(String((e && e.message) || e)); });
    if (TESTNET) await picksReady;      // the test page's data folder comes from its testnet settings
    await loadAll(); render(); renderBoard();
    await loadBlocks(); render();
    await picksReady; await loadMine(); render();
    setInterval(() => { if (!document.hidden) loadBlocks().then(render); }, 30000);
    setInterval(() => { if (!document.hidden) loadAll().then(() => { render(); renderBoard(); }); }, 120000);
    setInterval(() => { if (!document.hidden && picksContract) loadMine().then(render); }, 60000);
    setInterval(() => { if (!document.hidden) tick(); }, 1000);
  })();
})();

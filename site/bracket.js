/* bracket.html: the Producer Bracket. It reads the bracket recorder's files (games-data/bracket: the seeding, the
   locked brackets, each hour's block counts and the leaderboards), the latest block snapshot (blocks-data) for each
   producer's recent form, and, once the KnodeGames Picks contract is live (picks-data/deployment.json), your bracket
   from the contract. It sends one thing: the bracket you confirm in your wallet, as one number.
   The rules are bracket-math.js, the same file the recorder (bot/games/bracket.ts) uses. */
(() => {
  "use strict";
  const BM = window.KBracketMath;
  if (!BM || typeof document === "undefined" || !document.getElementById("bk-rounds")) return;

  const lib = window.koilib || window.koinos || window;
  const RPC = "https://api.koinos.io";
  const DATA = "https://raw.githubusercontent.com/bawcejawn/Knode/games-data/bracket/";
  const BLOCKS = "https://raw.githubusercontent.com/bawcejawn/Knode/blocks-data/recent-blocks.json";
  const EXPLORER = "https://koinosscan.com/address/";
  const NAMES = { "1Mpmf2ERhjYpX7CCiM11WERuM4j17uT1sr": "KnodeGames vault node", "1FKTpXBhhHEbu5vVchM8UsVbAvPArJsRmR": "KnodeGames Swap node" };
  const OWN = new Set(Object.keys(NAMES));
  const ROOT = new URL("../", location.href);
  const W = window.KWallet;
  const provider = lib.Provider ? new lib.Provider([RPC]) : null;

  const $ = (id) => document.getElementById(id);
  const el = (tag, attrs = {}, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (v == null) continue; if (k === "text") e.textContent = v; else if (k.startsWith("on")) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v); } for (const c of kids) if (c != null) e.append(c); return e; };
  const isAddr = (a) => typeof a === "string" && /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a);
  const nameOf = (a) => (isAddr(a) ? NAMES[a] || a.slice(0, 5) + "…" + a.slice(-4) : "–");
  const fmt = (n, d = 0) => (Number.isFinite(Number(n)) ? Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }) : "–");
  const dayTime = (t) => new Date(t).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
  const dayName = (t) => new Date(t).toLocaleDateString(undefined, { weekday: "long", timeZone: "UTC" });
  const dur = (ms) => { const m = Math.max(0, Math.ceil(ms / 60000)), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60); return d ? `${d} d ${h} h` : h ? `${h} h ${String(m % 60).padStart(2, "0")} min` : `${m} min`; };
  const say = (t) => { $("status").textContent = t; $("status").hidden = !t; };
  async function fetchJson(url) { const r = await fetch(url, { cache: "no-cache" }); if (!r.ok) throw new Error(String(r.status)); return r.json(); }
  const me = () => (W && W.address) || null;

  // ── state ──
  const weeks = new Map();          // week → recorder file
  let board = null, form = new Map(), view = null, round = 0;
  let picksContract = null, mine = null, sending = false;
  let draft = null, draftWeek = null; // winner seeds per round for the bracket being filled in

  // ── data ──
  async function loadWeeks() {
    const now = Date.now(), w = BM.weekOf(now);
    await Promise.all([w - 1, w, w + 1].filter((x) => x >= 1).map(async (x) => {
      try { const j = await fetchJson(`${DATA}W${String(x).padStart(3, "0")}.json`); if (valid(j, x)) weeks.set(x, j); } catch { /* not yet */ }
    }));
    try { const b = await fetchJson(DATA + "board.json"); if (b && b.v === 1) board = b; } catch { /* not yet */ }
  }
  /** Only well-formed files are used (the publish job checks the same shape). */
  function valid(j, w) {
    if (!j || j.v !== 1 || j.week !== w || typeof j.status !== "string") return false;
    const s = j.seeding;
    if (s && !(Array.isArray(s.seeds) && s.seeds.every(isAddr) && [0, 8, 16, 32].includes(s.size) && s.seeds.length <= s.size)) return false;
    if (!Array.isArray(j.days) || !Array.isArray(j.points)) return false;
    return true;
  }
  async function loadForm() {
    try {
      const b = await fetchJson(BLOCKS);
      if (!b || !Array.isArray(b.sig) || !Array.isArray(b.signers)) return;
      const n = b.sig.length, cnt = new Map();
      for (const i of b.sig) { const a = b.signers[i]; if (isAddr(a)) cnt.set(a, (cnt.get(a) || 0) + 1); }
      form = new Map([...cnt].map(([a, c]) => [a, { blocks: c, of: n }]));
    } catch { /* no form shown */ }
  }

  // ── which week the page shows ──
  function pickView() {
    const now = Date.now(), w = BM.weekOf(now);
    const next = weeks.get(w + 1);
    if (next && next.seeding && next.seeding.size && now < BM.lockTime(w + 1)) return w + 1;
    if (weeks.get(w)) return w;
    return next ? w + 1 : w;
  }
  const wf = () => weeks.get(view);
  /** The round being played (or last played) in the shown week; 0 before the week starts. */
  function currentRound() {
    const s = wf() && wf().seeding; if (!s || !s.size) return 0;
    return Math.max(0, Math.min(BM.roundsOf(s.size) - 1, Math.floor((Date.now() - BM.weekStart(view)) / BM.DAY)));
  }
  const seeding = () => (wf() && wf().seeding && wf().seeding.size ? wf().seeding : null);
  const isOpen = () => !!seeding() && Date.now() < BM.lockTime(view) && !(wf().picks);

  // ── producers ──
  function info(seed) {
    const s = seeding(); if (!s || !seed) return null;
    const a = s.seeds[seed - 1], vhp = s.vhp[seed - 1] || 0, share = s.totalVhp > 0 ? vhp / s.totalVhp : 0;
    const f = form.get(a), exp = f ? f.of * share : 0;
    return { seed, a, vhp, share, perDay: 28800 * share, form: f && exp > 0 ? f.blocks / exp : null };
  }
  function dayIdx(r) {
    const w = wf(); if (!w || !w.days[r]) return null;
    return { idx: BM.indexFromHours(w.days[r].map((h) => h || null)), done: w.days[r].every(Boolean), hours: w.days[r].filter(Boolean).length };
  }

  // ── the bracket being filled in ──
  function startDraft(empty = false) {
    const s = seeding(); if (!s) { draft = null; return; }
    if (!empty && draftWeek === view && draft) return;
    draftWeek = view;
    const d = !empty && mine !== null ? BM.decode(mine, s.size, s.seeds.length) : null;
    draft = d ? d.rounds.map((r) => [...r]) : Array.from({ length: BM.roundsOf(s.size) }, (_, r) => new Array(s.size / 2 ** (r + 1)).fill(0));
    // byes advance by themselves
    BM.firstRound(s.size, s.seeds.length).forEach(([a, b], m) => { if (!b) draft[0][m] = a; });
  }
  /** The two seeds meeting in matchup m of round r, given the draft (0 = not decided yet). */
  function pairOf(r, m) {
    const s = seeding();
    if (r === 0) return BM.firstRound(s.size, s.seeds.length)[m];
    const a = draft[r - 1][2 * m], b = draft[r - 1][2 * m + 1];
    return a && b ? [Math.min(a, b), Math.max(a, b)] : [a || 0, b || 0].sort((x, y) => (x && y ? x - y : y - x));
  }
  function choose(r, m, seed) {
    if (!isOpen() || sending) return;
    const old = draft[r][m];
    draft[r][m] = seed;
    // a later pick that relied on the seed that just lost is cleared
    if (old && old !== seed) for (let k = r + 1, mm = m >> 1; k < draft.length; k++, mm >>= 1) if (draft[k][mm] === old) draft[k][mm] = 0;
    render();
  }
  const filled = () => draft && draft.every((r) => r.every((x) => x > 0));
  const draftNumber = () => { const s = seeding(); try { return filled() ? BM.encode(draft, s.size, s.seeds.length) : null; } catch { return null; } };
  function autoFill(kind) {
    const s = seeding(); if (!s || !isOpen()) return;
    draft = BM.play(s.size, s.seeds.length, (r, m, a, b) => (kind === "underdog" ? true : kind === "form" ? (info(b).form ?? 1) > (info(a).form ?? 1) : false)).rounds.map((x) => [...x]);
    render();
  }

  // ── picks contract ──
  async function setupPicks() {
    let pdep = null, dep = null;
    try { pdep = await fetchJson(new URL("picks-data/deployment.json", ROOT)); } catch { return; }
    if (!pdep || !isAddr(pdep.contract) || !provider) return;
    try { dep = await fetchJson(new URL("game-data/deployment.json", ROOT)); } catch { /* defaults */ }
    const abi = await fetchJson(new URL("picks/abi/picks.koilib.json", ROOT));
    picksContract = new lib.Contract({ id: pdep.contract, abi, provider });
    if (W) W.init({ provider, chainId: dep && dep.chainId, payer: dep && dep.payer, sponsor: dep && dep.sponsor, onChange: () => loadMine() });
    $("picks-soon").hidden = true;
  }
  async function loadMine() {
    mine = null;
    const who = me();
    if (picksContract && who && seeding()) {
      try {
        const x = await picksContract.functions.get_pick({ game: BM.GAME_ID, round: String(BM.picksRound(view)), player: who });
        const p = x.result && x.result.pick;
        if (p && p.number !== undefined && (p.height || p.time)) mine = Number(p.number);
      } catch { /* unknown */ }
    }
    if (mine === null && wf() && wf().picks && who) { const row = wf().picks.rows.find((r) => r[0] === who); if (row) mine = row[1]; }
    draftWeek = null; startDraft(); render();
  }

  // ── drawing ──
  function render() {
    const w = wf(), s = seeding(), now = Date.now();
    // the week line
    const lines = [];
    if (!w && view) lines.push(now < BM.seedTime(view) ? `The bracket for week ${view + 1} is seeded ${dayTime(BM.seedTime(view))} (in ${dur(BM.seedTime(view) - now)}).` : "Waiting for the recorder…");
    else if (w && (w.status === "none" || w.status === "void")) lines.push(`Week ${view + 1}: no bracket. ${w.void || ""}`);
    else if (s && isOpen()) lines.push(`Week ${view + 1}: ${s.size}-producer bracket. Picks lock ${dayTime(BM.lockTime(view))} (in ${dur(BM.lockTime(view) - now)}).`);
    else if (s && w.status === "final") lines.push(`Week ${view + 1}: final.`);
    else if (s) { const r = currentRound(); lines.push(`Week ${view + 1}: locked. ${now < BM.weekStart(view) ? "Round 1 starts Monday 00:00 UTC." : `${BM.ROUND_NAMES[s.size][r]} today (UTC).`}`); }
    $("week-line").textContent = lines.join(" ");
    $("week-tabs").replaceChildren(...[...weeks.keys()].sort((a, b) => b - a).filter((x) => weeks.get(x).seeding).map((x) =>
      el("button", { type: "button", "aria-pressed": String(x === view), onclick: () => { view = x; round = currentRound(); draftWeek = null; loadMine(); } }, x > BM.weekOf(now) ? "Next week" : x === BM.weekOf(now) ? "This week" : "Last week")));
    $("bracket-box").hidden = !s;
    $("own-note").hidden = !(s && s.seeds.some((a) => OWN.has(a)));
    if (!s) { $("bk-rounds").replaceChildren(); $("bk-list").replaceChildren(); $("bk-actions").hidden = true; return; }
    startDraft();
    const R = BM.roundsOf(s.size);
    if (round >= R) round = 0;
    $("bk-rounds").replaceChildren(...BM.ROUND_NAMES[s.size].map((n, r) => el("button", { type: "button", "aria-pressed": String(r === round), onclick: () => { round = r; render(); } },
      el("span", { text: n }), el("small", { text: dayName(BM.roundDay(view, r)).slice(0, 3) }))));
    const open = isOpen(), res = w.results, di = dayIdx(round), byes = new Set(BM.byesOf(s.size, s.seeds.length));
    $("bk-day").textContent = `${BM.ROUND_NAMES[s.size][round]} · played ${dayName(BM.roundDay(view, round))} (UTC)${di && di.hours && !di.done ? ` · ${di.hours} of 24 hours in` : ""} · ${2 ** round} point${round ? "s" : ""} a right pick${round === R - 1 ? ", +2 for the champion" : ""}`;
    const list = [];
    const nM = s.size / 2 ** (round + 1);
    for (let m = 0; m < nM; m++) {
      const [a, b] = open || !res ? pairOf(round, m) : realPair(round, m);
      const bye = round === 0 && byes.has(m);
      const winner = res && res.rounds[round] ? res.rounds[round][m] : 0;
      const myPick = draft ? draft[round][m] : 0;
      const side = (seed) => {
        if (!seed) return el("div", { class: "bk-side tbd" }, el("span", { class: "bk-seed", text: "" }), el("span", { text: bye ? "Bye" : "Winner of the match before" }));
        const p = info(seed), ix = di && di.idx ? di.idx.get(p.a) : null;
        const cls = ["bk-side", myPick === seed ? "picked" : "", winner === seed ? "won" : "", winner && winner !== seed ? "lost" : ""].join(" ").trim();
        const meta = [`${fmt(p.share * 100, p.share < 0.01 ? 2 : 1)}% VHP`, `~${fmt(p.perDay)} blocks/day`, p.form !== null ? `recent form ${fmt(p.form * 100)}%` : null].filter(Boolean).join(" · ");
        const kids = [el("span", { class: "bk-seed", text: String(seed) }),
          el("span", { class: "bk-name" }, el("b", { text: nameOf(p.a) }), el("small", { text: meta })),
          ix && ix.expected > 0 ? el("span", { class: "bk-ix", text: `${fmt(ix.index * 100, 1)}%`, title: `${fmt(ix.blocks)} blocks of ${fmt(ix.expected, 1)} expected` }) : null,
          myPick === seed && !bye && (open || mine !== null) ? el("span", { class: "bk-mark", text: winner ? (winner === seed ? "✓" : "✗") : "★" }) : null];
        if (open && !bye && seed) return el("button", { type: "button", class: cls, "aria-pressed": String(myPick === seed), onclick: () => choose(round, m, seed) }, ...kids);
        return el("div", { class: cls }, ...kids);
      };
      list.push(el("div", { class: "bk-match" + (bye ? " bye" : "") }, side(a), el("div", { class: "bk-vs", text: bye ? "bye" : "v" }), side(b)));
    }
    $("bk-list").replaceChildren(...list);
    // actions
    const who = me();
    $("bk-actions").hidden = !open;
    if (open) {
      const total = draft.flat().length, done = draft.flat().filter(Boolean).length;
      $("bk-progress").textContent = `${done} of ${total} picked${filled() ? " · ready" : ""}${mine !== null ? " · you have a bracket on chain" : ""}`;
      $("bk-submit").disabled = !filled() || sending || !picksContract || !who || draftNumber() === mine;
      $("bk-submit").textContent = mine !== null ? "Change my bracket" : "Submit my bracket";
      $("bk-who").textContent = !picksContract ? "" : who ? `Picking as ${nameOf(who)}${W.kind === "guest" ? " (guest: free play; prizes need a stake)" : ""}.` : "Connect a wallet to submit (Kondor, KOIN Vault or a guest wallet).";
    }
    $("bk-share").hidden = !(draft && filled());
    renderScore();
  }
  /** The real pair in a round once results are in (or the winners so far). */
  function realPair(r, m) {
    const s = seeding(), res = wf().results;
    if (r === 0) return BM.firstRound(s.size, s.seeds.length)[m];
    const prev = res && res.rounds[r - 1];
    if (!prev) return [0, 0];
    const a = prev[2 * m], b = prev[2 * m + 1];
    return [Math.min(a, b), Math.max(a, b)];
  }
  function renderScore() {
    const w = wf(), who = me();
    const row = w && who ? w.points.find((p) => p[0] === who) : null;
    const s = seeding();
    $("bk-score").textContent = !row ? "" : `Your bracket: ${row[1]} point${row[1] === 1 ? "" : "s"} so far, ${row[3]} right${row[2] ? ", champion right" : ""}. Most possible: ${BM.maxPoints(s.size) - BM.byesOf(s.size, s.seeds.length).length}.`;
  }

  // ── the confirm pop-up ──
  let modal = null;
  function pop(state, title, lines = [], actions = []) {
    if (!modal) {
      modal = el("div", { class: "pk-modal", role: "dialog", "aria-modal": "true", "aria-labelledby": "pk-m-title" });
      modal.addEventListener("click", (e) => { if (e.target === modal && !modal.querySelector(".pk-spin")) close(); });
      document.body.append(modal);
    }
    const icon = { busy: el("span", { class: "pk-spin", "aria-hidden": "true" }), ok: el("span", { class: "pk-big ok", text: "✓" }), bad: el("span", { class: "pk-big bad", text: "✗" }), info: el("span", { class: "pk-big", text: "ℹ" }) }[state];
    modal.replaceChildren(el("div", { class: `pk-box ${state}` }, icon, el("h3", { id: "pk-m-title", text: title }), ...lines.map((l) => (typeof l === "string" ? el("p", { text: l }) : l)),
      actions.length ? el("div", { class: "pk-acts" }, ...actions) : null));
    modal.hidden = false;
    const btn = modal.querySelector("button"); if (btn) btn.focus();
  }
  function close() { if (modal) modal.hidden = true; }
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && modal && !modal.hidden && !modal.querySelector(".pk-spin")) close(); });
  const btn = (text, onclick, cls = "btn") => el("button", { class: cls, type: "button", onclick }, text);

  function summary() {
    const s = seeding(), names = BM.ROUND_NAMES[s.size];
    const champ = draft[draft.length - 1][0];
    const out = [el("p", {}, "Champion: ", el("b", { text: `${champ} · ${nameOf(s.seeds[champ - 1])}` }))];
    for (let r = draft.length - 2; r >= Math.max(0, draft.length - 3); r--) out.push(el("p", { text: `${names[r]} winners: ${draft[r].map((x) => `${x} ${nameOf(s.seeds[x - 1])}`).join(", ")}` }));
    return out;
  }
  function review() {
    const n = draftNumber(), who = me();
    if (n === null || !who || !picksContract) return;
    if (BM.lockTime(view) - Date.now() < 120000) return pop("bad", "Too close to the lock", ["Brackets lock Sunday 23:55 UTC. This one can't make it in time."], [btn("OK", close)]);
    pop("info", "Check your bracket", [...summary(),
      el("p", { class: "ago", text: `Sent to the chain as one number: ${n}. You can change it until ${dayTime(BM.lockTime(view))}, up to ${BM.MAX_CHANGES} times.` })],
      [btn("Back", close, "btn btn-ghost"), btn("Confirm in wallet", () => send(n))]);
  }
  async function send(n) {
    const who = me();
    if (!who || !picksContract || sending) return;
    sending = true; render();
    const wallet = W.kind === "guest" ? "your guest wallet" : W.label ? W.label() : "your wallet";
    pop("busy", W.kind === "guest" ? "Sending your bracket…" : `Confirm in ${wallet}`, [...summary(), "The KnodeGames Mana sponsor pays the Mana."]);
    try {
      const { operation } = await picksContract.functions.pick({ player: who, game: BM.GAME_ID, round: String(BM.picksRound(view)), producers: [], number: String(n) }, { onlyOperation: true });
      const id = await W.send(`your bracket for week ${view + 1}`, [operation]);
      pop("busy", "Sent. Checking the chain…", summary());
      let seen = false;
      for (let t = 0; t < 10 && !seen; t++) {
        try { const x = await picksContract.functions.get_pick({ game: BM.GAME_ID, round: String(BM.picksRound(view)), player: who }); seen = !!(x.result && x.result.pick && Number(x.result.pick.number) === n); } catch { /* again */ }
        if (!seen) await new Promise((r) => setTimeout(r, 3000));
      }
      if (seen) pop("ok", "Bracket confirmed", [...summary(), id ? el("p", { class: "ago mono", text: `Transaction ${String(id).slice(0, 18)}…` }) : null].filter(Boolean), [btn("Done", close)]);
      else pop("info", "Sent, not seen on the chain yet", ["Your wallet sent it. It usually shows within a minute; this page updates by itself."], [btn("OK", close)]);
    } catch (e) {
      const m = String((e && e.message) || e);
      const why = /locked/i.test(m) ? "Brackets are locked: they close Sunday 23:55 UTC."
        : /not open yet/i.test(m) ? "Picks for this week aren't open yet (they open Saturday 12:00 UTC)."
        : /used up/i.test(m) ? "Today's picks are used up. More after 00:00 UTC."
        : /changed again/i.test(m) ? `This bracket has been changed ${BM.MAX_CHANGES} times already.`
        : /already your pick/i.test(m) ? "That is already your bracket."
        : /reject|denied|cancel/i.test(m) ? "Cancelled in your wallet. Nothing was sent."
        : `Not sent: ${m.slice(0, 200)}`;
      pop(/Cancelled/.test(why) ? "info" : "bad", /Cancelled/.test(why) ? "Cancelled" : "Bracket not sent", [why], [btn("OK", close)]);
    } finally { sending = false; await loadMine(); }
  }

  // ── share image: drawn on a canvas, saved or shared as a PNG ──
  function shareImage() {
    const s = seeding(); if (!s || !filled()) return;
    const c = document.createElement("canvas"), W1 = 1080, H1 = 1350; c.width = W1; c.height = H1;
    const g = c.getContext("2d"); if (!g) return;
    const css = getComputedStyle(document.documentElement);
    const ink = css.getPropertyValue("--ink").trim() || "#14213D", paper = css.getPropertyValue("--paper").trim() || "#FFF8EC", acc = css.getPropertyValue("--tang").trim() || "#F28C28";
    g.fillStyle = paper; g.fillRect(0, 0, W1, H1);
    g.fillStyle = ink; g.font = "800 64px system-ui, sans-serif"; g.fillText("My Producer Bracket", 64, 120);
    g.font = "400 34px system-ui, sans-serif"; g.fillText(`KnodeGames · week ${view + 1} · ${s.size} producers`, 64, 176);
    const champ = draft[draft.length - 1][0];
    g.fillStyle = acc; g.fillRect(64, 220, W1 - 128, 150);
    g.fillStyle = "#1b1206"; g.font = "700 34px system-ui, sans-serif"; g.fillText("🏆 Champion", 96, 280);
    g.font = "800 52px system-ui, sans-serif"; g.fillText(`${champ} · ${nameOf(s.seeds[champ - 1])}`, 96, 345);
    g.fillStyle = ink; let y = 450;
    const names = BM.ROUND_NAMES[s.size];
    for (let r = draft.length - 2; r >= 0 && y < H1 - 120; r--) {
      g.font = "700 32px system-ui, sans-serif"; g.fillText(`${names[r]} winners`, 64, y); y += 46;
      g.font = "400 28px system-ui, sans-serif";
      const items = draft[r].map((x) => `${x} ${nameOf(s.seeds[x - 1])}`);
      for (let i = 0; i < items.length && y < H1 - 120; i += 2) { g.fillText(items.slice(i, i + 2).join("     "), 84, y); y += 40; }
      y += 22;
    }
    g.font = "400 28px system-ui, sans-serif"; g.fillText("bawcejawn.github.io/Knode/site/bracket.html", 64, H1 - 60);
    c.toBlob(async (blob) => {
      if (!blob) return;
      const file = new File([blob], `knodegames-bracket-week${view + 1}.png`, { type: "image/png" });
      try { if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: "My Producer Bracket" }); return; } } catch { /* fall back to a download */ }
      const a = el("a", { href: URL.createObjectURL(blob), download: file.name });
      document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    }, "image/png");
  }

  // ── leaderboard (shared component) ──
  const lb = window.KBoard ? window.KBoard.create($("bk-board"), {
    label: "Bracket leaderboard", hide: ["today"],
    columns: [{ key: "pts", label: "Points" }, { key: "correct", label: "Right" }],
    scored: (r) => r.pts > 0,
    summary: (r) => `${fmt(r.pts)} pts · ${fmt(r.correct)} right${r.champion ? " · champion ✓" : ""}`,
    name: nameOf, link: (a) => EXPLORER + a,
    me: (r, place) => `${place ? `You: #${place} with` : "Your bracket:"} ${fmt(r.pts)} points (${fmt(r.correct)} right${r.champion ? ", champion right" : ""}).`,
  }) : null;
  function renderBoard() { if (lb && board) { $("board-box").hidden = false; lb.setMe(me() || ""); lb.set(board); } }

  // ── start ──
  $("bk-submit").addEventListener("click", review);
  $("bk-share").addEventListener("click", shareImage);
  $("bk-fill-chalk").addEventListener("click", () => autoFill("chalk"));
  $("bk-fill-form").addEventListener("click", () => autoFill("form"));
  $("bk-clear").addEventListener("click", () => { if (isOpen() && !sending) { startDraft(true); render(); } });
  if (W && W.subscribe) W.subscribe(() => { loadMine(); renderBoard(); });
  (async () => {
    say("Loading the bracket…");
    await Promise.all([loadWeeks(), loadForm(), setupPicks().catch(() => {})]);
    view = pickView(); round = currentRound(); say("");
    await loadMine(); renderBoard();
    setInterval(() => { if (!document.hidden) loadWeeks().then(() => { render(); renderBoard(); }); }, 300000);
    setInterval(() => { if (!document.hidden) render(); }, 60000);
  })();
})();

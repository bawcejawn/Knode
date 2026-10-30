/* Knode Games website — a static page: everything is read from the Koinos chain and the bot's public
   question files (game-data/), and every action is signed by the player's own wallet (Kondor or KOIN Vault).
   With no deployment yet (or ?demo in the address), it runs a preview on sample data. */
(() => {
  "use strict";

  const DAY = 28800;              // blocks per day
  const UNIT = 100000000n;        // 1 KOIN / 1 VHP = 10^8 units
  const FREE_PRIZE = 2n * UNIT;   // v5: the 2 best free players' prize, taken from each pot first (Kpred FREE_PRIZE)
  const RPC = "https://koinos.armana.io";
  // Block explorer links (change here if the explorer's address format differs).
  const EXPLORER_ADDRESS = "https://koinosscan.com/address/";
  const EXPLORER_PRODUCERS = "https://koinosscan.com/producers";
  const BASE = "./";
  const DATA = BASE + "game-data/";
  const ABI_URL = BASE + "game/abi/kpred.koilib.json";
  const lib = window.koilib || window.koinos || window; // koilib's browser build exposes Contract, Provider, ...

  const TOKEN_ABI = {
    methods: {
      balance_of: { entry_point: 0x5c721497, argument: "token.balance_of_arguments", return: "token.balance_of_result", read_only: true },
      approve: { entry_point: 0x74e21680, argument: "token.approve_arguments", return: "token.approve_result", read_only: false },
    },
    koilib_types: { nested: { token: { nested: {
      balance_of_arguments: { fields: { owner: { type: "bytes", id: 1, options: { "(koinos.btype)": "ADDRESS" } } } },
      balance_of_result: { fields: { value: { type: "uint64", id: 1, options: { jstype: "JS_STRING" } } } },
      approve_arguments: { fields: {
        owner: { type: "bytes", id: 1, options: { "(koinos.btype)": "ADDRESS" } },
        spender: { type: "bytes", id: 2, options: { "(koinos.btype)": "ADDRESS" } },
        value: { type: "uint64", id: 3, options: { jstype: "JS_STRING" } } } },
      approve_result: { fields: {} },
    } } } },
  };

  const S = {
    demo: false, dep: null, abi: null, provider: null, game: null,
    height: 0, chainTime: 0, seenAt: 0, st: null, week: 0, weekEnd: 0, questions: [], files: [],
    account: null, player: null, entry: null, balances: null, board: {}, boardWeek: null, claims: [],
  };

  // ═══════════════ params hash: is this question file exactly what was posted on chain? ═══════════════
  // params-hash:start (the same rule as paramsHashOf in resolver.ts; tests/audit/site.params-hash.test.mjs compares them)
  const AFTER_RELEASE = ["paramsHash", "result", "text", "title", "options", "chainId", "chainOutcome", "postSkipped", "vhpEnd", "vhpReadings", "vhpSeal", "corrections", "chainDataHash"];
  const WORDING = ["title", "text", "options"];
  async function paramsHashOf(q) {
    const withWording = Number(q.hashRule ?? 0) >= 2;
    const canonical = Object.create(null);   // so a "__proto__" member is a key like any other
    for (const [k, v] of Object.entries(q)) if (!AFTER_RELEASE.includes(k) || (withWording && WORDING.includes(k))) canonical[k] = v;
    const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(canonical)));
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  // params-hash:end

  // ═══════════════ small helpers ═══════════════
  const $ = (s) => document.querySelector(s);
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") n.className = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) n.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid.nodeType ? kid : String(kid));
    return n;
  };
  const big = (x) => { try { return BigInt(x ?? 0); } catch { return 0n; } };
  const num = (x) => Number(x ?? 0);
  const amount = (units, max = 2) => {
    const v = Number(big(units)) / 1e8;
    return v.toLocaleString("en-US", { maximumFractionDigits: v !== 0 && Math.abs(v) < 1 ? 4 : max });
  };
  const toUnits = (text) => {
    const m = String(text).trim().match(/^(\d+)(?:\.(\d{0,8}))?$/);
    if (!m) return null;
    return (BigInt(m[1]) * UNIT + BigInt((m[2] || "").padEnd(8, "0"))).toString();
  };
  /** Every decimal, nothing rounded (for "withdraw all"). */
  const exact = (units) => {
    const v = big(units), w = v / UNIT, f = (v % UNIT).toString().padStart(8, "0").replace(/0+$/, "");
    return f ? `${w}.${f}` : `${w}`;
  };
  const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
  /** Chain time now (ms): the last block's time plus however long ago we read it. */
  const nowMs = () => (S.chainTime ? S.chainTime + (Date.now() - S.seenAt) : Date.now());
  const BLOCK_MS = 3080; // typical time between Koinos blocks, for "result in about…" estimates only
  const duration = (ms) => {
    const s = Math.max(0, ms) / 1000;
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    if (d) return `${d}d ${h}h`;
    if (h) return `${h}h ${m}m`;
    return `${Math.max(m, s > 0 ? 1 : 0)}m`;
  };
  // ── plain-language questions: built from the question's own fields, so the card reads like a sentence ──
  const ADDR_RE = /1[1-9A-HJ-NP-Za-km-z]{25,34}/g;
  const fmtN = (n) => Number(n).toLocaleString();
  /** A producer as a small coloured chip; opens it in Producer lookup (blocks, share, what to expect). */
  const pchip = (a) => el("a", { class: "pchip", href: `node.html?a=${a}&w=28800`, target: "_blank", rel: "noopener", title: `${a}\nOpen in Producer lookup`, style: `--c: hsl(${hue(a)} 65% 52%)` },
    el("i", { "aria-hidden": "true" }), a === S.dep?.contract ? "Knode Games pool" : short(a));
  const chipify = (text) => {
    const out = []; let last = 0;
    for (const m of String(text).matchAll(ADDR_RE)) { out.push(text.slice(last, m.index)); out.push(pchip(m[0])); last = m.index + m[0].length; }
    out.push(text.slice(last)); return out;
  };
  function qKind(q) {
    const t = `${q.template || ""} ${q.title || ""}`;
    if (/^H2|Two head-to-heads/.test(t)) return "combo";
    if (/^E2|Head-to-head/.test(t)) return "h2h";
    if (/^M10|non-core/.test(t)) return "tail";
    if (/over\/under/.test(t)) return "ou";
    if (/quartiles|sextiles|eighths|^M1|^M9|^H1|^H3/.test(t)) return "range";
    return "network";
  }
  const KIND_LABEL = { h2h: "Head-to-head", ou: "Over / under", range: "How many blocks", tail: "Smaller producers together", network: "Network", combo: "Double head-to-head" };
  const qSubjects = (q) => (q.subjects && q.subjects.length ? q.subjects : (String(q.text).match(ADDR_RE) || []));
  const qLine = (q) => (q.thresholds && q.thresholds.length ? q.thresholds[0] : Number((String(q.text).match(/more than ([\d,]+)/) || [])[1]?.replace(/,/g, "")));
  /** The question as a short sentence, producers as chips. The full original wording stays in the tooltip. */
  function headline(q) {
    const kind = qKind(q), [A, B] = qSubjects(q), line = qLine(q);
    if (kind === "h2h" && A && B && Number.isFinite(line)) return ["Will ", pchip(A), " out-sign ", pchip(B), " by more than ", el("b", {}, fmtN(line)), " blocks?"];
    if (kind === "ou" && A && Number.isFinite(line)) return ["Will ", pchip(A), " sign more than ", el("b", {}, fmtN(line)), " blocks?"];
    if (kind === "range" && A) return ["How many blocks will ", pchip(A), " sign?"];
    if (kind === "tail" && q.group && q.group.length) return [`How many blocks will these ${q.group.length} smaller producers sign together?`];
    const plain = String(q.text).replace(/,? between block [\d,]+ and block [\d,]+/, "").replace(/ \(about [^)]*\)/, "").replace(/ \(Full list[^)]*\)/, "");
    return chipify(plain);
  }
  /** For "these N producers together" questions: every producer in the group, as chips. */
  const groupView = (q) => (q.group && q.group.length ? el("div", { class: "q-group" },
    el("span", { class: "q-group-h" }, `The ${q.group.length} producers counted together:`), ...q.group.map(pchip)) : null);
  /** "Counts blocks #a → #b · 10,000 blocks · about 8 h" */
  function windowFacts(q) {
    const n = q.windowEnd - q.windowStart + 1, hours = (n * BLOCK_MS) / 3.6e6;
    return [el("span", { class: "fact" }, `Blocks ${fmtN(q.windowStart)} → ${fmtN(q.windowEnd)}`),
      el("span", { class: "fact" }, `${fmtN(n)} blocks · about ${hours < 10 ? hours.toFixed(1) : Math.round(hours)} h`)];
  }
  /** What actually happened, in words. */
  function actualText(q) {
    if (!q.result || q.result.void) return null;
    const v = Number(String(q.result.value).replace(/,/g, "")), [A, B] = qSubjects(q), kind = qKind(q);
    if (!Number.isFinite(v)) return [`Actual: ${q.result.value}`];
    if (kind === "h2h" && A && B) return v >= 0 ? [pchip(A), ` signed ${fmtN(v)} more blocks than `, pchip(B), "."] : [pchip(B), " signed ", el("b", {}, fmtN(-v)), " more blocks than ", pchip(A), ` (a difference of ${fmtN(v)}).`];
    if ((kind === "ou" || kind === "range") && A) return [pchip(A), ` signed ${fmtN(v)} blocks.`];
    if (q.unit === "ms") return [`Actual: ${(v / 1000).toFixed(2)} seconds.`];
    if (q.unit === "permille") return [`Actual: ${(v / 10).toFixed(1)}% of blocks.`];
    return [`Actual: ${fmtN(v)}.`];
  }
  /** "No — 298 or less" → strong "No" + quieter detail. */
  const optLabel = (label) => { const [a, ...b] = String(label).split(" — "); return b.length ? [el("b", {}, a), el("span", { class: "opt-detail" }, b.join(" — "))] : [el("b", {}, label)]; };

  /** A UTC hour of the day shown in the viewer's own time zone, e.g. "8:00 AM". */
  const localHour = (utcHour) => { const d = new Date(); d.setUTCHours(utcHour, 0, 0, 0); return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); };
  /** A moment in the viewer's own time zone, short: "Mon 5:00 AM". */
  const dayTime = (ms) => new Date(ms).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
  const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const hue = (addr) => { let h = 0; for (const c of addr || "") h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
  let toastTimer = 0;
  const toast = (msg, ms = 4200) => {
    const t = $("#toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), ms);
  };
  const fetchJson = async (url) => { const r = await fetch(url, { cache: "no-store" }); if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.json(); };

  // ═══════════════ routing ═══════════════
  const SEEN_KEY = "kn-welcomed-v1";
  const seenWelcome = () => { try { return localStorage.getItem(SEEN_KEY) === "1"; } catch { return true; } };
  const markWelcomed = () => { try { localStorage.setItem(SEEN_KEY, "1"); } catch { /* private window: shown again next time */ } };
  function route() {
    // "#how/race" opens the Rules on the Race tab (also "#how/game", "#how/swap").
    const [view, sub] = (location.hash || "").slice(1).split("/");
    const known = ["play", "leaderboard", "results", "how", "welcome"];
    // Opening the site (or the installed app) with no particular page asked for always starts on the short welcome
    // ("New here?"): the owner's choice, so nobody lands in the game without knowing what it is. One tap to play.
    const v = known.includes(view) ? view : "welcome";
    if (v !== "welcome") markWelcomed();
    document.querySelectorAll(".view").forEach((s) => (s.hidden = s.dataset.view !== v));
    document.querySelectorAll(".tabs a, .tabbar a").forEach((a) => { if (a.dataset.view === v) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
    document.body && document.body.setAttribute && document.body.setAttribute("data-view", v);
    if (v === "leaderboard") renderBoard();
    if (v === "results") renderResults();
    if (v === "how") showRulesTab(sub);
    window.scrollTo({ top: 0 });
  }

  // ═══════════════ Rules: one tab per part of Knode Games (game, Producer Race, Swap) ═══════════════
  const RULE_TABS = ["game", "race", "swap"];
  function showRulesTab(name) {
    const t = RULE_TABS.includes(name) ? name : "game";
    document.querySelectorAll("[data-rules]").forEach((b) => { const on = b.dataset.rules === t; b.setAttribute("aria-selected", on ? "true" : "false"); b.tabIndex = on ? 0 : -1; });
    document.querySelectorAll("[data-rules-panel]").forEach((p) => (p.hidden = p.dataset.rulesPanel !== t));
  }
  document.querySelectorAll("[data-rules]").forEach((b) => b.addEventListener("click", () => {
    const want = `#how/${b.dataset.rules}`;
    if (location.hash !== want) history.replaceState(null, "", want);
    showRulesTab(b.dataset.rules);
  }));
  // A list of UTC start hours also gets one line in the visitor's own clock: " (in your time: 5:00 PM, 11:00 PM, …)".
  document.querySelectorAll("[data-utc-hours]").forEach((el) => {
    try {
      if (new Date().getTimezoneOffset() === 0) return;
      const n = new Date();
      const t = el.dataset.utcHours.split(",").map((h) => new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate(), Number(h), 0)).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }));
      el.textContent = ` (your time: ${t.join(", ")})`;
    } catch { /* keep the UTC text */ }
  });
  // Times written as "12:00 UTC" also show the visitor's own clock: "12:00 UTC (5:00 AM your time)".
  document.querySelectorAll("[data-utc-hour]").forEach((el) => {
    try {
      const n = new Date(), d = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate(), Number(el.dataset.utcHour), 0));
      const local = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      if (new Date().getTimezoneOffset() !== 0) el.textContent = `${String(el.dataset.utcHour).padStart(2, "0")}:00 UTC (${local} your time)`;
    } catch { /* keep the UTC text */ }
  });
  window.addEventListener("hashchange", route);

  // ═══════════════ reading the game ═══════════════
  /** The public node refuses bursts (a refused request comes back without CORS headers, so the browser reports a
   *  CORS error). Every chain read goes through one small queue: at most 4 at a time, and a refused one is retried a
   *  few times with a growing pause. */
  function gentle(provider) {
    const call = provider.call.bind(provider);
    let running = 0; const waiting = [];
    const next = () => { if (running < 4 && waiting.length) { running++; waiting.shift()(); } };
    provider.call = async (method, params) => {
      await new Promise((go) => { waiting.push(go); next(); });
      try {
        for (let attempt = 0; ; attempt++) {
          try { return await call(method, params); }
          catch (e) {
            const netFail = e instanceof TypeError || /fetch|network|load failed/i.test(String(e?.message ?? e));
            // never resend a transaction (a lost reply may hide one that went through)
            if (!netFail || attempt >= 4 || /submit|send/i.test(String(method))) throw e;
            await new Promise((r) => setTimeout(r, 700 * (attempt + 1) + Math.random() * 300));
          }
        }
      } finally { running--; next(); }
    };
    return provider;
  }

  async function read(method, args = {}) {
    const { result } = await S.game.functions[method](args);
    return result || {};
  }

  async function loadQuestions() {
    const idx = await fetchJson(DATA + "index.json").catch(() => ({ days: [] }));
    // Only plain question files from game-data/questions/ (index.json is a published file; never follow other paths).
    const days = (idx.days || []).filter((f) => typeof f === "string" && /^questions\/[A-Za-z0-9_-]+\.json$/.test(f));
    const files = await Promise.all(days.slice(-21).map((f) => fetchJson(DATA + f).then((d) => ({ f, d })).catch(() => null)));
    S.files = files.filter(Boolean);
    await checkFiles(S.files);
    numberQuestions(S.files);
    S.questions = S.files.flatMap(({ f, d }) => (d.questions || []).filter((q) => q.chainId !== undefined).map((q) => ({ ...q, chainId: Number(q.chainId), file: f })));
  }

  /** Each question file must hash to the params_hash posted on chain for its id, or the page will not offer it for
   *  answering: an edited or swapped file could show reversed option labels, or another question's id.
   *  q.hashOk: true (checked), false (does not match), null (could not be checked this time).
   *  q.chainSays: the outcome stored on chain (0 = not resolved, 1000 = void, n = option n − 1), after any owner
   *  correction; null when it could not be read. Results are shown from it, never from the file's own result. */
  const chainHashes = new Map(), chainOutcomes = new Map(), chainFacts = new Map();
  async function checkFiles(files) {
    const qs = files.flatMap(({ d }) => (d.questions || []).filter((q) => q.chainId !== undefined));
    // Nothing is added to a question before it is hashed (any extra key would change its hash).
    await Promise.all(qs.map(async (q) => {
      try {
        const id = Number(q.chainId);
        // Question ids are 32-bit on chain: a larger one would wrap to another question when answering (Info).
        if (!Number.isInteger(id) || id < 0 || id >= 2 ** 32) { q.hashOk = false; return; }
        // A question's outcome can still change until its week closes (owner corrections): re-read those of the last
        // nine days, and any not resolved yet.
        const recent = !S.height || num(q.windowEnd) > S.height - 9 * 28800;
        if (!chainHashes.has(id) || recent || !chainOutcomes.get(id)) {
          const onChain = (await read("get_question", { id })).question || {};
          const h = String(onChain.params_hash || "").replace(/^0x/, "").toLowerCase();
          if (!h) { q.hashOk = null; return; }
          chainHashes.set(id, h);
          chainOutcomes.set(id, num(onChain.outcome));
          // What the contract enforces must be what the file shows: answers close at the chain's lock time, and the
          // chain's window and number of options decide the result (audit W1-04).
          chainFacts.set(id, { lock: num(onChain.lock_time), ws: num(onChain.window_start), we: num(onChain.window_end), k: num(onChain.k) });
        }
        const f = chainFacts.get(id);
        const same = !f || (f.lock === num(q.lockTime) && f.ws === num(q.windowStart) && f.we === num(q.windowEnd) && f.k === (q.options || []).length);
        const ok = same && (await paramsHashOf(q)) === chainHashes.get(id);
        q.hashOk = ok;
        q.chainSays = chainOutcomes.get(id);
      } catch { q.hashOk = null; }
      if (q.chainSays === undefined) q.chainSays = null;
    }));
  }

  async function loadLive() {
    const [st, head] = await Promise.all([read("get_state"), S.provider.getHeadInfo()]);
    S.st = st;
    S.height = num(head.head_topology.height);
    S.chainTime = num(st.time) || Date.now();
    S.seenAt = Date.now();
    const c = st.config || {};
    const g = num(c.genesis_time), wl = num(c.week_length) || 604800000;
    S.week = S.chainTime <= g ? 0 : Math.floor((S.chainTime - g) / wl);
    S.weekEnd = g + (S.week + 1) * wl;
    S.genesis = g;
    S.closeDelay = num(c.close_delay) || 43200000;
    // Last week, until this week's pot starts on its own: its earnings keep counting until it closes (a bot run after
    // close_delay), then it holds a fixed pot until it is final (settle_end) and players collect.
    S.prev = null;
    if (S.week > 0 && S.chainTime > g) {
      const pw = S.week - 1, t = st.totals || {};
      const closed = num(t.weeks_closed) > pw, finalized = num(t.weeks_finalized) > pw;
      const W = closed ? ((await read("get_week", { week: String(pw) }).catch(() => ({}))).week || {}) : {};
      S.prev = { week: pw, closed, finalized, W };
    }
    await loadQuestions();
    if (S.account) await loadPlayer();
  }

  async function loadPlayer() {
    const a = S.account;
    const r = await read("get_player", { player: a, week: String(S.week) });
    S.player = r.player || {};
    S.activeStake = big(r.active_stake);
    S.entry = r.entry || null;
    const tok = (id) => new lib.Contract({ id, abi: TOKEN_ABI, provider: S.provider });
    const bal = async (id) => big(((await tok(id).functions.balance_of({ owner: a })).result || {}).value);
    S.balances = { vhp: await bal(S.dep.vhp), koin: await bal(S.dep.koin) };
    // rewards waiting in finished weeks
    // Every finished week (audit W1-02: not only the last six), a few at a time, newest first.
    const fin = num(S.st.totals?.weeks_finalized);
    const claims = [], history = [];
    const weeks = []; for (let w = fin - 1; w >= 0 && weeks.length < 104; w--) weeks.push(w);
    for (let i = 0; i < weeks.length; i += 6) {
      await Promise.all(weeks.slice(i, i + 6).map(async (w) => {
        const [p, wk] = await Promise.all([read("get_player", { player: a, week: String(w) }), read("get_week", { week: String(w) })]);
        const e = p.entry, W = wk.week || {};
        if (!e) return;
        // For "Your past weeks" on the Results page: what the contract recorded for this wallet.
        const h = { week: w, pts: num(e.points), counted: num(e.counted), staked: !!e.eligible, voided: !!e.voided, claimed: !!e.claimed, cutoff: num(W.cutoff), reward: 0n, free: false };
        history.push(h);
        // v5: a free player among the week's 2 best free scores collects the free prize (with their own Mana).
        // (the same conditions as Kpred.freePrizeOf: settled as a free player, not voided, at least 2 counted answers;
        // paid even in a week whose other pots rolled over)
        if (e.settled && !e.eligible && e.free_player && !e.voided && num(e.counted) >= 2) {
          const f = freePrize(W, num(e.points)); h.reward = f; h.free = f > 0n;
          if (f > 0n && !e.claimed) claims.push({ week: w, reward: f, free: true });
          return;
        }
        if (!e.eligible || W.rolled_over || num(e.points) < num(W.cutoff)) return;
        // The exact amount the contract pays, from the week's pots and the player's score group (audit W1-01).
        const r = exactReward(W, (wk.buckets || [])[num(e.points)], e);
        h.reward = r;
        if (!e.claimed) claims.push({ week: w, reward: r });
      }));
    }
    S.history = history.sort((x, y) => y.week - x.week);
    S.claims = claims.sort((x, y) => x.week - y.week);
  }

  /** v5: a free player's prize (Kpred.freePrizeOf): the best free score gets 1 VHP (all 2 if two or more share it), the
   *  second free score shares the other 1 VHP; nothing for anyone else. */
  function freePrize(W, pts) {
    const pot = big(W.pot_free), best = num(W.free_best), bn = num(W.free_best_n), second = num(W.free_second), sn = num(W.free_second_n);
    if (!W.reward_rule || pot === 0n || pts === 0) return 0n;
    if (pts === best) return bn >= 2 ? pot / BigInt(bn) : sn > 0 ? pot / 2n : pot;
    if (pts === second && bn === 1 && sn > 0) return (pot - pot / 2n) / BigInt(sn);
    return 0n;
  }

  /** The reward the contract's claim pays (Kpred.rewardOf), each step rounded down exactly as the contract's 128-bit
   *  muldiv does. v5 weeks (W.reward_rule): basket A by rank × stake up to 10 VHP; before: basket A by rank only.
   *  Basket B by rank × stake. */
  function exactReward(W, b, e) {
    if (!b || !(num(b.players) > 0) || !(big(W.sum_w) > 0n)) return 0n;
    const n = BigInt(num(b.players)), sw = big(b.sum_w);
    let r = 0n;
    if (W.reward_rule) {
      const aw = (big(W.aw_hi) << 64n) + big(W.aw_lo);
      if (aw > 0n) r = (big(W.pot_a) * ((sw * capA(big(e.stake))) / n)) / aw;
    } else r = (big(W.pot_a) * sw) / (n * big(W.sum_w));
    const bw = (big(W.bw_hi) << 64n) + big(W.bw_lo);
    if (bw > 0n) r += (big(W.pot_b) * ((sw * big(e.stake)) / n)) / bw;
    return r;
  }

  // ═══════════════ scoring (same rules as the contract) ═══════════════
  /** v4: from the week the contract records (config.scorer_rule_week_plus_one), winners are the top 30% of the
   *  eligible players WITH POINTS; before it, of all eligible players. */
  /** The minimum stake for a week (v4: a change applies from the week after it was made; 1 VHP until then). */
  const minStakeFor = (week) => { const c = (S.st && S.st.config) || {}; const next = big(c.min_stake_next || 0);
    return next > 0n && week >= num(c.min_stake_next_week) ? next : big(c.min_stake || UNIT); };
  const scorerRule = (week) => { const v = num((S.st && S.st.config || {}).scorer_rule_week_plus_one); return v > 0 && week + 1 >= v; };
  /** v5: from the week the contract records (config.reward_rule_week_plus_one), basket A is 40% of the pot by rank ×
   *  stake counted up to 10 VHP, and basket B the other 60% by rank × full stake. */
  const rewardRule = (week) => { const v = num((S.st && S.st.config || {}).reward_rule_week_plus_one); return v > 0 && week + 1 >= v; };
  const CAP_A = 10n * UNIT;
  const capA = (stake) => (stake < CAP_A ? stake : CAP_A);
  function score(rows, outcomes, week = S.week) {
    const scored = rows.map((r) => {
      let pts = 0, counted = 0;
      if (!r.voided) for (const a of r.answers || []) {
        const o = outcomes.get(num(a.question_id));
        if (!o || o === 1000) continue;
        counted++;
        if (o === num(a.option) + 1) pts++;
      }
      return { ...r, pts, counted, eligible: !r.voided && counted > 1 && r.stake > 0n && r.stake >= minStakeFor(week) };
    }).sort((x, y) => y.pts - x.pts || (y.stake > x.stake ? 1 : y.stake < x.stake ? -1 : 0));
    const elig = scored.filter((s) => s.eligible);
    const total = elig.reduce((s, x) => s + x.stake, 0n);
    // Winners: the top 30% of staked, eligible players by points (headcount), ties included; 0 points never wins
    // (and, from v4, does not count toward the 30%).
    const need = Math.ceil(((scorerRule(week) ? elig.filter((s) => s.pts > 0).length : elig.length) * 30) / 100);
    let cutoff = 0, cum = 0;
    const maxP = Math.max(0, ...elig.map((s) => s.pts));
    if (need > 0) for (let p = maxP; p >= 1; p--) { cum += elig.filter((s) => s.pts === p).length; cutoff = p; if (cum >= need) break; }
    // Rank weights 1/√rank; players tied share their places' weights evenly.
    const groups = new Map();
    let rank = 1n, sumW = 0n, bw = 0n, aw = 0n;
    if (cutoff >= 1) for (let p = maxP; p >= cutoff; p--) {
      const members = elig.filter((s) => s.pts === p);
      if (!members.length) continue;
      let gw = 0n;
      for (let i = 0; i < members.length; i++) { gw += rankWeight(rank); rank++; }
      const stake = members.reduce((a, x) => a + x.stake, 0n);
      const capped = members.reduce((a, x) => a + capA(x.stake), 0n);
      groups.set(p, { n: BigInt(members.length), sumW: gw });
      sumW += gw;
      bw += (gw * stake) / BigInt(members.length);
      aw += (gw * capped) / BigInt(members.length);
    }
    for (const s of scored) {
      s.winner = s.eligible && cutoff >= 1 && s.pts >= cutoff;
      s.group = s.winner ? groups.get(s.pts) : null;
    }
    return { scored, cutoff, total, sumW, bw, aw };
  }

  /** Fill in each winner's reward for pots A and B (exactly the contract's arithmetic, rounded down). `v5`: basket A
   *  by rank × stake up to 10 VHP; otherwise by rank only. */
  function applyPots(board, potA, potB, v5) {
    for (const s of board.scored) {
      if (!s.winner || !s.group) { s.reward = undefined; continue; }
      const g = s.group;
      let r = 0n;
      if (v5) { if (board.aw > 0n) r = (potA * ((g.sumW * capA(s.stake)) / g.n)) / board.aw; }
      else r = board.sumW > 0n ? (potA * g.sumW) / (g.n * board.sumW) : 0n;
      if (board.bw > 0n) r += (potB * ((g.sumW * s.stake) / g.n)) / board.bw;
      s.reward = r;
    }
  }

  /** This week's pots if it closed now: 5% fee off new earnings; v5: up to 2 VHP for the 2 best free players first,
   *  then 40% / 60%; before: 65% of the house's part by rank, the rest by rank × stake. An estimate (gains can still
   *  change before the week closes). */
  function livePots() {
    // Until last week closes, everything earned so far is still last week's: this week has nothing yet.
    if (S.prev && !S.prev.closed) return { potA: 0n, potB: 0n };
    const t = S.st?.totals || {};
    const holdings = big(S.st?.vhp_balance) + big(S.st?.koin_balance);
    const owed = ["total_stake", "seed_vhp", "seed_koin", "owner_share", "creator_fee", "pots_outstanding"].reduce((a, k) => a + big(t[k]), 0n);
    const gain = holdings > owed ? holdings - owed : 0n;
    const carried = big(t.rolled_over) < gain ? big(t.rolled_over) : gain;
    const fresh = gain - carried, net = fresh - (fresh * 500n) / 10000n;
    const house = big(t.seed_vhp) + big(t.pots_outstanding) + big(t.rolled_over), all = house + big(t.total_stake);
    const houseNet = (all > 0n ? (net * house) / all : net) + carried;
    if (rewardRule(S.week)) {
      // Kpred.closeInternal: the free players' prize (up to 2 VHP) comes off first.
      const pot = net + carried, free = pot < FREE_PRIZE ? pot : FREE_PRIZE;
      const potA = ((pot - free) * 4000n) / 10000n;
      return { potA, potB: pot - free - potA };
    }
    const potA = (houseNet * 6500n) / 10000n;
    return { potA, potB: net + carried - potA };
  }

  const FREE_SHOW = 6;   // the Free play board lists only its top 6 (owner, 2026-10-28)
  const W_SCALE = 10n ** 18n;
  function isqrt(n) { if (n < 2n) return n; let x = n, y = n / 2n + 1n; while (y < x) { x = y; y = (x + n / x) / 2n; } return x; }
  const rankWeight = (r) => isqrt(W_SCALE / BigInt(r));

  async function loadBoard(week) {
    if (S.demo) return demoBoard(week);
    const rows = [];
    let start = "";
    for (let i = 0; i < 40; i++) {
      const page = (await read("list_players", { start, limit: 50, week: String(week) })).rows || [];
      for (const r of page) if (r.entry) rows.push({ address: r.address, stake: big(r.entry.stake), answers: r.entry.answers || [], voided: !!r.entry.voided });
      if (page.length < 50) break;
      start = page[page.length - 1].address;
    }
    const ids = new Set(rows.flatMap((r) => r.answers.map((a) => num(a.question_id))));
    const outcomes = new Map();
    await Promise.all([...ids].map(async (id) => outcomes.set(id, num(((await read("get_question", { id })).question || {}).outcome))));
    const res = score(rows, outcomes, week);
    if (week < num(S.st.totals?.weeks_finalized)) {
      res.final = (await read("get_week", { week: String(week) })).week || {};
      applyPots(res, big(res.final.pot_a), big(res.final.pot_b), !!res.final.reward_rule);
    } else if (week === S.week) {
      const lp = livePots(); applyPots(res, lp.potA, lp.potB, rewardRule(week)); res.estimate = true;
    }
    return res;
  }

  // ═══════════════ wallet (Kondor on a computer, KOIN Vault on a phone, or a guest: see wallet.js, guest.js) ═══════════════
  const isGuest = () => !S.demo && !!window.KWallet && window.KWallet.kind === "guest";
  const youLabel = () => (isGuest() ? "You (guest)" : "You");
  async function afterConnect() {
    toast(`Connected ${short(S.account)} with ${window.KWallet.label()}`);
    await loadPlayer().catch(() => {});
    S.board = {};
    renderAll();
    renderBoard(S.week).then(renderPlay).catch(() => {});
  }

  async function connect() {
    if (S.demo) {
      S.account = "1DemoP1ayerXXXXXXXXXXXXXXXXXXXXXX";
      demoPlayer();
      renderAll();
      renderBoard(S.week).then(renderPlay);
      toast("Demo wallet connected");
      return;
    }
    if (!window.KWallet) return toast("The wallet code didn't load. Refresh the page and try again.");
    await window.KWallet.connect(); // onChange (in start) picks up the address
  }

  function writer() {
    return new lib.Contract({ id: S.dep.contract, abi: S.abi, provider: S.provider });
  }

  /** Send one or more operations in one transaction, signed in the player's wallet. */
  async function send(label, build, opts = {}) {
    if (S.demo) { toast(`Demo: this would ask your wallet to confirm “${label}”.`); return false; }
    if (!S.account) { await connect(); if (!S.account) return false; }
    try {
      const ops = await build();
      const ownMana = !opts.ownMana ? "" : window.KWallet.kind === "vault"
        ? " This one must use your own Mana: the page can't check who KOIN Vault charges, so in KOIN Vault make sure your wallet pays (not the game)."
        : " This one uses your own Mana: leave Kondor's free Mana option off.";
      toast(window.KWallet.kind === "guest" ? `Sending “${label}” from your guest wallet (free)…` : `Confirm “${label}” in ${window.KWallet.label()}…${ownMana}`, 20000);
      const id = await window.KWallet.send(label, ops, opts);
      toast(id ? `Done: ${label}` : `Sent: ${label}. It may take a minute to show; the page refreshes by itself.`, 8000);
      await loadLive().catch(() => {});
      renderAll();
      return true;
    } catch (e) {
      const msg = String(e.message || e);
      toast(/reject|denied|cancel/i.test(msg) ? `Cancelled in ${window.KWallet.label()}.` : `Not sent: ${friendlyError(msg)}`, 9000);
      return false;
    }
  }
  const opOf = async (contract, fn, args) => (await contract.functions[fn](args, { onlyOperation: true })).operation;

  function friendlyError(msg) {
    const m = msg.match(/"([^"]{6,140})"/);
    const text = m ? m[1] : msg;
    if (/insufficient\s*(rc|mana|resources?)|\bmana\b|\brc[_ ]?limit\b|out of rc/i.test(text)) return `not enough Mana. Today's free Mana may be used up, so this one needs your own: hold a little KOIN in your wallet (its Mana refills by itself), or try again after 00:00 UTC. (${text.slice(0, 90)})`;
    return text.slice(0, 160);
  }

  // Every player action, answers included, asks the Mana sponsor first (site/wallet.js); when its caps are used up the
  // player's own Mana pays. The game contract no longer pays for anyone (owner, 2026-10-28): its Mana is kept for
  // burning block rewards back into VHP.
  const answer = (q, option) => send(`answer ${String.fromCharCode(65 + option)}`, async () => [
    await opOf(writer(), "answer", { player: S.account, question_id: q.chainId, option }),
  ]);

  const claim = (week) => send(`collect week ${week + 1} reward`, async () => [
    await opOf(writer(), "claim", { player: S.account, week: String(week) }),
  ], { ownMana: (S.claims.find((c) => c.week === week) || {}).free || claimNeedsOwnMana(S.claims.find((c) => c.week === week)) });

  // claim-mana:start
  /** Should this claim be paid with the player's own Mana instead of the contract's? The contract agrees to pay for a
   *  claim when the VHP it is short can be burned back from spare KOIN within its Mana left after the transaction's own
   *  limit, but the claim itself may burn up to all of its Mana. So while the pool is short of VHP and its spare KOIN is
   *  more than its Mana minus the largest limit it pays (max_sponsor_rc), a contract-paid claim could run out of Mana
   *  and fail at the pool's cost: the player pays instead. An unknown reward counts as short. */
  function claimNeedsOwnMana(c, st = S.st) {
    if (!st) return true;
    const t = st.totals || {}, cfg = st.config || {};
    const koin = big(st.koin_balance), keep = big(t.seed_koin) + big(t.creator_fee);
    const spare = koin > keep ? koin - keep : 0n;
    const short = !c || !(big(c.reward) > 0n) || big(st.vhp_balance) < big(c.reward);
    return short && spare > 0n && spare + big(cfg.max_sponsor_rc) > big(st.mana);
  }
  // claim-mana:end

  // ═══════════════ ads (site/ads.json) ═══════════════
  // Ads never get access to this page: network ads run in a sandboxed frame (no access to the page, the wallet or
  // cookies), and sponsor ads are a plain image and link. Only https links are accepted.
  let ADS = {};
  const httpsUrl = (u) => { try { const x = new URL(String(u), location.href); return x.protocol === "https:" || x.origin === location.origin ? x.href : null; } catch { return null; } };
  function fillAd(slot) {
    const a = ADS[slot.dataset.adSlot];
    if (!a || typeof a !== "object") return;
    const label = el("small", { class: "ad-label" }, "Sponsored");
    if (a.type === "sponsor") {
      const link = httpsUrl(a.link), img = httpsUrl(a.image);
      if (!link || !img) return;
      slot.replaceChildren(el("a", { href: link, target: "_blank", rel: "sponsored noopener noreferrer", class: "ad-link" },
        el("img", { src: img, alt: String(a.alt || "Sponsor"), loading: "lazy" })), label);
      slot.classList.add("ad-filled");
    } else if (a.type === "iframe") {
      const src = httpsUrl(a.src);
      if (!src) return;
      const f = el("iframe", { src, title: "Advertisement", loading: "lazy", referrerpolicy: "no-referrer", scrolling: "no",
        sandbox: "allow-scripts allow-popups allow-popups-to-escape-sandbox" });
      f.width = String(Number(a.width) || 300); f.height = String(Number(a.height) || 250);
      slot.replaceChildren(f, label);
      slot.classList.add("ad-filled");
    }
  }
  // Koinos projects fill any slot nobody has bought, in a fresh random order on every page load.
  function houseAd(slot, h) {
    const link = httpsUrl(h.link);
    if (!link) return;
    const hueOf = (t) => { let x = 0; for (const c of t) x = (x * 31 + c.charCodeAt(0)) % 360; return x; };
    slot.replaceChildren(el("a", { href: link, target: "_blank", rel: "noopener", class: "house", style: `--h: ${hueOf(h.name)}` },
      el("span", { class: "house-mark", "aria-hidden": "true" }, h.name.slice(0, 1)),
      el("span", { class: "house-text" }, el("b", {}, h.name), el("span", {}, h.tagline)),
      el("span", { class: "house-cta" }, `${h.cta || "Visit"} →`)), el("small", { class: "ad-label" }, "Koinos ecosystem"));
    slot.classList.add("ad-filled", "ad-house");
  }
  function shuffle(list) { const a = list.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
  let houseQueue = [];
  function nextHouse() { if (!houseQueue.length) houseQueue = shuffle((ADS.ecosystem || []).filter((h) => h && h.name && h.link)); return houseQueue.shift(); }
  // An unsold slot stays empty and takes no space (CSS hides it); it appears only when ads.json has an entry for it.
  // Set "emptySlots": "ecosystem" in ads.json to show a Koinos project in unsold slots instead.
  function fillSlot(slot) {
    fillAd(slot);
    if (slot.classList.contains("ad-filled")) return;
    if (ADS.emptySlots === "ecosystem") { const h = nextHouse(); if (h) houseAd(slot, h); }
  }
  async function loadAds() {
    try { const r = await fetch("ads.json", { cache: "no-cache" }); if (r.ok) ADS = await r.json(); } catch { ADS = {}; }
    document.querySelectorAll("[data-ad-slot]").forEach(fillSlot);
    // fixed spot: run your own node
    const f = ADS.featured, kit = $("#kit-card"), fl = f && httpsUrl(f.link);
    if (fl) {
      kit.href = fl;
      kit.replaceChildren(el("span", { class: "kit-kicker" }, "Run your own node"), el("b", {}, f.name), el("span", { class: "muted" }, f.tagline), el("span", { class: "kit-cta" }, `${f.cta || "Visit"} →`));
      kit.hidden = false;
    }
    // footer: every project
    const eco = (ADS.ecosystem || []).filter((h) => h && h.name && httpsUrl(h.link));
    if (eco.length) {
      $("#eco-grid").replaceChildren(...eco.map((h) => el("a", { href: httpsUrl(h.link), target: "_blank", rel: "noopener", class: "eco-item" }, el("b", {}, h.name), el("span", {}, h.tagline))));
      document.querySelector(".eco").hidden = false;
    }
  }

  // ═══════════════ stake dialog ═══════════════
  function openStake(mode) {
    if (isGuest()) return window.KWallet.guestInfo();   // a guest only answers: explain how to stake instead
    const d = $("#stake-dialog");
    $("#stake-title").textContent = mode === "deposit" ? "Stake" : "Withdraw";
    $("#stake-token").hidden = mode !== "deposit";
    $("#stake-amount").value = "";
    $("#stake-amount").inputMode = mode === "deposit" ? "numeric" : "decimal";
    $("#stake-amount").placeholder = mode === "deposit" ? "e.g. 25" : "e.g. 2.5";
    $("#stake-max").hidden = mode === "deposit";
    const warn = $("#stake-warn");
    if (mode === "deposit") {
      const b = S.balances || {};
      $("#stake-help").textContent = `Counts from next week. You have ${amount(b.vhp)} VHP and ${amount(b.koin)} KOIN. KOIN is burned into VHP 1:1 (needs Mana at least equal to the amount).`;
      warn.hidden = true;
    } else {
      const total = big(S.player?.stake) + big(S.player?.pending);
      $("#stake-help").textContent = `You can withdraw any amount up to ${exact(total)} VHP, decimals included. It goes straight back to your wallet.`;
      warn.textContent = "Withdrawing part keeps you in this week with a lower stake. Withdrawing everything takes you out of this week.";
      warn.hidden = !S.entry;
    }
    d.dataset.mode = mode;
    d.showModal();
    $("#stake-amount").focus();
  }

  $("#stake-max").addEventListener("click", () => {
    $("#stake-amount").value = exact(big(S.player?.stake) + big(S.player?.pending));
  });

  $("#stake-dialog").addEventListener("close", async () => {
    const d = $("#stake-dialog");
    if (d.returnValue !== "go") return;
    const raw = $("#stake-amount").value.trim();
    const isDeposit = d.dataset.mode === "deposit";
    if (isDeposit && !/^[1-9]\d*$/.test(raw)) return toast("Stakes are whole numbers only, for example 1 or 25.");
    const units = toUnits(raw);
    // Never more than a 64-bit amount (the wallet's encoder would wrap it) or than the wallet holds (audit I-5).
    if (units && big(units) > 18446744073709551615n) return toast("That amount is too large.");
    if (isDeposit && units && S.balances) {
      const tokNow = document.querySelector('input[name="tok"]:checked').value;
      const have = tokNow === "VHP" ? big(S.balances.vhp) : big(S.balances.koin);
      if (big(units) > have) return toast(`That is more than your wallet holds (${amount(have)} ${tokNow}).`);
    }
    if (!isDeposit) {
      if (!units || big(units) <= 0n) return toast("Enter an amount, for example 2.5 (up to 8 decimals).");
      if (big(units) > big(S.player?.stake) + big(S.player?.pending)) return toast("That is more than you have staked.");
    }
    if (d.dataset.mode === "deposit") {
      const tok = document.querySelector('input[name="tok"]:checked').value;
      if (big(units) < UNIT && big(S.player?.stake) + big(S.player?.pending) < UNIT) toast("Note: you need at least 1 VHP staked to answer.", 6000);
      await send(`stake ${amount(units)} ${tok}`, async () => {
        const token = new lib.Contract({ id: tok === "VHP" ? S.dep.vhp : S.dep.koin, abi: TOKEN_ABI, provider: S.provider });
        return [
          await opOf(token, "approve", { owner: S.account, spender: S.dep.contract, value: units }),
          await opOf(writer(), tok === "VHP" ? "deposit_vhp" : "deposit_koin", { from: S.account, amount: units }),
        ];
      });
    } else {
      await send(`withdraw ${exact(units)} VHP`, async () => [await opOf(writer(), "withdraw", { to: S.account, amount: units })]);
    }
  });

  // ═══════════════ rendering ═══════════════
  function myAnswer(q) {
    const a = (S.entry?.answers || []).find((x) => num(x.question_id) === Number(q.chainId));
    return a ? num(a.option) : null;
  }
  /** The outcome stored on chain (the demo has no chain: it uses its sample results). */
  const outcomeOf = (q) => (S.demo ? (q.chainOutcome !== undefined ? q.chainOutcome : q.result ? (q.result.void ? 1000 : q.result.option + 1) : 0) : num(q.chainSays));
  /** Questions released before their wording was hashed (hashRule 2): the page can't confirm their options. */
  const wordingHashedRule = (q) => Number(q.hashRule ?? 0) >= 2;
  /** Older questions (before hashRule 2): their thresholds, unit and template ARE in the on-chain hash, only the label
   *  text is not. For whole-number questions the labels follow from the thresholds exactly, so the page rebuilds them
   *  and accepts the question only when every label and range is exactly what the thresholds give. */
  function legacyLabelsOk(q) {
    const t = q.thresholds, o = q.options;
    if (q.unit !== "count" || !Array.isArray(t) || !Array.isArray(o) || o.length !== t.length + 1) return false;
    if (!t.every((x) => Number.isInteger(x))) return false;
    const f = (v) => v.toLocaleString("en-US", { maximumFractionDigits: 0 });
    const yesNo = t.length === 1 && /^No — /.test(String(o[0]?.label)) && /^Yes — /.test(String(o[1]?.label));
    const want = [];
    for (let j = 0; j <= t.length; j++) {
      const lo = j === 0 ? null : t[j - 1] + 1, hi = j === t.length ? null : t[j];
      const labels = yesNo
        ? (j === 0 ? [`No — ${f(hi)} or fewer`, `No — ${f(hi)} or less`] : [`Yes — ${f(lo)} or more`])
        : [lo === null ? `${f(hi)} or fewer` : hi === null ? `${f(lo)} or more` : lo === hi ? f(lo) : `${f(lo)} to ${f(hi)}`];
      want.push({ lo, hi, labels });
    }
    return o.every((x, j) => x && x.index === j && (x.min ?? null) === want[j].lo && (x.max ?? null) === want[j].hi && want[j].labels.includes(x.label));
  }
  const wordingHashed = (q) => wordingHashedRule(q) || legacyLabelsOk(q);

  /** Questions are numbered within their week: Q1 is the week's first question (lowest on-chain id), up to Q30.
   *  Submits still send q.chainId; the raw on-chain id is only shown in "How it was decided". */
  const QNO = new Map();
  function numberQuestions(files) {
    const byWeek = new Map();
    for (const { d } of files) for (const q of d.questions || []) {
      if (q.chainId === undefined) continue;
      const w = num(q.week ?? d.week);
      if (!byWeek.has(w)) byWeek.set(w, new Set());
      byWeek.get(w).add(Number(q.chainId));
    }
    QNO.clear();
    for (const [w, ids] of byWeek) [...ids].sort((a, b) => a - b).forEach((id, i) => QNO.set(id, { week: w, n: i + 1 }));
  }
  const displayQuestionNumber = (q) => QNO.get(Number(q.chainId))?.n ?? Number(q.chainId) + 1;
  const qTag = (q) => `Q${displayQuestionNumber(q)}`;
  /** "Week 2 · Monday · Q1" */
  const qWhere = (q, withQ = true) => {
    const w = QNO.get(Number(q.chainId))?.week ?? num(q.week);
    const d = num(q.day);
    return `Week ${w + 1}${d >= 1 && d <= 6 ? ` · ${DAY_NAMES[d]}` : ""}${withQ ? ` · ${qTag(q)}` : ""}`;
  };

  // ═══════════════ live race: count blocks for questions whose answers are closed ═══════════════
  // The page reads the window's blocks itself (who signed each, its time and transaction count), keeps them in this
  // browser, and tops up only the new ones every minute. Answers are locked by then, so showing the race is fair.
  const LV = { from: 0, sig: [], ts: [], ntx: [], signers: [], idx: new Map(), busy: false, top: 0 };
  const LV_KEY = "kn-live-v1";
  try {
    const r = JSON.parse(localStorage.getItem(LV_KEY) || "null");
    if (r && r.sig && r.sig.length === r.ts.length && r.sig.length === r.ntx.length) {
      Object.assign(LV, { from: r.from, sig: r.sig, ts: r.ts, ntx: r.ntx, signers: r.signers });
      LV.signers.forEach((a, i) => LV.idx.set(a, i)); LV.top = LV.from + LV.sig.length - 1;
    }
  } catch { /* start fresh */ }
  const lvSigner = (a) => { let i = LV.idx.get(a); if (i === undefined) { i = LV.signers.length; LV.signers.push(a); LV.idx.set(a, i); } return i; };
  async function lvRead(a, b, headId) {
    const n = b - a + 1, out = { signer: new Array(n), ts: new Array(n), ntx: new Array(n) };
    const queue = []; for (let e = b; e >= a; e -= 200) queue.push([Math.max(a, e - 199), e]);
    const worker = async () => {
      while (queue.length) {
        const [x, y] = queue.shift();
        let res = null;
        for (let t = 0; ; t++) {
          try { res = await S.provider.call("block_store.get_blocks_by_height", { head_block_id: headId, ancestor_start_height: String(x), num_blocks: y - x + 1, return_block: true, return_receipt: false }); break; }
          catch (err) { if (y - x >= 50) { const m = (x + y) >> 1; queue.push([x, m], [m + 1, y]); break; } if (t >= 3) throw err; await new Promise((r) => setTimeout(r, 800 * (t + 1))); }
        }
        if (!res) continue;
        let got = 0;
        for (const it of res.block_items || []) {
          const i = num(it.block_height) - a;
          if (i < 0 || i >= n || out.signer[i] !== undefined) continue;
          out.signer[i] = it.block.header.signer; out.ts[i] = num(it.block.header.timestamp); out.ntx[i] = (it.block.transactions || []).length; got++;
        }
        if (!got) throw new Error("no blocks returned");
        let k = x; while (k <= y && out.signer[k - a] !== undefined) k++;
        if (k <= y) queue.push([k, y]);
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    return out;
  }
  /** Make sure the store covers every running window, up to the newest block. */
  async function updateLive() {
    if (S.demo || !S.provider || LV.busy) return;
    const running = S.questions.filter((q) => nowMs() >= q.lockTime && !(q.result && S.height > q.windowEnd) && q.windowStart);
    if (!running.length) return;
    LV.busy = true;
    try {
      const head = await S.provider.getHeadInfo();
      const top = Math.min(num(head.head_topology.height), Math.max(...running.map((q) => q.windowEnd)));
      const need = Math.min(...running.map((q) => q.windowStart));
      if (top < need) return;
      const drop = (k) => { LV.sig.splice(0, k); LV.ts.splice(0, k); LV.ntx.splice(0, k); LV.from += k; };
      if (!LV.sig.length || LV.top < need - 1 || LV.from > top) { Object.assign(LV, { from: need, sig: [], ts: [], ntx: [], signers: [], top: need - 1 }); LV.idx.clear(); }
      if (LV.from < need) drop(Math.min(LV.sig.length, need - LV.from));
      // the newest ~60 blocks can still change: re-read them
      const keep = Math.max(0, Math.min(LV.sig.length, LV.top - 60 - LV.from + 1));
      LV.sig.length = keep; LV.ts.length = keep; LV.ntx.length = keep; LV.top = LV.from + keep - 1;
      if (!LV.sig.length) LV.from = need, LV.top = need - 1;
      if (LV.top < top) {
        const r = await lvRead(LV.top + 1, top, head.head_topology.id);
        for (let i = 0; i < r.signer.length; i++) { LV.sig.push(lvSigner(r.signer[i])); LV.ts.push(r.ts[i]); LV.ntx.push(r.ntx[i]); }
        LV.top = top;
      }
      try { localStorage.setItem(LV_KEY, JSON.stringify({ from: LV.from, sig: LV.sig, ts: LV.ts, ntx: LV.ntx, signers: LV.signers })); } catch { /* storage full: still works */ }
    } catch { /* try again next minute */ } finally { LV.busy = false; }
  }

  /** Each option's range. Uses the stored min/max, or reads it from the label ("654 to 684", "745 or more"). */
  function optBounds(q) {
    return q.options.map((o) => {
      if (o.min !== undefined || o.max !== undefined) return { min: o.min ?? null, max: o.max ?? null };
      const t = String(o.label).replace(/,/g, ""), n = (t.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
      if (/or (fewer|less)/.test(t)) return { min: null, max: n[n.length - 1] };
      if (/or more/.test(t)) return { min: n[n.length - 1], max: null };
      return n.length >= 2 ? { min: n[n.length - 2], max: n[n.length - 1] } : { min: null, max: null };
    });
  }
  const qThresholds = (q) => (q.thresholds && q.thresholds.length ? q.thresholds : optBounds(q).slice(0, -1).map((b) => b.max).filter((x) => x != null));

  /** Where a question stands right now: counts so far, the pace, and the option the pace points to. */
  function liveOf(q) {
    if (!q.windowStart || LV.top < q.windowStart || LV.from > q.windowStart) return null;
    const end = Math.min(q.windowEnd, LV.top), done = end - q.windowStart + 1, total = q.windowEnd - q.windowStart + 1, frac = done / total;
    const i0 = q.windowStart - LV.from, i1 = end - LV.from;
    const countOf = (a) => { const k = LV.idx.get(a); if (k === undefined) return 0; let c = 0; for (let i = i0; i <= i1; i++) if (LV.sig[i] === k) c++; return c; };
    const bd = optBounds(q);
    const pick = (v) => { const i = bd.findIndex((o) => (o.min == null || v >= o.min) && (o.max == null || v <= o.max)); return i >= 0 ? q.options[i].index : null; };
    const kind = qKind(q), subs = qSubjects(q), th = qThresholds(q);
    const L = { done, total, frac, kind };
    if (kind === "h2h" || kind === "combo") {
      L.lines = [];
      for (let j = 0; j + 1 < subs.length; j += 2) {
        const a = countOf(subs[j]), b = countOf(subs[j + 1]), d = a - b;
        L.lines.push({ A: subs[j], B: subs[j + 1], a, b, d, pa: a / frac, pb: b / frac, pd: d / frac, line: th[j / 2] });
      }
      L.pointsTo = kind === "h2h" ? pick(Math.round(L.lines[0].pd)) : (L.lines.length === 2 ? (L.lines[0].pd > L.lines[0].line ? 2 : 0) + (L.lines[1].pd > L.lines[1].line ? 1 : 0) : null);
    } else if (kind === "ou" || kind === "range" || kind === "tail") {
      const who = kind === "tail" ? (q.group || []) : subs.slice(0, 1);
      const v = who.reduce((s, a) => s + countOf(a), 0);
      Object.assign(L, { who, v, proj: v / frac, pointsTo: pick(Math.round(v / frac)) });
    } else {
      const t = String(q.text);
      let v = NaN, proj = NaN, show = (x) => fmtN(Math.round(x));
      if (/longest gap/i.test(t)) { let g = 0; for (let i = i0 + 1; i <= i1; i++) g = Math.max(g, LV.ts[i] - LV.ts[i - 1]); v = g; proj = g; show = (x) => `${(x / 1000).toFixed(1)} s`; L.what = "Longest gap so far"; }
      else if (/average time/i.test(t)) { v = done > 1 ? (LV.ts[i1] - LV.ts[i0]) / (done - 1) : NaN; proj = v; show = (x) => `${(x / 1000).toFixed(2)} s`; L.what = "Average so far"; }
      else if (/no transactions/i.test(t)) { let e = 0; for (let i = i0; i <= i1; i++) if (LV.ntx[i] === 0) e++; v = (1000 * e) / done; proj = v; show = (x) => `${(x / 10).toFixed(1)}%`; L.what = "Empty blocks so far"; }
      else if (/transactions/i.test(t)) { let c = 0; for (let i = i0; i <= i1; i++) c += LV.ntx[i]; v = c; proj = c / frac; L.what = "Transactions so far"; }
      Object.assign(L, { v, proj, show, pointsTo: Number.isFinite(proj) ? pick(Math.round(proj)) : null });
    }
    return L;
  }

  /** The race, drawn: a progress bar for the window, then a lane per producer (or a gauge for the network). */
  function raceView(q, compact = false) {
    const L = liveOf(q);
    if (!L) return S.demo ? null : el("div", { class: "race race-wait" }, el("span", { class: "muted" }, "Live count loading…"));
    const pct = Math.min(100, (L.frac * 100));
    const head = el("div", { class: "race-head" },
      el("span", { class: "live-dot", "aria-hidden": "true" }), el("b", {}, L.frac >= 1 ? "All blocks counted" : "Live"),
      el("span", { class: "muted" }, `${fmtN(L.done)} of ${fmtN(L.total)} blocks · ${pct.toFixed(0)}%`),
      L.pointsTo != null && L.frac < 1 ? el("span", { class: "race-points" }, `On pace for ${String.fromCharCode(65 + L.pointsTo)}`) : null);
    const bar = el("div", { class: "race-track", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(Math.round(pct)) }, el("i", { style: `width:${pct}%` }));
    if (compact) return el("div", { class: "race race-compact" }, head, bar);
    const lane = (who, v, proj, scale, marker, addr) => el("div", { class: "lane" },
      el("div", { class: "lane-label" }, who),
      el("div", { class: "lane-track" },
        el("span", { class: "lane-proj", style: `width:${Math.min(100, (proj / scale) * 100)}%` }),
        el("span", { class: "lane-now", style: `width:${Math.min(100, (v / scale) * 100)}%${addr ? `;background:hsl(${hue(addr)} 62% 52%)` : ""}` }),
        marker != null ? el("span", { class: "lane-mark", style: `left:${Math.min(100, (marker / scale) * 100)}%`, title: `line ${fmtN(marker)}` }) : null),
      el("div", { class: "lane-num" }, el("b", {}, fmtN(v)), el("span", {}, `→ ${fmtN(Math.round(proj))}`)));
    const body = [];
    if (L.lines) {
      for (const ln of L.lines) {
        const scale = Math.max(ln.pa, ln.pb, 1) * 1.08;
        body.push(lane(pchip(ln.A), ln.a, ln.pa, scale, null, ln.A), lane(pchip(ln.B), ln.b, ln.pb, scale, null, ln.B));
        const lead = ln.d >= 0 ? [pchip(ln.A), ` leads by ${fmtN(ln.d)}`] : [pchip(ln.B), ` leads by ${fmtN(-ln.d)}`];
        body.push(el("p", { class: "race-note" }, ...lead, ` · needs more than ${fmtN(ln.line)} · on pace for a gap of ${fmtN(Math.round(ln.pd))}`));
      }
    } else if (L.who) {
      const th = qThresholds(q), scale = Math.max(L.proj, ...(th.length ? [th[th.length - 1] * 1.15] : []), 1) * 1.05;
      const who = L.kind === "tail" ? el("span", {}, `${L.who.length} producers`) : pchip(L.who[0]);
      body.push(lane(who, L.v, L.proj, scale, th.length === 1 ? th[0] : null));
      if (th.length > 1) {
        // the answer zones along the same track: where the projection lands is the option it points to
        // equal-width zones (one per answer), with a dot where the pace currently lands
        const k = q.options.length, w = 100 / k, bd = optBounds(q), p = L.proj, i = q.options.findIndex((o) => o.index === L.pointsTo);
        let at = null;
        if (i >= 0) {
          const avg = (th[th.length - 1] - th[0]) / Math.max(1, th.length - 1) || 1;
          const lo = bd[i].min ?? bd[i].max - avg, hi = bd[i].max ?? bd[i].min + avg;
          at = w * i + w * Math.max(0.08, Math.min(0.92, (p - lo) / Math.max(1, hi - lo)));
        }
        body.push(el("div", { class: "lane lane-zones" }, el("div", { class: "lane-label muted" }, "Answers"),
          el("div", { class: "zones" }, ...q.options.map((o) => el("span", { class: `zone${o.index === L.pointsTo ? " on" : ""}`, title: o.label }, String.fromCharCode(65 + o.index))),
            at != null ? el("i", { class: "zone-dot", style: `left:${at}%`, title: `on pace for ${fmtN(Math.round(p))}` }) : null),
          el("div", {})));
      }
      body.push(el("p", { class: "race-note" }, `${fmtN(L.v)} so far · on pace for ${fmtN(Math.round(L.proj))}${th.length === 1 ? ` · the line is ${fmtN(th[0])}` : ""}`));
    } else if (Number.isFinite(L.v)) {
      body.push(el("p", { class: "race-note" }, `${L.what}: `, el("b", {}, L.show(L.v)), Number.isFinite(L.proj) && L.proj !== L.v ? ` · on pace for ${L.show(L.proj)}` : ""));
    }
    return el("div", { class: "race" }, head, bar, ...body);
  }

  function questionCard(q, mode) {
    const mine = myAnswer(q);
    const oc = outcomeOf(q);
    const left = q.lockTime - nowMs();
    const status = mode === "open" ? el("span", { class: `timer${left < 3600000 ? " soon" : ""}`, title: `Answers close ${new Date(q.lockTime).toLocaleString()}` }, `Closes in ${duration(left)}`)
      : oc === 1000 ? el("span", { class: "badge badge-void" }, "Voided")
      : oc ? (mine === null ? el("span", { class: "badge badge-wait" }, "Resolved") : mine + 1 === oc ? el("span", { class: "badge badge-ok" }, "+1 point") : el("span", { class: "badge badge-miss" }, "No point"))
      : el("span", { class: "badge badge-wait" }, `Result in ~${duration((q.windowEnd + 60 - S.height) * BLOCK_MS)}`);
    const top = el("div", { class: "q-top" },
      el("div", { class: "q-tags" }, el("span", { class: `tier tier-${q.tier || "Medium"}` }, q.tier || "Question"), el("span", { class: "kind" }, KIND_LABEL[qKind(q)])),
      status);
    const pace = mode === "locked" && !oc ? liveOf(q)?.pointsTo : null;
    const opts = el("div", { class: `opts n${q.options.length}` }, q.options.map((o) => {
      let cls = "opt";
      if (pace === o.index && (q.windowEnd - q.windowStart) > 0) cls += " pace";
      if (mine === o.index) cls += " picked";
      if (oc && oc !== 1000 && oc === o.index + 1) cls += " correct";
      else if (oc && oc !== 1000 && mine === o.index) cls += " wrong";
      const canAnswer = mode === "open" && mine === null && q.hashOk !== false && (S.demo || q.hashOk === true) && (S.demo || wordingHashed(q));
      return el("button", {
        class: cls, type: "button", disabled: !canAnswer,
        "aria-label": `Option ${String.fromCharCode(65 + o.index)}: ${o.label}`,
        onclick: () => answer(q, o.index),
      }, el("span", { class: "letter" }, String.fromCharCode(65 + o.index)), el("span", { class: "opt-text" }, ...optLabel(o.label)));
    }));
    const act = oc && oc !== 1000 && (S.demo || q.result?.option + 1 === oc) ? actualText(q) : null;   // only once decided on chain
    const foot = el("div", { class: "q-foot" },
      el("span", { class: "q-where" }, qWhere(q, false)),
      mine !== null ? el("span", { class: `q-done${oc && oc !== 1000 ? (mine + 1 === oc ? " ok" : " miss") : ""}` }, outcomeNote(mine, oc)) : mode === "open" ? el("span", { class: "q-cta" }, S.account ? "Tap an answer" : "Connect a wallet to answer") : null);
    return el("article", { class: `q q-${(q.tier || "Medium")}${mine !== null ? " q-answered" : ""}` }, top,
      el("h3", { title: q.text }, el("span", { class: "qno" }, qTag(q)), " ", ...headline(q)), groupView(q),
      el("div", { class: "q-facts" }, ...windowFacts(q), mode === "open" ? el("span", { class: "fact" }, "Counting starts when answers close") : null),
      mode === "locked" && !oc ? raceView(q) : null,
      opts, act ? el("p", { class: "q-actual" }, ...act) : null, hashNote(q), foot);
  }

  /** What an answered card says: the pick, and once the chain records the outcome, whether it was right. */
  function outcomeNote(mine, oc) {
    const L = (i) => String.fromCharCode(65 + i);
    if (!oc) return `✓ Answered: ${L(mine)}`;
    if (oc === 1000) return "Void: nobody scores";
    return mine + 1 === oc ? `✓ Right (${L(mine)})` : `✗ Missed: answer was ${L(oc - 1)} (you: ${L(mine)})`;
  }
  /** Final: the chain recorded an outcome and the window's blocks are past (the same test as Results). */
  const isFinal = (q) => !!outcomeOf(q) && S.height > q.windowEnd;
  const weekOfQ = (q) => QNO.get(Number(q.chainId))?.week ?? num(q.week);

  function hashNote(q) {
    if (S.demo || (q.hashOk === true && wordingHashed(q))) return null;
    return el("p", { class: "q-warn" }, q.hashOk === false
      ? "This question's published file does not match what was posted on chain, so it is not offered here. Don't answer it from anywhere else either."
      : q.hashOk === true
        ? "This question was released before its wording was covered by the on-chain hash, so the page can't confirm its options and does not offer it."
        : "This question could not be checked against the chain yet. Reload the page to try again.");
  }

  /** The scoreboard band at the top of Play: your place, points and stake, with Stake / Withdraw right there. */
  function renderBand(now) {
    const band = $("#band");
    if (!band) return;
    const kicker = el("p", { class: "band-kicker" }, now < S.genesis ? "The first week starts Monday" : `Week ${S.week + 1} · ${DAY_NAMES[new Date(now).getDay()]}`);
    const stat = (k, v, sub) => el("div", { class: "band-stat" }, el("span", { class: "band-k" }, k), el("b", { class: "band-v" }, ...[].concat(v)), sub ? el("span", { class: "band-sub" }, sub) : null);
    if (!S.account) {
      band.replaceChildren(
        el("div", { class: "band-main" }, kicker,
          el("h1", { class: "band-title" }, "Call the next blocks."),
          el("p", { class: "band-text" }, "Answer each day's questions about Koinos block producers. Play free, or stake 1 VHP or more to share the weekly pool.")),
        el("div", { class: "band-actions" },
          el("button", { class: "btn btn-tang", type: "button", onclick: connect }, "Connect wallet"),
          el("a", { class: "btn btn-onnavy", href: "#welcome" }, "How it works")));
      return;
    }
    const p = S.player || {};
    const active = S.activeStake ?? big(p.stake), total = big(p.stake) + big(p.pending);
    const joining = total > active ? total - active : 0n;
    const B = S.board[S.week], me = B?.scored.find((x) => x.address === S.account);
    const elig = B ? B.scored.filter((x) => x.eligible) : [];
    const place = me && me.eligible && me.counted > 0 ? [`#${elig.indexOf(me) + 1}`, el("small", {}, ` of ${elig.length}`)] : [active >= UNIT ? "–" : "Free"];
    const owed = S.claims.reduce((a, c) => a + big(c.reward), 0n);
    band.replaceChildren(
      el("div", { class: "band-main" }, kicker,
        el("div", { class: "band-stats" },
          stat("Your place", place, me && !me.eligible && me.counted > 0 ? "free play" : me?.winner ? "in the top 30%" : null),
          stat("Points", String(me ? me.pts : 0), "this week"),
          stat("Staked", [amount(active), el("small", {}, " VHP")], joining > 0n ? `+${amount(joining)} next week` : active < UNIT ? "stake 1+ to win" : null))),
      el("div", { class: "band-actions" },
        el("button", { class: "btn btn-tang", type: "button", onclick: () => openStake("deposit") }, "Stake"),
        el("button", { class: "btn btn-onnavy", type: "button", onclick: () => openStake("withdraw") }, "Withdraw"),
        owed > 0n ? el("button", { class: "btn btn-sun band-collect", type: "button", onclick: () => { const c = $("#panel-claim"); if (c && c.scrollIntoView) c.scrollIntoView({ behavior: "smooth", block: "center" }); } }, `${amount(owed)} VHP to collect`) : null,
        el("button", { class: "btn btn-onnavy band-share", type: "button", onclick: () => openShare(S.week) }, "Share my week")));
  }

  /** "Yesterday's results: 3 of 5 right", for the last question day the player answered something on. */
  function renderYesterday(now) {
    const box = $("#yesterday");
    if (!box) return;
    const past = S.questions.filter((q) => q.lockTime <= now);
    if (!S.account || !past.length) { box.hidden = true; return; }
    const last = past.reduce((a, q) => (q.lockTime > a.lockTime ? q : a));
    const w = weekOfQ(last), d = num(last.day);
    const day = past.filter((q) => weekOfQ(q) === w && num(q.day) === d);
    const mine = day.filter((q) => pickOf(q) !== null);
    if (!mine.length) { box.hidden = true; return; }
    const decided = mine.filter((q) => isFinal(q) && outcomeOf(q) !== 1000);
    const right = decided.filter((q) => pickOf(q) + 1 === outcomeOf(q)).length;
    const waiting = mine.filter((q) => !isFinal(q)).length;
    const yesterday = (d + 1) % 7 === new Date(now).getUTCDay();
    const label = `${yesterday ? "Yesterday's" : `${DAY_NAMES[d] || "Last"}'s`} results`;
    box.hidden = false;
    box.replaceChildren(el("a", { href: "#results", onclick: () => { RV.week = w; RV.day = d; RV.q = ""; RV.mine = false; } },
      el("b", {}, `${label}: `), decided.length ? `${right} of ${decided.length} right` : "waiting for the blocks",
      decided.length && waiting ? ` · ${waiting} still waiting` : "", " →"));
  }

  /** One week's numbers for the share picture. */
  function weekStats(week) {
    const B = S.board[week], me = B?.scored.find((x) => x.address === S.account);
    const elig = B ? B.scored.filter((x) => x.eligible) : [];
    const qs = S.questions.filter((q) => weekOfQ(q) === week && isFinal(q) && outcomeOf(q) !== 1000 && pickOf(q) !== null);
    return {
      week: week + 1, pts: me ? me.pts : 0,
      place: me && me.eligible && me.counted > 0 ? elig.indexOf(me) + 1 : 0, of: elig.length,
      right: qs.filter((q) => pickOf(q) + 1 === outcomeOf(q)).length, decided: qs.length,
      free: !me || !me.eligible, address: S.account,
    };
  }
  const installUrl = () => { const u = new URL("install.html", location.href); u.hash = ""; u.search = ""; return u.href; };
  const playUrl = () => { const u = new URL("./", location.href); u.hash = "play"; u.search = ""; return u.href; };
  function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = el("a", { href: url, download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
  /** Share my week: a picture made on this device (no address unless ticked), shared with the phone's share sheet. */
  const SH = { week: 0 };
  async function drawShareNow() {
    const c = $("#share-canvas"), box = $("#share-addr");
    if (c && window.KnodeExtras) await window.KnodeExtras.drawShare(c, weekStats(SH.week), { showAddress: !!(box && box.checked) });
  }
  async function openShare(week) {
    const dlg = $("#share-dialog");
    if (!dlg || !window.KnodeExtras || !S.account) return;
    SH.week = week;
    const box = $("#share-addr");
    if (box) box.checked = false;
    if (!S.board[week] && !S.demo) { try { S.board[week] = await loadBoard(week); } catch { /* the picture shows what is known */ } }
    if (dlg.showModal) dlg.showModal();
    await drawShareNow();
  }
  const shareText = () => { const st = weekStats(SH.week); return `I scored ${st.pts} ${st.pts === 1 ? "point" : "points"} on Knode Games in week ${st.week}${st.place ? ` (#${st.place} of ${st.of})` : ""}. Call the next blocks on Koinos: ${installUrl()}`; };
  const shareBlob = () => new Promise((res) => { const c = $("#share-canvas"); if (!c || !c.toBlob) res(null); else c.toBlob((b) => res(b), "image/png"); });
  async function shareGo() {
    const blob = await shareBlob(), text = shareText(), name = `knode-week-${SH.week + 1}.png`;
    try {
      const file = blob && typeof File === "function" ? new File([blob], name, { type: "image/png" }) : null;
      if (file && navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], text, title: "Knode Games" }); return; }
      if (navigator.share) { await navigator.share({ text, title: "Knode Games", url: installUrl() }); return; }
    } catch (e) { if (e && e.name === "AbortError") return; }
    await shareSave();
  }
  async function shareSave() {
    const blob = await shareBlob();
    if (blob) saveBlob(blob, `knode-week-${SH.week + 1}.png`);
    try { await navigator.clipboard.writeText(shareText()); toast("Picture saved, and the text is copied: paste it with the picture."); }
    catch { toast("Picture saved."); }
  }

  /** Reminders. A calendar file always works; notifications only while Knode Games is open (no server sends them). */
  const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const lsSet = (k, v) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* private window */ } };
  const NOTIFY_KEY = "kn-notify-v1";
  const canNotify = () => typeof Notification !== "undefined";
  const notifyOn = () => canNotify() && Notification.permission === "granted" && lsGet(NOTIFY_KEY) === "1";
  function notify(title, body, tag) {
    const opts = { body, tag, icon: "media/icon-192.png", data: { url: playUrl() } };
    const plain = () => { try { new Notification(title, opts); } catch { /* not allowed here */ } };
    try {
      if (navigator.serviceWorker && navigator.serviceWorker.getRegistration) navigator.serviceWorker.getRegistration().then((r) => (r ? r.showNotification(title, opts) : plain())).catch(plain);
      else plain();
    } catch { plain(); }
  }
  function checkReminders(open, now) {
    if (S.demo || !notifyOn() || !open.length) return;
    const newest = Math.max(...open.map((q) => Number(q.chainId)));
    if (newest > Number(lsGet("kn-notify-q") || -1)) {
      lsSet("kn-notify-q", String(newest));
      notify("Today's Knode Games questions are out", `${open.length} new questions. Answers close in ${duration(open[0].lockTime - now)}.`, "knode-new");
    }
    const left = open[0].lockTime - now, todo = open.filter((q) => myAnswer(q) === null).length;
    if (S.account && todo && left > 0 && left <= 3600000 && lsGet("kn-notify-close") !== String(open[0].lockTime)) {
      lsSet("kn-notify-close", String(open[0].lockTime));
      notify("Under an hour left on Knode Games", `You have ${todo} question${todo === 1 ? "" : "s"} still to answer.`, "knode-close");
    }
  }
  function remindersCard() {
    const ics = () => {
      const text = window.KnodeExtras ? window.KnodeExtras.buildIcs(playUrl()) : "";
      if (text) { saveBlob(new Blob([text], { type: "text/calendar" }), "knode-daily-reminder.ics"); toast("Open the downloaded file to add the reminder to your calendar."); }
    };
    const toggle = async () => {
      if (notifyOn()) { lsSet(NOTIFY_KEY, null); toast("Notifications off."); return renderReminders(); }
      let p = "denied";
      try { p = await Notification.requestPermission(); } catch { /* old browsers */ }
      if (p === "granted") {
        lsSet(NOTIFY_KEY, "1");
        const open = S.questions.filter((q) => nowMs() < q.lockTime);
        if (open.length) lsSet("kn-notify-q", String(Math.max(...open.map((q) => Number(q.chainId)))));
        toast("Notifications on: you'll hear about new questions while Knode Games is open.");
      } else toast("Notifications are blocked in this browser. The calendar reminder still works.");
      renderReminders();
    };
    return el("div", { class: "remind" },
      el("p", { class: "muted" }, `New questions come out Monday to Saturday at ${localHour(12)} your time.`),
      el("div", { class: "row-btns" },
        el("button", { class: "btn btn-primary", type: "button", onclick: ics }, "Add to my calendar"),
        canNotify() ? el("button", { class: "btn btn-ghost", type: "button", onclick: toggle }, notifyOn() ? "Turn notifications off" : "Notify me while Knode Games is open") : null),
      el("p", { class: "fine-print muted" }, canNotify()
        ? "The calendar reminder works even when Knode Games is closed. Notifications only appear while Knode Games is open in a tab or as the installed app (on iPhone, only in the installed app)."
        : "The calendar reminder works even when Knode Games is closed. This browser can't show notifications."));
  }
  function renderReminders() {
    for (const id of ["#remind-body", "#welcome-remind"]) { const b = $(id); if (b && b.replaceChildren) b.replaceChildren(remindersCard()); }
  }

  function renderPlay() {
    const st = S.st || {};
    const t = st.totals || {};
    const now = nowMs();
    const holdings = big(st.vhp_balance) + big(st.koin_balance);
    const owed = ["total_stake", "seed_vhp", "seed_koin", "owner_share", "creator_fee", "pots_outstanding"].reduce((s, k) => s + big(t[k]), 0n);
    const earned = holdings > owed ? holdings - owed : 0n;
    // 95% of new earnings go to the players; a pot carried over from a week with no winners is added in full. v5: up to
    // 2 VHP of it is the 2 best free players' prize, the rest goes to the staked winners.
    const carried = big(t.rolled_over) < earned ? big(t.rolled_over) : earned;
    const forAll = carried + ((earned - carried) * 95n) / 100n;
    const forWinners = rewardRule(S.week) ? (forAll > FREE_PRIZE ? forAll - FREE_PRIZE : 0n) : forAll;
    $("#stat-ends").textContent = duration((now < S.genesis ? S.genesis : S.weekEnd) - now);
    $("#stat-ends").nextElementSibling.textContent = now < S.genesis ? "until the first week starts" : "until the week ends";
    // Last week and this week, kept apart. Until last week closes, everything earned still belongs to it.
    const P = S.prev, lastBox = $("#pot-last");
    const prevOpen = !!(P && !P.closed);
    lastBox.hidden = !P || (P.finalized && !S.claims.some((c) => c.week === P.week) && now > num(P.W.settle_end) + 86400000);
    if (P) {
      const settle = num(P.W.settle_end), closeAt = S.genesis + S.week * (num(st.config?.week_length) || 604800000) + (S.closeDelay || 43200000);
      $("#pot-last-k").textContent = `Week ${P.week + 1} · ${!P.closed ? "closing" : !P.finalized ? "closed" : "final"}`;
      $("#pot-last-v").textContent = `${amount(P.closed ? P.W.pot : forAll)} VHP`;
      $("#pot-last-note").textContent = !P.closed
        ? `still counting until it closes, ${now < closeAt ? `about ${dayTime(closeAt)}` : "at the next bot run"}`
        : !P.finalized ? `winners final ${settle ? dayTime(settle) : "Tuesday"}` : "ready to collect";
    }
    $("#stat-pot-k").textContent = now < S.genesis ? "Pool so far" : `Week ${S.week + 1} so far`;
    $("#stat-pot").textContent = `${amount(prevOpen ? 0n : forWinners)} VHP`;
    $("#stat-pot-note").textContent = prevOpen ? `starts counting when week ${P.week + 1} closes` : rewardRule(S.week) ? "for the staked winners, after the 5% fee and up to 2 VHP for the top free players" : "for the winners, after the 5% fee";
    $("#stat-players").textContent = S.boardWeek === S.week && S.board[S.week] ? String(S.board[S.week].scored.length) : "…";
    renderBand(now);

    const thisWeek = (q) => (QNO.get(q.chainId)?.week ?? num(q.week)) === S.week;
    const open = S.questions.filter((q) => now < q.lockTime).sort((a, b) => a.chainId - b.chainId);
    const lockedAll = S.questions.filter((q) => thisWeek(q) && now >= q.lockTime);
    const waiting = lockedAll.filter((q) => !outcomeOf(q));
    // Answered questions decided in the last day stay here too, so the player sees right / missed right away.
    const recent = lockedAll.filter((q) => outcomeOf(q) && myAnswer(q) !== null && num(q.windowEnd) >= S.height - 28800);
    const locked = [...waiting, ...recent].sort((a, b) => a.chainId - b.chainId);
    const oq = $("#open-questions");
    // Between 12:00 UTC and the day's questions appearing (the bot posts them on chain, then publishes the files):
    // say they're on their way, not "no questions", so a visitor in those minutes knows nothing is wrong.
    const dayN = S.genesis && now >= S.genesis ? Math.floor((now - S.genesis) / 86400000) : -1;
    const dayLock = S.genesis + (dayN + 1) * 86400000;
    const todayLabel = dayN >= 0 ? `W${String(Math.floor(dayN / 7)).padStart(3, "0")}-D${(dayN % 7) + 1}` : "";
    const skippedToday = (S.files || []).some(({ d }) => d && d.date === todayLabel && d.skipped);
    const posting = dayN >= 0 && dayN % 7 < 6 && now >= dayLock - 12 * 3600000 && !skippedToday && !S.questions.some((q) => num(q.lockTime) === dayLock);
    const late = posting && now >= dayLock - 10 * 3600000; // still not out two hours after 12:00 UTC
    const emptyText = late
      ? "Today's questions are running late. They'll show up here as soon as they're posted; this page checks every minute."
      : posting
        ? `Today's questions are on their way. They're posted on the Koinos chain at ${localHour(12)} your time and show up here within a few minutes. This page checks every minute, so there's no need to refresh.`
        : `No open questions right now. New questions arrive Monday to Saturday at ${localHour(12)} your time.`;
    oq.replaceChildren(...(open.length ? open.map((q) => questionCard(q, "open")) : [el("div", { class: "empty" }, emptyText)]));
    const answeredToday = open.filter((q) => myAnswer(q) !== null).length;
    const tn = $("#today-note");
    if (tn) tn.textContent = !open.length ? "" : S.account ? `${answeredToday} of ${open.length} answered${open.length && open[0] ? ` · answers close in ${duration(open[0].lockTime - now)}` : ""}` : `${open.length} to answer · answers close in ${duration(open[0].lockTime - now)}`;
    const wc = $("#waiting-count");
    if (wc) wc.textContent = `(${waiting.length} waiting${recent.length ? ` · ${recent.length} decided` : ""})`;
    const wtt = $("#waiting-title");
    if (wtt) wtt.textContent = recent.length ? "Waiting and latest results" : "Waiting for results";
    renderYesterday(now);
    checkReminders(open, now);
    const wt = $("#waiting");
    if (wt) wt.hidden = !locked.length;
    // (Ad slots are the elements with data-ad-slot="…"; loadAds() fills them from site/ads.json. A network (iframe) ad
    // also needs its origin in index.html's CSP frame-src.)
    $("#locked-questions").replaceChildren(...locked.map((q) => questionCard(q, "locked")));

    // you
    const you = $("#you-body");
    if (!S.account) {
      you.replaceChildren(el("p", { class: "muted" }, "Connect a wallet to stake and answer: Kondor on a computer, or KOIN Vault on your phone (fingerprint or face, no extension)."),
        el("div", { class: "row-btns" }, el("button", { class: "btn btn-primary", type: "button", onclick: connect }, "Connect wallet")));
    } else {
      const p = S.player || {};
      const total = big(p.stake) + big(p.pending), active = S.activeStake ?? big(p.stake);
      const joining = total > active ? total - active : 0n;
      const pts = S.board[S.week]?.scored.find((s) => s.address === S.account);
      you.replaceChildren(...[
        el("div", { class: "you-big" }, el("b", {}, amount(S.activeStake ?? p.stake)), el("span", { class: "muted" }, nowMs() < S.genesis ? "VHP playing in week 1 (starts Monday)" : "VHP playing this week")),
        (S.activeStake ?? 0n) < UNIT ? el("p", { class: "free-note" }, "You're playing free: your points count on the leaderboard. Stake at least 1 VHP to share in the rewards (a stake counts from the next week).") : null,
        // Only the part that doesn't count yet. (Deposits made before the game starts already count for week 1.)
        joining > 0n ? el("p", { class: "muted" }, `+ ${amount(joining)} VHP joining next week`) : null,
        el("dl", { class: "facts", style: "margin-top:14px" },
          el("dt", {}, "Points this week"), el("dd", {}, pts ? String(pts.pts) : "0"),
          ...(nowMs() >= S.genesis && pts && pts.counted > 0 ? [
            el("dt", {}, "Live place"), el("dd", {}, pts.eligible ? `#${S.board[S.week].scored.filter((x) => x.eligible).indexOf(pts) + 1} of ${S.board[S.week].scored.filter((x) => x.eligible).length}` : "free play (no place)"),
            el("dt", { title: "An estimate from what the pool has earned so far this week; the final split is set when the week closes." }, "If the week ended now"),
            el("dd", {}, prevOpen ? `counts after week ${P.week + 1} closes` : pts.winner && pts.reward !== undefined ? `~${amount(pts.reward)} VHP` : !pts.eligible ? "needs 1 VHP + 2 answers" : "not in the top 30% yet")] : []),
          el("dt", {}, "Answers given"), el("dd", {}, String((S.entry?.answers || []).length)),
          el("dt", {}, "Wallet"), el("dd", { class: "addr" }, short(S.account))),
        S.entry?.voided ? el("p", { class: "warn" }, "You withdrew this week, so this week's answers don't count.") : null,
        el("div", { class: "row-btns" },
          el("button", { class: "btn btn-primary", type: "button", onclick: () => openStake("deposit") }, "Stake"),
          el("button", { class: "btn btn-ghost", type: "button", onclick: () => openStake("withdraw") }, "Withdraw"))].filter(Boolean));
    }
    // claims
    const cp = $("#panel-claim");
    cp.hidden = !S.claims.length;
    $("#claim-body").replaceChildren(...S.claims.map((c) => el("div", { class: "claim-row" },
      el("span", {}, el("b", {}, `${amount(c.reward)} VHP`), el("br"), el("span", { class: "muted" }, c.free ? `Week ${c.week + 1}: top free player prize. Stake it to share the full pool next week!` : `Week ${c.week + 1}`)),
      el("button", { class: "btn btn-sun", type: "button", onclick: () => claim(c.week) }, "Collect"))));
    // pool
    $("#pool-facts").replaceChildren(
      el("dt", {}, "Players' stake"), el("dd", {}, `${amount(t.total_stake, 0)} VHP`),
      el("dt", {}, "Seed VHP (never plays)"), el("dd", {}, `${amount(t.seed_vhp, 0)} VHP`),
      el("dt", {}, prevOpen ? `Earned (week ${P.week + 1}, closing)` : "Earned this week"), el("dd", {}, `${amount(earned)} VHP`),
      el("dt", {}, "Winners get"), el("dd", {}, rewardRule(S.week) ? "95%, minus up to 2 VHP for the top free players" : "95%"),
      el("dt", {}, "Waiting to be collected"), el("dd", {}, `${amount(t.pots_outstanding)} VHP`));
    if (S.demo) { const btn = $("#connect"); btn.textContent = S.account ? short(S.account) : "Connect wallet"; btn.classList.toggle("connected", !!S.account); }
    $("#foot-contract").textContent = S.dep?.contract ? `Contract ${S.dep.contract}` : "";
  }

  async function renderBoard(week = S.boardWeek ?? S.week) {
    if (!S.demo && !S.st) return; // not loaded yet
    const fin = S.demo ? 0 : num(S.st?.totals?.weeks_finalized);
    const weeks = [S.week, ...Array.from({ length: Math.min(4, fin) }, (_, i) => fin - 1 - i)].filter((w, i, a) => w >= 0 && a.indexOf(w) === i);
    $("#lb-weeks").replaceChildren(...weeks.map((w) => el("button", {
      type: "button", role: "tab", "aria-selected": String(w === week), onclick: () => renderBoard(w),
    }, w === S.week ? `This week (${w + 1})` : `Week ${w + 1}`)));
    const tbody = $("#board tbody");
    const cards = $("#board-cards");
    const cardMsg = (t) => { if (cards && cards.replaceChildren) cards.replaceChildren(el("div", { class: "empty" }, t)); };
    if (!S.board[week]) {
      tbody.replaceChildren(el("tr", {}, el("td", { colspan: "5", class: "muted" }, "Loading…")));
      cardMsg("Loading…");
      try { S.board[week] = await loadBoard(week); } catch (e) { tbody.replaceChildren(el("tr", {}, el("td", { colspan: "5", class: "muted" }, `Couldn't load: ${e.message}`))); cardMsg(`Couldn't load: ${e.message}`); return; }
    }
    S.boardWeek = week;
    const b = S.board[week];
    // Two boards. Staked: players with a stake, who share the weekly pool. Free play: wallets with no stake; 1st and
    // 2nd collect the weekly free-play prize. Free play lists only the top FREE_SHOW; everyone else stays private
    // (a free player still sees their own place).
    const kind = S.lbKind === "free" ? "free" : "main";
    const L = (window.KBoard && window.KBoard.LABELS) || { staked: "Staked", free: "Free play" };   // same names in every game
    $("#lb-kind").replaceChildren(...[["main", L.staked], ["free", L.free]].map(([k, label]) => el("button", {
      type: "button", "aria-pressed": String(k === kind), onclick: () => { S.lbKind = k; renderBoard(week); },
    }, label)));
    const everyone = b.scored.filter((s) => s.counted > 0 || s.address === S.account);
    const freeAll = everyone.filter((s) => s.stake < UNIT && s.counted > 0);
    const myFree = freeAll.findIndex((s) => s.address === S.account);
    const rows = kind === "main" ? everyone.filter((s) => s.stake >= UNIT) : freeAll.slice(0, FREE_SHOW);
    $("#lb-me").textContent = kind === "free" && myFree >= FREE_SHOW ? `${youLabel()}: #${myFree + 1} in free play with ${freeAll[myFree].pts} points (only you see this).`
      : kind === "main" && myFree >= 0 ? `${youLabel()} play free this week: your place is on the Free play board.` : "";
    const empty = kind === "main" ? "No staked players yet this week. Stake at least 1 VHP and answer to be the first." : "No free-play scores yet this week.";
    if (!rows.length) { tbody.replaceChildren(el("tr", {}, el("td", { colspan: "5", class: "muted" }, empty))); cardMsg(empty); return; }
    let lastWinnerIdx = -1;
    rows.forEach((s, i) => { if (s.winner) lastWinnerIdx = i; });
    // Staked: places among eligible staked players. Free play: places in the free-play order.
    let place = 0;
    const placeOf = new Map(rows.map((s, i) => [s, kind === "free" ? i + 1 : s.eligible ? ++place : null]));
    const freePrizeRow = (s) => kind === "free" && rows.indexOf(s) < 2;
    if (kind === "free") lastWinnerIdx = -1;
    tbody.replaceChildren(...rows.map((s, i) => el("tr", { class: [s.address === S.account ? "me" : "", i === lastWinnerIdx ? "cutline" : ""].join(" ").trim() },
      el("td", {}, el("span", { class: `rank${s.winner || freePrizeRow(s) ? " top" : ""}` }, placeOf.get(s) ? String(placeOf.get(s)) : "–")),
      el("td", {}, el("span", { class: "addr" }, s.address === S.account ? youLabel() : short(s.address)), i === lastWinnerIdx ? el("span", { class: "cut-label" }, "winners' line") : null),
      el("td", { class: "num" }, String(s.pts)),
      el("td", { class: "num" }, s.stake < UNIT ? el("span", { class: "badge badge-free" }, "Free play") : `${amount(s.stake, 0)} VHP`),
      el("td", { class: "num" }, freePrizeRow(s) ? (rows.indexOf(s) === 0 ? "🥇 Prize" : "🥈 Prize") : s.winner && s.reward !== undefined && !(b.estimate && s.reward === 0n) ? `${b.estimate ? "~" : ""}${amount(s.reward)} VHP` : "–"))));
    // Phones: the same standings as cards, your own card pinned on top. Ties: players on the same points as a neighbour.
    if (cards && cards.replaceChildren) {
      const elig = rows.filter((s) => s.eligible);
      const tied = (s) => s.eligible && elig.some((o) => o !== s && o.pts === s.pts);
      const rewardOf = (s) => (freePrizeRow(s) ? "weekly free-play prize" : s.winner && s.reward !== undefined && !(b.estimate && s.reward === 0n) ? `${b.estimate ? "~" : ""}${amount(s.reward)} VHP` : null);
      const card = (s, i, pinned) => el("div", { class: ["lbc", s.address === S.account ? "me" : "", s.winner ? "win" : "", pinned ? "pinned" : ""].join(" ").trim() },
        el("span", { class: `lbc-place${s.winner ? " lbc-win" : ""}` }, placeOf.get(s) ? `#${placeOf.get(s)}` : "–"),
        el("div", { class: "lbc-who" },
          el("b", {}, pinned ? `${youLabel()}: ${placeOf.get(s) ? `#${placeOf.get(s)}${kind === "main" ? ` of ${elig.length}` : " in free play"}` : "free play"}` : s.address === S.account ? youLabel() : short(s.address)),
          el("span", { class: "muted" }, s.stake < UNIT ? "Free play" : `${amount(s.stake, 0)} VHP staked`, tied(s) ? " · tied" : "", rewardOf(s) ? ` · ${rewardOf(s)}` : "")),
        el("span", { class: "lbc-pts" }, el("b", {}, String(s.pts)), el("small", {}, " pts")));
      const meRow = rows.find((s) => s.address === S.account);
      const list = [];
      if (meRow) list.push(card(meRow, -1, true));
      rows.forEach((s, i) => { list.push(card(s, i, false)); if (i === lastWinnerIdx && i < rows.length - 1) list.push(el("div", { class: "lbc-cut" }, "Winners' line: everyone above shares the pool")); });
      cards.replaceChildren(...list);
    }
    $("#lb-note").textContent = kind === "free"
      ? `Free play: wallets with no stake. 1st and 2nd at the end of the week collect the free-play prize. Only the top ${FREE_SHOW} are shown; everyone else stays private.`
      : week === S.week
      ? "Live standings: points count as soon as each question's blocks are final. The top 30% of staked players win (ties too). Rewards shown with ~ are estimates if the week ended now."
      : b.final ? `Final: ${num(b.final.winners)} winner(s) at ${num(b.final.cutoff)}+ points shared ${amount(b.final.pot)} VHP.` : "Final standings.";
    if (week === S.week) $("#stat-players").textContent = String(b.scored.length);
  }

  /** Results: one week at a time, a day at a time, one row per question. Search looks through the whole week. */
  const RV = { week: null, day: null, q: "", mine: false };
  const SHORT_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  /** The answer this wallet gave to q (this week from the wallet's entry; earlier weeks from that week's board). */
  function pickOf(q) {
    if (!S.account) return null;
    if (num(q.week) === S.week || S.demo) return myAnswer(q);
    const me = S.board[num(q.week)]?.scored.find((x) => x.address === S.account);
    const a = me && (me.answers || []).find((x) => num(x.question_id) === Number(q.chainId));
    return a ? num(a.option) : null;
  }
  const searchText = (q) => [q.text, ...(q.subjects || []), ...(q.group || []), ...(q.options || []).map((o) => o.label), qTag(q), `#${q.chainId}`].join(" ").toLowerCase();
  function renderResults() {
    const files = S.files.filter(({ d }) => (d.questions || []).some((q) => q.chainId !== undefined));
    const list = $("#results-list");
    if (!files.length) { list.replaceChildren(el("div", { class: "empty" }, "No results yet. The first ones arrive a few hours after the first questions close.")); return; }
    const final = (q) => !!outcomeOf(q) && S.height > q.windowEnd;
    const weeks = [...new Set(files.map(({ d }) => num(d.week)))].sort((x, y) => y - x);
    if (RV.week === null || !weeks.includes(RV.week)) { RV.week = weeks[0]; RV.day = null; }
    const inWeek = files.filter(({ d }) => num(d.week) === RV.week);
    const days = [...new Set(inWeek.map(({ d }) => num(d.day)))].sort((x, y) => x - y);
    if (RV.day === null || !days.includes(RV.day)) {
      const withFinal = days.filter((dd) => inWeek.some(({ d }) => num(d.day) === dd && (d.questions || []).some((q) => q.chainId !== undefined && final(q))));
      RV.day = (withFinal.length ? withFinal : days)[(withFinal.length ? withFinal : days).length - 1];
    }
    // week and day pickers
    const wk = $("#res-weeks");
    if (wk) wk.replaceChildren(...(weeks.length >= 1 ? weeks.map((w) => el("button", { type: "button", "aria-pressed": String(w === RV.week), onclick: () => { RV.week = w; RV.day = null; renderResults(); } }, w === S.week ? `This week (Week ${w + 1})` : w === S.week - 1 ? `Last week (Week ${w + 1})` : `Week ${w + 1}`)) : []));
    const dk = $("#res-days");
    if (dk) dk.replaceChildren(...days.filter((dd) => dd >= 1 && dd <= 6).map((dd) => el("button", { type: "button", "aria-pressed": String(!RV.q && dd === RV.day), onclick: () => { RV.day = dd; RV.q = ""; const i = $("#res-search"); if (i) i.value = ""; renderResults(); } }, SHORT_DAYS[dd - 1])));
    const mineBtn = $("#res-mine");
    if (mineBtn) { mineBtn.hidden = !S.account; mineBtn.setAttribute("aria-pressed", String(!!(S.account && RV.mine))); }
    const shareBtn = $("#res-share");
    if (shareBtn) shareBtn.hidden = !S.account;
    if (S.account && !S.demo && RV.week !== S.week && !S.board[RV.week]) loadBoard(RV.week).then((b) => { S.board[RV.week] = b; renderResults(); }).catch(() => {});

    const needle = RV.q.trim().toLowerCase();
    let qs = inWeek.filter(({ d }) => needle || num(d.day) === RV.day).flatMap(({ f, d }) => (d.questions || []).filter((q) => q.chainId !== undefined).map((q) => ({ q, f, day: num(d.day) })));
    if (needle) qs = qs.filter(({ q }) => searchText(q).includes(needle));
    if (S.account && RV.mine) qs = qs.filter(({ q }) => pickOf(q) !== null);
    qs.sort((x, y) => x.day - y.day || Number(x.q.chainId) - Number(y.q.chainId));

    // the score in the band: right answers among this week's final, answered questions
    const sc = $("#res-score");
    if (sc) {
      const all = inWeek.flatMap(({ d }) => (d.questions || []).filter((q) => q.chainId !== undefined && final(q) && outcomeOf(q) !== 1000));
      const mine = all.filter((q) => pickOf(q) !== null), right = mine.filter((q) => pickOf(q) + 1 === outcomeOf(q));
      sc.replaceChildren(...(S.account && mine.length ? [el("b", {}, String(right.length)), ` / ${mine.length} right`] : [`Week ${RV.week + 1} · ${all.length} decided`]));
    }

    const row = ({ q, f }) => {
      const done = final(q), oc = done ? outcomeOf(q) : 0, isVoid = oc === 1000, opt = oc && !isVoid ? q.options?.[oc - 1] : null;
      const mine = pickOf(q);
      // The outcome recorded on chain (after any owner correction) decides what is shown; the file's own result only
      // explains it, and only when it says the same.
      const r = q.result && typeof q.result === "object" ? q.result : null;
      const fileOc = r ? (r.void ? 1000 : Number.isInteger(r.option) ? r.option + 1 : null) : null;
      const agrees = done && fileOc === oc;
      const name = (o) => (o === 1000 ? "void" : `option ${String.fromCharCode(64 + o)}`);
      const status = !done ? "wait" : isVoid ? "void" : mine === null ? "none" : mine + 1 === oc ? "right" : "wrong";
      const ICON = { right: ["M5 12.5l4.5 4.5L19 7", "Right"], wrong: ["M6 6l12 12M18 6L6 18", "Missed"], none: ["M6 12h12", "Not answered"], void: ["M5 19L19 5", "Voided"], wait: ["M12 7v5l3 2", "Waiting"] }[status];
      const icon = el("span", { class: `res-icon res-icon-${status}`, role: "img", "aria-label": ICON[1], title: ICON[1] });
      const svg = document.createElementNS ? document.createElementNS("http://www.w3.org/2000/svg", "svg") : null;
      if (svg && svg.setAttribute) {
        svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true");
        if (status === "wait") { const c = document.createElementNS("http://www.w3.org/2000/svg", "circle"); c.setAttribute("cx", "12"); c.setAttribute("cy", "12"); c.setAttribute("r", "8"); svg.append(c); }
        const pth = document.createElementNS("http://www.w3.org/2000/svg", "path"); pth.setAttribute("d", ICON[0]); svg.append(pth); icon.append(svg);
      }
      const answerLine = !done
        ? el("p", { class: "res-line" }, el("span", { class: "badge badge-wait" }, S.height > q.windowEnd ? "Result being posted" : `Result in ~${duration((q.windowEnd + 60 - S.height) * BLOCK_MS)}`),
          mine !== null ? el("span", { class: "res-you" }, `You: ${String.fromCharCode(65 + mine)}`) : null)
        : isVoid ? el("p", { class: "res-line" }, el("span", { class: "res-void-note" }, `Voided${agrees && r.reason ? `: ${r.reason}` : ""}. Nobody gains or loses a point.`))
          : el("p", { class: "res-line" }, el("span", { class: "res-k" }, "Answer"), el("span", { class: "res-letter" }, String.fromCharCode(64 + oc)), el("span", { class: "opt-text" }, ...(opt ? optLabel(opt.label) : [`Option ${String.fromCharCode(64 + oc)}`])),
            mine !== null ? el("span", { class: `res-you${mine + 1 === oc ? " ok" : ""}` }, `You: ${String.fromCharCode(65 + mine)}`) : null);
      const warns = [
        done && !agrees && !S.demo ? el("p", { class: "q-warn" }, fileOc === null
          ? "The question file has no result yet; the result shown is the one recorded on chain."
          : `The question file says ${name(fileOc)}, but the chain records ${name(oc)} (an owner correction, or an edited file). The chain's result is the one that counts.`) : null,
        q.hashOk === false ? el("p", { class: "q-warn" }, "This question's published file does not match what was posted on chain.") : null];
      // Audit W1-03: before hashRule 2 the on-chain fingerprint did not cover the wording, so the option text shown
      // (not the letter, which comes from the chain) cannot be confirmed.
      const how = done ? el("details", { class: "res-how" }, el("summary", {}, "How it was decided"),
        agrees && actualText(q) ? el("p", { class: "q-actual" }, ...actualText(q)) : null,
        el("p", { class: "meta" }, `${qWhere(q)} · on-chain #${q.chainId}. Counted blocks ${fmtN(q.windowStart)} to ${fmtN(q.windowEnd)}${r && r.dataHash ? ` · fingerprint of those blocks ${String(r.dataHash).slice(0, 12)}…` : ""}. `,
          S.demo ? null : el("a", { href: DATA + f }, "See the data")),
        el("p", { class: "meta" }, "All answers: ", (q.options || []).map((o) => `${String.fromCharCode(65 + o.index)} ${o.label}`).join(" · ")),
        agrees && r.vhpCheck?.skipped ? el("p", { class: "meta" }, `The VHP-swing rule was not applied: ${r.vhpCheck.skipped}.`) : null,
        !S.demo && q.hashOk !== false && !wordingHashed(q) ? el("p", { class: "meta" }, "Released before the wording was covered by the on-chain fingerprint: the winning letter comes from the chain, but the option text shown can't be confirmed against it.") : null)
        : nowMs() >= q.lockTime ? raceView(q, true) : null;
      return el("article", { class: `res res-st-${status}` },
        icon,
        el("div", { class: "res-body" },
          el("h3", { title: q.text }, el("span", { class: "qno" }, qTag(q)), " ", ...headline(q)),
          answerLine, ...warns, how));
    };
    list.replaceChildren(...(qs.length ? qs.map(row) : [el("div", { class: "empty" }, needle ? "Nothing matches that this week." : RV.mine ? "You didn't answer any questions that day." : "No questions that day.")]));

    // Your past weeks
    const hist = $("#history");
    if (hist) {
      const H = S.account ? (S.history || []) : [];
      hist.hidden = !H.length;
      const hb = $("#history-body");
      if (hb && H.length) hb.replaceChildren(...H.map((h) => el("tr", {},
        el("td", {}, `Week ${h.week + 1}`),
        el("td", { class: "num" }, String(h.pts)),
        el("td", {}, h.voided ? "withdrew (answers didn't count)"
          : h.reward > 0n ? `${h.free ? "Top free player: " : "Won "}${amount(h.reward)} VHP${h.claimed ? " · collected" : " · to collect"}`
          : h.staked ? (h.pts >= h.cutoff && h.cutoff > 0 ? "in the top 30%" : `missed the line${h.cutoff ? ` (${h.cutoff} pts)` : ""}`) : "free play"))));
    }
  }

  function renderAll() {
    renderPlay();
    if (!$("#view-leaderboard").hidden) renderBoard();
    if (!$("#view-results").hidden) renderResults();
  }

  // ═══════════════ live block ticker ═══════════════
  let tickerTop = 0;
  async function ticker() {
    let blocks = [];
    try {
      if (S.demo) blocks = demoBlocks();
      else {
        const head = await S.provider.getHeadInfo();
        const h = num(head.head_topology.height);
        if (h === tickerTop) return;
        const res = await S.provider.call("block_store.get_blocks_by_height", {
          head_block_id: head.head_topology.id, ancestor_start_height: String(h - 6), num_blocks: 7, return_block: true, return_receipt: false,
        });
        blocks = (res.block_items || []).map((it) => ({ h: num(it.block_height), signer: it.block.header.signer })).reverse();
        S.height = h;
      }
    } catch { return; }
    if (!blocks.length) return;
    const list = $("#ticker");
    const isNew = (b) => b.h > tickerTop && tickerTop !== 0;
    list.replaceChildren(...blocks.slice(0, 7).map((b) => el("li", {
      class: `blk${b.signer === S.dep?.contract ? " ours" : ""}${isNew(b) ? " new" : ""}`, style: `--c: hsl(${hue(b.signer)} 70% 58%)`,
    }, el("span", { class: "cube", "aria-hidden": "true" }), el("span", { class: "who" }, b.signer === S.dep?.contract ? "Knode Games pool" : short(b.signer)), el("span", { class: "h" }, `#${b.h.toLocaleString()}`))));
    tickerTop = blocks[0].h;
  }

  // ═══════════════ demo data ═══════════════
  let demoTop = 0, demoSeed = 7;
  const drnd = () => ((demoSeed = (demoSeed * 16807) % 2147483647) / 2147483647);
  const DEMO_PRODUCERS = ["1MbsVfNw6yzQqA8499d8KQj8qdLyRs8CzW", "1KoinosNodeA9xQ2sPp3rX7mW1vD4k8Lz", "13mJx9ZbYqT2wE5rU8iO1pA4sD7fG0hJ", "1Burn4ndChi11FoGata3PoolQ8vX2nM5", "1Knode9PooL4demoXXXXXXXXXXXXXXXXX"];
  function demoBlocks() {
    if (!demoTop) demoTop = S.height;
    demoTop += 1;
    const out = [];
    for (let i = 0; i < 7; i++) { const h = demoTop - i; out.push({ h, signer: DEMO_PRODUCERS[(h * 7 + (h % 5)) % DEMO_PRODUCERS.length] }); }
    return out;
  }
  function setupDemo() {
    S.demo = true;
    $("#demo-note").hidden = false;
    const qs = (window.KPRED_DEMO?.questions || []);
    const last = Math.max(...qs.map((q) => q.lockHeight));
    // ?demo=live previews the race: the last day's answers closed 4,500 blocks ago and its blocks are being counted.
    const liveDemo = /[?&]demo=live\b/.test(location.search);
    S.height = liveDemo ? last + 4500 : last - 9000;
    // Demo clock: "now" is 15:00 UTC on a Saturday, so Saturday's questions are open until 00:00 UTC.
    const sat = new Date(); sat.setUTCDate(sat.getUTCDate() + ((6 - sat.getUTCDay() + 7) % 7)); sat.setUTCHours(15, 0, 0, 0);
    S.chainTime = sat.getTime(); S.seenAt = Date.now();
    S.genesis = 0; S.week = 2; S.weekEnd = S.chainTime + 33 * 3600000;
    const lockOf = (q) => (q.lockHeight === last && !liveDemo ? S.chainTime + 9 * 3600000 : S.chainTime + (q.lockHeight - S.height) * BLOCK_MS);
    S.dep = { contract: DEMO_PRODUCERS[4] };
    S.questions = qs.map((q) => ({ ...q, lockTime: lockOf(q), chainOutcome: q.result && q.windowEnd + 60 < S.height ? (q.result.void ? 1000 : q.result.option + 1) : undefined, result: q.windowEnd + 60 < S.height ? q.result : null }));
    S.files = [...new Set(qs.map((q) => q.day))].map((d) => ({ f: `W002-D${d}.json`, d: { week: 2, day: d, questions: S.questions.filter((q) => q.day === d) } }));
    numberQuestions(S.files);
    S.st = { totals: { total_stake: String(48250n * UNIT), seed_vhp: String(170000n * UNIT), seed_koin: String(20000n * UNIT), pots_outstanding: String(1203n * UNIT), owner_share: "0", creator_fee: "0" },
      vhp_balance: String(218250n * UNIT + 1203n * UNIT), koin_balance: String(20000n * UNIT + 412n * UNIT) };
    S.claims = [];
    S.st.totals.weeks_closed = "2"; S.st.totals.weeks_finalized = "1";
    S.prev = { week: 1, closed: true, finalized: false, W: { pot: String(1203n * UNIT), settle_end: String(S.chainTime + 40 * 3600000) } };
    // the live race for questions still counting: simulated blocks that drift toward each question's real result
    const run = S.questions.filter((q) => q.lockHeight < S.height && !q.result);
    if (run.length) {
      const orig = new Map(qs.map((q) => [q.id, q])), prob = new Map();
      for (const q of run) {
        const W = q.windowEnd - q.windowStart + 1, V = Number(String(orig.get(q.id)?.result?.value || "0").replace(/,/g, "")), [A, B] = qSubjects(q);
        if (qKind(q) === "h2h" && A && B) { prob.set(A, 0.2); prob.set(B, Math.max(0.01, 0.2 - V / W)); } else if (A) prob.set(A, Math.min(0.5, V / W));
      }
      const from = Math.min(...run.map((q) => q.windowStart)), list = [...prob.entries()];
      Object.assign(LV, { from, sig: [], ts: [], ntx: [], signers: [], top: S.height }); LV.idx.clear();
      for (let h = from; h <= S.height; h++) {
        let x = drnd(), who = "1OtherProducerXXXXXXXXXXXXXXXXXXX";
        for (const [a, pr] of list) { if (x < pr) { who = a; break; } x -= pr; }
        LV.sig.push(lvSigner(who)); LV.ts.push(S.chainTime - (S.height - h) * BLOCK_MS + Math.floor(drnd() * 900)); LV.ntx.push(drnd() < 0.3 ? 0 : 1 + Math.floor(drnd() * 3));
      }
    }
    // a field of players with made-up answers to the resolved questions
    const resolved = S.questions.filter((q) => q.chainOutcome);
    S.demoRows = Array.from({ length: 14 }, (_, i) => {
      const skill = 0.25 + drnd() * 0.45;
      return {
        address: "1" + Array.from({ length: 33 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz123456789"[Math.floor(drnd() * 58)]).join(""), voided: i === 9,
        stake: i % 6 === 5 ? 0n : BigInt(Math.round(50 + drnd() * 4000)) * UNIT,
        answers: resolved.filter(() => drnd() < 0.85).map((q) => ({ question_id: q.chainId, option: drnd() < skill && q.chainOutcome !== 1000 ? q.chainOutcome - 1 : Math.floor(drnd() * q.options.length) })),
      };
    });
  }
  function demoPlayer() {
    const resolved = S.questions.filter((q) => q.chainOutcome && q.chainOutcome !== 1000);
    S.entry = { stake: String(250n * UNIT), answers: resolved.slice(0, 9).map((q, i) => ({ question_id: q.chainId, option: i % 3 === 0 ? (q.chainOutcome % q.options.length) : q.chainOutcome - 1 })) };
    S.player = { stake: String(250n * UNIT), pending: String(25n * UNIT) };
    S.activeStake = 250n * UNIT;
    S.balances = { vhp: 120n * UNIT, koin: 40n * UNIT };
    S.claims = [{ week: 1, reward: 18_37000000n }];
    S.history = [{ week: 1, pts: 17, counted: 28, staked: true, voided: false, claimed: false, cutoff: 15, reward: 18_37000000n, free: false },
      { week: 0, pts: 9, counted: 25, staked: true, voided: false, claimed: false, cutoff: 12, reward: 0n, free: false }];
    S.board = {};
  }
  function demoBoard() {
    const outcomes = new Map(S.questions.filter((q) => q.chainOutcome).map((q) => [q.chainId, q.chainOutcome]));
    const rows = S.demoRows.slice();
    if (S.account) rows.push({ address: S.account, stake: 250n * UNIT, answers: S.entry.answers, voided: false });
    const res = score(rows, outcomes);
    const lp = livePots(); applyPots(res, lp.potA, lp.potB); res.estimate = true;
    return res;
  }

  // ═══════════════ start ═══════════════
  async function start() {
    // Staked or free in Daily Questions, how much, and a link to the staking page (stake-panel.js).
    if (window.KStake && !/[?&]demo\b/.test(location.search)) window.KStake.badge($("#stake-badge"), { game: 1, href: "stake.html" });
    const rs = $("#res-search");
    if (rs) rs.addEventListener("input", () => { RV.q = rs.value || ""; renderResults(); });
    const rm = $("#res-mine");
    if (rm) rm.addEventListener("click", () => { RV.mine = !RV.mine; renderResults(); });
    const rsh = $("#res-share");
    if (rsh) rsh.addEventListener("click", () => openShare(RV.week ?? S.week));
    const sa = $("#share-addr");
    if (sa) sa.addEventListener("change", () => drawShareNow());
    const sg = $("#share-go");
    if (sg) sg.addEventListener("click", () => shareGo());
    const ss = $("#share-save");
    if (ss) ss.addEventListener("click", () => shareSave());
    const sc = $("#share-close");
    if (sc) sc.addEventListener("click", () => { const d = $("#share-dialog"); if (d && d.close) d.close(); });
    renderReminders();
    // Installable app: the service worker keeps only the page shell for offline start-up (never game data or chain reads).
    if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
    // The header's wallet button and its account menu are header-wallet.js (shared by every page). In the demo it
    // only explains itself.
    if (/[?&]demo\b/.test(location.search) || !window.KWallet) $("#connect").addEventListener("click", () => { if (!S.account) return connect(); toast(`Connected with the demo wallet: ${S.account}.`, 5000); });
    const initWallet = () => window.KWallet && window.KWallet.init({
      provider: S.provider, toast, chainId: S.dep && S.dep.chainId, payer: S.dep && S.dep.payer, sponsor: S.dep && S.dep.sponsor, game: S.dep && S.dep.contract,
      onChange: (addr) => {
        S.account = addr; S.player = null; S.entry = null; S.activeStake = null; S.balances = null; S.claims = [];
        if (addr) afterConnect(); else { toast("Wallet disconnected"); S.board = {}; renderAll(); }
      },
    });
    route();
    const wantDemo = /[?&]demo\b/.test(location.search);
    let dep = null;
    if (!wantDemo) dep = await fetchJson(DATA + "deployment.json").catch(() => null);
    if (!dep || !dep.contract || !lib.Contract) {
      setupDemo();
    } else {
      S.dep = dep;
      S.abi = await fetchJson(ABI_URL);
      S.provider = gentle(new lib.Provider([dep.rpc || RPC]));
      initWallet();
      S.game = new lib.Contract({ id: dep.contract, abi: S.abi, provider: S.provider });
      try { await loadLive(); } catch (e) { toast(`Couldn't reach the Koinos network: ${e.message}`, 8000); }
      setInterval(async () => { try { await loadLive(); S.board[S.week] = undefined; renderPlay(); } catch {} await updateLive(); renderPlay(); if (!$("#view-results").hidden) renderResults(); }, 60000);
      updateLive().then(() => { renderPlay(); if (!$("#view-results").hidden) renderResults(); });
    }
    $("#producers-link").href = EXPLORER_PRODUCERS;
    $("#schedule").textContent = `Your time: new questions ${localHour(12)} Monday to Saturday, answers close ${localHour(0)}. Winners are final Tuesdays at ${localHour(12)}.`;
    renderAll();
    loadAds();
    renderBoard(S.week).then(() => renderPlay()).catch(() => {});
    ticker();
    setInterval(ticker, S.demo ? 3000 : 6000);
    setInterval(() => renderPlay(), 30000);
  }
  start();
})();

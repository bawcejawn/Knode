/* Knode website — a static page: everything is read from the Koinos chain and the bot's public
   question files (game-data/), and every action is signed by the player's own Kondor wallet.
   With no deployment yet (or ?demo in the address), it runs a preview on sample data. */
(() => {
  "use strict";

  const DAY = 28800;              // blocks per day
  const UNIT = 100000000n;        // 1 KOIN / 1 VHP = 10^8 units
  const RPC = "https://api.koinos.io";
  // Block explorer links (change here if the explorer's address format differs).
  const EXPLORER_ADDRESS = "https://koinosscan.com/address/";
  const EXPLORER_PRODUCERS = "https://koinosscan.com/producers";
  const BASE = location.pathname.includes("/site/") ? "../" : "./";
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
  /** Question text with every Koinos address turned into an explorer link (full address, easy to look up). */
  const linkify = (text) => {
    const out = [];
    let last = 0;
    for (const m of String(text).matchAll(/1[1-9A-HJ-NP-Za-km-z]{25,34}/g)) {
      out.push(text.slice(last, m.index));
      out.push(el("a", { href: EXPLORER_ADDRESS + m[0], target: "_blank", rel: "noopener", class: "addr-link", title: "Open this producer on the block explorer" }, m[0]));
      last = m.index + m[0].length;
    }
    out.push(text.slice(last));
    return out;
  };

  /** A UTC hour of the day shown in the viewer's own time zone, e.g. "8:00 AM". */
  const localHour = (utcHour) => { const d = new Date(); d.setUTCHours(utcHour, 0, 0, 0); return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); };
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
  function route() {
    const view = (location.hash || "#play").slice(1);
    const known = ["play", "leaderboard", "results", "how"];
    const v = known.includes(view) ? view : "play";
    document.querySelectorAll(".view").forEach((s) => (s.hidden = s.dataset.view !== v));
    document.querySelectorAll(".tabs a").forEach((a) => { if (a.dataset.view === v) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
    if (v === "leaderboard") renderBoard();
    if (v === "results") renderResults();
    window.scrollTo({ top: 0 });
  }
  window.addEventListener("hashchange", route);

  // ═══════════════ reading the game ═══════════════
  async function read(method, args = {}) {
    const { result } = await S.game.functions[method](args);
    return result || {};
  }

  async function loadQuestions() {
    const idx = await fetchJson(DATA + "index.json").catch(() => ({ days: [] }));
    const files = await Promise.all((idx.days || []).slice(-21).map((f) => fetchJson(DATA + f).then((d) => ({ f, d })).catch(() => null)));
    S.files = files.filter(Boolean);
    S.questions = S.files.flatMap(({ f, d }) => (d.questions || []).filter((q) => q.chainId !== undefined).map((q) => ({ ...q, file: f })));
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
    const fin = num(S.st.totals?.weeks_finalized);
    const claims = [];
    for (let w = Math.max(0, fin - 6); w < fin; w++) {
      const [p, wk] = await Promise.all([read("get_player", { player: a, week: String(w) }), read("get_week", { week: String(w) })]);
      const e = p.entry, W = wk.week || {};
      if (!e || !e.eligible || e.claimed || W.rolled_over || num(e.points) < num(W.cutoff)) continue;
      let est = null;
      try {
        if (!S.board[w]) S.board[w] = await loadBoard(w);
        const me = S.board[w].scored.find((x) => x.address === a);
        if (me && me.reward !== undefined) est = me.reward;
      } catch {}
      claims.push({ week: w, reward: est ?? 0n });
    }
    S.claims = claims;
  }

  // ═══════════════ scoring (same rules as the contract) ═══════════════
  function score(rows, outcomes) {
    const scored = rows.map((r) => {
      let pts = 0, counted = 0;
      if (!r.voided) for (const a of r.answers || []) {
        const o = outcomes.get(num(a.question_id));
        if (!o || o === 1000) continue;
        counted++;
        if (o === num(a.option) + 1) pts++;
      }
      return { ...r, pts, counted, eligible: !r.voided && counted > 1 && r.stake >= UNIT };
    }).sort((x, y) => y.pts - x.pts || (y.stake > x.stake ? 1 : y.stake < x.stake ? -1 : 0));
    const elig = scored.filter((s) => s.eligible);
    const total = elig.reduce((s, x) => s + x.stake, 0n);
    // Winners: the top 30% of staked, eligible players by points (headcount), ties included; 0 points never wins.
    const need = Math.ceil((elig.length * 30) / 100);
    let cutoff = 0, cum = 0;
    const maxP = Math.max(0, ...elig.map((s) => s.pts));
    if (need > 0) for (let p = maxP; p >= 1; p--) { cum += elig.filter((s) => s.pts === p).length; cutoff = p; if (cum >= need) break; }
    // Rank weights 1/√rank; players tied share their places' weights evenly.
    const groups = new Map();
    let rank = 1n, sumW = 0n, bw = 0n;
    if (cutoff >= 1) for (let p = maxP; p >= cutoff; p--) {
      const members = elig.filter((s) => s.pts === p);
      if (!members.length) continue;
      let gw = 0n;
      for (let i = 0; i < members.length; i++) { gw += rankWeight(rank); rank++; }
      const stake = members.reduce((a, x) => a + x.stake, 0n);
      groups.set(p, { n: BigInt(members.length), sumW: gw });
      sumW += gw;
      bw += (gw * stake) / BigInt(members.length);
    }
    for (const s of scored) {
      s.winner = s.eligible && cutoff >= 1 && s.pts >= cutoff;
      s.group = s.winner ? groups.get(s.pts) : null;
    }
    return { scored, cutoff, total, sumW, bw };
  }

  /** Fill in each winner's reward for pots A and B (exactly the contract's arithmetic, rounded down). */
  function applyPots(board, potA, potB) {
    for (const s of board.scored) {
      if (!s.winner || !s.group) { s.reward = undefined; continue; }
      const g = s.group;
      let r = board.sumW > 0n ? (potA * g.sumW) / (g.n * board.sumW) : 0n;
      if (board.bw > 0n) r += (potB * ((g.sumW * s.stake) / g.n)) / board.bw;
      s.reward = r;
    }
  }

  /** This week's pots if it closed now: 5% fee off new earnings, then 65% of the house's part by rank, the rest by
   *  rank × stake. An estimate (the real split weighs who produced what over the whole week). */
  function livePots() {
    const t = S.st?.totals || {};
    const holdings = big(S.st?.vhp_balance) + big(S.st?.koin_balance);
    const owed = ["total_stake", "seed_vhp", "seed_koin", "owner_share", "creator_fee", "pots_outstanding"].reduce((a, k) => a + big(t[k]), 0n);
    const gain = holdings > owed ? holdings - owed : 0n;
    const carried = big(t.rolled_over) < gain ? big(t.rolled_over) : gain;
    const fresh = gain - carried, net = fresh - (fresh * 500n) / 10000n;
    const house = big(t.seed_vhp) + big(t.pots_outstanding) + big(t.rolled_over), all = house + big(t.total_stake);
    const houseNet = (all > 0n ? (net * house) / all : net) + carried;
    const potA = (houseNet * 6500n) / 10000n;
    return { potA, potB: net + carried - potA };
  }

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
    const res = score(rows, outcomes);
    if (week < num(S.st.totals?.weeks_finalized)) {
      res.final = (await read("get_week", { week: String(week) })).week || {};
      applyPots(res, big(res.final.pot_a), big(res.final.pot_b));
    } else if (week === S.week) {
      const lp = livePots(); applyPots(res, lp.potA, lp.potB); res.estimate = true;
    }
    return res;
  }

  // ═══════════════ wallet (Kondor) ═══════════════
  const withTimeout = (p, ms, msg) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);

  async function connect() {
    if (S.demo) {
      S.account = "1DemoP1ayerXXXXXXXXXXXXXXXXXXXXXX";
      demoPlayer();
      renderAll();
      renderBoard(S.week).then(renderPlay);
      toast("Demo wallet connected");
      return;
    }
    if (!window.kondor) return toast("Kondor didn't load. Refresh the page and try again.");
    try {
      const accounts = await withTimeout(window.kondor.getAccounts(), 15000, "No answer from Kondor. Is the Kondor extension installed and unlocked?");
      if (!accounts || !accounts.length) return toast("Kondor shared no account. Open Kondor and allow this site.");
      S.account = accounts[0].address;
      toast(`Connected ${short(S.account)}`);
      await loadPlayer();
      S.board = {};
      renderAll();
      renderBoard(S.week).then(renderPlay).catch(() => {});
    } catch (e) { toast(e.message || String(e), 7000); }
  }

  function writer() {
    const signer = window.kondor.getSigner(S.account);
    return new lib.Contract({ id: S.dep.contract, abi: S.abi, provider: S.provider, signer });
  }

  /** Send one or more operations in one transaction, signed in Kondor. */
  async function send(label, build) {
    if (S.demo) { toast(`Demo: this would open Kondor to confirm “${label}”.`); return false; }
    if (!S.account) { await connect(); if (!S.account) return false; }
    try {
      toast(`Confirm “${label}” in Kondor…`, 20000);
      const signer = window.kondor.getSigner(S.account);
      try { signer.provider = S.provider; } catch {}
      const tx = new lib.Transaction({ signer, provider: S.provider });
      for (const op of await build()) await tx.pushOperation(op);
      const receipt = await tx.send();
      if (receipt && receipt.reverted) throw new Error(JSON.stringify(receipt.logs || "the contract refused it"));
      // Sent. Watch for it with our own connection to the chain (Kondor's own "wait" needs a provider it may not have).
      toast("Sent. Waiting for the next block…", 30000);
      const id = tx.transaction && tx.transaction.id;
      let confirmed = false;
      if (id) { try { await S.provider.wait(id, "byBlock", 90000); confirmed = true; } catch {} }
      toast(confirmed ? `Done: ${label}` : `Sent: ${label}. It may take a minute to show; the page refreshes by itself.`, 8000);
      await loadLive().catch(() => {});
      renderAll();
      return true;
    } catch (e) {
      const msg = String(e.message || e);
      toast(/reject|denied|cancel/i.test(msg) ? "Cancelled in Kondor." : `Not sent: ${friendlyError(msg)}`, 8000);
      return false;
    }
  }
  const opOf = async (contract, fn, args) => (await contract.functions[fn](args, { onlyOperation: true })).operation;

  function friendlyError(msg) {
    const m = msg.match(/"([^"]{6,140})"/);
    const text = m ? m[1] : msg;
    if (/insufficient|mana|rc/i.test(text)) return "not enough Mana. Tick Kondor's free Mana option, or wait for your Mana to refill.";
    return text.slice(0, 160);
  }

  const answer = (q, option) => send(`answer ${String.fromCharCode(65 + option)}`, async () => [
    await opOf(writer(), "answer", { player: S.account, question_id: q.chainId, option }),
  ]);

  const claim = (week) => send(`collect week ${week + 1} reward`, async () => [
    await opOf(writer(), "claim", { player: S.account, week: String(week) }),
  ]);

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
  function fillSlot(slot) {
    fillAd(slot);
    if (!slot.classList.contains("ad-filled")) { const h = nextHouse(); if (h) houseAd(slot, h); }
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
    const eco = (ADS.ecosystem || []).concat(f ? [f] : []).filter((h) => h && h.name && httpsUrl(h.link));
    if (eco.length) {
      $("#eco-grid").replaceChildren(...eco.map((h) => el("a", { href: httpsUrl(h.link), target: "_blank", rel: "noopener", class: "eco-item" }, el("b", {}, h.name), el("span", {}, h.tagline))));
      document.querySelector(".eco").hidden = false;
    }
  }

  // ═══════════════ stake dialog ═══════════════
  function openStake(mode) {
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
    const a = (S.entry?.answers || []).find((x) => num(x.question_id) === q.chainId);
    return a ? num(a.option) : null;
  }
  const outcomeOf = (q) => (q.chainOutcome !== undefined ? q.chainOutcome : q.result ? (q.result.void ? 1000 : q.result.option + 1) : 0);

  function questionCard(q, mode) {
    const mine = myAnswer(q);
    const oc = outcomeOf(q);
    const left = q.lockTime - nowMs();
    const top = el("div", { class: "q-top" },
      el("span", { class: `tier tier-${q.tier || "Medium"}` }, q.tier || "Question"),
      mode === "open" ? el("span", { class: `timer${left < 3600000 ? " soon" : ""}`, title: `Answers close ${new Date(q.lockTime).toLocaleString()}` }, `Closes in ${duration(left)}`)
        : oc === 1000 ? el("span", { class: "badge badge-void" }, "Voided")
        : oc ? (mine === null ? el("span", { class: "badge badge-wait" }, "Resolved") : mine + 1 === oc ? el("span", { class: "badge badge-ok" }, "+1 point") : el("span", { class: "badge badge-miss" }, "No point"))
        : el("span", { class: "badge badge-wait" }, `Result in ~${duration((q.windowEnd + 60 - S.height) * BLOCK_MS)}`));
    const opts = el("div", { class: "opts" }, q.options.map((o) => {
      let cls = "opt";
      if (mine === o.index) cls += " picked";
      if (oc && oc !== 1000 && oc === o.index + 1) cls += " correct";
      else if (oc && oc !== 1000 && mine === o.index) cls += " wrong";
      const canAnswer = mode === "open" && mine === null;
      return el("button", {
        class: cls, type: "button", disabled: !canAnswer,
        "aria-label": `Option ${String.fromCharCode(65 + o.index)}: ${o.label}`,
        onclick: () => answer(q, o.index),
      }, el("span", { class: "letter" }, String.fromCharCode(65 + o.index)), el("span", {}, o.label));
    }));
    const foot = el("div", { class: "q-foot" },
      el("span", {}, `Question #${q.chainId}`),
      mine !== null ? el("span", {}, `Your answer: ${String.fromCharCode(65 + mine)}`) : mode === "open" ? el("span", {}, S.account ? "Pick an option" : "Connect Kondor to answer") : null,
      q.result && q.result.value ? el("span", {}, `Actual: ${q.result.value}`) : null);
    return el("article", { class: "q" }, top, el("h3", {}, ...linkify(q.text)), opts, foot);
  }

  function renderPlay() {
    const st = S.st || {};
    const t = st.totals || {};
    const now = nowMs();
    $("#week-pill").textContent = now < S.genesis ? "The game starts Monday" : `Week ${S.week + 1}`;
    $("#stat-ends").textContent = duration((now < S.genesis ? S.genesis : S.weekEnd) - now);
    $("#stat-ends").nextElementSibling.textContent = now < S.genesis ? "until the first week starts" : "until the week ends";
    const holdings = big(st.vhp_balance) + big(st.koin_balance);
    const owed = ["total_stake", "seed_vhp", "seed_koin", "owner_share", "creator_fee", "pots_outstanding"].reduce((s, k) => s + big(t[k]), 0n);
    const earned = holdings > owed ? holdings - owed : 0n;
    // 95% of new earnings go to the winners; a pot carried over from a week with no winners is added in full.
    const carried = big(t.rolled_over) < earned ? big(t.rolled_over) : earned;
    $("#stat-pot").textContent = `${amount(carried + ((earned - carried) * 95n) / 100n)} VHP`;
    $("#stat-players").textContent = S.boardWeek === S.week && S.board[S.week] ? String(S.board[S.week].scored.length) : "…";

    const open = S.questions.filter((q) => now < q.lockTime).sort((a, b) => a.lockTime - b.lockTime);
    const locked = S.questions.filter((q) => now >= q.lockTime && !outcomeOf(q)).sort((a, b) => a.windowEnd - b.windowEnd);
    const oq = $("#open-questions");
    oq.replaceChildren(...(open.length ? open.map((q) => questionCard(q, "open")) : [el("div", { class: "empty" }, `No open questions right now. New questions arrive Monday to Saturday at ${localHour(12)} your time.`)]));
    // (In-page ad slots are switched off for now. To bring one back, add an element with data-ad-slot="…" to the page;
    // loadAds() fills it from site/ads.json.)
    $("#locked-questions").replaceChildren(...(locked.length ? locked.map((q) => questionCard(q, "locked")) : [el("div", { class: "empty" }, "Nothing waiting. Answered questions show up here until their result is in.")]));

    // you
    const you = $("#you-body");
    if (!S.account) {
      you.replaceChildren(el("p", { class: "muted" }, "Connect Kondor to stake and answer. Answering is free with Kondor's free Mana."),
        el("div", { class: "row-btns" }, el("button", { class: "btn btn-primary", type: "button", onclick: connect }, "Connect Kondor")));
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
            el("dd", {}, pts.winner && pts.reward !== undefined ? `~${amount(pts.reward)} VHP` : !pts.eligible ? "needs 1 VHP + 2 answers" : "not in the top 30% yet")] : []),
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
      el("span", {}, el("b", {}, `${amount(c.reward)} VHP`), el("br"), el("span", { class: "muted" }, `Week ${c.week + 1}`)),
      el("button", { class: "btn btn-sun", type: "button", onclick: () => claim(c.week) }, "Collect"))));
    // pool
    $("#pool-facts").replaceChildren(
      el("dt", {}, "Players' stake"), el("dd", {}, `${amount(t.total_stake, 0)} VHP`),
      el("dt", {}, "Seed VHP (never plays)"), el("dd", {}, `${amount(t.seed_vhp, 0)} VHP`),
      el("dt", {}, "Earned this week"), el("dd", {}, `${amount(earned)} VHP`),
      el("dt", {}, "Winners get"), el("dd", {}, "95%"),
      el("dt", {}, "Waiting to be collected"), el("dd", {}, `${amount(t.pots_outstanding)} VHP`));
    const btn = $("#connect");
    btn.textContent = S.account ? short(S.account) : "Connect Kondor";
    btn.classList.toggle("connected", !!S.account);
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
    if (!S.board[week]) {
      tbody.replaceChildren(el("tr", {}, el("td", { colspan: "5", class: "muted" }, "Loading…")));
      try { S.board[week] = await loadBoard(week); } catch (e) { tbody.replaceChildren(el("tr", {}, el("td", { colspan: "5", class: "muted" }, `Couldn't load: ${e.message}`))); return; }
    }
    S.boardWeek = week;
    const b = S.board[week];
    // Everyone who answered is listed. Free players (no stake) score points but are never paid.
    const rows = b.scored.filter((s) => s.counted > 0 || s.address === S.account);
    if (!rows.length) { tbody.replaceChildren(el("tr", {}, el("td", { colspan: "5", class: "muted" }, "No players yet this week. Stake and answer to be the first."))); return; }
    let lastWinnerIdx = -1;
    rows.forEach((s, i) => { if (s.winner) lastWinnerIdx = i; });
    // Places are counted among eligible staked players only (free players never take a place).
    let place = 0;
    const placeOf = new Map(rows.map((s) => [s, s.eligible ? ++place : null]));
    tbody.replaceChildren(...rows.map((s, i) => el("tr", { class: [s.address === S.account ? "me" : "", i === lastWinnerIdx ? "cutline" : ""].join(" ").trim() },
      el("td", {}, el("span", { class: `rank${s.winner ? " top" : ""}` }, placeOf.get(s) ? String(placeOf.get(s)) : "–")),
      el("td", {}, el("span", { class: "addr" }, s.address === S.account ? "You" : short(s.address)), i === lastWinnerIdx ? el("span", { class: "cut-label" }, "winners' line") : null),
      el("td", { class: "num" }, String(s.pts)),
      el("td", { class: "num" }, s.stake < UNIT ? el("span", { class: "badge badge-free" }, "Free play") : `${amount(s.stake, 0)} VHP`),
      el("td", { class: "num" }, s.winner && s.reward !== undefined ? `${b.estimate ? "~" : ""}${amount(s.reward)} VHP` : "–"))));
    $("#lb-note").textContent = week === S.week
      ? "Live standings: points count as soon as each question's blocks are final. The top 30% of staked players win (ties too). Rewards shown with ~ are estimates if the week ended now."
      : b.final ? `Final: ${num(b.final.winners)} winner(s) at ${num(b.final.cutoff)}+ points shared ${amount(b.final.pot)} VHP.` : "Final standings.";
    if (week === S.week) $("#stat-players").textContent = String(b.scored.length);
  }

  function renderResults() {
    const groups = S.files.slice().reverse().map(({ f, d }) => ({ f, d, qs: (d.questions || []).filter((q) => q.result && q.chainId !== undefined && S.height > q.windowEnd) })).filter((g) => g.qs.length);
    const list = $("#results-list");
    if (!groups.length) { list.replaceChildren(el("div", { class: "empty" }, "No results yet. The first ones arrive a few hours after the first questions close.")); return; }
    list.replaceChildren(...groups.map((g) => el("section", { class: "day-group" },
      el("h2", {}, `Week ${num(g.d.week) + 1}, day ${g.d.day}`),
      g.qs.map((q) => el("div", { class: "res" },
        el("p", {}, q.text),
        el("span", { class: "ans" }, q.result.void ? el("span", { class: "badge badge-void" }, "Voided") : `${String.fromCharCode(65 + q.result.option)}: ${q.options[q.result.option].label}`),
        el("span", { class: "meta" }, q.result.void ? `Reason: ${q.result.reason || "a producer went offline"}. ` : `Actual: ${q.result.value}. `,
          `Blocks ${q.windowStart.toLocaleString()}–${q.windowEnd.toLocaleString()}. Fingerprint ${String(q.result.dataHash || "").slice(0, 16)}… `,
          S.demo ? null : el("a", { href: DATA + g.f }, "full data")))))));
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
    }, el("span", { class: "cube", "aria-hidden": "true" }), el("span", { class: "who" }, b.signer === S.dep?.contract ? "Knode pool" : short(b.signer)), el("span", { class: "h" }, `#${b.h.toLocaleString()}`))));
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
    S.height = last - 9000;
    // Demo clock: "now" is 15:00 UTC on a Saturday, so Saturday's questions are open until 00:00 UTC.
    const sat = new Date(); sat.setUTCDate(sat.getUTCDate() + ((6 - sat.getUTCDay() + 7) % 7)); sat.setUTCHours(15, 0, 0, 0);
    S.chainTime = sat.getTime(); S.seenAt = Date.now();
    S.genesis = 0; S.week = 2; S.weekEnd = S.chainTime + 33 * 3600000;
    const lockOf = (q) => (q.lockHeight === last ? S.chainTime + 9 * 3600000 : S.chainTime + (q.lockHeight - S.height) * BLOCK_MS);
    S.dep = { contract: DEMO_PRODUCERS[4] };
    S.questions = qs.map((q) => ({ ...q, lockTime: lockOf(q), chainOutcome: q.result && q.windowEnd + 60 < S.height ? (q.result.void ? 1000 : q.result.option + 1) : undefined, result: q.windowEnd + 60 < S.height ? q.result : null }));
    S.files = [...new Set(qs.map((q) => q.day))].map((d) => ({ f: `W002-D${d}.json`, d: { week: 2, day: d, questions: S.questions.filter((q) => q.day === d) } }));
    S.st = { totals: { total_stake: String(48250n * UNIT), seed_vhp: String(170000n * UNIT), seed_koin: String(20000n * UNIT), pots_outstanding: String(1203n * UNIT), owner_share: "0", creator_fee: "0" },
      vhp_balance: String(218250n * UNIT + 1203n * UNIT), koin_balance: String(20000n * UNIT + 412n * UNIT) };
    S.claims = [];
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
    $("#connect").addEventListener("click", () => (S.account ? toast(`Connected as ${S.account}`) : connect()));
    route();
    const wantDemo = /[?&]demo\b/.test(location.search);
    let dep = null;
    if (!wantDemo) dep = await fetchJson(DATA + "deployment.json").catch(() => null);
    if (!dep || !dep.contract || !lib.Contract) {
      setupDemo();
    } else {
      S.dep = dep;
      S.abi = await fetchJson(ABI_URL);
      S.provider = new lib.Provider([dep.rpc || RPC]);
      S.game = new lib.Contract({ id: dep.contract, abi: S.abi, provider: S.provider });
      try { await loadLive(); } catch (e) { toast(`Couldn't reach the Koinos network: ${e.message}`, 8000); }
      setInterval(async () => { try { await loadLive(); S.board[S.week] = undefined; renderPlay(); } catch {} }, 60000);
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

/* mana.html: Mana levels. Read-only: it reads a wallet's KOIN balance and Mana from the chain and shows a recharging
   gauge. Nothing here signs or sends a transaction; "Use my wallet" only asks the wallet for its address.

   How Koinos Mana works (what the math below assumes):
   - A wallet's most Mana = its KOIN balance (1 KOIN = 1 Mana, 8 decimals).
   - Used Mana comes back at a steady rate: an empty tank is full again after 5 days (MANA_REGEN_MS).
   - chain.get_account_rc gives the Mana available right now (already recharged up to the head block). */
(() => {
  "use strict";
  const UNIT = 100000000n;                 // 8 decimals
  const MANA_REGEN_MS = 432000000n;        // 5 days, the Koinos chain's Mana regeneration time
  const ANSWER_MANA = 35000000n;           // ≈0.35 Mana per game answer (measured on mainnet), for the "about N" line

  /** The gauge at time `at` (ms), from one chain reading taken at `t0`: koin and mana in units (BigInt). */
  function gauge({ koin, mana, t0, at = t0 }) {
    const max = koin > 0n ? koin : 0n;
    let start = mana < 0n ? 0n : mana > max ? max : mana;
    const dt = BigInt(Math.max(0, Math.floor(at - t0)));
    let now = max === 0n ? 0n : start + (max * dt) / MANA_REGEN_MS;
    if (now > max) now = max;
    const perHour = (max * 3600000n) / MANA_REGEN_MS;
    const perDay = (max * 86400000n) / MANA_REGEN_MS;
    // Time until full: (missing Mana) ÷ (Mana per ms), rounded up.
    const missing = max - now;
    const msToFull = max === 0n || missing === 0n ? 0 : Number((missing * MANA_REGEN_MS + max - 1n) / max);
    const pct = max === 0n ? 0 : Number((now * 10000n) / max) / 100;
    return { max, now, perHour, perDay, msToFull, pct, full: max > 0n && missing === 0n, empty: max === 0n };
  }
  /** About how many game answers this much Mana pays for. */
  const answersFor = (mana) => (mana > 0n ? mana / ANSWER_MANA : 0n);
  window.KManaMath = { gauge, answersFor, UNIT, MANA_REGEN_MS, ANSWER_MANA };

  if (typeof document === "undefined" || !document.getElementById("addr")) return;   // loaded by a test

  const lib = window.koilib || window.koinos || window;
  const RPC = "https://api.koinos.io";
  const KOIN = "19GYjDBVXU7keLbYvMLazsGQn3GTWHjHkK";
  const SPONSOR = "1ByDDSBUzy5zkRceELc54Jh8i41yNRoKt8";
  const EXPLORER = "https://koinosscan.com/address/";
  const LAST = "ml-last";                  // the last address checked here (this browser only)

  const ADDR = { type: "bytes", options: { "(koinos.btype)": "ADDRESS" } };
  const U64 = { type: "uint64", options: { jstype: "JS_STRING" } };
  const types = { nested: { t: { nested: {
    balance_of_arguments: { fields: { owner: { ...ADDR, id: 1 } } },
    balance_of_result: { fields: { value: { ...U64, id: 1 } } },
    empty: { fields: {} },
    usage: { fields: { day: { ...U64, id: 1 }, used_day: { ...U64, id: 2 }, week: { ...U64, id: 3 }, used_week: { ...U64, id: 4 } } },
    config: { fields: {
      enabled: { type: "bool", id: 1 },
      max_mana_per_tx: { ...U64, id: 5 }, max_mana_per_account_day: { ...U64, id: 6 }, max_mana_per_account_week: { ...U64, id: 7 },
      max_mana_per_day: { ...U64, id: 8 }, min_vhp: { ...U64, id: 10 }, max_mana_free_day: { ...U64, id: 11 } } },
  } } } };
  const provider = new lib.Provider([RPC]);
  const koin = new lib.Contract({ id: KOIN, provider, abi: { methods: {
    balance_of: { entry_point: 0x5c721497, argument: "t.balance_of_arguments", return: "t.balance_of_result", read_only: true },
  }, koilib_types: types } });
  const sponsor = new lib.Contract({ id: SPONSOR, provider, abi: { methods: {
    get_config: { entry_point: 0xbc4fcdd4, argument: "t.empty", return: "t.config", read_only: true },
    get_total_usage: { entry_point: 0x49cdf951, argument: "t.empty", return: "t.usage", read_only: true },
    get_free_usage: { entry_point: 0x73b615e1, argument: "t.empty", return: "t.usage", read_only: true },
  }, koilib_types: types } });

  // ── helpers ──
  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const say = (t, bad = false) => { $("msg").textContent = t; $("msg").classList.toggle("bad", bad); };
  /** Mana/KOIN units → "1,234.56" (2 decimals; 4 below 1). */
  function show(u) {
    const n = Number(u) / 1e8;
    const d = n !== 0 && Math.abs(n) < 1 ? 4 : 2;
    return n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: d });
  }
  function dur(ms) {
    const m = Math.ceil(ms / 60000);
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60), mm = m % 60;
    if (h < 24) return mm ? `${h} h ${mm} min` : `${h} h`;
    const d = Math.floor(h / 24), hh = h % 24;
    return hh ? `${d} d ${hh} h` : `${d} d`;
  }
  const when = (t) => new Date(t).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
  const isAddr = (a) => { if (!/^1[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a)) return false; try { return lib.utils.isChecksumAddress(a); } catch { return false; } };
  const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };

  /** One chain read with one retry (public nodes sometimes refuse a burst). */
  async function retry(fn) { try { return await fn(); } catch { await sleep(900); return fn(); } }
  async function readWallet(addr) {
    const [bal, rc] = await Promise.all([
      retry(() => koin.functions.balance_of({ owner: addr })),
      retry(() => provider.getAccountRc(addr)),
    ]);
    return { koin: BigInt((bal.result || {}).value || "0"), mana: BigInt(rc || "0"), t0: Date.now() };
  }

  /** Draw one gauge (prefix "r" = the looked-up wallet, "s" = the sponsor). */
  function draw(p, g) {
    const fill = $(`${p}-fill`);
    fill.style.width = `${g.pct}%`;
    fill.classList.toggle("low", g.pct < 20);
    fill.classList.toggle("mid", g.pct >= 20 && g.pct < 50);
    fill.classList.toggle("charging", !g.full && !g.empty);
    $(`${p}-meter`).setAttribute("aria-valuenow", String(Math.round(g.pct)));
    $(`${p}-pct`).textContent = g.empty ? "No KOIN" : `${g.pct.toFixed(g.pct < 10 && !g.full ? 1 : 0)}%`;
    $(`${p}-now`).textContent = show(g.now);
    $(`${p}-max`).textContent = g.empty ? "Tank size 0" : `of ${show(g.max)} (its KOIN)`;
  }

  // ── the looked-up wallet ──
  let cur = null;        // { addr, koin, mana, t0 }
  let busy = false;
  function render() {
    if (!cur) return;
    const g = gauge({ ...cur, at: Date.now() });
    draw("r", g);
    $("r-hour").textContent = `+${show(g.perHour)}`;
    $("r-day").textContent = `+${show(g.perDay)}`;
    if (g.empty) {
      $("r-status").textContent = "This wallet holds no KOIN, so it has no Mana of its own.";
      $("r-full").textContent = "–"; $("r-full-in").textContent = "";
      $("r-uses").textContent = "Knode's sponsor (below) can still pay for its game answers.";
      return;
    }
    if (g.full) { $("r-full").textContent = "Now"; $("r-full-in").textContent = "The tank is full"; $("r-status").textContent = "Full tank."; }
    else {
      $("r-full").textContent = when(Date.now() + g.msToFull);
      $("r-full-in").textContent = `in ${dur(g.msToFull)}`;
      $("r-status").textContent = `Charging: +${show(g.perHour)} Mana every hour.`;
    }
    $("r-uses").textContent = `Enough for about ${answersFor(g.now).toLocaleString()} game answers right now. Figures are live and tick up as Mana recharges.`;
  }
  async function check(addr, { quiet = false } = {}) {
    addr = String(addr || "").trim();
    if (!addr) return say("Enter a wallet address.", true);
    if (!isAddr(addr)) return say("That isn't a Koinos address. It starts with 1 and is 26–35 letters and numbers; copy it again.", true);
    if (busy) return;
    busy = true; $("check").disabled = true;
    if (!quiet) say("Reading the chain…");
    try {
      cur = { addr, ...(await readWallet(addr)) };
      $("addr").value = addr;
      $("result").hidden = false;
      $("r-addr").textContent = "";
      const a = document.createElement("a");
      a.href = EXPLORER + addr; a.target = "_blank"; a.rel = "noopener noreferrer"; a.textContent = addr;
      $("r-addr").append(a, addr === SPONSOR ? " · Knode's Mana sponsor" : "");
      render();
      store.set(LAST, addr);
      const url = new URL(location.href); url.searchParams.set("addr", addr); url.hash = "";
      history.replaceState(null, "", url.pathname + url.search);
      $("copy").disabled = false;
      say(quiet ? "" : "Updated just now.");
    } catch (e) {
      say("Couldn't reach the Koinos network. Check your connection and try again in a moment.", true);
    } finally { busy = false; $("check").disabled = false; }
  }

  // ── the sponsor spotlight ──
  let sp = null;         // { koin, mana, t0 }
  async function readSponsor() {
    try { sp = await readWallet(SPONSOR); }
    catch { $("s-status").textContent = "Couldn't read the sponsor right now."; return; }
    renderSponsor();
    try {
      const [cfg, total, free] = await Promise.all([
        retry(() => sponsor.functions.get_config({})), retry(() => sponsor.functions.get_total_usage({})), retry(() => sponsor.functions.get_free_usage({})),
      ]);
      const c = cfg.result || {};
      const today = String(Math.floor(Date.now() / 86400000));   // the sponsor counts by UTC day
      const usedOf = (u) => (u && u.result && u.result.day === today ? BigInt(u.result.used_day || "0") : 0n);
      const meter = (box, lab, bar, used, cap) => {
        if (!(cap > 0n)) return;
        $(box).hidden = false;
        $(lab).textContent = `${show(used)} of ${show(cap)} Mana`;
        $(bar).style.width = `${Math.min(100, Number((used * 10000n) / cap) / 100)}%`;
      };
      const cap = BigInt(c.max_mana_per_day || "0"), freeCap = BigInt(c.max_mana_free_day || "0"), used = usedOf(total);
      meter("s-budget", "s-used", "s-used-bar", used, cap);
      meter("s-freebudget", "s-free", "s-free-bar", usedOf(free), freeCap);
      if (!c.enabled) $("s-note").textContent = "The sponsor is switched off right now, so players pay with their own Mana.";
      else {
        let left = cap > used ? cap - used : 0n;
        const tank = gauge({ ...sp, at: Date.now() }).now;
        if (tank < left) left = tank;                       // can't pay out more Mana than it has right now
        $("s-note").textContent = `Daily budgets reset at 00:00 UTC. Per player: up to ${show(BigInt(c.max_mana_per_account_day || "0"))} Mana a day and ${show(BigInt(c.max_mana_per_account_week || "0"))} a week. About ${answersFor(left).toLocaleString()} more answers can be sponsored today.`;
      }
    } catch { $("s-note").textContent = "Couldn't read the sponsor's daily budget right now."; }
  }
  function renderSponsor() {
    if (!sp) return;
    const g = gauge({ ...sp, at: Date.now() });
    draw("s", g);
    $("s-day").textContent = `+${show(g.perDay)}`;
    $("s-hour").textContent = `+${show(g.perHour)} an hour`;
    $("s-status").textContent = g.empty ? "The sponsor holds no KOIN right now." : g.full ? "Full tank, ready to pay for players." : `Charging: full again ${when(Date.now() + g.msToFull)} (in ${dur(g.msToFull)}).`;
  }
  $("s-open").onclick = () => { check(SPONSOR); window.scrollTo({ top: 0, behavior: "smooth" }); };

  // ── controls ──
  $("check").onclick = () => check($("addr").value);
  $("addr").addEventListener("keydown", (e) => { if (e.key === "Enter") check($("addr").value); });
  $("copy").onclick = async () => {
    try { await navigator.clipboard.writeText(location.href); say("Link copied. Anyone who opens it sees this wallet's gauge."); }
    catch { say("Copy the address bar to share this gauge."); }
  };

  // "Use my wallet": asks Kondor or KOIN Vault for the address only. Nothing is signed.
  const W = window.KWallet;
  W.init({ provider, toast: (t) => say(t, true), onChange: (addr) => { if (addr) check(addr); } });
  $("mine").onclick = async () => {
    if (W.address) return check(W.address);
    try { await W.connect(); } catch (e) { say(String(e.message || e), true); }
  };

  // ── start: a shared link first, then a Kondor wallet this site was already allowed to see, then the last check ──
  (async () => {
    const fromLink = new URLSearchParams(location.search).get("addr");
    if (fromLink) return check(fromLink);
    let kind = null; try { kind = localStorage.getItem("kw-kind"); } catch {}
    if (kind === "kondor" && window.kondor) {
      try {
        const accts = await Promise.race([window.kondor.getAccounts(), sleep(4000).then(() => null)]);
        if (accts && accts[0] && accts[0].address) return check(accts[0].address);
      } catch { /* fall through */ }
    }
    const last = store.get(LAST);
    if (last && isAddr(last)) return check(last);
    say("Enter an address, or tap Use my wallet.");
  })();
  readSponsor();

  // Live: the gauges tick every second; fresh chain readings every minute while the page is visible.
  setInterval(() => { render(); renderSponsor(); }, 1000);
  setInterval(() => {
    if (document.hidden) return;
    if (cur) check(cur.addr, { quiet: true });
    readSponsor();
  }, 60000);
})();

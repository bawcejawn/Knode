/* Knode Games Swap — swap VHP for the desk's KOIN, 1:1 minus the fee.
   A static page: it reads the desk contract on the Koinos chain, and the swap is signed by the visitor's own wallet (Kondor or KOIN Vault, see wallet.js)
   wallet as ONE transaction (approve the VHP + swap). With no desk deployed yet (or ?demo), it runs a preview. */
(() => {
  "use strict";

  const UNIT = 100000000n;            // 1 KOIN / 1 VHP = 10^8 units
  const RPC = "https://koinos.armana.io";
  const EXPLORER_ADDRESS = "https://koinosscan.com/address/";
  const BASE = "./";
  const DEPLOYMENT = BASE + "desk-data/deployment.json";
  const lib = window.koilib || window.koinos || window;

  // ── The parts of the desk contract this page uses. Entry points = first 4 bytes of sha256(name);
  //    `npm run check` in desk/ verifies they match the built contract's ABI.
  const addr = (id) => ({ type: "bytes", id, options: { "(koinos.btype)": "ADDRESS" } });
  const u64 = (id) => ({ type: "uint64", id, options: { jstype: "JS_STRING" } });
  const DESK_ABI = {
    methods: {
      get_state: { entry_point: 0x3d02a349, argument: "desk.get_state_arguments", return: "desk.get_state_result", read_only: true },
      quote: { entry_point: 0x6327245c, argument: "desk.quote_arguments", return: "desk.quote_result", read_only: true },
      get_recent: { entry_point: 0x3cc6b02a, argument: "desk.get_recent_arguments", return: "desk.get_recent_result", read_only: true },
      swap: { entry_point: 0xda47c2f4, argument: "desk.swap_arguments", return: "desk.swap_result", read_only: false },
    },
    koilib_types: { nested: { desk: { nested: {
      config_object: { fields: { owner: addr(1), treasury: addr(2), fee_bps: { type: "uint32", id: 3 }, min_swap: u64(4), max_swap: u64(5), paused: { type: "bool", id: 6 }, timelock_length: u64(7) } },
      totals_object: { fields: { swaps: u64(1), vhp_in: u64(2), koin_out: u64(3), next_slot: { type: "uint32", id: 4 } } },
      swap_record: { fields: { account: addr(1), vhp_in: u64(2), koin_out: u64(3), time: u64(4) } },
      timelock_object: { fields: { hash: { type: "bytes", id: 1, options: { "(koinos.btype)": "HEX" } }, address: addr(2), eta: u64(3) } },
      get_state_arguments: { fields: {} },
      get_state_result: { fields: {
        config: { type: "config_object", id: 1 }, totals: { type: "totals_object", id: 2 }, koin_balance: u64(3), vhp_balance: u64(4),
        mana: u64(5), available: u64(6), max_vhp_in: u64(7), time: u64(8), upgrade: { type: "timelock_object", id: 9 }, treasury_change: { type: "timelock_object", id: 10 },
      } },
      quote_arguments: { fields: { vhp_amount: u64(1) } },
      quote_result: { fields: { koin_out: u64(1), fee: u64(2), problem: { type: "string", id: 3 } } },
      get_recent_arguments: { fields: {} },
      get_recent_result: { fields: { swaps: { rule: "repeated", type: "swap_record", id: 1 } } },
      swap_arguments: { fields: { from: addr(1), vhp_amount: u64(2), min_koin_out: u64(3) } },
      swap_result: { fields: { koin_out: u64(1), fee: u64(2) } },
    } } } },
  };
  const TOKEN_ABI = {
    methods: {
      balance_of: { entry_point: 0x5c721497, argument: "token.balance_of_arguments", return: "token.balance_of_result", read_only: true },
      approve: { entry_point: 0x74e21680, argument: "token.approve_arguments", return: "token.approve_result", read_only: false },
    },
    koilib_types: { nested: { token: { nested: {
      balance_of_arguments: { fields: { owner: addr(1) } },
      balance_of_result: { fields: { value: u64(1) } },
      approve_arguments: { fields: { owner: addr(1), spender: addr(2), value: u64(3) } },
      approve_result: { fields: {} },
    } } } },
  };

  const S = { demo: false, dep: null, provider: null, desk: null, st: null, firstAvail: null, account: null, vhp: null, recent: [] };

  // ═══════════════ helpers ═══════════════
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
  const amount = (units, max = 2) => {
    const v = Number(big(units)) / 1e8;
    return v.toLocaleString("en-US", { maximumFractionDigits: v !== 0 && Math.abs(v) < 1 ? 4 : max });
  };
  /** Every decimal, nothing rounded. */
  const exact = (units) => {
    const v = big(units), w = v / UNIT, f = (v % UNIT).toString().padStart(8, "0").replace(/0+$/, "");
    return f ? `${w}.${f}` : `${w}`;
  };
  /** "12.5" → 1250000000n, or null if not a valid amount (up to 8 decimals). */
  const toUnits = (text) => {
    const m = String(text).trim().replace(/,/g, "").match(/^(\d*)(?:\.(\d{0,8}))?$/);
    if (!m || (!m[1] && !m[2])) return null;
    return BigInt(m[1] || "0") * UNIT + BigInt((m[2] || "").padEnd(8, "0"));
  };
  const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
  const ago = (ms) => {
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 90) return "just now";
    if (s < 5400) return `${Math.round(s / 60)} min ago`;
    if (s < 129600) return `${Math.round(s / 3600)} h ago`;
    return `${Math.round(s / 86400)} days ago`;
  };
  let toastTimer = 0;
  const toast = (msg, ms = 4200) => {
    const t = $("#toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), ms);
  };
  const fetchJson = async (url) => { const r = await fetch(url, { cache: "no-store" }); if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.json(); };
  const withTimeout = (p, ms, msg) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);

  /** The fee exactly as the contract computes it: rounded up to the smallest unit. */
  const feeOf = (units, bps) => (units * BigInt(bps) + 9999n) / 10000n;
  const feeBps = () => Number(S.st?.config?.fee_bps ?? 300);

  // ═══════════════ reading the desk ═══════════════
  async function read(method, args = {}) {
    const { result } = await S.desk.functions[method](args);
    return result || {};
  }

  async function loadLive() {
    if (S.demo) { demoTick(); return; }
    const [st, rec] = await Promise.all([read("get_state"), read("get_recent")]);
    S.st = st;
    S.recent = rec.swaps || [];
    if (S.firstAvail === null) S.firstAvail = big(st.available);
    if (S.account) await loadBalance();
  }

  async function loadBalance() {
    if (S.demo) return;
    const tok = new lib.Contract({ id: S.dep.vhp, abi: TOKEN_ABI, provider: S.provider });
    S.vhp = big(((await tok.functions.balance_of({ owner: S.account })).result || {}).value);
  }

  // ═══════════════ wallet ═══════════════
  async function connect() {
    if (S.demo) {
      S.account = "1DemoSwapperXXXXXXXXXXXXXXXXXXXXX";
      S.vhp = 1250n * UNIT;
      toast("Demo wallet connected");
      renderAll();
      return;
    }
    if (!window.KWallet) return toast("The wallet code didn't load. Refresh the page and try again.");
    await window.KWallet.connect(); // onChange (in start) picks up the address
  }

  function friendlyError(msg) {
    const m = msg.match(/"([^"]{6,160})"/);
    const text = m ? m[1] : msg;
    if (/insufficient\s*(rc|mana|resources?)|\bmana\b|\brc[_ ]?limit\b|out of rc/i.test(text)) return `not enough Mana. The free Mana may be used up for today; in KOIN Vault, hold a little KOIN; or wait for Mana to refill. (${text.slice(0, 90)})`;
    return text.slice(0, 180);
  }

  // ═══════════════ the quote ═══════════════
  /** Works out the swap for the typed amount, exactly as the contract will. */
  function quote() {
    const units = toUnits($("#amount").value);
    const st = S.st || {};
    const c = st.config || {};
    const res = { units, out: 0n, fee: 0n, problem: "" };
    if (units === null) { res.problem = $("#amount").value.trim() ? "Enter an amount like 25 or 12.5" : ""; return res; }
    res.fee = feeOf(units, feeBps());
    res.out = units > res.fee ? units - res.fee : 0n;
    if (units === 0n) res.problem = "";
    else if (c.paused) res.problem = "Swaps are paused for a moment. Try again soon.";
    else if (units < big(c.min_swap || UNIT)) res.problem = `The smallest swap is ${amount(c.min_swap || UNIT)} VHP.`;
    else if (big(c.max_swap) > 0n && units > big(c.max_swap)) res.problem = `The largest single swap is ${amount(c.max_swap)} VHP.`;
    else if (res.out > big(st.available)) res.problem = `Only ${amount(st.available)} KOIN is available right now. It refills with every block the desk produces.`;
    else if (S.account && S.vhp !== null && units > S.vhp) res.problem = `You have ${amount(S.vhp, 8)} VHP.`;
    return res;
  }

  function renderQuote() {
    const q = quote();
    const pct = feeBps() / 100;
    $("#fee-inline").textContent = `${pct}%`;
    $("#q-rate").textContent = `1 VHP = ${amount((UNIT * BigInt(10000 - feeBps())) / 10000n, 4)} KOIN`;
    $("#out").textContent = q.units ? exact(q.out) : "0";
    $("#q-fee").textContent = q.units ? `${exact(q.fee)} VHP (${pct}%)` : `${pct}%`;
    $("#q-max").textContent = S.st ? (big(S.st.max_vhp_in) > 0n ? `${amount(S.st.max_vhp_in)} VHP` : "none right now") : "…";
    const w = $("#warn");
    w.textContent = q.problem;
    w.hidden = !q.problem;
    const go = $("#go");
    if (!S.account) { go.textContent = "Connect wallet"; go.disabled = false; }
    else if (!q.units) { go.textContent = "Enter an amount"; go.disabled = true; }
    else { go.textContent = q.problem ? "Can't swap this amount" : `Swap for ${amount(q.out, 4)} KOIN`; go.disabled = !!q.problem; }
  }

  // ═══════════════ swap ═══════════════
  async function doSwap(ev) {
    ev.preventDefault();
    if (!S.account) return connect();
    const q = quote();
    if (!q.units || q.problem) return renderQuote();
    const label = `swap ${exact(q.units)} VHP for ${exact(q.out)} KOIN`;
    if (S.demo) return toast(`Demo: this would ask your wallet to confirm “${label}”.`, 6000);
    const go = $("#go");
    go.disabled = true;
    try {
      const vhp = new lib.Contract({ id: S.dep.vhp, abi: TOKEN_ABI, provider: S.provider });
      const desk = new lib.Contract({ id: S.dep.contract, abi: DESK_ABI, provider: S.provider });
      const op = async (c, fn, args) => (await c.functions[fn](args, { onlyOperation: true })).operation;
      // 1) let the desk take exactly this much VHP, 2) swap — never accept less than the KOIN quoted here
      const ops = [
        await op(vhp, "approve", { owner: S.account, spender: S.dep.contract, value: q.units.toString() }),
        await op(desk, "swap", { from: S.account, vhp_amount: q.units.toString(), min_koin_out: q.out.toString() }),
      ];
      toast(`Confirm “${label}” in ${window.KWallet.label()}…`, 20000);
      const confirmed = !!(await window.KWallet.send(label, ops));
      toast(confirmed ? `Done: you received ${exact(q.out)} KOIN.` : "Sent. It may take a minute to show.", 9000);
      $("#amount").value = "";
      await loadLive().catch(() => {});
    } catch (e) {
      const msg = String(e.message || e);
      toast(/reject|denied|cancel/i.test(msg) ? `Cancelled in ${window.KWallet.label()}.` : `Not sent: ${friendlyError(msg)}`, 9000);
    } finally {
      renderAll();
    }
  }


  // ═══════════════ rendering ═══════════════
  function renderStats() {
    const st = S.st;
    if (!st) return;
    $("#stat-avail").textContent = amount(st.available);
    $("#stat-swapped").textContent = amount(st.totals?.vhp_in);
  }

  function renderRecent() {
    const list = $("#recent");
    if (!S.recent.length) return list.replaceChildren(el("li", { class: "empty" }, "No swaps yet. Be the first."));
    list.replaceChildren(...S.recent.slice(0, 10).map((r) => el("li", {},
      el("a", { class: "who", href: EXPLORER_ADDRESS + r.account, target: "_blank", rel: "noopener" }, r.account === S.account ? "You" : short(r.account)),
      el("span", { class: "amt" }, el("b", {}, amount(r.vhp_in)), " VHP → ", el("b", {}, amount(r.koin_out)), " KOIN"),
      el("span", { class: "when" }, ago(Number(r.time))))));
  }

  function renderWallet() {
    const btn = $("#connect");
    btn.textContent = S.account ? short(S.account) : "Connect wallet";
    btn.classList.toggle("connected", !!S.account);
    $("#bal-line").textContent = S.account && S.vhp !== null ? `Balance: ${amount(S.vhp, 4)} VHP` : "Connect a wallet to see your VHP";
  }

  function renderAll() { renderWallet(); renderStats(); renderQuote(); renderRecent(); }

  function setMax() {
    if (!S.account) return connect();
    let m = big(S.st?.max_vhp_in);
    if (S.vhp !== null && S.vhp < m) m = S.vhp;
    $("#amount").value = m > 0n ? exact(m) : "";
    renderQuote();
  }

  // ═══════════════ demo ═══════════════
  function setupDemo() {
    S.demo = true;
    $("#demo-note").hidden = false;
    const now = Date.now();
    S.st = {
      config: { fee_bps: 300, min_swap: String(UNIT), max_swap: "0", paused: false },
      totals: { swaps: "14", vhp_in: String(3820n * UNIT), koin_out: String(3705n * UNIT) },
      available: String(2412n * UNIT), max_vhp_in: String(2486n * UNIT),
    };
    S.firstAvail = big(S.st.available);
    S.recent = [
      { account: "1Lq9mV8bJ2kDqPZgYzX4eTfa7hW3nR6sUp", vhp_in: String(120n * UNIT), koin_out: String(1164n * UNIT / 10n), time: String(now - 4 * 60000) },
      { account: "17cXwF2Tg8nE5yKvQ1hBdRm9sJ3uLpA6Zt", vhp_in: String(45n * UNIT), koin_out: String(4365n * UNIT / 100n), time: String(now - 52 * 60000) },
      { account: "1Np4HsX8vQkW2dJm7rYbF3eCt9gL5aUzE6", vhp_in: String(800n * UNIT), koin_out: String(776n * UNIT), time: String(now - 5 * 3600000) },
    ];
  }
  /** In the preview, the pool grows a little as if the desk were producing blocks. */
  function demoTick() {
    const add = 37n * UNIT / 100n;
    S.st.available = String(big(S.st.available) + add);
    S.st.max_vhp_in = String((big(S.st.available) * 10000n) / 9700n);
  }

  // ═══════════════ start ═══════════════
  async function start() {
    let armed = 0;
    $("#connect").addEventListener("click", () => {
      if (!S.account) return connect();
      if (S.demo || Date.now() - armed > 5000) { armed = Date.now(); return toast(`Connected with ${S.demo ? "the demo wallet" : window.KWallet.label()}: ${S.account}. Tap again to disconnect.`, 5000); }
      armed = 0; window.KWallet.disconnect();
    });
    $("#swap-form").addEventListener("submit", doSwap);
    $("#amount").addEventListener("input", renderQuote);
    $("#max").addEventListener("click", setMax);
    const wantDemo = /[?&]demo\b/.test(location.search);
    const dep = wantDemo ? null : await fetchJson(DEPLOYMENT).catch(() => null);
    if (!dep || !dep.contract || !lib.Contract) {
      setupDemo();
    } else {
      S.dep = dep;
      S.provider = new lib.Provider([dep.rpc || RPC]);
      if (window.KWallet) window.KWallet.init({
        provider: S.provider, toast, chainId: dep.chainId, payer: dep.payer, sponsor: dep.sponsor,
        onChange: async (addr) => {
          S.account = addr; S.vhp = null;
          if (addr) { toast(`Connected ${short(addr)} with ${window.KWallet.label()}`); await loadBalance().catch(() => {}); }
          else toast("Wallet disconnected");
          renderAll();
        },
      });
      S.desk = new lib.Contract({ id: dep.contract, abi: DESK_ABI, provider: S.provider });
      $("#foot-contract").replaceChildren("Desk contract ", el("a", { href: EXPLORER_ADDRESS + dep.contract, target: "_blank", rel: "noopener" }, short(dep.contract)));
      try { await loadLive(); } catch (e) { toast(`Couldn't reach the Koinos network: ${e.message}`, 8000); }
    }
    renderAll();
    // Refresh every 30 s: the available KOIN grows as the desk's node produces blocks.
    setInterval(async () => { try { await loadLive(); renderAll(); } catch {} }, S.demo ? 4000 : 30000);
  }
  start();
})();

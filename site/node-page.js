/* node.html: the page script (moved out of the HTML so the Content-Security-Policy can refuse inline scripts). */
(() => {
  "use strict";
  const lib = window.koilib || window.koinos || window;
  const RPC = "https://api.koinos.io";
  const KOIN = "19GYjDBVXU7keLbYvMLazsGQn3GTWHjHkK";
  const VHP = "12Y5vW6gk8GceH53YfRkRre2Rrcsgw7Naq";
  const EXPLORER = "https://koinosscan.com/address/";
  const UNIT = 1e8, MAX_BLOCKS = 201600, WORKERS = 6, REORG = 60, STORE = "nd-blocks-v2";
  const NAMES = { "1Mpmf2ERhjYpX7CCiM11WERuM4j17uT1sr": "Knode pool" };
  const QUICK = [["Knode pool", "1Mpmf2ERhjYpX7CCiM11WERuM4j17uT1sr"]];
  try { localStorage.removeItem("nd-blocks-v1"); } catch {}

  const provider = new lib.Provider([RPC]);
  const types = { nested: { t: { nested: {
    balance_of_arguments: { fields: { owner: { type: "bytes", id: 1, options: { "(koinos.btype)": "ADDRESS" } } } },
    balance_of_result: { fields: { value: { type: "uint64", id: 1, options: { jstype: "JS_STRING" } } } },
    mint_event: { fields: { to: { type: "bytes", id: 1, options: { "(koinos.btype)": "ADDRESS" } }, value: { type: "uint64", id: 2, options: { jstype: "JS_STRING" } } } },
    burn_event: { fields: { from: { type: "bytes", id: 1, options: { "(koinos.btype)": "ADDRESS" } }, value: { type: "uint64", id: 2, options: { jstype: "JS_STRING" } } } },
  } } } };
  const ser = new lib.Serializer(types);
  const vhpToken = new lib.Contract({ id: VHP, provider, abi: { methods: { balance_of: { entry_point: 0x5c721497, argument: "t.balance_of_arguments", return: "t.balance_of_result", read_only: true } }, koilib_types: types } });

  // ── helpers ──
  const $ = (id) => document.getElementById(id);
  const el = (tag, attrs = {}, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); for (const c of kids) if (c != null) e.append(c); return e; };
  const fmt = (n, d = 0) => (Number.isFinite(n) ? Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }) : "—");
  const sig = (n) => (!Number.isFinite(n) ? "—" : n >= 100 ? fmt(n, 0) : n >= 10 ? fmt(n, 1) : fmt(n, 2));
  const short = (a) => NAMES[a] || a.slice(0, 6) + "…" + a.slice(-4);
  const dur = (ms) => { const s = ms / 1000; return s < 120 ? `${fmt(s, s < 10 ? 1 : 0)} s` : s < 5400 ? `${Math.round(s / 60)} min` : s < 172800 ? `${(s / 3600).toFixed(1)} h` : `${(s / 86400).toFixed(1)} days`; };
  const isAddr = (a) => /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a);
  const say = (t) => { $("status").textContent = t; };
  const progress = (f) => { $("bar").hidden = f == null; if (f != null) $("bar").firstElementChild.style.width = `${Math.round(f * 100)}%`; };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const lastMondayUtc = () => { const d = new Date(); const day = (d.getUTCDay() + 6) % 7; return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day); };
  /** The count a Poisson(mean) stays at or below with probability p. */
  function poissonQ(mean, p) {
    if (!(mean > 0)) return 0;
    if (mean > 300) { const z = p < 0.5 ? -1.2816 : 1.2816; return Math.max(0, Math.round(mean + z * Math.sqrt(mean))); }
    let k = 0, pk = Math.exp(-mean), cum = pk;
    while (cum < p && k < 10000) { k++; pk *= mean / k; cum += pk; }
    return k;
  }

  // ── blocks kept in this browser: signer index, timestamp and transaction count per height ──
  let B = null; // { from, top, signers, sig, ts, ntx }
  const sIdx = new Map();
  function loadStore() {
    try {
      const r = JSON.parse(localStorage.getItem(STORE) || "null");
      if (!r || !r.sig || r.sig.length !== r.dts.length || r.sig.length !== r.ntx.length) return null;
      const ts = new Array(r.dts.length); let t = r.t0;
      for (let i = 0; i < ts.length; i++) { t += r.dts[i]; ts[i] = t; }
      return { from: r.from, top: r.from + r.sig.length - 1, signers: r.signers, sig: r.sig, ts, ntx: r.ntx };
    } catch { return null; }
  }
  function saveStore() {
    try {
      const dts = new Array(B.ts.length); let prev = B.ts[0];
      for (let i = 0; i < B.ts.length; i++) { dts[i] = B.ts[i] - prev; prev = B.ts[i]; }
      localStorage.setItem(STORE, JSON.stringify({ from: B.from, signers: B.signers, sig: B.sig, t0: B.ts[0], dts, ntx: B.ntx }));
    } catch { /* storage full or blocked: still works, just re-reads next time */ }
  }
  function signerIndex(a) { let i = sIdx.get(a); if (i === undefined) { i = B.signers.length; B.signers.push(a); sIdx.set(a, i); } return i; }

  /** Read blocks a..b into flat arrays: newest first, several requests at once, oversized requests split. */
  async function readRange(a, b, headId, note) {
    const n = b - a + 1, signers = new Array(n), ts = new Array(n), ntx = new Array(n);
    const queue = []; for (let e = b; e >= a; e -= 200) queue.push([Math.max(a, e - 199), e]);
    let done = 0;
    const worker = async () => {
      while (queue.length) {
        const [s, e] = queue.shift();
        let res = null;
        for (let tries = 0; ; tries++) {
          try { res = await provider.call("block_store.get_blocks_by_height", { head_block_id: headId, ancestor_start_height: String(s), num_blocks: e - s + 1, return_block: true, return_receipt: false }); break; }
          catch (err) {
            if (e - s >= 50) { const m = Math.floor((s + e) / 2); queue.push([s, m], [m + 1, e]); break; }
            if (tries >= 4) throw err;
            await sleep(700 * (tries + 1));
          }
        }
        if (!res) continue;
        let got = 0;
        for (const it of res.block_items || []) {
          const i = Number(it.block_height) - a;
          if (i < 0 || i >= n || signers[i] !== undefined) continue;
          signers[i] = it.block.header.signer; ts[i] = Number(it.block.header.timestamp); ntx[i] = (it.block.transactions || []).length; got++;
        }
        if (got === 0) throw new Error(`no blocks returned at ${s}`);
        let k = s; while (k <= e && signers[k - a] !== undefined) k++;
        if (k <= e) queue.push([k, e]); // the node sent fewer than asked: get the rest
        done += got; progress(Math.min(1, done / n)); say(`${note} ${fmt(done)} of ${fmt(n)} blocks…`);
      }
    };
    await Promise.all(Array.from({ length: WORKERS }, worker));
    return { signers, ts, ntx };
  }

  /** The bot publishes the last two days of blocks every hour as one file (branch blocks-data). One download instead
   *  of ~144 requests to the public node. It is only used if a random sample of its blocks matches the chain. */
  const SNAPSHOT = "https://raw.githubusercontent.com/bawcejawn/Knode/blocks-data/recent-blocks.json";
  async function loadSnapshot(needFrom, top, headId) {
    try {
      say("Loading recent blocks…");
      const r = await (await fetch(SNAPSHOT, { cache: "no-cache" })).json();
      const n = r && Array.isArray(r.sig) ? r.sig.length : 0;
      if (!n || r.v !== 1 || r.dts.length !== n || r.ntx.length !== n || r.top !== r.from + n - 1 || r.from > needFrom || r.top > top) return null;
      if (!r.signers.every(isAddr) || !r.sig.every((i) => Number.isInteger(i) && i >= 0 && i < r.signers.length)) return null;
      const ts = new Array(n); let t = r.t0;
      for (let i = 0; i < n; i++) { t += r.dts[i]; ts[i] = t; }
      // Spot-check 8 random blocks (older than the newest 60, which can still change) against the chain.
      const picks = Array.from({ length: 8 }, () => r.from + Math.floor(Math.random() * Math.max(1, n - REORG)));
      const ok = await Promise.all(picks.map(async (h) => {
        const res = await provider.call("block_store.get_blocks_by_height", { head_block_id: headId, ancestor_start_height: String(h), num_blocks: 1, return_block: true, return_receipt: false });
        const it = (res.block_items || [])[0];
        return it && Number(it.block_height) === h && it.block.header.signer === r.signers[r.sig[h - r.from]] && Number(it.block.header.timestamp) === ts[h - r.from];
      }));
      if (!ok.every(Boolean)) return null;
      return { from: r.from, top: r.top, signers: r.signers.slice(), sig: r.sig.slice(), ts, ntx: r.ntx.slice() };
    } catch { return null; }
  }

  async function ensureBlocks(needFrom, head) {
    const top = Number(head.head_topology.height), headId = head.head_topology.id;
    needFrom = Math.max(needFrom, top - MAX_BLOCKS + 1);
    if (!B) B = loadStore();
    // Nothing (or too little) kept in this browser: start from the bot's snapshot when it is good.
    if (!B || B.from > needFrom || B.top < top - 1200) { const snap = await loadSnapshot(needFrom, top, headId); if (snap && (!B || snap.top > B.top || snap.from < B.from)) B = snap; }
    sIdx.clear(); if (B) B.signers.forEach((a, i) => sIdx.set(a, i));
    if (!B || B.top < needFrom - 1 || B.top > top || B.sig.length === 0) { B = { from: top + 1, top, signers: [], sig: [], ts: [], ntx: [] }; sIdx.clear(); }
    else { // the newest ~60 blocks can still change: re-read them
      const keep = Math.max(0, B.sig.length - REORG);
      B.sig.length = keep; B.ts.length = keep; B.ntx.length = keep; B.top = B.from + keep - 1;
    }
    if (B.top < top) {
      const a = B.sig.length ? B.top + 1 : needFrom, r = await readRange(a, top, headId, "Reading new blocks:");
      if (B.sig.length === 0) B.from = a;
      for (let i = 0; i < r.signers.length; i++) { B.sig.push(signerIndex(r.signers[i])); B.ts.push(r.ts[i]); B.ntx.push(r.ntx[i]); }
      B.top = top;
    }
    if (needFrom < B.from) {
      const r = await readRange(needFrom, B.from - 1, headId, "Reading older blocks:");
      B.sig = r.signers.map(signerIndex).concat(B.sig); B.ts = r.ts.concat(B.ts); B.ntx = r.ntx.concat(B.ntx); B.from = needFrom;
    }
    const cut = B.sig.length - MAX_BLOCKS;
    if (cut > 0) { B.sig.splice(0, cut); B.ts.splice(0, cut); B.ntx.splice(0, cut); B.from += cut; }
    progress(null);
    saveStore();
  }

  // ── network block reward (median of the latest blocks; read once) ──
  let rewardCache = null;
  async function networkReward(head) {
    if (rewardCache) return rewardCache;
    const h = Number(head.head_topology.height), N = 40;
    const res = await provider.call("block_store.get_blocks_by_height", { head_block_id: head.head_topology.id, ancestor_start_height: String(h - N + 1), num_blocks: N, return_block: true, return_receipt: true });
    const nets = [];
    for (const it of res.block_items || []) {
      const signer = it.block.header.signer; let mint = 0, burn = 0;
      for (const ev of (it.receipt && it.receipt.events) || []) {
        try {
          if (ev.source === KOIN && /mint/i.test(ev.name || "")) { const d = await ser.deserialize(ev.data, "t.mint_event"); if (d.to === signer) mint += Number(d.value) / UNIT; }
          else if (ev.source === VHP && /burn/i.test(ev.name || "")) { const d = await ser.deserialize(ev.data, "t.burn_event"); if (d.from === signer) burn += Number(d.value) / UNIT; }
        } catch { /* not a token event we know */ }
      }
      if (mint > 0) nets.push(mint - burn);
    }
    if (!nets.length) return NaN;
    nets.sort((x, y) => x - y);
    return (rewardCache = nets[Math.floor(nets.length / 2)]);
  }

  const bal = new Map();
  async function vhpOf(a) {
    const hit = bal.get(a);
    if (hit && Date.now() - hit.at < 300000) return hit.v;
    const r = await vhpToken.functions.balance_of({ owner: a });
    const v = Number((r.result && r.result.value) || 0) / UNIT;
    bal.set(a, { v, at: Date.now() }); return v;
  }

  // ── render ──
  const tile = (k, v, s, cls = "") => el("div", { class: "tile" }, el("div", { class: "k" }, k), el("div", { class: `v ${cls}` }, v), s ? el("div", { class: "s" }, s) : null);

  function chart(first, last, mineTs, expPerHour, spanH) {
    const bucketH = spanH <= 30 ? 1 : spanH <= 80 ? 3 : 6;
    const size = bucketH * 3.6e6, N = Math.max(1, Math.ceil((last - first) / size));
    const counts = new Array(N).fill(0);
    for (const t of mineTs) counts[Math.min(N - 1, Math.floor((t - first) / size))]++;
    const exp = expPerHour * bucketH, max = Math.max(1, exp * 1.4, ...counts), W = 1000, H = 150, bw = W / N;
    const ns = "http://www.w3.org/2000/svg", svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`); svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("role", "img"); svg.setAttribute("aria-label", `Blocks per ${bucketH} hour${bucketH === 1 ? "" : "s"}, with the expected level`);
    counts.forEach((c, i) => {
      const h = c ? Math.max(4, (c / max) * (H - 6)) : 2, r = document.createElementNS(ns, "rect");
      r.setAttribute("x", i * bw + bw * 0.12); r.setAttribute("width", Math.max(1, bw * 0.76)); r.setAttribute("y", H - h); r.setAttribute("height", h); r.setAttribute("rx", 2);
      r.setAttribute("fill", c ? "var(--violet)" : "var(--line)");
      const t = document.createElementNS(ns, "title"); t.textContent = `${new Date(first + i * size).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}: ${c} block${c === 1 ? "" : "s"}`; r.append(t);
      svg.append(r);
    });
    if (exp > 0) {
      const y = H - (exp / max) * (H - 6), line = document.createElementNS(ns, "line");
      line.setAttribute("x1", 0); line.setAttribute("x2", W); line.setAttribute("y1", y); line.setAttribute("y2", y);
      line.setAttribute("stroke", "var(--sun)"); line.setAttribute("stroke-width", 2); line.setAttribute("stroke-dasharray", "8 6"); line.setAttribute("vector-effect", "non-scaling-stroke");
      svg.append(line);
    }
    $("chart").replaceChildren(svg);
    $("chart-sub").textContent = `Each bar is ${bucketH === 1 ? "1 hour" : `${bucketH} hours`}; the dashed line is the expected ${sig(exp)} per bar.`;
    $("ax-l").textContent = new Date(first).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }

  let busy = false, current = null;
  async function show(addr, mode, quiet = false) {
    if (busy) return; busy = true; current = { addr, mode };
    try {
      const head = await provider.getHeadInfo();
      const top = Number(head.head_topology.height), now = Number(head.head_block_time) || Date.now();
      const monday = lastMondayUtc();
      const n = mode === "week" ? Math.min(MAX_BLOCKS, Math.ceil((now - monday) / 3000 * 1.05) + 200) : Number(mode);
      await ensureBlocks(top - n + 1, head);
      if (!quiet) say("Reading VHP balances…");

      let i0 = Math.max(0, (top - n + 1) - B.from);
      if (mode === "week") while (i0 < B.ts.length && B.ts[i0] < monday) i0++;
      const total = B.sig.length - i0;
      if (total < 10) throw new Error("not enough blocks in this window yet");
      const t0 = B.ts[i0], t1 = B.ts[B.sig.length - 1], spanH = Math.max(0.1, (t1 - t0) / 3.6e6);
      const me = sIdx.get(addr);
      const counts = new Map(), mineTs = [];
      let maxGap = 0, empty = 0, txs = 0;
      for (let i = i0; i < B.sig.length; i++) {
        const s = B.sig[i]; counts.set(s, (counts.get(s) || 0) + 1);
        if (s === me) mineTs.push(B.ts[i]);
        if (i > i0) maxGap = Math.max(maxGap, B.ts[i] - B.ts[i - 1]);
        if (B.ntx[i] === 0) empty++; txs += B.ntx[i] || 0;
      }
      const producers = [...counts.entries()].map(([s, c]) => [B.signers[s], c]).sort((x, y) => y[1] - x[1]);
      const list = producers.map(([a]) => a); if (!list.includes(addr)) list.push(addr);
      const vals = []; for (let i = 0; i < list.length; i += 8) { vals.push(...(await Promise.all(list.slice(i, i + 8).map(vhpOf)))); }
      const vhp = new Map(list.map((a, i) => [a, vals[i]]));
      let reward = NaN; try { reward = await networkReward(head); } catch { /* shown as — */ }

      const myVhp = vhp.get(addr) || 0;
      const activeVhp = producers.reduce((s, [a]) => s + (vhp.get(a) || 0), 0) + (counts.has(me) ? 0 : myVhp);
      const share = activeVhp ? myVhp / activeVhp : 0;
      const perDay = total / spanH * 24; // network blocks a day
      const mine = mineTs.length, expWin = share * total, luck = expWin > 0 ? mine / expWin : NaN;
      const lastTs = mineTs[mine - 1], since = lastTs ? now - lastTs : NaN, every = share > 0 ? 8.64e7 / (share * perDay) : NaN;
      const late = lastTs ? since > every * 3 : expWin >= 3;
      const winName = $("win").selectedOptions[0].textContent.replace(/^Last /, "");
      const name = NAMES[addr] ? `${NAMES[addr]} (${addr.slice(0, 6)}…${addr.slice(-4)})` : short(addr);

      $("tiles").replaceChildren(
        tile("Share of active VHP", share > 0 ? `${fmt(share * 100, share < 0.01 ? 3 : 2)}%` : "0%", `${fmt(myVhp, 0)} VHP of ${fmt(activeVhp / 1e6, 1)}M producing`),
        tile(`Blocks, ${mode === "week" ? "this Knode week" : winName.toLowerCase()}`, `${fmt(mine)}`, expWin > 0 ? `expected ${sig(expWin)} · ${fmt(luck * 100, 0)}% of expected` : "no VHP, so no blocks expected", !Number.isFinite(luck) || expWin < 3 ? "" : luck >= 0.8 ? "good" : luck < 0.5 ? "bad" : ""),
        tile("Last block", lastTs ? `${dur(since)} ago` : "none in window", Number.isFinite(every) ? `usually one every ${dur(every)}${late ? " · overdue, check the node" : ""}` : "", late && share > 0 ? "bad" : ""),
      );

      const rows = [["Next 1,000 blocks", 1000], ["Next 5,000 blocks", 5000], ["Next 10,000 blocks", 10000], ["Next 20,000 blocks", 20000],
        ["A day", perDay], ["A week", perDay * 7], ["A month", perDay * 30], ["A year", perDay * 365]];
      $("forecast").replaceChildren(...rows.map(([label, blocks]) => {
        const m = share * blocks, lo = poissonQ(m, 0.1), hi = poissonQ(m, 0.9);
        const hint = /blocks/.test(label) ? ` (~${dur(blocks / perDay * 8.64e7)})` : "";
        return el("tr", {}, el("td", {}, label, el("span", { class: "range" }, hint)), el("td", { class: "r" }, sig(m)),
          el("td", { class: "r" }, m > 0 ? (lo === hi ? fmt(lo) : `${fmt(lo)} – ${fmt(hi)}`) : "—"), el("td", { class: "r" }, sig(m * reward)));
      }));
      const apr = myVhp > 0 ? share * perDay * reward * 365 / myVhp * 100 : NaN;
      $("fc-sub").textContent = `${name}, if VHP stays as it is now. Knode's block questions use windows of 5,000–20,000 blocks.${Number.isFinite(apr) ? ` Earnings ≈ ${fmt(apr, 1)}% a year on its VHP (${fmt(reward, 3)} KOIN a block).` : ""}`;

      chart(t0, t1, mineTs, share * perDay / 24, spanH);

      const shown = producers.slice(0, 60); if (!shown.some(([a]) => a === addr)) shown.push([addr, 0]);
      $("top").replaceChildren(...shown.map(([a, c]) => {
        const v = vhp.get(a), vs = v != null && activeVhp ? v / activeVhp : NaN, l = vs > 0 ? (c / total) / vs : NaN;
        const rank = producers.findIndex(([x]) => x === a);
        const pick = el("button", { type: "button", class: "link mono", title: a }, short(a));
        pick.onclick = () => { $("addr").value = a; go(); window.scrollTo({ top: 0, behavior: "smooth" }); };
        return el("tr", { class: a === addr ? "me" : "" },
          el("td", {}, rank >= 0 ? String(rank + 1) : "–"), el("td", {}, pick),
          el("td", { class: "r" }, fmt(c)), el("td", { class: "r" }, Number.isFinite(vs) ? `${fmt(vs * 100, 2)}%` : "—"),
          el("td", { class: "r" }, Number.isFinite(vs) ? sig(vs * 10000) : "—"),
          el("td", { class: "r" }, Number.isFinite(l) && c + vs * total >= 3 ? `${fmt(l * 100, 0)}%` : "—"));
      }));

      const stat = (k, v) => el("div", {}, el("dt", {}, k), el("dd", {}, v));
      $("net").replaceChildren(
        stat("Average time between blocks", dur((t1 - t0) / (total - 1))),
        stat("Longest gap between blocks", dur(maxGap)),
        stat("Blocks with no transactions", `${fmt(empty / total * 100, 1)}%`),
        stat("Transactions per 10,000 blocks", fmt(txs / total * 10000, 0)),
        stat("Active producers", fmt(producers.length)),
        stat("Blocks a day", fmt(perDay, 0)),
      );

      say(`${name} · ${fmt(total)} blocks over ${dur(t1 - t0)}, to block #${fmt(top)}. Updated ${new Date().toLocaleTimeString()}, refreshes every 5 minutes.`);
      $("out").hidden = false;
    } catch (e) {
      progress(null);
      say(`Couldn't read the chain: ${(e && e.message) || e}. Try again in a minute.`);
    } finally { busy = false; }
  }

  // ── wiring ──
  const remember = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
  const recall = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  function go() {
    const a = $("addr").value.trim(), m = $("win").value;
    if (!isAddr(a)) return say("That doesn't look like a Koinos address (it starts with 1 and has 26–35 characters).");
    remember("nd-addr", a); remember("nd-win", m);
    history.replaceState(null, "", `?a=${a}&w=${m}`);
    show(a, m);
  }
  $("form").addEventListener("submit", (e) => { e.preventDefault(); go(); });
  $("win").addEventListener("change", () => { if (isAddr($("addr").value.trim())) go(); });
  $("quick").replaceChildren(el("span", {}, "Try:"), ...QUICK.map(([label, a]) => { const b = el("button", { type: "button" }, label); b.onclick = () => { $("addr").value = a; go(); }; return b; }));
  setInterval(() => { if (current && !document.hidden) show(current.addr, current.mode, true); }, 300000);
  const q = new URLSearchParams(location.search);
  const a0 = q.get("a") || recall("nd-addr") || QUICK[0][1], w0 = q.get("w") || recall("nd-win");
  if (w0 && [...$("win").options].some((o) => o.value === w0)) $("win").value = w0;
  $("addr").value = a0; go();
})();

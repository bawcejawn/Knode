/* pulse.html: Network pulse. Read only: the last 24 hours of Koinos blocks (via chain-blocks.js) and the KOIN and VHP
   supplies. Nothing here signs or sends a transaction. */
(() => {
  "use strict";
  const HOUR = 3600000, DAY = 24 * HOUR;

  /** The numbers on the page, from block arrays B (ts ascending) and the newest block's time. Pure, so tests can run it. */
  function stats(B, now) {
    let i0 = 0; { let lo = 0, hi = B.ts.length; while (lo < hi) { const m = (lo + hi) >> 1; if (B.ts[m] <= now - DAY) lo = m + 1; else hi = m; } i0 = lo; }
    const n = B.ts.length - i0, hours = new Array(24).fill(0).map(() => ({ blocks: 0, tx: 0 }));
    const per = new Map(); let tx = 0, gapMax = 0, gaps = 0;
    for (let i = i0; i < B.ts.length; i++) {
      const hIdx = Math.min(23, Math.max(0, 23 - Math.floor((now - B.ts[i]) / HOUR)));
      hours[hIdx].blocks++; hours[hIdx].tx += B.ntx[i]; tx += B.ntx[i];
      per.set(B.sig[i], (per.get(B.sig[i]) || 0) + 1);
      if (i > i0) { const g = B.ts[i] - B.ts[i - 1]; if (g > gapMax) gapMax = g; if (g > 30000) gaps++; }
    }
    const producers = [...per.entries()].map(([s, c]) => ({ addr: B.signers[s], blocks: c, share: c / Math.max(1, n) })).sort((a, b) => b.blocks - a.blocks);
    let acc = 0, n33 = 0, n50 = 0;
    for (const p of producers) { acc += p.share; if (!n33 && acc > 1 / 3) n33 = producers.indexOf(p) + 1; if (!n50 && acc > 0.5) { n50 = producers.indexOf(p) + 1; break; } }
    const span = n > 1 ? B.ts[B.ts.length - 1] - B.ts[i0] : 0;
    return { blocks: n, tx, avgBlockMs: n > 1 ? span / (n - 1) : 0, gapMax, slowGaps: gaps, hours, producers, n33, n50, withTx: B.ntx.slice(i0).filter((x) => x > 0).length };
  }
  window.KPulseMath = { stats };
  if (typeof document === "undefined" || !document.getElementById("p-height")) return;   // loaded by a test

  const lib = window.koilib || window.koinos || window;
  const RPC = "https://koinos.armana.io";
  const KOIN = "19GYjDBVXU7keLbYvMLazsGQn3GTWHjHkK", VHP = "12Y5vW6gk8GceH53YfRkRre2Rrcsgw7Naq";
  const EXPLORER = "https://koinosscan.com/address/";
  const NAMES = { "1Mpmf2ERhjYpX7CCiM11WERuM4j17uT1sr": "Knode Games pool", "1FKTpXBhhHEbu5vVchM8UsVbAvPArJsRmR": "Knode Games Swap" };
  const provider = new lib.Provider([RPC]);
  const types = { nested: { t: { nested: { empty: { fields: {} }, supply: { fields: { value: { type: "uint64", id: 1, options: { jstype: "JS_STRING" } } } } } } } };
  const token = (id) => new lib.Contract({ id, provider, abi: { methods: { total_supply: { entry_point: 0xb0da3934, argument: "t.empty", return: "t.supply", read_only: true } }, koilib_types: types } });

  const $ = (id) => document.getElementById(id);
  const fmt = (n, d = 0) => (Number.isFinite(n) ? Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }) : "–");
  // Producer names (names.js): "Name · 1Abc12…wxyz", or the short address.
  const nameOf = (a) => (window.KNames ? window.KNames.of(a) : NAMES[a] || a.slice(0, 6) + "…" + a.slice(-4));
  const hourLabel = (t) => new Date(t).toLocaleTimeString(undefined, { hour: "numeric" });
  const say = (t) => { $("status").textContent = t; };
  let B = null, now = 0;

  /** A 24-bar chart (one series, one hue). Each bar has a hover title with the hour and the value. */
  function bars(box, values, label, unit) {
    const ns = "http://www.w3.org/2000/svg", W = 720, H = 150, gap = 2, bw = W / values.length, max = Math.max(1, ...values);
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`); svg.setAttribute("preserveAspectRatio", "none"); svg.setAttribute("role", "img"); svg.setAttribute("aria-label", label);
    values.forEach((v, i) => {
      const h = v ? Math.max(3, (v / max) * (H - 4)) : 1.5, r = document.createElementNS(ns, "rect");
      r.setAttribute("x", i * bw + gap / 2); r.setAttribute("width", Math.max(1, bw - gap)); r.setAttribute("y", H - h); r.setAttribute("height", h); r.setAttribute("rx", 3);
      r.setAttribute("fill", v ? "var(--violet)" : "var(--line)");
      const t = document.createElementNS(ns, "title"); t.textContent = `${hourLabel(now - (23 - i) * HOUR - HOUR)}–${hourLabel(now - (23 - i) * HOUR)}: ${fmt(v)} ${unit}`; r.append(t);
      svg.append(r);
    });
    $(box).replaceChildren(svg);
  }

  function render(S, head) {
    $("p-height").textContent = fmt(Number(head.head_topology.height));
    $("p-blocktime").textContent = `${fmt(S.avgBlockMs / 1000, 2)} s`;
    $("p-blocks").textContent = fmt(S.blocks);
    $("p-tx").textContent = fmt(S.tx);
    $("p-tx-s").textContent = `${fmt(S.withTx)} blocks carried at least one`;
    $("p-gap").textContent = `${fmt(S.gapMax / 1000, 0)} s`;
    $("p-gap-s").textContent = S.slowGaps ? `${fmt(S.slowGaps)} gaps over 30 s` : "no gaps over 30 s";
    $("p-prod").textContent = fmt(S.producers.length);
    $("p-n50").textContent = fmt(S.n50);
    $("p-n33").textContent = `${fmt(S.n33)} producers sign a third`;
    const busiest = S.hours.reduce((b, h, i) => (h.tx > S.hours[b].tx ? i : b), 0);
    $("tx-sub").textContent = `Busiest hour: ${hourLabel(now - (23 - busiest) * HOUR - HOUR)}, ${fmt(S.hours[busiest].tx)} transactions.`;
    bars("tx-chart", S.hours.map((h) => h.tx), "Transactions per hour, last 24 hours", "transactions");
    bars("blk-chart", S.hours.map((h) => h.blocks), "Blocks per hour, last 24 hours", "blocks");
    $("ax-tx").textContent = $("ax-blk").textContent = hourLabel(now - DAY);

    const top = S.producers.slice(0, 12), max = top.length ? top[0].share : 1;
    $("prods").replaceChildren(...top.map((p, i) => {
      const row = document.createElement("div"); row.className = "pp-row";
      const name = document.createElement("a"); name.href = EXPLORER + p.addr; name.target = "_blank"; name.rel = "noopener noreferrer"; name.className = "pp-name"; name.textContent = `${i + 1}. ${nameOf(p.addr)}`;
      const bar = document.createElement("div"); bar.className = "pp-bar"; const fill = document.createElement("i"); fill.style.width = `${(p.share / max) * 100}%`; bar.append(fill);
      bar.title = `${fmt(p.blocks)} blocks`;
      const v = document.createElement("span"); v.className = "pp-v"; v.textContent = `${fmt(p.share * 100, 1)}%`;
      row.append(name, bar, v); return row;
    }));
    const rest = S.producers.slice(12);
    $("prods-rest").textContent = rest.length ? `+ ${rest.length} more producers with ${fmt(rest.reduce((s, p) => s + p.share, 0) * 100, 1)}% together.` : "";
  }

  async function supplies() {
    try {
      const [k, v] = await Promise.all([token(KOIN).functions.total_supply({}), token(VHP).functions.total_supply({})]);
      const koin = Number((k.result || {}).value || 0) / 1e8, vhp = Number((v.result || {}).value || 0) / 1e8;
      $("p-koin").textContent = fmt(koin); $("p-vhp").textContent = fmt(vhp);
      $("p-vhp-s").textContent = koin + vhp > 0 ? `${fmt((vhp / (koin + vhp)) * 100, 1)}% of all KOIN + VHP is burned into VHP` : "";
    } catch { $("p-vhp-s").textContent = "Couldn't read the supplies right now."; }
  }

  async function refresh(first = false) {
    const r = await KBlocks.ensure(provider, { blocks: 30500, onStatus: first ? (t) => t && say(t) : null });
    B = r.B; now = B.ts[B.ts.length - 1];
    render(stats(B, now), r.head);
    say("");
    $("p-ago").textContent = `${Math.max(0, Math.round((Date.now() - now) / 1000))} s ago`;
  }
  (async () => {
    try { await refresh(true); } catch { say("Couldn't reach the Koinos network. Trying again in a moment…"); }
    supplies();
    setInterval(() => { if (!document.hidden) refresh().catch(() => {}); }, 20000);
    setInterval(() => { if (now) $("p-ago").textContent = `${Math.max(0, Math.round((Date.now() - now) / 1000))} s ago`; }, 1000);
    setInterval(() => { if (!document.hidden) supplies(); }, 300000);
    if (window.KNames) window.KNames.onChange(() => { if (B) refresh().catch(() => {}); });
  })();
})();

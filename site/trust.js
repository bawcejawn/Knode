/* Knode Trust page — everything here is read live from the Koinos chain (and the public deployment files in the
   repo), so visitors can check the numbers themselves. Read-only: no wallet, no transactions. */
(() => {
  "use strict";

  const UNIT = 100000000n;
  const RPC = "https://koinos.armana.io";
  const SCAN = "https://koinosscan.com/address/";
  const BASE = location.pathname.includes("/site/") ? "../" : "./";
  const lib = window.koilib || window.koinos || window;
  const $ = (s) => document.querySelector(s);
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") n.className = v;
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
  const fetchJson = async (url) => { const r = await fetch(url, { cache: "no-store" }); if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.json(); };
  const link = (addr) => el("a", { class: "mono", href: SCAN + addr, target: "_blank", rel: "noopener" }, addr);
  const when = (ms) => new Date(Number(ms)).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const fact = (dl, k, v) => { dl.append(el("dt", {}, k), el("dd", {}, v)); };

  async function read(contract, method) {
    const { result } = await contract.functions[method]({});
    return result || {};
  }

  function gameCard(st) {
    const t = st.totals || {};
    const holdings = big(st.vhp_balance) + big(st.koin_balance);
    const parts = [["Players' stakes", t.total_stake], ["Seed", big(t.seed_vhp) + big(t.seed_koin)], ["Unclaimed prizes", t.pots_outstanding],
      ["Producer fee (5%)", t.creator_fee], ["Owner share (retired)", t.owner_share]];
    const owed = parts.reduce((a, [, v]) => a + big(v), 0n);
    const ok = holdings >= owed;
    const card = $("#game-card");
    const dl = el("dl", { class: "facts" });
    fact(dl, "Holds (VHP + KOIN)", `${amount(holdings)}`);
    for (const [k, v] of parts) if (big(v) > 0n) fact(dl, `· owes ${k.charAt(0).toLowerCase() + k.slice(1)}`, amount(v));
    fact(dl, "Owes in total", amount(owed));
    fact(dl, "Earned this week, not yet split", amount(ok ? holdings - owed : 0n));
    card.replaceChildren(
      el("h2", {}, "Game pool"),
      el("div", { class: "solv" }, el("b", {}, ok ? "Fully covered" : "Short"), el("span", { class: ok ? "ok-pill" : "bad-pill" }, ok ? "holds ≥ owes" : "holds < owes")),
      dl,
      el("p", { class: "muted small" }, "The contract re-checks this after every payout and refuses any payout that would leave it short."));
  }

  function deskCard(st) {
    const c = st.config || {}, t = st.totals || {};
    const dl = el("dl", { class: "facts" });
    fact(dl, "KOIN (swap liquidity)", amount(st.koin_balance));
    fact(dl, "Available for one swap now", `${amount(st.available)} KOIN`);
    fact(dl, "VHP (producing blocks)", amount(st.vhp_balance));
    fact(dl, "Fee", `${Number(c.fee_bps ?? 0) / 100}%${c.paused ? " (paused)" : ""}`);
    fact(dl, "Swaps so far", `${t.swaps ?? 0} · ${amount(t.vhp_in)} VHP in, ${amount(t.koin_out)} KOIN out`);
    $("#desk-card").replaceChildren(
      el("h2", {}, "Knode Swap desk"),
      el("div", { class: "solv" }, el("b", {}, "Owes no one"), el("span", { class: "ok-pill" }, "settles instantly")),
      dl,
      el("p", { class: "muted small" }, "Every swap pays out in the same transaction it takes your VHP, so the desk never holds anyone else's money. Withdrawals can only go to the treasury address below."));
  }

  function changes(game, desk) {
    const list = [];
    const up = (name, u) => { if (u && u.hash && String(u.hash).length > 2 && big(u.eta) > 0n) list.push(`${name}: a code upgrade is announced (fingerprint ${String(u.hash).slice(0, 12)}…), possible from ${when(u.eta)}.`); };
    if (game) {
      up("Game", game.upgrade);
      const w = game.seed_withdrawal;
      if (w && big(w.eta) > 0n) list.push(`Game: a seed withdrawal is announced (${amount(w.vhp)} VHP, ${amount(w.koin)} KOIN), possible from ${when(w.eta)}.`);
    }
    if (desk) {
      up("Swap desk", desk.upgrade);
      const tc = desk.treasury_change;
      if (tc && tc.address && big(tc.eta) > 0n) list.push(`Swap desk: a new treasury (${tc.address}) is announced, possible from ${when(tc.eta)}.`);
    }
    $("#changes").replaceChildren(list.length
      ? el("ul", { class: "checks" }, list.map((x) => el("li", { class: "pending" }, el("span", {}, x))))
      : el("p", {}, el("span", { class: "ok-pill" }, "None"), " No code change, seed withdrawal or treasury change is announced right now."));
  }

  function addresses(gameDep, deskDep, game, desk) {
    const rows = [];
    const row = (what, addr, can) => { if (addr) rows.push(el("tr", {}, el("td", {}, what), el("td", {}, link(addr)), el("td", { class: "muted" }, can))); };
    row("Game contract", gameDep?.contract, "Holds the pool. Pays stakes back only to their owners, prizes only to winners.");
    row("Swap desk contract", deskDep?.contract, "Swaps VHP for KOIN. Its VHP produces blocks on its own node.");
    row("Owner (admin)", game?.config?.owner || gameDep?.owner, "Can pause new deposits, fix a result before a week closes, collect the 5% fee, and announce upgrades (48 h). Can't touch players' stakes or prizes.");
    if (desk?.config?.treasury) row("Swap desk treasury", desk.config.treasury, "The only address the desk's funds can ever be withdrawn to.");
    row("Game bot", game?.config?.operator || gameDep?.operator, "Posts and resolves questions. Can't move any tokens.");
    row("KOIN token", gameDep?.koin, "Koinos system contract.");
    row("VHP token", gameDep?.vhp, "Koinos system contract.");
    row("Proof-of-Burn", gameDep?.pob, "Koinos system contract that turns KOIN into VHP and runs block production.");
    $("#addr-body").replaceChildren(...rows);
  }

  function prints(gameDep, deskDep) {
    const dl = $("#prints");
    dl.replaceChildren();
    if (gameDep?.wasmSha256) fact(dl, "Game contract (as deployed)", el("span", { class: "mono" }, gameDep.wasmSha256));
    if (deskDep?.wasmSha256) fact(dl, "Swap desk contract", el("span", { class: "mono" }, deskDep.wasmSha256));
  }

  async function start() {
    const [gameDep, deskDep] = await Promise.all([
      fetchJson(BASE + "game-data/deployment.json").catch(() => null),
      fetchJson(BASE + "desk-data/deployment.json").catch(() => null),
    ]);
    addresses(gameDep, deskDep, null, null);
    prints(gameDep, deskDep);
    if (!lib.Contract) { $("#as-of").textContent = "Couldn't load the Koinos library. Refresh the page to try again."; return; }
    const provider = new lib.Provider([gameDep?.rpc || RPC]);
    let game = null, desk = null;
    try {
      const abi = await fetchJson(BASE + "game/abi/kpred.koilib.json");
      game = await read(new lib.Contract({ id: gameDep.contract, abi, provider }), "get_state");
      gameCard(game);
    } catch (e) { $("#game-card").replaceChildren(el("h2", {}, "Game pool"), el("p", { class: "muted" }, `Couldn't read the game contract right now (${e.message}).`)); }
    try {
      const abi = await fetchJson(BASE + "desk/abi/desk.koilib.json");
      desk = await read(new lib.Contract({ id: deskDep.contract, abi, provider }), "get_state");
      deskCard(desk);
    } catch (e) { $("#desk-card").replaceChildren(el("h2", {}, "Knode Swap desk"), el("p", { class: "muted" }, `Couldn't read the swap desk right now (${e.message}).`)); }
    changes(game, desk);
    addresses(gameDep, deskDep, game, desk);
    const t = game?.time || desk?.time;
    $("#as-of").textContent = t ? `Read from the chain at ${when(t)} (your time). Refresh for the latest.` : "";
  }
  start();
})();

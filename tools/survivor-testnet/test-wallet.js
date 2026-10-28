/* Survivor TESTNET test wallet. Served only by the local test server (bot/survivor-test.ts) in place of the real
 * wallet scripts. You choose a test player (p1…p6) in the red bar; a pick you confirm on the page is sent to the
 * local server, which checks it is a Survivor pick for that player on the testnet Picks contract and signs it with
 * that player's TEST key (the keys never reach the browser). Nothing here can sign anything else. */
(() => {
  "use strict";
  const NET = window.KSurvivorNet;
  if (!NET) return;
  const subs = new Set();
  let onChange = null, token = null, who = null;
  const W = {
    kind: "test",
    address: null,
    label: () => `test player ${who}`,
    init(o) { onChange = o && typeof o.onChange === "function" ? o.onChange : null; },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    async send(label, ops) {
      if (!who) throw new Error("Choose a test player in the red bar first. Nothing was sent.");
      if (!token) token = (await (await fetch("/testnet/session", { cache: "no-store" })).json()).token;
      const r = await fetch("/test/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, as: who, ops }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `the test server said ${r.status}`);
      return j.id;
    },
  };
  function choose(name) {
    const p = NET.players.find((x) => x.name === name) || null;
    who = p ? p.name : null;
    W.address = p ? p.address : null;
    try { sessionStorage.setItem("survivor-test-player", who || ""); } catch { /* fine */ }
    for (const fn of subs) { try { fn(); } catch { /* a page error */ } }
    if (onChange) { try { onChange(); } catch { /* a page error */ } }
  }
  window.KWallet = W;
  function bar() {
    const sel = document.getElementById("tn-player");
    if (!sel) return;
    const none = document.createElement("option"); none.value = ""; none.textContent = "watch only"; sel.append(none);
    for (const p of NET.players) { const o = document.createElement("option"); o.value = p.name; o.textContent = `${p.name} (${p.address.slice(0, 6)}…)`; sel.append(o); }
    let saved = ""; try { saved = sessionStorage.getItem("survivor-test-player") || ""; } catch { /* fine */ }
    if (saved && NET.players.some((p) => p.name === saved)) { sel.value = saved; choose(saved); }
    sel.addEventListener("change", () => choose(sel.value));
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bar); else bar();
})();

/* The wallet button in every page's header (one shared component). Load it right after wallet.js.
 * - Shows the active account on every page, kept across pages, reloads and tabs (wallet.js remembers public addresses
 *   only), or "Connect wallet".
 * - Its menu lists every account connected on this device (all the Kondor accounts you shared, KOIN Vault, a guest),
 *   so you can switch between addresses from the same seed in one tap, add another, forget one, or disconnect all.
 * - On a page that doesn't set up the wallet itself, it does (read-only provider; mainnet chain pinned by wallet.js). */
(() => {
  "use strict";
  const W = window.KWallet;
  if (!W || typeof document === "undefined") return;
  const lib = window.koilib || window.koinos || null;
  const short = (a) => (a ? a.slice(0, 5) + "…" + a.slice(-4) : "");
  const KIND = { kondor: "Kondor", vault: "KOIN Vault", guest: "Guest" };

  const css = `
  .hw-wrap{position:relative;margin-left:auto}
  .hw-menu{position:absolute;right:0;top:calc(100% + 8px);z-index:900;min-width:290px;max-width:min(360px,calc(100vw - 32px));background:var(--surface,#fff);color:var(--ink,#22302B);border:1px solid var(--line,#E2DCCC);border-radius:16px;box-shadow:0 18px 50px rgba(0,0,0,.22);padding:8px}
  .hw-menu[hidden]{display:none}
  .hw-h{font-size:12px;color:var(--muted,#5E6B63);padding:6px 10px 4px}
  .hw-row{display:flex;align-items:center;gap:6px}
  .hw-acct{flex:1;display:flex;align-items:center;gap:8px;text-align:left;font:inherit;font-size:14px;padding:9px 10px;border-radius:10px;border:0;background:none;color:inherit;cursor:pointer;min-width:0}
  .hw-acct:hover,.hw-item:hover{background:var(--paper,#F3F1EA)}
  .hw-acct.on{background:var(--violet-soft,#E3EFE7);font-weight:700}
  .hw-addr{font-family:ui-monospace,Consolas,monospace;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .hw-kind{font-size:11px;color:var(--muted,#5E6B63);margin-left:auto;white-space:nowrap}
  .hw-x{font:inherit;font-size:18px;line-height:1;border:0;background:none;color:var(--muted,#5E6B63);cursor:pointer;padding:6px 8px;border-radius:8px}
  .hw-x:hover{background:var(--rose-soft,#F8E2DA);color:var(--rose,#B4432F)}
  .hw-sep{height:1px;background:var(--line,#E2DCCC);margin:6px 4px}
  .hw-item{display:block;width:100%;text-align:left;font:inherit;font-size:14px;padding:9px 10px;border-radius:10px;border:0;background:none;color:inherit;cursor:pointer}
  .hw-item.warn{color:var(--rose,#B4432F)}
  .hw-note{font-size:12px;color:var(--muted,#5E6B63);padding:4px 10px 6px}`;

  function el(tag, attrs = {}, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) { if (k === "text") e.textContent = v; else if (k.startsWith("on")) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v); }
    for (const c of kids) if (c != null) e.append(c);
    return e;
  }
  const toast = (t) => {
    let box = document.getElementById("hw-toast");
    if (!box) { box = el("div", { id: "hw-toast", role: "status", style: "position:fixed;left:50%;bottom:84px;transform:translateX(-50%);z-index:1001;background:var(--navy,#14213D);color:var(--navy-ink,#fff);padding:10px 16px;border-radius:12px;font-size:14px;max-width:calc(100vw - 32px);box-shadow:0 10px 30px rgba(0,0,0,.3)" }); document.body.append(box); }
    box.textContent = t; box.hidden = false; clearTimeout(box._t); box._t = setTimeout(() => { box.hidden = true; }, 6000);
  };

  let btn = null, menu = null;
  function setup() {
    const row = document.querySelector(".top-row");
    if (!row || /[?&]demo\b/.test(location.search)) return;   // the game's demo keeps its own pretend wallet
    if (!document.getElementById("hw-css")) { const s = el("style", { id: "hw-css" }); s.textContent = css; document.head.append(s); }
    // The game page's own button (#connect) is reused; other pages' "Play Knode Games" link becomes the wallet button.
    const old = row.querySelector("#connect, .btn-wallet");
    btn = old && old.tagName === "BUTTON" ? old : el("button", { class: "btn btn-wallet", type: "button" });
    btn.id = btn.id || "hw-btn";
    btn.setAttribute("aria-haspopup", "menu"); btn.setAttribute("aria-expanded", "false");
    menu = el("div", { class: "hw-menu", role: "menu", hidden: "" });
    const wrap = el("div", { class: "hw-wrap" });
    (old || row.lastElementChild).replaceWith(wrap);
    if (!old) row.append(wrap);
    wrap.append(btn, menu);
    btn.addEventListener("click", (e) => { e.stopPropagation(); if (!W.address && !W.accounts().length) return connect(); toggle(); });
    document.addEventListener("click", (e) => { if (!menu.hidden && !menu.contains(e.target)) toggle(false); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !menu.hidden) { toggle(false); btn.focus(); } });
    paint();
  }
  async function connect() {
    toggle(false);
    try { await W.connect(); } catch (e) { toast(String(e.message || e)); }
  }
  function toggle(open = menu.hidden) {
    menu.hidden = !open; btn.setAttribute("aria-expanded", String(open));
    if (open) renderMenu();
  }
  function paint() {
    if (!btn) return;
    btn.textContent = W.address ? (W.kind === "guest" ? `Guest ${short(W.address)}` : short(W.address)) : "Connect wallet";
    btn.classList.toggle("connected", !!W.address);
    btn.title = W.address ? `${KIND[W.kind] || "Wallet"}: ${W.address}` : "Connect a Koinos wallet";
    if (!menu.hidden) renderMenu();
  }
  function renderMenu() {
    const list = W.accounts();
    const kids = [el("div", { class: "hw-h", text: list.length ? "Your accounts on this device" : "No wallet connected" })];
    for (const a of list) {
      const on = a.address === W.address;
      kids.push(el("div", { class: "hw-row" },
        el("button", { class: "hw-acct" + (on ? " on" : ""), type: "button", role: "menuitemradio", "aria-checked": String(on), title: a.address,
          onclick: () => { if (!on) { W.switchTo(a.address); toast(`Switched to ${short(a.address)} (${KIND[a.kind]}).`); } toggle(false); } },
          el("span", { "aria-hidden": "true", text: on ? "●" : "○" }), el("span", { class: "hw-addr", text: a.address }), el("span", { class: "hw-kind", text: KIND[a.kind] })),
        el("button", { class: "hw-x", type: "button", "aria-label": `Forget ${a.address} on this device`, title: "Forget on this device", onclick: (e) => { e.stopPropagation(); W.forget(a.address); renderMenu(); } }, "×")));
    }
    kids.push(el("div", { class: "hw-sep" }));
    kids.push(el("button", { class: "hw-item", type: "button", role: "menuitem", onclick: connect }, list.length ? "＋ Add another account" : "Connect a wallet"));
    if (W.address) {
      kids.push(el("button", { class: "hw-item", type: "button", role: "menuitem", onclick: async () => { try { await navigator.clipboard.writeText(W.address); toast("Address copied."); } catch { toast(W.address); } toggle(false); } }, "Copy address"));
      if (W.kind === "guest" && W.manageGuest) kids.push(el("button", { class: "hw-item", type: "button", role: "menuitem", onclick: () => { toggle(false); W.manageGuest(); } }, "Guest wallet: back up, restore, forget"));
    }
    if (list.length || W.address) kids.push(el("button", { class: "hw-item warn", type: "button", role: "menuitem", onclick: () => { toggle(false); W.disconnect(); toast("Disconnected. Nothing is remembered on this device."); } }, "Disconnect all"));
    kids.push(el("div", { class: "hw-note", text: "Kondor: “Add another account” shares more accounts from the same seed. Only addresses are remembered here, never keys." }));
    menu.replaceChildren(...kids);
  }

  W.subscribe(() => paint());
  // Pages that set the wallet up themselves (game, swap, burn, Mana) call init with their own settings; init may run
  // more than once, so set it up here too for every other page.
  W.init({ provider: lib && lib.Provider ? new lib.Provider(["https://api.koinos.io"]) : null, toast });
  // Guest play is offered on every page: read the owner's switch (game-data/deployment.json, this site's own file).
  if (W.setGuestConfig && window.KGuest) {
    const base = location.pathname.includes("/site/") ? "../" : "./";
    fetch(base + "game-data/deployment.json", { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d && d.sponsor) W.setGuestConfig({ payer: d.payer, sponsor: d.sponsor }); }).catch(() => { /* no guest option then */ });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", setup); else setup();
})();

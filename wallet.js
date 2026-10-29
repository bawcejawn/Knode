/* Knode Games wallet layer: one way to connect and sign, two wallets.
 *   - Kondor: the browser extension (desktop).
 *   - Guest: a play-only key kept in this browser (site/guest.js). It signs only game answers, paid by the Knode Games Mana
 *     sponsor, so anyone can play the daily questions for free with no extension, app or KOIN.
 *   - KOIN Vault: passkey smart accounts on the phone (https://koinvault.app), via its website connection API
 *     (docs/website-integration.md in therexdev/koin-vault). The user approves every transaction in KOIN Vault;
 *     this page never sees a key or a passkey. The session secret lives only in page memory (never in storage); it goes
 *     in a URL only for KOIN Vault's two GET status calls (status, request-status), every other call posts it.
 * Usage: KWallet.init({ provider, onChange(address) }); await KWallet.connect(); await KWallet.send(label, ops).
 * `ops` are koilib operations ({ call_contract: { contract_id, entry_point, args } }), built with onlyOperation. */
(() => {
  "use strict";
  // GitHub Pages cannot send X-Frame-Options or frame-ancestors, so a wallet page refuses to run inside a frame
  // (another site could lay it under its own content and trick a click).
  if (window.top !== window.self) {
    document.documentElement.style.display = "none";
    try { window.top.location.replace(window.self.location.href); } catch { /* a parent we may not navigate: stay hidden */ }
    return;
  }
  const VAULT = "https://koinvault.app"; const STATUS_CALLS = new Set(["status", "request-status"]); // GET-only in KOIN Vault's API
  const lib = window.koilib || window.koinos || window;
  const store = {
    get: (s, k) => { try { return s.getItem(k); } catch { return null; } },
    set: (s, k, v) => { try { v == null ? s.removeItem(k) : s.setItem(k, v); } catch {} },
  };
  const W = { kind: null, address: null, provider: null, onChange: () => {}, session: null, poll: null };
  const isPhone = () => /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.platform));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const withTimeout = (p, ms, msg) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);

  // ── tiny modal ──
  const css = `
  .kw-back{position:fixed;inset:0;background:rgba(10,12,30,.55);display:flex;align-items:flex-end;justify-content:center;z-index:1000;padding:0}
  @media(min-width:560px){.kw-back{align-items:center;padding:16px}}
  .kw-box{background:var(--surface,#fff);color:var(--ink,#181b34);width:100%;max-width:420px;border-radius:22px 22px 0 0;padding:22px 20px 26px;box-shadow:0 20px 60px rgba(0,0,0,.35);max-height:92vh;overflow:auto}
  @media(min-width:560px){.kw-box{border-radius:22px}}
  .kw-box h3{font-family:var(--display,inherit);font-size:21px;margin:0 0 6px}
  .kw-box p{margin:6px 0;color:var(--muted,#5d6283);font-size:14px;line-height:1.45}
  .kw-opt{display:flex;gap:12px;align-items:center;width:100%;text-align:left;font:inherit;padding:14px;margin-top:10px;border-radius:14px;border:1px solid var(--line,#e2e4ef);background:var(--paper,#f4f5fb);color:inherit;cursor:pointer}
  .kw-opt b{display:block;font-size:16px}.kw-opt span{font-size:13px;color:var(--muted,#5d6283)} .kw-opt .kw-ic{font-size:26px;line-height:1}
  .kw-tag{display:inline-block;font-size:11px;font-weight:700;padding:2px 7px;border-radius:99px;background:var(--violet-soft,#ece9ff);color:var(--violet,#5a43e6);margin-left:6px;vertical-align:2px}
  .kw-go{display:block;text-align:center;margin-top:14px;padding:13px;border-radius:99px;background:var(--violet,#5a43e6);color:var(--violet-ink,#fff);font-weight:700;text-decoration:none}
  .kw-qr{display:flex;justify-content:center;margin:14px 0 4px}.kw-qr svg,.kw-qr img{width:200px;height:200px;background:#fff;padding:8px;border-radius:12px}
  .kw-status{margin-top:12px;font-size:14px;color:var(--ink,#181b34);min-height:1.3em}
  .kw-x{float:right;font:inherit;font-size:22px;line-height:1;border:0;background:none;color:var(--muted,#5d6283);cursor:pointer;padding:0 0 0 10px}
  .kw-link{font:inherit;background:none;border:0;color:var(--violet,#5a43e6);text-decoration:underline;cursor:pointer;padding:0;font-size:14px}
  .kw-opt[disabled]{opacity:.55;cursor:not-allowed}
  .kw-warn{background:var(--sun-soft,#fff4dc);color:var(--ink,#181b34)!important;border-radius:10px;padding:10px 12px}
  .kw-key{font-family:ui-monospace,Consolas,monospace;font-size:13px;word-break:break-all;background:var(--paper,#f4f5fb);border:1px solid var(--line,#e2e4ef);border-radius:10px;padding:10px;margin:8px 0}
  .kw-row{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
  .kw-btn{font:inherit;font-weight:700;font-size:14px;padding:10px 14px;min-height:44px;border-radius:99px;border:1px solid var(--line,#e2e4ef);background:var(--surface,#fff);color:var(--ink,#181b34);cursor:pointer}
  .kw-btn.kw-danger{color:var(--rose,#d93f4c)}
  .kw-in{width:100%;box-sizing:border-box;font:inherit;font-size:14px;padding:10px;border-radius:10px;border:1px solid var(--line,#e2e4ef);margin-top:8px}`;
  function ensureCss() { if (!document.getElementById("kw-css")) { const s = document.createElement("style"); s.id = "kw-css"; s.textContent = css; document.head.append(s); } }
  function h(tag, attrs = {}, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) { if (k.startsWith("on")) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v); }
    for (const c of kids) if (c != null) e.append(c);
    return e;
  }
  let modal = null;
  function open(...content) {
    ensureCss(); close();
    const box = h("div", { class: "kw-box", role: "dialog", "aria-modal": "true" }, h("button", { class: "kw-x", type: "button", "aria-label": "Close", onclick: () => close(true) }, "×"), ...content);
    modal = h("div", { class: "kw-back", onclick: (e) => { if (e.target === modal) close(true); } }, box);
    document.body.append(modal);
    return box;
  }
  let onClose = null;
  function close(byUser = false) { if (modal) { modal.remove(); modal = null; } const f = onClose; onClose = null; if (byUser && f) f(); }

  // ── KOIN Vault API ──
  async function vaultApi(path, { body, query } = {}) {
    const url = new URL("/api/dapp/" + path, VAULT);
    if (query) { if (!STATUS_CALLS.has(path)) throw new Error("credentials go in a URL only for KOIN Vault's status calls"); url.search = new URLSearchParams(query).toString(); }
    const res = await fetch(url, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer",
    });
    let data = {}; try { data = await res.json(); } catch { /* hosting error page */ }
    if (!res.ok || data.ok !== true) { const e = new Error(data.error || `KOIN Vault answered ${res.status}`); e.status = res.status; throw e; }
    return data;
  }
  const creds = () => ({ sessionId: W.session.sessionId, secret: W.session.secret });

  // ── Remembered accounts: so the wallet stays connected across pages, reloads and tabs ──
  // Only public data is kept (in localStorage): each account's wallet kind and address, and which one is active.
  // Never a key, a KOIN Vault session secret, or a signature. A remembered account still has to be signed for by its
  // own wallet: Kondor signs only for accounts it holds, and KOIN Vault asks for a fresh approval (and must name the
  // same address) before anything is sent. "Disconnect" forgets all of it.
  const ACCTS = "kw-accounts", ACTIVE = "kw-active", KINDS = ["kondor", "vault", "guest"], MAX_ACCTS = 20;
  const isAddr = (a) => typeof a === "string" && /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a);
  function remembered() {
    let r = null; try { r = JSON.parse(store.get(localStorage, ACCTS) || "[]"); } catch { r = null; }
    if (!Array.isArray(r)) return [];
    const seen = new Set(), out = [];
    for (const x of r) if (x && KINDS.includes(x.kind) && isAddr(x.address) && !seen.has(x.address) && out.length < MAX_ACCTS) { seen.add(x.address); out.push({ kind: x.kind, address: x.address }); }
    return out;
  }
  const saveAccts = (list) => store.set(localStorage, ACCTS, list.length ? JSON.stringify(list.map(({ kind, address }) => ({ kind, address }))) : null);
  function remember(kind, address) {
    if (!isAddr(address)) return;
    const list = remembered(), i = list.findIndex((x) => x.address === address);
    if (i >= 0) list[i] = { kind, address }; else list.push({ kind, address });
    saveAccts(list.slice(-MAX_ACCTS));
  }
  function forgetAcct(address) { saveAccts(remembered().filter((x) => x.address !== address)); }
  const listeners = new Set();
  function notify() { for (const f of [W.onChange, ...listeners]) { try { f(W.address, W.kind); } catch { /* one listener never stops the others */ } } }

  function setAddress(kind, address) {
    const changed = address !== W.address || (address && kind !== W.kind);
    W.kind = address ? kind : null; W.address = address || null;
    store.set(localStorage, "kw-kind", W.kind);
    store.set(localStorage, ACTIVE, W.address);
    if (W.address) remember(W.kind, W.address);
    if (changed) notify();
  }
  /** The KOIN Vault session ended. On a plain expiry the address stays (the next action asks KOIN Vault again); when the
   *  wallet itself disconnected or switched accounts (`forget`), that account is forgotten here too. */
  function dropVault(reason, forget = false) {
    if (W.poll) { clearTimeout(W.poll); W.poll = null; }
    W.session = null; store.set(sessionStorage, "kw-vault", null);
    if (forget && W.kind === "vault") { forgetAcct(W.address); setAddress(null, null); }
    if (reason && W.toast) W.toast(reason, 7000);
  }
  /** Keep checking the KOIN Vault session so a disconnect or expiry in the wallet also clears this page. */
  function watchVault() {
    if (W.poll) clearTimeout(W.poll);
    let fails = 0;
    const tick = async () => {
      if (!W.session) return;
      if (Date.now() > W.session.expiresAt) return dropVault("KOIN Vault connection expired (they last 30 minutes). Your next action asks KOIN Vault again.");
      if (!document.hidden) {
        try {
          const st = await vaultApi("status", { query: creds() }); fails = 0;
          if (!st.connected || (W.address && st.address !== W.address)) return dropVault("KOIN Vault disconnected. Connect again to keep playing.", true);
        } catch (e) {
          if (e.status === 404 || e.status === 410) return dropVault("KOIN Vault connection ended. Your next action asks KOIN Vault again.");
          fails++;
        }
      }
      W.poll = setTimeout(tick, Math.min(30000, 5000 * (1 + fails)));
    };
    W.poll = setTimeout(tick, 5000);
  }

  let qrLib = null;
  function loadQr() {
    if (window.qrcode) return Promise.resolve(window.qrcode);
    if (!qrLib) qrLib = new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = "https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js"; s.integrity = "sha384-mZT2gIty7ZDdOGkxfP6joZcYdMW1Jvj9dRlfpTmaJAKKXTqzygtB22k7FLe+KZC1"; s.crossOrigin = "anonymous";
      s.onload = () => res(window.qrcode); s.onerror = () => rej(new Error("QR code didn't load"));
      document.head.append(s);
    });
    return qrLib;
  }

  async function connectVault() {
    const status = h("div", { class: "kw-status", role: "status" }, "Starting a secure connection…");
    const go = h("a", { class: "kw-go", href: VAULT, target: "_blank", rel: "noopener noreferrer", referrerpolicy: "no-referrer", hidden: "" }, "Open KOIN Vault");
    const qr = h("div", { class: "kw-qr" });
    const box = open(h("h3", {}, "Connect KOIN Vault"),
      h("p", {}, isPhone() ? "Tap Open KOIN Vault, approve Knode (Knode Games) with your fingerprint or face, then come back to this tab." : "Scan with your phone (or use Connect inside KOIN Vault), approve Knode (Knode Games) with your passkey, and this page connects by itself."),
      qr, go, status,
      h("p", {}, "No KOIN Vault yet? ", h("a", { href: VAULT, target: "_blank", rel: "noopener" }, "Create one at koinvault.app"), " in a minute, no extension needed."));
    let cancelled = false; onClose = () => { cancelled = true; };
    try {
      const s = await vaultApi("create", { body: { name: "Knode" } });   // the name KOIN Vault knows this dapp by; rename only after checking with KOIN Vault
      const link = new URL(s.uri);
      if (link.origin !== VAULT || link.pathname !== "/") throw new Error("unexpected wallet address");
      go.href = s.uri; go.hidden = false;
      if (!isPhone()) {
        loadQr().then((q) => { const c = q(0, "M"); c.addData(s.uri); c.make(); qr.innerHTML = c.createSvgTag({ cellSize: 4, margin: 2, scalable: true }); }).catch(() => {});
      }
      status.textContent = "Waiting for your approval in KOIN Vault…";
      const until = Math.min(s.expiresAt, Date.now() + 10 * 60000);
      while (!cancelled && Date.now() < until) {
        await sleep(2000);
        if (cancelled) break;
        let st; try { st = await vaultApi("status", { query: { sessionId: s.sessionId, secret: s.secret } }); }
        catch (e) { if (e.status === 404 || e.status === 410) throw new Error("The connection expired. Try again."); status.textContent = "Connection hiccup, still waiting…"; continue; }
        if (cancelled) break;                                     // the dialog was closed while the status call ran
        if (st.connected && st.address) {
          W.session = { sessionId: s.sessionId, secret: s.secret, expiresAt: s.expiresAt };
          store.set(sessionStorage, "kw-vault", null);           // the secret stays in this page's memory only
          setAddress("vault", st.address);
          watchVault();
          close();
          return st.address;
        }
      }
      if (!cancelled) throw new Error("No approval arrived. Try again.");
      return null;
    } catch (e) {
      if (box.isConnected) status.textContent = /Failed to fetch|NetworkError|Load failed/i.test(String(e.message)) ? "Couldn't reach KOIN Vault. Check your connection and try again." : String(e.message || e);
      return null;
    }
  }

  async function connectKondor() {
    close();
    if (!window.kondor) { W.toast && W.toast("Kondor isn't installed in this browser. On a phone, use KOIN Vault.", 7000); return null; }
    const accounts = await withTimeout(window.kondor.getAccounts(), 15000, "No answer from Kondor. Is the extension installed and unlocked?");
    if (!accounts || !accounts.length) { W.toast && W.toast("Kondor shared no account. Open Kondor and allow this site.", 7000); return null; }
    const addrs = accounts.map((a) => a && a.address).filter((a) => typeof a === "string" && a.length > 0);   // only real addresses are remembered
    if (!addrs.length) { W.toast && W.toast("Kondor shared no account. Open Kondor and allow this site.", 7000); return null; }
    for (const a of addrs) remember("kondor", a);
    setAddress("kondor", addrs.includes(W.address) ? W.address : addrs[0]);
    return W.address;
  }

  /** Ask which wallet, then connect it. Resolves to the address, or null if cancelled. */
  function connect() {
    return new Promise((resolve) => {
      const phone = isPhone();
      const pick = (fn) => async () => { onClose = null; try { resolve(await fn()); } catch (e) { W.toast && W.toast(String(e.message || e), 7000); resolve(null); } };
      const kondor = h("button", { class: "kw-opt", type: "button", onclick: pick(connectKondor) }, h("span", { class: "kw-ic", "aria-hidden": "true" }, "🧩"),
        h("div", {}, h("b", {}, "Kondor", !phone && window.kondor ? h("span", { class: "kw-tag" }, "found") : null), h("span", {}, "Browser extension, on a computer")));
      const vault = h("button", { class: "kw-opt", type: "button", onclick: pick(connectVault) }, h("span", { class: "kw-ic", "aria-hidden": "true" }, "📱"),
        h("div", {}, h("b", {}, "KOIN Vault", phone ? h("span", { class: "kw-tag" }, "for phones") : null), h("span", {}, "Fingerprint or face, no extension. Works on any phone")));
      const guest = guestOption(pick);
      open(h("h3", {}, "Connect a wallet"), h("p", {}, "Your wallet signs everything. Knode Games never sees a key."), ...(phone ? [vault, kondor] : [kondor, vault]), guest);
      onClose = () => resolve(null);
    });
  }

  // ── Guest (site/guest.js) ──
  const GUEST_WARN = "Play-only wallet stored in this browser. Never send KOIN or VHP to it.";
  // Audit (guest) M-2: say plainly that the browser itself can delete the key.
  const GUEST_EVICT = "Your browser can delete this guest by itself (Safari does after 7 days without a visit). Back up the key to keep your points.";
  // Audit (guest) L-1: a key someone hands you is theirs, not yours.
  const RESTORE_WARN = "Only paste a key you backed up yourself. Anyone who gives you a key can take it back.";
  // Audit (guest) L-3: what a guest sees when the sponsor won't pay (never Kondor or KOIN Vault advice).
  const GUEST_NO_FREE = "Free answers are used up for today — try again after 00:00 UTC (5pm PT), or connect a wallet.";
  // Audit SP-18: say which limit it was. The free pool is released by the hour (sponsor v3), so "this hour" first.
  const guestRefusal = (m) =>
    /free-player|free answers|FREE_USED_UP|free play/i.test(m) ? "Today's free play is used up for this hour — more opens on the hour (UTC). Try again then, or connect a wallet."
      : /this player's daily/i.test(m) ? "This guest has used its free Mana for today — try again after 00:00 UTC (5pm PT)."
      : /weekly/i.test(m) ? "This guest has used its free Mana for this week — try again Monday (00:00 UTC)."
      : /today's sponsored mana is used up/i.test(m) ? GUEST_NO_FREE
      : /mana limit above|per-transaction cap|what these actions may ask/i.test(m) ? "The page asked for more Mana than the sponsor allows for this action (the site is being updated). Try again in a few minutes."
      : /insufficient|\brc\b|rc_limit|resource/i.test(m) ? "The network turned this down for lack of Mana. Nothing happened; try again in a few minutes."
      : GUEST_NO_FREE;
  // Audit (guest) L-5: on Koinos mainnet a guest only ever names the live Knode Games sponsor as payer and only answers on the
  // Knode Games question game, whatever deployment.json says (pinned like the chain id).
  const PINNED_SPONSOR = "1ByDDSBUzy5zkRceELc54Jh8i41yNRoKt8", PINNED_GAME = "1Mpmf2ERhjYpX7CCiM11WERuM4j17uT1sr";
  // The Producer Race picks contract, pinned the same way once it is on mainnet (race-data/deployment.json). Until
  // then guests can't pick (empty = none).
  const PINNED_RACE = "1EN7xU8R9tQXjHvrX79qZvvvGkkKWVnB5K";
  const guestGame = () => (W.chainId === MAINNET_CHAIN_ID ? PINNED_GAME : (W.gameContract || null));
  const guestRace = () => (W.chainId === MAINNET_CHAIN_ID ? (PINNED_RACE || null) : ((W.sponsor && W.sponsor.race) || null));
  // The KnodeGames Picks contract (picks-data/deployment.json), pinned the same way once it is on mainnet. Until then
  // guests can't make KnodeGames picks (empty = none).
  const PINNED_PICKS = "";
  const guestPicks = () => (W.chainId === MAINNET_CHAIN_ID ? (PINNED_PICKS || null) : ((W.sponsor && W.sponsor.picks) || null));
  /** A guest may sign only free play: game answers, picks on the race contract, and KnodeGames picks. */
  const guestOp = (o, game, race, picks) => !!(o && o.call_contract && ((game && o.call_contract.contract_id === game && Number(o.call_contract.entry_point) === ANSWER)
    || (race && o.call_contract.contract_id === race && Number(o.call_contract.entry_point) === PICK)
    || (picks && o.call_contract.contract_id === picks && Number(o.call_contract.entry_point) === PICK)));
  // Owner switch: guest play is on only when game-data/deployment.json has "sponsor": { ..., "guest": true }. Keep it off
  // the site now has its own domain (knodegames.com), so no other Pages site shares its storage.
  // Pages that set the wallet up without the sponsor (swap, burn, the info pages) still offer guest play: the header
  // reads game-data/deployment.json and passes its sponsor settings here (setGuestConfig), so the switch is the same
  // everywhere. A guest still signs only free play (answers and race picks); anything else is refused with a reason.
  const guestCfg = () => (W.sponsor && W.sponsor.guest === true ? W.sponsor : W.guestConfig && W.guestConfig.guest === true ? W.guestConfig : null);
  // Audit BX-1 / BX-40 / BX-51: guest keys exist only on Knode Games' own address (and this computer, for testing). Not
  // a list of bad addresses (*.github.io, a trailing dot, file: pages would slip past one) but the few good ones.
  // Everywhere else every guest path is closed: create, restore, backup, reconnect, switch and sign never touch the key.
  const GUEST_ORIGINS = ["knodegames.com", "www.knodegames.com", "localhost", "127.0.0.1"];
  const guestOrigin = () => {
    try { const l = window.location; return !!l && (l.protocol === "https:" || l.protocol === "http:") && GUEST_ORIGINS.includes(String(l.hostname || "")); } catch { return false; }
  };
  const NO_GUEST = () => Promise.reject(new Error("Guest play is only on knodegames.com."));
  const guestLib = () => (guestOrigin() && window.KGuest ? window.KGuest
    : { load: NO_GUEST, create: NO_GUEST, restore: NO_GUEST, forget: NO_GUEST, signer: NO_GUEST, backupWif: NO_GUEST, isWif: () => false, lastAddress: () => null });
  const guestOn = () => guestOrigin() && !!guestCfg();
  // Ready only while the sponsor pays (deployment.json "payer": "sponsor"): the page's own setting, or the header's copy.
  const guestPayer = () => (W.sponsor && W.sponsor.guest === true ? W.payer : W.guestConfig ? W.guestConfig.payer : "self");
  const guestReady = () => { const g = guestCfg(); return !!(guestOrigin() && window.KGuest && g && typeof g.address === "string" && g.address && guestPayer() === "sponsor"); };
  function guestOption(pick) {
    if (!window.KGuest || !guestOn()) return null;   // guest.js missing, or guest play switched off (every page loads it; a guest signs only answers and picks)
    const ready = guestReady();
    const btn = h("button", { class: "kw-opt", type: "button", ...(ready ? {} : { disabled: "", "aria-disabled": "true" }), onclick: ready ? pick(connectGuest) : () => {} },
      h("span", { class: "kw-ic", "aria-hidden": "true" }, "🎟️"),
      h("div", {}, h("b", {}, "Play as a guest", h("span", { class: "kw-tag" }, "free")),
        h("span", {}, ready ? "No wallet, no KOIN. Answer the daily questions and pick race horses for free on this device." : "Guest play turns on when the Mana sponsor is live.")));
    if (!ready) return btn;
    return h("div", {}, btn, h("p", {}, "Moving from another phone? ", h("button", { class: "kw-link", type: "button", onclick: pick(restoreGuest) }, "Restore a guest key")));
  }
  async function connectGuest() {
    close();
    let g = await guestLib().load();
    const isNew = !g;
    if (!g) {
      // Audit (guest) M-2: a guest this device had before is gone (the browser cleared it): say so, don't silently start over.
      const last = guestLib().lastAddress && guestLib().lastAddress();
      if (last) return guestMissing(last);
      g = await guestLib().create();
    }
    setAddress("guest", g.address);
    if (isNew) guestWelcome(g.address);
    return g.address;
  }
  function guestMissing(last) {
    return new Promise((resolve) => {
      open(h("h3", {}, "Your guest isn't here any more"),
        h("p", {}, `Your previous guest ${last.slice(0, 6)}…${last.slice(-4)} is no longer on this device. Restore it from your backup, or start a new guest.`),
        h("div", { class: "kw-row" },
          h("button", { class: "kw-btn", type: "button", onclick: async () => { resolve(await restoreGuest()); } }, "Restore from backup"),
          h("button", { class: "kw-btn", type: "button", onclick: async () => {
            close();
            try { const g = await guestLib().create(); setAddress("guest", g.address); guestWelcome(g.address); resolve(g.address); }
            catch (e) { W.toast && W.toast(String(e.message || e), 8000); resolve(null); }
          } }, "Start a new guest")));
      onClose = () => resolve(null);
    });
  }
  function guestWelcome(address) {
    open(h("h3", {}, "You're playing as a guest"),
      h("p", {}, "Your guest wallet is ", h("b", {}, address.slice(0, 6) + "…" + address.slice(-4)), ". Answering is free: the Knode Games Mana sponsor pays."),
      h("p", { class: "kw-warn" }, GUEST_WARN),
      h("p", {}, "It lives only in this browser. Back it up if you want to keep your points when you change phone or clear your browser."),
      // Audit (guest) M-2: the browser can delete it by itself (Safari after 7 days without a visit).
      h("p", { class: "kw-warn" }, GUEST_EVICT),
      h("div", { class: "kw-row" }, h("button", { class: "kw-btn", type: "button", onclick: () => backupGuest() }, "Back up guest key"), h("button", { class: "kw-btn", type: "button", onclick: () => close() }, "Start playing")));
  }
  async function backupGuest() {
    // Audit (guest) L-4: read the key fresh, and show it only if it is the guest this page is connected as.
    const wif = await guestLib().backupWif();
    if (!wif) { close(); W.toast && W.toast("No guest key on this device.", 6000); return; }
    let keyAddress = null;
    try { keyAddress = lib.Signer.fromWif(wif).getAddress(); } catch { /* unreadable */ }
    if (!keyAddress || (W.kind === "guest" && W.address && keyAddress !== W.address)) {
      open(h("h3", {}, "Reload the page first"),
        h("p", {}, "The guest key stored on this device isn't the guest this page is connected as (it was changed in another tab). Reload the page, then back it up."));
      return;
    }
    const key = h("div", { class: "kw-key", hidden: "" }, wif);
    const reveal = h("button", { class: "kw-btn", type: "button", onclick: () => { key.hidden = false; reveal.hidden = true; copy.hidden = false; } }, "Tap to reveal");
    const copy = h("button", { class: "kw-btn", type: "button", hidden: "", onclick: async () => { try { await navigator.clipboard.writeText(wif); copy.textContent = "Copied"; } catch { copy.textContent = "Select and copy it"; } } }, "Copy");
    open(h("h3", {}, "Back up your guest key"),
      h("p", { class: "kw-warn" }, "Anyone with this key controls this guest wallet. Keep it private: never paste it into a website or message."),
      h("p", {}, GUEST_WARN),
      h("p", {}, "Guest ", h("b", {}, keyAddress)),
      reveal, key, h("div", { class: "kw-row" }, copy),
      h("p", { class: "kw-warn" }, GUEST_EVICT),
      h("p", {}, "To restore it on another phone: Connect wallet → Play as a guest → Restore a guest key."));
  }
  async function restoreGuest() {
    const input = h("input", { class: "kw-in", type: "password", autocomplete: "off", autocapitalize: "off", spellcheck: "false", placeholder: "Paste your guest key (starts with K or L)" });
    const status = h("div", { class: "kw-status", role: "status" });
    return new Promise((resolve) => {
      const go = h("button", { class: "kw-btn", type: "button", onclick: async () => {
        try {
          if (!guestLib().isWif(input.value)) { status.textContent = "That isn't a valid private key (WIF)."; return; }
          if (!window.confirm(`${RESTORE_WARN} Continue?`)) return;
          if (await guestLib().load() && !window.confirm("This replaces the guest already on this device. Make sure it's backed up. Continue?")) return;
          const g = await guestLib().restore(input.value);
          input.value = "";
          setAddress("guest", g.address); close(); resolve(g.address);
        } catch (e) { status.textContent = String(e.message || e); }
      } }, "Restore");
      open(h("h3", {}, "Restore a guest key"), h("p", {}, "Paste the guest key you backed up. It stays in this browser."), h("p", { class: "kw-warn" }, RESTORE_WARN), input, h("div", { class: "kw-row" }, go), status, h("p", { class: "kw-warn" }, GUEST_WARN));
      onClose = () => resolve(null);
    });
  }
  /** The menu behind the wallet button for a guest: back up, restore, disconnect, forget. */
  function manageGuest() {
    open(h("h3", {}, "Guest wallet"),
      h("p", {}, W.address ? W.address : ""),
      h("p", { class: "kw-warn" }, GUEST_WARN),
      h("div", { class: "kw-row" },
        h("button", { class: "kw-btn", type: "button", onclick: () => backupGuest() }, "Back up guest key"),
        h("button", { class: "kw-btn", type: "button", onclick: () => restoreGuest() }, "Restore a guest key"),
        h("button", { class: "kw-btn", type: "button", onclick: () => { close(); disconnect(); } }, "Disconnect"),
        h("button", { class: "kw-btn kw-danger", type: "button", onclick: async () => {
          if (!window.confirm("Forget this guest? Without a backup its points and any prize are gone for good.")) return;
          await guestLib().forget(); close(); forget(W.address); W.toast && W.toast("Guest forgotten on this device.", 6000);
        } }, "Forget this guest")),
      h("p", {}, "Want to stake and share the weekly pool? ", h("a", { href: "get.html" }, "Get a wallet and VHP"), "."));
  }
  /** Explain why a guest can't do something, instead of failing silently. */
  function guestCant(ops) {
    const game = guestGame();
    const isClaim = ops.some((o) => o && o.call_contract && o.call_contract.contract_id === game && Number(o.call_contract.entry_point) === CLAIM);
    if (isClaim) {
      open(h("h3", {}, "Collect your prize"),
        // Audit (guest) L-2: a free player's claim must use its own Mana; the sponsor doesn't pay it yet.
        h("p", {}, "Congratulations! Your prize is safe in the game and never expires."),
        h("p", {}, "Collecting it from a guest wallet comes with the next Mana sponsor update; or back up this key, import it into Kondor (Import account → private key) and hold a little KOIN there to claim now."),
        h("div", { class: "kw-row" }, h("button", { class: "kw-btn", type: "button", onclick: () => backupGuest() }, "Back up guest key")),
        h("p", { class: "kw-warn" }, GUEST_WARN));
      return new Error("A guest can't collect yet: your prize is safe and never expires.");
    }
    open(h("h3", {}, "Connect KOIN Vault or Kondor to stake"),
      h("p", {}, "A guest wallet is for answering the daily questions only. To stake, withdraw or swap, connect a real wallet that holds your VHP."),
      h("div", { class: "kw-row" }, h("a", { class: "kw-btn", href: "get.html" }, "How to get a wallet and VHP")),
      h("p", { class: "kw-warn" }, GUEST_WARN));
    return new Error("Guests can only answer questions. Connect KOIN Vault or Kondor to stake.");
  }
  /** Sign a guest's answers with the local key, paid by the sponsor, after checking exactly what will be sent. */
  async function sendGuest(label, ops) {
    const sp = sponsorFor(ops);
    const game = guestGame();
    const race = guestRace(), picks = guestPicks();
    // What a guest may sign is checked first, so a swap or a stake gets "connect a real wallet", not a sponsor message.
    const freeOnly = !!game && ops.length > 0 && ops.every((o) => guestOp(o, game, race, picks));
    if (!freeOnly) throw guestCant(ops);
    if (W.chainId === MAINNET_CHAIN_ID && (!sp || sp.address !== PINNED_SPONSOR || !Array.isArray(sp.covers) || !sp.covers.includes(PINNED_GAME)))
      throw new Error("Guest play is paused: the page's Mana sponsor settings aren't the live Knode Games sponsor. Nothing was sent.");
    if (!sp) throw new Error("Guest play works on the game pages. Nothing was sent.");
    const rcLimit = rcFor(sp, ops, String(sp.rcLimit || "100000000"));
    if (!(await sponsorSaysYes(sp, rcLimit, true))) throw new Error(GUEST_NO_FREE);
    const signer = await guestLib().signer();
    if (signer.getAddress() !== W.address) throw new Error("The guest key on this device changed. Reconnect as a guest.");
    signer.provider = W.provider;
    const tx = new lib.Transaction({ signer, provider: W.provider, options: { payer: sp.address, payee: W.address, rcLimit, chainId: W.chainId } });
    for (const op of ops) await tx.pushOperation(op);
    const prepared = await tx.prepare({ payer: sp.address, payee: W.address, rcLimit, chainId: W.chainId });
    checkGuestTx(prepared, { sponsor: sp.address, payee: W.address, chainId: W.chainId, game, race, picks, rcLimit });
    W.status && W.status(`Sending “${label}” (free: the Mana sponsor pays)…`);
    tx.transaction = await tx.sign();
    checkGuestTx(tx.transaction, { sponsor: sp.address, payee: W.address, chainId: W.chainId, game, race, picks, rcLimit });
    let receipt;
    try { receipt = await tx.send(); }
    catch (e) {
      // Never retried with the guest's own Mana (it has none). A sponsor refusal gets the guest message; a game error
      // (e.g. "answers for this question are closed") is shown as is.
      const m = String((e && e.message) || e);
      if (/SPONSOR|insufficient|\brc\b|rc_limit|mana|payer|authori[sz]/i.test(m)) throw new Error(guestRefusal(m));
      throw e;
    }
    if (receipt && receipt.reverted) throw new Error(JSON.stringify(receipt.logs || "the contract refused it"));
    const id = tx.transaction && tx.transaction.id;
    W.status && W.status("Sent. Waiting for the next block…");
    guestNudge();
    if (id) { try { await W.provider.wait(id, "byBlock", 90000); return id; } catch { return null; } }
    return null;
  }
  /** Audit (guest) M-2: once, after a guest's first answer, ask them to back the key up. */
  function guestNudge() {
    if (store.get(localStorage, "kn-guest-nudged") === "1") return;
    store.set(localStorage, "kn-guest-nudged", "1");
    setTimeout(() => {
      open(h("h3", {}, "Back up your guest"),
        h("p", {}, "Nice, your first answer is in! " + GUEST_EVICT),
        h("div", { class: "kw-row" }, h("button", { class: "kw-btn", type: "button", onclick: () => backupGuest() }, "Back up guest key"), h("button", { class: "kw-btn", type: "button", onclick: () => close() }, "Later")));
    }, 0);
  }
  /** Throws unless the transaction is exactly: the sponsor pays, this guest is the payee, Koinos mainnet (or the pinned
   *  chain), within the asked Mana limit, and every operation is a game answer. */
  function checkGuestTx(tx, want) {
    const hd = tx && tx.header;
    if (!hd) throw new Error("Couldn't build the transaction. Nothing was sent.");
    if (hd.payer !== want.sponsor) throw new Error("The transaction doesn't name the Mana sponsor as payer. Nothing was sent.");
    if (hd.payee !== want.payee) throw new Error("The transaction doesn't name this guest as payee. Nothing was sent.");
    if (want.chainId && hd.chain_id !== want.chainId) throw new Error("The transaction is for another chain. Nothing was sent.");
    if (BigInt(hd.rc_limit || 0) > BigInt(want.rcLimit)) throw new Error("The transaction asks for more Mana than expected. Nothing was sent.");
    const ops = tx.operations || [];
    // (self-contained: answers on the game, or picks (0x8ce33c6c) on the pinned race or KnodeGames Picks contract)
    const ok = (o) => !!(o && o.call_contract && ((want.game && o.call_contract.contract_id === want.game && Number(o.call_contract.entry_point) === ANSWER)
      || (want.race && o.call_contract.contract_id === want.race && Number(o.call_contract.entry_point) === 0x8ce33c6c)
      || (want.picks && o.call_contract.contract_id === want.picks && Number(o.call_contract.entry_point) === 0x8ce33c6c)));
    if (!ops.length || !ops.every(ok))
      throw new Error("A guest signs only game answers and picks. Nothing was sent.");
  }

  /** Disconnect: ends the KOIN Vault session and forgets every remembered account on this device. */
  function disconnect() {
    if (W.session) vaultApi("disconnect", { body: creds() }).catch(() => {});
    dropVault();
    saveAccts([]);
    setAddress(null, null);
  }
  /** Make a remembered account the active one. Returns false for an account that isn't remembered here. */
  function switchTo(address) {
    const a = remembered().find((x) => x.address === address);
    if (!a) return false;
    if (W.session && a.address !== W.address) dropVault();   // a KOIN Vault session belongs to one account only
    setAddress(a.kind, a.address);
    return true;
  }
  /** Forget one remembered account (the others stay). */
  function forget(address) {
    if (address === W.address) { if (W.session) { vaultApi("disconnect", { body: creds() }).catch(() => {}); dropVault(); } forgetAcct(address); const next = remembered()[0]; return next ? setAddress(next.kind, next.address) : setAddress(null, null); }
    forgetAcct(address); notify();
  }

  const MAINNET_CHAIN_ID = "EiBZK_GGVP0H_fXVAM3j6EAuz3-B-l3ejxRSewi7qIBfSA==";

  /** Sign and send. Returns the transaction id once the network has it in a block (or null when it isn't seen yet).
   *  Throws on rejection or failure, with a readable message. */
  async function send(label, ops, opts = {}) {
    if (!W.address) throw new Error("Connect a wallet first.");
    // Audit Info: pin the chain. The chain id comes from the RPC; when the page knows the expected one (deployment.json
    // "chainId", confirmed with "npm run bot -- chain-check"), nothing is signed for any other chain.
    if (W.chainId) {
      const id = await W.provider.getChainId().catch(() => null);
      if (id !== W.chainId) throw new Error("The network node reports a different chain than Knode Games runs on. Nothing was signed.");
    }
    if (W.kind === "guest") { if (!guestOn()) throw new Error("Guest play is paused for now. Connect Kondor or KOIN Vault to play."); return sendGuest(label, ops, opts); }
    return W.kind === "vault" ? sendVault(label, ops, opts) : sendKondor(label, ops, opts);
  }

  /** opts.ownMana: the player's own account must pay the Mana, never the contract. The transaction names the player as
   *  payer and is signed first. It is broadcast only as signed: if the wallet switched the payer (Kondor's free Mana
   *  option), or did not hand back a signed transaction (so the page can't see who pays), it is not sent. */
  async function sendKondor(label, ops, opts = {}) {
    const sp = !opts.gamePays ? sponsorFor(ops) : null;
    // A transaction made only of game answers is sponsored for any wallet (free play), within the sponsor's caps.
    // Free play (game answers, race picks, KnodeGames picks with sponsor v3) is sponsored for any wallet, within the sponsor's caps.
    const answerOnly = !!sp && ops.every((o) => o.call_contract && ((o.call_contract.contract_id === sp.covers[0] && Number(o.call_contract.entry_point) === ANSWER)
      || (sp.race && o.call_contract.contract_id === sp.race && Number(o.call_contract.entry_point) === PICK)
      || (sp.picks && o.call_contract.contract_id === sp.picks && Number(o.call_contract.entry_point) === PICK)));
    // Answers are light (rcLimit, 1 Mana); staking, withdrawing, swapping and claiming do much more in one transaction
    // (approve, transfer, burn, stake), so they ask for rcLimitOther (audit SP-17: the sponsor's per-transaction cap, 1 Mana).
    const rcLimit = sp ? rcFor(sp, ops, String(answerOnly ? (sp.rcLimit || "100000000") : (sp.rcLimitOther || "100000000"))) : null;
    if (sp && await sponsorSaysYes(sp, rcLimit, answerOnly)) {
      try { return await sendKondorWith(label, ops, { ...opts, sponsor: sp.address, rcLimit }); }
      catch (e) {
        // The network turned the sponsored transaction down before it was included (nothing happened, nothing was
        // charged), or the sponsor refused: offer the same action with the player's own Mana. A cancel in Kondor, or a
        // transaction that was included and then reverted, is never retried.
        if (!(e && (e.sponsorSend || /SPONSOR/i.test(String(e.message || e))))) throw e;
        W.status && W.status("The Mana sponsor couldn't cover this one. Confirm again in Kondor to use your own Mana.");
      }
    }
    // Not sponsored: the player's own Mana, always named as payer (owner, 2026-10-28: the game contract pays for no one,
    // so Kondor's free Mana option, which names the game, would only be refused).
    // Audit BX-10: an explicit Mana limit (not "all of it"): 1 Mana for answers and picks, 10 for anything else, never
    // more than the account has. The chain charges only what is used; the limit is only held aside until it settles.
    let own = answerOnly || (ops.length && ops.every((o) => o.call_contract && [ANSWER, PICK].includes(Number(o.call_contract.entry_point)))) ? 100000000n : 1000000000n;
    try { const have = BigInt(await W.provider.getAccountRc(W.address)); if (have > 0n && have < own) own = have; } catch { /* keep the limit */ }
    return sendKondorWith(label, ops, { ...opts, ownMana: true, rcLimit: own.toString() });
  }

  async function sendKondorWith(label, ops, opts = {}) {
    const signer = window.kondor.getSigner(W.address);
    try { signer.provider = W.provider; } catch {}
    // Audit BXW-2: name the chain in the transaction (not re-read from the node by koilib) when the page knows it.
    const chain = W.chainId ? { chainId: W.chainId } : {};
    const options = opts.sponsor ? { payer: opts.sponsor, payee: W.address, rcLimit: opts.rcLimit, ...chain } : opts.ownMana ? { payer: W.address, ...(opts.rcLimit ? { rcLimit: opts.rcLimit } : {}), ...chain } : null;
    const tx = new lib.Transaction({ signer, provider: W.provider, ...(options ? { options } : {}) });
    for (const op of ops) await tx.pushOperation(op);
    W.status && W.status(`Confirm “${label}” in Kondor…`);
    if (opts.ownMana || opts.sponsor) {
      const signed = await tx.sign();
      if (!signed || !Array.isArray(signed.signatures) || !signed.signatures.length) {
        throw new Error("Kondor did not hand back a signed transaction, so the page can't check who pays the Mana. Nothing was sent; try again, or claim later.");
      }
      tx.transaction = signed;
      // Audit BXW-2: send only what the page built: this chain, no higher Mana limit, the same operations.
      checkSigned(signed, ops, opts.rcLimit || null);
      const payer = signed.header && signed.header.payer;
      // ownMana: never the game contract. The sponsor (when chosen) or the player may pay.
      const okPayers = opts.sponsor ? [opts.sponsor, W.address] : [W.address];
      if (opts.ownMana && !okPayers.includes(payer)) throw new Error("This one must use your own Mana. Leave Kondor's free Mana option off and try again.");
      // Sponsor audit (Info): send only what was shown: the sponsor (or you) pays, and you are the payee.
      if (opts.sponsor) {
        const payee = signed.header && signed.header.payee;
        if (!okPayers.includes(payer)) throw new Error("Kondor changed who pays the Mana for this one, so it was not sent. Leave Kondor's free Mana option off and try again.");
        if (payer === opts.sponsor && payee !== W.address) throw new Error("The signed transaction doesn't name your wallet as the one the sponsor pays for, so it was not sent.");
      }
    }
    let receipt;
    try { receipt = await tx.send(); }
    catch (e) { if (opts.sponsor) { const err = e instanceof Error ? e : new Error(String(e)); err.sponsorSend = true; throw err; } throw e; }
    if (receipt && receipt.reverted) throw new Error(JSON.stringify(receipt.logs || "the contract refused it"));
    const id = tx.transaction && tx.transaction.id;
    W.status && W.status("Sent. Waiting for the next block…");
    if (id) { try { await W.provider.wait(id, "byBlock", 90000); return id; } catch { return null; } }
    return null;
  }

  /** The signed transaction is for this chain (when the page knows it), asks for no more Mana than the page set (when
   *  it set a limit), and carries exactly the operations the page built (same contracts, entry points and arguments). */
  /** Audit BX-50: arguments compared as bytes, so a wallet that re-encodes the same bytes (padding, base64 flavour)
   *  isn't refused; anything else must match exactly. */
  function sameArgs(x, y) {
    const bytes = (v) => { if (v instanceof Uint8Array) return v; try { return lib.utils.decodeBase64url(String(v || "").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")); } catch { return null; } };
    const a = bytes(x), b = bytes(y);
    if (!a || !b) return String(x || "") === String(y || "");
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }
  function checkSigned(signed, ops, rcLimit) {
    const hd = signed && signed.header;
    if (!hd) throw new Error("Kondor handed back a transaction without a header. Nothing was sent.");
    if (W.chainId && hd.chain_id !== W.chainId) throw new Error("The signed transaction is for another chain. Nothing was sent.");
    if (rcLimit != null && BigInt(hd.rc_limit || 0) > BigInt(rcLimit)) throw new Error("Kondor raised the Mana limit. Nothing was sent.");
    const got = signed.operations || [];
    const same = (a, b) => !!(a && b && a.call_contract && b.call_contract && a.call_contract.contract_id === b.call_contract.contract_id
      && Number(a.call_contract.entry_point) === Number(b.call_contract.entry_point) && sameArgs(a.call_contract.args, b.call_contract.args));
    if (got.length !== ops.length || ops.some((o, i) => !same(o, got[i]))) throw new Error("Kondor changed what is signed. Nothing was sent.");
  }

  // ── Mana sponsor (sponsor/README.md) ──
  // deployment.json "payer": "sponsor" (the sponsor wallet pays the Mana) or "self" (players' own Mana; also the default).
  // "sponsor": { address, covers: [game, desk, vhp, koin], rcLimit (answers), rcLimitOther (everything else), rcLimits (v3:
  // each action's own limit) }. The sponsor contract decides on chain; the page
  // only picks it when every operation is one it pays for and its caps (would_pay) say yes, else the player's own Mana.
  // Answers are sponsored for any wallet (free play); everything else only for wallets with VHP or a stake.
  const APPROVE = 0x74e21680, WOULD_PAY = 0xda1fd8f5, ANSWER = 0x0db52f40, CLAIM = 0xdd1b3c31, PICK = 0x8ce33c6c;
  /** The sponsor this transaction could use, or null. */
  function sponsorFor(ops) {
    const sp = W.sponsor;
    if (!sp || W.payer !== "sponsor" || !sp.address || !Array.isArray(sp.covers) || !ops.length || ops.length > 10) return null;
    for (const o of ops) {
      const c = o && o.call_contract;
      if (!c || !sp.covers.includes(c.contract_id)) return null;
      // Tokens: only approve (the contract checks spender and owner too).
      if (sp.tokens && sp.tokens.includes(c.contract_id) && Number(c.entry_point) !== APPROVE) return null;
    }
    return sp;
  }
  /** Sponsor v3 (owner, 2026-10-28): each action's own Mana limit ("rcLimits": "contract:entry" → Mana, from the
   *  sponsor's mana-report). When every operation has one, ask for their sum (never more than the old limit), so a
   *  0.05-Mana pick counts about 0.1 against the caps instead of 1. Otherwise the old limit, as before. */
  function rcFor(sp, ops, fallback) {
    const m = sp && sp.rcLimits;
    if (!m || typeof m !== "object") return fallback;
    let sum = 0n;
    for (const o of ops) {
      const c = o && o.call_contract;
      const k = c && `${c.contract_id}:${(Number(c.entry_point) >>> 0).toString(16).padStart(8, "0")}`;
      const v = k && m[k];
      if (typeof v !== "string" || !/^[1-9][0-9]{0,15}$/.test(v)) return fallback;
      sum += BigInt(v);
    }
    return String(sum < BigInt(fallback) ? sum : BigInt(fallback));
  }
  /** would_pay(account, rc_limit, answer_only): true only when the sponsor answers yes (any error: no). */
  async function sponsorSaysYes(sp, rcLimit, answerOnly) {
    try {
      const acct = lib.utils.decodeBase58(W.address);
      const bytes = [0x0a, acct.length, ...acct, 0x10];
      let v = BigInt(rcLimit);
      do { let b = Number(v & 0x7fn); v >>= 7n; if (v > 0n) b |= 0x80; bytes.push(b); } while (v > 0n);
      if (answerOnly) bytes.push(0x18, 0x01);   // field 3 (answer_only) = true
      const r = await withTimeout(W.provider.readContract({ contract_id: sp.address, entry_point: WOULD_PAY, args: lib.utils.encodeBase64url(new Uint8Array(bytes)) }), 6000, "timeout");
      const out = r && r.result ? lib.utils.decodeBase64url(r.result) : new Uint8Array(0);
      return out.length >= 2 && out[0] === 0x08 && out[1] === 0x01;   // field 1 (ok) = true
    } catch { return false; }
  }

  async function sendVault(label, ops, opts = {}) {
    if (!W.session) {
      // A remembered KOIN Vault account: ask KOIN Vault again, and only go on if it is the same account.
      const want = W.address, got = await connectVault();
      if (!got) throw new Error("Not connected to KOIN Vault, nothing was sent.");
      if (got !== want) throw new Error("KOIN Vault connected a different account, nothing was sent. Check the account and try again.");
      if (!W.session) throw new Error("KOIN Vault isn't connected. Connect again.");
    }
    const operations = ops.map((o) => ({ call_contract: { contract_id: o.call_contract.contract_id, entry_point: Number(o.call_contract.entry_point), args: o.call_contract.args } }));
    let req;
    try { req = await vaultApi("request", { body: { ...creds(), operations, mana: "auto" } }); }
    catch (e) {
      if (e.status === 404 || e.status === 410) { dropVault(); throw new Error("KOIN Vault connection expired. Connect again, then retry."); }
      throw new Error(e.status === 409 ? `${e.message} (KOIN Vault)` : e.message);
    }
    const status = h("div", { class: "kw-status", role: "status" }, "Waiting for your approval in KOIN Vault…");
    open(h("h3", {}, `Approve in KOIN Vault`), h("p", {}, `“${label}”. Open KOIN Vault, check the details and approve with your fingerprint or face, then come back here.`),
      h("a", { class: "kw-go", href: VAULT + "/", target: "_blank", rel: "noopener noreferrer", referrerpolicy: "no-referrer" }, "Open KOIN Vault"), status,
      h("p", {}, req.funding && req.funding.payer === "sponsor" ? "Mana for this one is covered by KOIN Vault." : "This uses your wallet's own Mana (from the KOIN it holds)."),
      opts.ownMana ? h("p", { class: "kw-warn" }, "This one must be paid with your own Mana (or KOIN Vault's), not the game's: right now a claim the game pays for could run out of Mana and fail. The page can't check who KOIN Vault charges. If KOIN Vault shows the game contract as the payer, reject it and claim later.") : null);
    let stop = false; onClose = () => { stop = true; };
    const until = Math.min(req.expiresAt || Infinity, Date.now() + 10 * 60000);
    try {
      while (Date.now() < until) {
        await sleep(2000);
        let r; try { r = await vaultApi("request-status", { query: { ...creds(), requestId: req.requestId } }); }
        catch (e) { if (e.status === 404 || e.status === 410) throw new Error("The request expired before it was approved."); continue; }
        if (r.status === "pending") { if (stop) throw new Error("Still waiting in KOIN Vault. Approve or reject it there; don't send it again from here."); continue; }
        if (r.status === "submitting") { status.textContent = "Approved. Sending…"; continue; }
        if (r.status === "rejected") throw new Error("Cancelled in KOIN Vault.");
        if (r.status === "failed") throw new Error(r.error || "KOIN Vault couldn't send it.");
        if (r.status === "approved") {
          status.textContent = "Sent. Waiting for the next block…";
          W.status && W.status("Sent. Waiting for the next block…");
          close();
          if (r.txid) { try { await W.provider.wait(r.txid, "byBlock", 90000); return r.txid; } catch { /* not seen in a block yet */ } }
          return null;
        }
      }
      throw new Error("No answer from KOIN Vault in time. Check the wallet before trying again.");
    } finally { close(); }
  }

  /** The header passes game-data/deployment.json ({ payer, sponsor }), for the guest switch only: it never changes who
   *  pays for this page's own transactions (W.payer / W.sponsor stay what the page set). */
  function setGuestConfig(dep) {
    const cfg = dep && dep.sponsor;
    W.guestConfig = cfg && typeof cfg === "object" && typeof cfg.address === "string"
      ? { address: cfg.address, guest: cfg.guest === true, payer: dep.payer === "sponsor" ? "sponsor" : "self" } : null;
    if (store.get(localStorage, "kw-kind") === "guest" && guestReady() && !W.address)
      guestLib().load().then((g) => { if (g && !W.address) setAddress("guest", g.address); }).catch(() => {});
    notify();
  }

  function init({ provider, onChange, toast, status, chainId, payer, sponsor, game } = {}) {
    W.gameContract = typeof game === "string" ? game : null;   // the game contract (pinned on mainnet: PINNED_GAME)
    W.payer = payer === "sponsor" ? "sponsor" : "self";
    W.sponsor = sponsor && typeof sponsor.address === "string" ? sponsor : null;
    // Koinos mainnet's chain id is the default pin (audit L-3), so every page (burn, producer lookup included) refuses
    // to sign for another chain; a page can pass a different expected id (a testnet deployment.json "chainId").
    W.provider = provider || W.provider; W.chainId = chainId || MAINNET_CHAIN_ID; W.toast = toast || W.toast; W.status = status || W.status;
    if (onChange) {
      if (!W.inited) W.onChange = onChange;
      else {
        listeners.add(onChange);
        // A page that sets up after the header did still hears about the account that is already active.
        if (W.address && !W.restoring) setTimeout(() => { try { onChange(W.address, W.kind); } catch {} }, 0);
      }
    }
    // An earlier version of this page kept the KOIN Vault session in sessionStorage. Delete any such entry and never
    // use it: another page of this origin could have written it, and the user has not chosen it on this page.
    store.set(sessionStorage, "kw-vault", null);
    // A guest chosen on this device comes back by itself (its key never left the browser).
    if (store.get(localStorage, "kw-kind") === "guest" && guestReady()) {
      guestLib().load().then((g) => { if (g && !W.address) setAddress("guest", g.address); }).catch(() => {});
    }
    // The account that was active on this device comes back on every page (address only; nothing is asked of the
    // wallet until something has to be signed). A guest account comes back only where its key is (above).
    if (!W.inited && !W.address) {
      const act = store.get(localStorage, ACTIVE), a = remembered().find((x) => x.address === act);
      if (a && a.kind !== "guest") { W.kind = a.kind; W.address = a.address; W.restoring = setTimeout(() => { W.restoring = null; notify(); }, 0); }
    }
    W.inited = true;
  }

  window.KWallet = {
    init, setGuestConfig, connect, disconnect, send, isPhone, manageGuest, guestInfo: () => { guestCant([]); }, switchTo, forget,
    accounts: () => remembered(), subscribe: (f) => { listeners.add(f); return () => listeners.delete(f); },
    get address() { return W.address; }, get kind() { return W.kind; },
    label: () => (W.kind === "vault" ? "KOIN Vault" : W.kind === "kondor" ? "Kondor" : W.kind === "guest" ? "your guest wallet" : "your wallet"),
  };
})();

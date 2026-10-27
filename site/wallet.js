/* Knode wallet layer: one way to connect and sign, two wallets.
 *   - Kondor: the browser extension (desktop).
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
  .kw-link{font:inherit;background:none;border:0;color:var(--violet,#5a43e6);text-decoration:underline;cursor:pointer;padding:0;font-size:14px}`;
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

  function setAddress(kind, address) {
    const changed = address !== W.address;
    W.kind = address ? kind : null; W.address = address || null;
    store.set(localStorage, "kw-kind", W.kind);
    if (changed) W.onChange(W.address, W.kind);
  }
  function dropVault(reason) {
    if (W.poll) { clearTimeout(W.poll); W.poll = null; }
    W.session = null; store.set(sessionStorage, "kw-vault", null);
    if (W.kind === "vault") setAddress(null, null);
    if (reason && W.toast) W.toast(reason, 7000);
  }
  /** Keep checking the KOIN Vault session so a disconnect or expiry in the wallet also clears this page. */
  function watchVault() {
    if (W.poll) clearTimeout(W.poll);
    let fails = 0;
    const tick = async () => {
      if (!W.session) return;
      if (Date.now() > W.session.expiresAt) return dropVault("KOIN Vault connection expired (they last 30 minutes). Connect again.");
      if (!document.hidden) {
        try {
          const st = await vaultApi("status", { query: creds() }); fails = 0;
          if (!st.connected || (W.address && st.address !== W.address)) return dropVault("KOIN Vault disconnected. Connect again to keep playing.");
        } catch (e) {
          if (e.status === 404 || e.status === 410) return dropVault("KOIN Vault connection ended. Connect again.");
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
      h("p", {}, isPhone() ? "Tap Open KOIN Vault, approve Knode with your fingerprint or face, then come back to this tab." : "Scan with your phone (or use Connect inside KOIN Vault), approve Knode with your passkey, and this page connects by itself."),
      qr, go, status,
      h("p", {}, "No KOIN Vault yet? ", h("a", { href: VAULT, target: "_blank", rel: "noopener" }, "Create one at koinvault.app"), " in a minute, no extension needed."));
    let cancelled = false; onClose = () => { cancelled = true; };
    try {
      const s = await vaultApi("create", { body: { name: "Knode" } });
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
    setAddress("kondor", accounts[0].address);
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
      open(h("h3", {}, "Connect a wallet"), h("p", {}, "Your wallet signs everything. Knode never sees a key."), ...(phone ? [vault, kondor] : [kondor, vault]));
      onClose = () => resolve(null);
    });
  }

  function disconnect() {
    if (W.kind === "vault" && W.session) vaultApi("disconnect", { body: creds() }).catch(() => {});
    if (W.kind === "vault") dropVault(); else setAddress(null, null);
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
      if (id !== W.chainId) throw new Error("The network node reports a different chain than Knode runs on. Nothing was signed.");
    }
    return W.kind === "vault" ? sendVault(label, ops, opts) : sendKondor(label, ops, opts);
  }

  /** opts.ownMana: the player's own account must pay the Mana, never the contract. The transaction names the player as
   *  payer and is signed first. It is broadcast only as signed: if the wallet switched the payer (Kondor's free Mana
   *  option), or did not hand back a signed transaction (so the page can't see who pays), it is not sent. */
  async function sendKondor(label, ops, opts = {}) {
    const sp = !opts.gamePays ? sponsorFor(ops) : null;
    // A transaction made only of game answers is sponsored for any wallet (free play), within the sponsor's caps.
    const answerOnly = !!sp && ops.every((o) => o.call_contract && o.call_contract.contract_id === sp.covers[0] && Number(o.call_contract.entry_point) === ANSWER);
    // Answers are light (rcLimit, 1 Mana); staking, withdrawing, swapping and claiming do much more in one transaction
    // (approve, transfer, burn, stake), so they ask for rcLimitOther (default 3 Mana).
    const rcLimit = sp ? String(answerOnly ? (sp.rcLimit || "100000000") : (sp.rcLimitOther || "300000000")) : null;
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
    return sendKondorWith(label, ops, opts);
  }

  async function sendKondorWith(label, ops, opts = {}) {
    const signer = window.kondor.getSigner(W.address);
    try { signer.provider = W.provider; } catch {}
    const options = opts.sponsor ? { payer: opts.sponsor, payee: W.address, rcLimit: opts.rcLimit } : opts.ownMana ? { payer: W.address } : null;
    const tx = new lib.Transaction({ signer, provider: W.provider, ...(options ? { options } : {}) });
    for (const op of ops) await tx.pushOperation(op);
    W.status && W.status(`Confirm “${label}” in Kondor…`);
    if (opts.ownMana || opts.sponsor) {
      const signed = await tx.sign();
      if (!signed || !Array.isArray(signed.signatures) || !signed.signatures.length) {
        throw new Error("Kondor did not hand back a signed transaction, so the page can't check who pays the Mana. Nothing was sent; try again, or claim later.");
      }
      tx.transaction = signed;
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

  // ── Mana sponsor (sponsor/README.md) ──
  // deployment.json "payer": "sponsor" (the sponsor wallet pays the Mana) or "self" (players' own Mana; also the default).
  // "sponsor": { address, covers: [game, desk, vhp, koin], rcLimit (answers), rcLimitOther (everything else) }. The sponsor contract decides on chain; the page
  // only picks it when every operation is one it pays for and its caps (would_pay) say yes, else the player's own Mana.
  // Answers are sponsored for any wallet (free play); everything else only for wallets with VHP or a stake.
  const APPROVE = 0x74e21680, WOULD_PAY = 0xda1fd8f5, ANSWER = 0x0db52f40;
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
    if (!W.session) { dropVault(); throw new Error("KOIN Vault isn't connected any more. Connect again."); }
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

  function init({ provider, onChange, toast, status, chainId, payer, sponsor } = {}) {
    W.payer = payer === "sponsor" ? "sponsor" : "self";
    W.sponsor = sponsor && typeof sponsor.address === "string" ? sponsor : null;
    // Koinos mainnet's chain id is the default pin (audit L-3), so every page (burn, producer lookup included) refuses
    // to sign for another chain; a page can pass a different expected id (a testnet deployment.json "chainId").
    W.provider = provider; W.chainId = chainId || MAINNET_CHAIN_ID; W.onChange = onChange || (() => {}); W.toast = toast; W.status = status;
    // An earlier version of this page kept the KOIN Vault session in sessionStorage. Delete any such entry and never
    // use it: another page of this origin could have written it, and the user has not chosen it on this page.
    store.set(sessionStorage, "kw-vault", null);
  }

  window.KWallet = {
    init, connect, disconnect, send, isPhone,
    get address() { return W.address; }, get kind() { return W.kind; },
    label: () => (W.kind === "vault" ? "KOIN Vault" : W.kind === "kondor" ? "Kondor" : "your wallet"),
  };
})();

/* Knode Games TESTNET wallet: only for blockx-testnet.html (the Koinos Foundation testnet). Never loaded by a
 * mainnet page, and it never touches the mainnet wallet (wallet.js, guest.js, header-wallet.js):
 *   - its own storage name ("kg-testnet-wallet-v1"), so it can't read, replace or delete a mainnet guest key;
 *   - it refuses to work when the node or the page's settings name the Koinos MAINNET chain;
 *   - it signs only for the chain id in testnet/blockx.json, and only calls to the testnet Picks contract.
 * Two ways to sign:
 *   - Test wallet: a throwaway key made and kept in this browser (like SwarmTales' test wallet). Play money only: get
 *     test KOIN for it from the faucet bot. Clearing the browser's site data loses it.
 *   - Kondor, switched to the testnet. Some Kondor versions loop on "Refresh check" on this testnet; then use the Test
 *     wallet.
 * The player pays their own (test) Mana: every faucet claim of 100 test KOIN is plenty of Mana.
 * Everything on screen is built with textContent. No HTML strings, no eval, no network except the testnet node. */
(function (root) {
  "use strict";
  // GitHub Pages can't send X-Frame-Options, so a page that signs refuses to run inside a frame (as wallet.js does).
  if (window.top !== window.self) {
    document.documentElement.style.display = "none";
    try { window.top.location.replace(window.self.location.href); } catch { /* a parent we may not navigate: stay hidden */ }
    return;
  }
  const MAINNET_CHAIN_ID = "EiBZK_GGVP0H_fXVAM3j6EAuz3-B-l3ejxRSewi7qIBfSA==";
  const KEY = "kg-testnet-wallet-v1", KIND = "kg-testnet-kind-v1";
  // At most 0.3 test Mana per transaction. A pick uses about 0.05, and the network holds the whole limit aside until the
  // transaction settles, so a big limit would block the next pick (5 test KOIN then allows ~15 picks in a few minutes).
  const MANA_CAP = 30000000n;
  const lib = root.koilib || root.koinos || root;
  const W = { address: null, kind: null, provider: null, chainId: null, picks: null, sponsor: null, listeners: new Set() };
  // The sponsor v3 trial (docs/blockx/SPONSOR-TESTNET.md): with a testnet sponsor named in testnet/blockx.json, picks
  // ask it to pay first (a wallet with no test KOIN can play), and fall back to the wallet's own test Mana.
  const SPONSORED_LIMIT = 30000000n;   // 0.3 Mana per sponsored transaction (the sponsor's per-transaction cap is 1)

  const store = {
    get(k) { try { return root.localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { v == null ? root.localStorage.removeItem(k) : root.localStorage.setItem(k, v); return true; } catch { return false; } },
  };
  const notify = () => W.listeners.forEach((f) => { try { f(W.address, W.kind); } catch { /* a listener's own problem */ } });
  const hexKey = () => { const h = store.get(KEY); return h && /^[0-9a-f]{64}$/.test(h) ? h : null; };
  function newKey() {
    const b = new Uint8Array(32);
    root.crypto.getRandomValues(b);
    return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  }
  const signerFromHex = (hex) => { const s = new lib.Signer({ privateKey: hex, provider: W.provider }); return s; };

  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) { if (k === "text") e.textContent = v; else if (k.startsWith("on")) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v); }
    for (const c of kids) if (c != null) e.append(c);
    return e;
  }
  let sheet = null;
  function open(...kids) {
    if (!sheet) { sheet = el("div", { class: "pk-modal", role: "dialog", "aria-modal": "true", "aria-label": "Testnet wallet" }); sheet.addEventListener("click", (e) => { if (e.target === sheet) close(); }); document.body.append(sheet); }
    sheet.replaceChildren(el("div", { class: "pk-box info" }, ...kids));
    sheet.hidden = false;
    const b = sheet.querySelector("button"); if (b) b.focus();
  }
  function close() { if (sheet) sheet.hidden = true; }

  /** Must be called first: the testnet node and the chain id the page's settings name. */
  function init({ provider, chainId, picks, sponsor }) {
    if (!chainId || chainId === MAINNET_CHAIN_ID) throw new Error("The testnet wallet only works with a testnet chain id.");
    W.provider = provider; W.chainId = chainId; W.picks = picks || null;
    W.sponsor = typeof sponsor === "string" && /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(sponsor) ? sponsor : null;
    // Come back as the wallet used last time on this device (the test key stays in this browser).
    const kind = store.get(KIND);
    if (kind === "test" && hexKey()) { W.kind = "test"; W.address = signerFromHex(hexKey()).getAddress(); }
    notify();
  }
  async function checkChain() {
    const id = await W.provider.getChainId();
    if (id === MAINNET_CHAIN_ID) throw new Error("The node is on Koinos MAINNET. The testnet page never signs there. Nothing was sent.");
    if (id !== W.chainId) throw new Error("The node is on another testnet than the page's settings. Nothing was sent.");
  }

  function useTest() {
    let hex = hexKey();
    if (!hex) { hex = newKey(); if (!store.set(KEY, hex)) throw new Error("This browser won't store a test key (private window or storage blocked). Use Kondor instead."); }
    W.kind = "test"; W.address = signerFromHex(hex).getAddress(); store.set(KIND, "test");
    notify();
    return W.address;
  }
  async function useKondor() {
    if (!root.kondor) throw new Error("Kondor isn't installed in this browser. Use the Test wallet.");
    const accounts = await root.kondor.getAccounts();
    const a = (accounts || []).map((x) => x && x.address).find((x) => typeof x === "string" && x);
    if (!a) throw new Error("Kondor shared no account. Open Kondor, switch it to the testnet, and allow this site.");
    W.kind = "kondor"; W.address = a; store.set(KIND, "kondor");
    notify();
    return a;
  }

  /** Ask which wallet. Resolves to the address, or null. */
  function connect() {
    return new Promise((resolve) => {
      const pick = (fn) => async () => { try { const a = await fn(); close(); resolve(a); } catch (e) { open(el("h3", { text: "Couldn't connect" }), el("p", { text: String((e && e.message) || e) }), el("button", { class: "btn", type: "button", onclick: () => { close(); resolve(null); } }, "OK")); } };
      open(el("h3", { text: "Connect a TESTNET wallet" }),
        el("p", { text: "This page is the Koinos testnet: test KOIN only, nothing here is real money." }),
        el("button", { class: "btn", type: "button", onclick: pick(useTest) }, hexKey() ? "Use my Test wallet" : "Make a Test wallet (this browser)"),
        el("button", { class: "btn ghost", type: "button", onclick: pick(useKondor) }, "Kondor (switched to the testnet)"),
        el("p", { class: "ago", text: "If Kondor keeps asking to “Refresh check”, cancel it and use the Test wallet." }),
        el("button", { class: "btn ghost", type: "button", onclick: () => { close(); resolve(null); } }, "Cancel"));
    });
  }
  function disconnect() { W.address = null; W.kind = null; store.set(KIND, null); notify(); }
  /** Delete the test key from this browser (any test KOIN on it is lost). */
  function forget() { store.set(KEY, null); if (W.kind === "test") disconnect(); }

  // Audit BX-31: only the Picks contract's `pick` entry point (2363702380), never an owner action.
  const PICK_ENTRY = 2363702380;
  const isPick = (o) => !!(o && o.call_contract && o.call_contract.contract_id === W.picks && Number(o.call_contract.entry_point) === PICK_ENTRY);

  /** Sign and send: only calls to the testnet Picks contract, for this testnet, the player paying their own test Mana. */
  async function send(label, ops) {
    if (!W.address) throw new Error("Connect a testnet wallet first.");
    if (!Array.isArray(ops) || !ops.length || ops.length > 10) throw new Error("Nothing to send.");
    for (const o of ops) if (!isPick(o)) throw new Error("The testnet wallet signs only picks on the testnet Picks contract. Nothing was sent.");
    await checkChain();
    if (W.sponsor) {
      try { return await sendWith(ops, { payer: W.sponsor, payee: W.address, limit: SPONSORED_LIMIT }); }
      catch (e) {
        const m = String((e && e.message) || e);
        // Only a refusal by the sponsor or the network BEFORE inclusion falls back (audit SP-35); a transaction that was
        // included and then reverted, a wallet change or a cancel never does.
        if ((e && e.included) || !/SPONSOR|insufficient|\brc\b|rc_limit|resource|mana/i.test(m) || /Nothing was sent/.test(m)) throw e;
        W.lastSponsorRefusal = m.slice(0, 200);
      }
    }
    const mana = BigInt(await W.provider.getAccountRc(W.address));
    if (mana < 6000000n) throw new Error(W.sponsor ? `The test sponsor didn't pay this one (${W.lastSponsorRefusal || "refused"}), and this wallet has no test Mana of its own.` : "This wallet has no test Mana yet. Get test KOIN from the faucet bot (see “Get test KOIN”), then try again.");
    const limit = mana * 9n / 10n < MANA_CAP ? mana * 9n / 10n : MANA_CAP;
    return sendWith(ops, { payer: W.address, payee: null, limit });
  }
  async function sendWith(ops, { payer, payee, limit }) {
    const signer = W.kind === "test" ? signerFromHex(hexKey()) : root.kondor.getSigner(W.address);
    try { signer.provider = W.provider; } catch { /* Kondor's signer */ }
    const tx = new lib.Transaction({ signer, provider: W.provider, options: { payer, ...(payee ? { payee } : {}), rcLimit: limit.toString(), chainId: W.chainId } });
    for (const op of ops) await tx.pushOperation(op);
    const signed = await tx.sign();
    if (!signed || !signed.header || signed.header.chain_id !== W.chainId) throw new Error("The signed transaction is not for this testnet. Nothing was sent.");
    if (signed.header.payer !== payer || (payee && signed.header.payee !== payee)) throw new Error("The wallet changed who pays the Mana. Nothing was sent.");
    // The wallet (Kondor) must not have raised the Mana limit or changed what is signed (review 2026-10-28, #7).
    if (BigInt(signed.header.rc_limit || "0") > limit) throw new Error("The wallet raised the Mana limit. Nothing was sent.");
    const sent = signed.operations || [];
    if (sent.length !== ops.length || sent.some((o) => !isPick(o))) throw new Error("The wallet changed what is signed. Nothing was sent.");
    tx.transaction = signed;
    const receipt = await tx.send();
    if (receipt && receipt.reverted) { const err = new Error(JSON.stringify(receipt.logs || "the contract refused it")); err.included = true; throw err; }
    const id = tx.transaction && tx.transaction.id;
    if (id) { try { await W.provider.wait(id, "byBlock", 90000); } catch { /* shown as not seen yet */ } }
    return id || null;
  }

  root.KTestWallet = {
    get address() { return W.address; }, get kind() { return W.kind; },
    /** The testnet sponsor this page asks to pay first (the v3 trial), or null. */
    get sponsor() { return W.sponsor; },
    label: () => (W.kind === "test" ? "your Test wallet" : W.kind === "kondor" ? "Kondor" : "your wallet"),
    init, connect, disconnect, forget, send,
    /** "Play free": make (or reuse) the Test wallet in this browser at once, without the wallet choice. */
    quick: () => useTest(),
    hasTestKey: () => !!hexKey(),
    subscribe: (f) => { W.listeners.add(f); return () => W.listeners.delete(f); },
    STORAGE: Object.freeze([KEY, KIND]),
  };
})(typeof window !== "undefined" ? window : globalThis);

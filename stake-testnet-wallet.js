/* Knode Games TESTNET staking wallet: only for stake-testnet.html (the Koinos Foundation testnet vault trial).
 * Never loaded by a mainnet page, and it never touches the mainnet wallet (wallet.js, guest.js, header-wallet.js):
 *   - its own storage names ("kg-testnet-stake-wallet-v1"), so it can't read, replace or delete a mainnet guest key;
 *   - it refuses to work when the node or the page's settings name the Koinos MAINNET chain;
 *   - it signs only the four player calls on the testnet vault named in testnet/vault.json (deposit_to, withdraw_from,
 *     move_stake, claim_game), plus the test token "approve" that must come right before a deposit_to, and it refuses
 *     a transaction the wallet changed in any way after it was built.
 * Two ways to sign: a Test wallet (a throwaway key kept in this browser; play money only), or Kondor switched to the
 * testnet. The player pays their own test Mana (test KOIN from the faucet bot).
 * Everything on screen is built with textContent. No HTML strings, no eval, no network except the testnet node. */
(function (root) {
  "use strict";
  if (window.top !== window.self) {   // a page that signs refuses to run inside a frame (as wallet.js does)
    document.documentElement.style.display = "none";
    try { window.top.location.replace(window.self.location.href); } catch { /* stay hidden */ }
    return;
  }
  const MAINNET_CHAIN_ID = "EiBZK_GGVP0H_fXVAM3j6EAuz3-B-l3ejxRSewi7qIBfSA==";
  const KEY = "kg-testnet-stake-wallet-v1", KIND = "kg-testnet-stake-kind-v1";
  const MANA_CAP = 100000000n;   // at most 1 test Mana per transaction
  const VAULT_CALLS = new Set([0x7bb5c436, 0x5b0aaef8, 0x7c268e69, 0x4107e3ab]);   // deposit_to, withdraw_from, move_stake, claim_game
  const DEPOSIT_TO = 0x7bb5c436, APPROVE = 0x74e21680;
  const ADDR = /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/;
  const lib = root.koilib || root.koinos || root;
  const W = { address: null, kind: null, provider: null, chainId: null, vault: null, tokens: [], listeners: new Set() };

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
  const signerFromHex = (hex) => new lib.Signer({ privateKey: hex, provider: W.provider });

  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) { if (k === "text") e.textContent = v; else if (k.startsWith("on")) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v); }
    for (const c of kids) if (c != null) e.append(c);
    return e;
  }
  let sheet = null;
  function open(...kids) {
    if (!sheet) { sheet = el("div", { class: "tw-modal", role: "dialog", "aria-modal": "true", "aria-label": "Testnet wallet" }); sheet.addEventListener("click", (e) => { if (e.target === sheet) close(); }); document.body.append(sheet); }
    sheet.replaceChildren(el("div", { class: "tw-box" }, ...kids));
    sheet.hidden = false;
    const b = sheet.querySelector("button"); if (b) b.focus();
  }
  function close() { if (sheet) sheet.hidden = true; }

  /** Must be called first, with testnet/vault.json's settings. */
  function init({ provider, chainId, contract, vhp, koin }) {
    if (!chainId || chainId === MAINNET_CHAIN_ID) throw new Error("The testnet wallet only works with a testnet chain id.");
    if (![contract, vhp, koin].every((a) => ADDR.test(String(a || "")))) throw new Error("testnet/vault.json is missing an address.");
    W.provider = provider; W.chainId = chainId; W.vault = contract; W.tokens = [vhp, koin];
    if (store.get(KIND) === "test" && hexKey()) { W.kind = "test"; W.address = signerFromHex(hexKey()).getAddress(); }
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
  function connect() {
    return new Promise((resolve) => {
      const pick = (fn) => async () => { try { const a = await fn(); close(); resolve(a); } catch (e) { open(el("h3", { text: "Couldn't connect" }), el("p", { text: String((e && e.message) || e) }), el("button", { class: "btn", type: "button", onclick: () => { close(); resolve(null); } }, "OK")); } };
      open(el("h3", { text: "Connect a TESTNET wallet" }),
        el("p", { text: "This page is the Koinos testnet: test KOIN only, nothing here is real money." }),
        el("button", { class: "btn btn-primary", type: "button", onclick: pick(useTest) }, hexKey() ? "Use my Test wallet" : "Make a Test wallet (this browser)"),
        el("button", { class: "btn", type: "button", onclick: pick(useKondor) }, "Kondor (switched to the testnet)"),
        el("button", { class: "btn", type: "button", onclick: () => { close(); resolve(null); } }, "Cancel"));
    });
  }
  function disconnect() { W.address = null; W.kind = null; store.set(KIND, null); notify(); }

  /** Only the four player calls on the testnet vault, and a test-token approve directly before a deposit_to. */
  function allowed(ops) {
    if (!Array.isArray(ops) || !ops.length || ops.length > 2) return false;
    return ops.every((o, i) => {
      const c = o && o.call_contract; if (!c) return false;
      const ep = Number(c.entry_point);
      if (c.contract_id === W.vault && VAULT_CALLS.has(ep)) return ops.length === 1 || i === 1;
      if (W.tokens.includes(c.contract_id) && ep === APPROVE) {
        const next = ops[i + 1] && ops[i + 1].call_contract;
        return i === 0 && !!next && next.contract_id === W.vault && Number(next.entry_point) === DEPOSIT_TO;
      }
      return false;
    });
  }
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  /** Sign and send (the player paying their own test Mana). */
  async function send(label, ops) {
    if (!W.address) throw new Error("Connect a testnet wallet first.");
    if (!allowed(ops)) throw new Error("The testnet wallet signs only stakes, withdrawals, moves and claims on the testnet vault. Nothing was sent.");
    await checkChain();
    const mana = BigInt(await W.provider.getAccountRc(W.address));
    if (mana < 10000000n) throw new Error("This wallet has no test Mana yet. Get test KOIN from the faucet bot (see step 2 on this page), then try again.");
    const limit = mana * 9n / 10n < MANA_CAP ? mana * 9n / 10n : MANA_CAP;
    const signer = W.kind === "test" ? signerFromHex(hexKey()) : root.kondor.getSigner(W.address);
    try { signer.provider = W.provider; } catch { /* Kondor's signer */ }
    const tx = new lib.Transaction({ signer, provider: W.provider, options: { payer: W.address, rcLimit: limit.toString(), chainId: W.chainId } });
    for (const op of ops) await tx.pushOperation(op);
    const built = JSON.parse(JSON.stringify(tx.transaction.operations || []));
    const signed = await tx.sign();
    if (!signed || !signed.header || signed.header.chain_id !== W.chainId) throw new Error("The signed transaction is not for this testnet. Nothing was sent.");
    if (signed.header.payer !== W.address) throw new Error("The wallet changed who pays the Mana. Nothing was sent.");
    if (BigInt(signed.header.rc_limit || "0") > limit) throw new Error("The wallet raised the Mana limit. Nothing was sent.");
    if (!same(signed.operations || [], built)) throw new Error("The wallet changed what is signed. Nothing was sent.");
    tx.transaction = signed;
    const receipt = await tx.send();
    if (receipt && receipt.reverted) throw new Error(JSON.stringify(receipt.logs || "the contract refused it"));
    const id = tx.transaction && tx.transaction.id;
    if (id) { try { await W.provider.wait(id, "byBlock", 90000); } catch { /* shown as not seen yet */ } }
    return id || null;
  }

  root.KTestStakeWallet = {
    get address() { return W.address; }, get kind() { return W.kind; },
    label: () => (W.kind === "test" ? "your Test wallet" : W.kind === "kondor" ? "Kondor" : "your wallet"),
    init, connect, disconnect, send,
    subscribe: (f) => { W.listeners.add(f); return () => W.listeners.delete(f); },
    _test: { allowed: (ops, cfg) => { W.vault = cfg.contract; W.tokens = [cfg.vhp, cfg.koin]; return allowed(ops); } },
  };
})(typeof window !== "undefined" ? window : globalThis);

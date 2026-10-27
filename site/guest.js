/* Knode guest wallet: a play-only key kept in this browser, so anyone can answer the daily questions for free with no
 * extension, no app and no KOIN. Its answers are paid by the Knode Mana sponsor (sponsor/README.md), which pays
 * answer-only transactions for any wallet within its free daily allowance.
 *
 * Rules this file keeps:
 *   - The key is made here (crypto.getRandomValues) and stays on this device: IndexedDB first, localStorage as a
 *     fallback. It is never sent anywhere, never put in a URL, and only leaves storage when the player asks to see it
 *     (backup) or pastes one in (restore).
 *   - It is a play-only wallet: wallet.js signs with it only transactions made of game answers, paid by the sponsor.
 *   - Every storage call is wrapped: private windows and blocked storage just mean "no guest key".
 * Exposes window.KGuest = { load, create, restore, forget, signer, isWif }. */
(() => {
  "use strict";
  const lib = window.koilib || window.koinos || window;
  const DB = "knode-guest", STORE = "keys", ID = "guest", LS = "kn-guest-v1";

  // ── storage: IndexedDB, else localStorage ──
  function idb() {
    return new Promise((resolve) => {
      try {
        if (!window.indexedDB) return resolve(null);
        const req = indexedDB.open(DB, 1);
        req.onupgradeneeded = () => { try { req.result.createObjectStore(STORE); } catch { /* exists */ } };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch { resolve(null); }
    });
  }
  async function idbDo(mode, fn) {
    const db = await idb();
    if (!db) return { ok: false };
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE, mode), st = tx.objectStore(STORE);
        const req = fn(st);
        tx.oncomplete = () => { resolve({ ok: true, value: req && req.result }); try { db.close(); } catch {} };
        tx.onerror = tx.onabort = () => { resolve({ ok: false }); try { db.close(); } catch {} };
      } catch { resolve({ ok: false }); try { db.close(); } catch {} }
    });
  }
  const lsGet = () => { try { return localStorage.getItem(LS); } catch { return null; } };
  const lsSet = (v) => { try { v == null ? localStorage.removeItem(LS) : localStorage.setItem(LS, v); return true; } catch { return false; } };

  async function readWif() {
    const r = await idbDo("readonly", (st) => st.get(ID));
    if (r.ok && typeof r.value === "string" && isWif(r.value)) return r.value;
    const v = lsGet();
    return v && isWif(v) ? v : null;
  }
  async function writeWif(wif) {
    const r = await idbDo("readwrite", (st) => st.put(wif, ID));
    if (r.ok) { lsSet(null); return true; }   // one copy only
    return lsSet(wif);
  }
  async function eraseWif() {
    await idbDo("readwrite", (st) => st.delete(ID));
    lsSet(null);
  }

  // ── keys ──
  /** A valid compressed-key WIF (what koilib's Signer.fromWif accepts and Kondor imports). */
  function isWif(wif) {
    if (typeof wif !== "string" || !/^[5KL][1-9A-HJ-NP-Za-km-z]{50,51}$/.test(wif.trim())) return false;
    try { lib.Signer.fromWif(wif.trim()); return true; } catch { return false; }
  }
  /** 32 random bytes from the browser's CSPRNG, retried in the (astronomically rare) case they are not a valid key. */
  function freshSigner() {
    if (!window.crypto || !crypto.getRandomValues) throw new Error("This browser can't make a secure key.");
    for (let i = 0; i < 8; i++) {
      const b = new Uint8Array(32);
      crypto.getRandomValues(b);
      if (b.every((x) => x === 0)) continue;
      try {
        const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
        const s = new lib.Signer({ privateKey: hex, compressed: true });
        s.getAddress();
        b.fill(0);
        return s;
      } catch { /* out of range: draw again */ }
    }
    throw new Error("Couldn't make a key. Try again.");
  }

  /** The stored guest, or null. */
  async function load() {
    const wif = await readWif();
    if (!wif) return null;
    try { return { address: lib.Signer.fromWif(wif).getAddress() }; } catch { return null; }
  }
  /** A new guest key, stored on this device. Refuses to replace an existing one (forget it first). */
  async function create() {
    if (await readWif()) throw new Error("This browser already has a guest. Forget it first to make a new one.");
    const s = freshSigner();
    const wif = s.getPrivateKey("wif", true);
    if (!(await writeWif(wif))) throw new Error("This browser won't store a guest key (private window or storage blocked). Use KOIN Vault or Kondor instead.");
    return { address: s.getAddress() };
  }
  /** Replace the stored guest with a pasted key (moving to a new phone). */
  async function restore(wif) {
    const w = String(wif || "").trim();
    if (!isWif(w)) throw new Error("That isn't a valid private key (WIF).");
    if (!(await writeWif(w))) throw new Error("This browser won't store a guest key (private window or storage blocked).");
    return { address: lib.Signer.fromWif(w).getAddress() };
  }
  async function forget() { await eraseWif(); }
  /** The key, only for the backup screen (the player asked to see it). */
  async function backupWif() { return readWif(); }
  /** A koilib Signer for wallet.js to sign a game answer. */
  async function signer() {
    const wif = await readWif();
    if (!wif) throw new Error("No guest key on this device any more. Start a new guest, or restore your backup.");
    return lib.Signer.fromWif(wif);
  }

  window.KGuest = { load, create, restore, forget, backupWif, signer, isWif };
})();

/* Knode Games names: producers and players name their wallet. One shared file for every page, the claim checker
   (bot/names.ts) and the tests.
   - KNames.rules: the automatic rules for a name and a claim (pure: no network, no DOM).
   - KNames.of(address): "Name · 1Abc12…wxyz" for a wallet with a Knode Games name, else "@nick · 1Abc12…wxyz" for one
     with an on-chain Koinos nickname (the Nicknames contract), else the short address. The short address is always
     part of it, so a name can never pass for another wallet. KNames.node(address) is the same as a DOM element.
   - names.json is read once per page from the names-data branch (published by .github/workflows/names.yml); every
     entry's shape and rules are checked again here (not its signature: the checker verified it before publishing),
     and anything that fails is ignored. Names are only ever set as textContent.
   See docs/NAMES.md. */
(() => {
  "use strict";
  const G = typeof globalThis !== "undefined" ? globalThis : window;

  const DATA = "https://raw.githubusercontent.com/bawcejawn/Knode/names-data/names.json";
  const PREFIX = "Knode Games name: ";
  const ADDR = /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/;
  const DAY = 86400000;
  const MAX_AGE_DAYS = 7;       // a claim's date is at most 7 days old
  const CHANGE_DAYS = 7;        // one change per address every 7 days
  // The two Knode Games nodes keep their names (owner-only); nobody can claim these addresses.
  const BUILTIN = {
    "1Mpmf2ERhjYpX7CCiM11WERuM4j17uT1sr": "Knode Games pool",
    "1FKTpXBhhHEbu5vVchM8UsVbAvPArJsRmR": "Knode Games Swap",
  };

  // ═══════════════ rules (pure) ═══════════════
  /** The form used to compare names: no case, no spaces or . - _ ', and lookalikes made the same (0/O, 1/l/I, 5/S…). */
  // Letter pairs that read as one letter (audit PN-13: "Arnnana" beside "Armana") are folded first, then digits.
  function fold(name) {
    let s = String(name).toLowerCase().replace(/[ .\-_']/g, "");
    s = s.replace(/cl/g, "d").replace(/nn/g, "m").replace(/rn/g, "m").replace(/ri/g, "n").replace(/ii/g, "u").replace(/vv/g, "w");
    const LOOK = { 0: "o", 1: "l", i: "l", 2: "z", 3: "e", 4: "a", 5: "s", 6: "g", 7: "t", 8: "b", 9: "g" };
    s = s.replace(/[0-9i]/g, (c) => LOOK[c]);
    // Once more after the digits: "KnocIe" / "Knoc1e" only become "cl" here (Repo Lens C1-3).
    return s.replace(/cl/g, "d");
  }
  const RESERVED_EQUAL = ["Koinos", "admin", "support", "Knode", "Knode Games"].map(fold);
  // Anywhere in the folded name (audit PN-6: "Koinos Group", "K-node pool", "Knocle Games").
  const RESERVED_CONTAINS = ["Knode Games", "Knode pool", "Knode Swap", "Knode node", "official", "Koinos Foundation", "Koinos Group",
    "Koinos Team", "Koinos Support", "Koinos Admin", "Koinos Official", "Koinos Network", "Koinos Labs"].map(fold);
  const KNODE = fold("Knode");
  // The whole folded name, or any word, starting with "knode" ("K.node Swap", "Kno de", "My Knode"); not "Blocknode".
  function reserved(name) {
    const f = fold(name);
    if (RESERVED_EQUAL.includes(f) || RESERVED_CONTAINS.some((r) => f.includes(r)) || f.startsWith(KNODE)) return true;
    return String(name).split(/[ .\-_']+/).some((w) => fold(w).startsWith(KNODE));
  }
  /** Shaped like a Koinos address or a short address (audit PN-7): "1Mpmf2…", "1Mpmf2...T1sr", "1Mpmf2 T1sr". */
  const addressLike = (n) => /(^|[^A-Za-z0-9])1[1-9A-HJ-NP-Za-km-z]{5,}/.test(String(n)) || /\.\.\.|…/.test(String(n));
  /** null if the name is allowed, else the reason (plain words, shown to the player or producer). */
  function checkName(name) {
    if (typeof name !== "string") return "Enter a name.";
    if (name.length < 3 || name.length > 24) return "A name is 3 to 24 characters.";
    if (!/^[A-Za-z0-9 .\-_']+$/.test(name)) return "Use letters A–Z, digits, spaces and . - _ ' only.";
    if (/^ | $/.test(name)) return "No space at the start or the end.";
    if (/ {2}/.test(name)) return "No double spaces.";
    if ((name.match(/[A-Za-z0-9]/g) || []).length < 2) return "Use at least 2 letters or digits.";
    if (reserved(name)) return "That name is reserved.";
    if (addressLike(name)) return "A name can't look like a wallet address.";
    return null;
  }
  const isDate = (d) => {
    if (typeof d !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
    const t = Date.parse(`${d}T00:00:00Z`);
    return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === d;   // also refuses 2026-02-30
  };
  const dayOf = (d) => Date.parse(`${d}T00:00:00Z`);
  const today = (now) => new Date(now).toISOString().slice(0, 10);

  /** The exact message the wallet signs. */
  const message = (name, address, date) => `${PREFIX}${name} | ${address} | ${date}`;
  /** The claim as it is pasted (an issue, an email): the message, then "Signature: …" on the next line. */
  const claimText = (name, address, date, signature) => `${message(name, address, date)}\nSignature: ${signature}`;

  /** Finds one claim in any text (an issue body, a pasted email). Returns { name, address, date, signature, message }
   *  or null. Only the exact form counts; anything else in the text is ignored. */
  function parseClaim(text) {
    if (typeof text !== "string" || text.length > 20000) return null;
    const lines = text.replace(/\r/g, "").split("\n").map((l) => l.trim());
    for (let i = 0; i < lines.length - 1; i++) {
      const m = /^Knode Games name: (.{1,40}) \| (1[1-9A-HJ-NP-Za-km-z]{25,34}) \| (\d{4}-\d{2}-\d{2})$/.exec(lines[i]);
      if (!m) continue;
      let j = i + 1;
      while (j < lines.length && lines[j] === "") j++;
      const s = /^Signature: ([A-Za-z0-9_-]{80,96}={0,2})$/.exec(lines[j] || "");
      if (!s) return null;
      return { name: m[1], address: m[2], date: m[3], signature: s[1], message: message(m[1], m[2], m[3]) };
    }
    return null;
  }

  /** Does the signature recover the claimed address? (koilib Signer.recoverAddress on sha256 of the message.) */
  async function verifySignature(claim, lib) {
    try {
      const L = lib || G.koilib || G.koinos || G;   // the koilib browser build puts Signer and utils on window
      const hash = new Uint8Array(await G.crypto.subtle.digest("SHA-256", new TextEncoder().encode(claim.message)));
      const sig = L.utils.decodeBase64url(claim.signature);
      return sig.length === 65 && L.Signer.recoverAddress(hash, sig) === claim.address;
    } catch {
      return false;
    }
  }

  const emptyDb = () => ({ v: 1, updated: "", names: {}, hidden: {}, nicknames: {}, pools: {} });
  /** A block producer's pool name (the pool contract's own get_pool_params name), shown as it is: plain text, at most
   *  48 characters, never one imitating Knode Games or Koinos or shaped like an address. */
  const okPool = (n) => typeof n === "string" && n.length >= 1 && n.length <= 48 && n.trim() === n && !/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/.test(n)
    && (n.match(/[\p{L}\p{N}]/gu) || []).length >= 2 && !reserved(n) && !addressLike(n);
  /** An on-chain Koinos nickname as the Nicknames contract allows it (shown with an @). Reserved ones are skipped. */
  const okNick = (n) => typeof n === "string" && /^[a-z0-9][a-z0-9.-]{0,31}$/.test(n) && !reserved(n) && !addressLike(n);
  /** A copy of names.json with only valid parts (the shape is checked again on every page and before publishing). */
  function cleanDb(db) {
    const out = emptyDb();
    if (!db || typeof db !== "object" || db.v !== 1) return out;
    out.updated = typeof db.updated === "string" ? db.updated.slice(0, 40) : "";
    for (const [a, e] of Object.entries(db.names && typeof db.names === "object" ? db.names : {})) {
      if (!ADDR.test(a) || BUILTIN[a] || !e || typeof e !== "object" || checkName(e.name) || !isDate(e.date)) continue;
      if (typeof e.signature !== "string" || !/^[A-Za-z0-9_-]{80,96}={0,2}$/.test(e.signature)) continue;
      out.names[a] = { name: e.name, date: e.date, signature: e.signature };
    }
    for (const [a, n] of Object.entries(db.nicknames && typeof db.nicknames === "object" ? db.nicknames : {})) {
      if (ADDR.test(a) && !BUILTIN[a] && okNick(n)) out.nicknames[a] = n;
    }
    for (const [a, n] of Object.entries(db.pools && typeof db.pools === "object" ? db.pools : {})) {
      if (ADDR.test(a) && !BUILTIN[a] && okPool(n)) out.pools[a] = n;
    }
    for (const [a, h] of Object.entries(db.hidden && typeof db.hidden === "object" ? db.hidden : {})) {
      if (!ADDR.test(a) || !h || typeof h !== "object" || !isDate(h.date)) continue;
      out.hidden[a] = { reason: typeof h.reason === "string" ? h.reason.slice(0, 200) : "", date: h.date };
    }
    return out;
  }

  /** Checks a claim against names.json and returns { ok: true, db } (a new names.json) or { ok: false, reason }.
   *  opts: { now (ms), isEligible(address) → boolean, lib (koilib) }. Same code on the claim page, in the workflow and
   *  in the owner's CLI. */
  /** Everything that needs neither the chain nor the signature: the name, the address, the date, hidden, the 7-day
   *  limit and lookalikes. null = fine, else the reason. The claim page runs it before asking for a signature. */
  function precheck(db, claim, now) {
    if (!claim) return "No claim found. It needs the line \"Knode Games name: …\" and the \"Signature: …\" line under it.";
    const bad = checkName(claim.name);
    if (bad) return bad;
    if (!ADDR.test(claim.address)) return "That is not a Koinos address.";
    if (BUILTIN[claim.address]) return "That address is a Knode Games node: its name is set by the owner.";
    if (db.hidden[claim.address]) return "The owner has hidden the name for this address. Contact the owner.";
    if (!isDate(claim.date)) return "The date must be YYYY-MM-DD.";
    const t = dayOf(claim.date);
    if (t > now + 14 * 3600000) return "The date is in the future.";   // today in any time zone (UTC+14 at most)
    if (t < dayOf(today(now)) - MAX_AGE_DAYS * DAY) return `The claim is more than ${MAX_AGE_DAYS} days old. Sign a new one.`;
    const prev = db.names[claim.address];
    if (prev && t <= dayOf(prev.date)) return "This address already has a claim with this date or a later one. Sign a new one tomorrow.";
    if (prev && t < dayOf(prev.date) + CHANGE_DAYS * DAY) {
      return `One change every ${CHANGE_DAYS} days: the next change can be dated ${today(dayOf(prev.date) + CHANGE_DAYS * DAY)} or later.`;
    }
    const f = fold(claim.name);
    for (const [a, e] of Object.entries(db.names)) {
      if (a !== claim.address && fold(e.name) === f) return "That name, or one that looks the same, belongs to another wallet.";
    }
    for (const [a, n] of Object.entries(db.nicknames)) {
      if (a !== claim.address && fold(n) === f) return "That name, or one that looks the same, is another wallet's Koinos nickname.";
    }
    return null;
  }

  /** Checks a claim against names.json and returns { ok: true, db } (a new names.json) or { ok: false, reason }.
   *  opts: { now (ms), isEligible(address) → boolean, lib (koilib) }. Same code on the claim page, in the workflow and
   *  in the owner's CLI. */
  async function applyClaim(dbIn, claim, opts) {
    const db = cleanDb(dbIn);
    const now = opts.now;
    const why = precheck(db, claim, now);
    if (why) return { ok: false, reason: why };
    // The signature first: junk claims never cause a chain read (audit PN-3).
    if (!(await verifySignature(claim, opts.lib))) return { ok: false, reason: "The signature doesn't match the address: sign the exact message with that wallet." };
    const eligible = await opts.isEligible(claim.address);
    if (eligible === null) return { ok: false, unknown: true, reason: "Couldn't check the wallet right now. The claim stays open and is checked again." };
    if (!eligible) return { ok: false, reason: "That wallet can't take a name yet: it needs at least 1 VHP in the wallet or staked in Knode Games, or to be a block producer." };
    db.names[claim.address] = { name: claim.name, date: claim.date, signature: claim.signature };
    db.updated = new Date(now).toISOString();
    return { ok: true, db };
  }

  /** Owner: hide an address's name and nickname (pages show its short address again; new claims from it are refused). */
  function hide(dbIn, address, reason, now) {
    if (!ADDR.test(address)) throw new Error("That is not a Koinos address.");
    const db = cleanDb(dbIn);
    db.hidden[address] = { reason: String(reason || "").slice(0, 200), date: today(now) };
    db.updated = new Date(now).toISOString();
    return db;
  }
  /** Owner: remove an address's name for good (it may claim again later). */
  function remove(dbIn, address, now) {
    const db = cleanDb(dbIn);
    if (!db.names[address]) throw new Error("That address has no name.");
    delete db.names[address];
    db.updated = new Date(now).toISOString();
    return db;
  }
  /** Owner: show it again (its last valid claim comes back; it may claim again). */
  function unhide(dbIn, address, now) {
    const db = cleanDb(dbIn);
    if (!db.hidden[address]) throw new Error("That address isn't hidden.");
    delete db.hidden[address];
    db.updated = new Date(now).toISOString();
    return db;
  }

  // ═══════════════ display ═══════════════
  const short = (a) => (typeof a === "string" && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : String(a ?? ""));
  let shown = { ...BUILTIN };
  const mine = {};             // @names created on this device this visit (names-page.js), until names.json has them
  let current = null;           // names.json as loaded (cleaned); the claim page reads it
  const listeners = new Set();
  /** The name alone ("" if none). Only for layouts that show the short address next to it themselves. */
  const name = (a) => (typeof a === "string" && Object.prototype.hasOwnProperty.call(shown, a) ? shown[a] : "");
  /** "Name · 1Abc12…wxyz", or the short address when there's no name. */
  const of = (a) => (name(a) ? `${name(a)} · ${short(a)}` : short(a));
  /** The same as an element: <span class="kn"><b class="kn-name">Name</b> <span class="kn-addr">1Abc12…wxyz</span></span>. */
  function node(a, cls) {
    const d = G.document;
    const s = d.createElement("span");
    s.className = cls ? `kn ${cls}` : "kn";
    s.title = String(a ?? "");
    if (name(a)) {
      const b = d.createElement("b"); b.className = "kn-name"; b.textContent = name(a);
      s.append(b, " ");
    }
    const t = d.createElement("span"); t.className = "kn-addr"; t.textContent = short(a);
    s.append(t);
    return s;
  }
  /** Use names.json (already checked by cleanDb): hidden addresses and the Knode nodes' addresses are skipped. */
  function use(db) {
    const c = cleanDb(db), next = { ...BUILTIN };
    current = c;
    // A producer's pool name, then an older Knode Games name, then the wallet's Koinos @name, which wins (owner,
    // 30 Oct: the Koinos @name is the one name a wallet has). Plus any @name this device just created.
    for (const [a, n] of Object.entries(c.pools)) if (!c.hidden[a]) next[a] = n;
    for (const [a, e] of Object.entries(c.names)) if (!c.hidden[a]) next[a] = e.name;
    for (const [a, n] of Object.entries(c.nicknames)) if (!c.hidden[a]) next[a] = `@${n}`;
    for (const [a, n] of Object.entries(mine)) if (!c.hidden[a] && okNick(n)) next[a] = `@${n}`;
    shown = next;
    for (const f of listeners) { try { f(); } catch { /* one page part never stops another */ } }
  }
  let loading = null;
  /** Reads names.json once per page. Never fails: without the file, pages show short addresses (and the Knode names). */
  function load() {
    if (!loading) {
      loading = (typeof G.fetch === "function" ? G.fetch(DATA, { cache: "no-cache" }) : Promise.reject(new Error("no fetch")))
        .then((r) => (r.ok ? r.text() : null))
        .then((t) => { if (t && t.length <= 2000000) use(JSON.parse(t)); return true; })   // never a huge file (audit PN-20)
        .catch(() => false);
    }
    return loading;
  }
  /** Calls fn whenever the names change (once names.json arrives). */
  const onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
  /** Show an @name this device just created (checked on chain by the page) before the hourly names.json has it. */
  function setLocal(address, n) {
    if (!ADDR.test(address) || !okNick(n)) return;
    mine[address] = n;
    use(current || emptyDb());
  }

  G.KNames = {
    of, name, short, node, load, onChange, setLocal, DATA,
    /** names.json as loaded and checked (an empty list before it arrives or when there's none yet). */
    db: () => current || emptyDb(),
    rules: { PREFIX, BUILTIN, fold, reserved, checkName, isDate, message, claimText, parseClaim, verifySignature, precheck, applyClaim, cleanDb, emptyDb, okNick, okPool, addressLike, hide, unhide, remove, today },
    _test: { use },
  };
  if (G.document && G.fetch) load();
})();

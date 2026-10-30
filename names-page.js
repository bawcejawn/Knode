/* names.html: a player or producer names their wallet. The page connects Kondor only to read the address and to sign one
   text message (signMessage: no transaction, no Mana). It checks the rules (names.js) and the signature before showing
   the claim, then hands it to GitHub as a prefilled issue (or the wallet's owner copies it to the owner). It never sends
   anything to the chain and stores nothing. Names are only ever set as textContent. */
(() => {
  "use strict";
  const K = window.KNames, R = K && K.rules;
  const lib = window.koilib || window.koinos || window;
  if (!K || !document.getElementById("name")) return;

  const RAW = "https://raw.githubusercontent.com/bawcejawn/Knode/";
  const ISSUE = "https://github.com/bawcejawn/Knode/issues/new?template=producer-name.yml";
  const DAY = 86400000;
  const $ = (id) => document.getElementById(id);
  const say = (id, text, cls) => { const e = $(id); e.textContent = text || ""; e.className = `msg${cls ? ` ${cls}` : ""}`; };
  const S = { address: "", signature: "", producers: null, eligible: {} };
  const UNIT = 100000000n;
  // Read-only chain reads for "may this wallet take a name?" (the check runs the same reads: bot/names.ts).
  const lib0 = window.koilib || window.koinos || window;
  const addrT = (id) => ({ type: "bytes", id, options: { "(koinos.btype)": "ADDRESS" } });
  const u64T = (id) => ({ type: "uint64", id, options: { jstype: "JS_STRING" } });
  const READ_ABI = {
    methods: {
      balance_of: { entry_point: 0x5c721497, argument: "r.balance_of_arguments", return: "r.balance_of_result", read_only: true },
      get_player: { entry_point: 0x37ce3085, argument: "r.get_player_arguments", return: "r.get_player_result", read_only: true },
    },
    koilib_types: { nested: { r: { nested: {
      balance_of_arguments: { fields: { owner: addrT(1) } }, balance_of_result: { fields: { value: u64T(1) } },
      player_object: { fields: { stake: u64T(1), pending: u64T(2), stake_other: u64T(6) } },
      get_player_arguments: { fields: { player: addrT(1), week: u64T(2) } }, get_player_result: { fields: { player: { type: "player_object", id: 1 } } },
    } } } },
  };
  let reader = null;
  async function holdsEnough(a) {
    try {
      if (!reader) {
        const dep = await fetch("./game-data/deployment.json", { cache: "no-cache" }).then((r) => r.json());
        const provider = new lib0.Provider([dep.rpc || "https://koinos.armana.io"]);
        reader = { vhp: new lib0.Contract({ id: dep.vhp, provider, abi: READ_ABI }).functions, game: new lib0.Contract({ id: dep.contract, provider, abi: READ_ABI }).functions };
      }
      const v = BigInt((await reader.vhp.balance_of({ owner: a })).result?.value || 0);
      if (v >= UNIT) return true;
      const p = (await reader.game.get_player({ player: a, week: "0" })).result?.player || {};
      return BigInt(p.stake || 0) + BigInt(p.pending || 0) + BigInt(p.stake_other || 0) >= UNIT;
    } catch { return null; }   // unknown: the check decides
  }
  async function checkEligible(a) {
    if (!a || a in S.eligible) return;
    S.eligible[a] = null;
    const ok = (S.producers && S.producers.has(a)) || (await holdsEnough(a));
    S.eligible[a] = ok;
    if (a === S.address) update();
  }

  // ── who counts as a producer (the same evidence the check uses: race cards of the last 30 days, recent blocks) ──
  async function loadProducers() {
    const out = new Set(), now = Date.now();
    const add = (a) => { if (typeof a === "string" && /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a)) out.add(a); };
    const get = (u) => fetch(u, { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const idx = await get(`${RAW}race-data/index.json`);
    const weeks = Array.isArray(idx && idx.weeks) ? idx.weeks.filter((w) => Number.isInteger(w)).slice(-6) : [];
    const files = await Promise.all([...weeks.map((w) => get(`${RAW}race-data/W${String(w).padStart(3, "0")}.json`)), get(`${RAW}blocks-data/recent-blocks.json`)]);
    for (const j of files) {
      if (j && Array.isArray(j.races)) {
        for (const r of j.races) for (const c of (r && Array.isArray(r.cards) ? r.cards : [])) {
          if (!c || typeof c.at !== "number" || c.at < now - 30 * DAY) continue;
          for (const x of [...(c.field || []), ...(c.paddock || [])]) add(x && x.a);
        }
      } else if (j && Array.isArray(j.signers)) j.signers.forEach(add);
    }
    return out;
  }

  const today = () => R.today(Date.now());
  const claimNow = () => ({ name: $("name").value, address: S.address, date: today() });

  /** Re-check everything after any change; drop a signature that no longer fits. */
  function update() {
    const c = claimNow();
    const db = K.db();
    $("message").value = S.address && c.name ? R.message(c.name, c.address, c.date) : "";
    S.signature = "";
    $("s-send").hidden = true;
    say("sign-msg", "");
    // Who
    const elig = S.address ? S.eligible[S.address] : undefined;
    if (S.address && !(S.address in S.eligible)) checkEligible(S.address);
    if (!S.address) say("who", "Connect Kondor, or enter the wallet address.");
    else if (elig === false) say("who", `${K.short(S.address)} can't take a name yet: it needs at least 1 VHP in the wallet or staked in Knode Games, or to be a block producer.`, "bad");
    else if (db.names[S.address] && !db.hidden[S.address]) say("who", `${K.short(S.address)} is named “${db.names[S.address].name}” (since ${db.names[S.address].date}).`);
    else if (db.nicknames[S.address] && !db.hidden[S.address]) say("who", `${K.short(S.address)} shows as @${db.nicknames[S.address]} (its Koinos nickname) until it takes a Knode Games name.`);
    else say("who", elig ? `${K.short(S.address)} can take a name.` : K.short(S.address));
    // Name
    const preview = $("preview");
    if (c.name) {
      const b = document.createElement("b"); b.className = "kn-name"; b.textContent = c.name;
      const a = document.createElement("span"); a.className = "kn-addr"; a.textContent = S.address ? K.short(S.address) : "1Abc12…wxyz";
      preview.replaceChildren("How it shows: ", b, " ", a);
      preview.hidden = false;
    } else preview.hidden = true;
    const why = c.name ? (S.address ? R.precheck(db, c, Date.now()) : R.checkName(c.name)) : null;
    say("name-msg", why || (c.name && S.address ? "Looks good. Sign it below." : ""), why ? "bad" : c.name && S.address ? "good" : "");
    const ready = !!(S.address && c.name && !why && elig !== false);
    $("sign").disabled = !ready || !window.kondor;
    $("sig-use").disabled = !ready;
    return ready;
  }

  async function accept(signature) {
    const c = { ...claimNow(), signature };
    c.message = R.message(c.name, c.address, c.date);
    if (!(await R.verifySignature(c, lib))) {
      say("sign-msg", "The signature doesn't match this address. Sign with that wallet itself, and sign the exact message above.", "bad");
      return;
    }
    S.signature = signature;
    const text = R.claimText(c.name, c.address, c.date, signature);
    $("claim").value = text;
    $("gh").href = `${ISSUE}&title=${encodeURIComponent(`Knode Games name: ${c.name}`)}&claim=${encodeURIComponent(text)}`;
    $("s-send").hidden = false;
    say("sign-msg", "Signed. The signature matches the address.", "good");
    $("s-send").scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  // ── wiring ──
  $("connect").addEventListener("click", async () => {
    if (!window.kondor || typeof window.kondor.getAccounts !== "function") {
      say("who", "Kondor isn't installed in this browser. Install it, or open “Signing with another tool?” below.", "bad");
      return;
    }
    try {
      const accounts = await Promise.race([window.kondor.getAccounts(), new Promise((_, no) => setTimeout(() => no(new Error("No answer from Kondor. Is it unlocked?")), 20000))]);
      const list = (Array.isArray(accounts) ? accounts : []).filter((x) => x && /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(x.address));
      if (!list.length) { say("who", "Kondor shared no account. Allow this site in Kondor and try again.", "bad"); return; }
      const sel = $("acct");
      sel.replaceChildren(...list.map((x) => { const o = document.createElement("option"); o.value = x.address; o.textContent = `${x.name ? `${String(x.name).slice(0, 30)} · ` : ""}${K.short(x.address)}`; return o; }));
      sel.value = list[0].address;
      sel.hidden = list.length < 2;
      S.address = sel.value;
      $("addr").value = "";
      update();
    } catch (e) {
      say("who", /reject|denied|cancel/i.test(String(e && e.message)) ? "Cancelled in Kondor." : String((e && e.message) || e).slice(0, 160), "bad");
    }
  });
  $("acct").addEventListener("change", () => { S.address = $("acct").value; update(); });
  $("addr").addEventListener("input", () => { const v = $("addr").value.trim(); S.address = /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(v) ? v : ""; $("acct").hidden = true; update(); });
  $("name").addEventListener("input", update);
  $("sign").addEventListener("click", async () => {
    if (!update()) return;
    try {
      say("sign-msg", "Confirm in Kondor…");
      const sig = await window.kondor.getSigner(S.address).signMessage($("message").value);
      await accept(lib.utils.encodeBase64url(sig));
    } catch (e) {
      say("sign-msg", /reject|denied|cancel/i.test(String(e && e.message)) ? "Cancelled in Kondor." : `Couldn't sign: ${String((e && e.message) || e).slice(0, 160)}`, "bad");
    }
  });
  $("sig-use").addEventListener("click", () => {
    const v = $("sig-in").value.trim();
    if (!update()) return;
    if (!/^[A-Za-z0-9_-]{80,96}={0,2}$/.test(v)) { say("sign-msg", "That isn't a signature (65 bytes, base64url).", "bad"); return; }
    accept(v);
  });
  $("copy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($("claim").value); $("copy").textContent = "Copied"; } catch { $("claim").select(); }
  });

  function renderList() {
    const db = K.db();
    const rows = Object.entries(db.names).filter(([a]) => !db.hidden[a]).sort((x, y) => x[1].name.localeCompare(y[1].name));
    const tr = (cells) => { const r = document.createElement("tr"); r.append(...cells); return r; };
    const td = (kid, cls) => { const d = document.createElement("td"); if (cls) d.className = cls; d.append(kid); return d; };
    $("list").replaceChildren(...(rows.length
      ? rows.map(([a, e]) => tr([td(K.node(a)), td(`since ${e.date}`, "d")]))
      : [tr([td("No names yet. Be the first.", "help")])]));
  }

  K.onChange(() => { renderList(); update(); });
  K.load().then(renderList);
  loadProducers().then((p) => { S.producers = p; S.eligible = {}; update(); });
  update();
})();

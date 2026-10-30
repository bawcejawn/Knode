/* names.html: a producer claims a name. The page connects Kondor only to read the producer's address and to sign one
   text message (signMessage: no transaction, no Mana). It checks the rules (names.js) and the signature before showing
   the claim, then hands it to GitHub as a prefilled issue (or the producer copies it to the owner). It never sends
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
  const S = { address: "", signature: "", producers: null };

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
    if (!S.address) say("who", "Connect Kondor, or enter the producer address.");
    else if (S.producers && !S.producers.has(S.address)) say("who", `${K.short(S.address)} isn't on a race card and signed no block in the last 30 days, so the check will refuse it. Pick the producer wallet.`, "bad");
    else if (db.names[S.address] && !db.hidden[S.address]) say("who", `${K.short(S.address)} is named “${db.names[S.address].name}” (since ${db.names[S.address].date}).`);
    else say("who", S.producers ? `${K.short(S.address)}: a producer.` : K.short(S.address));
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
    const ready = !!(S.address && c.name && !why && (!S.producers || S.producers.has(S.address)));
    $("sign").disabled = !ready || !window.kondor;
    $("sig-use").disabled = !ready;
    return ready;
  }

  async function accept(signature) {
    const c = { ...claimNow(), signature };
    c.message = R.message(c.name, c.address, c.date);
    if (!(await R.verifySignature(c, lib))) {
      say("sign-msg", "The signature doesn't match this address. Sign with the producer wallet itself, and sign the exact message above.", "bad");
      return;
    }
    S.signature = signature;
    const text = R.claimText(c.name, c.address, c.date, signature);
    $("claim").value = text;
    $("gh").href = `${ISSUE}&title=${encodeURIComponent(`Producer name: ${c.name}`)}&claim=${encodeURIComponent(text)}`;
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
      // Preselect a producer if one of the accounts is one.
      const prod = S.producers ? list.find((x) => S.producers.has(x.address)) : null;
      sel.value = (prod || list[0]).address;
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
      : [tr([td("No producer names yet. Be the first.", "help")])]));
  }

  K.onChange(() => { renderList(); update(); });
  K.load().then(renderList);
  loadProducers().then((p) => { S.producers = p; update(); });
  update();
})();

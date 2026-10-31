/* names.html: get a Koinos @name. The player connects their own wallet (wallet.js: Kondor or KOIN Vault), types a
   name, sees at once whether the Koinos Nicknames contract would accept it (verify_valid_name, a read), and creates
   it with one transaction from that wallet (Nicknames mint, the player's own Mana; the Mana sponsor never pays for
   it). The contract, the recipient and the Mana limit are fixed here. Names are only ever set as textContent. */
(() => {
  "use strict";
  const K = window.KNames, R = K && K.rules;
  const lib = window.koilib || window.koinos || window;
  const $ = (id) => document.getElementById(id);
  if (!K || !$("nick")) return;

  const NICKNAMES = "1KD9Es7LBBjA1FY3ViCgQJ7e6WH1ipKbhz";   // the Koinos Nicknames contract
  const W = () => window.KWallet;
  const say = (id, text, cls) => { const e = $(id); e.textContent = text || ""; e.className = `msg${cls ? ` ${cls}` : ""}`; };
  const nickHex = (n) => "0x" + Array.from(new TextEncoder().encode(n), (b) => b.toString(16).padStart(2, "0")).join("");
  const nickOf = () => $("nick").value.trim().toLowerCase().replace(/^@/, "");
  const S = { who: "", current: "", checked: "", ok: false, minting: false, seq: 0 };

  let contract = null;
  async function nick(signer) {
    if (!contract) {
      const dep = await fetch("./game-data/deployment.json", { cache: "no-cache" }).then((r) => r.json()).catch(() => ({}));
      contract = new lib.Contract({ id: NICKNAMES, abi: lib.utils.nicknamesAbi, provider: new lib.Provider([dep.rpc || "https://koinos.armana.io"]) });
    }
    return contract.functions;
  }
  /** The contract's own words for why a name can't be used (or null when it's available). */
  function reason(e) {
    const m = String((e && e.message) || e || "");
    const j = /"message"\s*:\s*"([^"]{3,140})"/.exec(m);
    const t = (j ? j[1] : m.replace(/^Error:\s*/, "")).trim();
    return t && t.length <= 160 && !/[{}<>]/.test(t) ? t.charAt(0).toUpperCase() + t.slice(1) + (/[.!?]$/.test(t) ? "" : ".") : "That name can't be used.";
  }

  // ── 1. the wallet ──
  async function showWallet() {
    const w = W(), a = w && w.address;
    S.who = a && w.kind !== "guest" ? a : "";
    $("connect").hidden = !!S.who;
    if (!a) { say("who", "Connect your wallet to start."); return check(); }
    if (w.kind === "guest") { say("who", "Guest wallets can't hold an @name. Connect Kondor or KOIN Vault (the button above, or Connect wallet)."); $("connect").hidden = false; return check(); }
    say("who", `${K.short(a)} connected. Checking for an @name…`);
    try {
      const t = (await (await nick()).get_main_token({ value: a })).result;
      S.current = t && t.token_id ? new TextDecoder().decode(lib.utils.toUint8Array(String(t.token_id).replace(/^0x/, ""))) : "";
    } catch { S.current = ""; }
    say("who", S.current ? `${K.short(a)} is @${S.current}. You're all set; you can also create another one below.` : `${K.short(a)} has no @name yet.`, S.current ? "good" : "");
    check();
  }
  $("connect").addEventListener("click", () => { const w = W(); if (w && w.connect) w.connect(); });
  if (W() && W().subscribe) W().subscribe(() => showWallet());

  // ── 2. the name: checked as you type ──
  let timer = null;
  function check() {
    clearTimeout(timer);
    const n = nickOf(), my = ++S.seq;
    S.ok = false; S.checked = "";
    $("nick-mint").textContent = n ? `Create @${n}` : "Create @name";
    $("nick-mint").disabled = true;
    if (!n) return say("nick-msg", "");
    if (!/^[a-z][a-z0-9.-]{2,31}$/.test(n)) return say("nick-msg", "3 to 32 characters: lowercase letters, numbers, dots and dashes, starting with a letter.", "bad");
    if (!R.okNick(n)) return say("nick-msg", "That one imitates Knode Games or Koinos, or looks like an address. Pick another.", "bad");
    say("nick-msg", "Checking…");
    timer = setTimeout(async () => {
      try {
        // Valid names come back as "@name is available"; anything else is refused with the contract's reason.
        const v = (await (await nick()).verify_valid_name({ value: n })).result;
        if (my !== S.seq) return;
        const text = String((v && v.value) || "");
        if (!/is available$/.test(text)) return say("nick-msg", text || "That name can't be used.", "bad");
        S.ok = true; S.checked = n;
        say("nick-msg", `✓ @${n} is available.${S.who ? "" : " Connect your wallet to create it."}`, "good");
        $("nick-mint").disabled = !S.who || S.minting;
      } catch (e) {
        if (my !== S.seq) return;
        say("nick-msg", reason(e), "bad");
      }
    }, 350);
  }
  $("nick").addEventListener("input", check);

  // ── 3. create it ──
  $("nick-mint").addEventListener("click", async () => {
    const w = W(), n = nickOf(), who = S.who;
    if (S.minting || !S.ok || S.checked !== n || !who || !w) return;
    S.minting = true; $("nick-mint").disabled = true;
    try {
      say("nick-msg", `Confirm “Create @${n}” in your wallet…`);
      const op = (await (await nick()).mint({ to: who, token_id: nickHex(n) }, { onlyOperation: true })).operation;
      const id = await w.send(`create @${n}`, [op]);
      say("nick-msg", "Sent. Waiting for the next block…");
      // Only the chain says whether it worked: who owns @name now?
      let owner = null;
      for (let i = 0; i < 6 && owner !== who; i++) {
        try { owner = (await (await nick()).get_address({ value: n })).result?.value || null; } catch { owner = null; }
        if (owner !== who) await new Promise((r) => setTimeout(r, 5000));
      }
      if (owner === who) {
        if (K.setLocal) K.setLocal(who, n);   // show it on this device at once; everyone else within the hour
        S.current = S.current || n;
        say("nick-msg", `Done! You're @${n} on Koinos. It shows on every Knode Games page within the hour.`, "good");
        $("nick").value = ""; S.ok = false;
        showWallet();
      } else {
        say("nick-msg", id ? "Sent, but it isn't confirmed yet. Check your wallet in a minute before trying again." : "Not confirmed yet. Check your wallet before trying again.", "bad");
      }
    } catch (e) {
      const m = String((e && e.message) || e);
      say("nick-msg", /reject|denied|cancel/i.test(m) ? "Cancelled in your wallet. Nothing was sent."
        : /pending account resources/i.test(m) ? "Your Mana is still busy with your last transaction. Wait a minute and try again."
        : /mana|rc_limit|insufficient/i.test(m) ? "Your wallet doesn't have enough Mana right now. Mana comes from the KOIN in your wallet and refills by itself; try again later."
        : `Couldn't create it: ${reason(e)}`, "bad");
    } finally {
      S.minting = false; $("nick-mint").disabled = !S.ok || !S.who;
    }
  });

  K.load();
  showWallet();
})();

/* stake.html: the staking hub. One place for a wallet's whole stake: what it holds in each game, the game's total and
   its share of it, and Stake / Withdraw / Move / Claim in a couple of taps (no pop-ups: each game's card opens its
   own small form). Every transaction is built by stake-panel.js (KStake.send) and signed in the player's own wallet.
   Everything on screen is built with textContent. */
(() => {
  "use strict";
  const K = window.KStake;
  const $ = (id) => document.getElementById(id);
  if (!K || !K.overview || !$("hub")) return;
  const F = K.fmt, UNIT = 100000000n;
  const PAGES = { 1: "index.html#play", 2: "blockx.html", 3: "survivor.html", 4: "fantasy.html", 6: "golf.html", 7: "race.html", 8: "combo.html", 9: "bracket.html", 13: "lastnode.html" };

  function el(tag, attrs = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") n.className = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid.nodeType ? kid : String(kid));
    return n;
  }
  const vhp = (u) => `${F.amount(u)} VHP`;
  const pct = (x) => (x <= 0 ? "0%" : x < 0.001 ? "<0.1%" : `${(x * 100).toLocaleString("en-US", { maximumFractionDigits: x < 0.1 ? 1 : 0 })}%`);

  const S = { data: null, open: null, busy: false, tab: "games", note: "", noteCls: "" };
  const W = () => K.wallet();
  const me = () => { const w = W(); return w && w.address && w.kind !== "guest" ? w.address : null; };

  let gen = 0;   // only the latest load may show (a slow one from before the wallet connected never overwrites it)
  async function load() {
    const my = ++gen;
    try {
      const d = await K.overview(me());
      if (my !== gen) return;
      S.data = d;
    } catch {
      if (my !== gen) return;
      S.data = S.data || { live: false, error: true };
    }
    render();
  }

  function say(text, cls = "") { S.note = text; S.noteCls = cls; render(); }

  async function run(action, a, done) {
    if (S.busy) return;
    S.busy = true; say(`Confirm in ${W() && W().label ? W().label() : "your wallet"}…`);
    try {
      const id = await K.send(action, a);
      S.open = null;
      say(id ? `Done: ${done}.` : `Sent: ${done}. It may take a minute to show.`, "good");
    } catch (e) {
      say(K.sayError(e), "bad");
    }
    S.busy = false;
    await load();
  }

  // ── one game's small form: Stake, Withdraw or Move ──
  function form(g, mode) {
    const d = S.data, others = d.games.filter((x) => x.active && x.id !== g.id && x.id !== 1);
    const f = S.open;                                   // { id, mode, token, value, to }
    const bal = d.wallet ? (f.token === "KOIN" ? d.wallet.koin : d.wallet.vhp) : 0n;
    const most = mode === "stake" ? (bal / UNIT) * UNIT : g.mine;   // stakes are whole numbers
    const input = el("input", { class: "hub-amt", inputmode: mode === "stake" ? "numeric" : "decimal", autocomplete: "off", placeholder: "Amount", value: f.value || "", "aria-label": "Amount" });
    const units = () => F.toUnits(input.value);
    const set = (v) => { f.value = v; input.value = v; check(); };
    const chips = mode === "stake"
      ? [["1", 1n], ["10", 10n], ["100", 100n]].filter(([, n]) => n * UNIT <= most).map(([t, n]) => [t, F.exact(n * UNIT)]).concat(most > 0n ? [["Max", F.exact(most)]] : [])
      : [["25%", F.exact((most / 4n / 100000n) * 100000n)], ["50%", F.exact((most / 2n / 100000n) * 100000n)], ["All", F.exact(most)]].filter(([, v]) => v !== "0");
    const go = el("button", { class: "btn btn-primary hub-go", type: "button" });
    const hint = el("p", { class: "hub-hint" });
    function check() {
      f.value = input.value;
      const u = units();
      let bad = "";
      if (!input.value.trim()) bad = " ";
      else if (!u) bad = "Enter an amount, like 5 or 2.5.";
      else if (mode === "stake" && !/^[1-9]\d*$/.test(input.value.trim())) bad = "Stakes are whole numbers (1, 2, 3 …).";
      else if (mode === "stake" && u > bal) bad = `You have ${F.exact(bal)} ${f.token} in your wallet.`;
      else if (mode !== "stake" && u > g.mine) bad = `You have ${vhp(g.mine)} staked here.`;
      else if (mode === "move" && !f.to) bad = "Pick the game to move it to.";
      const after = !bad && mode === "stake" ? ` Your share becomes ${pct(Number(((g.mine + u) * 1000000n) / (g.total + u)) / 1e6)}.` : "";
      hint.textContent = bad.trim() || ({
        stake: `Counts from next week.${after}${f.token === "KOIN" ? " KOIN is burned into VHP 1:1." : ""}`,
        withdraw: "Straight back to your wallet, right now.",
        move: "No tokens leave the vault. It counts in the new game from next week. You pay this one's Mana yourself.",
      })[mode];
      hint.className = `hub-hint${bad.trim() ? " bad" : ""}`;
      const name = mode === "move" ? (d.games.find((x) => x.id === f.to) || {}).name : "";
      go.textContent = !bad && u ? `${mode === "stake" ? "Stake" : mode === "withdraw" ? "Withdraw" : `Move to ${name}:`} ${F.exact(u)} ${mode === "stake" ? f.token : "VHP"}` : ({ stake: "Stake", withdraw: "Withdraw", move: "Move" })[mode];
      go.disabled = !!bad || S.busy;
    }
    input.addEventListener("input", check);
    go.addEventListener("click", () => {
      const u = units();
      if (mode === "stake") run("stake", { game: g.id, units: u, koin: f.token === "KOIN" }, `staked ${F.exact(u)} ${f.token} in ${g.name}`);
      else if (mode === "withdraw") run("withdraw", { game: g.id, units: u }, `withdrew ${F.exact(u)} VHP from ${g.name}`);
      else run("move", { game: g.id, to: f.to, units: u }, `moved ${F.exact(u)} VHP to ${(d.games.find((x) => x.id === f.to) || {}).name}`);
    });
    const box = el("div", { class: "hub-form" },
      mode === "stake" && d.wallet ? el("div", { class: "seg", role: "radiogroup", "aria-label": "Pay with" },
        ...["VHP", "KOIN"].map((t) => el("button", { type: "button", class: f.token === t ? "on" : null, "aria-pressed": String(f.token === t),
          onclick: () => { f.token = t; f.value = ""; render(); } }, `${t} · ${F.amount(t === "VHP" ? d.wallet.vhp : d.wallet.koin)}`))) : null,
      mode === "move" ? el("div", { class: "hub-to" }, el("span", { class: "muted" }, "To"),
        ...others.map((x) => el("button", { type: "button", class: `chip${f.to === x.id ? " on" : ""}`, onclick: () => { f.to = x.id; render(); } }, x.name))) : null,
      el("div", { class: "hub-amt-row" }, input, ...chips.map(([t, v]) => el("button", { type: "button", class: "chip", onclick: () => set(v) }, t))),
      hint,
      el("div", { class: "hub-form-actions" }, go, el("button", { class: "btn btn-ghost", type: "button", onclick: () => { S.open = null; render(); } }, "Cancel")));
    check();
    setTimeout(() => { if (document.activeElement === document.body) input.focus({ preventScroll: true }); }, 0);
    return box;
  }

  function card(g) {
    const d = S.data, who = me(), open = S.open && S.open.id === g.id ? S.open.mode : null;
    const reward = g.claims.reduce((t, c) => t + c.reward, 0n);
    const chip = !g.active ? ["stopped", "Stopped"] : g.staked ? ["on", "Staked"] : g.mine > 0n ? ["wait", g.pending && g.pendingFrom ? `Counts from ${g.pendingFrom}` : "Counts next week"] : ["", "Not staked"];
    const pick = (mode) => () => { S.open = open === mode ? null : { id: g.id, mode, token: "VHP", value: "", to: null }; S.note = ""; render(); };
    const q = g.id === 1;
    return el("li", { class: `hub-card${g.staked ? " staked" : ""}`, id: `g${g.id}` },
      el("div", { class: "hub-head" },
        el("a", { class: "hub-name", href: PAGES[g.id] || "games.html" }, g.name),
        who ? el("span", { class: `hub-chip ${chip[0]}` }, chip[1]) : null),
      el("div", { class: "hub-nums" },
        who ? el("div", {}, el("small", {}, "Your stake"), el("b", {}, vhp(g.mine))) : null,
        el("div", {}, el("small", {}, "Game total"), el("b", {}, vhp(g.total))),
        who ? el("div", {}, el("small", {}, "Your share"), el("b", {}, pct(g.share))) : el("div", {}, el("small", {}, "Last week"), el("b", {}, g.last != null ? `${F.amount(g.last)} per 100` : "—"))),
      who ? el("div", { class: "hub-bar", role: "img", "aria-label": `Your share: ${pct(g.share)}` }, el("i", { style: `width:${Math.min(100, Math.max(g.mine > 0n ? 1.5 : 0, g.share * 100)).toFixed(1)}%` })) : null,
      who && q ? el("div", { class: "hub-btns" }, el("a", { class: "btn btn-ghost btn-small", href: PAGES[1] }, "Stake or withdraw on Daily Questions →")) : null,
      who && !q ? el("div", { class: "hub-btns" },
        g.active && !d.paused ? el("button", { type: "button", class: `btn btn-small ${open === "stake" ? "btn-primary" : "btn-ghost"}`, disabled: S.busy, onclick: pick("stake") }, "Stake") : null,
        g.mine > 0n ? el("button", { type: "button", class: `btn btn-small ${open === "withdraw" ? "btn-primary" : "btn-ghost"}`, disabled: S.busy, onclick: pick("withdraw") }, "Withdraw") : null,
        g.mine > 0n && d.games.some((x) => x.active && x.id !== g.id && x.id !== 1) ? el("button", { type: "button", class: `btn btn-small ${open === "move" ? "btn-primary" : "btn-ghost"}`, disabled: S.busy, onclick: pick("move") }, "Move") : null,
        reward > 0n ? el("button", { type: "button", class: "btn btn-small btn-tang", disabled: S.busy, onclick: () => run("claim", { claims: g.claims.slice(0, 10).map((c) => ({ game: g.id, week: c.week })) }, `claimed ${vhp(reward)} from ${g.name}`) }, `Claim ${vhp(reward)}`) : null) : null,
      open ? form(g, open) : null);
  }

  function rewards() {
    const d = S.data, all = [];
    for (const g of d.games) for (const c of g.claims) all.push({ g, ...c });
    if (!all.length) return el("p", { class: "muted hub-empty" }, "Nothing to claim right now. Rewards show here after each week is finalized (Mondays).");
    const total = all.reduce((t, c) => t + c.reward, 0n), first = all.slice(0, 10);
    return el("div", {},
      el("ul", { class: "hub-claims" }, ...all.map((c) => el("li", {},
        el("span", {}, el("b", {}, c.g.name), el("small", { class: "muted" }, ` · week of ${F.weekDate(d.config, c.week).replace(/^\w+ /, "")}`)),
        el("b", {}, vhp(c.reward)),
        el("button", { type: "button", class: "btn btn-small btn-ghost", disabled: S.busy, onclick: () => run("claim", { claims: [{ game: c.g.id, week: c.week }] }, `claimed ${vhp(c.reward)}`) }, "Claim")))),
      el("button", { type: "button", class: "btn btn-tang hub-claim-all", disabled: S.busy, onclick: () => run("claim", { claims: first.map((c) => ({ game: c.g.id, week: c.week })) }, `claimed ${first.length} reward${first.length > 1 ? "s" : ""}`) },
        all.length > 10 ? `Claim the first 10 (${vhp(first.reduce((t, c) => t + c.reward, 0n))})` : `Claim all · ${vhp(total)}`));
  }

  function render() {
    const d = S.data, who = me(), w = W();
    $("hub-loading").hidden = !!d;
    if (!d) return;
    $("soon").hidden = d.live || !!d.error;
    $("hub-err").hidden = !d.error;
    $("hub").hidden = !d.live;
    if (!d.live) return;
    const games = [...d.games].sort((a, b) => (b.mine > 0n) - (a.mine > 0n) || (b.id === 1) - (a.id === 1) || Number(b.total - a.total));
    const staked = d.games.reduce((t, g) => t + g.mine, 0n), reward = d.games.reduce((t, g) => t + g.claims.reduce((x, c) => x + c.reward, 0n), 0n);
    const nClaims = d.games.reduce((t, g) => t + g.claims.length, 0);
    $("hub-top").replaceChildren(...[
      !who ? el("div", { class: "hub-connect" },
        el("p", {}, w && w.kind === "guest" ? "Guest wallets play free. Connect a Koinos wallet (Kondor or KOIN Vault) to stake." : "Connect your wallet to see and manage your stakes."),
        el("button", { type: "button", class: "btn btn-primary", onclick: () => w && w.connect && w.connect() }, "Connect wallet")) :
      el("div", { class: "hub-sum" },
        el("div", {}, el("small", {}, "Staked"), el("b", {}, vhp(staked)), el("small", { class: "muted" }, `in ${d.games.filter((g) => g.mine > 0n).length} game${d.games.filter((g) => g.mine > 0n).length === 1 ? "" : "s"}`)),
        el("div", {}, el("small", {}, "In your wallet"), el("b", {}, vhp(d.wallet ? d.wallet.vhp : 0n)), el("small", { class: "muted" }, `${F.amount(d.wallet ? d.wallet.koin : 0n)} KOIN`)),
        el("div", { class: reward > 0n ? "has" : null }, el("small", {}, "Rewards"), el("b", {}, vhp(reward)),
          reward > 0n ? el("button", { type: "button", class: "btn btn-small btn-tang", onclick: () => { S.tab = "rewards"; render(); } }, "Claim →") : el("small", { class: "muted" }, "nothing yet"))),
      S.note ? el("p", { class: `hub-note ${S.noteCls}`, role: "status" }, S.note) : null,
      d.paused ? el("p", { class: "hub-note bad" }, "New stakes are paused right now. Withdrawals and claims always work.") : null].filter(Boolean));
    $("hub-tabs").replaceChildren(
      el("button", { type: "button", role: "tab", "aria-selected": String(S.tab === "games"), onclick: () => { S.tab = "games"; render(); } }, "Games"),
      el("button", { type: "button", role: "tab", "aria-selected": String(S.tab === "rewards"), onclick: () => { S.tab = "rewards"; render(); } }, nClaims ? `Rewards (${nClaims})` : "Rewards"));
    $("hub-tabs").hidden = !who;
    $("hub-body").replaceChildren(S.tab === "rewards" && who ? rewards() : el("ul", { class: "hub-list" }, ...games.map(card)));
  }

  // #g7 (from a game page's status bar): open that game's Stake form.
  function fromHash() {
    const m = /^#g(\d{1,3})$/.exec(location.hash);
    if (!m || !S.data || !S.data.live) return;
    const g = S.data.games.find((x) => x.id === Number(m[1]));
    if (!g) return;
    S.tab = "games";
    if (me() && g.id !== 1 && !S.open) S.open = { id: g.id, mode: g.active ? "stake" : "withdraw", token: "VHP", value: "", to: null };
    render();
    const n = $(`g${g.id}`); if (n) n.scrollIntoView({ block: "center" });
  }
  window.addEventListener("hashchange", fromHash);
  if (W() && W().subscribe) W().subscribe(() => { S.open = null; S.note = ""; load(); });
  // The wallet needs the game's settings (network, chain id, Mana sponsor) to send from this page, as the game pages do.
  (async () => {
    const lib = window.koilib || window.koinos || window, w = W();
    try {
      const dep = await fetch("./game-data/deployment.json", { cache: "no-cache" }).then((r) => r.json());
      if (w && w.init && lib.Provider) w.init({ provider: new lib.Provider([dep.rpc || "https://koinos.armana.io"]), chainId: dep.chainId, payer: dep.payer, sponsor: dep.sponsor });
    } catch { /* the header's defaults (own Mana) */ }
  })();
  K.badge($("q-badge"), { game: 1, href: "index.html#play" });
  load().then(fromHash);
  setInterval(() => { if (!document.hidden && !S.open && !S.busy) load(); }, 60000);
})();

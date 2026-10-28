/* Who Signs Block X: the game page. One script for two pages:
 *   blockx.html          Koinos MAINNET: the live game (Picks game 2).
 *   blockx-testnet.html  the Koinos Foundation TESTNET (<meta name="kg-network" content="testnet">): test KOIN only,
 *                        settings from testnet/blockx.json, its own wallet (testnet-wallet.js), its own data branch.
 * It reads the chain's head block, the handicap card (mainnet: the Producer Race recorder's; testnet: the Block X
 * recorder's own), the recorder's results and leaderboard, and your picks from the Picks contract. It sends one thing:
 * a pick you confirm in your wallet. The scoring is blockx-math.js, the same file the recorder uses. */
(() => {
  "use strict";
  const X = window.KBlockX, M = window.KRaceMath;
  if (!X || !M || typeof document === "undefined" || !document.getElementById("targets")) return;

  const lib = window.koilib || window.koinos || window;
  const MAINNET_CHAIN_ID = "EiBZK_GGVP0H_fXVAM3j6EAuz3-B-l3ejxRSewi7qIBfSA==";
  const meta = document.querySelector('meta[name="kg-network"]');
  const TESTNET = !!(meta && meta.getAttribute("content") === "testnet");
  const ROOT = new URL("../", location.href);
  const NAMES = { "1Mpmf2ERhjYpX7CCiM11WERuM4j17uT1sr": "Knode pool", "1FKTpXBhhHEbu5vVchM8UsVbAvPArJsRmR": "Knode Swap" };

  const $ = (id) => document.getElementById(id);
  const el = (tag, attrs = {}, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (v == null) continue; if (k === "text") e.textContent = v; else if (k.startsWith("on")) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v); } for (const c of kids) if (c != null) e.append(c); return e; };
  const isAddr = (a) => typeof a === "string" && /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a);
  const nameOf = (a) => (isAddr(a) ? NAMES[a] || a.slice(0, 5) + "…" + a.slice(-4) : "–");
  const fmt = (n, d = 0) => Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
  const pts = (h) => fmt(h / 100, 2);
  const clock = (t) => new Date(t).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const dayTime = (t) => new Date(t).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
  const dur = (ms) => { const m = Math.max(0, Math.ceil(ms / 60000)); return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min` : `${m} min`; };
  const say = (t) => { $("status").textContent = t; $("status").hidden = !t; };
  async function fetchJson(url) { const r = await fetch(url, { cache: "no-cache" }); if (!r.ok) throw new Error(String(r.status)); return r.json(); }

  // ── the network ──
  // NET: { rpc, data (this game's data folder), cards ("race" | "self"), game settings, picks contract, wallet, words }
  let NET = null, G = X, provider = null, W = null;
  async function setupNet() {
    if (!TESTNET) {
      let picks = null;
      try { const d = await fetchJson(new URL("picks-data/deployment.json", ROOT)); if (isAddr(d.contract)) picks = d.contract; } catch { /* not live yet */ }
      NET = { rpc: ["https://koinos.armana.io", "https://api.koinos.io"], data: "https://raw.githubusercontent.com/bawcejawn/Knode/games-data/blockx/", raceData: "https://raw.githubusercontent.com/bawcejawn/Knode/race-data/",
        cards: "race", picks, explorer: "https://koinosscan.com/address/", chainId: MAINNET_CHAIN_ID,
        prize: "1st and 2nd at the end of the week win the free-play prize (2 and 1 VHP, paid once the Knode Games vault is live)." };
      G = X;
      provider = new lib.Provider(NET.rpc);
      W = window.KWallet || null;
      return;
    }
    const cfg = await fetchJson(new URL("testnet/blockx.json", ROOT));
    if (!cfg || cfg.network !== "koinos-foundation-testnet" || cfg.chainId === MAINNET_CHAIN_ID) throw new Error("This page's testnet settings are missing or name mainnet.");
    const want = /^#game-(\d+)$/.exec(location.hash), games = Array.isArray(cfg.games) ? cfg.games : [];
    const game = games.find((g) => want && g.id === Number(want[1])) || games[0];
    G = X.forGame(game);
    // On the owner's own computer (npm run testnet-site), the recorder's files in testnet-data/ on that computer.
    const local = location.hostname === "localhost" || location.hostname === "127.0.0.1";
    const data = local ? new URL(`testnet-data/blockx-${game.id}/`, ROOT).href : `${cfg.data}blockx-${game.id}/`;
    NET = { rpc: [cfg.rpc], data, cards: "self", picks: isAddr(cfg.picks) ? cfg.picks : null, explorer: null, chainId: cfg.chainId,
      faucet: cfg.faucet, games, game, prize: "Test prizes only: on the testnet nothing is paid, and nothing here counts on mainnet." };
    provider = new lib.Provider(NET.rpc);
    const id = await provider.getChainId();
    if (id === MAINNET_CHAIN_ID || (NET.chainId && id !== NET.chainId)) throw new Error("The node isn't the testnet in this page's settings.");
    NET.chainId = NET.chainId || id;
    W = window.KTestWallet || null;
    if (W) W.init({ provider, chainId: NET.chainId, picks: NET.picks });
    // The page's fixed wording, for this game's own settings (the fast game has a target every 300 blocks).
    const mins = Math.round(G.ROUND * X.BLOCK_MS / 60000), about = mins >= 90 ? `about every ${Math.round(mins / 60)} hours` : `about every ${mins} minutes`;
    const words = { every: `Every ${G.ROUND.toLocaleString("en-US")} blocks (${about})`, round: G.ROUND.toLocaleString("en-US"), about, perday: String(G.PICKS_PER_DAY), changes: String(G.MAX_CHANGES) };
    for (const e of document.querySelectorAll("[data-bx]")) { const w = words[e.getAttribute("data-bx")]; if (w) e.textContent = w; }
    renderGameTabs();
  }
  /** Testnet: one button per game in the settings (the real settings, and the fast test game). */
  function renderGameTabs() {
    const box = $("game-tabs");
    if (!box || !NET.games) return;
    box.hidden = NET.games.length < 2;
    box.replaceChildren(...NET.games.map((g) => el("a", { href: `#game-${g.id}`, class: "btn" + (g.id === G.GAME_ID ? "" : " ghost"), "aria-current": g.id === G.GAME_ID ? "page" : null, text: g.name })));
    window.addEventListener("hashchange", () => location.reload());
  }

  let head = null;                 // { height, time }
  let card = null, cardAt = 0;     // the handicap card in force now
  let picksContract = null, myPicks = new Map(), usage = null, sending = false;
  let weeks = new Map(), board = null;
  const drafts = new Map();
  const me = () => (W && W.address) || null;

  async function readHead() {
    const h = await provider.getHeadInfo();
    head = { height: Number(h.head_topology.height), time: Number(h.head_block_time) };
    return head;
  }
  const about = (h) => X.aboutTime(h, head.height, head.time);

  // ── the producers and their multipliers ──
  async function loadCard() {
    const now = Date.now();
    try {
      if (NET.cards === "self") {
        const j = await fetchJson(NET.data + "cards.json");
        const cs = j && j.v === 1 && Array.isArray(j.cards) ? j.cards.filter((c) => c && Number.isFinite(c.at) && Array.isArray(c.field)) : [];
        const c = cs.sort((a, b) => b.at - a.at)[0];
        if (c) { card = c; cardAt = c.at; }
        return;
      }
      const ra = M.raceAt(now), w = M.weekOf(ra.start);
      const wf = await fetchJson(`${NET.raceData}W${String(w).padStart(3, "0")}.json`);
      const race = wf && Array.isArray(wf.races) ? wf.races.find((r) => r && r.id === ra.id) : null;
      const c = race && Array.isArray(race.cards) ? M.cardForLeg(race.cards, M.legOf(ra.start, now, M.legsOf(race.cards))) : null;
      if (c && Array.isArray(c.field) && c.field.length) { card = c; cardAt = now; }
    } catch { /* keep the last card */ }
  }
  function producers() {
    if (!card) return [];
    const { m } = X.vhpOf(card), tot = [...m.values()].reduce((s, v) => s + v, 0);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([a, v]) => ({ a, share: tot ? v / tot : 0, mult: X.multiplier(card, a) }));
  }

  // ── the Picks contract ──
  async function setupPicks() {
    if (!NET.picks) return;
    const abi = await fetchJson(new URL("picks/abi/picks.koilib.json", ROOT));
    picksContract = new lib.Contract({ id: NET.picks, abi, provider });
    if (!TESTNET && W) {
      let dep = null;
      try { dep = await fetchJson(new URL("game-data/deployment.json", ROOT)); } catch { /* the wallet keeps its defaults */ }
      W.init({ provider, chainId: dep && dep.chainId, payer: dep && dep.payer, sponsor: dep && dep.sponsor, onChange: () => loadMine() });
    }
    $("picks-soon").hidden = true;
    loadMine();
  }
  async function loadMine() {
    if (!picksContract || !head) { renderTargets(true); return; }
    const who = me();
    myPicks = new Map(); usage = null;
    if (who) {
      const rounds = G.openRounds(head.height);
      try {
        const got = await Promise.all(rounds.map((r) => picksContract.functions.get_pick({ game: G.GAME_ID, round: String(r), player: who })
          .then((x) => [r, x.result && x.result.pick && Array.isArray(x.result.pick.producers) ? x.result.pick : null])));
        for (const [r, p] of got) if (p) myPicks.set(r, p);
        usage = (await picksContract.functions.get_usage({ game: G.GAME_ID, player: who })).result || null;
      } catch { /* shown as unknown */ }
    }
    renderTargets(true);
  }

  // ── the open targets ──
  let targetsKey = "";
  function renderTargets(force = false) {
    if (!head) return;
    const list = $("targets");
    if (!force && list.contains(document.activeElement) && document.activeElement.tagName === "SELECT") return;
    const who = me(), rounds = G.offerRounds(head.height), ps = producers();
    const key = JSON.stringify([who, W && W.kind, rounds[0], sending, !!picksContract, cardAt, usage && usage.picks_today, [...myPicks.keys()]]);
    if (!force && key === targetsKey && list.childElementCount) { updateTimes(); return; }
    targetsKey = key;
    $("head-line").textContent = `Head block ${fmt(head.height)} · next target block ${fmt(G.target(G.openRounds(head.height)[0]))}`;
    const max = usage ? Number(usage.max_picks_per_day) || G.PICKS_PER_DAY : G.PICKS_PER_DAY, used = usage ? Number(usage.picks_today) || 0 : 0;
    $("picks-left").textContent = usage ? `${Math.max(0, max - used)} of ${max} picks left today` : "";
    const whoLine = $("picks-who");
    whoLine.replaceChildren();
    if (picksContract && who) whoLine.append(`Picking as ${nameOf(who)}${W.kind === "guest" ? " (guest)" : W.kind === "test" ? " (Test wallet)" : ""}. `);
    if (picksContract && !who) whoLine.append(el("button", { class: "btn", type: "button", onclick: () => W && W.connect() }, TESTNET ? "Connect a testnet wallet" : "Connect wallet"));
    if (TESTNET && who) {
      whoLine.append(el("button", { class: "btn ghost", type: "button", onclick: () => copy(who) }, "Copy my address"));
      if (NET.faucet) whoLine.append(" ", el("a", { href: NET.faucet, target: "_blank", rel: "noopener noreferrer", text: "Get test KOIN (faucet bot: /faucet <your address>)" }));
    }
    const rows = [];
    for (const r of rounds) {
      const h = G.target(r), mine = myPicks.get(r), mineP = mine && mine.producers && mine.producers[0];
      const when = el("div", { class: "bx-when" },
        el("b", { text: `Block ${fmt(h)}` }),
        el("span", { "data-h": String(h), class: "bx-eta", text: `about ${clock(about(h))} · locks in ${dur(about(G.lockHeight(r)) - Date.now())}` }));
      let pickCell;
      if (!picksContract) pickCell = el("div", { class: "bx-now", text: "Picks open soon" });
      else if (!who) pickCell = el("div", { class: "bx-now", text: mineP ? `Your pick: ${nameOf(mineP)}` : "–" });
      else {
        const sel = el("select", { "aria-label": `Producer for block ${fmt(h)}` },
          el("option", { value: "", text: !ps.length ? "Loading producers…" : mineP ? "Change to…" : "Who signs it?" }),
          ...ps.map((p) => { const o = el("option", { value: p.a, text: `${nameOf(p.a)} · ${fmt(p.share * 100, p.share < 0.01 ? 2 : 1)}% · ×${fmt(p.mult, 2)}` }); if (p.a === (drafts.get(r) || mineP)) o.selected = true; return o; }));
        if (!ps.length) sel.disabled = true;
        sel.addEventListener("change", () => { if (sel.value) drafts.set(r, sel.value); else drafts.delete(r); });
        const btn = el("button", { class: "btn", type: "button", onclick: () => sendPick(r, sel.value) }, mineP ? "Change" : "Pick");
        if (sending || used >= max || (mine && Number(mine.changes) >= G.MAX_CHANGES)) btn.disabled = true;
        pickCell = el("div", { class: "bx-pick" }, sel, btn, mineP ? el("div", { class: "bx-now ago", text: `Your pick: ${nameOf(mineP)} (×${fmt(X.multiplier(card, mineP), 2)} if right)` }) : null);
      }
      rows.push(el("div", { class: `bx-row${mineP ? " mine" : ""}` }, when, pickCell));
    }
    list.replaceChildren(...rows);
  }
  function updateTimes() {
    if (!head) return;
    document.querySelectorAll("#targets [data-h]").forEach((n) => {
      const h = Number(n.dataset.h);
      n.textContent = `about ${clock(about(h))} · locks in ${dur(about(h - G.LEAD) - Date.now())}`;
    });
  }
  function copy(text) {
    try { navigator.clipboard.writeText(text).then(() => say("Address copied."), () => say(text)); } catch { say(text); }
  }

  // ── the pick pop-up: wallet → sent → confirmed on the chain ──
  let modal = null;
  function pickModal(state, title, lines = [], actions = []) {
    if (!modal) {
      modal = el("div", { class: "pk-modal", role: "dialog", "aria-modal": "true", "aria-labelledby": "pk-m-title" });
      modal.addEventListener("click", (e) => { if (e.target === modal && !modal.querySelector(".pk-spin")) closeModal(); });
      document.body.append(modal);
    }
    const icon = { busy: el("span", { class: "pk-spin", "aria-hidden": "true" }), ok: el("span", { class: "pk-big ok", text: "✓" }), bad: el("span", { class: "pk-big bad", text: "✗" }), info: el("span", { class: "pk-big", text: "ℹ" }) }[state];
    modal.replaceChildren(el("div", { class: `pk-box ${state}` }, icon, el("h3", { id: "pk-m-title", text: title }), ...lines.map((l) => (typeof l === "string" ? el("p", { text: l }) : l)),
      actions.length ? el("div", { class: "pk-acts" }, ...actions) : null));
    modal.hidden = false;
    const b = modal.querySelector("button"); if (b) b.focus();
  }
  function closeModal() { if (modal) modal.hidden = true; }
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && modal && !modal.hidden && !modal.querySelector(".pk-spin")) closeModal(); });
  const okBtn = (text = "Done") => el("button", { class: "btn", type: "button", onclick: closeModal }, text);

  async function sendPick(r, producer) {
    const who = me();
    if (!who || !picksContract || sending) return;
    const h = G.target(r);
    if (!isAddr(producer)) return pickModal("info", "Choose a producer first", ["Pick who you think signs the block, then press Pick."], [okBtn("OK")]);
    const mine = myPicks.get(r);
    if (mine && mine.producers && mine.producers[0] === producer) return pickModal("info", "That is already your pick", [`${nameOf(producer)} for block ${fmt(h)}.`], [okBtn("OK")]);
    try { await readHead(); } catch { /* use the last head */ }
    if (!(G.lockHeight(r) - head.height > 20)) return pickModal("bad", "Too close to the lock", [`Block ${fmt(h)} locks in a few minutes. Pick a later one.`], [okBtn("OK")]);
    sending = true; renderTargets(true);
    const mult = X.multiplier(card, producer);
    const what = `${nameOf(producer)} signs block ${fmt(h)} (about ${dayTime(about(h))})`;
    const wallet = W.kind === "guest" ? "your guest wallet" : W.label ? W.label() : "your wallet";
    const mana = TESTNET ? "Testnet: your wallet pays a little test Mana." : "Free: the Knode Mana sponsor pays the Mana.";
    pickModal("busy", W.kind === "guest" || W.kind === "test" ? "Sending your pick…" : `Confirm in ${wallet}`, [what, `Scores ×${fmt(mult, 2)} if right.`, mana]);
    try {
      const { operation } = await picksContract.functions.pick({ player: who, game: G.GAME_ID, round: String(r), producers: [producer], number: "0" }, { onlyOperation: true });
      const id = await W.send(`pick ${nameOf(producer)} for block ${fmt(h)}`, [operation]);
      pickModal("busy", "Sent. Checking the chain…", [what]);
      let onChain = false;
      for (let t = 0; t < 10 && !onChain; t++) {
        try { const x = await picksContract.functions.get_pick({ game: G.GAME_ID, round: String(r), player: who }); onChain = !!(x.result && x.result.pick && x.result.pick.producers && x.result.pick.producers[0] === producer); } catch { /* again */ }
        if (!onChain) await new Promise((res) => setTimeout(res, 3000));
      }
      drafts.delete(r);
      if (onChain) pickModal("ok", "Pick confirmed", [el("p", {}, "Your pick: ", el("b", { text: nameOf(producer) }), ` for block ${fmt(h)}.`),
        `It locks ${G.LEAD} blocks (about ${Math.round(G.LEAD * 3 / 60)} minutes) before the block. Until then you can change it (up to ${G.MAX_CHANGES} times; changes count toward today's ${G.PICKS_PER_DAY}).`,
        id ? el("p", { class: "ago mono", text: `Transaction ${String(id).slice(0, 18)}…` }) : null].filter(Boolean), [okBtn()]);
      else pickModal("info", "Sent, not seen on the chain yet", ["Your wallet sent it. It usually shows within a minute; this list updates by itself."], [okBtn("OK")]);
    } catch (e) {
      const m = String((e && e.message) || e);
      const why = /locked/i.test(m) ? `That block is locked: picks close ${G.LEAD} blocks before it.`
        : /not open yet/i.test(m) ? "That block isn't open yet."
        : /used up/i.test(m) ? "Today's picks are used up (changes count). More after 00:00 UTC."
        : /changed again/i.test(m) ? `That pick has been changed ${G.MAX_CHANGES} times already.`
        : /already your pick/i.test(m) ? "That is already your pick."
        : /closed/i.test(m) ? "This game is switched off right now."
        : /reject|denied|cancel/i.test(m) ? "Cancelled in your wallet. Nothing was sent."
        : `Not sent: ${m.slice(0, 200)}`;
      pickModal(/Cancelled/.test(why) ? "info" : "bad", /Cancelled/.test(why) ? "Cancelled" : "Pick not sent", [why], [okBtn("OK")]);
    } finally { sending = false; await loadMine(); }
  }

  // ── results and the leaderboard (the recorder's files) ──
  const lb = window.KBoard ? window.KBoard.create($("bx-board"), {
    label: "Block X leaderboard",
    columns: [{ key: "points", label: "Points" }, { key: "correct", label: "Right" }, { key: "picks", label: "Picks", wide: true }, { key: "days", label: "Days", wide: true }],
    summary: (r) => `${fmt(r.points, 2)} pts · ${r.correct} right`,
    scored: (r) => r.pts > 0,
    link: (a) => (NET && NET.explorer ? NET.explorer + a : null),
    name: nameOf,
    unranked: "The Staked board is for wallets holding at least 1 VHP or staking in Knode Games.",
    free: { show: 6, prize: "" },
  }) : null;
  /** The recorder's rows carry points in hundredths (pts); the board shows them as points. */
  const withPoints = (b) => {
    if (!b) return b;
    const fix = (part) => (part && Array.isArray(part.rows) ? { ...part, rows: part.rows.map((r) => ({ ...r, points: (Number(r.pts) || 0) / 100 })) } : part);
    return { ...b, today: fix(b.today), week: fix(b.week), lastWeek: fix(b.lastWeek), allTime: fix(b.allTime) };
  };
  async function loadResults() {
    const wNow = M.weekOf(Date.now());
    for (const w of [wNow - 1, wNow]) {
      if (w < 0) continue;
      try { const j = await fetchJson(`${NET.data}W${String(w).padStart(3, "0")}.json`); if (j && j.v === 1 && j.week === w && Array.isArray(j.targets)) weeks.set(w, j); } catch { /* none yet */ }
    }
    try { const b = await fetchJson(NET.data + "board.json"); if (b && b.v === 1) board = withPoints(b); } catch { /* none yet */ }
    renderResults(); renderBoard();
  }
  function renderResults() {
    const all = [...weeks.values()].flatMap((w) => w.targets).filter((t) => t && Number.isInteger(t.height)).sort((a, b) => b.height - a.height).slice(0, 12);
    $("results-box").hidden = !all.length;
    const who = me();
    $("res-rows").replaceChildren(...all.map((t) => {
      const p = who && Array.isArray(t.picks) ? t.picks.find((x) => x[0] === who) : null;
      const right = p && p[3] > 0;
      const signer = t.signer ? (NET.explorer ? el("a", { href: NET.explorer + t.signer, target: "_blank", rel: "noopener noreferrer", text: nameOf(t.signer) }) : el("span", { text: nameOf(t.signer) })) : el("span", { text: "–" });
      return el("tr", { class: right ? "me" : null },
        el("td", { class: "num", text: fmt(t.height) }),
        el("td", { class: "hide-sm", text: dayTime(t.time) }),
        el("td", { class: "mono" }, signer),
        el("td", { class: "num hide-sm", text: t.void ? "void" : String((t.picks || []).filter((x) => x[3] > 0).length) + " / " + String((t.picks || []).length) }),
        el("td", { text: !p ? "" : right ? `✓ ${nameOf(p[1])} +${pts(p[3])}` : `✗ ${nameOf(p[1])}` }));
    }));
  }
  function renderBoard() {
    if (!board || !lb) { $("board-box").hidden = true; return; }
    $("board-box").hidden = false;
    lb.setMe(me() || "");
    lb.set(board);
    const lw = board.lastWeek, prizes = lw && lw.final && Array.isArray(lw.prizes) ? lw.prizes : [];
    $("prize-line").textContent = prizes.length
      ? `${TESTNET ? "Test prizes" : "Prizes"} for week ${lw.week + 1}: ${prizes.map((p) => `${nameOf(p.player)} ${fmt(p.vhp, p.vhp % 1 ? 2 : 0)} VHP`).join(", ")}.${TESTNET ? " Nothing is paid on the testnet." : ""}`
      : NET.prize;
  }
  if (W && W.subscribe) W.subscribe(() => { loadMine(); renderBoard(); renderResults(); });

  function renderMults() {
    const ps = producers();
    $("mult-sub").textContent = card
      ? `From the ${NET.cards === "self" ? "Block X recorder's" : "Producer Race's"} handicap card of ${dayTime(card.at || cardAt)}. A right pick scores the multiplier: top producer's VHP ÷ yours, at most ×3.`
      : `Waiting for the ${NET.cards === "self" ? "Block X recorder's first card (it runs every hour)" : "race recorder's card"}…`;
    $("mult-rows").replaceChildren(...ps.map((p) => el("tr", {},
      el("td", { class: "mono" }, NET.explorer ? el("a", { href: NET.explorer + p.a, target: "_blank", rel: "noopener noreferrer", text: nameOf(p.a) }) : el("span", { text: nameOf(p.a) })),
      el("td", { class: "num", text: `${fmt(p.share * 100, p.share < 0.01 ? 2 : 1)}%` }),
      el("td", { class: "num", text: `×${fmt(p.mult, 2)}` }),
      el("td", { class: "num hide-sm", text: fmt(p.share * p.mult * 100, 1) }))));
  }

  // ── start ──
  (async () => {
    try { await setupNet(); }
    catch (e) { say(TESTNET ? `Testnet settings problem: ${String((e && e.message) || e)}` : "Couldn't load the game settings."); return; }
    $("game-rules").textContent = `A target every ${fmt(G.ROUND)} blocks (about ${dur(G.ROUND * X.BLOCK_MS)}). Picks lock ${G.LEAD} blocks before the target and open ${fmt(G.AHEAD)} blocks ahead. Up to ${G.PICKS_PER_DAY} picks a day; each pick can be changed ${G.MAX_CHANGES} times.`;
    const picksReady = setupPicks().catch(() => {});
    try { await readHead(); say(""); } catch { say("Couldn't reach the Koinos network. Trying again in a moment…"); }
    await loadCard(); renderMults();
    await picksReady; renderTargets(true);
    loadResults();
    setInterval(() => { if (!document.hidden) readHead().then(() => { say(""); renderTargets(); }).catch(() => say("Reconnecting to the Koinos network…")); }, 6000);
    setInterval(() => { if (!document.hidden) loadCard().then(renderMults); }, 600000);
    setInterval(() => { if (!document.hidden) loadResults(); }, TESTNET ? 120000 : 300000);
    setInterval(() => { if (!document.hidden && picksContract) loadMine(); }, 60000);
    setInterval(updateTimes, 15000);
  })();
})();

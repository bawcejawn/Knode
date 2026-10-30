/* Knode Games: the shared "stake in this game" panel (Vault v6).
   Any game page mounts it with   KStake.mount(element, { game: <vault game id> })   after wallet.js has loaded.
   It shows the wallet's stake in that game, the game's total and this week's minimum, and offers Stake (deposit_to),
   Withdraw (withdraw_from), Move (move_stake) and the claims for the game's finished weeks (claim_game).
   It stays hidden until the vault is live: the game contract answers get_state with v6_rule_week_plus_one > 0 and the
   game is registered. Withdraw is always offered when there is a stake, also when deposits are paused or the game has
   stopped. Every transaction is signed in the player's own wallet (wallet.js). The question game (id 1) keeps its own
   controls on the home page; this panel is for every other game. */
(() => {
  "use strict";

  const UNIT = 100000000n;                 // 1 VHP / 1 KOIN = 10^8 units
  const CAP_A = 10n * UNIT;                // basket A counts a stake up to 10 VHP (the vault's V5_CAP_A)
  const RPC = "https://koinos.armana.io";
  const DEPLOYMENT = "./game-data/deployment.json";
  const Q_GAME = 1;
  const CLAIM_WEEKS = 52;                  // finished weeks checked for something to claim (the vault never expires a claim)
  const lib = window.koilib || window.koinos || window;

  // ── The parts of the vault (game contract, v6) this panel uses. Entry points = first 4 bytes of sha256(name);
  //    tests/audit/site.stake-panel.test.mjs checks them, and every field number against game/abi/kpred.koilib.json
  //    once that file is the v6 one. Fields the panel doesn't read are left out (the decoder skips them).
  const addr = (id) => ({ type: "bytes", id, options: { "(koinos.btype)": "ADDRESS" } });
  const u64 = (id) => ({ type: "uint64", id, options: { jstype: "JS_STRING" } });
  const u32 = (id) => ({ type: "uint32", id });
  const bool = (id) => ({ type: "bool", id });
  const VAULT_ABI = {
    methods: {
      get_state: { entry_point: 0x3d02a349, argument: "kpred.get_state_arguments", return: "kpred.get_state_result", read_only: true },
      get_player: { entry_point: 0x37ce3085, argument: "kpred.get_player_arguments", return: "kpred.get_player_result", read_only: true },
      get_game: { entry_point: 0x6f8d72cf, argument: "kpred.get_game_arguments", return: "kpred.get_game_result", read_only: true },
      list_games: { entry_point: 0x2efa793, argument: "kpred.list_games_arguments", return: "kpred.list_games_result", read_only: true },
      get_game_player: { entry_point: 0xfeb472b, argument: "kpred.get_game_player_arguments", return: "kpred.get_game_player_result", read_only: true },
      deposit_to: { entry_point: 0x7bb5c436, argument: "kpred.deposit_to_arguments", return: "kpred.deposit_to_result", read_only: false },
      withdraw_from: { entry_point: 0x5b0aaef8, argument: "kpred.withdraw_from_arguments", return: "kpred.withdraw_from_result", read_only: false },
      move_stake: { entry_point: 0x7c268e69, argument: "kpred.move_stake_arguments", return: "kpred.move_stake_result", read_only: false },
      claim_game: { entry_point: 0x4107e3ab, argument: "kpred.claim_game_arguments", return: "kpred.claim_game_result", read_only: false },
    },
    koilib_types: { nested: { kpred: { nested: {
      config_object: { fields: { genesis_time: u64(4), week_length: u64(5), min_stake: u64(9), paused: bool(11), min_stake_next: u64(13), min_stake_next_week: u64(14), v6_rule_week_plus_one: u64(21) } },
      get_state_arguments: { fields: {} },
      get_state_result: { fields: { config: { type: "config_object", id: 1 }, week: u64(4), time: u64(11) } },
      player_object: { fields: { stake: u64(1), pending: u64(2), pending_week: u64(3) } },
      get_player_arguments: { fields: { player: addr(1), week: u64(2) } },
      get_player_result: { fields: { player: { type: "player_object", id: 1 }, active_stake: u64(3) } },
      game_object: { fields: { id: u32(1), name: { type: "string", id: 2 }, staked: bool(3), free_prize: bool(4), active: bool(5), from_week: u64(6), last_week_plus_one: u64(7), stake: u64(10), week_stake: u64(11), week: u64(12), season_weeks: u32(15) } },
      gweek_object: { fields: {
        closed: bool(1), bucket: u64(2), prize: u64(3), voided: bool(7), finalized: bool(8), rolled_over: bool(9), cutoff: u32(12),
        pot_a: u64(14), pot_b: u64(15), bw_hi: u64(17), bw_lo: u64(18), aw_hi: u64(19), aw_lo: u64(20),
        first_n: u32(26), second_n: u32(27), prize_first: u64(28), prize_second: u64(29), weight: u64(31), weight_set: bool(32),
      } },
      bucket_object: { fields: { stake: u64(1), players: u32(2), sum_w: u64(3), capped: u64(4) } },
      get_game_arguments: { fields: { game: u32(1), week: u64(2) } },
      get_game_result: { fields: { game: { type: "game_object", id: 1 }, week: { type: "gweek_object", id: 2 }, buckets: { rule: "repeated", type: "bucket_object", id: 3 } } },
      list_games_arguments: { fields: {} },
      list_games_result: { fields: { games: { rule: "repeated", type: "game_object", id: 1 } } },
      gplayer_object: { fields: { stake: u64(1), pending: u64(2), pending_week: u64(3), void_week_plus_one: u64(4) } },
      gentry_object: { fields: { stake: u64(1), voided: bool(2), points: u32(3), claimed: bool(4), reward: u64(5), prize_place: u32(6) } },
      get_game_player_arguments: { fields: { player: addr(1), game: u32(2), week: u64(3) } },
      get_game_player_result: { fields: { player: { type: "gplayer_object", id: 1 }, entry: { type: "gentry_object", id: 2 }, active_stake: u64(3), week_stake: u64(4) } },
      deposit_to_arguments: { fields: { from: addr(1), game: u32(2), amount: u64(3), koin: bool(4) } },
      deposit_to_result: { fields: {} },
      withdraw_from_arguments: { fields: { to: addr(1), game: u32(2), amount: u64(3) } },
      withdraw_from_result: { fields: {} },
      move_stake_arguments: { fields: { player: addr(1), from_game: u32(2), to_game: u32(3), amount: u64(4) } },
      move_stake_result: { fields: {} },
      claim_game_arguments: { fields: { player: addr(1), game: u32(2), week: u64(3) } },
      claim_game_result: { fields: { reward: u64(1) } },
    } } } },
  };
  const TOKEN_ABI = {
    methods: {
      balance_of: { entry_point: 0x5c721497, argument: "token.balance_of_arguments", return: "token.balance_of_result", read_only: true },
      approve: { entry_point: 0x74e21680, argument: "token.approve_arguments", return: "token.approve_result", read_only: false },
    },
    koilib_types: { nested: { token: { nested: {
      balance_of_arguments: { fields: { owner: addr(1) } },
      balance_of_result: { fields: { value: u64(1) } },
      approve_arguments: { fields: { owner: addr(1), spender: addr(2), value: u64(3) } },
      approve_result: { fields: {} },
    } } } },
  };

  // ═══════════════ pure helpers (also used by the tests) ═══════════════
  const big = (x) => { try { return BigInt(x ?? 0); } catch { return 0n; } };
  const amount = (units) => {
    const v = Number(big(units)) / 1e8;
    return v.toLocaleString("en-US", { maximumFractionDigits: v !== 0 && Math.abs(v) < 1 ? 4 : 2 });
  };
  /** Every decimal, nothing rounded. */
  const exact = (units) => {
    const v = big(units), w = v / UNIT, f = (v % UNIT).toString().padStart(8, "0").replace(/0+$/, "");
    return f ? `${w}.${f}` : `${w}`;
  };
  /** "12.5" → 1250000000n; null if not a positive amount with at most 8 decimals or above 64 bits. */
  function toUnits(raw) {
    const m = /^(\d{1,11})(?:\.(\d{1,8}))?$/.exec(String(raw).trim());
    if (!m) return null;
    const v = BigInt(m[1]) * UNIT + BigInt((m[2] || "").padEnd(8, "0"));
    return v > 0n && v <= 18446744073709551615n ? v : null;
  }
  /** The minimum stake for week w: a new minimum applies from its first week (get_state → config). */
  function minStakeFor(config, w) {
    const next = big(config && config.min_stake_next);
    return next > 0n && big(w) >= big(config.min_stake_next_week) ? next : big(config && config.min_stake);
  }
  /** The Monday a vault week starts, as players read it: "Mon 2 Nov" (UTC). */
  function weekDate(config, w) {
    const len = big(config && config.week_length) || 604800000n;
    const ms = Number(big(config && config.genesis_time) + big(w) * len);
    return new Date(ms).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).replace(",", "");
  }
  /** Last week's rewards per 100 VHP staked in a game: its bucket ÷ the stake counted for it (null = not known). */
  function per100(gw) {
    if (!gw || !gw.closed || !gw.weight_set) return null;
    const w = big(gw.weight);
    return w > 0n ? (big(gw.bucket) * 100n * UNIT) / w : null;
  }
  const live = (state) => !!(state && state.config && big(state.config.v6_rule_week_plus_one) > 0n);
  /** What claim_game would pay for a week now (0n = nothing), the same rule as the vault's claimableG / rewardOfG. */
  function claimable(gw, e, buckets) {
    if (!gw || !gw.finalized || !e || e.claimed) return 0n;
    const place = Number(e.prize_place || 0);
    if (place === 1) return big(gw.prize_first);
    if (place === 2) return Number(gw.first_n || 0) === 1 ? big(gw.prize_second) : 0n;
    const points = Number(e.points || 0), cutoff = Number(gw.cutoff || 0);
    if (gw.rolled_over || cutoff < 1 || points < cutoff) return 0n;
    const b = (buckets || [])[points];
    const n = big(b && b.players);
    if (n === 0n) return 0n;
    const sumW = big(b.sum_w), stake = big(e.stake);
    const aw = (big(gw.aw_hi) << 64n) + big(gw.aw_lo), bw = (big(gw.bw_hi) << 64n) + big(gw.bw_lo);
    let reward = 0n;
    if (aw > 0n) reward = (big(gw.pot_a) * ((sumW * (stake < CAP_A ? stake : CAP_A)) / n)) / aw;
    if (bw > 0n) reward += (big(gw.pot_b) * ((sumW * stake) / n)) / bw;
    return reward;
  }
  /** One line for the page: who plays for what in this game. */
  function explain(game, min) {
    const m = exact(min || UNIT);
    if (!game || !game.staked) return "";
    const prize = Number(game.season_weeks || 0) > 1 ? "the 4 + 2 VHP season prize" : "the 2 + 1 VHP prize";
    return game.free_prize
      ? `Staked players (at least ${m} VHP in this game) share this game's weekly bucket; free players play for ${prize}.`
      : `Staked players (at least ${m} VHP in this game) share this game's weekly bucket.`;
  }
  const opOf = async (contract, fn, args) => (await contract.functions[fn](args, { onlyOperation: true })).operation;
  /** The operations for one action, in one transaction. `units` is a BigInt amount; `k` = { lib, dep, provider }. */
  async function buildOps(k, action, a) {
    const vault = new k.lib.Contract({ id: k.dep.contract, abi: VAULT_ABI, provider: k.provider });
    const amt = a.units != null ? a.units.toString() : undefined;
    if (action === "stake") {
      const tokenId = a.koin ? k.dep.koin : k.dep.vhp;
      const token = new k.lib.Contract({ id: tokenId, abi: TOKEN_ABI, provider: k.provider });
      return [
        await opOf(token, "approve", { owner: a.player, spender: k.dep.contract, value: amt }),
        await opOf(vault, "deposit_to", { from: a.player, game: a.game, amount: amt, koin: !!a.koin }),
      ];
    }
    if (action === "withdraw") return [await opOf(vault, "withdraw_from", { to: a.player, game: a.game, amount: amt })];
    if (action === "move") return [await opOf(vault, "move_stake", { player: a.player, from_game: a.game, to_game: a.to, amount: amt })];
    if (action === "claim") return [await opOf(vault, "claim_game", { player: a.player, game: a.game, week: String(a.week) })];
    throw new Error(`unknown action ${action}`);
  }

  // ═══════════════ DOM ═══════════════
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [key, v] of Object.entries(attrs)) {
      if (key === "class") n.className = v;
      else if (key.startsWith("on")) n.addEventListener(key.slice(2), v);
      else if (v !== false && v != null) n.setAttribute(key, v === true ? "" : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid.nodeType ? kid : String(kid));
    return n;
  };

  let shared = null;   // { dep, provider, vault } for every panel on the page
  async function setup() {
    if (shared) return shared;
    if (!lib.Contract || !lib.Provider) throw new Error("koilib missing");
    const res = await fetch(DEPLOYMENT, { cache: "no-cache" });
    if (!res.ok) throw new Error("no deployment");
    const dep = await res.json();
    if (!dep || !dep.contract || !dep.vhp || !dep.koin) throw new Error("no vault");
    const provider = new lib.Provider([dep.rpc || RPC]);
    shared = { dep, provider, vault: new lib.Contract({ id: dep.contract, abi: VAULT_ABI, provider }) };
    return shared;
  }
  const read = async (fn, args) => (await shared.vault.functions[fn](args)).result || {};

  function mount(root, opts = {}) {
    const game = Number(opts.game);
    if (!root || !Number.isInteger(game) || game <= Q_GAME) return null;
    root.hidden = true;
    root.classList.add("kstake");
    const P = { state: null, game: null, games: [], me: null, claims: [], busy: false, note: "" };

    async function refresh() {
      try {
        await setup();
        const state = await read("get_state", {});
        if (!live(state)) { root.hidden = true; return; }
        const week = big(state.week);
        const g = await read("get_game", { game, week: week.toString() });
        if (!g.game || !g.game.staked) { root.hidden = true; return; }
        P.state = state; P.game = g.game;
        P.games = ((await read("list_games", {})).games || []).filter((x) => x.active && x.staked && Number(x.id) !== game);
        const who = window.KWallet && window.KWallet.address;
        P.me = null; P.claims = [];
        if (who) {
          P.me = await read("get_game_player", { player: who, game, week: week.toString() });
          // Not from the game's from_week: a game restarted after a gap moves it forward, and the weeks it earned before
          // stay claimable. The player's own entries first (8 at a time); a week's results only where there's an entry
          // with something in it.
          const weeks = [];
          for (let w = week - 1n; w >= 0n && w >= week - BigInt(CLAIM_WEEKS); w--) weeks.push(w);
          for (let i = 0; i < weeks.length; i += 8) {
            const part = weeks.slice(i, i + 8);
            const mine = await Promise.all(part.map((w) => read("get_game_player", { player: who, game, week: w.toString() })));
            for (let j = 0; j < part.length; j++) {
              const e = mine[j] && mine[j].entry;
              if (!e || e.claimed || !(Number(e.points || 0) > 0 || Number(e.prize_place || 0) > 0)) continue;
              const gx = await read("get_game", { game, week: part[j].toString() });
              const r = claimable(gx.week, e, gx.buckets);
              if (r > 0n) P.claims.push({ week: part[j], reward: r });
            }
          }
        }
        render();
      } catch {
        // Not live, not reachable or not on this network: keep the panel out of the way (the game page still works).
        // A read that fails after the panel has shown keeps what it showed.
        if (!P.state) root.hidden = true;
      }
    }

    async function act(label, action, a) {
      if (P.busy) return;
      const W = window.KWallet;
      if (!W) return;
      if (!W.address) { await W.connect(); return; }
      P.busy = true; P.note = `Confirm “${label}” in ${W.label()}…`; render();
      try {
        const ops = await buildOps({ lib, dep: shared.dep, provider: shared.provider }, action, { ...a, player: W.address, game });
        const id = await W.send(label, ops);
        P.note = id ? `Done: ${label}.` : `Sent: ${label}. It may take a minute to show.`;
      } catch (e) {
        const msg = String((e && e.message) || e);
        P.note = /reject|denied|cancel/i.test(msg) ? "Cancelled in your wallet." : `Not sent: ${(/"([^"]{6,140})"/.exec(msg) || [, msg])[1].slice(0, 160)}`;
      }
      P.busy = false;
      await refresh();
    }

    function dialog(mode) {
      const W = window.KWallet;
      if (W && W.kind === "guest") return W.guestInfo();
      if (W && !W.address) return W.connect();
      const st = P.me && P.me.player ? big(P.me.player.stake) + big(P.me.player.pending) : 0n;
      const cfg = P.state.config, min = minStakeFor(cfg, P.state.week);
      const input = el("input", { inputmode: mode === "stake" ? "numeric" : "decimal", autocomplete: "off", placeholder: mode === "stake" ? "e.g. 25" : "e.g. 2.5", required: true });
      const tok = el("div", { class: "seg", role: "radiogroup", "aria-label": "Token" },
        el("label", {}, el("input", { type: "radio", name: "kstake-tok", value: "VHP", checked: true }), el("span", {}, "VHP")),
        el("label", {}, el("input", { type: "radio", name: "kstake-tok", value: "KOIN" }), el("span", {}, "KOIN")));
      const to = el("select", { "aria-label": "Move to" }, ...P.games.map((x) => el("option", { value: String(x.id) }, x.name || `Game ${x.id}`)));
      const err = el("p", { class: "warn", hidden: true });
      const help = mode === "stake"
        ? `Whole numbers only (1, 2, 3 …). It counts from next week. You need at least ${exact(min)} VHP in this game to play as a staked player. KOIN is burned into VHP 1:1.`
        : mode === "withdraw"
          ? `Any amount up to ${exact(st)} VHP, decimals included, straight back to your wallet. Always available. Withdrawing part keeps you in this week at the lower stake; withdrawing everything takes you out of this week.`
          : `Moves stake to another game without leaving the vault. It counts there from next week. Up to ${exact(st)} VHP.`;
      const max = mode === "stake" ? null : el("button", { class: "btn btn-ghost btn-small", type: "button", onclick: () => { input.value = exact(st); } }, "All");
      const d = el("dialog", { class: "kstake-dialog" },
        el("form", { method: "dialog" },
          el("h2", {}, mode === "stake" ? "Stake in this game" : mode === "withdraw" ? "Withdraw from this game" : "Move stake"),
          el("p", { class: "muted" }, help),
          el("label", { class: "field" }, el("span", {}, "Amount"), el("span", { class: "amount-row" }, input, max)),
          mode === "stake" ? tok : null,
          mode === "move" ? el("label", { class: "field" }, el("span", {}, "To"), to) : null,
          err,
          el("p", { class: "muted fine-print" }, "Staking is optional; rewards aren't guaranteed. ", el("a", { href: "terms.html", target: "_blank", rel: "noopener" }, "Terms & risks")),
          el("div", { class: "dialog-actions" },
            el("button", { class: "btn btn-ghost", value: "cancel", type: "submit", formnovalidate: true }, "Cancel"),
            el("button", { class: "btn btn-primary", value: "go", type: "submit" }, "Continue in your wallet"))));
      d.addEventListener("close", () => {
        const go = d.returnValue === "go";
        const raw = input.value.trim();
        const koin = mode === "stake" && d.querySelector('input[name="kstake-tok"]:checked').value === "KOIN";
        d.remove();
        if (!go) return;
        const units = toUnits(raw);
        if (mode === "stake") {
          if (!/^[1-9]\d*$/.test(raw) || !units) { P.note = "Stakes are whole numbers only, for example 1 or 25."; return render(); }
          return act(`stake ${exact(units)} ${koin ? "KOIN" : "VHP"} in this game`, "stake", { units, koin });
        }
        if (!units) { P.note = "Enter an amount, for example 2.5 (up to 8 decimals)."; return render(); }
        if (units > st) { P.note = "That is more than you have staked in this game."; return render(); }
        if (mode === "withdraw") return act(`withdraw ${exact(units)} VHP from this game`, "withdraw", { units });
        const target = Number(to.value);
        const name = (P.games.find((x) => Number(x.id) === target) || {}).name || `game ${target}`;
        return act(`move ${exact(units)} VHP to ${name}`, "move", { units, to: target });
      });
      document.body.append(d);
      d.showModal();
      input.focus();
    }

    function render() {
      const g = P.game, cfg = P.state.config, week = big(P.state.week);
      const min = minStakeFor(cfg, week);
      const W = window.KWallet, who = W && W.address;
      const p = P.me && P.me.player;
      const mine = p ? big(p.stake) + big(p.pending) : 0n;
      const counted = P.me ? big(P.me.week_stake) : 0n;
      const pendingNote = p && big(p.pending) > 0n && big(p.pending_week) > week ? ` ${exact(p.pending)} VHP more counts from ${weekDate(cfg, p.pending_week)}.` : "";
      const staked = counted >= min && min > 0n;
      const canStake = g.active && !cfg.paused;
      const rows = [
        el("div", { class: "kstake-stats" },
          el("div", {}, el("span", { class: "muted" }, "Your stake here"), el("b", {}, who ? `${amount(mine)} VHP` : "—")),
          el("div", {}, el("span", { class: "muted" }, "Game total"), el("b", {}, `${amount(g.stake)} VHP`)),
          el("div", {}, el("span", { class: "muted" }, "Minimum this week"), el("b", {}, `${exact(min)} VHP`))),
        who ? el("p", { class: "kstake-status" }, staked
          ? `You're a staked player in this game this week, with ${amount(counted)} VHP counted.${pendingNote}`
          : `You're a free player in this game this week.${pendingNote}`) : null,
        el("p", { class: "muted kstake-explain" }, explain(g, min)),
        !g.active ? el("p", { class: "warn" }, "This game has stopped taking stakes. You can withdraw any time.") : null,
        g.active && cfg.paused ? el("p", { class: "warn" }, "New stakes are paused. Withdrawals always work.") : null,
        el("div", { class: "kstake-actions" },
          !who ? el("button", { class: "btn btn-primary", type: "button", onclick: () => W && W.connect() }, "Connect wallet to stake") : null,
          who && canStake ? el("button", { class: "btn btn-primary", type: "button", disabled: P.busy, onclick: () => dialog("stake") }, "Stake") : null,
          who && mine > 0n ? el("button", { class: "btn btn-ghost", type: "button", disabled: P.busy, onclick: () => dialog("withdraw") }, "Withdraw") : null,
          who && mine > 0n && canStake && P.games.length ? el("button", { class: "btn btn-ghost", type: "button", disabled: P.busy, onclick: () => dialog("move") }, "Move") : null),
        P.claims.length ? el("ul", { class: "kstake-claims" }, ...P.claims.map((c) => el("li", {},
          el("span", {}, `Week of ${weekDate(cfg, c.week).replace(/^\w+ /, "")}: ${amount(c.reward)} VHP`),
          el("button", { class: "btn btn-tang btn-small", type: "button", disabled: P.busy, onclick: () => act(`claim ${exact(c.reward)} VHP for week ${c.week}`, "claim", { week: c.week }) }, "Claim")))) : null,
        P.note ? el("p", { class: "muted kstake-note", role: "status" }, P.note) : null,
      ];
      root.replaceChildren(el("h3", {}, "Stake in this game"), ...rows.filter(Boolean));
      root.hidden = false;
    }

    if (window.KWallet && window.KWallet.subscribe) window.KWallet.subscribe(() => { P.note = ""; refresh(); });
    refresh();
    return { refresh };
  }

  /** "Where to stake": every game that takes stakes, side by side — staked in it, your stake, and last week's rewards
   *  per 100 VHP staked — each with a link to its page's panel. `links` maps a vault game id to that page (the hub's
   *  games.json "vault" ids). Hidden until the vault is live, like the panel. */
  function mountList(root, opts = {}) {
    if (!root) return null;
    root.hidden = true;
    root.classList.add("kstake");
    const links = opts.links || {};
    async function refresh() {
      try {
        await setup();
        const state = await read("get_state", {});
        if (!live(state)) { root.hidden = true; return; }
        const week = big(state.week), cfg = state.config;
        const games = ((await read("list_games", {})).games || []).filter((g) => g.staked && (g.active || big(g.stake) > 0n));
        if (!games.length) { root.hidden = true; return; }
        const who = window.KWallet && window.KWallet.address;
        const rows = [];
        for (const g of games) {
          const id = Number(g.id);
          let last = null, mine = null;
          if (id !== Q_GAME && week > 0n) last = per100((await read("get_game", { game: id, week: (week - 1n).toString() })).week);
          if (who) {
            const r = id === Q_GAME ? await read("get_player", { player: who, week: week.toString() }) : await read("get_game_player", { player: who, game: id, week: week.toString() });
            mine = r.player ? big(r.player.stake) + big(r.player.pending) : 0n;
          }
          rows.push({ id, name: g.name || `Game ${id}`, stake: big(g.stake), last, mine, active: !!g.active, href: links[id] || "" });
        }
        root.replaceChildren(
          el("h3", {}, "Where to stake"),
          el("p", { class: "muted kstake-explain" }, `Stake VHP in any game, as many as you like (at least ${exact(minStakeFor(cfg, week))} VHP in a game to play it as a staked player). Each game's stakers share that game's part of the weekly rewards. You can withdraw any time, or move stake between games.`),
          el("ul", { class: "kstake-list" }, ...rows.map((r) => el("li", {},
            el("div", { class: "kstake-list-head" },
              el("b", {}, r.name),
              r.href ? el("a", { class: "btn btn-ghost btn-small", href: r.href }, r.active ? "Stake →" : "Withdraw →") : el("span", { class: "muted" }, "Page coming soon")),
            el("div", { class: "kstake-list-stats" },
              el("span", {}, el("small", { class: "muted" }, "Staked "), `${amount(r.stake)} VHP`),
              who ? el("span", {}, el("small", { class: "muted" }, "Yours "), `${amount(r.mine)} VHP`) : null,
              el("span", {}, el("small", { class: "muted" }, "Last week "), r.last != null ? `${amount(r.last)} VHP per 100` : r.id === Q_GAME ? "see its page" : "new: no full week yet"))))),
          el("p", { class: "muted fine-print" }, `"Last week" is the game's rewards for the week of ${weekDate(cfg, week - 1n).replace(/^\w+ /, "")} divided by the VHP staked in it: the top 30% of its staked players share them, so winners get more and others nothing. Past weeks don't promise future rewards. Daily Questions pays the staked players who answered: its page shows this week's pot.`));
        root.hidden = false;
      } catch {
        if (!root.children || !root.children.length) root.hidden = true;
      }
    }
    if (window.KWallet && window.KWallet.subscribe) window.KWallet.subscribe(() => refresh());
    refresh();
    return { refresh };
  }

  // ═══════════════ status: staked or free in one game (every game page shows it) ═══════════════
  /** The wallet's standing in one game this week. Daily Questions (game 1) works on every vault version; the other
   *  games once the vault is live. { open, staked, amount, counted, pending, pendingFrom, min } (units are BigInt). */
  async function status(game, who) {
    await setup();
    const state = await read("get_state", {});
    const week = big(state.week), cfg = state.config || {};
    const min = minStakeFor(cfg, week);
    if (game === Q_GAME) {
      const r = who ? await read("get_player", { player: who, week: week.toString() }) : {};
      const p = r.player || {};
      const pending = big(p.pending) > 0n && big(p.pending_week) > week ? big(p.pending) : 0n;
      const counted = big(r.active_stake);
      return { open: true, staked: counted >= min && min > 0n, amount: big(p.stake) + big(p.pending), counted, pending, pendingFrom: pending ? weekDate(cfg, p.pending_week) : "", min };
    }
    if (!live(state)) return { open: false, staked: false, amount: 0n, counted: 0n, pending: 0n, pendingFrom: "", min };
    const g = (await read("get_game", { game, week: week.toString() })).game;
    if (!g || !g.staked) return { open: false, staked: false, amount: 0n, counted: 0n, pending: 0n, pendingFrom: "", min };
    const r = who ? await read("get_game_player", { player: who, game, week: week.toString() }) : {};
    const p = r.player || {};
    const pending = big(p.pending) > 0n && big(p.pending_week) > week ? big(p.pending) : 0n;
    const counted = big(r.week_stake);
    return { open: !!g.active, staked: counted >= min && min > 0n, amount: big(p.stake) + big(p.pending), counted, pending, pendingFrom: pending ? weekDate(cfg, p.pending_week) : "", min };
  }
  /** The text of a status line (also used by the tests). */
  function badgeText(st, connected, guest) {
    if (!connected) return { cls: "free", head: "Playing free", sub: "Connect a wallet to see your stake.", link: "How staking works" };
    if (guest) return { cls: "free", head: "Playing free (guest)", sub: "Guests play free. Stake from a Koinos wallet to share the weekly rewards.", link: "How staking works" };
    if (!st.open && st.amount === 0n) return { cls: "free", head: "Playing free", sub: "Staking in this game opens when the Knode Games vault goes live.", link: "Staking" };
    const more = st.pending > 0n ? ` ${exact(st.pending)} VHP more counts from ${st.pendingFrom}.` : "";
    if (st.staked) return { cls: "staked", head: "Staked", amount: `${amount(st.amount)} VHP`, sub: `You share this game's weekly rewards.${more}`, link: "Manage stake" };
    if (st.amount > 0n) return { cls: "free", head: "Playing free this week", amount: `${amount(st.amount)} VHP staked`, sub: `It counts from ${st.pendingFrom || "next week"}.`, link: "Manage stake" };
    return { cls: "free", head: "Playing free", sub: `Stake ${exact(st.min || UNIT)} VHP or more to share this game's weekly rewards.`, link: "Stake" };
  }
  /** A small status bar for the top of a game page: staked or free, how much, and a link to the staking page. */
  function badge(root, opts = {}) {
    const game = Number(opts.game);
    if (!root || !Number.isInteger(game) || game < Q_GAME) return null;
    const href = opts.href || `stake.html#g${game}`;
    root.classList.add("kbadge");
    async function refresh() {
      const W = window.KWallet, who = W && W.address;
      let st = { open: false, staked: false, amount: 0n, counted: 0n, pending: 0n, pendingFrom: "", min: UNIT };
      try { if (who && W.kind !== "guest") st = await status(game, who); else if (!who) st = await status(game, null); } catch { /* chain unreachable: show "free" without amounts */ }
      const t = badgeText(st, !!who, !!(W && W.kind === "guest"));
      root.className = `kbadge ${t.cls}`;
      root.replaceChildren(
        el("span", { class: "kb-dot", "aria-hidden": "true" }),
        el("span", { class: "kb-main" }, el("b", {}, t.head), t.amount ? el("span", { class: "kb-amt" }, ` · ${t.amount}`) : null),
        el("span", { class: "kb-sub" }, t.sub),
        el("a", { class: "kb-link", href }, `${t.link} →`));
      root.hidden = false;
    }
    if (window.KWallet && window.KWallet.subscribe) window.KWallet.subscribe(() => refresh());
    refresh();
    setInterval(() => { if (!document.hidden) refresh(); }, 120000);
    return { refresh };
  }

  window.KStake = { mount, mountList, badge, status, live: async () => { await setup(); return live(await read("get_state", {})); }, _test: { badgeText, VAULT_ABI, TOKEN_ABI, toUnits, minStakeFor, live, claimable, explain, buildOps, exact, weekDate, per100 } };
})();

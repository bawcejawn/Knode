/* Knode Games: "Stake in this game", one panel every game page can use (owner, 2026-10-28: every game takes stakes in
 * the Knode Games Vault, v6). It shows the wallet's stake in the game, what counts this week, the game's total and the
 * minimum, and offers Stake, Withdraw, Move and any claims for the game's finished weeks.
 *
 *   KStake.mount(hostElement, { game: 7, name: "Producer Race", provider, toast,
 *     note: "Staked players share this game's weekly bucket; free players play for the 2 + 1 VHP prize." });
 *
 * It stays hidden until the vault is live (get_state → config.v6_rule_week_plus_one > 0), this site's contract ABI has
 * the v6 calls, and the game takes stakes. Every transaction is signed in the player's own wallet (window.KWallet);
 * nothing here holds a key. Vault calls (the player is argument 1):
 *   deposit_to(from, game, amount, koin)   after approving the vault for the amount, in the same transaction
 *   withdraw_from(to, game, amount)        any amount, at any time
 *   move_stake(player, from_game, to_game, amount)   counts in the new game from next week
 *   claim_game(player, game, week)         only offered when the vault would pay (its claimableG rule)
 * Built with textContent only. */
(function (root) {
  "use strict";
  const lib = root.koilib || root.koinos || root;
  const UNIT = 100000000n, MAX_U64 = 18446744073709551615n;
  const ROOT = new URL("./", location.href);
  const TOKEN_ABI = {
    methods: {
      approve: { entry_point: 0x74e21680, argument: "token.approve_arguments", return: "token.approve_result", read_only: false },
    },
    koilib_types: { nested: { token: { nested: {
      approve_arguments: { fields: {
        owner: { type: "bytes", id: 1, options: { "(koinos.btype)": "ADDRESS" } },
        spender: { type: "bytes", id: 2, options: { "(koinos.btype)": "ADDRESS" } },
        value: { type: "uint64", id: 3, options: { jstype: "JS_STRING" } } } },
      approve_result: { fields: {} },
    } } } },
  };

  const big = (x) => { try { return BigInt(x || 0); } catch { return 0n; } };
  /** VHP amount from base units, e.g. 250000000n → "2.5". */
  function vhp(units) {
    const u = big(units), whole = u / UNIT, frac = (u % UNIT).toString().padStart(8, "0").replace(/0+$/, "");
    return whole.toLocaleString("en-US") + (frac ? "." + frac : "");
  }
  /** Base units from text: up to 8 decimals; null when it isn't a number. Exported for tests. */
  function toUnits(text) {
    const m = String(text).trim().match(/^(\d{1,12})(?:\.(\d{1,8}))?$/);
    if (!m) return null;
    return BigInt(m[1]) * UNIT + BigInt((m[2] || "").padEnd(8, "0") || "0");
  }
  /** What the vault would pay for a finished week (its claimableG rule), or null when nothing; 0n = a share of the
   *  bucket whose size the page doesn't work out. Exported for tests. */
  function claimable(gw, e) {
    if (!gw || !gw.finalized || !e || e.claimed) return null;
    const place = Number(e.prize_place || 0);
    if (place === 1) return big(gw.prize_first) > 0n ? big(gw.prize_first) : null;
    if (place === 2) return big(gw.prize_second) > 0n ? big(gw.prize_second) : null;
    if (gw.rolled_over || Number(gw.cutoff || 0) < 1 || Number(e.points || 0) < Number(gw.cutoff)) return null;
    return 0n;
  }
  /** The minimum stake for week w (the vault's minStakeFor). Exported for tests. */
  function minStake(cfg, w) {
    const next = big(cfg.min_stake_next);
    return next > 0n && w >= Number(cfg.min_stake_next_week || 0) ? next : big(cfg.min_stake);
  }

  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "text") e.textContent = v; else if (k === "onclick") e.addEventListener("click", v); else e.setAttribute(k, v === true ? "" : v);
    }
    for (const c of kids) if (c) e.append(c);
    return e;
  }
  async function fetchJson(url) { const r = await fetch(url, { cache: "no-cache" }); if (!r.ok) throw new Error(String(r.status)); return r.json(); }

  function mount(host, opt) {
    const o = Object.assign({ game: 0, name: "this game", note: "", provider: null, toast: null }, opt || {});
    const W = root.KWallet;
    const say = (m, ms) => (o.toast ? o.toast(m, ms) : (status.textContent = m));
    const status = el("p", { class: "note ks-status", role: "status" });
    const body = el("div", { class: "ks-body" });
    host.hidden = true;
    host.classList.add("ks");
    host.replaceChildren(el("h2", { text: `Stake in the ${o.name}` }), o.note ? el("p", { class: "note ks-note", text: o.note }) : null, body, status);
    let dep = null, vault = null, cfg = null, cur = 0, games = [], me = null, busy = false;

    async function load() {
      try {
        dep = await fetchJson(new URL("game-data/deployment.json", ROOT));
        const abi = await fetchJson(new URL("game/abi/kpred.koilib.json", ROOT));
        if (!abi.methods || !abi.methods.deposit_to || !abi.methods.get_game_player) return;      // the site is still on v5
        vault = new lib.Contract({ id: dep.contract, abi, provider: o.provider });
        cfg = (await vault.functions.get_state({})).result.config;
        if (!(Number(cfg.v6_rule_week_plus_one || 0) > 0)) return;                                // the vault isn't live
        cur = Math.max(0, Math.floor((Date.now() - Number(cfg.genesis_time)) / Number(cfg.week_length)));
        const list = (await vault.functions.list_games({})).result.games || [];
        games = list.filter((g) => g.active && g.staked);
        if (!games.some((g) => Number(g.id) === o.game)) return;                                  // this game takes no stakes
        host.hidden = false;
        await refresh();
      } catch (e) { /* not live, or the node can't be reached: the panel stays hidden */ }
    }

    async function refresh() {
      const who = W && W.address;
      const g = (await vault.functions.get_game({ game: o.game, week: String(cur) })).result.game || {};
      const min = minStake(cfg, cur);
      const rows = [
        el("p", {}, "Staked in the game: ", el("b", { text: `${vhp(g.stake)} VHP` }), ` · minimum ${vhp(min)} VHP`),
      ];
      me = null;
      if (!who) rows.push(el("p", { class: "note", text: "Connect a wallet to stake in this game." }));
      else if (W.kind === "guest") rows.push(el("p", { class: "note", text: "A guest wallet can't stake. Connect Kondor or KOIN Vault to stake." }));
      else {
        const r = (await vault.functions.get_game_player({ player: who, game: o.game, week: String(cur) })).result || {};
        const p = r.player || {}, total = big(p.stake) + big(p.pending);
        me = { total, now: big(r.active_stake) };
        const peak = r.entry ? big(r.entry.peak_stake) : me.now;           // the vault's own test for this week
        const later = big(p.pending) > 0n && Number(p.pending_week) > cur;
        rows.push(el("p", {}, "Your stake: ", el("b", { text: `${vhp(total)} VHP` }),
          later ? ` (${vhp(p.pending)} VHP counts from week ${Number(p.pending_week) + 1})` : "",
          ` · counting this week: ${vhp(me.now)} VHP`, min > 0n && peak >= min ? " (Staked board)" : " (Free play board)"));
        rows.push(el("div", { class: "ks-actions" },
          el("button", { type: "button", class: "btn btn-primary", onclick: () => ask("stake") }, "Stake"),
          el("button", { type: "button", class: "btn btn-ghost", onclick: () => ask("withdraw"), disabled: total === 0n }, "Withdraw"),
          el("button", { type: "button", class: "btn btn-ghost", onclick: () => ask("move"), disabled: total === 0n || games.length < 2 }, "Move")));
        // Claims for the last four finished weeks.
        const claims = [];
        for (let w = cur - 1; w >= Math.max(0, cur - 4); w--) {
          const [gw, gp] = await Promise.all([
            vault.functions.get_game({ game: o.game, week: String(w) }).then((x) => x.result.week),
            vault.functions.get_game_player({ player: who, game: o.game, week: String(w) }).then((x) => x.result.entry),
          ]);
          const amt = claimable(gw, gp);
          if (amt !== null) claims.push(el("button", { type: "button", class: "btn btn-tang", onclick: () => claim(w) }, amt > 0n ? `Claim week ${w + 1}: ${vhp(amt)} VHP` : `Claim week ${w + 1}`));
        }
        if (claims.length) rows.push(el("div", { class: "ks-actions" }, ...claims));
      }
      body.replaceChildren(...rows);
    }

    async function send(label, build) {
      if (busy) return;
      busy = true;
      try {
        const ops = await build();
        say(`Confirm “${label}” in ${W.label()}…`, 20000);
        const id = await W.send(label, ops, {});
        say(id ? `Done: ${label}` : `Sent: ${label}. It may take a minute to show.`, 8000);
      } catch (e) {
        const m = String((e && e.message) || e);
        say(/reject|denied|cancel/i.test(m) ? `Cancelled in ${W.label()}.` : `Not sent: ${m.slice(0, 160)}`, 9000);
      } finally { busy = false; refresh().catch(() => {}); }
    }
    const op = async (contract, fn, args) => (await contract.functions[fn](args, { onlyOperation: true })).operation;

    function claim(w) {
      const who = W.address;
      send(`claim ${o.name} week ${w + 1}`, async () => [await op(vault, "claim_game", { player: who, game: o.game, week: String(w) })]);
    }

    /** The Stake / Withdraw / Move dialog. */
    function ask(mode) {
      const who = W.address, total = me ? me.total : 0n;
      const amount = el("input", { id: `ks-amount-${o.game}`, inputmode: mode === "withdraw" ? "decimal" : "numeric", autocomplete: "off", placeholder: mode === "withdraw" ? "e.g. 2.5" : "e.g. 5" });
      const token = el("select", { id: `ks-token-${o.game}` }, el("option", { value: "VHP", text: "VHP" }), el("option", { value: "KOIN", text: "KOIN (burned into VHP 1:1)" }));
      const target = el("select", { id: `ks-target-${o.game}` }, ...games.filter((g) => Number(g.id) !== o.game).map((g) => el("option", { value: String(g.id), text: g.name || `Game ${g.id}` })));
      const err = el("p", { class: "note ks-err", role: "alert" });
      const help = {
        stake: "Whole VHP only (1, 2, 3 …). It counts from next week. You can withdraw at any time.",
        withdraw: `Any amount up to ${vhp(total)} VHP, at any time. If you were staked at the start of this week, you stay on the Staked board this week, counted at your lowest stake.`,
        move: `Move up to ${vhp(total)} VHP (whole VHP) to another game. No tokens move, and it counts there from next week.`,
      }[mode];
      const go = el("button", { type: "submit", class: "btn btn-primary" }, { stake: "Stake", withdraw: "Withdraw", move: "Move" }[mode]);
      const cancel = el("button", { type: "button", class: "btn btn-ghost" }, "Cancel");
      const form = el("form", { method: "dialog" },
        el("h3", { text: { stake: `Stake in the ${o.name}`, withdraw: `Withdraw from the ${o.name}`, move: `Move stake from the ${o.name}` }[mode] }),
        el("p", { class: "note", text: help }),
        el("label", { for: amount.id, text: "Amount" }), amount,
        mode === "stake" ? el("label", { for: token.id, text: "Pay with" }) : null, mode === "stake" ? token : null,
        mode === "move" ? el("label", { for: target.id, text: "To" }) : null, mode === "move" ? target : null,
        err, el("div", { class: "ks-actions" }, go, cancel));
      const d = el("dialog", { class: "ks-dialog" }, form);
      document.body.append(d);
      cancel.addEventListener("click", () => d.close());
      d.addEventListener("close", () => d.remove());
      form.addEventListener("submit", (ev) => {
        const raw = amount.value.trim();
        const units = toUnits(raw);
        const bad = (m) => { ev.preventDefault(); err.textContent = m; };
        if (mode !== "withdraw" && !/^[1-9]\d{0,11}$/.test(raw)) return bad("Whole VHP only, for example 1 or 25.");
        if (units === null || units <= 0n) return bad("Enter an amount, for example 2.5 (up to 8 decimals).");
        if (units > MAX_U64) return bad("That amount is too large.");
        if (mode !== "stake" && units > total) return bad(`That is more than your ${vhp(total)} VHP in this game.`);
        if (mode === "move" && !target.value) return bad("There is no other game to move to.");
        if (mode === "stake") {
          const koin = token.value === "KOIN";
          send(`stake ${vhp(units)} ${koin ? "KOIN" : "VHP"} in the ${o.name}`, async () => {
            const t = new lib.Contract({ id: koin ? dep.koin : dep.vhp, abi: TOKEN_ABI, provider: o.provider });
            return [await op(t, "approve", { owner: who, spender: dep.contract, value: units.toString() }),
              await op(vault, "deposit_to", { from: who, game: o.game, amount: units.toString(), koin })];
          });
        } else if (mode === "withdraw") {
          send(`withdraw ${vhp(units)} VHP from the ${o.name}`, async () => [await op(vault, "withdraw_from", { to: who, game: o.game, amount: units.toString() })]);
        } else {
          const to = Number(target.value), name = (games.find((g) => Number(g.id) === to) || {}).name || `game ${to}`;
          send(`move ${vhp(units)} VHP from the ${o.name} to ${name}`, async () => [await op(vault, "move_stake", { player: who, from_game: o.game, to_game: to, amount: units.toString() })]);
        }
      });
      d.showModal();
      amount.focus();
    }

    if (W && W.subscribe) W.subscribe(() => { if (!host.hidden) refresh().catch(() => {}); });
    load();
    return { refresh: () => (host.hidden ? Promise.resolve() : refresh()) };
  }

  root.KStake = { mount, toUnits, claimable, minStake, vhp };
})(typeof window !== "undefined" ? window : globalThis);

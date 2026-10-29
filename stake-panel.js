/* Knode Games: "Stake in this game", one panel every game page can use (owner, 2026-10-28: every game takes stakes in
 * the Knode Games Vault, v6). It shows the wallet's stake in the game, what counts this week, the game's total and the
 * minimum, and offers Stake, Withdraw, Move and the claims the vault would pay.
 *
 *   KStake.mount(hostElement, { game: 7, name: "Producer Race", provider, toast,
 *     note: "Staked players share this game's weekly bucket; free players play for the 2 + 1 VHP prize." });
 *
 * Shown once the vault is live (get_state → config.v6_rule_week_plus_one > 0), this site's contract ABI has the v6
 * calls, and the game exists in the vault. Withdraw and claims are always offered for a game that exists, active or
 * not, as the contract allows (stakes are always withdrawable); Stake and Move only while the game takes stakes and new
 * deposits aren't paused. Every transaction is signed in the player's own wallet (window.KWallet); nothing here holds a
 * key. Vault calls (the player is argument 1):
 *   deposit_to(from, game, amount, koin)   after approving the vault for exactly that amount, in the same transaction
 *   withdraw_from(to, game, amount)        any amount, at any time
 *   move_stake(player, from_game, to_game, amount)   counts in the new game from next week
 *   claim_game(player, game, week)         only offered when the vault would pay more than 0 (its claimableG rule,
 *                                          worked out exactly here)
 * Built with textContent only. */
(function (root) {
  "use strict";
  const lib = root.koilib || root.koinos || root;
  const UNIT = 100000000n, MAX_U64 = 18446744073709551615n, CAP_A = 10n * UNIT;   // CAP_A: the vault's basket-A cap
  const CLAIM_WEEKS = 52;                    // how far back claims are looked for (the vault never expires them)
  const ROOT = new URL("./", location.href);
  const T = { type: "bytes", options: { "(koinos.btype)": "ADDRESS" } };
  const TOKEN_ABI = {
    methods: {
      balance_of: { entry_point: 0x5c721497, argument: "token.balance_of_arguments", return: "token.balance_of_result", read_only: true },
      approve: { entry_point: 0x74e21680, argument: "token.approve_arguments", return: "token.approve_result", read_only: false },
    },
    koilib_types: { nested: { token: { nested: {
      balance_of_arguments: { fields: { owner: { ...T, id: 1 } } },
      balance_of_result: { fields: { value: { type: "uint64", id: 1, options: { jstype: "JS_STRING" } } } },
      approve_arguments: { fields: {
        owner: { ...T, id: 1 }, spender: { ...T, id: 2 },
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
  const u128 = (lo, hi) => (big(hi) << 64n) | big(lo);
  /** A staked winner's share of a week's bucket: the vault's rewardOfG, in exact integer arithmetic. buckets[p] is the
   *  bucket for p points (get_game's list). Exported for tests. */
  function rewardOf(gw, buckets, e) {
    const b = (buckets || [])[Number(e.points || 0)] || {}, n = big(b.players);
    if (n === 0n) return 0n;
    const aw = u128(gw.aw_lo, gw.aw_hi), bw = u128(gw.bw_lo, gw.bw_hi), stake = big(e.stake), w = big(b.sum_w);
    let r = 0n;
    if (aw > 0n) r += (big(gw.pot_a) * ((w * (stake < CAP_A ? stake : CAP_A)) / n)) / aw;
    if (bw > 0n) r += (big(gw.pot_b) * ((w * stake) / n)) / bw;
    return r;
  }
  /** What the vault would pay for a finished week now (its claimableG rule); 0n = nothing. Exported for tests. */
  function claimable(gw, buckets, e) {
    if (!gw || !gw.finalized || !e || e.claimed) return 0n;
    const place = Number(e.prize_place || 0);
    if (place === 1) return big(gw.prize_first);
    if (place === 2) return big(gw.prize_second);                 // 0 when tied 1st places share the whole prize
    if (gw.rolled_over || Number(gw.cutoff || 0) < 1 || Number(e.points || 0) < Number(gw.cutoff)) return 0n;
    return rewardOf(gw, buckets, e);
  }
  /** The minimum stake for week w (the vault's minStakeFor). Exported for tests. */
  function minStake(cfg, w) {
    const next = big(cfg.min_stake_next);
    return next > 0n && w >= Number(cfg.min_stake_next_week || 0) ? next : big(cfg.min_stake);
  }
  /** Where a wallet stands this week, by the vault's rules: "staked" earns from the bucket (this week's lowest stake at
   *  least the minimum); "free" plays for the free prize (peak below the minimum); "neither" (staked at some point this
   *  week, but withdrew below the minimum): no bucket share and no free prize. Exported for tests. */
  function standing(r, min) {
    const peak = r.entry ? big(r.entry.peak_stake) : big(r.active_stake);
    if (min <= 0n || peak < min) return "free";
    return big(r.week_stake) >= min ? "staked" : "neither";
  }

  let n = 0;
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
    const W = root.KWallet, id = `ks${++n}`;
    const status = el("p", { class: "note ks-status", role: "status" });
    const say = (m, ms) => (o.toast ? o.toast(m, ms) : (status.textContent = m));
    const body = el("div", { class: "ks-body" });
    host.hidden = true;
    host.classList.add("ks");
    host.replaceChildren(el("h2", { text: `Stake in the ${o.name}` }), o.note ? el("p", { class: "note ks-note", text: o.note }) : null, body, status);
    let dep = null, vault = null, cfg = null, cur = 0, game = null, targets = [], me = null, busy = false, gen = 0;

    async function load() {
      try {
        dep = await fetchJson(new URL("game-data/deployment.json", ROOT));
        const abi = await fetchJson(new URL("game/abi/kpred.koilib.json", ROOT));
        if (!abi.methods || !abi.methods.deposit_to || !abi.methods.get_game_player) return;      // the site is still on v5
        vault = new lib.Contract({ id: dep.contract, abi, provider: o.provider });
        cfg = (await vault.functions.get_state({})).result.config;
        if (!(Number(cfg.v6_rule_week_plus_one || 0) > 0)) return;                                // the vault isn't live
        if (!(await reloadGames())) return;                                                       // no such game
        host.hidden = false;
        await refresh();
      } catch (e) { /* not live, or the node can't be reached: the panel stays hidden */ }
    }
    async function reloadGames() {
      const list = (await vault.functions.list_games({})).result.games || [];
      game = list.find((g) => Number(g.id) === o.game) || null;
      targets = list.filter((g) => g.active && g.staked && Number(g.id) !== o.game);
      cur = Math.max(0, Math.floor((Date.now() - Number(cfg.genesis_time)) / Number(cfg.week_length)));
      return !!game;
    }
    const canStake = () => !!(game && game.active && game.staked && !cfg.paused);

    /** The finished weeks this wallet can claim, newest first: [week, amount]. */
    async function claimsOf(who) {
      const from = Math.max(Number(game.from_week || 0), cur - CLAIM_WEEKS), weeks = [];
      for (let w = cur - 1; w >= from && w >= 0; w--) weeks.push(w);
      const out = [];
      for (let i = 0; i < weeks.length; i += 8) {
        const part = weeks.slice(i, i + 8);
        const entries = await Promise.all(part.map((w) => vault.functions.get_game_player({ player: who, game: o.game, week: String(w) }).then((x) => x.result.entry)));
        for (let j = 0; j < part.length; j++) {
          const e = entries[j];
          if (!e || e.claimed || !(Number(e.points || 0) > 0 || Number(e.prize_place || 0) > 0)) continue;
          const g = (await vault.functions.get_game({ game: o.game, week: String(part[j]) })).result;
          const amt = claimable(g.week, g.buckets, e);
          if (amt > 0n) out.push([part[j], amt]);
        }
      }
      return out;
    }

    async function refresh() {
      const mine = ++gen, who = W && W.address, kind = W && W.kind;
      await reloadGames();
      const g = game, min = minStake(cfg, cur);
      const rows = [el("p", {}, "Staked in the game: ", el("b", { text: `${vhp(g.stake)} VHP` }), ` · minimum ${vhp(min)} VHP`)];
      if (!g.active || !g.staked) rows.push(el("p", { class: "note", text: "This game doesn't take new stakes now. You can still withdraw and claim at any time." }));
      else if (cfg.paused) rows.push(el("p", { class: "note", text: "New stakes are paused for now. You can still withdraw and claim at any time." }));
      let state = null;
      if (who) {
        const r = (await vault.functions.get_game_player({ player: who, game: o.game, week: String(cur) })).result || {};
        const p = r.player || {}, total = big(p.stake) + big(p.pending);
        state = { who, total, week: big(r.week_stake), stand: standing(r, min), claims: await claimsOf(who) };
      }
      if (mine !== gen || (W && W.address) !== who) return;            // a newer refresh, or another wallet, took over
      me = state;
      if (!who) rows.push(el("p", { class: "note", text: "Connect a wallet to stake in this game." }));
      else {
        const later = me.total > me.week && me.stand !== "free";
        rows.push(el("p", {}, "Your stake: ", el("b", { text: `${vhp(me.total)} VHP` }),
          ` · this week: ${vhp(me.week)} VHP`, later ? " (the rest counts from next week)" : "",
          { staked: " · Staked board", free: " · Free play board", neither: " · this week: no bucket share and no free prize (you withdrew below the minimum)" }[me.stand]));
        if (kind === "guest") {
          rows.push(el("p", { class: "note", text: "A guest wallet can't stake." + (me.claims.length ? " It has a prize to claim: back up your guest key and import it into Kondor or KOIN Vault, then claim it here." : "") }));
          if (me.claims.length) rows.push(el("p", { class: "note", text: me.claims.map(([w, a]) => `Week ${w + 1}: ${vhp(a)} VHP`).join(" · ") }));
        } else {
          rows.push(el("div", { class: "ks-actions" },
            el("button", { type: "button", class: "btn btn-primary", onclick: (ev) => ask("stake", ev.currentTarget), disabled: !canStake() }, "Stake"),
            el("button", { type: "button", class: "btn btn-ghost", onclick: (ev) => ask("withdraw", ev.currentTarget), disabled: me.total === 0n }, "Withdraw"),
            el("button", { type: "button", class: "btn btn-ghost", onclick: (ev) => ask("move", ev.currentTarget), disabled: me.total === 0n || !targets.length || cfg.paused }, "Move")));
          if (me.claims.length) rows.push(el("div", { class: "ks-actions" },
            ...me.claims.map(([w, a]) => el("button", { type: "button", class: "btn btn-tang", onclick: () => claim(w) }, `Claim week ${w + 1}: ${vhp(a)} VHP`))));
        }
      }
      body.replaceChildren(...rows);
      body.querySelectorAll("button").forEach((b) => { if (busy) b.disabled = true; });
    }

    async function send(label, who, build) {
      if (busy) { say("Already sending: wait for it to finish.", 4000); return; }
      if (!W || W.address !== who) { say("Your wallet changed: nothing was sent. Check the panel and try again.", 8000); refresh().catch(() => {}); return; }
      busy = true;
      body.querySelectorAll("button").forEach((b) => { b.disabled = true; });
      try {
        const ops = await build();
        say(`Confirm “${label}” in ${W.label()}…`, 20000);
        const txid = await W.send(label, ops, {});
        say(txid ? `Done: ${label}` : `Sent: ${label}. It may take a minute to show.`, 8000);
      } catch (e) {
        const m = String((e && e.message) || e);
        say(/reject|denied|cancel/i.test(m) ? `Cancelled in ${W.label()}.` : `Not sent: ${m.slice(0, 160)}`, 9000);
      } finally { busy = false; refresh().catch(() => {}); }
    }
    const op = async (contract, fn, args) => (await contract.functions[fn](args, { onlyOperation: true })).operation;

    function claim(w) {
      const who = me && me.who;
      send(`claim ${o.name} week ${w + 1}`, who, async () => [await op(vault, "claim_game", { player: who, game: o.game, week: String(w) })]);
    }

    /** The Stake / Withdraw / Move dialog. */
    async function ask(mode, opener) {
      if (!me || busy) return;
      const who = me.who, total = me.total, min = minStake(cfg, cur);
      const ids = { title: `${id}-t`, help: `${id}-h`, err: `${id}-e`, amount: `${id}-a`, token: `${id}-k`, target: `${id}-g` };
      const amount = el("input", { id: ids.amount, inputmode: mode === "stake" ? "numeric" : "decimal", autocomplete: "off", placeholder: mode === "stake" ? "e.g. 5" : "e.g. 2.5", "aria-describedby": `${ids.help} ${ids.err}` });
      const token = el("select", { id: ids.token }, el("option", { value: "VHP", text: "VHP" }), el("option", { value: "KOIN", text: "KOIN (burned into VHP 1:1)" }));
      const target = el("select", { id: ids.target }, ...targets.map((g) => el("option", { value: String(g.id), text: g.name || `Game ${g.id}` })));
      const err = el("p", { class: "note ks-err", id: ids.err, role: "alert" });
      const help = {
        stake: `Whole VHP only (1, 2, 3 …). It counts from next week and is held as VHP; you can withdraw at any time. Paying with KOIN needs Mana at least equal to the amount.${total < min ? ` It earns once your stake here reaches ${vhp(min)} VHP.` : ""}`,
        withdraw: `Any amount up to ${vhp(total)} VHP, at any time. It goes back to your wallet as VHP.`,
        move: `Move up to ${vhp(total)} VHP to another game. No tokens move, and it counts there from next week.`,
      }[mode];
      const go = el("button", { type: "submit", class: "btn btn-primary" }, { stake: "Stake", withdraw: "Withdraw", move: "Move" }[mode]);
      const cancel = el("button", { type: "button", class: "btn btn-ghost" }, "Cancel");
      const form = el("form", { method: "dialog" },
        el("h3", { id: ids.title, text: { stake: `Stake in the ${o.name}`, withdraw: `Withdraw from the ${o.name}`, move: `Move stake from the ${o.name}` }[mode] }),
        el("p", { class: "note", id: ids.help, text: help }),
        el("label", { for: ids.amount, text: "Amount" }), amount,
        mode === "stake" ? el("label", { for: ids.token, text: "Pay with" }) : null, mode === "stake" ? token : null,
        mode === "move" ? el("label", { for: ids.target, text: "To" }) : null, mode === "move" ? target : null,
        err, el("div", { class: "ks-actions" }, go, cancel));
      const d = el("dialog", { class: "ks-dialog", "aria-labelledby": ids.title, "aria-describedby": ids.help }, form);
      document.body.append(d);
      cancel.addEventListener("click", () => d.close());
      d.addEventListener("close", () => { d.remove(); if (opener && opener.isConnected) opener.focus(); });
      let confirmed = false;
      form.addEventListener("submit", async (ev) => {
        ev.preventDefault();
        const raw = amount.value.trim(), units = toUnits(raw);
        if (mode === "stake" && !/^[1-9]\d{0,11}$/.test(raw)) { err.textContent = "Whole VHP only, for example 1 or 25."; return; }
        if (units === null || units <= 0n) { err.textContent = "Enter an amount, for example 2.5 (up to 8 decimals)."; return; }
        if (units > MAX_U64) { err.textContent = "That amount is too large."; return; }
        if (mode !== "stake" && units > total) { err.textContent = `That is more than your ${vhp(total)} VHP in this game.`; return; }
        if (W.address !== who) { err.textContent = "Your wallet changed. Close this and try again."; return; }
        if (mode === "stake") {
          const koin = token.value === "KOIN";
          const t = new lib.Contract({ id: koin ? dep.koin : dep.vhp, abi: TOKEN_ABI, provider: o.provider });
          let have = null;
          try { have = big((await t.functions.balance_of({ owner: who })).result.value); } catch { /* the wallet will refuse if short */ }
          if (have !== null && units > have) { err.textContent = `That is more than your wallet holds (${vhp(have)} ${koin ? "KOIN" : "VHP"}).`; return; }
          d.close();
          send(`stake ${vhp(units)} ${koin ? "KOIN" : "VHP"} in the ${o.name}`, who, async () => [
            await op(t, "approve", { owner: who, spender: dep.contract, value: units.toString() }),
            await op(vault, "deposit_to", { from: who, game: o.game, amount: units.toString(), koin })]);
        } else if (mode === "withdraw") {
          // Warn once if it would cost this week: staked this week, and what's left falls under the minimum.
          if (!confirmed && me.stand === "staked" && total - units < min) {
            confirmed = true;
            err.textContent = `This leaves less than the ${vhp(min)} VHP minimum: this week you'd get no share of the ${o.name}'s bucket, and you can't win its free prize either. Press Withdraw again to go ahead.`;
            return;
          }
          d.close();
          send(`withdraw ${vhp(units)} VHP from the ${o.name}`, who, async () => [await op(vault, "withdraw_from", { to: who, game: o.game, amount: units.toString() })]);
        } else {
          if (!target.value) { err.textContent = "There is no other game to move to."; return; }
          const to = Number(target.value), name = (targets.find((g) => Number(g.id) === to) || {}).name || `game ${to}`;
          d.close();
          send(`move ${vhp(units)} VHP from the ${o.name} to ${name}`, who, async () => [await op(vault, "move_stake", { player: who, from_game: o.game, to_game: to, amount: units.toString() })]);
        }
      });
      d.showModal();
      amount.focus();
    }

    if (W && W.subscribe) W.subscribe(() => { if (!host.hidden) refresh().catch(() => {}); });
    load();
    return { refresh: () => (host.hidden ? Promise.resolve() : refresh()) };
  }

  root.KStake = { mount, toUnits, claimable, rewardOf, minStake, standing, vhp };
})(typeof window !== "undefined" ? window : globalThis);

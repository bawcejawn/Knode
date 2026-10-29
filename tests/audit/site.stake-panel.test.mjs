// The shared "stake in this game" panel (stake-panel.js, Vault v6): its own copy of the vault's ABI, the claim math
// (same rule as the vault's claimableG / rewardOfG), the operations it asks the wallet to sign, and what it shows:
// hidden until the vault is live, withdraw always offered, stake/move off when paused or the game is stopped.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import crypto from "node:crypto";

const APP = process.env.APP || ".";
const src = fs.readFileSync(`${APP}/stake-panel.js`, "utf8");
const DEP = JSON.parse(fs.readFileSync(`${APP}/game-data/deployment.json`, "utf8"));
const UNIT = 100000000n;
const ME = "1PlayerAddrXXXXXXXXXXXXXXXXXXXXXXX";

// ── a tiny DOM: enough for the panel (elements, attributes, children, listeners, a <dialog>) ──
class Node {
  constructor(tag) { this.nodeType = 1; this.tagName = tag; this.children = []; this.attrs = {}; this.on = {}; this.hidden = false; this.className = ""; this.value = ""; this.returnValue = ""; this.parent = null;
    this.classList = { add: (c) => { this.className = `${this.className} ${c}`.trim(); } }; }
  setAttribute(k, v) { this.attrs[k] = v; if (k === "hidden") this.hidden = true; if (k === "value") this.value = v; if (k === "checked") this.checked = true; }
  addEventListener(t, f) { this.on[t] = f; }
  append(...k) { for (const c of k) { assert.ok(c != null, "append(null) would show the text 'null' in a browser"); if (typeof c === "object") c.parent = this; this.children.push(c); } }
  replaceChildren(...k) { this.children = []; this.append(...k); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); }
  showModal() { this.open = true; }
  focus() {}
  get textContent() { return this.children.map((c) => (typeof c === "string" ? c : c.textContent)).join(""); }
  all() { return [this, ...this.children.filter((c) => typeof c === "object").flatMap((c) => c.all())]; }
  querySelector(sel) { const m = /input\[name="([^"]+)"\]:checked/.exec(sel); return this.all().find((n) => n.tagName === "input" && n.attrs.name === m[1] && n.checked) || null; }
}
const buttons = (root, label) => root.all().filter((n) => n.tagName === "button" && n.textContent === label);

function env({ state, game, player = null, weeks = {}, account = ME, kind = "kondor", games = [] } = {}) {
  const sent = [], ops = [], reads = [];
  class Contract {
    constructor({ id }) { this.id = id; const self = this;
      this.functions = new Proxy({}, { get: (_, m) => async (args, opt) => {
        if (opt && opt.onlyOperation) { const op = { call_contract: { contract_id: self.id }, _m: m, _a: args }; ops.push(op); return { operation: op }; }
        reads.push(m);
        if (m === "get_state") return { result: state };
        if (m === "list_games") return { result: { games } };
        if (m === "get_game") { const w = weeks[args.week]; return { result: { game, week: w && w.gw, buckets: w && w.buckets } }; }
        if (m === "get_game_player") { const w = weeks[args.week]; return { result: args.week === String(state.week) ? player || {} : { entry: w && w.e } }; }
        return { result: {} };
      } }); }
  }
  let listener = null;
  const body = new Node("body");
  const ctx = {
    document: { createElement: (t) => new Node(t), body },
    koilib: { Contract, Provider: class {} },
    KWallet: { address: account, kind, label: () => "Kondor", subscribe: (f) => { listener = f; }, connect: async () => {}, guestInfo: () => { ctx.guestInfoShown = true; },
      send: async (label, o) => { sent.push({ label, ops: o }); return "0xtx"; } },
    fetch: async () => ({ ok: true, json: async () => DEP }),
    console, BigInt, Number, String, JSON, Promise, Object, Error,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  const root = new Node("section");
  const tick = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };
  return { ctx, root, sent, ops, reads, body, tick, K: ctx.KStake, listener: () => listener };
}
const T = env({ state: {} }).K._test;
const J = (x) => JSON.parse(JSON.stringify(x));   // values made inside the vm, compared as plain data

const LIVE = (o = {}) => ({ config: { min_stake: String(UNIT), min_stake_next: "0", min_stake_next_week: "0", paused: false, v6_rule_week_plus_one: "3", ...o }, week: "5", time: "0" });
const GAME = (o = {}) => ({ id: 7, name: "Producer Race", staked: true, free_prize: true, active: true, from_week: "3", stake: String(250n * UNIT), season_weeks: 0, ...o });

test("ABI: every entry point is the first 4 bytes of sha256(name)", () => {
  for (const abi of [T.VAULT_ABI, T.TOKEN_ABI]) for (const [name, m] of Object.entries(abi.methods)) {
    const want = parseInt(crypto.createHash("sha256").update(name).digest("hex").slice(0, 8), 16);
    assert.equal(m.entry_point, want, name);
  }
});

// The repo's ABI becomes v6 when the vault-v6 branch is merged; until then point STAKE_PANEL_ABI at that branch's
// game/abi/kpred.koilib.json to run this check (it was run that way when the panel was written).
const abiPath = process.env.STAKE_PANEL_ABI || `${APP}/game/abi/kpred.koilib.json`;
const real = JSON.parse(fs.readFileSync(abiPath, "utf8"));
test("ABI: the panel's methods and field numbers match the vault's own ABI (v6)", { skip: !real.methods.deposit_to && "the repository's ABI is not v6 yet" }, () => {
  const types = real.koilib_types.nested.kpred.nested;
  for (const [name, m] of Object.entries(T.VAULT_ABI.methods)) {
    assert.equal(real.methods[name].entry_point, m.entry_point, `${name} entry point`);
    assert.equal(real.methods[name].argument, m.argument); assert.equal(real.methods[name].return, m.return);
  }
  for (const [msg, def] of Object.entries(T.VAULT_ABI.koilib_types.nested.kpred.nested)) {
    for (const [field, f] of Object.entries(def.fields)) {
      const r = types[msg] && types[msg].fields[field];
      assert.ok(r, `${msg}.${field} exists in the vault`);
      assert.equal(r.id, f.id, `${msg}.${field} number`);
      assert.equal(r.type, f.type, `${msg}.${field} type`);
      assert.equal(r.rule || "", f.rule || "", `${msg}.${field} repeated`);
    }
  }
});

test("amounts: whole stakes, up to 8 decimals for withdrawals, never above 64 bits", () => {
  assert.equal(T.toUnits("25"), 25n * UNIT);
  assert.equal(T.toUnits("2.5"), 250000000n);
  assert.equal(T.toUnits("0.00000001"), 1n);
  for (const bad of ["0", "-1", "1.123456789", "abc", "", "1e3", "999999999999"]) assert.equal(T.toUnits(bad), null, bad);
});

test("minimum stake: the next minimum applies from its first week", () => {
  const c = { min_stake: String(UNIT), min_stake_next: String(2n * UNIT), min_stake_next_week: "6" };
  assert.equal(T.minStakeFor(c, "5"), UNIT);
  assert.equal(T.minStakeFor(c, "6"), 2n * UNIT);
  assert.equal(T.minStakeFor({ min_stake: String(UNIT), min_stake_next: "0" }, "9"), UNIT);
});

test("live only once the vault's v6 rules are set", () => {
  assert.equal(T.live(LIVE()), true);
  assert.equal(T.live(LIVE({ v6_rule_week_plus_one: "0" })), false);
  assert.equal(T.live({ config: {} }), false);   // v5 answers get_state without the field
  assert.equal(T.live(null), false);
});

test("claim math: prizes, cutoff and the two baskets, as the vault computes them", () => {
  const gw = { finalized: true, cutoff: 3, pot_a: String(40n * UNIT), pot_b: String(60n * UNIT), aw_hi: "0", aw_lo: "0", bw_hi: "0", bw_lo: "0", first_n: 1, prize_first: String(2n * UNIT), prize_second: String(UNIT) };
  const buckets = []; buckets[5] = { players: 2, sum_w: "1000000" };
  // aw = sum over winners of sum_w×capped/n, bw likewise with the full stake: make this player's share easy to check.
  const e = { points: 5, stake: String(20n * UNIT), claimed: false };
  const aw = (1000000n * 10n * UNIT) / 2n * 4n, bw = (1000000n * 20n * UNIT) / 2n * 5n;
  const w = { ...gw, aw_hi: String(aw >> 64n), aw_lo: String(aw & ((1n << 64n) - 1n)), bw_hi: String(bw >> 64n), bw_lo: String(bw & ((1n << 64n) - 1n)) };
  assert.equal(T.claimable(w, e, buckets), 40n * UNIT / 4n + 60n * UNIT / 5n);   // a quarter of A (capped at 10), a fifth of B
  assert.equal(T.claimable({ ...w, finalized: false }, e, buckets), 0n);
  assert.equal(T.claimable(w, { ...e, claimed: true }, buckets), 0n);
  assert.equal(T.claimable(w, { ...e, points: 2 }, buckets), 0n);              // below the cutoff
  assert.equal(T.claimable({ ...w, rolled_over: true }, e, buckets), 0n);
  assert.equal(T.claimable(w, { prize_place: 1 }, buckets), 2n * UNIT);
  assert.equal(T.claimable(w, { prize_place: 2 }, buckets), UNIT);
  assert.equal(T.claimable({ ...w, first_n: 2 }, { prize_place: 2 }, buckets), 0n);  // 1st tied: they share all 3 VHP
  assert.equal(T.claimable(w, null, buckets), 0n);
});

test("explain: staked + free prize, staked only, season prize", () => {
  assert.match(T.explain(GAME(), UNIT), /share this game's weekly bucket; free players play for the 2 \+ 1 VHP prize/);
  assert.match(T.explain(GAME({ season_weeks: 2 }), UNIT), /4 \+ 2 VHP season prize/);
  assert.doesNotMatch(T.explain(GAME({ free_prize: false }), UNIT), /free players/);
});

test("operations: stake = approve + deposit_to in one transaction, for this game, from the player", async () => {
  const e = env({ state: LIVE() });
  const k = { lib: e.ctx.koilib, dep: DEP, provider: {} };
  let ops = await e.K._test.buildOps(k, "stake", { player: ME, game: 7, units: 25n * UNIT, koin: false });
  assert.deepEqual(J(ops.map((o) => [o.call_contract.contract_id, o._m])), [[DEP.vhp, "approve"], [DEP.contract, "deposit_to"]]);
  assert.deepEqual({ ...ops[0]._a }, { owner: ME, spender: DEP.contract, value: String(25n * UNIT) });
  assert.deepEqual({ ...ops[1]._a }, { from: ME, game: 7, amount: String(25n * UNIT), koin: false });
  ops = await e.K._test.buildOps(k, "stake", { player: ME, game: 3, units: 2n * UNIT, koin: true });
  assert.equal(ops[0].call_contract.contract_id, DEP.koin);
  assert.equal(ops[1]._a.koin, true);
  ops = await e.K._test.buildOps(k, "withdraw", { player: ME, game: 7, units: 150000000n });
  assert.deepEqual(J(ops.map((o) => [o._m, o._a])), [["withdraw_from", { to: ME, game: 7, amount: "150000000" }]]);
  ops = await e.K._test.buildOps(k, "move", { player: ME, game: 7, to: 2, units: UNIT });
  assert.deepEqual({ ...ops[0]._a }, { player: ME, from_game: 7, to_game: 2, amount: String(UNIT) });
  ops = await e.K._test.buildOps(k, "claim", { player: ME, game: 7, week: 4n });
  assert.deepEqual({ ...ops[0]._a }, { player: ME, game: 7, week: "4" });
});

test("hidden while the vault is not live (v5 today), and for the question game", async () => {
  const e = env({ state: LIVE({ v6_rule_week_plus_one: "0" }), game: GAME() });
  e.K.mount(e.root, { game: 7 });
  await e.tick();
  assert.equal(e.root.hidden, true);
  assert.equal(e.ctx.KStake.mount(new Node("div"), { game: 1 }), null);
});

test("shown when live: stake, game total, minimum, staked or free this week, and the explainer", async () => {
  const e = env({ state: LIVE(), game: GAME(), player: { player: { stake: String(3n * UNIT), pending: "0" }, week_stake: String(3n * UNIT) },
    games: [GAME({ id: 2, name: "Who Signs Block X" })] });
  e.K.mount(e.root, { game: 7 });
  await e.tick();
  assert.equal(e.root.hidden, false);
  const text = e.root.textContent;
  assert.match(text, /Your stake here3 VHP/); assert.match(text, /Game total250 VHP/); assert.match(text, /Minimum this week1 VHP/);
  assert.match(text, /You're a staked player in this game this week/);
  assert.match(text, /free players play for the 2 \+ 1 VHP prize/);
  for (const b of ["Stake", "Withdraw", "Move"]) assert.equal(buttons(e.root, b).length, 1, b);
});

test("a wallet staked in another game but not this one is a free player here", async () => {
  const e = env({ state: LIVE(), game: GAME(), player: { player: { stake: "0", pending: "0" }, week_stake: "0" } });
  e.K.mount(e.root, { game: 7 });
  await e.tick();
  assert.match(e.root.textContent, /You're a free player in this game this week/);
  assert.equal(buttons(e.root, "Withdraw").length, 0);
});

test("withdraw is always offered with a stake: paused deposits and a stopped game hide only Stake and Move", async () => {
  for (const [state, game] of [[LIVE({ paused: true }), GAME()], [LIVE(), GAME({ active: false })]]) {
    const e = env({ state, game, player: { player: { stake: String(UNIT), pending: "0" }, week_stake: String(UNIT) }, games: [GAME({ id: 2 })] });
    e.K.mount(e.root, { game: 7 });
    await e.tick();
    assert.equal(buttons(e.root, "Withdraw").length, 1);
    assert.equal(buttons(e.root, "Stake").length, 0);
    assert.equal(buttons(e.root, "Move").length, 0);
  }
});

test("finished weeks with something to claim get a Claim button that sends claim_game for that week", async () => {
  const gw = { finalized: true, cutoff: 1, first_n: 1, prize_first: String(2n * UNIT), prize_second: String(UNIT) };
  const e = env({ state: LIVE(), game: GAME(), player: { player: { stake: "0", pending: "0" }, week_stake: "0" },
    weeks: { 4: { gw, e: { prize_place: 1 } }, 3: { gw, e: { prize_place: 1, claimed: true } } } });
  e.K.mount(e.root, { game: 7 });
  await e.tick();
  assert.match(e.root.textContent, /Week 4: 2 VHP/);
  assert.doesNotMatch(e.root.textContent, /Week 3:/);
  await buttons(e.root, "Claim")[0].on.click();
  await e.tick();
  assert.equal(e.sent.length, 1);
  assert.deepEqual(J(e.sent[0].ops.map((o) => [o._m, o._a])), [["claim_game", { player: ME, game: 7, week: "4" }]]);
});

test("claims: weeks before a restart (from_week moved forward) and up to 52 weeks back are still offered", async () => {
  const gw = { finalized: true, cutoff: 1, first_n: 1, prize_first: String(2n * UNIT), prize_second: String(UNIT) };
  // Now week 60; the Race was restarted and earns from week 50. Week 12 (before the restart) and week 9 (51 weeks
  // back) still pay; week 7 (53 weeks back) is beyond the window.
  const e = env({ state: { ...LIVE(), week: "60" }, game: GAME({ from_week: "50" }), player: { player: { stake: "0", pending: "0" }, week_stake: "0" },
    weeks: { 12: { gw, e: { prize_place: 1 } }, 9: { gw, e: { prize_place: 1 } }, 7: { gw, e: { prize_place: 1 } } } });
  e.K.mount(e.root, { game: 7 });
  await e.tick();
  assert.match(e.root.textContent, /Week 12: 2 VHP/);
  assert.match(e.root.textContent, /Week 9: 2 VHP/);
  assert.doesNotMatch(e.root.textContent, /Week 7:/);
  // Results are read only for weeks with something in the player's entry, not for all 52.
  assert.equal(e.reads.filter((m) => m === "get_game").length, 1 + 2, "the current week, then weeks 12 and 9 only");
});

test("stake dialog: whole numbers only; a valid stake sends approve + deposit_to", async () => {
  const e = env({ state: LIVE(), game: GAME(), player: { player: { stake: "0", pending: "0" }, week_stake: "0" } });
  e.K.mount(e.root, { game: 7 });
  await e.tick();
  const open = async (amount) => {
    buttons(e.root, "Stake")[0].on.click();
    const d = e.body.children.at(-1);
    d.all().find((n) => n.tagName === "input" && !n.attrs.type).value = amount;
    d.returnValue = "go"; await d.on.close(); await e.tick();
  };
  await open("2.5");
  assert.equal(e.sent.length, 0);
  assert.match(e.root.textContent, /whole numbers only/);
  await open("2");
  assert.equal(e.sent.length, 1);
  assert.deepEqual(J(e.sent[0].ops.map((o) => o._m)), ["approve", "deposit_to"]);
});

test("a guest can't stake: the wallet's guest explanation shows instead", async () => {
  const e = env({ state: LIVE(), game: GAME(), kind: "guest", player: { player: { stake: "0", pending: "0" }, week_stake: "0" } });
  e.K.mount(e.root, { game: 7 });
  await e.tick();
  buttons(e.root, "Stake")[0].on.click();
  assert.equal(e.ctx.guestInfoShown, true);
  assert.equal(e.sent.length, 0);
});

test("the panel sends only through the wallet, and only vault and token operations it builds itself", () => {
  const sends = [...src.matchAll(/\.send\(/g)];
  assert.equal(sends.length, 1, "one send");
  assert.match(src, /const id = await W\.send\(label, ops\);/);
  assert.doesNotMatch(src, /signTransaction|sendTransaction|privateKey|wif|innerHTML|outerHTML|insertAdjacentHTML|eval\(|new Function|localStorage|sessionStorage/i);
  assert.match(src, /new k\.lib\.Contract\(\{ id: k\.dep\.contract, abi: VAULT_ABI/, "the vault address comes from game-data/deployment.json");
});

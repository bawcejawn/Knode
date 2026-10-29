// Red team (web attacker) for Knode @ 6b37c46: what the swap page asks the wallet to sign vs what it shows.
// Runs the real site/swap.js in a vm with a stub DOM, a stub koilib (records operations) and a stub KWallet.
// All "(blocked)": they pass today and guard the defence.
//  - approve is for exactly the swapped amount, spender = the desk from deployment.json, owner = the connected account
//  - min_koin_out = the KOIN shown (amount - fee rounded up exactly like the contract), so an owner fee raise
//    or a stale quote makes the swap revert instead of paying less
//  - ?demo never builds or sends a real transaction
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const APP = process.env.APP || ".";
const src = fs.readFileSync(`${APP}/swap.js`, "utf8");
const DEP = JSON.parse(fs.readFileSync(`${APP}/desk-data/deployment.json`, "utf8"));
const UNIT = 100000000n;

function run({ search = "", feeBps = 300, account = "1SwapperAddrXXXXXXXXXXXXXXXXXXXXX", vhp = 1000n * UNIT } = {}) {
  const els = new Map(), sent = [], toasts = [];
  const elem = (id) => {
    if (!els.has(id)) els.set(id, { id, value: "", textContent: "", hidden: false, disabled: false, on: {}, classList: { toggle() {} },
      addEventListener(t, f) { this.on[t] = f; }, replaceChildren() {}, append() {}, setAttribute() {} });
    return els.get(id);
  };
  const ops = [];
  class Contract {
    constructor({ id }) { this.id = id; const self = this;
      this.functions = new Proxy({}, { get: (_, m) => async (args, opt) => {
        if (opt && opt.onlyOperation) { const op = { call_contract: { contract_id: self.id, entry_point: 1, args: "" }, _m: m, _a: args }; ops.push(op); return { operation: op }; }
        if (m === "get_state") return { result: { config: { fee_bps: feeBps, min_swap: String(UNIT), max_swap: "0", paused: false }, totals: {}, available: String(100000n * UNIT), max_vhp_in: String(100000n * UNIT) } };
        if (m === "get_recent") return { result: { swaps: [] } };
        if (m === "balance_of") return { result: { value: String(vhp) } };
        return { result: {} };
      } }); }
  }
  let onChange = null;
  const ctx = {
    location: { pathname: "/Knode/site/swap.html", search },
    document: { querySelector: (s) => elem(s.replace(/^#/, "")), createElement: () => elem(Math.random()) },
    koilib: { Contract, Provider: class {} },
    KWallet: { init(o) { onChange = o.onChange; }, connect: async () => { await onChange(account); }, label: () => "Kondor", send: async (label, o) => { sent.push({ label, ops: o }); return "0xtx"; }, disconnect() {} },
    fetch: async () => ({ ok: true, json: async () => DEP }),
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, console, BigInt, Number, String, Date, JSON, Promise, Object,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  const tick = () => new Promise((r) => setImmediate(r));
  return { ctx, els, elem, sent, ops, tick };
}

async function swap(env, amountText) {
  for (let i = 0; i < 5; i++) await env.tick();
  await env.elem("connect").on.click();
  for (let i = 0; i < 5; i++) await env.tick();
  env.elem("amount").value = amountText;
  await env.elem("swap-form").on.submit({ preventDefault() {} });
  for (let i = 0; i < 5; i++) await env.tick();
}

test("(blocked) swap signs approve(exact amount, desk) + swap(min_koin_out = shown KOIN)", async () => {
  const env = run();
  await swap(env, "12.345678912"); // 9 decimals: rejected by toUnits
  assert.equal(env.sent.length, 0, "an amount with more than 8 decimals is refused, not rounded");
  env.elem("amount").value = "12.3456789";
  env.elem("amount").on.input();
  const shown = env.elem("out").textContent;
  await env.elem("swap-form").on.submit({ preventDefault() {} });
  for (let i = 0; i < 5; i++) await env.tick();
  assert.equal(env.sent.length, 1);
  const [ap, sw] = env.sent[0].ops;
  const units = 1234567890n, fee = (units * 300n + 9999n) / 10000n;
  assert.equal(ap._m, "approve"); assert.equal(ap.call_contract.contract_id, DEP.vhp);
  assert.deepEqual({ ...ap._a }, { owner: "1SwapperAddrXXXXXXXXXXXXXXXXXXXXX", spender: DEP.contract, value: units.toString() });
  assert.equal(sw._m, "swap"); assert.equal(sw.call_contract.contract_id, DEP.contract);
  assert.equal(sw._a.vhp_amount, units.toString());
  assert.equal(sw._a.min_koin_out, (units - fee).toString());
  assert.equal(shown, "11.97530853", "the 'You receive' figure shown before signing == min_koin_out");
  assert.match(env.sent[0].label, /12\.3456789 VHP for 11.97530853 KOIN/);
});

test("(blocked) ?demo never reaches the wallet", async () => {
  const env = run({ search: "?demo" });
  await swap(env, "5");
  assert.equal(env.sent.length, 0);
  assert.equal(env.ops.length, 0);
  assert.equal(env.elem("demo-note").hidden, false, "the preview banner is shown");
});

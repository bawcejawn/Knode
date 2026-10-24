// v5 rewards on the website must equal the contract's (Kpred.rewardOf): basket A 40% by rank × stake up to 10 VHP,
// basket B 60% by rank × full stake, every step rounded down like the contract's 128-bit muldiv.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { webcrypto } from "node:crypto";

const APP = process.env.APP || ".";
const src = fs.readFileSync(`${APP}/site/app.js`, "utf8");
const END = /\r?\n  start\(\);\r?\n\}\)\(\);\s*$/;
assert.match(src, END, "site/app.js ends with start(); })();");
const patched = src.replace(END, "\n  globalThis.__T = { S, exactReward, score, applyPots };\n})();\n");

// ── fake DOM ──
function mk(tag) {
  let text = "";
  const e = {
    tag, nodeType: 1, attrs: {}, on: {}, children: [], hidden: false, style: {}, dataset: {}, value: "", className: "",
    setAttribute(k, v) { this.attrs[k] = String(v); }, removeAttribute(k) { delete this.attrs[k]; }, getAttribute(k) { return this.attrs[k] ?? null; },
    addEventListener(t, f) { this.on[t] = f; }, append(...k) { this.children.push(...k); }, replaceChildren(...k) { this.children = k; text = ""; },
    remove() {}, focus() {}, showModal() {}, querySelector: () => mk("div"), querySelectorAll: () => [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  };
  Object.defineProperty(e, "textContent", { get: () => text + e.children.map(textOf).join(""), set: (v) => { text = String(v); e.children = []; } });
  Object.defineProperty(e, "nextElementSibling", { get: () => mk("span") });
  return e;
}
const textOf = (n) => (n == null ? "" : typeof n === "string" ? n : n.textContent);
const walk = (n, out = []) => { if (n && typeof n === "object") { out.push(n); for (const c of n.children || []) walk(c, out); } return out; };
const optButtons = (card) => walk(card).filter((n) => n.tag === "button" && /\bopt\b/.test(n.className));
const byClass = (root, cls) => walk(root).filter((n) => typeof n.className === "string" && n.className.split(/\s+/).includes(cls));

function harness() {
  const els = new Map();
  const files = new Map();             // "./game-data/<path>" -> JSON text
  const chain = new Map();             // question id -> { params_hash, outcome } ; null = read fails
  const store = new Map();
  const ctx = {
    document: {
      querySelector: (s) => { if (!els.has(s)) els.set(s, mk("div")); return els.get(s); },
      querySelectorAll: () => [], createElement: mk, getElementById: () => null, head: mk("head"), body: mk("body"),
    },
    location: { pathname: "/", search: "", hash: "", href: "https://knode.test/" },
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    crypto: webcrypto, TextEncoder, Uint8Array,
    fetch: async (url) => {
      const t = files.get(String(url));
      if (t === undefined) return { ok: false, status: 404, json: async () => { throw new Error("404"); } };
      return { ok: true, status: 200, json: async () => JSON.parse(t) };
    },
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
  };
  ctx.window = ctx; ctx.addEventListener = () => {}; ctx.scrollTo = () => {};
  vm.createContext(ctx);
  vm.runInContext(patched, ctx);
  return ctx.__T;
}

const U = 100000000n;
const isqrt = (n) => { if (n < 2n) return n; let x = n, y = n / 2n + 1n; while (y < x) { x = y; y = (x + n / x) / 2n; } return x; };
const rw = (r) => isqrt(10n ** 18n / BigInt(r));
const cap = (s) => (s < 10n * U ? s : 10n * U);

/** The contract's arithmetic, written out independently: one score group per entry of `groups`. */
function contract(groups, potA, potB) {
  let rank = 1, sumW = 0n, aw = 0n, bw = 0n;
  const per = [];
  for (const g of groups) {
    let gw = 0n;
    for (let i = 0; i < g.length; i++) gw += rw(rank++);
    const n = BigInt(g.length);
    sumW += gw;
    aw += (gw * g.reduce((a, s) => a + cap(s), 0n)) / n;
    bw += (gw * g.reduce((a, s) => a + s, 0n)) / n;
    per.push({ gw, n, stakes: g });
  }
  const out = [];
  for (const p of per) for (const s of p.stakes) out.push((potA * ((p.gw * cap(s)) / p.n)) / aw + (potB * ((p.gw * s) / p.n)) / bw);
  return { out, sumW, aw, bw, per };
}

test("exactReward for a v5 week equals the contract's claim, for every winner", () => {
  const T = harness();
  const groups = [[1n * U], [1000n * U, 10n * U], [3n * U]];
  const potA = 380n * U, potB = 570n * U;
  const c = contract(groups, potA, potB);
  const W = { reward_rule: true, pot_a: String(potA), pot_b: String(potB), sum_w: String(c.sumW),
    aw_hi: String(c.aw >> 64n), aw_lo: String(c.aw & ((1n << 64n) - 1n)), bw_hi: String(c.bw >> 64n), bw_lo: String(c.bw & ((1n << 64n) - 1n)) };
  let i = 0;
  for (const p of c.per) for (const s of p.stakes) {
    const got = T.exactReward(W, { players: String(p.n), sum_w: String(p.gw) }, { stake: String(s) });
    assert.equal(got, c.out[i++]);
  }
});

test("the live leaderboard's v5 estimate (score + applyPots) pays the same as a claim would", () => {
  const T = harness();
  T.S.st = { config: { reward_rule_week_plus_one: "1", min_stake: String(U) } };
  // three players, all eligible, with 3, 2 and 2 points (30% of 3 = 1 place, the tie at 2 is below the line)
  const rows = [
    { address: "a", stake: 1000n * U, answers: [{ question_id: 1, option: 0 }, { question_id: 2, option: 0 }, { question_id: 3, option: 0 }], voided: false },
    { address: "b", stake: 5n * U, answers: [{ question_id: 1, option: 0 }, { question_id: 2, option: 0 }, { question_id: 3, option: 1 }], voided: false },
    { address: "c", stake: 1n * U, answers: [{ question_id: 1, option: 0 }, { question_id: 2, option: 0 }, { question_id: 3, option: 1 }], voided: false },
  ];
  const outcomes = new Map([[1, 1], [2, 1], [3, 1]]);
  const board = T.score(rows, outcomes, 0);
  T.applyPots(board, 400n * U, 600n * U, true);
  const a = board.scored.find((s) => s.address === "a");
  assert.equal(a.winner, true);
  assert.equal(a.reward, contract([[1000n * U]], 400n * U, 600n * U).out[0]);
});

test("splitting 10 VHP into ten 1-VHP wallets earns nothing more (v5)", () => {
  const potA = 400n * U, potB = 600n * U;
  const rivals = Array.from({ length: 5 }, () => 5n * U);
  const one = contract([[10n * U, ...rivals]], potA, potB).out[0];
  const ten = contract([[...Array(10).fill(1n * U), ...rivals]], potA, potB).out.slice(0, 10).reduce((a, x) => a + x, 0n);
  assert.ok(ten <= one + 10n, `split ${ten} vs one ${one}`);
});

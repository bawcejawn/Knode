import { fileURLToPath } from "node:url";
// V-P harness: runs COPIES of survivor-math.js and survivor.js (verbatim, except FIRST_DAY set as at launch) in a
// vm with a tiny DOM and stubbed chain/wallet. No network, no repo imports.
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
// The real page files at the repo root (APP), read in place.
const HERE = path.resolve(process.env.APP || path.join(path.dirname(fileURLToPath(import.meta.url)), "../.."));

class El {
  constructor(tag) { this.tagName = String(tag).toUpperCase(); this.children = []; this._text = ""; this.attrs = {}; this.hidden = false; this.listeners = {}; this.dataset = {}; this.disabled = false; this.selected = false; this.id = ""; }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text + this.children.map((c) => (typeof c === "string" ? c : c.textContent)).join(""); }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k.startsWith("data-")) this.dataset[k.slice(5)] = String(v); if (k === "id") this.id = v; }
  getAttribute(k) { return this.attrs[k]; }
  addEventListener(k, f) { (this.listeners[k] ||= []).push(f); }
  append(...k) { for (const c of k) this.children.push(c); }
  replaceChildren(...k) { this.children = k.filter((c) => c != null); this._text = ""; }
  contains(x) { return x === this || this.children.some((c) => c instanceof El && c.contains(x)); }
  get childElementCount() { return this.children.length; }
  querySelector(sel) { const all = this.all(); if (sel === "button") return all.find((e) => e.tagName === "BUTTON") || null; if (sel === ".pk-spin") return all.find((e) => (e.attrs.class || "").includes("pk-spin")) || null; return null; }
  all() { const out = []; for (const c of this.children) if (c instanceof El) { out.push(c, ...c.all()); } return out; }
  focus() {}
  get value() { if (this.tagName === "SELECT") { const o = this.children.find((c) => c.selected); return o ? o.attrs.value : (this.children[0] ? this.children[0].attrs.value : ""); } return this.attrs.value; }
}

export function makePage({ firstDay, now, picks = {}, season = null, fields = null, head = () => now(), address = "1" + "W".repeat(33), headFail = () => false }) {
  const ids = {};
  for (const id of ["days", "status", "picks-left", "season-line", "picks-soon", "picks-who", "today-title", "today-sub", "today-rows", "standings-box", "standings-title", "standings-sub", "board-free", "board-staked", "board-note", "prizes", "stake-panel", "standings-rows", "me-line", "field-title", "field-sub", "field-rows"]) { ids[id] = new El("div"); ids[id].id = id; }
  const document = { getElementById: (id) => ids[id] || null, createElement: (t) => new El(t), querySelectorAll: () => [], addEventListener() {}, activeElement: null, body: new El("body"), hidden: false };
  const realNow = Date.now;
  const DateX = class extends Date { constructor(...a) { if (a.length) super(...a); else super(now()); } static now() { return now(); } };
  const files = {
    "https://knodegames.com/picks-data/deployment.json": { contract: "1" + "P".repeat(33) },
    "https://knodegames.com/game-data/deployment.json": { chainId: "EiBZK_GGVP0H_fXVAM3j6EAuz3-B-l3ejxRSewi7qIBfSA==", payer: "sponsor", sponsor: null },
    "https://knodegames.com/picks/abi/picks.koilib.json": {},
    "https://raw.githubusercontent.com/bawcejawn/Knode/games-data/survivor/fields.json": fields,
  };
  if (season) files[`https://raw.githubusercontent.com/bawcejawn/Knode/games-data/survivor/S${String(season.season).padStart(3, "0")}.json`] = season;
  const sent = [], intervals = [];
  const W = { address, kind: "kondor", init() {}, subscribe() {}, label: () => "Kondor", send: async (label, ops) => { sent.push({ label, ops }); return "0xabc"; } };
  class Contract {
    constructor(o) { this.id = o.id; const self = this; this.functions = {
      get_pick: async ({ round }) => ({ result: picks[round] ? { pick: { producers: [picks[round]], changes: 0 } } : {} }),
      get_usage: async () => ({ result: { picks_today: 0, max_picks_per_day: 20 } }),
      pick: async (args) => ({ operation: { call_contract: { contract_id: self.id, entry_point: 2363702380, args: JSON.stringify(args) } } }),
    }; }
  }
  class Provider { constructor() {} async getHeadInfo() { if (headFail()) throw new Error("down"); return { head_block_time: String(head()) }; } }
  const win = {};
  const ctx = {
    window: win, document, Date: DateX, Math, JSON, Number, String, Array, Object, Map, Set, Promise, URL, Error, RegExp, console,
    location: { href: "https://knodegames.com/survivor.html" },
    fetch: async (u) => { const k = String(u); const v = files[k]; return v == null ? { ok: false, status: 404, json: async () => null } : { ok: true, json: async () => JSON.parse(JSON.stringify(v)) }; },
    setInterval: (f, ms) => { intervals.push([f, ms]); return 0; }, setTimeout: (f) => { f(); return 0; },
  };
  win.window = win; win.document = document; win.koilib = { Provider, Contract }; win.KWallet = W;
  win.KBlocks = { ensure: async () => ({ B: { ts: [], sig: [], signers: [] } }) };
  Object.assign(ctx, { KBlocks: win.KBlocks });
  vm.createContext(ctx);
  // survivor-math.js copy: FIRST_DAY set, as the owner does at launch (the only edit).
  let math = fs.readFileSync(path.join(HERE, "survivor-math.js"), "utf8");
  if (firstDay !== null) math = math.replace("const MAINNET = { day: MAINNET_DAY, firstDay: null, outFloor: 0 };", `const MAINNET = { day: MAINNET_DAY, firstDay: ${firstDay}, outFloor: 0 };`);
  vm.runInContext(math, ctx);
  ctx.window.KSurvivor = ctx.KSurvivor || win.KSurvivor;
  vm.runInContext(fs.readFileSync(path.join(HERE, "survivor.js"), "utf8"), ctx);
  return { ids, sent, tick: async (ms) => { for (const [f, m] of intervals) if (m === ms) f(); for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r)); }, ctx, W, S: win.KSurvivor, flush: async () => { for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r)); } };
}
export const rowsText = (ids) => ids.days.children.map((r) => r.textContent);

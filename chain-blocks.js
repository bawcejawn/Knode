/* Shared recent-block loader for the read-only pages (race.html, pulse.html).
 * It keeps who signed each block, when, and how many transactions it carried, for up to the last ~2.3 days.
 *   1. The bot publishes the last two days of blocks every hour (branch blocks-data). That file is used only after
 *      8 random blocks in it match the chain exactly (same check as the producer lookup).
 *   2. Newer blocks are read straight from the chain; the newest 60 are always re-read (they can still change).
 *   3. What it has is kept in this browser (localStorage), so a second visit only reads the new blocks.
 * Usage: const B = await KBlocks.ensure(provider, { blocks: 30000, onStatus }); then B.sig / B.ts / B.ntx / B.signers,
 * where B.sig[i] is an index into B.signers for block height B.from + i. Read only: nothing here signs or sends. */
(() => {
  "use strict";
  const SNAPSHOT = "https://raw.githubusercontent.com/bawcejawn/Knode/blocks-data/recent-blocks.json";
  const STORE = "kb-blocks-v1", MAX_BLOCKS = 66000, REORG = 60, WORKERS = 4;
  const isAddr = (a) => typeof a === "string" && /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let B = null;                // { from, top, signers, sig, ts, ntx }
  const sIdx = new Map();

  function load() {
    try {
      const r = JSON.parse(localStorage.getItem(STORE) || "null");
      if (!r || !Array.isArray(r.sig) || r.sig.length !== r.dts.length || r.sig.length !== r.ntx.length || !r.signers.every(isAddr)) return null;
      if (!r.sig.every((i) => Number.isInteger(i) && i >= 0 && i < r.signers.length)) return null;
      const ts = new Array(r.dts.length); let t = r.t0;
      for (let i = 0; i < ts.length; i++) { t += r.dts[i]; ts[i] = t; }
      return { from: r.from, top: r.from + r.sig.length - 1, signers: r.signers, sig: r.sig, ts, ntx: r.ntx };
    } catch { return null; }
  }
  function save() {
    try {
      const dts = new Array(B.ts.length); let prev = B.ts[0];
      for (let i = 0; i < B.ts.length; i++) { dts[i] = B.ts[i] - prev; prev = B.ts[i]; }
      localStorage.setItem(STORE, JSON.stringify({ from: B.from, signers: B.signers, sig: B.sig, t0: B.ts[0], dts, ntx: B.ntx }));
    } catch { /* storage full or blocked: it still works, it just reads again next time */ }
  }
  const signerIndex = (a) => { let i = sIdx.get(a); if (i === undefined) { i = B.signers.length; B.signers.push(a); sIdx.set(a, i); } return i; };

  /** Read blocks a..b (several requests at once; a request that fails is split, then retried). */
  async function readRange(provider, a, b, headId, onStatus) {
    const n = b - a + 1, signers = new Array(n), ts = new Array(n), ntx = new Array(n);
    const queue = []; for (let e = b; e >= a; e -= 200) queue.push([Math.max(a, e - 199), e]);
    let done = 0;
    const worker = async () => {
      while (queue.length) {
        const [s, e] = queue.shift();
        let res = null;
        for (let tries = 0; ; tries++) {
          try { res = await provider.call("block_store.get_blocks_by_height", { head_block_id: headId, ancestor_start_height: String(s), num_blocks: e - s + 1, return_block: true, return_receipt: false }); break; }
          catch (err) {
            if (e - s >= 50) { const m = Math.floor((s + e) / 2); queue.push([s, m], [m + 1, e]); break; }
            if (tries >= 4) throw err;
            await sleep(700 * (tries + 1));
          }
        }
        if (!res) continue;
        let got = 0;
        for (const it of res.block_items || []) {
          const i = Number(it.block_height) - a;
          if (i < 0 || i >= n || signers[i] !== undefined || !isAddr(it.block.header.signer)) continue;
          signers[i] = it.block.header.signer; ts[i] = Number(it.block.header.timestamp); ntx[i] = (it.block.transactions || []).length; got++;
        }
        if (got === 0) throw new Error(`no blocks returned at ${s}`);
        let k = s; while (k <= e && signers[k - a] !== undefined) k++;
        if (k <= e) queue.push([k, e]);
        done += got; onStatus && onStatus(`Reading blocks: ${done.toLocaleString()} of ${n.toLocaleString()}…`, done / n);
      }
    };
    await Promise.all(Array.from({ length: WORKERS }, worker));
    return { signers, ts, ntx };
  }

  async function snapshot(provider, needFrom, top, headId, onStatus) {
    try {
      onStatus && onStatus("Loading recent blocks…", null);
      const r = await (await fetch(SNAPSHOT, { cache: "no-cache" })).json();
      const n = r && Array.isArray(r.sig) ? r.sig.length : 0;
      if (!n || r.v !== 1 || r.dts.length !== n || r.ntx.length !== n || r.top !== r.from + n - 1 || r.from > needFrom || r.top > top) return null;
      if (!r.signers.every(isAddr) || !r.sig.every((i) => Number.isInteger(i) && i >= 0 && i < r.signers.length)) return null;
      if (!r.ntx.every((x) => Number.isInteger(x) && x >= 0)) return null;
      const ts = new Array(n); let t = r.t0;
      for (let i = 0; i < n; i++) { t += r.dts[i]; ts[i] = t; }
      // Spot-check 8 random blocks (older than the newest 60) against the chain: signer and timestamp must match.
      const picks = Array.from({ length: 8 }, () => r.from + Math.floor(Math.random() * Math.max(1, n - REORG)));
      const ok = await Promise.all(picks.map(async (h) => {
        const res = await provider.call("block_store.get_blocks_by_height", { head_block_id: headId, ancestor_start_height: String(h), num_blocks: 1, return_block: true, return_receipt: false });
        const it = (res.block_items || [])[0];
        return it && Number(it.block_height) === h && it.block.header.signer === r.signers[r.sig[h - r.from]] && Number(it.block.header.timestamp) === ts[h - r.from];
      }));
      if (!ok.every(Boolean)) return null;
      return { from: r.from, top: r.top, signers: r.signers.slice(), sig: r.sig.slice(), ts, ntx: r.ntx.slice() };
    } catch { return null; }
  }

  let running = null;
  /** Make sure the last `blocks` blocks up to the head are here. Resolves to { B, head }. One run at a time. */
  function ensure(provider, opts = {}) {
    if (!running) running = run(provider, opts).finally(() => { running = null; });
    return running;
  }
  async function run(provider, { blocks = 30000, onStatus } = {}) {
    const head = await provider.getHeadInfo();
    const top = Number(head.head_topology.height), headId = head.head_topology.id;
    const needFrom = Math.max(1, top - Math.min(blocks, MAX_BLOCKS) + 1);
    if (!B) B = load();
    if (!B || B.from > needFrom || B.top < top - 1200 || B.top > top) {
      const snap = await snapshot(provider, needFrom, top, headId, onStatus);
      if (snap && (!B || B.top > top || snap.top > B.top || snap.from < B.from)) B = snap;
    }
    sIdx.clear(); if (B) B.signers.forEach((a, i) => sIdx.set(a, i));
    if (!B || B.top < needFrom - 1 || B.top > top || B.sig.length === 0) { B = { from: top + 1, top, signers: [], sig: [], ts: [], ntx: [] }; sIdx.clear(); }
    else { const keep = Math.max(0, B.sig.length - REORG); B.sig.length = keep; B.ts.length = keep; B.ntx.length = keep; B.top = B.from + keep - 1; }
    if (B.top < top) {
      const a = B.sig.length ? B.top + 1 : needFrom, r = await readRange(provider, a, top, headId, onStatus);
      if (B.sig.length === 0) B.from = a;
      for (let i = 0; i < r.signers.length; i++) { B.sig.push(signerIndex(r.signers[i])); B.ts.push(r.ts[i]); B.ntx.push(r.ntx[i]); }
      B.top = top;
    }
    if (needFrom < B.from) {
      const r = await readRange(provider, needFrom, B.from - 1, headId, onStatus);
      B.sig = r.signers.map(signerIndex).concat(B.sig); B.ts = r.ts.concat(B.ts); B.ntx = r.ntx.concat(B.ntx); B.from = needFrom;
    }
    const cut = B.sig.length - MAX_BLOCKS;
    if (cut > 0) { B.sig.splice(0, cut); B.ts.splice(0, cut); B.ntx.splice(0, cut); B.from += cut; }
    save();
    onStatus && onStatus("", null);
    return { B, head };
  }

  window.KBlocks = { ensure, isAddr };
})();

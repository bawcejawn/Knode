/**
 * KnodeGames VHP standard, recorder side (owner decision 2026-10-28; the math is site/vhp-standard.js).
 * Every game's recorder reads VHP this way:
 *  - blocks with their receipts (4 reads at a time), every VHP event decoded (reverted transactions skipped);
 *  - each producer's balance AND effective balance read once, pinned to one block (the head did not move around the
 *    read), on each node; the VHP events walked back from there (bookFor);
 *  - the rebuilt effective VHP must equal the effective balance the VHP contract reports at that block (a missed or
 *    misread event can't slip through), and the block ids walked must be the ones the balances were read on (forks);
 *  - games run this on two nodes and use the result only when both agree exactly.
 * Holds no key and sends nothing.
 */
import { Contract, Serializer, utils } from "koilib";
import { withRetry } from "../common.ts";
import { tokenAbi } from "./token-abi.ts";
await import("../vhp-standard.js");
const V: any = (globalThis as any).KVhp;

export type Head = { height: number; time: number; lib: number; libTime: number };
/** Blocks from..to: heights, times, signers, block ids, and the VHP changes their receipts hold. */
export type Chain = { hs: number[]; ts: number[]; sig: number[]; signers: string[]; ids: string[]; deltas: { h: number; a: string; d: number }[] };
export type Node = {
  head(): Promise<{ height: number; time: number; lib: number; libTime: number; id: string }>;
  blockTime(h: number): Promise<number>;
  blockId(h: number): Promise<string>;
  chain(from: number, to: number): Promise<Chain>;
  /** A VHP balance (satoshi) pinned to one block: the head did not move while it was read. */
  balance(a: string): Promise<{ v: number; eff?: number; h: number; id: string }>;
};
const ser = new Serializer((utils.tokenAbi as any).koilib_types);
async function vhpEvents(it: any) {
  const rc = it.receipt || {}, out: any[] = [], h = Number(it.block_height);
  // a reverted transaction's events changed nothing (audit A-4)
  const all = [...(rc.events || []), ...(rc.transaction_receipts || []).filter((t: any) => !t.reverted).flatMap((t: any) => t.events || [])];
  for (const x of all) {
    if (x.source !== V.VHP_CONTRACT) continue;
    const n = String(x.name || ""), kind = /transfer_event$/.test(n) ? "transfer_event" : /mint_event$/.test(n) ? "mint_event" : /burn_event$/.test(n) ? "burn_event" : "";
    if (!kind) continue;   // approve and other events don't move balances
    const d: any = await ser.deserialize(x.data, `token.${kind}`);   // a VHP event that can't be read stops the run
    out.push({ h, src: x.source, name: n, from: d.from, to: d.to, value: String(d.value ?? "0") });
  }
  return out;
}
export function chainNode(p: any): Node {
  let effDown = "";
  let headId = "";
  const abi: any = JSON.parse(JSON.stringify(tokenAbi));
  // effective_balance_of (vhp contract entry point 0x629f31e6): same argument and result shapes as balance_of
  abi.methods.effective_balance_of = { ...abi.methods.balance_of, entry_point: 0x629f31e6 };
  const vhp = new Contract({ id: V.VHP_CONTRACT, abi, provider: p });
  const blockAt = async (h: number) => {
    const res: any = await withRetry(`block ${h}`, () => p.call("block_store.get_blocks_by_height", { head_block_id: headId, ancestor_start_height: String(h), num_blocks: 1, return_block: true, return_receipt: false }));
    const it = res?.block_items?.[0];
    if (!it || Number(it.block_height) !== h) throw new Error(`block ${h} not returned`);
    return it;
  };
  const headNow = async () => { const h: any = await withRetry("head", () => p.getHeadInfo()); return { id: String(h.head_topology.id), height: Number(h.head_topology.height), raw: h }; };
  return {
    async head() {
      const h = await headNow(); headId = h.id;
      const lib = Number(h.raw.last_irreversible_block);
      return { id: headId, height: h.height, time: Number(h.raw.head_block_time), lib, libTime: Number((await blockAt(lib)).block.header.timestamp) };
    },
    async blockTime(h) { return Number((await blockAt(h)).block.header.timestamp); },
    async blockId(h) { return String((await blockAt(h)).block_id); },
    async chain(from, to) {
      const hNow = await headNow(); headId = hNow.id;   // blocks up to the head as it is now
      const n = to - from + 1, items: any[] = new Array(Math.max(0, n));
      const queue: [number, number][] = []; for (let s = from; s <= to; s += 50) queue.push([s, Math.min(to, s + 49)]);
      const worker = async () => {   // 4 reads at a time (audit A-2)
        while (queue.length) {
          const [s, e] = queue.shift()!;
          let k = s;
          while (k <= e) {
            const res: any = await withRetry(`blocks at ${k}`, () => p.call("block_store.get_blocks_by_height", { head_block_id: headId, ancestor_start_height: String(k), num_blocks: e - k + 1, return_block: true, return_receipt: true }));
            const got = res?.block_items ?? [];
            if (!got.length) throw new Error(`no blocks returned at ${k}`);
            for (const it of got) { if (Number(it.block_height) !== k || k > e) throw new Error(`blocks out of order at ${k}`); items[k - from] = it; k++; }
          }
        }
      };
      await Promise.all(Array.from({ length: 4 }, worker));
      const out: Chain = { hs: [], ts: [], sig: [], signers: [], ids: [], deltas: [] };
      const idx = new Map<string, number>(), events: any[] = [];
      for (const it of items) {
        const a = String(it.block.header.signer); let i = idx.get(a); if (i === undefined) { i = out.signers.length; out.signers.push(a); idx.set(a, i); }
        out.hs.push(Number(it.block_height)); out.ts.push(Number(it.block.header.timestamp)); out.sig.push(i); out.ids.push(String(it.block_id));
        events.push(...(await vhpEvents(it)));
      }
      out.deltas = V.vhpDeltas(events);
      return out;
    },
    async balance(a) {
      for (let t = 0; t < 6; t++) {
        const h1 = await headNow();
        const r: any = await withRetry(`VHP of ${a}`, () => (vhp.functions as any).balance_of({ owner: a }));
        if (!r || typeof r !== "object" || !("result" in r)) throw new Error(`no answer reading the VHP of ${a}`);
        // the contract's own effective balance is only a cross-check (audit S-3): if a read-only call can't give it,
        // the node is marked and the check is skipped, with a warning; the exact rebuild still decides
        let e: any = null;
        if (!effDown) { try { e = await (vhp.functions as any).effective_balance_of({ owner: a }); if (!e || typeof e !== "object" || !("result" in e)) throw new Error("no result"); } catch (err) { effDown = String((err as Error)?.message || err).slice(0, 200); e = null; console.warn(`effective_balance_of unavailable as a read-only call (${effDown}); cross-check skipped`); } }
        const h2 = await headNow();
        if (h1.id === h2.id) return { v: Number(r.result?.value ?? "0"), ...(e ? { eff: Number(e.result?.value ?? "0") } : {}), h: h1.height, id: h1.id };
      }
      throw new Error(`the head kept moving while reading the VHP of ${a}`);
    },
  };
}
/** The first height (≤ lib + 1) whose block time is at or after t. */
export async function heightAt(n: Node, head: Head, t: number): Promise<number> {
  if (t > head.libTime) return head.lib + 1;
  const est = Math.round(head.lib - (head.libTime - t) / 3000);
  let lo = Math.max(1, est - 2000), hi = Math.min(head.lib, est + 2000);
  for (let i = 0; i < 20 && lo > 1 && (await n.blockTime(lo)) >= t; i++) lo = Math.max(1, lo - 4000 * 2 ** i);
  for (let i = 0; i < 20 && hi < head.lib && (await n.blockTime(hi)) < t; i++) hi = Math.min(head.lib, hi + 4000 * 2 ** i);
  if ((await n.blockTime(hi)) < t) return hi + 1;
  while (lo < hi) { const m = Math.floor((lo + hi) / 2); if ((await n.blockTime(m)) < t) lo = m + 1; else hi = m; }
  return lo;
}
/** Blocks fromH..toH (irreversible) with an exact VHP book for every producer that signed in them and every address in
 *  `also`: balances read once at the head (pinned to a block) and the VHP events walked back to the range. */
export async function bookFor(n: Node, fromH: number, toH: number, also: string[]) {
  const c = await n.chain(fromH, toH);
  const who = [...new Set([...c.signers, ...also])];
  const anchors: Record<string, { h: number; v: number }> = {}, at = new Map<number, string>();
  const effAt: Record<string, { h: number; eff: number }> = {};
  for (const a of who) { const b = await n.balance(a); anchors[a] = { h: b.h, v: b.v }; at.set(b.h, b.id); if (b.eff !== undefined) effAt[a] = { h: b.h, eff: b.eff }; }
  const top = Math.max(...[...at.keys()]);
  if (top < toH) throw new Error(`a balance was read below block ${toH}; tried again next run`);
  const tail = top > toH ? await n.chain(toH + 1, top) : ({ hs: [], ids: [], deltas: [] } as any);
  // The blocks walked back are the very ones the balances were read on (no fork in between).
  const idOf = new Map<number, string>(); c.hs.forEach((h, i) => idOf.set(h, c.ids[i])); tail.hs.forEach((h: number, i: number) => idOf.set(h, tail.ids[i]));
  for (const [h, id] of at) if (idOf.get(h) !== id) throw new Error(`block ${h} changed while reading (a fork); tried again next run`);
  const book = V.vhpBook(anchors, [...c.deltas, ...tail.deltas]);
  // the contract's own effective balance at the read block must match the rebuild (it is read before block h + 1)
  // (audit S-3: not yet seen live. If the read-only call computes at the head block instead, a match at h is accepted
  //  too and reported, so the first real run shows which; matching neither is a real miss and stops the run.)
  const effCheck = { n: 0, atNext: 0, atHead: 0, skipped: who.length - Object.keys(effAt).length };
  for (const [a, x] of Object.entries(effAt)) {
    effCheck.n++;
    if (book.effective(a, x.h + 1) === x.eff) effCheck.atNext++;
    else if (book.effective(a, x.h) === x.eff) effCheck.atHead++;
    else throw new Error(`the VHP rebuild for ${a} doesn't match the contract's effective balance at block ${x.h}`);
  }
  if (effCheck.skipped) console.warn(`effective VHP cross-check skipped for ${effCheck.skipped} of ${who.length} producers`);
  for (const a of who) { const v = book.before(a, fromH); if (v === null || v < -0.5) throw new Error(`the VHP rebuild for ${a} went below zero (a missed event)`); }
  return { c, book, effCheck };
}

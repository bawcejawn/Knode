/**
 * Producer Bracket, option A research (owner OK 2026-10-28): collect a read-only sample of mainnet so the bracket can
 * rebuild every producer's exact VHP at every block from the chain's own VHP events, instead of hourly readings.
 *
 * Reads, for the last DAYS days up to the head:
 *  - every block's signer and time (compact),
 *  - every event in every block receipt and transaction receipt whose source is the VHP, KOIN or PoB contract,
 *    decoded where it is a token event (from, to, value), with a census of every (source, name) seen,
 *  - each signer's VHP balance at the end, on two nodes, with the head height before and after the reads,
 *  - a spot check: 1 range in 25 read again from the second node, events compared.
 * Writes OUT/vhp-sample.json.gz and OUT/summary.json. Holds no key and sends nothing.
 *
 *   RPC, RPC_CHECK, DAYS (default 8), OUT
 *   npx tsx tools/sim/bracket/sample-vhp.ts
 */
import { Provider, Contract, Serializer, utils } from "koilib";
import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { withRetry } from "../../../common.ts";

const E = process.env;
const RPC = E.RPC || "https://api.koinos.io", RPC_CHECK = E.RPC_CHECK || "";
const DAYS = Number(E.DAYS || 8), OUT = E.OUT || "bracket-samples";
const VHP = "12Y5vW6gk8GceH53YfRkRre2Rrcsgw7Naq";
const KOIN = "15DJN4a8SgrbGhhGksSBASiSYjGnMU8dGL";
const POB = "159myq5YUhhoVWu3wsHKHiJYKPKGUrGiyv";
const WATCH = new Set([VHP, KOIN, POB]);
const p = new Provider([RPC]), c = RPC_CHECK ? new Provider([RPC_CHECK]) : null;
const ser = new Serializer((utils.tokenAbi as any).koilib_types);

type Ev = { h: number; tx: number; seq: number; src: string; name: string; from?: string; to?: string; value?: string; impacted: string[]; raw?: string };

async function decode(e: any): Promise<Partial<Ev>> {
  const n = String(e.name || ""), kind = /transfer/.test(n) ? "transfer_event" : /mint/.test(n) ? "mint_event" : /burn/.test(n) ? "burn_event" : "";
  if (!kind || !(e.source === VHP || e.source === KOIN)) return { raw: e.data };
  try { const d: any = await ser.deserialize(e.data, `token.${kind}`); return { from: d.from, to: d.to, value: String(d.value ?? "0") }; }
  catch { return { raw: e.data }; }
}

const progress: string[] = [];
const note = (m: string) => { progress.push(`${new Date().toISOString()} ${m}`); console.log(m); };
/** Blocks from..to with receipts. A batch that errors is split in two (a node may refuse a large answer). */
async function range(node: Provider, headId: string, from: number, to: number): Promise<any[]> {
  try {
    const r: any = await withRetry(`blocks ${from}-${to}`, () => node.call("block_store.get_blocks_by_height",
      { head_block_id: headId, ancestor_start_height: String(from), num_blocks: to - from + 1, return_block: true, return_receipt: true }), 3);
    const items = (r?.block_items ?? []) as any[];
    if (items.length) return items;
    throw new Error(`no blocks returned at ${from}`);
  } catch (e) {
    if (to <= from) throw e;
    const mid = Math.floor((from + to) / 2);
    note(`split ${from}-${to}: ${String((e as Error).message).slice(0, 160)}`);
    return [...(await range(node, headId, from, mid)), ...(await range(node, headId, mid + 1, to))];
  }
}

async function main() {
  const t0 = Date.now();
  const hi: any = await withRetry("head", () => p.getHeadInfo());
  const headId = hi.head_topology.id, top = Number(hi.head_topology.height), lib = Number(hi.last_irreversible_block);
  const from = top - Math.round(DAYS * 28800);
  console.log(`head ${top}, irreversible ${lib}; reading ${from}..${top} with receipts`);
  const n = top - from + 1, signer: string[] = new Array(n), ts: number[] = new Array(n), ids: string[] = new Array(n);
  const events: Ev[] = [], census = new Map<string, number>(), samples = new Map<string, any>();
  const queue: [number, number][] = [];
  for (let s = from; s <= top; s += 50) queue.push([s, Math.min(top, s + 49)]);
  const spot: [number, number][] = queue.filter((_, i) => i % 25 === 7);
  let done = 0;
  const worker = async () => {
    while (queue.length) {
      const [s, e] = queue.shift()!;
      let k = s;
      while (k <= e) {
        const items = await range(p, headId, k, e);
        if (!items.length) throw new Error(`no blocks at ${k}`);
        for (const it of items) {
          const h = Number(it.block_height); if (h !== k) throw new Error(`out of order at ${k}`);
          signer[h - from] = it.block.header.signer; ts[h - from] = Number(it.block.header.timestamp); ids[h - from] = it.block_id;
          const rc = it.receipt || {};
          const all: [number, any][] = [...(rc.events || []).map((x: any) => [-1, x] as [number, any])];
          (rc.transaction_receipts || []).forEach((tr: any, i: number) => { for (const x of tr.events || []) all.push([i, x]); });
          for (const [tx, x] of all) {
            const key = `${x.source} ${x.name}${tx < 0 ? " (block)" : ""}`;
            census.set(key, (census.get(key) || 0) + 1);
            if (!samples.has(key)) samples.set(key, { h, tx, event: x });
            if (!WATCH.has(x.source)) continue;
            events.push({ h, tx, seq: Number(x.sequence || 0), src: x.source, name: x.name, impacted: x.impacted || [], ...(await decode(x)) });
          }
          k++;
        }
      }
      if (++done % 400 === 0) note(`${done} ranges, ${events.length} events, ${Math.round((Date.now() - t0) / 1000)} s`);
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  events.sort((a, b) => a.h - b.h || a.tx - b.tx || a.seq - b.seq);

  // spot check on the second node: same block ids and the same watched events
  const spotResult = { ranges: 0, mismatches: [] as string[] };
  if (c) {
    const ch: any = await withRetry("check head", () => c.getHeadInfo());
    for (const [s, e] of spot) {
      if (e > Number(ch.last_irreversible_block)) continue;
      const items = await range(c, ch.head_topology.id, s, e);
      spotResult.ranges++;
      for (const it of items) {
        const h = Number(it.block_height);
        if (it.block_id !== ids[h - from]) spotResult.mismatches.push(`block ${h} id`);
        const rc = it.receipt || {};
        const mine = [...(rc.events || []), ...(rc.transaction_receipts || []).flatMap((t: any) => t.events || [])].filter((x: any) => WATCH.has(x.source)).length;
        const ours = events.filter((x) => x.h === h).length;
        if (mine !== ours) spotResult.mismatches.push(`block ${h}: ${mine} vs ${ours} events`);
      }
    }
  }

  // balances at the end, on both nodes
  const who = [...new Set([...signer, ...events.flatMap((x) => [x.from, x.to].filter(Boolean) as string[])])].filter((a) => typeof a === "string");
  const signersOnly = [...new Set(signer)];
  async function balances(node: Provider) {
    const vhp = new Contract({ id: VHP, abi: utils.tokenAbi as any, provider: node });
    const before: any = await withRetry("head", () => node.getHeadInfo());
    const out: Record<string, string> = {};
    for (const a of signersOnly) { const r: any = await withRetry(`VHP ${a}`, () => (vhp.functions as any).balance_of({ owner: a })); out[a] = String(r?.result?.value ?? "0"); }
    const supply: any = await withRetry("supply", () => (vhp.functions as any).total_supply({}));
    const after: any = await withRetry("head", () => node.getHeadInfo());
    return { before: Number(before.head_topology.height), after: Number(after.head_topology.height), supply: String(supply?.result?.value ?? "0"), values: out };
  }
  const balP = await balances(p), balC = c ? await balances(c) : null;

  // the blocks after the sample's top up to the balance reads, so the rebuild can line up exactly
  const tailTop = Math.max(balP.after, balC ? balC.after : 0);
  const tail: Ev[] = [];
  if (tailTop > top) {
    const h2: any = await withRetry("head", () => p.getHeadInfo());
    for (let s = top + 1; s <= tailTop; s += 100) for (const it of await range(p, h2.head_topology.id, s, Math.min(tailTop, s + 99))) {
      const rc = it.receipt || {};
      const all: [number, any][] = [...(rc.events || []).map((x: any) => [-1, x] as [number, any])];
      (rc.transaction_receipts || []).forEach((tr: any, i: number) => { for (const x of tr.events || []) all.push([i, x]); });
      for (const [tx, x] of all) if (WATCH.has(x.source)) tail.push({ h: Number(it.block_height), tx, seq: Number(x.sequence || 0), src: x.source, name: x.name, impacted: x.impacted || [], ...(await decode(x)) });
    }
  }

  const signers = [...new Set(signer)];
  const sample = {
    v: 1, made: new Date().toISOString(), rpc: RPC, check: RPC_CHECK || null, contracts: { VHP, KOIN, POB },
    from, top, lib, headId, t0: ts[0],
    blocks: { signers, sig: signer.map((a) => signers.indexOf(a)), dts: ts.map((t, i) => (i ? t - ts[i - 1] : 0)) },
    events, tail, balances: { primary: balP, check: balC },
    census: Object.fromEntries([...census].sort((a, b) => b[1] - a[1])),
    examples: Object.fromEntries(samples), spot: spotResult,
  };
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "vhp-sample.json.gz"), zlib.gzipSync(JSON.stringify(sample), { level: 9 }));
  const summary = { made: sample.made, from, top, lib, blocks: n, events: events.length, tail: tail.length, signers: signers.length,
    census: sample.census, progress: progress.slice(-100), spot: { ranges: spotResult.ranges, mismatches: spotResult.mismatches.slice(0, 50) },
    balancesAgree: balC ? Object.keys(balP.values).every((a) => balP.values[a] === balC.values[a]) : null, seconds: Math.round((Date.now() - t0) / 1000) };
  fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 1) + "\n");
  console.log(JSON.stringify(summary, null, 1));
}
// Never fail without a reason anyone can read: the error goes into summary.json, which is published either way.
main().catch((e) => {
  console.error(e);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify({ made: new Date().toISOString(), error: String((e as Error)?.stack || e).slice(0, 4000), progress: progress.slice(-200) }, null, 1) + "\n");
});

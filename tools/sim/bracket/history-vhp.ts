/**
 * Producer Bracket: a long, read-only mainnet history for the exact-VHP handicap (owner OK 2026-10-28: "use the armana
 * api … downloading a few million blocks is okay"). Run in parallel chunks by .github/workflows/bracket-sample.yml.
 *
 *   MODE=plan     prints the irreversible head (the history's top) for the chunks.
 *   MODE=chunk    FROM..TO: every block's signer and time, and every VHP balance change in its receipts (the per-block
 *                 burn, transfers, mints), compact → OUT/history-<FROM>.json.gz
 *   MODE=anchor   TOP: every producer's VHP read pinned to one block (the head did not move during the read) on two
 *                 nodes, with the VHP changes from TOP+1 up to that block → OUT/anchors.json
 * Holds no key and sends nothing.
 */
import { Provider, Contract, Serializer, utils } from "koilib";
import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { withRetry } from "../../../common.ts";
import { tokenAbi } from "../../../bot/token-abi.ts";

const E = process.env;
const RPC = E.RPC || "https://koinos.armana.io", RPC_CHECK = E.RPC_CHECK || "";
const OUT = E.OUT || "bracket-history", MODE = E.MODE || "chunk";
const VHP = "12Y5vW6gk8GceH53YfRkRre2Rrcsgw7Naq";
const p = new Provider([RPC]);
const ser = new Serializer((utils.tokenAbi as any).koilib_types);
const log: string[] = [];
const note = (m: string) => { log.push(`${new Date().toISOString()} ${m}`); console.log(m); };

async function range(node: Provider, headId: string, from: number, to: number): Promise<any[]> {
  try {
    const r: any = await withRetry(`blocks ${from}-${to}`, () => node.call("block_store.get_blocks_by_height",
      { head_block_id: headId, ancestor_start_height: String(from), num_blocks: to - from + 1, return_block: true, return_receipt: true }), 4);
    const items = (r?.block_items ?? []) as any[];
    if (items.length) return items;
    throw new Error(`no blocks returned at ${from}`);
  } catch (e) {
    if (to <= from) throw e;
    const mid = Math.floor((from + to) / 2);
    note(`split ${from}-${to}: ${String((e as Error).message).slice(0, 120)}`);
    return [...(await range(node, headId, from, mid)), ...(await range(node, headId, mid + 1, to))];
  }
}
/** VHP balance changes in a block: [address, satoshi delta]. */
async function changes(it: any): Promise<[string, number][]> {
  const rc = it.receipt || {}, out: [string, number][] = [];
  for (const x of [...(rc.events || []), ...(rc.transaction_receipts || []).flatMap((t: any) => t.events || [])]) {
    if (x.source !== VHP) continue;
    const n = String(x.name || ""), kind = /transfer_event$/.test(n) ? "transfer_event" : /mint_event$/.test(n) ? "mint_event" : /burn_event$/.test(n) ? "burn_event" : "";
    if (!kind) continue;
    const d: any = await ser.deserialize(x.data, `token.${kind}`), v = Number(d.value ?? 0);
    if (kind === "transfer_event") { out.push([d.from, -v], [d.to, v]); } else if (kind === "mint_event") out.push([d.to, v]); else out.push([d.from, -v]);
  }
  return out;
}
async function blocks(node: Provider, from: number, to: number) {
  const hi: any = await withRetry("head", () => node.getHeadInfo());
  const headId = hi.head_topology.id, n = to - from + 1;
  const signer: string[] = new Array(n), ts: number[] = new Array(n), ev: [number, string, number][] = [];
  const queue: [number, number][] = []; for (let s = from; s <= to; s += 50) queue.push([s, Math.min(to, s + 49)]);
  let done = 0; const t0 = Date.now();
  const worker = async () => {
    while (queue.length) {
      const [s, e] = queue.shift()!;
      for (const it of await range(node, headId, s, e)) {
        const h = Number(it.block_height); if (h < s || h > e) throw new Error(`out of order at ${s}`);
        signer[h - from] = it.block.header.signer; ts[h - from] = Number(it.block.header.timestamp);
        for (const [a, d] of await changes(it)) ev.push([h, a, d]);
      }
      if (++done % 1000 === 0) note(`${done} of ${Math.ceil(n / 50)} ranges, ${Math.round((Date.now() - t0) / 1000)} s`);
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  for (let i = 0; i < n; i++) if (!signer[i]) throw new Error(`block ${from + i} missing`);
  ev.sort((x, y) => x[0] - y[0]);
  return { signer, ts, ev };
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  if (MODE === "plan") {
    const hi: any = await withRetry("head", () => p.getHeadInfo());
    const top = Number(hi.last_irreversible_block), days = Number(E.DAYS || 100), chunks = Number(E.CHUNKS || 6);
    const from = top - Math.round(days * 28800) + 1, size = Math.ceil((top - from + 1) / chunks);
    const list = Array.from({ length: chunks }, (_, k) => ({ from: from + k * size, to: Math.min(top, from + (k + 1) * size - 1) }));
    fs.appendFileSync(E.GITHUB_OUTPUT || "/dev/stdout", `top=${top}\nchunks=${JSON.stringify(list)}\n`);
    return;
  }
  if (MODE === "chunk") {
    const from = Number(E.FROM), to = Number(E.TO);
    note(`chunk ${from}..${to} from ${RPC}`);
    const b = await blocks(p, from, to);
    const signers = [...new Set(b.signer)], addrs = [...new Set(b.ev.map((x) => x[1]))];
    const sIx = new Map(signers.map((a, i) => [a, i])), aIx = new Map(addrs.map((a, i) => [a, i]));
    const file = { v: 1, from, to, t0: b.ts[0], signers, sig: b.signer.map((a) => sIx.get(a)), dts: b.ts.map((t, i) => (i ? t - b.ts[i - 1] : 0)), addrs, ev: b.ev.map(([h, a, d]) => [h - from, aIx.get(a), d]), log };
    fs.writeFileSync(path.join(OUT, `history-${from}.json.gz`), zlib.gzipSync(JSON.stringify(file), { level: 9 }));
    note(`wrote ${b.signer.length} blocks, ${b.ev.length} VHP changes`);
    return;
  }
  if (MODE === "anchor") {
    const top = Number(E.TOP);
    // every address that signed in the last 3 days, read pinned to a block, on each node
    const recent = await blocks(p, top - 3 * 28800 + 1, top);
    const who = [...new Set(recent.signer)];
    const read = async (node: Provider) => {
      const vhp = new Contract({ id: VHP, abi: tokenAbi as any, provider: node });
      const out: Record<string, { v: string; h: number }> = {};
      for (const a of who) {
        for (let t = 0; ; t++) {
          const h1: any = await withRetry("head", () => node.getHeadInfo());
          const r: any = await withRetry(`VHP ${a}`, () => (vhp.functions as any).balance_of({ owner: a }));
          const h2: any = await withRetry("head", () => node.getHeadInfo());
          if (h1.head_topology.id === h2.head_topology.id) { out[a] = { v: String(r?.result?.value ?? "0"), h: Number(h1.head_topology.height) }; break; }
          if (t > 8) throw new Error(`head kept moving reading ${a}`);
        }
      }
      return out;
    };
    const primary = await read(p), check = RPC_CHECK ? await read(new Provider([RPC_CHECK])) : null;
    const hiTop = Math.max(...Object.values(primary).map((x) => x.h));
    const tail = await blocks(p, top + 1, hiTop);
    fs.writeFileSync(path.join(OUT, "anchors.json"), JSON.stringify({ v: 1, top, rpc: RPC, check: RPC_CHECK || null, primary, checkNode: check, tail: tail.ev, log }) + "\n");
    note(`anchored ${who.length} producers at up to block ${hiTop}`);
  }
}
main().catch((e) => {
  console.error(e);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, `error-${E.MODE || "x"}-${E.FROM || E.TOP || "0"}.json`), JSON.stringify({ error: String((e as Error)?.stack || e).slice(0, 4000), log: log.slice(-100) }) + "\n");
});

// One-off live check (audit S-3): does a read-only effective_balance_of answer, and at which block height does the
// VHP contract compute it? Reads only; no keys. Usage: npx tsx tools/sim/bracket/live-effective.ts [rpc]
import { chainNode } from "../../../bot/vhp-chain.ts";
import { createRequire } from "node:module";
import { Provider } from "koilib";
const V = (createRequire(import.meta.url)("../../../vhp-standard.js"), (globalThis as any).KVhp);
const rpc = process.argv[2] || "https://koinos.armana.io";
const n: any = chainNode(new Provider([rpc]));
const head = await n.head();
const from = head.lib - 300, c = await n.chain(from, head.lib);
const who = [...new Set(c.signers)].slice(0, 12) as string[];
const out: any[] = [];
for (const a of who) {
  const b = await n.balance(a);
  const tail = b.h > head.lib ? await n.chain(head.lib + 1, b.h) : { deltas: [] };
  const book = V.vhpBook({ [a]: { h: b.h, v: b.v } }, [...c.deltas, ...tail.deltas]);
  const recv = [...c.deltas, ...tail.deltas].filter((d: any) => d.a === a && d.d > 0 && d.h > b.h - 25).length;
  out.push({ a, read: b.eff, bal: b.v, atH: book.effective(a, b.h), atH1: book.effective(a, b.h + 1), recentReceipts: recv });
}
console.log(JSON.stringify({ rpc, lib: head.lib, rows: out }, null, 1));

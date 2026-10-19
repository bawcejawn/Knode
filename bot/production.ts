/**
 * Live "who produced the recent blocks?" check for `npm run bot -- status`.
 * It reads signers from the chain. It does not look at bot-state.json.
 */
export type SignedBlock = { h: number; ts: number; signer: string };

export const BLOCKS_PER_DAY = 28_800;

/** Heights to read: the last `maxBlocks` irreversible blocks, never below 1. */
export function scanRange(lib: number, maxBlocks: number): { from: number; to: number } {
  if (!Number.isInteger(lib) || lib < 1) throw new Error(`not a block height: ${lib}`);
  const span = Math.max(1, Math.floor(maxBlocks));
  return { from: Math.max(1, lib - span + 1), to: lib };
}

export function signerFromBlockItem(item: any): SignedBlock {
  const header = item?.block?.header ?? {};
  return {
    h: Number(item?.block_height ?? header.height),
    ts: Number(header.timestamp ?? 0),
    signer: String(header.signer ?? "unknown"),
  };
}

/** Highest block signed by `address`, and how many it signed in this list. */
export function productionOf(blocks: SignedBlock[], address: string): { last: SignedBlock | null; count: number } {
  let last: SignedBlock | null = null;
  let count = 0;
  for (const b of blocks) {
    if (b.signer !== address) continue;
    count++;
    if (!last || b.h > last.h) last = b;
  }
  return { last, count };
}

const utc = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC";

/**
 * One status line. `nowMs` is the chain's current time. Age comes from the block's own timestamp
 * when we have one, otherwise from the height gap (20 blocks ≈ 1 minute).
 */
export function formatProduction(label: string, address: string, blocks: SignedBlock[], from: number, to: number, nowMs: number): string {
  const span = to - from + 1;
  const { last, count } = productionOf(blocks, address);
  const perDay = span > 0 ? (count / span) * BLOCKS_PER_DAY : 0;
  const window = `${span.toLocaleString("en-US")} blocks (heights ${from.toLocaleString("en-US")}–${to.toLocaleString("en-US")})`;
  if (!last) return `${label}: no block signed by ${address} in the last ${window}.`;
  const ago = last.ts > 0 && nowMs >= last.ts
    ? `${Math.round((nowMs - last.ts) / 60_000)} min ago`
    : `${Math.round((to - last.h) / 20)} min ago`;
  const when = last.ts > 0 ? ` at ${utc(last.ts)}` : "";
  return `${label}: last block ${last.h.toLocaleString("en-US")}${when} (${ago}), ${count.toLocaleString("en-US")} of the last ${window}, ~${perDay.toFixed(0)} blocks/day.`;
}

/** Read every block in the window. `fetchRange` is one RPC page; pages are fetched a few at a time. */
export async function loadSigners(
  fetchRange: (from: number, to: number) => Promise<SignedBlock[]>,
  lib: number,
  maxBlocks: number,
  page = 100,
): Promise<{ blocks: SignedBlock[]; from: number; to: number }> {
  const { from, to } = scanRange(lib, maxBlocks);
  const spans: Array<[number, number]> = [];
  for (let h = from; h <= to; h += page) spans.push([h, Math.min(to, h + page - 1)]);
  const parts: SignedBlock[][] = new Array(spans.length);
  let cursor = 0;
  const run = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= spans.length) return;
      const [a, b] = spans[i];
      parts[i] = await fetchRange(a, b);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, spans.length) }, run));
  const blocks = parts.flat();
  if (blocks.length === 0) throw new Error(`node returned no blocks from ${from} to ${to}`);
  return { blocks, from, to };
}

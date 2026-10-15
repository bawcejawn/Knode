/**
 * Shared helpers for the generator (and, later, the resolver/keeper services).
 * Read-only chain access, the lean block cache, and the forecast model's building blocks.
 */
import { Provider } from "koilib";
import * as fs from "node:fs";
import * as path from "node:path";

export const BLOCKS_PER_DAY = 28_800;
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const fmt = (x: number, d = 0) => (isFinite(x) ? x.toLocaleString("en-US", { maximumFractionDigits: d }) : "n/a");
export const pct = (x: number, d = 1) => (isFinite(x) ? (x * 100).toFixed(d) + "%" : "n/a");

export async function withRetry<T>(label: string, fn: () => Promise<T>, tries = 6): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= tries) throw new Error(`${label}: ${(err as Error).message}`);
      const wait = 1000 * 2 ** attempt;
      if (attempt >= 2) console.log(`  ${label}: server busy, retry ${attempt} in ${wait / 1000}s ...`);
      await sleep(wait);
    }
  }
}

// ───────────────────────── Lean block cache ─────────────────────────

export type Blk = { h: number; ts: number; signer: string; ntx: number; compute: number };

export function readCsv(file: string): Blk[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => {
    const [h, ts, signer, ntx, compute] = l.split(",");
    return { h: +h, ts: +ts, signer, ntx: +ntx, compute: +compute };
  });
}

export function writeCsv(file: string, blocks: Blk[]) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, blocks.map((b) => `${b.h},${b.ts},${b.signer},${b.ntx},${b.compute}`).join("\n"));
}

function toBlk(item: any): Blk {
  const header = item.block?.header ?? {};
  return {
    h: Number(item.block_height ?? header.height),
    ts: Number(header.timestamp),
    signer: header.signer ?? "unknown",
    ntx: item.block?.transactions?.length ?? 0,
    compute: Number(item.receipt?.compute_bandwidth_used ?? 0),
  };
}

export async function fetchRange(provider: Provider, headId: string, from: number, to: number, batch = 100, concurrency = 2) {
  const starts: number[] = [];
  for (let h = from; h <= to; h += batch) starts.push(h);
  const results = new Map<number, Blk[]>();
  const total = to - from + 1;
  let done = 0;
  const t0 = Date.now();
  const worker = async () => {
    while (starts.length) {
      const s = starts.shift()!;
      const count = Math.min(batch, to - s + 1);
      const got: Blk[] = [];
      while (got.length < count) {
        const res: any = await withRetry(`blocks at ${s + got.length}`, () =>
          provider.call("block_store.get_blocks_by_height", {
            head_block_id: headId, ancestor_start_height: String(s + got.length),
            num_blocks: count - got.length, return_block: true, return_receipt: true,
          })
        );
        const items = res?.block_items ?? [];
        if (items.length === 0) throw new Error(`node returned no blocks at ${s + got.length}`);
        got.push(...items.map(toBlk));
      }
      results.set(s, got);
      done += count;
      const rate = done / ((Date.now() - t0) / 1000);
      process.stdout.write(`\r  downloaded ${fmt(done)} / ${fmt(total)} blocks  (~${fmt((total - done) / rate / 60, 1)} min left)   `);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  process.stdout.write("\n");
  return [...results.keys()].sort((a, b) => a - b).flatMap((k) => results.get(k)!);
}

/**
 * Keeps `file` holding exactly the last `days` of irreversible blocks. Seeds from `seedFile`
 * (e.g. the backtester's cache) when available, then downloads whatever is missing, saving as it goes.
 */
export async function syncBlocks(provider: Provider, file: string, days: number, seedFile?: string) {
  let blocks = readCsv(file);
  if (blocks.length === 0 && seedFile && fs.existsSync(seedFile)) {
    console.log(`Seeding block history from ${seedFile} ...`);
    blocks = readCsv(seedFile);
  }
  const head: any = await withRetry("reading head", () => provider.getHeadInfo());
  const lib = Number(head.last_irreversible_block);
  const from = Math.max(1, lib - Math.round(days * BLOCKS_PER_DAY) + 1);
  blocks = blocks.filter((b) => b.h >= from && b.h <= lib).sort((a, b) => a.h - b.h);
  const CHUNK = 50_000;
  const first = blocks.length ? blocks[0].h : lib + 1;
  if (first > from) {
    console.log(`Downloading ${fmt(first - from)} older blocks ...`);
    for (let hi = first - 1; hi >= from; hi -= CHUNK) {
      const lo = Math.max(from, hi - CHUNK + 1);
      blocks = (await fetchRange(provider, head.head_topology.id, lo, hi)).concat(blocks);
      writeCsv(file, blocks);
    }
  }
  const last = blocks.length ? blocks[blocks.length - 1].h : from - 1;
  if (last < lib) {
    console.log(`Downloading ${fmt(lib - last)} newer blocks ...`);
    for (let lo = last + 1; lo <= lib; lo += CHUNK) {
      blocks = blocks.concat(await fetchRange(provider, head.head_topology.id, lo, Math.min(lib, lo + CHUNK - 1)));
      writeCsv(file, blocks);
    }
  }
  writeCsv(file, blocks);
  return { blocks, lib };
}

// ───────────────────────── Small statistics helpers ─────────────────────────

export const quant = (sorted: number[], p: number) => {
  const pos = (sorted.length - 1) * p, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
};

/** Integer thresholds from a sample: each threshold's empirical CDF is nearest j/k. Null if not distinct. */
export function sampleThresholds(sample: number[], k: number): number[] | null {
  const s = [...sample].sort((x, y) => x - y);
  const uniq = [...new Set(s)];
  const cdf = (v: number) => { let lo = 0, hi = s.length; while (lo < hi) { const m = (lo + hi) >> 1; if (s[m] <= v) lo = m + 1; else hi = m; } return lo / s.length; };
  const t: number[] = [];
  for (let j = 1; j < k; j++) {
    let best = uniq[0], err = Infinity;
    for (const v of uniq) { const e = Math.abs(cdf(v) - j / k); if (e < err) { err = e; best = v; } }
    t.push(best);
  }
  for (let j = 1; j < t.length; j++) if (t[j] <= t[j - 1]) return null;
  return t;
}

/** Option index for an integer value against integer thresholds: option j means t[j-1] < value ≤ t[j]. */
export const optionFor = (value: number, thresholds: number[]) => thresholds.filter((t) => value > t).length;

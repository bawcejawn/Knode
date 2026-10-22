/**
 * Shared helpers for the generator (and, later, the resolver/keeper services).
 * Read-only chain access, the lean block cache, and the forecast model's building blocks.
 */
import { Provider, Contract } from "koilib";
import { tokenAbi } from "./bot/token-abi.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";

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
 * `checkAllDays`: the newest days of the cache that are compared with the chain row by row (the generator's model
 * weighs them most); older rows are spot-checked.
 */
export async function syncBlocks(provider: Provider, file: string, days: number, seedFile?: string, opts: { checkAllDays?: number } = {}) {
  let blocks = readCsv(file);
  if (blocks.length === 0 && seedFile && fs.existsSync(seedFile)) {
    console.log(`Seeding block history from ${seedFile} ...`);
    blocks = readCsv(seedFile);
  }
  if (blocks.length === 0 && fs.existsSync(COMPACT)) {
    console.log(`Seeding block history from ${COMPACT} ...`);
    blocks = readCompact(COMPACT);
  }
  const head: any = await withRetry("reading head", () => provider.getHeadInfo());
  const lib = Number(head.last_irreversible_block);
  const from = Math.max(1, lib - Math.round(days * BLOCKS_PER_DAY) + 1);
  blocks = blocks.filter((b) => b.h >= from && b.h <= lib).sort((a, b) => a.h - b.h);
  blocks = blocks.filter((b, i) => i === 0 || b.h !== blocks[i - 1].h);
  // Holes inside the cached range are downloaded (or, if there are many, the cache is dropped).
  const holes: Array<[number, number]> = [];
  let missing = 0;
  for (let i = 1; i < blocks.length; i++) if (blocks[i].h > blocks[i - 1].h + 1) { holes.push([blocks[i - 1].h + 1, blocks[i].h - 1]); missing += blocks[i].h - blocks[i - 1].h - 1; }
  if (missing > 50_000) { console.log(`The cached blocks have ${fmt(missing)} missing heights: discarding the cache.`); blocks = []; }
  else if (holes.length) {
    console.log(`Filling ${fmt(missing)} missing height(s) in the cached blocks ...`);
    for (const [lo, hi] of holes) blocks = blocks.concat(await fetchRange(provider, head.head_topology.id, lo, hi));
    blocks.sort((a, b) => a.h - b.h);
  }
  // The cache (a file, or GitHub's Actions cache) is not trusted: the newest checkAllDays are compared with the chain
  // row by row, and runs of older rows spread over the rest; on any difference the cache is dropped and downloaded again.
  const checkFrom = lib - Math.round((opts.checkAllDays ?? 2) * BLOCKS_PER_DAY) + 1;
  if (blocks.length && !(await cacheMatchesChain(provider, head.head_topology.id, blocks, 24, 10, checkFrom))) {
    console.log("Cached blocks differ from the chain: discarding the cache and downloading again.");
    blocks = [];
  }
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

/** Compares every cached block at or above `checkFrom`, and `runs` runs of `len` older cached blocks, evenly spread
 *  (random start), with the chain. `blocks` must be sorted by height with no gaps. */
export async function cacheMatchesChain(provider: Provider, headId: string, blocks: Blk[], runs = 24, len = 10, checkFrom = Infinity): Promise<boolean> {
  const old = blocks.findIndex((b) => b.h >= checkFrom), split = old < 0 ? blocks.length : old;
  const starts: Array<[number, number]> = [];
  const step = Math.max(len, Math.floor(split / runs));
  for (let i = Math.floor(Math.random() * step); i < split; i += step) starts.push([i, Math.min(len, split - i)]);
  for (let i = split; i < blocks.length; i += 100) starts.push([i, Math.min(100, blocks.length - i)]);
  for (const [i, n] of starts) {
    const got: Blk[] = [];
    while (got.length < n) {
      const res: any = await withRetry(`checking cached blocks at ${blocks[i + got.length].h}`, () =>
        provider.call("block_store.get_blocks_by_height", {
          head_block_id: headId, ancestor_start_height: String(blocks[i + got.length].h), num_blocks: n - got.length, return_block: true, return_receipt: false,
        }));
      const items = res?.block_items ?? [];
      if (!items.length) return false;
      got.push(...items.map(toBlk));
    }
    for (let j = 0; j < n; j++) {
      const a = blocks[i + j], b = got[j];
      if (!b || a.h !== b.h || a.ts !== b.ts || a.signer !== b.signer || a.ntx !== b.ntx) return false;
    }
  }
  return true;
}

/** The repo's packed block history (see export-blocks.ts): signer table, start, then per block
 *  "<signer index>,<ms since previous>,<transaction count>". The compute column is not kept (unused). */
export const COMPACT = "data/blocks-compact.csv.gz";
export function readCompact(file = COMPACT): Blk[] {
  const lines = zlib.gunzipSync(fs.readFileSync(file)).toString("utf8").split("\n");
  const signers = lines[0].split(",").slice(1);
  const [, h0, ts0] = lines[1].split(",").map(Number);
  const out: Blk[] = [];
  let ts = ts0;
  for (let i = 2; i < lines.length; i++) {
    if (!lines[i]) continue;
    const [s, dt, ntx] = lines[i].split(",").map(Number);
    ts += dt;
    out.push({ h: h0 + out.length, ts, signer: signers[s], ntx, compute: 0 });
  }
  return out;
}

// ───────────────────────── VHP readings (the VHP-swing void rule) ─────────────────────────

/** The VHP token on mainnet; game-data/deployment.json's "vhp" is used when present. */
export const MAINNET_VHP = "12Y5vW6gk8GceH53YfRkRre2Rrcsgw7Naq";

/** VHP held by each address right now, and the whole network's VHP under the key "network" (the token's total
 *  supply). Values are 1e-8 units, as text. The height is the head read AFTER the values, so every value is from that
 *  block or an earlier one. A read that returns no value is an error, never "0". */
export async function readVhp(provider: Provider, vhpContract: string, who: string[]): Promise<{ height: number; values: Record<string, string> }> {
  const vhp = new Contract({ id: vhpContract, abi: tokenAbi as any, provider });
  const fn = vhp.functions as any;
  const values: Record<string, string> = {};
  for (const w of [...new Set(who)]) {
    const r: any = w === "network"
      ? await withRetry("VHP total supply", () => fn.total_supply({}))
      : await withRetry(`VHP of ${w}`, () => fn.balance_of({ owner: w }));
    // An empty result is how a token reports a zero balance; a missing result is a failed read.
    if (!r || typeof r !== "object" || !("result" in r)) throw new Error(`no answer reading the VHP of ${w}`);
    values[w] = String(r.result?.value ?? "0");
  }
  const head: any = await withRetry("reading head", () => provider.getHeadInfo());
  return { height: Number(head.head_topology.height), values };
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

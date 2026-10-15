/**
 * STEP 0 — Koinos producer & reward analysis  (READ-ONLY, no keys needed)
 * -----------------------------------------------------------------------
 * Scans recent mainnet blocks and answers the questions that decide the
 * platform's economics and anti-gaming rules:
 *
 *   1. Producer counts and shares (how concentrated is block production?)
 *   2. Actual reward per VHP per week
 *   3. Does producing a block change the producer's VHP balance?
 *      (decides how compound() must re-burn returned KOIN)
 *   4. Projected pool share, pot and win-vs-solo yield at different deposit levels
 *   5. Missed-block rates and VHP volatility (for the "void" thresholds)
 *
 * Run:   npx tsx step0.ts                 (last 7 days)
 *        npx tsx step0.ts --days 3        (shorter, faster)
 *        npx tsx step0.ts --seed 50000 --pools 10000,100000
 *        npx tsx step0.ts --from-cache step0-output/cache.json   (re-analyze, no download)
 *
 * Outputs go to ./step0-output/ (report.json, producers.csv, daily.csv, cache.json)
 *
 * Nothing here signs or sends a transaction. It only reads public data.
 */

import { Provider, Contract, utils } from "koilib";
import * as fs from "node:fs";
import * as path from "node:path";

// ───────────────────────── Settings (override with --flags) ─────────────────────────

const DEFAULTS = {
  rpc: "https://api.koinos.io",
  days: 7, // how far back to scan
  batch: 100, // blocks per RPC request
  concurrency: 2, // parallel requests (keep low; it's a shared public node)
  // Mainnet contract addresses, confirmed from live block rewards (Oct 2026).
  // The script re-detects them from the data every run; these are only fallbacks.
  koin: "19GYjDBVXU7keLbYvMLazsGQn3GTWHjHkK",
  vhp: "12Y5vW6gk8GceH53YfRkRre2Rrcsgw7Naq",
  // Platform projection inputs (all in whole VHP)
  seed: 0, // Koinos Federation seed in KOIN: 95% is burned into VHP, 5% kept as KOIN for Mana
  pools: "10000,100000,1000000,2000000,5000000,10000000", // total player VHP deposited (any split across wallets)
  feeBps: 500, // creator fee on the gain, held back as KOIN: 500 = 5%
  retainBps: 200, // creator's owner share of each week's gain, kept producing as VHP: 200 = 2%
  out: "step0-output",
  fromCache: "",
};

const BLOCKS_PER_DAY = 28_800; // 86,400 s / 3 s
const DECIMALS = 1e8; // KOIN and VHP both use 8 decimals
const MS_PER_DAY = 86_400_000;

// ───────────────────────── Tiny helpers ─────────────────────────

/** Parses --key value flags into the settings object. */
function parseArgs(): typeof DEFAULTS {
  const cfg: any = { ...DEFAULTS };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    // "--from-cache" -> "fromCache"
    const key = argv[i].slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const val = argv[i + 1];
    if (!(key in DEFAULTS)) throw new Error(`Unknown flag --${argv[i].slice(2)}`);
    cfg[key] = typeof (DEFAULTS as any)[key] === "number" ? Number(val) : val;
    i++;
  }
  return cfg;
}

const nums = (s: string) => s.split(",").map((x) => Number(x.trim())).filter((x) => !isNaN(x));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pct = (x: number, d = 2) => (isFinite(x) ? (x * 100).toFixed(d) + "%" : "n/a");
const fmt = (x: number, d = 2) =>
  isFinite(x) ? x.toLocaleString("en-US", { maximumFractionDigits: d }) : "n/a";

/** Retries a network call with growing waits (2s, 4s, 8s, ...). Public nodes sometimes rate-limit. */
async function withRetry<T>(label: string, fn: () => Promise<T>, tries = 6): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= tries) throw new Error(`${label}: ${(err as Error).message}`);
      const wait = 1000 * 2 ** attempt;
      console.log(`  ${label} failed (${(err as Error).message.slice(0, 80)}); retrying in ${wait / 1000}s ...`);
      await sleep(wait);
    }
  }
}

/** Value at quantile q (0..1) of a list of numbers. */
function quantile(values: number[], q: number): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

// ───────────────────────── Protobuf event decoding ─────────────────────────
// Event payloads arrive as base64 protobuf. Token events are simple enough to
// decode by hand, so we don't need generated protobuf code:
//   mint_event     { to: bytes = 1;  value: uint64 = 2 }
//   burn_event     { from: bytes = 1; value: uint64 = 2 }
//   transfer_event { from: bytes = 1; to: bytes = 2; value: uint64 = 3 }

function readVarint(buf: Uint8Array, pos: number): [bigint, number] {
  let result = 0n;
  let shift = 0n;
  while (true) {
    const byte = buf[pos++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [result, pos];
    shift += 7n;
  }
}

function decodeFields(b64: string): Map<number, Uint8Array | bigint> {
  const buf = Uint8Array.from(Buffer.from(b64, "base64"));
  const fields = new Map<number, Uint8Array | bigint>();
  let pos = 0;
  while (pos < buf.length) {
    const [tag, p1] = readVarint(buf, pos);
    pos = p1;
    const field = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (wire === 0) {
      const [v, p2] = readVarint(buf, pos);
      fields.set(field, v);
      pos = p2;
    } else if (wire === 2) {
      const [len, p2] = readVarint(buf, pos);
      fields.set(field, buf.slice(p2, p2 + Number(len)));
      pos = p2 + Number(len);
    } else {
      break; // other wire types never appear in token events
    }
  }
  return fields;
}

const addr = (b: unknown) => (b instanceof Uint8Array ? utils.encodeBase58(b) : undefined);
const amount = (v: unknown) => (typeof v === "bigint" ? Number(v) / DECIMALS : 0);

// ───────────────────────── Compact block record ─────────────────────────

type TokenEvent = {
  src: string; // contract that emitted it (KOIN, VHP, ...)
  kind: "mint" | "burn" | "transfer";
  from?: string;
  to?: string;
  value: number; // whole tokens
  blockLevel: boolean; // emitted by the block itself (rewards) vs. by a user transaction
};

type BlockRow = {
  h: number;
  ts: number; // ms
  signer: string;
  ntx: number;
  compute: number;
  network: number;
  gov: number; // governance/proposal events
  ev: TokenEvent[];
};

function toRow(item: any): BlockRow {
  const header = item.block?.header ?? {};
  const receipt = item.receipt ?? {};
  const ev: TokenEvent[] = [];
  let gov = 0;

  const handle = (e: any, blockLevel: boolean) => {
    const name: string = e.name ?? "";
    if (/proposal/i.test(name)) gov++;
    const m = name.match(/(?:^|\.)(mint|burn|transfer)_event$/);
    if (!m || !e.data) return;
    const f = decodeFields(e.data);
    const kind = m[1] as TokenEvent["kind"];
    if (kind === "mint") ev.push({ src: e.source, kind, to: addr(f.get(1)), value: amount(f.get(2)), blockLevel });
    if (kind === "burn") ev.push({ src: e.source, kind, from: addr(f.get(1)), value: amount(f.get(2)), blockLevel });
    if (kind === "transfer")
      ev.push({ src: e.source, kind, from: addr(f.get(1)), to: addr(f.get(2)), value: amount(f.get(3)), blockLevel });
  };

  for (const e of receipt.events ?? []) handle(e, true);
  for (const tr of receipt.transaction_receipts ?? []) for (const e of tr.events ?? []) handle(e, false);

  return {
    h: Number(item.block_height ?? header.height),
    ts: Number(header.timestamp),
    signer: header.signer ?? "unknown",
    ntx: item.block?.transactions?.length ?? 0,
    compute: Number(receipt.compute_bandwidth_used ?? 0),
    network: Number(receipt.network_bandwidth_used ?? 0),
    gov,
    ev,
  };
}

// ───────────────────────── Downloading blocks ─────────────────────────

async function fetchBatch(provider: Provider, headId: string, start: number, count: number): Promise<BlockRow[]> {
  const rows: BlockRow[] = [];
  let attempt = 0;
  while (rows.length < count) {
    try {
      const res: any = await provider.call("block_store.get_blocks_by_height", {
        head_block_id: headId,
        ancestor_start_height: String(start + rows.length),
        num_blocks: count - rows.length,
        return_block: true,
        return_receipt: true,
      });
      const items = res?.block_items ?? [];
      if (items.length === 0) throw new Error("node returned no blocks");
      rows.push(...items.map(toRow)); // node may return fewer than asked; loop picks up the rest
      attempt = 0;
    } catch (err) {
      if (++attempt > 5) throw new Error(`Failed at height ${start + rows.length}: ${(err as Error).message}`);
      await sleep(1000 * 2 ** attempt); // back off: 2s, 4s, 8s...
    }
  }
  return rows;
}

async function fetchRange(provider: Provider, headId: string, from: number, to: number, cfg: typeof DEFAULTS) {
  const starts: number[] = [];
  for (let h = from; h <= to; h += cfg.batch) starts.push(h);
  const results = new Map<number, BlockRow[]>();
  const total = to - from + 1;
  let done = 0;
  const t0 = Date.now();

  const worker = async () => {
    while (starts.length) {
      const s = starts.shift()!;
      results.set(s, await fetchBatch(provider, headId, s, Math.min(cfg.batch, to - s + 1)));
      done += Math.min(cfg.batch, to - s + 1);
      const rate = done / ((Date.now() - t0) / 1000);
      process.stdout.write(
        `\r  downloaded ${fmt(done, 0)} / ${fmt(total, 0)} blocks  (~${fmt((total - done) / rate / 60, 1)} min left)   `
      );
    }
  };
  await Promise.all(Array.from({ length: cfg.concurrency }, worker));
  process.stdout.write("\n");
  return [...results.keys()].sort((a, b) => a - b).flatMap((k) => results.get(k)!);
}

// ───────────────────────── Main ─────────────────────────

async function main() {
  const cfg = parseArgs();
  fs.mkdirSync(cfg.out, { recursive: true });
  const provider = new Provider([cfg.rpc]);

  console.log("\n=== STEP 0: Koinos producer & reward analysis (read-only) ===\n");

  // 1) Get blocks (from the node, or from a previous run's cache)
  let rows: BlockRow[];
  let lib: number;
  if (cfg.fromCache) {
    const cached = JSON.parse(fs.readFileSync(cfg.fromCache, "utf8"));
    rows = cached.rows;
    console.log(`Loaded ${fmt(rows.length, 0)} blocks from cache.`);
    // VHP balances are read "now" and walked backwards, so the cache must reach today's head.
    // Download only the blocks added since the cache was saved, then keep the last --days.
    const head: any = await withRetry("reading head", () => provider.getHeadInfo());
    const headHeight = Number(head.head_topology.height);
    lib = Number(head.last_irreversible_block);
    const lastCached = rows[rows.length - 1].h;
    if (headHeight > lastCached) {
      console.log(`Topping up the cache with ${fmt(headHeight - lastCached, 0)} new blocks ...`);
      rows = rows.concat(await fetchRange(provider, head.head_topology.id, lastCached + 1, headHeight, cfg));
    }
    const from = Math.max(1, lib - Math.round(cfg.days * BLOCKS_PER_DAY) + 1);
    rows = rows.filter((r) => r.h >= from);
    fs.writeFileSync(path.join(cfg.out, "cache.json"), JSON.stringify({ lib, rows }));
  } else {
    const head: any = await withRetry("reading head", () => provider.getHeadInfo());
    const headHeight = Number(head.head_topology.height);
    lib = Number(head.last_irreversible_block);
    const from = Math.max(1, lib - Math.round(cfg.days * BLOCKS_PER_DAY) + 1);
    console.log(`Head ${fmt(headHeight, 0)}, last irreversible ${fmt(lib, 0)}.`);
    console.log(`Scanning ${fmt(headHeight - from + 1, 0)} blocks (~${cfg.days} days) from ${cfg.rpc} ...`);
    // We read up to the head (not just the irreversible block) so that VHP balances
    // read "now" can be walked backwards exactly. Stats use irreversible blocks only.
    rows = await fetchRange(provider, head.head_topology.id, from, headHeight, cfg);
    fs.writeFileSync(path.join(cfg.out, "cache.json"), JSON.stringify({ lib, rows }));
  }
  const confirmed = rows.filter((r) => r.h <= lib);
  if (confirmed.length < 2) throw new Error("Not enough irreversible blocks to analyze.");
  const windowDays = (confirmed[confirmed.length - 1].ts - confirmed[0].ts) / MS_PER_DAY;

  // 2) Producer counts and shares
  const counts = new Map<string, number>();
  for (const r of confirmed) counts.set(r.signer, (counts.get(r.signer) ?? 0) + 1);
  const producers = [...counts.keys()];
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const N = confirmed.length;
  const shares = sorted.map(([, c]) => c / N);
  const hhi = shares.reduce((s, x) => s + x * x, 0);
  let cum = 0;
  let nakamoto = 0;
  for (const s of shares) {
    cum += s;
    nakamoto++;
    if (cum > 0.5) break;
  }

  // 3) What happens to the signer in each block? (block-level token events)
  const flowKey = (e: TokenEvent, signer: string) => {
    const who =
      e.kind === "mint" ? (e.to === signer ? "to signer" : "to other")
      : e.kind === "burn" ? (e.from === signer ? "from signer" : "from other")
      : e.from === signer ? "out of signer" : e.to === signer ? "into signer" : "other";
    return `${e.src}|${e.kind}|${who}`;
  };
  const flows = new Map<string, { total: number; blocks: number }>();
  for (const r of confirmed)
    for (const e of r.ev.filter((x) => x.blockLevel)) {
      const k = flowKey(e, r.signer);
      const f = flows.get(k) ?? { total: 0, blocks: 0 };
      f.total += e.value;
      f.blocks++;
      flows.set(k, f);
    }

  // Auto-detect the KOIN and VHP contracts from the data itself. Per the PoB contract
  // (process_block_signature), every block MINTS KOIN to the signer and BURNS VHP from
  // the signer, so whichever contracts do that are KOIN and VHP. The --koin/--vhp
  // settings are only a fallback if detection finds nothing.
  const detect = (kind: string, dir: string) => {
    const hits = [...flows.entries()]
      .filter(([k]) => k.split("|")[1] === kind && k.split("|")[2] === dir)
      .sort((a, b) => b[1].blocks - a[1].blocks);
    return hits.length && hits[0][1].blocks > N * 0.5 ? hits[0][0].split("|")[0] : undefined;
  };
  const koinId = detect("mint", "to signer") ?? cfg.koin;
  const vhpId = detect("burn", "from signer") ?? cfg.vhp;
  if (koinId !== cfg.koin) console.log(`ℹ KOIN contract detected from block rewards: ${koinId} (setting said ${cfg.koin})`);
  if (vhpId !== cfg.vhp) console.log(`ℹ VHP contract detected from block burns: ${vhpId} (setting said ${cfg.vhp})`);

  const koinMinted = new Map<string, number>(); // KOIN minted to each producer (reward + VHP converted back)
  const vhpBurnedBySigning = new Map<string, number>(); // VHP removed from the signer by producing
  for (const r of confirmed)
    for (const e of r.ev)
      if (e.blockLevel) {
        if (e.src === koinId && e.kind === "mint" && e.to === r.signer)
          koinMinted.set(r.signer, (koinMinted.get(r.signer) ?? 0) + e.value);
        if (e.src === vhpId && e.kind === "burn" && e.from === r.signer)
          vhpBurnedBySigning.set(r.signer, (vhpBurnedBySigning.get(r.signer) ?? 0) + e.value);
      }
  const totalKoinMinted = [...koinMinted.values()].reduce((a, b) => a + b, 0);
  const totalVhpBurned = [...vhpBurnedBySigning.values()].reduce((a, b) => a + b, 0);

  // 4) VHP balances: read "now", then walk backwards through every VHP event
  console.log(`Reading current VHP balances for ${producers.length} producers ...`);
  const vhpToken = new Contract({ id: vhpId, abi: utils.tokenAbi, provider });
  const current = new Map<string, number>();
  for (const p of producers) {
    const { result }: any = await withRetry(`reading VHP balance of ${p}`, () => vhpToken.functions.balanceOf({ owner: p }));
    await sleep(250); // be gentle with the public node
    current.set(p, Number(result?.value ?? 0) / DECIMALS);
  }
  let vhpSupply = NaN;
  try {
    const { result: supplyRes }: any = await withRetry("reading VHP supply", () => vhpToken.functions.totalSupply());
    vhpSupply = Number(supplyRes?.value ?? 0) / DECIMALS;
  } catch {
    console.log("  (could not read VHP total supply; continuing)");
  }

  // Per producer: list of [height, delta] for every VHP balance change in the scan
  const deltas = new Map<string, Array<[number, number]>>(producers.map((p) => [p, []]));
  for (const r of rows)
    for (const e of r.ev)
      if (e.src === vhpId) {
        if (e.to && deltas.has(e.to)) deltas.get(e.to)!.push([r.h, e.value]);
        if (e.from && deltas.has(e.from)) deltas.get(e.from)!.push([r.h, -e.value]);
      }
  /** VHP balance of producer p right after block h. */
  const vhpAt = (p: string, h: number) =>
    current.get(p)! - deltas.get(p)!.filter(([dh]) => dh > h).reduce((s, [, d]) => s + d, 0);

  // Biggest single-block VHP jump per producer (as % of balance before it)
  const maxJump = new Map<string, number>();
  for (const p of producers) {
    let bal = current.get(p)!;
    let jump = 0;
    const byBlock = new Map<number, number>();
    for (const [h, d] of deltas.get(p)!) byBlock.set(h, (byBlock.get(h) ?? 0) + d);
    for (const h of [...byBlock.keys()].sort((a, b) => b - a)) {
      const before = bal - byBlock.get(h)!;
      if (before >= 10_000) jump = Math.max(jump, Math.abs(byBlock.get(h)!) / before);
      bal = before;
    }
    maxJump.set(p, jump);
  }

  // 5) Daily statistics (days counted from the first block's timestamp)
  const days = new Map<number, BlockRow[]>();
  for (const r of confirmed) {
    const d = Math.floor((r.ts - confirmed[0].ts) / MS_PER_DAY);
    if (!days.has(d)) days.set(d, []);
    days.get(d)!.push(r);
  }

  const daily: any[] = [];
  const producerDays: any[] = [];
  for (const [d, list] of [...days.entries()].sort((a, b) => a[0] - b[0])) {
    const spanH = (list[list.length - 1].ts - list[0].ts) / 3_600_000;
    let streak = 1, longest = 1, maxGap = 0, zeroTx = 0, compute = 0, gov = 0;
    const c = new Map<string, number>();
    list.forEach((r, i) => {
      c.set(r.signer, (c.get(r.signer) ?? 0) + 1);
      if (r.ntx === 0) zeroTx++;
      compute += r.compute;
      gov += r.gov;
      if (i > 0) {
        streak = r.signer === list[i - 1].signer ? streak + 1 : 1;
        longest = Math.max(longest, streak);
        maxGap = Math.max(maxGap, (r.ts - list[i - 1].ts) / 1000);
      }
    });

    // Snapshot VHP at the START of the day (like snapshotting at question release)
    const startH = list[0].h - 1;
    const endH = list[list.length - 1].h;
    const snap = new Map(producers.map((p) => [p, Math.max(0, vhpAt(p, startH))]));
    const activeVhp = [...snap.values()].reduce((a, b) => a + b, 0);
    for (const p of producers) {
      const v0 = snap.get(p)!;
      const expected = activeVhp > 0 ? (list.length * v0) / activeVhp : 0;
      const actual = c.get(p) ?? 0;
      const v1 = vhpAt(p, endH);
      producerDays.push({
        day: d, partial: spanH < 23, producer: p, vhp_start: v0, expected, actual,
        // shortfall in standard deviations: > 3 means more missing than luck explains
        z: expected > 0 ? (expected - actual) / Math.sqrt(expected) : 0,
        missed: expected > 0 ? Math.max(0, 1 - actual / expected) : 0,
        vhp_change: v0 > 0 ? (v1 - v0) / v0 : 0,
      });
    }
    daily.push({
      day: d, partial: spanH < 23, blocks: list.length, distinct_producers: c.size,
      longest_streak: longest, max_gap_s: maxGap,
      avg_interval_s: list.length > 1 ? (list[list.length - 1].ts - list[0].ts) / 1000 / (list.length - 1) : NaN,
      zero_tx_pct: zeroTx / list.length, compute, governance_events: gov, active_vhp: activeVhp,
    });
  }

  // 6) Reward per VHP per week
  const avgActiveVhp = daily.reduce((s, d) => s + d.active_vhp, 0) / daily.length;
  const weekScale = 7 / windowDays;
  // KOIN minted to the signer = block_reward + vhp_reduction (the burned VHP comes back as KOIN).
  // So the TRUE yield is minted minus burned; the burned part is principal changing form.
  const weeklyRewards = (totalKoinMinted - totalVhpBurned) * weekScale; // true yield to all producers per week
  const rewardPerVhpWeek = avgActiveVhp > 0 ? weeklyRewards / avgActiveVhp : NaN;
  const vhpDecayPerWeek = avgActiveVhp > 0 ? (totalVhpBurned * weekScale) / avgActiveVhp : NaN;
  const nowActiveVhp = producers.reduce((s, p) => s + current.get(p)!, 0);

  // ───────────────────────── Report ─────────────────────────

  console.log(`\nWindow: ${fmt(N, 0)} irreversible blocks, ${fmt(windowDays, 2)} days\n`);

  console.log("── 1. PRODUCER CONCENTRATION ──");
  console.log(`Distinct producers: ${producers.length}`);
  console.log(`Top producer share: ${pct(shares[0])}   Top-3 share: ${pct(shares.slice(0, 3).reduce((a, b) => a + b, 0))}`);
  console.log(`Producers needed for >50% of blocks: ${nakamoto}`);
  console.log(`Concentration index (HHI, 0–1, higher = more concentrated): ${hhi.toFixed(3)}`);
  console.table(
    sorted.slice(0, 15).map(([p, c]) => ({
      producer: p, blocks: c, share: pct(c / N), vhp_now: fmt(current.get(p)!, 0),
      vhp_share_now: pct(current.get(p)! / nowActiveVhp),
    }))
  );

  console.log("── 2/3. WHAT A BLOCK DOES TO THE SIGNER (block-level token events) ──");
  if (flows.size === 0) console.log("No block-level token events found. Rewards may be paid differently — inspect a block on koinosscan.");
  console.table(
    [...flows.entries()].map(([k, f]) => {
      const [src, kind, who] = k.split("|");
      const label = src === koinId ? "KOIN" : src === vhpId ? "VHP" : src;
      return { token: label, event: kind, direction: who, avg_per_block: fmt(f.total / N, 6), blocks_with_it: f.blocks };
    })
  );
  const unknownSources = [...new Set([...flows.keys()].map((k) => k.split("|")[0]))].filter(
    (s) => s !== koinId && s !== vhpId
  );
  if (unknownSources.length)
    console.log(`ℹ Other contracts with block-level token events (e.g. the Koinos Fund's KOIN share): ${unknownSources.join(", ")}`);

  console.log(`KOIN minted to signers: ${fmt(totalKoinMinted, 4)} total, ${fmt(totalKoinMinted / N, 6)} per block`);
  console.log(`VHP burned from signers: ${fmt(totalVhpBurned, 4)} total, ${fmt(totalVhpBurned / N, 6)} per block`);
  console.log(`True block reward (minted − burned): ${fmt(totalKoinMinted - totalVhpBurned, 4)} total, ${fmt((totalKoinMinted - totalVhpBurned) / N, 6)} per block`);
  const vhpChanges = totalVhpBurned > 0;
  console.log(
    vhpChanges
      ? `→ YES, producing burns the producer's VHP and pays it back as KOIN.\n  compound() must re-burn the returned KOIN into VHP (at least daily) so bucket\n  balances stay whole. Only the true block reward goes into the weekly pot.`
      : "→ NO block-level VHP burns seen. compound() would only need to burn the yield (confirm by inspecting a few blocks)."
  );

  console.log("\n── 2. REWARD PER VHP ──");
  console.log(`Active VHP (avg of daily snapshots): ${fmt(avgActiveVhp, 0)}   Total VHP supply: ${fmt(vhpSupply, 0)}  (${pct(avgActiveVhp / vhpSupply)} producing)`);
  console.log(`True reward per 1 VHP per week: ${fmt(rewardPerVhpWeek, 6)} KOIN  (≈ ${pct(rewardPerVhpWeek * 52)} per year)`);
  if (vhpChanges)
    console.log(`VHP converted back to KOIN per week: ${pct(vhpDecayPerWeek)} of VHP  (≈ ${pct(vhpDecayPerWeek * 52)} per year, before re-burning)`);

  // Missed blocks & VHP volatility
  // Only full days: a partial day has too few blocks, so luck swamps everything.
  const fullDays = producerDays.filter((x) => !x.partial);
  const meaningful = fullDays.filter((x) => x.expected >= 50);
  const missed = meaningful.map((x) => x.missed);
  const beyondLuck = meaningful.filter((x) => x.z > 3);
  const offlineDays = fullDays.filter((x) => x.expected >= 20 && x.actual === 0).length;
  // Ignore near-empty balances: a jump from 5 VHP to 50,000 is "+1,000,000%" and wrecks the percentiles.
  const minVhp = Math.max(10_000, avgActiveVhp * 0.001);
  const vhpMoves = fullDays.filter((x) => x.vhp_start >= minVhp).map((x) => Math.abs(x.vhp_change));
  const jumps = [...maxJump.values()];

  console.log("\n── 5. MISSED BLOCKS (actual vs VHP-expected, per producer per day, expected ≥ 50) ──");
  console.log(`Samples: ${missed.length}   p50 ${pct(quantile(missed, 0.5))}   p90 ${pct(quantile(missed, 0.9))}   p95 ${pct(quantile(missed, 0.95))}   p99 ${pct(quantile(missed, 0.99))}`);
  console.log(`Producer-days with zero blocks despite expecting ≥ 20 (likely offline): ${offlineDays}`);
  console.log(`Producer-days short by MORE than luck explains (shortfall > 3σ): ${beyondLuck.length} of ${meaningful.length}`);
  for (const x of beyondLuck.slice(0, 10))
    console.log(`  day ${x.day}  ${x.producer}  expected ${fmt(x.expected, 0)}, signed ${x.actual}  (${pct(x.missed, 1)} short)`);
  if (meaningful.length === 0) console.log("  (no full days yet — run with --days 2 or more)");
  console.log("Pure luck alone moves block counts by about (3 standard deviations):");
  for (const E of [100, 1_000, 10_000]) console.log(`  expected ${fmt(E, 0)} blocks → ±${pct(3 / Math.sqrt(E), 1)}`);

  // Production efficiency: realized block share ÷ VHP-implied share. Questions and void checks must use
  // each producer's OWN realized rate as the baseline, not its VHP (some producers run far below 1.0).
  console.log("\n── 5. PRODUCTION EFFICIENCY (signed ÷ VHP-expected, full days) ──");
  const eff = producers
    .map((p) => {
      const ds = fullDays.filter((x) => x.producer === p && x.expected >= 50);
      const E = ds.reduce((a, x) => a + x.expected, 0), A = ds.reduce((a, x) => a + x.actual, 0);
      const perDay = ds.map((x) => x.actual / x.expected);
      return { producer: p, days: ds.length, efficiency: E > 0 ? A / E : NaN,
               day_min: perDay.length ? Math.min(...perDay) : NaN, day_max: perDay.length ? Math.max(...perDay) : NaN };
    })
    .filter((x) => x.days > 0)
    .sort((a, b) => a.efficiency - b.efficiency);
  console.table(eff.map((x) => ({ producer: x.producer, days: x.days, efficiency: fmt(x.efficiency, 3),
    worst_day: fmt(x.day_min, 3), best_day: fmt(x.day_max, 3) })));
  console.log("1.000 = signs exactly its VHP share. Well below 1 every day = a steady handicap, not an outage.");

  console.log(`\n── 5. VHP VOLATILITY (|daily % change| per producer holding ≥ ${fmt(minVhp, 0)} VHP) ──`);
  console.log(`p50 ${pct(quantile(vhpMoves, 0.5))}   p90 ${pct(quantile(vhpMoves, 0.9))}   p95 ${pct(quantile(vhpMoves, 0.95))}   p99 ${pct(quantile(vhpMoves, 0.99))}`);
  console.log(`Largest single-block VHP jump seen: ${pct(Math.max(0, ...jumps))}`);

  // Threshold from producer-days that behaved normally (within luck), so real outages don't set the bar.
  const normalMissed = meaningful.filter((x) => x.z <= 3).map((x) => x.missed);
  const suggestMissed = Math.max(quantile(normalMissed, 0.95), 3 / Math.sqrt(1_000));
  const suggestVhp = quantile(vhpMoves, 0.95);
  console.log("\nStarting-point void thresholds (tune after the back-test):");
  console.log(`  X (missed blocks): void if the subject is short by more than 3σ (luck) AND by more than ~${pct(suggestMissed, 1)} of expected.`);
  console.log(`  Y (VHP change after lock): void if subject's VHP moves more than ~${pct(suggestVhp, 1)} (historical p95).`);

  // Platform projection (stake-weighted model: every 1 VHP = one entry)
  console.log("\n── 4. PLATFORM POOL PROJECTION ──");
  console.log("Block rewards are fixed per block, so the pool earns (its share × all producer rewards).");
  console.log("Adding VHP dilutes everyone's reward per VHP. Winners = top 30% of eligible stake.\n");
  const A = nowActiveVhp;
  const fee = cfg.feeBps / 10_000, retain = cfg.retainBps / 10_000, potShare = 1 - fee - retain;
  const seedVhp = cfg.seed * 0.95; // 95% of the KOIN seed is burned into VHP
  if (cfg.seed > 0)
    console.log(`Seed ${fmt(cfg.seed, 0)} KOIN → ${fmt(seedVhp, 0)} VHP producing + ${fmt(cfg.seed * 0.05, 0)} KOIN Mana reserve (≈ ${fmt(cfg.seed * 0.05 / 5, 0)} Mana/day)\n`);
  const projection: any[] = [];
  for (const S of nums(cfg.pools)) {
    const P = seedVhp + S; // everything in the pool produces
    const share = P / (A + P);
    const gross = share * weeklyRewards; // true weekly yield of the whole pool
    const net = gross * potShare;
    const soloPerVhp = weeklyRewards / (A + P); // what 1 VHP earns producing on its own
    const winPerVhp = S > 0 ? net / (0.3 * S) : NaN; // average weekly win per 1 VHP of winning stake
    projection.push({
      player_vhp: fmt(S, 0), pool_vhp: fmt(P, 0), network_share: pct(share, 1),
      weekly_gain: fmt(gross, 0), creator_fee_koin: fmt(gross * fee, 0), owner_share_vhp: fmt(gross * retain, 0), winners_pot: fmt(net, 0),
      solo_per_vhp_week: fmt(soloPerVhp, 6), avg_win_per_winning_vhp: fmt(winPerVhp, 6),
      win_vs_solo: isFinite(winPerVhp) ? fmt(winPerVhp / soloPerVhp, 2) + "x" : "n/a",
    });
  }
  console.table(projection);
  console.log("win_vs_solo = how many times solo yield an average winner earns per VHP.");
  console.log(`Without a seed it is ≈ ${potShare.toFixed(2)} / 0.30 ≈ ${(potShare / 0.3).toFixed(1)}x; the seed's yield pushes it higher.`);
  // No cap — but show where the pool would become a concentration risk for the network.
  for (const level of [1 / 3, 1 / 2]) {
    const P = (level / (1 - level)) * A;
    console.log(`Pool reaches ${pct(level, 0)} of producing VHP at ≈ ${fmt(P, 0)} VHP (≈ ${fmt(Math.max(0, P - seedVhp), 0)} from players)` +
      (level < 0.5 ? " — one outage of our node visibly slows the chain" : " — our node alone signs most blocks; plan several nodes well before this"));
  }
  const wk = rewardPerVhpWeek;
  if (isFinite(wk))
    console.log(`Compounding: ${pct(wk * 52)} simple per year vs ${pct((1 + wk / 7) ** 365 - 1)} with daily compound()`);
  if (cfg.seed === 0) console.log("(Seed set to 0. Try --seed 200000 and --seed 1000000, in KOIN.)");

  // Verdict on concentration
  console.log("\n── VERDICT ──");
  if (shares[0] > 0.4 || nakamoto <= 2)
    console.log("⚠ Production is highly concentrated. Single-producer questions would be near-certain or easy to steer.\n  Lean on timing, gap, resource and diversity templates; down-weight or drop producer-volume questions.");
  else if (producers.length < 8)
    console.log("⚠ Few producers. Rotating-producer questions will repeat subjects often; keep them a minority of the 20.");
  else console.log("Producer set looks diverse enough for rotating producer questions.");

  // ───────────────────────── Files ─────────────────────────
  const csv = (list: any[]) =>
    [Object.keys(list[0] ?? {}).join(","), ...list.map((o) => Object.values(o).map((v) => (typeof v === "number" ? +v.toFixed(8) : v)).join(","))].join("\n");
  fs.writeFileSync(
    path.join(cfg.out, "producers.csv"),
    csv(sorted.map(([p, c]) => ({
      producer: p, blocks: c, share: c / N, vhp_now: current.get(p), koin_reward: koinMinted.get(p) ?? 0,
      vhp_burned: vhpBurnedBySigning.get(p) ?? 0, max_single_block_vhp_jump: maxJump.get(p),
    })))
  );
  fs.writeFileSync(path.join(cfg.out, "daily.csv"), csv(daily));
  fs.writeFileSync(path.join(cfg.out, "producer_days.csv"), csv(producerDays));
  fs.writeFileSync(
    path.join(cfg.out, "report.json"),
    JSON.stringify({
      generated: new Date().toISOString(), settings: cfg, blocks: N, window_days: windowDays,
      last_irreversible: lib, distinct_producers: producers.length, top_share: shares[0], hhi, nakamoto_50: nakamoto,
      koin_minted_total: totalKoinMinted, vhp_burned_by_signing: totalVhpBurned, producing_changes_vhp: vhpChanges,
      active_vhp_avg: avgActiveVhp, vhp_supply: vhpSupply, reward_per_vhp_week: rewardPerVhpWeek, vhp_decay_per_week: vhpDecayPerWeek,
      koin_contract: koinId, vhp_contract: vhpId,
      missed_quantiles: { p50: quantile(missed, 0.5), p90: quantile(missed, 0.9), p95: quantile(missed, 0.95), p99: quantile(missed, 0.99) },
      vhp_change_quantiles: { p50: quantile(vhpMoves, 0.5), p90: quantile(vhpMoves, 0.9), p95: quantile(vhpMoves, 0.95), p99: quantile(vhpMoves, 0.99) },
      suggested_void: { missed: suggestMissed, vhp_change: suggestVhp },
      production_efficiency: eff,
      daily,
    }, null, 2)
  );
  console.log(`\nFiles written to ./${cfg.out}/ (report.json, producers.csv, daily.csv, producer_days.csv, cache.json)\n`);
}

main().catch((err) => {
  console.error("\n✖ Step 0 failed:", err.message ?? err);
  console.error("  Tips: if blocks were already downloaded, re-run with:  npm run step0 -- --from-cache step0-output/cache.json");
  console.error("  Otherwise check your internet connection, or lower --concurrency to 1.");
  process.exit(1);
});

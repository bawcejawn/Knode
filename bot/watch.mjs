/**
 * NODE WATCHDOG — runs on GitHub every 15 minutes (.github/workflows/watch.yml). Read-only: no keys, no installs.
 *
 * Watches one block-producer address (your personal node's, set as the GitHub variable PERSONAL_PRODUCER). All three
 * nodes run on the same PC, and the personal one produces by far the most often, so when it goes quiet the PC, Docker
 * or the internet is almost certainly down for all of them.
 *
 * It reads the last 90 minutes of blocks from a public Koinos node and finds this producer's latest block.
 *   - silent longer than WATCH_MINUTES (default 30), and longer than pure bad luck would explain → the run FAILS,
 *     which makes GitHub email you;
 *   - the same outage emails once, then a reminder every 3 hours while it lasts;
 *   - if the public Koinos node can't be reached, it says so but does not alarm (that's not your node's fault).
 *
 * State between runs (which outage was already emailed) is kept in watch-state.json, carried by the workflow's cache.
 */
import fs from "node:fs";

const RPC = process.env.RPC || "https://koinos.armana.io";
const ADDR = (process.env.WATCH_PRODUCER || "").trim();
const LABEL = process.env.WATCH_LABEL || "personal node";
const MINUTES = Number(process.env.WATCH_MINUTES || 30);
const STATE = "watch-state.json";
const SCAN = 1800;               // blocks to look back (~90 minutes at ~3 s per block)
const BATCH = 300;
const REMIND_MS = 3 * 3600_000;

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readState = () => { try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { return {}; } };
const writeState = (s) => fs.writeFileSync(STATE, JSON.stringify(s, null, 2));

async function rpc(method, params) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      const j = await r.json();
      if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
      return j.result;
    } catch (e) {
      if (i >= 4) throw e;
      await sleep(2000 * i);
    }
  }
}

async function main() {
  if (!/^1[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(ADDR)) {
    log("::notice title=Node watchdog::No producer to watch yet. Add your personal node's producer address as the repository variable PERSONAL_PRODUCER.");
    return;
  }
  let head, items = [];
  try {
    head = await rpc("chain.get_head_info", {});
    const h = Number(head.head_topology.height);
    for (let start = h - SCAN + 1; start <= h; start += BATCH) {
      const res = await rpc("block_store.get_blocks_by_height", {
        head_block_id: head.head_topology.id, ancestor_start_height: String(start),
        num_blocks: Math.min(BATCH, h - start + 1), return_block: true, return_receipt: false,
      });
      items.push(...(res.block_items || []));
    }
  } catch (e) {
    log(`::warning title=Node watchdog::Couldn't read blocks from ${RPC} (${e.message}). Not an alarm: the public node may be busy. Trying again next run.`);
    return;
  }
  const h = Number(head.head_topology.height);
  const mine = items.filter((it) => it.block?.header?.signer === ADDR).map((it) => Number(it.block_height ?? it.block?.header?.height));
  const last = mine.length ? Math.max(...mine) : 0;
  const lastTime = last ? Number(items.find((it) => Number(it.block_height ?? it.block?.header?.height) === last)?.block?.header?.timestamp) : 0;
  const scanned = items.length;
  const headTime = Number(head.head_block_time || items[items.length - 1]?.block?.header?.timestamp || Date.now());
  const gapMin = last ? (headTime - lastTime) / 60000 : Infinity;
  // How long a silence must be before it's not just bad luck: at least WATCH_MINUTES, and at least the gap that would
  // happen by chance less than 1 time in 1,000 at this producer's recent rate.
  // The rate is measured only up to the latest block, so an ongoing silence doesn't water it down.
  const firstTime = Number(items[0]?.block?.header?.timestamp || 0);
  const activeMin = last && firstTime ? Math.max(1, (lastTime - firstTime) / 60000) : 0;
  const perMin = activeMin ? mine.length / activeMin : 0;
  const luckMin = perMin > 0 ? Math.log(1000) / perMin : Infinity;
  const limit = Math.max(MINUTES, Math.min(luckMin, 24 * 60));
  log(`Watching ${LABEL} ${ADDR}`);
  log(`Last ${scanned} blocks (to #${h.toLocaleString()}): ${mine.length} by this producer; ${last ? `latest #${last.toLocaleString()}, ${gapMin.toFixed(0)} min ago` : "none in the last ~90 minutes"}.`);
  if (last) log(`Alarm after ${limit.toFixed(0)} min of silence.`);

  const st = readState();
  const down = last === 0 || gapMin > limit;
  if (!down) {
    if (st.outage) log(`✔ Back to normal (the outage first emailed at ${new Date(st.firstAlert).toISOString()} is over).`);
    else log("✔ Producing normally.");
    writeState({});
    return;
  }
  const outage = String(last);  // one outage = silence since the same last block
  const now = Date.now();
  const what = last ? `No block from your ${LABEL} for ${gapMin.toFixed(0)} minutes (last block #${last.toLocaleString()}).` : `No block from your ${LABEL} in the last ~90 minutes.`;
  const advice = "Check the PC is awake and online, Docker Desktop is running, and the nodes are up (npm run desk -- node-status, npm run bot -- node-status, npm run bot -- node-status personal).";
  if (st.outage === outage && now - (st.lastAlert || 0) < REMIND_MS) {
    log(`(already emailed for this outage at ${new Date(st.lastAlert).toISOString()}) ${what}`);
    return;
  }
  writeState({ outage, firstAlert: st.outage === outage ? st.firstAlert : now, lastAlert: now });
  log(`::error title=Node down?::${what} ${advice}`);
  process.exitCode = 1;   // a failed run makes GitHub email you
}

main().catch((e) => { log(`::warning title=Node watchdog::${e.message}`); });

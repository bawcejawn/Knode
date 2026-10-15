/**
 * Packs backtest-output/blocks.csv into a small gzip file (about 5–10 MB for 120 days) that can be
 * attached to a chat or uploaded to GitHub, so the model can be tuned on the real chain history.
 *
 *   npm run export-blocks
 *
 * Output: data/blocks-compact.csv.gz
 *   line 1: #signers,<addr0>,<addr1>,...        (signer index → address)
 *   line 2: #start,<first height>,<first timestamp ms>
 *   then one line per block: <signer index>,<ms since previous block>,<transaction count>
 * Read-only: it never touches the chain or your keys.
 */
import fs from "node:fs";
import zlib from "node:zlib";

const src = process.argv[2] ?? "backtest-output/blocks.csv";
if (!fs.existsSync(src)) throw new Error(`${src} not found — run the backtest first.`);
const lines = fs.readFileSync(src, "utf8").split("\n").filter(Boolean);
const ids = new Map<string, number>();
const rows: string[] = [];
let prevH = -1, prevTs = 0, h0 = 0, ts0 = 0;
for (const line of lines) {
  const [h, ts, signer, ntx] = line.split(",");
  const H = Number(h), T = Number(ts);
  if (prevH === -1) { h0 = H; ts0 = T; }
  else if (H !== prevH + 1) throw new Error(`gap in the history at height ${prevH + 1}`);
  if (!ids.has(signer)) ids.set(signer, ids.size);
  rows.push(`${ids.get(signer)},${prevH === -1 ? 0 : T - prevTs},${ntx}`);
  prevH = H; prevTs = T;
}
const text = `#signers,${[...ids.keys()].join(",")}\n#start,${h0},${ts0}\n${rows.join("\n")}\n`;
fs.mkdirSync("data", { recursive: true });
const out = "data/blocks-compact.csv.gz";
fs.writeFileSync(out, zlib.gzipSync(text, { level: 9 }));
console.log(`Wrote ${out}: ${rows.length.toLocaleString()} blocks (${h0.toLocaleString()}–${prevH.toLocaleString()}), ${(fs.statSync(out).size / 1e6).toFixed(1)} MB.`);
